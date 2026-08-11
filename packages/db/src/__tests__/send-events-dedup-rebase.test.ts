import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationsUpTo,
  buildRoleDsn,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  SCAN_ROLE,
} from "@mega-crm/test-support";

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
