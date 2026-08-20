---
phase: 11-delivery-correctness
plan: 09
subsystem: delivery
tags: [reconciler, watchdog, dead-mans-switch, postgres, cross-process, vitest, sendgrid]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (plan 11-02)
    provides: "send_reconciler_runs table (migration 0050) and its Drizzle schema shape -- this plan writes into it, does not create it"
  - phase: 11-delivery-correctness (plan 11-08)
    provides: "runReconcilerTick's per-verdict counts ({ scanned, resolvedSent, markedUnknown, swept }) -- this plan's health-row snapshot is a direct consumer of exactly that shape"
  - phase: 9 (partition maintenance dead-man's-switch)
    provides: "partition-watchdog.ts / maintenance-run.ts's two-process pattern -- this plan's watchdog and health-row helpers are deliberate siblings, not a new invention"
provides:
  - "packages/db/src/reconciler/reconciler-run.ts -- recordReconcilerRun/readLatestReconcilerRun, the worker-writer half of the reconciler's dead-man's-switch"
  - "apps/api/src/modules/ops/send-reconciler-watchdog.ts -- evaluateReconcilerHealth/renderReconcilerAlertText/claimReconcilerAlertSlot/checkReconcilerHealthAndAlert/startSendReconcilerWatchdog, the API-process reader half"
  - "send-reconciler.worker.ts writes send_reconciler_runs on every completed tick, including oldest_reconciling_since computed inside the same withCrossWorkspaceScan call as discovery"
  - "apps/api/src/server.ts's main() arms a second, independent dead-man's-switch alongside the pre-existing partition watchdog"
affects: [11-10, 11-11, phase-15 (OPS-13 re-plumbs oldest_reconciling_since into real alerting)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-process dead-man's-switch #2 in this codebase: worker writes a singleton health row on its own clock, a DIFFERENT process (apps/api) reads it on an independent poll interval -- exact structural sibling of Phase 9's partition-maintenance/partition-watchdog pair, not a new mechanism"
    - "Health-row write placed AFTER the tick's own work completes, with no try/catch around either the candidate loop or the write -- an unhandled throw anywhere upstream skips the write entirely, so a failed run never reports itself alive"
    - "Cross-workspace aggregate (MIN(reconciling_since)) folded into the SAME withCrossWorkspaceScan call the discovery query already runs, avoiding a second scan-role round trip per tick"
    - "Cross-module vi.spyOn (spying on a dependency import shared between the test file and the module under test) as the reliable Vitest ESM mocking pattern for forcing a mid-tick failure -- same-module self-spy on an internal call is not reliable and was deliberately avoided"

key-files:
  created:
    - packages/db/src/reconciler/reconciler-run.ts
    - packages/db/src/__tests__/reconciler-run.test.ts
    - apps/api/src/modules/ops/send-reconciler-watchdog.ts
    - apps/api/src/modules/ops/__tests__/send-reconciler-watchdog.test.ts
    - apps/worker/src/queues/__tests__/send-reconciler-health.test.ts
  modified:
    - apps/worker/src/queues/send-reconciler.worker.ts
    - apps/api/src/server.ts
    - apps/worker/package.json
    - SPECIFICATION.md

key-decisions:
  - "recordReconcilerRun/readLatestReconcilerRun mirror packages/db/src/partitions/maintenance-run.ts structurally, including its own file-header two-process framing, and are NOT re-exported from packages/db/src/index.ts's barrel -- the barrel already exports only the schema shape (send-reconciler-runs.ts, landed in 11-02); the functional module is consumed via the same direct subpath-import convention the partitions modules already established (@mega-crm/db/src/reconciler/reconciler-run.js)."
  - "The worker's health-row write reuses the ALREADY-imported shared @mega-crm/tenant-context pool, unscoped (no withTenant) -- send_reconciler_runs carries no workspace_id/RLS, so this is not a new dedicated Pool the file's own header comment warns against, just the plain form of the pool the file already holds for every tenant-scoped write."
  - "oldest_reconciling_since is captured at DISCOVERY time (before the tick resolves anything), not re-queried after resolution -- this is the literal reading of D-14's own \"oldest outstanding ... it observed\" phrasing, and it is what makes the reconciling_backlog_aged end-to-end test correct: a row aged past RECONCILING_AGE_ALERT_HOURS (30h) is ALSO past the 24h resolution window, so it resolves to 'unknown' during the SAME tick that discovers it, and only the discovery-time snapshot still reflects the age that should trip the alert."
  - "RECONCILER_ALERT_DEDUP_HOURS is 6h, deliberately shorter than partition-watchdog.ts's 20h -- that value tracks a once-daily job's cadence; copying it here would leave a stopped reconciler (whose own cadence is ~5min) nearly silent for a day."
  - "apps/worker/src/queues/__tests__/send-reconciler-health.test.ts's final test imports evaluateReconcilerHealth from @mega-crm/api directly (added as a test-only devDependency in apps/worker/package.json) rather than re-implementing the evaluator -- this is what makes it a genuine two-process proof (worker writes, a DIFFERENT package's own evaluator reads) instead of two independently-passing halves."
  - "send_reconciler_runs carries FORCE ROW LEVEL SECURITY via the sends table it reads from during discovery -- but the health table itself has no RLS at all (by design, 11-02). The actual constraint that shaped this plan's tests: sends itself is fail-closed RLS, so no cross-tenant DELETE against it is legal from any role this codebase grants (app-role or scan-role). Every test fixture is therefore either resolved to a non-'reconciling' terminal status by the SAME tick that discovers it, or explicitly deleted via a tenant-scoped withTenant/withTenantTransaction DELETE -- never a blanket cross-tenant query."

requirements-completed: [DLV-03]

coverage:
  - id: D1
    description: "Every reconciler tick writes a health row recording when it ran, how many candidates it scanned, how many rows it resolved, and the oldest outstanding reconciling_since it observed"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-health.test.ts (7 cases, every behavior item)"
        status: pass
      - kind: unit
        ref: "packages/db/src/__tests__/reconciler-run.test.ts (7 cases, read/write helper contract)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A watchdog in the API process reads the health row on its own independent clock and sends a plain-text operator email when ticks have stopped or when reconciling rows have aged past threshold"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/send-reconciler-watchdog.test.ts (11 cases, full unhealthy-condition matrix + claim/dedup/release-on-failure)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-health.test.ts#test 7 (end-to-end, two-process proof)"
        status: pass
      - kind: other
        ref: "grep -n \"startSendReconcilerWatchdog\" apps/api/src/server.ts shows the call inside main(), not buildServer(); npx vitest run --root apps/api src/__tests__ passes (no stray interval in any integration test)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A missing health row evaluates UNHEALTHY, never healthy; the alert body carries no tenant data, workspace id, contact id, email address, send id, or SendGrid key fragment; concurrent API replicas cannot both send the same alert"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/ops/__tests__/send-reconciler-watchdog.test.ts#test 1 (missing_health_row), #test 7 (mechanical UUID/email/Bearer regex assertions), #test 10 (two concurrent replicas, exactly one send)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The reconciler still makes zero provider calls, writes no resolve_failed/-> failed transition, and the API process gains no SCAN_DATABASE_URL or cross-workspace-scan entry point"
    requirement: "DLV-03"
    verification:
      - kind: other
        ref: "apps/api/src/__tests__/env-schema.test.ts (P3 negative source test, unmodified, still passes); apps/api/src/modules/ops/send-reconciler-watchdog.ts imports nothing from ../../env.js or any tenancy/KMS module (verified by grep during execution)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts (unmodified, still 11/11 passing) -- zero-provider-call and no-resolve_failed invariants unchanged by this plan"
        status: pass
    human_judgment: false

# Metrics
duration: ~75min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 09: Reconciler Dead-Man's-Switch (Health Row + Watchdog) Summary

**A `send_reconciler_runs` health row written on every completed tick, and a parameter-driven `apps/api` watchdog on an independent 15-minute clock that alerts on both a stopped reconciler and a reconciler that ticks but stops resolving -- the exact two-process pattern Phase 9 built for partition maintenance, reused rather than reinvented.**

## Performance

- **Duration:** ~75 min
- **Completed:** 2026-08-09
- **Tasks:** 3
- **Files modified:** 9 (5 created, 4 modified)

## Accomplishments

- **Task 1 -- health-row read/write helpers:** `packages/db/src/reconciler/reconciler-run.ts` exports `recordReconcilerRun`/`readLatestReconcilerRun`, structurally mirroring `packages/db/src/partitions/maintenance-run.ts` (same `{ query }`-shaped structural client type, same UPSERT-onto-`id=1` shape, same deliberate exclusion of `last_alert_sent_at` from the writer's own SQL). 7 tests in `reconciler-run.test.ts` cover every `<behavior>` item against a live migrated ephemeral database, including the "survives a write" and "null stored as null" cases.
- **Task 2 -- the watchdog module:** `apps/api/src/modules/ops/send-reconciler-watchdog.ts` is a deliberate sibling of `partition-watchdog.ts`: `evaluateReconcilerHealth` defaults to unhealthy on a missing row (never healthy on missing data, checked first), detects a stopped reconciler (`stale_last_run`, 30-minute/six-tick threshold) and a reconciler that ticks but stops resolving (`reconciling_backlog_aged`, a 30-hour threshold deliberately distinct from the 24-hour resolution window it sits above). `claimReconcilerAlertSlot` is a single conditional `UPDATE ... RETURNING` (6-hour dedup, shorter than partition-watchdog's 20h since this reconciler's own cadence is ~5min, not once-daily) that releases on a rejected send so the next check can retry. The module reads no env module and imports nothing from tenancy/KMS -- every dependency is injected. 11 tests cover the full unhealthy-condition matrix, the redaction mechanics (no UUID/email pattern, no `Bearer`), the cross-replica claim, and the release-on-send-failure path.
- **Task 3 -- wiring both ends:** `send-reconciler.worker.ts`'s `runReconcilerTick` now writes the health row after its candidate loop completes (no try/catch anywhere above it -- a throw skips the write entirely), using the plain shared `@mega-crm/tenant-context` pool already imported for tenant-scoped writes (no new dedicated `Pool`). `oldest_reconciling_since` is computed inside the SAME `withCrossWorkspaceScan` call the discovery query already runs, avoiding a second scan-role round trip, and is observed at discovery time -- before this tick resolves anything -- per D-14's own "oldest outstanding ... it observed" phrasing. `apps/api/src/server.ts`'s `main()` arms `startSendReconcilerWatchdog` immediately after the existing partition watchdog, strictly inside `main()`, never `buildServer()`. 7 tests in `send-reconciler-health.test.ts` prove every `<behavior>` item against live Postgres, including a throwing-tick test (via cross-module `vi.spyOn` on `@mega-crm/tenant-context`'s `withCrossWorkspaceScan`, the reliable Vitest ESM mocking pattern) and an end-to-end test that imports `evaluateReconcilerHealth` from `@mega-crm/api` directly to prove the worker-writes/API-reads signal actually round-trips.
- `SPECIFICATION.md` updated in the same change: §4.2 (the table's writer now exists), §5.10 (the health-row write step), a new §6.12 (the second `apps/api` background timer), and §7 (the reconciler watchdog's own observability entry, including the D-14 interim-channel note that Phase 15's OPS-13 re-plumbs the same signal).

## Task Commits

1. **Task 1: Reconciler health-row read and write helpers** - `bae7dde` (feat)
2. **Task 2: Parameter-driven reconciler watchdog with cross-replica alert claiming** - `e530e43` (feat)
3. **Task 3: Worker writes the health row; API boot arms the watchdog** - `8e73429` (feat, includes SPECIFICATION.md updates)

**Plan metadata:** (this commit) — docs: complete plan

## Files Created/Modified

- `packages/db/src/reconciler/reconciler-run.ts` - `recordReconcilerRun`/`readLatestReconcilerRun`, `ReconcilerRunRow`/`ReconcilerRunSnapshot`/`ReconcilerRunClient`
- `packages/db/src/__tests__/reconciler-run.test.ts` - 7 tests covering every Task 1 `<behavior>` item
- `apps/api/src/modules/ops/send-reconciler-watchdog.ts` - `evaluateReconcilerHealth`, `renderReconcilerAlertText`, `claimReconcilerAlertSlot`, `checkReconcilerHealthAndAlert`, `startSendReconcilerWatchdog`, the four versioned constants
- `apps/api/src/modules/ops/__tests__/send-reconciler-watchdog.test.ts` - 11 tests covering every Task 2 `<behavior>` item
- `apps/worker/src/queues/send-reconciler.worker.ts` - `discoverReconcilableCandidatesWithOldestReconciling` (internal), `findReconcilableCandidates` delegates to it, `runReconcilerTick` writes the health row
- `apps/worker/src/queues/__tests__/send-reconciler-health.test.ts` - new, 7 tests covering every Task 3 `<behavior>` item
- `apps/api/src/server.ts` - `startSendReconcilerWatchdog` armed in `main()`, `sendReconcilerOperatorAlert` dispatch function
- `apps/worker/package.json` - `@mega-crm/api` added as a test-only devDependency
- `SPECIFICATION.md` - §4.2/§5.10/§6.12 (new)/§7 updated

## Decisions Made

See `key-decisions` in frontmatter. In short: the health-row helpers mirror `maintenance-run.ts` structurally and are consumed via direct subpath import, not the barrel (matching the partitions modules' own precedent); the worker's write reuses the already-imported shared pool unscoped rather than adding a dedicated `Pool`; `oldest_reconciling_since` is a discovery-time snapshot, not a post-resolution re-query; the reconciler's own dedup window is deliberately shorter than partition-watchdog's; the health test's final case imports the API's evaluator directly (a test-only cross-app devDependency) to make it a genuine two-process proof; and every test fixture that would otherwise leave a `reconciling` row lying around is either resolved by the same tick or explicitly deleted tenant-scoped, since `sends`' fail-closed RLS makes a cross-tenant DELETE illegal from any role this codebase grants.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - blocking issue] Cross-tenant DELETE against `sends` is illegal under Phase 10's fail-closed RLS -- test design fix, not a production code change**
- **Found during:** Task 3, writing `send-reconciler-health.test.ts`
- **Issue:** An early draft of the health test used a plain-pool `DELETE FROM sends WHERE status = 'reconciling'` between tests to force a clean "zero reconciling rows" state. This throws `error: unrecognized configuration parameter "app.current_workspace_id"` -- `sends` carries FORCE ROW LEVEL SECURITY, and no role this codebase grants (app-role or `mega_crm_scan`, which holds SELECT-only per migration 0042) can perform a cross-tenant write against it. This is the exact fail-closed design Phase 10 intentionally built, not a bug to work around.
- **Fix:** Redesigned every test fixture to leave zero `reconciling` rows behind either naturally (evidence-backed rows resolve to `sent` in the same tick; rows aged past `RECONCILING_AGE_ALERT_HOURS` are also past the 24h resolution window and resolve to `unknown` in the same tick) or via an explicit tenant-scoped `withTenant`/`withTenantTransaction` DELETE (legal, since it operates within one known workspace). Also hardened the "oldest_reconciling_since is null when none exist" assertion to compare against a live ground-truth `MIN(reconciling_since)` query (via `withCrossWorkspaceScan`, the same mechanism production uses) rather than a hardcoded `null` literal -- this is both more correct (verifies the invariant, not a specific global state) and immune to the file-order flakiness that surfaced when this suite ran alongside `send-reconciler-verdicts.test.ts`/`send-reconciler-tracer.test.ts` in one `vitest run` invocation (all three files share one ephemeral database for that invocation; each file remains internally consistent when run per the plan's own standalone `<verify>` command).
- **Files modified:** `apps/worker/src/queues/__tests__/send-reconciler-health.test.ts` (test-only; no production code affected)
- **Verification:** `npx vitest run --root apps/worker src/queues/__tests__/send-reconciler-health.test.ts` passes reliably across 8+ repeated runs (standalone); the 3-file combination (`send-reconciler-health.test.ts` + `send-reconciler-verdicts.test.ts` + `send-reconciler-tracer.test.ts`) also passes reliably across 5+ repeated runs after the ground-truth-comparison fix; full `apps/worker` suite (43 files, 234 tests) passes.
- **Committed in:** `8e73429` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (a test-design correction forced by a genuine, intentional RLS constraint from Phase 10 -- no production code was affected, and no security property was weakened or worked around).
**Impact on plan:** None beyond the named test file -- the fix strengthened the test (it now verifies a real invariant against live ground truth rather than assuming a specific global database state) without changing what behavior is being proven.

## Issues Encountered

- Same-module self-referential `vi.spyOn` (spying on `findReconcilableCandidates`, exported from the same file that internally calls a *different*, non-exported discovery function) does not reliably intercept an internal call path in this codebase's Vitest/ESM setup. Resolved before any commit by switching to cross-module spying: `vi.spyOn` on `withCrossWorkspaceScan`, imported from `@mega-crm/tenant-context` by both the test file and `send-reconciler.worker.ts` -- the reliable pattern, since both files hold the same live binding to the same module instance.
- An initial 3-file combined run surfaced order-dependent flakiness (one file's genuinely-existing `reconciling` row, still mid-lifecycle in a sibling test, was observed by this file's own "zero reconciling rows" assertion) -- not a defect in the plan or the production code, but a reminder that this project's shared-ephemeral-database convention (one database per `vitest run` invocation, not per file) makes any assertion of a literal global-empty-state fragile outside a single-file run. Resolved by asserting against live ground truth instead of a hardcoded expectation (see Deviations above).

## Known Stubs

None.

## Threat Flags

None -- every new surface this plan introduces (the health-row write path, the watchdog's read/evaluate/alert/claim path, the second `apps/api` background timer) is already covered by this plan's own `<threat_model>` (T-11-09-01 through T-11-09-06), and this plan's tests exercise each one directly:
- T-11-09-01 (missing/unreadable health row defaulting to healthy) -- mitigated, proven by `evaluateReconcilerHealth(null, ...)` tests in both the watchdog suite and (implicitly, via the seeded singleton row) the reconciler-run suite.
- T-11-09-02 (tenant data in the alert body) -- mitigated, proven by the mechanical UUID/email/`Bearer` regex assertions; the module also imports no tenancy/KMS module (verified by inspection during execution).
- T-11-09-03 (alert storm across replicas) -- mitigated, proven by the two-concurrent-replicas test and the release-on-send-failure test.
- T-11-09-04 (a failed tick reporting itself alive) -- mitigated, proven by the throwing-tick test (cross-module spy) asserting `last_run_at` is unchanged.
- T-11-09-05 (a tick resetting the alert dedup window) -- mitigated; `recordReconcilerRun`'s SQL never references `last_alert_sent_at` (asserted both by a direct source-string test and a survives-a-write test).
- T-11-09-06 (watchdog interval running inside a test process) -- mitigated; `startSendReconcilerWatchdog` is called only in `apps/api/src/server.ts`'s `main()`, never `buildServer()`, and the full `apps/api/src/__tests__` integration suite (53 tests) passes with no stray interval.

## User Setup Required

None -- no new environment variables introduced. `OPERATOR_ALERT_EMAIL` and `PLATFORM_SENDGRID_API_KEY` were already required at API boot (Phase 9); this plan adds a second consumer of both, not a new configuration requirement.

## Next Phase Readiness

- The reconciler now has a complete dead-man's-switch: a health row written on every tick (this plan) sitting on top of the full verdict-classification machinery (11-08) sitting on top of the state-machine authority and the sole-writer discipline (11-01, 11-03 onward). If the reconciler silently stops -- a scheduler that never registered, a Redis loss, a poisoned tick -- an operator is notified from a genuinely different process within roughly half an hour, and separately notified if the reconciler keeps ticking but stops resolving.
- Explicitly NOT built here, and owned by a named later plan: Phase 15's OPS-13 re-plumbs the same `oldest_reconciling_since` signal into real alerting infrastructure (this plan ships only the interim plain-text email channel, per D-14). Bull Board / queue observability UI remains Phase 15 scope (unchanged by this plan).
- No stub was left where an architectural decision belongs -- the one gap above is a functional deferral already named to a specific later plan (Phase 15, OPS-13), not a silent omission.

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: packages/db/src/reconciler/reconciler-run.ts
- FOUND: packages/db/src/__tests__/reconciler-run.test.ts
- FOUND: apps/api/src/modules/ops/send-reconciler-watchdog.ts
- FOUND: apps/api/src/modules/ops/__tests__/send-reconciler-watchdog.test.ts
- FOUND: apps/worker/src/queues/__tests__/send-reconciler-health.test.ts
- FOUND: this SUMMARY.md on disk
- FOUND commit: bae7dde (Task 1)
- FOUND commit: e530e43 (Task 2)
- FOUND commit: 8e73429 (Task 3)
