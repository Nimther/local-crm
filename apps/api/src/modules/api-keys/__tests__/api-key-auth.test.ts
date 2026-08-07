import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { withTenant } from "../../../middleware/tenant-context.js";
import { generateApiKey, apiKeyAuth } from "../api-key-auth.js";
import { createApiKey, lookupApiKeyById, revokeApiKey } from "../api-keys.repository.js";

/**
 * apiKeyAuth (Pattern 3, D-21/D-22/D-23, T-02-03-01/T-02-03-02): the
 * onRequest hook that resolves workspace_id from a presented
 * `Bearer mcrm_<id>.<secret>` key -- the auth mechanism the Contacts API
 * (CONT-03) and Event API (EVNT-01) will run behind. Exercises the hook via
 * a tiny standalone Fastify route so it's tested in isolation from the
 * Owner/Admin-gated management routes (covered by
 * api-keys-management.test.ts).
 */
describe("apiKeyAuth (D-21/D-22/D-23, T-02-03-01/T-02-03-02)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let workspaceId: string;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();

    const email = `api-key-auth-${Date.now()}@example.com`;
    const signUpRes = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password: "correct horse battery staple 42", name: "API Key Auth Owner" },
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
      payload: { name: "API Key Auth Co" },
    });
    expect(workspaceRes.statusCode, `create workspace failed: ${workspaceRes.body}`).toBe(200);
    workspaceId = (workspaceRes.json<{ id: string }>()).id;
  });

  afterAll(async () => {
    await app.close();
  });

  function buildProtectedApp() {
    const protectedApp = Fastify();
    protectedApp.get("/protected", { onRequest: apiKeyAuth }, async (request, reply) => {
      return reply.send({ workspaceId: request.apiKeyWorkspaceId });
    });
    return protectedApp;
  }

  it("generateApiKey returns a high-entropy mcrm_<id>.<secret> key with a SHA-256 hash and a prefix+last4 mask (D-22)", () => {
    const generated = generateApiKey();
    expect(generated.fullKey).toMatch(/^mcrm_[0-9a-f]{16}\.[\w-]+$/);
    expect(generated.secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.keyMask.startsWith("mcrm_")).toBe(true);

    const [, secret] = generated.fullKey.split(".");
    // >= 32 bytes of entropy -- base64url of 32 random bytes is 43 chars (no padding).
    expect(secret.length).toBeGreaterThanOrEqual(43);
  });

  it("valid key: sets request.apiKeyWorkspaceId to the key's workspace", async () => {
    const protectedApp = buildProtectedApp();
    const generated = generateApiKey();
    await withTenant(workspaceId, () =>
      createApiKey({
        id: generated.id,
        name: "prod backend",
        secretHash: generated.secretHash,
        keyMask: generated.keyMask,
      })
    );

    const res = await protectedApp.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${generated.fullKey}` },
    });

    expect(res.statusCode, `valid key rejected: ${res.body}`).toBe(200);
    expect(res.json().workspaceId).toBe(workspaceId);
  });

  it("missing Authorization header -> 401", async () => {
    const protectedApp = buildProtectedApp();
    const res = await protectedApp.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
  });

  it("malformed token (no id.secret shape) -> 401", async () => {
    const protectedApp = buildProtectedApp();
    const res = await protectedApp.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer not-a-real-key" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("unknown-prefix and known-prefix-wrong-secret produce an IDENTICAL 401 body (T-02-03-02: uniform 401, no enumeration oracle)", async () => {
    const protectedApp = buildProtectedApp();
    const generated = generateApiKey();
    await withTenant(workspaceId, () =>
      createApiKey({
        id: generated.id,
        name: "uniform-401 key",
        secretHash: generated.secretHash,
        keyMask: generated.keyMask,
      })
    );

    const unknownPrefixRes = await protectedApp.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer mcrm_${"f".repeat(16)}.someRandomSecretValueXXXXXXXXXXXXXXXXXXXXXXX`,
      },
    });
    const wrongSecretRes = await protectedApp.inject({
      method: "GET",
      url: "/protected",
      headers: {
        authorization: `Bearer mcrm_${generated.id}.wrongSecretValueXXXXXXXXXXXXXXXXXXXXXXXXXXXX`,
      },
    });

    expect(unknownPrefixRes.statusCode).toBe(401);
    expect(wrongSecretRes.statusCode).toBe(401);
    expect(unknownPrefixRes.json()).toEqual(wrongSecretRes.json());
  });

  it("revoked key -> 401", async () => {
    const protectedApp = buildProtectedApp();
    const generated = generateApiKey();
    await withTenant(workspaceId, () =>
      createApiKey({
        id: generated.id,
        name: "to-revoke",
        secretHash: generated.secretHash,
        keyMask: generated.keyMask,
      })
    );
    await withTenant(workspaceId, () => revokeApiKey(generated.id));

    const res = await protectedApp.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${generated.fullKey}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // ---------------------------------------------------------------------
  // Phase 10 plan 10-07 (SEC-03/SEC-04): lookupApiKeyById runs through
  // withPreTenantLookup under migration 0044's fail-closed
  // workspace_isolation predicate. The end-to-end tests above already
  // exercise this indirectly via apiKeyAuth (valid key -> 200, unknown
  // id/wrong secret -> uniform 401); these two assert the repository
  // function's own return contract directly.
  // ---------------------------------------------------------------------

  it("lookupApiKeyById: returns the matching row for a valid key id after migration 0044, on a connection with no tenant context", async () => {
    const generated = generateApiKey();
    await withTenant(workspaceId, () =>
      createApiKey({
        id: generated.id,
        name: "pre-tenant-lookup fixture",
        secretHash: generated.secretHash,
        keyMask: generated.keyMask,
      })
    );

    const row = await lookupApiKeyById(generated.id);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(generated.id);
    expect(row?.workspaceId).toBe(workspaceId);
    expect(row?.secretHash).toBe(generated.secretHash);
  });

  it("lookupApiKeyById: returns null (not a thrown error) for an unknown key id", async () => {
    await expect(lookupApiKeyById(randomUUID())).resolves.toBeNull();
  });

  it("the stored row holds only a hash + mask -- never the plaintext secret (D-22)", async () => {
    const generated = generateApiKey();
    const [, secret] = generated.fullKey.split(".");
    const row = await withTenant(workspaceId, () =>
      createApiKey({
        id: generated.id,
        name: "no-plaintext",
        secretHash: generated.secretHash,
        keyMask: generated.keyMask,
      })
    );
    expect(row.keyMask).not.toContain(secret);
    expect(generated.secretHash).not.toContain(secret);
  });
});
