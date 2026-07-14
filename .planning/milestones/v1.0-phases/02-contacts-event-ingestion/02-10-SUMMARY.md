---
phase: 02-contacts-event-ingestion
plan: 10
subsystem: database
tags: [postgres, drizzle, bullmq, rls, partitioning, multi-tenancy]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: events-ingest.worker.ts, events-api.routes.ts, events-queue.ts, imports-csv-queue.ts (02-05/02-06)
provides:
  - Workspace-scoped events primary key (workspace_id, id, occurred_at) closing the CR-01 cross-tenant idempotency collision
  - events_default DEFAULT partition closing the CR-03 out-of-window durability gap
  - Per-tenant BullMQ jobId scoping on POST /v1/events (queue-layer half of CR-01)
  - defaultJobOptions (attempts + exponential backoff) on both events-ingest and imports-csv queues (WR-01)
affects: [phase-03-segmentation, phase-04-campaigns-send-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hand-authored migration for partitioned-table PK changes (drizzle-kit cannot express composite PK on a partitioned table) -- same convention as 0007"
    - "BullMQ Custom Id / queue name may not contain ':' -- use '-' as the tenant-scoping separator everywhere a jobId or queue name is composed"

key-files:
  created:
    - packages/db/migrations/0010_events_workspace_scoped_pk.sql
  modified:
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/schema/events.ts
    - apps/worker/src/queues/events-ingest.worker.ts
    - apps/api/src/modules/events/events-api.routes.ts
    - apps/api/src/modules/events/events-queue.ts
    - apps/api/src/modules/contacts/imports-csv-queue.ts
    - apps/api/src/modules/events/__tests__/events-api.test.ts
    - apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts

key-decisions:
  - "events PK widened to (workspace_id, id, occurred_at) -- worker's ON CONFLICT target updated to match exactly"
  - "events_default DEFAULT partition added as a catch-all so any occurredAt outside the pre-created monthly partitions is accepted and stored, not dropped"
  - "jobId scoping separator is '-' not ':' -- BullMQ rejects a Custom Id containing a colon (confirmed against bullmq@5.79.1's job.js), same restriction 02-06 already hit for queue names"

patterns-established:
  - "Any future BullMQ jobId composition (not just queue names) must avoid ':' as a separator"

requirements-completed: [EVNT-01, EVNT-03]

coverage:
  - id: D1
    description: "Two tenants posting the SAME client-supplied eventId both get their own event stored (queue-layer jobId scoping + DB-layer PK scoping)"
    requirement: "EVNT-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#CR-01: two workspaces posting the SAME client-supplied eventId both get their own BullMQ job"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts#CR-01: two workspaces processing the SAME eventId + occurredAt both get their own events row"
        status: pass
    human_judgment: false
  - id: D2
    description: "An out-of-window occurredAt is accepted and lands in events via the DEFAULT partition instead of failing the INSERT"
    requirement: "EVNT-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts#CR-03: an out-of-window occurredAt is accepted and stored, not dropped"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both events:ingest and imports:csv queues retry transient failures (attempts>1, exponential backoff) instead of dropping an accepted job on first error"
    requirement: "EVNT-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#WR-01: eventsIngestQueue is configured with retry"
        status: pass
    human_judgment: false

duration: 6min
completed: 2026-07-05
status: complete
---

# Phase 02 Plan 10: Event Ingestion Tenant Isolation + Durability Gap Closure Summary

**Workspace-scoped events PK + DEFAULT partition + per-tenant BullMQ jobId + retry-configured queues close CR-01/CR-03/WR-01 from the 02-REVIEW findings.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-05T09:41:00Z
- **Completed:** 2026-07-05T09:47:03Z
- **Tasks:** 3
- **Files modified:** 8 (1 created)

## Accomplishments
- Closed CR-01 (tenant isolation): a client-supplied `eventId` can no longer let one tenant squat another tenant's UUID and silently suppress their event, at BOTH the BullMQ jobId layer (`events-api.routes.ts`) and the Postgres dedupe-key layer (new PK `(workspace_id, id, occurred_at)`, migration 0010).
- Closed CR-03 (durability): an `occurredAt` outside the pre-created monthly partitions (backfills, any date after 2026-09-01) is now accepted and stored via a new `events_default` DEFAULT partition, instead of failing the INSERT after the API already returned 202.
- Closed WR-01: both `events-ingest` and `imports-csv` BullMQ queues now configure `defaultJobOptions` (5 attempts, exponential backoff, `removeOnFail: false`) so a transient failure retries instead of silently dropping an already-accepted job.
- Migration 0010 applied cleanly to the dev database (`drizzle-kit migrate` exits 0); verified via `psql \d events` showing the new composite PK and the `events_default` partition.
- All four RED regression tests (cross-tenant jobId, retry config, cross-tenant DB dedupe, out-of-window occurredAt) now pass; full worker suite (13/13) and full API suite (102/102) green; `db`/`api`/`worker` builds clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing regression tests (RED)** - `a4af42b` (test)
2. **Task 2 [BLOCKING]: DB workspace-scoped PK + DEFAULT partition migration + worker ON CONFLICT + apply migration** - `e6be772` (feat)
3. **Task 3: App-layer per-tenant jobId + queue durability** - `b3b0b38` (feat)

**Plan metadata:** (final commit follows this summary)

## Files Created/Modified
- `packages/db/migrations/0010_events_workspace_scoped_pk.sql` - hand-authored migration: drops/re-adds the events PK as `(workspace_id, id, occurred_at)`, adds `events_default` DEFAULT partition
- `packages/db/migrations/meta/_journal.json` - idx-10 journal entry for 0010 (hand-authored precedent, no meta snapshot)
- `packages/db/src/schema/events.ts` - doc comment synced to the new physical PK + default partition
- `apps/worker/src/queues/events-ingest.worker.ts` - `ON CONFLICT (workspace_id, id, occurred_at) DO NOTHING` matching the new PK
- `apps/api/src/modules/events/events-api.routes.ts` - enqueue `jobId` scoped to `${workspaceId}-${eventId}`
- `apps/api/src/modules/events/events-queue.ts` - `defaultJobOptions` (attempts+backoff) added
- `apps/api/src/modules/contacts/imports-csv-queue.ts` - `defaultJobOptions` (attempts+backoff) added
- `apps/api/src/modules/events/__tests__/events-api.test.ts` - cross-tenant jobId test + retry-config assertion
- `apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts` - cross-tenant DB dedupe test + out-of-window occurredAt test

## Decisions Made
- Widened the events PK to `(workspace_id, id, occurred_at)` rather than a narrower fix, since a partitioned table's PK/unique constraint must include the partition key column (`occurred_at`) regardless -- adding `workspace_id` was the minimal change that closes CR-01 at the DB layer while preserving the partitioning contract.
- Chose a DEFAULT partition (not additional pre-created monthly partitions) as the CR-03 fix -- a catch-all is durability-correctness-critical and cheap; pre-creating further monthly partitions for query-performance reasons remains a tracked operational follow-up (unchanged from 02-RESEARCH.md), not a correctness requirement now that the catch-all exists.
- `defaultJobOptions` values (5 attempts, exponential backoff starting at 2000ms, `removeOnFail: false`) chosen per the plan's/02-REVIEW's recommended shape, applied identically to both queues.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] jobId separator changed from ":" to "-"**
- **Found during:** Task 3 (App-layer per-tenant jobId + queue durability)
- **Issue:** The plan specifies `jobId: \`${workspaceId}:${eventId}\``. BullMQ (5.79.1) throws `Custom Id cannot contain :` for any jobId containing a colon -- the exact same restriction 02-06 already hit and worked around for queue *names* (`events:ingest` → `events-ingest`), but this plan's jobId literal reintroduced a colon. Confirmed by reading `node_modules/bullmq/dist/cjs/classes/job.js` directly (line 1049).
- **Fix:** Changed the separator to `-`: `jobId: \`${workspaceId}-${eventId}\``. Functionally identical (jobId is opaque, never parsed back apart) and satisfies the same CR-01 per-tenant-scoping intent. Updated Task 1's cross-tenant regression test's `getJob()` lookups to the same `-` separator so the test continues to validate the actual production jobId shape.
- **Files modified:** `apps/api/src/modules/events/events-api.routes.ts`, `apps/api/src/modules/events/__tests__/events-api.test.ts`
- **Verification:** `cd apps/api && npm test -- events-api` -- all 10 tests pass, including the cross-tenant jobId test with the corrected separator.
- **Committed in:** `b3b0b38` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The fix preserves the plan's full intent (per-tenant BullMQ jobId namespace closing CR-01 at the queue layer) with no scope change -- only the literal separator character differs from the plan text, forced by a BullMQ platform constraint already precedented in this codebase (02-06).

