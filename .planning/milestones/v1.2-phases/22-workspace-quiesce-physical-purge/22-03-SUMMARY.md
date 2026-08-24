---
phase: 22-workspace-quiesce-physical-purge
plan: 03
subsystem: api
tags: [fastify, drizzle, bullmq, postgres, multi-tenancy, webhooks, api-keys]

requires:
  - phase: 22-workspace-quiesce-physical-purge (plan 01, same wave)
    provides: "the Owner-only soft-delete route (organization.deletedAt) this plan's checks read"
provides:
  - "isWorkspaceSoftDeletedById -- the single API-side fail-closed soft-delete lookup shared by apiKeyAuth and the webhook route"
  - "A typed 403 (code: workspace_deleted) on every API-key-authed surface (events, contacts) for a soft-deleted workspace"
  - "An indistinguishable generic 404 on the anonymous SendGrid webhook route for a soft-deleted workspace's pathToken"
  - "Fail-closed drain-window guards on both events-ingest and webhook-events BullMQ processors"
affects: [22-02, 22-04, 22-06, 22-09]

tech-stack:
  added: []
  patterns:
    - "Ingress quiesce check lives in the shared auth hook (apiKeyAuth), not on individual routes, so every present and future key-authed surface is covered by one check"
    - "Anonymous, unauthenticated surfaces (webhook) reuse the existing generic-failure response verbatim rather than adding a new distinguishable code/body -- no enumeration oracle"
    - "BullMQ processors resolve (not throw) on an intentional-refusal outcome, so BullMQ's retry/dead-letter machinery is never invoked for work that must simply never happen"

key-files:
  created:
    - apps/api/src/modules/events/__tests__/events-api-quiesce.test.ts
    - apps/api/src/modules/webhooks/__tests__/webhooks-quiesce.test.ts
    - apps/worker/src/queues/__tests__/workspace-quiesce-ingest.test.ts
  modified:
    - apps/api/src/modules/tenancy/workspace-lookup.ts
    - apps/api/src/modules/api-keys/api-key-auth.ts
    - apps/api/src/modules/webhooks/webhooks.routes.ts
    - apps/worker/src/queues/events-ingest.worker.ts
    - apps/worker/src/queues/webhook-events.worker.ts

key-decisions:
  - "Placed the soft-delete check inside apiKeyAuth itself, not scoped to the events route -- apiKeyAuth also fronts the public Contacts API, and D-04's purpose (no new PII in a workspace awaiting purge) covers both"
  - "Resolved RESEARCH Open Question 1 (bounded queue-drain window) as zero tolerance: both ingest workers get a dispatch-time guard rather than accepting the window as a documented gap"
  - "22-02's shared packages/delivery-core/src/workspace-quiesce.ts had not landed on this branch yet (parallel wave), so Task 3 adds an identical fail-closed rule as a local, TODO(22-02)-marked duplicate in each of the two worker files, per the plan's own contingency instruction -- to be deleted by whichever of 22-02/22-03 merges second"

patterns-established:
  - "Pattern: workspace-state quiesce checks are placed at the earliest point workspaceId is known, before any body parse / signature verification / tenant write -- proven identically on 4 distinct entry points (API-key hook, webhook route, 2 BullMQ processors)"

requirements-completed: [PRG-06]

coverage:
  - id: D1
    description: "Every API-key-authenticated surface (events, contacts) refuses a soft-deleted workspace with a typed 403 (code: workspace_deleted) before any write, while a live workspace and an invalid key are unaffected"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api-quiesce.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "A signed SendGrid webhook for a soft-deleted workspace is answered with a response byte-identical to the unknown-pathToken 404, before signature verification, with no ingress_journal/quarantine row and no enqueue -- while a live workspace is unaffected"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-quiesce.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "A job already in the events-ingest or webhook-events queue when its workspace was soft-deleted resolves without throwing and writes zero contacts/events/send_events rows, while a live workspace still ingests"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-ingest.test.ts"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-23
