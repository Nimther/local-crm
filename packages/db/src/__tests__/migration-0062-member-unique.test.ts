import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  applyMigrationsUpTo,
  createEphemeralDatabase,
  dropEphemeralDatabase,
} from "@mega-crm/test-support";

import { findRoleWarnings, resolveAllDuplicates } from "../../scripts/count-member-duplicates.js";

/**
 * Phase 14 (DB-12, Pitfall 17), Task 2: proves migration 0062's actual
 * apply-time behavior -- the fail-closed duplicate guard, the blocking
 * unique index build, the promoted named constraint, and the `indisvalid`
 * assertion -- against a real ephemeral Postgres, following migration
 * 0057's own test structure (`send-events-dedup-rebase.test.ts`).
 *
 * Unlike 0057, `member` is NOT partitioned and carries NO row-level
 * security (migration 0045's header: "RLS is deliberately NOT used here"
 * for the seven better-auth tables) -- so this suite seeds `member` rows
 * directly via the admin (superuser) connection, with no
 * `SET LOCAL app.current_workspace_id` dance and no per-workspace loop.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
const CHECKPOINT_BEFORE_0062 = "0061_suppression_hash_contract.sql";
const MIGRATION_0062_FILENAME = "0062_member_unique_org_user.sql";
const CONSTRAINT_NAME = "member_organization_user_unique";

function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createOrganization(adminPool: Pool, seed: string): Promise<string> {
  const id = randomUUID();
  await adminPool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
    id,
    `Member Unique Test ${seed}`,
    `member-unique-test-${seed}-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function createUser(adminPool: Pool, seed: string): Promise<string> {
  const id = randomUUID();
  await adminPool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    `Member Unique User ${seed}`,
    `member-unique-${seed}-${id.slice(0, 8)}@example.test`,
  ]);
  return id;
}

async function createMember(
  adminPool: Pool,
  organizationId: string,
  userId: string,
  role: string = "member",
  createdAt: Date = new Date(),
): Promise<string> {
  const id = randomUUID();
  await adminPool.query(
    `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, $5)`,
    [id, organizationId, userId, role, createdAt],
  );
  return id;
}

async function memberRows(adminPool: Pool, organizationId: string, userId: string): Promise<{ id: string }[]> {
  const { rows } = await adminPool.query<{ id: string }>(
    `SELECT id FROM member WHERE "organizationId" = $1 AND "userId" = $2 ORDER BY "createdAt" ASC, id ASC`,
    [organizationId, userId],
  );
  return rows;
}

interface IndexValidity {
  exists: boolean;
  valid: boolean | null;
}

async function indexValidity(pool: Pool, indexName: string): Promise<IndexValidity> {
  const { rows } = await pool.query<{ indisvalid: boolean }>(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [indexName],
  );
  if (rows.length === 0) return { exists: false, valid: null };
  return { exists: true, valid: rows[0].indisvalid };
}

async function constraintExists(pool: Pool, relation: string, constraintName: string): Promise<boolean> {
  const { rows } = await pool.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
    [relation, constraintName],
  );
  return rows.length > 0;
}

describe("migration 0062 (Phase 14, DB-12, plan 14-02)", () => {
  describe("fresh apply (0000..0061 then 0062) + constraint enforcement", () => {
    let adminPool: Pool;
    let migratePool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let organizationId: string;
    let userId: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "member-unique-fresh" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      migratePool = new Pool({ connectionString: created.dsn, max: 2 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });

      await applyMigrationsUpTo(migratePool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0062);

      organizationId = await createOrganization(adminPool, "fresh");
      userId = await createUser(adminPool, "fresh");
      // One membership row -- zero duplicate groups, so Step 0's guard
      // passes trivially and the chain reaches the constraint (`<behavior>`
      // truth 6: "applying the full chain from empty... passes the Step 0
      // assertion trivially").
      await createMember(adminPool, organizationId, userId);
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      await migratePool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("applying 0062 succeeds and leaves the named constraint's backing index valid", async () => {
      await expect(applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0062_FILENAME)).resolves.toBeUndefined();

      expect(await constraintExists(migratePool, "member", CONSTRAINT_NAME)).toBe(true);
      const index = await indexValidity(migratePool, `public.${CONSTRAINT_NAME}`);
      expect(index).toEqual({ exists: true, valid: true });
    });

    it("inserting a second row for the same (organizationId, userId) pair is rejected", async () => {
      await expect(createMember(adminPool, organizationId, userId)).rejects.toThrow(
        /duplicate key value violates unique constraint/i,
      );
    });

    it("inserting a membership for the same user in a DIFFERENT organization succeeds", async () => {
      const otherOrganizationId = await createOrganization(adminPool, "fresh-other-org");
      await expect(createMember(adminPool, otherOrganizationId, userId)).resolves.toEqual(expect.any(String));
    });

    it("inserting a membership for a DIFFERENT user in the same organization succeeds", async () => {
      const otherUserId = await createUser(adminPool, "fresh-other-user");
      await expect(createMember(adminPool, organizationId, otherUserId)).resolves.toEqual(expect.any(String));
    });
  });

  describe("the fail-closed duplicate guard, and resuming after --resolve", () => {
    let adminPool: Pool;
    let migratePool: Pool;
    let databaseName: string;
    let adminDsn: string;
    let organizationId: string;
    let userId: string;
    let earlierRowId: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "member-unique-guard" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      migratePool = new Pool({ connectionString: created.dsn, max: 2 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });

      await applyMigrationsUpTo(migratePool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0062);

      organizationId = await createOrganization(adminPool, "guard");
      userId = await createUser(adminPool, "guard");

      const now = new Date();
      earlierRowId = await createMember(adminPool, organizationId, userId, "member", now);
      await createMember(adminPool, organizationId, userId, "member", new Date(now.getTime() + 5000));
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      await migratePool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("applying 0062 over unresolved duplicates raises, naming db:count-member-duplicates, and leaves both rows and no new constraint in place", async () => {
      await expect(applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0062_FILENAME)).rejects.toThrow(
        /db:count-member-duplicates/,
      );

      expect(await constraintExists(migratePool, "member", CONSTRAINT_NAME)).toBe(false);
      const index = await indexValidity(migratePool, `public.${CONSTRAINT_NAME}`);
      expect(index.exists).toBe(false);

      const survivors = await memberRows(adminPool, organizationId, userId);
      expect(survivors).toHaveLength(2);
    });

    it("applying 0062 after db:resolve-member-duplicates has run succeeds, and the surviving row is the earlier-createdAt one", async () => {
      const resolveResult = await resolveAllDuplicates(adminPool, 500);
      expect(resolveResult.deletedCount).toBe(1);
      expect(resolveResult.roleWarnings).toEqual([]);

      const survivorsAfterResolve = await memberRows(adminPool, organizationId, userId);
      expect(survivorsAfterResolve).toHaveLength(1);
      expect(survivorsAfterResolve[0].id).toBe(earlierRowId);

      await expect(applyMigrationFile(migratePool, MIGRATIONS_DIR, MIGRATION_0062_FILENAME)).resolves.toBeUndefined();

      expect(await constraintExists(migratePool, "member", CONSTRAINT_NAME)).toBe(true);
      const index = await indexValidity(migratePool, `public.${CONSTRAINT_NAME}`);
      expect(index).toEqual({ exists: true, valid: true });

      const finalSurvivors = await memberRows(adminPool, organizationId, userId);
      expect(finalSurvivors).toHaveLength(1);
      expect(finalSurvivors[0].id).toBe(earlierRowId);
    });
  });

  describe("role-difference warning (findRoleWarnings/resolveAllDuplicates)", () => {
    let adminPool: Pool;
    let databaseName: string;
    let adminDsn: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "member-unique-role-warn" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;
      const migratePool = new Pool({ connectionString: created.dsn, max: 2 });
      adminPool = new Pool({ connectionString: adminDsnForDatabase(adminDsn, databaseName), max: 5 });
      await applyMigrationsUpTo(migratePool, MIGRATIONS_DIR, CHECKPOINT_BEFORE_0062);
      await migratePool.end();
    }, 60_000);

    afterAll(async () => {
      await adminPool?.end();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("names the group and the differing roles when duplicates disagree on role, without discarding silently", async () => {
      const organizationId = await createOrganization(adminPool, "role-warn");
      const userId = await createUser(adminPool, "role-warn");
      await createMember(adminPool, organizationId, userId, "admin", new Date());
      await createMember(adminPool, organizationId, userId, "member", new Date(Date.now() + 5000));

      const warnings = await findRoleWarnings(adminPool);
      const thisWarning = warnings.find((w) => w.organizationId === organizationId && w.userId === userId);
      expect(thisWarning).toBeDefined();
      expect(thisWarning?.roles.sort()).toEqual(["admin", "member"]);
    });
  });
});

describe("migration 0062 static shape (Phase 14, DB-12, plan 14-02)", () => {
  const MIGRATION_0062_PATH = path.resolve(MIGRATIONS_DIR, MIGRATION_0062_FILENAME);

  function readMigrationSql(): string {
    return readFileSync(MIGRATION_0062_PATH, "utf8");
  }

  function stripLineComments(sql: string): string {
    return sql
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
  }

  it("exists on disk", () => {
    expect(existsSync(MIGRATION_0062_PATH)).toBe(true);
  });

  it("declares CREATE UNIQUE INDEX on member, not a non-unique CREATE INDEX", () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(new RegExp(`CREATE UNIQUE INDEX ${CONSTRAINT_NAME} ON member`));
  });

  it("promotes the index to a named UNIQUE constraint via USING INDEX", () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(new RegExp(`ADD CONSTRAINT ${CONSTRAINT_NAME} UNIQUE USING INDEX ${CONSTRAINT_NAME}`));
  });

  it("emits no CONCURRENTLY build outside of prose (comment-stripped)", () => {
    const withoutComments = stripLineComments(readMigrationSql());
    expect(withoutComments).not.toMatch(/CONCURRENTLY/i);
  });

  it("contains no DELETE and no UPDATE against member, and its guard is the first executable statement", () => {
    const sql = readMigrationSql();
    const withoutComments = stripLineComments(sql);
    expect(withoutComments).not.toMatch(/\bDELETE\s+FROM\s+member\b/i);
    expect(withoutComments).not.toMatch(/\bUPDATE\s+member\s+SET\b/i);

    // Comment-stripped: this migration's own header prose discusses
    // `CREATE UNIQUE INDEX` (the deviation note) BEFORE the real DDL
    // statement, so a raw `indexOf` against the full file would find that
    // prose mention first. Stripping comments first removes the false hit.
    const firstDoIndex = withoutComments.indexOf("DO $$");
    const firstCreateIndex = withoutComments.indexOf("CREATE UNIQUE INDEX");
    expect(firstDoIndex).toBeGreaterThanOrEqual(0);
    expect(firstCreateIndex).toBeGreaterThanOrEqual(0);
    expect(firstDoIndex).toBeLessThan(firstCreateIndex);
  });

  it("names the count script in its guard's RAISE message", () => {
    expect(readMigrationSql()).toMatch(/db:count-member-duplicates/);
  });

  it("asserts pg_index.indisvalid after building the index", () => {
    const sql = readMigrationSql();
    expect(sql).toMatch(/indisvalid/);
    expect(sql).toMatch(/RAISE EXCEPTION/i);
  });
});
