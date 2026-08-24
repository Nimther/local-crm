import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { DEAD_LETTER_RETENTION_DAYS_FLOOR, parseWorkerEnv } from "../../env.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { DEAD_LETTER_SWEEP_BATCH_SIZE, sweepExpiredDeadLetterJobs } from "../dead-letter-retention.js";
import { processWorkspacePurge } from "../workspace-purge.worker.js";

/**
 * Gap-closure plan 22-12 (PRG-02), Task 1: `DEAD_LETTER_RETENTION_DAYS`'s
 * boot-time invariant, driven directly through `parseWorkerEnv` exactly the
 * way `workspace-purge.test.ts`'s own "retention floor" case drives
 * `WORKSPACE_PURGE_RETENTION_DAYS` -- `parseWorkerEnv` is pure and takes the
 * source object, so this never mutates `process.env`.
 */
describe("DEAD_LETTER_RETENTION_DAYS env invariant (Task 1)", () => {
  it("defaults to 30 when absent", () => {
    const parsed = parseWorkerEnv({});
    expect(parsed.DEAD_LETTER_RETENTION_DAYS).toBe(30);
  });

  it("throws naming the variable when below the floor", () => {
    expect(() => parseWorkerEnv({ DEAD_LETTER_RETENTION_DAYS: "6" })).toThrow(/DEAD_LETTER_RETENTION_DAYS/);
  });

  it("throws naming both variables when it exceeds WORKSPACE_PURGE_RETENTION_DAYS", () => {
    expect(() =>
      parseWorkerEnv({ DEAD_LETTER_RETENTION_DAYS: "60", WORKSPACE_PURGE_RETENTION_DAYS: "30" }),
    ).toThrow(/DEAD_LETTER_RETENTION_DAYS[\s\S]*WORKSPACE_PURGE_RETENTION_DAYS|WORKSPACE_PURGE_RETENTION_DAYS[\s\S]*DEAD_LETTER_RETENTION_DAYS/);
  });

  it("succeeds when strictly below the purge retention window", () => {
    const parsed = parseWorkerEnv({ DEAD_LETTER_RETENTION_DAYS: "30", WORKSPACE_PURGE_RETENTION_DAYS: "90" });
    expect(parsed.DEAD_LETTER_RETENTION_DAYS).toBe(30);
    expect(parsed.WORKSPACE_PURGE_RETENTION_DAYS).toBe(90);
  });

  it("succeeds when equal to the purge retention window -- at most, not strictly less", () => {
    const parsed = parseWorkerEnv({ DEAD_LETTER_RETENTION_DAYS: "30", WORKSPACE_PURGE_RETENTION_DAYS: "30" });
    expect(parsed.DEAD_LETTER_RETENTION_DAYS).toBe(30);
    expect(parsed.WORKSPACE_PURGE_RETENTION_DAYS).toBe(30);
  });

  it("exposes the floor constant", () => {
    expect(DEAD_LETTER_RETENTION_DAYS_FLOOR).toBe(7);
  });
});

/**
 * Gap-closure plan 22-12 (PRG-02), Task 2: the bounded retention sweep and
 * its wiring into `processWorkspacePurge`'s tick. Real Postgres, mirroring
 * `apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts`'s own
 * `seedDeadLetterRow` seeding shape. Every seeded `job_id` in this block
 * carries the `22-12-` prefix and the teardown deletes ONLY rows matching
 * that prefix -- never a bare `DELETE FROM dead_letter_jobs`, which would
 * erase another suite's fixtures sharing this same platform table.
 */
describe("sweepExpiredDeadLetterJobs and its wiring into the purge tick (Task 2)", () => {
  let pool: Pool;
  let seedCounter = 0;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM dead_letter_jobs WHERE job_id LIKE '22-12-%'`);
  });

  async function seedRow(overrides: {
    failedAt: Date;
    acknowledgedAt?: Date | null;
    queueName?: string;
  }): Promise<string> {
    seedCounter += 1;
    const jobId = `22-12-${seedCounter}-${Date.now()}`;
    await pool.query(
      `INSERT INTO dead_letter_jobs (
         queue_name, job_id, job_name, attempts_made, payload, error_message, failed_at, acknowledged_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        overrides.queueName ?? "ingest-events",
        jobId,
        "fixture-job",
        5,
        JSON.stringify({}),
        "permanent failure",
        overrides.failedAt,
        overrides.acknowledgedAt ?? null,
      ],
    );
    return jobId;
  }

  async function countByJobId(jobId: string): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM dead_letter_jobs WHERE job_id = $1`, [
      jobId,
    ]);
    return Number(rows[0]?.count ?? 0);
  }

  function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }

  it("deletes rows older than the cutoff and leaves a younger row untouched", async () => {
    const oldJobId1 = await seedRow({ failedAt: daysAgo(40) });
    const oldJobId2 = await seedRow({ failedAt: daysAgo(31) });
    const youngJobId = await seedRow({ failedAt: daysAgo(5) });

    const deletedCount = await sweepExpiredDeadLetterJobs(pool, daysAgo(30));

    expect(deletedCount).toBeGreaterThanOrEqual(2);
    expect(await countByJobId(oldJobId1)).toBe(0);
    expect(await countByJobId(oldJobId2)).toBe(0);
    expect(await countByJobId(youngJobId)).toBe(1);
  });

  it("deletes an acknowledged row older than the cutoff -- acknowledgement does not extend its life", async () => {
    const jobId = await seedRow({ failedAt: daysAgo(40), acknowledgedAt: new Date() });

    await sweepExpiredDeadLetterJobs(pool, daysAgo(30));

    expect(await countByJobId(jobId)).toBe(0);
  });

  it("leaves an unacknowledged row younger than the cutoff untouched", async () => {
    const jobId = await seedRow({ failedAt: daysAgo(5), acknowledgedAt: null });

    await sweepExpiredDeadLetterJobs(pool, daysAgo(30));

    expect(await countByJobId(jobId)).toBe(1);
  });

  it("loops across batches: deletes every expired row and returns the full count when there are more rows than the batch size", async () => {
    const smallBatchSize = 2;
    const jobIds = await Promise.all(
      Array.from({ length: 5 }, () => seedRow({ failedAt: daysAgo(40) })),
    );

    const deletedCount = await sweepExpiredDeadLetterJobs(pool, daysAgo(30), smallBatchSize);

    expect(deletedCount).toBeGreaterThanOrEqual(5);
    for (const jobId of jobIds) {
      expect(await countByJobId(jobId)).toBe(0);
    }
  });

  it("never touches dead_letter_alert_state -- byte-identical before and after a sweep that deletes rows", async () => {
    await seedRow({ failedAt: daysAgo(40) });
    const before = await pool.query(`SELECT * FROM dead_letter_alert_state WHERE id = 1`);

    await sweepExpiredDeadLetterJobs(pool, daysAgo(30));

    const after = await pool.query(`SELECT * FROM dead_letter_alert_state WHERE id = 1`);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("DEAD_LETTER_SWEEP_BATCH_SIZE matches the phase's batch discipline", () => {
    expect(DEAD_LETTER_SWEEP_BATCH_SIZE).toBe(500);
  });

  it("processWorkspacePurge sweeps an expired row and leaves a fresh row untouched", async () => {
    const expiredJobId = await seedRow({ failedAt: daysAgo(40) });
    const freshJobId = await seedRow({ failedAt: daysAgo(1) });

    await processWorkspacePurge({ deadLetterRetentionDays: 30 });

    expect(await countByJobId(expiredJobId)).toBe(0);
    expect(await countByJobId(freshJobId)).toBe(1);
  });
});
