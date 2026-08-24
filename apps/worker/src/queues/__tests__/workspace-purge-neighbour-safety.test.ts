import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { PURGE_TABLE_ORDER, countPurgeTableRows, type PurgeTable } from "@mega-crm/db";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization, createFixtureContact } from "../../test/failure-fixtures.js";
import { processWorkspacePurge } from "../workspace-purge.worker.js";

/**
 * Phase 22, plan 22-05, Task 3 (PRG-04, SC4): the neighbour proof this
 * phase's whole partition-safety claim rests on -- another workspace's rows
 * in the SAME monthly partition are provably unchanged, provably never
 * blocked, and no structural partition operation (DROP/DETACH/TRUNCATE) is
 * ever issued. Real Postgres, real partitions -- a mocked database cannot
 * prove this claim (this file's own `<action>` guidance).
 *
 * `events`/`send_events` rows for BOTH workspaces are seeded with
 * `occurred_at = now()` so they land in the SAME current-month partition
 * `ensureTestDbMigrated()` already created (via `ensurePartitions`'s
 * `LOOKAHEAD_MONTHS` window) -- no need to hand-pick a future month the way
 * `relocate-default.test.ts` does, since that file is proving something
 * about DEFAULT specifically.
 */
describe("workspace purge: neighbour partition safety (plan 22-05, Task 3)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function softDeleteWorkspace(workspaceId: string, daysAgo: number): Promise<void> {
    await pool.query(`UPDATE organization SET "deletedAt" = now() - ($2 || ' days')::interval WHERE id = $1`, [
      workspaceId,
      daysAgo,
    ]);
  }

  interface PurgeRecordRow {
    status: string;
    tableCounts: Record<string, number>;
    completedTables: string[];
  }

  async function readPurgeRecord(workspaceId: string): Promise<PurgeRecordRow | null> {
    const { rows } = await pool.query<PurgeRecordRow>(
      `SELECT status, table_counts AS "tableCounts", completed_tables AS "completedTables"
         FROM purge_records WHERE workspace_id = $1`,
      [workspaceId],
    );
    return rows[0] ?? null;
  }

  async function countTable(workspaceId: string, table: PurgeTable): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction((client) => countPurgeTableRows(client, table, workspaceId)),
    );
  }

  /** Bulk insert via `generate_series` -- mirrors `relocate-default.test.ts`'s own `seedEvents` shape. */
  async function seedEventsFor(workspaceId: string, contactId: string, count: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
           SELECT gen_random_uuid(), $1, $2, 'neighbour_test_event', '{}'::jsonb, now()
             FROM generate_series(1, $3)`,
          [workspaceId, contactId, count],
        ),
      ),
    );
  }

  /** send_id left NULL (orphan row) -- avoids needing a `sends` fixture; the column is nullable by design. */
  async function seedSendEventsFor(workspaceId: string, count: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, event_type, payload, occurred_at)
           SELECT gen_random_uuid(), $1, 'sg-evt-' || gen_random_uuid()::text, 'delivered', '{}'::jsonb, now()
             FROM generate_series(1, $2)`,
          [workspaceId, count],
        ),
      ),
    );
  }

  async function readAllRows(workspaceId: string, table: "events" | "send_events"): Promise<Record<string, unknown>[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT * FROM ${table} WHERE workspace_id = $1 ORDER BY id`, [workspaceId]);
        return rows as Record<string, unknown>[];
      }),
    );
  }

  /** `pg_inherits`/`pg_class` enumeration of a partitioned parent's current children, by name. */
  async function listPartitions(parentTable: string): Promise<string[]> {
    const { rows } = await pool.query<{ relname: string }>(
      `SELECT c.relname
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = $1
        ORDER BY c.relname`,
      [parentTable],
    );
    return rows.map((r) => r.relname);
  }

  it("neighbour rows unchanged: another workspace's rows in the same monthly partitions are byte-identical after a purge", async () => {
    const workspaceA = await freshWorkspaceId("neighbour-unchanged-a");
    const workspaceB = await freshWorkspaceId("neighbour-unchanged-b");
    await softDeleteWorkspace(workspaceA, 40);

    const contactA = await createFixtureContact(workspaceA);
    const contactB = await createFixtureContact(workspaceB);

    await seedEventsFor(workspaceA, contactA, 5);
    await seedEventsFor(workspaceB, contactB, 5);
    await seedSendEventsFor(workspaceA, 5);
    await seedSendEventsFor(workspaceB, 5);

    const beforeEventsB = await readAllRows(workspaceB, "events");
    const beforeSendEventsB = await readAllRows(workspaceB, "send_events");
    expect(beforeEventsB.length).toBe(5);
    expect(beforeSendEventsB.length).toBe(5);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    const afterEventsB = await readAllRows(workspaceB, "events");
    const afterSendEventsB = await readAllRows(workspaceB, "send_events");

    expect(afterEventsB).toEqual(beforeEventsB);
    expect(afterSendEventsB).toEqual(beforeSendEventsB);

    expect(await countTable(workspaceA, "events")).toBe(0);
    expect(await countTable(workspaceA, "send_events")).toBe(0);
    expect(await countTable(workspaceB, "events")).toBe(5);
    expect(await countTable(workspaceB, "send_events")).toBe(5);
  });

  it("purge count is A's alone: table_counts reflects only A's own rows, never inflated by B's rows sharing the partition", async () => {
    const workspaceA = await freshWorkspaceId("neighbour-count-a");
    const workspaceB = await freshWorkspaceId("neighbour-count-b");
    await softDeleteWorkspace(workspaceA, 40);
    const contactA = await createFixtureContact(workspaceA);
    const contactB = await createFixtureContact(workspaceB);

    await seedEventsFor(workspaceA, contactA, 3);
    await seedEventsFor(workspaceB, contactB, 7);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    const record = await readPurgeRecord(workspaceA);
    expect(record!.tableCounts.events).toBe(3);
    expect(await countTable(workspaceB, "events")).toBe(7);
  });

  it("no structural partition operation: every partition existing before the purge still exists after it", async () => {
    const workspaceA = await freshWorkspaceId("neighbour-structural-a");
    await softDeleteWorkspace(workspaceA, 40);
    const contactA = await createFixtureContact(workspaceA);
    await seedEventsFor(workspaceA, contactA, 3);
    await seedSendEventsFor(workspaceA, 3);

    const beforeEventsPartitions = await listPartitions("events");
    const beforeSendEventsPartitions = await listPartitions("send_events");
    expect(beforeEventsPartitions.length).toBeGreaterThan(0);
    expect(beforeSendEventsPartitions.length).toBeGreaterThan(0);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    const afterEventsPartitions = await listPartitions("events");
    const afterSendEventsPartitions = await listPartitions("send_events");

    expect(afterEventsPartitions).toEqual(beforeEventsPartitions);
    expect(afterSendEventsPartitions).toEqual(beforeSendEventsPartitions);

    // Secondary guard (comment-stripped, per this task's own guidance --
    // prose explaining the rule must not be able to fail the gate; the
    // observable partition-existence check above is the primary proof).
    const stripComments = (src: string): string =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");

    const purgeTablesSource = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../../../packages/db/src/workspace-purge-tables.ts",
      ),
      "utf8",
    );
    const workerSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../workspace-purge.worker.ts"),
      "utf8",
    );
    const combined = `${stripComments(purgeTablesSource)}\n${stripComments(workerSource)}`;
    expect(combined).not.toMatch(/\b(DROP|DETACH|TRUNCATE)\b/i);
  });

  it("concurrent neighbour write is not blocked: B can insert and update in the same partition while A's purge is walking it", async () => {
    const workspaceA = await freshWorkspaceId("neighbour-concurrent-a");
    const workspaceB = await freshWorkspaceId("neighbour-concurrent-b");
    await softDeleteWorkspace(workspaceA, 40);
    const contactA = await createFixtureContact(workspaceA);
    const contactB = await createFixtureContact(workspaceB);

    // Large enough to force multiple 500-row batches for `events`, so A's
    // purge walk over the shared partition takes measurable wall-clock time.
    await seedEventsFor(workspaceA, contactA, 600);
    await seedEventsFor(workspaceB, contactB, 1);

    await processWorkspacePurge(); // report

    const purgePromise = processWorkspacePurge(); // destroy -- not awaited yet

    const writeClient = await pool.connect();
    let writeSucceeded = false;
    try {
      // A short statement timeout: if the purge's batches were somehow
      // blocking B's writer, this query fails fast instead of hanging the
      // whole suite. Keep it transaction-local so the pooled connection
      // cannot leak the timeout into its next checkout.
      await writeClient.query("BEGIN");
      await writeClient.query("SET LOCAL statement_timeout = '2000'");
      await writeClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceB]);
      await writeClient.query(
        `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
         VALUES (gen_random_uuid(), $1, $2, 'neighbour_concurrent_write', '{}'::jsonb, now())`,
        [workspaceB, contactB],
      );
      await writeClient.query(
        `UPDATE events SET name = 'neighbour_concurrent_update' WHERE workspace_id = $1 AND contact_id = $2 AND name = 'neighbour_test_event'`,
        [workspaceB, contactB],
      );
      await writeClient.query("COMMIT");
      writeSucceeded = true;
    } catch (err) {
      await writeClient.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      writeClient.release();
    }

    await purgePromise;

    expect(writeSucceeded).toBe(true);
    expect(await countTable(workspaceA, "events")).toBe(0);
    expect(await countTable(workspaceB, "events")).toBe(2);
  }, 60_000);

  it("a locked row is retried, not lost: the purge never declares a table done while a row still remains", async () => {
    const workspaceA = await freshWorkspaceId("neighbour-lock-retry-a");
    await softDeleteWorkspace(workspaceA, 40);
    const contactA = await createFixtureContact(workspaceA);

    const eventId = await withTenant(workspaceA, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, 'lock_retry_test_event', '{}'::jsonb, now())
           RETURNING id`,
          [workspaceA, contactA],
        );
        return rows[0].id;
      }),
    );

    await processWorkspacePurge(); // report

    const lockClient = await pool.connect();
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceA]);
    await lockClient.query(`SELECT * FROM events WHERE id = $1 FOR UPDATE`, [eventId]);

    try {
      // Held for the ENTIRE destructive tick -- every one of
      // walkPurgeTable's MAX_ATTEMPTS retries sees this row as SKIP LOCKED,
      // so the walk MUST fail loudly rather than silently declare `events`
      // complete while this row is still present. This is the deterministic
      // half of the plan's "either completes after retry, or fails loudly"
      // contract -- holding the lock for the whole tick removes the timing
      // race the other half would require.
      await expect(processWorkspacePurge()).rejects.toThrow(/still has rows/);
    } finally {
      await lockClient.query("COMMIT");
      lockClient.release();
    }

    // The row was never deleted -- SKIP LOCKED skipped it on every attempt.
    expect(await countTable(workspaceA, "events")).toBe(1);

    const record = await readPurgeRecord(workspaceA);
    expect(record!.status).toBe("failed");
    expect(record!.completedTables).not.toContain("events");

    // 'failed' is a terminal state for automation -- a later tick does not
    // silently resume (workspace-purge.worker.ts's own header comment,
    // mirrored by workspace-purge.test.ts's "restored mid-walk" case).
    await processWorkspacePurge();
    const afterLaterTick = await readPurgeRecord(workspaceA);
    expect(afterLaterTick!.status).toBe("failed");
  });

  it("regression: PURGE_TABLE_ORDER still contains both partitioned tables (sanity for this file's own fixtures)", () => {
    expect(PURGE_TABLE_ORDER).toContain("events");
    expect(PURGE_TABLE_ORDER).toContain("send_events");
  });
});
