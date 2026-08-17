import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { webhookEventsQueue } from "../enqueue.js";
import { logger } from "../../../logger.js";
import { WEBHOOK_RAW_CAPTURE_LOG_MARKER } from "../webhooks.routes.js";

/**
 * Phase 16 (D-09): `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` -- the seam that makes
 * UAT-03's byte-exact replay physically possible (`ingress_journal` stores
 * re-serialised parsed events, RESEARCH.md Pattern 3, so it cannot be the
 * replay source). Reuses `webhooks-signature.test.ts`'s exact `app.inject`
 * pattern and SendGrid's own published real-signature fixture verbatim --
 * never a hand-built signature string (RESEARCH.md Pitfall 1).
 *
 * `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` is read directly from `process.env` at
 * request time (NOT through `apps/api/src/env.ts`'s frozen zod-parsed
 * schema, which is evaluated once at boot) -- this is the placement decision
 * recorded in 16-03-SUMMARY.md: a UAT-session-scoped toggle needs to be
 * flippable per-request within a single running process (both for this
 * test file, which never rebuilds the server, and for the real UAT session,
 * which starts the capture without a redeploy).
 */
describe("POST /webhooks/sendgrid/:pathToken raw capture (Phase 16, D-09)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  const PUBLIC_KEY =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";
  const SIGNATURE =
    "MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=";
  const TIMESTAMP = "1600112502";
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
    await webhookEventsQueue.close();
  });

  beforeEach(() => {
    infoSpy = vi.spyOn(logger, "info");
  });

  afterEach(() => {
    vi.useRealTimers();
    infoSpy.mockRestore();
    delete process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID;
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

  async function postVerifiedDelivery(pathToken: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(TIMESTAMP) * 1000);
    try {
      return await app.inject({
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
  }

  function captureLogCalls() {
    return infoSpy.mock.calls.filter(([, msg]: unknown[]) => typeof msg === "string" && msg.includes(WEBHOOK_RAW_CAPTURE_LOG_MARKER));
  }

  it("with the capture variable unset, a verified delivery produces no capture log line and a normal 200", async () => {
    const workspace = await freshWorkspace("wh-cap-unset");
    const pathToken = `tok-cap-unset-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    delete process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID;
    const res = await postVerifiedDelivery(pathToken);

    expect(res.statusCode).toBe(200);
    expect(captureLogCalls().length).toBe(0);
  });

  it("with the capture variable set to a DIFFERENT workspace's id, a verified delivery for this workspace produces no capture log line", async () => {
    const workspace = await freshWorkspace("wh-cap-other");
    const pathToken = `tok-cap-other-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID = randomUUID();
    const res = await postVerifiedDelivery(pathToken);

    expect(res.statusCode).toBe(200);
    expect(captureLogCalls().length).toBe(0);
  });

  it("with the capture variable set to THIS workspace's id, a verified delivery produces exactly one capture log line carrying the base64 raw body and both signature header values", async () => {
    const workspace = await freshWorkspace("wh-cap-match");
    const pathToken = `tok-cap-match-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID = workspace.id;
    const res = await postVerifiedDelivery(pathToken);

    expect(res.statusCode).toBe(200);
    const calls = captureLogCalls();
    expect(calls.length).toBe(1);
    const [fields] = calls[0] as [Record<string, unknown>, string];
    expect(fields.rawBodyBase64).toBe(Buffer.from(PAYLOAD, "utf8").toString("base64"));
    expect(fields.signatureHeaderValue).toBe(SIGNATURE);
    expect(fields.timestampHeaderValue).toBe(TIMESTAMP);

    // Byte-identity: the base64 payload decodes to bytes identical to the
    // request body as sent (UAT-03's replay requirement).
    const decoded = Buffer.from(fields.rawBodyBase64 as string, "base64");
    expect(decoded.equals(Buffer.from(PAYLOAD, "utf8"))).toBe(true);
  });

  it("an empty-string capture variable is treated as absent -- no capture line even for this workspace", async () => {
    const workspace = await freshWorkspace("wh-cap-empty");
    const pathToken = `tok-cap-empty-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID = "";
    const res = await postVerifiedDelivery(pathToken);

    expect(res.statusCode).toBe(200);
    expect(captureLogCalls().length).toBe(0);
  });

  it("a request failing signature verification produces no capture log line, even when the capture workspace matches", async () => {
    const workspace = await freshWorkspace("wh-cap-badsig");
    const pathToken = `tok-cap-badsig-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);
    process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID = workspace.id;

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
        payload: PAYLOAD.replace("hello@world.com", "attacker@evil.com"),
      });
    } finally {
      vi.useRealTimers();
    }

    expect(res.statusCode).toBe(400);
    expect(captureLogCalls().length).toBe(0);
  });

  it("a request failing the timestamp freshness check produces no capture log line, even when the capture workspace matches", async () => {
    const workspace = await freshWorkspace("wh-cap-stale");
    const pathToken = `tok-cap-stale-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);
    process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID = workspace.id;

    // Real wall-clock "now" is far outside the fixture's tolerance window --
    // no fake timers here, so the timestamp is genuinely stale.
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

    expect(res.statusCode).toBe(400);
    expect(captureLogCalls().length).toBe(0);
  });

  it("a request for an unknown path token produces no capture log line", async () => {
    process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID = randomUUID();

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
    expect(captureLogCalls().length).toBe(0);
  });

  it("the response status and body are identical for a capture-active workspace and a capture-inactive workspace, on both the accepted and rejected paths", async () => {
    const activeWs = await freshWorkspace("wh-cap-parity-active");
    const inactiveWs = await freshWorkspace("wh-cap-parity-inactive");
    const activeToken = `tok-cap-parity-active-${randomUUID()}`;
    const inactiveToken = `tok-cap-parity-inactive-${randomUUID()}`;
    await provisionEndpoint(activeWs.id, activeToken, PUBLIC_KEY);
    await provisionEndpoint(inactiveWs.id, inactiveToken, PUBLIC_KEY);

    // Accepted path.
    process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID = activeWs.id;
    const activeAccepted = await postVerifiedDelivery(activeToken);
    delete process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID;
    const inactiveAccepted = await postVerifiedDelivery(inactiveToken);
    expect(activeAccepted.statusCode).toBe(inactiveAccepted.statusCode);
    expect(activeAccepted.body).toBe(inactiveAccepted.body);

    // Rejected path (tampered signature -> 400).
    process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID = activeWs.id;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(TIMESTAMP) * 1000);
    let activeRejected;
    let inactiveRejected;
    try {
      activeRejected = await app.inject({
        method: "POST",
        url: `/webhooks/sendgrid/${activeToken}`,
        headers: {
          "content-type": "application/json",
          "x-twilio-email-event-webhook-signature": SIGNATURE,
          "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
        },
        payload: PAYLOAD.replace("hello@world.com", "attacker@evil.com"),
      });
      delete process.env.WEBHOOK_RAW_CAPTURE_WORKSPACE_ID;
      inactiveRejected = await app.inject({
        method: "POST",
        url: `/webhooks/sendgrid/${inactiveToken}`,
        headers: {
          "content-type": "application/json",
          "x-twilio-email-event-webhook-signature": SIGNATURE,
          "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
        },
        payload: PAYLOAD.replace("hello@world.com", "attacker@evil.com"),
      });
    } finally {
      vi.useRealTimers();
    }
    expect(activeRejected.statusCode).toBe(inactiveRejected.statusCode);
    expect(activeRejected.body).toBe(inactiveRejected.body);
  });
});
