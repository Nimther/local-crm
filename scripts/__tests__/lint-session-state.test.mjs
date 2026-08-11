// GSD 10-05 (SEC-16): tests for the session-state audit.
//
// Mirrors the mix used by packages/test-support/src/__tests__/redis-config.test.ts
// and lint-migrations.mjs's own design: the pure exported helpers are asserted
// on directly with in-memory strings (fast, precise edge cases), and the CLI
// entry point is exercised as a real subprocess for the behaviors that are
// actually about exit codes (Test 1, 2, 6) -- what CI runs is the subprocess,
// not the imported function.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { lintFile, lintSourceTree, stripComments } from "../lint-session-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/lint-session-state.mjs");
const FIXTURES_DIR = path.join(REPO_ROOT, "scripts/__fixtures__/session-state");

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

describe("Test 1 — the violating fixture fails with exactly three violations", () => {
  it("exits non-zero and reports three violations via the CLI", () => {
    const run = runCli([path.join(FIXTURES_DIR, "violating.ts")]);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/3 violation\(s\)/);
  });

  it("lintFile finds exactly three violations, one of each rule", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(FIXTURES_DIR, "violating.ts"), "utf8");
    const violations = lintFile("violating.ts", source);
    expect(violations).toHaveLength(3);
    expect(violations.map((v) => v.rule).sort()).toEqual(
      ["connection-scoped-assignment", "role-switch", "set-config-not-local"].sort(),
    );
  });
});

describe("Test 2 — the compliant fixture passes", () => {
  it("exits zero via the CLI", () => {
    const run = runCli([path.join(FIXTURES_DIR, "compliant.ts")]);
    expect(run.exitCode).toBe(0);
    expect(run.output).toMatch(/no violations/);
  });

  it("lintFile finds zero violations", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(FIXTURES_DIR, "compliant.ts"), "utf8");
    expect(lintFile("compliant.ts", source)).toHaveLength(0);
  });
});

describe("Test 3 — comment-stripping: prose describing the forbidden forms is not self-invalidating", () => {
  it("stripComments blanks a // line comment mentioning SET ROLE", () => {
    const masked = stripComments("// SET ROLE is forbidden\nconst x = 1;");
    expect(masked).not.toMatch(/SET\s+ROLE/);
    expect(masked.split("\n")).toHaveLength(2); // line count preserved
  });

  it("stripComments blanks a /* */ block comment mentioning SET LOCAL", () => {
    const masked = stripComments("/* SET LOCAL app.x = '1' is fine */\nconst x = 1;");
    expect(masked).not.toMatch(/SET\s+LOCAL/);
  });

  it("does not blank a // inside a string (e.g. a URL)", () => {
    const masked = stripComments(`const url = "https://api.sendgrid.com/v3";`);
    expect(masked).toContain("https://api.sendgrid.com/v3");
  });

  it("the compliant fixture's descriptive comment produces zero violations", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(path.join(FIXTURES_DIR, "compliant.ts"), "utf8");
    expect(source).toMatch(/SET app\.foo/); // the prose really is there
    expect(lintFile("compliant.ts", source)).toHaveLength(0); // but not flagged
  });
});

describe("Test 4 — set_config with a non-true third argument, and the two-argument form", () => {
  it("reports a literal `false` third argument", () => {
    const source = `client.query("SELECT set_config('app.x', $1, false)");`;
    const violations = lintFile("f.ts", source);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("set-config-not-local");
  });

  it("reports the two-argument form (no is_local at all)", () => {
    const source = `client.query("SELECT set_config('app.x', $1)");`;
    const violations = lintFile("f.ts", source);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("set-config-not-local");
  });

  it("accepts a literal `true` third argument", () => {
    const source = `client.query("SELECT set_config('app.x', $1, true)");`;
    expect(lintFile("f.ts", source)).toHaveLength(0);
  });
});

describe("Test 5 — the exception marker requires a reason", () => {
  it("a marker WITH a reason suppresses the violation on the following line", () => {
    const source = [
      "function f(client) {",
      "  // session-state-exception: one-shot maintenance connection, never pooled",
      "  client.query(\"SET statement_timeout = '0'\");",
      "}",
    ].join("\n");
    expect(lintFile("f.ts", source)).toHaveLength(0);
  });

  it("the same marker WITHOUT a reason does not suppress", () => {
    const source = [
      "function f(client) {",
      "  // session-state-exception:",
      "  client.query(\"SET statement_timeout = '0'\");",
      "}",
    ].join("\n");
    const violations = lintFile("f.ts", source);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe("connection-scoped-assignment");
  });

  it("a marker with no colon at all does not suppress", () => {
    const source = [
      "function f(client) {",
      "  // session-state-exception one-shot connection",
      "  client.query(\"SET statement_timeout = '0'\");",
      "}",
    ].join("\n");
    expect(lintFile("f.ts", source)).toHaveLength(1);
  });
});

describe("Test 6 — the real repository source tree is clean", () => {
  it("lintSourceTree reports zero violations", () => {
    const { violations, checkedCount } = lintSourceTree(REPO_ROOT);
    if (violations.length > 0) {
      const report = violations.map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.snippet}`).join("\n");
      throw new Error(`session-state audit found violations in the real tree:\n${report}`);
    }
    expect(checkedCount).toBeGreaterThan(0);
  });

  it("exits zero via the CLI with no argument", () => {
    const run = runCli([]);
    expect(run.exitCode).toBe(0);
    expect(run.output).toMatch(/no violations/);
  });
});

describe("UPDATE ... SET is not a session-state statement", () => {
  it("does not flag a normal UPDATE ... SET clause", () => {
    const source = `client.query(\`UPDATE sends\n     SET status = $2::send_status\n     WHERE id = $1\`, [id, status]);`;
    expect(lintFile("f.ts", source)).toHaveLength(0);
  });
});

describe("role switch is reported unconditionally, even with LOCAL", () => {
  it.each(["SET ROLE mega_crm_admin", "SET LOCAL ROLE mega_crm_admin", "RESET ROLE", "SET SESSION AUTHORIZATION x"])(
    "%s",
    (stmt) => {
      const source = `client.query(${JSON.stringify(stmt)});`;
      const violations = lintFile("f.ts", source);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("role-switch");
    },
  );
});
