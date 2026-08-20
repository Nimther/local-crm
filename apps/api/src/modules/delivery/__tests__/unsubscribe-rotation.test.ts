import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { signUnsubscribeToken } from "@mega-crm/delivery-core";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * End-to-end coverage for graceful unsubscribe-secret rotation (ROT-01,
 * ROT-02, D-08). Simulates D-08's completed two-step rotation at the process
 * level: sign a token while the primary is secret A, then set the primary to
 * secret B and put A into the previous list, then redeem through the real
 * RFC 8058 one-click POST route (harness copied from
 * unsubscribe-content-type.test.ts — same buildServer()/ensureTestDbMigrated()
 * setup and owner/createContact/getContact helpers).
 *
 * Every secret literal below is >= 32 chars and contains no comma/whitespace
 * (D-03's charset contract). Env vars are captured in beforeAll and restored
 * in afterEach/afterAll so no state leaks between tests or files.
 */
describe("Unsubscribe secret graceful rotation (ROT-01, ROT-02, SC1/SC3, D-08)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  const ROTATION_SECRET_A = "rotation-a-secret-at-least-32-bytes-long-000";
  const ROTATION_SECRET_B = "rotation-b-secret-at-least-32-bytes-long-111";
  const UNLISTED_SECRET = "unlisted-secret-never-in-any-list-32-bytes222";

  let originalPrimary: string | undefined;
  let originalPrevious: string | undefined;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    originalPrimary = process.env.UNSUBSCRIBE_TOKEN_SECRET;
    originalPrevious = process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    app = await buildServer();
    await app.ready();
  });

  function restoreSecretEnv() {
    if (originalPrimary === undefined) {
      delete process.env.UNSUBSCRIBE_TOKEN_SECRET;
    } else {
      process.env.UNSUBSCRIBE_TOKEN_SECRET = originalPrimary;
    }
    if (originalPrevious === undefined) {
      delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    } else {
      process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = originalPrevious;
    }
  }

  afterEach(() => {
    restoreSecretEnv();
  });

  afterAll(async () => {
    restoreSecretEnv();
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

  async function postOneClick(token: string) {
    return app.inject({
      method: "POST",
      url: `/unsubscribe/${token}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
  }

  it("Test 1 (ROT-01/SC1): a link signed BEFORE rotation (secret A) still unsubscribes after the primary rotates to B", async () => {
    const { cookie, workspace } = await owner("unsub-rot-pre");
    const contact = await createContact(
      cookie,
      workspace.slug,
      `rot-pre-${Date.now()}@example.com`
    );
    expect(contact.subscriptionStatus).toBe("subscribed");

    // Sign while the primary is the pre-rotation secret A.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = ROTATION_SECRET_A;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    // Complete D-08's two-step rotation: primary becomes B, A moves into
    // the previous list.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = ROTATION_SECRET_B;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = ROTATION_SECRET_A;

    const res = await postOneClick(token);
    expect(res.statusCode).toBeLessThan(300);

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("unsubscribed");
  });

  it("Test 2 (ROT-01/SC1): a link signed AFTER rotation (new primary B) also unsubscribes", async () => {
    const { cookie, workspace } = await owner("unsub-rot-post");
    const contact = await createContact(
      cookie,
      workspace.slug,
      `rot-post-${Date.now()}@example.com`
    );
    expect(contact.subscriptionStatus).toBe("subscribed");

    // Post-rotation env: primary is the new B, previous holds retired A.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = ROTATION_SECRET_B;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = ROTATION_SECRET_A;

    const token = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    const res = await postOneClick(token);
    expect(res.statusCode).toBeLessThan(300);

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("unsubscribed");
  });

  it("Test 3 (negative control): a token signed by a secret that is neither primary nor previous does not unsubscribe, and its response is byte-identical to a structurally forged token's", async () => {
    const { cookie, workspace } = await owner("unsub-rot-neg");
    const contact = await createContact(
      cookie,
      workspace.slug,
      `rot-neg-${Date.now()}@example.com`
    );
    expect(contact.subscriptionStatus).toBe("subscribed");

    // Sign with a secret that will never appear in either the primary or
    // the previous list.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = UNLISTED_SECRET;
    delete process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
    const unlistedToken = signUnsubscribeToken({
      sendId: randomUUID(),
      contactId: contact.id,
      workspaceId: workspace.id,
      exp: futureExp(),
    });

    // Restore the post-rotation env (B primary, A previous) before redeeming
    // -- this is the env the running process actually verifies against.
    process.env.UNSUBSCRIBE_TOKEN_SECRET = ROTATION_SECRET_B;
    process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS = ROTATION_SECRET_A;

    // A structurally forged token: same encoded payload, garbage signature.
    const [encodedPayload] = unlistedToken.split(".");
    const forgedSignature = Buffer.from("not-the-real-signature-at-all").toString("base64url");
    const forgedToken = `${encodedPayload}.${forgedSignature}`;

    const unlistedRes = await postOneClick(unlistedToken);
    const forgedRes = await postOneClick(forgedToken);

    expect(unlistedRes.statusCode).toBe(forgedRes.statusCode);
    expect(unlistedRes.body).toBe(forgedRes.body);
    expect(unlistedRes.statusCode).toBeLessThan(300);

    const after = await getContact(cookie, workspace.slug, contact.id);
    expect(after.subscriptionStatus).toBe("subscribed");
  });
});
