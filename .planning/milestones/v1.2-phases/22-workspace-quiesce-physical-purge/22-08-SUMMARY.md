---
phase: 22-workspace-quiesce-physical-purge
plan: 08
subsystem: api
tags: [watchdog, alerting, ops-alert-state, purge, dead-mans-switch, runbook]

# Dependency graph
requires:
  - phase: 22-workspace-quiesce-physical-purge (plan 22-01)
    provides: "purge_records table (migration 0068) with status/reported_at/first_destructive_batch_at/last_progress_at/purge_error, and the workspace-purge worker that heartbeats last_progress_at per batch"
provides:
  - "apps/api/src/modules/ops/purge-watchdog.ts — the tenth operator watchdog: evaluateWorkspacePurgeHealth, renderWorkspacePurgeAlertText, checkWorkspacePurgeHealthAndAlert, startWorkspacePurgeWatchdog"
  - "startWorkspacePurgeWatchdog registered in apps/api/src/server.ts alongside the other nine watchdogs"
  - "docs/runbooks/workspace-purge-stuck-alert.md — the operator runbook check:runbook-coverage requires"
affects: [22-06 (workspace-purge-report CLI, referenced by this runbook), 22-07 (auth-failure resume path, referenced by this runbook), 22-10 (SPECIFICATION.md, general purge-and-restore runbook)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-only dead-man's-switch watchdog over a platform table (purge_records), sharing the ops_alert_state claim primitive rather than a private singleton row"
    - "Release-on-healthy in addition to release-on-send-failure: a new variant of the claim/release discipline (an unconditional release, distinct from releaseOpsAlertSlot's guarded release) so a resolved incident re-arms the switch immediately"

key-files:
  created:
    - apps/api/src/modules/ops/purge-watchdog.ts
    - apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts
    - docs/runbooks/workspace-purge-stuck-alert.md
  modified:
    - apps/api/src/server.ts

key-decisions:
  - "The health predicate only ever examines purging/failed records — pending/reported/complete are unconditionally healthy regardless of any timestamp, since a purge sitting in reported for a whole tick is D-07's announce-then-act design working as intended."
  - "A healthy evaluation unconditionally releases any existing ops_alert_state claim for this alert name (new local helper, not the shared releaseOpsAlertSlot, whose guard only clears the exact value a matching claim just set) — this watchdog re-arms immediately on recovery rather than sitting inside a stale dedup window, unlike every sibling watchdog."
  - "Dropped this plan's own optional in-suite check:runbook-coverage duplicate test (explicitly authorized by the plan's own escape hatch) because importing the .mjs script from inside apps/api/src breaks `tsc -p tsconfig.json` (rootDir: \"src\", no allowJs) even though vitest itself resolves it fine; the shell-level `npm run check:runbook-coverage` step already covers the identical gate."

requirements-completed: [PRG-01, PRG-03]

coverage:
  - id: D1
    description: "A purge_records row stuck in purging past the threshold, or one recorded failed, raises exactly one deduplicated operator alert naming the workspace id, status, timestamps and error — never tenant PII or the workspace name."
    requirement: "PRG-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts#test 4/5/6/7/8/10"
        status: pass
    human_judgment: false
  - id: D2
    description: "A purge in the report-only window, or purging with recent progress despite an old first_destructive_batch_at, or with no purge_records at all, raises no alert."
    requirement: "PRG-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts#test 1/2/3"
        status: pass
    human_judgment: false
  - id: D3
    description: "A healthy evaluation releases any prior claim so a resolved incident re-arms the switch immediately rather than waiting out the dedup window."
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts#test 9"
        status: pass
    human_judgment: false
  - id: D4
    description: "The watchdog is registered at API boot alongside the other nine, and its runbook exists at the path check:runbook-coverage derives from the alert-name literal."
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts#test 11"
        status: pass
      - kind: other
        ref: "npm run check:runbook-coverage"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-08-23
status: complete
---

# Phase 22 Plan 08: Workspace Purge Stuck Alert Summary

**A read-only tenth operator watchdog (`purge-watchdog.ts`) that alerts once when a workspace physical purge stalls past 6 hours without progress or lands in `failed`, deduplicates via the shared `ops_alert_state` claim, self-clears on recovery, and ships its own required runbook.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-23T18:07:00Z (approx.)
- **Completed:** 2026-08-23T18:20:09Z
- **Tasks:** 2
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments
- `apps/api/src/modules/ops/purge-watchdog.ts`: `evaluateWorkspacePurgeHealth` (pure), `renderWorkspacePurgeAlertText`, `checkWorkspacePurgeHealthAndAlert`, `startWorkspacePurgeWatchdog`, mirroring `partition-watchdog.ts`'s shape and `failed-send-share-watchdog.ts`'s shared `claimOpsAlertSlot`/`ops_alert_state` claim.
- `WORKSPACE_PURGE_STUCK_ALERT_NAME = "workspace-purge-stuck"` derives exactly `docs/runbooks/workspace-purge-stuck-alert.md`, keeping `npm run check:runbook-coverage` green.
- 11 tests covering the full healthy/stuck/failed matrix, the atomic claim/dedup path, the new release-on-healthy behavior, PII-freedom, and boot registration — all passing, plus a comment-stripped-grep-verified read-only guarantee over `purge_records`.
- `startWorkspacePurgeWatchdog` registered in `apps/api/src/server.ts` as the tenth watchdog, with its own dispatch function and boot log line.
- `docs/runbooks/workspace-purge-stuck-alert.md` covering what fires it, how to confirm, what it means, remediation split by `purging`/`failed` (including the exact copy-pasteable `failed` recovery statement and its two required pre-checks), what not to do, and threshold tuning.

## Task Commits

Each task was committed atomically (TDD RED → GREEN per task):

1. **Task 1: Purge health evaluation and the deduplicated operator alert**
   - `4721905` (test) — RED: 10 failing tests against a nonexistent module
   - `045f6dc` (feat) — GREEN: `purge-watchdog.ts` implementation, all 10 tests pass
2. **Task 2: Register the watchdog and ship the runbook the coverage gate demands**
   - `23472a9` (test) — RED: added the server.ts-registration test (11 total, 1 failing)
   - `d553e66` (feat) — GREEN: server.ts registration + runbook, all 11 tests pass

**Plan metadata:** (this commit, docs(22-08): complete workspace-purge-stuck-alert plan)

## Files Created/Modified
- `apps/api/src/modules/ops/purge-watchdog.ts` - the watchdog module (health predicate, renderer, claim/release/send orchestration, interval starter)
- `apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts` - 11 tests: 6 pure evaluator cases, 4 fake-client effectful cases (claim, dedup, healthy-release, PII), 1 boot-registration assertion
- `apps/api/src/server.ts` - imports and registers `startWorkspacePurgeWatchdog` as the tenth watchdog, with its own `sendWorkspacePurgeAlert` dispatch and boot log line
- `docs/runbooks/workspace-purge-stuck-alert.md` - the required operator runbook

## Decisions Made
- **Narrow health predicate matching the worker's own state machine exactly**: only `purging` (stuck) and `failed` are ever unhealthy; `pending`/`reported`/`complete` are healthy unconditionally, regardless of any timestamp's age — a `reported` row waiting out its tick is D-07's design working, not a stall.
- **`WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS = 6`**, **`WORKSPACE_PURGE_ALERT_DEDUP_HOURS = 6`**, **`WORKSPACE_PURGE_WATCHDOG_INTERVAL_MS = 15min`** — flagged assumptions (no purge has run at production scale), matching the same order of magnitude as `dead-letter-watchdog.ts`/`failed-send-share-watchdog.ts`'s event-driven dedup windows, documented in both the module and the runbook's tuning section.
- **A new "unconditional release" helper**, distinct from the shared `releaseOpsAlertSlot` (whose guard only clears the exact value a matching claim call just set): on a healthy evaluation this watchdog clears any existing claim outright, so an operator-resolved incident re-arms the switch immediately instead of sitting inside a stale dedup window. This is new behavior relative to every sibling watchdog and is called out explicitly in the module's own doc comments.
- **Effectful tests use a purpose-built in-memory fake `ops_alert_state` client** (pattern-matched on the two known SQL shapes `claimOpsAlertSlot`/`releaseOpsAlertSlot`/the new unconditional release issue) rather than a live Postgres fixture, per this task's own instruction — keeps the plan migration-free and the test file dependency-free.
- **Dropped the plan's own optional in-suite `check:runbook-coverage` test** per its documented escape hatch: importing `scripts/check-runbook-coverage.mjs` from inside `apps/api/src` breaks `tsc -p tsconfig.json` (`rootDir: "src"`, no `allowJs`) with TS7016, even though `vitest` (esbuild-transformed) resolves and runs it fine. Verified this empirically (build failed, then passed after removing the import) before dropping it. The shell-level `npm run check:runbook-coverage` step in this task's own `<verify>` already covers the identical gate from the repository root, so the gate itself is not weakened.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] ESLint `require-await` errors in test spies and the fake client**
- **Found during:** Task 1, after writing the initial test file
- **Issue:** `npm run lint` failed with 5 `@typescript-eslint/require-await` errors — the fake client's `query` method and four `sendMail` test spies were declared `async` with no `await` inside, matching the interface's `Promise`-returning shape but tripping the lint rule.
- **Fix:** Added `// eslint-disable-next-line @typescript-eslint/require-await -- test spy: intentionally synchronous` comments, matching the exact convention already used in `failed-send-share-watchdog.test.ts` and `partition-watchdog.test.ts` for the identical pattern.
- **Files modified:** `apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts`
- **Verification:** `npx eslint` on the two new files exits 0 with no warnings.
- **Committed in:** `4721905` (Task 1's RED commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — lint), plus 1 plan-authorized test-case drop (documented above under Decisions, not a deviation from the plan's own instructions).
**Impact on plan:** No scope creep; the lint fix is a mechanical convention match, and the dropped test case was explicitly pre-authorized by the plan's own escape-hatch language with the coverage still fully asserted at the shell-verify level.

