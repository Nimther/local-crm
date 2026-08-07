import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { pool } from "../../../db.js";

// 10-09 (SEC-05): `DELETE FROM organization` below needs a role that still
// holds DELETE on it -- mega_crm_app (the `pool` above) keeps SELECT+UPDATE
// only post-migration-0045, so this test-only orphaning helper runs its
// DELETE through a raw connection under mega_crm_auth instead. The ALTER
// TABLE statements stay on `pool`: dropping/adding a constraint requires
// table OWNERSHIP, which only mega_crm_app (the migration-applying role)
// holds -- mega_crm_auth owns no tables at all.
const authPool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL });

/**
 * SEC-10/SEC-15/T-10-04-03: `GET /api/invites/:invitationId` -- the public,
 * unauthenticated invite-preview endpoint -- answers identically for an
 * invitation id that exists nowhere and one that exists but whose
 * organization row is gone (RESEARCH.md Open Question #1, interpretation
 * (a): tighten the not-found path, keep the 200 preview for a genuinely
 * actionable invitation). Its 200 payload carries exactly the field set
 * `apps/web`'s `InviteAcceptPage` reads -- see `invites.ts`'s handler doc
 * comment for the field-by-field audit this test enforces.
 */
describe("Invite preview response identity (SEC-10, T-10-04-03)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await authPool.end();
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

  async function createPendingInvite(cookie: string, slug: string, email: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/invites`,
      headers: { cookie },
      payload: { email, role: "member" },
    });
    expect(res.statusCode, `create invite failed: ${res.body}`).toBe(200);
    return res.json<{ id: string }>();
  }

  /**
   * Forces the "invitation exists, organization row is gone" state that
   * `invitation.organizationId`'s `ON DELETE CASCADE` FK normally makes
   * unreachable through ordinary deletion (deleting the org cascades to the
   * invitation too, so the invitation would vanish along with it).
   * Momentarily suspends `organization`'s constraint-enforcement triggers
   * for a single DELETE, then restores them immediately -- the FK stays
   * fully enforced for every other row and every other test.
   *
   * Also drops (and restores) `member`'s FK to `organization` for the
   * DELETE's duration -- 10-09 (SEC-05): the owner-creating workspace flow
   * always inserts the creator's own `member` row, so `organization`'s
   * ON DELETE CASCADE would otherwise fan out into `member` too. Postgres
   * runs that cascade under `member`'s OWNER (`mega_crm_app`), regardless of
   * which role's connection issued the DELETE -- and `mega_crm_app` holds
   * only SELECT on `member` post-migration-0045 (D-04/D-05's audited
   * grant), so the cascade would fail with a permission error rather than
   * (silently or otherwise) deleting a row no live application path ever
   * hard-deletes. Dropping the FK sidesteps the cascade entirely instead of
   * widening the production grant matrix for a test-only edge case.
   */
  async function deleteOrganizationLeavingInvitationOrphaned(organizationId: string) {
    await pool.query('ALTER TABLE invitation DROP CONSTRAINT "invitation_organizationId_organization_id_fk"');
    await pool.query('ALTER TABLE member DROP CONSTRAINT "member_organizationId_organization_id_fk"');
    try {
      await authPool.query("DELETE FROM organization WHERE id = $1", [organizationId]);
    } finally {
      // NOT VALID: skips re-validating the now-orphaned row(s) this DELETE
      // just created, while still enforcing the FK for every future
      // insert/update -- both constraints stay live for every other test.
      await pool.query(
        `ALTER TABLE invitation
           ADD CONSTRAINT "invitation_organizationId_organization_id_fk"
           FOREIGN KEY ("organizationId") REFERENCES organization(id) ON DELETE CASCADE NOT VALID`
      );
      await pool.query(
        `ALTER TABLE member
           ADD CONSTRAINT "member_organizationId_organization_id_fk"
           FOREIGN KEY ("organizationId") REFERENCES organization(id) ON DELETE CASCADE NOT VALID`
      );
    }
  }

  it("Test 1: a syntactically valid invitation id that exists nowhere returns 404 with the invitation-not-found body", async () => {
    const res = await app.inject({ method: "GET", url: `/api/invites/${randomUUID()}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "Invitation not found" });
  });

  it("Test 2: an invitation that exists but whose organization row is gone returns the identical status + byte-identical body as a nonexistent id", async () => {
    const owner = await signUp(
      `invite-orphan-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Owner"
    );
    const workspace = await createWorkspace(owner.cookie, "Orphan Invite Co");
    const invite = await createPendingInvite(owner.cookie, workspace.slug, `orphan-invitee-${Date.now()}@example.com`);

    await deleteOrganizationLeavingInvitationOrphaned(workspace.id);

    const missingRes = await app.inject({ method: "GET", url: `/api/invites/${randomUUID()}` });
    const orphanRes = await app.inject({ method: "GET", url: `/api/invites/${invite.id}` });

    expect(orphanRes.statusCode, `orphan preview failed: ${orphanRes.body}`).toBe(missingRes.statusCode);
    expect(orphanRes.body).toBe(missingRes.body);
    expect(orphanRes.statusCode).toBe(404);
  });

  it("Test 3: a genuinely pending, unexpired invitation returns 200 with exactly the audited field set", async () => {
    const owner = await signUp(
      `invite-pending-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Owner"
    );
    const workspace = await createWorkspace(owner.cookie, "Pending Invite Co");
    const invite = await createPendingInvite(
      owner.cookie,
      workspace.slug,
      `pending-invitee-${Date.now()}@example.com`
    );

    const res = await app.inject({ method: "GET", url: `/api/invites/${invite.id}` });
    expect(res.statusCode, `preview failed: ${res.body}`).toBe(200);

    const body = res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(
      ["email", "organizationName", "organizationSlug", "role", "status"].sort()
    );
    expect(body.status).toBe("pending");
    expect(body.organizationSlug).toBe(workspace.slug);
    expect(body.organizationName).toBe(workspace.name);
    expect(body.role).toBe("member");
  });

  it("Test 4: two consecutive requests for the same nonexistent id return byte-identical bodies (no timestamp/request-id leaks into the failure response)", async () => {
    const id = randomUUID();
    const first = await app.inject({ method: "GET", url: `/api/invites/${id}` });
    const second = await app.inject({ method: "GET", url: `/api/invites/${id}` });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.body).toBe(first.body);
  });
});
