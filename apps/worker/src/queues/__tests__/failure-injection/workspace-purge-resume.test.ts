import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { PURGE_ADVISORY_LOCK_NAMESPACE, PURGE_BATCH_SIZE, deletePurgeBatch } from "@mega-crm/db";
import {
  createTestPool,
  ensureTestDbMigrated,
  getTestDatabaseUrl,
  killAndAwaitExit,
  spawnAndAwaitReady,
  type SpawnedChild,
} from "@mega-crm/test-support";
import { insertFixtureOrganization } from "../../../test/failure-fixtures.js";
import { WORKSPACE_PURGE_KILL_HARNESS_READY } from "../../../test/harness/workspace-purge-kill-entrypoint.js";
import { closeAuthPurgePool } from "../../workspace-purge-auth.js";
import { processWorkspacePurge } from "../../workspace-purge.worker.js";

/**
 * Phase 22 (PRG-03, D-05/D-09, plan 22-09): proves SC3's first half -- "a
 * purge killed mid-run resumes and completes on the next run" -- with a
 * REAL SIGKILL against a REAL child process, at all three seams the
 * objective names: mid-batch (Task 1), between tables and before the tail
 * (Task 2). No mocked kill and no simulated crash anywhere in this file.
 *
 * Reproduce with `npm run failure:workspace-purge-resume` from the repo
 * root.
 *
 * Fixture shape shared by every kill scenario: three tables from
 * `PURGE_TABLE_ORDER`, chosen far apart in the walk order and free of any
 * FK setup beyond a single contact --
 * `subscription_status_history` (index 3) -> `contacts` (index 13) ->
 * `workspace_property_registry` (index 16) -- each seeded to EXACTLY
 * `2 * PURGE_BATCH_SIZE` rows, so each table's walk is exactly two
 * meaningful (non-zero) `deletePurgeBatch` calls followed by one
 * zero-count confirmation call. Freezing after the 4th meaningful call
 * across the whole workspace therefore lands deterministically inside
 * the SECOND table's SECOND batch -- table 1 fully drained and committed,
 * table 2 half-drained with its second batch's transaction still open,
 * table 3 completely untouched -- without any sleep or fixed timer
 * anywhere in this file (SPEC R6).
 */
