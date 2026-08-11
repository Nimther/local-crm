import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUnsubscribeToken } from "@mega-crm/delivery-core";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * Public RFC 8058 one-click unsubscribe endpoint (SUBS-04, D-15,
 * T-04-03-01/02/03): POST mutates + is RFC-8058-compliant, GET never
 * mutates, and forged/unknown-contact tokens are indistinguishable from
 * genuine ones in the response.
 */
describe("Public unsubscribe endpoint (SUBS-04, D-15)", () => {
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
    return res.json() as { id: string; slug: string; name: string };
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
    return res.json() as { id: string; subscriptionStatus: string; email: string };
  }

  async function getContact(cookie: string, slug: string, id: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${slug}/contacts/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode, `get contact failed: ${res.body}`).toBe(200);
    return res.json() as { id: string; subscriptionStatus: string };
  }

  function futureExp(): number {
    return Math.floor(Date.now() / 1000) + 3600;
  }

  it("POST with a valid token sets subscription_status to unsubscribed and returns 200 with an empty body", async () => {
    const { cookie, workspace } = await owner("unsub-post-valid");
    const contact = await createContact(cookie, workspace.slug, `post-valid-${Date.now()}@example.com`);
    expect(contact.subscriptionStatus).toBe("subscribed");

    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await app.inject({ method: "POST", url: `/unsubscribe/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("unsubscribed");
  });

  it("POST is idempotent: re-posting an already-unsubscribed contact's token stays 200 with an empty body", async () => {
    const { cookie, workspace } = await owner("unsub-post-idempotent");
    const contact = await createContact(
      cookie,
      workspace.slug,
      `post-idempotent-${Date.now()}@example.com`
    );
    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const first = await app.inject({ method: "POST", url: `/unsubscribe/${token}` });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: "POST", url: `/unsubscribe/${token}` });
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("unsubscribed");
  });

  it("GET renders an HTML confirm page and does NOT mutate subscription_status", async () => {
    const { cookie, workspace } = await owner("unsub-get-nonmutating");
    const contact = await createContact(cookie, workspace.slug, `get-safe-${Date.now()}@example.com`);
    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await app.inject({ method: "GET", url: `/unsubscribe/${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Отписаться");

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("subscribed");
  });

  it("GET renders the identical page for a garbage/forged token as for a genuine one (enumeration-oracle safety)", async () => {
    const { cookie, workspace } = await owner("unsub-get-identical");
    const contact = await createContact(
      cookie,
      workspace.slug,
      `get-identical-${Date.now()}@example.com`
    );
    const genuineToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });
    const forgedToken = "forged.garbage-token-value";

    const genuineRes = await app.inject({ method: "GET", url: `/unsubscribe/${genuineToken}` });
    // The confirm form's action embeds the token itself, so compare the page
    // shape with each token substituted for a placeholder rather than raw bytes.
    const normalize = (body: string, token: string) => body.split(token).join("__TOKEN__");
    const forgedRes = await app.inject({ method: "GET", url: `/unsubscribe/${forgedToken}` });

    expect(forgedRes.statusCode).toBe(genuineRes.statusCode);
    expect(normalize(forgedRes.body, forgedToken)).toBe(normalize(genuineRes.body, genuineToken));
  });

  it("POST produces byte-identical responses for a forged token and a valid-but-unknown-contact token", async () => {
    const { workspace } = await owner("unsub-post-identical");

    const forgedToken = "forged.garbage-token-value";
    const unknownContactToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: randomUUID(), // no such contact exists
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const forgedRes = await app.inject({ method: "POST", url: `/unsubscribe/${forgedToken}` });
    const unknownRes = await app.inject({ method: "POST", url: `/unsubscribe/${unknownContactToken}` });

    expect(forgedRes.statusCode).toBe(unknownRes.statusCode);
    expect(forgedRes.body).toBe(unknownRes.body);
    expect(forgedRes.statusCode).toBe(200);
    expect(forgedRes.body).toBe("");
  });

  it("POST with an expired token does not mutate and matches the invalid-token response", async () => {
    const { cookie, workspace } = await owner("unsub-post-expired");
    const contact = await createContact(cookie, workspace.slug, `expired-${Date.now()}@example.com`);
    const expiredToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: Math.floor(Date.now() / 1000) - 3600, // already expired
    });

    const res = await app.inject({ method: "POST", url: `/unsubscribe/${expiredToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("subscribed");
  });
});
