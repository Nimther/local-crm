// Phase 14 plan 13 (DB-14 §3 filing gate). Tests for
// scripts/check-spec-env-coverage.mjs.
//
// Mirrors scripts/__tests__/lint-session-state.test.mjs's mix: pure exported
// helpers asserted directly with in-memory/fixture strings, plus the real
// docker/prod.env.example + SPECIFICATION.md pair asserted with a non-zero
// checked-name count, so a vacuous pass (an accidentally-empty env.example,
// or a coverage check that silently examined zero names) is caught here
// before it is caught by npm run check:spec-env-coverage in CI.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  checkSpecEnvCoverage,
  extractEnvVarNames,
  findMissingNames,
} from "../check-spec-env-coverage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURES_DIR = path.join(__dirname, "../__fixtures__/spec-env-coverage");

function readFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

describe("extractEnvVarNames", () => {
  it("extracts every uncommented NAME=, de-duplicated, in first-seen order", () => {
    const names = extractEnvVarNames(readFixture("env.example"));
    expect(names).toEqual([
      "GHCR_IMAGE_BASE",
      "IMAGE_TAG",
      "FIXTURE_SECRET_ONE",
      "FIXTURE_SECRET_TWO",
      "FIXTURE_PREFIX",
      "FIXTURE_PREFIX_LONGER",
    ]);
  });

  it("never extracts a commented-out placeholder line", () => {
    const names = extractEnvVarNames(readFixture("env.example"));
    expect(names).not.toContain("API_PORT");
  });

  it("extracts a name with an empty (secret) assignment, not just a valued one", () => {
    const names = extractEnvVarNames("FIXTURE_ONLY=\n");
    expect(names).toEqual(["FIXTURE_ONLY"]);
  });
});

describe("findMissingNames", () => {
  it("reports nothing missing against the passing fixture spec", () => {
    const names = extractEnvVarNames(readFixture("env.example"));
    const missing = findMissingNames(names, readFixture("passing-spec.md"));
    expect(missing).toEqual([]);
  });

  it("reports exactly the missing names against the missing-name fixture spec", () => {
    const names = extractEnvVarNames(readFixture("env.example"));
    const missing = findMissingNames(names, readFixture("missing-spec.md"));
    expect(missing.sort()).toEqual(["FIXTURE_PREFIX", "FIXTURE_SECRET_TWO"]);
  });

  it("does not credit a shorter name merely because a longer name sharing its prefix is present (word-boundary, not substring, containment)", () => {
    const missing = findMissingNames(
      ["FIXTURE_PREFIX"],
      "the spec mentions only `FIXTURE_PREFIX_LONGER` here",
    );
    expect(missing).toEqual(["FIXTURE_PREFIX"]);
  });

  it("does credit an exact name that is genuinely present at a word boundary", () => {
    const missing = findMissingNames(
      ["FIXTURE_PREFIX"],
      "the spec mentions `FIXTURE_PREFIX` here",
    );
    expect(missing).toEqual([]);
  });
});

describe("checkSpecEnvCoverage against fixture files", () => {
  it("passing case: zero missing, checkedCount matches the fixture's name count", () => {
    const result = checkSpecEnvCoverage({
      envExamplePath: path.join(FIXTURES_DIR, "env.example"),
      specPath: path.join(FIXTURES_DIR, "passing-spec.md"),
      cwd: REPO_ROOT,
    });
    expect(result.checkedCount).toBe(6);
    expect(result.missing).toEqual([]);
  });

  it("missing-name case: reports the two names absent from the fixture spec", () => {
    const result = checkSpecEnvCoverage({
      envExamplePath: path.join(FIXTURES_DIR, "env.example"),
      specPath: path.join(FIXTURES_DIR, "missing-spec.md"),
      cwd: REPO_ROOT,
    });
    expect(result.checkedCount).toBe(6);
    expect(result.missing.sort()).toEqual(["FIXTURE_PREFIX", "FIXTURE_SECRET_TWO"]);
  });
});

describe("checkSpecEnvCoverage against the real repository files", () => {
  it("exits (would exit) 0 against the real docker/prod.env.example and SPECIFICATION.md, with a non-zero checked-name count", () => {
    const result = checkSpecEnvCoverage({ cwd: REPO_ROOT });
    expect(result.checkedCount).toBeGreaterThan(0);
    expect(result.missing).toEqual([]);
  });
});
