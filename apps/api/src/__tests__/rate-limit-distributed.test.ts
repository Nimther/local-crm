import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrivateKey, Ecdsa } from "starkbank-ecdsa";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { buildServer } from "../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../test/db-fixture.js";
import { webhookEventsQueue } from "../modules/webhooks/enqueue.js";
import { logger } from "../logger.js";

/**
 * SEC-11/SEC-08 (10-12): proves the distributed rate limiter's three
 * properties end to end -- everything here drives the REAL Fastify stack
 * via `app.inject`, never the store or the route handler in isolation.
 *
 * 1. Two `buildServer()` instances sharing one Redis enforce ONE limit
 *    between them (Test 2) -- the count from Test 1 (a single instance) is
 *    the number the two-instance run must also produce, not double it. A
 *    per-process (in-memory) store would let the pair absorb roughly twice
 *    the configured `max` before either returned 429; only an EXACT-count
 *    assertion (not "a 429 eventually appeared") tells the two stores apart.
 * 2. When the limiter's Redis is unreachable, requests proceed rather than
 *    failing, and the failure is LOGGED -- `skipOnError` alone makes this
 *    silent from the request's point of view, so the log assertion is what
 *    proves SEC-08's "loud fail-open," not merely "fail-open."
 * 3. The webhook route's bucket is independent of every other rate-limited
 *    route's bucket, in both directions (T-10-12-02).
 *
 * Each test builds its OWN disposable Redis via `startTempRedis()` (never
 * `env.REDIS_URL`, never a shared instance across tests) so that one test's
 * bucket state, or one test stopping its Redis, cannot leak into another.
 * `buildServer({ rateLimitRedisUrl })` is what makes this possible --
 * production and every other apps/api test call `buildServer()` with no
 * arguments and get the process-wide `env.REDIS_URL` unchanged.
 *
 * SPEC R8 scopes SEC-11 to this in-process, single-Redis proof deliberately
 * -- multi-replica deployment is out of this milestone; two `buildServer()`
 * calls in the same test process is the whole of what "distributed" means
 * here.
 */
