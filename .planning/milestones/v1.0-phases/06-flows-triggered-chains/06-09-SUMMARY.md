---
phase: 06-flows-triggered-chains
plan: 09
subsystem: api
tags: [fastify, drizzle, postgres, flows, rls]

requires:
  - phase: 06-flows-triggered-chains
    provides: "flow lifecycle API (flow.repository.ts, flows.routes.ts, flow-version.repository.ts) and the flow_runs table (06-01/06-04)"
provides:
  - "flow-run.repository.ts: getRunCounts/listRuns (D-21 read-model), ejectRuns (single/bulk intervention), activeRunCount (D-22 guard primitive)"
  - "GET /flows/:id/runs, POST /flows/:id/runs/eject, DELETE /flows/:id wired into flows.routes.ts"
  - "deleteFlow's D-22 guard in flow.repository.ts"
affects: ["06-11 (flow detail canvas UI — consumes GET /flows/:id/runs for the run counter + eject action)"]

tech-stack:
  added: []
  patterns:
    - "Read-model counter pattern reused from campaign.repository.ts's getCampaignProgress (column-const + FILTER(WHERE) aggregate query)"
    - "Owner/Admin-gated destructive routes reuse the existing flow:publish permission (flow resource has only one gated action; pause/resume already reuse it identically)"

key-files:
  created:
    - apps/api/src/modules/flows/flow-run.repository.ts
    - apps/api/src/modules/flows/__tests__/flow-run-management.test.ts
  modified:
    - apps/api/src/modules/flows/flow.repository.ts
    - apps/api/src/modules/flows/flows.routes.ts
    - packages/shared-schemas/src/flow.ts

key-decisions:
  - "Reused requirePermission('flow', 'publish') for eject/delete gating instead of adding a new access-control action -- the flow resource's statement only defines 'publish' and pause/resume already reuse it for the same Owner/Admin cut, so this is the established convention, not a new one"
  - "Added flowRunListQuerySchema/flowRunEjectSchema to shared-schemas/src/flow.ts (not in the plan's files_modified) -- every other list/action route in this codebase validates via a matching zod schema; adding ad-hoc inline validation would have been the actual deviation"
  - "activeRunCount runs as its own withTenantTransaction (a separate connection from deleteFlow's FOR UPDATE-locked read), matching the plan's literal key_link (deleteFlow calls activeRunCount) rather than inlining the count query inside deleteFlow's own transaction"

patterns-established:
  - "D-21 run visibility: getRunCounts/listRuns join flow_runs to flows (for the live_version_id comparison) and to contacts (for display), computing onOldVersion as a boolean SQL expression rather than a second app-side lookup"

requirements-completed: [FLOW-06, FLOW-07, FLOW-01]

coverage:
  - id: D1
    description: "GET /flows/:id/runs reports active-run count and how many of those are pinned to a non-live version ('N in flow (M on old versions)', D-21/FLOW-07)"
    requirement: "FLOW-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-run-management.test.ts#D-21: run counts + list surface active runs and how many are on old (non-live) versions"
        status: pass
    human_judgment: false
  - id: D2
    description: "Eject (single via runIds, bulk via contactIds) marks matching active runs 'ejected' without ever re-pointing flow_version_id, and is Owner/Admin-gated (D-21/D-23/FLOW-07)"
    requirement: "FLOW-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-run-management.test.ts#D-21/D-23: eject (single via runIds, bulk via contactIds) marks matching active runs 'ejected' and is Owner/Admin-gated"
        status: pass
    human_judgment: false
  - id: D3
    description: "A flow is deletable only if never-published or paused with zero active runs; deleting otherwise is blocked with 409, and delete is Owner/Admin-gated (D-22/D-23)"
    requirement: "FLOW-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-run-management.test.ts#D-22/D-23: delete is blocked for a live flow, blocked for paused-with-active-runs, and Owner/Admin-gated"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-run-management.test.ts#D-22: a never-published draft flow is always deletable"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 09: Flow Run Visibility, Eject & Delete Guard Summary

**Read-model + destructive-action surface for in-flight flow runs: "N in flow (M on old versions)" counter, single/bulk eject, and a D-22-guarded flow delete — all wired into the existing flows module.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-10T05:52:00Z (approx, following 06-07 completion)
- **Completed:** 2026-07-10T06:02:00Z
- **Tasks:** 2
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments
- `flow-run.repository.ts`: `getRunCounts`/`listRuns` (active + on-old-versions read-model, D-21), `ejectRuns` (single/bulk, never migrates `flow_version_id` — FLOW-07), `activeRunCount` (D-22 guard primitive)
- `deleteFlow` added to `flow.repository.ts`: D-22 guard — deletable only if never-published or paused with zero active runs, else 409 `illegal_transition`
- Three new routes on `flows.routes.ts`: `GET /flows/:id/runs` (any member), `POST /flows/:id/runs/eject` and `DELETE /flows/:id` (both Owner/Admin, D-23)
- Integration test suite covering run counts, on-old-version flagging, single/bulk eject, role gating, and all four delete-guard branches (live/paused-with-runs/paused-zero-active/never-published)

