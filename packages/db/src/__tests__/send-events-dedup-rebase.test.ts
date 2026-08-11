import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  applyMigrationsUpTo,
  buildRoleDsn,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  SCAN_ROLE,
} from "@mega-crm/test-support";

import { incrementWorkspaceDailyRollup } from "../analytics/daily-rollup.js";

import {
  countAllDuplicates,
  countDuplicatesForWorkspace,
  resolveAllDuplicates,
  resolveDuplicatesForWorkspace,
} from "../../scripts/count-send-event-duplicates.js";

/**
 * Phase 13 (CMP-07, plan 13-07), Task 1: proves `count-send-event-duplicates.ts`'s
 * counting and bounded-batched resolution against a real ephemeral Postgres,
 * on the schema as it exists BEFORE migration 0057 -- deliberately checked
 * out at migration 0056 via `applyMigrationsUpTo` (mirrors
 * `migrate-incremental.test.ts`'s own checkpoint convention), because once
 * 0057 lands the enforced unique index on `(workspace_id, send_id,
 * event_type, occurred_at)` makes it impossible to construct the very
 * duplicate rows this script exists to find and resolve -- the OLD key
 * `(workspace_id, sg_event_id, occurred_at)` is still all that is enforced
 * at this checkpoint, so two rows sharing the new key but differing only in
 * `sg_event_id` insert cleanly, exactly the historical shape CMP-07 exists
 * to clean up.
 *
 * Migration 0057's own apply-time behavior (the guard, the index, the
 * constraint swap) is covered separately, in this same file, by Task 2's
 * describe block below.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const CHECKPOINT_BEFORE_0057 = "0056_workspace_daily_rollup_dirtied_at.sql";

const SCRIPT_SOURCE = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/count-send-event-duplicates.ts"),
  "utf8",
);

function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createWorkspace(adminPool: Pool, seed: string): Promise<string> {
  const workspaceId = randomUUID();
  await adminPool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
    workspaceId,
    `Dedup Test ${seed}`,
    `dedup-test-${seed}-${workspaceId.slice(0, 8)}`,
  ]);
  return workspaceId;
}

async function withTenantWrite<T>(pool: Pool, workspaceId: string, fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function createContact(pool: Pool, workspaceId: string): Promise<string> {
  const contactId = randomUUID();
  await withTenantWrite(pool, workspaceId, (client) =>
    client.query(`INSERT INTO contacts (id, workspace_id, external_id) VALUES ($1, $2, $3)`, [
      contactId,
      workspaceId,
      `contact-${contactId.slice(0, 8)}`,
    ]),
  );
  return contactId;
}

async function createSend(pool: Pool, workspaceId: string, contactId: string): Promise<string> {
  const sendId = randomUUID();
  await withTenantWrite(pool, workspaceId, (client) =>
    client.query(
      `INSERT INTO sends (id, workspace_id, contact_id, kind, status, sent_at) VALUES ($1, $2, $3, 'campaign', 'sent', now())`,
      [sendId, workspaceId, contactId],
    ),
  );
  return sendId;
}

interface SendEventSeed {
  sendId: string | null;
  eventType: string;
  occurredAt: Date;
  receivedAt: Date;
  sgEventId?: string;
}

async function insertSendEvent(pool: Pool, workspaceId: string, seed: SendEventSeed): Promise<string> {
  const id = randomUUID();
  await withTenantWrite(pool, workspaceId, (client) =>
    client.query(
      `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at, received_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $7)`,
      [id, workspaceId, seed.sgEventId ?? `sg-${id}`, seed.sendId, seed.eventType, seed.occurredAt, seed.receivedAt],
    ),
  );
  return id;
}

async function sendEventIds(pool: Pool, workspaceId: string): Promise<{ id: string; receivedAt: Date }[]> {
  return withTenantWrite(pool, workspaceId, async (client) => {
    const { rows } = await client.query<{ id: string; received_at: Date }>(
      `SELECT id, received_at FROM send_events ORDER BY received_at ASC`,
    );
    return rows.map((r) => ({ id: r.id, receivedAt: r.received_at }));
  });
}

describe("count-send-event-duplicates script (Phase 13, CMP-07, plan 13-07, Task 1)", () => {
  let adminPool: Pool;
  let appPool: Pool;
  let scanPool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "dedup-duplicates-count" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;

    appPool = new Pool({ connectionString: created.dsn, max: 5 });
    adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });
    scanPool = new Pool({
      connectionString: buildRoleDsn(adminDsnForDatabase(adminDsn, databaseName), databaseName, SCAN_ROLE, "mega_crm_dev_pw"),
      max: 5,
    });

    // Checked out BEFORE 0057 -- see this file's header comment for why.
    await applyMigrationsUpTo(appPool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0057);
  }, 60_000);

  afterAll(async () => {
    await scanPool?.end();
    await adminPool?.end();
    await appPool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("introduces no new GRANT statement", () => {
    expect(SCRIPT_SOURCE).not.toMatch(/\bGRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL|USAGE|EXECUTE)\b/i);
  });

  it("performs no DELETE when --resolve is absent (read path never mutates)", () => {
    // Static proof the read path contains no DELETE statement at all --
    // countDuplicatesForWorkspace/countAllDuplicates below are the only
    // functions the default (no --resolve) CLI path calls.
    const readPathSource = SCRIPT_SOURCE.slice(0, SCRIPT_SOURCE.indexOf("export async function resolveDuplicatesForWorkspace"));
    expect(readPathSource).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("reports 1 duplicate group and 1 row to resolve for two rows sharing the new key but differing only in sg_event_id", async () => {
    const workspaceId = await createWorkspace(adminPool, "basic");
    const contactId = await createContact(appPool, workspaceId);
    const sendId = await createSend(appPool, workspaceId, contactId);
    const occurredAt = new Date();

    await insertSendEvent(appPool, workspaceId, {
      sendId,
      eventType: "delivered",
      occurredAt,
      receivedAt: new Date(occurredAt.getTime()),
    });
    await insertSendEvent(appPool, workspaceId, {
      sendId,
      eventType: "delivered",
      occurredAt,
      receivedAt: new Date(occurredAt.getTime() + 1000),
    });

    const result = await countDuplicatesForWorkspace(appPool, workspaceId);
    expect(result).toEqual({ groups: 1, rowsToResolve: 1 });
  });

  it("reports 0 duplicate groups for two null-send_id rows sharing everything else", async () => {
    const workspaceId = await createWorkspace(adminPool, "orphan");
    const occurredAt = new Date();

    await insertSendEvent(appPool, workspaceId, {
      sendId: null,
      eventType: "delivered",
      occurredAt,
      receivedAt: new Date(occurredAt.getTime()),
    });
    await insertSendEvent(appPool, workspaceId, {
      sendId: null,
      eventType: "delivered",
      occurredAt,
      receivedAt: new Date(occurredAt.getTime() + 1000),
    });

    const result = await countDuplicatesForWorkspace(appPool, workspaceId);
    expect(result).toEqual({ groups: 0, rowsToResolve: 0 });
  });

  it("--resolve leaves exactly the earlier-received_at row, and a second run deletes nothing", async () => {
    const workspaceId = await createWorkspace(adminPool, "resolve-once");
    const contactId = await createContact(appPool, workspaceId);
    const sendId = await createSend(appPool, workspaceId, contactId);
    const occurredAt = new Date();

    const earlierId = await insertSendEvent(appPool, workspaceId, {
      sendId,
      eventType: "delivered",
      occurredAt,
      receivedAt: new Date(occurredAt.getTime()),
    });
    await insertSendEvent(appPool, workspaceId, {
      sendId,
      eventType: "delivered",
      occurredAt,
      receivedAt: new Date(occurredAt.getTime() + 5000),
    });

    const first = await resolveDuplicatesForWorkspace(appPool, workspaceId, 500);
    expect(first).toEqual({ workspaceId, deletedCount: 1, batches: 1 });

    const survivors = await sendEventIds(appPool, workspaceId);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].id).toBe(earlierId);

    const second = await resolveDuplicatesForWorkspace(appPool, workspaceId, 500);
    expect(second).toEqual({ workspaceId, deletedCount: 0, batches: 0 });
  });

  it("issues more than one committed batch when the rows to resolve exceed the page size", async () => {
    const workspaceId = await createWorkspace(adminPool, "resolve-batched");
    const contactId = await createContact(appPool, workspaceId);
    const sendId = await createSend(appPool, workspaceId, contactId);

    // Two SEPARATE duplicate groups (distinct event_type), one excess row
    // each -- 2 total rows to resolve, page size 1 forces 2 batches.
    for (const eventType of ["delivered", "open"]) {
      const occurredAt = new Date();
      await insertSendEvent(appPool, workspaceId, {
        sendId,
        eventType,
        occurredAt,
        receivedAt: new Date(occurredAt.getTime()),
      });
      await insertSendEvent(appPool, workspaceId, {
        sendId,
        eventType,
        occurredAt,
        receivedAt: new Date(occurredAt.getTime() + 1000),
      });
    }

    const batchSizes: number[] = [];
    const result = await resolveDuplicatesForWorkspace(appPool, workspaceId, 1, (batchDeleted) => {
      batchSizes.push(batchDeleted);
    });

    expect(result.deletedCount).toBe(2);
    expect(result.batches).toBe(2);
    expect(batchSizes).toEqual([1, 1]);
  });

  it("countAllDuplicates/resolveAllDuplicates (the CLI's own code path) enumerate workspaces via the scan role and reach the same per-workspace result", async () => {
    const workspaceId = await createWorkspace(adminPool, "all-wrapper");
    const contactId = await createContact(appPool, workspaceId);
    const sendId = await createSend(appPool, workspaceId, contactId);
    const occurredAt = new Date();

    await insertSendEvent(appPool, workspaceId, {
      sendId,
      eventType: "delivered",
      occurredAt,
      receivedAt: new Date(occurredAt.getTime()),
    });
    await insertSendEvent(appPool, workspaceId, {
      sendId,
      eventType: "delivered",
      occurredAt,
      receivedAt: new Date(occurredAt.getTime() + 1000),
    });

    const countReport = await countAllDuplicates(scanPool, appPool);
    const thisWorkspace = countReport.perWorkspace.find((w) => w.workspaceId === workspaceId);
    expect(thisWorkspace).toEqual({ workspaceId, groups: 1, rowsToResolve: 1 });

    const resolveReport = await resolveAllDuplicates(scanPool, appPool, 500);
    const resolvedWorkspace = resolveReport.perWorkspace.find((w) => w.workspaceId === workspaceId);
    expect(resolvedWorkspace).toEqual({ workspaceId, deletedCount: 1, batches: 1 });
  });
});

const MIGRATION_0057_FILENAME = "0057_send_events_dedup_rebase.sql";
const DEDUP_V2_INDEX = "send_events_dedup_v2_idx";
const OLD_CONSTRAINT_NAME = "send_events_workspace_id_sg_event_id_occurred_at_key";

interface IndexValidity {
  exists: boolean;
  valid: boolean | null;
}

async function indexValidity(pool: Pool, indexName: string): Promise<IndexValidity> {
  const { rows } = await pool.query<{ indisvalid: boolean }>(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [indexName],
  );
  if (rows.length === 0) return { exists: false, valid: null };
  return { exists: true, valid: rows[0].indisvalid };
}

async function constraintExists(pool: Pool, relation: string, constraintName: string): Promise<boolean> {
  const { rows } = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
    [relation, constraintName],
  );
  return rows.length > 0;
}

/**
 * Phase 13 (CMP-07, plan 13-07), Task 2: proves migration 0057's actual
 * apply-time behavior -- the fail-closed duplicate guard, the blocking
 * parent-level unique index build, the per-partition enforcement it leaves
 * behind, and the old-constraint drop -- against a real ephemeral Postgres.
 * `applyMigrationFile` sends a migration file as ONE query call, which
 * `pg` executes as one implicit transaction (the SAME mechanism
 * `db-fixture.ts`'s own `applyPendingMigrations` and every other migration
 * test in this file/package rely on) -- when Step 0's guard raises, nothing
 * else in 0057 (the index build, the drop) takes effect, which is exactly
 * what "leaves both rows and the old constraint in place" (a `must_haves`
 * truth of this plan) depends on.
 */
describe("migration 0057 (Phase 13, CMP-07, plan 13-07, Task 2)", () => {
  describe("fresh apply (0000..0056 then 0057) + dedup insert behavior + rollup-unchanged", () => {
    let adminPool: Pool;
    let appPool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let workspaceId: string;
    let contactId: string;
    let sendId: string;
    let rollupBefore: { deliveredCount: number; day: string };

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "dedup-migration-fresh" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      appPool = new Pool({ connectionString: created.dsn, max: 5 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });

      await applyMigrationsUpTo(appPool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0057);

      workspaceId = await createWorkspace(adminPool, "fresh");
      contactId = await createContact(appPool, workspaceId);
      sendId = await createSend(appPool, workspaceId, contactId);

      // Seed a workspace_daily_rollup row BEFORE 0057 is applied, so the
      // "rollup totals unchanged" truth has a real before/after pair rather
      // than an assumption. `occurredAt` is deliberately TODAY (UTC) so
      // `incrementWorkspaceDailyRollup` takes its plain (non-dirtied) path.
      const day = new Date().toISOString().slice(0, 10);
      await withTenantWrite(appPool, workspaceId, (client) =>
        incrementWorkspaceDailyRollup(client, workspaceId, new Date().toISOString(), "delivered"),
      );
      const before = await withTenantWrite(appPool, workspaceId, async (client) => {
        const { rows } = await client.query<{ delivered_count: number }>(
          `SELECT delivered_count FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, day],
        );
        return rows[0];
      });
      rollupBefore = { deliveredCount: before.delivered_count, day };
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      await appPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("applying 0057 succeeds, leaves send_events_dedup_v2_idx valid, and drops the old constraint", async () => {
      await expect(applyMigrationFile(appPool, MIGRATIONS_DIR, MIGRATION_0057_FILENAME)).resolves.toBeUndefined();

      const index = await indexValidity(appPool, `public.${DEDUP_V2_INDEX}`);
      expect(index).toEqual({ exists: true, valid: true });

      expect(await constraintExists(appPool, "send_events", OLD_CONSTRAINT_NAME)).toBe(false);
    });

    it("workspace_daily_rollup totals seeded before 0057 are unchanged after it", async () => {
      const after = await withTenantWrite(appPool, workspaceId, async (client) => {
        const { rows } = await client.query<{ delivered_count: number }>(
          `SELECT delivered_count FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
          [workspaceId, rollupBefore.day],
        );
        return rows[0];
      });
      expect(after.delivered_count).toBe(rollupBefore.deliveredCount);
    });

    it("inserting two rows identical except for sg_event_id is rejected", async () => {
      const occurredAt = new Date();
      await insertSendEvent(appPool, workspaceId, {
        sendId,
        eventType: "delivered",
        occurredAt,
        receivedAt: new Date(),
        sgEventId: `sg-conflict-a-${randomUUID()}`,
      });

      await expect(
        insertSendEvent(appPool, workspaceId, {
          sendId,
          eventType: "delivered",
          occurredAt,
          receivedAt: new Date(),
          sgEventId: `sg-conflict-b-${randomUUID()}`,
        }),
      ).rejects.toThrow(/duplicate key value violates unique constraint/i);
    });

    it("inserting two rows identical except for event_type succeeds", async () => {
      const occurredAt = new Date();
      const sgBase = randomUUID();
      await insertSendEvent(appPool, workspaceId, {
        sendId,
        eventType: "delivered",
        occurredAt,
        receivedAt: new Date(),
        sgEventId: `sg-etype-a-${sgBase}`,
      });
      await expect(
        insertSendEvent(appPool, workspaceId, {
          sendId,
          eventType: "open",
          occurredAt,
          receivedAt: new Date(),
          sgEventId: `sg-etype-b-${sgBase}`,
        }),
      ).resolves.toEqual(expect.any(String));
    });

    it("inserting a second row with the identical (workspace_id, send_id, event_type, occurred_at) tuple is rejected", async () => {
      const occurredAt = new Date();
      const sendIdForThisTest = await createSend(appPool, workspaceId, contactId);
      await insertSendEvent(appPool, workspaceId, {
        sendId: sendIdForThisTest,
        eventType: "click",
        occurredAt,
        receivedAt: new Date(),
      });
      await expect(
        insertSendEvent(appPool, workspaceId, {
          sendId: sendIdForThisTest,
          eventType: "click",
          occurredAt,
          receivedAt: new Date(),
        }),
      ).rejects.toThrow(/duplicate key value violates unique constraint/i);
    });

    it("sg_event_id remains NOT NULL and stores its exact original value", async () => {
      const marker = `sg-forensic-${randomUUID()}`;
      const sendIdForThisTest = await createSend(appPool, workspaceId, contactId);
      await insertSendEvent(appPool, workspaceId, {
        sendId: sendIdForThisTest,
        eventType: "bounce",
        occurredAt: new Date(),
        receivedAt: new Date(),
        sgEventId: marker,
      });

      const stored = await withTenantWrite(appPool, workspaceId, async (client) => {
        const { rows } = await client.query<{ sg_event_id: string }>(
          `SELECT sg_event_id FROM send_events WHERE send_id = $1`,
          [sendIdForThisTest],
        );
        return rows[0]?.sg_event_id;
      });
      expect(stored).toBe(marker);

      await expect(
        withTenantWrite(appPool, workspaceId, (client) =>
          client.query(
            `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
             VALUES ($1, $2, NULL, $3, 'processed', '{}'::jsonb, now())`,
            [randomUUID(), workspaceId, sendIdForThisTest],
          ),
        ),
      ).rejects.toThrow(/null value in column "sg_event_id"/i);
    });
  });

  describe("two attached partitions, each holding rows, enforce the new key independently", () => {
    let adminPool: Pool;
    let appPool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let workspaceId: string;
    let contactId: string;
    let sendId: string;

    // 0020 creates send_events_2026_07/_2026_08; 0038's catch-up creates
    // 2026_09 through 2027_06 -- both fixed, migration-authored partitions
    // that exist by the time the chain reaches 0056, independent of the
    // wall-clock date this suite happens to run on (Codex follow-up review,
    // WARNING finding 5's "prove it against >= 2 real partitions" demand).
    const OCCURRED_AT_PARTITION_A = new Date("2026-07-15T12:00:00Z");
    const OCCURRED_AT_PARTITION_B = new Date("2026-09-15T12:00:00Z");

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "dedup-migration-two-partitions" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      appPool = new Pool({ connectionString: created.dsn, max: 5 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });

      await applyMigrationsUpTo(appPool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0057);

      workspaceId = await createWorkspace(adminPool, "two-partitions");
      contactId = await createContact(appPool, workspaceId);
      sendId = await createSend(appPool, workspaceId, contactId);

      await insertSendEvent(appPool, workspaceId, {
        sendId,
        eventType: "delivered",
        occurredAt: OCCURRED_AT_PARTITION_A,
        receivedAt: new Date(OCCURRED_AT_PARTITION_A),
      });
      await insertSendEvent(appPool, workspaceId, {
        sendId,
        eventType: "delivered",
        occurredAt: OCCURRED_AT_PARTITION_B,
        receivedAt: new Date(OCCURRED_AT_PARTITION_B),
      });
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      await appPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("confirms both seed rows landed in DIFFERENT, already-attached partitions before 0057 is applied", async () => {
      const { rows } = await appPool.query<{ tableoid_name: string }>(
        `SELECT c.relname AS tableoid_name
           FROM send_events se
           JOIN pg_class c ON c.oid = se.tableoid
          WHERE se.workspace_id = $1
          ORDER BY se.occurred_at`,
        [workspaceId],
      );
      expect(rows.map((r) => r.tableoid_name)).toEqual(["send_events_2026_07", "send_events_2026_09"]);
    });

    it("applying 0057 over this two-partition, row-holding schema succeeds and leaves the parent index valid", async () => {
      await expect(applyMigrationFile(appPool, MIGRATIONS_DIR, MIGRATION_0057_FILENAME)).resolves.toBeUndefined();
      const index = await indexValidity(appPool, `public.${DEDUP_V2_INDEX}`);
      expect(index).toEqual({ exists: true, valid: true });
    });

    it("a duplicate insert is rejected in partition A (2026-07) independently", async () => {
      await expect(
        insertSendEvent(appPool, workspaceId, {
          sendId,
          eventType: "delivered",
          occurredAt: OCCURRED_AT_PARTITION_A,
          receivedAt: new Date(),
        }),
      ).rejects.toThrow(/duplicate key value violates unique constraint/i);
    });

    it("a duplicate insert is rejected in partition B (2026-09) independently", async () => {
      await expect(
        insertSendEvent(appPool, workspaceId, {
          sendId,
          eventType: "delivered",
          occurredAt: OCCURRED_AT_PARTITION_B,
          receivedAt: new Date(),
        }),
      ).rejects.toThrow(/duplicate key value violates unique constraint/i);
    });
  });

  describe("the fail-closed duplicate guard, and resuming after --resolve", () => {
    let adminPool: Pool;
    let appPool: Pool;
    let scanPool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let workspaceId: string;
    let contactId: string;
    let sendId: string;
    let earlierRowId: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "dedup-migration-guard" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      appPool = new Pool({ connectionString: created.dsn, max: 5 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });
      scanPool = new Pool({
        connectionString: buildRoleDsn(adminDsnForDatabase(adminDsn, databaseName), databaseName, SCAN_ROLE, "mega_crm_dev_pw"),
        max: 5,
      });

      await applyMigrationsUpTo(appPool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0057);

      workspaceId = await createWorkspace(adminPool, "guard");
      contactId = await createContact(appPool, workspaceId);
      sendId = await createSend(appPool, workspaceId, contactId);

      const occurredAt = new Date();
      earlierRowId = await insertSendEvent(appPool, workspaceId, {
        sendId,
        eventType: "delivered",
        occurredAt,
        receivedAt: new Date(occurredAt.getTime()),
      });
      await insertSendEvent(appPool, workspaceId, {
        sendId,
        eventType: "delivered",
        occurredAt,
        receivedAt: new Date(occurredAt.getTime() + 5000),
      });
    }, 60_000);

    afterAll(async () => {
      await scanPool?.end();
      await adminPool?.end();
      await appPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("applying 0057 over unresolved duplicates raises, naming db:resolve-send-event-duplicates, and leaves both rows and the old constraint in place", async () => {
      await expect(applyMigrationFile(appPool, MIGRATIONS_DIR, MIGRATION_0057_FILENAME)).rejects.toThrow(
        /db:resolve-send-event-duplicates/,
      );

      expect(await constraintExists(appPool, "send_events", OLD_CONSTRAINT_NAME)).toBe(true);
      const index = await indexValidity(appPool, `public.${DEDUP_V2_INDEX}`);
      expect(index.exists).toBe(false);

      const survivors = await sendEventIds(appPool, workspaceId);
      expect(survivors).toHaveLength(2);
    });

    it("applying 0057 after --resolve has run succeeds, and the surviving row is the earlier-received_at one", async () => {
      const resolveResult = await resolveDuplicatesForWorkspace(appPool, workspaceId, 500);
      expect(resolveResult.deletedCount).toBe(1);

      const survivorsAfterResolve = await sendEventIds(appPool, workspaceId);
      expect(survivorsAfterResolve).toHaveLength(1);
      expect(survivorsAfterResolve[0].id).toBe(earlierRowId);

      await expect(applyMigrationFile(appPool, MIGRATIONS_DIR, MIGRATION_0057_FILENAME)).resolves.toBeUndefined();

      const index = await indexValidity(appPool, `public.${DEDUP_V2_INDEX}`);
      expect(index).toEqual({ exists: true, valid: true });
      expect(await constraintExists(appPool, "send_events", OLD_CONSTRAINT_NAME)).toBe(false);

      const finalSurvivors = await sendEventIds(appPool, workspaceId);
      expect(finalSurvivors).toHaveLength(1);
      expect(finalSurvivors[0].id).toBe(earlierRowId);
    });
  });
});

describe("migration 0057 static shape (Phase 13, CMP-07, plan 13-07, Task 2)", () => {
  const MIGRATION_0057_PATH = path.resolve(MIGRATIONS_DIR, MIGRATION_0057_FILENAME);
  const migrationSql = readFileSync(MIGRATION_0057_PATH, "utf8");

  function stripLineComments(sql: string): string {
    return sql
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
  }

  it("declares CREATE UNIQUE INDEX on the parent, not a non-unique CREATE INDEX", () => {
    expect(migrationSql).toMatch(/CREATE UNIQUE INDEX send_events_dedup_v2_idx ON send_events/);
  });

  it("emits no CONCURRENTLY build outside of prose (comment-stripped)", () => {
    const withoutComments = stripLineComments(migrationSql);
    expect(withoutComments).not.toMatch(/CONCURRENTLY/i);
  });

  it("contains no ATTACH PARTITION statement", () => {
    expect(migrationSql).not.toMatch(/ATTACH PARTITION/i);
  });

  it("contains no DELETE statement, and its guard is the first executable statement", () => {
    expect(migrationSql).not.toMatch(/\bDELETE\s+FROM\b/i);
    const firstDoIndex = migrationSql.indexOf("DO $$");
    const firstCreateIndex = migrationSql.indexOf("CREATE UNIQUE INDEX");
    expect(firstDoIndex).toBeGreaterThanOrEqual(0);
    expect(firstDoIndex).toBeLessThan(firstCreateIndex);
  });

  it("names the operator sequence and the stop-old-then-start-new deploy assumption in its header", () => {
    expect(migrationSql).toMatch(/db:count-send-event-duplicates/);
    expect(migrationSql).toMatch(/db:resolve-send-event-duplicates/);
    expect(migrationSql).toMatch(/stop-old-then-start-new/);
    expect(migrationSql).toMatch(/R-05/);
  });

  it("names the chosen index-build route and both rejected alternatives", () => {
    expect(migrationSql).toMatch(/CHOSEN: the blocking parent build/);
    expect(migrationSql).toMatch(/REJECTED: a non-blocking per-partition build/);
    expect(migrationSql).toMatch(/REJECTED: an operator\/pre-deploy script/);
    expect(migrationSql).toMatch(/write lock/i);
  });
});
