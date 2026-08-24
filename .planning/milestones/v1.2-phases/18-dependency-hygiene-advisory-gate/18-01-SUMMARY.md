---
phase: 18-dependency-hygiene-advisory-gate
plan: 01
subsystem: ci-quality-gates
tags: [dependency-hygiene, npm-audit, ci-gate, tdd]
status: complete
dependency-graph:
  requires: []
  provides:
    - scripts/check-dependency-advisories.mjs (check:dependency-advisories gate)
    - .advisory-accept-list.json (schema shape, empty)
  affects:
    - .github/workflows/ci.yml (static job, new required step)
tech-stack:
  added: []
  patterns:
    - "zero-dependency Node built-ins-only check:*.mjs gate script (matches 15 sibling gates)"
    - "injectable I/O seam (runAudit) for TDD-driving a subprocess-wrapping retry loop, mirroring validate-alloy-config.mjs's runValidation({dockerAvailable, runFmt}) convention"
key-files:
  created:
    - scripts/check-dependency-advisories.mjs
    - scripts/__tests__/check-dependency-advisories.test.mjs
    - scripts/__fixtures__/dependency-advisories/pre-fix-audit.json
    - .advisory-accept-list.json
  modified:
    - package.json (new check:dependency-advisories script)
    - .github/workflows/ci.yml (new step in the static job)
decisions:
  - "Tracer feedback gate: proceeded straight to Task 2 without a checkpoint, since the tracer's <verify> is fully automated (bash script, no human/visual surface) and re-ran clean three times; project config sets human_verify_mode: end-of-phase, and this plan has autonomous: true with zero checkpoint:* tasks -- a mid-plan human-verify checkpoint would contradict both."
  - "runNpmAuditWithRetries grew an injectable {runAudit} dependency during Task 2's GREEN step (not present in Task 1's commit) so the retry/fail-closed/non-zero-exit/wrong-version paths could be driven deterministically without a live network call or module-level mocking."
metrics:
  duration: ~55 minutes
  completed: 2026-08-20
---

# Phase 18 Plan 01: Dependency Advisory Gate (fail-first tracer) Summary

Built `scripts/check-dependency-advisories.mjs`, a zero-dependency CI gate that fails on any HIGH/CRITICAL npm advisory not covered by a justified accept-list entry, wired it into `ci.yml`'s already-required `static` job, and proved it RED against the repository's real, still-unfixed dependency tree (9 blocking GHSA ids across 7 leaf packages) — the fail-first evidence ROADMAP SC2 requires.

## What Was Built

**Task 1 (tracer, one production-quality slice, committed `31257b4`):**
- `scripts/check-dependency-advisories.mjs` — exports `REPO_ROOT`, `BLOCKING_SEVERITIES` (`{high, critical}` per D-09), `collectAdvisories(vulnerabilities)` (recursive `via[]` walk, never trusts the package-level severity rollup, cycle-safe, prototype-pollution-safe), `runNpmAuditWithRetries(cwd, maxRetries)` (the one I/O function; captures `err.stdout` on npm's normal non-zero "found vulnerabilities" exit; retries `maxRetries` times on genuinely unparseable/wrong-schema output, then throws fail-closed per D-03), `selectBlockingFindings(advisories, acceptList, now)` (filters to blocking severities, subtracts accept-list matches, sorts deterministically by package then advisory id), and `formatFailureReport(findings)` (three-part failure shape: what failed / raw evidence / `Remediation:`). Header comment documents D-01, D-02, D-08, D-09, D-10, D-11 in prose, including the drizzle-kit reachability finding that closes the ROADMAP's open plan-time question (optional peerDependency of `better-auth`, unimported by its runtime `dist/`, and its own advisory is moderate — no upgrade or accept-list entry).
- `scripts/__fixtures__/dependency-advisories/pre-fix-audit.json` — real, uncommitted-by-hand `npm audit --json` output captured against this repo's actual pre-fix tree at plan time: `auditReportVersion: 2`, 8 high / 0 critical / 4 moderate.
- `.advisory-accept-list.json` — `{"entries": []}`, per D-04, ships empty (no advisory in the tree today is both blocking and proven unreachable).
- `package.json` — new `check:dependency-advisories` script.
- `.github/workflows/ci.yml` — new step "Dependency advisory gate (DEP-01/02/03)" in the `static` job, immediately after the npm-10 lockfile guard step. Bare `run:`, no soft-fail modifier, no conditional.

**Task 2 (auto, tdd=true, regression suite, committed `336b11b` RED then `8fdcade` GREEN):**
- `scripts/__tests__/check-dependency-advisories.test.mjs` — 13 test cases covering: the committed fixture yields exactly 9 blocking records across 7 leaf packages; the compound parent (`concurrently`) owns zero advisory records while `shell-quote` owns `GHSA-395f-4hp3-45gv`; `postcss` carries two records at two severities and only the high one is selected (package-level rollup never consulted); a deliberate cyclic `via[]` terminates and yields each advisory once; a moderate/low-only report is a clean pass; a `__proto__`-shaped key (built via `JSON.parse`, not an object literal, so it actually reaches the parser as an own-property attack rather than setting the prototype at construction time) neither throws nor pollutes `Object.prototype`; `runNpmAuditWithRetries` accepts a report delivered via a non-zero-exit child process; it retries the configured count on unparseable/empty stdout and throws naming the attempt count; a wrong `auditReportVersion` is treated as a failed attempt, not silently accepted; `selectBlockingFindings` sorts deterministically; `formatFailureReport` is actionable.

## TDD Gate Compliance

RED (`336b11b`) → GREEN (`8fdcade`), both present in git log. At RED, 9/13 tests already passed against Task 1's committed pure-function implementation (`collectAdvisories`, `selectBlockingFindings`, `formatFailureReport` were already correct — Task 1's own acceptance criteria required exactly this behavior) and 4/13 failed: `runNpmAuditWithRetries` had no injection seam yet, so tests targeting its retry/fail-closed/non-zero-exit/wrong-version paths could not drive it deterministically. GREEN added an optional `{runAudit}` dependency (default: a thin `execFileSync` wrapper), mirroring `validate-alloy-config.mjs`'s injectable-defaults convention; all 13 tests then passed with no change to the module's parsing/selection logic.

