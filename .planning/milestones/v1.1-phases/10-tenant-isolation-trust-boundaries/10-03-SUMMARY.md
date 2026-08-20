---
phase: 10-tenant-isolation-trust-boundaries
plan: 03
subsystem: database
tags: [postgres, rls, tenant-isolation, bullmq, worker, drizzle]

requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: "plan 10-01's mega_crm_scan role, withCrossWorkspaceScan helper, and migration 0041 tracer slice (campaigns-only)"
provides:
  - "Migration 0042: GRANT SELECT ON flow_runs, flows, contacts, sends, organization TO mega_crm_scan"
  - "Role-scoped scan policies flow_runs_scan / flows_scan carrying the narrowing predicates 0027/0032 never implemented"
  - "contacts_scan / sends_scan unrestricted-row SELECT policies (accepted risk T-10-03-02)"
  - "workspace_isolation TO mega_crm_app scoping on flow_runs, flows, contacts, sends"
  - "flow-reconciliation.worker.ts, flow-segment-sweep.worker.ts, analytics-reconciliation.worker.ts migrated onto withCrossWorkspaceScan"
  - "SPECIFICATION.md as-built update for the extended scan-role topology"
affects: [10-06-partition-guc-removal, 10-08-webhook-sibling-drop, phase-10-remaining-plans]

tech-stack:
  added: []
  patterns:
    - "Every scan-role consumer follows the identical transformation: replace pool.connect()/BEGIN/set_config('app.admin_scan')/COMMIT/release with one withCrossWorkspaceScan(...) call; per-tenant re-verification below it stays byte-unchanged"
    - "A scan policy's USING predicate mirrors its consumer's own WHERE clause verbatim -- role-scoping and predicate-narrowing are complementary, never substitutes for each other (Pitfall 3)"
    - "A table with no legitimate narrowing predicate (contacts, sends) gets an explicitly-commented unrestricted-row policy instead of a false one -- documented as accepted risk, not silently permissive"

key-files:
  created:
    - packages/db/migrations/0042_scan_role_grants_and_policies.sql
  modified:
    - packages/db/migrations/meta/_journal.json
    - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
    - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - packages/tenant-context/src/__tests__/scan.test.ts
    - SPECIFICATION.md

key-decisions:
  - "flow_runs_scan/flows_scan predicates restore the row-narrowing intent migrations 0027/0032 never implemented -- a deliberate correction, not an incidental tightening, per RESEARCH.md Pitfall 3"
  - "contacts_scan/sends_scan are unrestricted-row (USING true) by design -- neither reader (partition relocation, webhook sibling-drop) can predict which rows it needs in advance; column restriction to id/workspace_id is enforced in application code, not the policy (accepted risk T-10-03-02)"
  - "The four legacy marker-GUC policies (0027, 0032, 0039x2) are left in place, PUBLIC, inert for mega_crm_scan -- their removal is plan 10-06's coordinated cleanup, not this plan's side effect"

patterns-established:
  - "Consumer migration to withCrossWorkspaceScan is now proven on 4 of 5 named cross-tenant scan consumers (campaign-scheduler from 10-01, plus this plan's three)"

requirements-completed: [SEC-01, SEC-02]

coverage:
  - id: D1
    description: "Migration 0042 grants mega_crm_scan SELECT-only access to flow_runs, flows, contacts, sends, organization with narrowing predicates on flow_runs_scan/flows_scan"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "packages/db/migrations/0042_scan_role_grants_and_policies.sql -- npm run lint:migrations"
        status: pass
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#10-03 Test 1: reads waiting, past-wake flow_runs from two DIFFERENT workspaces in a single scan-pool query"
        status: pass
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#10-03 Test 2: a completed flow_run and a future-wake waiting flow_run are both invisible to the scan pool"
        status: pass
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#10-03 Test 3: a live segment-triggered flow in each of two workspaces is visible to the scan pool; a paused one is not"
        status: pass
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#10-03 Test 4: the scan pool can read organization ids across workspaces"
        status: pass
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts#Test 5 (10-01 tracer, superseded by 10-03's flow_versions case below)"
        status: pass
    human_judgment: false
  - id: D2
    description: "flow-reconciliation, flow-segment-sweep, and analytics-reconciliation all discover cross-workspace candidates through withCrossWorkspaceScan, not a session flag on the tenant pool"
    requirement: "SEC-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts -- 3/3 passing after migration"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts -- 8/8 passing after migration"
        status: pass
      - kind: other
        ref: "grep -c set_config apps/worker/src/queues/flows/flow-reconciliation.worker.ts == 0; grep -n admin_scan across all three migrated files == 0 matches"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-08-07
