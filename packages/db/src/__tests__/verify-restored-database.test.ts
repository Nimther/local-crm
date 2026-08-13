import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
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

import {
  captureRowCountBaseline,
  checkPartitions,
  checkRlsPosture,
  checkRowCounts,
  diffRowCountsAgainstBaseline,
  formatReport,
  loadBaselineFile,
  parseArgs,
  RLS_ACCEPT_EXEMPT,
  saveBaselineFile,
  verifyRestoredDatabase,
} from "../../scripts/verify-restored-database.js";

/**
 * Phase 14 plan 11 (DB-10), Task 1 -- exercises the restore verification
 * query set against ordinary migrated ephemeral databases, so a broken
 * check is caught on every CI run rather than discovered mid-drill
 * (`scripts/restore-drill.sh`'s own dry-run tests, Task 2, cover the shell
 * orchestration; this file covers the check logic itself).
 *
 * Every scenario connects as the cluster SUPERUSER (never the app-role
 * `dsn` `createEphemeralDatabase` hands back) -- this file's own subject
 * REQUIRES a BYPASSRLS connection (see verify-restored-database.ts's header
 * comment for why), so each `describe` below builds that DSN explicitly
 * from `adminDsn` + the ephemeral database's own name, exactly mirroring
 * how `scripts/restore-drill.sh` connects as `postgres` against a real
 * restore.
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

/** `adminDsn` points at the cluster's maintenance `postgres` database -- swap in the ephemeral database's own name, keeping the same (superuser) credentials. */
function superuserDsnFor(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function migrateFreshDatabase(workspace: string): Promise<{
  databaseName: string;
  adminDsn: string;
  superuserPool: Pool;
}> {
  const created = await createEphemeralDatabase({ workspace });

  const appPool = new Pool({ connectionString: created.dsn, max: 2 });
  try {
    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(appPool, MIGRATIONS_DIR, file);
    }
  } finally {
    await appPool.end();
  }

  const superuserPool = new Pool({
    connectionString: superuserDsnFor(created.adminDsn, created.databaseName),
    max: 3,
  });

  return { databaseName: created.databaseName, adminDsn: created.adminDsn, superuserPool };
}

