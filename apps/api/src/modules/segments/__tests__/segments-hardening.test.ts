import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 03-06 gap closure (WR-03/CR-01): HTTP-level regression coverage for
 * paths preview-count.test.ts didn't exercise --
 *
 * 1. Unknown/empty standard field over HTTP on POST /segments (not just
 *    preview-count) returns 400, not 500 (the 03-05 STANDARD_FIELD_KEYS
 *    allow-list boundary proven over the save path too).
 * 2. A tags/has_tag segment round-trips create -> members over HTTP.
 *
 * Does NOT attempt to force a real statement_timeout cancellation on the
 * save path -- there is no reliable automated trigger at test-data volume.
 * The 57014-cancellation MECHANISM (SET LOCAL/set_config statement_timeout
 * surfacing Postgres code 57014) is already proven directly by
 * preview-count.test.ts's "SET LOCAL statement_timeout cancels a slow query
 * with 57014" case; Task 1's wiring (statementTimeoutMs threaded into
 * create/update/members + the 57014->4xx catch blocks) is verified by a
 * clean `npm run build -w apps/api` and this suite staying green, not by a
 * dedicated timeout-trip test here.
 */
describe("segments hardening (03-06 gap closure)", () => {
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
    return res.json<{ id: string }>();
  }

  it("CR-01: POST /segments with an unknown standard field returns 400, not 500", async () => {
    const { cookie, workspace } = await owner("hardening-unknown-field");

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/segments`,
      headers: { cookie },
      payload: {
        name: "Unknown field segment",
        definition: {
          version: 1,
          groups: [
            {
              conditions: [
                { type: "attribute", source: "standard", field: "totallyUnknownField", operator: "eq", value: "x" },
              ],
            },
          ],
        },
      },
    });
    expect(res.statusCode, `expected 400, got: ${res.body}`).toBe(400);
  });

  it("CR-01: POST /segments with an empty standard field returns 400, not 500", async () => {
    const { cookie, workspace } = await owner("hardening-empty-field");

    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/segments`,
      headers: { cookie },
      payload: {
        name: "Empty field segment",
        definition: {
          version: 1,
          groups: [{ conditions: [{ type: "attribute", source: "standard", field: "", operator: "eq", value: "x" }] }],
        },
      },
    });
    expect(res.statusCode, `expected 400, got: ${res.body}`).toBe(400);
  });

  it("SEGM-01: a tags/has_tag segment round-trips create -> members over HTTP", async () => {
    const { cookie, workspace } = await owner("hardening-tags");
    const taggedContact = await createContact(cookie, workspace.slug, {
      email: `hardening-tags-vip-${Date.now()}@example.com`,
      tags: ["vip"],
    });
    await createContact(cookie, workspace.slug, {
      email: `hardening-tags-nontag-${Date.now()}@example.com`,
      tags: [],
    });

    const definition = {
      version: 1,
      groups: [
        { conditions: [{ type: "attribute", source: "standard", field: "tags", operator: "has_tag", value: "vip" }] },
      ],
    };

    const createRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/segments`,
      headers: { cookie },
      payload: { name: "VIP tag segment", definition },
    });
    expect(createRes.statusCode, `create failed: ${createRes.body}`).toBe(201);
    const created = createRes.json();
    expect(created.memberCount).toBe(1);
    expect(created.memberCountAt).not.toBeNull();

    const membersRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/segments/${created.id}/members`,
      headers: { cookie },
    });
    expect(membersRes.statusCode, `members failed: ${membersRes.body}`).toBe(200);
    const membersBody = membersRes.json();
    expect(membersBody.total).toBe(1);
    expect(membersBody.items.map((c: { id: string }) => c.id)).toEqual([taggedContact.id]);
  });
});
