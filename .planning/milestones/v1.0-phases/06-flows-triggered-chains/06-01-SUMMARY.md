---
phase: 06-flows-triggered-chains
plan: 01
subsystem: database
tags: [drizzle, postgres, rls, migrations, flows]

requires:
  - phase: 04-broadcast-campaigns
    provides: campaigns/sends ledger pattern (kind column, RESTRICT segment FK, RLS ENABLE+FORCE+NULLIF convention) that this plan extends for flows
  - phase: 03-segmentation
    provides: segments table this plan's flows.trigger_segment_id references with ON DELETE RESTRICT
provides:
  - Five new flow tables (flows, flow_versions, flow_runs, flow_run_steps, flow_segment_membership_snapshot) live in Postgres with RLS ENABLE+FORCE from their first migration
  - Immutable version storage model (flows.live_version_id -> flow_versions.definition, flow_runs.flow_version_id pin) satisfying FLOW-06/FLOW-07
  - sends.flow_run_id/node_id + sends_flow_run_node_unique partial unique index -- the DB-level idempotency guarantee for flow-step sends
  - contacts.timezone + workspace_send_settings default timezone/quiet-hours columns for later dispatch-time resolution
  - flow_runs_due_scan admin-scan SELECT-only policy for cross-tenant reconciliation/sweep worker discovery
affects: [06-flows-engine, 06-flows-triggers, 06-flows-api, 06-flows-ui]

tech-stack:
  added: []
  patterns:
    - "RLS ENABLE+FORCE+NULLIF-guarded workspace_isolation applied from the FIRST migration for every new table (no 0019-style follow-up fix needed)"
    - "Partial unique index (raw SQL, not Drizzle unique()) as the idempotency guarantee for a claim-based send/step insert"
    - "Admin-scan SELECT-only permissive policy for cross-tenant due-timer discovery, mirroring campaign-scheduler's precedent"

key-files:
  created:
    - packages/db/src/schema/flows.ts
    - packages/db/src/schema/flow-versions.ts
    - packages/db/src/schema/flow-runs.ts
    - packages/db/src/schema/flow-run-steps.ts
    - packages/db/src/schema/flow-segment-membership-snapshot.ts
    - packages/db/migrations/0026_flows.sql
    - packages/db/migrations/0027_flows_scheduler_scan_policy.sql
    - packages/db/migrations/0028_sends_flow_columns.sql
    - packages/db/migrations/0029_contacts_timezone.sql
    - packages/db/migrations/0030_workspace_send_settings_timezone_quiet_hours.sql
  modified:
    - packages/db/src/schema/sends.ts
    - packages/db/src/schema/contacts.ts
    - packages/db/src/schema/workspace-send-settings.ts
    - packages/db/src/index.ts
    - packages/db/migrations/meta/_journal.json

key-decisions:
  - "New flow schema files registered in packages/db/src/index.ts (the repo's actual barrel/export point), not packages/db/src/schema/index.ts as the plan's files_modified listed -- no schema/index.ts file exists in this codebase; every prior schema file follows the src/index.ts import+export convention"
  - "flows.draft_version_id/live_version_id are plain nullable uuid columns with no FK constraint (not references(flowVersions.id)) -- avoids a circular schema-file dependency (flow-versions.ts already references flows.id) and matches the plan's literal column description"

requirements-completed: [FLOW-06, FLOW-07, FLOW-01]