describe("verify-restored-database: ordinary migrated database (14-11, DB-10)", () => {
  let databaseName: string;
  let adminDsn: string;
  let pool: Pool;

  beforeAll(async () => {
    const fixture = await migrateFreshDatabase("verify-restored-happy");
    databaseName = fixture.databaseName;
    adminDsn = fixture.adminDsn;
    pool = fixture.superuserPool;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("checkRowCounts reports every real table with a non-negative count", async () => {
    const { observed } = await checkRowCounts(pool);
    expect(observed.length).toBeGreaterThan(10);
    for (const o of observed) {
      expect(o.count, `${o.table} must report a non-negative count`).toBeGreaterThanOrEqual(0);
    }
    expect(observed.some((o) => o.table === "contacts")).toBe(true);
    expect(observed.some((o) => o.table === "events")).toBe(true);
  });

  it("checkPartitions reports every expected month attached, with no gaps", async () => {
    const partitions = await checkPartitions(pool);
    expect(partitions.length).toBeGreaterThan(0);
    for (const p of partitions) {
      expect(p.ok, `${p.table} missing: ${p.missing.join(", ")}`).toBe(true);
      expect(p.missing).toEqual([]);
      expect(p.attached.length).toBeGreaterThan(0);
    }
  });

  it("checkRlsPosture reports every tenant-scoped table enabled and forced", async () => {
    const rls = await checkRlsPosture(pool);
    expect(rls.checked.length).toBeGreaterThan(10);
    expect(rls.unprotected).toEqual([]);
    expect(rls.ok).toBe(true);
  });

  it("RLS_ACCEPT_EXEMPT names a table that actually exists among the checked set", async () => {
    // Mirrors migrate-from-empty.test.ts's own stale-exemption guard: a
    // renamed/dropped exempt table must fail loudly here too, not silently
    // widen the exemption to nothing.
    const { checked } = await checkRlsPosture(pool);
    for (const exempt of RLS_ACCEPT_EXEMPT) {
      expect(
        checked.includes(exempt),
        `RLS_ACCEPT_EXEMPT names '${exempt}', which is not among the checked tenant-scoped tables -- remove the stale exemption`,
      ).toBe(true);
    }
  });

  it("verifyRestoredDatabase passes end to end and formats an OK report", async () => {
    const result = await verifyRestoredDatabase(pool);
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);

    const report = formatReport(result);
    expect(report).toMatch(/OK: restored database verification passed\./);
    expect(report).toMatch(/contacts: \d+/);
  });

  it("captures a row-count baseline and reports a real delta after a change", async () => {
    const baseline = await captureRowCountBaseline(pool);
    expect(baseline.contacts).toBeGreaterThanOrEqual(0);

    const workspaceId = randomUUID();
    await pool.query(`INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)`, [
      workspaceId,
      "Verify Restored Baseline Co",
      `verify-restored-baseline-${workspaceId.slice(0, 8)}`,
    ]);
    await pool.query(`INSERT INTO contacts (id, workspace_id, external_id) VALUES ($1, $2, $3)`, [
      randomUUID(),
      workspaceId,
      `verify-restored-baseline-contact-${workspaceId.slice(0, 8)}`,
    ]);

    const { observed } = await checkRowCounts(pool);
    const diff = diffRowCountsAgainstBaseline(observed, baseline);

    const contactsDiff = diff.find((d) => d.table === "contacts");
    expect(contactsDiff?.delta).toBe(1);
    const orgDiff = diff.find((d) => d.table === "organization");
    expect(orgDiff?.delta).toBe(1);

    // baseline drift is informational -- it never fails the overall check
    const result = await verifyRestoredDatabase(pool, { baseline });
    expect(result.baselineDiff).toBeDefined();
    expect(result.ok).toBe(true);

    const report = formatReport(result);
    expect(report).toMatch(/Baseline diff/);
  });

  it("round-trips a baseline file through save/load", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "verify-restored-baseline-"));
    const filePath = path.join(dir, "baseline.json");
    try {
      const baseline = { contacts: 42, campaigns: 3 };
      saveBaselineFile(filePath, baseline);
      expect(loadBaselineFile(filePath)).toEqual(baseline);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verify-restored-database: a detached (missing) partition (14-11, DB-10)", () => {
  let databaseName: string;
  let adminDsn: string;
  let pool: Pool;

  beforeAll(async () => {
    const fixture = await migrateFreshDatabase("verify-restored-detached");
    databaseName = fixture.databaseName;
    adminDsn = fixture.adminDsn;
    pool = fixture.superuserPool;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("names the detached partition as missing and fails the overall check", async () => {
    // asOf must cover the WHOLE attached range for a middle-month gap to be
    // visible at all -- checkPartitions only walks earliest..asOf, and this
    // fixture's migrated range extends into 2027, well past real "now".
    // Parsed from the LAST attached name rather than hand-typed, so this
    // stays correct if the migrated range's end ever changes.
    const before = await checkPartitions(pool);
    const eventsBefore = before.find((p) => p.table === "events");
    expect(eventsBefore?.ok).toBe(true);
    expect(eventsBefore!.attached.length).toBeGreaterThan(2);

    const lastMatch = /_(\d{4})_(\d{2})$/.exec(eventsBefore!.attached.at(-1)!);
    const asOf = new Date(Date.UTC(Number(lastMatch![1]), Number(lastMatch![2]) - 1, 1));

    // A MIDDLE month, never the earliest -- detaching the earliest shifts
    // "earliest attached" forward instead of opening a gap, which would
    // prove nothing about this check's gap-detection logic.
    const middleName = eventsBefore!.attached[Math.floor(eventsBefore!.attached.length / 2)];
    await pool.query(`ALTER TABLE events DETACH PARTITION ${middleName}`);

    const after = await checkPartitions(pool, undefined, asOf);
    const eventsAfter = after.find((p) => p.table === "events");
    expect(eventsAfter?.ok).toBe(false);
    expect(eventsAfter?.missing).toContain(middleName);

    const result = await verifyRestoredDatabase(pool, { asOf });
    expect(result.ok).toBe(false);

    const report = formatReport(result);
    expect(report).toMatch(/FAIL: restored database verification failed\./);
    expect(report).toMatch(new RegExp(`MISSING \\(${middleName}`));
  });
});

describe("verify-restored-database: RLS enabled but not forced (14-11, DB-10)", () => {
  let databaseName: string;
  let adminDsn: string;
  let pool: Pool;

  beforeAll(async () => {
    const fixture = await migrateFreshDatabase("verify-restored-rls-not-forced");
    databaseName = fixture.databaseName;
    adminDsn = fixture.adminDsn;
    pool = fixture.superuserPool;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("names the table as unprotected and fails the overall check", async () => {
    await pool.query(`ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY`);

    const rls = await checkRlsPosture(pool);
    expect(rls.ok).toBe(false);
    expect(rls.unprotected).toContain("contacts");

    const result = await verifyRestoredDatabase(pool);
    expect(result.ok).toBe(false);

    const report = formatReport(result);
    expect(report).toMatch(/NOT enabled-and-forced:.*contacts/);
  });
});

describe("verify-restored-database: cannot connect (14-11, DB-10)", () => {
  it("never reports success when the database is unreachable", async () => {
    // Port 1 on loopback -- nothing listens there, so this fails fast
    // (ECONNREFUSED) rather than hanging.
    const pool = new Pool({
      connectionString: "postgresql://postgres:postgres@127.0.0.1:1/does-not-matter",
      max: 1,
    });
    pool.on("error", () => {
      // Swallowed deliberately -- this test asserts on verifyRestoredDatabase's
      // own return value, not on the pool's background error events.
    });

    try {
      const result = await verifyRestoredDatabase(pool);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.rowCounts).toBeUndefined();
      expect(result.partitions).toBeUndefined();
      expect(result.rls).toBeUndefined();

      const report = formatReport(result);
      expect(report).toMatch(/^ERROR: verification could not complete/m);
      expect(report).not.toMatch(/OK: restored database verification passed\./);
    } finally {
      await pool.end();
    }
  });
});

describe("verify-restored-database: CLI argument parsing (pure)", () => {
  it("parses --baseline, --as-of and --capture-baseline", () => {
    const args = parseArgs(["--baseline=/tmp/baseline.json", "--as-of=2026-01-01T00:00:00Z"]);
    expect(args).toMatchObject({ baselinePath: "/tmp/baseline.json" });
    expect(args.asOf?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

    expect(parseArgs(["--capture-baseline=/tmp/out.json"])).toEqual({
      captureBaselineTo: "/tmp/out.json",
    });
  });

  it("rejects an invalid --as-of value and an unrecognized flag", () => {
    expect(() => parseArgs(["--as-of=not-a-date"])).toThrow(/not a valid date/);
    expect(() => parseArgs(["--nonsense"])).toThrow(/unrecognized argument/);
  });
});
