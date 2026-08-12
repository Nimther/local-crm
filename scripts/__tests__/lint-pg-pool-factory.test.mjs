// Phase 14 plan 03 (DB-14, D-11): tests for the pool-factory audit.
//
// Mirrors lint-session-state.test.mjs's own mix exactly: the pure exported
// helpers are asserted on directly with in-memory strings (fast, precise
// edge cases), and the CLI entry point is exercised as a real subprocess for
// the behaviors that are actually about exit codes -- what CI runs is the
// subprocess, not the imported function.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  findBarePoolConstructions,
  lintDirectories,
  lintFile,
  lintSourceTree,
  stripComments,
} from "../lint-pg-pool-factory.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/lint-pg-pool-factory.mjs");
const FIXTURES_DIR = path.join(REPO_ROOT, "scripts/__fixtures__/pg-pool-factory");

/** The shape execFileSync throws on a non-zero exit. */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return { exitCode: 0, output: stdout };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

describe("Test 1 -- the violating fixture fails with exactly one violation", () => {
  it("lintFile finds exactly one bare-pool-construction violation", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(FIXTURES_DIR, "violating.ts"), "utf8");
    const violations = lintFile("violating.ts", source);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("bare-pool-construction");
  });
});

describe("Test 2 -- the compliant fixture passes", () => {
  it("lintFile finds zero violations", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(FIXTURES_DIR, "compliant.ts"), "utf8");
    expect(lintFile("compliant.ts", source)).toHaveLength(0);
  });
});

describe("Test 3 -- comment-stripping: prose mentioning `new Pool(` is not self-invalidating", () => {
  it("stripComments blanks a // line comment mentioning new Pool(", () => {
    const masked = stripComments("// new Pool( is forbidden here\nconst x = 1;");
    expect(masked).not.toMatch(/new\s+Pool\s*\(/);
    expect(masked.split("\n")).toHaveLength(2); // line count preserved
  });

  it("stripComments blanks a /* */ block comment mentioning new Pool(", () => {
    const masked = stripComments("/* new Pool({...}) is forbidden */\nconst x = 1;");
    expect(masked).not.toMatch(/new\s+Pool\s*\(/);
  });

  it("does not blank a // inside a string (e.g. a URL)", () => {
    const masked = stripComments(`const url = "https://api.sendgrid.com/v3";`);
    expect(masked).toContain("https://api.sendgrid.com/v3");
  });
});

describe("Test 4 -- findBarePoolConstructions", () => {
  it("finds a bare `new Pool(` call", () => {
    const masked = stripComments(`const pool = new Pool({ connectionString: dsn });`);
    expect(findBarePoolConstructions(masked)).toHaveLength(1);
  });

  it("does not flag createPgPool(...)", () => {
    const masked = stripComments(`const pool = createPgPool({ connectionString: dsn, name: "x" });`);
    expect(findBarePoolConstructions(masked)).toHaveLength(0);
  });

  it("does not flag an unrelated `new` expression", () => {
    const masked = stripComments(`const err = new Error("Pool exhausted");`);
    expect(findBarePoolConstructions(masked)).toHaveLength(0);
  });
});

describe("Test 5 -- the exception marker requires a reason", () => {
  it("a marker WITH a reason suppresses the violation on the following line", () => {
    const source = [
      "// pg-pool-factory-exception: this is the factory's own construction site",
      "const pool = new Pool({ connectionString: dsn });",
    ].join("\n");
    expect(lintFile("f.ts", source)).toHaveLength(0);
  });

  it("the same marker WITHOUT a reason does not suppress", () => {
    const source = ["// pg-pool-factory-exception:", "const pool = new Pool({ connectionString: dsn });"].join(
      "\n",
    );
    expect(lintFile("f.ts", source)).toHaveLength(1);
  });

  it("a marker with no colon at all does not suppress", () => {
    const source = ["// pg-pool-factory-exception one-shot", "const pool = new Pool({ connectionString: dsn });"].join(
      "\n",
    );
    expect(lintFile("f.ts", source)).toHaveLength(1);
  });
});

describe("Test 6 -- the factory file itself is allow-listed", () => {
  it("lintFile never flags packages/db/src/pool.ts regardless of content", () => {
    const source = `const pool = new Pool({ connectionString: dsn });`;
    expect(lintFile(path.join("packages", "db", "src", "pool.ts"), source)).toHaveLength(0);
  });
});

describe("Test 7 -- the real repository source tree is clean and the scan actually examined files", () => {
  it("lintSourceTree reports zero violations and a non-zero scanned-file count", () => {
    const { violations, checkedCount } = lintSourceTree(REPO_ROOT);
    if (violations.length > 0) {
      const report = violations.map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.detail}`).join("\n");
      throw new Error(`pg-pool-factory audit found violations in the real tree:\n${report}`);
    }
    // A walk with a broken exclusion glob examines nothing and exits 0 --
    // a green gate that proved nothing (mirrors lint-session-state.test.mjs's
    // own Test 6 reasoning).
    expect(checkedCount).toBeGreaterThan(0);
  });

  it("exits zero via the CLI and reports a non-zero scanned-file count", () => {
    const run = runCli([]);
    expect(run.exitCode).toBe(0);
    expect(run.output).toMatch(/no violations/);
    const match = run.output.match(/(\d+) file\(s\) checked/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeGreaterThan(0);
  });
});

describe("Test 8 -- the CLI fails non-zero against the negative fixture", () => {
  it("exits non-zero via the CLI when pointed at the violating fixture", () => {
    const run = runCli([path.join(FIXTURES_DIR, "violating.ts")]);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/1 violation\(s\)/);
  });

  it("exits zero via the CLI when pointed at the compliant fixture", () => {
    const run = runCli([path.join(FIXTURES_DIR, "compliant.ts")]);
    expect(run.exitCode).toBe(0);
  });

  it("lintDirectories finds the violation when scanning the fixtures directory", () => {
    const { violations } = lintDirectories([FIXTURES_DIR], REPO_ROOT);
    expect(violations.length).toBeGreaterThan(0);
  });
});
