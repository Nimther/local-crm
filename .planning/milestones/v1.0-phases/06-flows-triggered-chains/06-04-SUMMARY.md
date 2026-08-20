---
phase: 06-flows-triggered-chains
plan: 04
subsystem: api
tags: [fastify, postgres, jsonb, rls, flows, state-machine, versioning]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains (06-01)
    provides: flows/flow_versions tables, immutable-version storage model, RLS-scoped schema
  - phase: 06-flows-triggered-chains (06-02)
    provides: flowDefinitionSchema/validateFlowDefinition (@mega-crm/flows-core), createFlowSchema/updateFlowDraftSchema (@mega-crm/shared-schemas)
provides:
  - "Flow CRUD + lifecycle API: createFlow/getFlow/listFlows/updateFlowDraft/publishFlow/pauseFlow/resumeFlow/duplicateFlow (apps/api/src/modules/flows/flow.repository.ts)"
  - "Immutable version read/write helpers: snapshotDraftToVersion/getPinnedVersion (flow-version.repository.ts)"
  - "flows.routes.ts registered in server.ts: GET/POST /flows, GET/PATCH /flows/:id, POST publish/pause/resume/duplicate, Owner/Admin gate on publish/pause/resume (D-23)"
  - "Segment restrict-delete extended to block deletion when referenced by a flow trigger/branch/exit (D-24, referenced_by_flow)"
  - "flows.exit_conditions jsonb column (migration 0031) -- gap-fill for a 06-02 DTO field that had no column to persist it"
affects: [06-05, 06-06, 06-10, 06-11]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Every route handler builds its FULL response (including any nested withTenantTransaction-backed lookups like getPinnedVersion) inside a single withTenant(...) closure -- AsyncLocalStorage context exits the instant the outer callback's promise settles, so anything awaited AFTER `await withTenant(...)` runs with no tenant context"
    - "jsonb ARRAY columns (as opposed to jsonb OBJECT columns) must be JSON.stringify'd explicitly before binding as a pg query param -- node-postgres's prepareValue special-cases a raw JS Array into a Postgres ARRAY literal ('{...}'), not JSON text, which is invalid input for a jsonb column"
    - "D-20 single-working-draft: publish clears draft_version_id to NULL (not eagerly recreated); the next updateFlowDraft call lazily creates a fresh flow_versions row copied from the live definition"

key-files:
  created:
    - apps/api/src/modules/flows/flow.repository.ts
    - apps/api/src/modules/flows/flow-version.repository.ts
    - apps/api/src/modules/flows/flow-validation.ts
    - apps/api/src/modules/flows/flows.routes.ts
    - apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts
    - packages/db/migrations/0031_flows_exit_conditions.sql
  modified:
    - apps/api/src/modules/segments/segment.repository.ts
    - apps/api/src/server.ts
    - apps/api/package.json
    - packages/db/src/schema/flows.ts
    - packages/db/migrations/meta/_journal.json
    - package-lock.json

key-decisions:
  - "flows.exit_conditions jsonb column added via a new migration (0031) -- updateFlowDraftSchema (06-02) already accepted an exitConditions field but 0026_flows.sql never added a column to persist it; a gap-fill, not an architectural change"
  - "publishFlow clears flows.draft_version_id to NULL rather than eagerly allocating a new draft row -- resolves an ambiguity in the plan's prose ('create a fresh empty draft_version_id') in favor of the literal, testable acceptance criterion ('updateFlowDraft auto-creates a single working draft ... on first edit')"
  - "flows.routes.ts registered in apps/api/src/server.ts, not apps/api/src/app.ts -- no app.ts file exists in this codebase (mirrors 06-01's identical barrel-path correction precedent for packages/db/src/index.ts)"
  - "updateFlowDraft mirrors a definition's (single) trigger node onto flows.trigger_type/trigger_event_name/trigger_segment_id whenever `definition` changes, so D-24's restrict-delete check can query these columns directly without parsing jsonb on every delete"
  - "apps/api added @mega-crm/flows-core as an explicit package.json dependency (previously only resolved via workspace hoisting)"

patterns-established:
  - "FlowStateError carries an optional `details: FlowValidationError[]` (beyond CampaignStateError's message+code shape) so publishFlow's 'incomplete' rejection can surface the D-17 hard-error list all the way to the route's 422 {fields} response"

requirements-completed: [FLOW-01, FLOW-06, FLOW-07, FLOW-04, FLOW-05]

