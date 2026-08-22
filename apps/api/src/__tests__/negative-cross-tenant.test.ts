import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPreTenantLookup, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../test/db-fixture.js";

/**
 * SEC-16 (API half), SPEC R2: "no code path reachable from the public API can
 * obtain a cross-tenant read". Every prior plan in Phase 10 asserted its OWN
 * mechanism (a policy predicate, a role attribute, a grant, a response body).
 * This suite asserts the OUTCOME those mechanisms exist for, from the
 * outside: it actively ATTEMPTS a cross-tenant read/write through every
 * session-authenticated route module and asserts denial, rather than
 * asserting that a guard is registered or a policy exists. A route that
 * bypassed every one of the prior plans' mechanisms would still pass their
 * own tests (they never issue the forbidden request) but would fail here.
 *
 * Test 6's coverage assertion is the reason this file must be updated
 * alongside any new route module: it builds the expected module set from
 * `apps/api/src/server.ts`'s own `app.register(registerX...)` list, so a
 * module added later without a corresponding case in `COVERED_MODULES` or
 * `EXCLUDED_MODULES` below fails the suite rather than silently going
 * unchecked.
 *
 * Reuses plan 10-04's two-workspace fixture pattern
 * (anti-enumeration-sweep.test.ts) rather than importing from it -- every
 * existing multi-file fixture in this codebase (campaign-scheduler-scan.test.ts,
 * webhook-events-sibling-drop.test.ts) duplicates its own seed helpers rather
 * than sharing a fixture module across apps/api test files.
 */
