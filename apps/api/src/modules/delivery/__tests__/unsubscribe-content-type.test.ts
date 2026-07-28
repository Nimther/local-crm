import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUnsubscribeToken } from "@mega-crm/delivery-core";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * Regression coverage for SUBS-04 / CR-01: Fastify's default content-type
 * parser set (application/json + text/plain) rejects
 * application/x-www-form-urlencoded with 415 FST_ERR_CTP_INVALID_MEDIA_TYPE
 * *before* the route handler runs. Neither of the two real-world POST shapes
 * that hit /unsubscribe/:token -- a mailbox provider's RFC 8058 one-click
 * POST, nor the confirm page's own <form method="POST"> submit -- ever
 * reached the handler. The existing unsubscribe.test.ts / unsubscribe-xss.test.ts
 * suites never set an explicit Content-Type header, so app.inject takes the
 * empty-body fast path and silently misses this defect -- every POST here
 * MUST pass an explicit content-type header to actually exercise the parser.
 */
describe("Public unsubscribe content-type parsing (SUBS-04, CR-01)", () => {
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

  async function createContact(cookie: string, slug: string, email: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload: { email },
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json<{ id: string; subscriptionStatus: string; email: string }>();
  }

  async function getContact(cookie: string, slug: string, id: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${slug}/contacts/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode, `get contact failed: ${res.body}`).toBe(200);
    return res.json<{ id: string; subscriptionStatus: string }>();
  }

  function futureExp(): number {
    return Math.floor(Date.now() / 1000) + 3600;
  }

  it("RFC 8058 one-click POST (urlencoded, List-Unsubscribe=One-Click body) returns 2xx and unsubscribes the contact", async () => {
    const { cookie, workspace } = await owner("unsub-ct-oneclick");
    const contact = await createContact(
      cookie,
      workspace.slug,
      `ct-oneclick-${Date.now()}@example.com`
    );
    expect(contact.subscriptionStatus).toBe("subscribed");

    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/unsubscribe/${token}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    expect(res.statusCode).toBeLessThan(300);

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("unsubscribed");
  });

  it("confirm-page form POST (urlencoded, empty body) returns 2xx and unsubscribes the contact", async () => {
    const { cookie, workspace } = await owner("unsub-ct-form");
    const contact = await createContact(cookie, workspace.slug, `ct-form-${Date.now()}@example.com`);
    expect(contact.subscriptionStatus).toBe("subscribed");

    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/unsubscribe/${token}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    expect(res.statusCode).toBeLessThan(300);

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("unsubscribed");
  });

  it("an unregistered content type (application/xml) on the same route still returns 415 (scope guard)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/unsubscribe/any-token-value.sig",
      headers: { "content-type": "application/xml" },
      payload: "<x/>",
    });
    expect(res.statusCode).toBe(415);
  });
});
