import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { authDb, member } from "@mega-crm/db";
import { dsrExportDocumentSchema, type DsrExportDocument } from "@mega-crm/shared-schemas";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { withTenantTransactionRepeatableRead } from "@mega-crm/tenant-context";
import { deleteContact } from "../contact.repository.js";

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

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
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
});
