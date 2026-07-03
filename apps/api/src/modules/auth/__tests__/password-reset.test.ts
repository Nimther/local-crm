import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

interface CapturedMailBody {
  from: { email: string };
  content: Array<{ type: string; value: string }>;
}

/**
 * D-02/D-03: better-auth's request-password-reset -> reset-password flow
 * dispatches through the platform mail path (never a tenant key) and the
 * issued token actually sets a new password that authenticates. Also proves
 * a freshly registered user is reported not-verified via isEmailVerified
 * (the per-action gate helper 01-05 will enforce on SendGrid-key-connect).
 */
describe("password reset + verification state (D-02/D-03)", () => {
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
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
  }

  it("dispatches a reset email through the platform mail path and the issued token sets a new password that authenticates", async () => {
    const email = `reset-${Date.now()}@example.com`;
    const oldPassword = "correct horse battery staple 42";
    const newPassword = "new correct horse battery staple 99";
    await signUp(email, oldPassword, "Reset User");

    let capturedBody: CapturedMailBody | undefined;
    const scope = nock("https://api.sendgrid.com")
      .post("/v3/mail/send", (body: CapturedMailBody) => {
        capturedBody = body;
        return true;
      })
      .reply(202, "", { "x-message-id": "reset-flow-test" });

    const reqRes = await app.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      payload: { email },
    });
    expect(reqRes.statusCode, `request-password-reset failed: ${reqRes.body}`).toBe(200);
    expect(scope.isDone()).toBe(true);

    const html = capturedBody?.content.find((c) => c.type === "text/html")?.value;
    expect(html, "reset email should contain the in-repo reset-password template").toContain(
      "MEGA_CRM_RESET_PASSWORD_TEMPLATE"
    );
    const match = html?.match(/token=([^"&\s]+)/);
    expect(match, "reset email HTML did not contain a token in its link").toBeTruthy();
    const token = decodeURIComponent(match![1]);

    const resetRes = await app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      payload: { newPassword, token },
    });
    expect(resetRes.statusCode, `reset-password failed: ${resetRes.body}`).toBe(200);

    const signInRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password: newPassword },
    });
    expect(signInRes.statusCode, `sign-in with new password failed: ${signInRes.body}`).toBe(200);
  });

  it("reports a freshly registered user as not email-verified", async () => {
    const email = `unverified-${Date.now()}@example.com`;
    const { cookie } = await signUp(email, "correct horse battery staple 42", "Unverified User");

    const { isEmailVerified } = await import("../verification-gate.js");

    const sessionRes = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie },
    });
    expect(sessionRes.statusCode, `get-session failed: ${sessionRes.body}`).toBe(200);
    const session = sessionRes.json();

    expect(isEmailVerified(session)).toBe(false);
  });
});
