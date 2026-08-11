import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signUnsubscribeToken } from "@mega-crm/delivery-core";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * CR-01 regression (04-19): a test-send's List-Unsubscribe token used to be
 * signed with the literal placeholder string "test-send" as its contactId
 * (a pre-04-19 bug, fixed at the root in the worker). This suite pins the
 * API-side defense-in-depth guard: redeeming a signature-valid token whose
 * contactId is NOT a canonical UUID (a "test-send-shaped" token) must never
 * reach the uuid-typed `contacts.id` column, must never 500, must not
 * mutate any contact, and must stay byte-identical to the existing
 * unknown-but-valid-UUID-contact response (T-04-03-02 / T-04-19-02).
 */
describe("Public unsubscribe endpoint -- test-send-shaped (non-UUID contactId) tokens (CR-01)", () => {
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

  it("POST with a test-send-shaped (non-UUID contactId) token returns 200 with an empty body, byte-identical to an unknown-but-valid-UUID contact token", async () => {
    const { workspace } = await owner("unsub-testsend-identical");

    const testSendToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: "test-send", // pre-04-19 placeholder shape: signature-valid, not UUID-shaped
      workspaceId: workspace.id,
      exp: futureExp(),
    });
    const unknownContactToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: randomUUID(), // no such contact exists, but UUID-shaped
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const testSendRes = await app.inject({ method: "POST", url: `/unsubscribe/${testSendToken}` });
    const unknownRes = await app.inject({ method: "POST", url: `/unsubscribe/${unknownContactToken}` });

    expect(testSendRes.statusCode).toBe(200);
    expect(testSendRes.body).toBe("");
    expect(testSendRes.statusCode).toBe(unknownRes.statusCode);
    expect(testSendRes.body).toBe(unknownRes.body);
  });

  it("POST with a test-send-shaped token does not mutate a real subscribed contact in the same workspace", async () => {
    const { cookie, workspace } = await owner("unsub-testsend-nomutate");
    const contact = await createContact(
      cookie,
      workspace.slug,
      `testsend-nomutate-${Date.now()}@example.com`
    );
    expect(contact.subscriptionStatus).toBe("subscribed");

    const testSendToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: "test-send",
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await app.inject({ method: "POST", url: `/unsubscribe/${testSendToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("subscribed");
  });

  it("GET with a test-send-shaped token still returns 200 HTML (no crash)", async () => {
    const { workspace } = await owner("unsub-testsend-get");
    const testSendToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: "test-send",
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await app.inject({ method: "GET", url: `/unsubscribe/${testSendToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});
