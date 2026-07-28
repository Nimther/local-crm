import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  applyMigrationsUpTo,
  applyRemainingMigrations,
  createEphemeralDatabase,
  dropEphemeralDatabase,
} from "@mega-crm/test-support";

/**
 * 08-09 (QG-05) — run B: the incremental chain over a database that already
 * holds rows.
 *
 * Run A proves the chain applies to nothing. This proves it applies to
 * something, which is the case that actually breaks a deploy: DDL that is fine
 * against an empty table and fails, or locks, against a populated one.
 *
 * Two defenses against a green that proves nothing:
 *   1. `applyRemainingMigrations` returns what it applied, and this asserts the
 *      list is non-empty. A checkpoint that had drifted to the end of the chain
 *      would otherwise migrate zero files and pass.
 *   2. Seeds are inserted inside a tenant scope. Every domain table here carries
 *      ENABLE + FORCE ROW LEVEL SECURITY, so a bare insert would be silently
 *      filtered to zero rows and the whole "over seeded data" premise would be
 *      a fiction.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

/**
 * The last migration of Phase 6, i.e. the schema as it stood before the Phase 7
 * analytics work began. Chosen as the checkpoint because it is a real release
 * boundary in this repository's history (git shows 0026-0035 land under
 * feat(06-*), and 0036 is the first feat(07-*)), and because what follows it is
 * exactly the interesting shape: 0036 runs
 * `ALTER TABLE sends ADD COLUMN ... integer NOT NULL DEFAULT 0` — the SAFE form
 * of the pattern whose unsafe form this file also proves is rejected.
 *
 * Named rather than computed by index on purpose. The directory will keep
 * growing, and "everything after this release" stays correct as it does; an
 * index or a count would silently start meaning something else.
 */
const CHECKPOINT = "0035_csv_imports_default_timezone.sql";

/**
 * What `withTenant`/`withTenantTransaction` do, applied to THIS test's pool.
 *
 * @mega-crm/tenant-context binds its pool to process.env.DATABASE_URL at module
 * load, which points at the workspace's globalSetup database — not the
 * ephemeral one provisioned here. Reusing it would seed the wrong database and
 * leave this run's tables empty, which is precisely the vacuous outcome
 * defense 2 exists to prevent.
 */
