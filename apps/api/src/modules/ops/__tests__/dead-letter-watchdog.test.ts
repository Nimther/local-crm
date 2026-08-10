import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "@mega-crm/tenant-context";

import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import {
  DEAD_LETTER_ALERT_DEDUP_HOURS,
  DEAD_LETTER_WATCHDOG_INTERVAL_MS,
  checkDeadLetterHealthAndAlert,
  claimDeadLetterAlertSlot,
  readDeadLetterHealth,
  renderDeadLetterAlertText,
  startDeadLetterWatchdog,
} from "../dead-letter-watchdog.js";

/**
 * 12-10 (WRK-10, D-08): the third operator watchdog's own test module,
 * mirroring `partition-watchdog.test.ts`'s and `send-reconciler-watchdog.test.ts`'s
 * structure and conventions. Unlike its two singleton-health-row siblings,
 * `dead_letter_jobs` is a genuine multi-row table -- every DB-touching test
 * below runs against a table reset in `beforeEach` so rows from one test can
 * never leak into another's count/queue-name assertions.
 */

let seedCounter = 0;

async function seedDeadLetterRow(overrides: {
  queueName?: string;
  jobId?: string;
  failedAt?: Date;
  acknowledgedAt?: Date | null;
  payloadMarker?: string;
} = {}): Promise<void> {
  seedCounter += 1;
  const queueName = overrides.queueName ?? "ingest-events";
  const jobId = overrides.jobId ?? `job-${seedCounter}`;
  const failedAt = overrides.failedAt ?? new Date();
  const acknowledgedAt = overrides.acknowledgedAt ?? null;
  const payload = overrides.payloadMarker ? { marker: overrides.payloadMarker } : {};

  await pool.query(
    `INSERT INTO dead_letter_jobs (
       queue_name, job_id, job_name, attempts_made, payload, error_message, failed_at, acknowledged_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (queue_name, job_id) DO UPDATE SET
       failed_at = EXCLUDED.failed_at,
       acknowledged_at = EXCLUDED.acknowledged_at`,
    [queueName, jobId, "fixture-job", 5, JSON.stringify(payload), "permanent failure", failedAt, acknowledgedAt],
  );
}

async function resetDeadLetterAlertState(): Promise<void> {
  await pool.query(
    `UPDATE dead_letter_alert_state
        SET last_alert_sent_at = NULL, last_seen_failed_at = NULL, updated_at = now()
      WHERE id = 1`,
  );
}

describe("renderDeadLetterAlertText (pure, no DB)", () => {
  it("test 1: carries the unacknowledged count, the queue names and the oldest failure timestamp, and never a payload field", () => {
    const now = new Date("2027-03-01T00:00:00Z");
    const oldestFailedAt = new Date("2027-02-28T12:00:00Z");
    const body = renderDeadLetterAlertText(
      { unacknowledgedCount: 3, queueNames: ["ingest-events", "webhook-events"], oldestFailedAt },
      now,
    );

    expect(body).toContain(now.toISOString());
    expect(body).toContain("3");
    expect(body).toContain("ingest-events");
    expect(body).toContain("webhook-events");
    expect(body).toContain(oldestFailedAt.toISOString());
    expect(body).not.toContain("payload");
    expect(body).not.toContain("marker-value");
  });

  it("test 2: with a null oldestFailedAt the body still renders without dereferencing it", () => {
    const now = new Date("2027-03-01T00:00:00Z");
    const body = renderDeadLetterAlertText({ unacknowledgedCount: 0, queueNames: [], oldestFailedAt: null }, now);
    expect(body).toContain("0");
    expect(body).not.toContain("Invalid Date");
  });
});

