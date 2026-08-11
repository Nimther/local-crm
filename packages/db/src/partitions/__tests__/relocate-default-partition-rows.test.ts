import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyMigrationFile,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  listMigrationFiles,
} from "@mega-crm/test-support";

import {
  PARTITIONED_TABLES,
  attachPartitionCheckFirst,
  type PartitionedTableConfig,
} from "../ensure-partitions.js";

/**
 * 10-06 (SEC-01/SEC-02, checkpoint option-b): proves
 * `attachPartitionCheckFirst`'s `options.adminClient` mechanism is
 * load-bearing for a NON-EMPTY attach -- exactly the case the operator CLI
 * (`packages/db/scripts/relocate-default-partition-rows.ts`) exercises via
 * `PARTITION_RELOCATION_ADMIN_DATABASE_URL`, now that migration 0043 drops
 * the legacy `app.admin_scan`-gated policy (0039)
 * `attachPartitionCheckFirst` used to rely on for this same visibility.
 *
 * A NEW, dedicated suite (not an extension of `relocate-default.test.ts`'s
 * shared, multi-test-ordered state) so its failure-path assertion -- an
 * attach WITHOUT an elevated `adminClient` must fail -- can run against a
 * freestanding child table this file constructs directly, without
 * perturbing `relocate-default.test.ts`'s own DEFAULT
 * discovery/relocation state machine (a failed ATTACH there would leave a
 * freestanding, un-reattachable child outside that suite's own month-walk,
 * per `discoverDefaultMonths`'s "read DEFAULT" semantics -- rows already
 * moved out of DEFAULT by the DELETE/INSERT batch loop are not rediscovered
 * on a retry).
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);

const EVENTS_TABLE: PartitionedTableConfig = PARTITIONED_TABLES.find((t) => t.parentTable === "events")!;

// A month outside migration 0038's pre-created 2026-09..2027-06 window --
// this suite provisions its own ephemeral database, so collision with other
// suites is impossible regardless, but a distinct, unused label keeps
// failure output unambiguous.
const MONTH_START = new Date(Date.UTC(2029, 0, 1, 0, 0, 0));
const MONTH_END = new Date(Date.UTC(2029, 1, 1, 0, 0, 0));
const CHILD_NAME = "events_2029_01";

/**
 * `createEphemeralDatabase`'s own `adminDsn` field points at the CLUSTER's
 * maintenance database (`postgres`, used for CREATE/DROP DATABASE), not at
 * the ephemeral database itself -- swap only the pathname, keeping whatever
 * superuser credentials `adminDsn` already carries, to get a connection that
 * (a) targets the ephemeral database's own tables and (b) is backed by the
 * same RLS-bypassing role class production's
 * `PARTITION_RELOCATION_ADMIN_DATABASE_URL` documents (superuser or
 * BYPASSRLS).
 */