status: complete
---

# Phase 10 Plan 03: Extend scan-role grants + migrate flow-reconciliation/flow-segment-sweep/analytics-reconciliation to withCrossWorkspaceScan Summary

**Migration 0042 extends `mega_crm_scan` from the tracer's single `campaigns` grant to `flow_runs`, `flows`, `contacts`, `sends`, and `organization`, with role-scoped policies restoring the row-narrowing predicates two legacy GUC-gated policies never implemented; four of the phase's five named cross-tenant scan consumers now read through the single `withCrossWorkspaceScan` entry point.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3/3 completed
- **Files modified:** 7 (2 in Task 1, 4 in Task 2, 1 in Task 3)

## Accomplishments

- Migration `0042_scan_role_grants_and_policies.sql`: `GRANT SELECT ON flow_runs, flows, contacts, sends, organization TO mega_crm_scan` (SELECT-only, nothing else), four new role-scoped policies (`flow_runs_scan`, `flows_scan`, `contacts_scan`, `sends_scan`), four `ALTER POLICY workspace_isolation ... TO mega_crm_app` role-scoping statements on the tables the scan role can now reach.
- Closed RESEARCH.md Pitfall 3: `flow_runs_scan` and `flows_scan` restore the row-narrowing predicates (`status='waiting' AND next_wake_at<=now()`; `status='live' AND trigger_type='segment' AND trigger_segment_id IS NOT NULL AND live_version_id IS NOT NULL`) that the legacy GUC-gated `flow_runs_due_scan` (0027) and `flows_segment_sweep_scan` (0032) never carried — those two policies granted unconditional visibility to every row once the marker GUC was set; the new role-scoped policies never had that gap.
- `contacts_scan`/`sends_scan` deliberately carry `USING (true)` — commented as an accepted, bounded risk (T-10-03-02): the partition-relocation path and plan 10-08's webhook sibling-drop cannot predict which rows they need before reading them.
- `flow-reconciliation.worker.ts`'s `findDueFlowRunCandidates`, `flow-segment-sweep.worker.ts`'s `findLiveSegmentTriggeredFlows`, and `analytics-reconciliation.worker.ts`'s organization enumeration all replaced their `pool.connect()`/`BEGIN`/`set_config('app.admin_scan', ...)`/`COMMIT`/`release` scaffolding (or plain `pool.query`) with one `withCrossWorkspaceScan(...)` call each. Every per-tenant re-verification/write path below each discovery scan (`transitionAndNudge`, `sweepOneFlow`, `reconcileWorkspace`) is byte-unchanged.
- `scan.test.ts`: 4 new integration tests proving migration 0042's narrowing predicates against seeded rows a plain WHERE-clause-only reading would not have excluded (a `completed` flow_run, a future-wake `waiting` flow_run, a `paused` segment-triggered flow); the tracer's own superseded contacts-denial test updated to `flow_versions` (still ungranted) since `contacts` is now legitimately granted by this migration.
- SPECIFICATION.md SS4.3/SS5.6/SS5.7 updated to as-built; also corrected two pre-existing staleness bugs discovered while editing the same table this plan touches (SS4.3's "who sets app.admin_scan" column still named the pre-10-01 campaign-scheduler location; SS4.6's migration journal count was stuck at 41/idx-40, missing 0041).

## Task Commits

1. **Task 1: Migration 0042 — scan-role grants and narrowed, role-scoped policies** - `67bfcdf` (feat)
2. **Task 2: Move the three remaining worker scan consumers onto the shared helper** - `932e32c` (feat)
3. **Task 3: Record the extended role topology in SPECIFICATION.md** - `51997f6` (docs)

**Plan metadata:** commit_docs is enabled but `.planning/` is gitignored in this repo (worktree mode) — the final metadata commit step is expected to report `skipped_gitignored` for this SUMMARY, matching plan 10-01's precedent. STATE.md/ROADMAP.md are the orchestrator's responsibility after this worktree merges.

## Files Created/Modified

