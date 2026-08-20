#!/usr/bin/env node
// Phase 18 plan 01 (DEP-01, DEP-02, DEP-03). The dependency advisory gate:
// fails CI on any HIGH/CRITICAL npm advisory not covered by a justified,
// owned, time-limited accept-list entry.
//
// D-01: the advisory source of truth is `npm audit --json`, GHSA ids as
// reported by npm audit ARE advisory identity. No new scanner dependency
// (osv-scanner and audit-ci were both explicitly rejected) -- npm already
// talks to the registry's advisory bulk data; a parallel client would
// duplicate a solved problem for zero benefit.
//
// D-02: there is deliberately NO diff-against-master machinery here. The
// gate fails on ANY blocking-severity advisory not on the accept-list, full
// stop. "New/untriaged" is implied by construction, not computed: DEP-01's
// baseline cleanup (a separate plan) makes everything present at that point
// either fixed or accept-listed, so any advisory this gate later reports
// necessarily arrived after that baseline. No master-state fetch, no git
// history read -- fully deterministic against the current tree alone.
//
// D-08: the scan is the FULL dependency tree, INCLUDING devDependencies --
// never `npm audit --omit=dev`. A prod-only scan would make DEP-03 (the
// accept-list mechanism for proven-unreachable tooling-only findings) a
// dead letter, since tooling-only packages live in devDependencies by
// definition. Tooling-only HIGHs are triaged exactly like production-path
// HIGHs: fixed if cheap, accept-listed with a reachability analysis
// otherwise.
//
// D-09: only `high` and `critical` severities ever block. `moderate` and
// `low` never do, regardless of what a package's rolled-up severity claims
// (see collectAdvisories below -- the rollup is never consulted).
//
// D-11 (semver-major fix policy): a HIGH or CRITICAL advisory reachable on
// a production path is ALWAYS fixed by upgrading immediately, even when the
// only available fix is a semver-major bump -- the accept-list exists only
// for advisories PROVEN unreachable, never to bridge a reachable finding
// past an inconvenient major bump. At the time this gate was authored, no
// advisory in this repository's tree required a semver-major bump to fix;
// this policy therefore governs FUTURE findings, not the current set, and
// is recorded here so a future author does not quietly reach for the
// accept-list instead of doing the upgrade.
//
// D-10 (drizzle-kit reachability -- closes the ROADMAP's open plan-time
// question): `drizzle-kit` is declared in `packages/db`'s `devDependencies`.
// `npm ls drizzle-kit --omit=dev` nonetheless shows a path
// `apps/api -> better-auth -> drizzle-kit`, but that edge is better-auth's
// OPTIONAL peerDependency (`peerDependenciesMeta.drizzle-kit.optional ===
// true`), satisfied only because npm workspace hoisting places the single
// physical copy `packages/db` already declares at the shared root
// `node_modules/drizzle-kit`. better-auth's shipped `dist/` contains ZERO
// references to drizzle-kit (verified: `grep -rl "drizzle-kit"
// node_modules/better-auth/dist` returns no matches) -- the peer is opt-in
// CLI-only tooling (`@better-auth/cli`'s schema-generation command), never
// invoked by the running server. drizzle-kit's own advisory (via
// @esbuild-kit/esm-loader -> @esbuild-kit/core-utils -> esbuild) is
// MODERATE, below this gate's HIGH/CRITICAL blocking threshold regardless.
// Conclusion: no upgrade and no accept-list entry for drizzle-kit -- an
// accept-list entry must never be manufactured for a finding that isn't
// even blocking.
//
// Same class as scripts/check-lockfile-npm10.mjs and
// scripts/validate-alloy-config.mjs: Node built-ins only, REPO_ROOT resolved
// from import.meta.url (runnable from any cwd), exported pure helpers plus a
// guarded main(), fail-closed on unavailable/unparseable tooling (D-03) --
// there is no skip path and no env flag that downgrades an unreachable or
// malformed npm audit run into a pass.
//
// No dependencies -- Node built-ins only. Do not import `zod` even though it
// resolves via node_modules hoisting from apps/api -- every scripts/*.mjs
// gate in this repo hand-rolls its own validation for exactly this reason
// (hoisting resolution is fragile: a future dedup change would silently
// break this gate).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** D-09: only these severities ever block the gate. */
export const BLOCKING_SEVERITIES = Object.freeze(new Set(["high", "critical"]));

/** D-04: the accept-list lives at the repo root under this exact name. */
const ACCEPT_LIST_FILENAME = ".advisory-accept-list.json";

/** D-03: attempts before failing closed on an unreachable/unparseable audit run. */
const DEFAULT_MAX_RETRIES = 3;

