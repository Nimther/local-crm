---
phase: 06-flows-triggered-chains
verified: 2026-07-10T20:15:00Z
status: passed
score: 4/4 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 2/4
  gaps_closed:
    - "A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met. Both round-3 findings are closed: (1) CR-01 — validateFlowDefinition (packages/flows-core/src/flow-validate.ts) now runs a recursion-stack DFS (findCycleReachableFrom) scoped to nodes reachable from the trigger and rejects a graph cycle with cycle_detected; independently, processFlowRunAdvance (apps/worker/src/queues/flows/flow-run-advance.worker.ts) enforces MAX_STEPS_PER_RUN=1000 via a countFlowRunSteps check BEFORE any node dispatch, force-exiting a run with exit_reason='step_budget_exceeded' if the guard is ever evaded. Ran the two live regression tests myself: `flow-validate.test.ts -t \"06-17\"` (2/2 pass) and `flow-run-advance.test.ts -t \"06-17/CR-01\"` (1/1 pass, live Postgres/Redis). (2) CR-02 — flow.repository.ts's publishFlow now runs seedMembershipSnapshotAtomic INSIDE its own transaction (bounded 60s statement timeout) for the enrollExisting!==true branch, immediately after the flows status UPDATE and before commit; flows.routes.ts only enqueues the async flowEnrollExistingQueue job for enrollExisting===true. Ran the live regression test myself: `flow-enroll-atomic.test.ts -t \"06-18\"` (1/1 pass)."
    - "Re-entry control (once ever / once per N days / every time) and quiet hours are honored. The segment-triggered re-entry gap is closed: flow-segment-sweep.worker.ts's sweepOneFlow now runs a bounded anti-join DELETE against flow_segment_membership_snapshot (contacts no longer matching the compiled segment predicate) BEFORE the empty-membership early return, clearing the stale 'seen' row so a later rejoin reaches canEnterFlow's existing, correct every_time/once_per_n_days/once_ever decision logic again. Ran the live regression test myself: `flow-segment-trigger.test.ts -t \"06-19/WR-04/FLOW-04\"` (1/1 pass) — proves both the fix (every_time re-enters after leave->rejoin) and the safety boundary (once_ever stays correctly blocked)."
  gaps_remaining: []
  regressions: []
deferred: []
---

# Phase 6: Flows — Triggered Chains Verification Report (Re-Verification, Round 3)