coverage:
  - id: D1
    description: "Five flow tables (flows, flow_versions, flow_runs, flow_run_steps, flow_segment_membership_snapshot) exist in the live database with RLS ENABLE+FORCE and NULLIF-guarded workspace_isolation policy"
    requirement: "FLOW-01"
    verification:
      - kind: other
        ref: "psql information_schema.tables count query + pg_class.relrowsecurity/relforcerowsecurity + pg_policies query (see Task 3 verification transcript)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Immutable published-version storage model: flows.live_version_id references a flow_versions row whose definition jsonb is never re-pointed for an in-flight run"
    requirement: "FLOW-06"
    verification:
      - kind: other
        ref: "packages/db/migrations/0026_flows.sql (flow_versions table, flow_runs.flow_version_id ON DELETE RESTRICT FK) + npm run build -w packages/db"
        status: pass
    human_judgment: false
  - id: D3
    description: "A flow-step send can be inserted into sends with kind='flow', a non-null flow_run_id and node_id, and a redelivered identical insert is rejected by the sends_flow_run_node_unique partial index"
    requirement: "FLOW-07"
    verification:
      - kind: other
        ref: "psql pg_indexes query confirming sends_flow_run_node_unique exists WHERE kind='flow' (see Task 3 verification transcript)"
        status: pass
    human_judgment: false
  - id: D4
    description: "contacts.timezone and workspace_send_settings default-timezone/quiet-hours columns exist for later dispatch-time resolution"
    verification:
      - kind: other
        ref: "psql information_schema.columns query confirming timezone, default_timezone, quiet_hours_start, quiet_hours_end, quiet_hours_enabled columns (see Task 3 verification transcript)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-10
status: complete
---

# Phase 6 Plan 1: Flow Storage Spine Summary

**Five new flow tables (flows/flow_versions/flow_runs/flow_run_steps/flow_segment_membership_snapshot) plus sends/contacts/workspace_send_settings extensions, applied and RLS-verified against the live Postgres database.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-10T03:31:00Z
- **Completed:** 2026-07-10T03:37:00Z
- **Tasks:** 3
- **Files modified:** 15

## Accomplishments
- Created the five Drizzle schema files (flows, flow-versions, flow-runs, flow-run-steps, flow-segment-membership-snapshot) with the immutable-version storage model (FLOW-06/FLOW-07): `flows.live_version_id` points at a `flow_versions` row whose `definition` jsonb is never mutated once published; `flow_runs.flow_version_id` is `ON DELETE RESTRICT` -- the run's immutability pin.
- Extended `sends.ts` with `flow_run_id`/`node_id`, `contacts.ts` with `timezone`, and `workspace_send_settings.ts` with `default_timezone`/`quiet_hours_start`/`quiet_hours_end`/`quiet_hours_enabled`.
- Wrote five hand-written SQL migrations (0026-0030): RLS `ENABLE`+`FORCE`+NULLIF-guarded `workspace_isolation` policy applied from the FIRST migration on all five new tables (no 0019-style follow-up fix needed); `flow_runs_due_scan` admin-scan SELECT-only policy for cross-tenant reconciliation/sweep worker discovery; `sends_flow_run_node_unique` partial unique index (`WHERE kind = 'flow'`) as the flow-send idempotency guarantee; `flow_runs_one_active_per_contact` partial unique index enforcing D-07's max-one-active-run-per-contact-per-flow invariant.
- Applied all five migrations to the live dev Postgres via `npm run db:migrate` and verified via `psql`: 5/5 flow tables present, RLS `relrowsecurity`/`relforcerowsecurity` both `true` on all five, `sends_flow_run_node_unique` and `flow_runs_one_active_per_contact` indexes present, `flow_runs_due_scan` and `workspace_isolation` policies present on the expected tables, and all new columns (`sends.flow_run_id`/`node_id`, `contacts.timezone`, `workspace_send_settings.default_timezone`/`quiet_hours_*`) confirmed live.

## Task Commits

Each task was committed atomically:

