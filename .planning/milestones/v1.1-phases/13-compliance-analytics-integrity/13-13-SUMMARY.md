---
phase: 13-compliance-analytics-integrity
plan: 13
subsystem: worker
tags: [bullmq, postgres, jsonb, gdpr-erasure, pii, allowlist, checkpoint, keyset-pagination]

requires:
  - phase: 13 (plan 13-10)
    provides: erasure_records table (status/counts/cursor columns, migration 0059), deleteContact synchronous anonymization + ERASURE_SCRUB_QUEUE producer
  - phase: 13 (plan 13-12)
    provides: workspace_suppressions hashed-email scheme (no plaintext column this plan needed to touch)
  - phase: 12 (plan 12-06)
    provides: bounded checkpointed keyset-pagination sweep template (flow-segment-sweep-flow.worker.ts / flow-segment-sweep-checkpoint.ts) this plan's walk shape (not storage) copies
provides:
  - Allowlist-reconstructed send_events.payload scrub (SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST, buildScrubbedSendEventPayload)
  - Unconditional events.properties scrub to {} (buildScrubbedEventProperties)
  - Checkpointed, bounded, resumable erasure-scrub BullMQ worker (createErasureScrubWorker) consuming ERASURE_SCRUB_QUEUE
  - erasure_records.status/counts/cursor lifecycle management (pending -> scrubbing -> complete/failed)
  - Kill-resume failure-injection coverage wired into failure:all
affects: [13-14 (SPECIFICATION §4 must reproduce the allowlist), 13-15 (reclaimer producer for stranded pending records)]

tech-stack:
  added: []
  patterns:
    - "Allowlist reconstruction (build-up, never tear-down) as the mechanism for bounding what JSONB PII survives a scrub, replacing a denylist"
    - "Cursor stored as { done: false, occurredAt, id } | { done: true } rather than a nullable positional cursor, so 'finished' is distinguishable from 'not started'"
    - "occurred_at read/written as TEXT and cast to ::timestamptz in SQL, never round-tripped through a JS Date, when the value must compare exactly against its own source row"

key-files:
  created:
    - apps/worker/src/queues/erasure-scrub.worker.ts
    - apps/worker/src/queues/erasure-scrub-checkpoint.ts
    - apps/worker/src/queues/__tests__/erasure-scrub.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/erasure-scrub-resume.test.ts
  modified:
    - apps/worker/src/server.ts
    - apps/worker/src/queues/__tests__/scheduler-registration.test.ts
    - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
    - packages/db/src/index.ts
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "Allowlist reconstruction, not denylist filtering (REVIEWS.md Codex BLOCKER finding 4) -- an unanticipated PII field is dropped by construction rather than by detection"
  - "events.properties gets no allowlist at all -- unconditionally rewritten to {} because its key space is tenant-defined and unenumerable"
  - "Checkpoint cursor lives on erasure_records.sends_scrub_cursor/events_scrub_cursor (migration 0059's two jsonb columns), never the Phase 12 flow_segment_sweep_checkpoint table (its flow_id FK cannot hold an erasure-record id)"
  - "occurred_at must be read as text and cast back to ::timestamptz in SQL rather than round-tripped through a JS Date -- pg's default timestamptz parser truncates to millisecond precision, which silently broke both the per-row UPDATE match and the keyset pagination boundary against microsecond-precision now()-derived timestamps"

requirements-completed: [CMP-04]

coverage:
  - id: D1
    description: "send_events.payload scrubbed via allowlist reconstruction -- only 10 named provider fields survive, PII under any other key name (including reason/response embedding the address, and unenumerable tenant-invented keys) is gone by construction"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub.test.ts#buildScrubbedSendEventPayload (Task 1, T-13-13-01/03/06)"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/erasure-scrub.test.ts#erasure scrub: checkpointed bounded walk over sends/send_events/events (Task 2)"
        status: pass
    human_judgment: false
  - id: D2
    description: "events.properties unconditionally rewritten to {} for every scrubbed row"
    requirement: "CMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub.test.ts#buildScrubbedEventProperties (Task 1, T-13-13-01)"
        status: pass
    human_judgment: false
  - id: D3
    description: "erasure_records proves the scrub ran (per-table counts, complete/failed status) and a scrub for a contact with no linked rows completes with zero counts"
    requirement: "CMP-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/erasure-scrub.test.ts#scrubs 5 linked send_events and 3 linked events... / completes with both counts zero..."
        status: pass
    human_judgment: false
  - id: D4
    description: "A scrub interrupted at either boundary (after a page commits, or mid-page before commit) resumes correctly without skipping or double-reporting a row"
    requirement: "CMP-04"
    verification:
      - kind: integration
        ref: "npm run failure:erasure-scrub-resume (apps/worker/src/queues/__tests__/failure-injection/erasure-scrub-resume.test.ts)"
        status: pass
    human_judgment: false
  - id: D5
    description: "A hostile job naming a sibling workspace with this workspace's contactId/erasureRecordId cannot read or mutate this workspace's erasure record or send_events rows (SEC-16 cross-tenant coverage)"
    requirement: "CMP-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts#erasure-scrub (runErasureScrub, plan 13-13)"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-08-12