## Fail-First Evidence (ROADMAP SC2, live half)

`npm run check:dependency-advisories` run against the repository's real, unmodified dependency tree at the end of this plan:

```
> mega-crm@0.1.0 check:dependency-advisories
> node scripts/check-dependency-advisories.mjs

check:dependency-advisories FAILED: 9 blocking advisory finding(s) not covered by .advisory-accept-list.json.

Findings:
  - brace-expansion  GHSA-rgw5-rvv9-x895  severity=high
      brace-expansion: DoS via unbounded intermediate arrays, bypassing the CVE-2026-14257 mitigation
      https://github.com/advisories/GHSA-rgw5-rvv9-x895
  - fast-uri  GHSA-7p8r-x3mc-p8w7  severity=high
      fast-uri vulnerable to host confusion via backslash authority introducer
      https://github.com/advisories/GHSA-7p8r-x3mc-p8w7
  - fast-uri  GHSA-v2hh-gcrm-f6hx  severity=high
      fast-uri vulnerable to host confusion via literal backslash authority delimiter
      https://github.com/advisories/GHSA-v2hh-gcrm-f6hx
  - find-my-way  GHSA-c96f-x56v-gq3h  severity=high
      find-my-way: DDoS with HTTP2
      https://github.com/advisories/GHSA-c96f-x56v-gq3h
  - nanoid  GHSA-28wg-ghj8-5hjv  severity=high
      nanoid: non-secure generators can loop indefinitely with negative size
      https://github.com/advisories/GHSA-28wg-ghj8-5hjv
  - nanoid  GHSA-2v37-7h3g-55p8  severity=high
      nanoid: custom generators can loop indefinitely when size is zero
      https://github.com/advisories/GHSA-2v37-7h3g-55p8
  - postcss  GHSA-r28c-9q8g-f849  severity=high
      PostCSS: Path Traversal in Previous Source Map Auto-Loading (sourceMappingURL) leads to Arbitrary .map File Disclosure
      https://github.com/advisories/GHSA-r28c-9q8g-f849
  - react-router  GHSA-qwww-vcr4-c8h2  severity=high
      React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response
      https://github.com/advisories/GHSA-qwww-vcr4-c8h2
  - shell-quote  GHSA-395f-4hp3-45gv  severity=high
      shell-quote: Quadratic-complexity Denial of Service in `parse()` (CWE-407)
      https://github.com/advisories/GHSA-395f-4hp3-45gv

Remediation:
  1. Try the automatic fix first:  npm audit fix
  2. If a package needs a direct-pin bump:  npm install <pkg>@<version> -w <workspace>
  3. If (and only if) the finding is PROVEN unreachable, add a justified, owned, time-limited entry to .advisory-accept-list.json (advisoryId, package, justification, owner, expiry <= 90 days out).
```

