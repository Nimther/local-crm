---
phase: 12-worker-reliability-tenant-fairness
plan: 10
subsystem: infra
tags: [bullmq, postgres, watchdog, dead-letter, observability, sendgrid]

# Dependency graph
requires:
  - phase: 12-worker-reliability-tenant-fairness (plans 07/08)
    provides: dead_letter_jobs/dead_letter_alert_state tables (migration 0054), the terminal-failure writer, and attachSharedErrorListeners wired on every worker
provides:
  - The third operator watchdog (dead-letter-watchdog.ts), reading dead_letter_jobs directly and alerting on unacknowledged terminal failures
  - Boot wiring in apps/api/src/server.ts's main() alongside the two existing watchdogs
  - An end-to-end test proving the whole dead-letter path (writer -> table -> watchdog -> alert)
  - packages/queue-core/src/dead-letter-writer.ts -- the dead-letter writer's core logic, relocated from apps/worker so both apps can import it directly
affects: [phase-15-observability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Third operator watchdog sharing the claim-then-send-then-release-on-failure shape with partition-watchdog.ts/send-reconciler-watchdog.ts, but reading the live table directly instead of a per-tick health row"
    - "Cross-app shared logic moves into packages/queue-core (apps depend on packages, packages never depend on apps) rather than a direct apps/api -> apps/worker relative import, which tsc's per-app rootDir forbids"

key-files:
  created:
    - apps/api/src/modules/ops/dead-letter-watchdog.ts
    - apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts
    - packages/queue-core/src/dead-letter-writer.ts
  modified:
    - apps/api/src/server.ts
    - apps/worker/src/queues/dead-letter/dead-letter-writer.ts
    - packages/queue-core/src/index.ts
    - SPECIFICATION.md

key-decisions:
  - "DEAD_LETTER_WATCHDOG_INTERVAL_MS = 5min, DEAD_LETTER_ALERT_DEDUP_HOURS = 6h (matches the reconciler watchdog's event-driven window, not the partition watchdog's daily one)"
  - "readDeadLetterHealth reads dead_letter_jobs directly (count/distinct queue names/oldest failed_at in one query) -- there is no per-tick worker-written health row for this watchdog, unlike its two siblings"
  - "claimDeadLetterAlertSlot's single UPDATE also writes last_seen_failed_at (migration 0054's own stated intent for that column) as an extra SET column outside the dedup WHERE predicate and outside the release-on-failure statement"
  - "Deviation (Rule 3, blocking): relocated isTerminalJobFailure/writeDeadLetterOnTerminalFailure from apps/worker into packages/queue-core so apps/api's watchdog test can call the real writer for its end-to-end case without violating apps/api/tsconfig.json's rootDir (TS6059, proven empirically)"

requirements-completed: [WRK-10]

coverage:
  - id: D1
    description: "Dead-letter watchdog alerts an operator exactly once per dedup window when unacknowledged dead-letter rows exist, naming affected queues/count/oldest failure"
    requirement: "WRK-10"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts#test 5, test 6"
        status: pass
    human_judgment: false
  - id: D2
    description: "Alert slot claimed before send, released on send failure so a failed delivery does not consume the dedup window"
    requirement: "WRK-10"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts#test 9"
        status: pass
    human_judgment: false
  - id: D3
    description: "No unacknowledged rows -> no mail; acknowledged rows excluded from count and decision"
    requirement: "WRK-10"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts#test 3, test 4"
        status: pass
    human_judgment: false
  - id: D4
    description: "Whole dead-letter path (writer -> durable row -> watchdog -> alert) proven end to end"
    requirement: "WRK-10"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts#test 10 (12-10 task 2, T-12-10-03)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Watchdog runs from apps/api boot beside the two existing watchdogs, dedups independently, alerts through the platform key"
    requirement: "WRK-10"
    verification:
      - kind: unit
        ref: "apps/api/src/server.ts (startDeadLetterWatchdog call site) + npx tsc -p apps/api/tsconfig.json --noEmit"
        status: pass
    human_judgment: false

duration: ~30min
completed: 2026-08-10
status: complete
---

# Phase 12 Plan 10: Dead-Letter Watchdog Summary

**Third operator watchdog over `dead_letter_jobs`, closing the dead-letter observability loop end to end, plus a Rule-3 relocation of the shared writer into `@mega-crm/queue-core` to keep the cross-app test path legal under `tsc`.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-08-10T21:33Z (approx, first task commit)
- **Completed:** 2026-08-10T21:46Z
- **Tasks:** 2 (both `type="auto"`, Task 1 `tdd="true"`)
- **Files modified:** 7 (3 created, 4 modified)

## Accomplishments

- `apps/api/src/modules/ops/dead-letter-watchdog.ts`: the third operator watchdog, mirroring `partition-watchdog.ts`/`send-reconciler-watchdog.ts`'s claim-then-send-then-release-on-failure shape, but reading `dead_letter_jobs` directly (no per-tick health row exists for this one) via `readDeadLetterHealth` — count/distinct queue names/oldest `failed_at` in a single query, excluding acknowledged rows.
- `checkDeadLetterHealthAndAlert` sends at most one plain-text alert per `DEAD_LETTER_ALERT_DEDUP_HOURS=6` window; `claimDeadLetterAlertSlot` is a single atomic `UPDATE ... RETURNING` (never a read-then-write), and a rejected `sendMail` releases the claim so the very next check can retry.
- `startDeadLetterWatchdog` wired into `apps/api/src/server.ts`'s `main()` immediately beside the two existing watchdog starts — third independent dead-man's switch, own dedup state, own alert subject line.
- One end-to-end test (`test 10`) drives a real terminal job failure through the shared writer, then runs the watchdog check and asserts the alert names that row's queue — the case that fails if either half of the dead-letter path (durable record vs. reader) is disconnected.
- SPECIFICATION.md updated: new §6.13, a new §7 paragraph for the watchdog's own health signal/push channel, and the §4.2/§2.1 entries for `dead_letter_jobs`/`dead_letter_alert_state`/`queue-core` updated to point at the writer's new location.

## Task Commits

Each task was committed atomically (Task 1 followed the TDD RED/GREEN cycle):

1. **Task 1 RED: failing test for dead-letter watchdog** - `f9140f2` (test)
2. **Task 1 GREEN: implement dead-letter watchdog** - `b691a94` (feat)
3. **Deviation: relocate dead-letter writer into @mega-crm/queue-core** - `e0dfcb7` (refactor)
4. **Task 2: boot wiring and end-to-end observability check** - `4e5ddc3` (feat)

**Plan metadata:** (this commit) `docs: complete plan`

## Files Created/Modified

- `apps/api/src/modules/ops/dead-letter-watchdog.ts` - The third operator watchdog: `readDeadLetterHealth`, `renderDeadLetterAlertText`, `claimDeadLetterAlertSlot`, `checkDeadLetterHealthAndAlert`, `startDeadLetterWatchdog`, and the `DEAD_LETTER_WATCHDOG_INTERVAL_MS`/`DEAD_LETTER_ALERT_DEDUP_HOURS` constants
- `apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts` - 11 tests: pure render tests, DB-backed health/claim/dedup/release/concurrent-replica tests, one end-to-end case, and a `startDeadLetterWatchdog` interval/log-catch test
- `packages/queue-core/src/dead-letter-writer.ts` - Relocated `isTerminalJobFailure`/`writeDeadLetterOnTerminalFailure` core logic (deviation, see below)
- `packages/queue-core/src/index.ts` - Re-exports the new module
- `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` - Now a thin shim: keeps its dedicated `pg.Pool` + idle-error listener, delegates to the shared function
- `apps/api/src/server.ts` - `startDeadLetterWatchdog` wired into `main()`, third `sendMail` wrapper (`sendDeadLetterOperatorAlert`), startup log line
- `SPECIFICATION.md` - §6.13 (new background process), §7 (health signal/push channel paragraph + writer-location note), §4.2 (`dead_letter_jobs`/`dead_letter_alert_state` entries), §2.1 (`queue-core` row)

## Decisions Made

- `DEAD_LETTER_WATCHDOG_INTERVAL_MS = 5 * 60_000` — a terminal failure can land at any moment (unlike the daily partition job or the reconciler's ~5min tick), and the check is one indexed count query, so frequent polling is cheap.
- `DEAD_LETTER_ALERT_DEDUP_HOURS = 6` — matches the reconciler watchdog's event-driven window rather than the partition watchdog's daily one.
- `claimDeadLetterAlertSlot` takes an optional 4th `newestFailedAt` parameter and writes it to `last_seen_failed_at` in the same single statement, honoring migration 0054's own stated column intent ("newest failure it had seen at that time") without adding a second write or touching the dedup `WHERE` predicate.
- Deviation (Rule 3, blocking, see below): relocated the dead-letter writer's core logic into `@mega-crm/queue-core`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Relocated `isTerminalJobFailure`/`writeDeadLetterOnTerminalFailure` from `apps/worker` into `@mega-crm/queue-core`**
- **Found during:** Task 2 (boot wiring and end-to-end observability check)
- **Issue:** The plan's Task 2 explicitly requires an end-to-end test in `apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts` that "drives a terminal job failure through the writer" (`apps/worker/src/queues/dead-letter/dead-letter-writer.ts`). A direct relative import from `apps/api/src` into `apps/worker/src` was empirically confirmed to fail `tsc` with `TS6059` ("File ... is not under 'rootDir' '.../apps/api/src'") because `apps/api/tsconfig.json` sets `rootDir: "src"` — this would have broken the plan's own acceptance criterion `npx tsc -p apps/api/tsconfig.json --noEmit exits 0`. Additionally, `apps/api`'s vitest config never opens a real Redis/BullMQ connection in any test, so driving the failure through an actual BullMQ retry cycle was never an option either — the only way to satisfy "through the writer, not a direct insert" is to call the writer function directly with a fake `Job`, exactly as `apps/worker`'s own existing writer test already does.
- **Fix:** Moved the gate (`isTerminalJobFailure`) and the redacting insert (`writeDeadLetterOnTerminalFailure`) into `packages/queue-core/src/dead-letter-writer.ts` — a package both `apps/worker` and `apps/api` already depend on, and which already hosts this writer's composition partner (`error-listeners.ts`'s `attachSharedErrorListeners`). The relocated function takes its DB client as a required structural parameter (no module-level `Pool`), keeping `packages/queue-core` free of a live connection at import time. `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` became a thin shim that keeps its own dedicated `pg.Pool` + idle-error listener and delegates to the shared function — no import site in `apps/worker` (including its own pre-existing test) needed to change.
- **Files modified:** `packages/queue-core/src/dead-letter-writer.ts` (new), `packages/queue-core/src/index.ts`, `apps/worker/src/queues/dead-letter/dead-letter-writer.ts`, `SPECIFICATION.md`
- **Verification:** `npx tsc -p apps/api/tsconfig.json --noEmit` and `npx tsc -p apps/worker/tsconfig.json --noEmit` both exit 0; all 6 pre-existing `apps/worker` writer tests still pass unchanged; all 15 `packages/queue-core` tests pass; the new end-to-end case in `apps/api` passes calling the relocated function directly.
- **Committed in:** `e0dfcb7` (its own `refactor(12-10):` commit, before Task 2's `feat` commit, per advisor guidance)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to satisfy the plan's own stated acceptance criteria (the tsc gate) while still literally driving the dead-letter path through the real writer, as the plan's Task 2 action text requires. No scope creep beyond the minimal file relocation; no behavior change to either app.

## Issues Encountered

- The worktree had no `node_modules` at session start; ran `npm install --prefer-offline` before any test run, per the standing worktree instructions. No lockfile churn resulted.
- One `apps/api` full-suite run showed 2 failing assertions in `webhooks-signature.test.ts` (exact `waiting` job-count mismatches on a shared real Redis queue). Confirmed pre-existing and unrelated: the file passes 7/7 in isolation, and a second full-suite run passed 396/396 with no code changes in between — a test-isolation flake from parallel test files sharing one Redis queue, not caused by this plan's changes (which touch `apps/api/src/modules/ops`, `apps/api/src/server.ts`, `apps/worker/src/queues/dead-letter`, and `packages/queue-core` only).
- `npm run lint` (repo-wide, `--max-warnings=0`) reported 11 pre-existing `@typescript-eslint/require-await` errors in `apps/worker/src/__tests__/graceful-shutdown.test.ts` and `apps/worker/src/queues/__tests__/shared-error-listener.test.ts`, both from plan 12-08 (confirmed via `git log`), unrelated to any file this plan touches. Linting only the files this plan created/modified (`dead-letter-watchdog.ts` + test, `server.ts`, both `dead-letter-writer.ts`, `queue-core/src/index.ts`) is clean. Recorded to `.planning/WINDOWS.md` (kind: `lint-warning`) rather than fixed, per the Scope Boundary rule.

## Known Stubs

None.

## Threat Flags

None beyond what the plan's own `<threat_model>` already covers (T-12-10-01..04, all addressed by the implementation and its tests).

## User Setup Required

None - no external service configuration required. `OPERATOR_ALERT_EMAIL` and the platform mail credentials were already boot-required by the two pre-existing watchdogs; this plan's precondition (no new operational prerequisite) held.

## Next Phase Readiness

- WRK-10/D-08 closed: the dead-letter path is now observable end to end, matching the partition/reconciler watchdog precedent.
- Phase 15 (observability) is expected to replace all three plain-text watchdog channels with real alerting/dashboards — no additional work required from this plan to enable that.
- Flag for the orchestrator: `packages/queue-core/src/index.ts` and `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` were modified by this plan. Plan `12-09` (same phase, wave 7, `files_modified: packages/queue-core/src/queue-options.ts` and others) does not touch the same files, but both plans land in `packages/queue-core` — worth a quick diff check at merge time even though no line-level overlap is expected.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-10*