function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("relocate-default-partition-rows CLI mechanism -- elevated adminClient (10-06, SEC-01/SEC-02)", () => {
  let pool: Pool;
  let appPool: Pool;
  let adminPool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let workspaceId: string;
  let contactId: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "relocate-admin-dsn" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    pool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });

    // Two SEPARATE pools mirroring the CLI's own two-DSN shape: `appPool` is
    // the ordinary `mega_crm_app`-role connection (DATABASE_URL), `adminPool`
    // is the elevated, RLS-bypassing connection
    // (PARTITION_RELOCATION_ADMIN_DATABASE_URL) -- the ephemeral database's
    // own Postgres superuser DSN plays that role here, the same shape
    // `relocate-default.test.ts`'s `relocationAdminPool` uses, and the same
    // role class SPECIFICATION.md/ARCHITECTURE.md document the CLI as
    // requiring (BYPASSRLS or superuser).
    appPool = new Pool({ connectionString: created.dsn, max: 5, options: "-c timezone=UTC" });
    adminPool = new Pool({
      connectionString: adminDsnForDatabase(adminDsn, databaseName),
      max: 5,
      options: "-c timezone=UTC",
    });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }

    // 10-09 (SEC-05): the full migration chain above now includes 0045 --
    // mega_crm_app (`pool`) holds only SELECT on organization from this
    // point on, so seeding a workspace row goes through the superuser
    // `adminPool` constructed above instead.
    workspaceId = randomUUID();
    await adminPool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
      workspaceId,
      "Relocate Admin DSN Test Co",
      `relocate-admin-dsn-${workspaceId.slice(0, 8)}`,
    ]);

    contactId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await client.query(`INSERT INTO contacts (id, workspace_id, external_id) VALUES ($1, $2, $3)`, [
        contactId,
        workspaceId,
        `relocate-admin-dsn-contact-${contactId.slice(0, 8)}`,
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    // Build a freestanding, NON-EMPTY child directly -- mirrors
    // relocate-default.ts's own `relocateMonth`'s CREATE TABLE IF NOT
    // EXISTS + row population, without going through the full
    // DEFAULT-discovery pipeline: this suite exercises
    // `attachPartitionCheckFirst`'s `options.adminClient` in isolation, not
    // `relocateAllDefaultRows`'s month-discovery loop.
    await appPool.query(`CREATE TABLE IF NOT EXISTS ${CHILD_NAME} (LIKE events INCLUDING ALL)`);
    await appPool.query(
      `INSERT INTO ${CHILD_NAME} (id, workspace_id, contact_id, name, properties, occurred_at)
       SELECT gen_random_uuid(), $1, $2, 'admin-dsn-mechanism-event', '{}'::jsonb, $3::timestamptz
         FROM generate_series(1, 3)`,
      [workspaceId, contactId, MONTH_START],
    );
  }, 60_000);

  afterAll(async () => {
    await adminPool?.end();
    await appPool?.end();
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("without an elevated adminClient, attaching the non-empty child fails with a spurious FK violation", async () => {
    await expect(
      attachPartitionCheckFirst(appPool, EVENTS_TABLE, MONTH_START, MONTH_END),
    ).rejects.toThrow(/foreign key/i);

    // Never attached -- the failed ATTACH's own transaction rolled back
    // (attachPartitionCheckFirst's catch/ROLLBACK). The freestanding child
    // and its 3 rows survive untouched -- they were created/populated
    // OUTSIDE this call, in this file's own beforeAll.
    const { rows } = await pool.query<{ relispartition: boolean }>(
      `SELECT relispartition FROM pg_class WHERE relname = $1`,
      [CHILD_NAME],
    );
    expect(rows[0]?.relispartition, `${CHILD_NAME} must remain freestanding after the failed attach`).toBe(
      false,
    );

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${CHILD_NAME}`,
    );
    expect(Number(countRows[0]?.count ?? 0), "the 3 seeded rows must survive the failed attempt").toBe(3);
  });

  it("with the elevated adminClient, the SAME non-empty child attaches successfully", async () => {
    const attachedName = await attachPartitionCheckFirst(appPool, EVENTS_TABLE, MONTH_START, MONTH_END, {
      adminClient: adminPool,
    });
    expect(attachedName).toBe(CHILD_NAME);

    const { rows } = await pool.query<{ relispartition: boolean }>(
      `SELECT relispartition FROM pg_class WHERE relname = $1`,
      [CHILD_NAME],
    );
    expect(rows[0]?.relispartition, `${CHILD_NAME} must be attached after the elevated retry`).toBe(true);

    const { rows: countRows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${CHILD_NAME}`,
    );
    expect(Number(countRows[0]?.count ?? 0)).toBe(3);

    // Readable through the PARENT, under the owning workspace's ordinary
    // tenant context -- proves the row is a normal, RLS-governed row now
    // that it is attached, not one that stays permanently elevated.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      const { rows: parentRows } = await client.query<{ count: string }>(
        `SELECT count(*) AS count FROM events WHERE name = 'admin-dsn-mechanism-event'`,
      );
      await client.query("COMMIT");
      expect(Number(parentRows[0]?.count ?? 0)).toBe(3);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
});

/**
 * 10-06 (SEC-01/SEC-02, checkpoint option-b): "the elevated DSN is held only
 * by the operator-invoked CLI" is a STRUCTURAL claim -- it must be true of
 * the source, mirroring plan 10-01's P3 pattern for `SCAN_DATABASE_URL`
 * (`apps/api/src/__tests__/env-schema.test.ts`). No DB required -- pure
 * source inspection, repo-root-relative from this file's own location.
 */
describe("P3-style structural check: PARTITION_RELOCATION_ADMIN_DATABASE_URL never reaches a service process", () => {
  const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../..",
  );
  const ACCESS_PATTERN = /process\.env\.PARTITION_RELOCATION_ADMIN_DATABASE_URL/;

  function collectSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__") continue;
      const entryPath = path.join(dir, entry);
      const stat = statSync(entryPath);
      if (stat.isDirectory()) {
        files.push(...collectSourceFiles(entryPath));
      } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
        files.push(entryPath);
      }
    }
    return files;
  }

  it("no file under apps/api/src reads process.env.PARTITION_RELOCATION_ADMIN_DATABASE_URL", () => {
    const dir = path.join(REPO_ROOT, "apps", "api", "src");
    const offenders = collectSourceFiles(dir).filter((file) =>
      ACCESS_PATTERN.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("no file under apps/worker/src reads process.env.PARTITION_RELOCATION_ADMIN_DATABASE_URL", () => {
    const dir = path.join(REPO_ROOT, "apps", "worker", "src");
    const offenders = collectSourceFiles(dir).filter((file) =>
      ACCESS_PATTERN.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("the CLI script itself is the one that reads it", () => {
    const cliSource = readFileSync(
      path.join(REPO_ROOT, "packages", "db", "scripts", "relocate-default-partition-rows.ts"),
      "utf8",
    );
    expect(cliSource).toMatch(ACCESS_PATTERN);
  });
});