- `packages/db/migrations/0042_scan_role_grants_and_policies.sql` — grants + four role-scoped policies + four `ALTER POLICY ... TO mega_crm_app` statements
- `packages/db/migrations/meta/_journal.json` — journal entry idx 42
- `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` — `findDueFlowRunCandidates` migrated to `withCrossWorkspaceScan`; `transitionAndNudge` unchanged
- `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` — `findLiveSegmentTriggeredFlows` migrated to `withCrossWorkspaceScan`; `sweepOneFlow` unchanged
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` — organization enumeration migrated to `withCrossWorkspaceScan`; `reconcileWorkspace`/`reconcileWorkspaceDay` unchanged
- `packages/tenant-context/src/__tests__/scan.test.ts` — 4 new tests (flow_runs narrowing, flows narrowing, organization readability) + Test 5 updated from contacts to flow_versions
- `SPECIFICATION.md` — SS4.3 (migration 0042, corrected GUC-setter table), SS4.6/SS8.2b (journal count, 0042 precedent note), SS5.6/SS5.7 (three consumers on withCrossWorkspaceScan)

## Decisions Made

- Task 1/2/3's shape was fully specified by the plan (grants, exact predicates, exact transformation pattern from plan 10-01's precedent) — executed as written, no open decisions to make.
- Chose to also correct SPECIFICATION.md SS4.3's stale "who sets app.admin_scan" table and SS4.6's stale journal count while editing the same section this plan's Task 3 requires touching — both were pre-existing inaccuracies (the GUC table still named `campaign-scheduler.worker.ts`/`flow-reconciliation.worker.ts`/`flow-segment-sweep.worker.ts` as GUC-setters after plan 10-01 had already migrated the first of the three; the journal count was stuck at 41/idx-40 after plan 10-01 added 0041 without updating this line). Documented as an in-scope accuracy fix (Rule 1) rather than a separate deviation, since it is the exact same file/section this task's own acceptance criteria require editing.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug/spec correction] scan.test.ts's original Test 5 (contacts-denial) contradicted the new migration**
- **Found during:** Task 2, before writing new tests
- **Issue:** Plan 10-01's `scan.test.ts` asserted that a scan-pool query against `contacts` is refused with "permission denied" (no grant existed at that point). This plan's migration 0042 now `GRANT SELECT ON contacts TO mega_crm_scan`, so that assertion is now false and the test would fail.
- **Fix:** Updated the existing test to assert the same claim (a table with no grant is refused outright) against `flow_versions` instead, which remains ungranted by this migration set. Verified live: `SELECT id FROM flow_versions LIMIT 1` under `mega_crm_scan` still throws `permission denied for table flow_versions`.
- **Files modified:** `packages/tenant-context/src/__tests__/scan.test.ts`
- **Verification:** Full `scan.test.ts` suite passes (10/10).
- **Committed in:** `932e32c` (Task 2 commit)

**2. [Rule 1 - Doc accuracy] SPECIFICATION.md SS4.3's GUC table and SS4.6's journal count were stale from plan 10-01**
- **Found during:** Task 3, while editing SS4.3 for this plan's own acceptance criteria
- **Issue:** (a) The "Дополнительные GUC и bypass-политики" table's "Где ставится" column still listed `campaign-scheduler.worker.ts:40` as an `app.admin_scan` setter, even though plan 10-01 had already migrated that file off the GUC. (b) SS4.6 said "41 запись (0–40)" — stale by one migration after plan 10-01 added 0041 without updating this specific line.
- **Fix:** Corrected the GUC table to say "никем — легаси" for the three now-fully-migrated policies (campaigns/flow_runs/flows) and named `ensure-partitions.ts` as the sole remaining GUC-setter (for contacts/sends). Updated the journal count to 43 entries (0–42) and listed 0041/0042 in the snapshot-less migration count.
- **Files modified:** `SPECIFICATION.md`
- **Verification:** Re-read the corrected sections; all Task 3 `<verify>` greps still pass.
- **Committed in:** `51997f6` (Task 3 commit)

---

**Total deviations:** 2 (1 test-correction auto-fix, 1 doc-accuracy auto-fix)
**Impact on plan:** Both necessary for the plan's own `<verify>`/acceptance criteria to remain true after this plan's changes. No scope creep — both fixes are inside the exact files/sections this plan's tasks already require touching.

## Issues Encountered

- **Worktree had no `node_modules` at all** (unlike plan 10-01's worktree, which at least had stale symlinks): created `node_modules/@mega-crm/*` symlinks pointing at this worktree's own `apps/*`/`packages/*` directories, plus symlinks for every other top-level `node_modules` entry pointing at the main checkout's copies (all non-`@mega-crm/*` dependencies are identical across worktree and main checkout — no code under test lives there). `node_modules/` is gitignored — nothing tracked was touched. Required before any `npx vitest`/`npm run lint`/`npm run build` command would resolve `@mega-crm/*` imports at all.
- **`apps/web` build failure is pre-existing and unrelated** (identical finding to plan 10-01's SUMMARY): `npm run build --workspaces --if-present` fails on `@mega-crm/web` with `TS2688: Cannot find type definition file for 'vite/client'` — this worktree has no `apps/web/node_modules` (only `apps/api`/`apps/worker`/`packages/*` node_modules content is mirrored across the main checkout's dependency tree the same way for every package). This plan touches zero files under `apps/web`. All 11 other workspaces (`api`, `worker`, `db`, `contacts-core`, `delivery-core`, `flows-core`, `kms`, `segments-core`, `shared-schemas`, `tenant-context`, `test-support`) built cleanly with `tsc`.
- **Task 2's acceptance criterion `grep -c "set_config" apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` is literally 1, not 0** — the file legitimately contains ONE `set_config('statement_timeout', ...)` call inside `sweepOneFlow`'s per-tenant bulk-query path (pre-existing since 06-08, unrelated to the `app.admin_scan` GUC this plan removes). Verified the actual intent of the criterion (zero `app.admin_scan` references) holds: `grep -n admin_scan` across all three migrated files returns zero matches. Documenting this as a literal-vs-intent mismatch in the plan's acceptance criterion rather than removing the unrelated `statement_timeout` call, which is out of this plan's scope.

## User Setup Required

None — this plan applies only to database migrations (not yet live-applied to any dev database in this session; that step is optional per this plan, unlike plan 10-01's Task 2 which explicitly required it) and worker source files. No new environment variables, secrets, or external service configuration.

## Next Phase Readiness

- 4 of 5 named cross-tenant scan consumers (`campaign-scheduler` from 10-01; `flow-reconciliation`, `flow-segment-sweep`, `analytics-reconciliation` from this plan) now read through `withCrossWorkspaceScan` under `mega_crm_scan`. The fifth (partition maintenance/relocation, still on the `app.admin_scan` GUC via `ensure-partitions.ts`) is plan 10-06's subject, per the plan's own scope note.
- The four legacy marker-GUC policies (`campaign_scheduler_due_scan` 0018, `flow_runs_due_scan` 0027, `flows_segment_sweep_scan` 0032, `partition_relocation_admin_scan` x2 on `0039`) remain in the catalog, unscoped, inert for `mega_crm_scan` — plan 10-06 owns dropping the GUC pattern entirely, after its own checkpoint resolves the partition path (per this plan's own action step, unchanged from the plan's stated intent).
- `contacts_scan`/`sends_scan`'s unrestricted-row policies and their two known readers (partition relocation, webhook sibling-drop) are now the documented row-visibility contract plan 10-08 depends on (see this plan's own `key_links`).
- Migration 0042 has NOT been live-applied to any dev/staging database in this session (unlike 0041, which plan 10-01 applied live) — this plan's tasks did not include a live-apply step. The next environment that runs `npm run db:migrate` against a real Postgres cluster will pick it up automatically; no manual intervention beyond the standard migration pipeline is required.
- No blockers for continuing the phase's remaining plans.

## Self-Check: PASSED

- FOUND: packages/db/migrations/0042_scan_role_grants_and_policies.sql
- FOUND: apps/worker/src/queues/flows/flow-reconciliation.worker.ts (modified)
- FOUND: apps/worker/src/queues/flows/flow-segment-sweep.worker.ts (modified)
- FOUND: apps/worker/src/queues/analytics-reconciliation.worker.ts (modified)
- FOUND: packages/tenant-context/src/__tests__/scan.test.ts (modified)
- FOUND: SPECIFICATION.md (modified)
- FOUND commit: 67bfcdf
- FOUND commit: 932e32c
- FOUND commit: 51997f6

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-07*
