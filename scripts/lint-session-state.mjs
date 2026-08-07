#!/usr/bin/env node
// GSD 10-05 (SEC-16): the session-state audit -- the machine half of
// "transaction-local session state only" (CONVENTIONS.md).
//
// A connection-scoped (non-transaction-local) session-state statement --
// `SET app.current_workspace_id = ...` without `LOCAL`, a role switch, or
// `set_config(..., false)` / `set_config(..., <no third arg>)` -- persists on
// the pooled `pg` connection past COMMIT/ROLLBACK and leaks into the next
// request or job that checks that connection back out of the pool. That has
// been a discipline-only convention since Phase 1; this makes a reintroduced
// violation a blocking CI failure instead of something only caught by review.
//
// The written half -- the binding rule text -- lives in CONVENTIONS.md (10-05
// Task 2).
//
// No dependencies -- Node built-ins only.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_APP_SRC_DIRS = [
  ["apps", "api", "src"],
  ["apps", "worker", "src"],
  ["packages", "db", "scripts"],
];

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", "__fixtures__"]);
const SCANNED_EXTENSIONS = new Set([".ts", ".mts", ".mjs"]);

/**
 * Marker convention: a single-line `//` comment carrying the phrase
 * `session-state-exception`, a colon, then at least one non-whitespace
 * character of reason. Mirrors `lint-migrations.mjs`'s `DESTRUCTIVE_MARKER`:
 * it suppresses ONLY the statement on the immediately following non-blank
 * line -- a file-header marker is the blanket suppression that convention
 * forbids. A marker with no reason after the colon does not suppress.
 */
const EXCEPTION_MARKER = /^\/\/\s*session-state-exception:\s*\S/;

// The three patterns below are deliberately CASE-SENSITIVE (uppercase),
// unlike `set_config(` below. Every real SQL statement in this codebase is
// written in uppercase SQL-keyword style ("SET LOCAL", "UPDATE ... SET ...");
// a case-insensitive match would false-positive on ordinary lowercase English
// starting with the word "set" -- e.g. Drizzle's `{ onDelete: "set null" }`
// API string, or a test assertion message like `` `set externalId failed: ${..}` ``.
// Both are real occurrences in this repository's first-party source, found
// while proving Test 6 (repo-wide clean run) actually passes.

/** The only accepted "assignment" form: `SET LOCAL <name> = <value>`. */
const SET_LOCAL_PATTERN = /^SET\s+LOCAL\b/;

/**
 * Role switching has NO accepted form in this codebase at all -- cross-tenant
 * access is a separate connection under a separate login role, never a
 * switch on an existing one (T-10-05-02). Reported unconditionally, even
 * with a `LOCAL`/`SESSION` scope qualifier (`SET LOCAL ROLE ...` and
 * `SET SESSION AUTHORIZATION ...` are both valid Postgres grammar), because
 * there is no qualifier that makes a role switch on a pooled connection
 * safe. This MUST be checked before `SET_LOCAL_PATTERN` below, or
 * `SET LOCAL ROLE ...` would be misread as the accepted transaction-local
 * assignment form.
 */
const ROLE_SWITCH_PATTERN =
  /^(SET\s+(?:LOCAL\s+|SESSION\s+)?(?:ROLE\b|SESSION\s+AUTHORIZATION\b)|RESET\s+(?:ROLE\b|SESSION\s+AUTHORIZATION\b))/;

/** Any other statement beginning with `SET` is a connection-scoped assignment. */
const SET_STATEMENT_PATTERN = /^SET\s+/;

/**
 * Strip `//` line comments and `/* *\/` block comments, JS/TS-aware of string
 * and template-literal boundaries so a `//` inside a URL (e.g.
 * `"https://api.sendgrid.com/..."`) is never mistaken for a comment start,
 * and so a comment can never prematurely close an open string. Output has
 * the exact same length and line count as the input (comment bytes become
 * spaces, newlines are preserved), so an offset computed against the masked
 * text always maps back to the same physical line in the original file.
 *
 * Runs before either detection pass, mirroring `lint-migrations.mjs`'s
 * `stripSqlComments`: prose describing the forbidden construct in a code
 * comment must neither trigger nor mask a finding (T-10-05 Test 3).
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

/**
 * Extracts every quoted string / template literal in `text`, with the
 * character offset of its opening quote. Does not attempt to parse `${...}`
 * interpolation inside template literals -- the SQL this codebase passes to
 * `client.query()` never nests a differently-quoted string inside one, and a
 * full JS parser is out of scope for a Node-builtins-only gate script.
 */