## Task Commits

Each task was committed atomically:

1. **Task 1: flow-run.repository.ts — counters, run list, eject, active-run guard** - `0bcebb0` (feat)
2. **Task 2: Run/eject/delete routes + D-22 delete guard in flow.repository** - `3b14235` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/api/src/modules/flows/flow-run.repository.ts` - getRunCounts, listRuns, ejectRuns, activeRunCount
- `apps/api/src/modules/flows/flow.repository.ts` - added `deleteFlow` (D-22 guard)
- `apps/api/src/modules/flows/flows.routes.ts` - added GET runs / POST eject / DELETE routes + `toFlowRunSummaryResponse`
- `packages/shared-schemas/src/flow.ts` - added `flowRunListQuerySchema`, `flowRunEjectSchema`, `flowRunStatusSchema`
- `apps/api/src/modules/flows/__tests__/flow-run-management.test.ts` - new integration test suite (real HTTP + real Postgres)

## Decisions Made
- Reused `requirePermission("flow", "publish")` for eject/delete gating — the `flow` resource's access-control statement only ever defined `publish`, and pause/resume (06-04) already reuse it for the identical Owner/Admin cut, so this is the established convention, not a new permission action.
- `activeRunCount` is called from `deleteFlow` as a separate `withTenantTransaction` (its own connection), matching the plan's literal key_link (`deleteFlow calls activeRunCount`) rather than inlining the count query inside `deleteFlow`'s own `FOR UPDATE`-locked transaction. The `FOR UPDATE` lock on the `flows` row still prevents a concurrent publish/edit from racing the delete decision; a new run entering mid-check is an accepted, pre-existing race class in this codebase (segment/campaign delete guards use the same two-transaction shape).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `flowRunListQuerySchema`/`flowRunEjectSchema` to `packages/shared-schemas/src/flow.ts`**
- **Found during:** Task 2 (wiring the new routes)
- **Issue:** The plan's `files_modified` list for this plan did not include `packages/shared-schemas/src/flow.ts`, but every existing list/action route in this codebase (campaigns, segments, flows itself) validates its query/body through a matching zod schema exported from `shared-schemas` — the plan's own `flows.routes.ts` action already imports `flowListQuerySchema`/`updateFlowDraftSchema` from there. Skipping schema validation for the new routes would have been inconsistent with every sibling route and left `page`/`pageSize`/`status`/`runIds`/`contactIds` unvalidated.
- **Fix:** Added `flowRunStatusSchema`, `flowRunListQuerySchema` (page/pageSize/optional status filter, same `EXHAUSTIVE_LOOKUP_PAGE_SIZE` bound as `flowListQuerySchema`), and `flowRunEjectSchema` (`runIds`/`contactIds` arrays of UUIDs, `.refine` requiring at least one non-empty).
- **Files modified:** `packages/shared-schemas/src/flow.ts`
- **Verification:** `npm run build -w apps/api` clean; integration tests exercise both schemas (400 on missing eject payload was implicitly covered by the `.refine`, though not asserted directly — valid payloads are asserted in all four eject/list test cases).
- **Committed in:** `3b14235` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical — Rule 2)
**Impact on plan:** Necessary plumbing to keep the new routes consistent with the rest of the codebase's validation convention. No scope creep — no new business logic beyond what the plan specified.

## Issues Encountered
- Initial integration test attempt used `db.insert(flowRuns)` directly (the plain drizzle client, no ambient tenant context) and was rejected by Postgres RLS (`new row violates row-level security policy for table "flow_runs"`, error 42501) — `flow_runs` has `ENABLE + FORCE ROW LEVEL SECURITY` (06-01). Fixed by wrapping the fixture insert in `withTenant(workspaceId, () => withTenantTransaction(...))`, mirroring `apps/worker/src/test/db-fixture.ts`'s `createFixtureFlowRun` pattern. No production code was affected — this was a test-fixture-only fix.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- The flow detail page (06-11, not yet executed) can now call `GET /flows/:id/runs` for the "N in flow (M on old versions)" header and the eject action, and `DELETE /flows/:id` for a guarded delete flow.
- No new migrations required — this plan is pure repository/route logic on top of the existing 06-01 `flow_runs` schema and 06-04 flows module.
- Full `apps/api` test suite for `flows`/`campaigns`/`segments` (11 files, 44 tests, including the 4 new tests this plan added) passes; `npm run build` is clean across `db`, `shared-schemas`, `api`, and `worker`.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED
