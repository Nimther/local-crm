import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 07-05/D-14/T-07-05-02: the send-log drawer's per-message chronology read
 * (send_events, oldest-first) and its IDOR double-gate -- a sendId belonging
 * to another workspace 404s (never an empty 200 array).
 */
describe("Send log drawer (07-05, D-14)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
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

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  async function createContact(cookie: string, slug: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload,
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  async function insertSend(workspaceId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, 'campaign', 'sent', now())
           RETURNING id`,
          [workspaceId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  async function insertSendEvent(
    workspaceId: string,
    sendId: string,
    eventType: string,
    occurredAt: Date,
    payload: Record<string, unknown> = {}
  ) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, reason, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
          [
            workspaceId,
            `sg-${eventType}-${Math.random().toString(36).slice(2, 10)}`,
            sendId,
            eventType,
            (payload.reason as string | undefined) ?? null,
            JSON.stringify(payload),
            occurredAt,
          ]
        )
      )
    );
  }

  it("returns the send's chronology ordered oldest -> newest, exposing click URLs and bounce reasons", async () => {
    const { cookie, workspace } = await owner("drawer-chrono");
    const contact = await createContact(cookie, workspace.slug, { email: `drawer-${Date.now()}@example.com` });
    const sendId = await insertSend(workspace.id, contact.id);

    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-01T01:00:00Z");
    const t2 = new Date("2026-01-01T02:00:00Z");

    await insertSendEvent(workspace.id, sendId, "delivered", t1);
    await insertSendEvent(workspace.id, sendId, "processed", t0);
    await insertSendEvent(workspace.id, sendId, "click", t2, { url: "https://example.com/product" });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/send-log/${sendId}/events`,
      headers: { cookie },
    });
    expect(res.statusCode, `drawer failed: ${res.body}`).toBe(200);
    const rows = res.json<Array<{ eventType: string; occurredAt: string; clickUrl: string | null }>>();

    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.eventType)).toEqual(["processed", "delivered", "click"]);
    expect(rows[2].clickUrl).toBe("https://example.com/product");
    expect(rows[0].clickUrl).toBeNull();
  });

  it("404s a drawer request for a sendId belonging to another workspace (IDOR double-gate)", async () => {
    const a = await owner("drawer-idor-a");
    const b = await owner("drawer-idor-b");
    const contactInB = await createContact(b.cookie, b.workspace.slug, {
      email: `drawer-idor-${Date.now()}@example.com`,
    });
    const sendInB = await insertSend(b.workspace.id, contactInB.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${a.workspace.slug}/send-log/${sendInB}/events`,
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
