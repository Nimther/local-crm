#!/usr/bin/env node
// GSD 08-15 (QG-07): the working-root blacklist.
//
// A file holding real platform secrets sitting in the repository working root
// is readable by every tool, script, editor extension and agent operating on
// this checkout. 08-15 moved the configuration out; this is what fails the
// build when it — or a Redis dump, or OS litter — comes back.
//
// This check is about what SITS IN the working root, and is deliberately
// independent of what git tracks. Being gitignored does not make a file safe:
// an ignored file is still on disk and still readable by anything running here.
// `.gitignore` and this list answer different questions.
//
// The scan is NON-RECURSIVE, on purpose (D-29). A recursive walk would
// immediately flag legitimate fixture trees — tools/lint-fixtures,
// tools/migration-fixtures, and any future one — and the exclusion list needed
// to keep it quiet would grow until the check stopped meaning anything. The
// working root is the specific place a secrets file must not sit.
//
// Content-based secret scanning is a different class of check and is deferred
// to Phase 13. This one is name-based.
//
// No dependencies -- Node built-ins only.

import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * The one permitted exception: a committed template carrying no real values.
 */
const ALLOWED = new Set([".env.example"]);

/**
 * Name patterns that must never appear in the working root.
 * Each carries the reason it is here, because a blacklist without reasons
 * becomes a list nobody dares change.
 */
const BLACKLIST = [
  { pattern: /^\.env($|\.)/, reason: "configuration file — holds real platform secrets" },
  { pattern: /\.rdb$/, reason: "Redis snapshot — may contain queue payloads" },
  { pattern: /\.aof$/, reason: "Redis append-only file — may contain queue payloads" },
  { pattern: /^\.DS_Store$/, reason: "macOS directory metadata" },
];

/**
 * @param entries directory-entry names from the working root
 * @returns {string[]} the offending subset, in the order given
 */
export function checkRootHygiene(entries) {
  return entries.filter(
    (name) => !ALLOWED.has(name) && BLACKLIST.some(({ pattern }) => pattern.test(name)),
  );
}

/** The reason a given name is blacklisted, for the CLI's output. */
export function hygieneReason(name) {
  return BLACKLIST.find(({ pattern }) => pattern.test(name))?.reason ?? "blacklisted";
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

if (isDirectInvocation()) {
  const root = path.resolve(process.cwd(), process.argv[2] ?? ".");

  let entries;
  try {
    // Non-recursive by construction — readdirSync without `recursive: true`.
    entries = readdirSync(root);
  } catch (err) {
    console.error(`check:root-hygiene FAILED: could not list ${root}.\n  ${err.message}`);
    process.exit(1);
  }

  const offenders = checkRootHygiene(entries);

  if (offenders.length > 0) {
    console.error(
      [
        `check:root-hygiene FAILED: ${offenders.length} blacklisted entr${offenders.length === 1 ? "y" : "ies"} in ${root}:`,
        ...offenders.map((name) => `  - ${name}  (${hygieneReason(name)})`),
        "",
        "The configuration file belongs outside the repository — scripts/env-path.mjs",
        "decides where, and MEGA_CRM_ENV_FILE overrides it. Redis dumps belong in the",
        "named docker volume, not here.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(`check:root-hygiene — ${entries.length} entr${entries.length === 1 ? "y" : "ies"} in ${root}, none blacklisted. OK`);
}
