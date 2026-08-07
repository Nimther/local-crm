import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PrivateKey, Ecdsa } from "starkbank-ecdsa";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { webhookEventsQueue } from "../enqueue.js";
import { envSchema } from "../../../env.js";
import {
  isWebhookTimestampFresh,
  DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
} from "../signature-verify.js";

/**
 * SEC-07 (10-11): the signature timestamp header's AGE, not merely its
 * presence, is now bounded. Every HTTP-level test here drives the REAL
 * Fastify stack via `app.inject` with a GENUINELY signed payload -- never
 * `verifyWebhookSignature`/`isWebhookTimestampFresh` called directly with
 * hand-built clean strings (RESEARCH.md Pitfall 1, mirrors
 * webhooks-signature.test.ts's own stated discipline).
 *
 * The existing suite's fixed SendGrid-published fixture (one payload, one
 * signature, one timestamp) cannot exercise a time-varying window -- the
 * signature is computed over `timestamp + payload` bytes (§eventwebhook.js),
 * so changing the timestamp without re-signing invalidates the signature.
 * This file therefore generates its OWN self-consistent EC key pair via
 * `starkbank-ecdsa` (the same library `@sendgrid/eventwebhook` verifies
 * with internally) and signs fresh payloads at test-chosen timestamps --
 * still a REAL ECDSA signature over REAL bytes, just not SendGrid's own
 * published constants.
 *
 * Time is controlled via `vi.useFakeTimers({ toFake: ["Date"] })` -- ONLY
 * `Date`/`Date.now()` is faked, never `setTimeout`/`setInterval`, so
 * ioredis/BullMQ/pg's real event-loop timers are untouched. Frozen (not
 * auto-advancing) so `Date.now()` returns an exact, non-flaky value
 * throughout each test's awaits -- no sleeping anywhere in this file.
 *
 * Enqueue verification is scoped by `workspaceId` (each test provisions its
 * own fresh workspace, so the id is a natural per-test unique key), NOT a
 * global before/after `getJobCounts()` delta -- this file is the SECOND
 * apps/api test file to enqueue real jobs onto the shared
 * `webhookEventsQueue` (webhooks-signature.test.ts was the first), and
 * vitest runs test files concurrently by default, so two files racing a
 * shared-queue's total depth produces exactly the cross-file flake this
 * scoping avoids (mirrors apps/worker/vitest.config.ts's documented
 * "steals sibling files' jobs mid-assertion" class of bug, without paying
 * apps/api's full-suite `fileParallelism: false` cost for it).
 */