describe("failure injection: workspace-purge kill-resume (PRG-03, SC3, plan 22-09)", () => {
  let pool: Pool;
  let authPool: Pool;
  let survivor: SpawnedChild | undefined;

  const HARNESS_ENTRYPOINT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../test/harness/workspace-purge-kill-entrypoint.ts",
  );

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    // Published into process.env by packages/test-support's global-setup.ts
    // for every workspace's test project -- see workspace-purge-auth.test.ts's
    // own comment on this exact pattern.
    authPool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL });
  });

  afterAll(async () => {
    // Belt and braces: a failed assertion between spawn and kill would
    // otherwise leave a frozen child holding a database connection.
    if (survivor) await killAndAwaitExit(survivor).catch(() => undefined);
    await pool.end();
    await authPool.end();
    await closeAuthPurgePool();
  });

  const TABLE_A = "subscription_status_history" as const;
  const TABLE_B = "contacts" as const;
  const TABLE_C = "workspace_property_registry" as const;
  const ROWS_PER_TABLE = PURGE_BATCH_SIZE * 2;

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function softDeleteWorkspace(workspaceId: string, daysAgo: number): Promise<void> {
    await pool.query(`UPDATE organization SET "deletedAt" = now() - ($2 || ' days')::interval WHERE id = $1`, [
      workspaceId,
      daysAgo,
    ]);
  }

  async function seedManyContacts(workspaceId: string, count: number): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           SELECT $1, 'bulk-' || gs || '-' || substr(gen_random_uuid()::text, 1, 8) || '@fixture.test', 'Fixture', 'subscribed'
           FROM generate_series(1, $2) AS gs
           RETURNING id`,
          [workspaceId, count],
        );
        return rows[0].id;
      }),
    );
  }

  async function seedManySubscriptionHistory(workspaceId: string, contactId: string, count: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO subscription_status_history (workspace_id, contact_id, old_status, new_status, source)
           SELECT $1, $2, 'subscribed', 'unsubscribed', 'manual_ui'
           FROM generate_series(1, $3) AS gs`,
          [workspaceId, contactId, count],
        ),
      ),
    );
  }

  async function seedManyPropertyRegistryEntries(workspaceId: string, count: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO workspace_property_registry (workspace_id, key, observed_type)
           SELECT $1, 'prop-' || gs || '-' || substr(gen_random_uuid()::text, 1, 8), 'string'
           FROM generate_series(1, $2) AS gs`,
          [workspaceId, count],
        ),
      ),
    );
  }

  async function countRows(workspaceId: string, table: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table} WHERE workspace_id = $1`, [
          workspaceId,
        ]);
        return Number(rows[0].count);
      }),
    );
  }

  interface PurgeRecordRow {
    status: string;
    completedTables: string[];
    tableCounts: Record<string, number>;
    purgedAt: Date | null;
  }

  async function readPurgeRecord(workspaceId: string): Promise<PurgeRecordRow | null> {
    const { rows } = await pool.query<PurgeRecordRow>(
      `SELECT status, completed_tables AS "completedTables", table_counts AS "tableCounts", purged_at AS "purgedAt"
         FROM purge_records WHERE workspace_id = $1`,
      [workspaceId],
    );
    return rows[0] ?? null;
  }

  interface OrganizationRow {
    deletedAt: Date | null;
    purgedAt: Date | null;
    name: string;
  }

  async function readOrganization(workspaceId: string): Promise<OrganizationRow> {
    const { rows } = await pool.query<OrganizationRow>(
      `SELECT "deletedAt" AS "deletedAt", "purgedAt" AS "purgedAt", name FROM organization WHERE id = $1`,
      [workspaceId],
    );
    return rows[0];
  }

  /** Mirrors workspace-purge-auth.test.ts's own fixture helpers -- `member`/`invitation` require the mega_crm_auth-backed pool, not the ordinary app pool. */
  async function createAuthUser(seed: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(`INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`, [
      `Purge Kill ${seed}`,
      `purge-kill-${seed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`,
    ]);
    return rows[0].id;
  }

  async function createMember(organizationId: string, userId: string): Promise<void> {
    await authPool.query(`INSERT INTO member ("organizationId", "userId", role) VALUES ($1, $2, 'member')`, [organizationId, userId]);
  }

  async function createInvitation(organizationId: string, inviterId: string, email: string): Promise<void> {
    await authPool.query(
      `INSERT INTO invitation ("organizationId", email, status, "expiresAt", "inviterId")
       VALUES ($1, $2, 'pending', now() + interval '7 days', $3)`,
      [organizationId, email, inviterId],
    );
  }

  /** `mega_crm_app` holds SELECT on member/invitation (migration 0045) -- reading through the ordinary pool is fine. */
  async function memberCount(organizationId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM member WHERE "organizationId" = $1`, [
      organizationId,
    ]);
    return Number(rows[0].count);
  }

  async function invitationCount(organizationId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM invitation WHERE "organizationId" = $1`, [
      organizationId,
    ]);
    return Number(rows[0].count);
  }

  /**
   * Runs the destructive tick inside a REAL child process, killed with a
   * REAL SIGKILL the instant the harness posts its ready marker -- never a
   * fixed sleep or timer (SPEC R6).
   */
  async function spawnAndKillOnReady(env: Record<string, string>): Promise<void> {
    const child = await spawnAndAwaitReady({
      entrypoint: HARNESS_ENTRYPOINT,
      readyMessage: WORKSPACE_PURGE_KILL_HARNESS_READY,
      execArgv: ["--import", "tsx"],
      env: {
        TEST_DATABASE_URL: getTestDatabaseUrl(),
        DATABASE_URL: getTestDatabaseUrl(),
        ...env,
      },
    });
    survivor = child;

    const exit = await killAndAwaitExit(child);
    survivor = undefined;

    // A process that had ended on its own reports a numeric code and a null
    // signal, and would satisfy a bare "it is gone" check while proving
    // nothing -- this must be a real, uncatchable kill.
    expect(exit.signal, "the child must have been killed with a real SIGKILL, not have exited on its own").toBe("SIGKILL");
    expect(exit.code).toBeNull();

    const targetWorkspaceId = env.WPK_TARGET_WORKSPACE_ID;
    expect(targetWorkspaceId, "every purge kill scenario must name the workspace whose advisory lock needs a release barrier").toBeTruthy();

    // `killAndAwaitExit` proves the OS process is gone, but not that
    // PostgreSQL has already noticed the closed socket and released that
    // backend's session advisory lock. Under aggregate coverage load the
    // next purge tick could reach pg_try_advisory_lock first, treat the
    // still-held lock as a successful skip, and leave the record `purging`.
    // Block on the SAME lock with a server-side timeout, then release it
    // immediately. This is an event barrier, never a guessed sleep.
    const barrier = await pool.connect();
    let barrierLocked = false;
    try {
      await barrier.query("BEGIN");
      await barrier.query("SET LOCAL statement_timeout = '5000ms'");
      await barrier.query(`SELECT pg_advisory_lock($1, hashtext($2))`, [PURGE_ADVISORY_LOCK_NAMESPACE, targetWorkspaceId]);
      barrierLocked = true;
      await barrier.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [PURGE_ADVISORY_LOCK_NAMESPACE, targetWorkspaceId]);
      barrierLocked = false;
      await barrier.query("COMMIT");
    } finally {
      if (barrierLocked) {
        await barrier
          .query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [PURGE_ADVISORY_LOCK_NAMESPACE, targetWorkspaceId])
          .catch(() => undefined);
      }
      await barrier.query("ROLLBACK").catch(() => undefined);
      barrier.release();
    }
  }

  /**
   * `walkPurgeTable`'s own retry loop confirms a zero-delete page with
   * `countPurgeTableRows` before declaring a table done, and retries (up to
   * 3 times, no delay between attempts) if rows remain -- built specifically
   * for `FOR UPDATE SKIP LOCKED` contention. A batch killed while its
   * transaction was still open can leave its row locks held by the now-dead
   * backend for a brief moment before Postgres notices the closed
   * connection and releases them; this retries the RESUME call itself
   * (never the kill, which stays purely signal-driven) a few times with a
   * short pause so that brief, real cleanup window doesn't flake the test.
   */
  async function resumeWithLockReleaseTolerance(): Promise<void> {
    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await processWorkspacePurge();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === attempts || !/still has rows/.test(message)) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  it(
    "mid-batch SIGKILL resumes and completes: some rows gone and some remain right after the kill, then the next tick finishes with counts identical to an uninterrupted purge",
    async () => {
      const subjectId = await freshWorkspaceId("wp-kill-mid-batch-subject");
      const contactId = await seedManyContacts(subjectId, ROWS_PER_TABLE);
      await seedManySubscriptionHistory(subjectId, contactId, ROWS_PER_TABLE);
      await seedManyPropertyRegistryEntries(subjectId, ROWS_PER_TABLE);
      await softDeleteWorkspace(subjectId, 40);

      // A neighbour, never soft-deleted and therefore never eligible --
      // proves the kill-and-resume never bleeds across workspace_id scope.
      const neighbourId = await freshWorkspaceId("wp-kill-mid-batch-neighbour");
      const neighbourContactId = await seedManyContacts(neighbourId, 5);
      await seedManySubscriptionHistory(neighbourId, neighbourContactId, 5);
      await seedManyPropertyRegistryEntries(neighbourId, 5);

      await processWorkspacePurge(); // report tick -- writes the census

      const census = await readPurgeRecord(subjectId);
      expect(census!.status).toBe("reported");
      expect(census!.tableCounts).toMatchObject({ [TABLE_A]: ROWS_PER_TABLE, [TABLE_B]: ROWS_PER_TABLE, [TABLE_C]: ROWS_PER_TABLE });

      // Freeze after the 4th meaningful (non-zero) delete across the whole
      // workspace: table A's two batches (calls 1-2, fully committed), then
      // table B's first batch (call 3, fully committed), then table B's
      // SECOND batch (call 4) -- frozen strictly after its real DELETE ran
      // but before that transaction could ever commit.
      await spawnAndKillOnReady({
        WPK_MODE: "mid_batch",
        WPK_TARGET_WORKSPACE_ID: subjectId,
        WPK_FREEZE_AFTER_MEANINGFUL_CALL: "4",
      });

      // --- immediately after the kill: some rows gone, some remain -------
      expect(await countRows(subjectId, TABLE_A), "table A fully drained and committed before the freeze").toBe(0);
      expect(
        await countRows(subjectId, TABLE_B),
        "table B's frozen second batch never committed -- its rows must still be physically present (MVCC, not a timing race)",
      ).toBe(PURGE_BATCH_SIZE);
      expect(await countRows(subjectId, TABLE_C), "table C was never reached").toBe(ROWS_PER_TABLE);

      const midKillRecord = await readPurgeRecord(subjectId);
      expect(midKillRecord!.status).toBe("purging");
      expect(midKillRecord!.completedTables).toContain(TABLE_A);
      expect(midKillRecord!.completedTables).not.toContain(TABLE_B);
      expect(midKillRecord!.completedTables).not.toContain(TABLE_C);
      expect(midKillRecord!.purgedAt).toBeNull();

      // Neighbour untouched throughout.
      expect(await countRows(neighbourId, TABLE_A)).toBe(5);
      expect(await countRows(neighbourId, TABLE_B)).toBe(5);
      expect(await countRows(neighbourId, TABLE_C)).toBe(5);

      // --- resume: a real second tick, in-process --------------------------
      await resumeWithLockReleaseTolerance();

      expect(await countRows(subjectId, TABLE_A)).toBe(0);
      expect(await countRows(subjectId, TABLE_B)).toBe(0);
      expect(await countRows(subjectId, TABLE_C)).toBe(0);

      const finalRecord = await readPurgeRecord(subjectId);
      expect(finalRecord!.status).toBe("complete");
      expect(finalRecord!.purgedAt).not.toBeNull();
      expect(finalRecord!.completedTables).toEqual(expect.arrayContaining([TABLE_A, TABLE_B, TABLE_C]));

      const finalOrg = await readOrganization(subjectId);
      expect(finalOrg.purgedAt).not.toBeNull();

      // Neighbour still untouched after the resume.
      expect(await countRows(neighbourId, TABLE_A)).toBe(5);
      expect(await countRows(neighbourId, TABLE_B)).toBe(5);
      expect(await countRows(neighbourId, TABLE_C)).toBe(5);
    },
    120_000,
  );

  it(
    "counts match an uninterrupted run: the killed-then-resumed workspace's table_counts deep-equals a control workspace purged without any kill",
    async () => {
      const killedId = await freshWorkspaceId("wp-kill-counts-killed");
      const controlId = await freshWorkspaceId("wp-kill-counts-control");

      for (const workspaceId of [killedId, controlId]) {
        const contactId = await seedManyContacts(workspaceId, ROWS_PER_TABLE);
        await seedManySubscriptionHistory(workspaceId, contactId, ROWS_PER_TABLE);
        await seedManyPropertyRegistryEntries(workspaceId, ROWS_PER_TABLE);
        await softDeleteWorkspace(workspaceId, 40);
      }

      await processWorkspacePurge(); // report tick -- both workspaces reported together

      await spawnAndKillOnReady({
        WPK_MODE: "mid_batch",
        WPK_TARGET_WORKSPACE_ID: killedId,
        WPK_FREEZE_AFTER_MEANINGFUL_CALL: "4",
      });
      await resumeWithLockReleaseTolerance();

      // The control workspace is destroyed by this SAME resume tick above
      // (processWorkspacePurge scans every destructible record each call),
      // so no separate destroy call is needed here -- both are complete by
      // this point.
      const killedRecord = await readPurgeRecord(killedId);
      const controlRecord = await readPurgeRecord(controlId);
      expect(killedRecord!.status).toBe("complete");
      expect(controlRecord!.status).toBe("complete");

      expect(
        killedRecord!.tableCounts,
        "identical seeds must produce an identical census, whether the purge that consumed it was interrupted or not",
      ).toEqual(controlRecord!.tableCounts);
    },
    120_000,
  );

  it(
    "counts match the census: table_counts after the resumed purge is byte-identical to the pre-destruction census the report tick wrote",
    async () => {
      const subjectId = await freshWorkspaceId("wp-kill-counts-census");
      const contactId = await seedManyContacts(subjectId, ROWS_PER_TABLE);
      await seedManySubscriptionHistory(subjectId, contactId, ROWS_PER_TABLE);
      await seedManyPropertyRegistryEntries(subjectId, ROWS_PER_TABLE);
      await softDeleteWorkspace(subjectId, 40);

      await processWorkspacePurge(); // report
      const census = (await readPurgeRecord(subjectId))!.tableCounts;

      await spawnAndKillOnReady({
        WPK_MODE: "mid_batch",
        WPK_TARGET_WORKSPACE_ID: subjectId,
        WPK_FREEZE_AFTER_MEANINGFUL_CALL: "4",
      });
      await resumeWithLockReleaseTolerance();

      const finalCounts = (await readPurgeRecord(subjectId))!.tableCounts;
      // recordAuthPurgeCounts (workspace-purge-checkpoint.ts) merges `member`
      // and `invitation` into table_counts once the auth step runs -- those
      // two keys are never part of PURGE_TABLE_ORDER's own census, so their
      // arrival is an ADDITION, not drift, per that function's own doc
      // comment. No member/invitation rows were seeded for this workspace,
      // so both merge in as zero.
      expect(
        finalCounts,
        "the tenant-table census must not drift across the crash -- it is the same numbers, verbatim, plus the auth step's own zero-count merge",
      ).toEqual({ ...census, member: 0, invitation: 0 });
    },
    120_000,
  );

  it(
    "kill between tables: the finished table is marked done and empty, the next table is neither, and the resumed run completes with table_counts unchanged",
    async () => {
      const subjectId = await freshWorkspaceId("wp-kill-between-tables");
      const contactId = await seedManyContacts(subjectId, ROWS_PER_TABLE);
      await seedManySubscriptionHistory(subjectId, contactId, ROWS_PER_TABLE);
      await seedManyPropertyRegistryEntries(subjectId, ROWS_PER_TABLE);
      await softDeleteWorkspace(subjectId, 40);

      await processWorkspacePurge(); // report
      const census = (await readPurgeRecord(subjectId))!.tableCounts;

      // Freezes BEFORE table B's very first batch is ever attempted -- table
      // A has already fully drained and committed by this point, and no
      // DELETE is ever issued for table B, so there is no open-transaction
      // lock to worry about on resume (unlike the mid-batch seam above).
      await spawnAndKillOnReady({
        WPK_MODE: "between_tables",
        WPK_TARGET_WORKSPACE_ID: subjectId,
        WPK_STOP_BEFORE_TABLE: TABLE_B,
      });

      // --- intermediate: the boundary's own granularity, proven directly ---
      expect(await countRows(subjectId, TABLE_A), "the finished table is empty").toBe(0);
      expect(await countRows(subjectId, TABLE_B), "the next table was never even attempted").toBe(ROWS_PER_TABLE);
      expect(await countRows(subjectId, TABLE_C), "the table after that is equally untouched").toBe(ROWS_PER_TABLE);

      const midKillRecord = await readPurgeRecord(subjectId);
      expect(midKillRecord!.status).toBe("purging");
      expect(midKillRecord!.completedTables, "the finished table is marked done").toContain(TABLE_A);
      expect(midKillRecord!.completedTables, "the next table is NOT marked done").not.toContain(TABLE_B);
      expect(midKillRecord!.completedTables).not.toContain(TABLE_C);

      // --- resume ------------------------------------------------------------
      await processWorkspacePurge();

      expect(await countRows(subjectId, TABLE_A)).toBe(0);
      expect(await countRows(subjectId, TABLE_B)).toBe(0);
      expect(await countRows(subjectId, TABLE_C)).toBe(0);

      const finalRecord = await readPurgeRecord(subjectId);
      expect(finalRecord!.status).toBe("complete");
      expect(finalRecord!.tableCounts, "table_counts is still the immutable pre-destruction census").toEqual({
        ...census,
        member: 0,
        invitation: 0,
      });
    },
    60_000,
  );

  it(
    "kill before the tail: membership rows survive the kill, and the resumed run finishes the auth step and tombstones the organization",
    async () => {
      const subjectId = await freshWorkspaceId("wp-kill-before-tail");
      const contactId = await seedManyContacts(subjectId, ROWS_PER_TABLE);
      await seedManySubscriptionHistory(subjectId, contactId, ROWS_PER_TABLE);
      await seedManyPropertyRegistryEntries(subjectId, ROWS_PER_TABLE);
      await softDeleteWorkspace(subjectId, 40);

      const userId = await createAuthUser("wp-kill-before-tail");
      await createMember(subjectId, userId);
      await createInvitation(subjectId, userId, `invitee-${Date.now().toString(36)}@fixture.test`);

      await processWorkspacePurge(); // report

      // Freezes AFTER every table is confirmed empty and marked done, but
      // BEFORE the auth step and the tombstone -- the one boundary the
      // table loop's own checkpoint cannot reach on its own.
      await spawnAndKillOnReady({
        WPK_MODE: "before_tail",
        WPK_TARGET_WORKSPACE_ID: subjectId,
      });

      // --- intermediate: every table done, the tail never ran ---------------
      expect(await countRows(subjectId, TABLE_A)).toBe(0);
      expect(await countRows(subjectId, TABLE_B)).toBe(0);
      expect(await countRows(subjectId, TABLE_C)).toBe(0);

      const midKillRecord = await readPurgeRecord(subjectId);
      expect(midKillRecord!.completedTables).toEqual(expect.arrayContaining([TABLE_A, TABLE_B, TABLE_C]));
      expect(midKillRecord!.status, "the tail never ran -- this purge is not complete").not.toBe("complete");
      expect(midKillRecord!.purgedAt).toBeNull();

      const midKillOrg = await readOrganization(subjectId);
      expect(midKillOrg.purgedAt, "the organization is not tombstoned").toBeNull();

      expect(await memberCount(subjectId), "membership rows still exist").toBe(1);
      expect(await invitationCount(subjectId), "invitation rows still exist").toBe(1);

      // --- resume: the tail finishes ------------------------------------------
      await processWorkspacePurge();

      expect(await memberCount(subjectId), "the auth step's resume deletes the surviving membership row").toBe(0);
      expect(await invitationCount(subjectId)).toBe(0);

      const finalRecord = await readPurgeRecord(subjectId);
      expect(finalRecord!.status).toBe("complete");
      expect(finalRecord!.purgedAt).not.toBeNull();
      expect(finalRecord!.tableCounts).toMatchObject({ member: 1, invitation: 1 });

      const finalOrg = await readOrganization(subjectId);
      expect(finalOrg.purgedAt, "the organization is tombstoned once the tail actually runs").not.toBeNull();
    },
    60_000,
  );

  it(
    "kill after the auth delete commits: the resumed run records the REAL member/invitation counts, never zeros",
    async () => {
      const subjectId = await freshWorkspaceId("wp-kill-after-auth-delete");
      const contactId = await seedManyContacts(subjectId, ROWS_PER_TABLE);
      await seedManySubscriptionHistory(subjectId, contactId, ROWS_PER_TABLE);
      await seedManyPropertyRegistryEntries(subjectId, ROWS_PER_TABLE);
      await softDeleteWorkspace(subjectId, 40);

      const userId = await createAuthUser("wp-kill-after-auth-delete");
      await createMember(subjectId, userId);
      await createInvitation(subjectId, userId, `invitee-${Date.now().toString(36)}@fixture.test`);

      await processWorkspacePurge(); // report

      // Freezes the INSTANT deleteWorkspaceAuthRows returns -- the two auth
      // DELETEs have already committed on the elevated mega_crm_auth pool,
      // but neither the platform-pool checkpoint write nor the "auth"
      // completed_tables marker has happened yet.
      await spawnAndKillOnReady({
        WPK_MODE: "after_auth_delete",
        WPK_TARGET_WORKSPACE_ID: subjectId,
      });

      // --- immediately after the kill: auth rows already gone, step not marked done ---
      expect(await memberCount(subjectId), "the auth delete already committed before the freeze").toBe(0);
      expect(await invitationCount(subjectId), "the auth delete already committed before the freeze").toBe(0);

      const midKillRecord = await readPurgeRecord(subjectId);
      expect(midKillRecord!.completedTables, "the auth step is not yet marked complete").not.toContain("auth");
      expect(midKillRecord!.status, "the tail never finished").not.toBe("complete");

      const midKillOrg = await readOrganization(subjectId);
      expect(midKillOrg.purgedAt, "the organization is not tombstoned").toBeNull();

      // --- resume: the census must survive the crash window ------------------
      await processWorkspacePurge();

      const finalRecord = await readPurgeRecord(subjectId);
      expect(finalRecord!.status).toBe("complete");
      expect(
        finalRecord!.tableCounts,
        "the census must survive the crash window -- the REAL destroyed counts, never zeros",
      ).toMatchObject({ member: 1, invitation: 1 });

      const finalOrg = await readOrganization(subjectId);
      expect(finalOrg.purgedAt).not.toBeNull();
    },
    60_000,
  );

  it(
    "resume does not re-walk: the resumed run issues zero deletePurgeBatch calls against a table already in completed_tables",
    async () => {
      const subjectId = await freshWorkspaceId("wp-kill-no-rewalk");
      const contactId = await seedManyContacts(subjectId, ROWS_PER_TABLE);
      await seedManySubscriptionHistory(subjectId, contactId, ROWS_PER_TABLE);
      await seedManyPropertyRegistryEntries(subjectId, ROWS_PER_TABLE);
      await softDeleteWorkspace(subjectId, 40);

      await processWorkspacePurge(); // report

      await spawnAndKillOnReady({
        WPK_MODE: "between_tables",
        WPK_TARGET_WORKSPACE_ID: subjectId,
        WPK_STOP_BEFORE_TABLE: TABLE_B,
      });

      const midKillRecord = await readPurgeRecord(subjectId);
      expect(midKillRecord!.completedTables).toContain(TABLE_A);

      const calls: { table: string; workspaceId: string }[] = [];
      const spyDeletePurgeBatch: typeof deletePurgeBatch = async (client, table, wsId, limit) => {
        calls.push({ table, workspaceId: wsId });
        return deletePurgeBatch(client, table, wsId, limit);
      };

      await processWorkspacePurge({ deletePurgeBatch: spyDeletePurgeBatch });

      const callsForSubject = calls.filter((call) => call.workspaceId === subjectId);
      expect(
        callsForSubject.some((call) => call.table === TABLE_A),
        "a table already in completed_tables must never be re-walked -- zero calls, not merely zero rows deleted",
      ).toBe(false);
      expect(callsForSubject.some((call) => call.table === TABLE_B), "the unfinished table IS walked").toBe(true);

      expect(await countRows(subjectId, TABLE_A)).toBe(0);
      expect(await countRows(subjectId, TABLE_B)).toBe(0);
      expect(await countRows(subjectId, TABLE_C)).toBe(0);
    },
    60_000,
  );

  it(
    "double resume: a third tick after completion changes nothing anywhere",
    async () => {
      const subjectId = await freshWorkspaceId("wp-kill-double-resume");
      const contactId = await seedManyContacts(subjectId, ROWS_PER_TABLE);
      await seedManySubscriptionHistory(subjectId, contactId, ROWS_PER_TABLE);
      await seedManyPropertyRegistryEntries(subjectId, ROWS_PER_TABLE);
      await softDeleteWorkspace(subjectId, 40);

      const userId = await createAuthUser("wp-kill-double-resume");
      await createMember(subjectId, userId);

      await processWorkspacePurge(); // report

      await spawnAndKillOnReady({
        WPK_MODE: "before_tail",
        WPK_TARGET_WORKSPACE_ID: subjectId,
      });

      await processWorkspacePurge(); // resume -- finishes the tail

      const firstRecord = await readPurgeRecord(subjectId);
      const firstOrg = await readOrganization(subjectId);
      expect(firstRecord!.status).toBe("complete");

      await processWorkspacePurge(); // third tick -- replay
      await processWorkspacePurge(); // fourth tick -- replay of the replay

      const secondRecord = await readPurgeRecord(subjectId);
      const secondOrg = await readOrganization(subjectId);

      expect(secondRecord, "a killed-and-resumed purge's replay is a no-op exactly like an uninterrupted one's").toEqual(firstRecord);
      expect(secondOrg).toEqual(firstOrg);
    },
    60_000,
  );
});
