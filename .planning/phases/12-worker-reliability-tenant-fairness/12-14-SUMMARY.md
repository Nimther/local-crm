---
phase: 12-worker-reliability-tenant-fairness
plan: 14
subsystem: testing
tags: [vitest, bullmq, postgres, campaign-scheduler, gap-closure, uat]

requires:
  - phase: 12-worker-reliability-tenant-fairness
    provides: >-
      12-12's five-workers autorun-default test file
      (worker-autorun-default.test.ts) and campaign-scheduler.worker.ts's
      findDueCampaignCandidates/transitionToSending/deterministic-jobId
      kickoff seam
provides:
  - "A non-vacuous burst-absorption assertion: one seeded past-due `scheduled` campaign, exactly one kickoff job across waiting+active+delayed+completed+failed, resolvable by campaignId, with the right payload"
  - "A transition-once re-check tick proving a repeat scan neither re-transitions the campaign nor double-enqueues a kickoff"
  - "A separately-named control case (no due campaigns -> zero kickoff jobs) that discriminates 'dedup worked' from 'nothing happened'"
  - "A single shared seedDueCampaign/readDueCampaignState fixture in apps/worker/src/test/failure-fixtures.ts, consumed by both campaign-scheduler test files"
affects: [worker-reliability-tenant-fairness, campaign-scheduler, gap-closure]

tech-stack:
  added: []
  patterns:
    - "Shared DB-seeding fixture (seedDueCampaign/readDueCampaignState) extracted into failure-fixtures.ts instead of duplicated per test file"
    - "Five-state kickoff-queue-total assertion (waiting+active+delayed+completed+failed) instead of asserting `completed` alone, since nothing in this harness consumes the kickoff queue"

key-files:
  created: []
  modified:
    - apps/worker/src/test/failure-fixtures.ts
    - apps/worker/src/queues/__tests__/worker-autorun-default.test.ts
    - apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts

key-decisions:
  - "Kickoff-count assertion uses the five-state SUM, not `completed` alone (12-REVIEW.md WR-03's suggestion is wrong for this harness: nothing consumes CAMPAIGN_KICKOFF_QUEUE here, so the job sits in `waiting` and never completes)"
  - "RED observation (assertions present, seed absent -> failure) was never committed; only the final GREEN state is in git history, per the plan's explicit `type=\"tdd\"` category-error avoidance for a test-only deliverable"

requirements-completed: [WRK-13]

coverage:
  - id: D1
    description: "Burst-absorption case seeds one past-due scheduled campaign and asserts exactly one kickoff job (five-state sum), resolvable by campaignId, with correct payload, and the campaign reads back as 'sending'"
    requirement: WRK-13
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/worker-autorun-default.test.ts#campaign-scheduler: a stacked burst of identical tick jobs kicks off one seeded due campaign exactly once, never twice"
        status: pass
    human_judgment: false
  - id: D2
    description: "A further scan tick after the burst leaves sending_started_at unchanged and the kickoff total still 1 (transitions only once)"
    requirement: WRK-13
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/worker-autorun-default.test.ts (same case, recheck-tick assertions)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A separately-named control case proves zero kickoffs on an empty scan, discriminating dedup-worked from nothing-happened"
    requirement: WRK-13
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/worker-autorun-default.test.ts#campaign-scheduler: no due campaigns produces zero kickoff jobs (control)"
        status: pass
    human_judgment: false
  - id: D4
    description: "seedDueCampaign/readDueCampaignState defined once in failure-fixtures.ts and reused by campaign-scheduler-scan.test.ts (no local duplicate)"
    verification:
      - kind: unit
        ref: "npm test -w apps/worker (61 files / 405 tests passed); npx tsc -p apps/worker/tsconfig.json --noEmit (clean); grep -c \"seedDueCampaign(\" apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts == 2"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-08-11
status: complete
---

# Phase 12 Plan 14: Non-Vacuous Burst-Absorption Dedup Assertion (G-12-3) Summary

**Seeded one past-due campaign into the burst-absorption case so its dedup assertion can actually fail — replacing an all-zeros assertion that was true whether or not dedup worked.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3
- **Files modified:** 3

## Accomplishments

- Extracted `seedDueCampaign(nameSeed)` and `readDueCampaignState(workspaceId, campaignId)` into `apps/worker/src/test/failure-fixtures.ts` — the exact SQL from `campaign-scheduler-scan.test.ts`'s own local helpers, copied verbatim and parameterised only by `nameSeed`, so both campaign-scheduler test files share one definition.
- Rewired `worker-autorun-default.test.ts`'s burst-absorption case: seeds one past-due `scheduled` campaign before the 20-job tick burst, adds an arrange guard (empty scan before seeding, exactly one candidate after), and replaces the vacuous all-zeros kickoff assertion with an exactly-one five-state-sum assertion, a `getJob(campaignId)` payload check, and a `status === "sending"` readback.
- Added a transition-once re-check: after the burst drains, one more manually-tracked scan tick (`recheck-tick`, completed-listener registered before the enqueue to close the completion race) proves the campaign's `sending_started_at` is byte-identical and the kickoff total is still 1 — pinning "transitions only once" directly instead of by inference.
- Added a separately-named control case (`no due campaigns produces zero kickoff jobs (control)`) using a handful of ticks, proving the exactly-one assertion actually discriminates "dedup worked" from "nothing happened".
- Renamed the burst case and updated the file-header's accumulated-backlog docstring bullet so no comment in the file still claims the kickoff queue is unreachable or asserts the no-double-kickoff behavior by reasoning alone.
- Repointed `campaign-scheduler-scan.test.ts` at the shared fixtures, deleting its local `seedDueCampaign`/`campaignStatus` duplicates.