coverage:
  - id: D1
    description: "A Member can create a flow and save its draft (nodes/edges + reentry + quiet-hours-override + exit-conditions) via POST /flows + PATCH /flows/:id"
    requirement: "FLOW-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#publish rejects an incomplete definition server-side (422 + fields) and succeeds once valid (D-17)"
        status: pass
    human_judgment: false
  - id: D2
    description: "publishFlow re-runs validateFlowDefinition server-side inside the publish transaction and rejects the D-17 hard errors with a 422 {fields} breakdown -- never trusts a client isValid flag"
    requirement: "FLOW-06"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#publish rejects an incomplete definition server-side (422 + fields) and succeeds once valid (D-17)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Publish atomically snapshots the draft into an immutable flow_versions row (published_at stamped) and points flows.live_version_id at it; draft_version_id is cleared for D-20's lazy single-working-draft model"
    requirement: "FLOW-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#pause/resume enforce legal transitions (live<->paused) and D-20 lazily recreates a draft on first post-publish edit"
        status: pass
    human_judgment: false
  - id: D4
    description: "Publish/pause/resume are Owner/Admin-only (D-23); draft CRUD + duplicate remain Member-allowed"
    requirement: "FLOW-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#D-23: publish/pause/resume are Owner/Admin-only; draft CRUD + duplicate remain Member-allowed"
        status: pass
    human_judgment: false
  - id: D5
    description: "Deleting a segment referenced by a flow trigger/branch/exit is blocked (409 conflict, code referenced_by_flow)"
    requirement: "FLOW-05"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts#D-24: a segment referenced by a flow trigger cannot be deleted"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 4: Flow API (draft CRUD, atomic publish, lifecycle, restrict-delete) Summary

**Fastify flow API mirroring campaigns' repository/routes shape -- draft CRUD, an atomically-validated publish that snapshots an immutable flow_versions row, pause/resume/duplicate, Owner/Admin gating on state transitions (D-23), and a segment restrict-delete extension (D-24) -- all verified against a real Postgres test database.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-10T08:57:00+05:00
- **Completed:** 2026-07-10T09:24:31+05:00
- **Tasks:** 3 (plus a gap-fill migration and a post-task test/bugfix pass)
- **Files modified:** 12