export function extractStringLiterals(text) {
  const literals = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const offset = i;
      i++;
      let content = "";
      while (i < n) {
        const c = text[i];
        if (c === "\\") {
          content += c + (text[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        content += c;
        i++;
      }
      literals.push({ content, offset });
      continue;
    }
    i++;
  }
  return literals;
}

/** Splits a `set_config(...)` argument list on top-level commas only. */
function splitArgs(argsStr) {
  const args = [];
  let depth = 0;
  let inQuote = null;
  let current = "";
  for (let i = 0; i < argsStr.length; i++) {
    const c = argsStr[i];
    if (inQuote) {
      current += c;
      if (c === "\\") {
        current += argsStr[++i] ?? "";
        continue;
      }
      if (c === inQuote) inQuote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      inQuote = c;
      current += c;
      continue;
    }
    if (c === "(") {
      depth++;
      current += c;
      continue;
    }
    if (c === ")") {
      depth--;
      current += c;
      continue;
    }
    if (c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim() !== "" || args.length > 0) args.push(current.trim());
  return args;
}

/** Finds every `set_config(...)` call inside a single string literal's content. */
export function findSetConfigCalls(content) {
  const calls = [];
  const opener = /set_config\s*\(/gi;
  let m;
  while ((m = opener.exec(content))) {
    const openParenIndex = m.index + m[0].length - 1;
    let depth = 0;
    let j = openParenIndex;
    for (; j < content.length; j++) {
      if (content[j] === "(") depth++;
      else if (content[j] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue; // unterminated -- not a real call, ignore
    const argsStr = content.slice(openParenIndex + 1, j);
    calls.push({ index: m.index, args: splitArgs(argsStr) });
  }
  return calls;
}

function firstLine(s) {
  const line = s.split("\n")[0].trim();
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

function lineNumberAt(text, offset) {
  let line = 1;
  const bound = Math.min(offset, text.length);
  for (let i = 0; i < bound; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/**
 * Rule 1/2 -- a SQL string literal whose FIRST statement keyword is a
 * session-state assignment. "First keyword" is load-bearing: it is what lets
 * `UPDATE sends SET status = $2 ...` (a normal DML statement, all over this
 * codebase) pass cleanly while `SET app.current_workspace_id = ...` (a
 * standalone session-state statement) is caught -- both contain the
 * substring "SET", but only one of them BEGINS with it.
 */
function findAssignmentViolations(masked) {
  const violations = [];
  for (const lit of extractStringLiterals(masked)) {
    const leading = lit.content.match(/^\s*/)[0].length;
    const trimmed = lit.content.slice(leading);
    if (trimmed === "") continue;
    const offset = lit.offset + 1 + leading;

    if (ROLE_SWITCH_PATTERN.test(trimmed)) {
      violations.push({
        offset,
        rule: "role-switch",
        snippet: firstLine(trimmed),
        detail:
          "role switching has no accepted form in this codebase -- cross-tenant access is a separate connection under a separate login role, never SET ROLE / RESET ROLE / SET SESSION AUTHORIZATION on an existing one",
      });
      continue;
    }
    if (SET_LOCAL_PATTERN.test(trimmed)) {
      continue; // accepted form
    }
    if (SET_STATEMENT_PATTERN.test(trimmed)) {
      violations.push({
        offset,
        rule: "connection-scoped-assignment",
        snippet: firstLine(trimmed),
        detail:
          "session state must be transaction-local -- use SET LOCAL or set_config(name, value, true); a plain SET persists on the pooled connection past COMMIT/ROLLBACK",
      });
    }
  }
  return violations;
}

/**
 * Rule 3 -- any `set_config(...)` call whose third argument is not the
 * literal `true`, including the two-argument form (which has no `is_local`
 * parameter and therefore behaves like a plain `SET`).
 */
function findSetConfigViolations(masked) {
  const violations = [];
  for (const lit of extractStringLiterals(masked)) {
    for (const call of findSetConfigCalls(lit.content)) {
      const offset = lit.offset + 1 + call.index;
      const snippet = `set_config(${call.args.join(", ")})`;
      if (call.args.length < 3) {
        violations.push({
          offset,
          rule: "set-config-not-local",
          snippet,
          detail:
            "set_config has no third (is_local) argument -- add a literal `true`, or the setting persists on the pooled connection past COMMIT/ROLLBACK",
        });
        continue;
      }
      if (call.args[2] !== "true") {
        violations.push({
          offset,
          rule: "set-config-not-local",
          snippet,
          detail:
            "set_config's third argument must be the literal `true` (transaction-local) -- found something else",
        });
      }
    }
  }
  return violations;
}

/** True when the raw line immediately preceding `line` (1-based) carries a valid exception marker. */
function isSuppressed(rawLines, line) {
  let idx = line - 2; // 0-based index of the line before `line`
  while (idx >= 0 && rawLines[idx].trim() === "") idx--;
  if (idx < 0) return false;
  return EXCEPTION_MARKER.test(rawLines[idx].trim());
}

/**
 * Lints a single file's already-read source, returning every violation not
 * suppressed by a documented, reason-bearing exception marker.
 */
export function lintFile(file, rawSource) {
  const masked = stripComments(rawSource);
  const rawLines = rawSource.split("\n");

  const found = [...findAssignmentViolations(masked), ...findSetConfigViolations(masked)];

  const violations = [];
  for (const v of found) {
    const line = lineNumberAt(masked, v.offset);
    if (isSuppressed(rawLines, line)) continue;
    violations.push({ file, line, rule: v.rule, snippet: v.snippet, detail: v.detail });
  }
  violations.sort((a, b) => a.line - b.line);
  return violations;
}

/** `packages/*\/src` expanded to the packages that actually have a `src` directory. */
function resolvePackageSrcDirs(baseDir) {
  const packagesDir = path.join(baseDir, "packages");
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(packagesDir, d.name, "src"))
    .filter((p) => existsSync(p));
}

/**
 * The default scan scope: `apps/api/src`, `apps/worker/src`, `packages/db/scripts`,
 * and every `packages/*\/src` that exists. Enumerated from the filesystem, not
 * hand-listed -- Pitfall 8's sixth touchpoint was missed precisely because a
 * hand-listed file set looked complete (T-10-05-05).
 */
export function getDefaultScanDirectories(baseDir = process.cwd()) {
  const fixed = DEFAULT_APP_SRC_DIRS.map((parts) => path.join(baseDir, ...parts)).filter((p) =>
    existsSync(p),
  );
  return [...fixed, ...resolvePackageSrcDirs(baseDir)];
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
      console.error(`${v.file}:${v.line}: [${v.rule}] ${v.snippet}`);
      console.error(`  ${v.detail}`);
    }
    console.error(`\n${violations.length} violation(s) across ${checkedCount} file(s) checked.`);
    process.exit(1);
  }

  console.log(`lint:session-state — ${checkedCount} file(s) checked, no violations.`);
}