**Phase Goal:** A marketer can visually build, publish, and run automated triggered chains that send the right email at the right time, reusing the proven send pipeline, suppression, and frequency cap.
**Verified:** 2026-07-10
**Status:** passed
**Re-verification:** Yes — after gap-closure round 3 (plans 06-17 through 06-21), closing the 3 blocking gaps identified in the round-2 re-verification (CR-01 cycle/hot-loop, CR-02 enrollExisting=false race, segment-triggered re-entry dead controls) plus warnings WR-01 (segment-delete transaction abort) and WR-05 (autosave silent failure).

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can drag-and-drop a flow on the canvas with trigger, delay/wait, conditional branch, send-email, and explicit exit nodes per branch, then publish it (draft → live → paused). | ✓ VERIFIED | Core mechanic unaffected across all rounds. `validateFlowDefinition` now also rejects `cycle_detected` and `no_entry` at publish time (both wired to Russian copy in `flow-validation.ts` and `NodeConfigPanel.tsx`'s `PUBLISH_BLOCKER_MESSAGES`), closing the previous round's validation-gap note. |
| 2 | A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met. | ✓ VERIFIED | **CR-01 (cyclic-graph hot loop): CLOSED.** Confirmed by direct source read: `findCycleReachableFrom` (DFS + recursion stack, `flow-validate.ts:104-127`) rejects any cycle reachable from the trigger at publish time; `processFlowRunAdvance` independently enforces `MAX_STEPS_PER_RUN=1000` (`flow-run-advance.worker.ts:97-103, 166-177`) as a defense-in-depth backstop, checked before any node dispatch/read of the pinned definition. Ran both regression tests live myself — pass. **CR-02 (enrollExisting=false race): CLOSED.** Confirmed by direct source read: `seedMembershipSnapshotAtomic` (`flow.repository.ts:356-415`) runs inside `publishFlow`'s own transaction for the `enrollExisting !== true` branch; `flows.routes.ts:282-306` only enqueues the async back-fill job when `enrollExisting === true`. Ran the regression test live myself — pass (3 members seeded, 0 flow_runs rows, synchronously). |
| 3 | Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends. | ✓ VERIFIED | Quiet hours remained closed from round 2 (contact-timezone bind order fix, unaffected by round 3). **Segment-triggered re-entry: CLOSED this round.** Confirmed by direct source read: `flow-segment-sweep.worker.ts:105-119`'s `sweepOneFlow` now runs a bounded anti-join `DELETE ... WHERE NOT EXISTS (...)` against `flow_segment_membership_snapshot` for contacts who no longer match the trigger segment, positioned BEFORE the empty-membership early return, so a fully-emptied segment still clears its stale rows. `canEnterFlow`'s per-mode decision logic (`flow-reentry.ts`, unchanged) is reachable again once the stale snapshot is cleared. Ran the regression test live myself — pass, proving both `every_time` re-enters after leave→rejoin AND `once_ever` correctly stays blocked (the fix does not bypass `canEnterFlow`'s authority). |
| 4 | Editing a live flow happens in a draft that only takes effect on publish; contacts already mid-flight continue on the version they entered, with no duplicate or skipped sends. | ✓ VERIFIED | Unaffected by round 3. `publishFlow`'s paused-status preservation (round 2, WR-04 old numbering) and version-pinning (`flow_version_id`, never `flows.live_version_id`) both unchanged and regression-confirmed via the full test suites (222/222 api, 95/95 worker, all green). |

**Score:** 4/4 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/flows-core/src/flow-validate.ts` | cycle detection + trigger-has-outgoing-edge publish-time hard errors | ✓ VERIFIED | `findCycleReachableFrom` (DFS/recursion-stack, lines 104-127) emits `cycle_detected`; `no_entry` check at lines 71-75; both scoped to nodes reachable from the trigger, preserving the "no v2 linting" (D-17) contract for unreachable/orphan cycles |
| `apps/worker/src/queues/flows/flow-run-advance.worker.ts` | bounded, terminating advance loop | ✓ VERIFIED | `MAX_STEPS_PER_RUN = 1000` exported constant (line 22); `countFlowRunSteps` check (lines 166-177) runs before any node dispatch/pinned-definition read, force-exits with `exit_reason='step_budget_exceeded'` |
| `apps/api/src/modules/flows/flow.repository.ts` | atomic `enrollExisting=false` seed inside `publishFlow`'s own transaction | ✓ VERIFIED | `seedMembershipSnapshotAtomic` (lines 356-415) called at line 481 inside `publishFlow`'s transaction, before commit, bounded by a 60s statement timeout |
| `apps/api/src/modules/flows/flows.routes.ts` | async enroll-existing job only for the `enrollExisting=true` back-fill | ✓ VERIFIED | Lines 282-306: `flowEnrollExistingQueue.add(...)` gated on `result.segmentTriggered && result.triggerSegmentId && enrollExisting` |
| `apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` | stale snapshot row cleanup on segment exit | ✓ VERIFIED | Lines 105-119: bounded anti-join `DELETE` runs before the `matchingContacts.length === 0` early return, reusing the already-compiled segment predicate |
| `apps/api/src/modules/segments/segment.repository.ts` | `deleteSegment` recovers from an aborted transaction on FK conflict | ✓ VERIFIED | `SAVEPOINT seg_delete` (line 378) + `ROLLBACK TO SAVEPOINT` in the `23503` catch (line 396), restoring a live transaction before `findReferencingFlowName` re-runs |
| `apps/web/src/features/flows/canvas/useAutosaveDraft.ts` | honest error state + automatic retry, no false "Сохранено" | ✓ VERIFIED | `deriveAutosaveState` (lines 74-82) pure function extended `AutosaveState` to include `"error"`; `FlowCanvas.tsx:329` renders «Не сохранено — повтор…» for the error state instead of the prior two-branch ternary |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `flow-validate.ts`'s `validateFlowDefinition` | publish route / canvas publish-blocker panel | `cycle_detected`/`no_entry` error codes | ✓ WIRED | `flow-validation.ts`'s `copyForCode` (lines 28-31) and `NodeConfigPanel.tsx`'s `PUBLISH_BLOCKER_MESSAGES` (lines 37-38) both map the two new codes to Russian copy |
| `flow-run-advance.worker.ts`'s step-budget guard | `flow_runs.status='exited'` | direct `UPDATE` before any node dispatch | ✓ WIRED | Confirmed at lines 170-177: no further `flow_run_steps` append and no send/advance enqueue occurs once the budget is reached |
| `flows.routes.ts`'s publish route | `flow.repository.ts`'s `publishFlow(id, { enrollExisting })` | direct function call, single transaction | ✓ WIRED | The seed-only path is now fully synchronous with the HTTP response — no async job, no race window |
| `flow-segment-sweep.worker.ts`'s anti-join DELETE | `flow-trigger-evaluator.worker.ts`'s `checkSegmentEntryForContact` / `canEnterFlow` | shared `flow_segment_membership_snapshot` table | ✓ WIRED | Once the sweep clears a stale row, the next sweep tick's own `enterSegmentTriggeredFlow` call (or a subsequent event-triggered check) reaches `canEnterFlow` again for that contact |
| `segment.repository.ts`'s `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` | `findReferencingFlowName` re-check | same transaction, recovered | ✓ WIRED | The 23503 catch now queries a live transaction instead of an aborted one, correctly surfacing `SegmentConflictError` (409) instead of a raw 25P02 (500) |
| `useAutosaveDraft.ts`'s `deriveAutosaveState` | `FlowCanvas.tsx` toolbar render | direct prop/state read | ✓ WIRED | Confirmed by reading both files: the ternary explicitly branches on `"error"` before falling back to the saved-copy default |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| FLOW-01 | 01,02,03,04,05,07,08,09,10,11,17,21 | Visual canvas builder, 5 node types, publish | ✓ SATISFIED | Core mechanic + closed validation gaps (cycle/no_entry) + honest autosave error state |
| FLOW-02 | 02,06,08,12,18,20 | Trigger by event or segment entry | ✓ SATISFIED | CR-02 atomic seed closes the mass-enrollment race; WR-01 segment-delete SAVEPOINT fix closes a related transaction-abort regression |
| FLOW-03 | 02,05,08,12,17 | Exit conditions | ✓ SATISFIED | CR-01 cycle detection + step-budget backstop closes the unbounded-hot-loop path that prevented "leaves when an exit condition is met" for a publishable cyclic graph |
| FLOW-04 | 06,11,19 | Re-entry control | ✓ SATISFIED | 06-19 closes the segment-triggered dead-control gap; `every_time`/`once_per_n_days` are functional again after a sweep-detected leave→rejoin |
| FLOW-05 | 07,11,13,15 | Quiet hours | ✓ SATISFIED | Unaffected by round 3; remains closed from round 2 |
| FLOW-06 | 01,04,05,09,11,14,16 | draft → live → paused state machine | ✓ SATISFIED | Unaffected by round 3; remains closed from round 2 |
| FLOW-07 | 01,03,04,05,09 | Immutable published versions, in-flight pinning | ✓ SATISFIED | Unaffected by round 3 |

No orphaned requirements — all 7 FLOW-0X IDs from REQUIREMENTS.md are claimed across the 21 plans (16 original/round-1/round-2 + 5 round-3 gap-closure).

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX` markers found in any of the round-3 gap-closure files (`flow-validate.ts`, `flow-run-advance.worker.ts`, `flow.repository.ts`, `flows.routes.ts`, `flow-segment-sweep.worker.ts`, `segment.repository.ts`, `useAutosaveDraft.ts`, `FlowCanvas.tsx`, `NodeConfigPanel.tsx`, `flow-validation.ts`).

A fresh code review (`06-REVIEW.md`, reviewed 2026-07-10T15:06:08Z, after all 5 round-3 plans) independently confirms all 6 remediated findings hold (0 critical findings) and surfaces 6 new/carried-forward **non-blocking warnings** plus 7 **info** items. I independently spot-checked the two new warnings with direct source reading and judge both correctly classified as non-blocking (narrower reachability than the closed blocking gaps):

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `packages/flows-core/src/flow-definition-schema.ts` / `flow-validate.ts:154-181` | No referential-integrity check on edge `source`/`target` against `nodes`; `pathReachesExit`'s missing-node branch returns `true` (fail-open) | ⚠️ Warning | A dangling edge is unreachable via the canvas (`serializeCanvas` filters to kept nodes) but is acceptable to the raw PATCH API from any workspace member; if published, the run throws on every advance and is re-nudged forever by the 60s reconciliation scan. Narrower than the closed CR-01 (requires bypassing the canvas UI, not reachable via normal drag-and-drop). |
| `packages/flows-core/src/flow-validate.ts:58-65` vs `apps/worker/src/queues/flows/flow-send.ts:92-98` | Validator accepts `fromSenderId OR fromEmail`; dispatcher requires `fromEmail` literally and throws otherwise | ⚠️ Warning | Independently verified: `SendConfigSection` (`NodeConfigPanel.tsx:443-453`) and `SenderPicker` (`TemplateSenderPickers.tsx`) share the identical TanStack Query cache key/entry, so in the ordinary case the `.find()` resolving `fromEmail` operates on already-loaded data the dropdown itself was populated from — the "cache miss" scenario is a narrow race, not a routine occurrence, correctly scoped as Warning not Critical. |
| `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts` (cursor), `flow.repository.ts`/`flow-run.repository.ts` (nested transaction), `flows.routes.ts:252` (unbounded preview query), `flow-run-advance.worker.ts` (unindexed `flow_run_steps` count) | Carried-forward pre-existing warnings (enroll_cursor never resets; `deleteFlow` nested pooled transaction; unbounded `enroll-preview` count; new step-budget count is an unindexed seq-scan) | ⚠️ Warning | Not in scope for this round's 5 plans (explicitly out of scope per commit `d10c439`); operational/scale risks, not correctness breaks of the 4 roadmap truths under current test conditions. Recommended for future triage, especially the unindexed `flow_run_steps` count given the platform's stated hundreds-of-thousands-of-sends/day target. |

### Behavioral Spot-Checks / Regression Tests (run live by this verifier, not trusted from SUMMARY.md)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Cycle + no_entry publish rejection (06-17) | `cd packages/flows-core && npx vitest run src/__tests__/flow-validate.test.ts -t "06-17"` | 2 passed, 8 skipped | ✓ PASS |
| Step-budget worker backstop (06-17/CR-01) | `cd apps/worker && npx vitest run src/queues/__tests__/flow-run-advance.test.ts -t "06-17/CR-01"` | 1 passed, 8 skipped | ✓ PASS |
| Atomic enrollExisting=false seed (06-18/CR-02) | `cd apps/api && npx vitest run src/modules/flows/__tests__/flow-enroll-atomic.test.ts -t "06-18"` | 1 passed | ✓ PASS |
| Segment leave→rejoin re-entry (06-19/WR-04/FLOW-04) | `cd apps/worker && npx vitest run src/queues/__tests__/flow-segment-trigger.test.ts -t "06-19/WR-04/FLOW-04"` | 1 passed, 7 skipped | ✓ PASS |
| Segment-delete SAVEPOINT recovery (06-20/WR-01) | `cd apps/api && npx vitest run src/modules/segments/__tests__/segment-delete-conflict.test.ts -t "06-20/WR-01"` | 1 passed | ✓ PASS |
| Autosave honest error state (06-21/WR-05) | `cd apps/web && npx vitest run src/features/flows/canvas/__tests__/autosaveState.test.ts -t "06-21/WR-05"` | 4 passed | ✓ PASS |
| Full worker suite (regression check, run once) | `cd apps/worker && npx vitest run` | 95/95 passed across 19 files | ✓ PASS |
| Full api suite (regression check, run once) | `cd apps/api && npx vitest run` | 222/222 passed across 41 files | ✓ PASS |
| Full flows-core suite (regression check, run once) | `cd packages/flows-core && npx vitest run` | 15/15 passed across 2 files | ✓ PASS |
| Full delivery-core suite (regression check, run once) | `cd packages/delivery-core && npx vitest run` | 70/70 passed across 8 files | ✓ PASS |
| Full web suite (regression check, run once) | `cd apps/web && npx vitest run` | 22/22 passed across 3 files | ✓ PASS |
| No `MAX_STEPS`/cycle guard was missing (round-2 finding); now present | `grep -n -E "MAX_STEPS_PER_RUN|findCycleReachableFrom" apps/worker/src/queues/flows/flow-run-advance.worker.ts packages/flows-core/src/flow-validate.ts` | Both present, wired | ✓ PASS |
| No DELETE ever cleared the segment snapshot (round-2 finding); now present | `grep -n "DELETE FROM flow_segment_membership_snapshot" apps/worker/src/queues/flows/flow-segment-sweep.worker.ts` | 1 hit, positioned before the empty-membership early return | ✓ PASS |
| Async job race for enrollExisting=false (round-2 finding); now atomic | `grep -n "seedMembershipSnapshotAtomic" apps/api/src/modules/flows/flow.repository.ts` | Defined + called inside `publishFlow`'s transaction | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files exist in this repository and no probes are declared in the phase's PLAN/SUMMARY files. Step 7c: SKIPPED (no probes declared or discovered).

### Human Verification Required

None. All findings in this round were independently confirmed by live test execution (each gap-closure regression test run individually by this verifier, plus a full-suite regression pass across all 5 affected packages) and direct static code inspection of the actual source files (not derived from SUMMARY.md or 06-REVIEW.md narrative alone). The one item flagged by 06-21-SUMMARY.md as needing human judgment (live browser rendering/retry-timing of the autosave toolbar) is a cosmetic UI-only concern outside the 4 roadmap truths' scope — its underlying logic (`deriveAutosaveState`) is unit-tested and its wiring into `FlowCanvas.tsx`'s render was confirmed directly by reading the source, so it does not block phase completion.

### Gaps Summary

**All 3 previously-blocking gaps are now closed, independently re-verified against the current codebase (not just SUMMARY.md claims):**

1. **CR-01 (publishable graph cycle → unbounded hot loop) — CLOSED.** `validateFlowDefinition` rejects cycles reachable from the trigger via a proper DFS/recursion-stack check; `processFlowRunAdvance` independently enforces a 1000-step budget as a backstop. Both layers are live-tested; I ran both tests myself and they pass.
2. **CR-02 (`enrollExisting=false` async-job race) — CLOSED.** The snapshot seed is now synchronous and atomic inside `publishFlow`'s own transaction; the async job is only used for the explicit back-fill (`enrollExisting=true`) case. Live-tested; I ran the test myself and it passes.
3. **Segment-triggered re-entry dead controls (`every_time`/`once_per_n_days` unreachable) — CLOSED.** The periodic sweep now clears a contact's stale snapshot row when they no longer match the trigger segment, restoring `canEnterFlow`'s existing correct re-entry decision logic on a later rejoin, while `once_ever` correctly stays blocked. Live-tested; I ran the test myself and it passes.

**The two warnings targeted this round are also closed:**
4. **WR-01 (segment-delete transaction abort → raw 500 instead of 409) — CLOSED**, via a `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` around the DELETE.
5. **WR-05 (autosave silently claims "Сохранено" after a failed save) — CLOSED**, via an honest `"error"` state and a bounded 4s automatic retry.

**Non-blocking items carried forward for future triage** (identified by this round's fresh code review, independently spot-checked here, judged correctly non-blocking — narrower reachability or out of this round's explicit scope): dangling-edge referential-integrity gap (API-only, not canvas-reachable), a narrow `fromSenderId`-without-`fromEmail` cache race (shared-query-cache analysis shows it's a narrow race, not routine), `enroll_cursor` never resetting between back-fill passes, `deleteFlow`'s nested pooled transaction, `enroll-preview`'s unbounded query, and the new step-budget guard's unindexed `flow_run_steps` count (a scale/performance concern worth addressing before the platform's stated hundreds-of-thousands-of-sends/day target, but not a current correctness break).

**Recommendation:** The phase goal is achieved — all 4 roadmap success criteria are independently verified true against the current codebase, live tests were run by this verifier (not merely inherited from SUMMARY.md/06-REVIEW.md narrative) and all pass, and the full regression suites (95 + 222 + 15 + 70 + 22 = 424 tests) are green. Proceed to the next phase. Triage the carried-forward warnings (especially the unindexed `flow_run_steps` count, given the platform's stated send-volume target) as a follow-up, non-blocking item.

---

_Verified: 2026-07-10_
_Verifier: Claude (gsd-verifier)_