## Accomplishments
- `flow.repository.ts`: `FLOW_COLUMNS`, `FlowStateError` (illegal_transition|incomplete|not_found, with an optional `details: FlowValidationError[]` for 422 rejections), `createFlow`/`getFlow`/`listFlows`/`updateFlowDraft`/`publishFlow`/`pauseFlow`/`resumeFlow`/`duplicateFlow`. `updateFlowDraft` implements D-20's single-working-draft model (lazily recreates a draft from the live definition on the first edit after publish) and mirrors a definition's trigger node onto `flows.trigger_type`/`trigger_event_name`/`trigger_segment_id`.
- `flow-version.repository.ts`: `snapshotDraftToVersion` (client-scoped, stamps `published_at` inside the SAME transaction as `publishFlow`'s other writes -- true atomicity, not two separate transactions) and `getPinnedVersion` (standalone read).
- `flow-validation.ts` + `flows.routes.ts`: full flow lifecycle API (`GET`/`POST /flows`, `GET`/`PATCH /flows/:id`, `POST .../publish|pause|resume|duplicate`), `mapFlowStateError` (404/409/422+fields), `toFlowResponse` (includes the best-current-editable `definition`, joined via `getPinnedVersion`). Publish/pause/resume gated via `requirePermission("flow", "publish")` (D-23); draft CRUD + duplicate remain Member-allowed. Registered in `apps/api/src/server.ts` (no `app.ts` exists in this codebase).
- `segment.repository.ts`: `deleteSegment` extended with `findReferencingFlowName` -- checks `flows.trigger_segment_id`, `flows.exit_conditions` (jsonb array), and any `flow_versions.definition` branch/trigger node referencing the segment (draft or published). The DB-level `23503` catch now disambiguates flow vs. campaign origin, defaulting to `referenced_by_flow` when a flow reference is found.
- Gap-fill migration `0031_flows_exit_conditions.sql`: `flows.exit_conditions` jsonb column -- `updateFlowDraftSchema` (06-02) already accepted this field but no column existed to persist it. Applied and verified live against the dev database.
- New `apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts` (5 tests, real-Postgres HTTP integration mirroring `campaign-state-machine.test.ts`): D-17 publish re-validation, pause/resume transitions, D-20 lazy draft recreation, duplicate, D-23 role gating, D-24 segment restrict-delete. All 5 pass; full `apps/api` suite (206/206) passes.

## Task Commits

Each task was committed atomically:

1. **Task 1: flow.repository.ts + flow-version.repository.ts (CRUD, publish, lifecycle, versioning)** - `b43993e` (feat)
2. **Task 2: flow-validation.ts + flows.routes.ts with role gating + error mapping, registered in server** - `e752fb2` (feat)
3. **Task 3: Extend segment restrict-delete to block flow references (D-24)** - `4583cd3` (feat)
4. **Post-task verification pass: integration tests + two runtime bug fixes found by running them** - `6d58516` (test)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `apps/api/src/modules/flows/flow.repository.ts` - FLOW_COLUMNS, FlowStateError, createFlow/getFlow/listFlows/updateFlowDraft/publishFlow/pauseFlow/resumeFlow/duplicateFlow
- `apps/api/src/modules/flows/flow-version.repository.ts` - snapshotDraftToVersion (client-scoped), getPinnedVersion
- `apps/api/src/modules/flows/flow-validation.ts` - shapeFlowValidationFields (D-17 hard errors -> {fields} breakdown)
- `apps/api/src/modules/flows/flows.routes.ts` - full flow lifecycle API, role gating, mapFlowStateError, toFlowResponse
- `apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts` - 5 real-Postgres integration tests
- `apps/api/src/modules/segments/segment.repository.ts` - findReferencingFlowName + deleteSegment D-24 extension
- `apps/api/src/server.ts` - registerFlowsRoutes registered alongside campaigns/segments
- `apps/api/package.json` - added @mega-crm/flows-core dependency
- `packages/db/src/schema/flows.ts` - added exitConditions jsonb column
- `packages/db/migrations/0031_flows_exit_conditions.sql` - flows.exit_conditions column (gap-fill)
- `packages/db/migrations/meta/_journal.json` - journal entry for migration 0031
- `package-lock.json` - lockfile entry for the new apps/api -> @mega-crm/flows-core dependency

## Decisions Made
- `flows.exit_conditions` jsonb column added via migration 0031 -- a gap-fill for a field `updateFlowDraftSchema` (06-02) already accepted with no column to persist it (see Deviations).
- `publishFlow` clears `flows.draft_version_id` to `NULL` rather than eagerly creating a new draft row at publish time, resolving an ambiguity in the plan's prose in favor of the literal, testable acceptance criterion ("updateFlowDraft auto-creates a single working draft ... on first edit").
- `flows.routes.ts` registered in `apps/api/src/server.ts`, since no `app.ts` file exists in this codebase (identical precedent to 06-01's `packages/db/src/schema/index.ts` -> `packages/db/src/index.ts` correction).
- `updateFlowDraft` mirrors a definition's trigger node onto `flows.trigger_type`/`trigger_event_name`/`trigger_segment_id` on every `definition` change, so D-24's restrict-delete check can query these columns directly.
- `apps/api` added `@mega-crm/flows-core` as an explicit `package.json` dependency (build previously succeeded only via npm workspace hoisting, which is not a reliable guarantee).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `flows.exit_conditions` jsonb column (migration 0031)**
- **Found during:** Task 1
- **Issue:** `updateFlowDraftSchema` (06-02, `packages/shared-schemas/src/flow.ts`) already accepts an `exitConditions` array field, and this plan's own must-haves require persisting it, but no column exists on `flows` (verified: `packages/db/src/schema/flows.ts` and `0026_flows.sql` have no `exit_conditions` column). Without it, exit conditions could never be saved at all.
- **Fix:** Added `flows.exit_conditions jsonb DEFAULT '[]' NOT NULL` via a new migration (`0031_flows_exit_conditions.sql`) and the corresponding Drizzle schema column; applied to the live dev database and verified via `psql \d flows`.
- **Files modified:** `packages/db/src/schema/flows.ts`, `packages/db/migrations/0031_flows_exit_conditions.sql`, `packages/db/migrations/meta/_journal.json`
- **Verification:** `npm run build -w packages/db` clean; `psql` confirms the column exists live.
- **Committed in:** `b43993e` (Task 1 commit)

**2. [Rule 3 - Blocking] `flows.routes.ts` registered in `apps/api/src/server.ts`, not `apps/api/src/app.ts`**
- **Found during:** Task 2
- **Issue:** The plan's `files_modified` and interfaces section referenced `apps/api/src/app.ts` as the Fastify app-assembly file to register the new route plugin in. No such file exists in this codebase -- the actual file is `apps/api/src/server.ts` (`buildServer()`), which every other route plugin (campaigns, segments, contacts, etc.) is registered in.
- **Fix:** Registered `registerFlowsRoutes` in `apps/api/src/server.ts`, following the exact existing convention (import + `await app.register(...)` alongside `registerCampaignsRoutes`).
- **Files modified:** `apps/api/src/server.ts`
- **Verification:** `npm run build -w apps/api` clean; route reachable in integration tests.
- **Committed in:** `e752fb2` (Task 2 commit)

**3. [Rule 1 - Bug] `toFlowResponse`'s definition lookup ran outside its tenant-context scope, throwing "No tenant context set" on every route**
- **Found during:** post-task integration test run (all 5 new tests initially failed with a 500)
- **Issue:** Every route handler called `await withTenant(workspace.id, () => someRepoCall())` and THEN, on the next line, `await toFlowResponse(result)` -- but `toFlowResponse` internally calls `getPinnedVersion`, which uses `withTenantTransaction`'s ambient `AsyncLocalStorage` context. That context exits the instant the outer `withTenant(...)` callback's promise settles, so `toFlowResponse` ran with no tenant context bound at all.
- **Fix:** Restructured every handler (list/create/get/patch/publish/pause/resume/duplicate) to build its FULL response, including the `toFlowResponse` call, inside a single `withTenant(workspace.id, async () => {...})` closure.
- **Files modified:** `apps/api/src/modules/flows/flows.routes.ts`
- **Verification:** All 5 new integration tests pass; full `apps/api` suite (206/206) passes.
- **Committed in:** `6d58516`

**4. [Rule 1 - Bug] `exit_conditions` (a jsonb ARRAY column) written as a raw JS array produced a Postgres `22P02` (invalid json) error**
- **Found during:** post-task integration test run
- **Issue:** node-postgres's own `prepareValue` special-cases a bare JS `Array` param into a Postgres ARRAY literal (`{...}`), not JSON text -- correct behavior for `text[]`/`int[]` columns, but wrong for a `jsonb` column storing an array. `definition` (a plain object) is unaffected since `pg` `JSON.stringify`s plain objects automatically; only the array-typed `exit_conditions` column hit this.
- **Fix:** Added `toJsonbArrayParam` (explicit `JSON.stringify`) and applied it at both write sites (`updateFlowDraft`'s `UPDATE flows` and `duplicateFlow`'s `INSERT INTO flows`).
- **Files modified:** `apps/api/src/modules/flows/flow.repository.ts`
- **Verification:** All 5 new integration tests pass; full `apps/api` suite (206/206) passes.
- **Committed in:** `6d58516`

---

**Total deviations:** 4 auto-fixed (1 missing-critical gap-fill, 1 blocking path-correction, 2 bugs caught by integration testing)
**Impact on plan:** All four were necessary corrections for correctness (persisting a documented DTO field, registering routes in the app that actually exists, and two runtime bugs that would have made every flow route and every exit-conditions write fail in production). No scope creep beyond what the plan's own must-haves required.

## Issues Encountered
The two Rule-1 bugs (tenant-context scope, jsonb array serialization) were only caught because a real-Postgres integration test suite was added and run before finalizing the plan -- `npm run build` alone (the plan's own `<verify>` step) could not have caught either, since both are runtime-only failures (a thrown error at request time, and a Postgres-side type-coercion error). No blockers remained after the fixes; both were resolved within the same session.

## User Setup Required

None - no external service configuration required. Migration 0031 applied against the existing local dev Postgres instance (already running per Phase 1-6 setup).

## Next Phase Readiness
- The flow lifecycle API is live, tested, and ready for the canvas UI (06-10/06-11) to drive directly.
- `getPinnedVersion` is ready for the trigger/engine workers (06-05/06-06) to read live/pinned versions from.
- `flows.trigger_type`/`trigger_event_name`/`trigger_segment_id` are kept in sync with the canvas definition on every draft edit -- the trigger evaluator worker (06-05) can query these columns directly without parsing jsonb.
- No blockers identified for downstream wave-2/wave-3 plans.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 7 created files verified present on disk (flow.repository.ts, flow-version.repository.ts, flow-validation.ts, flows.routes.ts, flow-lifecycle.test.ts, 0031_flows_exit_conditions.sql, this SUMMARY); all 5 task commit hashes (b43993e, e752fb2, 4583cd3, 6d58516, 1bb2c70) verified present in git log.
