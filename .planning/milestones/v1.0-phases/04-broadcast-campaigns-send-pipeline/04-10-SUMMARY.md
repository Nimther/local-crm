---
phase: 04-broadcast-campaigns-send-pipeline
plan: 10
subsystem: database
tags: [postgres, sql, send-ledger, idempotency, gap-closure, vitest]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-03/04-04's sends ledger (dispatchSendGate/recordSendResult/recordExcluded) and 04-06's campaign-kickoff exclusion re-walk"
provides:
  - "recordExcluded's ON CONFLICT guarded against demoting a 'sent'/'dispatching'/'failed' sends row"
  - "delivery-core package's first real-Postgres integration test (db-fixture + vitest.config.ts DATABASE_URL routing)"
affects: [campaign-kickoff.worker.ts, pre-send-gate.ts, send-dispatch.ts, phase-05-webhook-tracking]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "packages/delivery-core now has a real-Postgres integration test lane (src/test/db-fixture.ts + vitest.config.ts test.env.DATABASE_URL), mirroring apps/api and apps/worker's existing convention -- prior delivery-core tests all stubbed PoolClient"

key-files:
  created:
    - packages/delivery-core/src/__tests__/send-ledger-integrity.test.ts
    - packages/delivery-core/src/test/db-fixture.ts
  modified:
    - packages/delivery-core/src/send-ledger.ts
    - packages/delivery-core/vitest.config.ts

key-decisions:
  - "recordExcluded's ON CONFLICT DO UPDATE gained a WHERE sends.status NOT IN ('sent', 'dispatching', 'failed') clause -- when the conflicting row's status must be preserved, Postgres skips the update silently (no error), so a redelivered kickoff's exclusion re-walk becomes a true no-op against a delivered/in-flight send"
  - "No migration added -- the send_status enum already had every value needed (dispatching/sent/failed/excluded); this was a pure SQL-predicate fix to an existing function's ON CONFLICT clause"
  - "delivery-core had no db-fixture prior to this plan (all existing tests stubbed PoolClient) -- created src/test/db-fixture.ts mirroring apps/worker's version verbatim (same migrations-dir relative depth) and added test.env.DATABASE_URL routing to vitest.config.ts, since send-ledger.ts issues real SQL that a stub cannot exercise for the ON CONFLICT guard itself"

requirements-completed: [SEND-04, SEND-06]

coverage:
  - id: D1
    description: "recordExcluded never demotes an already-'sent' row when a kickoff re-walk redelivers the same (workspace, campaign, contact) exclusion call"
    requirement: SEND-04
    verification:
      - kind: integration
        ref: "packages/delivery-core/src/__tests__/send-ledger-integrity.test.ts#does NOT demote an already-'sent' row when a kickoff re-walk calls recordExcluded again"
        status: pass
    human_judgment: false
  - id: D2
    description: "recordExcluded never demotes an in-flight 'dispatching' row (a send still being processed when the exclusion re-walk runs)"
    requirement: SEND-06
    verification:
      - kind: integration
        ref: "packages/delivery-core/src/__tests__/send-ledger-integrity.test.ts#does NOT demote an in-flight 'dispatching' row when recordExcluded is called concurrently"
        status: pass
    human_judgment: false
  - id: D3
    description: "Normal exclusion recording (fresh insert) and re-classification of an already-'excluded' row are unchanged by the guard"
    verification:
      - kind: integration
        ref: "packages/delivery-core/src/__tests__/send-ledger-integrity.test.ts#still inserts a fresh 'excluded' row with the supplied reason when no row exists yet"
        status: pass
      - kind: integration
        ref: "packages/delivery-core/src/__tests__/send-ledger-integrity.test.ts#still updates the exclusion_reason when re-classifying an already-'excluded' row"
        status: pass
    human_judgment: false

# Metrics
duration: 12min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 10: Send Ledger Demotion Guard (CR-07) Summary

