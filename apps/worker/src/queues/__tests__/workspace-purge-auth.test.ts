import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { PURGE_TABLE_ORDER } from "@mega-crm/db";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { createAuthPurgePool, closeAuthPurgePool, countWorkspaceAuthRows, deleteWorkspaceAuthRows } from "../workspace-purge-auth.js";
import { recordAuthPurgeCounts } from "../workspace-purge-checkpoint.js";
import { processWorkspacePurge } from "../workspace-purge.worker.js";

/**
 * Phase 22 (PRG-02, D-12, plan 22-07): proves the workspace purge's reach
 * into the Better Auth tables from both sides -- Task 1 (six cases) proves
 * the trust boundary itself (the ordinary `mega_crm_app` pool still cannot
 * delete `member`/`invitation`, the dedicated `mega_crm_auth` pool can, and
 * global identities are never touched); Task 2 (five cases) proves the auth
 * step's wiring into the full purge state machine (ordering, evidence,
 * fail-loud, and the failed-is-terminal / operator-act-resumes pair 22-01
 * Task 3 defines).
 *
 * Real Postgres throughout -- `auth-boundary.test.ts` already established
 * why: a broken privilege boundary produces no SQL error at all, only a
 * mock would hide that. `authPool` below connects as `mega_crm_auth`
 * directly (the same role `deleteWorkspaceAuthRows` itself uses) so this
 * file's own fixtures can write `member`/`invitation`/`session`/`account`
 * rows that the ordinary `appPool` (mega_crm_app) cannot.
 */
