import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Job, Worker } from "bullmq";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenantTransaction } from "@mega-crm/tenant-context";
import type { EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { emailBroadcastJobSchema, EMAIL_BROADCAST_QUEUE } from "@mega-crm/shared-schemas";
import { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "../test/db-fixture.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  freshWorkspaceId,
} from "../test/failure-fixtures.js";

/**
 * Phase 15 plan 02 (Task 3) -- TRACER PROOF: one correlation id is visible in
 * BOTH a real worker log line (captured pino output) AND `pg_stat_activity
 * .application_name` for a transaction opened while that job is processing
 * -- the full HTTP->queue->Postgres path this plan's objective names, minus
 * the HTTP hop itself (proven separately by `apps/api`'s own suite: the
 * `genReqId` override and the test-send route reading the correlation id
 * back via `getCorrelationContext()`).
 *
 * Phase 15 plan 08 (OPS-06): the correlation scope this test exercises now
 * opens inside the shared `wrapProcessor` helper, not inline in
 * `handleEmailBroadcastJob` (plan 02's targeted tracer-only fix was replaced
 * by the general-purpose wrapper every `create*Worker` factory routes
 * through) -- this suite invokes the handler THROUGH `wrapProcessor`, the
 * same shape `createEmailBroadcastWorker`'s factory now does, rather than
 * calling `handleEmailBroadcastJob` bare.
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
  let wrapProcessor: typeof import("../processor-wrapper.js")["wrapProcessor"];
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
    ({ wrapProcessor } = await import("../processor-wrapper.js"));
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
    // processSendJob's test-send branch, still nested within the
    // withCorrelation({ jobId, requestId }) scope wrapProcessor opens.
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

    const wrapped = wrapProcessor(EMAIL_BROADCAST_QUEUE, (job: Job<EmailBroadcastJob>, token) =>
      handleEmailBroadcastJob(job, fakeWorker(), { sendMail, redisClient }, token),
    );
    await wrapped(fakeJob(jobData, jobId));

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

    const wrapped = wrapProcessor(EMAIL_BROADCAST_QUEUE, (job: Job<EmailBroadcastJob>, token) =>
      handleEmailBroadcastJob(job, fakeWorker(), { sendMail, redisClient }, token),
    );
    await expect(wrapped(fakeJob(parsed, jobId))).resolves.toBeUndefined();

    // WR-03 (Phase 15 plan 10 fix): wrapProcessor no longer falls back
    // requestId to the job id when the payload carries none -- that fallback
    // made requestId indistinguishable from jobId in every log line/Sentry
    // tag for any queue whose payload has no genuine requestId (repeatable
    // ticks, webhook-originated jobs, ...). A legacy payload's
    // application_name now reads the plan 02 `req=-` placeholder (requestId
    // truly unbound) with `job=<jobId>` still carrying job-level
    // correlation -- @mega-crm/tenant-context's own composition already
    // handles this absent-requestId case.
    expect(observedApplicationName).toContain("req=-");
    expect(observedApplicationName).toContain(`job=${jobId}`);
  });

  it("carries sendId into a captured worker log line alongside requestId and jobId, matching the custom_args.send_id SendGrid receives (G-15-1 dispatch half)", async () => {
    const workspaceId = await freshWorkspaceId(pool, "correlation-tracer-sendid");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);

    const requestId = `trace-req-sendid-${Date.now().toString(36)}`;
    const jobId = randomUUID();

    const jobData = emailBroadcastJobSchema.parse({
      workspaceId,
      campaignId,
      kind: "test",
      testTo: "marketer@fixture.test",
      requestId,
    });

    let capturedSendId = "";
    const sendMail = async (_apiKey: string, payload: { personalizations: Array<{ custom_args: { send_id: string } }> }) => {
      capturedSendId = payload.personalizations[0].custom_args.send_id;
      return { status: 202, headers: new Headers(), messageId: "sg-message-id-fixture-sendid" };
    };

    const wrapped = wrapProcessor(EMAIL_BROADCAST_QUEUE, (job: Job<EmailBroadcastJob>, token) =>
      handleEmailBroadcastJob(job, fakeWorker(), { sendMail, redisClient }, token),
    );
    await wrapped(fakeJob(jobData, jobId));

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

    const matchingLine = logLines.find(
      (line) => line.sendId === capturedSendId && line.requestId === requestId,
    );

    // Assertion 1: at least one captured JSON line has sendId strictly equal
    // to the captured custom_args.send_id -- proves the field is not merely
    // declared, the value on the line is the same value SendGrid was handed.
    expect(
      matchingLine,
      `expected a captured worker log line with sendId=${capturedSendId} and requestId=${requestId}; captured lines: ${JSON.stringify(logLines)}`,
    ).toBeDefined();

    // Assertion 2: that SAME line also carries requestId and jobId -- a line
    // with sendId but no requestId would not close OPS-11's correlation claim.
    expect(matchingLine?.requestId).toBe(requestId);
    expect(matchingLine?.jobId).toBe(jobId);

    // Assertion 3: the fixture recipient address never occurs anywhere on
    // that line -- the standing no-PII guarantee for the new call sites.
    const serializedLine = JSON.stringify(matchingLine);
    expect(serializedLine).not.toContain("marketer@fixture.test");
  });
});
