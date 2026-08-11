import nock from "nock";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAuthTestDatabaseUrl } from "@mega-crm/test-support";
import { buildServer } from "../../../server.js";
import { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

interface CapturedMailBody {
  content: Array<{ type: string; value: string }>;
}

/**
 * SEC-05/SEC-12 (plan 10-09, checkpoint option-a): proves the Better Auth
 * trust boundary from both sides -- the flows a real user takes (signup,
 * login, invite-accept) still succeed end to end against the real database,
 * and the catalog no longer grants `mega_crm_app` any privilege on the
 * three secret-bearing tables. Tests 1-3 run against the real server and
 * real database rather than mocks, because Pitfall 12's failure mode is
 * precisely that a broken boundary produces no SQL error -- only a mock
 * would hide that.
 */
describe("Better Auth trust boundary (SEC-05)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let catalogPool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    // 10-09 (SEC-05): the auth-role DSN for the SAME ephemeral database --
    // global-setup.ts publishes AUTH_DATABASE_URL for every workspace's
    // tests, but this suite also needs the raw DSN to run its own catalog
    // assertions independent of whatever env.ts requires at boot.
    process.env.AUTH_DATABASE_URL = getAuthTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
    catalogPool = createTestPool();
  });

  afterAll(async () => {
    await app.close();
    await catalogPool.end();
  });

  afterEach(() => {
    nock.cleanAll();
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
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}`, userId: res.json().user.id as string };
  }

  async function signIn(email: string, password: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email, password },
    });
    expect(res.statusCode, `sign-in failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-in response did not set a session cookie");
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

  function mockSendGrid() {
    const scope = nock("https://api.sendgrid.com")
      .post("/v3/mail/send", (body: CapturedMailBody) => {
        void body;
        return true;
      })
      .reply(202, "", { "x-message-id": "auth-boundary-test" });
    return scope;
  }

  it("Test 1: signup creates a user and returns a session", async () => {
    const email = `boundary-signup-${Date.now()}@example.com`;
    const { cookie } = await signUp(email, "correct horse battery staple 42", "Boundary Signup");
    expect(cookie).toMatch(/=/);
  });

  it("Test 2: login with those credentials succeeds and issues a session cookie", async () => {
    const email = `boundary-login-${Date.now()}@example.com`;
    const password = "correct horse battery staple 42";
    await signUp(email, password, "Boundary Login");
    const { cookie } = await signIn(email, password);
    expect(cookie).toMatch(/=/);
  });

  it("Test 3: an invited user accepts an invitation and becomes a member of the inviting workspace", async () => {
    const owner = await signUp(
      `boundary-owner-${Date.now()}@example.com`,
      "correct horse battery staple 42",
      "Boundary Owner",
    );
    const workspace = await createWorkspace(owner.cookie, "Boundary Co");
    mockSendGrid();

    const inviteeEmail = `boundary-invitee-${Date.now()}@example.com`;
    const inviteePassword = "correct horse battery staple 42";
    await signUp(inviteeEmail, inviteePassword, "Boundary Invitee");

    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/invites`,
      headers: { cookie: owner.cookie },
      payload: { email: inviteeEmail, role: "member" },
    });
    expect(inviteRes.statusCode, `create invite failed: ${inviteRes.body}`).toBe(200);
    const invite = inviteRes.json();

    const invitee = await signIn(inviteeEmail, inviteePassword);
    const acceptRes = await app.inject({
      method: "POST",
      url: `/api/invites/${invite.id}/accept`,
      headers: { cookie: invitee.cookie },
    });
    expect(acceptRes.statusCode, `accept failed: ${acceptRes.body}`).toBe(200);

    const memberRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}`,
      headers: { cookie: invitee.cookie },
    });
    expect(memberRes.statusCode, `invitee cannot read the workspace: ${memberRes.body}`).toBe(200);
    expect(memberRes.json().role).toBe("member");
  });

  async function hasPrivilege(role: string, table: string, privilege: string): Promise<boolean> {
    const { rows } = await catalogPool.query<{ has: boolean }>(
      "SELECT has_table_privilege($1, $2, $3) AS has",
      [role, table, privilege],
    );
    return rows[0].has;
  }

  it("Test 4: mega_crm_app holds no privilege on session/account/verification across SELECT/INSERT/UPDATE/DELETE", async () => {
    for (const table of ["session", "account", "verification"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const has = await hasPrivilege("mega_crm_app", table, privilege);
        expect(has, `mega_crm_app should not hold ${privilege} on ${table}`).toBe(false);
      }
    }
  });

  it("Test 5: mega_crm_app keeps SELECT + UPDATE on organization, but not INSERT/DELETE", async () => {
    expect(await hasPrivilege("mega_crm_app", "organization", "SELECT")).toBe(true);
    expect(await hasPrivilege("mega_crm_app", "organization", "UPDATE")).toBe(true);
    expect(await hasPrivilege("mega_crm_app", "organization", "INSERT")).toBe(false);
    expect(await hasPrivilege("mega_crm_app", "organization", "DELETE")).toBe(false);
  });

  it("Test 6: mega_crm_auth holds SELECT on all seven Better Auth tables", async () => {
    for (const table of ["user", "session", "account", "verification", "organization", "member", "invitation"]) {
      const has = await hasPrivilege("mega_crm_auth", table, "SELECT");
      expect(has, `mega_crm_auth should hold SELECT on ${table}`).toBe(true);
    }
  });

  it("Test 7: reading session through the app-role tenant pool rejects with a permission error, not zero rows", async () => {
    const appPool = createTestPool();
    try {
      await expect(appPool.query('SELECT * FROM "session" LIMIT 1')).rejects.toThrow(/permission denied/i);
    } finally {
      await appPool.end();
    }
  });
});
