---
phase: 06-flows-triggered-chains
plan: 13
subsystem: infra
tags: [flows-engine, quiet-hours, drizzle, vitest, gap-closure]

# Dependency graph
requires:
  - phase: 06-flows-triggered-chains
    provides: flow-run-advance.worker.ts's queue-as-doorbell engine (06-05), per-flow quiet-hours deferral (06-07), unique-per-wake advance nudges (06-12)
provides:
  - One canonical quiet_hours_mode vocabulary ("workspace_default" | "custom" | "disabled") shared by the API/UI shared-schema, the DB column default, and the worker
  - resolveQuietHoursWindow in send-node.ts branches on the real API/UI-persisted 'custom' value, so a flow's own quiet-hours window is actually honored
  - Migration 0034 corrects the flows.quiet_hours_mode DB default and data-migrates any stray legacy rows
affects: [06-flows-triggered-chains phase verification, 06-14]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hand-written migrations (not drizzle-kit generate output) for schema changes made after migrations 0026-0033 broke the drizzle-kit snapshot lineage -- meta/ has no snapshot for those hand-written migrations, so drizzle-kit generate re-derives a full-table-recreate diff against the stale 0025 baseline instead of a minimal incremental change"

key-files:
  created: []
  modified:
    - apps/worker/src/queues/flows/handlers/send-node.ts
    - apps/worker/src/queues/flows/flow-run-advance.worker.ts
    - packages/db/src/schema/flows.ts
    - packages/db/migrations/0034_flows_quiet_hours_mode_canonical.sql
    - packages/db/migrations/meta/0034_snapshot.json
    - packages/db/migrations/meta/_journal.json
    - apps/worker/src/queues/__tests__/flow-run-advance.test.ts
    - packages/shared-schemas/src/campaign.ts

key-decisions:
  - "Canonical quiet_hours_mode vocabulary is \"workspace_default\" | \"custom\" | \"disabled\" (the API/UI/shared-schema vocabulary, since it is what flow.repository.ts actually persists) -- the worker's legacy \"inherit\"/\"override\" vocabulary was retired, not the other way around"
  - "resolveQuietHoursWindow's else branch (now covering 'workspace_default' AND any unrecognized/legacy value) fails toward the workspace-default window, never toward \"no gate\" (T-06-13-01)"
  - "0034's SQL migration is hand-written rather than using drizzle-kit generate's raw output -- drizzle-kit generate produced a full-table-recreate diff (CREATE TABLE for every flow table, ALTER for contacts.timezone, etc.) because packages/db/migrations/meta/ has no snapshot for the hand-written 0026-0033 migrations, so its lineage jumps straight from 0025 to a stale full re-derivation; only the actual incremental ALTER DEFAULT + data-migration UPDATEs were kept, mirroring the existing hand-written-migration convention already used for 0026-0033"
  - "The drizzle-kit-generated 0034_snapshot.json WAS kept as-is (not hand-edited) -- unlike the SQL file, a snapshot stores the full current schema state, not a diff, so it correctly reflects reality and its prevId correctly chains to 0025's id"

requirements-completed: [FLOW-05]

coverage:
  - id: D1
    description: "A flow saved with quiet_hours_mode 'custom' (the exact value the API/UI persist) defers sends inside its configured window -- closes CR-02 / roadmap success criterion 3"
    requirement: "FLOW-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-07/06-13/D-08/D-14/Pitfall 4/CR-02: a send node inside its flow's custom quiet-hours window defers -- NO send job, next_wake_at = window end"
        status: pass
    human_judgment: false
  - id: D2
    description: "quiet_hours_mode 'workspace_default' (with the workspace default disabled) does NOT defer -- only 'custom' engages a flow's own window, proving the fix is value-specific"
    requirement: "FLOW-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-run-advance.test.ts#06-13/CR-02 regression: quiet_hours_mode 'workspace_default' with the workspace default disabled does NOT defer"
        status: pass
    human_judgment: false
  - id: D3
    description: "flows.quiet_hours_mode DB default corrected to 'workspace_default'; migration 0034 data-migrates any stray legacy rows (inherit->workspace_default, override->custom)"
    requirement: "FLOW-05"
    verification:
      - kind: other
        ref: "drizzle-kit migrate exit 0 against local dev DB; information_schema.columns.column_default = 'workspace_default'::text (verified via psql)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-10
status: complete
---

# Phase 06 Plan 13: Quiet-hours vocabulary unification (CR-02) Summary

