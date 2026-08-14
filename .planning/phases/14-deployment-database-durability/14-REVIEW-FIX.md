---
phase: 14-deployment-database-durability
fixed_at: 2026-08-13T11:40:00Z
review_path: .planning/phases/14-deployment-database-durability/14-REVIEW.md
iteration: 1
findings_in_scope: 2
fixed: 2
skipped: 0
status: all_fixed
---

# Phase 14: Code Review Fix Report

**Fixed at:** 2026-08-13T11:40:00Z
**Source review:** .planning/phases/14-deployment-database-durability/14-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 2 (WR-01, WR-02; Critical: 0; IN-01 through IN-03 excluded, out of `critical_warning` scope)
- Fixed: 2
- Skipped: 0

This is a re-review fix cycle (re-review after an earlier full review + fix cycle already committed for this phase, covered by the prior version of this report, preserved in git history). All fixes were applied in an isolated git worktree (`gsd-reviewfix/14-12512`, branched from `gsd/phase-14-deployment-database-durability`), committed one finding per commit, then fast-forwarded onto the phase branch.

## Fixed Issues

### WR-01: `isDirectInvocation()` silently no-ops on any repo path containing a space or other URL-reserved character

**Files modified:** `scripts/check-lockfile-npm10.mjs`
**Commit:** `929e257`
**Applied fix:** Replaced the hand-built `` `file://${path.resolve(entry)}` `` comparison string with `pathToFileURL(path.resolve(entry)).href` (imported alongside the existing `fileURLToPath` from `node:url`), exactly as the reviewer's suggested fix specified. `pathToFileURL` produces the same percent-encoding Node applies to `import.meta.url`, so the CLI-entry-point guard now matches correctly on paths containing spaces or other URL-reserved characters instead of silently returning `false` and skipping `main()`.
**Verification:** Tier 1 (re-read, fix text present and intact) and Tier 2 (`node -c` syntax check passed; ran the existing `scripts/__tests__/check-lockfile-npm10.test.mjs` suite via `vitest run --root scripts __tests__/check-lockfile-npm10.test.mjs` against the fixed script — 11/11 tests pass, including Test 9's real no-override `npx npm@10` run against this repo's actual lockfile/Dockerfiles). No test regressions from the fix.

### WR-02: `check:lockfile-npm10`'s default invocation requires npm-registry network access, and it runs inside a required status check

**Files modified:** `.github/workflows/ci.yml`
**Commit:** `f075645`
**Applied fix:** Per the reviewer's option (a), added an explicit "Network note" to the `npm-10 lockfile guard` step's existing header comment in `ci.yml`, documenting that the default (no `--npm-command` override) invocation shells out to `npx --yes npm@10` and therefore needs registry/npx-cache access, and instructing a future on-call engineer to check registry/npx-cache health before suspecting the lockfile itself if this required `static` check goes red for an apparently unrelated reason. This is a documentation-only change — the review explicitly states "No change strictly required for correctness" and offers pre-warming the npm cache (option b) as a further-scope improvement, not required now.
**Verification:** Tier 1 (re-read confirms the comment block is intact, correctly indented, and the `run:` step itself is unchanged) and Tier 3 fallback (no YAML syntax checker was available in this environment — `js-yaml`/`PyYAML` not installed — so Tier 1 was accepted per the verification strategy's fallback rule; the edit is comment-only, on lines that do not affect YAML structure).

## Skipped Issues

None — both in-scope findings were fixed.

---

_Fixed: 2026-08-13T11:40:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
