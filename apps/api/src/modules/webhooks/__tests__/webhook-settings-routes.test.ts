import nock from "nock";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, member, user } from "@mega-crm/db";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant } from "../../../middleware/tenant-context.js";
import { getWebhookEndpointByWorkspace } from "../webhook-endpoint.repository.js";

const VALID_KEY = "SG.mock_webhook_health_key_1234567890abcdef";

/**
 * GET /api/workspaces/:slug/webhook-health + POST
 * /api/workspaces/:slug/webhook-reconnect (D-03, WBHK-01): health is
 * member-readable, reconnect is Owner/Admin-only; neither route leaks the
 * pathToken/publicKey.
 */
describe("Webhook health + reconnect routes (D-03)", () => {
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

  function mockScopes(apiKey: string) {
    return nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${apiKey}` } })
      .get("/v3/scopes")
      .reply(200, { scopes: ["mail.send"] });
  }

  function mockVerifiedSenders(apiKey: string) {
    return nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${apiKey}` } })
      .get("/v3/verified_senders")
      .reply(200, { results: [] });
  }

  function mockWebhookListing(apiKey: string, webhooks: unknown[] = [], maxAllowed = 10) {
    return nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${apiKey}` } })
      .get("/v3/user/webhooks/event/settings/all")
      .reply(200, { webhooks, max_allowed: maxAllowed });
  }

  function mockWebhookCreate(apiKey: string, id: string) {
    return nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${apiKey}` } })
      .post("/v3/user/webhooks/event/settings")
      .reply(200, { id });
  }

  function mockWebhookPatch(apiKey: string, id: string) {
    return nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${apiKey}` } })
      .patch(`/v3/user/webhooks/event/settings/${id}`)
      .reply(200, { id });
  }

  function mockSignedEnable(apiKey: string, id: string, publicKey: string) {
    return nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${apiKey}` } })
      .patch(`/v3/user/webhooks/event/settings/signed/${id}`)
      .reply(200, { id, public_key: publicKey });
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

  async function markVerified(userId: string) {
    await db.update(user).set({ emailVerified: true }).where(eq(user.id, userId));
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

  async function verifiedOwner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    await markVerified(account.userId);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  async function connectKey(cookie: string, slug: string) {
    mockScopes(VALID_KEY);
    mockVerifiedSenders(VALID_KEY);
    mockWebhookListing(VALID_KEY);
    mockWebhookCreate(VALID_KEY, "wh_health_1");
    mockSignedEnable(VALID_KEY, "wh_health_1", "PUBLICKEYVALUE");

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/sendgrid-key`,
      headers: { cookie },
      payload: { apiKey: VALID_KEY },
    });
    expect(res.statusCode, `connect failed: ${res.body}`).toBe(200);
  }

  it("GET health returns { connected: false, provisionStatus: 'pending', lastEventAt: null } before any key is connected", async () => {
    const { cookie, workspace } = await verifiedOwner("health-empty");

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/webhook-health`,
      headers: { cookie },
    });

    expect(res.statusCode, `GET health failed: ${res.body}`).toBe(200);
    expect(res.json()).toEqual({ connected: false, provisionStatus: "pending", lastEventAt: null });
  });

  it("GET health returns connected:true/provisionStatus:'active' after a successful connect, and never leaks pathToken/publicKey", async () => {
    const { cookie, workspace } = await verifiedOwner("health-active");
    await connectKey(cookie, workspace.slug);

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/webhook-health`,
      headers: { cookie },
    });

    expect(res.statusCode, `GET health failed: ${res.body}`).toBe(200);
    const body = res.json();
    expect(body.connected).toBe(true);
    expect(body.provisionStatus).toBe("active");
    expect(body).not.toHaveProperty("pathToken");
    expect(body).not.toHaveProperty("publicKey");
  });

  it("GET health is readable by a plain Member (not over-restricted to Owner/Admin)", async () => {
    const { workspace } = await verifiedOwner("health-member-owner");
    const memberEmail = `health-member-${Date.now()}@example.com`;
    const memberAccount = await signUp(memberEmail, "correct horse battery staple 42", "Health Member");
    await markVerified(memberAccount.userId);
    await db.insert(member).values({ organizationId: workspace.id, userId: memberAccount.userId, role: "member" });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/webhook-health`,
      headers: { cookie: memberAccount.cookie },
    });

    expect(res.statusCode, `member GET failed: ${res.body}`).toBe(200);
  });

  it("GET health returns the same generic 404 for an authenticated non-member as for a nonexistent workspace (no enumeration oracle)", async () => {
    const { workspace } = await verifiedOwner("health-nonmember-owner");
    const outsider = await signUp(`health-outsider-${Date.now()}@example.com`, "correct horse battery staple 42", "Outsider");
    await markVerified(outsider.userId);

    const nonMemberRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/webhook-health`,
      headers: { cookie: outsider.cookie },
    });
    const missingWorkspaceRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/does-not-exist-${Date.now()}/webhook-health`,
      headers: { cookie: outsider.cookie },
    });

    expect(nonMemberRes.statusCode).toBe(404);
    expect(nonMemberRes.json()).toEqual(missingWorkspaceRes.json());
  });

  it("POST reconnect refuses a Member with 403 while the Owner succeeds", async () => {
    const { cookie: ownerCookie, workspace } = await verifiedOwner("reconnect-role-owner");
    await connectKey(ownerCookie, workspace.slug);

    const memberEmail = `reconnect-member-${Date.now()}@example.com`;
    const memberAccount = await signUp(memberEmail, "correct horse battery staple 42", "Reconnect Member");
    await markVerified(memberAccount.userId);
    await db.insert(member).values({ organizationId: workspace.id, userId: memberAccount.userId, role: "member" });

    const memberRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/webhook-reconnect`,
      headers: { cookie: memberAccount.cookie },
    });
    expect(memberRes.statusCode).toBe(403);

    mockScopes(VALID_KEY);
    mockWebhookPatch(VALID_KEY, "wh_health_1");
    mockSignedEnable(VALID_KEY, "wh_health_1", "PUBLICKEYVALUE_RECONNECT");

    const ownerRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/webhook-reconnect`,
      headers: { cookie: ownerCookie },
    });
    expect(ownerRes.statusCode, `owner reconnect failed: ${ownerRes.body}`).toBe(200);
    expect(ownerRes.json()).toEqual({ connected: true, provisionStatus: "active", lastEventAt: null });
  });

  it("POST reconnect PATCHes the existing sendgridWebhookId in place (reuses stored pathToken, no duplicate create)", async () => {
    const { cookie, workspace } = await verifiedOwner("reconnect-reuse");
    await connectKey(cookie, workspace.slug);

    const before = await withTenant(workspace.id, () => getWebhookEndpointByWorkspace());

    mockScopes(VALID_KEY);
    mockWebhookPatch(VALID_KEY, "wh_health_1");
    mockSignedEnable(VALID_KEY, "wh_health_1", "PUBLICKEYVALUE_2");

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/webhook-reconnect`,
      headers: { cookie },
    });

    expect(res.statusCode, `reconnect failed: ${res.body}`).toBe(200);

    const after = await withTenant(workspace.id, () => getWebhookEndpointByWorkspace());
    expect(after?.pathToken).toBe(before?.pathToken);
    expect(after?.sendgridWebhookId).toBe("wh_health_1");
    expect(after?.publicKey).toBe("PUBLICKEYVALUE_2");
  });

  it("POST reconnect returns 404 when no SendGrid key has ever been connected", async () => {
    const { cookie, workspace } = await verifiedOwner("reconnect-no-key");

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/webhook-reconnect`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
  });
});
