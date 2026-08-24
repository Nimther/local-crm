---
phase: 18-dependency-hygiene-advisory-gate
reviewed: 2026-08-20T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - scripts/check-dependency-advisories.mjs
  - scripts/__tests__/check-dependency-advisories.test.mjs
  - scripts/__fixtures__/dependency-advisories/pre-fix-audit.json
  - scripts/__tests__/advisory-scan-workflow.test.mjs
  - .github/workflows/advisory-scan.yml
  - .github/workflows/ci.yml
  - apps/web/package.json
findings:
  critical: 1
  warning: 2
  info: 3
  total: 6
status: issues_found
---

# Phase 18: Code Review Report

**Reviewed:** 2026-08-20T00:00:00Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

Reviewed the dependency advisory gate script, its regression suite, the committed pre-fix `npm audit` fixture, the daily scheduled `advisory-scan.yml` workflow plus its drift test, the `ci.yml` diff that wires the gate into the required `static` job, and the `apps/web/package.json` version bumps that turn the gate green.

Several things verified correctly: `collectAdvisories`'s leaf-attribution math matches the fixture exactly (9 blocking findings across 7 distinct packages, `postcss`'s moderate/high split attributed to the right advisory ids, the `concurrently`/`shell-quote` compound-parent case contributing zero records to `concurrently`); the `postcss` and `react-router` version bumps in `apps/web/package.json` match the fixture's `fixAvailable` versions exactly; `runNpmAuditWithRetries` genuinely fails closed (no skip path, no env override) on unreachable/unparseable `npm audit` output; `advisory-scan.yml`'s gate-invocation line is byte-identical to `ci.yml`'s (enforced by the drift test), its `permissions:` block is scoped to exactly `contents: read` + `issues: write`, and every third-party action is pinned to a full 40-character commit SHA; the committed `.advisory-accept-list.json` is empty (`{"entries": []}`), consistent with D-11's policy of fixing every current HIGH rather than accept-listing it.

However, the accept-list's headline guarantee — that an entry's `expiry` date is valid *through the end of that day, inclusive* (D-05) — is violated by the enforcement path. `validateAcceptListEntry` (the schema/shape checker) implements the inclusive UTC-day comparison correctly and is unit-tested for it. `selectBlockingFindings` (the function that actually decides whether a finding is suppressed) re-implements its own, older, millisecond-precision date comparison that was never updated to match, and expires an entry as soon as the clock passes UTC midnight on its expiry day — i.e., for essentially the entire last day the entry is supposed to be valid. This is empirically reproduced below (CR-01). It fails **closed** (a valid accept-list entry stops suppressing its finding a day early, so the gate goes red on a legitimate PR), not open, but it directly contradicts the phase's own documented and tested contract and will surprise whoever owns the first real accept-list entry that reaches its expiry date. Two warnings and three info-level notes round out the rest.

## Critical Issues

### CR-01: `selectBlockingFindings` expires accept-list entries a full day before `validateAcceptListEntry` says they lapse

**File:** `scripts/check-dependency-advisories.mjs:302-325` (the expiry check specifically at lines 306-311), compared against the UTC-day-inclusive logic at lines 423-447.

**Issue:** `validateAcceptListEntry` computes expiry against `now` in whole UTC-day units (`Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())`), so an entry with `expiry: "2026-01-15"` is valid for the *entire* calendar day of 2026-01-15 UTC, per D-05 and Test 18 ("accepts an expiry of exactly today -- the expiry date is inclusive"). `selectBlockingFindings`, which is the function that actually decides whether the entry suppresses a finding, instead does:

```js
if (entry.expiry) {
  const expiryDate = new Date(entry.expiry);       // midnight UTC on the expiry date
  if (!Number.isNaN(expiryDate.getTime()) && expiryDate.getTime() < now.getTime()) {
    continue; // expired entries never cover a finding
  }
}
```

`new Date("2026-01-15")` parses to `00:00:00.000Z`. Any `now` later than that instant on the *same calendar day* satisfies `expiryDate.getTime() < now.getTime()`, so the entry is treated as already expired — even though `validateAcceptListEntry` (called first, in `main()`) just certified it as valid with zero problems. `main()` calls both functions with the same `now = new Date()`, so in production this triggers on every gate run after UTC midnight on an entry's expiry date (i.e., essentially all day, every day an entry expires).

Reproduced directly against the exported functions:

