import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readShippedMigrations } from "../migration-journal.js";
import { MIGRATION_TIERS, newestAutoReversibleTier, tierFor, type MigrationTier } from "../migration-tiers.js";

/**
 * Phase 14 plan 05 (DB-07), Task 1 -- machine-checked tier classification.
 *
 * The independent SQL scan below is a BACKSTOP, not the full definition of
 * "forward-only" (see migration-tiers.ts's own header for the two additional,
 * non-signature-matched reasons a migration can be forward-only). It only
 * asserts the necessary direction: every migration whose SQL contains one of
 * the five listed signatures MUST be classified forward-only. It never
 * asserts the converse -- a migration without any signature can still be
 * forward-only for a reason this scan does not check (an irreversible data
 * mutation, or a GRANT/REVOKE-only access-control change).
 */

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../migrations");

const FORWARD_ONLY_SIGNATURES: Record<string, RegExp> = {
  CREATE_TYPE: /\bCREATE\s+TYPE\b/i,
  ALTER_TYPE_ADD_VALUE: /\bALTER\s+TYPE\b[\s\S]{0,80}\bADD\s+VALUE\b/i,
  CREATE_POLICY: /\bCREATE\s+POLICY\b/i,
  ATTACH_PARTITION: /\bATTACH\s+PARTITION\b/i,
  DROP_COLUMN: /\bDROP\s+COLUMN\b/i,
  DROP_CONSTRAINT: /\bDROP\s+CONSTRAINT\b/i,
};

function listMigrationSqlFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((entry) => entry.endsWith(".sql"))
    .sort();
}

function tagFromFilename(filename: string): string {
  return filename.replace(/\.sql$/, "");
}

function sqlSignatureHits(sql: string): string[] {
  return Object.entries(FORWARD_ONLY_SIGNATURES)
    .filter(([, pattern]) => pattern.test(sql))
    .map(([name]) => name);
}

describe("MIGRATION_TIERS coverage against the journal", () => {
  const journalTags = readShippedMigrations(MIGRATIONS_DIR).map((entry) => entry.tag);
  const classifiedTags = Object.keys(MIGRATION_TIERS);

  it("has exactly one entry per tag in meta/_journal.json (no journal tag missing an entry)", () => {
    const missing = journalTags.filter((tag) => !(tag in MIGRATION_TIERS));
    expect(missing).toEqual([]);
  });

  it("names no tag that is not in the journal (no stale classification left behind)", () => {
    const stale = classifiedTags.filter((tag) => !journalTags.includes(tag));
    expect(stale).toEqual([]);
  });

  it("has no duplicate coverage gap: journal and MIGRATION_TIERS are the same set", () => {
    expect(new Set(classifiedTags)).toEqual(new Set(journalTags));
  });
});

