#!/usr/bin/env node
// Phase 14 plan 13 (DB-14 §3 filing gate). The machine half of
// `.claude/CLAUDE.md`'s "Project Specification (SPECIFICATION.md)" rule for
// the secrets section specifically: every environment variable name
// `docker/prod.env.example` documents must also appear in `SPECIFICATION.md`.
//
// This is the mechanism that makes CLAUDE.md's same-change rule survive the
// NEXT phase: a future plan that adds a secret to `docker/prod.env.example`
// and forgets to file it into SPECIFICATION.md's §3 is told by CI, not by a
// security reviewer reading the two documents side by side months later.
//
// Deliberately ONE-DIRECTIONAL: this only checks env.example -> SPEC. A name
// SPECIFICATION.md mentions but env.example does not (there are legitimate
// ones -- PARTITION_RETENTION_ENABLED is deliberately absent from
// env.example because plan 14-12 ships it default-off with no committed
// value anywhere, per that plan's own D5 coverage check) is not this gate's
// concern and is never flagged.
//
// No dependencies -- Node built-ins only, in the same class as
// scripts/lint-session-state.mjs and scripts/lint-pg-pool-factory.mjs:
// exported pure helpers, a CLI behind an `import.meta.url` guard, and a
// reported checked-name count so a vacuous pass (e.g. an empty env.example
// silently "passing" with zero names checked) is visible rather than hidden
// inside a bare exit 0.

import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_ENV_EXAMPLE_PATH = "docker/prod.env.example";
const DEFAULT_SPEC_PATH = "SPECIFICATION.md";

/**
 * Extracts every environment-variable NAME `docker/prod.env.example`
 * declares -- never a value, per this repository's own "names, sources and
 * purposes only" rule (T-14-83). Matches only an UNCOMMENTED line whose
 * first non-whitespace character starts a `KEY=` assignment
 * (`^[A-Z_][A-Z0-9_]*=`) -- a commented-out placeholder line
 * (`# API_PORT=4000`, `# WORKER_HEALTH_PORT=4100`) is deliberately NOT an
 * active variable this compose topology reads, and must not be swept into
 * the required-coverage list alongside the 41 genuinely active ones. Names
 * are de-duplicated (several names -- `PGBACKREST_STANZA`, `NODE_ENV` --
 * appear on more than one commented section boundary in the source file)
 * while preserving first-seen order, which is what makes the missing-name
 * report readable top-to-bottom against the file it came from.
 */
export function extractEnvVarNames(envExampleContent) {
  const names = [];
  const seen = new Set();
  const lines = envExampleContent.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (!match) continue;
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Word-boundary containment, not a bare substring check: `\b` fails to
 * match between two word characters, and `_` is a word character in
 * JavaScript regex semantics -- so `PGBACKREST_REPO1_S3_KEY\b` correctly
 * does NOT match inside `PGBACKREST_REPO1_S3_KEY_SECRET` (the `Y`/`_`
 * junction has no boundary), which a plain `specContent.includes(name)`
 * check would have silently treated as coverage for the shorter name.
 */
function nameAppearsIn(name, specContent) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(specContent);
}

/** Returns the subset of `names` that do NOT appear in `specContent`. */
export function findMissingNames(names, specContent) {
  return names.filter((name) => !nameAppearsIn(name, specContent));
}

/**
 * Runs the full check against real files (or an injected pair, for tests).
 * Returns `{ checkedCount, missing }` -- never throws for a coverage gap;
 * the CLI below decides how to report/exit.
 */
export function checkSpecEnvCoverage({
  envExamplePath = DEFAULT_ENV_EXAMPLE_PATH,
  specPath = DEFAULT_SPEC_PATH,
  cwd = process.cwd(),
} = {}) {
  const envExampleContent = readFileSync(path.resolve(cwd, envExamplePath), "utf8");
  const specContent = readFileSync(path.resolve(cwd, specPath), "utf8");
  const names = extractEnvVarNames(envExampleContent);
  const missing = findMissingNames(names, specContent);
  return { checkedCount: names.length, missing };
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
  const { checkedCount, missing } = checkSpecEnvCoverage();

  if (missing.length > 0) {
    console.error(
      `check:spec-env-coverage — ${missing.length} name(s) from ${DEFAULT_ENV_EXAMPLE_PATH} missing from ${DEFAULT_SPEC_PATH}:`,
    );
    for (const name of missing) {
      console.error(`  ${name}`);
    }
    console.error(`\n${checkedCount} name(s) checked, ${missing.length} missing.`);
    process.exit(1);
  }

  console.log(
    `check:spec-env-coverage — ${checkedCount} name(s) checked, all present in ${DEFAULT_SPEC_PATH}.`,
  );
}