describe("readDeadLetterHealth / claimDeadLetterAlertSlot / checkDeadLetterHealthAndAlert (T-12-10-01/02/03)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool.on("error", () => {
      // expected: the concurrent-replica test below deliberately drives two
      // independent pools against the same alert-state row, mirroring
      // partition-watchdog.test.ts's own multi-pool convention.
    });
  });

  beforeEach(async () => {
    // dead_letter_jobs is a genuine multi-row table (unlike the singleton
    // health rows the two sibling watchdogs read) -- every test starts from
    // an empty table and a reset alert-state row so counts/queue-name
    // assertions can never see another test's rows.
    await pool.query("DELETE FROM dead_letter_jobs");
    await resetDeadLetterAlertState();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test 3: with no unacknowledged rows readDeadLetterHealth reports zero and checkDeadLetterHealthAndAlert sends nothing", async () => {
    const snapshot = await readDeadLetterHealth(pool);
    expect(snapshot.unacknowledgedCount).toBe(0);
    expect(snapshot.queueNames).toEqual([]);
    expect(snapshot.oldestFailedAt).toBeNull();

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkDeadLetterHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(0);

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM dead_letter_alert_state WHERE id = 1",
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();
  });

  it("test 4: acknowledged rows are excluded from both the count and the alert decision", async () => {
    await seedDeadLetterRow({ queueName: "ingest-events", jobId: "ack-1", acknowledgedAt: new Date() });

    const snapshot = await readDeadLetterHealth(pool);
    expect(snapshot.unacknowledgedCount).toBe(0);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    await checkDeadLetterHealthAndAlert({ client: pool, now: new Date(), operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(0);
  });

  it("test 5: unacknowledged rows present -> checkDeadLetterHealthAndAlert sends exactly one mail naming the queues, count and oldest failure", async () => {
    const t1 = new Date("2027-04-01T00:00:00Z");
    const oldest = new Date(t1.getTime() - 60 * 60 * 1000);
    await seedDeadLetterRow({ queueName: "ingest-events", jobId: "job-a", failedAt: oldest });
    await seedDeadLetterRow({ queueName: "webhook-events", jobId: "job-b", failedAt: t1, payloadMarker: "marker-value" });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkDeadLetterHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("2");
    expect(sent[0]?.text).toContain("ingest-events");
    expect(sent[0]?.text).toContain("webhook-events");
    expect(sent[0]?.text).toContain(oldest.toISOString());
    expect(sent[0]?.text).not.toContain("marker-value");
  });

  it("test 6: at most one send per DEAD_LETTER_ALERT_DEDUP_HOURS window, even across repeated unhealthy checks", async () => {
    const t1 = new Date("2027-05-01T00:00:00Z");
    await seedDeadLetterRow({ queueName: "ingest-events", jobId: "dedup-1", failedAt: t1 });

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };

    await checkDeadLetterHealthAndAlert({ client: pool, now: t1, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);

    const t2 = new Date(t1.getTime() + 60_000); // still deduped
    await checkDeadLetterHealthAndAlert({ client: pool, now: t2, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(1);

    const t3 = new Date(t1.getTime() + (DEAD_LETTER_ALERT_DEDUP_HOURS + 1) * 60 * 60 * 1000); // past the window
    await checkDeadLetterHealthAndAlert({ client: pool, now: t3, operatorEmail: "ops@example.com", sendMail });
    expect(sent).toHaveLength(2);
  });

  it("test 7: claimDeadLetterAlertSlot's own atomicity -- a second claim inside the window is refused", async () => {
    const t1 = new Date("2027-05-10T00:00:00Z");
    const firstClaim = await claimDeadLetterAlertSlot(pool, t1, DEAD_LETTER_ALERT_DEDUP_HOURS);
    expect(firstClaim).toBe(true);

    const secondClaim = await claimDeadLetterAlertSlot(pool, new Date(t1.getTime() + 60_000), DEAD_LETTER_ALERT_DEDUP_HOURS);
    expect(secondClaim).toBe(false);
  });

  it("test 8: two concurrent replicas checking the same unhealthy table produce exactly one send", async () => {
    await seedDeadLetterRow({ queueName: "ingest-events", jobId: "race-1" });

    const dsn = getTestDatabaseUrl();
    const poolA = new Pool({ connectionString: dsn, max: 2 });
    const poolB = new Pool({ connectionString: dsn, max: 2 });
    poolA.on("error", () => undefined);
    poolB.on("error", () => undefined);

    const sent: Array<{ to: string; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
    const sendMail = async (message: { to: string; text: string }) => {
      sent.push(message);
    };
    const now = new Date();

    try {
      await Promise.all([
        checkDeadLetterHealthAndAlert({ client: poolA, now, operatorEmail: "ops@example.com", sendMail }),
        checkDeadLetterHealthAndAlert({ client: poolB, now, operatorEmail: "ops@example.com", sendMail }),
      ]);
    } finally {
      await poolA.end();
      await poolB.end();
    }

    expect(sent).toHaveLength(1);
  });

  it("test 9: a rejecting sendMail causes checkDeadLetterHealthAndAlert to reject, never swallowed, and does not permanently burn the dedup window (CR-02)", async () => {
    const now = new Date();
    await seedDeadLetterRow({ queueName: "ingest-events", jobId: "release-1", failedAt: now });

    await expect(
      checkDeadLetterHealthAndAlert({
        client: pool,
        now,
        operatorEmail: "ops@example.com",
        sendMail: () => Promise.reject(new Error("sendgrid down")),
      }),
    ).rejects.toThrow("sendgrid down");

    const { rows } = await pool.query<{ last_alert_sent_at: Date | null }>(
      "SELECT last_alert_sent_at FROM dead_letter_alert_state WHERE id = 1",
    );
    expect(rows[0]?.last_alert_sent_at).toBeNull();

    // The very next check, moments later, still inside the dedup window,
    // must be able to claim and actually send.
    const sent: Array<{ to: string; text: string }> = [];
    await checkDeadLetterHealthAndAlert({
      client: pool,
      now: new Date(now.getTime() + 1_000),
      operatorEmail: "ops@example.com",
      // eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous
      sendMail: async (message) => {
        sent.push(message);
      },
    });
    expect(sent).toHaveLength(1);
  });
});

describe("startDeadLetterWatchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("test 10: returns an interval handle and a rejected check is caught and logged rather than escaping", async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const client = {
      query: () => Promise.reject(new Error("db down")),
    };
    const handle = startDeadLetterWatchdog({
      client,
      operatorEmail: "ops@example.com",
      sendMail: () => Promise.resolve(),
    });

    expect(handle).toBeDefined();

    await vi.advanceTimersByTimeAsync(DEAD_LETTER_WATCHDOG_INTERVAL_MS);
    // Let the rejected microtask's .catch() handler run.
    await Promise.resolve();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "dead-letter-watchdog: health check failed",
      expect.anything(),
    );

    clearInterval(handle);
  });
});
