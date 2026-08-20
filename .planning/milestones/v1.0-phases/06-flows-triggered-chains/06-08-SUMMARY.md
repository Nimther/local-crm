---
phase: 06-flows-triggered-chains
plan: 08
subsystem: worker
tags: [bullmq, postgres, flows, segmentation, branching, bulk-diff, resumable-cursor]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains (06-05)
    provides: "flow-run-advance.worker.ts's node-type dispatch (send/exit/delay handlers), flow_run_steps outcome vocabulary, resolveNextNodeId"
  - phase: 06-flows-triggered-chains (06-06)
    provides: "flow-trigger-evaluator.worker.ts (event-driven trigger matching), canEnterFlow re-entry decision, flow_runs_one_active_per_contact partial unique index"
  - phase: segments (Phase 3)
    provides: "isContactInSegment / compileSegmentDefinition -- the single shared segment engine, reused here rather than reimplemented"
provides:
  - "handleBranchNode (apps/worker/src/queues/flows/handlers/branch-node.ts) -- binary yes/no branch routing via segment point-check, registered in flow-run-advance.worker.ts's dispatcher"
  - "Segment-entry trigger, hybrid detection (D-02): event-driven re-check (checkSegmentEntryForContact, runs on every flow-trigger-check job) + periodic bulk sweep (flow-segment-sweep.worker.ts, 15-min tick)"
  - "enterSegmentTriggeredFlow (exported from flow-trigger-evaluator.worker.ts) -- the ONE entry primitive both the event re-check and the sweep route a newly-matching contact through"
  - "flow_segment_membership_snapshot diffing -- O(flows) bulk queries, never O(flows x contacts) point-check loops"
  - "D-04 enroll-existing on publish: GET /flows/:id/enroll-preview + publish route's enrollExisting flag + flow-enroll-existing.worker.ts's resumable-cursor batch (true) / bulk seed-only (false)"
affects: [06-11]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bulk per-segment query diffed against a membership snapshot (flow_segment_membership_snapshot), NOT a per-contact isContactInSegment loop across the workspace -- the load-bearing anti-Pitfall-1 shape reused by both the sweep and the enroll-existing worker"
    - "One shared entry primitive (enterSegmentTriggeredFlow) consumed by three call sites (event re-check, sweep, enroll-existing-true) -- canEnterFlow decision + version-pinned flow_runs INSERT + advance enqueue + unconditional snapshot upsert, never duplicated"
    - "Resumable-cursor batch enroll (flows.enroll_cursor, keyset-paginated on contacts.id) for genuinely per-row external work (canEnterFlow + conditional INSERT), vs. a single INSERT...SELECT bulk statement for the seed-only path which has no per-contact external work at all"
    - "Admin-scan cross-tenant discovery (SELECT-only, app.admin_scan-gated permissive RLS policy) followed by per-flow withTenant re-scoping before any read/write -- mirrors campaign-scheduler.worker.ts's two-phase split, applied to a new resource (flows) via a new migration"

key-files:
  created:
    - apps/worker/src/queues/flows/handlers/branch-node.ts
    - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
    - apps/worker/src/queues/flows/flow-enroll-existing.worker.ts
    - apps/api/src/modules/flows/flow-queues.ts
    - apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts
    - packages/db/migrations/0032_flows_segment_sweep_scan_policy.sql
    - packages/db/migrations/0033_flows_enroll_cursor.sql
  modified:
    - apps/worker/src/queues/flows/flow-run-advance.worker.ts
    - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
    - apps/worker/src/server.ts
    - apps/api/src/modules/flows/flow.repository.ts
    - apps/api/src/modules/flows/flows.routes.ts
    - packages/db/src/schema/flows.ts
    - packages/shared-schemas/src/flow.ts
    - packages/shared-schemas/src/queues.ts

key-decisions:
  - "Every flow-trigger-check job (event- or contact-change-driven) ALSO runs the segment-entry re-check unconditionally -- since an ingested event always upserts the contact, the SAME job doubles as D-02a's 'contact changed' signal for segment-triggered flows, with no separate hook needed on contact PATCH/CSV import for v1 (event-ingestion coverage + the 15-min sweep close the remaining gap)"
  - "flow_segment_membership_snapshot semantics are permanent-seen, not toggle-on-exit: once a contact is recorded as seen for a flow, leaving and re-entering the trigger segment later does NOT re-trigger entry -- matches the plan's literal diff-against-snapshot design; re-entry within the SAME initial match is governed by canEnterFlow's reentryMode as usual"
  - "flowEnrollExistingJobSchema carries the enrollExisting boolean itself (not a separate seed-only queue/route) -- both D-04 choices are handled by ONE worker/queue, keeping the publish route a thin enqueue-only call and making both paths testable from apps/worker's own test suite"
  - "flows.enroll_cursor (new nullable uuid column, migration 0033) added for the resumable batch's keyset pagination -- Rule 2 gap-fill: campaigns.snapshot_cursor's equivalent didn't exist yet for flows"
  - "0032's flows_segment_sweep_scan admin-scan SELECT policy added as a new migration (Rule 2 gap-fill) -- the existing 0027 admin-scan policy only covers flow_runs, not flows itself, which the sweep's cross-tenant discovery needs"
  - "apps/api/src/modules/flows/flow-queues.ts created new (Rule 2 gap-fill) -- mirrors campaigns' producer(apps/api)/consumer(apps/worker) queue split; no equivalent flow-queues.ts existed on the apps/api side yet"

