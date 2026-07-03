import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { db, invitation, member } from "@mega-crm/db";

interface CapturedMailBody {
  content: Array<{ type: string; value: string }>;
}

/**
 * TENANT-02 (D-10/D-11/D-12): invite create dispatches through the platform
 * mail path with an accept URL; both accept paths (existing account,
 * register-from-invite) join the invited role; expired/revoked invites are
 * rejected; resend refreshes the invite.
 */
describe("invite lifecycle (TENANT-02)", () => {
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

  async function signIn(email: string, password: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    expect(res.statusCode, `sign-in failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-in response did not set a session cookie");
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

  function mockSendGrid() {
    let capturedBody: CapturedMailBody | undefined;
    const scope = nock("https://api.sendgrid.com")
      .post("/v3/mail/send", (body: CapturedMailBody) => {
        capturedBody = body;
        return true;
      })
      .reply(202, "", { "x-message-id": "invite-flow-test" });
    return { scope, getCapturedBody: () => capturedBody };
  }

  it("creates an invitation, dispatches it via the platform mail path with an accept URL, and shows the copyable link", async () => {
    const owner = await signUp(`owner-inv-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Invite Co");

    const { scope, getCapturedBody } = mockSendGrid();

    const inviteEmail = `invitee-${Date.now()}@example.com`;
    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
      payload: { email: inviteEmail, role: "member" },
    });

    expect(inviteRes.statusCode, `create invite failed: ${inviteRes.body}`).toBe(200);
    const invite = inviteRes.json();
    expect(invite.email).toBe(inviteEmail);
    expect(invite.role).toBe("member");
    expect(invite.inviteUrl).toContain(`/invite/${invite.id}`);

    expect(scope.isDone()).toBe(true);
    const html = getCapturedBody()?.content.find((c) => c.type === "text/html")?.value;
    expect(html, "invite email should contain the in-repo invite template").toContain("MEGA_CRM_INVITE_TEMPLATE");
    expect(html).toContain(`/invite/${invite.id}`);
  });

  it("registers a brand-new user directly from the invite (D-12) and joins with the assigned role, email fixed by the invite", async () => {
    const owner = await signUp(`owner-reg-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Register Co");
    mockSendGrid();

    const inviteEmail = `newperson-${Date.now()}@example.com`;
    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
      payload: { email: inviteEmail, role: "member" },
    });
    const invite = inviteRes.json();

    const previewRes = await app.inject({ method: "GET", url: `/api/invites/${invite.id}` });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json().status).toBe("pending");
    expect(previewRes.json().email).toBe(inviteEmail);

    const registerRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.id}/register`,
      payload: { name: "New Person", password: "correct horse battery staple 42" },
    });
    expect(registerRes.statusCode, `register-from-invite failed: ${registerRes.body}`).toBe(200);
    const newSessionCookie = registerRes.cookies.find((c) => c.name.toLowerCase().includes("session"));
    expect(newSessionCookie, "register-from-invite should sign the new user in").toBeTruthy();

    const memberRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: `${newSessionCookie!.name}=${newSessionCookie!.value}` },
    });
    expect(memberRes.statusCode, `newly-registered invitee cannot read the workspace: ${memberRes.body}`).toBe(200);
    expect(memberRes.json().role).toBe("member");
  });

  it("accepts as an existing account and joins with the assigned role", async () => {
    const owner = await signUp(`owner-exist-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Existing Co");
    mockSendGrid();

    const existingEmail = `existing-${Date.now()}@example.com`;
    const existingPassword = "correct horse battery staple 42";
    await signUp(existingEmail, existingPassword, "Existing User");

    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
      payload: { email: existingEmail, role: "member" },
    });
    const invite = inviteRes.json();

    const existing = await signIn(existingEmail, existingPassword);
    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.id}/accept`,
      headers: { cookie: existing.cookie },
    });
    expect(acceptRes.statusCode, `accept failed: ${acceptRes.body}`).toBe(200);

    const memberRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: existing.cookie },
    });
    expect(memberRes.statusCode).toBe(200);
    expect(memberRes.json().role).toBe("member");
  });

  it("rejects an invitation older than 7 days (D-11)", async () => {
    const owner = await signUp(`owner-exp-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Expired Co");
    mockSendGrid();

    const inviteEmail = `expired-${Date.now()}@example.com`;
    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
      payload: { email: inviteEmail, role: "member" },
    });
    const invite = inviteRes.json();

    await db
      .update(invitation)
      .set({ expiresAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(invitation.id, invite.id));

    const previewRes = await app.inject({ method: "GET", url: `/api/invites/${invite.id}` });
    expect(previewRes.statusCode).toBe(200);
    expect(previewRes.json().status).toBe("expired");

    const registerRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.id}/register`,
      payload: { name: "Too Late", password: "correct horse battery staple 42" },
    });
    expect(registerRes.statusCode).toBe(400);
  });

  it("rejects a revoked invite and lets the Owner resend a fresh invite (D-11)", async () => {
    const owner = await signUp(`owner-revoke-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Revoke Co");
    mockSendGrid();

    const inviteEmail = `revoked-${Date.now()}@example.com`;
    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
      payload: { email: inviteEmail, role: "member" },
    });
    const invite = inviteRes.json();

    const revokeRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites/${invite.id}/revoke`,
      headers: { cookie: owner.cookie },
    });
    expect(revokeRes.statusCode, `revoke failed: ${revokeRes.body}`).toBe(200);

    const previewRes = await app.inject({ method: "GET", url: `/api/invites/${invite.id}` });
    expect(previewRes.json().status).toBe("revoked");

    const registerRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.id}/register`,
      payload: { name: "Nope", password: "correct horse battery staple 42" },
    });
    expect(registerRes.statusCode).toBe(400);

    mockSendGrid();
    const secondInviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
      payload: { email: inviteEmail, role: "member" },
    });
    expect(secondInviteRes.statusCode, `re-invite after revoke failed: ${secondInviteRes.body}`).toBe(200);
  });

  it("a plain Member is 403'd from GET /invites (cannot read pending invites or accept tokens); the Owner still gets 200 (WR-02)", async () => {
    const owner = await signUp(`owner-list-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "List Co");

    const memberAccount = await signUp(
      `list-member-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "List Member"
    );
    await db.insert(member).values({ organizationId: workspace.id, userId: memberAccount.userId, role: "member" });

    const memberRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: memberAccount.cookie },
    });
    expect(memberRes.statusCode).toBe(403);

    const ownerRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
    });
    expect(ownerRes.statusCode, `owner GET /invites failed: ${ownerRes.body}`).toBe(200);
    expect(Array.isArray(ownerRes.json())).toBe(true);
  });

  it("resend issues a fresh invite with a refreshed expiry", async () => {
    const owner = await signUp(`owner-resend-${Date.now()}@example.com`, "correct horse battery staple 42", "Owner");
    const workspace = await createWorkspace(owner.cookie, "Resend Co");
    mockSendGrid();

    const inviteEmail = `resend-${Date.now()}@example.com`;
    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
      payload: { email: inviteEmail, role: "member" },
    });
    const invite = inviteRes.json();

    await db.update(invitation).set({ expiresAt: new Date(Date.now() + 1000) }).where(eq(invitation.id, invite.id));

    mockSendGrid();
    const resendRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites/${invite.id}/resend`,
      headers: { cookie: owner.cookie },
    });
    expect(resendRes.statusCode, `resend failed: ${resendRes.body}`).toBe(200);
    const resent = resendRes.json();
    expect(new Date(resent.expiresAt).getTime()).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });
});
