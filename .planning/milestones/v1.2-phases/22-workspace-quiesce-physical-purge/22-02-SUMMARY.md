---
phase: 22-workspace-quiesce-physical-purge
plan: 02
subsystem: delivery
tags: [quiesce, soft-delete, sends-ledger, bullmq, dispatch-gate, campaign-kickoff, flow-send, delivery-core]

# Dependency graph
requires:
  - phase: 22-01 (workspace-purge, parallel wave 1 plan)
    provides: "organization.deletedAt column and purge machinery (not directly consumed here -- this plan reads deletedAt only, and deliberately does not join purge_records)"
provides:
  - "packages/delivery-core/src/workspace-quiesce.ts: shared fail-closed isWorkspaceSoftDeleted(client, workspaceId) lookup + WORKSPACE_DELETED_EXCLUSION_REASON literal"
  - "dispatch-time quiesce gate on all three send paths (campaign, flow, test-send) in apps/worker"
  - "campaign-kickoff fan-out guard stopping broadcast enqueue for a soft-deleted workspace"
affects: [22-04 (discovery-query quiesce fix), 22-06/22-07 (purge worker plans that may want to reuse isWorkspaceSoftDeleted), any future plan touching send-dispatch.ts/flow-send.ts/campaign-kickoff.worker.ts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dispatch-time fail-closed tenant-state check: a single shared lookup (isWorkspaceSoftDeleted) called once per job on every send path, positioned before the pre-send gate and before any transport call, re-read fresh (never cached) so a mid-flight tenant-state change still takes effect on a job already in the queue."
    - "Freeze-never-cancel refusal: a quiesce refusal writes only the send row's own exclusion (or, on paths with no ledger row, a structured log line) -- never a campaign/flow-run status transition, so a later-restored workspace finds its work untouched."

key-files:
  created:
    - packages/delivery-core/src/workspace-quiesce.ts
    - apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts
  modified:
    - packages/delivery-core/src/index.ts
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/flows/flow-send.ts
    - apps/worker/src/queues/campaign-kickoff.worker.ts

key-decisions:
  - "isWorkspaceSoftDeleted is fail-closed on a missing organization row (returns true/refuse), matching T-22-02-03 -- verified with a direct unit-style call against a random UUID rather than attempting to construct a full campaign/contact fixture with no organization row, which the schema's ON DELETE CASCADE FKs make impossible to set up (deleting organization would cascade-delete the very campaign/contact rows the test needs to keep)."
  - "The test-send refusal returns { outcome: \"skipped\" } -- reusing the existing 'nothing happened, not an error' outcome rather than inventing a new SendJobResult variant, since D-12 means this path never writes a sends row for a quiesce refusal to attach a new state to."
  - "organization.deletedAt is updated directly via the app-role pool (mega_crm_app holds UPDATE on organization per migration 0045, and the table carries no RLS per migration 0001) -- no need for a separate auth-role test pool for this plan's fixtures."

requirements-completed: [PRG-06]

coverage:
  - id: D1
    description: "Campaign-path dispatch refuses a soft-deleted workspace's send, recording an excluded send fact with reason workspace_deleted, and is idempotent across redelivery"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#T-22-02-01: campaign path refuses after soft delete, recording an excluded send fact"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#PRG-06 idempotency: redelivery of the same refused job records the same excluded fact again without error"
        status: pass
    human_judgment: false
  - id: D2
    description: "Flow-path dispatch refuses a soft-deleted workspace's send through the same shared lookup, recording an excluded flow send fact"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#T-22-02-01: flow path refuses after soft delete, recording an excluded flow send fact"
        status: pass
    human_judgment: false
  - id: D3
    description: "A live workspace is unaffected by the quiesce check on both campaign and test-send paths (not a blanket refusal)"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#a live workspace (deletedAt null) is unaffected by the quiesce check -- not a blanket refusal"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#test-send still succeeds for a live workspace"
        status: pass
    human_judgment: false
  - id: D4
    description: "The quiesce lookup is fail-closed when the organization row cannot be resolved at all"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#T-22-02-03: isWorkspaceSoftDeleted fails closed when the organization row cannot be found at all"
        status: pass
    human_judgment: false
  - id: D5
    description: "A quiesce refusal mutates no campaign or flow-run state (freeze, never cancel)"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#D-02: a quiesce refusal mutates no campaign or flow-run state -- freeze, never cancel"
        status: pass
    human_judgment: false
  - id: D6
    description: "Test-send refuses for a deleted workspace without writing any sends row (D-12's no-ledger-row path)"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#PRG-06: test-send refuses for a deleted workspace without writing any sends row"
        status: pass
    human_judgment: false
  - id: D7
    description: "Campaign kickoff fan-out enqueues zero per-recipient jobs for a soft-deleted workspace, and is unaffected for a live workspace"
    requirement: "PRG-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#PRG-06/D-01: campaign kickoff enqueues zero per-recipient jobs for a soft-deleted workspace"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts#campaign kickoff for a live workspace enqueues one job per sendable recipient (unaffected)"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-08-23
status: complete
---

# Phase 22 Plan 02: Dispatch-Time Workspace Quiesce Summary

**Shared fail-closed `isWorkspaceSoftDeleted` lookup wired into all three send-dispatch paths (campaign, flow, test-send) and the campaign-kickoff fan-out, killing in-flight mail for a soft-deleted workspace without mutating any campaign/flow state.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- New `packages/delivery-core/src/workspace-quiesce.ts` exports `isWorkspaceSoftDeleted(client, workspaceId)` and `WORKSPACE_DELETED_EXCLUSION_REASON = "workspace_deleted"`, re-exported from the package index. The lookup reads `organization."deletedAt"` fresh on every call and fails closed (refuses) when the row is missing entirely.
- `send-dispatch.ts`'s campaign claim path (`claimCampaignSend`) and the `kind === "test"` branch both call the shared lookup before the pre-send gate / transport call; the campaign branch records an `excluded` send fact via the existing `recordExcluded`, the test branch (which has no ledger row per D-12) logs and returns `{ outcome: "skipped" }`.
- `flows/flow-send.ts`'s `claimFlowSend` calls the identical shared lookup and records through `recordFlowExcluded` -- no second hand-rolled `deletedAt` query anywhere in the worker's send paths (grep-verified).
- `campaign-kickoff.worker.ts` checks the same lookup at the top of `processCampaignKickoffJob`, before the audience walk -- a deleted workspace's kickoff enqueues zero per-recipient `email-broadcast` jobs and leaves campaign status/counters untouched.
- 10-case integration suite `workspace-quiesce-dispatch.test.ts` covers all `<must_haves>` truths: refusal on both ledgered paths, live-workspace pass-through, fail-closed missing-org-row, idempotent redelivery, campaign/flow-run state untouched, test-send's zero-row guarantee, and the kickoff fan-out guard (both refused and unaffected cases).

## Task Commits

1. **Task 1: The shared fail-closed quiesce lookup, wired into the campaign and flow dispatch paths** - `ad3d841` (feat)
2. **Task 2: The two paths with no send row -- test-send refusal and the broadcast fan-out guard** - `907e6d4` (feat)

_Both tasks were `tdd="true"`; the test file was written and run (confirmed RED against the not-yet-wired gate) before each task's implementation, then extended for Task 2._

## Files Created/Modified

- `packages/delivery-core/src/workspace-quiesce.ts` - shared fail-closed `isWorkspaceSoftDeleted` lookup + `WORKSPACE_DELETED_EXCLUSION_REASON` literal
- `packages/delivery-core/src/index.ts` - re-exports the two new symbols
- `apps/worker/src/queues/send-dispatch.ts` - quiesce check in `claimCampaignSend` (before the pre-send gate) and in the `kind === "test"` branch (before the unsubscribe-token build)
- `apps/worker/src/queues/flows/flow-send.ts` - quiesce check in `claimFlowSend`, before `readFlowSendPrereqs`
- `apps/worker/src/queues/campaign-kickoff.worker.ts` - quiesce check at the top of `processCampaignKickoffJob`, before the audience walk
- `apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts` - 10-case integration suite covering all three dispatch paths + the kickoff guard

## Decisions Made

- **Fail-closed missing-org-row test constructed as a direct call, not a full pipeline test.** The `<behavior>` spec describes "the dispatch refuses ... rather than treating not found as not deleted", but every table `claimCampaignSend`/`readSendPrereqs` touches (`campaigns`, `workspace_sendgrid_keys`, `contacts`) has an `ON DELETE CASCADE` FK to `organization.id` -- deleting the organization row to simulate "missing" would cascade-delete the very fixture rows the rest of the dispatch flow needs, and inserting those fixture rows against a nonexistent `organization.id` is rejected by the FK at insert time regardless of RLS. The test instead calls `isWorkspaceSoftDeleted` directly against a random UUID with no seeded organization row -- the exact function whose fail-closed contract is under test, exercised against the real schema/DB.
- **Test-send refusal outcome is `{ outcome: "skipped" }`**, not a new `SendJobResult` variant. The plan's action text ("return the branch's normal non-error outcome") maps most naturally onto the existing "nothing happened, not an error" outcome already in the union, avoiding a type-widening change for a single new call site.
- **`organization.deletedAt` fixture writes go through the app-role pool directly** (no `withTenant`/RLS wrapper needed) -- `organization` carries no Row-Level Security (`packages/db/migrations/0001_rls_policies.sql` deliberately excludes it) and `mega_crm_app` holds `UPDATE` on it (migration 0045), so a plain `pool.query(...)` in the test mirrors what a real soft-delete action does.

## Deviations from Plan

None - plan executed as written, with the one test-construction interpretation noted above under Decisions Made (not a code deviation, a test-design choice necessitated by the schema's FK cascade behavior).

## Issues Encountered

- Full-repo `npm run lint` (root `eslint . --max-warnings=0`) fails on `apps/web/src/lib/sentry.ts` with `@typescript-eslint/no-unsafe-*` errors caused by unresolved `import.meta.env` types -- this worktree has no `apps/web` node_modules and Vite's client types are one of the packages this project's own constraints flag as unresolvable in a worktree. Confirmed unrelated to this plan (file untouched, no delivery/worker code involved) by scoping lint to every file this plan created or modified (`eslint <touched files> --max-warnings=0`), which reports zero problems. `npm run build -w apps/worker` and `npx tsc -p apps/worker/tsconfig.json --noEmit` both exit 0.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The dispatch-time half of PRG-06/SC1 is closed: mail already in the pipeline for a soft-deleted workspace cannot reach SendGrid on any of the three send paths, and the kickoff fan-out cannot flood the dispatch gate with thousands of one-at-a-time exclusions.
- `isWorkspaceSoftDeleted`/`WORKSPACE_DELETED_EXCLUSION_REASON` are now available from `@mega-crm/delivery-core` for plan 22-04 (the discovery-query half of quiesce, closing the `campaigns_scan`/`flows_scan` gap) to reuse rather than re-deriving.
- No blockers for downstream plans in this phase.

## Self-Check: PASSED

- `packages/delivery-core/src/workspace-quiesce.ts` - FOUND
- `apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts` - FOUND
- Commit `ad3d841` - FOUND in `git log --oneline --all`
- Commit `907e6d4` - FOUND in `git log --oneline --all`

---
*Phase: 22-workspace-quiesce-physical-purge*
*Completed: 2026-08-23*
