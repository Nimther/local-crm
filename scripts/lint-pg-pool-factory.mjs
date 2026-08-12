#!/usr/bin/env node
// Phase 14 plan 03 (DB-14, D-11) -- the machine half of "every first-party
// production Postgres pool goes through createPgPool()". The written half
// -- the binding rule -- is packages/db/src/pool.ts's own header comment and
// this plan's SUMMARY.
//
// Without this gate, DB-14's "every pool has an error handler" property
// decays the moment a future edit adds a tenth `new Pool(...)` by hand,
// outside the factory, with no listener -- exactly what this plan found
// twice already (relocate-default-partition-rows.ts,
// replay-webhook-journal.ts) before this gate existed. A pool with no
// `'error'` listener crashes its whole process on the very next idle
// connection drop (T-14-13).
//
// Mirrors scripts/lint-session-state.mjs's own class of guard script
// exactly: no dependencies beyond Node built-ins, a directory walk over
// first-party source, comments stripped before matching (so a mention in a
// doc comment can never trip or hide a finding), exported pure helpers for
// direct unit testing, a clear file:line failure report, and a documented
// single-line suppression marker for a justified exception.
//
// No dependencies -- Node built-ins only.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Directories skipped anywhere in the walk. `test`/`__fixtures__` cover this
 * codebase's established test-fixture-directory convention
 * (apps/api/src/test, apps/worker/src/test, packages/delivery-core/src/test
 * -- each holds shared `db-fixture.ts`/fixture helpers consumed only by test
 * files, the same rationale `__tests__` and `packages/test-support` already
 * get: forcing a throwaway single-connection test pool through a factory
 * whose sizes are tuned for production makes the test suite's connection
 * behavior harder to reason about, not easier. */
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "__tests__", "__fixtures__", "test"]);

/** Whole packages excluded from the package-src-dir scan entirely. */
const SKIP_PACKAGE_NAMES = new Set(["test-support"]);

const SCANNED_EXTENSIONS = new Set([".ts", ".mts", ".mjs"]);

/** The one file allowed to construct a real `new Pool(...)` -- the factory itself. */
const FACTORY_FILE = path.join("packages", "db", "src", "pool.ts");

/**
 * Marker convention: a single-line `//` comment carrying the phrase
 * `pg-pool-factory-exception`, a colon, then at least one non-whitespace
 * character of reason. Mirrors lint-session-state.mjs's own
 * `session-state-exception` marker exactly -- suppresses ONLY the
 * violation on the immediately following non-blank line. A marker with no
 * reason after the colon does not suppress.
 */
const EXCEPTION_MARKER = /^\/\/\s*pg-pool-factory-exception:\s*\S/;

/** A bare Postgres pool construction -- the one pattern this gate forbids outside the factory. */
const BARE_POOL_PATTERN = /\bnew\s+Pool\s*\(/;

/**
 * Strip `//` line comments and `/* *\/` block comments, JS/TS-aware of
 * string/template-literal boundaries so a `//` inside a URL is never
 * mistaken for a comment start and a comment can never prematurely close an
 * open string. Output has the exact same length and line count as the
 * input, so an offset computed against the masked text always maps back to
 * the same physical line in the original file. Identical algorithm to
 * lint-session-state.mjs's own `stripComments` (duplicated, not imported --
 * each guard script stays self-contained and dependency-light, matching
 * `lint-migrations.mjs`'s own `stripSqlComments` precedent of not sharing
 * state between independent gate scripts).
 */
export function stripComments(source) {
  let result = "";
  let state = "normal"; // normal | single | double | backtick | line | block
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (state === "normal") {
      if (ch === "/" && next === "/") {
        state = "line";
        result += "  ";
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        result += "  ";
        i++;
        continue;
      }
      if (ch === "'") {
        state = "single";
        result += ch;
        continue;
      }
      if (ch === '"') {
        state = "double";
        result += ch;
        continue;
      }
      if (ch === "`") {
        state = "backtick";
        result += ch;
        continue;
      }
      result += ch;
      continue;
    }

    if (state === "single" || state === "double" || state === "backtick") {
      if (ch === "\\") {
        result += ch + (next ?? "");
        i++;
        continue;
      }
      const closes =
        (state === "single" && ch === "'") ||
        (state === "double" && ch === '"') ||
        (state === "backtick" && ch === "`");
      if (closes) {
        state = "normal";
      }
      result += ch;
      continue;
    }

    if (state === "line") {
      if (ch === "\n") {
        state = "normal";
        result += "\n";
        continue;
      }
      result += " ";
      continue;
    }

    // state === "block"
    if (ch === "*" && next === "/") {
      state = "normal";
      result += "  ";
      i++;
      continue;
    }
    result += ch === "\n" ? "\n" : " ";
  }
  return result;
}

