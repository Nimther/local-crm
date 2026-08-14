import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrationFile, createEphemeralDatabase, dropEphemeralDatabase, listMigrationFiles } from "@mega-crm/test-support";

import { pruneSendEventQuarantine, SEND_EVENT_QUARANTINE_RETENTION_DAYS } from "../webhooks/quarantine.js";
import { writeIngressJournal, markIngestionComplete, INGRESS_JOURNAL_RETENTION_DAYS } from "../webhooks/ingress-journal.js";

/**
 * Phase 13 (CMP-04, gap-closure plan 13-16), Task 1: the disposal
 * counterpart to `writeQuarantinedEvent` (plan 13-01). Mirrors
 * `ingress-journal-queries.test.ts`'s provisioning and tenant-scope-entry
 * shape exactly -- `organization` is INSERT-restricted to `mega_crm_auth`,
 * so seeding a workspace needs the admin pool, not the ordinary
 * `mega_crm_app`-role pool this suite otherwise uses.
 *
 * `received_at` is controlled by direct SQL UPDATE after insert (mirrors
 * `seedJournalRow`'s own `ageDays` override) rather than by waiting on
 * real wall-clock thresholds -- `writeQuarantinedEvent` always stamps
 * `received_at` at `now()` and has no backdating parameter of its own.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("quarantine.ts pruneSendEventQuarantine (CMP-04, gap-closure plan 13-16)", () => {
  let pool: Pool;
  let adminPool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "quarantine-retention" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 5 });
    adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 2 });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const { rows } = await adminPool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`]
    );
    return rows[0].id;
  }

  async function withWorkspace<T>(workspaceId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Inserts a `send_event_quarantine` row directly (not through `writeQuarantinedEvent`, which always stamps `now()`) and backdates `received_at`. */
  async function seedQuarantineRow(
    workspaceId: string,
    overrides: {
      ageDays?: number;
      occurredAtCandidate?: string | null;
      rawEvent?: unknown;
    } = {}
  ): Promise<string> {
    const { ageDays = 0, occurredAtCandidate = null, rawEvent = { event: "delivered" } } = overrides;
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO send_event_quarantine (workspace_id, sg_event_id, event_type, raw_event, reason, occurred_at_candidate)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [workspaceId, `sg-${Math.random().toString(36).slice(2, 10)}`, "delivered", JSON.stringify(rawEvent), "too_old", occurredAtCandidate]
      );
      const quarantineId = rows[0].id;
      if (ageDays > 0) {
        await client.query(`UPDATE send_event_quarantine SET received_at = now() - make_interval(days => $1) WHERE id = $2`, [
          ageDays,
          quarantineId,
        ]);
      }
      return quarantineId;
    });
  }

  async function quarantineRowExists(workspaceId: string, quarantineId: string): Promise<boolean> {
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM send_event_quarantine WHERE id = $1`, [quarantineId]);
      return rows.length > 0;
    });
  }

  interface JournalSnapshot {
    id: string;
    rawBatch: unknown;
  }

  async function seedJournalRow(
    workspaceId: string,
    overrides: { ageDays?: number; completed?: boolean } = {}
  ): Promise<string> {
    return withWorkspace(workspaceId, async (client) => {
      const journalId = await writeIngressJournal(client, workspaceId, [{ event: "delivered" }]);
      if (overrides.completed) {
        await markIngestionComplete(client, journalId);
      }
      if (overrides.ageDays !== undefined) {
        await client.query(`UPDATE ingress_journal SET received_at = now() - make_interval(days => $1) WHERE id = $2`, [
          overrides.ageDays,
          journalId,
        ]);
      }
      return journalId;
    });
  }

  async function readJournalRow(workspaceId: string, journalId: string): Promise<JournalSnapshot | undefined> {
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query<JournalSnapshot>(
        `SELECT id, raw_batch as "rawBatch" FROM ingress_journal WHERE id = $1`,
        [journalId]
      );
      return rows[0];
    });
  }

  it("SEND_EVENT_QUARANTINE_RETENTION_DAYS equals INGRESS_JOURNAL_RETENTION_DAYS", () => {
    expect(SEND_EVENT_QUARANTINE_RETENTION_DAYS).toBe(INGRESS_JOURNAL_RETENTION_DAYS);
  });

  it("deletes a row whose received_at is older than the retention horizon and returns 1", async () => {
    const workspaceId = await freshWorkspaceId("prune-expired");
    const expiredId = await seedQuarantineRow(workspaceId, { ageDays: 8 });

    const deleted = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 7));

    expect(deleted).toBe(1);
    expect(await quarantineRowExists(workspaceId, expiredId)).toBe(false);
  });

  it("leaves a row whose received_at is inside the horizon in place and returns 0", async () => {
    const workspaceId = await freshWorkspaceId("prune-fresh");
    const freshId = await seedQuarantineRow(workspaceId, { ageDays: 1 });

    const deleted = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 7));

    expect(deleted).toBe(0);
    expect(await quarantineRowExists(workspaceId, freshId)).toBe(true);
  });

  it("a row with an ancient occurred_at_candidate but a recent received_at survives the prune", async () => {
    const workspaceId = await freshWorkspaceId("prune-candidate");
    const ancientCandidate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const rowId = await seedQuarantineRow(workspaceId, { ageDays: 0, occurredAtCandidate: ancientCandidate });

    const deleted = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 7));

    expect(deleted).toBe(0);
    expect(await quarantineRowExists(workspaceId, rowId)).toBe(true);
  });

  it("a row whose raw_event carries an old provider timestamp but a recent received_at survives the prune", async () => {
    const workspaceId = await freshWorkspaceId("prune-raw-event-ts");
    const oldProviderTimestamp = Math.floor(new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).getTime() / 1000);
    const rowId = await seedQuarantineRow(workspaceId, {
      ageDays: 0,
      rawEvent: { event: "delivered", timestamp: oldProviderTimestamp },
    });

    const deleted = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 7));

    expect(deleted).toBe(0);
    expect(await quarantineRowExists(workspaceId, rowId)).toBe(true);
  });

  it("given three expired rows and two fresh rows in the same workspace, prunes exactly the three expired rows", async () => {
    const workspaceId = await freshWorkspaceId("prune-mixed");
    const expiredIds = [
      await seedQuarantineRow(workspaceId, { ageDays: 8 }),
      await seedQuarantineRow(workspaceId, { ageDays: 9 }),
      await seedQuarantineRow(workspaceId, { ageDays: 10 }),
    ];
    const freshIds = [await seedQuarantineRow(workspaceId, { ageDays: 1 }), await seedQuarantineRow(workspaceId, { ageDays: 2 })];

    const deleted = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 7));

    expect(deleted).toBe(3);
    for (const id of expiredIds) {
      expect(await quarantineRowExists(workspaceId, id)).toBe(false);
    }
    for (const id of freshIds) {
      expect(await quarantineRowExists(workspaceId, id)).toBe(true);
    }
  });

  it("a second prune call over an already-pruned set returns 0 and deletes nothing", async () => {
    const workspaceId = await freshWorkspaceId("prune-idempotent");
    await seedQuarantineRow(workspaceId, { ageDays: 8 });

    const first = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 7));
    expect(first).toBe(1);

    const second = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 7));
    expect(second).toBe(0);
  });

  it("a prune inside workspace A's tenant scope deletes only workspace A's rows; workspace B's expired row is still present under its own scope", async () => {
    const workspaceA = await freshWorkspaceId("prune-tenant-a");
    const workspaceB = await freshWorkspaceId("prune-tenant-b");
    const rowA = await seedQuarantineRow(workspaceA, { ageDays: 8 });
    const rowB = await seedQuarantineRow(workspaceB, { ageDays: 8 });

    const deleted = await withWorkspace(workspaceA, (client) => pruneSendEventQuarantine(client, 7));

    expect(deleted).toBe(1);
    expect(await quarantineRowExists(workspaceA, rowA)).toBe(false);
    expect(await quarantineRowExists(workspaceB, rowB)).toBe(true);
  });

  it("a prune leaves both a completed and an incomplete expired ingress_journal row untouched, including a non-null raw_batch on each", async () => {
    const workspaceId = await freshWorkspaceId("prune-journal-untouched");
    const completedJournalId = await seedJournalRow(workspaceId, { ageDays: 8, completed: true });
    const incompleteJournalId = await seedJournalRow(workspaceId, { ageDays: 8 });
    const quarantineId = await seedQuarantineRow(workspaceId, { ageDays: 8 });

    const deleted = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 7));

    expect(deleted).toBe(1);
    expect(await quarantineRowExists(workspaceId, quarantineId)).toBe(false);

    const completedRow = await readJournalRow(workspaceId, completedJournalId);
    const incompleteRow = await readJournalRow(workspaceId, incompleteJournalId);
    expect(completedRow).toBeDefined();
    expect(completedRow?.rawBatch).not.toBeNull();
    expect(incompleteRow).toBeDefined();
    expect(incompleteRow?.rawBatch).not.toBeNull();
  });

  it("a retention horizon different from INGRESS_JOURNAL_RETENTION_DAYS prunes quarantine on that horizon with no effect on journal rows", async () => {
    const workspaceId = await freshWorkspaceId("prune-independent-horizon");
    const quarantineId = await seedQuarantineRow(workspaceId, { ageDays: 3 });
    const journalId = await seedJournalRow(workspaceId, { ageDays: 3, completed: true });

    // Quarantine horizon of 2 days -- shorter than INGRESS_JOURNAL_RETENTION_DAYS (7) --
    // ages out the 3-day-old quarantine row without touching the 3-day-old journal row.
    const deleted = await withWorkspace(workspaceId, (client) => pruneSendEventQuarantine(client, 2));

    expect(deleted).toBe(1);
    expect(await quarantineRowExists(workspaceId, quarantineId)).toBe(false);
    expect(await readJournalRow(workspaceId, journalId)).toBeDefined();
  });
});