describe("POST /webhooks/sendgrid/:pathToken timestamp window (SEC-07)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // Deliberately NOT `.obliterate()` -- this file's assertions are
    // workspace-scoped and never depend on the queue being empty, and
    // obliterating here would race webhooks-signature.test.ts's own jobs if
    // that file's tests are still mid-flight in a sibling worker.
    await webhookEventsQueue.close();
  });

  afterEach(() => {
    // Safety net: every test that fakes time restores it in its own
    // try/finally, but a thrown assertion before that finally must never
    // leak a frozen clock into a later test.
    vi.useRealTimers();
  });

  // A fixed, arbitrary instant -- NOT real wall-clock time. Every test signs
  // its payload relative to this constant and (where it needs a specific
  // "now") freezes Date to it, so age arithmetic is exact and deterministic
  // regardless of how long DB setup actually took.
  const FIXED_NOW_SECONDS = 1_700_000_000;
  const FIXED_NOW_MS = FIXED_NOW_SECONDS * 1000;

  function buildPayload(eventId: string): string {
    return (
      JSON.stringify([
        {
          email: "hello@world.com",
          event: "dropped",
          reason: "Bounced Address",
          sg_event_id: eventId,
          sg_message_id: `${eventId}.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0`,
          "smtp-id": `<${eventId}@ismtpd0039p1iad1.sendgrid.net>`,
          timestamp: FIXED_NOW_SECONDS - 10,
        },
      ]) + "\r\n"
    );
  }

  function generateTestKeyPair() {
    const privateKey = new PrivateKey();
    const publicKeyPem = privateKey
      .publicKey()
      .toPem()
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith("-----"))
      .join("");
    return { privateKey, publicKeyPem };
  }

  function signPayload(privateKey: PrivateKey, payload: string, timestamp: string): string {
    // Matches @sendgrid/eventwebhook's own verifySignature exactly:
    // message = timestamp + payload bytes, ECDSA-SHA256 over that.
    return Ecdsa.sign(timestamp + payload, privateKey).toBase64();
  }

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-up response did not set a session cookie");
    }
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
  }

  async function createWorkspace(cookie: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create workspace failed: ${res.body}`).toBe(200);
    return res.json<{ id: string; slug: string; name: string }>();
  }

  async function provisionEndpoint(workspaceId: string, pathToken: string, publicKey: string) {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(
          `INSERT INTO workspace_webhook_endpoints (workspace_id, path_token, public_key, provision_status)
           VALUES ($1, $2, $3, 'active')`,
          [workspaceId, pathToken, publicKey]
        );
      })
    );
  }

  async function freshWorkspace(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return workspace;
  }

  async function postWebhook(
    pathToken: string,
    payload: string,
    headers: Record<string, string>
  ) {
    return app.inject({
      method: "POST",
      url: `/webhooks/sendgrid/${pathToken}`,
      headers: { "content-type": "application/json", ...headers },
      payload,
    });
  }

  /** No worker runs in this test process, so an enqueued job stays "waiting" and is directly countable/inspectable. */
  async function waitingJobCountForWorkspace(workspaceId: string): Promise<number> {
    const jobs = await webhookEventsQueue.getJobs(["waiting"]);
    return jobs.filter((job) => (job.data as { workspaceId?: string }).workspaceId === workspaceId)
      .length;
  }

  it("Test 1: header timestamp exactly 600 seconds old -> 200 and enqueues", async () => {
    const workspace = await freshWorkspace("wh-window-600");
    const pathToken = `tok-window-600-${randomUUID()}`;
    const { privateKey, publicKeyPem } = generateTestKeyPair();
    await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

    const headerTimestamp = String(FIXED_NOW_SECONDS - 600);
    const payload = buildPayload(`evt-600-${randomUUID()}`);
    const signature = signPayload(privateKey, payload, headerTimestamp);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW_MS);
    let res;
    try {
      res = await postWebhook(pathToken, payload, {
        "x-twilio-email-event-webhook-signature": signature,
        "x-twilio-email-event-webhook-timestamp": headerTimestamp,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(res.statusCode, `expected 200 at exactly 600s old: ${res.body}`).toBe(200);
    expect(await waitingJobCountForWorkspace(workspace.id)).toBe(1);
  });

  it("Test 2: header timestamp 601 seconds old -> 400 and enqueues nothing", async () => {
    const workspace = await freshWorkspace("wh-window-601");
    const pathToken = `tok-window-601-${randomUUID()}`;
    const { privateKey, publicKeyPem } = generateTestKeyPair();
    await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

    const headerTimestamp = String(FIXED_NOW_SECONDS - 601);
    const payload = buildPayload(`evt-601-${randomUUID()}`);
    const signature = signPayload(privateKey, payload, headerTimestamp);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW_MS);
    let res;
    try {
      res = await postWebhook(pathToken, payload, {
        "x-twilio-email-event-webhook-signature": signature,
        "x-twilio-email-event-webhook-timestamp": headerTimestamp,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(res.statusCode).toBe(400);
    expect(await waitingJobCountForWorkspace(workspace.id)).toBe(0);
  });

  it("Test 3: non-numeric timestamp header -> 400, body byte-identical to a wrong-signature delivery", async () => {
    const workspace = await freshWorkspace("wh-window-malformed");
    const pathToken = `tok-window-malformed-${randomUUID()}`;
    const { privateKey, publicKeyPem } = generateTestKeyPair();
    await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

    // Baseline: a genuinely wrong signature (tampered payload bytes),
    // matching webhooks-signature.test.ts's own "tampered signature" shape.
    const baselineTimestamp = String(FIXED_NOW_SECONDS - 10);
    const baselinePayload = buildPayload(`evt-baseline-${randomUUID()}`);
    const baselineSignature = signPayload(privateKey, baselinePayload, baselineTimestamp);
    const wrongSignatureRes = await postWebhook(
      pathToken,
      baselinePayload.replace("hello@world.com", "attacker@evil.com"),
      {
        "x-twilio-email-event-webhook-signature": baselineSignature,
        "x-twilio-email-event-webhook-timestamp": baselineTimestamp,
      }
    );
    expect(wrongSignatureRes.statusCode).toBe(400);

    // A validly (self-consistently) signed delivery whose header timestamp
    // is a non-numeric string -- signing accepts any string as the
    // timestamp component, so this is a REAL signature over these exact
    // bytes, just for a malformed timestamp value.
    const malformedTimestamp = "not-a-timestamp";
    const malformedPayload = buildPayload(`evt-malformed-${randomUUID()}`);
    const malformedSignature = signPayload(privateKey, malformedPayload, malformedTimestamp);
    const malformedRes = await postWebhook(pathToken, malformedPayload, {
      "x-twilio-email-event-webhook-signature": malformedSignature,
      "x-twilio-email-event-webhook-timestamp": malformedTimestamp,
    });

    expect(malformedRes.statusCode).toBe(400);
    expect(malformedRes.body).toBe(wrongSignatureRes.body);
    expect(await waitingJobCountForWorkspace(workspace.id)).toBe(0);
  });

  it("Test 4: missing timestamp header -> 400, body byte-identical to a wrong-signature delivery", async () => {
    const workspace = await freshWorkspace("wh-window-missing");
    const pathToken = `tok-window-missing-${randomUUID()}`;
    const { privateKey, publicKeyPem } = generateTestKeyPair();
    await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

    const baselineTimestamp = String(FIXED_NOW_SECONDS - 10);
    const baselinePayload = buildPayload(`evt-baseline-${randomUUID()}`);
    const baselineSignature = signPayload(privateKey, baselinePayload, baselineTimestamp);
    const wrongSignatureRes = await postWebhook(
      pathToken,
      baselinePayload.replace("hello@world.com", "attacker@evil.com"),
      {
        "x-twilio-email-event-webhook-signature": baselineSignature,
        "x-twilio-email-event-webhook-timestamp": baselineTimestamp,
      }
    );
    expect(wrongSignatureRes.statusCode).toBe(400);

    const missingPayload = buildPayload(`evt-missing-${randomUUID()}`);
    const missingRes = await postWebhook(pathToken, missingPayload, {
      // No timestamp header at all -- also omit a real signature, since a
      // genuine signature cannot exist without a timestamp to sign over.
      "x-twilio-email-event-webhook-signature": "irrelevant-no-timestamp-to-sign-over",
    });

    expect(missingRes.statusCode).toBe(400);
    expect(missingRes.body).toBe(wrongSignatureRes.body);
    expect(await waitingJobCountForWorkspace(workspace.id)).toBe(0);
  });

  it("Test 5: header timestamp 601 seconds in the FUTURE -> 400 (bounded in both directions)", async () => {
    const workspace = await freshWorkspace("wh-window-future");
    const pathToken = `tok-window-future-${randomUUID()}`;
    const { privateKey, publicKeyPem } = generateTestKeyPair();
    await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

    const headerTimestamp = String(FIXED_NOW_SECONDS + 601);
    const payload = buildPayload(`evt-future-${randomUUID()}`);
    const signature = signPayload(privateKey, payload, headerTimestamp);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW_MS);
    let res;
    try {
      res = await postWebhook(pathToken, payload, {
        "x-twilio-email-event-webhook-signature": signature,
        "x-twilio-email-event-webhook-timestamp": headerTimestamp,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(res.statusCode, `expected 400 for a 601s future-dated timestamp: ${res.body}`).toBe(
      400
    );
    expect(await waitingJobCountForWorkspace(workspace.id)).toBe(0);
  });

  it("Test 6: replaying an accepted delivery after the window has elapsed is rejected the second time", async () => {
    // Proves the window bounds REPLAY of the identical signed bytes over
    // time, not merely a single request's age at receipt. Per-event
    // deduplication (sg_event_id) is a separate mechanism owned by the
    // worker/Phase 13 -- this test proves the HTTP-level age bound alone,
    // with the exact same bytes and headers replayed verbatim.
    const workspace = await freshWorkspace("wh-window-replay");
    const pathToken = `tok-window-replay-${randomUUID()}`;
    const { privateKey, publicKeyPem } = generateTestKeyPair();
    await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

    // Inside the window relative to FIXED_NOW_SECONDS (300s old).
    const headerTimestamp = String(FIXED_NOW_SECONDS - 300);
    const payload = buildPayload(`evt-replay-${randomUUID()}`);
    const signature = signPayload(privateKey, payload, headerTimestamp);
    const headers = {
      "x-twilio-email-event-webhook-signature": signature,
      "x-twilio-email-event-webhook-timestamp": headerTimestamp,
    };

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(FIXED_NOW_MS);
      const first = await postWebhook(pathToken, payload, headers);
      expect(first.statusCode, `first delivery should succeed: ${first.body}`).toBe(200);
      expect(await waitingJobCountForWorkspace(workspace.id)).toBe(1);

      // Advance the apparent clock so the SAME signed timestamp is now 602
      // seconds old -- past the window -- and replay the identical bytes.
      vi.setSystemTime((FIXED_NOW_SECONDS + 302) * 1000);
      const replay = await postWebhook(pathToken, payload, headers);
      expect(
        replay.statusCode,
        `replay after window elapsed should be rejected: ${replay.body}`
      ).toBe(400);

      // Still exactly one -- the replay must not have enqueued a second job.
      expect(await waitingJobCountForWorkspace(workspace.id)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Test 7: a fresh timestamp with a WRONG signature still returns 400 (freshness composes with, never replaces, verification)", async () => {
    const workspace = await freshWorkspace("wh-window-composed");
    const pathToken = `tok-window-composed-${randomUUID()}`;
    const { privateKey, publicKeyPem } = generateTestKeyPair();
    await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

    // Fresh, well inside the window.
    const headerTimestamp = String(FIXED_NOW_SECONDS - 100);
    const payload = buildPayload(`evt-composed-${randomUUID()}`);
    const signature = signPayload(privateKey, payload, headerTimestamp);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW_MS);
    let res;
    try {
      res = await postWebhook(
        pathToken,
        // Tamper the payload bytes actually sent -- same genuine signature,
        // different bytes underneath it (mirrors webhooks-signature.test.ts's
        // "tampered signature" case).
        payload.replace("hello@world.com", "attacker@evil.com"),
        {
          "x-twilio-email-event-webhook-signature": signature,
          "x-twilio-email-event-webhook-timestamp": headerTimestamp,
        }
      );
    } finally {
      vi.useRealTimers();
    }

    expect(
      res.statusCode,
      `a fresh timestamp must NOT bypass signature verification: ${res.body}`
    ).toBe(400);
    expect(await waitingJobCountForWorkspace(workspace.id)).toBe(0);
  });

  it("Test 8: the pure predicate takes an explicit tolerance override and defaults to 600 seconds when unset", () => {
    expect(DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).toBe(600);

    const now = 1_700_000_000_000;
    // Explicit override (120s), independent of any environment variable --
    // the predicate itself never reads process.env (kept pure/unit-testable).
    expect(isWebhookTimestampFresh(String(1_700_000_000 - 120), 120, now)).toBe(true);
    expect(isWebhookTimestampFresh(String(1_700_000_000 - 121), 120, now)).toBe(false);

    // env.ts's zod schema is where the environment override actually lives
    // (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) -- default 600 when unset,
    // overridable when set. Parsed directly via the exported schema
    // (mirrors env-schema.test.ts's own pattern) rather than reloading the
    // process-wide `env` singleton, which is parsed once at import time.
    const baseValidEnv: Record<string, string> = {
      DATABASE_URL: "postgres://user:pass@localhost:5432/megacrm_test",
      AUTH_DATABASE_URL: "postgres://mega_crm_auth:pass@localhost:5432/megacrm_test",
      REDIS_URL: "redis://localhost:6379/1",
      BETTER_AUTH_SECRET: "0123456789abcdef0123",
      BETTER_AUTH_URL: "http://localhost:4000",
      WEB_URL: "http://localhost:5173",
      PLATFORM_SENDGRID_API_KEY: "SG.test_platform_key_0000000000000000",
      PLATFORM_MAIL_FROM: "noreply@megacrm.test",
      OPERATOR_ALERT_EMAIL: "ops@megacrm.test",
      UNSUBSCRIBE_TOKEN_SECRET: "test-only-unsubscribe-secret-at-least-32-bytes",
      PUBLIC_APP_URL: "https://api.test.local",
      KMS_PROVIDER: "local",
      KMS_LOCAL_KEK: "grdVCb1fxmhPzylKEPqafcPW4xOMaynE0UwaFUo2OUE=",
    };

    const withoutOverride = envSchema.safeParse(baseValidEnv);
    expect(withoutOverride.success).toBe(true);
    if (withoutOverride.success) {
      expect(withoutOverride.data.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).toBe(600);
    }

    const withOverride = envSchema.safeParse({
      ...baseValidEnv,
      WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: "120",
    });
    expect(withOverride.success).toBe(true);
    if (withOverride.success) {
      expect(withOverride.data.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS).toBe(120);
    }
  });
});