function lineNumberAt(text, offset) {
  let line = 1;
  const bound = Math.min(offset, text.length);
  for (let i = 0; i < bound; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** True when the raw line immediately preceding `line` (1-based) carries a valid exception marker. */
function isSuppressed(rawLines, line) {
  let idx = line - 2; // 0-based index of the line before `line`
  while (idx >= 0 && rawLines[idx].trim() === "") idx--;
  if (idx < 0) return false;
  return EXCEPTION_MARKER.test(rawLines[idx].trim());
}

/** Every `new Pool(...)` construction found in already-comment-stripped source. */
export function findBarePoolConstructions(masked) {
  const violations = [];
  const pattern = new RegExp(BARE_POOL_PATTERN, "g");
  let m;
  while ((m = pattern.exec(masked))) {
    violations.push({ offset: m.index });
  }
  return violations;
}

/**
 * Lints a single file's already-read source, returning every violation not
 * suppressed by a documented, reason-bearing exception marker. `file` is a
 * repo-relative path -- the `FACTORY_FILE` allow-list check happens here so
 * `lintFile` alone (given the factory's own relative path) reproduces the
 * same decision the directory walk makes.
 */
export function lintFile(file, rawSource) {
  const normalizedFile = file.split(path.sep).join("/");
  if (normalizedFile === FACTORY_FILE.split(path.sep).join("/")) {
    return [];
  }

  const masked = stripComments(rawSource);
  const rawLines = rawSource.split("\n");

  const violations = [];
  for (const v of findBarePoolConstructions(masked)) {
    const line = lineNumberAt(masked, v.offset);
    if (isSuppressed(rawLines, line)) continue;
    violations.push({
      file,
      line,
      rule: "bare-pool-construction",
      detail:
        "constructs a Postgres pool directly with `new Pool(...)` instead of `createPgPool()` " +
        "(@mega-crm/db/src/pool.js) -- a pool built outside the factory has no error listener by " +
        "default, and an idle-connection drop crashes the whole process (DB-14)",
    });
  }
  violations.sort((a, b) => a.line - b.line);
  return violations;
}

/** `packages/*\/src` expanded to the packages that actually have a `src` directory, excluding `SKIP_PACKAGE_NAMES`. */
function resolvePackageSrcDirs(baseDir) {
  const packagesDir = path.join(baseDir, "packages");
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !SKIP_PACKAGE_NAMES.has(d.name))
    .map((d) => path.join(packagesDir, d.name, "src"))
    .filter((p) => existsSync(p));
}

/** `apps/*\/src` expanded to the apps that actually have a `src` directory. */
function resolveAppSrcDirs(baseDir) {
  const appsDir = path.join(baseDir, "apps");
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(appsDir, d.name, "src"))
    .filter((p) => existsSync(p));
}

/**
 * The default scan scope: every `apps/*\/src`, every `packages/*\/src`
 * (excluding `packages/test-support`), and `packages/db/scripts`.
 * `apps/web/e2e` is never included -- it is a SIBLING of `apps/web/src`, not
 * a descendant of it, so this glob shape excludes it structurally rather
 * than by a runtime path check that could rot silently.
 */
export function getDefaultScanDirectories(baseDir = process.cwd()) {
  const scriptsDir = path.join(baseDir, "packages", "db", "scripts");
  const fixed = existsSync(scriptsDir) ? [scriptsDir] : [];
  return [...resolveAppSrcDirs(baseDir), ...resolvePackageSrcDirs(baseDir), ...fixed];
}

function collectFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      collectFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Lints every file under `dirs` (already-resolved absolute directories). */
export function lintDirectories(dirs, baseDir = process.cwd()) {
  const violations = [];
  let checkedCount = 0;
  for (const dir of dirs) {
    for (const absFile of collectFiles(dir)) {
      const rel = path.relative(baseDir, absFile);
      violations.push(...lintFile(rel, readFileSync(absFile, "utf8")));
      checkedCount++;
    }
  }
  return { violations, checkedCount };
}

/** Lints the default repo-wide scan scope. */
export function lintSourceTree(baseDir = process.cwd()) {
  return lintDirectories(getDefaultScanDirectories(baseDir), baseDir);
}

// ---------------------------------------------------------------------------
// CLI — guarded so importing this module for tests does not execute it.
// ---------------------------------------------------------------------------

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

if (isDirectInvocation()) {
  const cwd = process.cwd();
  const argPath = process.argv[2];

  let violations;
  let checkedCount;

  if (argPath) {
    // Same optional path-argument shape as lint-session-state.mjs's own
    // CLI -- lets the test suite (and an operator debugging one file) point
    // the gate at a single fixture/file instead of the whole repo.
    const target = path.resolve(cwd, argPath);
    if (statSync(target).isDirectory()) {
      const result = lintDirectories([target], cwd);
      violations = result.violations;
      checkedCount = result.checkedCount;
    } else {
      violations = lintFile(path.relative(cwd, target), readFileSync(target, "utf8"));
      checkedCount = 1;
    }
  } else {
    const result = lintSourceTree(cwd);
    violations = result.violations;
    checkedCount = result.checkedCount;
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}: [${v.rule}] ${v.detail}`);
    }
    console.error(`\n${violations.length} violation(s) across ${checkedCount} file(s) checked.`);
    process.exit(1);
  }

  console.log(`lint:pg-pool-factory — ${checkedCount} file(s) checked, no violations.`);
}