```
node -e '
import("./scripts/check-dependency-advisories.mjs").then(({validateAcceptListEntry, selectBlockingFindings}) => {
  const NOW = new Date(Date.UTC(2026,0,15,12,0,0)); // noon UTC on the expiry day
  const entry = {
    advisoryId: "GHSA-abcd-1234-efgh", package: "postcss",
    justification: "x".repeat(90), owner: "a@b.com", expiry: "2026-01-15",
  };
  console.log("validateAcceptListEntry:", validateAcceptListEntry(entry, NOW));       // []
  const advisories = [{package: "postcss", advisoryId: "GHSA-abcd-1234-efgh", severity: "high"}];
  console.log("selectBlockingFindings:", selectBlockingFindings(advisories, [entry], NOW));
  // -> [{ package: "postcss", advisoryId: "GHSA-abcd-1234-efgh", severity: "high" }]  <- NOT suppressed
});'
```

`validateAcceptListEntry` reports zero problems (the entry is valid), yet `selectBlockingFindings` still surfaces the finding as blocking. In `main()` this fails the CI gate on a legitimate PR for the entirety of an accept-list entry's last valid day, contradicting the explicit, unit-tested "inclusive" contract this same file documents at lines 79-83 and 375-381. It fails closed (a spurious red build), not open, but it breaks the accept-list mechanism this whole phase exists to deliver, and the existing test suite cannot catch it: every test in `check-dependency-advisories.test.mjs` fixes `NOW` at exact UTC midnight (`new Date(Date.UTC(2026, 0, 15))`), which is the single instant where the two functions happen to agree, masking the bug.

There is a second, related defect in the same block: if `entry.expiry` is present but unparseable (`Number.isNaN(expiryDate.getTime())` is true), the `if` guard is false, so the `continue` is skipped and the entry is added to `accepted` unconditionally — an unparseable expiry currently means "covers forever" rather than "does not cover." This path is unreachable through `main()` today (an unparseable expiry is rejected by `validateAcceptListEntry` before `selectBlockingFindings` ever runs), but `selectBlockingFindings` is an independently exported, independently tested function, and its wrong default direction should not survive a fix to this block.

**Fix:** Extract a single UTC-day comparison helper and use it in both functions, so the two can never drift apart again, and make an unparseable/untrimmed expiry fail to cover (not cover forever):

```js
/** Shared by validateAcceptListEntry and selectBlockingFindings so the two
 * can never disagree on the expiry boundary again. Returns undefined if
 * `expiry` is not a real YYYY-MM-DD calendar date. */
function parseExpiryUtcDayMs(expiry) {
  if (typeof expiry !== "string") return undefined;
  const trimmed = expiry.trim();
  const match = ISO_DATE_PATTERN.exec(trimmed);
  if (!match) return undefined;
  const [year, month, day] = trimmed.split("-").map(Number);
  if (!isRealUtcCalendarDate(year, month, day)) return undefined;
  return Date.UTC(year, month - 1, day);
}

function toUtcDayMs(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

// in selectBlockingFindings:
if (entry.expiry) {
  const expiryUtcDayMs = parseExpiryUtcDayMs(entry.expiry);
  // unparseable expiry never covers a finding -- fail closed, matching
  // validateAcceptListEntry's rejection of the same entry.
  if (expiryUtcDayMs === undefined || expiryUtcDayMs < toUtcDayMs(now)) {
    continue;
  }
}
```

Also add a regression test through `selectBlockingFindings` (not just `validateAcceptListEntry`) with a non-midnight `now` (e.g. `Date.UTC(2026, 0, 15, 12, 0, 0)`) and `expiry` equal to that same calendar day, asserting the finding IS suppressed — this is the scenario the current midnight-only `NOW` fixture cannot exercise.

## Warnings

### WR-01: `BLOCKING_SEVERITIES.has(a.severity)` has no normalization — a differently-cased or malformed severity silently becomes non-blocking

**File:** `scripts/check-dependency-advisories.mjs:184-186` (severity captured verbatim from the audit report), used unguarded at line 315.

**Issue:** `collectAdvisories` stores `severity: via.severity` straight from the parsed `npm audit --json` output with no type check or case normalization. `selectBlockingFindings` then does `blocking = advisories.filter((a) => BLOCKING_SEVERITIES.has(a.severity))`, where `BLOCKING_SEVERITIES` is `new Set(["high", "critical"])` — a case-sensitive, type-sensitive set lookup. If npm (or a future npm major, or a corrupted/truncated report that still happens to pass the `auditReportVersion === 2` shape check) ever emits `"High"`, `"HIGH"`, or a non-string severity value, the finding is silently treated as non-blocking and the gate reports a clean run despite a real HIGH-severity advisory being present. This is exactly the "a real finding turns into a green run" failure mode the gate is designed to prevent everywhere else (D-03's fail-closed retries, D-09's severity-rollup avoidance), but this one comparison has no defensive normalization.