**Retired the worker's legacy `"inherit"|"override"|"disabled"` quiet_hours_mode vocabulary in favor of the API/UI's real `"workspace_default"|"custom"|"disabled"` values, so a flow saved with a custom quiet-hours window actually defers sends inside it instead of silently falling back to the workspace default.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-10
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- `send-node.ts`'s `resolveQuietHoursWindow` now branches on `'custom'` (the value `QuietHoursCard.tsx` + `flow.repository.ts` actually persist) instead of the legacy, never-matched `'override'` value -- a flow's explicitly configured window is honored again
- Both `send-node.ts`'s `FlowQuietHoursConfig.quietHoursMode` and `flow-run-advance.worker.ts`'s `FlowRunAdvanceRow.quietHoursMode` are now typed with the shared `FlowQuietHoursMode` from `@mega-crm/shared-schemas`, closing off future vocabulary drift at the type level
- `packages/db/src/schema/flows.ts`'s `quiet_hours_mode` column default corrected from `'inherit'` to `'workspace_default'`; migration 0034 alters the live DB default and data-migrates any stray legacy rows (none existed in the local dev DB, but the UPDATEs are idempotent and value-scoped for any environment that does have them)
- The existing quiet-hours deferral test now seeds `'custom'` (proving the real API-writable value defers) plus a new companion test proving `'workspace_default'` (with quiet hours disabled) does NOT defer -- together pinning down that the fix is value-specific, not just "any truthy window"
- Full worker vitest suite: 91/91 passing after the change

## Task Commits

Each task was committed atomically:

1. **Task 1: Worker adopts the canonical quiet_hours_mode vocabulary and branches on 'custom'** - `fc183b8` (fix)
2. **Task 2 [BLOCKING]: Correct the DB default + generate/apply migration with legacy-row data migration** - `3462cab` (fix)
3. **Task 3: Worker regression test — a flow with a 'custom' quiet-hours window defers the send** - `e92fb69` (test)

**Additional deviation commit:** `a3780be` (docs) -- stale vocabulary reference fix in `campaign.ts` (see Deviations)

**Plan metadata:** (this commit)

## Files Created/Modified
- `apps/worker/src/queues/flows/handlers/send-node.ts` - `FlowQuietHoursConfig.quietHoursMode` typed with shared `FlowQuietHoursMode`; `resolveQuietHoursWindow` branches on `'custom'`
- `apps/worker/src/queues/flows/flow-run-advance.worker.ts` - `FlowRunAdvanceRow.quietHoursMode` typed with shared `FlowQuietHoursMode`
- `packages/db/src/schema/flows.ts` - `quiet_hours_mode` column default `'inherit'` -> `'workspace_default'`
- `packages/db/migrations/0034_flows_quiet_hours_mode_canonical.sql` - new: ALTER default + legacy-row data migration
- `packages/db/migrations/meta/0034_snapshot.json` - new: drizzle-kit-generated full current-schema snapshot (kept as-is; correctly chains from 0025)
- `packages/db/migrations/meta/_journal.json` - new idx-34 journal entry, tag renamed to match the hand-written filename
- `apps/worker/src/queues/__tests__/flow-run-advance.test.ts` - quiet-hours test reseeded on `'custom'`; new `'workspace_default'`-does-not-defer regression test; `seedDelayFlowRun`'s default fallback changed to `'workspace_default'`
- `packages/shared-schemas/src/campaign.ts` - doc-comment fix (see Deviations)

