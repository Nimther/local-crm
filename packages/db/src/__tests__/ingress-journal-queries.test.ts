import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrationFile, createEphemeralDatabase, dropEphemeralDatabase, listMigrationFiles } from "@mega-crm/test-support";

import {
  findStuckIngressJournalRows,
  pruneIngressJournal,
  purgeExpiredIngressJournalPayloads,
  writeIngressJournal,
  markIngestionComplete,
} from "../webhooks/ingress-journal.js";

/**
 * Phase 13 (CMP-08, D-05, plan 13-01, Task 3): the retention/stuck-row query
 * surface over `ingress_journal` -- proves `findStuckIngressJournalRows`'s
 * no-filter contract (returns attempt-capped AND purged-tombstone rows
 * alike), and that `pruneIngressJournal`/`purgeExpiredIngressJournalPayloads`
 * are two genuinely separate operations rather than one delete wearing two
 * names.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/**
 * `createEphemeralDatabase`'s own `adminDsn` points at the cluster's
 * maintenance database, not the ephemeral one -- swap only the pathname to
 * get a superuser connection into THIS database (mirrors
 * `relocate-default-partition-rows.test.ts`'s own helper). `organization` is
 * INSERT-restricted to `mega_crm_auth` as of migration 0045 -- the ordinary
 * `mega_crm_app`-role pool this suite otherwise uses cannot seed it.
 */
