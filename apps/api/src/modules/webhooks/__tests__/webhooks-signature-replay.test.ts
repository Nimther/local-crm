import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { webhookEventsQueue } from "../enqueue.js";
import fixture from "./fixtures/uat-signed-payload.json" with { type: "json" };

const rawBody = Buffer.from(fixture.rawBodyBase64, "base64");
const parsedBody: unknown = JSON.parse(rawBody.toString("utf8"));
const capturedEvents = Array.isArray(parsedBody) ? parsedBody : [];

interface CapturedDedupKey {
  sendId: string;
  eventType: string;
  occurredAt: string;
}

function readCapturedDedupKey(): CapturedDedupKey {
  const first = capturedEvents[0];
  if (typeof first !== "object" || first === null) {
    throw new Error("live signed fixture must contain at least one event object");
  }

  const event = first as Record<string, unknown>;
  if (
    typeof event.send_id !== "string" ||
    typeof event.event !== "string" ||
    typeof event.timestamp !== "number"
  ) {
    throw new Error("live signed fixture event is missing its dedup-key fields");
  }

  return {
    sendId: event.send_id,
    eventType: event.event,
    occurredAt: new Date(event.timestamp * 1000).toISOString(),
  };
}

const capturedDedupKey = readCapturedDedupKey();

// A valid but unrelated ECDSA public key from SendGrid's published fixture.
// The wrong-key case must exercise signature discrimination, not malformed-
// key exception handling.
const WRONG_PUBLIC_KEY =
  "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==";

// Kept as a dynamic, test-only cross-workspace import so apps/api's build
// does not pull apps/worker source under its rootDir. At runtime Vitest loads
// the exact production processor rather than a test-local approximation.
const WEBHOOK_PROCESSOR_MODULE_PATH = new URL(
  "../../../../../worker/src/queues/webhook-events.worker.ts",
  import.meta.url
).href;

interface WebhookProcessorModule {
  processWebhookEventBatch: (data: unknown) => Promise<{ inserted: number }>;
}

/**
 * Phase 16 (UAT-03/UAT-04): this import is deliberately unconditional.
 * The captured SendGrid signature is a permanent CI input; deleting or
 * corrupting it must turn this suite red rather than silently skipping the
 * only real-account signature evidence in the repository.
 */
describe("real SendGrid signed replay fixture integrity", () => {
  it("contains exactly the four non-empty capture fields", () => {
    expect(Object.keys(fixture).sort()).toEqual(
      ["publicKey", "rawBodyBase64", "signature", "timestamp"].sort()
    );

    for (const key of ["rawBodyBase64", "signature", "timestamp", "publicKey"] as const) {
      expect(fixture[key], `${key} must be a non-empty string`).toEqual(expect.any(String));
      expect(fixture[key].length, `${key} must not be empty`).toBeGreaterThan(0);
    }
  });

  it("decodes the raw body as canonical base64", () => {
    const decoded = Buffer.from(fixture.rawBodyBase64, "base64");

    expect(decoded.length).toBeGreaterThan(0);
    expect(decoded.toString("base64")).toBe(fixture.rawBodyBase64);
  });

  it("contains a JSON array of webhook events", () => {
    const decoded = Buffer.from(fixture.rawBodyBase64, "base64");
    const parsed: unknown = JSON.parse(decoded.toString("utf8"));

    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBeGreaterThan(0);
  });

  it("carries the signed timestamp as a numeric string", () => {
    expect(fixture.timestamp).toMatch(/^\d+$/);
  });
});

/**
 * Phase 16 (D-10/D-11/D-12): unlike the published-example analog in
 * webhooks-signature.test.ts, these requests use bytes captured from this
 * deployment's real SendGrid account. They still drive the complete Fastify
 * request stack through app.inject; no signature helper is called directly.
 */