/**
 * Walks an auditReportVersion-2 `vulnerabilities` object and returns one
 * record per LEAF advisory: `{ package, advisoryId, severity, title, url }`.
 *
 * Per Pitfall 2 (RESEARCH.md): a package's top-level `severity` field is a
 * MAX-rollup across every advisory that package carries -- it is NEVER read
 * here. Each record's `severity` comes from the individual `via[]` advisory
 * object that produced it, so a package carrying both a high and a moderate
 * advisory yields two records with two distinct severities.
 *
 * `via[]` mixes two shapes: a plain string is a reference to ANOTHER package
 * key in the same `vulnerabilities` object (a "depends on vulnerable version
 * of X" compound relationship) and must be recursed into; an object is a
 * leaf advisory and is attributed to the CURRENT package (the one whose
 * `via[]` produced it), never to whichever package originally referenced it
 * as a string. A compound parent that owns no advisory of its own therefore
 * contributes zero records.
 *
 * T-18-01/T-18-02 mitigations: `seen` terminates a cyclic or diamond
 * reference chain (each package is walked at most once); an own-property
 * check on every object read means a registry-supplied key shaped like
 * `__proto__` can never redirect a lookup onto `Object.prototype`. The
 * `advisories` accumulator is a plain array, never an object keyed by
 * attacker-controlled data.
 *
 * @param {Record<string, {via: Array<string | {url: string, severity: string, title?: string}>}>} vulnerabilities
 * @returns {Array<{package: string, advisoryId: string | undefined, severity: string, title: string | undefined, url: string | undefined}>}
 */
export function collectAdvisories(vulnerabilities) {
  const advisories = [];
  const seen = new Set();

  function walk(pkgName) {
    if (seen.has(pkgName)) return;
    seen.add(pkgName);
    if (!Object.prototype.hasOwnProperty.call(vulnerabilities, pkgName)) return;
    const entry = vulnerabilities[pkgName];
    if (!entry || !Array.isArray(entry.via)) return;
    for (const via of entry.via) {
      if (typeof via === "string") {
        walk(via);
      } else if (via && typeof via === "object") {
        advisories.push({
          package: pkgName,
          advisoryId: typeof via.url === "string" ? via.url.split("/").pop() : undefined,
          severity: via.severity,
          title: via.title,
          url: via.url,
        });
      }
    }
  }

  for (const pkgName of Object.keys(vulnerabilities)) {
    walk(pkgName);
  }

  return advisories;
}

/** The real subprocess call `runNpmAuditWithRetries` uses by default -- the
 * ONE genuine I/O primitive in this module. Never called directly by tests;
 * they inject a replacement via `runNpmAuditWithRetries`'s `runAudit` seam. */
function defaultRunAudit(cwd) {
  return execFileSync("npm", ["audit", "--json"], { cwd, encoding: "utf8" });
}

/**
 * Runs `npm audit --json` and returns the parsed report. This is the ONE I/O
 * function in this module.
 *
 * Pitfall 4 / important verified detail: npm exits NON-ZERO whenever it
 * finds ANY vulnerability -- that is npm's normal signal, not a tool
 * failure, and the full JSON report is still written to stdout. On a thrown
 * error this function reads `err.stdout` and attempts to parse it before
 * treating the attempt as failed (the `runCapture` idiom already established
 * in scripts/check-lockfile-npm10.mjs). A parsed document is only accepted
 * if `auditReportVersion === 2` and `vulnerabilities` is a plain object --
 * anything else (wrong schema version, missing field, empty/unparseable
 * stdout) is a failed attempt.
 *
 * D-03: retries up to `maxRetries` times and then THROWS a fail-closed
 * error naming the attempt count. There is no skip path and no env flag
 * that downgrades this to a pass -- an unreachable or unparseable registry
 * response is a violation, matching the Alloy-gate precedent
 * (scripts/validate-alloy-config.mjs's `ALLOY_VALIDATE_REQUIRE_BINARY`
 * branch). No backoff sleep between attempts: each attempt is a fresh
 * synchronous child process: an immediate retry is sufficient for a
 * transient registry hiccup, and this function must stay synchronous to
 * keep the CLI's control flow linear like every sibling gate script.
 *
 * The actual subprocess invocation is behind the injectable `runAudit(cwd)`
 * seam (defaulting to `defaultRunAudit`, a thin wrapper over
 * `execFileSync`), mirroring `scripts/validate-alloy-config.mjs`'s
 * `runValidation({dockerAvailable, runFmt})` injectable-defaults
 * convention -- tests drive the retry/fail-closed/non-zero-exit-parse path
 * through this seam directly, never by mocking the module or spawning a
 * real `npm audit` subprocess.
 *
 * @param {string} cwd
 * @param {number} [maxRetries]
 * @param {{runAudit?: (cwd: string) => string}} [deps]
 * @returns {{auditReportVersion: number, vulnerabilities: Record<string, unknown>, metadata?: unknown}}
 */
