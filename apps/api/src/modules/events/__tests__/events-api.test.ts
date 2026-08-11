import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { eventsIngestQueue } from "../events-queue.js";
import type { Pool } from "pg";

/**
 * POST /v1/events (EVNT-01/EVNT-03, D-24): API-key-authed, fast-2xx event
 * ingestion. This is the SYNCHRONOUS half of the contract only -- the route
 * must authenticate, shape-validate the envelope, and enqueue, never
 * perform the contact upsert/event write inline (proven below by reading
 * the DB immediately after the 202 and finding nothing yet, since no worker
 * is running in this test process to drain the queue).
 */
describe("Event ingestion API (EVNT-01/EVNT-03, D-24)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
    pool = createTestPool();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    await eventsIngestQueue.obliterate({ force: true }).catch(() => undefined);
    await eventsIngestQueue.close();
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

  async function mintApiKey(cookie: string, slug: string, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/api-keys`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create api key failed: ${res.body}`).toBe(200);
    return (res.json<{ fullKey: string }>()).fullKey;
  }

  async function ownerWithKey(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    const fullKey = await mintApiKey(account.cookie, workspace.slug, "prod backend");
    return { ...account, workspace, fullKey };
  }

  it("missing Authorization header -> 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { name: "order_placed", externalId: "cust-1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("invalid API key -> 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: {
        authorization: "Bearer mcrm_0000000000000000.invalidsecretvaluexxxxxxxxxxxxxxxxxxxxxxxxx",
      },
      payload: { name: "order_placed", externalId: "cust-1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("valid key: single event -> 202 with a per-item accepted status, and the contact/event are NOT written synchronously", async () => {
    const { fullKey, workspace } = await ownerWithKey("v1-events-single");
    const externalId = `single-${Date.now()}`;

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: { name: "order_placed", externalId, properties: { orderId: "o-1", total: 42.5 } },
    });

    expect(res.statusCode, `POST /v1/events failed: ${res.body}`).toBe(202);
    const body = res.json<{ results: Array<{ eventId: string; status: string }> }>();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe("accepted");
    expect(body.results[0].eventId).toBeTruthy();

    // Fast-path proof (EVNT-03/D-24 Anti-Pattern): nothing processes this
    // queued job in this test process (no worker is running here), so an
    // immediate DB read must find NO contact yet.
    //
    // Phase 10 (SEC-03/SEC-04, migration 0044): `workspace_isolation` is now
    // fail-closed -- the bare, tenant-scope-free `pool.query` this used to
    // be would THROW rather than silently return zero rows. Reading through
    // `withTenant`/`withTenantTransaction` makes "no contact exists in THIS
    // workspace" a genuine, tenant-scoped assertion instead of one that
    // happened to also work by accident under the old fail-open predicate.
    const rowCount = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT 1 FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
          [workspace.id, externalId],
        );
        return rows.length;
      }),
    );
    expect(rowCount).toBe(0);
  });

  it("valid key: batch of events -> 202 with one result per item", async () => {
    const { fullKey } = await ownerWithKey("v1-events-batch");

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: [
        { name: "page_viewed", externalId: "batch-cust-1", properties: { path: "/pricing" } },
        { name: "signed_up", email: "batch2@example.com", properties: {} },
        { name: "order_placed", externalId: "batch-cust-3", properties: { total: 10 } },
      ],
    });

    expect(res.statusCode, `batch POST /v1/events failed: ${res.body}`).toBe(202);
    const body = res.json<{ results: Array<{ eventId: string; status: string }> }>();
    expect(body.results).toHaveLength(3);
    for (const item of body.results) {
      expect(item.status).toBe("accepted");
      expect(item.eventId).toBeTruthy();
    }
  });

  it("D-24: a batch of more than 1000 events is rejected", async () => {
    const { fullKey } = await ownerWithKey("v1-events-overflow");
    const items = Array.from({ length: 1001 }, (_, i) => ({
      name: "stress_event",
      externalId: `overflow-${i}`,
    }));

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: items,
    });

    expect([400, 422]).toContain(res.statusCode);
  });

  it("envelope validation: missing/blank name is rejected per-item, without failing the whole batch", async () => {
    const { fullKey } = await ownerWithKey("v1-events-envelope");

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: [
        { name: "valid_event", externalId: "envelope-valid-1" },
        { name: "", externalId: "envelope-blank-name" },
      ],
    });

    expect(res.statusCode, `POST /v1/events failed: ${res.body}`).toBe(202);
    const body = res.json<{ results: Array<{ status: string }> }>();
    expect(body.results).toHaveLength(2);
    expect(body.results[0].status).toBe("accepted");
    expect(body.results[1].status).toBe("rejected");
  });

  it("envelope validation: non-object properties is rejected", async () => {
    const { fullKey } = await ownerWithKey("v1-events-badprops");

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${fullKey}` },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: { name: "bad_properties", externalId: "bad-props-1", properties: "not-an-object" as any },
    });

    expect(res.statusCode, `POST /v1/events failed: ${res.body}`).toBe(202);
    const body = res.json<{ results: Array<{ status: string }> }>();
    expect(body.results[0].status).toBe("rejected");
  });

  it("CR-01: two workspaces posting the SAME client-supplied eventId both get their own BullMQ job (no cross-tenant jobId collision)", async () => {
    const [a, b] = await Promise.all([ownerWithKey("v1-events-tenant-a"), ownerWithKey("v1-events-tenant-b")]);
    const sharedEventId = randomUUID();

    const [resA, resB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${a.fullKey}` },
        payload: { name: "order_placed", externalId: "cr01-cust-a", eventId: sharedEventId },
      }),
      app.inject({
        method: "POST",
        url: "/v1/events",
        headers: { authorization: `Bearer ${b.fullKey}` },
        payload: { name: "order_placed", externalId: "cr01-cust-b", eventId: sharedEventId },
      }),
    ]);

    expect(resA.statusCode, `workspace A POST failed: ${resA.body}`).toBe(202);
    expect(resB.statusCode, `workspace B POST failed: ${resB.body}`).toBe(202);

    // Against pre-fix code (jobId = raw eventId), only ONE global job exists
    // for this eventId -- these workspace-scoped lookups are the assertion
    // that closes CR-01 at the BullMQ layer. Separator is "-" not ":" --
    // BullMQ rejects a Custom Id containing a colon.
    const [jobA, jobB] = await Promise.all([
      eventsIngestQueue.getJob(`${a.workspace.id}-${sharedEventId}`),
      eventsIngestQueue.getJob(`${b.workspace.id}-${sharedEventId}`),
    ]);
    expect(jobA, "workspace A's job must exist under its own workspace-scoped jobId").toBeTruthy();
    expect(jobB, "workspace B's job must exist under its own workspace-scoped jobId").toBeTruthy();
  });

  it("WR-01: eventsIngestQueue is configured with retry (attempts > 1, backoff) so a transient failure doesn't drop an accepted job", () => {
    expect(eventsIngestQueue.defaultJobOptions?.attempts).toBeTypeOf("number");
    expect(eventsIngestQueue.defaultJobOptions?.attempts as number).toBeGreaterThan(1);
    expect(eventsIngestQueue.defaultJobOptions?.backoff).toBeTruthy();
  });

  it("freeform: arbitrary nested properties are accepted without schema enforcement", async () => {
    const { fullKey } = await ownerWithKey("v1-events-freeform");

    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: {
        name: "cart_updated",
        externalId: "freeform-1",
        properties: {
          items: [{ sku: "abc", qty: 2, meta: { color: "red", nested: { deep: true } } }],
          arbitraryTopLevelKey: "anything goes",
        },
      },
    });

    expect(res.statusCode, `POST /v1/events failed: ${res.body}`).toBe(202);
    const body = res.json<{ results: Array<{ status: string }> }>();
    expect(body.results[0].status).toBe("accepted");
  });
});