patterns-established:
  - "flow_run_steps outcome vocabulary extended with 'branched_yes'/'branched_no' for the branch node type"
  - "loadEntryNodeId exported from flow-trigger-evaluator.worker.ts for reuse by flow-enroll-existing.worker.ts -- the trigger-node-to-entry-node resolution is now a shared primitive across all three entry paths (event, segment re-check/sweep, enroll-existing)"

requirements-completed: [FLOW-02, FLOW-03, FLOW-01]

coverage:
  - id: D1
    description: "A conditional branch node routes the contact down the yes or no edge based on isContactInSegment-shaped point-check at the step boundary (binary, D-12/D-13)"
    requirement: "FLOW-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#a branch routes the 'yes' edge for a contact currently in the segment"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#a branch routes the 'no' edge for a contact NOT currently in the segment"
        status: pass
    human_judgment: false
  - id: D2
    description: "A contact entering a trigger segment is detected via event-driven re-check after a contact change (D-02a)"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#D-02a: the event-driven flow-trigger-check job also enrolls a contact newly matching a segment-triggered flow"
        status: pass
    human_judgment: false
  - id: D3
    description: "A contact entering a trigger segment is ALSO detected via a periodic bulk-diff sweep as the time-based safety net (D-02b), and does not re-enroll an already-seen contact"
    requirement: "FLOW-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#the sweep enrolls a contact newly matching the trigger segment and records the snapshot"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#the sweep does NOT re-enroll a contact already recorded in the membership snapshot"
        status: pass
    human_judgment: false
  - id: D4
    description: "Publishing a segment-triggered flow can enroll current segment members (batch, respecting canEnterFlow) or seed the snapshot only (future entrants only), D-04"
    requirement: "FLOW-01"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#enrollExisting=true creates a run for every current segment member"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts#enrollExisting=false only seeds the snapshot -- no runs are created for current members"
        status: pass
    human_judgment: false
  - id: D5
    description: "The sweep uses a bulk per-segment query diffed against the snapshot, not an O(flows x contacts) point-check loop"
    verification:
      - kind: other
        ref: "grep confirms flow-segment-sweep.worker.ts issues ONE compileSegmentDefinition-derived bulk contacts query per flow, diffed in-process against flow_segment_membership_snapshot; no isContactInSegment-shaped per-contact loop present"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 8: Branch node + segment-entry trigger (event re-check + sweep) + enroll-existing on publish Summary

**Binary branch routing via the shared segment engine's point-check, a hybrid segment-entry trigger (event-driven re-check on every contact-change job PLUS a 15-min bulk-diff sweep), and the D-04 publish-time choice to back-fill existing segment members via a resumable cursor batch or seed-only future-entrants path.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-07-10T11:05:00Z
- **Completed:** 2026-07-10T11:30:47Z
- **Tasks:** 3
- **Files modified:** 15 (8 created, 7 modified — includes the follow-up test commit)

