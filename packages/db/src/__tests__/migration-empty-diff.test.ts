import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkEmptyDiff, listSnapshotFiles } from "../../scripts/check-empty-diff.js";

/**
 * Phase 14 plan 05 (DB-07), Task 2 -- the ROADMAP's empty-diff smoke test.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT (RESEARCH.md Pitfall D): this test
 * proves that `packages/db/src/schema/*.ts` (the current TypeScript schema)
 * and `packages/db/migrations/meta/`'s newest snapshot agree -- nothing
 * more. `drizzle-kit generate`'s diff engine never connects to a database;
 * a manual, unrecorded `ALTER TABLE` run directly against a live database
 * would pass this test cleanly, because this test never looks at a live
 * database either. The separate proof that the SHIPPED SQL FILES actually
 * produce this schema when applied from empty is
 * `migrate-from-empty.test.ts`'s full-chain-application test. Both checks
 * are required; this file provides only the first.
 *
 * `checkEmptyDiff` (packages/db/scripts/check-empty-diff.ts) is the ONE
 * implementation this test calls -- the same function `npm run
 * db:check-empty-diff` invokes for an operator. Neither this test nor that
 * script ever calls drizzle-kit's `writeResult` (the function that actually
 * writes a new migration/snapshot/journal entry to disk), so neither can
 * ever leave an untracked file behind (T-14-25) -- proven below by diffing
 * `git status`-equivalent directory listings before and after, not merely
 * assumed from the mechanism.
 */

const REAL_MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");
const REAL_SCHEMA_DIR = path.resolve(import.meta.dirname, "../schema");

function listDirRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listDirRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out.sort();
}

describe("checkEmptyDiff against the real repository (the CI-enforced copy of db:check-empty-diff)", () => {
  it("produces no new migration for the current schema, and reports what it compared", async () => {
    const before = listDirRecursive(REAL_MIGRATIONS_DIR);

    const result = await checkEmptyDiff({
      migrationsDir: REAL_MIGRATIONS_DIR,
      schemaDir: REAL_SCHEMA_DIR,
    });

    const after = listDirRecursive(REAL_MIGRATIONS_DIR);

    expect(result.empty).toBe(true);
    expect(result.sqlStatements).toEqual([]);
    // Diagnosable on failure: which snapshot, how many shipped migrations.
    // 0066 (Phase 20 plan 20-01, TMPL-02/D-05) adds `campaigns.version` --
    // a real packages/db/src/schema/*.ts change, so it DOES ship its own
    // snapshot (0066_snapshot.json, chaining from 0064_snapshot.json since
    // 0065 was grants-only and shipped none).
    // 0067 (Phase 21 plan 21-06, DSR-02/DSR-03) is SQL-only (three plain
    // CREATE INDEX statements, no packages/db/src/schema/*.ts change) --
    // same precedent as 0065, so it ships NO snapshot of its own.
    // Phase 22 (plan 22-01): 0068_workspace_purge_records DOES change
    // packages/db/src/schema/*.ts (purge-records.ts's new table, plus
    // organization.purgedAt), and 0069_erasure_records_contact_fk_relax
    // also does (erasure-records.ts's contactId becomes nullable/SET NULL)
    // -- rather than one snapshot per migration, both are folded into ONE
    // new snapshot (0069_snapshot.json, chaining from 0066_snapshot.json)
    // attached to the newest of the two, mirroring the existing precedent
    // that a SQL-only migration between two schema-changing ones (0067
    // between 0066 and this pair) never gets a snapshot of its own -- what
    // this check actually requires is that the NEWEST snapshot equal
    // current schema.ts, not a 1:1 migration-to-snapshot mapping.
    // comparedAgainstSnapshot and snapshotFileCount move to that new file;
    // shippedMigrationCount grows to 70 (two more shipped tags in the
    // journal); snapshotFileCount grows to 16 (one new snapshot file).
    //
    // Phase 22 (PRG-06, SC1, D-01, plan 22-04): 0070_scan_policies_exclude_deleted_workspaces
    // is SQL-only (DROP POLICY + CREATE POLICY x3, no packages/db/src/schema/*.ts
    // change) -- same precedent as 0065/0067, so it ships NO snapshot of its
    // own. comparedAgainstSnapshot and snapshotFileCount are therefore
    // UNCHANGED by this migration; only shippedMigrationCount grows to 71.
    expect(result.comparedAgainstSnapshot).toBe("0069_snapshot.json");
    expect(result.shippedMigrationCount).toBe(71);
    expect(result.snapshotFileCount).toBe(16);

    // Never touches the repository -- proven, not assumed: the directory
    // listing (every file under packages/db/migrations, recursively) is
    // byte-for-byte identical before and after this check runs.
    expect(after).toEqual(before);
  });

  it("test:migrations remains green after the backfill (companion assertion -- run separately in <verify>, asserted here as a smoke check on the shipped chain shape)", () => {
    const journal = JSON.parse(
      fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
    ) as { entries: { tag: string }[] };
    // The backfilled snapshot's own prevId must chain from the snapshot that
    // preceded it (0034), and its filename must match the newest SCHEMA-
    // CHANGING migration's tag prefix -- a mismatch here would mean
    // db:check-empty-diff is silently comparing against the wrong point in
    // history. Phase 22 (plan 22-01): 0069_erasure_records_contact_fk_relax
    // was both the newest SCHEMA-CHANGING migration (asserted separately
    // above via `comparedAgainstSnapshot`, which stays UNCHANGED by 0070
    // below) AND the newest SHIPPED migration at that point.
    //
    // Phase 22 (plan 22-04): 0070_scan_policies_exclude_deleted_workspaces is
    // SQL-only (no packages/db/src/schema/*.ts change), so it does not move
    // `comparedAgainstSnapshot` -- but it IS now the newest SHIPPED
    // migration overall. This assertion tracks the JOURNAL's newest tag,
    // which is now 0070.
    const newestTag = journal.entries[journal.entries.length - 1]?.tag;
    expect(newestTag).toBe("0070_scan_policies_exclude_deleted_workspaces");
  });
});

