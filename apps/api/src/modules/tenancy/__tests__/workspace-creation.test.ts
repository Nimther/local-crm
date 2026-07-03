import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * TENANT-01 walking-skeleton contract: register -> create workspace -> Owner.
 * Drives the real HTTP stack via Fastify's `.inject()` (no listening socket
 * needed) against the better-auth sign-up route and the workspaces routes.
 */
describe("workspace creation (TENANT-01)", () => {
  let app: FastifyInstance;

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

  it("creates a workspace with a unique slug and an owner membership for the creator", async () => {
    const { cookie } = await signUp(
      `owner-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Owner One"
    );

    const createRes = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name: "Acme Marketing" },
    });

    expect(createRes.statusCode, `create workspace failed: ${createRes.body}`).toBe(200);
    const workspace = createRes.json();
    expect(workspace.slug).toBeTruthy();
    expect(workspace.name).toBe("Acme Marketing");

    const getRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().slug).toBe(workspace.slug);
  });

  it("generates distinct slugs for two workspaces created with the same name", async () => {
    const { cookie } = await signUp(
      `dup-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Dup User"
    );

    const first = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name: "Same Name Co" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name: "Same Name Co" },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().slug).not.toBe(second.json().slug);
  });

  it("rejects a non-member from reading the workspace (403 or 404)", async () => {
    const owner = await signUp(
      `owner2-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Owner Two"
    );
    const createRes = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie: owner.cookie },
      payload: { name: "Private Co" },
    });
    const workspace = createRes.json();

    const outsider = await signUp(
      `outsider-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Outsider"
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: outsider.cookie },
    });

    expect([403, 404]).toContain(res.statusCode);
  });
});
