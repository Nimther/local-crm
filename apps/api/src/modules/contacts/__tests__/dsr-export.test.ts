import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { authDb, member } from "@mega-crm/db";
import { dsrExportDocumentSchema, type DsrExportDocument } from "@mega-crm/shared-schemas";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { withTenantTransactionRepeatableRead } from "@mega-crm/tenant-context";
import { deleteContact } from "../contact.repository.js";
import { DSR_EXPORT_PAGE_LIMIT } from "../dsr-export.repository.js";

/**
 * Phase 21 plan 01 (DSR-01/DSR-04, tracer): end-to-end HTTP coverage of the
 * DSR export's happy path -- one contact's profile/customProperties/
 * metadata, the Owner/Admin gate, and the REPEATABLE READ isolation-level
 * helper. The refusal triad (403/404/410) is Task 2's scope, added in the
 * same file.
 */
describe("GET .../contacts/:id/dsr-export (DSR-01/DSR-04, plan 21-01)", () => {
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
  });

  // Phase 21 plan 05: this file's per-test owners/admins now exceed the
  // /api/auth/* scope's 20 req/min per-IP rate limit from inject's single
  // default address (contact-crud.test.ts's own precedent) -- each simulated
  // account signs up from its own source IP.
  let nextSignUpIp = 1;
  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
      remoteAddress: `127.0.2.${nextSignUpIp++}`,
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) throw new Error("sign-up response did not set a session cookie");
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}`, userId: res.json().user.id as string };
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

  /** Mirrors role-guard.test.ts's `addMemberWithRole` -- seeds a member row directly, bypassing the invite flow. */
  async function addMemberWithRole(organizationId: string, role: "member" | "admin" | "owner") {
    const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", role);
    await authDb.insert(member).values({ organizationId, userId: account.userId, role });
    return account;
  }

  async function createContact(
    ownerCookie: string,
    slug: string,
    input: { email: string; firstName?: string; city?: string; timezone?: string; tags?: string[]; properties?: Record<string, unknown> }
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie: ownerCookie },
      payload: input,
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  /** Drives the real `manual_ui` history write path via the PATCH route (mirrors subscription-status-history.test.ts Test A). */
  async function setSubscriptionStatus(ownerCookie: string, slug: string, contactId: string, status: string) {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${slug}/contacts/${contactId}`,
      headers: { cookie: ownerCookie },
      payload: { subscriptionStatus: status },
    });
    expect(res.statusCode, `status update failed: ${res.body}`).toBe(200);
  }

  /** Reads the real subscription_status_history row count straight from the table -- never a guessed number. */
  async function statusHistoryRowCount(workspaceId: string, contactId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM subscription_status_history WHERE workspace_id = $1 AND contact_id = $2`,
          [workspaceId, contactId]
        );
        return Number(rows[0].count);
      })
    );
  }

  /** Seeds one event row directly (mirrors contact-events-read.test.ts's `seedEvent`), the same table events:ingest writes to. */
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

  it("profile: an Owner gets a 200 export with metadata/profile/customProperties, no requester identity in the body", async () => {
    const owner = await signUp(`owner-dsr-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Export Co");
    const email = `dsr-profile-${Date.now()}@example.test`;
    const contact = await createContact(owner.cookie, workspace.slug, {
      email,
      firstName: "Ada",
      city: "Springfield",
      timezone: "America/Chicago",
      tags: ["vip", "beta"],
      properties: { plan: "pro", seats: 5 },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });

    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="dsr-export-${contact.id}-${today}.json"`
    );

    const body = res.json<DsrExportDocument>();
    const parsed = dsrExportDocumentSchema.safeParse(body);
    expect(parsed.success, `body failed schema validation: ${JSON.stringify(parsed.success ? null : parsed.error)}`).toBe(true);

    expect(body.profile.email).toBe(email);
    expect(body.profile.firstName).toBe("Ada");
    expect(body.profile.city).toBe("Springfield");
    expect(body.profile.timezone).toBe("America/Chicago");
    expect(body.profile.tags).toEqual(["vip", "beta"]);
    expect(body.customProperties).toEqual({ plan: "pro", seats: 5 });
    expect(body.metadata.contact.id).toBe(contact.id);
    expect(body.metadata.workspace.id).toBe(workspace.id);
    expect(body.metadata.workspace.name).toBe(workspace.name);
    expect(body.metadata.exportFormatVersion.length).toBeGreaterThan(0);
    expect(body.metadata.allowlistName.length).toBeGreaterThan(0);
    expect(body.metadata.sectionRowCounts.profile).toBe(1);
    expect(body.metadata.sectionRowCounts.customProperties).toBe(2);

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(owner.userId);
    expect(serialized).not.toContain(owner.cookie.split("=")[1] ?? "__no_cookie__");
  });

  it("admin can export: a second account with role admin also gets 200", async () => {
    const owner = await signUp(`owner-dsr-admin-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Admin Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-admin-${Date.now()}@example.test` });
    const admin = await addMemberWithRole(workspace.id, "admin");

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: admin.cookie },
    });

    expect(res.statusCode, `admin export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();
    expect(body.metadata.contact.id).toBe(contact.id);
  });

  it("isolation level: withTenantTransactionRepeatableRead opens a repeatable-read transaction", async () => {
    const owner = await signUp(`owner-dsr-iso-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Isolation Co");

    const level = await withTenant(workspace.id, () =>
      withTenantTransactionRepeatableRead(async (client) => {
        const { rows } = await client.query<{ level: string }>(`SELECT current_setting('transaction_isolation') as level`);
        return rows[0].level;
      })
    );
    expect(level).toBe("repeatable read");

    // Sanity control: the ordinary helper stays at the pool default.
    const defaultLevel = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ level: string }>(`SELECT current_setting('transaction_isolation') as level`);
        return rows[0].level;
      })
    );
    expect(defaultLevel).toBe("read committed");
  });

  it("role guard: member is refused with 403, no document assembled", async () => {
    const owner = await signUp(`owner-dsr-refuse-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Refuse Co");
    const email = `dsr-refuse-${Date.now()}@example.test`;
    const contact = await createContact(owner.cookie, workspace.slug, { email });
    const memberAccount = await addMemberWithRole(workspace.id, "member");

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: memberAccount.cookie },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(email);
  });

  it("cross-tenant: a contact id from another workspace, and a contact id that never existed, are byte-identical 404s", async () => {
    const ownerA = await signUp(`owner-dsr-tenant-a-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner A");
    const workspaceA = await createWorkspace(ownerA.cookie, "DSR Tenant A Co");
    const ownerB = await signUp(`owner-dsr-tenant-b-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner B");
    const workspaceB = await createWorkspace(ownerB.cookie, "DSR Tenant B Co");
    const contactB = await createContact(ownerB.cookie, workspaceB.slug, { email: `dsr-tenant-b-${Date.now()}@example.test` });

    const crossTenantRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceA.slug}/contacts/${contactB.id}/dsr-export`,
      headers: { cookie: ownerA.cookie },
    });
    expect(crossTenantRes.statusCode).toBe(404);
    expect(crossTenantRes.json()).toEqual({ error: "Workspace not found" });

    const neverExistedRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceA.slug}/contacts/00000000-0000-0000-0000-000000000000/dsr-export`,
      headers: { cookie: ownerA.cookie },
    });
    expect(neverExistedRes.statusCode).toBe(crossTenantRes.statusCode);
    expect(neverExistedRes.json()).toEqual(crossTenantRes.json());
  });

  it("invalid contact id: a non-UUID :id returns 400 for a workspace member", async () => {
    const owner = await signUp(`owner-dsr-invalid-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Invalid Co");

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/not-a-uuid/dsr-export`,
      headers: { cookie: owner.cookie },
    });

    expect(res.statusCode).toBe(400);
  });

  it("erased: an anonymized contact returns a typed 410, never a document", async () => {
    const owner = await signUp(`owner-dsr-erased-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Erased Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-erased-${Date.now()}@example.test` });

    await withTenant(workspace.id, () => deleteContact(contact.id));

    const erasureRecord = await withTenant(workspace.id, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; anonymizedAt: Date }>(
          `SELECT id, anonymized_at as "anonymizedAt" FROM erasure_records WHERE workspace_id = $1 AND contact_id = $2`,
          [workspace.id, contact.id]
        );
        return rows[0];
      })
    );
    expect(erasureRecord).toBeTruthy();

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });

    expect(res.statusCode, `expected 410, got: ${res.body}`).toBe(410);
    const body = res.json<{ code: string; erasedAt: string; erasureRecordId: string | null }>();
    expect(body.code).toBe("contact_erased");
    expect(new Date(body.erasedAt).toISOString()).toBe(erasureRecord.anonymizedAt.toISOString());
    expect(body.erasureRecordId).toBe(erasureRecord.id);
    expect(body).not.toHaveProperty("profile");
    expect(body).not.toHaveProperty("customProperties");
    expect(body).not.toHaveProperty("metadata");
  });

  it("consent history: every transition is exported oldest first (DSR-01)", async () => {
    const owner = await signUp(`owner-dsr-consent-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Consent Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-consent-${Date.now()}@example.test` });

    await setSubscriptionStatus(owner.cookie, workspace.slug, contact.id, "unsubscribed");
    await setSubscriptionStatus(owner.cookie, workspace.slug, contact.id, "subscribed");
    await setSubscriptionStatus(owner.cookie, workspace.slug, contact.id, "unsubscribed");

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    const expectedCount = await statusHistoryRowCount(workspace.id, contact.id);
    expect(expectedCount).toBe(3);
    expect(body.consentHistory).toHaveLength(3);
    expect(body.metadata.sectionRowCounts.consentHistory).toBe(3);

    expect(body.consentHistory[0]).toMatchObject({ oldStatus: "subscribed", newStatus: "unsubscribed", source: "manual_ui" });
    expect(body.consentHistory[1]).toMatchObject({ oldStatus: "unsubscribed", newStatus: "subscribed", source: "manual_ui" });
    expect(body.consentHistory[2]).toMatchObject({ oldStatus: "subscribed", newStatus: "unsubscribed", source: "manual_ui" });

    const changedAts = body.consentHistory.map((entry) => new Date(entry.changedAt).getTime());
    expect(changedAts).toEqual([...changedAts].sort((a, b) => a - b));
  });

  it("consent history: a contact with no transitions exports the real row count, not a guessed number (DSR-01)", async () => {
    const owner = await signUp(`owner-dsr-consent-empty-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Consent Empty Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-consent-empty-${Date.now()}@example.test` });

    const expectedCount = await statusHistoryRowCount(workspace.id, contact.id);

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.consentHistory).toHaveLength(expectedCount);
    expect(body.metadata.sectionRowCounts.consentHistory).toBe(expectedCount);
  });

  it("consent history: another contact's transitions are absent from this contact's section (DSR-01)", async () => {
    const owner = await signUp(`owner-dsr-consent-iso-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Consent Iso Co");
    const contactA = await createContact(owner.cookie, workspace.slug, { email: `dsr-consent-iso-a-${Date.now()}@example.test` });
    const contactB = await createContact(owner.cookie, workspace.slug, { email: `dsr-consent-iso-b-${Date.now()}@example.test` });

    await setSubscriptionStatus(owner.cookie, workspace.slug, contactB.id, "unsubscribed");
    await setSubscriptionStatus(owner.cookie, workspace.slug, contactB.id, "subscribed");

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contactA.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.consentHistory).toHaveLength(0);
    expect(body.metadata.sectionRowCounts.consentHistory).toBe(0);
  });

  it("events: every event is exported oldest first, without properties (DSR-02, D-01)", async () => {
    const owner = await signUp(`owner-dsr-events-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Events Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-events-${Date.now()}@example.test` });
    const otherPersonEmail = "another-subject-under-tenant-key@example.test";

    const now = Date.now();
    await seedEvent(workspace.id, contact.id, "signed_up", { plan: "free" }, new Date(now - 120_000));
    await seedEvent(workspace.id, contact.id, "order_placed", { total: 42 }, new Date(now - 60_000));
    await seedEvent(workspace.id, contact.id, "referral_shared", { referredEmail: otherPersonEmail }, new Date(now));

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.events).toHaveLength(3);
    expect(body.metadata.sectionRowCounts.events).toBe(3);
    expect(body.events.map((e) => e.name)).toEqual(["signed_up", "order_placed", "referral_shared"]);
    for (const entry of body.events) {
      expect(Object.keys(entry)).not.toContain("properties");
    }

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(otherPersonEmail);
  });

  it("events: a contact with more rows than one page exports all of them (D-10)", async () => {
    const owner = await signUp(`owner-dsr-events-page-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Events Page Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-events-page-${Date.now()}@example.test` });

    const total = DSR_EXPORT_PAGE_LIMIT + 7;
    const base = Date.now() - total * 1000;
    for (let i = 0; i < total; i++) {
      await seedEvent(workspace.id, contact.id, `event_${i}`, {}, new Date(base + i * 1000));
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.events).toHaveLength(total);
    expect(body.metadata.sectionRowCounts.events).toBe(total);
    const ids = new Set(body.events.map((e) => e.id));
    expect(ids.size).toBe(total);
  }, 30_000);

  it("events: another contact's events are absent (DSR-02)", async () => {
    const owner = await signUp(`owner-dsr-events-iso-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Events Iso Co");
    const contactA = await createContact(owner.cookie, workspace.slug, { email: `dsr-events-iso-a-${Date.now()}@example.test` });
    const contactB = await createContact(owner.cookie, workspace.slug, { email: `dsr-events-iso-b-${Date.now()}@example.test` });

    await seedEvent(workspace.id, contactB.id, "signed_up", {}, new Date());

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contactA.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.events).toHaveLength(0);
    expect(body.metadata.sectionRowCounts.events).toBe(0);
  });

  /**
   * Phase 21 plan 05 (DSR-02): seeds one `sends` row directly (mirrors
   * `contact-erasure.test.ts`'s raw-insert precedent), with every
   * delivery-status/telemetry column addressable so tests can populate
   * exactly what they need to assert on. Defaults leave every optional
   * column null/zero.
   */
  async function seedSend(
    workspaceId: string,
    contactId: string,
    fields: {
      kind?: string;
      status?: string;
      queuedAt: Date;
      sentAt?: Date | null;
      deliveredAt?: Date | null;
      firstOpenedAt?: Date | null;
      firstClickedAt?: Date | null;
      bouncedAt?: Date | null;
      droppedAt?: Date | null;
      unsubscribedAt?: Date | null;
      spamReportedAt?: Date | null;
      bounceReason?: string | null;
      dropReason?: string | null;
      flowRunId?: string | null;
      nodeId?: string | null;
      openCount?: number;
      clickCount?: number;
      reconcilingSince?: Date | null;
      dispatchedAt?: Date | null;
      dispatchDurationMs?: number | null;
    }
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (
             workspace_id, contact_id, kind, status, queued_at, sent_at, delivered_at,
             first_opened_at, first_clicked_at, bounced_at, dropped_at, unsubscribed_at,
             spam_reported_at, bounce_reason, drop_reason, flow_run_id, node_id,
             open_count, click_count, reconciling_since, dispatched_at, dispatch_duration_ms
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
           RETURNING id`,
          [
            workspaceId,
            contactId,
            fields.kind ?? "campaign",
            fields.status ?? "sent",
            fields.queuedAt,
            fields.sentAt ?? null,
            fields.deliveredAt ?? null,
            fields.firstOpenedAt ?? null,
            fields.firstClickedAt ?? null,
            fields.bouncedAt ?? null,
            fields.droppedAt ?? null,
            fields.unsubscribedAt ?? null,
            fields.spamReportedAt ?? null,
            fields.bounceReason ?? null,
            fields.dropReason ?? null,
            fields.flowRunId ?? null,
            fields.nodeId ?? null,
            fields.openCount ?? 0,
            fields.clickCount ?? 0,
            fields.reconcilingSince ?? null,
            fields.dispatchedAt ?? null,
            fields.dispatchDurationMs ?? null,
          ]
        );
        return rows[0].id;
      })
    );
  }

  /**
   * Phase 21 plan 05 (DSR-02/DSR-03): seeds one `send_events` row directly,
   * joined to `sends` through `sendId` -- the table itself carries no
   * `contact_id`.
   */
  async function seedSendEvent(
    workspaceId: string,
    sendId: string,
    fields: {
      sgEventId?: string;
      eventType?: string;
      reason?: string | null;
      payload?: Record<string, unknown>;
      isTest?: boolean;
      occurredAt: Date;
    }
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO send_events (
             id, workspace_id, sg_event_id, send_id, event_type, reason, payload,
             is_test, occurred_at, received_at
           ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, now())
           RETURNING id`,
          [
            workspaceId,
            fields.sgEventId ?? `sg-evt-${randomUUID()}`,
            sendId,
            fields.eventType ?? "delivered",
            fields.reason ?? null,
            JSON.stringify(fields.payload ?? {}),
            fields.isTest ?? false,
            fields.occurredAt,
          ]
        );
        return rows[0].id;
      })
    );
  }

  it("sends: every send for this contact is exported oldest first (DSR-02)", async () => {
    const owner = await signUp(`owner-dsr-sends-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Sends Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-sends-${Date.now()}@example.test` });

    const now = Date.now();
    const send1Queued = new Date(now - 60_000);
    await seedSend(workspace.id, contact.id, {
      kind: "campaign",
      status: "sent",
      queuedAt: send1Queued,
      sentAt: new Date(now - 59_000),
      deliveredAt: new Date(now - 58_000),
      firstOpenedAt: new Date(now - 57_000),
      openCount: 2,
      clickCount: 0,
    });
    const send2Queued = new Date(now - 30_000);
    await seedSend(workspace.id, contact.id, {
      kind: "flow",
      status: "failed",
      queuedAt: send2Queued,
      droppedAt: new Date(now - 29_000),
      dropReason: "hard_bounce",
      nodeId: "node-abc",
      openCount: 0,
      clickCount: 0,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.sends).toHaveLength(2);
    expect(body.metadata.sectionRowCounts.sends).toBe(2);

    const queuedAts = body.sends.map((s) => new Date(s.queuedAt).getTime());
    expect(queuedAts).toEqual([...queuedAts].sort((a, b) => a - b));

    const [first, second] = body.sends;
    expect(first).toMatchObject({
      campaignId: null,
      kind: "campaign",
      status: "sent",
      bounceReason: null,
      dropReason: null,
      flowRunId: null,
      nodeId: null,
      openCount: 2,
      clickCount: 0,
    });
    expect(new Date(first.queuedAt).getTime()).toBe(send1Queued.getTime());
    expect(first.sentAt).not.toBeNull();
    expect(first.deliveredAt).not.toBeNull();
    expect(first.firstOpenedAt).not.toBeNull();
    expect(first.firstClickedAt).toBeNull();
    expect(first.bouncedAt).toBeNull();
    expect(first.droppedAt).toBeNull();

    expect(second).toMatchObject({
      campaignId: null,
      kind: "flow",
      status: "failed",
      dropReason: "hard_bounce",
      bounceReason: null,
      nodeId: "node-abc",
      openCount: 0,
      clickCount: 0,
    });
    expect(new Date(second.queuedAt).getTime()).toBe(send2Queued.getTime());
    expect(second.droppedAt).not.toBeNull();
    expect(second.sentAt).toBeNull();
  });

  it("sends: excluded telemetry columns are absent (DSR-02)", async () => {
    const owner = await signUp(`owner-dsr-sends-tel-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Sends Telemetry Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-sends-tel-${Date.now()}@example.test` });

    await seedSend(workspace.id, contact.id, {
      queuedAt: new Date(),
      reconcilingSince: new Date(),
      dispatchedAt: new Date(),
      dispatchDurationMs: 250,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.sends).toHaveLength(1);
    expect(Object.keys(body.sends[0])).not.toContain("reconcilingSince");
    expect(Object.keys(body.sends[0])).not.toContain("dispatchDurationMs");
  });

  it("sends: another contact's sends are absent (DSR-02)", async () => {
    const owner = await signUp(`owner-dsr-sends-iso-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Sends Iso Co");
    const contactA = await createContact(owner.cookie, workspace.slug, { email: `dsr-sends-iso-a-${Date.now()}@example.test` });
    const contactB = await createContact(owner.cookie, workspace.slug, { email: `dsr-sends-iso-b-${Date.now()}@example.test` });

    await seedSend(workspace.id, contactB.id, { queuedAt: new Date() });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contactA.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.sends).toHaveLength(0);
    expect(body.metadata.sectionRowCounts.sends).toBe(0);
  });

  it("sends: a contact with no sends exports an empty array with count 0 (DSR-02)", async () => {
    const owner = await signUp(`owner-dsr-sends-empty-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Sends Empty Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-sends-empty-${Date.now()}@example.test` });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.sends).toHaveLength(0);
    expect(body.metadata.sectionRowCounts.sends).toBe(0);
  });

  /**
   * Phase 21 plan 05 (DSR-03, SC4): the synthetic other-subject-field proof.
   * A distinctive, unlikely-to-collide address shared as a constant so the
   * assertion cannot pass by accident.
   */
  const SYNTHETIC_OTHER_SUBJECT_ADDRESS = "another-subject-in-payload-key@example.test";

  it("send events nest under their send, oldest first (DSR-02)", async () => {
    const owner = await signUp(`owner-dsr-sevt-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Send Events Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-sevt-${Date.now()}@example.test` });
    const sendId = await seedSend(workspace.id, contact.id, { queuedAt: new Date() });

    const now = Date.now();
    await seedSendEvent(workspace.id, sendId, { eventType: "processed", occurredAt: new Date(now - 3000) });
    await seedSendEvent(workspace.id, sendId, { eventType: "delivered", occurredAt: new Date(now - 2000) });
    await seedSendEvent(workspace.id, sendId, { eventType: "open", occurredAt: new Date(now - 1000) });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.sends).toHaveLength(1);
    expect(body.sends[0].sendEvents).toHaveLength(3);
    expect(body.metadata.sectionRowCounts.sendEvents).toBe(3);
    expect(body.sends[0].sendEvents.map((e) => e.eventType)).toEqual(["processed", "delivered", "open"]);
    const occurredAts = body.sends[0].sendEvents.map((e) => new Date(e.occurredAt).getTime());
    expect(occurredAts).toEqual([...occurredAts].sort((a, b) => a - b));
  });

  it("allowlist: a synthetic field holding another subject's data is absent from the export (DSR-03, SC4)", async () => {
    const owner = await signUp(`owner-dsr-sc4-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR SC4 Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-sc4-${Date.now()}@example.test` });
    const sendId = await seedSend(workspace.id, contact.id, { queuedAt: new Date() });

    await seedSendEvent(workspace.id, sendId, {
      eventType: "bounce",
      occurredAt: new Date(),
      payload: {
        // Evidence keys (SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST):
        event: "bounce",
        type: "bounce",
        timestamp: 1700000000,
        sg_event_id: "sg-evt-1",
        sg_message_id: "sg-msg-1",
        "smtp-id": "<abc@sendgrid>",
        status: "5.1.1",
        attempt: "1",
        asm_group_id: 42,
        bounce_classification: "hard",
        // Export-only keys:
        ip: "203.0.113.10",
        useragent: "Mozilla/5.0",
        url: "https://example.test/click",
        reason: "550 mailbox unavailable",
        // Tenant-invented keys holding another subject's data:
        referred_by_contact: { nested_email: SYNTHETIC_OTHER_SUBJECT_ADDRESS },
        internal_notes: `escalated to ${SYNTHETIC_OTHER_SUBJECT_ADDRESS} for follow-up`,
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    const entry = body.sends[0].sendEvents[0];
    expect(entry.payload).toMatchObject({
      event: "bounce",
      type: "bounce",
      timestamp: 1700000000,
      sg_event_id: "sg-evt-1",
      sg_message_id: "sg-msg-1",
      "smtp-id": "<abc@sendgrid>",
      status: "5.1.1",
      attempt: "1",
      asm_group_id: 42,
      bounce_classification: "hard",
    });
    expect(entry.payload).not.toHaveProperty("referred_by_contact");
    expect(entry.payload).not.toHaveProperty("internal_notes");

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SYNTHETIC_OTHER_SUBJECT_ADDRESS);
  });

  it("allowlist: the export list is applied, not the evidence list (DSR-03, D-02)", async () => {
    const owner = await signUp(`owner-dsr-explist-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Export List Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-explist-${Date.now()}@example.test` });
    const sendId = await seedSend(workspace.id, contact.id, { queuedAt: new Date() });

    await seedSendEvent(workspace.id, sendId, {
      eventType: "click",
      occurredAt: new Date(),
      payload: {
        ip: "198.51.100.7",
        useragent: "curl/8.0",
        url: "https://example.test/offer",
        reason: "clicked link",
      },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    const entry = body.sends[0].sendEvents[0];
    expect(entry.payload.ip).toBe("198.51.100.7");
    expect(entry.payload.useragent).toBe("curl/8.0");
    expect(entry.payload.url).toBe("https://example.test/offer");
    expect(entry.payload.reason).toBe("clicked link");
  });

  it("allowlist: a payload of only non-allowlisted keys exports an empty object (DSR-03)", async () => {
    const owner = await signUp(`owner-dsr-empty-payload-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Empty Payload Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-empty-payload-${Date.now()}@example.test` });
    const sendId = await seedSend(workspace.id, contact.id, { queuedAt: new Date() });

    await seedSendEvent(workspace.id, sendId, {
      eventType: "unsubscribe",
      occurredAt: new Date(),
      payload: { unique_args: { foo: "bar" }, marketing_campaign_id: "mc-1" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.sends[0].sendEvents).toHaveLength(1);
    expect(body.sends[0].sendEvents[0].payload).toEqual({});
  });

  it("send events: another contact's send events are absent (DSR-02)", async () => {
    const owner = await signUp(`owner-dsr-sevt-iso-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Send Events Iso Co");
    const contactA = await createContact(owner.cookie, workspace.slug, { email: `dsr-sevt-iso-a-${Date.now()}@example.test` });
    const contactB = await createContact(owner.cookie, workspace.slug, { email: `dsr-sevt-iso-b-${Date.now()}@example.test` });
    const sendB = await seedSend(workspace.id, contactB.id, { queuedAt: new Date() });
    await seedSendEvent(workspace.id, sendB, { occurredAt: new Date() });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contactA.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.sends).toHaveLength(0);
    expect(body.metadata.sectionRowCounts.sendEvents).toBe(0);
  });

  it("send events: more than one page of send events all reach the file (D-10)", async () => {
    const owner = await signUp(`owner-dsr-sevt-page-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "DSR Send Events Page Co");
    const contact = await createContact(owner.cookie, workspace.slug, { email: `dsr-sevt-page-${Date.now()}@example.test` });
    const sendId = await seedSend(workspace.id, contact.id, { queuedAt: new Date() });

    const total = DSR_EXPORT_PAGE_LIMIT + 3;
    const base = Date.now() - total * 1000;
    for (let i = 0; i < total; i++) {
      await seedSendEvent(workspace.id, sendId, {
        eventType: `synthetic_${i}`,
        occurredAt: new Date(base + i * 1000),
      });
    }

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${contact.id}/dsr-export`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode, `export failed: ${res.body}`).toBe(200);
    const body = res.json<DsrExportDocument>();

    expect(body.sends).toHaveLength(1);
    expect(body.sends[0].sendEvents).toHaveLength(total);
    expect(body.metadata.sectionRowCounts.sendEvents).toBe(total);
    const ids = new Set(body.sends[0].sendEvents.map((e) => e.id));
    expect(ids.size).toBe(total);
  }, 30_000);
});