function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("ingress-journal.ts retention + stuck-row queries (CMP-08, D-05, 13-01)", () => {
  let pool: Pool;
  let adminPool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "ingress-journal-queries" });
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

  /** Directly backdates `received_at` (and optionally `ingestion_completed_at`/`payload_purged_at`) past the row's real insert time, for retention-horizon tests. */
  async function seedJournalRow(
    workspaceId: string,
    overrides: {
      ageDays?: number;
      completed?: boolean;
      replayCount?: number;
      payloadPurgedAt?: Date | null;
    } = {}
  ): Promise<string> {
    return withWorkspace(workspaceId, async (client) => {
      const journalId = await writeIngressJournal(client, workspaceId, [{ event: "delivered" }]);
      if (overrides.completed) {
        await markIngestionComplete(client, journalId);
      }
      const setClauses: string[] = [];
      const params: unknown[] = [];
      if (overrides.ageDays !== undefined) {
        params.push(overrides.ageDays);
        setClauses.push(`received_at = now() - make_interval(days => $${params.length})`);
      }
      if (overrides.replayCount !== undefined) {
        params.push(overrides.replayCount);
        setClauses.push(`replay_count = $${params.length}`);
      }
      if (overrides.payloadPurgedAt !== undefined) {
        params.push(overrides.payloadPurgedAt);
        setClauses.push(`payload_purged_at = $${params.length}`);
      }
      if (setClauses.length > 0) {
        params.push(journalId);
        await client.query(`UPDATE ingress_journal SET ${setClauses.join(", ")} WHERE id = $${params.length}`, params);
      }
      return journalId;
    });
  }

  interface JournalSnapshot {
    rawBatch: unknown;
    payloadPurgedAt: Date | null;
    workspaceId: string;
    receivedAt: Date;
    replayCount: number;
    ingestionCompletedAt: Date | null;
  }

  async function readJournalRow(workspaceId: string, journalId: string): Promise<JournalSnapshot | undefined> {
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query<JournalSnapshot>(
        `SELECT raw_batch as "rawBatch", payload_purged_at as "payloadPurgedAt", workspace_id as "workspaceId",
                received_at as "receivedAt", replay_count as "replayCount", ingestion_completed_at as "ingestionCompletedAt"
           FROM ingress_journal WHERE id = $1`,
        [journalId]
      );
      return rows[0];
    });
  }

  async function rowExists(workspaceId: string, journalId: string): Promise<boolean> {
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM ingress_journal WHERE id = $1`, [journalId]);
      return rows.length > 0;
    });
  }

  // -----------------------------------------------------------------------
  // findStuckIngressJournalRows
  // -----------------------------------------------------------------------

  it("returns an incomplete row older than the threshold and excludes a completed row at any threshold", async () => {
    const workspaceId = await freshWorkspaceId("stuck-basic");
    const incompleteId = await seedJournalRow(workspaceId, { ageDays: 1 });
    const completedId = await seedJournalRow(workspaceId, { ageDays: 1, completed: true });

    const stuck = await withWorkspace(workspaceId, (client) => findStuckIngressJournalRows(client, 15, 100));
    const ids = stuck.map((r) => r.id);

    expect(ids).toContain(incompleteId);
    expect(ids).not.toContain(completedId);
  });

  it("respects a caller-supplied row limit", async () => {
    const workspaceId = await freshWorkspaceId("stuck-limit");
    await seedJournalRow(workspaceId, { ageDays: 1 });
    await seedJournalRow(workspaceId, { ageDays: 1 });
    await seedJournalRow(workspaceId, { ageDays: 1 });

    const stuck = await withWorkspace(workspaceId, (client) => findStuckIngressJournalRows(client, 15, 2));
    expect(stuck.length).toBe(2);
  });

  it("returns a row whose replay_count is 99, with replay_count on the row", async () => {
    const workspaceId = await freshWorkspaceId("stuck-replay-count");
    const journalId = await seedJournalRow(workspaceId, { ageDays: 1, replayCount: 99 });

    const stuck = await withWorkspace(workspaceId, (client) => findStuckIngressJournalRows(client, 15, 100));
    const row = stuck.find((r) => r.id === journalId);
    expect(row?.replayCount).toBe(99);
  });

  it("returns a purged tombstone row and reports its payload_purged_at, rather than filtering it out", async () => {
    const workspaceId = await freshWorkspaceId("stuck-tombstone");
    const purgedAt = new Date();
    const journalId = await seedJournalRow(workspaceId, { ageDays: 8, payloadPurgedAt: purgedAt });
    // The CHECK constraint requires raw_batch to be non-null unless
    // payload_purged_at is set -- null it out directly to build a genuine
    // tombstone shape for this assertion (purgeExpiredIngressJournalPayloads
    // itself is exercised separately below).
    await withWorkspace(workspaceId, (client) =>
      client.query(`UPDATE ingress_journal SET raw_batch = NULL WHERE id = $1`, [journalId])
    );

    const stuck = await withWorkspace(workspaceId, (client) => findStuckIngressJournalRows(client, 15, 100));
    const row = stuck.find((r) => r.id === journalId);
    expect(row).toBeDefined();
    expect(row?.payloadPurgedAt?.getTime()).toBe(purgedAt.getTime());
  });

  // -----------------------------------------------------------------------
  // pruneIngressJournal
  // -----------------------------------------------------------------------

  it("deletes a COMPLETED row aged 8 days and leaves a completed row aged 6 days, with 7-day retention", async () => {
    const workspaceId = await freshWorkspaceId("prune-basic");
    const oldId = await seedJournalRow(workspaceId, { ageDays: 8, completed: true });
    const recentId = await seedJournalRow(workspaceId, { ageDays: 6, completed: true });

    const deleted = await withWorkspace(workspaceId, (client) => pruneIngressJournal(client, 7));

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(await rowExists(workspaceId, oldId)).toBe(false);
    expect(await rowExists(workspaceId, recentId)).toBe(true);
  });

  it("leaves an INCOMPLETE row aged 8 days present, and its returned count does not include that row", async () => {
    const workspaceId = await freshWorkspaceId("prune-incomplete");
    const incompleteId = await seedJournalRow(workspaceId, { ageDays: 8 });

    const deleted = await withWorkspace(workspaceId, (client) => pruneIngressJournal(client, 7));

    expect(deleted).toBe(0);
    expect(await rowExists(workspaceId, incompleteId)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // purgeExpiredIngressJournalPayloads
  // -----------------------------------------------------------------------

  it("nulls raw_batch and sets payload_purged_at on an incomplete row aged 8 days, leaving the row present", async () => {
    const workspaceId = await freshWorkspaceId("purge-basic");
    const journalId = await seedJournalRow(workspaceId, { ageDays: 8 });

    const purged = await withWorkspace(workspaceId, (client) => purgeExpiredIngressJournalPayloads(client, 7));

    expect(purged).toBe(1);
    const row = await readJournalRow(workspaceId, journalId);
    expect(row?.rawBatch).toBeNull();
    expect(row?.payloadPurgedAt).not.toBeNull();
  });

  it("leaves an incomplete row aged 6 days untouched -- raw_batch intact, payload_purged_at null", async () => {
    const workspaceId = await freshWorkspaceId("purge-recent");
    const journalId = await seedJournalRow(workspaceId, { ageDays: 6 });

    const purged = await withWorkspace(workspaceId, (client) => purgeExpiredIngressJournalPayloads(client, 7));

    expect(purged).toBe(0);
    const row = await readJournalRow(workspaceId, journalId);
    expect(row?.rawBatch).not.toBeNull();
    expect(row?.payloadPurgedAt).toBeNull();
  });

  it("is idempotent: a second call over an already-purged row changes nothing and returns 0", async () => {
    const workspaceId = await freshWorkspaceId("purge-idempotent");
    const journalId = await seedJournalRow(workspaceId, { ageDays: 8 });

    const first = await withWorkspace(workspaceId, (client) => purgeExpiredIngressJournalPayloads(client, 7));
    expect(first).toBe(1);
    const afterFirst = await readJournalRow(workspaceId, journalId);
    const firstPurgedAt = afterFirst?.payloadPurgedAt?.getTime();

    const second = await withWorkspace(workspaceId, (client) => purgeExpiredIngressJournalPayloads(client, 7));
    expect(second).toBe(0);
    const afterSecond = await readJournalRow(workspaceId, journalId);
    expect(afterSecond?.payloadPurgedAt?.getTime()).toBe(firstPurgedAt);
  });

  it("preserves workspace_id, received_at, replay_count, and ingestion_completed_at across a purge", async () => {
    const workspaceId = await freshWorkspaceId("purge-preserves");
    const journalId = await seedJournalRow(workspaceId, { ageDays: 8, replayCount: 3 });
    const before = await readJournalRow(workspaceId, journalId);

    await withWorkspace(workspaceId, (client) => purgeExpiredIngressJournalPayloads(client, 7));

    const after = await readJournalRow(workspaceId, journalId);
    expect(after?.workspaceId).toBe(before?.workspaceId);
    expect(after?.receivedAt.getTime()).toBe(before?.receivedAt.getTime());
    expect(after?.replayCount).toBe(before?.replayCount);
    expect(after?.ingestionCompletedAt).toBe(before?.ingestionCompletedAt);
  });
});
