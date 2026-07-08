import nock from "nock";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, user } from "@mega-crm/db";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant } from "../../../middleware/tenant-context.js";
import { getWebhookEndpointByWorkspace } from "../../webhooks/webhook-endpoint.repository.js";

const VALID_KEY = "SG.mock_webhook_provisioning_key_1234567890ab";

/**
 * D-01/D-02/D-05: best-effort SendGrid Event Webhook auto-provisioning
 * triggered from the SAME connect/recheck routes covered by
 * sendgrid-key-connect.test.ts. This file focuses specifically on the
 * provisioning side effect (persisted endpoint row + graceful degradation),
 * not the key-connect validation behavior itself (already covered there).
 */
describe("SendGrid key connect/recheck webhook provisioning (D-01/D-02/D-05)", () => {
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

  it("connect best-effort provisions the platform's Event Webhook and persists {pathToken, sendgridWebhookId, publicKey, provisionStatus: 'active'}", async () => {
    const { cookie, workspace } = await verifiedOwner("provision-success");

    mockScopes(VALID_KEY);
    mockVerifiedSenders(VALID_KEY);
    mockWebhookListing(VALID_KEY);
    mockWebhookCreate(VALID_KEY, "wh_success_1");
    mockSignedEnable(VALID_KEY, "wh_success_1", "PUBLICKEYVALUE");

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie },
      payload: { apiKey: VALID_KEY },
    });

    expect(res.statusCode, `connect failed: ${res.body}`).toBe(200);
    expect(res.json()).not.toHaveProperty("webhookWarning");

    const endpoint = await withTenant(workspace.id, () => getWebhookEndpointByWorkspace());
    expect(endpoint).not.toBeNull();
    expect(endpoint?.sendgridWebhookId).toBe("wh_success_1");
    expect(endpoint?.publicKey).toBe("PUBLICKEYVALUE");
    expect(endpoint?.provisionStatus).toBe("active");
    expect(endpoint?.pathToken).toMatch(/^[\w-]+$/);
  });

  it("a provisioning failure (403 missing scope) degrades gracefully -- connect still returns 200 with a webhookWarning, and provisionStatus 'error' persisted", async () => {
    const { cookie, workspace } = await verifiedOwner("provision-scope-fail");

    mockScopes(VALID_KEY);
    mockVerifiedSenders(VALID_KEY);
    nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${VALID_KEY}` } })
      .get("/v3/user/webhooks/event/settings/all")
      .reply(403, { errors: [{ message: "Forbidden" }] });
    nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${VALID_KEY}` } })
      .post("/v3/user/webhooks/event/settings")
      .reply(403, { errors: [{ message: "Forbidden" }] });

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie },
      payload: { apiKey: VALID_KEY },
    });

    expect(res.statusCode, `connect failed: ${res.body}`).toBe(200);
    expect(res.json().connected).toBe(true);
    expect(typeof res.json().webhookWarning).toBe("string");

    const endpoint = await withTenant(workspace.id, () => getWebhookEndpointByWorkspace());
    expect(endpoint?.provisionStatus).toBe("error");
  });

  it("recheck reuses the stored pathToken and PATCHes the existing sendgridWebhookId in place (no duplicate create)", async () => {
    const { cookie, workspace } = await verifiedOwner("provision-reconnect");

    mockScopes(VALID_KEY);
    mockVerifiedSenders(VALID_KEY);
    mockWebhookListing(VALID_KEY);
    mockWebhookCreate(VALID_KEY, "wh_reconnect_1");
    mockSignedEnable(VALID_KEY, "wh_reconnect_1", "PUBLICKEYVALUE_1");

    const connectRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie },
      payload: { apiKey: VALID_KEY },
    });
    expect(connectRes.statusCode, `connect failed: ${connectRes.body}`).toBe(200);

    const firstEndpoint = await withTenant(workspace.id, () => getWebhookEndpointByWorkspace());
    const firstPathToken = firstEndpoint?.pathToken;
    expect(firstEndpoint?.sendgridWebhookId).toBe("wh_reconnect_1");

    // Second round: ONLY a PATCH-in-place + signed-enable interceptor is
    // registered (no listing, no create) -- if the code path incorrectly
    // re-POSTed a create, this would fall through to nock's no-match error
    // instead of succeeding, catching a regression of Pitfall 4.
    mockScopes(VALID_KEY);
    mockVerifiedSenders(VALID_KEY);
    mockWebhookPatch(VALID_KEY, "wh_reconnect_1");
    mockSignedEnable(VALID_KEY, "wh_reconnect_1", "PUBLICKEYVALUE_2");

    const recheckRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key/recheck`,
      headers: { cookie },
    });
    expect(recheckRes.statusCode, `recheck failed: ${recheckRes.body}`).toBe(200);

    const secondEndpoint = await withTenant(workspace.id, () => getWebhookEndpointByWorkspace());
    expect(secondEndpoint?.pathToken).toBe(firstPathToken);
    expect(secondEndpoint?.sendgridWebhookId).toBe("wh_reconnect_1");
    expect(secondEndpoint?.publicKey).toBe("PUBLICKEYVALUE_2");
    expect(secondEndpoint?.provisionStatus).toBe("active");
  });
});
