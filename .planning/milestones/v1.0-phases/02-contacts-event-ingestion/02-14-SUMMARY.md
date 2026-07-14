---
phase: 02-contacts-event-ingestion
plan: 14
subsystem: testing
tags: [postgres, pg-pool, vitest, fault-injection, rls, connection-pool]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: "withTenantTransaction's release-with-error (destroy) branch, shipped in 02-11 (packages/tenant-context/src/index.ts)"
provides:
  - "Fault-injection integration test proving withTenantTransaction destroys a pooled connection killed mid-transaction and the pool self-heals (WR-09)"
affects: [phase-04-broadcast-send-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fault-injection test pattern: let the helper under test own the pooled client (not a manually checked-out client) so its internal catch/release branch is genuinely exercised, mirroring but distinguishing from the sibling rls-pooling-chaos.test.ts manual-release pattern"
    - "client.on('error', () => {}) inside the transaction fn body (in addition to the package-level pool.on('error', ...) CR-03 guard) is required whenever a test intentionally kills a checked-out (non-idle) client's backend -- pool-level 'error' only covers idle clients"

key-files:
  created:
    - apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts
  modified: []

key-decisions:
  - "Test-only gap closure, no production code change: the WR-09 fix already exists (packages/tenant-context/src/index.ts lines 80-94, shipped in 02-11); this plan converts it from a source-assertion sign-off to a deterministic fault-injection regression test"
  - "requirements intentionally empty per gap-contract rule 5 -- this hardens already-satisfied requirements (EVNT-03, CONT-04) rather than re-claiming them"

patterns-established:
  - "Dead-connection fault-injection tests must attach client.on('error', ...) directly on the checked-out client (not just pool.on('error', ...)) to avoid an uncaught exception crashing the vitest worker when Postgres closes the socket out from under an in-use client"

requirements-completed: []

coverage:
  - id: D1
    description: "A connection killed mid-transaction (pg_terminate_backend) drives withTenantTransaction's release-with-error branch: the transaction rejects, the dead client is destroyed rather than returned to the pool, and the pool recovers for subsequent tenant transactions"
    verification:
      - kind: integration
        ref: "apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts#a connection killed mid-transaction is destroyed on release and the pool recovers (WR-09)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The terminated backend is genuinely gone from pg_stat_activity and is never handed back to serve another pooled query (6 sequential recovery transactions never reuse the destroyed pid)"
    verification:
      - kind: integration
        ref: "apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts#a connection killed mid-transaction is destroyed on release and the pool recovers (WR-09)"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-07-05
status: complete
---

# Phase 02 Plan 14: WR-09 dead-connection fault-injection test Summary

**Fault-injection integration test that lets `withTenantTransaction` own a pooled client, kills its backend mid-transaction via `pg_terminate_backend`, and proves the destroy-not-recycle + pool-recovery guarantee (WR-09) deterministically instead of by source assertion.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-05T14:51:00Z
- **Completed:** 2026-07-05T14:53:30Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Added `apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts`: a single-`it` fault-injection test that terminates the backend of a connection `withTenantTransaction` itself checked out, forcing its internal `catch -> ROLLBACK(throws) -> client.release(err)` destroy branch to run
- Verified the terminated backend is absent from `pg_stat_activity` after the transaction rejects
- Verified 6 sequential post-failure tenant transactions all succeed and never receive the destroyed backend's pid, proving the pool self-heals and never recycles a poisoned connection
- Full `apps/api` suite (18 files / 110 tests) stays green with the new test included; `git status` shows only the new test file — no production code touched

## Task Commits

Each task was committed atomically:

1. **Task 1: Fault-injection test — dead pooled connection is destroyed and the pool recovers (WR-09)** - `d8eb0b3` (test)

**Plan metadata:** (recorded below, see final commit)

## Files Created/Modified
- `apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts` - Fault-injection test: kills the backend of a client owned by `withTenantTransaction` mid-fn, asserts rejection, backend death, and pool recovery without connection reuse

## Decisions Made
- Test-only plan; no production code changes needed since the WR-09 destroy-on-error logic already exists in `packages/tenant-context/src/index.ts` (shipped in 02-11)
- `requirements: []` intentionally, per gap-contract rule 5 (hardens EVNT-03/CONT-04, doesn't re-claim them)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added `client.on("error", () => {})` inside the transaction callback**
- **Found during:** Task 1 (initial test run)
- **Issue:** The plan's test spec did not call out a per-client `error` listener. Running the test as initially written produced 2 uncaught exceptions ("terminating connection due to administrator command" / "Connection terminated unexpectedly") that failed the vitest process even though the single test itself passed — the package-level `pool.on("error", ...)` guard (CR-03) only covers *idle* pooled clients; a client that is checked out and in-use when its backend is killed emits its own `error` event on the client object, which crashes the process without a listener. The sibling `rls-pooling-chaos.test.ts` already handles this via `doomed.on("error", () => {...})` on its manually-checked-out client — the same pattern was missing here for the client `withTenantTransaction` checks out internally.
- **Fix:** Added `client.on("error", () => {})` as the first line inside the `withTenantTransaction` callback, right after `client` is received, with a comment identical in intent to the sibling test's.
- **Files modified:** apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts
- **Verification:** Re-ran `npm test -- withTenantTransaction-dead-connection` — 1 passed, 0 errors. Re-ran full `apps/api` suite — 18 files / 110 tests passed, 0 errors.
- **Committed in:** d8eb0b3 (Task 1 commit; single commit for the whole file, deviation applied before commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix, required to make the test process exit cleanly)
**Impact on plan:** No scope creep — this is the same defensive listener pattern the sibling chaos test already uses, just attached to the client instance instead of only the pool. Necessary for correctness of test execution, not a change to what's being verified.

## Issues Encountered
None beyond the auto-fixed deviation above.

## User Setup Required
None - no external service configuration required. Requires `TEST_DATABASE_URL` pointed at a non-superuser Postgres role, which is the existing prerequisite for every `apps/api` integration test (already satisfied in this environment).

## Next Phase Readiness
- WR-09's destroy-on-error branch is now proven by a deterministic fault-injection regression test, closing UAT Test 11's follow-up before Phase 4 (broadcast send pipeline) raises write concurrency through this same shared tenant connection pool
- No blockers for Phase 4

## Self-Check

- FOUND: apps/api/src/db/__tests__/withTenantTransaction-dead-connection.test.ts
- FOUND: d8eb0b3 (commit hash present in git log)

## Self-Check: PASSED

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-05*
