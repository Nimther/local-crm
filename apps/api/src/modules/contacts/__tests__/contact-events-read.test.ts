import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * Contact-card live event feed read route (D-14/EVNT-01, 02-08): GET
 * /api/workspaces/:slug/contacts/:id/events returns events newest-first,
 * scoped to the caller's workspace -- seeds a contact + a few events
 * directly via a raw `events` insert (mirroring events-ingest-idempotency
 * .test.ts's precedent of writing straight to the table rather than
 * round-tripping through the BullMQ queue) and drives the HTTP route via
 * Fastify's `.inject()`.
 */
describe("Contact event feed read route (D-14/EVNT-01)", () => {
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
    return res.json() as { id: string; slug: string; name: string };
  }

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  async function createContact(cookie: string, slug: string, externalId: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload: { externalId },
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json() as { id: string };
  }

  /** Seeds one event row directly -- same table the events:ingest worker writes to (0007_events_partitioned.sql). */
  async function seedEvent(
    workspaceId: string,
    contactId: string,
    name: string,
    properties: Record<string, unknown>,
    occurredAt: Date
  ) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [randomUUID(), workspaceId, contactId, name, properties, occurredAt]
        )
      )
    );
  }

  it("returns the contact's events newest-first, workspace-scoped", async () => {
    const { cookie, workspace } = await owner("events-feed");
    const contact = await createContact(cookie, workspace.slug, `events-feed-${Date.now()}`);

    const now = Date.now();
    await seedEvent(workspace.id, contact.id, "signed_up", { plan: "free" }, new Date(now - 60_000));
    await seedEvent(workspace.id, contact.id, "order_placed", { total: 42 }, new Date(now));

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/events`,
      headers: { cookie },
    });
    expect(res.statusCode, `read failed: ${res.body}`).toBe(200);

    const events = res.json() as Array<{ id: string; name: string; properties: Record<string, unknown>; occurredAt: string }>;
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("order_placed"); // newest first
    expect(events[1].name).toBe("signed_up");
    expect(events[0].properties).toEqual({ total: 42 });
  });

  it("returns an empty feed for a contact with no events yet", async () => {
    const { cookie, workspace } = await owner("events-feed-empty");
    const contact = await createContact(cookie, workspace.slug, `events-empty-${Date.now()}`);

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/events`,
      headers: { cookie },
    });
    expect(res.statusCode, `read failed: ${res.body}`).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("T-02-08-01: workspace B cannot read workspace A's contact events", async () => {
    const { cookie: cookieA, workspace: workspaceA } = await owner("events-isolation-a");
    const { workspace: workspaceB } = await owner("events-isolation-b");
    const contact = await createContact(cookieA, workspaceA.slug, `events-isolation-${Date.now()}`);
    await seedEvent(workspaceA.id, contact.id, "signed_up", {}, new Date());

    const crossRes = await app.inject({
      method: "GET",
      // Cross-tenant read attempted via workspace B's slug -- the workspace-B
      // member session never exists here, so this must 404 like every other
      // contact route's non-enumeration guard (T-02-01-04 precedent).
      url: `/api/workspaces/${workspaceB.slug}/contacts/${contact.id}/events`,
      headers: { cookie: cookieA },
    });
    expect(crossRes.statusCode).toBe(404);
  });
});