status: complete
---

# Phase 22 Plan 03: Ingestion-Side Workspace Quiesce Summary

**Fail-closed `isWorkspaceSoftDeletedById` refuses a soft-deleted workspace on every ingress path -- API-key hook (403), anonymous webhook (indistinguishable 404), and both BullMQ ingest processors (silent drop) -- closing PRG-06's ingestion half.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-08-23
- **Tasks:** 3 (all `type="auto" tdd="true"`, no checkpoints)
- **Files modified:** 5 implementation files, 3 new test files (8 total)

## Accomplishments
- Every API-key-authenticated surface (events, contacts, and any future one) refuses a soft-deleted workspace with a typed 403 (`code: workspace_deleted`) from a single shared check inside `apiKeyAuth` itself
- The anonymous SendGrid webhook route drops a soft-deleted workspace's signed batch as the SAME bare 404 the unknown-pathToken branch already returns -- proven indistinguishable by comparing the two live responses against each other, not against a literal
- Closed the BullMQ queue-drain window: a job already queued when its workspace was soft-deleted now resolves quietly (never throws, never dead-letters) and writes nothing, on both `events-ingest` and `webhook-events`

## Task Commits

Each task followed the RED -> GREEN TDD cycle with two commits:

1. **Task 1: API-key-authenticated surfaces refuse a soft-deleted workspace with a typed 403**
   - `515816e` test(22-03): add API-key-surface soft-delete refusal test (RED)
   - `ec26c8b` feat(22-03): refuse API-key surfaces for a soft-deleted workspace (GREEN)
2. **Task 2: The anonymous webhook surface drops a deleted workspace as an indistinguishable 404**
   - `111e7e1` test(22-03): add webhook indistinguishable-404 quiesce test (RED)
   - `f26357a` feat(22-03): drop a soft-deleted workspace's webhook as the generic 404 (GREEN)
3. **Task 3: Close the queue-drain window on both ingest workers**
   - `d93be6d` test(22-03): add ingest-worker drain-window drop test (RED)
   - `e6900cb` feat(22-03): close the ingest-worker queue-drain window (GREEN)

**Plan metadata:** this commit (docs: complete plan)

## Files Created/Modified

- `apps/api/src/modules/tenancy/workspace-lookup.ts` - adds `isWorkspaceSoftDeletedById(workspaceId)`: fail-closed (refuses on non-null `deletedAt` AND on a missing row)
- `apps/api/src/modules/api-keys/api-key-auth.ts` - `apiKeyAuth` calls the lookup after key verification, before setting `request.apiKeyWorkspaceId`/`apiKeyScopes`; replies 403 with `{ error, code: "workspace_deleted" }` on `true`
- `apps/api/src/modules/webhooks/webhooks.routes.ts` - calls the lookup immediately after `findWebhookEndpointByToken` resolves an endpoint, before signature verification; replies with the SAME bare `reply.code(404).send()` the unknown-pathToken branch uses
- `apps/worker/src/queues/events-ingest.worker.ts` - local `isWorkspaceSoftDeletedForIngest` guard at the top of `processEventIngestJob`, before any tenant write or flow-trigger fan-out
- `apps/worker/src/queues/webhook-events.worker.ts` - local `isWorkspaceSoftDeletedForWebhookEvents` guard at the top of `processWebhookEventBatch`, before extraction/insert
- `apps/api/src/modules/events/__tests__/events-api-quiesce.test.ts` - 4 cases: events refused, contacts refused (hook-level proof), live workspace unaffected, invalid key still 401
- `apps/api/src/modules/webhooks/__tests__/webhooks-quiesce.test.ts` - 4 cases: indistinguishable 404, no journal/quarantine/enqueue, signature-not-reached, live workspace unchanged
- `apps/worker/src/queues/__tests__/workspace-quiesce-ingest.test.ts` - 3 cases: events-ingest dropped, webhook-events dropped, live workspace still ingests