describe("POST /webhooks/sendgrid/:pathToken real signed replay", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

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

  afterEach(() => {
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

  /** Provisions a workspace_webhook_endpoints row directly -- SendGrid auto-provisioning is outside this regression test. */
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
    return createWorkspace(account.cookie, `${nameSeed} Co`);
  }

  async function seedCapturedSend(workspaceId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, `captured-${randomUUID()}@fixture.test`]
        );
        const contact = rows[0];
        if (!contact) throw new Error("fixture contact insert returned no row");

        // The signed body's send_id cannot be rewritten. Seed that exact id
        // in the fresh tenant so the production worker retains it instead of
        // correctly nulling an orphan id, which would make PostgreSQL NULL
        // uniqueness semantics unable to prove migration 0057's dedup key.
        await client.query(
          `INSERT INTO sends (id, workspace_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', 'sent', $4::timestamptz)`,
          [capturedDedupKey.sendId, workspaceId, contact.id, capturedDedupKey.occurredAt]
        );
      })
    );
  }

  async function postCaptured(pathToken: string, body: Buffer = rawBody) {
    // Frozen-clock choice (RESEARCH.md Pitfall 1): hold only Date at the
    // fixture's own signed timestamp, tightly around this request. We do NOT
    // override WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: widening that value would
    // weaken the freshness gate this regression test is meant to keep armed.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(fixture.timestamp) * 1000);
    try {
      return await app.inject({
        method: "POST",
        url: `/webhooks/sendgrid/${pathToken}`,
        headers: {
          "content-type": "application/json",
          "x-twilio-email-event-webhook-signature": fixture.signature,
          "x-twilio-email-event-webhook-timestamp": fixture.timestamp,
        },
        payload: body,
      });
    } finally {
      vi.useRealTimers();
    }
  }

  async function countIngressJournal(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ingress_journal WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0]?.count ?? 0);
      })
    );
  }

  async function countCapturedSendEvents(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM send_events
            WHERE workspace_id = $1
              AND send_id = $2
              AND event_type = $3
              AND occurred_at = $4::timestamptz`,
          [workspaceId, capturedDedupKey.sendId, capturedDedupKey.eventType, capturedDedupKey.occurredAt]
        );
        return Number(rows[0]?.count ?? 0);
      })
    );
  }

  async function processQueuedBatches(workspaceId: string): Promise<number[]> {
    const loaded: unknown = await import(WEBHOOK_PROCESSOR_MODULE_PATH);
    const { processWebhookEventBatch } = loaded as WebhookProcessorModule;
    if (typeof processWebhookEventBatch !== "function") {
      throw new Error("production webhook processor module did not export processWebhookEventBatch");
    }

    const waitingJobs = await webhookEventsQueue.getJobs(["waiting"]);
    const workspaceJobs = waitingJobs.filter(
      (job) => (job.data as { workspaceId?: string }).workspaceId === workspaceId
    );
    expect(workspaceJobs).toHaveLength(2);

    // The worker independently applies classifyOccurredAt's seven-day event
    // bound. Freeze Date for processing too, without changing the route's
    // freshness tolerance or any signed byte, so this permanent fixture does
    // not decay into an out-of-window quarantine years from now.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(fixture.timestamp) * 1000);
    try {
      const inserted: number[] = [];
      for (const job of workspaceJobs) {
        const result = await processWebhookEventBatch(job.data);
        inserted.push(result.inserted);
      }
      return inserted;
    } finally {
      vi.useRealTimers();
    }
  }

  function enqueueCallsForWorkspace(
    calls: ReadonlyArray<readonly [string, { workspaceId?: string }, ...unknown[]]>,
    workspaceId: string
  ): number {
    return calls.filter(([, data]) => data.workspaceId === workspaceId).length;
  }

  it("accepts the byte-exact real payload with the captured public key", async () => {
    const workspace = await freshWorkspace("wh-live-accept");
    const pathToken = `tok-live-accept-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, fixture.publicKey);

    const response = await postCaptured(pathToken);

    expect(response.statusCode, response.body).toBe(200);
    expect(await countIngressJournal(workspace.id)).toBe(1);
  });

  it("rejects an exact one-byte mutation and ingests nothing", async () => {
    const workspace = await freshWorkspace("wh-live-mutated");
    const pathToken = `tok-live-mutated-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, fixture.publicKey);
    const addSpy = vi.spyOn(webhookEventsQueue, "add");

    const mutated = Buffer.from(rawBody);
    const mutationIndex = Math.floor(mutated.length / 2);
    mutated[mutationIndex] = (mutated[mutationIndex] ?? 0) ^ 1;
    const changedBytes = rawBody.reduce(
      (count, byte, index) => count + (byte === mutated[index] ? 0 : 1),
      0
    );

    try {
      const response = await postCaptured(pathToken, mutated);

      expect(changedBytes).toBe(1);
      expect(response.statusCode).toBe(400);
      expect(enqueueCallsForWorkspace(addSpy.mock.calls, workspace.id)).toBe(0);
      expect(await countIngressJournal(workspace.id)).toBe(0);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("enqueues two identical deliveries but retains one exact send_events dedup row", async () => {
    const workspace = await freshWorkspace("wh-live-dedup");
    const pathToken = `tok-live-dedup-${randomUUID()}`;
    await seedCapturedSend(workspace.id);
    await provisionEndpoint(workspace.id, pathToken, fixture.publicKey);
    const addSpy = vi.spyOn(webhookEventsQueue, "add");

    try {
      const first = await postCaptured(pathToken);
      const second = await postCaptured(pathToken);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(enqueueCallsForWorkspace(addSpy.mock.calls, workspace.id)).toBe(2);
      expect(await countIngressJournal(workspace.id)).toBe(2);

      const inserted = await processQueuedBatches(workspace.id);
      expect(inserted.sort()).toEqual([0, 1]);
      expect(await countCapturedSendEvents(workspace.id)).toBe(1);
    } finally {
      addSpy.mockRestore();
    }
  });

  it("rejects the real payload when the endpoint stores a different valid public key", async () => {
    expect(WRONG_PUBLIC_KEY).not.toBe(fixture.publicKey);
    const workspace = await freshWorkspace("wh-live-wrong-key");
    const pathToken = `tok-live-wrong-key-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, WRONG_PUBLIC_KEY);

    const response = await postCaptured(pathToken);

    expect(response.statusCode).toBe(400);
    expect(await countIngressJournal(workspace.id)).toBe(0);
  });
});