**Fix:**
```js
const BLOCKING_SEVERITIES = Object.freeze(new Set(["high", "critical"]));

function normalizedSeverity(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

// in selectBlockingFindings:
const blocking = advisories.filter((a) => BLOCKING_SEVERITIES.has(normalizedSeverity(a.severity)));
```

### WR-02: The captured "advisory gate findings" issue body can silently diverge from the actual failing gate run

**File:** `.github/workflows/advisory-scan.yml:99-116`

**Issue:** The job's failure is determined by the `gate` step (`npm run check:dependency-advisories`, line 99-101). The issue body is populated by re-invoking the identical npm script a second time (lines 114-116, `if: failure()`) and capturing its stdout/stderr to a file. These are two separate process invocations of a script whose I/O layer (`npm audit --json` against the live registry, with its own internal retry loop) is not guaranteed to return byte-identical output seconds apart — e.g., a transient registry blip could make the first invocation fail closed (`FAILED CLOSED: npm audit was unreachable...`) while the second invocation succeeds and reports "0 blocking finding(s)", or vice versa. The resulting GitHub issue would then report content that contradicts why the job actually failed, undermining the actionability of the one alerting channel D-13 relies on.

Separately, `if: failure()` fires whenever *any* prior step in the job failed, not specifically the `gate` step — if `actions/checkout`, `actions/setup-node`, or `npm ci` fails (e.g. a registry/network flake), both the capture step and the issue-creation step still run, filing/commenting on an issue titled "Dependency advisory gate: scheduled scan failure" whose captured body may just be an unrelated install error rather than an actual advisory finding.

**Fix:** Prefer capturing the `gate` step's own output once (e.g. via `tee`/redirection on the original step, or `outputs:`) rather than re-running the script a second time, so the issue body is guaranteed to reflect what actually failed:

```yaml
- name: Dependency advisory gate (DEP-01/02/03)
  id: gate
  run: npm run check:dependency-advisories 2>&1 | tee /tmp/advisory-gate-output.txt
```
(note: this requires `shell: bash` to get `pipefail`, as `ci.yml`'s own e2e job comment already documents for an identical pattern). If distinguishing "install/checkout failure" from "gate failure" in the issue title/body is also desired, gate the issue step on `steps.gate.outcome == 'failure'` instead of the job-wide `failure()`.

## Info

### IN-01: `GHSA_PATTERN` is looser than the real GHSA id shape

**File:** `scripts/check-dependency-advisories.mjs:125`

**Issue:** `/^GHSA-[0-9A-Za-z]+-[0-9A-Za-z]+-[0-9A-Za-z]+$/` accepts any non-empty alphanumeric group in each of the three segments (e.g. `GHSA-a-b-c` passes), where real GHSA ids always use fixed-length lowercase-alphanumeric segments (`GHSA-xxxx-xxxx-xxxx`). Not exploitable (a malformed-but-matching id just means a slightly looser accept-list entry), but tightening it to the real shape would catch a typo'd advisory id at review time instead of at "this entry silently matches nothing."

**Fix:** `/^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4,}$/` (or the exact upstream character set if stricter validation is desired).

### IN-02: `cancel-in-progress` can cancel a scheduled run mid-way through issue creation

**File:** `.github/workflows/advisory-scan.yml:63-65`

**Issue:** The concurrency group is `${{ github.workflow }}-${{ github.ref }}` with `cancel-in-progress: true`. If a manual `workflow_dispatch` run is started against the same ref while the daily scheduled run is between its failed `gate` step and its "Open or update advisory gate issue" step, the scheduled run is cancelled before it files the issue for that cycle. The next dispatch/tick will still catch the underlying finding, so this doesn't lose the signal permanently, but it's a narrow gap in D-13's "a failed run opens exactly one issue" guarantee. Not worth losing `cancel-in-progress`'s benefit (avoiding overlapping scans) over; noting for awareness only.

### IN-03: `ci.yml` has no repository-scoped `permissions:` block (pre-existing, not introduced by this phase)

**File:** `.github/workflows/ci.yml:1-50`

**Issue:** Unlike the new `advisory-scan.yml`, `ci.yml` carries no top-level `permissions:` block and relies on the repository's default `GITHUB_TOKEN` scope (the file's own header comment at line 69-70 confirms this is deliberate/pre-existing). Confirmed via `git diff 7a8ba12..HEAD -- .github/workflows/ci.yml` that this phase's only change to the file is the new "Dependency advisory gate" step (lines 141-154) — the missing `permissions:` block predates this phase and is out of scope for this review's fix set. Flagged for awareness only; not a regression introduced here.

---

_Reviewed: 2026-08-20T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