## Decisions Made

- **Hook-level placement (not route-level):** `apiKeyAuth` also fronts the Contacts API, which writes contact PII -- D-04's stated purpose ("nothing accumulates new PII in a workspace awaiting purge") covers both surfaces, and one check in the shared hook covers every present and future key-authed route without needing to remember it per-route.
- **Zero-tolerance drain-window closure:** RESEARCH Open Question 1 (the bounded window between soft-delete and an already-queued job draining) is resolved as zero tolerance rather than an accepted gap -- both ingest processors get the identical guard, since it is two lines once the lookup pattern exists.
- **22-02 helper not yet landed:** `packages/delivery-core/src/workspace-quiesce.ts` (plan 22-02, same wave, parallel worktree) was not present on this branch when Task 3 ran. Per the plan's own contingency instruction, Task 3 added an identical fail-closed rule as two local, `TODO(22-02)`-marked duplicates (`isWorkspaceSoftDeletedForIngest` in events-ingest.worker.ts, `isWorkspaceSoftDeletedForWebhookEvents` in webhook-events.worker.ts). Whichever of 22-02/22-03 merges second must delete these local copies in favour of importing the shared helper -- both are marked in-code for that removal.

## Deviations from Plan

None (Rules 1-4) beyond the plan's own explicitly anticipated contingency (22-02 helper not yet on branch, handled per the plan's own read_first instruction for Task 3, documented above as a Decision rather than a deviation since the plan itself specified this exact fallback).

## Issues Encountered

- **Cross-file BullMQ queue-count flake:** `webhooks-signature.test.ts`'s "tampered signature" and "missing signature header" cases assert on the SHARED `webhookEventsQueue`'s global `waiting` job count as a before/after delta. Adding `webhooks-quiesce.test.ts` (which also enqueues real jobs on the same shared queue) introduced a third concurrently-running file racing that global count -- exactly the flake class `webhooks-signature.test.ts`'s own header comment already documents. Confirmed non-deterministic: failed once, then passed 10/10 files on immediate rerun with no code change. Not fixed (out of this plan's scope; the flake is a pre-existing test-isolation gap in `webhooks-signature.test.ts`, not something Task 2 introduced) -- noted here for visibility.
- **Known-flaky/deterministic environment failures observed during full-suite regression runs (`npm run test -w apps/api`, `npm run test -w apps/worker`), none caused by this plan's changes:** `sentry.test.ts` "no DSN" (deterministic on this machine per project's own documented environment note), `failed-send-share-watchdog.test.ts` dedup test 11 (pre-documented flaky test).

## User Setup Required

None - no external service configuration required.

## Self-Check: PASSED

All files referenced above exist on disk; all six commit hashes are present in `git log`.

## Next Phase Readiness

- The ingestion half of PRG-06/D-04 is closed: a soft-deleted workspace accepts no new data via any API key, any webhook, or any already-queued ingest job.
- `isWorkspaceSoftDeletedById` (apps/api) is now available for any future API-key-authed or webhook-adjacent route to reuse without a second hand-rolled query.
- **Follow-up required at merge time (not blocking this plan):** once plan 22-02 lands `packages/delivery-core/src/workspace-quiesce.ts` (`isWorkspaceSoftDeleted`, `WORKSPACE_DELETED_EXCLUSION_REASON`), the two `TODO(22-02)`-marked local lookups in `apps/worker/src/queues/events-ingest.worker.ts` and `apps/worker/src/queues/webhook-events.worker.ts` must be deleted and replaced with imports from that shared module -- both are flagged in-code for whichever plan merges second to action.
- No blockers for 22-04 (discovery-query quiesce) or 22-06/22-09 (purge/watchdog) -- this plan touches only the ingress entry points, not campaign/flow discovery or physical deletion.

---
*Phase: 22-workspace-quiesce-physical-purge*
*Completed: 2026-08-23*
