import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 07-02/ANLT-03: the contact-timeline endpoint unions events + sends +
 * subscription_status_history + flow_runs into one { kind, occurredAt,
 * label, detail } shape, newest first, with repeated opens/clicks collapsed
 * via sends.open_count/click_count (D-11) rather than a per-row
 * `send_events` subquery. Also asserts the IDOR double-gate: a contact id
 * that belongs to another workspace 404s (never an empty 200).
 */
describe("Contact timeline (07-02, ANLT-03)", () => {
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

  async function insertEvent(workspaceId: string, contactId: string, name: string, occurredAt: Date) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, '{}'::jsonb, $4)`,
          [workspaceId, contactId, name, occurredAt]
        )
      )
    );
  }

  async function insertSend(
    workspaceId: string,
    contactId: string,
    opts: {
      status?: "dispatching" | "sent" | "failed" | "excluded";
      sentAt?: Date;
      firstOpenedAt?: Date;
      firstClickedAt?: Date;
      openCount?: number;
      clickCount?: number;
      exclusionReason?: string;
    } = {}
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends
             (workspace_id, contact_id, kind, status, sent_at, first_opened_at, first_clicked_at, open_count, click_count, exclusion_reason)
           VALUES ($1, $2, 'campaign', $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            workspaceId,
            contactId,
            opts.status ?? "sent",
            opts.sentAt ?? new Date(),
            opts.firstOpenedAt ?? null,
            opts.firstClickedAt ?? null,
            opts.openCount ?? 0,
            opts.clickCount ?? 0,
            opts.exclusionReason ?? null,
          ]
        );
        return rows[0].id;
      })
    );
  }

  async function insertStatusChange(
    workspaceId: string,
    contactId: string,
    oldStatus: string,
    newStatus: string,
    changedAt: Date
  ) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO subscription_status_history (workspace_id, contact_id, old_status, new_status, source, changed_at)
           VALUES ($1, $2, $3, $4, 'manual_ui', $5)`,
          [workspaceId, contactId, oldStatus, newStatus, changedAt]
        )
      )
    );
  }

  async function timelineUrl(slug: string, contactId: string, query?: string) {
    return `/api/workspaces/${slug}/contacts/${contactId}/timeline${query ? `?${query}` : ""}`;
  }

  it("returns a union of events + sends + status changes, sorted newest-first, with ×N collapse from open_count/click_count", async () => {
    const { cookie, workspace } = await owner("timeline-union");
    const contact = await createContact(cookie, workspace.slug, {
      email: `timeline-union-${Date.now()}@example.com`,
    });

    const t0 = new Date("2026-01-01T00:00:00Z");
    const t1 = new Date("2026-01-02T00:00:00Z");
    const t2 = new Date("2026-01-03T00:00:00Z");

    await insertEvent(workspace.id, contact.id, "purchase", t0);
    await insertSend(workspace.id, contact.id, {
      sentAt: t1,
      firstOpenedAt: t1,
      firstClickedAt: t1,
      openCount: 5,
      clickCount: 3,
    });
    await insertStatusChange(workspace.id, contact.id, "subscribed", "unsubscribed", t2);

    const res = await app.inject({
      method: "GET",
      url: await timelineUrl(workspace.slug, contact.id),
      headers: { cookie },
    });
    expect(res.statusCode, `timeline failed: ${res.body}`).toBe(200);
    const rows = res.json<Array<{ kind: string; occurredAt: string; label: string; detail: Record<string, unknown> }>>();

    expect(rows).toHaveLength(3);
    // Newest first.
    expect(rows.map((r) => r.kind)).toEqual(["status_change", "send", "event"]);

    const sendRow = rows.find((r) => r.kind === "send")!;
    expect(sendRow.detail).toMatchObject({ status: "clicked", openCount: 5, clickCount: 3 });

    const statusRow = rows.find((r) => r.kind === "status_change")!;
    expect(statusRow.detail).toMatchObject({ oldStatus: "subscribed", newStatus: "unsubscribed" });
  });

  it("collapses a bounced send's status via the D-06 priority chain, not opened/clicked facts", async () => {
    const { cookie, workspace } = await owner("timeline-bounced");
    const contact = await createContact(cookie, workspace.slug, {
      email: `timeline-bounced-${Date.now()}@example.com`,
    });

    const sendId = await insertSend(workspace.id, contact.id, { firstOpenedAt: new Date() });
    await withTenant(workspace.id, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE sends SET bounced_at = now(), bounce_reason = 'mailbox_full' WHERE id = $1`, [sendId])
      )
    );

    const res = await app.inject({
      method: "GET",
      url: await timelineUrl(workspace.slug, contact.id),
      headers: { cookie },
    });
    expect(res.statusCode, `timeline failed: ${res.body}`).toBe(200);
    const rows = res.json<Array<{ kind: string; detail: Record<string, unknown> }>>();
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ status: "bounced", reason: "mailbox_full" });
  });

  it("404s for a contact id belonging to another workspace (IDOR double-gate)", async () => {
    const a = await owner("timeline-idor-a");
    const b = await owner("timeline-idor-b");
    const contactInB = await createContact(b.cookie, b.workspace.slug, {
      email: `timeline-idor-${Date.now()}@example.com`,
    });

    const res = await app.inject({
      method: "GET",
      url: await timelineUrl(a.workspace.slug, contactInB.id),
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it("the type filter narrows to a single kind (emails)", async () => {
    const { cookie, workspace } = await owner("timeline-filter");
    const contact = await createContact(cookie, workspace.slug, {
      email: `timeline-filter-${Date.now()}@example.com`,
    });

    await insertEvent(workspace.id, contact.id, "signup", new Date());
    await insertSend(workspace.id, contact.id, {});

    const res = await app.inject({
      method: "GET",
      url: await timelineUrl(workspace.slug, contact.id, "type=emails"),
      headers: { cookie },
    });
    expect(res.statusCode, `timeline failed: ${res.body}`).toBe(200);
    const rows = res.json<Array<{ kind: string }>>();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("send");
  });
});