export function runNpmAuditWithRetries(cwd, maxRetries = DEFAULT_MAX_RETRIES, { runAudit = defaultRunAudit } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    let stdout;
    try {
      stdout = runAudit(cwd);
    } catch (err) {
      // npm exits non-zero whenever it finds ANY vulnerability -- read
      // err.stdout and keep going; only genuinely missing/empty output
      // below falls through to a failed attempt.
      stdout = typeof err?.stdout === "string" ? err.stdout : undefined;
    }

    if (typeof stdout === "string" && stdout.trim().length > 0) {
      try {
        const parsed = JSON.parse(stdout);
        const hasValidVulnerabilities =
          parsed &&
          typeof parsed === "object" &&
          parsed.vulnerabilities &&
          typeof parsed.vulnerabilities === "object" &&
          !Array.isArray(parsed.vulnerabilities);
        if (parsed?.auditReportVersion === 2 && hasValidVulnerabilities) {
          return parsed;
        }
        lastError = new Error(
          `unexpected npm audit report shape (auditReportVersion=${JSON.stringify(parsed?.auditReportVersion)})`,
        );
      } catch (parseErr) {
        lastError = parseErr instanceof Error ? parseErr : new Error(String(parseErr));
      }
    } else {
      lastError = new Error("npm audit produced no parseable stdout");
    }
  }

  throw new Error(
    `check-dependency-advisories FAILED CLOSED: npm audit was unreachable or produced unparseable output after ${maxRetries} attempt(s). Last error: ${lastError?.message ?? "unknown"}`,
  );
}

/**
 * Filters `advisories` down to `BLOCKING_SEVERITIES` and removes any finding
 * covered by an accept-list entry whose `advisoryId` AND `package` BOTH
 * match -- matched on the LEAF package name `collectAdvisories` attributes
 * each record to. `acceptList` is consumed here as a plain list of
 * already-validated entries (plan 18-02 adds the schema validation that
 * produces it); an entry that also carries a parseable `expiry` in the past
 * relative to `now` is treated as not covering anything, so this function
 * degrades safely even before 18-02's validation exists.
 *
 * Findings are returned sorted by package name, then advisory id, so the
 * report is byte-stable across runs over the same tree.
 *
 * @param {ReturnType<typeof collectAdvisories>} advisories
 * @param {Array<{advisoryId?: string, package?: string, expiry?: string}>} acceptList
 * @param {Date} now
 */
export function selectBlockingFindings(advisories, acceptList, now) {
  const accepted = new Set();
  for (const entry of Array.isArray(acceptList) ? acceptList : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.expiry) {
      const expiryDate = new Date(entry.expiry);
      if (!Number.isNaN(expiryDate.getTime()) && expiryDate.getTime() < now.getTime()) {
        continue; // expired entries never cover a finding
      }
    }
    accepted.add(`${entry.package}::${entry.advisoryId}`);
  }

  const blocking = advisories.filter((a) => BLOCKING_SEVERITIES.has(a.severity));
  const surviving = blocking.filter((a) => !accepted.has(`${a.package}::${a.advisoryId}`));

  return surviving.slice().sort((a, b) => {
    if (a.package !== b.package) return a.package < b.package ? -1 : 1;
    const idA = a.advisoryId ?? "";
    const idB = b.advisoryId ?? "";
    if (idA !== idB) return idA < idB ? -1 : 1;
    return 0;
  });
}

/**
 * The actionable failure report. Three parts, matching every sibling gate's
 * failure shape: what failed, the raw evidence (one line per finding, leaf
 * package + GHSA id + severity + advisory url), then an explicit
 * "Remediation:" section.
 *
 * @param {ReturnType<typeof selectBlockingFindings>} findings
 */
export function formatFailureReport(findings) {
  const lines = [];
  lines.push(
    `check:dependency-advisories FAILED: ${findings.length} blocking advisory finding(s) not covered by ${ACCEPT_LIST_FILENAME}.`,
  );
  lines.push("");
  lines.push("Findings:");
  for (const f of findings) {
    lines.push(`  - ${f.package}  ${f.advisoryId ?? "(unknown advisory id)"}  severity=${f.severity}`);
    if (f.title) lines.push(`      ${f.title}`);
    if (f.url) lines.push(`      ${f.url}`);
  }
  lines.push("");
  lines.push("Remediation:");
  lines.push("  1. Try the automatic fix first:  npm audit fix");
  lines.push(
    "  2. If a package needs a direct-pin bump:  npm install <pkg>@<version> -w <workspace>",
  );
  lines.push(
    `  3. If (and only if) the finding is PROVEN unreachable, add a justified, owned, time-limited entry to ${ACCEPT_LIST_FILENAME} (advisoryId, package, justification, owner, expiry <= 90 days out).`,
  );
  return lines.join("\n");
}

function loadAcceptList(repoRoot) {
  const file = path.join(repoRoot, ACCEPT_LIST_FILENAME);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed?.entries) ? parsed.entries : [];
}

function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

/** main() orchestrates only -- all logic above is pure and independently testable. */
function main() {
  let report;
  try {
    report = runNpmAuditWithRetries(REPO_ROOT, DEFAULT_MAX_RETRIES);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  const advisories = collectAdvisories(report.vulnerabilities ?? {});
  const acceptList = loadAcceptList(REPO_ROOT);
  const findings = selectBlockingFindings(advisories, acceptList, new Date());

  if (findings.length > 0) {
    console.error(formatFailureReport(findings));
    process.exit(1);
    return;
  }

  console.log(
    `check:dependency-advisories -- ${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} examined, ${acceptList.length} accept-list entr${acceptList.length === 1 ? "y" : "ies"} applied, 0 blocking finding(s).`,
  );
}

if (isDirectInvocation()) {
  main();
}
