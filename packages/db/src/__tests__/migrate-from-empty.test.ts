import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  listMigrationFiles,
} from "@mega-crm/test-support";

/**
 * 08-09 (QG-05) — run A: the whole chain against a guaranteed-empty database.
 *
 * Thirty-eight migration files exist and, before this, the only thing that had
 * ever applied them was a test fixture running incidentally inside unrelated
 * suites. Nobody had verified the chain applies from zero — which is exactly
 * what a first production deploy does.
 *
 * This provisions its OWN database rather than using the one globalSetup hands
 * the workspace. globalSetup's database has already had the whole chain applied
 * by the fixture, so applying it again there would be a no-op dressed as a
 * pass.
 *
 * The assertions deliberately go past "no statement threw". A chain whose RLS
 * statements were all silently ineffective would throw nothing and leave every
 * tenant's rows readable by every other tenant.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

/** Present in the chain today; a rename or drop should fail this loudly. */
const CORE_DOMAIN_TABLES = [
  "contacts",
  "campaigns",
  "sends",
  "send_events",
  "events",
  "flows",
  "flow_runs",
  "workspace_sendgrid_keys",
] as const;

describe("migration chain: empty database (QG-05 run A)", () => {
  let pool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let applied: string[] = [];
  let listed: string[] = [];

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "migrate-empty" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 2 });

    listed = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of listed) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
      applied.push(file);
    }
  });

  afterAll(async () => {
    // Runs even when an assertion above failed, so a red run does not leak a
    // database. The drop itself is name-guarded inside dropEphemeralDatabase.
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("applies every migration file in the directory, and there is something to apply", () => {
    expect(listed.length, "the migrations directory must not be empty").toBeGreaterThan(0);
    expect(
      applied.length,
      "every file listed must have been applied — a partial chain is not a pass",
    ).toBe(listed.length);
  });

  it("materializes the core domain tables", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const present = new Set(rows.map((r) => r.table_name));

    for (const table of CORE_DOMAIN_TABLES) {
      expect(present.has(table), `expected table "${table}" to exist after the chain`).toBe(true);
    }
  });

  it("leaves RLS enabled AND forced on every tenant-scoped table", async () => {
    // Derived from the schema rather than hard-coded: any table carrying a
    // workspace_id is tenant-scoped by construction, so this also covers tables
    // added by future migrations without needing an edit here.
    //
    // FORCE matters as much as ENABLE — without it the table owner bypasses
    // every policy, and the app role owns these tables.
    //
    // Partitions are excluded and asserted separately below: they carry their
    // own flags, which are off, and Postgres applies the PARENT's policies when
    // a partitioned table is queried through the parent.
    const { rows } = await pool.query<{
      table_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND NOT c.relispartition
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
             WHERE col.table_schema = 'public'
               AND col.table_name = c.relname
               AND col.column_name = 'workspace_id'
          )
        ORDER BY c.relname`,
    );

    expect(rows.length, "no tenant-scoped tables found — the probe itself is wrong").toBeGreaterThan(
      10,
    );

    const unprotected = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity);
    expect(
      unprotected.map((r) => r.table_name),
      "every workspace_id-bearing table must have RLS both ENABLED and FORCED",
    ).toEqual([]);
  });

  /**
   * Pins the partition posture rather than letting it drift silently.
   *
   * `events` and `send_events` are partitioned, and their partitions do NOT
   * carry their own RLS flags — Postgres applies the parent's policies when the
   * partitioned table is queried through the parent, which is the only way any
   * code in this repository reaches them (verified: no source file names a
   * partition directly). A query naming a partition BY NAME would bypass tenant
   * isolation.
   *
   * This asserts the property the application actually depends on — every
   * partition's parent is protected — and is the place a future direct-partition
   * access pattern would have to come and change something deliberately.
   */
  it("protects partitioned tables at the parent, which is the only access path in use", async () => {
    const { rows } = await pool.query<{
      partition: string;
      parent: string;
      parent_rls: boolean;
      parent_forced: boolean;
    }>(
      `SELECT c.relname AS partition,
              p.relname AS parent,
              p.relrowsecurity AS parent_rls,
              p.relforcerowsecurity AS parent_forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_inherits i ON i.inhrelid = c.oid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE n.nspname = 'public'
          AND c.relispartition
          AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    expect(rows.length, "expected the events/send_events partitions to exist").toBeGreaterThan(0);

    const unparented = rows.filter((r) => !r.parent_rls || !r.parent_forced);
    expect(
      unparented.map((r) => `${r.partition} -> ${r.parent}`),
      "every partition's parent must have RLS enabled and forced",
    ).toEqual([]);
  });
});
