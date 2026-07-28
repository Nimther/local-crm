import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listMigrationFiles } from "../migration-runner.js";

/**
 * 08-09 (QG-05) — the filename-ordering backstop.
 *
 * `readdirSync().sort()` is lexicographic. It agrees with numeric order only
 * while every migration name is zero-padded, and nothing about the sort itself
 * says so. A `9_fix.sql` added later would apply BEFORE `10_fix.sql`, silently,
 * and no downstream test could tell — by the time the list is returned the
 * information is already lost.
 *
 * Pure filesystem assertions: no database is involved.
 */
describe("listMigrationFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mega-crm-migrations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(...names: string[]): void {
    for (const name of names) writeFileSync(path.join(dir, name), "SELECT 1;");
  }

  it("returns padded .sql files in application order", () => {
    write("0002_c.sql", "0000_a.sql", "0001_b.sql");
    expect(listMigrationFiles(dir)).toEqual(["0000_a.sql", "0001_b.sql", "0002_c.sql"]);
  });

  it("ignores non-.sql entries", () => {
    write("0000_a.sql", "notes.md", "meta.json");
    expect(listMigrationFiles(dir)).toEqual(["0000_a.sql"]);
  });

  it("throws on a filename with no zero-padded prefix, naming the offender", () => {
    write("0009_ok.sql", "9_fix.sql");
    expect(() => listMigrationFiles(dir)).toThrow(/9_fix\.sql/);
    expect(() => listMigrationFiles(dir)).toThrow(/zero-padded/);
  });

  it("throws on an under-padded prefix that would sort wrong against a 4-digit name", () => {
    // The concrete hazard: lexicographically "10_late" < "0009_early".
    write("0009_early.sql", "10_late.sql");
    expect(() => listMigrationFiles(dir)).toThrow(/10_late\.sql/);
  });

  it("accepts more than four digits, so the convention can grow", () => {
    write("0000_a.sql", "10000_z.sql");
    expect(listMigrationFiles(dir)).toEqual(["0000_a.sql", "10000_z.sql"]);
  });

  // 08-REVIEW WR-05: the previous coincidentally-safe fixture above
  // ("0000_a.sql" vs "10000_z.sql") never exercises the unsafe pairing --
  // the leading '0' vs '1' happens to sort correctly under plain string
  // comparison. This one does not: lexicographically "0009_..." > "00010_..."
  // (comparing character-by-character, '9' > '1' at position 4), even
  // though 9 < 10 numerically, so a naive `.sort()` would apply the 10th
  // migration BEFORE the 9th.
  it("orders a 5-digit prefix correctly against a 4-digit prefix, even when lexicographic order disagrees", () => {
    write("00010_tenth.sql", "0009_ninth.sql");
    expect(listMigrationFiles(dir)).toEqual(["0009_ninth.sql", "00010_tenth.sql"]);
  });

  it("returns an empty list for a directory with no migrations", () => {
    expect(listMigrationFiles(dir)).toEqual([]);
  });
});
