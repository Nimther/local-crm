import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  listMigrationFiles,
} from "@mega-crm/test-support";

import {
  readLatestReconcilerRun,
  recordReconcilerRun,
  type ReconcilerRunSnapshot,
} from "../reconciler/reconciler-run.js";

/**
 * Phase 11, plan 11-09 (D-14) -- the worker-side half of the reconciler's
 * dead-man's-switch: `send_reconciler_runs`' singleton-row read/write. Mirrors
 * `packages/db/src/partitions/__tests__/maintenance-run.test.ts`'s absence
 * (that file has no dedicated suite either -- its own coverage lives inside
 * `ensure-partitions.test.ts`) by instead giving this module its own small,
 * self-contained ephemeral-database suite, since -- unlike
 * `runPartitionMaintenance` -- `recordReconcilerRun`/`readLatestReconcilerRun`
 * have no larger composing caller in this package to exercise them
 * end-to-end.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

function buildSnapshot(overrides: Partial<ReconcilerRunSnapshot> = {}): ReconcilerRunSnapshot {
  return {
    lastRunAt: new Date(),
    candidatesScanned: 0,
    rowsResolved: 0,
    rowsMarkedUnknown: 0,
    staleDispatchingSwept: 0,
    oldestReconcilingSince: null,
    ...overrides,
  };
}

describe("reconciler-run.ts (11-09, D-14)", () => {
  let pool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "reconciler-run" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 2 });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("test 1: readLatestReconcilerRun returns the seeded id=1 row on a freshly migrated database, with lastRunAt at the epoch", async () => {
    const row = await readLatestReconcilerRun(pool);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(1);
    expect(row?.lastRunAt.getTime()).toBe(new Date("1970-01-01T00:00:00Z").getTime());
    expect(row?.oldestReconcilingSince).toBeNull();
    expect(row?.lastAlertSentAt).toBeNull();
  });

  it("test 2: recordReconcilerRun UPSERTs onto id=1 and never inserts a second row", async () => {
    await recordReconcilerRun(pool, buildSnapshot({ candidatesScanned: 3 }));
    await recordReconcilerRun(pool, buildSnapshot({ candidatesScanned: 7 }));
    await recordReconcilerRun(pool, buildSnapshot({ candidatesScanned: 11 }));

    const { rows } = await pool.query<{ count: string }>("SELECT count(*) AS count FROM send_reconciler_runs");
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("test 3: after recordReconcilerRun, readLatestReconcilerRun reflects every field of the snapshot and an updatedAt at or after the call", async () => {
    const before = new Date();
    const snapshot = buildSnapshot({
      lastRunAt: before,
      candidatesScanned: 42,
      rowsResolved: 5,
      rowsMarkedUnknown: 2,
      staleDispatchingSwept: 1,
      oldestReconcilingSince: new Date(before.getTime() - 60_000),
    });

    await recordReconcilerRun(pool, snapshot);
    const row = await readLatestReconcilerRun(pool);

    expect(row).not.toBeNull();
    expect(row?.lastRunAt.getTime()).toBe(snapshot.lastRunAt.getTime());
    expect(row?.candidatesScanned).toBe(42);
    expect(row?.rowsResolved).toBe(5);
    expect(row?.rowsMarkedUnknown).toBe(2);
    expect(row?.staleDispatchingSwept).toBe(1);
    expect(row?.oldestReconcilingSince?.getTime()).toBe(snapshot.oldestReconcilingSince?.getTime());
    expect(row?.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());

    // Timestamps come back as Date instances, matching readLatestMaintenanceRun.
    expect(row?.lastRunAt).toBeInstanceOf(Date);
    expect(row?.updatedAt).toBeInstanceOf(Date);
    expect(row?.oldestReconcilingSince).toBeInstanceOf(Date);
  });

  it("test 4: recordReconcilerRun does not clear lastAlertSentAt -- the watchdog owns that column exclusively", async () => {
    const alertSentAt = new Date();
    await pool.query(`UPDATE send_reconciler_runs SET last_alert_sent_at = $1 WHERE id = 1`, [alertSentAt]);

    await recordReconcilerRun(pool, buildSnapshot({ candidatesScanned: 99 }));

    const row = await readLatestReconcilerRun(pool);
    expect(row?.lastAlertSentAt?.getTime()).toBe(alertSentAt.getTime());
    expect(row?.candidatesScanned).toBe(99);
  });

  it("test 5: recordReconcilerRun with a null oldestReconcilingSince stores null", async () => {
    // First establish a non-null value, then overwrite it with null --
    // proves the column is actually being SET to null, not merely left at
    // an already-null default.
    await recordReconcilerRun(pool, buildSnapshot({ oldestReconcilingSince: new Date() }));
    const withValue = await readLatestReconcilerRun(pool);
    expect(withValue?.oldestReconcilingSince).not.toBeNull();

    await recordReconcilerRun(pool, buildSnapshot({ oldestReconcilingSince: null }));
    const withoutValue = await readLatestReconcilerRun(pool);
    expect(withoutValue?.oldestReconcilingSince).toBeNull();
  });

  it("test 6: readLatestReconcilerRun returns null rather than throwing if the row is somehow absent", async () => {
    await pool.query("DELETE FROM send_reconciler_runs WHERE id = 1");
    const row = await readLatestReconcilerRun(pool);
    expect(row).toBeNull();

    // Restore the singleton for any test that might run after this one in
    // the same file (there are none below, but this keeps the suite's own
    // database in the state every other test expects on a fresh run).
    await pool.query(`INSERT INTO send_reconciler_runs (id, last_run_at) VALUES (1, TIMESTAMPTZ 'epoch')`);
  });

  it("recordReconcilerRun's SQL contains no reference to last_alert_sent_at", () => {
    const source = recordReconcilerRun.toString();
    expect(source).not.toContain("last_alert_sent_at");
  });
});
