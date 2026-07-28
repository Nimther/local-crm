import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkLintFileFloor } from "../../../../scripts/check-lint-file-floor.mjs";

/**
 * 08-03 (QG-02) — the lint gate proves itself.
 *
 * A lint gate that has only ever been seen to pass is indistinguishable from a
 * lint gate that checks nothing. These assertions prove it FAILS first:
 * on a single violation of an enabled rule, on a focused test, and on a
 * file-count that has silently collapsed.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const FIXTURES = path.join(REPO_ROOT, "tools/lint-fixtures");

/** Run ESLint and return { exitCode, report }. --no-ignore reaches the fixtures. */
function runEslint(args: string[]): { exitCode: number; report: Array<Record<string, any>> } {
  try {
    const stdout = execFileSync(
      "npx",
      ["eslint", "--no-ignore", "--format", "json", ...args],
      { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return { exitCode: 0, report: JSON.parse(stdout) };
  } catch (err: any) {
    return { exitCode: err.status ?? 1, report: JSON.parse(err.stdout || "[]") };
  }
}

function ruleIds(report: Array<Record<string, any>>): string[] {
  return report.flatMap((f) => f.messages).map((m: any) => m.ruleId);
}

describe("lint gate fails on a single violation", () => {
  it("rejects a floating promise with the type-aware rule", () => {
    const { exitCode, report } = runEslint([path.join(FIXTURES, "floating-promise.ts")]);
    expect(exitCode).toBe(1);
    expect(ruleIds(report)).toContain("@typescript-eslint/no-floating-promises");
  });

  it("rejects a focused test", () => {
    const { exitCode, report } = runEslint([path.join(FIXTURES, "focused-test.test.ts")]);
    expect(exitCode).toBe(1);
    expect(ruleIds(report)).toContain("vitest/no-focused-tests");
  });
});

describe("focused-test marker is not auto-fixable", () => {
  it("leaves the file byte-identical after eslint --fix", () => {
    const source = path.join(FIXTURES, "focused-test.test.ts");
    const copy = path.join(tmpdir(), `gsd-08-03-focused-${process.pid}.test.ts`);
    copyFileSync(source, copy);
    const before = readFileSync(copy);

    try {
      execFileSync("npx", ["eslint", "--no-ignore", "--fix", copy], {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
    } catch {
      // --fix still exits 1 because the violation is unfixable. That IS the point.
    }

    // If the rule were fixable, --fix would strip the .only and erase the very
    // evidence the rule exists to surface (D-07).
    expect(readFileSync(copy).equals(before)).toBe(true);
  });
});

describe("no blanket file-level eslint-disable", () => {
  it("finds zero file-level disable directives that name no rule", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
      .filter((f) => !f.startsWith("tools/lint-fixtures/"));

    // Matches a block-comment disable directive carrying no rule list. A
    // directive that names rules is allowed (D-06); one that names nothing is
    // the blanket suppression this asserts against.
    //
    // Deliberately no literal example in this comment: an example would be
    // matched by the very scan below, and this file is itself tracked. That is
    // not hypothetical — it failed exactly that way once.
    const blanket = /\/\*\s*eslint-disable\s*\*\//;

    const offenders = tracked.filter((f) => {
      const full = path.join(REPO_ROOT, f);
      try {
        if (!statSync(full).isFile()) return false;
        return blanket.test(readFileSync(full, "utf8"));
      } catch {
        return false;
      }
    });

    expect(offenders, `blanket eslint-disable found in:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});

describe("checkLintFileFloor", () => {
  const report = (n: number) => Array.from({ length: n }, () => ({ messages: [] }));

  it("passes when the count equals the floor", () => {
    expect(checkLintFileFloor(report(390), 390)).toMatchObject({ pass: true, checked: 390 });
  });

  it("passes when the count exceeds the floor", () => {
    expect(checkLintFileFloor(report(396), 390).pass).toBe(true);
  });

  it("fails when the count is one below the floor", () => {
    expect(checkLintFileFloor(report(389), 390).pass).toBe(false);
  });

  it("fails on an empty report — the ignores-typo case this exists for", () => {
    expect(checkLintFileFloor([], 390)).toMatchObject({ pass: false, checked: 0, floor: 390 });
  });
});

describe("lint fixtures are tracked evidence", () => {
  it("ships exactly the two fixture files", () => {
    expect(readdirSync(FIXTURES).sort()).toEqual([
      "floating-promise.ts",
      "focused-test.test.ts",
    ]);
  });
});
