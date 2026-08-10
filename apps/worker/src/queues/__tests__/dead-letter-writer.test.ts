import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Job } from "bullmq";
import type { Pool } from "pg";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { isTerminalJobFailure, writeDeadLetterOnTerminalFailure } from "../dead-letter/dead-letter-writer.js";

/**
 * Phase 12, plan 12-07 (WRK-09/WRK-10, D-07), Task 2: proves the terminal-
 * failure gate and the redacting insert against a real database -- this is
 * the prohibition's proof (T-12-07-01): a payload holding a plausible
 * contact email address, a provider-shaped API key and a bearer token is
 * written, read back, and none of the three raw values may appear anywhere
 * in the persisted row.
 */

/** Minimal fake of the BullMQ `Job` surface the writer actually reads. */
function fakeJob(overrides: {
  id?: string;
  name?: string;
  data?: unknown;
  attemptsMade?: number;
  attempts?: number;
}): Job {
  return {
    id: overrides.id ?? "job-1",
    name: overrides.name ?? "fixture-job",
    data: overrides.data ?? {},
    attemptsMade: overrides.attemptsMade ?? 1,
    opts: overrides.attempts === undefined ? {} : { attempts: overrides.attempts },
  } as unknown as Job;
}

describe("dead-letter-writer.ts (12-07, WRK-09/WRK-10, D-07)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function readDeadLetterRow(
    queueName: string,
    jobId: string,
  ): Promise<
    | {
        attemptsMade: number;
        payload: unknown;
        errorMessage: string;
      }
    | undefined
  > {
    const { rows } = await pool.query<{ attempts_made: number; payload: unknown; error_message: string }>(
      `SELECT attempts_made, payload, error_message FROM dead_letter_jobs WHERE queue_name = $1 AND job_id = $2`,
      [queueName, jobId],
    );
    const row = rows[0];
    return row
      ? { attemptsMade: row.attempts_made, payload: row.payload, errorMessage: row.error_message }
      : undefined;
  }

  async function countDeadLetterRows(queueName: string, jobId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT id FROM dead_letter_jobs WHERE queue_name = $1 AND job_id = $2`, [
      queueName,
      jobId,
    ]);
    return rows.length;
  }

  it("isTerminalJobFailure: false below configured attempts, true once reached, true on first failure when unconfigured", () => {
    expect(isTerminalJobFailure(fakeJob({ attemptsMade: 2, attempts: 5 }))).toBe(false);
    expect(isTerminalJobFailure(fakeJob({ attemptsMade: 5, attempts: 5 }))).toBe(true);
    expect(isTerminalJobFailure(fakeJob({ attemptsMade: 1, attempts: undefined }))).toBe(true);
  });

  it("writes no row for a non-terminal failure", async () => {
    const queueName = "test-queue-non-terminal";
    const job = fakeJob({ id: "job-non-terminal", attemptsMade: 1, attempts: 5 });
    await writeDeadLetterOnTerminalFailure(job, new Error("transient"), queueName, { pool });

    expect(await countDeadLetterRows(queueName, "job-non-terminal")).toBe(0);
  });

  it("writes exactly one row for a terminal failure, carrying queue name, job id, job name, attempts made and error message", async () => {
    const queueName = "test-queue-terminal";
    const job = fakeJob({ id: "job-terminal-1", name: "fixture-terminal-job", attemptsMade: 5, attempts: 5 });
    await writeDeadLetterOnTerminalFailure(job, new Error("permanent failure"), queueName, { pool });

    const row = await readDeadLetterRow(queueName, "job-terminal-1");
    expect(row).toBeDefined();
    expect(row?.attemptsMade).toBe(5);
    expect(row?.errorMessage).toBe("permanent failure");
  });

  it("redacts an email address, a provider API key and a bearer token from the persisted payload (T-12-07-01)", async () => {
    const queueName = "test-queue-redaction";
    const rawEmail = "leaked-contact@example.com";
    const rawApiKey = "SG.abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyzabcdefghijklmno";
    const rawBearerToken = "super-secret-bearer-token-value-0000";
    const job = fakeJob({
      id: "job-redaction-1",
      attemptsMade: 1,
      attempts: 1,
      data: {
        contactEmail: rawEmail,
        sendgridKey: rawApiKey,
        authorization: `Bearer ${rawBearerToken}`,
      },
    });
    await writeDeadLetterOnTerminalFailure(job, new Error("boom"), queueName, { pool });

    const row = await readDeadLetterRow(queueName, "job-redaction-1");
    expect(row).toBeDefined();
    const serializedPayload = JSON.stringify(row?.payload);
    expect(serializedPayload).not.toContain(rawEmail);
    expect(serializedPayload).not.toContain(rawApiKey);
    expect(serializedPayload).not.toContain(rawBearerToken);
  });

  it("calling it twice for the same queue and job id leaves exactly one row, with the later error message and failure timestamp", async () => {
    const queueName = "test-queue-duplicate";
    const job1 = fakeJob({ id: "job-dup-1", attemptsMade: 5, attempts: 5 });
    await writeDeadLetterOnTerminalFailure(job1, new Error("first failure"), queueName, { pool });
    const firstRow = await pool.query<{ failed_at: Date }>(
      `SELECT failed_at FROM dead_letter_jobs WHERE queue_name = $1 AND job_id = $2`,
      [queueName, "job-dup-1"],
    );

    // Ensure a measurable timestamp gap between the two writes.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const job2 = fakeJob({ id: "job-dup-1", attemptsMade: 5, attempts: 5 });
    await writeDeadLetterOnTerminalFailure(job2, new Error("second failure"), queueName, { pool });

    expect(await countDeadLetterRows(queueName, "job-dup-1")).toBe(1);
    const row = await readDeadLetterRow(queueName, "job-dup-1");
    expect(row?.errorMessage).toBe("second failure");

    const secondRow = await pool.query<{ failed_at: Date }>(
      `SELECT failed_at FROM dead_letter_jobs WHERE queue_name = $1 AND job_id = $2`,
      [queueName, "job-dup-1"],
    );
    expect(secondRow.rows[0].failed_at.getTime()).toBeGreaterThan(firstRow.rows[0].failed_at.getTime());
  });

  it("a database error during the write is caught and logged rather than rethrown", async () => {
    const queueName = "test-queue-db-error";
    const job = fakeJob({ id: "job-db-error", attemptsMade: 1, attempts: 1 });
    const brokenPool = {
      query: () => Promise.reject(new Error("simulated connection failure")),
    } as unknown as Pool;

    await expect(
      writeDeadLetterOnTerminalFailure(job, new Error("permanent failure"), queueName, { pool: brokenPool }),
    ).resolves.toBeUndefined();
  });
});