**Guarded `recordExcluded`'s `ON CONFLICT ... DO UPDATE` with `WHERE sends.status NOT IN ('sent', 'dispatching', 'failed')` so a redelivered campaign-kickoff exclusion re-walk can never erase delivery evidence or corrupt the frequency-cap ledger.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-06T12:53:00Z
- **Completed:** 2026-07-06T13:05:22Z
- **Tasks:** 2 completed
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- Closed CR-07 (04-VERIFICATION.md truth #4): `recordExcluded` in `send-ledger.ts` previously used an unconditional `ON CONFLICT ... DO UPDATE SET status='excluded'`, which let an at-least-once BullMQ kickoff redelivery demote an already-`sent` or in-flight `dispatching` row to `excluded` — erasing delivery history and corrupting `pre-send-gate.ts`'s rolling frequency-cap count (which counts this same campaign's own `status='sent'` rows).
- Added an integration test suite (`send-ledger-integrity.test.ts`) proving all four required behaviors against the real test Postgres: a `sent` row survives, a `dispatching` row survives, a fresh exclusion still inserts correctly, and re-classifying an already-`excluded` row's reason still works.
- Established delivery-core's first real-Postgres test lane (`src/test/db-fixture.ts` + `vitest.config.ts` DATABASE_URL routing) — every prior test in this package stubbed the `PoolClient` directly, but the ON CONFLICT guard can only be proven against real SQL semantics.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing test — recordExcluded must not demote a 'sent' or 'dispatching' row** - `2ed4142` (test)
2. **Task 2: Guard recordExcluded's ON CONFLICT against demoting terminal/in-flight rows** - `007b027` (feat)

_TDD plan: RED (2ed4142) confirmed both 'sent' and 'dispatching' cases failing against the unconditional ON CONFLICT before the fix; GREEN (007b027) confirmed all 4 cases passing after the fix. No REFACTOR commit needed — the fix was a single WHERE clause addition, no cleanup required._

## Files Created/Modified

- `packages/delivery-core/src/send-ledger.ts` - `recordExcluded`'s `ON CONFLICT ... DO UPDATE` gained `WHERE sends.status NOT IN ('sent', 'dispatching', 'failed')`
- `packages/delivery-core/src/__tests__/send-ledger-integrity.test.ts` - new integration test proving the guard (and the still-working normal paths) against real Postgres
- `packages/delivery-core/src/test/db-fixture.ts` - new test-DB migration/pool fixture, mirroring `apps/worker/src/test/db-fixture.ts` verbatim
- `packages/delivery-core/vitest.config.ts` - added `test.env.DATABASE_URL` routing to the isolated test database (additive; every other existing test in this package still stubs `PoolClient` and is unaffected)

## Decisions Made

- The guard is a `WHERE` clause on the `ON CONFLICT ... DO UPDATE`, not an application-level pre-check-then-write — this keeps the operation atomic (single statement, no read-then-write race) and makes Postgres silently no-op the update when the existing row must be preserved, rather than raising an error the caller would need to catch.
- No migration was added. The `send_status` enum (`dispatching`/`sent`/`failed`/`excluded`) already covered every value the guard needed.
- delivery-core's db-fixture was created as a near-verbatim copy of `apps/worker/src/test/db-fixture.ts` (per the plan's own `read_first` guidance) rather than extracted to a shared package — consistent with the existing precedent (worker's and api's db-fixtures are also independently duplicated, documented as intentional test-scaffolding duplication, not logic that needs single-sourcing).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] delivery-core had no test-database fixture to run the required integration test**
- **Found during:** Task 1
- **Issue:** The plan's `<behavior>` required proving the ON CONFLICT guard against real Postgres (a stubbed `PoolClient` cannot exercise a database-enforced conflict-guard clause), but `packages/delivery-core` had no existing db-fixture — every prior test in the package (`pre-send-gate.test.ts`, `send-ledger.test.ts` via stubs) never opened a real connection.
- **Fix:** Created `packages/delivery-core/src/test/db-fixture.ts`, mirroring `apps/worker/src/test/db-fixture.ts` exactly (same migrations-dir relative depth, same advisory-lock key so all three suites can safely share one physical test DB), and added `test.env.DATABASE_URL` routing to `packages/delivery-core/vitest.config.ts`, matching `apps/api`/`apps/worker`'s established convention.
- **Files modified:** `packages/delivery-core/src/test/db-fixture.ts` (new), `packages/delivery-core/vitest.config.ts`
- **Verification:** Full delivery-core suite (`npx vitest run`) passes 23/23 after the change — the 19 pre-existing stub-based tests are unaffected by the additive `DATABASE_URL` env entry.
- **Committed in:** `2ed4142` (part of Task 1's test commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking test-infrastructure gap).
**Impact on plan:** Necessary to make the plan's own required integration test runnable at all; no scope creep beyond what Task 1's `<read_first>` explicitly anticipated ("if delivery-core has no db fixture, reuse the pattern from the worker test").

## Issues Encountered

None — the fix was a single, well-scoped SQL predicate addition with no unexpected interactions.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `recordExcluded` is now safe under BullMQ's at-least-once kickoff redelivery: the send ledger (single source of truth for progress, frequency cap, and Phase 5's per-message delivery tracking) can no longer be corrupted by a redelivered exclusion re-walk.
- `packages/delivery-core` now has a reusable real-Postgres integration-test lane (`src/test/db-fixture.ts`) that future delivery-core plans (e.g. further send-ledger or pre-send-gate work) can reuse directly instead of re-deriving it.
- No blockers for the remaining 04-11/04-12/04-13 gap-closure plans.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All created/modified files and both task commit hashes (2ed4142, 007b027) verified present.
