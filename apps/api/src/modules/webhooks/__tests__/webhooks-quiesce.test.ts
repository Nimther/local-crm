import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { webhookEventsQueue } from "../enqueue.js";

/**
 * Phase 22 (PRG-06, D-04): the anonymous SendGrid webhook surface must drop a
 * soft-deleted workspace's inbound batch INDISTINGUISHABLY from an unknown
 * pathToken (T-05-03's existing no-enumeration discipline) -- same status,
 * same headers, same body, asserted against the sibling unknown-token
 * response rather than a literal. Reuses SendGrid's own published example
 * signed payload (verbatim from webhooks-signature.test.ts's precedent),
 * a REAL ECDSA signature over REAL bytes.
 */
describe("POST /webhooks/sendgrid/:pathToken drops a soft-deleted workspace (PRG-06, D-04)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

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
    // Deliberately NOT `.obliterate()` -- mirrors webhooks-signature.test.ts's
    // own rationale (this queue is shared with sibling test files running
    // concurrently under vitest).
    await webhookEventsQueue.close();
  });

  afterEach(() => {
    // Safety net for the frozen-time requests below -- restores real time
    // even if an assertion throws before its own finally runs (mirrors
    // webhooks-signature.test.ts).
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

  /** D-20's real Owner-only soft-delete route -- the exact codepath production uses to set `deletedAt`. */
  async function softDeleteWorkspace(cookie: string, slug: string, name: string): Promise<void> {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${slug}`,
      headers: { cookie },
      payload: { confirmName: name },
    });
    expect(res.statusCode, `soft-delete workspace failed: ${res.body}`).toBe(200);
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

  async function countIngressJournalRows(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM ingress_journal WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function countQuarantineRows(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM send_event_quarantine WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function deletedWorkspaceWithEndpoint(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const name = `${nameSeed} Co`;
    const workspace = await createWorkspace(account.cookie, name);
    const pathToken = `tok-${nameSeed}-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);
    await softDeleteWorkspace(account.cookie, workspace.slug, name);
    return { workspace, pathToken };
  }

  async function postSigned(pathToken: string, signature: string | undefined, payload: string) {
    return app.inject({
      method: "POST",
      url: `/webhooks/sendgrid/${pathToken}`,
      headers: {
        "content-type": "application/json",
        ...(signature !== undefined ? { "x-twilio-email-event-webhook-signature": signature } : {}),
        "x-twilio-email-event-webhook-timestamp": TIMESTAMP,
      },
      payload,
    });
  }

  it("deleted workspace drops the webhook: response is indistinguishable from an unknown pathToken", async () => {
    const { pathToken } = await deletedWorkspaceWithEndpoint("wh-quiesce-deleted");

    const deletedRes = await postSigned(pathToken, SIGNATURE, PAYLOAD);
    const unknownRes = await postSigned(`unknown-${randomUUID()}`, SIGNATURE, PAYLOAD);

    expect(deletedRes.statusCode).toBe(404);
    expect(deletedRes.statusCode).toBe(unknownRes.statusCode);
    expect(deletedRes.body).toBe(unknownRes.body);
    // Header-of-interest comparison (content-length/content-type), not a
    // byte-exact header dump -- date/connection-level headers legitimately
    // differ between two separate requests.
    expect(deletedRes.headers["content-type"]).toBe(unknownRes.headers["content-type"]);
    expect(deletedRes.headers["content-length"]).toBe(unknownRes.headers["content-length"]);
  });

  it("no journal, no quarantine, and no job enqueued for the deleted workspace's batch", async () => {
    const { workspace, pathToken } = await deletedWorkspaceWithEndpoint("wh-quiesce-nojournal");

    const before = await webhookEventsQueue.getJobCounts("waiting");
    const res = await postSigned(pathToken, SIGNATURE, PAYLOAD);
    expect(res.statusCode).toBe(404);
    const after = await webhookEventsQueue.getJobCounts("waiting");

    expect(after.waiting).toBe(before.waiting ?? 0);
    expect(await countIngressJournalRows(workspace.id)).toBe(0);
    expect(await countQuarantineRows(workspace.id)).toBe(0);
  });

  it("signature verification is not reached: an INVALID signature on the deleted workspace's pathToken still returns the quiesce 404, not the 400 signature-failure response", async () => {
    const { pathToken } = await deletedWorkspaceWithEndpoint("wh-quiesce-badsig");

    const res = await postSigned(pathToken, SIGNATURE, PAYLOAD.replace("hello@world.com", "attacker@evil.com"));

    // Against pre-fix code, a tampered signature on an ACTIVE workspace's
    // endpoint returns 400 (webhooks-signature.test.ts's own "tampered
    // signature" case) -- 404 here proves the quiesce check short-circuited
    // BEFORE verifyWebhookSignature ever ran.
    expect(res.statusCode).toBe(404);
  });

  it("live workspace unchanged: the same signed batch still verifies, journals and enqueues exactly as today", async () => {
    const email = `wh-quiesce-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", "wh-quiesce-live");
    const workspace = await createWorkspace(account.cookie, "wh-quiesce-live Co");
    const pathToken = `tok-live-${randomUUID()}`;
    await provisionEndpoint(workspace.id, pathToken, PUBLIC_KEY);

    // SendGrid's own published fixture's TIMESTAMP is stale relative to real
    // wall-clock time -- freeze `Date` to that exact instant (mirrors
    // webhooks-signature.test.ts's "valid signature" case) so the freshness
    // check passes without touching the signed bytes.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number(TIMESTAMP) * 1000);
    let res;
    try {
      res = await postSigned(pathToken, SIGNATURE, PAYLOAD);
    } finally {
      vi.useRealTimers();
    }

    expect(res.statusCode, `live workspace request failed: ${res.body}`).toBe(200);
    expect(await countIngressJournalRows(workspace.id)).toBe(1);

    const waitingJobs = await webhookEventsQueue.getJobs(["waiting"]);
    const forThisWorkspace = waitingJobs.filter(
      (job) => (job.data as { workspaceId?: string }).workspaceId === workspace.id
    );
    expect(forThisWorkspace.length).toBe(1);
  });
});
