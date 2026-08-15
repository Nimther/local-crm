import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Job, Worker } from "bullmq";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenantTransaction } from "@mega-crm/tenant-context";
import type { EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { emailBroadcastJobSchema } from "@mega-crm/shared-schemas";
import { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "../test/db-fixture.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  freshWorkspaceId,
} from "../test/failure-fixtures.js";

/**
 * Phase 15 plan 02 (Task 3) -- TRACER PROOF: one correlation id, bound by
 * `handleEmailBroadcastJob`'s `withCorrelation` wrapping, is visible in BOTH
 * a real worker log line (captured pino output) AND `pg_stat_activity
 * .application_name` for a transaction opened while that job is processing
 * -- the full HTTP->queue->Postgres path this plan's objective names, minus
 * the HTTP hop itself (proven separately by `apps/api`'s own suite: the
 * `genReqId` override and the test-send route reading the correlation id
 * back via `getCorrelationContext()`).
 *
 * The logger singleton (`apps/worker/src/logger.ts`) is only ever imported
 * via a DYNAMIC `import()` inside `beforeAll`, AFTER `process.stdout.write`
 * has been tampered with. Pino's own default-stream selection
 * (`lib/tools.js`'s `hasBeenTampered` check) picks `process.stdout` itself
 * as the write destination once it detects the stream has been patched,
 * instead of the raw-fd `SonicBoom` writer a plain `pino()` call otherwise
 * builds -- SonicBoom bypasses `process.stdout` entirely (writes straight to
 * the file descriptor), so it cannot be captured by a `process.stdout.write`
 * spy at all. A static top-level `import` would run before this file's own
 * code executes (ES module imports are hoisted), which is why every import
 * that transitively touches `../logger.js` is deferred into `beforeAll`.
 */
describe("correlation tracer: one requestId across worker log + application_name", () => {
  let pool: Pool;
  let redisClient: Redis;
  let stdoutChunks: string[];
  let handleEmailBroadcastJob: typeof import("../queues/email-broadcast.worker.js")["handleEmailBroadcastJob"];
  let workerLogger: typeof import("../logger.js")["logger"];

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");

    stdoutChunks = [];
    // MUST happen before the first import of ../logger.js (below) --
    // tampering process.stdout.write before pino's module-level
    // construction runs is what makes pino pick process.stdout as its
    // destination instead of a raw-fd SonicBoom writer.
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });

    ({ logger: workerLogger } = await import("../logger.js"));
    // Constructed with level "silent" under NODE_ENV=test (see logger.ts) --
    // bumped to "info" here so this test's log calls actually reach the
    // (now-captured) stream. pino's `.level` is a runtime-settable property.
    workerLogger.level = "info";

    ({ handleEmailBroadcastJob } = await import("../queues/email-broadcast.worker.js"));
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
    vi.restoreAllMocks();
  });

  function fakeWorker(): Worker<EmailBroadcastJob> {
    return { rateLimit: vi.fn() } as unknown as Worker<EmailBroadcastJob>;
  }

  function fakeJob(data: EmailBroadcastJob, id: string): Job<EmailBroadcastJob> {
    return { id, data } as Job<EmailBroadcastJob>;
  }

  it("carries one requestId into a captured worker log line and into pg_stat_activity.application_name for a transaction opened during job processing", async () => {
    const workspaceId = await freshWorkspaceId(pool, "correlation-tracer");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);

    const requestId = `trace-req-${Date.now().toString(36)}`;
    // A short, UUID-shaped id -- NOT this codebase's real
    // `${workspaceId}-test-${campaignId}-${Date.now()}` jobId format (which
    // alone runs well past APPLICATION_NAME_BYTE_BUDGET and would be
    // deterministically truncated, correctly, before this assertion ever
    // saw it -- see the byte-budget suite in
    // application-name-correlation.test.ts for that proof instead).
    const jobId = randomUUID();

    const jobData = emailBroadcastJobSchema.parse({
      workspaceId,
      campaignId,
      kind: "test",
      testTo: "marketer@fixture.test",
      requestId,
    });

    let observedApplicationName = "";
    // Stands in for the real SendGrid call -- invoked deep inside
    // processSendJob's test-send branch, still nested within
    // handleEmailBroadcastJob's withCorrelation({ jobId, requestId }) scope.
    // Opening a FRESH withTenantTransaction here observes the SAME
    // correlation-derived application_name a transaction opened anywhere
    // else during this job's processing would (composeApplicationName reads
    // the currently-bound ALS store, not "which transaction this is").
    const sendMail = async () => {
      observedApplicationName = await withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ application_name: string }>(
          "SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        );
        return rows[0].application_name;
      });
      return { status: 202, headers: new Headers(), messageId: "sg-message-id-fixture" };
    };

    await handleEmailBroadcastJob(fakeJob(jobData, jobId), fakeWorker(), { sendMail, redisClient });

    // --- Postgres half ---
    expect(observedApplicationName).toContain(requestId);
    expect(observedApplicationName).toContain(jobId);

    // --- worker log half ---
    const logLines = stdoutChunks
      .join("")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .filter((parsed): parsed is Record<string, unknown> => parsed !== undefined);

    const matchingLine = logLines.find((line) => line.requestId === requestId);
    expect(
      matchingLine,
      `expected a captured worker log line with requestId=${requestId}; captured lines: ${JSON.stringify(logLines)}`,
    ).toBeDefined();
    expect(matchingLine?.jobId).toBe(jobId);

    // --- the same literal id, both places ---
    expect(observedApplicationName).toContain(requestId);
    expect(matchingLine?.requestId).toBe(requestId);
  });

  it("still validates and processes a job payload with no requestId field (pre-Phase-15 compatibility)", async () => {
    const workspaceId = await freshWorkspaceId(pool, "correlation-tracer-legacy");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);

    // Deliberately no `requestId` key at all -- mirrors a job enqueued by
    // pre-Phase-15 code.
    const legacyPayload = {
      workspaceId,
      campaignId,
      kind: "test" as const,
      testTo: "marketer@fixture.test",
    };
    const parsed = emailBroadcastJobSchema.parse(legacyPayload);
    expect(parsed.requestId).toBeUndefined();

    const jobId = randomUUID();
    let observedApplicationName = "";
    const sendMail = async () => {
      observedApplicationName = await withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ application_name: string }>(
          "SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        );
        return rows[0].application_name;
      });
      return { status: 202, headers: new Headers(), messageId: "sg-message-id-fixture" };
    };

    await expect(
      handleEmailBroadcastJob(fakeJob(parsed, jobId), fakeWorker(), { sendMail, redisClient }),
    ).resolves.toBeUndefined();

    // No requestId bound -- composeApplicationName's "req=-" placeholder --
    // but jobId (from job.id, always present) still appears.
    expect(observedApplicationName).toContain("req=-");
    expect(observedApplicationName).toContain(jobId);
  });
});