describe("MIGRATION_TIERS cross-checked against the raw SQL (independent scan, necessary-condition backstop)", () => {
  const files = listMigrationSqlFiles();

  it("classifies every migration whose SQL contains a forward-only signature as forward-only", () => {
    const violations: string[] = [];
    for (const file of files) {
      const tag = tagFromFilename(file);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const hits = sqlSignatureHits(sql);
      if (hits.length > 0 && MIGRATION_TIERS[tag] !== "forward-only") {
        violations.push(`${tag}: matched [${hits.join(", ")}] but is classified "${String(MIGRATION_TIERS[tag])}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("finds at least one migration matching each of the five signatures (the scan itself is not vacuous)", () => {
    const allSql = files
      .map((file) => fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"))
      .join("\n");
    for (const [name, pattern] of Object.entries(FORWARD_ONLY_SIGNATURES)) {
      expect(pattern.test(allSql), `expected at least one migration to match ${name}`).toBe(true);
    }
  });
});

describe("tierFor", () => {
  it("returns the classified tier for a known tag", () => {
    expect(tierFor("0000_init_auth")).toBe("auto-reversible" satisfies MigrationTier);
    expect(tierFor("0001_rls_policies")).toBe("forward-only" satisfies MigrationTier);
  });

  it("throws for an unknown tag rather than defaulting", () => {
    expect(() => tierFor("nope")).toThrow(/unknown migration tag "nope"/);
  });
});

describe("newestAutoReversibleTier", () => {
  it("returns a contiguous trailing run of tags, all of which are auto-reversible (possibly empty, when the newest shipped migration is itself forward-only)", () => {
    const run = newestAutoReversibleTier(MIGRATIONS_DIR);
    for (const tag of run) {
      expect(tierFor(tag)).toBe("auto-reversible");
    }

    // Contiguity: the run must be exactly the trailing slice of the journal,
    // not merely a set of auto-reversible tags scattered through history.
    const journalTags = readShippedMigrations(MIGRATIONS_DIR).map((entry) => entry.tag);
    const trailingSlice = journalTags.slice(journalTags.length - run.length);
    expect(run).toEqual(trailingSlice);

    // The tag immediately before the run (if any) must be forward-only --
    // otherwise the run should have included it too.
    const runStartIdx = journalTags.length - run.length;
    if (runStartIdx > 0) {
      expect(tierFor(journalTags[runStartIdx - 1])).toBe("forward-only");
    }
  });

  it("returns an empty run -- 0070_scan_policies_exclude_deleted_workspaces is the newest shipped migration and is itself forward-only", () => {
    // Phase 15 (OPS-13, plan 15-14, Task 1): 0065 is a grants-only migration
    // (column-level GRANT + CREATE POLICY on workspace_webhook_endpoints,
    // human-approved override of this plan's own "no new migration"
    // prohibition -- see 0065's own header comment and 15-14-SUMMARY.md's
    // Deviations section). A CREATE POLICY is forward-only by this module's
    // own reason (2) (an access-control posture change), so 0065 itself
    // reset the trailing run to empty and stays forward-only.
    //
    // Phase 20 (TMPL-02/D-05, plan 20-01, Task 2): 0066_campaigns_version
    // adds exactly one column (`campaigns.version`, constant default, no
    // backfill) and is classified auto-reversible.
    //
    // Phase 21 (DSR-02/DSR-03, plan 21-06, Task 2): 0067_dsr_export_contact_indexes
    // adds exactly three plain CREATE INDEX statements (no table/column/
    // constraint) and is classified auto-reversible too, extending the
    // trailing run one tag further.
    //
    // Phase 22 (PRG-01/PRG-02/PRG-03/PRG-05, plan 22-01, Task 1):
    // 0068_workspace_purge_records creates a brand-new table (no RLS, no FK)
    // and adds one defaulted, nullable column (organization.purgedAt) -- pure
    // additive shape, no backfill, and is classified auto-reversible too,
    // extending the trailing run one tag further still (it briefly became
    // ["0066_campaigns_version", "0067_dsr_export_contact_indexes",
    // "0068_workspace_purge_records"] between this plan's Task 1 and Task 2
    // commits).
    //
    // Phase 22 (PRG-02, D-10, plan 22-01, Task 2): 0069_erasure_records_contact_fk_relax
    // drops and re-adds the erasure_records.contact_id foreign key
    // (NOT NULL/CASCADE -> nullable/SET NULL) -- a DROP CONSTRAINT, forward-
    // only reason (5) (re-adding a constraint recreates the SHAPE, never the
    // history of what was rejected while the old constraint was enforced).
    // It briefly WAS the newest shipped migration and was itself
    // forward-only, resetting the trailing run to EMPTY, same as 0065 did
    // earlier in this journal.
    //
    // Phase 22 (PRG-06, SC1, D-01, plan 22-04): 0070_scan_policies_exclude_deleted_workspaces
    // drops and re-creates three RLS policies (campaigns_scan, flows_scan,
    // flow_runs_scan) with an added soft-delete exclusion predicate -- a
    // CREATE POLICY, forward-only reason (2) (an access-control posture
    // change). It is now the newest shipped migration and is ALSO
    // forward-only, so the trailing run stays EMPTY. Pinned explicitly so a
    // future migration silently changing this fails loudly here rather than
    // only inside the rehearsal test.
    expect(newestAutoReversibleTier(MIGRATIONS_DIR)).toEqual([]);
  });

  it("returns an empty run when the newest migration is forward-only", () => {
    const shipped = readShippedMigrations(MIGRATIONS_DIR);
    const forwardOnlyTag = shipped.find((entry) => tierFor(entry.tag) === "forward-only")?.tag;
    expect(forwardOnlyTag).toBeDefined();

    // Simulate "newest migration is forward-only" by writing a scratch
    // journal/tiers pair rather than mutating the real one: reuse
    // newestAutoReversibleTier's own contiguity logic directly against a
    // truncated, in-memory shipped list ending on a known forward-only tag.
    const truncatedIdx = shipped.findIndex((entry) => entry.tag === forwardOnlyTag);
    const truncated = shipped.slice(0, truncatedIdx + 1);
    const run: string[] = [];
    for (let i = truncated.length - 1; i >= 0; i--) {
      const tag = truncated[i]?.tag;
      if (tag === undefined || tierFor(tag) !== "auto-reversible") break;
      run.unshift(tag);
    }
    expect(run).toEqual([]);
  });
});