describe("checkEmptyDiff detects an unmigrated schema change (negative case -- the scan is not vacuous)", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "mega-crm-empty-diff-negative-"));
    fs.cpSync(REAL_MIGRATIONS_DIR, path.join(scratchDir, "migrations"), { recursive: true });
    // Two SEPARATE schema directories (distinct absolute paths), not one
    // directory mutated in place: Node's ESM module cache is keyed by file
    // path/URL and persists for the life of this test-worker process, so a
    // "mutate, check, revert, check-again" sequence against the SAME path
    // would silently re-serve the first import's cached module on the
    // second check. Two paths sidesteps the caching question entirely
    // rather than fighting it (loadCurrentSchemaImports's own doc comment
    // in check-empty-diff.ts explains why cache-busting was rejected).
    fs.cpSync(REAL_SCHEMA_DIR, path.join(scratchDir, "schema-original"), { recursive: true });
    fs.cpSync(REAL_SCHEMA_DIR, path.join(scratchDir, "schema-mutated"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  });

  it("fails (non-empty diff) when a schema file gains a column with no matching migration, and passes on the unmutated schema", async () => {
    const originalFile = path.join(scratchDir, "schema-original/segments.ts");
    const mutatedFile = path.join(scratchDir, "schema-mutated/segments.ts");
    const original = fs.readFileSync(originalFile, "utf8");

    // Introduce an unmigrated additive change: one new nullable column on an
    // existing table. Small and unambiguous on purpose -- large synthetic
    // diffs can trigger drizzle-kit's interactive rename-conflict prompt,
    // which requires a TTY and would make this test flaky/hanging in CI.
    const mutated = original.replace(
      'memberCount: integer("member_count"),',
      'memberCount: integer("member_count"),\n  emptyDiffProbeColumn: text("empty_diff_probe_column"),',
    );
    expect(mutated).not.toBe(original); // guard against a silent no-op replace if the fixture line ever moves
    fs.writeFileSync(mutatedFile, mutated);

    const failing = await checkEmptyDiff({
      migrationsDir: path.join(scratchDir, "migrations"),
      schemaDir: path.join(scratchDir, "schema-mutated"),
    });
    expect(failing.empty).toBe(false);
    expect(failing.sqlStatements.length).toBeGreaterThan(0);
    expect(failing.sqlStatements.join("\n")).toContain("empty_diff_probe_column");

    const passing = await checkEmptyDiff({
      migrationsDir: path.join(scratchDir, "migrations"),
      schemaDir: path.join(scratchDir, "schema-original"),
    });
    expect(passing.empty).toBe(true);
  });
});

describe("listSnapshotFiles", () => {
  it("returns snapshot filenames sorted, excluding the journal file", () => {
    const files = listSnapshotFiles(path.join(REAL_MIGRATIONS_DIR, "meta"));
    expect(files).not.toContain("_journal.json");
    expect(files).toEqual([...files].sort());
    expect(files[files.length - 1]).toBe("0069_snapshot.json");
  });
});
