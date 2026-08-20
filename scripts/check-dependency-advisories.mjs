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
// Phase 18 plan 02 -- the accept-list contract (.advisory-accept-list.json):
// the accept-list is the ONLY sanctioned way a blocking advisory stops
// blocking, and it exists SOLELY for findings PROVEN unreachable -- never as
// a snooze button for a reachable HIGH (D-11 still requires the upgrade even
// when the only fix is semver-major). Every entry needs all five fields:
// D-04: advisoryId, package, justification, owner, expiry are ALL mandatory
// -- an entry missing, empty, or non-string in any of them fails the gate
// outright (validateAcceptListEntry), because a malformed accept-list means
// the gate cannot know what was intentionally accepted. D-06: `justification`
// IS the reachability analysis itself (>= MIN_JUSTIFICATION_LENGTH chars) --
// there is deliberately no separate per-advisory analysis document to drift
// out of sync with it. D-07: `owner` is the accountable person's git author
// email. D-05: `expiry` (YYYY-MM-DD) is valid through the end of that date
// (inclusive) and capped at MAX_EXPIRY_DAYS days out; renewal is a reviewed
// PR that touches the entry, not a silent extension. A stale entry (valid,
// unexpired, matching no CURRENT advisory) is a printed warning, not a
// failure -- D-05's cap already bounds how long it can survive.
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
export const ACCEPT_LIST_FILENAME = ".advisory-accept-list.json";

/**
 * D-05: an accept-list entry's `expiry` is valid at most this many days out
 * from the moment the gate runs. A longer cap would let an acceptance
 * outlive the review that granted it; 90 days is one quarter -- long enough
 * that an owner isn't nagged every sprint, short enough that a forgotten
 * entry turns the build red (and gets noticed) well within a year.
 */
export const MAX_EXPIRY_DAYS = 90;

/**
 * D-06: the `justification` field IS the reachability analysis -- there is
 * deliberately no separate per-advisory analysis document to keep in sync.
 * 80 characters is a low bar (a single real sentence, not a paragraph), but
 * it is still a bar: it rejects "not reachable", "internal tool only", and
 * other one-line hand-waves that assert a conclusion without showing the
 * trace that reached it, while staying cheap enough not to discourage
 * writing the entry at all.
 */
export const MIN_JUSTIFICATION_LENGTH = 80;

/** D-04: GHSA advisory ids are `GHSA-` followed by three dash-separated groups. */
const GHSA_PATTERN = /^GHSA-[0-9A-Za-z]+-[0-9A-Za-z]+-[0-9A-Za-z]+$/;

