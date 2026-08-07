import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../test/db-fixture.js";

/**
 * SEC-10/SEC-15: the platform-wide anti-enumeration contract. A missing
 * resource and a cross-tenant (forbidden) resource must be indistinguishable
 * -- same HTTP status, byte-identical response body -- on every
 * session-authenticated route, and the same holds for a nonexistent workspace
 * slug vs. a workspace slug the caller isn't a member of.
 *
 * This is a parameterized sweep, not a one-off assertion: `resourceCases`
 * drives every covered route through a single missing-vs-foreign comparison.
 * A NEW resource route is expected to add a row here, not a new bespoke
 * test file -- that is what keeps this a platform-wide guarantee instead of
 * nine independently-written 404 branches happening to agree (which is
 * exactly the bug class plan 10-02's `resolveWorkspaceMember` +
 * `NOT_FOUND_BODY` and this sweep together close).
 *
 * "segment-scoped analytics resource" (plan 10-04's coverage requirement) is
 * represented by `GET /segments/:id/members` -- D-12's paginated membership
 * list that drives the segment detail page's analytics-adjacent contact
 * list, existence-gated on the same `getSegment(id)` check as the segment
 * resource itself.
 */
describe("Anti-enumeration sweep (SEC-10, SEC-15)", () => {
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

  async function createSegmentFixture(cookie: string, slug: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/segments`,
      headers: { cookie },
      payload: {
        name,
        definition: {
          version: 1,
          groups: [{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] }],
        },
      },
    });
    expect(res.statusCode, `create segment failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  async function createCampaignFixture(cookie: string, slug: string, segmentId: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/campaigns`,
      headers: { cookie },
      payload: { name, segmentId },
    });
    expect(res.statusCode, `create campaign failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  async function createFlowFixture(cookie: string, slug: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/flows`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create flow failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  async function createApiKeyFixture(cookie: string, slug: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/api-keys`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create api key failed: ${res.body}`).toBe(200);
    return res.json<{ id: string }>();
  }

  async function insertSend(workspaceId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, 'campaign', 'sent', now())
           RETURNING id`,
          [workspaceId, contactId]
        );
        return rows[0].id;
      })
    );
  }

  async function insertCsvImport(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO csv_imports (workspace_id, file_name, created_by_user_id)
           VALUES ($1, 'fixture.csv', 'fixture-user')
           RETURNING id`,
          [workspaceId]
        );
        return rows[0].id;
      })
    );
  }

  interface SweepCase {
    name: string;
    method: "GET" | "POST";
    buildPath: (slug: string, id: string) => string;
  }

  /**
   * The platform-wide route matrix. Add one row here for a new
   * resource-scoped route -- never a bespoke test file.
   */
  const resourceCases: SweepCase[] = [
    { name: "contact", method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/contacts/${id}` },
    { name: "campaign", method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/campaigns/${id}` },
    { name: "flow", method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/flows/${id}` },
    { name: "flow analytics", method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/flows/${id}/analytics` },
    { name: "segment", method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/segments/${id}` },
    {
      name: "segment members",
      method: "GET",
      buildPath: (slug, id) => `/api/workspaces/${slug}/segments/${id}/members`,
    },
    { name: "send-log entry", method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/send-log/${id}/events` },
    { name: "csv import", method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/imports/${id}` },
    { name: "api key", method: "POST", buildPath: (slug, id) => `/api/workspaces/${slug}/api-keys/${id}/revoke` },
  ];

  /** A syntactically valid id that exists in no workspace. */
  const MISSING_ID = randomUUID();

  let cookieA: string;
  let cookieB: string;
  let workspaceA: { id: string; slug: string; name: string };
  let workspaceB: { id: string; slug: string; name: string };
  let contactAId: string;
  let foreignIds: Record<string, string>;

  beforeAll(async () => {
    const a = await owner("sweep-a");
    const b = await owner("sweep-b");
    cookieA = a.cookie;
    cookieB = b.cookie;
    workspaceA = a.workspace;
    workspaceB = b.workspace;

    const contactA = await createContact(cookieA, workspaceA.slug, {
      email: `sweep-a-contact-${Date.now()}@example.com`,
    });
    contactAId = contactA.id;

    const contactB = await createContact(cookieB, workspaceB.slug, {
      email: `sweep-b-contact-${Date.now()}@example.com`,
    });
    const segmentB = await createSegmentFixture(cookieB, workspaceB.slug, "Sweep segment B");
    const campaignB = await createCampaignFixture(cookieB, workspaceB.slug, segmentB.id, "Sweep campaign B");
    const flowB = await createFlowFixture(cookieB, workspaceB.slug, "Sweep flow B");
    const sendBId = await insertSend(workspaceB.id, contactB.id);
    const csvImportBId = await insertCsvImport(workspaceB.id);
    const apiKeyB = await createApiKeyFixture(cookieB, workspaceB.slug, "sweep key B");

    foreignIds = {
      contact: contactB.id,
      campaign: campaignB.id,
      flow: flowB.id,
      "flow analytics": flowB.id,
      segment: segmentB.id,
      "segment members": segmentB.id,
      "send-log entry": sendBId,
      "csv import": csvImportBId,
      "api key": apiKeyB.id,
    };
  });

  it.each(resourceCases)(
    "$name: a missing id and a cross-tenant (workspace B) id return byte-identical status + body under workspace A",
    async ({ method, buildPath, name }) => {
      const foreignId = foreignIds[name];

      const missingRes = await app.inject({
        method,
        url: buildPath(workspaceA.slug, MISSING_ID),
        headers: { cookie: cookieA },
      });
      const foreignRes = await app.inject({
        method,
        url: buildPath(workspaceA.slug, foreignId),
        headers: { cookie: cookieA },
      });

      expect(
        foreignRes.statusCode,
        `${name}: status mismatch (missing=${missingRes.statusCode} foreign=${foreignRes.statusCode})`
      ).toBe(missingRes.statusCode);
      expect(
        foreignRes.body,
        `${name}: body mismatch\n  missing=${missingRes.body}\n  foreign=${foreignRes.body}`
      ).toBe(missingRes.body);
    }
  );

  it("workspace-level (resolveWorkspaceMember route): a nonexistent slug and workspace B's slug return byte-identical 404 for a workspace-A-only member", async () => {
    const nonexistentSlugRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/nonexistent-slug-${randomUUID()}/contacts`,
      headers: { cookie: cookieA },
    });
    const nonMemberSlugRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceB.slug}/contacts`,
      headers: { cookie: cookieA },
    });

    expect(nonMemberSlugRes.statusCode).toBe(nonexistentSlugRes.statusCode);
    expect(nonMemberSlugRes.body).toBe(nonexistentSlugRes.body);
  });

  // T-10-04-02: `requirePermission`'s own workspace-existence check
  // (role-guard.ts) is a SEPARATE code path from `resolveWorkspaceMember`'s
  // -- this proves it independently, on a route gated purely by
  // `requirePermission` (api-keys list carries no `resolveWorkspaceMember`
  // call at all).
  it("workspace-level (requirePermission route, T-10-04-02): a nonexistent slug and workspace B's slug return byte-identical 404 for a workspace-A-only member", async () => {
    const nonexistentSlugRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/nonexistent-slug-${randomUUID()}/api-keys`,
      headers: { cookie: cookieA },
    });
    const nonMemberSlugRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceB.slug}/api-keys`,
      headers: { cookie: cookieA },
    });

    expect(nonMemberSlugRes.statusCode).toBe(nonexistentSlugRes.statusCode);
    expect(nonMemberSlugRes.body).toBe(nonexistentSlugRes.body);
  });

  // Negative/positive control (plan 10-04 Task 1 behavior): proves the
  // fixture actually reaches the handler for a real, own-workspace resource
  // -- without this, every 404-equality assertion above could pass
  // vacuously (e.g. both requests 401ing before either handler runs).
  it("positive control: workspace A's own resource returns 200 through the same authenticated fixture", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceA.slug}/contacts/${contactAId}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode, `own-resource GET failed: ${res.body}`).toBe(200);
  });
});