## Accomplishments
- `handlers/branch-node.ts`: `handleBranchNode` resolves the branch node's referenced segment definition on-the-fly and routes to the `yes`/`no` outgoing edge (via `sourceHandle`) based on a point-check against `@mega-crm/segments-core`'s `compileSegmentDefinition` (same primitive `isContactInSegment` wraps -- never a second segment implementation). Registered in `flow-run-advance.worker.ts`'s dispatcher alongside send/delay/exit, appending a `flow_run_steps` row with outcome `branched_yes`/`branched_no`.
- `flow-trigger-evaluator.worker.ts` extended: every `flow-trigger-check` job now ALSO runs `checkSegmentEntryForContact` (D-02a) -- for each live segment-triggered flow not yet recorded in `flow_segment_membership_snapshot`, a point-check determines new membership, and `enterSegmentTriggeredFlow` (newly exported) routes the contact through `canEnterFlow` + a version-pinned `flow_runs` INSERT + advance enqueue, marking the snapshot seen regardless of the entry decision.
- New `flow-segment-sweep.worker.ts` (D-02b safety net): a 15-min repeatable admin-scan discovery of every live segment-triggered flow across every tenant, followed by ONE compiled bulk `contacts` query per flow (never a per-contact `isContactInSegment` loop -- the explicit anti-Pitfall-1 shape), diffed in-process against the snapshot to find newly-matching contacts and enroll them via the same `enterSegmentTriggeredFlow` primitive. New migration `0032` adds the `flows_segment_sweep_scan` admin-scan SELECT policy the discovery scan needs (only `flow_runs` had one before this plan).
- `GET /flows/:id/enroll-preview` returns `countSegmentMembers` for a segment-triggered flow's trigger segment (D-04's "~N contacts" number). The publish route now always enqueues a `flow-enroll-existing` job for a segment-triggered flow, carrying the marketer's `enrollExisting` choice; `publishFlow` returns `segmentTriggered`/`triggerSegmentId` so the route can decide. New `apps/api/src/modules/flows/flow-queues.ts` producer (mirrors `campaign-queues.ts`'s split).
- New `flow-enroll-existing.worker.ts`: `enrollExisting=true` loops a resumable, keyset-paginated batch (persisted `flows.enroll_cursor`, new migration `0033`) routing each current segment member through `canEnterFlow` + run creation + advance enqueue, bounded per batch (no giant transaction); `enrollExisting=false` runs a single bulk `INSERT...SELECT` that only seeds the snapshot, creating zero runs.
- New integration test `flow-segment-trigger.test.ts` (7 cases, real Postgres/Redis): branch yes/no routing, the event-driven segment re-check, the sweep's enroll-new + skip-already-seen behavior, and both enroll-existing choices. Full `apps/worker` (88/88) and `apps/api` (218/218) suites pass with no regressions; every workspace package builds clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Binary branch-node handler + register in dispatcher** - `176c653` (feat)
2. **Task 2: Segment-entry trigger — event re-check + periodic sweep + snapshot** - `a0857d7` (feat)
3. **Task 3: Enroll-existing on publish (count preview + resumable batch)** - `42dbaad` (feat)
4. **Follow-up: direct test coverage for the event-driven re-check path** - `6372626` (test)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `apps/worker/src/queues/flows/handlers/branch-node.ts` - handleBranchNode (D-12/D-13 binary segment-based branch)
- `apps/worker/src/queues/flows/flow-run-advance.worker.ts` - registers the branch dispatch branch
- `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts` - checkSegmentEntryForContact, enterSegmentTriggeredFlow (exported), loadEntryNodeId (exported)
- `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` - runFlowSegmentSweepTick, createFlowSegmentSweepWorker (D-02b)
- `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts` - processFlowEnrollExisting, createFlowEnrollExistingWorker (D-04)
- `apps/worker/src/server.ts` - registers the sweep + enroll-existing workers
- `apps/api/src/modules/flows/flow.repository.ts` - publishFlow returns segmentTriggered/triggerSegmentId
- `apps/api/src/modules/flows/flows.routes.ts` - GET enroll-preview + publish route enqueues flow-enroll-existing
- `apps/api/src/modules/flows/flow-queues.ts` - flowEnrollExistingQueue producer (new)
- `packages/db/src/schema/flows.ts` - enrollCursor column
- `packages/db/migrations/0032_flows_segment_sweep_scan_policy.sql` - admin-scan SELECT policy on flows (new)
- `packages/db/migrations/0033_flows_enroll_cursor.sql` - flows.enroll_cursor column (new)
- `packages/shared-schemas/src/flow.ts` - publishFlowSchema (enrollExisting)
- `packages/shared-schemas/src/queues.ts` - FLOW_ENROLL_EXISTING_QUEUE + flowEnrollExistingJobSchema
- `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` - 7 integration tests (new file)