describe("Negative cross-tenant suite: API surface (SEC-16)", () => {
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
    return res.json<{ id: string; fullKey: string }>();
  }

  async function createInviteFixture(cookie: string, slug: string, email: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/invites`,
      headers: { cookie },
      payload: { email, role: "member" },
    });
    expect(res.statusCode, `create invite failed: ${res.body}`).toBe(200);
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

  async function contactFirstName(workspaceId: string, contactId: string): Promise<string | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ firstName: string | null }>(
          `SELECT first_name as "firstName" FROM contacts WHERE id = $1`,
          [contactId]
        );
        return rows[0]?.firstName ?? null;
      })
    );
  }

  async function campaignName(workspaceId: string, campaignId: string): Promise<string | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ name: string }>(`SELECT name FROM campaigns WHERE id = $1`, [campaignId]);
        return rows[0]?.name;
      })
    );
  }

  async function flowName(workspaceId: string, flowId: string): Promise<string | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ name: string }>(`SELECT name FROM flows WHERE id = $1`, [flowId]);
        return rows[0]?.name;
      })
    );
  }

  async function segmentName(workspaceId: string, segmentId: string): Promise<string | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ name: string }>(`SELECT name FROM segments WHERE id = $1`, [segmentId]);
        return rows[0]?.name;
      })
    );
  }

  async function memberRoleRowExists(memberId: string): Promise<boolean> {
    // `member` is a better-auth table (mega_crm_auth-owned, not RLS-scoped by
    // this package's tenant pool) -- a plain query against the app pool
    // (which post-migration-0045 holds SELECT on it) is sufficient.
    const { pool } = await import("@mega-crm/tenant-context");
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM member WHERE id = $1`, [memberId]);
    return rows.length > 0;
  }

  async function invitationStatus(invitationId: string): Promise<string | undefined> {
    const { pool } = await import("@mega-crm/tenant-context");
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM invitation WHERE id = $1`, [invitationId]);
    return rows[0]?.status;
  }

  /** A syntactically valid id that exists in no workspace. */
  const MISSING_ID = randomUUID();

  let cookieA: string;
  let cookieB: string;
  let workspaceA: { id: string; slug: string; name: string };
  let workspaceB: { id: string; slug: string; name: string };
  let contactAId: string;

  let foreignContactId: string;
  let foreignCampaignId: string;
  let foreignFlowId: string;
  let foreignSegmentId: string;
  let foreignSendId: string;
  let foreignCsvImportId: string;
  let foreignApiKeyId: string;
  let foreignMemberId: string;
  let foreignInvitationId: string;

  beforeAll(async () => {
    const a = await owner("neg-a");
    const b = await owner("neg-b");
    cookieA = a.cookie;
    cookieB = b.cookie;
    workspaceA = a.workspace;
    workspaceB = b.workspace;

    const contactA = await createContact(cookieA, workspaceA.slug, {
      email: `neg-a-contact-${Date.now()}@example.com`,
    });
    contactAId = contactA.id;

    const contactB = await createContact(cookieB, workspaceB.slug, {
      email: `neg-b-contact-${Date.now()}@example.com`,
      externalId: "shared-ext-neg-b",
    });
    foreignContactId = contactB.id;

    const segmentB = await createSegmentFixture(cookieB, workspaceB.slug, "Negative-suite segment B");
    foreignSegmentId = segmentB.id;

    const campaignB = await createCampaignFixture(cookieB, workspaceB.slug, segmentB.id, "Negative-suite campaign B");
    foreignCampaignId = campaignB.id;

    const flowB = await createFlowFixture(cookieB, workspaceB.slug, "Negative-suite flow B");
    foreignFlowId = flowB.id;

    foreignSendId = await insertSend(workspaceB.id, contactB.id);
    foreignCsvImportId = await insertCsvImport(workspaceB.id);

    const apiKeyB = await createApiKeyFixture(cookieB, workspaceB.slug, "negative-suite key B");
    foreignApiKeyId = apiKeyB.id;

    // A second member of workspace B, so removing/role-changing it is a
    // meaningful attempt (an Owner cannot be removed via this route).
    const bMemberEmail = `neg-b-member-${Date.now()}@example.com`;
    const bMemberInvite = await createInviteFixture(cookieB, workspaceB.slug, bMemberEmail);
    const bMemberSignup = await signUp(bMemberEmail, "correct horse battery staple 42", "neg-b-member");
    await app.inject({
      method: "POST",
      url: `/api/invites/${bMemberInvite.id}/accept`,
      headers: { cookie: bMemberSignup.cookie },
    });
    const membersRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceB.slug}/members`,
      headers: { cookie: cookieB },
    });
    expect(membersRes.statusCode, `list members failed: ${membersRes.body}`).toBe(200);
    const members = membersRes.json<Array<{ id: string; email: string }>>();
    foreignMemberId = members.find((m) => m.email === bMemberEmail)!.id;

    const inviteB = await createInviteFixture(cookieB, workspaceB.slug, `neg-b-pending-${Date.now()}@example.com`);
    foreignInvitationId = inviteB.id;
  });

  // -------------------------------------------------------------------
  // Test 1 + Test 2: per-module read/write cross-tenant attempts, with
  // row-level verification for every write.
  // -------------------------------------------------------------------

  interface AttemptCase {
    module: string;
    name: string;
    read?: { method: "GET"; buildPath: (slug: string, id: string) => string };
    write?: {
      method: "PATCH" | "POST" | "DELETE";
      buildPath: (slug: string, id: string) => string;
      body?: Record<string, unknown>;
      /** Re-reads workspace B's row after the denied attempt and returns a stable snapshot. */
      snapshot: () => Promise<unknown>;
    };
    foreignId: () => string;
  }

  const ATTEMPT_CASES: AttemptCase[] = [
    {
      module: "registerContactsRoutes",
      name: "contact",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/contacts/${id}` },
      write: {
        method: "PATCH",
        buildPath: (slug, id) => `/api/workspaces/${slug}/contacts/${id}`,
        body: { firstName: "Hacked" },
        snapshot: () => contactFirstName(workspaceB.id, foreignContactId),
      },
      foreignId: () => foreignContactId,
    },
    {
      // Phase 21 (DSR-04/SC4): read-only route, no write attempt -- workspace
      // A's Owner (cookieA has full permissions in their own workspace) reads
      // workspace B's contact id through workspace A's slug and must get the
      // same 404 a nonexistent id gets (byte-identical, per SC4).
      module: "registerDsrExportRoutes",
      name: "dsr-export",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/contacts/${id}/dsr-export` },
      foreignId: () => foreignContactId,
    },
    {
      module: "registerCampaignsRoutes",
      name: "campaign",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/campaigns/${id}` },
      write: {
        method: "PATCH",
        buildPath: (slug, id) => `/api/workspaces/${slug}/campaigns/${id}`,
        body: { name: "Hacked campaign" },
        snapshot: () => campaignName(workspaceB.id, foreignCampaignId),
      },
      foreignId: () => foreignCampaignId,
    },
    {
      module: "registerFlowsRoutes",
      name: "flow",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/flows/${id}` },
      write: {
        method: "PATCH",
        buildPath: (slug, id) => `/api/workspaces/${slug}/flows/${id}`,
        body: { name: "Hacked flow" },
        snapshot: () => flowName(workspaceB.id, foreignFlowId),
      },
      foreignId: () => foreignFlowId,
    },
    {
      module: "registerSegmentsRoutes",
      name: "segment",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/segments/${id}` },
      write: {
        method: "PATCH",
        buildPath: (slug, id) => `/api/workspaces/${slug}/segments/${id}`,
        body: { name: "Hacked segment" },
        snapshot: () => segmentName(workspaceB.id, foreignSegmentId),
      },
      foreignId: () => foreignSegmentId,
    },
    {
      module: "registerSendLogRoutes",
      name: "send-log entry",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/send-log/${id}/events` },
      foreignId: () => foreignSendId,
    },
    {
      module: "registerCsvImportRoutes",
      name: "csv import",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/imports/${id}` },
      write: {
        method: "POST",
        buildPath: (slug, id) => `/api/workspaces/${slug}/imports/${id}/apply`,
        body: {},
        snapshot: () =>
          withTenant(workspaceB.id, () =>
            withTenantTransaction(async (client) => {
              const { rows } = await client.query<{ status: string }>(`SELECT status FROM csv_imports WHERE id = $1`, [
                foreignCsvImportId,
              ]);
              return rows[0]?.status;
            })
          ),
      },
      foreignId: () => foreignCsvImportId,
    },
    {
      module: "registerAnalyticsRoutes",
      name: "flow analytics",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/flows/${id}/analytics` },
      foreignId: () => foreignFlowId,
    },
    {
      module: "registerAnalyticsRoutes",
      name: "contact timeline",
      read: { method: "GET", buildPath: (slug, id) => `/api/workspaces/${slug}/contacts/${id}/timeline` },
      foreignId: () => foreignContactId,
    },
    {
      // api-keys has no id-scoped READ (only a workspace-scoped list) --
      // POST .../revoke is the module's only id-scoped route, so it is the
      // sole attempt covering this module (T-10-14 read-vs-write split
      // does not apply symmetrically to every module -- see this file's
      // top comment).
      module: "registerApiKeyRoutes",
      name: "api key",
      write: {
        method: "POST",
        buildPath: (slug, id) => `/api/workspaces/${slug}/api-keys/${id}/revoke`,
        body: {},
        snapshot: () =>
          withTenant(workspaceB.id, () =>
            withTenantTransaction(async (client) => {
              const { rows } = await client.query<{ revokedAt: string | null }>(
                `SELECT revoked_at as "revokedAt" FROM workspace_api_keys WHERE id = $1`,
                [foreignApiKeyId]
              );
              return rows[0]?.revokedAt ?? null;
            })
          ),
      },
      foreignId: () => foreignApiKeyId,
    },
    {
      // members has no id-scoped READ (only a workspace-scoped list) --
      // DELETE .../:memberId is the module's only id-scoped route.
      module: "registerMemberRoutes",
      name: "member",
      write: {
        method: "DELETE",
        buildPath: (slug, id) => `/api/workspaces/${slug}/members/${id}`,
        snapshot: () => memberRoleRowExists(foreignMemberId),
      },
      foreignId: () => foreignMemberId,
    },
    {
      // invites has no id-scoped READ under the SESSION-authed surface --
      // GET /api/invites/:id is deliberately public/unauthenticated (the
      // invitee has no account yet, see invites.ts's own doc comment), so
      // it is not a session-cross-tenant case; POST .../revoke is.
      module: "registerInviteRoutes",
      name: "invite",
      write: {
        method: "POST",
        buildPath: (slug, id) => `/api/workspaces/${slug}/invites/${id}/revoke`,
        body: {},
        snapshot: () => invitationStatus(foreignInvitationId),
      },
      foreignId: () => foreignInvitationId,
    },
  ];

  it.each(ATTEMPT_CASES.filter((c) => c.read))(
    "$name: workspace A member reading workspace B's resource is denied, same shape as a nonexistent id",
    async ({ read, foreignId }) => {
      const missingRes = await app.inject({
        method: read!.method,
        url: read!.buildPath(workspaceA.slug, MISSING_ID),
        headers: { cookie: cookieA },
      });
      const foreignRes = await app.inject({
        method: read!.method,
        url: read!.buildPath(workspaceA.slug, foreignId()),
        headers: { cookie: cookieA },
      });

      expect(foreignRes.statusCode).toBe(404);
      expect(foreignRes.statusCode).toBe(missingRes.statusCode);
      expect(foreignRes.body).toBe(missingRes.body);
    }
  );

  it.each(ATTEMPT_CASES.filter((c) => c.write))(
    "$name: workspace A member writing to workspace B's resource is denied and the row is unchanged",
    async ({ write, foreignId }) => {
      const before = await write!.snapshot();

      const res = await app.inject({
        method: write!.method,
        url: write!.buildPath(workspaceA.slug, foreignId()),
        headers: { cookie: cookieA },
        payload: write!.body,
      });

      expect(res.statusCode, `write attempt unexpectedly succeeded: ${res.body}`).toBeGreaterThanOrEqual(400);

      const after = await write!.snapshot();
      expect(after, "workspace B's row changed as a result of a denied cross-tenant write").toEqual(before);
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

    expect(nonMemberSlugRes.statusCode).toBe(404);
    expect(nonMemberSlugRes.statusCode).toBe(nonexistentSlugRes.statusCode);
    expect(nonMemberSlugRes.body).toBe(nonexistentSlugRes.body);
  });

  it("workspace-level write (DELETE /api/workspaces/:slug): workspace A member cannot delete workspace B", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspaceB.slug}`,
      headers: { cookie: cookieA },
      payload: { confirmName: workspaceB.name },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    // Workspace B must still be reachable by its own owner afterwards.
    const stillThere = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceB.slug}`,
      headers: { cookie: cookieB },
    });
    expect(stillThere.statusCode).toBe(200);
  });

  it("positive control: workspace A's own resource returns 200 through the same authenticated fixture", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspaceA.slug}/contacts/${contactAId}`,
      headers: { cookie: cookieA },
    });
    expect(res.statusCode, `own-resource GET failed: ${res.body}`).toBe(200);
  });

  // -------------------------------------------------------------------
  // Test 3: a workspace-A API key presented against workspace-B-shaped
  // data affects only workspace A.
  // -------------------------------------------------------------------

  describe("Test 3: API-key-authed write is workspace-bound regardless of payload content", () => {
    it("a contact upsert through the Contacts API lands in workspace A even when the payload's externalId matches a workspace B contact", async () => {
      const apiKeyA = await createApiKeyFixture(cookieA, workspaceA.slug, "negative-suite api key A");

      const upsertEmail = `neg-apikey-upsert-${Date.now()}@example.com`;
      const res = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: { authorization: `Bearer ${apiKeyA.fullKey}` },
        payload: {
          email: upsertEmail,
          externalId: "shared-ext-neg-b", // matches workspace B's seeded contact
        },
      });
      expect(res.statusCode, `upsert failed: ${res.body}`).toBe(200);
      const body = res.json<{ id: string }>();

      // The written row belongs to workspace A -- readable under A's tenant
      // scope, invisible under B's.
      const seenUnderA = await withTenant(workspaceA.id, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ id: string }>(`SELECT id FROM contacts WHERE id = $1`, [body.id]);
          return rows.length > 0;
        })
      );
      expect(seenUnderA).toBe(true);

      const seenUnderB = await withTenant(workspaceB.id, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ id: string }>(`SELECT id FROM contacts WHERE id = $1`, [body.id]);
          return rows.length > 0;
        })
      );
      expect(seenUnderB).toBe(false);

      // Workspace B's own contact (the externalId collision target) is untouched.
      const bContactEmail = await withTenant(workspaceB.id, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ email: string | null }>(`SELECT email FROM contacts WHERE id = $1`, [
            foreignContactId,
          ]);
          return rows[0]?.email ?? null;
        })
      );
      expect(bContactEmail).not.toBe(upsertEmail);
    });
  });

  // -------------------------------------------------------------------
  // Test 4: no query on a tenant table runs without tenant context.
  // -------------------------------------------------------------------

  describe("Test 4: no code path reaches a tenant table without tenant context", () => {
    it("withTenantTransaction called without an enclosing withTenant throws rather than returning rows", async () => {
      await expect(withTenantTransaction((client) => client.query("SELECT id FROM contacts LIMIT 1"))).rejects.toThrow(
        /No tenant context set/
      );
    });

    it("a genuinely fresh connection that never set app.current_workspace_id throws (fail-closed RLS, migration 0044), never silently returns rows", async () => {
      const freshPool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
      try {
        await expect(freshPool.query("SELECT id FROM contacts LIMIT 1")).rejects.toThrow(
          /unrecognized configuration parameter/
        );
      } finally {
        await freshPool.end();
      }
    });
  });

  // -------------------------------------------------------------------
  // Test 5: withPreTenantLookup grants nothing beyond its two narrowly-keyed
  // policies -- an ordinary tenant table is invisible through it.
  // -------------------------------------------------------------------

  it("Test 5: the pre-tenant lookup sentinel reads zero rows from an ordinary tenant table it was never granted", async () => {
    const rows = await withPreTenantLookup((client) =>
      client.query<{ id: string }>(`SELECT id FROM contacts WHERE id = $1`, [contactAId]).then((r) => r.rows)
    );
    expect(rows).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Test 6 (coverage): the set of route modules server.ts registers equals
  // the set this suite exercises (covered ∪ explicitly-excluded).
  // -------------------------------------------------------------------

  describe("Test 6: coverage -- every registered route module has a case or a documented exclusion", () => {
    const COVERED_MODULES = new Set(ATTEMPT_CASES.map((c) => c.module));
    // Also covered by dedicated tests above (not via the ATTEMPT_CASES loop):
    COVERED_MODULES.add("registerWorkspaceRoutes"); // workspace-level 404 + delete tests
    COVERED_MODULES.add("registerContactsApiRoutes"); // Test 3
    COVERED_MODULES.add("registerEventsApiRoutes"); // shares apiKeyAuth's workspace-binding with registerContactsApiRoutes -- the mechanism proven in Test 3 (workspace resolved solely from the verified key, never client input) applies identically; no separate id-scoped resource exists to attempt against

    const EXCLUDED_MODULES: Record<string, string> = {
      registerProfileRoutes: "operates only on the caller's own account (no :id param, no cross-tenant resource reachable)",
      registerSendgridKeyRoutes:
        "workspace-level singleton, no id param -- cross-tenant reachability is exactly the workspace-membership gate already covered by the workspace-level test above",
      registerSendSettingsRoutes:
        "workspace-level singleton (PUT, no id param) -- same reasoning as registerSendgridKeyRoutes",
      registerWebhookSettingsRoutes:
        "workspace-level singleton (GET health / POST recheck, no id param) -- same reasoning as registerSendgridKeyRoutes",
      registerUnsubscribeRoutes:
        "public, HMAC-signed-token-authenticated endpoint -- not session/workspace-membership-gated at all, so there is no session-authenticated cross-tenant attempt to make",
      registerWebhookRoutes:
        "public, SendGrid-signature-authenticated receiver -- not session-authenticated; SEC-09's sibling-workspace drop is proven by the worker-side negative suite (plan 10-14 Task 2), not here",
      registerOpsHealthRoutes:
        "unauthenticated infrastructure probes (/healthz, /readyz) carrying no tenant data and no id param -- deliberate deviation from every other route module's auth posture (D-13/D-14, T-14-04, accepted by design), so there is no session-authenticated cross-tenant attempt to make",
    };

    it("every register* module in server.ts's registration list is covered or has a documented exclusion reason", () => {
      const serverPath = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../server.ts");
      const serverSource = readFileSync(serverPath, "utf8");
      const registeredModules = [...serverSource.matchAll(/app\.register\((register\w+)\)/g)].map((m) => m[1]);

      expect(registeredModules.length).toBeGreaterThan(0);

      const uniqueRegistered = new Set(registeredModules);
      const accountedFor = new Set([...COVERED_MODULES, ...Object.keys(EXCLUDED_MODULES)]);

      const missing = [...uniqueRegistered].filter((m) => !accountedFor.has(m));
      expect(missing, `module(s) registered in server.ts but neither covered nor excluded: ${missing.join(", ")}`).toEqual(
        []
      );

      // The converse: nothing declared covered/excluded should be a module
      // that server.ts no longer registers -- keeps the exclusion set honest
      // as modules are renamed/removed.
      const stale = [...accountedFor].filter((m) => !uniqueRegistered.has(m));
      expect(stale, `covered/excluded module(s) no longer registered in server.ts: ${stale.join(", ")}`).toEqual([]);
    });
  });
});