async function withWorkspace<T>(
  pool: Pool,
  workspaceId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const SEEDED_TABLES = ["contacts", "campaigns", "sends"] as const;
type SeededCounts = Record<(typeof SEEDED_TABLES)[number], number>;

describe("migration chain: incremental over seeded data (QG-05 run B)", () => {
  /**
   * Two pools, deliberately.
   *
   * `pool` runs DDL and is NEVER tenant-scoped. `seedPool` does the
   * tenant-scoped inserts and counts.
   *
   * They must not be the same, and the reason is a defect this test found:
   * `set_config('app.current_workspace_id', x, true)` reverts at COMMIT to the
   * session value, and for a custom GUC that session value is the EMPTY STRING,
   * not NULL. Thirteen of this schema's RLS policies read
   * `current_setting('app.current_workspace_id', true)::uuid` with no NULLIF, so
   * on a connection that has once been scoped they evaluate `''::uuid` and
   * throw `invalid input syntax for type uuid: ""` instead of returning no rows.
   * A pooled connection recycled from a scoped transaction into un-scoped DDL
   * therefore fails. Recorded in SPECIFICATION.md §4.3.
   */
  let pool: Pool;
  let seedPool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let workspaceId: string;

  let appliedUpTo: string[] = [];
  let appliedRemaining: string[] = [];
  let countsBefore: SeededCounts;
  let countsAfter: SeededCounts;

  async function countSeeded(): Promise<SeededCounts> {
    return withWorkspace(seedPool, workspaceId, async (client) => {
      const counts = {} as SeededCounts;
      for (const table of SEEDED_TABLES) {
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM ${table} WHERE workspace_id = $1`,
          [workspaceId],
        );
        counts[table] = Number(rows[0].n);
      }
      return counts;
    });
  }

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "migrate-incremental" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 2 });
    seedPool = new Pool({ connectionString: created.dsn, max: 2 });

    // --- prior release ------------------------------------------------------
    appliedUpTo = await applyMigrationsUpTo(pool, MIGRATIONS_DIR, CHECKPOINT);

    // --- data that release left behind --------------------------------------
    // `organization` is not tenant-scoped, so it is inserted outside the scope.
    const { rows: orgRows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      ["Migrate Incremental Co", `migrate-incremental-${Date.now()}`],
    );
    workspaceId = orgRows[0].id;

    await withWorkspace(seedPool, workspaceId, async (client) => {
      const { rows: segmentRows } = await client.query<{ id: string }>(
        `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
         VALUES ($1, 'Seed segment', $2, 'test-user') RETURNING id`,
        [workspaceId, { operator: "and", conditions: [] }],
      );
      const { rows: campaignRows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns (workspace_id, name, status, segment_id, created_by_user_id)
         VALUES ($1, 'Seed campaign', 'sending', $2, 'test-user') RETURNING id`,
        [workspaceId, segmentRows[0].id],
      );
      const campaignId = campaignRows[0].id;

      for (let i = 0; i < 3; i += 1) {
        const { rows: contactRows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Seed', 'subscribed') RETURNING id`,
          [workspaceId, `seed-${String(i)}-${Date.now()}@fixture.test`],
        );
        await client.query(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, status)
           VALUES ($1, $2, $3, 'sent')`,
          [workspaceId, campaignId, contactRows[0].id],
        );
      }
    });

    countsBefore = await countSeeded();

    // --- the release under test ---------------------------------------------
    appliedRemaining = await applyRemainingMigrations(pool, MIGRATIONS_DIR, CHECKPOINT);
    countsAfter = await countSeeded();
  });

  afterAll(async () => {
    await pool?.end();
    await seedPool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("reaches the checkpoint with real work done", () => {
    expect(appliedUpTo.length).toBeGreaterThan(0);
    expect(appliedUpTo.at(-1)).toBe(CHECKPOINT);
  });

  it("actually seeded rows — RLS did not silently swallow the inserts", () => {
    // Without this, every assertion below would hold trivially over empty tables.
    expect(countsBefore.contacts).toBe(3);
    expect(countsBefore.sends).toBe(3);
    expect(countsBefore.campaigns).toBe(1);
  });

  it("applies at least one migration after the checkpoint", () => {
    expect(
      appliedRemaining.length,
      "zero migrations after the checkpoint means this run proved nothing — move the checkpoint back (SPEC R5 empty edge)",
    ).toBeGreaterThanOrEqual(1);
  });

  it("preserves every seeded row across the remaining migrations", () => {
    for (const table of SEEDED_TABLES) {
      expect(countsAfter[table], `${table} lost or gained rows during the migration`).toBe(
        countsBefore[table],
      );
    }
  });

  it("rejects a NOT NULL column with no DEFAULT against the populated sends table", async () => {
    // The whole point of run B. This DDL is harmless against an empty table and
    // fails against a populated one — which is the difference between a green
    // CI run and a failed deploy. It is only meaningful here because the
    // seeding above genuinely put rows in `sends`.
    //
    // Written to a temp directory: adding it to packages/db/migrations would
    // break run A and trip the migration linter.
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "mega-crm-bad-migration-"));
    const fixtureName = "9999_unsafe_not_null.sql";
    writeFileSync(
      path.join(fixtureDir, fixtureName),
      'ALTER TABLE "sends" ADD COLUMN "mandatory_note" text NOT NULL;\n',
    );

    try {
      await expect(
        applyMigrationFile(pool, fixtureDir, fixtureName),
        "a NOT NULL column with no DEFAULT must be rejected against a table that already holds rows",
      ).rejects.toThrow(/contains null values|not-null/i);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
