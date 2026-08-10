---
phase: 12-worker-reliability-tenant-fairness
fixed_at: 2026-08-10T23:40:00Z
review_path: .planning/phases/12-worker-reliability-tenant-fairness/12-REVIEW.md
iteration: 2
findings_in_scope: 2
fixed: 2
skipped: 0
status: all_fixed
---

# Phase 12: Code Review Fix Report

**Fixed at:** 2026-08-10T23:40:00Z
**Source review:** .planning/phases/12-worker-reliability-tenant-fairness/12-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 2 (both INFO-tier; REVIEW.md iteration 2 reported 0 critical/blocker and 0 warning findings -- all three iteration-1 warnings were confirmed fixed with no regressions)
- Fixed: 2
- Skipped: 0

**Note on commit tooling:** `gsd-tools commit` returns `{"committed": false, "skipped": true, "reason": "skipped_gitignored"}` in this repo for any invocation, because `commands.cjs`'s `cmdCommit` unconditionally checks `isGitIgnored(cwd, '.planning')` before staging -- true here since `.planning/` is in `.gitignore` (only specific files under it are force-tracked). This is a known pre-existing tool limitation (iteration 1's fix commits `e8cd936`/`bb299a4`/`66f8130` hit the same wall and used plain `git`). Both fixes below were committed with plain `git add` + `git commit` instead, matching iteration 1's message format and commit granularity.

## Fixed Issues

### IN-01: WR-02's regression coverage doesn't actually pin the redaction behavior it fixes

**Files modified:** `apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts`
**Commit:** `d3e8720`
**Applied fix:** Imported `scrubbedConsole` from `@mega-crm/redaction` and changed `startDeadLetterWatchdog`'s "test 10" to spy on `scrubbedConsole.error` directly instead of `console.error`, per the review's suggested fix. Verified this actually discriminates the two implementations by temporarily reverting the WR-02 fix in `dead-letter-watchdog.ts` (routing the interval-catch handler back through raw `console.error`) and re-running the test: it failed as expected (`Number of calls: 0` against the `scrubbedConsole.error` spy), confirming the strengthened assertion would catch a regression that the old `console.error`-spy version could not. Restored the source file and re-ran: full suite passes, 12/12.

### IN-02: `decodeURIComponent` in the WR-03 fix throws `URIError` for a password containing a literal, non-escape `%`

**Files modified:** `packages/queue-core/src/connection.ts`, `packages/queue-core/src/__tests__/queue-options.test.ts`
**Commit:** `8138c98`
**Applied fix:** Added a `decodeCredential(value, field)` helper in `connection.ts` that wraps `decodeURIComponent` in a try/catch and re-throws `Error("REDIS_URL {field} contains an invalid percent-encoding; ensure it was built with encodeURIComponent")` on `URIError`, exactly as the review's suggested fix specified. `buildRedisConnectionOptions` now calls `decodeCredential(url.username, "username")` / `decodeCredential(url.password, "password")` in place of the bare `decodeURIComponent` calls introduced by WR-03. Added a new regression test in `queue-options.test.ts` (next to the existing WR-03 `p%40ss` case) asserting that `buildRedisConnectionOptions("redis://user:p%zzss@host:6379")` throws with a message matching `/REDIS_URL password contains an invalid percent-encoding/`, so a future regression back to the bare `decodeURIComponent` call would be caught rather than only surfacing as a generic `URIError` at process boot. Verified with `vitest run` in `packages/queue-core`: 15/15 tests pass (14 pre-existing + 1 new). `tsc --noEmit` clean on the package.

## Skipped Issues

None -- both in-scope findings were fixed and verified.

---

_Fixed: 2026-08-10T23:40:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
