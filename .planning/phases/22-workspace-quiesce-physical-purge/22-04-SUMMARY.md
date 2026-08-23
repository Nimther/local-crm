---
phase: 22-workspace-quiesce-physical-purge
plan: 04
subsystem: database
tags: [postgres, rls, migrations, bullmq, worker, gdpr, scan-role]

requires:
  - phase: 22-workspace-quiesce-physical-purge (plan 22-01)
    provides: purge_records checkpoint table, organization.purgedAt tombstone column, and migration 0069 as the last-shipped migration this plan's 0070 chains after
provides:
  - "Migration 0070: campaigns_scan, flows_scan and flow_runs_scan re-created with a soft-delete exclusion predicate (NOT EXISTS against organization.\"deletedAt\"), predicates otherwise preserved verbatim"
  - "apps/worker/src/queues/analytics-reconciliation.worker.ts: findLiveWorkspaceIds -- the organization enumeration narrowed to \"deletedAt\" IS NULL, closing RESEARCH Open Question 3"
  - "apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts: 7 tests proving all three policies plus the analytics enumeration exclude a soft-deleted workspace, admit it again on restore, and never touch a deleted workspace's flow_run/rollup row across a real tick"
affects: [22-05, 22-06, 22-07, 22-08, 22-09, 22-10]

tech-stack:
  added: []
  patterns:
    - "Discovery-side exclusion belongs in the Postgres policy predicate, not in the consumer's own SQL -- findDueCampaignCandidates/findLiveSegmentTriggeredFlows/findDueFlowRunCandidates needed zero code changes because the fix lives entirely in migration 0070's re-created policies"
    - "A plain WHERE-clause narrowing (analytics-reconciliation's organization enumeration) gets the same exported-query treatment as an RLS-policy-backed scan consumer (findLiveWorkspaceIds mirrors findDueCampaignCandidates's own exported-function shape), even though it isn't itself an RLS boundary"

key-files:
  created:
    - packages/db/migrations/0070_scan_policies_exclude_deleted_workspaces.sql
    - apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts
  modified:
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/migration-tiers.ts
    - packages/db/src/__tests__/migration-tiers.test.ts
    - packages/db/src/__tests__/migration-empty-diff.test.ts
    - apps/worker/src/queues/analytics-reconciliation.worker.ts

key-decisions:
  - "All three scan policies (campaigns_scan, flows_scan, flow_runs_scan) move together in one migration file, including flow_runs_scan -- the third gap CONTEXT.md's own discovery pass did not name -- rather than patching only the two originally surfaced"
  - "No privilege-granting statement of any kind added: migration 0042 already grants mega_crm_scan table-level SELECT on organization, so the NOT EXISTS subquery resolves as-is; the plan-time assumption that a column-level grant was needed was checked against 0042 and found incorrect"
  - "analytics-reconciliation's organization enumeration extracted into an exported findLiveWorkspaceIds (mirrors every sibling scan consumer's own exported-query convention) rather than inlining the WHERE clause, so workspace-quiesce-scan.test.ts can drive discovery directly without a live BullMQ worker"

requirements-completed: [PRG-06]

coverage:
  - id: D1
    description: "campaigns_scan, flows_scan and flow_runs_scan (migration 0070) exclude a soft-deleted workspace's rows from discovery, with each policy's existing narrowing predicate preserved verbatim; a live workspace's rows remain visible (negative control)"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts#campaigns_scan excludes deleted"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts#flows_scan excludes deleted"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts#flow_runs_scan excludes deleted"
        status: pass
    human_judgment: false
  - id: D2
    description: "A deleted workspace's waiting flow_run is provably frozen (unchanged current_node_id/exited_at/next_wake_at) across a full reconciliation tick, while a live workspace's run genuinely advances -- the D-02 freeze guarantee"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts#deleted workspace's flow run does not advance across a full reconciliation tick, while the live workspace's does (D-02 freeze guarantee)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Restoring a workspace (clearing deletedAt) re-admits its rows to all three scan policies -- the predicate is a live filter, not a one-way tombstone"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts#restoring re-admits: clearing deletedAt makes all three policies visible again"
        status: pass
    human_judgment: false
  - id: D4
    description: "analytics-reconciliation's organization enumeration skips deleted and purged workspaces, closing RESEARCH Open Question 3, while a live workspace's rollup row is still processed as usual"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts#analytics reconciliation skips deleted workspaces"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts#purged workspaces stay skipped: deletedAt is never cleared by the purge, so the same filter covers both states"
        status: pass
    human_judgment: false
  - id: D5
    description: "Migration 0070 ships no privilege change, applies cleanly from empty and incrementally, and every existing scan-consumer/db regression suite stays green"
    verification:
      - kind: integration
        ref: "npm run lint:migrations && npm run test:migrations"
        status: pass
      - kind: integration
        ref: "npm run test -w apps/worker (regression: analytics-reconciliation, campaign-scheduler, negative-cross-tenant-jobs, flow-segment-trigger, scheduler-registration, worker-autorun-default, segment-sweep-kill-resume)"
        status: pass
      - kind: integration
        ref: "npm run test -w packages/db"
        status: pass
    human_judgment: false

