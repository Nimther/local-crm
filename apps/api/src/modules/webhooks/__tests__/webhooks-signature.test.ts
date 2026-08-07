import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { webhookEventsQueue } from "../enqueue.js";
import { findWebhookEndpointByToken } from "../webhook-endpoint.repository.js";

/**
 * POST /webhooks/sendgrid/:pathToken (WBHK-01, T-05-01/02/03): drives the
 * REAL Fastify HTTP stack via `app.inject` -- never calls
 * `verifyWebhookSignature` directly with hand-built clean strings (that
 * would pass a naive unit test but never match a real request,
 * RESEARCH.md Pitfall 1). The valid-signature case uses SendGrid's own
 * published example signed payload + public key + signature (from
 * `@sendgrid/eventwebhook`'s own test fixture,
 * node_modules/@sendgrid/eventwebhook/src/eventwebhook.spec.js) -- a REAL
 * signature over REAL bytes, not a fabricated one.
 *
 * Enqueue is verified via the REAL `webhookEventsQueue` (BullMQ/Redis), not
 * a mocked function -- mirrors this codebase's existing precedent
 * (events-api.test.ts's CR-01 test reads `eventsIngestQueue.getJob(...)`
 * directly) rather than introducing a new module-mocking convention. No
 * worker runs in this test process, so a job that reaches the queue stays
 * in the `waiting` state and is directly countable.
 */