describe("workspace-purge-auth: the mega_crm_auth boundary and its wiring into the purge (plan 22-07)", () => {
  let appPool: Pool;
  let authPool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    appPool = createTestPool();
    // Published into process.env by packages/test-support's global-setup.ts
    // for every workspace's test project -- see that file's own comment.
    authPool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL });
  });

  afterAll(async () => {
    await appPool.end();
    await authPool.end();
    await closeAuthPurgePool();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function softDeleteWorkspace(workspaceId: string, daysAgo: number): Promise<void> {
    await appPool.query(`UPDATE organization SET "deletedAt" = now() - ($2 || ' days')::interval WHERE id = $1`, [
      workspaceId,
      daysAgo,
    ]);
  }

  async function createUser(seed: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      [`Purge Auth ${seed}`, `purge-auth-${seed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`],
    );
    return rows[0].id;
  }

  async function createMember(organizationId: string, userId: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO member ("organizationId", "userId", role) VALUES ($1, $2, 'member') RETURNING id`,
      [organizationId, userId],
    );
    return rows[0].id;
  }

  async function createInvitation(organizationId: string, inviterId: string, email: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO invitation ("organizationId", email, status, "expiresAt", "inviterId")
       VALUES ($1, $2, 'pending', now() + interval '7 days', $3) RETURNING id`,
      [organizationId, email, inviterId],
    );
    return rows[0].id;
  }

  async function createSession(userId: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO session ("expiresAt", token, "userId") VALUES (now() + interval '1 day', $1, $2) RETURNING id`,
      [`purge-auth-session-${randomUUID()}`, userId],
    );
    return rows[0].id;
  }

  async function createAccount(userId: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO account ("accountId", "providerId", "userId") VALUES ($1, 'credential', $2) RETURNING id`,
      [`purge-auth-account-${randomUUID()}`, userId],
    );
    return rows[0].id;
  }

  async function memberCount(organizationId: string): Promise<number> {
    const { rows } = await appPool.query<{ count: string }>(`SELECT count(*) AS count FROM member WHERE "organizationId" = $1`, [
      organizationId,
    ]);
    return Number(rows[0].count);
  }

  async function invitationCount(organizationId: string): Promise<number> {
    const { rows } = await appPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM invitation WHERE "organizationId" = $1`,
      [organizationId],
    );
    return Number(rows[0].count);
  }

  async function userExists(userId: string): Promise<boolean> {
    const { rows } = await appPool.query<{ id: string }>(`SELECT id FROM "user" WHERE id = $1`, [userId]);
    return rows.length === 1;
  }

  /** session/account carry NO privilege for mega_crm_app (migration 0045) -- read through the auth-role pool instead. */
  async function sessionExistsForUser(userId: string): Promise<boolean> {
    const { rows } = await authPool.query<{ id: string }>(`SELECT id FROM session WHERE "userId" = $1`, [userId]);
    return rows.length === 1;
  }

  async function accountExistsForUser(userId: string): Promise<boolean> {
    const { rows } = await authPool.query<{ id: string }>(`SELECT id FROM account WHERE "userId" = $1`, [userId]);
    return rows.length === 1;
  }

  async function memberRow(memberId: string): Promise<{ id: string; organizationId: string } | null> {
    const { rows } = await appPool.query<{ id: string; organizationId: string }>(
      `SELECT id, "organizationId" FROM member WHERE id = $1`,
      [memberId],
    );
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------------
  // Task 1: the mega_crm_auth pool, and proof that the ordinary pool still
  // cannot do this.
  // ---------------------------------------------------------------------

  it("the boundary holds: deleting member through the ordinary mega_crm_app pool is refused with 42501", async () => {
    const organizationId = await freshWorkspaceId("purge-auth-boundary");
    const userId = await createUser("boundary");
    await createMember(organizationId, userId);

    await expect(appPool.query(`DELETE FROM member WHERE "organizationId" = $1`, [organizationId])).rejects.toMatchObject({
      code: "42501",
    });
    // The boundary held -- the row is still there.
    expect(await memberCount(organizationId)).toBe(1);
  });

  it("the auth pool can: deleteWorkspaceAuthRows destroys member rows through mega_crm_auth and reports the count", async () => {
    const organizationId = await freshWorkspaceId("purge-auth-can");
    const userId = await createUser("can-member");
    await createMember(organizationId, userId);

    const counts = await deleteWorkspaceAuthRows(organizationId);

    expect(counts).toEqual({ memberCount: 1, invitationCount: 0 });
    expect(await memberCount(organizationId)).toBe(0);
  });

  it("invitations too: two pending invitations are removed and counted separately from members", async () => {
    const organizationId = await freshWorkspaceId("purge-auth-invites");
    const inviter = await createUser("invites-inviter");
    const memberUser = await createUser("invites-member");
    await createMember(organizationId, memberUser);
    await createInvitation(organizationId, inviter, "invitee-1@fixture.test");
    await createInvitation(organizationId, inviter, "invitee-2@fixture.test");

    const counts = await deleteWorkspaceAuthRows(organizationId);

    expect(counts).toEqual({ memberCount: 1, invitationCount: 2 });
    expect(await invitationCount(organizationId)).toBe(0);
  });

  it("global identities survive: a user who was a member only of the purged workspace still has user/session/account rows", async () => {
    const organizationId = await freshWorkspaceId("purge-auth-survive");
    const userId = await createUser("survive");
    await createMember(organizationId, userId);
    await createSession(userId);
    await createAccount(userId);

    await deleteWorkspaceAuthRows(organizationId);

    expect(await memberCount(organizationId)).toBe(0);
    expect(await userExists(userId)).toBe(true);
    expect(await sessionExistsForUser(userId)).toBe(true);
    expect(await accountExistsForUser(userId)).toBe(true);
  });

  it("another workspace's membership untouched: a user in both workspaces keeps the neighbour's membership row exactly as it was", async () => {
    const orgA = await freshWorkspaceId("purge-auth-neighbour-a");
    const orgB = await freshWorkspaceId("purge-auth-neighbour-b");
    const userId = await createUser("neighbour");
    await createMember(orgA, userId);
    const memberIdB = await createMember(orgB, userId);

    await deleteWorkspaceAuthRows(orgA);

    expect(await memberCount(orgA)).toBe(0);
    expect(await memberCount(orgB)).toBe(1);
    const neighbourRow = await memberRow(memberIdB);
    expect(neighbourRow).toEqual({ id: memberIdB, organizationId: orgB });
  });

  it("missing DSN fails loudly: createAuthPurgePool throws naming AUTH_DATABASE_URL, never falling back", async () => {
    const original = process.env.AUTH_DATABASE_URL;
    await closeAuthPurgePool();
    delete process.env.AUTH_DATABASE_URL;
    try {
      expect(() => createAuthPurgePool()).toThrow(/AUTH_DATABASE_URL/);
    } finally {
      if (original !== undefined) {
        process.env.AUTH_DATABASE_URL = original;
      }
    }
  });

  // ---------------------------------------------------------------------
  // Task 2: wired into the purge -- after the tables, before the tombstone,
  // counted and fail-loud.
  // ---------------------------------------------------------------------

  interface PurgeRecordRow {
    status: string;
    purgedAt: Date | null;
    tableCounts: Record<string, number>;
    completedTables: string[];
    purgeError: string | null;
  }

  async function readPurgeRecord(workspaceId: string): Promise<PurgeRecordRow | null> {
    const { rows } = await appPool.query<PurgeRecordRow>(
      `SELECT status,
              purged_at AS "purgedAt",
              table_counts AS "tableCounts",
              completed_tables AS "completedTables",
              purge_error AS "purgeError"
         FROM purge_records WHERE workspace_id = $1`,
      [workspaceId],
    );
    return rows[0] ?? null;
  }

  async function readOrganization(workspaceId: string): Promise<{ purgedAt: Date | null }> {
    const { rows } = await appPool.query<{ purgedAt: Date | null }>(
      `SELECT "purgedAt" AS "purgedAt" FROM organization WHERE id = $1`,
      [workspaceId],
    );
    return rows[0];
  }

  async function seedContact(workspaceId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed')`,
          [workspaceId, `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`],
        ),
      ),
    );
  }

  async function countContacts(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(`SELECT count(*) AS count FROM contacts WHERE workspace_id = $1`, [
          workspaceId,
        ]);
        return Number(rows[0].count);
      }),
    );
  }

  /** Runs one processWorkspacePurge() tick with AUTH_DATABASE_URL absent -- forces the auth step to throw. */
  async function tickWithAuthDsnMissing(): Promise<unknown> {
    const original = process.env.AUTH_DATABASE_URL;
    await closeAuthPurgePool();
    delete process.env.AUTH_DATABASE_URL;
    try {
      let caught: unknown;
      try {
        await processWorkspacePurge();
      } catch (err) {
        caught = err;
      }
      return caught;
    } finally {
      if (original !== undefined) {
        process.env.AUTH_DATABASE_URL = original;
      }
      await closeAuthPurgePool();
    }
  }

  it("end-to-end purge removes membership: a full purge run removes member/invitation rows and records their counts in table_counts", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-e2e");
    await softDeleteWorkspace(workspaceId, 40);
    const inviter = await createUser("e2e-inviter");
    const memberUserOne = await createUser("e2e-member-1");
    const memberUserTwo = await createUser("e2e-member-2");
    await createMember(workspaceId, memberUserOne);
    await createMember(workspaceId, memberUserTwo);
    await createInvitation(workspaceId, inviter, "e2e-invitee@fixture.test");

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy tables + auth step + tombstone

    expect(await memberCount(workspaceId)).toBe(0);
    expect(await invitationCount(workspaceId)).toBe(0);

    const record = await readPurgeRecord(workspaceId);
    expect(record!.status).toBe("complete");
    expect(record!.purgedAt).not.toBeNull();
    expect(record!.tableCounts).toMatchObject({ member: 2, invitation: 1 });
    expect(record!.completedTables).toContain("auth");

    const organization = await readOrganization(workspaceId);
    expect(organization.purgedAt).not.toBeNull();
  });

  it("ordering: the auth step only runs once every PURGE_TABLE_ORDER table is drained, and a failure there leaves the organization un-tombstoned", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-ordering");
    await softDeleteWorkspace(workspaceId, 40);
    await seedContact(workspaceId);

    await processWorkspacePurge(); // report

    const thrown = await tickWithAuthDsnMissing(); // destroy tables, then throw at the auth step
    expect(thrown).toBeDefined();

    const record = await readPurgeRecord(workspaceId);
    expect(record!.status).toBe("failed");
    // Every real PURGE_TABLE_ORDER table finished BEFORE the auth step was
    // even attempted -- proving the fixed order, not merely that SOMETHING
    // failed.
    for (const table of PURGE_TABLE_ORDER) {
      expect(record!.completedTables).toContain(table);
    }
    expect(record!.completedTables).not.toContain("auth");

    const organization = await readOrganization(workspaceId);
    expect(organization.purgedAt).toBeNull();
  });

  it("auth failure fails the purge: purge_records is marked failed, purged_at stays null, the organization is not tombstoned, and earlier destructive work is not undone", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-failure");
    await softDeleteWorkspace(workspaceId, 40);
    await seedContact(workspaceId);
    await seedContact(workspaceId);

    await processWorkspacePurge(); // report

    const thrown = await tickWithAuthDsnMissing();
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/AUTH_DATABASE_URL/);

    const record = await readPurgeRecord(workspaceId);
    expect(record!.status).toBe("failed");
    expect(record!.purgedAt).toBeNull();
    expect(record!.purgeError).toMatch(/AUTH_DATABASE_URL/);

    const organization = await readOrganization(workspaceId);
    expect(organization.purgedAt).toBeNull();

    // The tenant tables' destructive work already committed is NOT undone by
    // the later auth failure.
    expect(await countContacts(workspaceId)).toBe(0);
  });

  it("a fixed DSN alone does not resume: a tick against a still-failed record deletes nothing and changes nothing", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-no-auto-resume");
    await softDeleteWorkspace(workspaceId, 40);
    const inviter = await createUser("no-resume-inviter");
    const memberUser = await createUser("no-resume-member");
    await createMember(workspaceId, memberUser);
    await createInvitation(workspaceId, inviter, "no-resume-invitee@fixture.test");

    await processWorkspacePurge(); // report
    await tickWithAuthDsnMissing(); // destroy tables, fail at auth step -> status 'failed'

    const failedRecord = await readPurgeRecord(workspaceId);
    expect(failedRecord!.status).toBe("failed");
    // AUTH_DATABASE_URL is restored by tickWithAuthDsnMissing's own finally
    // block -- the DSN is fixed, but the record is still 'failed'.
    expect(process.env.AUTH_DATABASE_URL).toBeDefined();

    await processWorkspacePurge(); // a plain tick -- must be a no-op against a 'failed' record

    expect(await memberCount(workspaceId)).toBe(1);
    expect(await invitationCount(workspaceId)).toBe(1);
    const stillFailedRecord = await readPurgeRecord(workspaceId);
    expect(stillFailedRecord!.status).toBe("failed");
    const organization = await readOrganization(workspaceId);
    expect(organization.purgedAt).toBeNull();
  });

  it("the operator act resumes and completes: returning the record to purging lets the next tick finish the auth step and tombstone", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-operator-resume");
    await softDeleteWorkspace(workspaceId, 40);
    const inviter = await createUser("resume-inviter");
    const memberUser = await createUser("resume-member");
    await createMember(workspaceId, memberUser);
    await createInvitation(workspaceId, inviter, "resume-invitee@fixture.test");

    await processWorkspacePurge(); // report
    await tickWithAuthDsnMissing(); // destroy tables, fail at auth step -> status 'failed'

    expect((await readPurgeRecord(workspaceId))!.status).toBe("failed");

    // The exact operator statement 22-08's runbook documents.
    await appPool.query(`UPDATE purge_records SET status = 'purging', purge_error = NULL WHERE workspace_id = $1`, [
      workspaceId,
    ]);

    await processWorkspacePurge(); // resumes: tenant tables already complete, only the auth step + tombstone remain

    expect(await memberCount(workspaceId)).toBe(0);
    expect(await invitationCount(workspaceId)).toBe(0);

    const record = await readPurgeRecord(workspaceId);
    expect(record!.status).toBe("complete");
    expect(record!.purgeError).toBeNull();
    expect(record!.completedTables).toContain("auth");
    expect(record!.tableCounts).toMatchObject({ member: 1, invitation: 1 });

    const organization = await readOrganization(workspaceId);
    expect(organization.purgedAt).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // Gap-closure plan 22-11: countWorkspaceAuthRows on the ordinary pool, and
  // recordAuthPurgeCounts's write-once merge.
  // ---------------------------------------------------------------------

  /**
   * Minimal non-actionable record -- the write-once cases assert on the JSONB
   * merge itself, not a whole purge. Keep it terminal so a later test file's
   * global purge tick cannot mistake this live workspace for resumable work.
   */
  async function insertBarePurgeRecord(workspaceId: string, tableCounts: Record<string, number> = {}): Promise<void> {
    await appPool.query(
      `INSERT INTO purge_records (workspace_id, soft_deleted_at, eligible_at, status, table_counts)
       VALUES ($1, now(), now(), 'failed', $2::jsonb)`,
      [workspaceId, JSON.stringify(tableCounts)],
    );
  }

  it("countWorkspaceAuthRows reads member/invitation on the ordinary pool, scoped to the workspace", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-count-ordinary-pool");
    const inviter = await createUser("count-inviter");
    const memberUserOne = await createUser("count-member-1");
    const memberUserTwo = await createUser("count-member-2");
    await createMember(workspaceId, memberUserOne);
    await createMember(workspaceId, memberUserTwo);
    await createInvitation(workspaceId, inviter, "count-invitee@fixture.test");

    const counts = await countWorkspaceAuthRows(appPool, workspaceId);

    expect(counts).toEqual({ memberCount: 2, invitationCount: 1 });
  });

  it("countWorkspaceAuthRows returns zeros for a genuinely empty workspace", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-count-empty");

    const counts = await countWorkspaceAuthRows(appPool, workspaceId);

    expect(counts).toEqual({ memberCount: 0, invitationCount: 0 });
  });

  it("recordAuthPurgeCounts is write-once: a second call with different numbers never overwrites the first-written counts", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-write-once");
    await insertBarePurgeRecord(workspaceId);

    await recordAuthPurgeCounts(appPool, workspaceId, { memberCount: 3, invitationCount: 2 });
    await recordAuthPurgeCounts(appPool, workspaceId, { memberCount: 0, invitationCount: 0 });

    const record = await readPurgeRecord(workspaceId);
    expect(
      record!.tableCounts,
      "the second call's zeros must never replace the first call's real destroyed counts",
    ).toMatchObject({ member: 3, invitation: 2 });
  });

  it("recordAuthPurgeCounts on a genuinely empty workspace still records both keys present at zero", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-zero-still-recorded");
    await insertBarePurgeRecord(workspaceId);

    await recordAuthPurgeCounts(appPool, workspaceId, { memberCount: 0, invitationCount: 0 });

    const record = await readPurgeRecord(workspaceId);
    expect(record!.tableCounts).toHaveProperty("member", 0);
    expect(record!.tableCounts).toHaveProperty("invitation", 0);
  });

  it("recordAuthPurgeCounts never disturbs an existing tenant-table census key", async () => {
    const workspaceId = await freshWorkspaceId("purge-auth-census-untouched");
    await insertBarePurgeRecord(workspaceId, { contacts: 42, flows: 7 });

    await recordAuthPurgeCounts(appPool, workspaceId, { memberCount: 1, invitationCount: 1 });

    const record = await readPurgeRecord(workspaceId);
    expect(record!.tableCounts).toMatchObject({ contacts: 42, flows: 7, member: 1, invitation: 1 });
  });
});