duration: ~90min
completed: 2026-08-23
status: complete
---

# Phase 22 Plan 04: Scan Policies Exclude Deleted Workspaces Summary

**Migration 0070 closes the discovery half of D-01 in Postgres itself -- campaigns_scan, flows_scan and flow_runs_scan (plus a third gap, flow_runs_scan, that CONTEXT.md's own pass never named) now exclude a soft-deleted workspace from every cross-tenant scan, and analytics-reconciliation's own workspace enumeration is narrowed the same way, with zero consumer code changes and zero new privilege grants.**

## Performance

- **Duration:** ~90 min
- **Tasks:** 2 (both `tdd="true"`)
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- All three cross-workspace scan policies (`campaigns_scan`, `flows_scan`, `flow_runs_scan`) re-created in one migration (0070) with their existing predicates preserved verbatim, conjoined with a `NOT EXISTS` exclusion against `organization."deletedAt"` -- no consumer (`findDueCampaignCandidates`, `findLiveSegmentTriggeredFlows`, `findDueFlowRunCandidates`) needed a code change, proven directly by `git diff --name-only` showing none of the three touched.
- `flow_runs_scan` -- the third gap CONTEXT.md's own discovery pass did not name -- moved in the same migration as the other two, closing the risk that a deleted workspace's flow runs would keep waking and mutating `current_node_id`/`exited_at` for the whole 30-day retention window even after the 22-02 dispatch gate blocks any mail that path could produce.
- The D-02 freeze guarantee proven end to end: a full reconciliation tick (`findDueFlowRunCandidates` -> `transitionAndNudge` -> `processFlowRunAdvance`) leaves a deleted workspace's flow_run byte-identical, while the live workspace's run genuinely advances (`status`/`exited_at` change via `handleExitNode`).
- `analytics-reconciliation.worker.ts`'s organization enumeration extracted into an exported `findLiveWorkspaceIds`, narrowed to `"deletedAt" IS NULL`, closing RESEARCH Open Question 3 -- `workspace_daily_rollup` (one of D-10's four post-purge evidence sets) stops accruing `updated_at`/`dirtied_at` churn after a workspace is deleted, and stays skipped after a later purge since `tombstoneOrganization` never clears `deletedAt`.
- Zero privilege change: migration 0070 adds no `GRANT` of any kind, verified by `grep -v '^[[:space:]]*--' ... | grep -c GRANT` returning 0 -- migration 0042 already grants `mega_crm_scan` table-level `SELECT` on `organization`, so the plan-time assumption that a column-level grant was needed was checked and found incorrect.
- Full regression pass: `npm run lint:migrations` (71 files, no violations), `npm run test:migrations` (`packages/db`, 245/247, 2 pre-existing skips, matching 22-01's own baseline), `npm run test -w apps/worker` targeted regression suites (analytics-reconciliation, campaign-scheduler, negative-cross-tenant-jobs's own flow-reconciliation scan-consumer describe block, flow-segment-trigger, scheduler-registration, worker-autorun-default, failure-injection/segment-sweep-kill-resume) all green, `tsc --noEmit` clean for both `apps/worker` and `packages/db`, `eslint` clean for every file this plan touched.

## Task Commits

Both tasks' RED (`test`) and GREEN (`feat`) halves were committed, combined into one test commit followed by two feat commits (see Issues Encountered for why):

