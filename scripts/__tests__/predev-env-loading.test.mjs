// GSD 10-15 (SEC-01/SEC-02, gap G-10-1, Task 2): guards the predev chain so
// this failure class -- a DSN-resolving script that never loads the
// external env file -- cannot return through a fourth chain member.
//
// The rule is defined here (not imported from a script) because it is a
// property of source text, not runtime behavior: no database, no
// subprocess, so this stays in the `scripts` lane with no globalSetup.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

/**
 * Pure rule: does `source` need the sibling env-path import, and does it
 * have it?
 *
 * In scope: the source mentions an environment variable name ending in
 * DATABASE_URL (matched as a substring with a right-hand word boundary, so
 * it catches both the bare `DATABASE_URL` and prefixed forms like
 * `TEST_ADMIN_DATABASE_URL` -- a left-hand boundary would miss the prefixed
 * forms, since the character immediately before "DATABASE_URL" in
 * `TEST_ADMIN_DATABASE_URL` is `_`, itself a word character, so there is no
 * boundary there).
 *
 * Compliant (only meaningful when in scope): the source imports from the
 * sibling `env-path.mjs` module, matched on the module specifier rather
 * than the imported binding name, so a future script that imports it under
 * a different name or as a namespace import still counts.
 *
 * Comments are NOT stripped -- a script whose only mention of a DSN
 * variable is prose still has to route through the single decision point
 * if it ever reads one for real, so treating prose as in-scope only makes
 * the rule stricter, never falsely green.
 */
function checkEnvPathCompliance(source) {
  const inScope = /DATABASE_URL\b/.test(source);
  if (!inScope) {
    return { inScope: false, compliant: true };
  }
  const compliant = /from\s+["'][^"']*\/env-path\.mjs["']/.test(source);
  return { inScope: true, compliant };
}

/**
 * Every `scripts/<name>.mjs` path referenced in package.json's `predev`
 * value -- the enumeration source, parsed rather than hand-restated, so a
 * future fourth predev step is covered the day it is added, with no edit
 * to this test.
 */
function predevScriptPaths() {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const predev = pkg.scripts?.predev ?? "";
  const matches = predev.match(/scripts\/[\w.-]+\.mjs/g) ?? [];
  return [...new Set(matches)];
}

describe("Anti-vacuity — the rule actually detects a violation", () => {
  it("flags a synthetic source reading a DSN out of process.env with no env-path import", () => {
    const source = `const dsn = process.env.SOME_ADMIN_DATABASE_URL || DEFAULT_DSN;`;
    const result = checkEnvPathCompliance(source);
    expect(result.inScope).toBe(true);
    expect(result.compliant).toBe(false);
  });

  it("reports the same synthetic source clean once the sibling env-path import is added", () => {
    const source = [
      `import { resolveEnvPath } from "./env-path.mjs";`,
      `const dsn = process.env.SOME_ADMIN_DATABASE_URL || DEFAULT_DSN;`,
    ].join("\n");
    const result = checkEnvPathCompliance(source);
    expect(result.inScope).toBe(true);
    expect(result.compliant).toBe(true);
  });

  it("a namespace import of the sibling module still counts as compliant", () => {
    const source = [
      `import * as EnvPath from "./env-path.mjs";`,
      `const dsn = process.env.SOME_ADMIN_DATABASE_URL || DEFAULT_DSN;`,
    ].join("\n");
    expect(checkEnvPathCompliance(source).compliant).toBe(true);
  });

  it("a script that never mentions a DATABASE_URL-suffixed variable is out of scope, not a violation", () => {
    const source = `console.log("hello, world");`;
    const result = checkEnvPathCompliance(source);
    expect(result.inScope).toBe(false);
    expect(result.compliant).toBe(true);
  });
});

describe("The real predev chain", () => {
  const paths = predevScriptPaths();

  it("the enumeration is non-empty and has more than one entry", () => {
    // A parsing regression that silently matches nothing must not show up
    // as a pass -- assert shape, not just presence.
    expect(paths.length).toBeGreaterThan(1);
  });

  it("every predev-chain script mentioning a DATABASE_URL-suffixed variable imports the sibling env-path module", () => {
    const violations = [];
    for (const relPath of paths) {
      const source = readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      const result = checkEnvPathCompliance(source);
      if (result.inScope && !result.compliant) {
        violations.push({
          file: relPath,
          reason: "mentions a DATABASE_URL-suffixed variable but does not import ./env-path.mjs",
        });
      }
    }

    if (violations.length > 0) {
      const report = violations.map((v) => `${v.file}: ${v.reason}`).join("\n");
      throw new Error(`predev-chain env-loading guard found violation(s):\n${report}`);
    }

    expect(violations).toHaveLength(0);
  });
});