## Task Commits

1. **Task 1: End-to-end "one seeded campaign -> exactly one kickoff job" (the thin slice)** - `07c7205` (test)
2. **Task 2: Transition-once re-check tick, honest control case, and truthful docstrings** - `28b99e2` (test)
3. **Task 3: Collapse the duplicate seeding recipe and prove full regression** - `2fb8142` (test)

**Plan metadata:** committed separately per worktree convention (this SUMMARY).

_Note: this plan's `type="tdd"` note explains why no dedicated RED-commit/GREEN-commit pair exists — the deliverable IS a test, so a `<feature>`-block TDD plan would be a category error. The RED->GREEN discipline was followed literally within Task 1 without a separate RED commit (see below)._

## RED Step Evidence (non-vacuity proof, not committed)

Before any seed was added, the line-310 all-zeros `toMatchObject` assertion was replaced with a seed-independent five-state-sum `=== 1` assertion and the file was run. Observed failure (verbatim):

```
FAIL  src/queues/__tests__/worker-autorun-default.test.ts > repeatable-tick worker autorun default (G-12-1, WRK-13) > campaign-scheduler: a stacked burst of identical tick jobs drains to zero waiting/failed without duplicated kickoff work
AssertionError: expected +0 to be 1 // Object.is equality

- Expected
+ Received

- 1
+ 0

 ❯ src/queues/__tests__/worker-autorun-default.test.ts:319:28
```

This is the non-vacuity evidence G-12-3 required: the new assertion can and did fail before the fix. **This RED state was never committed** — `seedDueCampaign("burst-dedup")` and the remaining seed-dependent assertions were added in the same working-tree pass before the first commit (`07c7205`), which contains only the final GREEN state. Per the plan's Task 1 `<done>` criterion, this SUMMARY records the observed failure verbatim as the required non-vacuity proof; git history reflects the mutation as not separately committed.

## Files Created/Modified

- `apps/worker/src/test/failure-fixtures.ts` - Added `seedDueCampaign` and `readDueCampaignState`, the single shared seeding/readback recipe for due campaigns
- `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts` - Burst case now seeds a due campaign, asserts exactly-one kickoff + payload + status, adds a transition-once re-check tick, adds a control case, renames the burst case, and corrects the file-header docstring
- `apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts` - Repointed at the shared fixtures, local duplicate helpers removed

## Decisions Made

- Kickoff-count assertions use the five-state SUM (waiting+active+delayed+completed+failed), not `completed` alone — 12-REVIEW.md WR-03's suggestion of asserting `completed === 1` is incorrect for this harness since nothing consumes `CAMPAIGN_KICKOFF_QUEUE` in these tests; the job permanently sits in `waiting`. A comment in the test file documents this so a future reader does not reintroduce WR-03's version.
- The 30-second it-level timeout (raised from the file's 20s default) was set in Task 1, covering seeding, the 20-job drain, and Task 2's added re-check tick in one case.
- The RED failure was captured and recorded here rather than as a separate git commit, since the plan explicitly rejected a dedicated `type: tdd` plan structure for a test-only deliverable (category error) and instead required the RED->GREEN discipline to be followed literally within Task 1's single commit.

## Deviations from Plan

None — plan executed exactly as written. All three tasks, their `<behavior>`/`<action>` specifications, and the `<verification>` block's four checks (file-level vitest run, RED observation recorded, full suite green, type check clean, grep count) were followed and satisfied without any Rule 1-4 deviation.

## Verification Results

- `npx vitest run --root apps/worker src/queues/__tests__/worker-autorun-default.test.ts` — 9/9 cases pass (was 8; control case added).
- `npm test -w apps/worker` — 61 test files / 405 tests passed, 0 failed.
- `npx tsc -p apps/worker/tsconfig.json --noEmit` — clean, no errors.
- `grep -c "seedDueCampaign(" apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts` — 2 (two call sites; the shared definition lives only in failure-fixtures.ts).
- `npx eslint` on all three modified files — clean, 0 warnings.

## Known Stubs

None. This plan modified only test files and a test-fixture helper module; no production code, no UI, no data-facing surface.

## Threat Flags

None. This plan's own `<threat_model>` (T-12-14-01/02/03) covers the only trust-boundary-relevant surface introduced (fixture INSERTs into the ephemeral test database via the existing tenant-context pool) — no new network endpoint, auth path, or schema change was introduced.

## Issues Encountered

None.

## Next Phase Readiness

G-12-3 is closed: the burst-absorption case can now distinguish working dedup from no-work-happening. This was the last open UAT gap tracked for Phase 12 per the plan's `<source_audit>` (G-12-1 and G-12-2 resolved in 12-12/12-13, G-12-3 closed here). No further gap-closure plans are indicated by this plan's scope.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Plan: 14*
*Completed: 2026-08-11*