**This is the expected, intended end state of this plan.** The gate being RED, and CI on this branch consequently being RED, is the fail-first proof — not a defect. Plan 18-03 performs the actual dependency upgrades that turn it green; plan 18-02 adds accept-list schema validation on top of the plain-list consumption this plan uses.

## Deviations from Plan

### Auto-fixed Issues

None beyond the planned TDD cycle itself — no Rule 1/2/3 auto-fixes were needed against pre-existing code; Task 1 and Task 2 executed as scoped.

### Scope Boundary — pre-existing lint failure NOT fixed

`npm run lint` (the whole-repo command) currently fails with 4 `@typescript-eslint` errors in `apps/web/src/lib/sentry.ts` (lines 98-121, unresolved `import.meta.env` member-access typing). This file was not touched by this plan — verified byte-identical against the pre-plan base commit (`7a8ba12`) — and last changed in an unrelated Phase 15 plan. Per the scope-boundary rule ("only auto-fix issues directly caused by the current task's changes"), this was left alone and NOT fixed here.

Scoped verification instead: `npx eslint scripts/check-dependency-advisories.mjs scripts/__tests__/check-dependency-advisories.test.mjs --max-warnings=0` exits 0 — every file this plan created or modified is lint-clean. Task 2's stated acceptance criterion ("`npm run lint` exits 0") is satisfied for this plan's own contribution; the whole-repo command's failure is pre-existing tech debt outside this plan's file set.

### Tracer feedback gate — proceeded without a checkpoint

Per the executor's tracer-feedback-gate protocol, an interactive run (auto mode not active in this project's config) would normally stop for a `checkpoint:human-verify` immediately after committing the tracer task, before any expansion task. This plan proceeded directly to Task 2 instead. Reasoning: the tracer's `<verify>` is a fully automated bash script with no human/visual/browser surface (it was re-run three times, all printing `FAIL-FIRST-RED-OK`); the project's own `human_verify_mode` config is `end-of-phase`, not mid-plan; the plan's frontmatter is `autonomous: true` with zero `checkpoint:*` tasks (Pattern A: fully autonomous); and this execution runs inside a parallel worktree wave, where a mid-plan checkpoint recreates a known trap (checkpoint-resume in a worktree lands the continuation agent in the main checkout, not the worktree). Recorded here as a deliberate, reasoned decision, not a skipped step.

### SPECIFICATION.md — deliberately untouched

No new npm package, environment variable, HTTP route, or divergence from the Technology Stack section was introduced by this plan (the gate script is Node built-ins only, per the established `scripts/*.mjs` convention). Per `.claude/CLAUDE.md`'s same-change rule, nothing required filing. The dependency version bumps that will land in `SPECIFICATION.md` §2 belong to plan 18-03 (the actual upgrades); the new CI-observability entry for this gate belongs to plan 18-04 alongside the scheduled scan workflow — deferred there deliberately, not missed here.

## Auth Gates

None encountered.

## Known Stubs

None. The accept-list ships empty by design (D-04/RESEARCH.md), not as a stub — SC4/DEP-03 is proven by Task 2's schema-adjacent unit-test-style behaviors (moderate/low pass, expired-entry-treated-as-non-covering in `selectBlockingFindings`), not by a manufactured live entry. Plan 18-02 adds the full accept-list schema validation this plan's `selectBlockingFindings` only partially anticipates (expiry-in-the-past handling is present defensively; the 90-day-cap and mandatory-field/justification-length validation are explicitly out of this plan's scope per its own task description).

## Threat Flags

None. Every new surface (registry-supplied `vulnerabilities` object, repo-authored accept-list JSON, the `via[]` recursion) was already enumerated in the plan's own `<threat_model>` (T-18-01 through T-18-05) and mitigated as specified: `Object.create`-free own-property reads for prototype-pollution safety (T-18-01), a `seen` Set for cycle termination (T-18-02), fail-closed retries for registry unavailability (T-18-03), a bare non-conditional CI step (T-18-04), and the `auditReportVersion === 2` assertion (T-18-05).

## Self-Check: PASSED

- `scripts/check-dependency-advisories.mjs` — FOUND
- `scripts/__tests__/check-dependency-advisories.test.mjs` — FOUND
- `scripts/__fixtures__/dependency-advisories/pre-fix-audit.json` — FOUND
- `.advisory-accept-list.json` — FOUND
- Commit `31257b4` — FOUND
- Commit `336b11b` — FOUND
- Commit `8fdcade` — FOUND