1. **Tasks 1+2 RED** — `20e3276` (test): the full `workspace-quiesce-scan.test.ts` (7 cases)
2. **Task 1 GREEN** — `d872b7c` (feat): migration 0070 + journal + migration-tier bookkeeping fixups
3. **Task 2 GREEN** — `0b779b4` (feat): `findLiveWorkspaceIds` enumeration narrowing

## Files Created/Modified

- `packages/db/migrations/0070_scan_policies_exclude_deleted_workspaces.sql` — drops and re-creates `campaigns_scan`, `flows_scan`, `flow_runs_scan` with the soft-delete exclusion predicate; no privilege statement
- `packages/db/migrations/meta/_journal.json` — appends the `idx: 70` entry after 0069's
- `packages/db/src/migration-tiers.ts` — classifies 0070 `forward-only` (CREATE POLICY, an access-control posture change)
- `packages/db/src/__tests__/migration-tiers.test.ts` — pinned "newest shipped migration" comment/test updated from 0069 to 0070 (assertion itself, `newestAutoReversibleTier() === []`, was mechanically unchanged since 0070 is also forward-only)
- `packages/db/src/__tests__/migration-empty-diff.test.ts` — `shippedMigrationCount` 70 -> 71 and `newestTag` 0069 -> 0070; `comparedAgainstSnapshot`/`snapshotFileCount` unchanged (0070 is SQL-only, no `packages/db/src/schema/*.ts` change, same precedent as 0065/0067)
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` — new exported `findLiveWorkspaceIds`, used by the repeatable tick's processor in place of the old unfiltered `SELECT id FROM organization`
- `apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts` — 7 test cases: three per-policy negative-discovery + live-control pairs, the D-02 freeze assertion, the restore-re-admits assertion, and two analytics-reconciliation enumeration cases

## Decisions Made

- **All three policies move in one migration, not just the two CONTEXT.md named** (plan's own explicit instruction, followed as written): `flow_runs_scan` carries the identical missing-predicate shape as `campaigns_scan`/`flows_scan`, and patching only two would have left a deleted workspace's flow runs mutating for the whole retention window.
- **No privilege statement of any kind added**: verified against migration 0042's own header before writing 0070 — `mega_crm_scan` already holds table-level `SELECT` on `organization`, and `organization` carries no RLS, so the `NOT EXISTS` subquery resolves for that role unconditionally.
- **`findLiveWorkspaceIds` extracted as an exported function** rather than inlining the WHERE clause at the call site: matches every other scan consumer's own convention exactly (`findDueCampaignCandidates`, `findLiveSegmentTriggeredFlows`, `findDueFlowRunCandidates`) and makes the enumeration independently testable without a live BullMQ worker.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — missing critical functionality] migration-tiers.ts / migration-tiers.test.ts / migration-empty-diff.test.ts bookkeeping**
- **Found during:** Task 1, before the migration commit
- **Issue:** Adding migration 0070 to the journal without updating `MIGRATION_TIERS` (full-coverage test) and the pinned "0069 is the newest shipped migration" comments/hardcoded counts in `migration-tiers.test.ts`/`migration-empty-diff.test.ts` would break three repo-invariant tests the moment 0070 shipped — same class of fixup 22-01 disclosed for its own two migrations.
- **Fix:** Classified 0070 `forward-only` in `MIGRATION_TIERS`; updated the pinned test comment/title in `migration-tiers.test.ts` (assertion mechanically unchanged — 0070 is also forward-only, so the trailing auto-reversible run stays empty); updated `shippedMigrationCount` (70→71) and `newestTag` (0069→0070) in `migration-empty-diff.test.ts` (`comparedAgainstSnapshot`/`snapshotFileCount` correctly left unchanged, since 0070 is SQL-only).
- **Files modified:** `packages/db/src/migration-tiers.ts`, `packages/db/src/__tests__/migration-tiers.test.ts`, `packages/db/src/__tests__/migration-empty-diff.test.ts`
- **Verification:** `npm run test -w packages/db` (245/247, pre-existing skips only)
- **Committed in:** `d872b7c`

**2. [Rule 1 — plan's own literal acceptance-criteria command inaccurate] regression commands substituted for the two consumer suites with no matching filename**
- **Found during:** Task 2, running the plan's own `<acceptance_criteria>` verification commands
- **Issue:** `npm run test -w apps/worker -- flow-segment-sweep` and `-- flow-reconciliation` both exit 1 with "No test files found" — no `apps/worker/src/**/*.test.ts` file has either literal substring in its filename (confirmed by `find`/`grep` across the whole test tree). The actual regression coverage for these two scan consumers lives in `negative-cross-tenant-jobs.test.ts`'s own `flow-reconciliation (findDueFlowRunCandidates / transitionAndNudge, scan consumer)` describe block, `flow-segment-trigger.test.ts`, `scheduler-registration.test.ts`, `worker-autorun-default.test.ts`, and `failure-injection/segment-sweep-kill-resume.test.ts`.
- **Fix:** Ran the actually-matching regression suites instead of the plan's literal filter strings; all pass (17 + 55 + 1 = 73 tests across the substituted files).
- **Files modified:** none (verification-only substitution, no source change)
- **Verification:** `npx vitest run --root apps/worker negative-cross-tenant-jobs`, `flow-segment-trigger scheduler-registration worker-autorun-default`, `segment-sweep-kill-resume` — all green
- **Committed in:** n/a (verification-only, no commit)

---

**Total deviations:** 2 auto-fixed (1 missing-critical-functionality/repo-invariant coverage, 1 plan-inaccuracy verification substitution)
**Impact on plan:** Both auto-fixes necessary to keep repo invariants green and to actually exercise the regression surface the plan intended. No scope creep — no frozen name from the plan's `<document_contract>` was touched, and `SPECIFICATION.md`/`docker/prod.env.example`/`docs/PII-INVENTORY.md` were left untouched per that contract (owned by plans 22-10/22-05).

## Issues Encountered

- **TDD gate compliance note (disclosed, not silently claimed):** the plan structures this as two separate `tdd="true"` tasks (migration, then the analytics enumeration), each implying its own test-then-feat commit pair. The test file was authored once, covering all 7 cases for both tasks together (the two halves are tightly coupled — same file, same fixtures, one coherent discovery story), then RED was verified **independently for each half**: migration 0070 was temporarily removed from disk and its journal entry deleted, confirming the 5 policy-exclusion/freeze/restore cases genuinely failed (2 unrelated analytics cases still passed); then, separately, the `findLiveWorkspaceIds` WHERE-clause narrowing was reverted, confirming the 2 analytics cases genuinely failed (5 policy cases still passed). Both reversions were restored and the full file re-verified green before any commit. History reflects one `test` commit (all 7 cases) followed by two `feat` commits (0070, then the enumeration narrowing) — mechanically satisfies the "test commit exists, feat commit(s) follow" gate check, and the underlying RED state was proven empirically for both halves independently, which is a stronger bar than a single combined RED check would have been.
- `subscription_status_history`/cascade-style surprises from 22-01 did not recur here — no destructive walk in this plan.

## Known Stubs

None.

## Threat Flags

None beyond this plan's own `<threat_model>` register (T-22-04-01 through T-22-04-05, T-22-04-SC), all addressed by this plan's implementation:
- T-22-04-01 (flow_runs_scan gap): mitigated by migration 0070 + the D-02 freeze test.
- T-22-04-02 (mail enqueued for a deleted workspace): mitigated by `campaigns_scan`'s new predicate; the 22-02 dispatch gate remains the second, independent layer.
- T-22-04-03 (privilege widening): mitigated — no GRANT added, asserted by a zero-count grep.
- T-22-04-04 (evidence-row timestamp churn): mitigated by `findLiveWorkspaceIds`, asserted by a byte-identical rollup-row test.
- T-22-04-05 (DoS from the added subquery): accepted per the plan's own disposition — a `NOT EXISTS` against `organization`'s primary key per candidate row, on scans already bounded to one tick's candidate set.
- T-22-04-SC (package legitimacy): accepted — no new package introduced.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Migration 0070 is the last migration this plan's `<document_contract>` allows (second and last migration-adding plan in this phase, per the contract) — subsequent plans (22-05 through 22-10) should not need to touch `packages/db/migrations/meta/_journal.json` for scan-policy reasons.
- `findLiveWorkspaceIds` is a new exported symbol from `analytics-reconciliation.worker.ts`; future workspace-enumeration consumers in this codebase should reuse it rather than re-inlining `SELECT id FROM organization`.
- No blockers for 22-05 through 22-10.

## Self-Check: PASSED

All 2 created files confirmed present via `git ls-files` (below); all 3 commits confirmed present via `git log --oneline`.

---
*Phase: 22-workspace-quiesce-physical-purge*
*Completed: 2026-08-23*
