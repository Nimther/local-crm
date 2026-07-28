import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkDestructiveDdl,
  checkEnumAddValueSameFile,
  lintMigrationDirectory,
  lintMigrationFile,
  stripSqlComments,
} from "../../../../scripts/lint-migrations.mjs";

/**
 * 08-05 (DB-08) — migration linter.
 *
 * Two rules, both of which exist to stop a class of failure that is only
 * discovered at deploy time:
 *
 *   1. `enum-add-value-used-same-file` — Postgres refuses to let a freshly
 *      added enum value be used inside the transaction that added it, and this
 *      repo applies each migration file as a single client.query(sql) call.
 *      This is the rule that protects Phase 11's `'reconciling'` addition.
 *   2. `destructive-ddl-unmarked` — DROP COLUMN, or ADD COLUMN ... NOT NULL
 *      with no DEFAULT, must carry a reason-bearing marker on the immediately
 *      preceding line. Line-scoped, never file-scoped (D-31), mirroring the
 *      eslint-disable-next-line policy in D-06.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const FIXTURES = path.join(REPO_ROOT, "tools/migration-fixtures");
const MIGRATIONS = path.join(REPO_ROOT, "packages/db/migrations");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

describe("stripSqlComments", () => {
  it("removes single-line -- comments to end of line", () => {
    expect(stripSqlComments("SELECT 1; -- a note\nSELECT 2;")).not.toContain("a note");
  });

  it("removes block comments", () => {
    expect(stripSqlComments("SELECT 1; /* a\nmultiline note */ SELECT 2;")).not.toContain("note");
  });
});

describe("checkEnumAddValueSameFile", () => {
  it("flags a file that adds an enum value and then uses it", () => {
    const violations = checkEnumAddValueSameFile(
      "bad-enum-same-file.sql",
      fixture("bad-enum-same-file.sql"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("enum-add-value-used-same-file");
    expect(violations[0].detail).toContain("reconciling");
  });

  it("passes a file that only adds the enum value", () => {
    expect(
      checkEnumAddValueSameFile(
        "good-enum-separate-file.sql",
        fixture("good-enum-separate-file.sql"),
      ),
    ).toHaveLength(0);
  });

  it("does not flag a literal that appears only inside a comment", () => {
    const sql = [
      "ALTER TYPE \"send_status\" ADD VALUE 'reconciling';",
      "-- a later migration will set status to 'reconciling'",
    ].join("\n");
    expect(checkEnumAddValueSameFile("commented.sql", sql)).toHaveLength(0);
  });

  it("handles more than one ADD VALUE statement in one file", () => {
    const sql = [
      "ALTER TYPE \"t\" ADD VALUE 'alpha';",
      "ALTER TYPE \"t\" ADD VALUE 'beta';",
      "UPDATE x SET s = 'beta';",
    ].join("\n");
    const violations = checkEnumAddValueSameFile("multi.sql", sql);
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain("beta");
  });
});

describe("checkDestructiveDdl", () => {
  it("flags both unmarked destructive statements with distinct line numbers", () => {
    const violations = checkDestructiveDdl(
      "bad-destructive-unmarked.sql",
      fixture("bad-destructive-unmarked.sql"),
    );
    expect(violations).toHaveLength(2);
    expect(violations.every((v: { rule: string }) => v.rule === "destructive-ddl-unmarked")).toBe(true);
    expect(violations[0].line).not.toBe(violations[1].line);
  });

  it("passes when each statement carries a reason-bearing marker on the prior line", () => {
    expect(
      checkDestructiveDdl(
        "good-destructive-marked.sql",
        fixture("good-destructive-marked.sql"),
      ),
    ).toHaveLength(0);
  });

  it("rejects a marker with no reason text after the colon", () => {
    const sql = ["-- destructive:", 'ALTER TABLE "t" DROP COLUMN "c";'].join("\n");
    expect(checkDestructiveDdl("bare-marker.sql", sql)).toHaveLength(1);
  });

  it("does not let a marker on line 1 blanket a statement further down", () => {
    const sql = [
      "-- destructive: this reason is far away from the statement",
      "",
      "SELECT 1;",
      "",
      'ALTER TABLE "t" DROP COLUMN "c";',
    ].join("\n");
    const violations = checkDestructiveDdl("far-marker.sql", sql);
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(5);
  });

  it("does not flag ADD COLUMN ... NOT NULL when a DEFAULT is present", () => {
    const sql = 'ALTER TABLE "campaigns" ADD COLUMN "opened_count" integer DEFAULT 0 NOT NULL;';
    expect(checkDestructiveDdl("safe.sql", sql)).toHaveLength(0);
  });

  // 08-REVIEW WR-02: ADD COLUMN and NOT NULL wrapped across separate physical
  // lines used to evade the rule entirely, since the old check tested both
  // keywords against a single line at a time.
  it("flags an unsafe ADD COLUMN ... NOT NULL statement wrapped across lines", () => {
    const violations = checkDestructiveDdl(
      "bad-destructive-multiline.sql",
      fixture("bad-destructive-multiline.sql"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("destructive-ddl-unmarked");
    expect(violations[0].line).toBe(6);
  });

  it("does not flag a marked statement wrapped across lines", () => {
    const sql = [
      "-- destructive: multi-line statement, marker still applies",
      'ALTER TABLE "campaigns"',
      '  DROP',
      '  COLUMN "legacy_note";',
    ].join("\n");
    expect(checkDestructiveDdl("good-multiline.sql", sql)).toHaveLength(0);
  });
});

describe("lintMigrationFile", () => {
  it("concatenates violations from both rules", () => {
    expect(
      lintMigrationFile("bad-enum-same-file.sql", fixture("bad-enum-same-file.sql")),
    ).toHaveLength(1);
    expect(
      lintMigrationFile("bad-destructive-unmarked.sql", fixture("bad-destructive-unmarked.sql")),
    ).toHaveLength(2);
  });
});

describe("lintMigrationDirectory", () => {
  it("reports zero violations across every real migration", () => {
    const violations = lintMigrationDirectory(MIGRATIONS);
    expect(violations).toEqual([]);
  });
});