describe("POST /webhooks/sendgrid/:pathToken (WBHK-01)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  // SendGrid's own published example signed payload (verbatim from
  // @sendgrid/eventwebhook's test fixture) -- a real ECDSA signature
  // computed over these exact bytes by SendGrid's own test suite.
  const PUBLIC_KEY =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
  const SIGNATURE =
    "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=";
  const TIMESTAMP = "1600112502";
  // Trailing "\r\n" is part of the exact bytes the signature was computed
  // over (SendGrid's own fixture comment: "Be sure to include the trailing
  // carriage return and newline!") -- omitting it would make even this
  // genuine signature fail to verify.
  const PAYLOAD =
    JSON.stringify([
      {
        email: "hello@world.com",
        event: "dropped",
        reason: "Bounced Address",
        sg_event_id: "ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA",
        sg_message_id: "LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0",
        "smtp-id": "<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>",
        timestamp: 1600112492,
      },
    ]) + "\r\n";

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // Deliberately NOT `.obliterate()` (10-11, SEC-07 deviation): this file
    // is no longer the only apps/api test file enqueueing real jobs onto
    // the shared webhookEventsQueue -- webhook-timestamp-window.test.ts does
    // too, and vitest runs test files concurrently by default, so
    // obliterating the ENTIRE queue here could wipe a sibling file's
    // in-flight jobs mid-assertion. This file's own assertions are already
    // workspace-scoped (unique per test) and never depend on the queue
    // being empty. CI starts Redis fresh per run (docker compose), so the
    // only cost is jobs accumulating in a long-lived LOCAL dev Redis across
    // repeated manual test runs.
    await webhookEventsQueue.close();
  });

  afterEach(() => {
    // Safety net for the fake-Date test below (10-11, SEC-07) -- restores
    // real time even if an assertion throws before its own finally runs.
    vi.useRealTimers();
  });

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

  /** Provisions a workspace_webhook_endpoints row directly -- SendGrid auto-provisioning (D-01/D-02) is out of this plan's scope. */
  async function provisionEndpoint(workspaceId: string, pathToken: string, publicKey: string | null) {
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

  it("valid signature -> 200 and exactly one job enqueued", async () => {
    const workspace = await freshWorkspace("wh-valid");
    const pathToken = `tok-valid-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    // 10-11 (SEC-07): SendGrid's own published fixture's TIMESTAMP
    // ("1600112502", 2020-09-14) is now genuinely stale relative to real
    // wall-clock time -- freeze `Date` to that exact instant so this
    // pinned fixture stays inside the freshness window without touching
    // its signed bytes (the signature is computed over `timestamp +
    // payload`; re-timestamping would invalidate it). Only `Date` is
    // faked, never timers -- ioredis/BullMQ/pg are unaffected.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(TIMESTAMP) * 1000);
    let res;
    try {
      res = await app.inject({
        method: "POST",
        url: `/webhooks/sendgrid/${pathToken}`,
        headers: {
          "content-type": "application/json",
          "x-twilio-email-event-webhook-signature": SIGNATURE,
          "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
        },
        payload: PAYLOAD,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(res.statusCode, `valid signature request failed: ${res.body}`).toBe(200);

    // Scoped by workspaceId (unique per test), not a global before/after
    // getJobCounts() delta -- 10-11 (SEC-07) added a second apps/api test
    // file that also enqueues real jobs onto this same shared
    // webhookEventsQueue, and vitest runs test files concurrently by
    // default, so two files racing the queue's TOTAL depth produced a
    // genuine cross-file flake (mirrors apps/worker/vitest.config.ts's
    // documented "steals sibling files' jobs mid-assertion" class of bug).
    // No worker runs in this test process, so an enqueued job stays
    // "waiting" and is directly countable.
    const waitingJobs = await webhookEventsQueue.getJobs(["waiting"]);
    const forThisWorkspace = waitingJobs.filter(
      (job) => (job.data as { workspaceId?: string }).workspaceId === workspace.id
    );
    expect(forThisWorkspace.length).toBe(1);
  });

  it("tampered signature -> 400, and no job is enqueued (fail-closed, no JSON.parse reached)", async () => {
    const workspace = await freshWorkspace("wh-tampered");
    const pathToken = `tok-tampered-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    const before = await webhookEventsQueue.getJobCounts("waiting");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/sendgrid/${pathToken}`,
      headers: {
        "content-type": "application/json",
        // Same genuine signature, but the body below is now tampered
        // (different bytes than what the signature was computed over) --
        // this is what a real MITM/forgery attempt would produce.
        "x-twilio-email-event-webhook-signature": SIGNATURE,
        "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
      },
      payload: PAYLOAD.replace("hello@world.com", "attacker@evil.com"),
    });

    expect(res.statusCode).toBe(400);

    const after = await webhookEventsQueue.getJobCounts("waiting");
    expect(after.waiting).toBe(before.waiting ?? 0);
  });

  it("missing signature header -> 400, and no job is enqueued", async () => {
    const workspace = await freshWorkspace("wh-missing-sig");
    const pathToken = `tok-missing-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    const before = await webhookEventsQueue.getJobCounts("waiting");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/sendgrid/${pathToken}`,
      headers: {
        "content-type": "application/json",
        "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
      },
      payload: PAYLOAD,
    });

    expect(res.statusCode).toBe(400);

    const after = await webhookEventsQueue.getJobCounts("waiting");
    expect(after.waiting).toBe(before.waiting ?? 0);
  });

  it("unknown pathToken -> generic 404, no signature attempted, no job enqueued", async () => {
    const before = await webhookEventsQueue.getJobCounts("waiting");

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/sendgrid/unknown-${randomUUID()}`,
      headers: {
        "content-type": "application/json",
        "x-twilio-email-event-webhook-signature": SIGNATURE,
        "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
      },
      payload: PAYLOAD,
    });

    expect(res.statusCode).toBe(404);

    const after = await webhookEventsQueue.getJobCounts("waiting");
    expect(after.waiting).toBe(before.waiting ?? 0);
  });

  it("provisioned endpoint with no public_key yet -> generic 404 (same shape as unknown token)", async () => {
    const workspace = await freshWorkspace("wh-no-key");
    const pathToken = `tok-no-key-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, null);

    const res = await app.inject({
      method: "POST",
      url: `/webhooks/sendgrid/${pathToken}`,
      headers: {
        "content-type": "application/json",
        "x-twilio-email-event-webhook-signature": SIGNATURE,
        "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
      },
      payload: PAYLOAD,
    });

    expect(res.statusCode).toBe(404);
  });

  // ---------------------------------------------------------------------
  // Phase 10 plan 10-07 (SEC-03/SEC-04): findWebhookEndpointByToken runs
  // through withPreTenantLookup under migration 0044's fail-closed
  // workspace_isolation predicate. The HTTP-level tests above already
  // exercise this indirectly (valid token -> 200, unknown token -> 404);
  // these two assert the repository function's own return contract
  // directly.
  // ---------------------------------------------------------------------

  it("findWebhookEndpointByToken: returns the matching endpoint for a valid path token after migration 0044", async () => {
    const workspace = await freshWorkspace("wh-repo-lookup");
    const pathToken = `tok-repo-lookup-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    const row = await findWebhookEndpointByToken(pathToken);
    expect(row).not.toBeNull();
    expect(row?.workspaceId).toBe(workspace.id);
    expect(row?.publicKey).toBe(PUBLIC_KEY);
  });

  it("findWebhookEndpointByToken: returns null for an unknown token", async () => {
    await expect(findWebhookEndpointByToken(`unknown-repo-${randomUUID()}`)).resolves.toBeNull();
  });
});