/** D-07: owner is a git author email -- a plain, generic email shape. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** D-05: expiry is a plain `YYYY-MM-DD` calendar date, never a timestamp. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** D-04: the five mandatory accept-list entry fields, in the fixed order they are checked. */
const MANDATORY_ACCEPT_LIST_FIELDS = Object.freeze(["advisoryId", "package", "justification", "owner", "expiry"]);

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
 * produces it).
 *
 * D-05 / CR-01: an entry's `expiry` covers the ENTIRE calendar day it names,
 * in UTC, inclusive -- computed via the same `parseExpiryUtcDayMs`/
 * `toUtcDayMs` UTC-day comparison `validateAcceptListEntry` uses, so the two
 * functions can never disagree on the expiry boundary again (they used to:
 * this function previously compared millisecond-precision `Date` instants,
 * which expired an entry as soon as the clock passed UTC midnight on its
 * expiry day -- i.e. for nearly the entire day the entry was supposed to
 * still be valid). An unparseable/malformed `expiry` never covers a finding
 * -- fail closed, matching `validateAcceptListEntry`'s rejection of the same
 * entry, never "covers forever".
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
      const expiryUtcDayMs = parseExpiryUtcDayMs(entry.expiry);
      if (expiryUtcDayMs === undefined || expiryUtcDayMs < toUtcDayMs(now)) {
        continue; // expired (or unparseable) entries never cover a finding
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

/**
 * Returns true if `y-m-d` (1-indexed month) is a real UTC calendar date --
 * i.e. `Date.UTC` did not silently roll it over (the way `2026-02-30` rolls
 * into March).
 */
function isRealUtcCalendarDate(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

/**
 * CR-01: parses an accept-list entry's `expiry` field into UTC-day
 * milliseconds (midnight UTC on that calendar date), or returns `undefined`
 * if it is not a real `YYYY-MM-DD` calendar date. Shared by
 * `validateAcceptListEntry` and `selectBlockingFindings` so the two can
 * never disagree on the expiry boundary again -- callers must treat
 * `undefined` as "does not cover"/"invalid", never "covers forever".
 *
 * @param {unknown} expiry
 * @returns {number | undefined}
 */
function parseExpiryUtcDayMs(expiry) {
  if (typeof expiry !== "string") return undefined;
  const trimmed = expiry.trim();
  const match = ISO_DATE_PATTERN.exec(trimmed);
  if (!match) return undefined;
  const [year, month, day] = trimmed.split("-").map(Number);
  if (!isRealUtcCalendarDate(year, month, day)) return undefined;
  return Date.UTC(year, month - 1, day);
}

/**
 * UTC-day milliseconds (midnight UTC) for a `Date` -- ignores its
 * time-of-day, so a comparison against `parseExpiryUtcDayMs`'s result is a
 * whole-calendar-day comparison regardless of what time of day `date` is.
 *
 * @param {Date} date
 * @returns {number}
 */
function toUtcDayMs(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Validates one accept-list entry and returns the list of problems found (an
 * empty array means the entry is valid). Checks run in a fixed order so
 * messages are stable: object shape; each of the five mandatory fields
 * present/string/non-empty (D-04); advisoryId GHSA-shaped; owner
 * email-shaped (D-07); justification length (D-06); expiry format and real
 * calendar date; then the two date rules against `now`, computed purely in
 * UTC day units so the result never depends on the runner's timezone
 * (T-18-10): expired when the expiry day is strictly before `now`'s UTC day
 * (an entry is valid through the end of its expiry date -- inclusive), and
 * over-cap when the expiry day is more than MAX_EXPIRY_DAYS days after
 * `now`'s UTC day (D-05). The two failures carry distinct messages so a
 * lapsed acceptance is never confused with one requesting too long a window.
 *
 * @param {unknown} entry
 * @param {Date} now
 * @returns {string[]}
 */
export function validateAcceptListEntry(entry, now) {
  const problems = [];

  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    problems.push('entry must be an object with fields "advisoryId", "package", "justification", "owner", "expiry"');
    return problems;
  }

  const present = {};
  for (const field of MANDATORY_ACCEPT_LIST_FIELDS) {
    const value = Object.prototype.hasOwnProperty.call(entry, field) ? entry[field] : undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
      problems.push(`field "${field}" is required and must be a non-empty string`);
      present[field] = false;
    } else {
      present[field] = true;
    }
  }

  if (present.advisoryId && !GHSA_PATTERN.test(entry.advisoryId.trim())) {
    problems.push(`field "advisoryId" must be GHSA-shaped (GHSA-xxxx-xxxx-xxxx): got "${entry.advisoryId}"`);
  }

  if (present.owner && !EMAIL_PATTERN.test(entry.owner.trim())) {
    problems.push(`field "owner" must be an email-shaped git author address: got "${entry.owner}"`);
  }

  if (present.justification) {
    const length = entry.justification.trim().length;
    if (length < MIN_JUSTIFICATION_LENGTH) {
      problems.push(
        `field "justification" must be at least ${MIN_JUSTIFICATION_LENGTH} characters -- it IS the reachability analysis, not a label (got ${length})`,
      );
    }
  }

  let expiryUtcDayMs;
  if (present.expiry) {
    expiryUtcDayMs = parseExpiryUtcDayMs(entry.expiry);
    if (expiryUtcDayMs === undefined) {
      problems.push(`field "expiry" must be a real calendar date in YYYY-MM-DD form: got "${entry.expiry}"`);
    }
  }

  if (expiryUtcDayMs !== undefined) {
    const nowUtcDayMs = toUtcDayMs(now);
    const diffDays = Math.round((expiryUtcDayMs - nowUtcDayMs) / (24 * 60 * 60 * 1000));
    if (diffDays < 0) {
      problems.push(
        `field "expiry" (${entry.expiry.trim()}) has passed -- the acceptance has lapsed and must be renewed by a reviewed PR`,
      );
    } else if (diffDays > MAX_EXPIRY_DAYS) {
      problems.push(
        `field "expiry" (${entry.expiry.trim()}) is ${diffDays} day(s) out, exceeding the ${MAX_EXPIRY_DAYS}-day cap`,
      );
    }
  }

  return problems;
}

/**
 * Loads and shape-validates the accept-list file at `filePath`. Returns
 * `{ fileExisted, entries, problems }`: `fileExisted` is false (never a
 * throw) when the file is absent -- an absent accept-list is treated as
 * empty, strictly stricter than any live entry could make the gate, never
 * more permissive. `problems` covers only FILE-level shape issues --
 * unparseable JSON, a missing or non-array `entries`, and a duplicate
 * (advisoryId, package) pair (named by index) -- never individual field
 * validation, which is `validateAcceptListEntry`'s job against each returned
 * entry. Reads use own-property access and a `Map` for duplicate tracking
 * (T-18-07) so a crafted `__proto__`-shaped key in the JSON can never reach
 * `Object.prototype`.
 *
 * @param {string} filePath
 * @returns {{fileExisted: boolean, entries: unknown[], problems: string[]}}
 */
export function loadAcceptList(filePath) {
  if (!existsSync(filePath)) {
    return { fileExisted: false, entries: [], problems: [] };
  }

  const raw = readFileSync(filePath, "utf8");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      fileExisted: true,
      entries: [],
      problems: [`${ACCEPT_LIST_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.entries)) {
    return {
      fileExisted: true,
      entries: [],
      problems: [`${ACCEPT_LIST_FILENAME} must be an object with an "entries" array`],
    };
  }

  const problems = [];
  const seenPairs = new Map();
  parsed.entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const advisoryId = Object.prototype.hasOwnProperty.call(entry, "advisoryId") ? entry.advisoryId : undefined;
    const pkg = Object.prototype.hasOwnProperty.call(entry, "package") ? entry.package : undefined;
    if (typeof advisoryId !== "string" || typeof pkg !== "string") return;
    const key = `${advisoryId}::${pkg}`;
    if (seenPairs.has(key)) {
      problems.push(
        `duplicate accept-list entry for advisoryId "${advisoryId}" and package "${pkg}" at indices ${seenPairs.get(key)} and ${index} -- one acceptance cannot have two owners`,
      );
    } else {
      seenPairs.set(key, index);
    }
  });

  return { fileExisted: true, entries: parsed.entries, problems };
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

  const acceptListPath = path.join(REPO_ROOT, ACCEPT_LIST_FILENAME);
  const loaded = loadAcceptList(acceptListPath);
  if (!loaded.fileExisted) {
    console.log(`check:dependency-advisories -- no ${ACCEPT_LIST_FILENAME} found; treating the accept-list as empty.`);
  }

  const now = new Date();
  const entryProblems = [];
  loaded.entries.forEach((entry, index) => {
    for (const problem of validateAcceptListEntry(entry, now)) {
      const advisoryId = entry && typeof entry === "object" ? entry.advisoryId : undefined;
      const pkg = entry && typeof entry === "object" ? entry.package : undefined;
      entryProblems.push(
        `entry ${index} (advisoryId=${JSON.stringify(advisoryId ?? null)}, package=${JSON.stringify(pkg ?? null)}): ${problem}`,
      );
    }
  });

  const acceptListProblems = [...loaded.problems, ...entryProblems];
  if (acceptListProblems.length > 0) {
    // D-04: a malformed accept-list fails the gate outright, regardless of
    // the advisory state -- the gate cannot know what was intentionally
    // accepted, so it must not silently treat a broken entry as zero
    // acceptances.
    console.error(
      [
        `check:dependency-advisories FAILED: ${ACCEPT_LIST_FILENAME} is malformed.`,
        "",
        "Problems:",
        ...acceptListProblems.map((p) => `  - ${p}`),
        "",
        "Remediation:",
        `  Fix the offending field(s) in ${ACCEPT_LIST_FILENAME}. Every entry needs advisoryId (GHSA-shaped),`,
        `  package, justification (>= ${MIN_JUSTIFICATION_LENGTH} chars -- the reachability analysis itself),`,
        `  owner (an email address), and expiry (YYYY-MM-DD, at most ${MAX_EXPIRY_DAYS} days out).`,
      ].join("\n"),
    );
    process.exit(1);
    return;
  }

  const findings = selectBlockingFindings(advisories, loaded.entries, now);

  // D-04/D-06: every entry here has already passed validateAcceptListEntry,
  // so an entry present in the tree today but matching no CURRENT advisory
  // is a stale acceptance -- surfaced as a warning (next-review cleanup),
  // never a failure by itself.
  const advisoryKeys = new Set(advisories.map((a) => `${a.package}::${a.advisoryId}`));
  for (const entry of loaded.entries) {
    const key = `${entry.package}::${entry.advisoryId}`;
    if (!advisoryKeys.has(key)) {
      console.warn(
        `check:dependency-advisories -- stale accept-list entry (advisoryId=${entry.advisoryId}, package=${entry.package}) matches no advisory in the current tree; remove it in its next review.`,
      );
    }
  }

  if (findings.length > 0) {
    console.error(formatFailureReport(findings));
    process.exit(1);
    return;
  }

  console.log(
    `check:dependency-advisories -- ${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} examined, ${loaded.entries.length} accept-list entr${loaded.entries.length === 1 ? "y" : "ies"} applied, 0 blocking finding(s).`,
  );
}

if (isDirectInvocation()) {
  main();
}
