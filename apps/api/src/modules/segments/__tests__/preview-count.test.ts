import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { countSegmentMembers } from "../segment.repository.js";

/**
 * SEGM-04: live-preview count over HTTP for an UNSAVED definition, guarded
 * by a statement_timeout (D-08/T-03-04). Also proves segments.routes.ts's
 * registration + the 404-not-409 auth pattern for CRUD/members.
 */
describe("POST /segments/preview-count (SEGM-04)", () => {
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

  async function createContact(cookie: string, slug: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload,
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json() as { id: string };
  }

  it("returns an exact count matching seeded rows for a valid attribute definition", async () => {
    const { cookie, workspace } = await owner("preview-basic");
    await createContact(cookie, workspace.slug, { email: `preview-ru1-${Date.now()}@example.com`, country: "RU" });
    await createContact(cookie, workspace.slug, { email: `preview-ru2-${Date.now()}@example.com`, country: "RU" });
    await createContact(cookie, workspace.slug, { email: `preview-kz-${Date.now()}@example.com`, country: "KZ" });

    const definition = {
      version: 1,
      groups: [
        { conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/segments/preview-count`,
      headers: { cookie },
      payload: { definition },
    });
    expect(res.statusCode, `preview-count failed: ${res.body}`).toBe(200);
    expect(res.json()).toEqual({ count: 2 });
  });

  it("agrees exactly with countSegmentMembers called directly", async () => {
    const { cookie, workspace } = await owner("preview-agree");
    await createContact(cookie, workspace.slug, { email: `preview-agree1-${Date.now()}@example.com`, tags: ["vip"] });
    await createContact(cookie, workspace.slug, { email: `preview-agree2-${Date.now()}@example.com`, tags: [] });

    const definition = {
      version: 1 as const,
      groups: [
        {
          conditions: [
            { type: "attribute" as const, source: "standard" as const, field: "tags", operator: "has_tag" as const, value: "vip" },
          ],
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/segments/preview-count`,
      headers: { cookie },
      payload: { definition },
    });
    expect(res.statusCode, `preview-count failed: ${res.body}`).toBe(200);

    const directCount = await withTenant(workspace.id, () => countSegmentMembers(definition));
    expect(res.json()).toEqual({ count: directCount });
  });

  it("rejects an unknown-field definition with 400 before it ever reaches SQL", async () => {
    const { cookie, workspace } = await owner("preview-reject");

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/segments/preview-count`,
      headers: { cookie },
      payload: {
        definition: {
          version: 1,
          groups: [
            { conditions: [{ type: "attribute", source: "standard", field: "country", operator: "bogus_operator", value: "RU" }] },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("CRUD: create -> list -> get -> patch -> members -> delete round-trips over HTTP", async () => {
    const { cookie, workspace } = await owner("segments-crud");
    await createContact(cookie, workspace.slug, { email: `crud-member-${Date.now()}@example.com`, country: "RU" });

    const definition = {
      version: 1,
      groups: [
        { conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] },
      ],
    };

    const createRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/segments`,
      headers: { cookie },
      payload: { name: "RU segment", definition },
    });
    expect(createRes.statusCode, `create failed: ${createRes.body}`).toBe(201);
    const created = createRes.json();
    expect(created.name).toBe("RU segment");
    expect(created.memberCount).toBe(1);
    expect(created.memberCountAt).not.toBeNull();

    const listRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/segments`,
      headers: { cookie },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.map((s: { id: string }) => s.id)).toContain(created.id);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/segments/${created.id}`,
      headers: { cookie },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(created.id);

    const membersRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/segments/${created.id}/members`,
      headers: { cookie },
    });
    expect(membersRes.statusCode, `members failed: ${membersRes.body}`).toBe(200);
    expect(membersRes.json().total).toBe(1);
    expect(membersRes.json().items).toHaveLength(1);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/segments/${created.id}`,
      headers: { cookie },
      payload: { name: "RU segment renamed" },
    });
    expect(patchRes.statusCode, `patch failed: ${patchRes.body}`).toBe(200);
    expect(patchRes.json().name).toBe("RU segment renamed");

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/segments/${created.id}`,
      headers: { cookie },
    });
    expect(deleteRes.statusCode, `delete failed: ${deleteRes.body}`).toBe(200);

    const getAfterDeleteRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/segments/${created.id}`,
      headers: { cookie },
    });
    expect(getAfterDeleteRes.statusCode).toBe(404);
  });

  it("event-names picker returns distinct observed event names", async () => {
    const { cookie, workspace } = await owner("segments-event-names");

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/segments/event-names`,
      headers: { cookie },
    });
    expect(res.statusCode, `event-names failed: ${res.body}`).toBe(200);
    expect(Array.isArray(res.json().names)).toBe(true);
  });

  it("404-not-409: an unauthenticated request to a real segment route returns 404, not 401/403", async () => {
    const { workspace } = await owner("segments-auth-oracle");

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/segments`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("D-08/T-03-04: SET LOCAL statement_timeout cancels a slow query with Postgres code 57014 -- the exact code the route's catch block maps to { degraded: true }", async () => {
    const { workspace } = await owner("preview-timeout-mechanism");

    // Directly exercises the SAME mechanism countSegmentMembers uses
    // (SET LOCAL statement_timeout inside withTenantTransaction) against an
    // artificially slow query, since a real segment definition cannot
    // request pg_sleep. Confirms the assumption segments.routes.ts's catch
    // block depends on: a canceled statement surfaces as error code 57014.
    await expect(
      withTenant(workspace.id, () =>
        withTenantTransaction(async (client) => {
          await client.query("SET LOCAL statement_timeout = 50");
          await client.query("SELECT pg_sleep(1)");
        })
      )
    ).rejects.toMatchObject({ code: "57014" });
  });
});
