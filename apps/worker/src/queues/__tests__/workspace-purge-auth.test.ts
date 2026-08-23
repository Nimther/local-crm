import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { createAuthPurgePool, closeAuthPurgePool, deleteWorkspaceAuthRows } from "../workspace-purge-auth.js";

/**
 * Phase 22 (PRG-02, D-12, plan 22-07), Task 1: proves the mega_crm_auth
 * trust boundary from both sides -- the ordinary `mega_crm_app` pool still
 * cannot delete `member`/`invitation`, the dedicated `mega_crm_auth` pool
 * can, and Better Auth's global identities (`user`/`session`/`account`) are
 * never touched. Task 2 (apps/worker/src/queues/workspace-purge.worker.ts)
 * extends this same file with the wiring-into-the-full-purge cases.
 *
 * Real Postgres throughout -- `auth-boundary.test.ts` already established
 * why: a broken privilege boundary produces no SQL error at all, only a
 * mock would hide that. `authPool` below connects as `mega_crm_auth`
 * directly (the same role `deleteWorkspaceAuthRows` itself uses) so this
 * file's own fixtures can write `member`/`invitation`/`session`/`account`
 * rows that the ordinary `appPool` (mega_crm_app) cannot.
 */
describe("workspace-purge-auth: the mega_crm_auth boundary (plan 22-07, Task 1)", () => {
  let appPool: Pool;
  let authPool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    appPool = createTestPool();
    // Published into process.env by packages/test-support's global-setup.ts
    // for every workspace's test project -- see that file's own comment.
    authPool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL });
  });

  afterAll(async () => {
    await appPool.end();
    await authPool.end();
    await closeAuthPurgePool();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function createUser(seed: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO "user" (name, email) VALUES ($1, $2) RETURNING id`,
      [`Purge Auth ${seed}`, `purge-auth-${seed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`],
    );
    return rows[0].id;
  }

  async function createMember(organizationId: string, userId: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO member ("organizationId", "userId", role) VALUES ($1, $2, 'member') RETURNING id`,
      [organizationId, userId],
    );
    return rows[0].id;
  }

  async function createInvitation(organizationId: string, inviterId: string, email: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO invitation ("organizationId", email, status, "expiresAt", "inviterId")
       VALUES ($1, $2, 'pending', now() + interval '7 days', $3) RETURNING id`,
      [organizationId, email, inviterId],
    );
    return rows[0].id;
  }

  async function createSession(userId: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO session ("expiresAt", token, "userId") VALUES (now() + interval '1 day', $1, $2) RETURNING id`,
      [`purge-auth-session-${randomUUID()}`, userId],
    );
    return rows[0].id;
  }

  async function createAccount(userId: string): Promise<string> {
    const { rows } = await authPool.query<{ id: string }>(
      `INSERT INTO account ("accountId", "providerId", "userId") VALUES ($1, 'credential', $2) RETURNING id`,
      [`purge-auth-account-${randomUUID()}`, userId],
    );
    return rows[0].id;
  }

  async function memberCount(organizationId: string): Promise<number> {
    const { rows } = await appPool.query<{ count: string }>(`SELECT count(*) AS count FROM member WHERE "organizationId" = $1`, [
      organizationId,
    ]);
    return Number(rows[0].count);
  }

  async function invitationCount(organizationId: string): Promise<number> {
    const { rows } = await appPool.query<{ count: string }>(
      `SELECT count(*) AS count FROM invitation WHERE "organizationId" = $1`,
      [organizationId],
    );
    return Number(rows[0].count);
  }

  async function userExists(userId: string): Promise<boolean> {
    const { rows } = await appPool.query<{ id: string }>(`SELECT id FROM "user" WHERE id = $1`, [userId]);
    return rows.length === 1;
  }

  /** session/account carry NO privilege for mega_crm_app (migration 0045) -- read through the auth-role pool instead. */
  async function sessionExistsForUser(userId: string): Promise<boolean> {
    const { rows } = await authPool.query<{ id: string }>(`SELECT id FROM session WHERE "userId" = $1`, [userId]);
    return rows.length === 1;
  }

  async function accountExistsForUser(userId: string): Promise<boolean> {
    const { rows } = await authPool.query<{ id: string }>(`SELECT id FROM account WHERE "userId" = $1`, [userId]);
    return rows.length === 1;
  }

  async function memberRow(memberId: string): Promise<{ id: string; organizationId: string } | null> {
    const { rows } = await appPool.query<{ id: string; organizationId: string }>(
      `SELECT id, "organizationId" FROM member WHERE id = $1`,
      [memberId],
    );
    return rows[0] ?? null;
  }

  it("the boundary holds: deleting member through the ordinary mega_crm_app pool is refused with 42501", async () => {
    const organizationId = await freshWorkspaceId("purge-auth-boundary");
    const userId = await createUser("boundary");
    await createMember(organizationId, userId);

    await expect(appPool.query(`DELETE FROM member WHERE "organizationId" = $1`, [organizationId])).rejects.toMatchObject({
      code: "42501",
    });
    // The boundary held -- the row is still there.
    expect(await memberCount(organizationId)).toBe(1);
  });

  it("the auth pool can: deleteWorkspaceAuthRows destroys member rows through mega_crm_auth and reports the count", async () => {
    const organizationId = await freshWorkspaceId("purge-auth-can");
    const userId = await createUser("can-member");
    await createMember(organizationId, userId);

    const counts = await deleteWorkspaceAuthRows(organizationId);

    expect(counts).toEqual({ memberCount: 1, invitationCount: 0 });
    expect(await memberCount(organizationId)).toBe(0);
  });

  it("invitations too: two pending invitations are removed and counted separately from members", async () => {
    const organizationId = await freshWorkspaceId("purge-auth-invites");
    const inviter = await createUser("invites-inviter");
    const memberUser = await createUser("invites-member");
    await createMember(organizationId, memberUser);
    await createInvitation(organizationId, inviter, "invitee-1@fixture.test");
    await createInvitation(organizationId, inviter, "invitee-2@fixture.test");

    const counts = await deleteWorkspaceAuthRows(organizationId);

    expect(counts).toEqual({ memberCount: 1, invitationCount: 2 });
    expect(await invitationCount(organizationId)).toBe(0);
  });

  it("global identities survive: a user who was a member only of the purged workspace still has user/session/account rows", async () => {
    const organizationId = await freshWorkspaceId("purge-auth-survive");
    const userId = await createUser("survive");
    await createMember(organizationId, userId);
    await createSession(userId);
    await createAccount(userId);

    await deleteWorkspaceAuthRows(organizationId);

    expect(await memberCount(organizationId)).toBe(0);
    expect(await userExists(userId)).toBe(true);
    expect(await sessionExistsForUser(userId)).toBe(true);
    expect(await accountExistsForUser(userId)).toBe(true);
  });

  it("another workspace's membership untouched: a user in both workspaces keeps the neighbour's membership row exactly as it was", async () => {
    const orgA = await freshWorkspaceId("purge-auth-neighbour-a");
    const orgB = await freshWorkspaceId("purge-auth-neighbour-b");
    const userId = await createUser("neighbour");
    await createMember(orgA, userId);
    const memberIdB = await createMember(orgB, userId);

    await deleteWorkspaceAuthRows(orgA);

    expect(await memberCount(orgA)).toBe(0);
    expect(await memberCount(orgB)).toBe(1);
    const neighbourRow = await memberRow(memberIdB);
    expect(neighbourRow).toEqual({ id: memberIdB, organizationId: orgB });
  });

  it("missing DSN fails loudly: createAuthPurgePool throws naming AUTH_DATABASE_URL, never falling back", async () => {
    const original = process.env.AUTH_DATABASE_URL;
    await closeAuthPurgePool();
    delete process.env.AUTH_DATABASE_URL;
    try {
      expect(() => createAuthPurgePool()).toThrow(/AUTH_DATABASE_URL/);
    } finally {
      if (original !== undefined) {
        process.env.AUTH_DATABASE_URL = original;
      }
    }
  });
});
