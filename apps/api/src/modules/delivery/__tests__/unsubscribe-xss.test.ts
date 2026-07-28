import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUnsubscribeToken } from "@mega-crm/delivery-core";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * CR-01/WR-05: the public GET /unsubscribe/:token confirm page must never
 * reflect an attacker-controlled token into executable HTML, and every
 * response must carry a script-blocking Content-Security-Policy header
 * (@fastify/helmet). RFC 8058 one-click POST unsubscribe (SUBS-04) must keep
 * working end-to-end.
 */
describe("Public unsubscribe XSS + security headers hardening (CR-01, WR-05)", () => {
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

  /**
   * Builds an HTML-attribute-breaking injection sequence at runtime (never
   * written literally in this file) that would escape the
   * `action="/unsubscribe/${token}"` double-quoted attribute and open a new
   * `<script>` element if reflected unescaped.
   */
  function buildAttributeBreakoutPayload(): string {
    const dq = String.fromCharCode(34); // "
    const lt = String.fromCharCode(60); // <
    const gt = String.fromCharCode(62); // >
    const tag = ["s", "c", "r", "i", "p", "t"].join("");
    const call = ["a", "l", "e", "r", "t", "(", "1", ")"].join("");
    return `${dq}${gt}${lt}${tag}${gt}${call}${lt}/${tag}${gt}`;
  }

  it("GET does not reflect an HTML-attribute-breaking token unescaped into the form action", async () => {
    const payload = buildAttributeBreakoutPayload();
    const res = await app.inject({
      method: "GET",
      url: `/unsubscribe/${encodeURIComponent(payload)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(payload);
  });

  it("GET does not echo a malformed token (fails the base64url shape) at all", async () => {
    const malformedToken = `no-dot-marker-${randomUUID().replace(/-/g, "")}`;
    const res = await app.inject({
      method: "GET",
      url: `/unsubscribe/${malformedToken}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(malformedToken);
  });

  it("GET with a genuinely valid signed token round-trips the token unchanged into the form action", async () => {
    const { workspace } = await owner("unsub-xss-valid-roundtrip");
    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: randomUUID(),
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await app.inject({ method: "GET", url: `/unsubscribe/${token}` });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="/unsubscribe/${token}"`);
  });

  it("every response carries a Content-Security-Policy header", async () => {
    const res = await app.inject({ method: "GET", url: "/unsubscribe/whatever-token-shape" });

    expect(res.headers["content-security-policy"]).toBeTruthy();
  });

  it("POST with a valid signed token still unsubscribes the contact and returns 2xx", async () => {
    const { cookie, workspace } = await owner("unsub-xss-post-still-works");
    const contact = await createContact(
      cookie,
      workspace.slug,
      `xss-post-still-works-${Date.now()}@example.com`
    );
    expect(contact.subscriptionStatus).toBe("subscribed");

    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await app.inject({ method: "POST", url: `/unsubscribe/${token}` });
    expect(res.statusCode).toBeLessThan(300);

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("unsubscribed");
  });
});