describe("Distributed rate limiting (SEC-11) and webhook bucket isolation (SEC-08/T-10-12-02)", () => {
  // apps/api/src/modules/tenancy/invites.ts -- POST /api/invites/:id/accept
  const INVITE_ACCEPT_LIMIT = 10;
  const inviteAcceptUrl = (id: string): string => `/api/invites/${id}/accept`;

  // apps/api/src/modules/webhooks/webhooks.routes.ts -- POST /webhooks/sendgrid/:pathToken
  const WEBHOOK_LIMIT = 100;
  const webhookUrl = (pathToken: string): string => `/webhooks/sendgrid/${pathToken}`;

  // Generous headroom over each route's own configured max -- a driver that
  // never observes a 429 within this many requests is a real bug (an
  // unlimited route, or a limit far larger than expected), not a slow test.
  const SAFETY_CAP_OVER = 25;

  type App = Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
  });

  afterAll(async () => {
    // Module-singleton BullMQ producer (apps/api/src/modules/webhooks/enqueue.ts)
    // constructed the first time any buildServer() call in this file
    // registers the webhook routes -- closed once here rather than per test,
    // mirroring webhook-timestamp-window.test.ts's own teardown.
    await webhookEventsQueue.close();
  });

  async function bootApp(redisUrl: string): Promise<App> {
    const app = await buildServer({ rateLimitRedisUrl: redisUrl });
    await app.ready();
    return app;
  }

  /**
   * Sends requests (via `requestFn`, given the 0-based attempt index) until
   * one comes back 429, and returns the 1-based count at which that
   * happened. Throws if no 429 appears within `safetyCap` attempts -- a
   * driver that silently gives up would make "the limit was never reached"
   * indistinguishable from "the limit was reached exactly where expected."
   */
  /**
   * Polls `predicate` until it is true or `timeoutMs` elapses. The
   * limiter's ioredis client reconnects on its own backoff schedule
   * (`retryStrategy` in server.ts) independent of whether any request is
   * in flight -- the first reconnect ATTEMPT (and therefore the first
   * `error` event) can land up to a couple hundred milliseconds after the
   * connection drops, which is longer than an in-process `app.inject()`
   * loop takes to run its full 30-ish iterations. A fixed sleep would be
   * either flaky (too short) or slow (padded "to be safe"); polling
   * returns as soon as the condition is true.
   */
  async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function driveUntil429(
    requestFn: (attempt: number) => Promise<{ statusCode: number }>,
    safetyCap: number
  ): Promise<number> {
    for (let attempt = 0; attempt < safetyCap; attempt += 1) {
      const res = await requestFn(attempt);
      if (res.statusCode === 429) return attempt + 1;
    }
    throw new Error(`no 429 observed within ${String(safetyCap)} requests`);
  }

  // --- webhook fixture helpers (mirrors webhook-timestamp-window.test.ts) ---

  function generateTestKeyPair(): { privateKey: PrivateKey; publicKeyPem: string } {
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

  function buildWebhookPayload(eventId: string): string {
    return (
      JSON.stringify([
        {
          email: "hello@world.com",
          event: "dropped",
          reason: "Bounced Address",
          sg_event_id: eventId,
          sg_message_id: `${eventId}.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0`,
          "smtp-id": `<${eventId}@ismtpd0039p1iad1.sendgrid.net>`,
          timestamp: Math.floor(Date.now() / 1000) - 10,
        },
      ]) + "\r\n"
    );
  }

  async function signUp(app: App, email: string, password: string, name: string) {
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

  async function createWorkspace(app: App, cookie: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create workspace failed: ${res.body}`).toBe(200);
    return res.json<{ id: string; slug: string; name: string }>();
  }

  async function freshWorkspace(app: App, nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(app, email, "correct horse battery staple 42", nameSeed);
    return createWorkspace(app, account.cookie, `${nameSeed} Co`);
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

  function signedWebhookHeaders(privateKey: PrivateKey, payload: string, timestamp: string) {
    return {
      "content-type": "application/json",
      "x-twilio-email-event-webhook-signature": signPayload(privateKey, payload, timestamp),
      "x-twilio-email-event-webhook-timestamp": timestamp,
    };
  }

  // --- Test 1 ---------------------------------------------------------------

  it("Test 1: a single instance returns 429 after its configured limit", async () => {
    const redis: TempRedis = await startTempRedis();
    const app = await bootApp(redis.url);
    try {
      const fakeInvitationId = randomUUID();
      const count = await driveUntil429(
        () => app.inject({ method: "POST", url: inviteAcceptUrl(fakeInvitationId) }),
        INVITE_ACCEPT_LIMIT + SAFETY_CAP_OVER
      );
      expect(
        count,
        "a single instance's own store: the 429 must land exactly at limit+1"
      ).toBe(INVITE_ACCEPT_LIMIT + 1);
    } finally {
      await app.close();
      await redis.stop();
    }
  });

  // --- Test 2/3 ---------------------------------------------------------------

  it("Test 2/3: two instances against one Redis reject at the SAME total the single instance did -- the 429 can land on either instance", async () => {
    const redis: TempRedis = await startTempRedis();
    const appA = await bootApp(redis.url);
    const appB = await bootApp(redis.url);
    try {
      const fakeInvitationId = randomUUID();
      // Alternate instances per attempt; the driver only asserts on the
      // RESPONSE, never on which instance produced it -- the 429 is equally
      // valid landing on either.
      const count = await driveUntil429(
        (attempt) =>
          (attempt % 2 === 0 ? appA : appB).inject({
            method: "POST",
            url: inviteAcceptUrl(fakeInvitationId),
          }),
        INVITE_ACCEPT_LIMIT + SAFETY_CAP_OVER
      );
      expect(
        count,
        "a per-process store would let the pair absorb roughly TWICE the limit before either returned 429 -- " +
          "this exact-count assertion is what a per-process store would fail and a shared Redis store passes"
      ).toBe(INVITE_ACCEPT_LIMIT + 1);
    } finally {
      await appA.close();
      await appB.close();
      await redis.stop();
    }
  });

  // --- Test 4 ---------------------------------------------------------------

  it("Test 4: with the limiter's Redis unreachable, requests proceed and an error naming the limiter is logged", async () => {
    const redis: TempRedis = await startTempRedis();
    const app = await bootApp(redis.url);

    // Stop the store AFTER the app (and its Redis client) is already up --
    // this is what turns "was never reachable" into "became unreachable
    // mid-flight," matching a real store outage rather than a boot-time
    // misconfiguration.
    //
    // The spy is attached BEFORE stopping the store: the reconnect-failure
    // error the disconnect triggers can fire within milliseconds of
    // `redis.stop()` resolving, so attaching it afterward would race the
    // very event this test asserts on.
    const errorSpy = vi.spyOn(logger, "error");
    await redis.stop();

    try {
      const fakeInvitationId = randomUUID();
      const statuses: number[] = [];
      for (let i = 0; i < INVITE_ACCEPT_LIMIT + SAFETY_CAP_OVER; i += 1) {
        const res = await app.inject({ method: "POST", url: inviteAcceptUrl(fakeInvitationId) });
        statuses.push(res.statusCode);
      }

      expect(
        statuses.every((status) => status !== 429),
        `no request should be limited once the store is unreachable: ${statuses.join(",")}`
      ).toBe(true);

      // The reconnect attempt (and its failure) runs on the client's own
      // backoff timer, independent of the request loop above -- give it up
      // to 2s (comfortably more than the 200ms first-attempt delay in
      // server.ts's retryStrategy) to have logged at least once.
      await waitFor(() => errorSpy.mock.calls.length > 0, 2_000);

      const limiterErrorLogged = errorSpy.mock.calls.some((call) => {
        const [, message] = call as [unknown, unknown];
        return typeof message === "string" && message.toLowerCase().includes("rate-limiter");
      });
      expect(
        limiterErrorLogged,
        "the fail-open must be OBSERVABLE (SEC-08) -- skipOnError alone makes it silent from the request's point of view"
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
      await app.close();
      // Already stopped above -- TempRedis.stop() is documented safe to call twice.
      await redis.stop();
    }
  });

  // --- Test 5 (webhook bucket isolation, both directions) --------------------

  it("Test 5a: exhausting the webhook route's bucket does not throttle a different rate-limited route", async () => {
    const redis: TempRedis = await startTempRedis();
    const app = await bootApp(redis.url);
    try {
      const workspace = await freshWorkspace(app, "wh-bucket-a");
      const pathToken = `tok-bucket-a-${randomUUID()}`;
      const { privateKey, publicKeyPem } = generateTestKeyPair();
      await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

      const timestamp = String(Math.floor(Date.now() / 1000) - 10);
      const payload = buildWebhookPayload(`evt-bucket-a-${randomUUID()}`);
      const headers = signedWebhookHeaders(privateKey, payload, timestamp);

      const count = await driveUntil429(
        () => app.inject({ method: "POST", url: webhookUrl(pathToken), headers, payload }),
        WEBHOOK_LIMIT + SAFETY_CAP_OVER
      );
      expect(count, "the webhook route's own bucket exhausts at its configured limit").toBe(
        WEBHOOK_LIMIT + 1
      );

      const otherRouteRes = await app.inject({
        method: "POST",
        url: inviteAcceptUrl(randomUUID()),
      });
      expect(
        otherRouteRes.statusCode,
        "exhausting the webhook bucket must not consume the invite-accept route's independent bucket"
      ).not.toBe(429);
    } finally {
      await app.close();
      await redis.stop();
    }
  });

  it("Test 5b: exhausting another route's bucket does not throttle the webhook route", async () => {
    const redis: TempRedis = await startTempRedis();
    const app = await bootApp(redis.url);
    try {
      const fakeInvitationId = randomUUID();
      const count = await driveUntil429(
        () => app.inject({ method: "POST", url: inviteAcceptUrl(fakeInvitationId) }),
        INVITE_ACCEPT_LIMIT + SAFETY_CAP_OVER
      );
      expect(count).toBe(INVITE_ACCEPT_LIMIT + 1);

      const workspace = await freshWorkspace(app, "wh-bucket-b");
      const pathToken = `tok-bucket-b-${randomUUID()}`;
      const { privateKey, publicKeyPem } = generateTestKeyPair();
      await provisionEndpoint(workspace.id, pathToken, publicKeyPem);

      const timestamp = String(Math.floor(Date.now() / 1000) - 10);
      const payload = buildWebhookPayload(`evt-bucket-b-${randomUUID()}`);
      const headers = signedWebhookHeaders(privateKey, payload, timestamp);

      const webhookRes = await app.inject({
        method: "POST",
        url: webhookUrl(pathToken),
        headers,
        payload,
      });
      expect(
        webhookRes.statusCode,
        "exhausting the invite-accept bucket must not consume the webhook route's independent bucket"
      ).toBe(200);
    } finally {
      await app.close();
      await redis.stop();
    }
  });
});
