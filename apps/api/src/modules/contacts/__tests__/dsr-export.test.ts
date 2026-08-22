import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { authDb, member } from "@mega-crm/db";
import { dsrExportDocumentSchema, type DsrExportDocument } from "@mega-crm/shared-schemas";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { withTenantTransactionRepeatableRead } from "@mega-crm/tenant-context";

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
});
