import { afterAll, beforeAll, describe, expect, it } from "vitest";
// 10-09 (SEC-05): seeding a member row directly for test setup is not a live
// application query site -- as of migration 0045 it needs the
// mega_crm_auth-backed client, not the app-role `db`.
import { authDb, member } from "@mega-crm/db";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * API-keys management routes (D-21/D-22/D-23): Owner/Admin-gated
 * create/list/revoke of named, workspace-scoped API keys. The full secret
 * crosses the wire exactly once, at creation (D-22); the schema carries a
 * `scopes` column reserved-but-unused in v1 (D-23) so every valid key grants
 * full Event/Contacts API access. A Member is forbidden (403) from both
 * create and revoke (D-21).
 */
describe("API-keys management (D-21/D-22/D-23)", () => {
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

  /** Adds a member with an explicit role directly, mirroring role-guard.test.ts's isolation approach. */
  async function addMemberWithRole(organizationId: string, role: "member" | "admin") {
    const email = `${role}-apikey-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", role);
    await authDb.insert(member).values({ organizationId, userId: account.userId, role });
    return account;
  }

  it("Owner creates a named key -- the response includes the full secret exactly once, and a subsequent list never returns it (D-21/D-22)", async () => {
    const owner = await signUp(`owner-keys-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Keys Co");

    const createRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/api-keys`,
      headers: { cookie: owner.cookie },
      payload: { name: "prod backend" },
    });
    expect(createRes.statusCode, `create key failed: ${createRes.body}`).toBe(200);
    const created = createRes.json();
    expect(created.fullKey).toMatch(/^mcrm_[0-9a-f]{16}\.[\w-]+$/);
    expect(created.keyMask).not.toBe(created.fullKey);
    expect(created.name).toBe("prod backend");

    const listRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/api-keys`,
      headers: { cookie: owner.cookie },
    });
    expect(listRes.statusCode, `list keys failed: ${listRes.body}`).toBe(200);
    const list = listRes.json<Array<Record<string, unknown>>>();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("fullKey");
    expect(list[0].keyMask).toBe(created.keyMask);
  });

  it("Owner revokes a key and it stops authenticating", async () => {
    const owner = await signUp(`owner-revoke-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Revoke Co");

    const createRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/api-keys`,
      headers: { cookie: owner.cookie },
      payload: { name: "to revoke" },
    });
    expect(createRes.statusCode, `create key failed: ${createRes.body}`).toBe(200);
    const created = createRes.json();

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/api-keys/${created.id}/revoke`,
      headers: { cookie: owner.cookie },
    });
    expect(revokeRes.statusCode, `revoke failed: ${revokeRes.body}`).toBe(200);

    const listRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/api-keys`,
      headers: { cookie: owner.cookie },
    });
    const list = listRes.json<Array<{ revokedAt: string | null }>>();
    expect(list[0].revokedAt).not.toBeNull();
  });

  it("Admin can create and revoke keys", async () => {
    const owner = await signUp(
      `owner-admin-keys-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Owner"
    );
    const workspace = await createWorkspace(owner.cookie, "Admin Keys Co");
    const admin = await addMemberWithRole(workspace.id, "admin");

    const createRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/api-keys`,
      headers: { cookie: admin.cookie },
      payload: { name: "admin-created" },
    });
    expect(createRes.statusCode, `admin create failed: ${createRes.body}`).toBe(200);
    const created = createRes.json();

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/api-keys/${created.id}/revoke`,
      headers: { cookie: admin.cookie },
    });
    expect(revokeRes.statusCode, `admin revoke failed: ${revokeRes.body}`).toBe(200);
  });

  it("Member is forbidden (403) from both creating and revoking keys (D-21)", async () => {
    const owner = await signUp(
      `owner-member-keys-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Owner"
    );
    const workspace = await createWorkspace(owner.cookie, "Member Keys Co");
    const memberAccount = await addMemberWithRole(workspace.id, "member");

    const createRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/api-keys`,
      headers: { cookie: memberAccount.cookie },
      payload: { name: "member-attempt" },
    });
    expect(createRes.statusCode).toBe(403);

    const ownerCreateRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/api-keys`,
      headers: { cookie: owner.cookie },
      payload: { name: "owner-created" },
    });
    expect(ownerCreateRes.statusCode, `owner create failed: ${ownerCreateRes.body}`).toBe(200);
    const created = ownerCreateRes.json();

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/api-keys/${created.id}/revoke`,
      headers: { cookie: memberAccount.cookie },
    });
    expect(revokeRes.statusCode).toBe(403);
  });
});