1. **Task 1: Drizzle schema files for five flow tables + send/contact/settings extensions** - `b2d4e29` (feat)
2. **Task 2: Hand-written SQL migrations (RLS + admin-scan + partial index) + journal entries** - `0bf8ece` (feat)
3. **Task 3: [BLOCKING] Apply migrations to the live database and verify tables + RLS** - no code changes (pure DB migration application via `npm run db:migrate`; verified via `psql`, no commit needed)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `packages/db/src/schema/flows.ts` - flows parent table + flowStatusEnum (draft/live/paused)
- `packages/db/src/schema/flow-versions.ts` - immutable version snapshot (definition jsonb)
- `packages/db/src/schema/flow-runs.ts` - per-contact run state + flowRunStatusEnum (waiting/advancing/completed/exited/ejected)
- `packages/db/src/schema/flow-run-steps.ts` - append-only per-node-visit log
- `packages/db/src/schema/flow-segment-membership-snapshot.ts` - segment-sweep diff tracking
- `packages/db/src/schema/sends.ts` - added flowRunId/nodeId columns
- `packages/db/src/schema/contacts.ts` - added timezone column
- `packages/db/src/schema/workspace-send-settings.ts` - added defaultTimezone/quietHours* columns
- `packages/db/src/index.ts` - registered all five new schema files in the barrel
- `packages/db/migrations/0026_flows.sql` - five tables + RLS + supporting indexes
- `packages/db/migrations/0027_flows_scheduler_scan_policy.sql` - flow_runs_due_scan admin policy
- `packages/db/migrations/0028_sends_flow_columns.sql` - sends flow columns + partial unique index
- `packages/db/migrations/0029_contacts_timezone.sql` - contacts.timezone column
- `packages/db/migrations/0030_workspace_send_settings_timezone_quiet_hours.sql` - workspace_send_settings columns
- `packages/db/migrations/meta/_journal.json` - journal entries 26-30 appended

## Decisions Made
- Barrel export target corrected to `packages/db/src/index.ts` (see Deviations below).
- `flows.draft_version_id`/`live_version_id` left as plain nullable `uuid` columns with no FK constraint, avoiding a circular import between `flows.ts` and `flow-versions.ts` (each references the other's table) -- matches the plan's literal column description, which specified no FK for these two pointers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Barrel export file path corrected from `packages/db/src/schema/index.ts` to `packages/db/src/index.ts`**
- **Found during:** Task 1
- **Issue:** The plan's `files_modified` and Task 1 acceptance criteria referenced `packages/db/src/schema/index.ts` as the barrel export to update. No such file exists in this codebase -- every existing schema file is imported/re-exported from `packages/db/src/index.ts` instead (confirmed: `ls packages/db/src/schema/` shows no `index.ts`; `packages/db/src/index.ts` contains all `import * as ...Schema from "./schema/*.js"` + `export * from "./schema/*.js"` statements and constructs the Drizzle client/schema object).
- **Fix:** Registered all five new schema files (imports, `schema` object spread, and `export *`) in `packages/db/src/index.ts`, following the exact existing convention.
- **Files modified:** `packages/db/src/index.ts`
- **Verification:** `npm run build -w packages/db` passes clean; the five new schema files are importable and exported from the package's actual entry point.
- **Committed in:** `b2d4e29` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary correction to match the repo's real barrel-export convention; no scope creep, no behavior change from what the plan intended.

## Issues Encountered
None - Postgres was already running locally (verified via `pg_isready -h localhost -p 5432`) and `scripts/migrate-dev.mjs` handled `.env` loading + `db:migrate` invocation without any interactive prompts, so Task 3's live-migration requirement completed cleanly on the first attempt.

## User Setup Required

None - no external service configuration required. Migrations applied against the existing local dev Postgres instance (already running per Phase 1-5 setup).

## Next Phase Readiness
- The five-table flow storage spine plus all cross-cutting column extensions are live in the database with correct RLS from day one -- every downstream plan in this phase (flows-core validation package, flow-version/flow-run repositories, trigger evaluator, engine advance worker, send extension, canvas UI) can now build directly against these tables.
- `sends_flow_run_node_unique` and `flow_runs_one_active_per_contact` are ready to be consumed by `claimFlowSend` (06-03) and the reconciliation/sweep workers (06-06 onward) respectively.
- No blockers identified for Wave 2 plans.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED

All 10 created files verified present on disk; all 3 task commit hashes (`b2d4e29`, `0bf8ece`, `ce98f23`) verified present in git log.