## Issues Encountered
- Initial draft of the CR-01 cross-tenant regression test asserted `.not.toBeNull()` against `Queue.getJob()`'s return value, but BullMQ's `getJob()` resolves to `undefined` (not `null`) when a job doesn't exist -- `expect(undefined).not.toBeNull()` trivially passes, which caused the test to pass unexpectedly against unfixed (pre-fix) code during the RED phase. Caught before committing Task 1 by manually reproducing the jobId-collision behavior against a throwaway BullMQ queue (`node --input-type=module`) and confirming `getJob()` returns `undefined`. Fixed by asserting `.toBeTruthy()` instead, which correctly fails against pre-fix code and passes post-fix.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CR-01, CR-03, and WR-01 from 02-REVIEW.md are closed; the events-ingestion vertical slice's tenant-isolation and durability gaps are resolved with regression coverage.
- Migration 0010 is applied to the dev database; any other environment (staging/prod) must run `npm run db:migrate -w packages/db` before deploying this plan's application-layer changes, since the worker's new `ON CONFLICT (workspace_id, id, occurred_at)` target requires the new PK to already exist.
- Remaining phase-02 gap-closure plan (02-12) is unaffected by this plan's changes and can proceed independently.

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-05*

## Self-Check: PASSED

All 9 files created/modified verified present on disk; all 3 task commits (`a4af42b`, `e6be772`, `b3b0b38`) verified in git log.
