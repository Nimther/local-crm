import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { Queue } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createEphemeralDatabase,
  dropEphemeralDatabase,
  applyMigrationFile,
  listMigrationFiles,
  startTempRedis,
  type TempRedis,
} from "@mega-crm/test-support";
import type { PartitionClient } from "@mega-crm/db/src/partitions/ensure-partitions.js";
import { BUFFER_ALERT_THRESHOLD_MONTHS, LOOKAHEAD_MONTHS } from "@mega-crm/db/src/partitions/ensure-partitions.js";
import { runPartitionMaintenance, readLatestMaintenanceRun } from "@mega-crm/db/src/partitions/maintenance-run.js";
import { PARTITION_RETENTION_ENABLE_FLAG, RETENTION_ENABLING_VALUE } from "@mega-crm/db/src/partitions/retention.js";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";

import {
  processPartitionMaintenance,
  createPartitionMaintenanceWorker,
  PARTITION_MAINTENANCE_QUEUE,
  waitForPartitionMaintenanceRegistration,
} from "../partition-maintenance.worker.js";
import type { MaintenanceRunSnapshot } from "@mega-crm/db/src/partitions/maintenance-run.js";

/**
 * Phase 14 plan 12 (DB-11), Task 2 -- the retention step wired into the
 * existing daily tick, exercised against a real ephemeral database (tests
 * 1-4, one shared DB, DELIBERATELY ordered -- each builds on the previous
 * run's real state, mirroring ensure-partitions.test.ts's own convention),
 * plus a worker-layer logging unit test (test 5) and a scheduler-shape
 * sanity check (test 6, real temp Redis).
 *
 * `PARTITION_RETENTION_ENABLED` is reset in `afterEach` -- this suite is the
 * only one in the repository that ever sets it, and leaving it set would
 * leak into every OTHER test file's module-level `process.env` for the rest
 * of the same vitest worker process.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../packages/db/migrations",
);

describe("partition retention tick (14-12, DB-11) -- real database", () => {
  let pool: Pool;
  let partitionPool: Pool;
  let databaseName: string;
  let adminDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "partition-retention-tick" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });
    partitionPool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }
  }, 60_000);

  afterAll(async () => {
    await partitionPool?.end();
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  afterEach(() => {
    delete process.env[PARTITION_RETENTION_ENABLE_FLAG];
  });

  it("test 1: with the flag UNSET, a tick runs partition creation and drops nothing", async () => {
    delete process.env[PARTITION_RETENTION_ENABLE_FLAG];
    const now = new Date(Date.UTC(2027, 7, 15)); // 2027-08-15

    const snapshot = await processPartitionMaintenance({ client: partitionPool as unknown as PartitionClient, now: () => now });

    expect(snapshot.retentionStatus).toBe("disabled");
    expect(snapshot.partitionsDropped).toEqual([]);
    // Real events_2026_07/send_events_2026_07 (the migrated timeline's
    // oldest real partitions) are STILL PRESENT -- disabled means disabled.
    expect(await partitionExists(pool, "events_2026_07")).toBe(true);
    expect(await partitionExists(pool, "send_events_2026_07")).toBe(true);

    const drops = await pool.query(`SELECT count(*) AS count FROM partition_retention_drops`);
    expect(Number(drops.rows[0].count)).toBe(0);
  });

  it("test 2: with the flag ENABLED and eligible partitions present, a tick drops exactly those and records each drop", async () => {
    process.env[PARTITION_RETENTION_ENABLE_FLAG] = RETENTION_ENABLING_VALUE;
    const now = new Date(Date.UTC(2027, 7, 15)); // same instant as test 1 -- only the flag differs

    const snapshot = await processPartitionMaintenance({ client: partitionPool as unknown as PartitionClient, now: () => now });

    expect(snapshot.retentionStatus).toBe("ok");
    expect(snapshot.partitionsDropped.sort()).toEqual(["events_2026_07", "send_events_2026_07"]);

    expect(await partitionExists(pool, "events_2026_07")).toBe(false);
    expect(await partitionExists(pool, "send_events_2026_07")).toBe(false);
    // The next real month is untouched.
    expect(await partitionExists(pool, "events_2026_08")).toBe(true);

    const drops = await pool.query<{ parent_table: string; partition_name: string; horizon_months: number }>(
      `SELECT parent_table, partition_name, horizon_months FROM partition_retention_drops ORDER BY partition_name`,
    );
    expect(drops.rows).toHaveLength(2);
    expect(drops.rows.map((r) => r.partition_name)).toEqual(["events_2026_07", "send_events_2026_07"]);
    expect(drops.rows.every((r) => r.horizon_months === 12)).toBe(true);

    // Watchdog health is unaffected by a tick that included a retention drop
    // -- assert directly on the exact fields
    // `apps/api/src/modules/ops/partition-watchdog.ts`'s `evaluatePartitionHealth`
    // reads (staleness, buffer, both DEFAULT counts): every one of them is
    // driven ONLY by the creation-work half of the snapshot, which retention
    // never touches, and the new retention columns are additive -- a
    // pre-existing SELECT-by-column-name reader like the watchdog cannot
    // observe them at all. Not importing the watchdog module itself here:
    // apps/worker and apps/api are two independently deployable processes
    // with no cross-app source import anywhere else in this codebase
    // (confirmed by reading apps/worker/src/health-server.ts's own
    // deliberately-separate-implementation precedent) -- this test proves
    // the same invariant the watchdog's own test suite checks, without
    // introducing the first such cross-app import.
    const row = await readLatestMaintenanceRun(pool);
    expect(row).not.toBeNull();
    const ageMs = now.getTime() - (row?.lastRunAt.getTime() ?? 0);
    expect(ageMs).toBeLessThan(26 * 60 * 60 * 1000); // STALE_THRESHOLD_HOURS
    expect(row?.bufferMonthsRemaining).toBeGreaterThanOrEqual(BUFFER_ALERT_THRESHOLD_MONTHS);
    expect(row?.eventsDefaultCount).toBe(0);
    expect(row?.sendEventsDefaultCount).toBe(0);
  });

  it("test 3: with the flag ENABLED and nothing newly eligible, a tick completes with no new drop recorded", async () => {
    process.env[PARTITION_RETENTION_ENABLE_FLAG] = RETENTION_ENABLING_VALUE;
    const now = new Date(Date.UTC(2027, 7, 16)); // one day later -- nothing new crosses the horizon

    const snapshot = await processPartitionMaintenance({ client: partitionPool as unknown as PartitionClient, now: () => now });

    expect(snapshot.retentionStatus).toBe("ok");
    expect(snapshot.partitionsDropped).toEqual([]);

    const drops = await pool.query(`SELECT count(*) AS count FROM partition_retention_drops`);
    expect(Number(drops.rows[0].count)).toBe(2); // still exactly the two from test 2 -- nothing new
  });

  it("test 4: a forced failure in the retention step still records the partition-creation work, and the run record distinguishes disabled from failed", async () => {
    const now = new Date(Date.UTC(2027, 7, 17));
    const injectedError = new Error("boom: simulated retention failure");

    const snapshot = await runPartitionMaintenance(partitionPool, now, {
      lookaheadMonths: LOOKAHEAD_MONTHS,
      bufferAlertThresholdMonths: BUFFER_ALERT_THRESHOLD_MONTHS,
      isRetentionEnabledFn: () => true,
      dropExpiredPartitionsFn: () => Promise.reject(injectedError),
    });

    expect(snapshot.retentionStatus).toBe("failed");
    expect(snapshot.retentionError).toBe("boom: simulated retention failure");
    // The creation half of THIS SAME run was still recorded -- lastRunAt
    // advanced to this run's own `now`, proving recordMaintenanceRun ran.
    expect(snapshot.lastRunAt).toEqual(now);

    const row = await readLatestMaintenanceRun(pool);
    expect(row?.lastRunAt).toEqual(now);
    expect(row?.retentionStatus).toBe("failed");
    expect(row?.retentionError).toBe("boom: simulated retention failure");

    // No new drop row was written for the failed attempt.
    const drops = await pool.query(`SELECT count(*) AS count FROM partition_retention_drops`);
    expect(Number(drops.rows[0].count)).toBe(2); // unchanged from test 2/3
  });
});

async function partitionExists(pool: Pool, name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS exists`, [
    `public.${name}`,
  ]);
  return rows[0]?.exists ?? false;
}

describe("partition retention tick (14-12, DB-11) -- worker-layer logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("test 5: a retention-failed snapshot produces a logged error through the same channel every other partition-maintenance error uses", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const fakeNow = new Date("2026-09-01T03:00:00.000Z");
    const fakeSnapshot: MaintenanceRunSnapshot = {
      lastRunAt: fakeNow,
      lookaheadMonths: 3,
      bufferAlertThresholdMonths: 2,
      eventsBufferMonths: 3,
      sendEventsBufferMonths: 3,
      bufferMonthsRemaining: 3,
      eventsDefaultCount: 0,
      sendEventsDefaultCount: 0,
      partitionsCreated: [],
      retentionStatus: "failed",
      retentionError: "boom: simulated retention failure",
      partitionsDropped: [],
    };
    const runMaintenance = vi.fn().mockResolvedValue(fakeSnapshot);

    await processPartitionMaintenance({
      client: {} as PartitionClient,
      now: () => fakeNow,
      runMaintenance,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      "partition-maintenance: retention step failed",
      expect.objectContaining({ retentionError: "boom: simulated retention failure" }),
    );
    // The ordinary "run complete" log still fires -- a retention failure
    // never suppresses the creation-work summary line.
    expect(logSpy).toHaveBeenCalledWith("partition-maintenance: run complete", expect.any(Object));
  });

  it("test 5b: a disabled-retention snapshot never logs the retention-failure line", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const fakeNow = new Date("2026-09-01T03:00:00.000Z");
    const fakeSnapshot: MaintenanceRunSnapshot = {
      lastRunAt: fakeNow,
      lookaheadMonths: 3,
      bufferAlertThresholdMonths: 2,
      eventsBufferMonths: 3,
      sendEventsBufferMonths: 3,
      bufferMonthsRemaining: 3,
      eventsDefaultCount: 0,
      sendEventsDefaultCount: 0,
      partitionsCreated: [],
      retentionStatus: "disabled",
      retentionError: null,
      partitionsDropped: [],
    };
    const runMaintenance = vi.fn().mockResolvedValue(fakeSnapshot);

    await processPartitionMaintenance({
      client: {} as PartitionClient,
      now: () => fakeNow,
      runMaintenance,
    });

    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("partition retention tick (14-12, DB-11) -- scheduler shape unaffected", () => {
  let redis: TempRedis;

  beforeAll(async () => {
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it("test 6: the retention step's wiring registers no additional job scheduler -- still exactly one, same stable id/UTC hour", async () => {
    const connection = buildRedisConnectionOptions(redis.url);
    const worker = createPartitionMaintenanceWorker(connection, { autorun: false });
    const queue = new Queue(PARTITION_MAINTENANCE_QUEUE, { connection });

    try {
      await vi.waitFor(async () => {
        expect(await queue.getJobSchedulersCount()).toBe(1);
      });
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0].key).toBe("partition-maintenance-daily");
      expect(schedulers[0].pattern).toBe("0 3 * * *");
      expect(schedulers[0].tz).toBe("UTC");

      await waitForPartitionMaintenanceRegistration(worker);
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
