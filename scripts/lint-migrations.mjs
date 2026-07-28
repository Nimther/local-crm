#!/usr/bin/env node
// GSD 08-05 (DB-08): migration linter — the machine half of expand/contract.
//
// Closes two failure classes that are otherwise only discovered at deploy time,
// after the deploy has already started:
//
//   1. A single migration file that both adds an enum value and uses it.
//      Postgres refuses to let a freshly-added enum value be used inside the
//      transaction that added it, and this repo applies each migration file as
//      one client.query(sql) call — so the file is a guaranteed runtime failure.
//      This is the rule that protects Phase 11's 'reconciling' addition.
//   2. Destructive DDL with no visible, reason-bearing marker.
//
// The written half — the binding rule text — lives in CONVENTIONS.md (08-17).
//
// No dependencies -- Node built-ins only.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Marker convention (D-31): a single-line SQL comment, the word `destructive`,
 * a colon, then at least one non-whitespace character of reason. It suppresses
 * ONLY the statement on the immediately following non-blank line — a
 * file-header marker is the blanket suppression D-06/D-31 exist to forbid.
 */
const DESTRUCTIVE_MARKER = /^--\s*destructive:\s*\S/;

const DEFAULT_MIGRATIONS_DIR = "packages/db/migrations";

/**
 * Remove `--` line comments and block comments.
 *
 * Runs before either rule evaluates, so a rule keyword appearing inside prose
 * can neither trigger a false violation nor mask a real one.
 */
export function stripSqlComments(sql) {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Rule 1 — a file that adds an enum value and also references that literal.
 *
 * Handles multiple ADD VALUE statements per file, not just the first: each
 * added literal is checked against the file with ALL ADD VALUE statements
 * removed, so one statement cannot mask another.
 */
export function checkEnumAddValueSameFile(file, rawSql) {
  const sql = stripSqlComments(rawSql);
  const addValuePattern = /ALTER\s+TYPE\s+\S+\s+ADD\s+VALUE\s+'([^']+)'/gi;

  const statements = [...sql.matchAll(addValuePattern)];
  if (statements.length === 0) return [];

  // Strip every ADD VALUE statement before looking for usages, so the literal
  // inside its own declaration is never counted as a usage.
  let remainder = sql;
  for (const match of statements) {
    remainder = remainder.replace(match[0], "");
  }

  const violations = [];
  for (const match of statements) {
    const addedValue = match[1];
    if (new RegExp(`'${addedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`).test(remainder)) {
      violations.push({
        file,
        rule: "enum-add-value-used-same-file",
        line: null,
        detail: `'${addedValue}' is added with ALTER TYPE ... ADD VALUE and used in the same file; split the usage into a later migration`,
      });
    }
  }
  return violations;
}

/**
 * Rule 2 — destructive DDL without a marker on the immediately preceding line.
 *
 * Walks the ORIGINAL lines rather than the comment-stripped text, because the
 * marker itself is a comment and must stay visible.
 */
export function checkDestructiveDdl(file, rawSql) {
  const violations = [];
  const lines = rawSql.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const isDropColumn = /DROP\s+COLUMN/i.test(line);
    // Unsafe only when the same statement declares NOT NULL and supplies no
    // DEFAULT. `ADD COLUMN x integer DEFAULT 0 NOT NULL` is safe — which is the
    // shape every existing migration in this repo uses.
    const isUnsafeNotNull = /ADD\s+COLUMN/i.test(line) && /NOT\s+NULL/i.test(line) && !/DEFAULT/i.test(line);

    if (!isDropColumn && !isUnsafeNotNull) continue;

    // The immediately preceding NON-BLANK line — blank lines between the marker
    // and its statement are tolerated, arbitrary distance is not.
    let priorIndex = i - 1;
    while (priorIndex >= 0 && lines[priorIndex].trim() === "") priorIndex--;
    const priorLine = (lines[priorIndex] ?? "").trim();

    if (!DESTRUCTIVE_MARKER.test(priorLine)) {
      violations.push({
        file,
        rule: "destructive-ddl-unmarked",
        line: i + 1,
        detail: `line ${i + 1} is destructive DDL with no "-- destructive: <reason>" marker on the preceding line`,
      });
    }
  }
  return violations;
}

export function lintMigrationFile(file, rawSql) {
  return [...checkEnumAddValueSameFile(file, rawSql), ...checkDestructiveDdl(file, rawSql)];
}

export function lintMigrationDirectory(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const violations = [];
  for (const file of files) {
    violations.push(...lintMigrationFile(file, readFileSync(path.join(dir, file), "utf8")));
  }
  return violations;
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
  const target = path.resolve(process.cwd(), process.argv[2] || DEFAULT_MIGRATIONS_DIR);

  let violations;
  let checkedCount;
  if (statSync(target).isDirectory()) {
    violations = lintMigrationDirectory(target);
    checkedCount = readdirSync(target).filter((f) => f.endsWith(".sql")).length;
  } else {
    violations = lintMigrationFile(path.basename(target), readFileSync(target, "utf8"));
    checkedCount = 1;
  }

  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}${v.line ? `:${v.line}` : ""}  [${v.rule}]  ${v.detail}`);
    }
    console.error(`\n${violations.length} violation(s) across ${checkedCount} file(s) checked.`);
    process.exit(1);
  }

  // Print the count on success for the same reason the lint gate has a file
  // floor: "0 files checked, no violations" must be visibly distinguishable
  // from a genuine pass.
  console.log(`lint:migrations — ${checkedCount} file(s) checked, no violations.`);
}