## Decisions Made
- Every `flow-trigger-check` job (event- or contact-change-driven) unconditionally also runs the segment-entry re-check -- an ingested event always upserts the contact, so the SAME job doubles as D-02a's "contact changed" signal; no separate hook exists yet for contact PATCH/CSV import (v1 path, closed by event-ingestion coverage + the sweep).
- `flow_segment_membership_snapshot` is a permanent "seen" marker, not a toggle -- once recorded, a contact leaving and re-entering the trigger segment later does not re-trigger entry. This matches the plan's literal diff-against-snapshot design.
- Both D-04 choices (back-fill vs. seed-only) are handled by ONE worker/queue (`flowEnrollExistingJobSchema.enrollExisting`), keeping the publish route a thin enqueue-only call and both paths independently testable in `apps/worker`.
- `flows.enroll_cursor` (new column, migration 0033) and `flows_segment_sweep_scan` (new admin-scan policy, migration 0032) were added as Rule-2 gap-fills -- neither existed yet and both are required for the batch/sweep to function per the plan's explicit resumable-cursor and bulk-diff requirements.
- `apps/api/src/modules/flows/flow-queues.ts` created new (Rule 2) to mirror the campaigns module's producer/consumer queue split -- no flow-side producer queue file existed in apps/api yet.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `flows.enroll_cursor` column + migration**
- **Found during:** Task 3
- **Issue:** The plan requires a "resumable-cursor" batch enroll, but no persisted cursor column existed on `flows` (unlike `campaigns.snapshot_cursor`, which `recipient-snapshot.ts` relies on) -- without it, the batch could not actually resume across worker restarts/redeliveries.
- **Fix:** Added `enroll_cursor` (nullable uuid) via new migration `0033_flows_enroll_cursor.sql` and the matching Drizzle schema field.
- **Files modified:** `packages/db/migrations/0033_flows_enroll_cursor.sql`, `packages/db/src/schema/flows.ts`
- **Verification:** `flow-enroll-existing.worker.ts`'s batch persists/reads `enroll_cursor` in the same transaction as its work; integration test passes.
- **Committed in:** `42dbaad` (Task 3 commit)

**2. [Rule 2 - Missing Critical] Added `flows_segment_sweep_scan` admin-scan RLS policy (new migration)**
- **Found during:** Task 2
- **Issue:** The sweep's cross-tenant discovery scan needs to SELECT across every tenant's `flows` rows before it knows which workspace each belongs to -- the existing admin-scan policy (migration 0027) only covers `flow_runs`, not `flows` itself.
- **Fix:** Added migration `0032_flows_segment_sweep_scan_policy.sql`, a SELECT-only permissive policy on `flows` gated by `app.admin_scan='true'`, mirroring 0018/0027 exactly.
- **Files modified:** `packages/db/migrations/0032_flows_segment_sweep_scan_policy.sql`
- **Verification:** `runFlowSegmentSweepTick`'s cross-tenant discovery query succeeds in the integration test against real Postgres/RLS.
- **Committed in:** `a0857d7` (Task 2 commit)

**3. [Rule 2 - Missing Critical] Created `apps/api/src/modules/flows/flow-queues.ts` (new producer file)**
- **Found during:** Task 3
- **Issue:** The plan requires the publish route to "enqueue a flow-enroll-existing job", but no BullMQ producer for a flow queue existed on the apps/api side (only apps/worker's `flow-queues.ts` had producer instances, none reachable from apps/api routes).
- **Fix:** Added a new file mirroring `apps/api/src/modules/campaigns/campaign-queues.ts`'s exact convention (own `buildRedisConnectionOptions`, plain ioredis options never a constructed client).
- **Files modified:** `apps/api/src/modules/flows/flow-queues.ts` (new)
- **Verification:** `apps/api` builds clean; publish route enqueues successfully in test.
- **Committed in:** `42dbaad` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (all Rule 2 - missing critical functionality)
**Impact on plan:** All three additions were structurally required for the plan's own explicit acceptance criteria (resumable cursor, admin-scan discovery, publish-route enqueue) to actually function -- no scope creep beyond what the plan itself specified.

## Issues Encountered
None. Postgres and Redis were already running locally; every workspace package (`packages/db`, `packages/shared-schemas`, `packages/segments-core`, `packages/flows-core`, `apps/api`, `apps/worker`, `apps/web`) built clean throughout, and the full `apps/worker` (88/88) and `apps/api` (218/218) test suites passed with no regressions at each checkpoint.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- The flow engine's backend surface is now complete for FLOW-01/02/03: trigger (event + segment, hybrid detection), delay/wait, branch, send, exit, re-entry control, exit conditions, and both segment-trigger publish choices. 06-11 (UI) can wire `useEnrollPreview`/`usePublishFlow(enrollExisting)` directly against this plan's `GET /flows/:id/enroll-preview` and the widened publish route -- both were designed with 06-11's documented API contract in mind.
- `flow_run_steps.outcome` vocabulary now includes `branched_yes`/`branched_no`, consistent with the established per-node-type convention.
- No blockers identified for 06-11.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 7 created files verified present on disk (branch-node.ts, flow-segment-sweep.worker.ts, flow-enroll-existing.worker.ts, flow-queues.ts, flow-segment-trigger.test.ts, migrations 0032/0033); all 4 commit hashes (176c653, a0857d7, 42dbaad, 6372626) verified present in git log.
