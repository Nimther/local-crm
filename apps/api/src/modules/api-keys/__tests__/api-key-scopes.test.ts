import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { generateApiKey } from "../api-key-auth.js";
import { createApiKey, revokeApiKey } from "../api-keys.repository.js";

/**
 * Phase 10 plan 10-10 (SEC-06, D-06/D-07): per-route API-key scope
 * enforcement. `workspace_api_keys.scopes` moves from "reserved for v2 and
 * unused" to an enforced set-membership check on every API-key route.
 *
 * D-06 locks the taxonomy as `resource:action` pairs covering the two
 * API-key route modules that exist today: `contacts:read`, `contacts:write`,
 * `events:write`. Written RED (task 1) before `requireApiKeyScope` exists --
 * task 2 makes this file GREEN without touching it.
 */
describe("API-key route scope enforcement (D-06/D-07)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string;

  const CONTACTS_READ = "contacts:read";
  const CONTACTS_WRITE = "contacts:write";
  const EVENTS_WRITE = "events:write";
  const FULL_SCOPE_SET = [CONTACTS_READ, CONTACTS_WRITE, EVENTS_WRITE];

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();

    const email = `api-key-scopes-${Date.now()}@example.com`;
    const signUpRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password: "correct horse battery staple 42", name: "API Key Scopes Owner" },
    });
    expect(signUpRes.statusCode, `sign-up failed: ${signUpRes.body}`).toBe(200);
    const sessionCookie = signUpRes.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-up response did not set a session cookie");
    }
    const cookie = `${sessionCookie.name}=${sessionCookie.value}`;

    const workspaceRes = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name: "API Key Scopes Co" },
    });
    expect(workspaceRes.statusCode, `create workspace failed: ${workspaceRes.body}`).toBe(200);
    const workspace = workspaceRes.json<{ id: string; slug: string }>();
    workspaceId = workspace.id;
    testCookie = cookie;
    testSlug = workspace.slug;
  });

  afterAll(async () => {
    await app.close();
  });

  let testCookie: string;
  let testSlug: string;

  /**
   * Mints a key holding EXACTLY the given scopes by writing directly to
   * `workspace_api_keys` -- the management route offers no scope picker in
   * this phase (D-07 defers it), so the fixture sets scopes itself.
   */
  async function mintKeyWithScopes(name: string, scopes: string[]) {
    const generated = generateApiKey();
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(
          `INSERT INTO workspace_api_keys (id, workspace_id, name, secret_hash, key_mask, scopes)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [generated.id, workspaceId, name, generated.secretHash, generated.keyMask, scopes]
        );
      })
    );
    return generated;
  }

  function contactsBody() {
    return { externalId: `contact-${Date.now()}-${Math.random()}`, email: `c-${Date.now()}@example.com` };
  }

  function eventsBody() {
    return [{ name: "test_event", externalId: `contact-${Date.now()}-${Math.random()}` }];
  }

  it("Test 1: a key holding the full scope set reaches POST /v1/contacts successfully", async () => {
    const generated = await mintKeyWithScopes("full-scope-contacts", FULL_SCOPE_SET);
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${generated.fullKey}` },
      payload: contactsBody(),
    });
    expect(res.statusCode, `full-scope key rejected on /v1/contacts: ${res.body}`).toBe(200);
  });

  it("Test 2: a key holding only the events scope is refused on POST /v1/contacts with 403", async () => {
    const generated = await mintKeyWithScopes("events-only", [EVENTS_WRITE]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${generated.fullKey}` },
      payload: contactsBody(),
    });
    expect(res.statusCode, `events-only key should be refused on /v1/contacts: ${res.body}`).toBe(403);
  });

  it("Test 3: a key holding only the contacts scopes is refused on POST /v1/events with 403", async () => {
    const generated = await mintKeyWithScopes("contacts-only", [CONTACTS_READ, CONTACTS_WRITE]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${generated.fullKey}` },
      payload: eventsBody(),
    });
    expect(res.statusCode, `contacts-only key should be refused on /v1/events: ${res.body}`).toBe(403);
  });

  it("Test 4: a key whose scope list is empty is refused on both routes with 403", async () => {
    const generated = await mintKeyWithScopes("empty-scope", []);

    const contactsRes = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${generated.fullKey}` },
      payload: contactsBody(),
    });
    expect(contactsRes.statusCode, `empty-scope key should be refused on /v1/contacts: ${contactsRes.body}`).toBe(
      403
    );

    const eventsRes = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${generated.fullKey}` },
      payload: eventsBody(),
    });
    expect(eventsRes.statusCode, `empty-scope key should be refused on /v1/events: ${eventsRes.body}`).toBe(403);
  });

  it("Test 5: the 403 body is byte-identical across two different scoped routes for the same key, and names no scope", async () => {
    const generated = await mintKeyWithScopes("empty-scope-body-shape", []);

    const contactsRes = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${generated.fullKey}` },
      payload: contactsBody(),
    });
    const eventsRes = await app.inject({
      method: "POST",
      url: "/v1/events",
      headers: { authorization: `Bearer ${generated.fullKey}` },
      payload: eventsBody(),
    });

    expect(contactsRes.statusCode).toBe(403);
    expect(eventsRes.statusCode).toBe(403);
    expect(contactsRes.json()).toEqual(eventsRes.json());

    const bodyText = contactsRes.body;
    for (const scope of FULL_SCOPE_SET) {
      expect(bodyText).not.toContain(scope);
    }
  });

  it("Test 6: a revoked or invalid key still gets 401, not 403 -- the scope check runs after authentication, never instead of it", async () => {
    const generated = await mintKeyWithScopes("to-revoke", FULL_SCOPE_SET);
    await withTenant(workspaceId, () => revokeApiKey(generated.id));

    const revokedRes = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${generated.fullKey}` },
      payload: contactsBody(),
    });
    expect(revokedRes.statusCode, `revoked key must 401, not 403: ${revokedRes.body}`).toBe(401);

    const unknown = generateApiKey();
    const invalidRes = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { authorization: `Bearer ${unknown.fullKey}` },
      payload: contactsBody(),
    });
    expect(invalidRes.statusCode, `unknown key must 401, not 403: ${invalidRes.body}`).toBe(401);
  });

  it("Test 7: a key created through the management route after this change has the full scope set persisted", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${testSlug}/api-keys`,
      headers: { cookie: testCookie },
      payload: { name: "management-created-key" },
    });
    expect(createRes.statusCode, `management-route key creation failed: ${createRes.body}`).toBe(200);
    const created = createRes.json<{ id: string }>();

    const row = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ scopes: string[] }>(
          `SELECT scopes FROM workspace_api_keys WHERE id = $1`,
          [created.id]
        );
        return rows[0];
      })
    );

    expect(row).toBeDefined();
    expect(new Set(row.scopes)).toEqual(new Set(FULL_SCOPE_SET));
  });

  it("Test 8: every route in the API-key route modules is covered by this file", () => {
    // The route-enumeration set this file actually exercises (Tests 1-6):
    // POST /v1/contacts and POST /v1/events.
    const exercisedRoutes = new Set(["POST /v1/contacts", "POST /v1/events"]);

    // Enumerate the routes ACTUALLY registered on the built Fastify instance,
    // filtered to the API-key-authenticated prefix (`/v1/*`, CONT-03/EVNT-01)
    // -- so a future route added under this prefix without a corresponding
    // test in this file fails this assertion instead of silently shipping
    // unscoped.
    const routesText = app.printRoutes({ commonPrefix: false });
    const registeredRoutes = new Set<string>();
    for (const line of routesText.split("\n")) {
      const match = line.match(/(\/v1\/\S+)\s+\(([^)]+)\)/);
      if (!match) continue;
      const [, routePath, methodsGroup] = match;
      for (const method of methodsGroup.split(",").map((m) => m.trim())) {
        if (method === "HEAD" || method === "OPTIONS") continue;
        registeredRoutes.add(`${method} ${routePath}`);
      }
    }

    expect(registeredRoutes.size, "expected at least one /v1/* route to be registered").toBeGreaterThan(0);
    expect(registeredRoutes).toEqual(exercisedRoutes);
  });

  it("createApiKey persists the full scope set for a key created without an explicit scopes argument", async () => {
    const generated = generateApiKey();
    await withTenant(workspaceId, () =>
      createApiKey({
        id: generated.id,
        name: "repository-default-scope",
        secretHash: generated.secretHash,
        keyMask: generated.keyMask,
      })
    );

    const row = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ scopes: string[] }>(
          `SELECT scopes FROM workspace_api_keys WHERE id = $1`,
          [generated.id]
        );
        return rows[0];
      })
    );

    expect(new Set(row.scopes)).toEqual(new Set(FULL_SCOPE_SET));
  });
});
