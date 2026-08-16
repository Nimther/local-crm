#!/usr/bin/env node
// Phase 15 plan 18 (OPS-15, T-15-66). The mechanism that keeps a runbook in
// step with the alerts it documents: enumerates every `*_ALERT_NAME` constant
// `apps/api/src/modules/ops/*.ts` declares (the four OPS-13 alerts) and
// asserts a matching runbook file exists on disk for each.
//
// Deliberately narrow in scope: this checks source-declared alert-name
// identifiers only. `docs/runbooks/log-shipping-and-backstop-alerts.md`
// (OPS-10's two Grafana Cloud rules) and `docs/runbooks/bull-board-access.md`
// (OPS-14's access path) are NOT enumerated here and are not this gate's
// concern -- neither one has a source-declared alert-name constant to
// enumerate from (the two cloud rules are provisioned by hand in Grafana
// Cloud, never registered in this codebase under an alert name; the board is
// an access path, not an alert). A future reader should not "fix" this gate
// to also require those two -- they are real, required runbooks, just not
// ones this specific enumeration mechanism can discover automatically.
//
// Same anti-vacuous-pass discipline as scripts/check-spec-env-coverage.mjs:
// reports a checked-alert count, and unlike that script, this one treats an
// EMPTY enumeration as a hard failure (not merely a printed "0 checked, all
// present") -- a change to apps/api/src/modules/ops/ that accidentally stops
// matching the naming convention below would otherwise make this gate pass
// vacuously while checking nothing at all.
//
// No dependencies -- Node built-ins only, same shape as
// scripts/check-spec-env-coverage.mjs and scripts/validate-prod-compose.mjs:
// exported pure helpers, a CLI behind an import.meta.url guard.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_OPS_DIR = "apps/api/src/modules/ops";
const DEFAULT_RUNBOOKS_DIR = "docs/runbooks";

/**
 * Matches an exported `*_ALERT_NAME` string-literal constant, e.g.
 * `export const QUEUE_DEPTH_ALERT_NAME = "queue-depth";`. Captures the
 * literal value only (never the constant's own identifier name) -- the
 * literal is what `claimOpsAlertSlot` keys on and is therefore the value a
 * runbook file name must be derived from.
 */
const ALERT_NAME_PATTERN = /export const \w+_ALERT_NAME\s*=\s*["']([^"']+)["']/g;

/**
 * Extracts every alert-name literal from one file's source text. Pure --
 * no I/O. Exported for direct unit testing against a fixture string, never
 * needing a real file on disk.
 */
export function extractAlertNamesFromSource(sourceText) {
  const names = [];
  for (const match of sourceText.matchAll(ALERT_NAME_PATTERN)) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Lists every `.ts` file directly inside `opsDir`, excluding the `__tests__`
 * subdirectory -- mirrors the same top-level-only, tests-excluded scan every
 * sibling watchdog module in this directory already assumes about its own
 * neighbours. Returns absolute-from-`cwd`-relative paths, sorted, so the
 * enumeration order is stable and reproducible run to run.
 */
function listOpsSourceFiles(opsDir, cwd) {
  const absoluteDir = path.resolve(cwd, opsDir);
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(opsDir, entry.name))
    .sort();
}

/** The runbook file name this check requires for a given alert name -- one fixed convention, never a lookup table. */
export function expectedRunbookPathFor(alertName, runbooksDir = DEFAULT_RUNBOOKS_DIR) {
  return path.join(runbooksDir, `${alertName}-alert.md`);
}

/**
 * Runs the full check against real files (or injected paths, for tests).
 * Returns `{ checkedCount, missing, alertNames }` -- never throws for a
 * coverage gap or an empty enumeration; the CLI below decides how to
 * report/exit on both.
 */
export function checkRunbookCoverage({ opsDir = DEFAULT_OPS_DIR, runbooksDir = DEFAULT_RUNBOOKS_DIR, cwd = process.cwd() } = {}) {
  const sourceFiles = listOpsSourceFiles(opsDir, cwd);

  const alertNames = [];
  const seen = new Set();
  for (const relativeFile of sourceFiles) {
    const sourceText = readFileSync(path.resolve(cwd, relativeFile), "utf8");
    for (const name of extractAlertNamesFromSource(sourceText)) {
      if (seen.has(name)) continue;
      seen.add(name);
      alertNames.push(name);
    }
  }

  const missing = alertNames.filter((name) => !existsSync(path.resolve(cwd, expectedRunbookPathFor(name, runbooksDir))));

  return { checkedCount: alertNames.length, missing, alertNames };
}

// ---------------------------------------------------------------------------
// CLI -- guarded so importing this module for tests does not execute it.
// ---------------------------------------------------------------------------

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${path.resolve(entry)}`;
}

if (isDirectInvocation()) {
  const { checkedCount, missing, alertNames } = checkRunbookCoverage();

  if (checkedCount === 0) {
    console.error(
      `check:runbook-coverage — enumerated ZERO alert names from ${DEFAULT_OPS_DIR}. ` +
        "This is a hard failure, not a vacuous pass: either every watchdog's " +
        "*_ALERT_NAME constant was removed/renamed, or this script's own " +
        "extraction pattern has drifted from the naming convention it depends on. " +
        "Fix whichever is true before trusting this gate again.",
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(`check:runbook-coverage — ${missing.length} alert(s) with no matching runbook:`);
    for (const name of missing) {
      console.error(`  ${name} -> expected ${expectedRunbookPathFor(name)}`);
    }
    console.error(`\n${checkedCount} alert(s) checked, ${missing.length} missing.`);
    process.exit(1);
  }

  console.log(`check:runbook-coverage — ${checkedCount} alert(s) checked (${alertNames.join(", ")}), every one has a runbook.`);
}