## Decisions Made
- Canonical vocabulary chosen: `"workspace_default" | "custom" | "disabled"` (matches what `flow.repository.ts` actually writes) -- the worker's vocabulary was the one that had to change, not the schema's
- `resolveQuietHoursWindow`'s else branch fails toward the workspace-default window for `'workspace_default'` AND any unrecognized/legacy value, never toward "no gate" (T-06-13-01 mitigation)
- 0034's SQL is hand-written rather than drizzle-kit's raw generated output; the generated `0034_snapshot.json` was kept unmodified since it correctly represents full current schema state (see Issues Encountered)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1/Rule 3 - Blocking] `drizzle-kit generate` produced a full-table-recreate migration instead of the expected minimal ALTER**
- **Found during:** Task 2
- **Issue:** `packages/db/migrations/meta/` has snapshot files only up through `0025_snapshot.json` -- migrations `0026`-`0033` were hand-written directly (per prior phase decisions, mirroring the 03-02/04-01 precedent) without ever running `drizzle-kit generate` to produce a matching snapshot. Running `drizzle-kit generate` for this plan's schema change therefore diffed the CURRENT schema against the STALE `0025` baseline, producing `CREATE TABLE flow_run_steps/flow_runs/flow_versions/flows`, several `ALTER TABLE ... ADD COLUMN` statements for columns already live in the DB (added by 0026-0033), plus the one ALTER this plan actually needed -- all bundled into one file. Applying that file as-is against the real dev DB would have failed immediately on the first `CREATE TABLE` (relation already exists).
- **Fix:** Renamed the generated file to `0034_flows_quiet_hours_mode_canonical.sql` per the plan's instruction, then replaced its SQL body with a hand-written, minimal migration containing only `ALTER TABLE flows ALTER COLUMN quiet_hours_mode SET DEFAULT 'workspace_default'` plus the two legacy-row data-migration `UPDATE`s -- mirroring the same hand-written-migration convention already established for 0026-0033. The drizzle-kit-generated `0034_snapshot.json` was kept unchanged, since a snapshot stores the full CURRENT schema state (not a diff) and its `prevId` correctly chains from `0025`'s `id` -- it is accurate and useful for any future `drizzle-kit generate` call.
- **Files modified:** `packages/db/migrations/0034_flows_quiet_hours_mode_canonical.sql` (hand-written content), `packages/db/migrations/meta/0034_snapshot.json` (kept from generate, unmodified), `packages/db/migrations/meta/_journal.json` (tag renamed from `0034_special_terror` to match the filename)
- **Verification:** `drizzle-kit migrate` applied cleanly (exit 0) against the local dev database; `psql` confirmed `column_default = 'workspace_default'::text` on `flows.quiet_hours_mode` post-migration.
- **Committed in:** `3462cab` (Task 2 commit)

**2. [Rule 1 - Doc accuracy] Stale `'inherit'` vocabulary reference in `campaign.ts`**
- **Found during:** post-Task-3 sweep for any other consumer of the legacy vocabulary
- **Issue:** A doc comment on `workspaceSendSettingsSchema` in `packages/shared-schemas/src/campaign.ts` (not in this plan's `files_modified`) still read `a flow's quiet_hours_mode: 'inherit' falls back to` -- directly stale as a consequence of this plan's vocabulary unification.
- **Fix:** Updated the comment to `'workspace_default'`.
- **Files modified:** `packages/shared-schemas/src/campaign.ts`
- **Verification:** `npx tsc --noEmit` in `packages/shared-schemas` passes (comment-only change).
- **Committed in:** `a3780be`

---

**Total deviations:** 2 auto-fixed (1 Rule 1/3 blocking migration-generation fix, 1 Rule 1 doc-accuracy fix)
**Impact on plan:** Both fixes were necessary consequences of the plan's own instructed steps (running `drizzle-kit generate`, unifying the vocabulary) hitting a pre-existing repo condition (the meta/ snapshot gap) and a stale cross-package doc reference respectively. No scope creep -- neither touched flow behavior beyond what the plan specified.

## Issues Encountered
- The `drizzle-kit generate` full-table-recreate issue (see Deviations #1) is a pre-existing condition of this repo's migration history (0026-0033 were hand-written without snapshots), not something introduced by this plan. It will resurface for ANY future `drizzle-kit generate` call against the flows/sends/contacts/workspace_send_settings tables until a snapshot lineage gap is closed (out of this plan's scope) -- worth flagging for whoever next needs to hand-write vs. generate a migration touching those tables.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- CR-02 is closed: roadmap success criterion 3 ("no email is sent inside the quiet window, and it is deferred until the window ends") is now achievable for the exact per-flow custom-window configuration path the UI exposes.
- Remaining 06-VERIFICATION.md gap (CR-03) is tracked in the separate 06-14 gap-closure plan, which the git log shows was already executed on this branch ahead of this plan's commits.
- Migration-generation gap noted above (meta/ snapshot lineage stops at 0025) is a latent trap for future schema changes to the flows/sends/contacts/workspace_send_settings tables -- not blocking, but worth a note if a future phase's plan assumes `drizzle-kit generate` alone is sufficient for those tables.

---
*Phase: 06-flows-triggered-chains*
*Completed: 2026-07-10*

## Self-Check: PASSED
- FOUND: apps/worker/src/queues/flows/handlers/send-node.ts
- FOUND: apps/worker/src/queues/flows/flow-run-advance.worker.ts
- FOUND: packages/db/src/schema/flows.ts
- FOUND: packages/db/migrations/0034_flows_quiet_hours_mode_canonical.sql
- FOUND: apps/worker/src/queues/__tests__/flow-run-advance.test.ts
- FOUND commit: fc183b8
- FOUND commit: 3462cab
- FOUND commit: e92fb69
- FOUND commit: a3780be
- FOUND commit: 6aa073d
