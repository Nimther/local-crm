---
phase: 02-contacts-event-ingestion
plan: 11
subsystem: database
tags: [postgres, savepoint, connection-pool, node-postgres, race-condition, drizzle, contacts-core]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: "upsertContactByIdentity shared upsert (02-03/02-04/02-06), withTenantTransaction pooled tenant-context (02-05), lookupApiKeyById hot auth-lookup path (02-03)"
provides:
  - "upsertContactByIdentity survives a genuine concurrent-insert race (23505) without surfacing 25P02, resolving to the winning row"
  - "upsertContactByIdentity's update branch now honors subscriptionStatus (D-12 guarded) instead of silently ignoring it"
  - "withTenantTransaction and lookupApiKeyById destroy a pooled connection whose ROLLBACK failed, instead of returning a poisoned client to the pool"
affects: [03-segmentation, 04-campaigns-send-queue, 06-triggered-flows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SAVEPOINT/ROLLBACK TO SAVEPOINT for recoverable single-statement retry inside a shared caller transaction (vs. aborting the whole transaction on error)"
    - "client.release(err) to force node-postgres to destroy a connection instead of pooling it, whenever the failure-path ROLLBACK itself throws"

key-files:
  created: []
  modified:
    - packages/contacts-core/src/contact-repository.ts
    - packages/tenant-context/src/index.ts
    - apps/api/src/modules/api-keys/api-keys.repository.ts
    - apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts

key-decisions:
  - "Invalid subscriptionStatus transitions on the update branch are logged and silently skipped (not thrown), unlike updateContact's direct-PATCH throw -- this upsert is shared by unattended ingestion paths (events worker, CSV import) that have no request/response cycle to surface a 409 through"
  - "Test A (CR-02) drives a REAL concurrent double-insert via two independent pooled connections racing the same identity (Promise.allSettled), rather than mocking the interleave -- verified stable across repeated runs"

patterns-established: []

requirements-completed: []

coverage:
  - id: D1
    description: "Concurrent double-insert on a brand-new identity resolves to a single contact without surfacing a 25P02 aborted-transaction error (CR-02)"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#CR-02 (Test A): a concurrent double-insert on a brand-new identity resolves to a single contact without surfacing 25P02"
        status: pass
    human_judgment: false
  - id: D2
    description: "subscriptionStatus on the update branch applies a valid subscribed<->unsubscribed transition, still refusing suppressed (WR-06 + D-12)"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#WR-06 (Test B): subscriptionStatus on the update branch applies a valid subscribed->unsubscribed transition"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts#WR-06/D-12 (Test C): a direct set to suppressed on the update branch is refused, not applied"
        status: pass
    human_judgment: false
  - id: D3
    description: "withTenantTransaction and lookupApiKeyById destroy the pooled client when ROLLBACK itself fails (WR-09)"
    verification:
      - kind: other
        ref: "source assertion -- packages/tenant-context/src/index.ts and apps/api/src/modules/api-keys/api-keys.repository.ts both call client.release(err) on the dead-connection branch; full API suite (100/100) confirms happy-path release unaffected"
        status: pass
    human_judgment: true
    rationale: "No fault-injection tooling exists in this suite to deterministically kill a connection mid-ROLLBACK (unlike the CR-02 race, which is reproducible via two live concurrent connections). The fix is proven by source assertion and a clean full-suite regression run, per the plan's own documented test deferral -- a human should confirm this reasoning is acceptable rather than silently auto-passing an untested runtime branch."

duration: 15min
completed: 2026-07-05
status: complete
---

# Phase 02 Plan 11: Ingestion Plumbing Hardening (CR-02, WR-06, WR-09) Summary

**SAVEPOINT-wrapped race retry in the shared contact upsert, subscriptionStatus applied on its update branch under D-12 guards, and dead pooled connections destroyed instead of recycled on both the tenant-transaction and API-key-lookup paths.**

## Performance

- **Duration:** 15 min
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- `upsertContactByIdentity`'s Branch E INSERT is now wrapped in `SAVEPOINT upsert_insert`; a concurrent unique violation issues `ROLLBACK TO SAVEPOINT upsert_insert` (not a transaction-aborting bare error) before the single retry, so the retry's SELECT can actually resolve the winning row instead of throwing 25P02. Verified against a REAL concurrent double-insert across two independent pooled connections.
- The update branch of `upsertContactByIdentity` now applies `subscriptionStatus` for a valid subscribed<->unsubscribed transition, mirroring `updateContact`'s D-12 guards exactly (never a direct set to suppressed, never suppressed->subscribed) -- logged and skipped rather than thrown, since this is a shared upsert with unattended callers (events worker, CSV import) that have no response cycle to surface a 409 through.
- `withTenantTransaction` (shared by `apps/api` and `apps/worker`) and `lookupApiKeyById` (the hot auth-lookup path) now call `client.release(err)` when their failure-path `ROLLBACK` itself throws, so node-postgres destroys the dead client instead of returning it to the pool for the next caller.

## Task Commits

1. **Task 1: Failing tests -- insert-race retry + subscriptionStatus-on-update (RED)** - `3f23ddd` (test)
2. **Task 2: Shared upsert -- SAVEPOINT race retry (CR-02) + subscriptionStatus on update (WR-06)** - `f54b00d` (feat)
3. **Task 3: Destroy dead pooled connections on release (WR-09)** - `d57967d` (fix)

_Note: Task 1 is the RED half of a TDD-style cycle for CR-02/WR-06; Task 2 is GREEN. Task 3 (WR-09) has no runtime test (see Deferred Issues) and is committed as a standalone `fix`._

## Files Created/Modified

- `packages/contacts-core/src/contact-repository.ts` - Branch E INSERT wrapped in SAVEPOINT + ROLLBACK TO SAVEPOINT retry (CR-02); update branch computes and applies `nextStatus` for `subscription_status` under D-12 guards (WR-06)
- `packages/tenant-context/src/index.ts` - `withTenantTransaction` tracks ROLLBACK failure and calls `client.release(err)` (destroy) instead of `client.release()` on that path (WR-09)
- `apps/api/src/modules/api-keys/api-keys.repository.ts` - `lookupApiKeyById` applies the identical destroy-on-dead-ROLLBACK release pattern (WR-09)
- `apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts` - Test A (real concurrent-insert race, two pooled connections), Test B (subscriptionStatus applied on update), Test C (D-12 suppressed-set guard)

## Decisions Made

- Invalid subscriptionStatus transitions on the update branch are logged and silently skipped (not thrown), unlike `updateContact`'s direct-PATCH throw -- this upsert is shared by unattended ingestion paths (events worker, CSV import) that have no request/response cycle to surface a 409 through; matches the function's existing conflict-logging style (external_id/email conflicts already log-and-skip rather than throw).
- Test A (CR-02) drives a genuine concurrent double-insert via two independent pooled connections racing the same brand-new identity with `Promise.allSettled`, rather than mocking the interleave -- confirmed stable across 4 consecutive runs (including the RED baseline) with no flakiness observed.

## Deviations from Plan

None - plan executed exactly as written, including the documented WR-09 test deferral (no fault-injection tooling exists in this suite to deterministically kill a connection mid-ROLLBACK; proven instead by source assertion + full-suite regression).

## Issues Encountered

None - all three tasks completed without unexpected blockers. The concurrent-insert test (Test A) was the highest execution risk (potential flakiness) but passed cleanly and consistently across repeated runs both before and after the fix.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- All three write paths that depend on `upsertContactByIdentity` (Contacts API, events:ingest worker, imports:csv worker) now share a race-safe, status-aware shared upsert.
- Both plumbing sites that hand pooled connections back after a tenant transaction (`withTenantTransaction`, `lookupApiKeyById`) now correctly destroy dead connections, protecting every downstream phase's request/job path from inheriting a poisoned client.
- WR-09's dead-connection-destruction branch remains runtime-untested (source-asserted only) -- flagged in `coverage` for human sign-off rather than silently auto-passed; no fault-injection harness exists yet in this suite to close that gap deterministically.

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-05*

## Self-Check: PASSED

All modified files present on disk; all three task commits (3f23ddd, f54b00d, d57967d) found in git log.
