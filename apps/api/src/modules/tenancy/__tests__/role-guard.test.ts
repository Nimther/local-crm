import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, member } from "@mega-crm/db";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * TENANT-03/D-17/D-18: a Member is forbidden from inviting, changing roles,
 * removing members, and deleting the workspace. An Admin may invite/remove a
 * plain Member but is forbidden from assigning the Admin role, transferring
 * ownership, or deleting the workspace. Only the Owner succeeds at all of
 * the above (D-19/D-20).
 */
describe("role-based access control (TENANT-03, D-17/D-18)", () => {
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

  afterEach(() => {
    nock.cleanAll();
  });

  function mockSendGrid() {
    return nock("https://api.sendgrid.com").post("/v3/mail/send").reply(202, "", {
      "x-message-id": "role-guard-test",
    });
  }

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

  /** Adds a member with an explicit role directly (bypassing the invite flow, which is covered by invite-flow.test.ts) so each role-guard scenario is isolated. */
  async function addMemberWithRole(organizationId: string, role: "member" | "admin" | "owner") {
    const email = `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", role);
    await db.insert(member).values({ organizationId, userId: account.userId, role });
    return account;
  }

  async function findMemberRowId(slug: string, ownerCookie: string, userId: string): Promise<string> {
    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${slug}/members`,
      headers: { cookie: ownerCookie },
    });
    expect(res.statusCode, `list members failed: ${res.body}`).toBe(200);
    const row = (res.json<Array<{ id: string; userId: string }>>()).find((m) => m.userId === userId);
    if (!row) throw new Error(`member row not found for userId ${userId}`);
    return row.id;
  }

  it("blocks a Member from inviting, changing roles, removing members, and deleting the workspace", async () => {
    const owner = await signUp(`owner-mg-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Member Guard Co");
    const memberAccount = await addMemberWithRole(workspace.id, "member");
    const target = await addMemberWithRole(workspace.id, "member");
    const targetRowId = await findMemberRowId(workspace.slug, owner.cookie, target.userId);

    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: memberAccount.cookie },
      payload: { email: `blocked-${Date.now()}@example.com`, role: "member" },
    });
    expect(inviteRes.statusCode).toBe(403);

    const roleRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/members/${targetRowId}/role`,
      headers: { cookie: memberAccount.cookie },
      payload: { role: "admin" },
    });
    expect(roleRes.statusCode).toBe(403);

    const removeRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/members/${targetRowId}`,
      headers: { cookie: memberAccount.cookie },
    });
    expect(removeRes.statusCode).toBe(403);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: memberAccount.cookie },
      payload: { confirmName: workspace.name },
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it("lets an Admin invite and remove a Member, but blocks assigning Admin, transferring ownership, and deleting the workspace", async () => {
    const owner = await signUp(`owner-ag-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Admin Guard Co");
    const adminAccount = await addMemberWithRole(workspace.id, "admin");
    const removable = await addMemberWithRole(workspace.id, "member");
    const promotable = await addMemberWithRole(workspace.id, "member");

    mockSendGrid();
    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: adminAccount.cookie },
      payload: { email: `admin-invited-${Date.now()}@example.com`, role: "member" },
    });
    expect(inviteRes.statusCode, `admin invite failed: ${inviteRes.body}`).toBe(200);

    const removableRowId = await findMemberRowId(workspace.slug, owner.cookie, removable.userId);
    const removeRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/members/${removableRowId}`,
      headers: { cookie: adminAccount.cookie },
    });
    expect(removeRes.statusCode, `admin remove-member failed: ${removeRes.body}`).toBe(200);

    const promotableRowId = await findMemberRowId(workspace.slug, owner.cookie, promotable.userId);
    const promoteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/members/${promotableRowId}/role`,
      headers: { cookie: adminAccount.cookie },
      payload: { role: "admin" },
    });
    expect(promoteRes.statusCode).toBe(403);

    const transferRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/members/${promotableRowId}/role`,
      headers: { cookie: adminAccount.cookie },
      payload: { role: "owner" },
    });
    expect(transferRes.statusCode).toBe(403);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: adminAccount.cookie },
      payload: { confirmName: workspace.name },
    });
    expect(deleteRes.statusCode).toBe(403);
  });

  it("blocks an Admin from inviting someone directly as Admin", async () => {
    const owner = await signUp(`owner-ai-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Admin Invite Co");
    const adminAccount = await addMemberWithRole(workspace.id, "admin");

    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: adminAccount.cookie },
      payload: { email: `admin-target-${Date.now()}@example.com`, role: "admin" },
    });
    expect(inviteRes.statusCode).toBe(403);
  });

  it("lets the Owner assign Admin, transfer ownership, and delete the workspace via exact type-name confirmation", async () => {
    const owner = await signUp(`owner-og-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Owner Guard Co");
    const promotable = await addMemberWithRole(workspace.id, "member");
    const heir = await addMemberWithRole(workspace.id, "member");

    const promotableRowId = await findMemberRowId(workspace.slug, owner.cookie, promotable.userId);
    const promoteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/members/${promotableRowId}/role`,
      headers: { cookie: owner.cookie },
      payload: { role: "admin" },
    });
    expect(promoteRes.statusCode, `owner admin-assignment failed: ${promoteRes.body}`).toBe(200);

    const heirRowId = await findMemberRowId(workspace.slug, owner.cookie, heir.userId);
    const transferRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/members/${heirRowId}/role`,
      headers: { cookie: owner.cookie },
      payload: { role: "owner" },
    });
    expect(transferRes.statusCode, `owner ownership-transfer failed: ${transferRes.body}`).toBe(200);

    const wrongNameRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: owner.cookie },
      payload: { confirmName: "not the workspace name" },
    });
    expect(wrongNameRes.statusCode).toBe(400);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: owner.cookie },
      payload: { confirmName: workspace.name },
    });
    expect(deleteRes.statusCode, `owner delete-workspace failed: ${deleteRes.body}`).toBe(200);

    const afterDeleteRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: owner.cookie },
    });
    expect(afterDeleteRes.statusCode).toBe(404);
  });
});
