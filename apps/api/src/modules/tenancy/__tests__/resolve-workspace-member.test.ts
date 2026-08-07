import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { resolveWorkspaceMember, NOT_FOUND_BODY } from "../resolve-workspace-member.js";

/**
 * SEC-14: the single shared `resolveWorkspaceMember` implementation. Drives
 * the real HTTP stack via Fastify's `.inject()` -- mirrors the sign-up +
 * create-workspace harness from contact-crud.test.ts -- rather than mocking
 * Better Auth. A test-only route (registered directly on the built app,
 * before `.ready()`) calls `resolveWorkspaceMember` exactly the way every
 * route module will after task 2, so these tests exercise the real
 * `getCallerRoles` / better-auth membership-resolution path.
 */
describe("resolveWorkspaceMember (SEC-14)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();

    // Test-only route: exercises the shared resolver exactly as every real
    // route module will post-task-2 -- `if (!resolved) return;` (reply
    // already sent by the resolver), else send the resolution.
    app.get("/__test/resolve-workspace-member/:slug", async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const resolved = await resolveWorkspaceMember(request, reply, slug);
      if (!resolved) return;
      return reply.send({ workspaceId: resolved.workspace.id, roles: resolved.roles });
    });

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

  function resolveUrl(slug: string) {
    return `/__test/resolve-workspace-member/${slug}`;
  }

  it("Test 1: an unknown slug resolves to null and the reply carries status 404 with the shared body", async () => {
    const res = await app.inject({ method: "GET", url: resolveUrl(`does-not-exist-${Date.now()}`) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND_BODY);
  });

  it("Test 2: a soft-deleted workspace's slug resolves to null with the identical status and body as Test 1", async () => {
    const { cookie, workspace } = await owner("rwm-soft-deleted");

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie },
      payload: { confirmName: workspace.name },
    });
    expect(deleteRes.statusCode, `soft-delete failed: ${deleteRes.body}`).toBe(200);

    const res = await app.inject({ method: "GET", url: resolveUrl(workspace.slug) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND_BODY);
  });

  it("Test 3: an existing workspace with an unauthenticated caller resolves to null with the identical status and body as Test 1", async () => {
    const { workspace } = await owner("rwm-unauth");

    const res = await app.inject({ method: "GET", url: resolveUrl(workspace.slug) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND_BODY);
  });

  it("Test 4: an existing workspace with an authenticated caller who is NOT a member resolves to null with the identical status and body as Test 1", async () => {
    const { workspace } = await owner("rwm-outsider-target");
    const outsider = await signUp(
      `rwm-outsider-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Outsider"
    );

    const res = await app.inject({
      method: "GET",
      url: resolveUrl(workspace.slug),
      headers: { cookie: outsider.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND_BODY);
  });

  it("Test 5: an existing workspace with an authenticated member returns { workspace, roles } and sends no reply itself", async () => {
    const { cookie, workspace } = await owner("rwm-member-success");

    const res = await app.inject({
      method: "GET",
      url: resolveUrl(workspace.slug),
      headers: { cookie },
    });

    // If resolveWorkspaceMember had already sent a reply (the failure
    // branches), the test route's own reply.send() below would throw
    // ("reply already sent"), surfacing as a 500 here instead of 200 --
    // so a clean 200 IS the proof that resolveWorkspaceMember sent nothing.
    expect(res.statusCode, `resolve failed: ${res.body}`).toBe(200);
    const body = res.json<{ workspaceId: string; roles: string[] }>();
    expect(body.workspaceId).toBe(workspace.id);
    expect(body.roles).toContain("owner");
  });

  it("Test 6: the serialized reply payloads captured in Tests 1-4 are byte-identical to each other", async () => {
    const unknownSlugRes = await app.inject({ method: "GET", url: resolveUrl(`does-not-exist-${Date.now()}`) });

    const { cookie: deletedOwnerCookie, workspace: deletedWorkspace } = await owner("rwm-t6-soft-deleted");
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${deletedWorkspace.slug}`,
      headers: { cookie: deletedOwnerCookie },
      payload: { confirmName: deletedWorkspace.name },
    });
    expect(deleteRes.statusCode, `soft-delete failed: ${deleteRes.body}`).toBe(200);
    const softDeletedRes = await app.inject({ method: "GET", url: resolveUrl(deletedWorkspace.slug) });

    const { workspace: unauthWorkspace } = await owner("rwm-t6-unauth");
    const unauthenticatedRes = await app.inject({ method: "GET", url: resolveUrl(unauthWorkspace.slug) });

    const { workspace: nonMemberWorkspace } = await owner("rwm-t6-nonmember-target");
    const outsider = await signUp(
      `rwm-t6-outsider-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "T6 Outsider"
    );
    const nonMemberRes = await app.inject({
      method: "GET",
      url: resolveUrl(nonMemberWorkspace.slug),
      headers: { cookie: outsider.cookie },
    });

    const responses = [unknownSlugRes, softDeletedRes, unauthenticatedRes, nonMemberRes];

    for (const res of responses) {
      expect(res.statusCode).toBe(404);
    }

    const bodies = responses.map((res) => res.body);
    for (const body of bodies) {
      expect(body).toBe(bodies[0]);
    }
  });
});
