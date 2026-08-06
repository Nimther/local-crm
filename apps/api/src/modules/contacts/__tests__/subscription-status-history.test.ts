import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordSubscriptionStatusChange } from "@mega-crm/contacts-core";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";

/**
 * 07-01 (D-09): subscription_status_history write-path coverage. Test A/B
 * exercise the real `manual_ui` call site (updateContact, via the HTTP
 * PATCH route) end-to-end. Test C exercises the `webhook_suppression`
 * source tag's history-write correctness directly at the repository/helper
 * level -- apps/api has no dependency path to apps/worker's process (the
 * webhook worker's actual call site is covered separately by
 * apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts,
 * which asserts the same history row through the real
 * `processWebhookEventBatch` pipeline).
 */
describe("subscription_status_history write path (07-01, D-09)", () => {
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

  function contactsUrl(slug: string, id?: string) {
    return id ? `/api/workspaces/${slug}/contacts/${id}` : `/api/workspaces/${slug}/contacts`;
  }

  async function createContact(cookie: string, slug: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: contactsUrl(slug),
      headers: { cookie },
      payload,
    });
    expect(res.statusCode, `create failed: ${res.body}`).toBe(201);
    return res.json<{ id: string; subscriptionStatus: string; email: string }>();
  }

  interface HistoryRow {
    oldStatus: string | null;
    newStatus: string;
    source: string;
  }

  async function historyRows(workspaceId: string, contactId: string): Promise<HistoryRow[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<HistoryRow>(
          `SELECT old_status as "oldStatus", new_status as "newStatus", source
           FROM subscription_status_history
           WHERE workspace_id = $1 AND contact_id = $2
           ORDER BY changed_at ASC`,
          [workspaceId, contactId]
        );
        return rows;
      })
    );
  }

  it("Test A: flipping subscribed->unsubscribed via updateContact (manual_ui) writes exactly one history row", async () => {
    const { cookie, workspace } = await owner("subhist-manual-flip");
    const contact = await createContact(cookie, workspace.slug, {
      email: `manual-flip-${Date.now()}@example.com`,
    });
    expect(contact.subscriptionStatus).toBe("subscribed");

    const res = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, contact.id),
      headers: { cookie },
      payload: { subscriptionStatus: "unsubscribed" },
    });
    expect(res.statusCode, `update failed: ${res.body}`).toBe(200);

    const rows = await historyRows(workspace.id, contact.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldStatus: "subscribed", newStatus: "unsubscribed", source: "manual_ui" });
  });

  it("Test B: updating a contact to the SAME status it already has writes zero new history rows", async () => {
    const { cookie, workspace } = await owner("subhist-noop-update");
    const contact = await createContact(cookie, workspace.slug, {
      email: `noop-status-${Date.now()}@example.com`,
    });
    expect(contact.subscriptionStatus).toBe("subscribed");

    const res = await app.inject({
      method: "PATCH",
      url: contactsUrl(workspace.slug, contact.id),
      headers: { cookie },
      payload: { subscriptionStatus: "subscribed" },
    });
    expect(res.statusCode, `update failed: ${res.body}`).toBe(200);

    const rows = await historyRows(workspace.id, contact.id);
    expect(rows).toHaveLength(0);
  });

  it("Test C: a webhook_suppression status change writes a history row with new_status='suppressed'", async () => {
    const { cookie, workspace } = await owner("subhist-webhook-suppression");
    const contact = await createContact(cookie, workspace.slug, {
      email: `webhook-suppress-${Date.now()}@example.com`,
    });
    expect(contact.subscriptionStatus).toBe("subscribed");

    // Mirrors apps/worker/src/queues/webhook-events.worker.ts's
    // `applySuppression` write sequence exactly (capture prior status,
    // UPDATE to suppressed, record the transition with source
    // 'webhook_suppression') -- the real call site's wiring is verified via
    // grep (task acceptance criteria) and exercised end-to-end by
    // apps/worker's webhook-events-suppression.test.ts.
    await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        await client.query(`UPDATE contacts SET subscription_status = 'suppressed', updated_at = now() WHERE id = $1`, [
          contact.id,
        ]);
        await recordSubscriptionStatusChange(client, {
          workspaceId: workspace.id,
          contactId: contact.id,
          oldStatus: "subscribed",
          newStatus: "suppressed",
          source: "webhook_suppression",
          reason: "hard_bounce",
        });
      })
    );

    const rows = await historyRows(workspace.id, contact.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ oldStatus: "subscribed", newStatus: "suppressed", source: "webhook_suppression" });
  });
});
