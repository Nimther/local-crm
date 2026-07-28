import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * Contacts integration API (CONT-03): API-key-authed /v1/contacts, distinct
 * from the session-authed CRUD routes (contacts.routes.ts) -- a tenant
 * backend creates/updates contacts server-to-server, no cookie/session
 * involved. Mints a real key through the Owner/Admin-gated management route
 * (api-keys-management.test.ts's pattern) and drives POST /v1/contacts with
 * `Authorization: Bearer <key>`.
 */
describe("Contacts integration API (CONT-03, D-02)", () => {
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

  async function mintApiKey(cookie: string, slug: string, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/api-keys`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create api key failed: ${res.body}`).toBe(200);
    return (res.json<{ fullKey: string }>()).fullKey;
  }

  async function ownerWithKey(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    const fullKey = await mintApiKey(account.cookie, workspace.slug, "prod backend");
    return { ...account, workspace, fullKey };
  }

  it("missing Authorization header -> 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      payload: { email: "nope@example.com" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("invalid API key -> 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: {
        authorization: "Bearer mcrm_0000000000000000.invalidsecretvaluexxxxxxxxxxxxxxxxxxxxxxxxx",
      },
      payload: { email: "nope@example.com" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("valid key: creates a new contact and returns its resolved id", async () => {
    const { fullKey } = await ownerWithKey("v1-create");
    const email = `v1-create-${Date.now()}@example.com`;

    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: { email, externalId: "v1-ext-1", firstName: "Ada" },
    });

    expect(res.statusCode, `create via v1 failed: ${res.body}`).toBe(200);
    const body = res.json<{ id: string }>();
    expect(body.id).toBeTruthy();
  });

  it("valid key: a second call matched by external_id updates the same contact", async () => {
    const { fullKey, cookie, workspace } = await ownerWithKey("v1-update");
    const email = `v1-update-${Date.now()}@example.com`;

    const createRes = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: { email, externalId: "v1-update-ext" },
    });
    expect(createRes.statusCode, `create via v1 failed: ${createRes.body}`).toBe(200);
    const created = createRes.json<{ id: string }>();

    const updateRes = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: { externalId: "v1-update-ext", firstName: "Updated Via API" },
    });
    expect(updateRes.statusCode, `update via v1 failed: ${updateRes.body}`).toBe(200);
    const updated = updateRes.json<{ id: string }>();
    expect(updated.id).toBe(created.id);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/contacts/${created.id}`,
      headers: { cookie },
    });
    expect(getRes.statusCode, `session get failed: ${getRes.body}`).toBe(200);
    expect((getRes.json<{ firstName: string }>()).firstName).toBe("Updated Via API");
  });

  it("D-02: rejects a payload with neither email nor externalId", async () => {
    const { fullKey } = await ownerWithKey("v1-d02");

    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${fullKey}` },
      payload: { firstName: "No Identifier" },
    });

    expect([400, 422]).toContain(res.statusCode);
  });
});