status: complete
---

# Phase 13 Plan 13: Erasure Scrub Worker Summary

**Checkpointed BullMQ worker that scrubs an erased contact's `send_events.payload`/`events.properties` via allowlist reconstruction (not a denylist), with a kill-resume failure-injection scenario proving both interruption boundaries.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-08-12
- **Tasks:** 3
- **Files modified:** 10 (4 created, 6 modified)

## Accomplishments

- `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` names exactly 10 surviving top-level keys (`event`, `type`, `timestamp`, `sg_event_id`, `sg_message_id`, `smtp-id`, `status`, `attempt`, `asm_group_id`, `bounce_classification`); `buildScrubbedSendEventPayload` copies only those keys forward (build-up construction, never tear-down), so PII under any key name nobody anticipated -- including `reason`/`response` free-form SMTP text embedding the recipient's address, and arbitrary tenant-invented keys -- is gone by construction. No allowlist/denylist entry was added or removed from the plan's specified list.
- `buildScrubbedEventProperties` unconditionally returns `{}` for every input -- `events.properties`' key space is tenant-defined and unenumerable, so no field in it can be shown to be evidence. The actual `UPDATE events SET properties = ...` writes the literal value this function returns (`'{}'::jsonb`) in one bulk statement per page, so there is exactly one place to change if a future allowlist is ever justified.
- Checkpointed, bounded, resumable scrub over `send_events` (joined through `sends.contact_id`) and `events` (which carries `contact_id` directly -- no join needed), keyset-paginated on `(occurred_at, id)`, 500 rows per page (`ERASURE_SCRUB_PAGE_LIMIT`, matching the Phase 12 sweep's page-size precedent).
- Cursor stored on `erasure_records.sends_scrub_cursor`/`events_scrub_cursor` (the two `jsonb` columns migration 0059 already created) as `{ done: false, occurredAt, id }` mid-walk or `{ done: true }` once a page returns zero rows -- deliberately not `null`, so "finished" (a one-shot, non-resetting terminal state, unlike Phase 12's perpetual sweep) is distinguishable from "not started". `advanceErasureScrubCheckpoint` commits the cursor write and the `sends_scrubbed`/`events_scrubbed` count increment in one statement, in the same transaction as that page's JSONB rewrite (D-09).
- `runErasureScrub` drives `pending -> scrubbing -> complete`, is a no-op on an already-`complete` record, and on error marks the record `failed` with `scrub_error` recorded, then re-throws so BullMQ's own retry/backoff and dead-letter path apply exactly as for any other queue.
- `createErasureScrubWorker` registers no job scheduler (job-per-erasure, not a tick) -- a dedicated `scheduler-registration.test.ts` describe block pins that absence as a property, not merely an omission. Registered in `server.ts` as the 19th worker.
- Kill-resume failure-injection scenario (`erasure-scrub-resume.test.ts`) proves BOTH interruption boundaries: after a page's transaction commits (checkpoint honored on resume, no re-scrub) and mid-page before commit (the whole transaction, including the checkpoint advance, rolls back together -- proving the checkpoint and row rewrites share fate, not merely that a checkpoint happens to exist). Wired into `failure:erasure-scrub-resume` and `failure:all`.

## Task Commits

1. **Task 1: Reconstruct scrubbed JSONB from an explicit evidence allowlist** - `fb4e141` (feat)
2. **Task 2: Checkpointed, bounded scrub over both tables with completion tracking** - `3d30ec9` (feat)
3. **Task 3: Kill-resume failure-injection scenario** - `3276db7` (test, includes a Rule 1 bug fix surfaced by the new test)

## Files Created/Modified

- `apps/worker/src/queues/erasure-scrub.worker.ts` - allowlist reconstruction functions, keyset-paginated page scrubbers, `runErasureScrub`, `createErasureScrubWorker`
- `apps/worker/src/queues/erasure-scrub-checkpoint.ts` - `PoolClient`-first cursor read/write against `erasure_records`' two cursor columns
- `apps/worker/src/queues/__tests__/erasure-scrub.test.ts` - pure-function tests (Task 1) plus real-Postgres checkpointed-walk tests (Task 2)
- `apps/worker/src/queues/__tests__/failure-injection/erasure-scrub-resume.test.ts` - the two-boundary kill-resume scenario
- `apps/worker/src/server.ts` - registers `createErasureScrubWorker` as the 19th worker
- `apps/worker/src/queues/__tests__/scheduler-registration.test.ts` - new describe block asserting zero job schedulers/repeatables for this queue
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` - new ErasureScrub cross-tenant case + `COVERED_FAMILIES` entry (Rule 2 fix, see below)
- `packages/db/src/index.ts` - added the missing `export * from "./schema/erasure-records.js"` (Rule 3 fix, see below)
- `package.json` - `failure:erasure-scrub-resume` script, added to `failure:all`
- `SPECIFICATION.md` - §5.2 worker count (18 -> 19), new §5.15 documenting the queue/worker

## Decisions Made

- **Checkpoint storage:** confirmed as decided by the plan -- the two `erasure_records` `jsonb` cursor columns from migration 0059, never the Phase 12 `flow_segment_sweep_checkpoint` table (its `flow_id NOT NULL REFERENCES flows(id)` foreign key cannot hold an erasure-record id).
- **Cursor "finished" representation:** `{ done: true }`, distinguishable from `null` ("not started"). Unlike the Phase 12 sweep's perpetual walk (which resets its cursor to `null` on completion so a later-arriving row is never skipped), this walk is one-shot per erasure -- an already-anonymized contact does not gain new PII rows, so "done forever" is correct rather than a bug.
- **`scrubEventsPage` routing:** it does NOT read `properties` back before writing. It selects only `id`/`occurred_at` for the page, then issues one bulk `UPDATE ... SET properties = '{}'::jsonb WHERE id = ANY($ids)`. `buildScrubbedEventProperties({})` is still called in the code path and its result (`{}`) is what gets serialized into that UPDATE, so there is exactly one place to change if a future allowlist is ever justified, matching the plan's explicit preference for this form.
- **Page limit:** `ERASURE_SCRUB_PAGE_LIMIT = 500`, matching `flow-segment-sweep-flow.worker.ts`'s `SWEEP_PAGE_SIZE` precedent -- large enough that a typical contact's history scrubs in a handful of pages, small enough that each page's transaction (one bounded SELECT plus per-row or bulk UPDATEs) stays short.
- **`events` link path:** `events.contact_id` directly -- no join needed (unlike `send_events`, which reaches the contact only through `sends.contact_id`).
- **Final allowlist:** unchanged from the plan's specified 10 keys; nothing added or removed.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `@mega-crm/db` never re-exported `erasure-records.ts`**
- **Found during:** Task 2 (writing `erasure-scrub.worker.ts`'s `ErasureRecordStatus` import)
- **Issue:** Plan 13-10's migration 0059 added `erasure_records`, and `packages/db/src/index.ts` imported the schema module into its merged Drizzle `schema` object, but never added the corresponding `export * from "./schema/erasure-records.js"` line -- so `ErasureRecordStatus` (and the `erasureRecords` table export) was unreachable from any consumer of `@mega-crm/db`. This plan is the first to need it.
- **Fix:** Added the missing `export *` line to `packages/db/src/index.ts`.
- **Files modified:** `packages/db/src/index.ts`
- **Verification:** `npx tsc --noEmit -p packages/db/tsconfig.json` and `-p apps/worker/tsconfig.json` both pass; `npm run build` succeeds across all workspaces.
- **Committed in:** `3d30ec9` (Task 2 commit)

**2. [Rule 1 - Bug] `occurred_at` round-tripped through a JS `Date` lost microsecond precision, breaking both the per-row UPDATE match and the keyset pagination boundary**
- **Found during:** Task 3 (writing the kill-resume failure-injection scenario, whose fixtures seed rows with server-computed `now()`-based timestamps rather than Task 2's own JS-`Date`-only fixtures)
- **Issue:** `pg`'s default `timestamptz` type parser truncates to millisecond precision when building a JS `Date` (Postgres itself carries microsecond precision, e.g. from `now()`). `scrubSendEventsPage`/`scrubEventsPage` read `occurred_at` as a `Date`, then wrote it back (via `.toISOString()` for the cursor, or the `Date` object directly for the per-row UPDATE's `WHERE occurred_at = $4`) into a comparison against the SAME column's original, untruncated value. For any row whose real timestamp carried sub-millisecond precision, its own truncated cursor representation compared strictly LESS than its real value -- the per-row `UPDATE` silently matched zero rows (the scrub reported success but never persisted), and the keyset `WHERE (occurred_at, id) > (cursor)` kept re-including that same row on every subsequent page, an unbounded loop. Production `send_events` rows are unaffected in practice (the webhook worker derives `occurred_at` from SendGrid's integer-seconds `timestamp` field, always second-precision), which is why Task 2's own fixtures (built from JS `Date`s with only millisecond precision from the start) never exposed this -- it took Task 3's server-computed `now()`-based fixture to surface it.
- **Fix:** `occurred_at` is now selected as `occurred_at::text` (never parsed into a `Date`) and cast back to `::timestamptz` explicitly in every subsequent SQL comparison/UPDATE (`$n::timestamptz`, `$n::uuid`). Text round-trips a Postgres value through Postgres losslessly; casting it back reconstructs the identical value bit-for-bit.
- **Files modified:** `apps/worker/src/queues/erasure-scrub.worker.ts`
- **Verification:** `npm run failure:erasure-scrub-resume` passes (both boundaries); the full Task 2 suite (`erasure-scrub.test.ts`, `queue-core-single-definition.test.ts`, `scheduler-registration.test.ts`, `shared-error-listener.test.ts`) still passes (99/99); `npm run failure:all`, `npm run lint`, and `npm run build` all pass.
- **Committed in:** `3276db7` (Task 3 commit)

**3. [Rule 2 - Missing critical functionality] SEC-16 cross-tenant coverage gate did not know about the new worker family**
- **Found during:** post-Task-3 full-suite verification (`npx vitest run --root apps/worker`)
- **Issue:** `negative-cross-tenant-jobs.test.ts`'s Test 5 asserts every `create*Worker` family registered in `server.ts`'s `buildWorker()` is either covered by a dedicated cross-tenant proof or has a documented exclusion reason. Wiring `createErasureScrubWorker` into `server.ts` (Task 2) left `ErasureScrub` in neither set -- the gate failed with "job family(ies) registered in buildWorker but neither covered nor excluded: ErasureScrub".
- **Fix:** Added a dedicated cross-tenant case mirroring `flow-enroll-existing`'s shape (a direct job handler taking `workspaceId` from job data, not a scan-discovery family): a job naming workspace B whose `contactId`/`erasureRecordId` both belong to workspace A is a no-op, because `runErasureScrub`'s own `withTenant(workspaceB, ...)` scope makes workspace A's `erasure_records` row and `send_events` rows invisible under RLS -- proven by reading both back afterward under workspace A's own tenant scope. Added `"ErasureScrub"` to `COVERED_FAMILIES`.
- **Files modified:** `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
- **Verification:** `npx vitest run --root apps/worker src/queues/__tests__/negative-cross-tenant-jobs.test.ts` (17/17 pass); full `npx vitest run --root apps/worker` (524/524 pass); `npm run lint` and `npm run build` both pass.
- **Committed in:** `7ec0b97`

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 bug, 1 missing critical functionality)
**Impact on plan:** All three auto-fixes were necessary for correctness or an existing security gate the plan's own changes would otherwise have silently weakened. None changes the plan's specified allowlist, checkpoint storage, or page limit. No scope creep.

## Issues Encountered

The mid-page kill-resume test initially hung (high CPU, no progress) rather than failing cleanly -- traced via `process.stderr.write` breadcrumbs to the precision bug above: the keyset WHERE clause was re-including the same already-processed row on every page, an unbounded loop rather than a clean assertion failure. Resolved by the text round-trip fix documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CMP-04's evidence-hygiene half is complete: an erased contact's linked `send_events`/`events` rows carry only allowlisted evidence fields, the erasure record proves the scrub ran (or failed with a reason), and a kill at either boundary resumes correctly.
- Plan 13-14 must reproduce `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST`'s final contents (unchanged from the plan's specification) in `SPECIFICATION.md` §4 if it audits the schema section further; this plan already added §5.2/§5.15 documentation for the queue/worker itself.
- Plan 13-15's reclaimer (re-enqueueing a stranded `pending` erasure record) can safely call `runErasureScrub` again for any status other than `complete` -- the walk resumes from whatever cursor position exists, and `ERASURE_SCRUB_JOB_OPTIONS` is exported from `erasure-scrub.worker.ts` for that second producer to reuse rather than re-declare.
- No known stubs, skipped tests, or unrun `<verify>` steps from this plan.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-12*

## Self-Check: PASSED

- FOUND: apps/worker/src/queues/erasure-scrub.worker.ts
- FOUND: apps/worker/src/queues/erasure-scrub-checkpoint.ts
- FOUND: apps/worker/src/queues/__tests__/erasure-scrub.test.ts
- FOUND: apps/worker/src/queues/__tests__/failure-injection/erasure-scrub-resume.test.ts
- FOUND: .planning/phases/13-compliance-analytics-integrity/13-13-SUMMARY.md
- FOUND commit fb4e141 (Task 1)
- FOUND commit 3d30ec9 (Task 2)
- FOUND commit 3276db7 (Task 3)
- FOUND commit 7ec0b97 (Rule 2 fix: SEC-16 coverage gap)
- FOUND commit 0aaceb5 (docs: SUMMARY)
