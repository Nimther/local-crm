import { describe, expect, it } from "vitest";

import { checkRootHygiene } from "../../../../scripts/check-root-hygiene.mjs";

/**
 * 08-15 (QG-07) — the working-root blacklist.
 *
 * The check takes directory-entry NAMES rather than a path, which is what lets
 * every case below be a plain assertion instead of a filesystem mutation. That
 * matters here specifically: the executor is tool-denied on the real
 * configuration file, so a test that had to create one to prove the check works
 * could not be written at all.
 *
 * Scope is deliberately the working root and deliberately name-based. A
 * recursive walk would flag legitimate fixture trees (tools/lint-fixtures,
 * tools/migration-fixtures) and the exclusion list needed to quiet it would grow
 * until the check meant nothing. Content-based secret scanning is a different
 * class of check and is Phase 13 (D-29).
 */

describe("checkRootHygiene — configuration files", () => {
  it("flags the configuration file itself", () => {
    expect(checkRootHygiene([".env"])).toEqual([".env"]);
  });

  it("flags a local variant", () => {
    expect(checkRootHygiene([".env.local"])).toEqual([".env.local"]);
  });

  it("flags a backup left behind after editing", () => {
    expect(checkRootHygiene([".env.backup"])).toEqual([".env.backup"]);
  });

  it("permits the example template — it carries no secrets and belongs in the repo", () => {
    expect(checkRootHygiene([".env.example"])).toEqual([]);
  });
});

describe("checkRootHygiene — runtime dumps", () => {
  it("flags a Redis RDB snapshot", () => {
    expect(checkRootHygiene(["dump.rdb"])).toEqual(["dump.rdb"]);
  });

  it("flags a Redis append-only file", () => {
    expect(checkRootHygiene(["appendonly.aof"])).toEqual(["appendonly.aof"]);
  });
});

describe("checkRootHygiene — editor and OS litter", () => {
  it("flags .DS_Store", () => {
    expect(checkRootHygiene([".DS_Store"])).toEqual([".DS_Store"]);
  });
});

describe("checkRootHygiene — a clean root", () => {
  it("reports nothing for the repository's real top-level files", () => {
    expect(
      checkRootHygiene([
        "package.json",
        "README.md",
        "docker-compose.yml",
        ".env.example",
        "SPECIFICATION.md",
        "vitest.config.ts",
        "coverage-baseline.json",
      ]),
    ).toEqual([]);
  });

  it("names every offender, not just the first — the CLI prints them all", () => {
    const offenders = checkRootHygiene(["package.json", ".env", "dump.rdb", ".env.example"]);
    expect(offenders).toEqual([".env", "dump.rdb"]);
  });
});
