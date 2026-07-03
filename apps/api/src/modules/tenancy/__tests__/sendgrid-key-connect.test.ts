import nock from "nock";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, member, user } from "@mega-crm/db";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant } from "../../../middleware/tenant-context.js";
import { getKey } from "../sendgrid-key.repository.js";

const VALID_KEY = "SG.mock_valid_key_for_testing_1234567890abcdef";
const INVALID_KEY = "SG.mock_invalid_or_revoked_key_00000000000000";
const NO_SCOPE_KEY = "SG.mock_key_without_mail_send_scope_999999999999";

const INVALID_KEY_COPY =
  "SendGrid отклонил ключ: он недействителен или отозван. Проверьте ключ в настройках SendGrid и вставьте его заново.";
const MISSING_SCOPE_COPY =
  "Ключ действителен, но не имеет права mail.send. Создайте в SendGrid ключ с доступом Mail Send и подключите его.";
const UNVERIFIED_COPY =
  "Подтвердите email, чтобы подключить SendGrid. Мы отправили письмо со ссылкой — проверьте почту.";

/**
 * SendGrid key connect (TENANT-04, D-02/D-19/D-21): live validation
 * (mail.send scope + verified senders), envelope-encrypted storage, and the
 * Owner/Admin + verified-email gates. Mocks the SendGrid HTTP API with nock
 * (never a real network call).
 */
describe("SendGrid key connect (TENANT-04, D-02/D-19/D-21)", () => {
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

  function mockScopes(apiKey: string, scopes: string[] | null) {
    return nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${apiKey}` } })
      .get("/v3/scopes")
      .reply(scopes ? 200 : 401, scopes ? { scopes } : { errors: [{ message: "Unauthorized" }] });
  }

  function mockVerifiedSenders(apiKey: string) {
    return nock("https://api.sendgrid.com", { reqheaders: { authorization: `Bearer ${apiKey}` } })
      .get("/v3/verified_senders")
      .reply(200, { results: [{ id: 1, from_email: "hello@tenant.example", nickname: "Main" }] });
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

  it("connects a valid key with mail.send: validates, stores it, and returns verified senders", async () => {
    const { cookie, workspace } = await verifiedOwner("connect-owner");
    mockScopes(VALID_KEY, ["mail.send", "sender_verification_eui"]);
    mockVerifiedSenders(VALID_KEY);

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie },
      payload: { apiKey: VALID_KEY },
    });

    expect(res.statusCode, `connect failed: ${res.body}`).toBe(200);
    const body = res.json();
    expect(body.connected).toBe(true);
    expect(body.status).toBe("active");
    expect(body.verifiedSenders).toEqual([{ id: 1, fromEmail: "hello@tenant.example", nickname: "Main" }]);
    expect(body.keyMask).toMatch(/^.+…\w{4}$/);
  });

  it("rejects an invalid/revoked key with the exact SendGrid-rejected copy", async () => {
    const { cookie, workspace } = await verifiedOwner("invalid-owner");
    mockScopes(INVALID_KEY, null);

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie },
      payload: { apiKey: INVALID_KEY },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe(INVALID_KEY_COPY);
  });

  it("rejects a key missing the mail.send scope with the exact missing-scope copy", async () => {
    const { cookie, workspace } = await verifiedOwner("noscope-owner");
    mockScopes(NO_SCOPE_KEY, ["some.other.scope"]);

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie },
      payload: { apiKey: NO_SCOPE_KEY },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe(MISSING_SCOPE_COPY);
  });

  it("refuses a Member session with 403 while the Owner succeeds", async () => {
    const { cookie: ownerCookie, workspace } = await verifiedOwner("role-owner");
    const memberEmail = `role-member-${Date.now()}@example.com`;
    const memberAccount = await signUp(memberEmail, "correct horse battery staple 42", "Role Member");
    await markVerified(memberAccount.userId);
    await db.insert(member).values({ organizationId: workspace.id, userId: memberAccount.userId, role: "member" });

    mockScopes(VALID_KEY, ["mail.send"]);

    const memberRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie: memberAccount.cookie },
      payload: { apiKey: VALID_KEY },
    });
    expect(memberRes.statusCode).toBe(403);

    mockVerifiedSenders(VALID_KEY);
    const ownerRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie: ownerCookie },
      payload: { apiKey: VALID_KEY },
    });
    expect(ownerRes.statusCode, `owner connect failed: ${ownerRes.body}`).toBe(200);
  });

  it("blocks connect for an unverified-email Owner with the exact verify-email copy", async () => {
    const email = `unverified-owner-${Date.now()}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", "Unverified Owner");
    // Deliberately NOT marked verified -- fresh sign-up defaults to unverified (D-02).
    const workspace = await createWorkspace(account.cookie, "Unverified Co");

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie: account.cookie },
      payload: { apiKey: VALID_KEY },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(UNVERIFIED_COPY);
  });

  it("stores the key envelope-encrypted at rest -- no column contains the plaintext key", async () => {
    const { cookie, workspace } = await verifiedOwner("noplaintext-owner");
    mockScopes(VALID_KEY, ["mail.send"]);
    mockVerifiedSenders(VALID_KEY);

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/sendgrid-key`,
      headers: { cookie },
      payload: { apiKey: VALID_KEY },
    });
    expect(res.statusCode, `connect failed: ${res.body}`).toBe(200);

    const row = await withTenant(workspace.id, () => getKey());
    expect(row).not.toBeNull();
    expect(row?.ciphertext).not.toContain(VALID_KEY);
    expect(row?.encryptedDek).not.toContain(VALID_KEY);
    expect(Buffer.from(row!.ciphertext, "base64").toString("utf8")).not.toContain(VALID_KEY);
    expect(row?.keyMask).toMatch(/^.+…\w{4}$/);
    expect(row?.keyMask).not.toBe(VALID_KEY);
  });
});