## Issues Encountered
- This worktree has no `node_modules`. Symlinked every top-level entry from the main checkout's `node_modules` (except `@mega-crm/*`) plus this worktree's own `packages/*` under `node_modules/@mega-crm/*`, ran tests/lint/build, then deleted the entire symlink tree and any `dist`/`.vite` cache artifacts before the final commit — `git status --short --ignored` shows no stray entries.
- `apps/api`'s full test suite (`npm run test -w apps/api`) has exactly one pre-existing, unrelated failure: `src/__tests__/sentry.test.ts`'s "with no DSN configured" case, which fails deterministically on this machine because `~/.config/mega-crm/.env` carries real Sentry DSNs (known machine-specific issue, documented separately, not caused by this plan's changes). All 657 other tests pass, including all nine pre-existing watchdogs' own suites (no regression).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The tenth operator watchdog is live and registered; a stuck or failed workspace purge is now observable in production the same way every other destructive/critical background process in this system is.
- `docs/runbooks/workspace-purge-stuck-alert.md` forward-references `docs/runbooks/workspace-purge-and-restore.md` (owned by plan 22-10, not yet merged) and `npm run db:workspace-purge-report` (plan 22-06, not yet merged in this wave) — both are plain prose references, not script-verified links, so they do not block this plan; they will resolve once those sibling-wave plans land.
- No blockers for phase completion from this plan's scope.

---
*Phase: 22-workspace-quiesce-physical-purge*
*Completed: 2026-08-23*

## Self-Check: PASSED

All created files verified present on disk (`purge-watchdog.ts`, `purge-watchdog.test.ts`, `workspace-purge-stuck-alert.md`, this SUMMARY.md). All four task commits (`4721905`, `045f6dc`, `23472a9`, `d553e66`) verified present in `git log --oneline --all`.
