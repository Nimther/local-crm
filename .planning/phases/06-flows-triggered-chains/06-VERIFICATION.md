---
phase: 06-flows-triggered-chains
verified: 2026-07-10T19:00:00Z
status: gaps_found
score: 2/4 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 3/4
  gaps_closed:
    - "Re-entry control (once ever / once per N days / every time) and quiet hours are honored — the loadContactTimezone SQL bind-order defect is closed. Verified live: packages/delivery-core/src/contact-timezone.ts now exports one shared helper binding [workspaceId, contactId] (matching $1=workspace_id, $2=id); both send-node.ts and delay-node.ts import it (grep confirms zero local `function loadContactTimezone` definitions remain). Ran the two 06-15 regression tests live against real Postgres/Redis (`cd apps/worker && npx vitest run src/queues/__tests__/flow-run-advance.test.ts -t \"06-15\"`) — 2/2 passing, proving a custom quiet-hours window now defers in the CONTACT's timezone and a wait_until delay computes next_wake_at at the contact's local time, not the workspace default."
    - "WR-04 (publishFlow silently resuming a paused flow) is closed. Verified live: flow.repository.ts's publishFlow now computes `nextStatus = existing.status === 'paused' ? 'paused' : 'live'` and writes it via a bound $7 param (the literal `status = 'live'` remains only in resumeFlow). Ran the 06-16 regression test live (`cd apps/api && npx vitest run src/modules/flows/__tests__/flow-lifecycle.test.ts -t \"06-16\"`) — 1/1 passing. PublishEnrollDialog.tsx now renders an honest paused-case note (confirmed by reading the source)."
  gaps_remaining: []
  regressions: []
gaps:
  - truth: "A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met."
    status: failed
    reason: "The phase's own fresh code review (06-REVIEW.md, dated AFTER round-2 gap closure) surfaced two NEW critical defects that I independently reproduced by direct source inspection (not trusting the review narrative alone). (1) packages/flows-core/src/flow-validate.ts's validateFlowDefinition has no cycle detection — pathReachesExit (lines 98-125) explicitly treats a revisited node as 'already satisfied' rather than rejecting the cycle, and no DFS/recursion-stack check exists anywhere in the file. A definition like trigger -> send-A -> send-B -> send-A (no branch node involved, so check 3 never runs) validates clean and is publishable. The canvas's isValidConnection (FlowCanvas.tsx) only blocks self-loops and duplicate edges, not A->B/B->A cycles, so a marketer CAN draw this by hand. Once published, apps/worker/src/queues/flows/flow-run-advance.worker.ts contains no per-run step budget or cycle guard anywhere (grep for MAX_STEPS/step_budget over the file returns nothing) — a run entering the cycle sets next_wake_at=now() and forward-nudges itself forever (confirmed at lines 235-242/311-315), so the contact never 'leaves when an exit condition is met' — it hot-loops indefinitely, growing flow_run_steps unboundedly and saturating the worker/queue. (2) apps/api/src/modules/flows/flows.routes.ts's publish route (lines 281-306) commits publishFlow's transaction FIRST, then enqueues a SEPARATE flowEnrollExistingQueue job to seed the 'do not enroll existing members' snapshot (confirmed: seedSnapshotOnly in flow-enroll-existing.worker.ts runs in its own withTenantTransaction, never inside publishFlow's transaction). Because the flow becomes live (sweepable/event-checkable) the instant publishFlow commits, and the seed job can race the segment sweep or exhaust its retries, a marketer's explicit 'Опубликовать только для новых' choice can silently mass-enroll every current segment member — the wrong contacts enter the flow, contradicting the marketer's stated intent and 'the right email at the right time' phase goal. Both defects were confirmed true by direct code reading, not by trusting 06-REVIEW.md's narrative alone; they were not part of the previous verification's must-haves (discovered by this round's fresh review) but ARE genuine, reproducible failures of this literal roadmap truth, so per the adversarial goal-backward mandate they must be surfaced as gaps rather than silently deferred as 'warnings'."
    artifacts:
      - path: packages/flows-core/src/flow-validate.ts
        issue: "No cycle-detection check (DFS/recursion-stack) anywhere in validateFlowDefinition; pathReachesExit (98-125) treats a revisited node as satisfied rather than rejecting the loop"
      - path: apps/worker/src/queues/flows/flow-run-advance.worker.ts
        issue: "No per-run step budget/cycle guard (grep for MAX_STEPS/step_budget returns nothing); a cyclic run forward-nudges itself forever via enqueueFlowRunAdvance"
      - path: apps/api/src/modules/flows/flows.routes.ts
        issue: "publish route commits publishFlow's transaction, then enqueues the enrollExisting=false snapshot seed as a SEPARATE async job — a race/job-failure window during which the now-live flow can mass-enroll the segment the marketer explicitly chose not to enroll"
      - path: apps/worker/src/queues/flows/flow-enroll-existing.worker.ts
        issue: "seedSnapshotOnly (147-174) runs in its own transaction, not atomic with publishFlow's commit"
    missing:
      - "Reject cycles reachable from the trigger at publish time in validateFlowDefinition (DFS + recursion stack, new error code e.g. cycle_detected), plus a defensive per-run step budget in processFlowRunAdvance that exits a run with a terminal failure state once a threshold is exceeded"
      - "Make the enrollExisting=false snapshot seed synchronous and atomic with publishFlow's own transaction (single bounded INSERT...SELECT inside the same transaction, or before the route returns), removing the async-job race/job-loss window entirely"
      - "Regression tests: (a) a cyclic definition is rejected at publish with cycle_detected; (b) enrollExisting=false + a concurrent sweep tick immediately after publish enrolls zero current segment members"
  - truth: "Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends."
    status: failed
    reason: "Quiet hours (the timezone-bind-order half of this truth) is now genuinely fixed and verified live (see gaps_closed). However, the re-entry-control half of this SAME roadmap truth has an independently-confirmed defect for segment-triggered flows specifically, flagged in 06-REVIEW.md and reproduced here by direct code reading: flow-trigger-evaluator.worker.ts's checkSegmentEntryForContact (lines 206-217) short-circuits with `if (alreadySeen) continue` BEFORE ever calling canEnterFlow -- and flow_segment_membership_snapshot rows are inserted (markSeen, enterSegmentTriggeredFlow line 192, called unconditionally regardless of the entry decision) but NEVER deleted anywhere in the codebase (grep across apps/worker/src and apps/api/src for flow_segment_membership_snapshot shows only SELECT/INSERT statements, zero DELETE). canEnterFlow (flow-reentry.ts) itself correctly implements every_time/once_per_n_days/once_ever against flow_runs history -- the DECISION logic is not broken -- but for a segment-triggered flow it is simply never invoked a second time for a contact once markSeen has run once, because the snapshot check gates entry consideration before canEnterFlow is reached. Consequently, for a segment-triggered flow, once a contact has been checked once (allowed or not), a subsequent leave-then-rejoin of the trigger segment NEVER re-triggers entry regardless of reentry_mode -- every_time and once_per_n_days are dead, unreachable configuration values for this trigger type, while FlowLifecycleSettings.tsx still presents all three re-entry modes as available/functional with no caveat. No test in flow-segment-trigger.test.ts exercises a leave+rejoin scenario for any reentry_mode other than the default -- the gap is untested and undetected by the suite. This directly contradicts the literal roadmap wording ('Re-entry control (once ever / once per N days / every time)... are honored') for an entire trigger-type category under completely normal (non-adversarial) usage -- a contact leaving and rejoining a segment is a routine occurrence, not an edge case."
    artifacts:
      - path: apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
        issue: "checkSegmentEntryForContact (206-217) gates re-entry consideration on hasSeenSnapshot, which is permanently true once set -- canEnterFlow's every_time/once_per_n_days logic never runs a second time for segment-triggered flows"
      - path: apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
        issue: "Same snapshot-based one-shot gating applies to the periodic sweep path (110-131) -- no code path anywhere clears a snapshot row on segment exit"
    missing:
      - "Either (a) delete/clear the flow_segment_membership_snapshot row for a contact when they no longer match the segment (sweep-detected), restoring leave->rejoin re-entry subject to canEnterFlow's existing correct logic, or (b) if one-shot-per-segment-membership-episode is the intended v1 contract, hide/disable the every_time and once_per_n_days re-entry options in FlowLifecycleSettings.tsx specifically for segment-triggered flows so the UI does not present dead controls as functional"
      - "A regression test: a contact leaves the trigger segment (sweep-detected) and rejoins later; assert a NEW flow_run is created when reentry_mode is every_time or once_per_n_days (and correctly still blocked for once_ever)"
deferred: []
---

# Phase 6: Flows — Triggered Chains Verification Report (Re-Verification, Round 2)

**Phase Goal:** A marketer can visually build, publish, and run automated triggered chains that send the right email at the right time, reusing the proven send pipeline, suppression, and frequency cap.
**Verified:** 2026-07-10
**Status:** gaps_found
**Re-verification:** Yes — after gap-closure round 2 (06-15 contact-timezone bind fix, 06-16 paused-publish safety), plus a fresh code review (06-REVIEW.md, 2026-07-10T13:21:32Z) conducted after round 2 that surfaced two new critical defects and one warning independently confirmed here to bear directly on a stated roadmap truth.

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can drag-and-drop a flow on the canvas with trigger, delay/wait, conditional branch, send-email, and explicit exit nodes per branch, then publish it (draft → live → paused). | ✓ VERIFIED (core mechanic; validation gap noted) | Regression confirmed: `flow-definition-schema.ts` still defines all 5 node types; `flow.repository.ts`'s `createFlow`/`publishFlow`/`pauseFlow`/`resumeFlow` intact, with the WR-04 (round 2) status-preservation fix layered in and live-tested (1/1 passing). Note: `validateFlowDefinition` does not reject graph cycles or a trigger with no outgoing edge (see gap under truth 2 and WR-02 below) — the publish gate is real but incomplete. |
| 2 | A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met. | ✗ FAILED (new, round-2 findings) | Happy path unaffected (round-1 CR-01 advance-queue fix still holds — regression grep confirms `enqueueFlowRunAdvance` remains the sole producer). **But** the fresh code review's two new CRITICAL findings were independently reproduced by direct source reading: (1) a publishable graph cycle causes an unbounded hot loop that never reaches exit (`flow-validate.ts` has no cycle check; `flow-run-advance.worker.ts` has no step budget); (2) the `enrollExisting=false` snapshot seed is a separate async job racing the now-live flow's sweep/event triggers, so a marketer's explicit "don't enroll existing members" choice can silently mass-enroll the segment. See gaps. |
| 3 | Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends. | ✗ FAILED (quiet hours closed; re-entry partially broken) | **Quiet hours: CLOSED.** Ran the two 06-15 regression tests live against real Postgres/Redis — 2/2 passing, proving the contact's own timezone (not the workspace default) now governs both the custom quiet-hours window and wait_until delay computation. **Re-entry: partially broken for segment-triggered flows.** Independently confirmed by reading `flow-trigger-evaluator.worker.ts`: `checkSegmentEntryForContact` skips `canEnterFlow` entirely once a contact is marked "seen" in `flow_segment_membership_snapshot`, and nothing in the codebase ever deletes a snapshot row (grep across worker+api source: only SELECT/INSERT). `canEnterFlow`'s every_time/once_per_n_days logic (in `flow-reentry.ts`) is itself correct but unreachable a second time for this trigger type — a routine leave-then-rejoin of the segment never re-triggers entry regardless of configured mode. Untested (no test exercises leave+rejoin for a non-default reentry_mode). |
| 4 | Editing a live flow happens in a draft that only takes effect on publish; contacts already mid-flight continue on the version they entered, with no duplicate or skipped sends. | ✓ VERIFIED | CR-03 (round 1) confirmed still holding on regression check. WR-04 (old numbering, round-1 review — publishing a paused flow silently resuming) is **CLOSED**: ran the 06-16 regression test live — 1/1 passing; `publishFlow` now computes `nextStatus` from the pre-publish row via a bound `$7` param (`grep -n "status = 'live'"` shows the literal only inside `resumeFlow`); `PublishEnrollDialog.tsx` now renders an honest paused-case note. Version-pinning for in-flight runs unaffected by any round-2 change. |

**Score:** 2/4 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/delivery-core/src/contact-timezone.ts` | single shared, correctly-bound contact-timezone lookup | ✓ VERIFIED | New file; `client.query` binds `[workspaceId, contactId]` matching `$1=workspace_id, $2=id`; exported from `index.ts` (grep confirms 1 hit) |
| `apps/worker/src/queues/flows/handlers/send-node.ts` | imports shared helper, no local copy | ✓ VERIFIED | `grep -c "function loadContactTimezone"` → 0; imports from `@mega-crm/delivery-core` at line 7, call site at line 86 |
| `apps/worker/src/queues/flows/handlers/delay-node.ts` | imports shared helper, no local copy | ✓ VERIFIED | Same — `grep -c "function loadContactTimezone"` → 0; imports at line 3, call site at line 56 |
| `apps/api/src/modules/flows/flow.repository.ts` | `publishFlow` preserves paused status | ✓ VERIFIED | `nextStatus = existing.status === "paused" ? "paused" : "live"` (line 390), written via bound `$7` (lines 396, 410); `resumeFlow`'s literal `status = 'live'` (line 465) is the only remaining hard-coded instance |
| `apps/web/src/features/flows/detail/PublishEnrollDialog.tsx` | paused-case dialog copy | ✓ VERIFIED | Lines 110-116: `flow.status === "paused"` gates an additive Russian note referencing «Возобновить» |
| `packages/flows-core/src/flow-validate.ts` | publish-time hard errors (no_trigger / empty_send / branch_missing_exit) | ⚠️ PRESENT BUT INCOMPLETE | The three documented checks are correctly implemented, but no cycle-detection or trigger-has-outgoing-edge check exists — a cyclic or dead-end-trigger definition passes validation and is publishable (new CR-01/WR-02 findings) |
| `apps/worker/src/queues/flows/flow-run-advance.worker.ts` | bounded, terminating advance loop | ✗ MISSING GUARD | No per-run step budget/cycle detection anywhere in the file — a cyclic run forward-nudges itself unboundedly |
| `apps/api/src/modules/flows/flows.routes.ts` + `flow-enroll-existing.worker.ts` | atomic `enrollExisting=false` seed | ✗ NOT ATOMIC | `seedSnapshotOnly` runs as a separate post-commit async job, racing the now-live flow's sweep/event-trigger paths |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `handlers/send-node.ts` / `handlers/delay-node.ts` | `@mega-crm/delivery-core`'s `loadContactTimezone` | direct import, correct bind order | ✓ WIRED | Confirmed by reading both call sites; regression-tested live (2/2 06-15 cases pass) |
| `PublishEnrollDialog.tsx` (paused note) | `flow.repository.ts`'s `publishFlow` (`nextStatus`) | `flow.status === "paused"` branch | ✓ WIRED | Dialog copy and repository behavior are consistent — publishing a paused flow keeps it paused and the dialog says so |
| `flow-trigger-evaluator.worker.ts`'s `checkSegmentEntryForContact` | `flow-reentry.ts`'s `canEnterFlow` | `hasSeenSnapshot` gate | ✗ NOT CORRECTLY WIRED | The snapshot gate short-circuits BEFORE `canEnterFlow` is reached a second time for any contact already "seen" for a given flow — `every_time`/`once_per_n_days` never get a chance to re-evaluate on segment re-entry |
| `flows.routes.ts`'s publish route | `flow-enroll-existing.worker.ts`'s `seedSnapshotOnly` | `flowEnrollExistingQueue.add(...)` (async, post-commit) | ✗ NOT ATOMIC | The flow is live and sweepable/event-checkable before the seed job is guaranteed to have run — window for mass-enrollment against the marketer's explicit choice |
| `flow-validate.ts`'s `validateFlowDefinition` | canvas / publish route | publish-time hard-error gate | ⚠️ PARTIAL | Gates `no_trigger`/`empty_send`/`branch_missing_exit` correctly but does not gate cycles or a trigger with no outgoing edge |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| FLOW-01 | 01,02,03,04,05,07,08,09,10,11 | Visual canvas builder, 5 node types, publish | ✓ SATISFIED (core); validation gap noted | Core mechanic unaffected; `validateFlowDefinition` incompleteness (cycles, dead-end trigger) is a real gap but the drag-and-drop/publish mechanism itself works |
| FLOW-02 | 02,06,08,12 | Trigger by event or segment entry | ✗ BLOCKED | New CR-02 finding: `enrollExisting=false` can be silently defeated by the async seed-job race, entering contacts the marketer explicitly excluded |
| FLOW-03 | 02,05,08,12 | Exit conditions | ✗ BLOCKED | New CR-01 finding: a publishable graph cycle means a contact can enter a state that never reaches an exit node — the exit-condition guarantee is not enforced against malformed (but publishable) definitions |
| FLOW-04 | 06,11 | Re-entry control | ✗ BLOCKED | New finding (fresh review): `every_time`/`once_per_n_days` are dead, unreachable configuration values for segment-triggered flows specifically — `canEnterFlow`'s correct logic is never re-invoked once a contact is snapshot-"seen" |
| FLOW-05 | 07,11,13,15 | Quiet hours | ✓ SATISFIED | CLOSED this round — contact-timezone bind order fixed, live-tested (2/2 passing) |
| FLOW-06 | 01,04,05,09,11,14,16 | draft → live → paused state machine | ✓ SATISFIED | CR-03 (round 1) + WR-04/old (round 2, this round's closure) both hold, live-tested |
| FLOW-07 | 01,03,04,05,09 | Immutable published versions, in-flight pinning | ✓ SATISFIED | Unaffected by any round-2 change or fresh-review finding |

No orphaned requirements — all 7 FLOW-0X IDs from REQUIREMENTS.md are claimed across the 16 plans (11 original + 5 gap-closure across two rounds).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/flows-core/src/flow-validate.ts` | 34-125 | No cycle-detection (DFS/recursion-stack) anywhere in `validateFlowDefinition`; `pathReachesExit` treats a revisited node as already-satisfied | 🛑 Blocker | A publishable graph cycle causes an unbounded hot loop in the advance worker — confirmed independently, not just from the review narrative |
| `apps/worker/src/queues/flows/flow-run-advance.worker.ts` | (whole file) | No per-run step budget or cycle guard anywhere (`grep MAX_STEPS\|step_budget` returns nothing) | 🛑 Blocker | Same root cause as above — no defensive backstop if a cyclic definition is ever published |
| `apps/api/src/modules/flows/flows.routes.ts` / `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts` | 281-306 / 147-217 | `enrollExisting=false` snapshot seed runs as a separate async job, not atomic with `publishFlow`'s commit | 🛑 Blocker | Race/job-failure window can mass-enroll a segment the marketer explicitly chose not to enroll — compliance/reputation-grade risk for an email-marketing platform |
| `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts` | 206-217 | `checkSegmentEntryForContact`'s snapshot gate short-circuits before `canEnterFlow` on every subsequent check | 🛑 Blocker | `every_time`/`once_per_n_days` re-entry modes are dead controls for segment-triggered flows, contradicting a literal roadmap success criterion under normal (non-adversarial) usage |
| `packages/flows-core/src/flow-validate.ts` | 34-71 | No check that the trigger node has an outgoing edge | ⚠️ Warning | A trigger-with-no-edge definition is publishable; enrolled runs get `current_node_id = NULL` and are re-selected by the 60s reconciliation scan forever (WR-02, fresh review) |
| `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts` | 138-144, 205-228 | `flows.enroll_cursor` never resets between enroll-existing passes | ⚠️ Warning | A re-published segment-triggered flow's explicit "enroll now" back-fill can silently skip most of the segment (WR-03, fresh review) |
| `apps/api/src/modules/segments/segment.repository.ts` | 376-402 | `deleteSegment`'s 23503 catch block queries an already-aborted transaction | ⚠️ Warning | Guaranteed 25P02 → raw 500 instead of the intended 409; regresses a previously-working path (WR-01, fresh review) |
| `apps/web/src/features/flows/canvas/useAutosaveDraft.ts` | 101-119 | `saveState` reads "Сохранено" even after a failed autosave PATCH, with no automatic retry absent a further edit | ⚠️ Warning | Silent draft loss risk (WR-05, fresh review) |
| `apps/api/src/modules/flows/flow.repository.ts` / `flow-run.repository.ts` | 557-590 / 172-181 | `deleteFlow` opens a nested pooled transaction (`activeRunCount`) while holding `FOR UPDATE` on the same row | ⚠️ Warning | Pool-exhaustion stall pattern under concurrent deletes; TOCTOU count runs in a different snapshot than the DELETE it gates (WR-06, fresh review) |
| `apps/api/src/modules/flows/flows.routes.ts` | 252 | `enroll-preview` runs `countSegmentMembers` with no `statementTimeoutMs`, unlike the segments module's own bounded preview paths | ⚠️ Warning | Unbounded query on a member-accessible route fired on every publish-dialog open (WR-07, fresh review) |

No unresolved `TBD`/`FIXME`/`XXX` markers found in any file reviewed for this round's gap-closure work (`contact-timezone.ts`, `send-node.ts`, `delay-node.ts`, `flow.repository.ts`, `PublishEnrollDialog.tsx`).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 06-15 contact-timezone regression pair (custom quiet-hours in CONTACT's tz; wait_until at CONTACT's local time) | `cd apps/worker && TEST_DATABASE_URL=... TEST_REDIS_URL=... npx vitest run src/queues/__tests__/flow-run-advance.test.ts -t "06-15"` (live Postgres + Redis) | 2 passed, 6 skipped | ✓ PASS |
| 06-16 publish-on-paused regression | `cd apps/api && TEST_DATABASE_URL=... TEST_REDIS_URL=... npx vitest run src/modules/flows/__tests__/flow-lifecycle.test.ts -t "06-16"` | 1 passed, 6 skipped | ✓ PASS |
| Full worker suite (no regressions from round 2) | `cd apps/worker && npx vitest run` | 93/93 passed across 19 files | ✓ PASS |
| Full delivery-core suite | `cd packages/delivery-core && npx vitest run` | 70/70 passed | ✓ PASS |
| Full api suite | `cd apps/api && npx vitest run` | 220/220 passed across 39 files | ✓ PASS |
| No local `loadContactTimezone` copies remain | `grep -rncE "function loadContactTimezone" apps/worker/src/queues/flows/handlers/send-node.ts apps/worker/src/queues/flows/handlers/delay-node.ts` | 0 / 0 | ✓ PASS |
| `resumeFlow` is the only remaining hard-coded `status = 'live'` in publish-adjacent code | `grep -n "status = 'live'" apps/api/src/modules/flows/flow.repository.ts` | 1 hit, inside `resumeFlow` (line 465) only | ✓ PASS |
| No cycle/step-budget guard exists in the advance worker (independent reproduction of CR-01) | `grep -n -E "MAX_STEPS|step_budget|cycle" apps/worker/src/queues/flows/flow-run-advance.worker.ts` | 0 hits | ✗ FAIL (confirms the gap) |
| `enrollExisting=false` seed is not atomic with publish (independent reproduction of CR-02) | Read `flows.routes.ts:281-306` and `flow-enroll-existing.worker.ts:157-217` — `flowEnrollExistingQueue.add(...)` fires after `publishFlow` returns, `seedSnapshotOnly` runs in its own separate `withTenantTransaction` | Confirmed separate/async | ✗ FAIL (confirms the gap) |
| No DELETE ever clears `flow_segment_membership_snapshot` (independent reproduction of the re-entry finding) | `grep -rn "flow_segment_membership_snapshot" apps/worker/src apps/api/src` | Only SELECT/INSERT statements found, zero DELETE | ✗ FAIL (confirms the gap) |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files exist in this repository and no probes are declared in the phase's PLAN/SUMMARY files. Step 7c: SKIPPED (no probes declared or discovered).

### Human Verification Required

None — all findings in this round (both the closed gaps and the newly-surfaced ones) were independently confirmed by live test execution and/or direct static code inspection; no runtime/visual/UX judgment is needed to establish their status.

### Gaps Summary

**What CLOSED in this re-verification round (round 2, plans 06-15/06-16):**
1. **Contact-timezone bind-order defect (the sole gap from the previous verification, FLOW-05/roadmap truth 3's quiet-hours half)** — genuinely closed. `loadContactTimezone` is now a single shared, correctly-bound helper in `@mega-crm/delivery-core`; both handlers import it; the two live-run regression tests (Asia/Kolkata vs Pacific/Honolulu divergence proof) pass against real Postgres/Redis.
2. **WR-04 (old numbering, round-1 review) — publishing a paused flow silently resuming** — genuinely closed. `publishFlow` now preserves `paused` status via a computed, bound parameter; the live regression test passes; the dialog now states the outcome honestly.

**What did NOT close — two NEW critical findings from this round's fresh code review, independently reproduced here, that I am counting as gaps against roadmap truth 2:**
3. **Publishable graph cycles cause an unbounded hot loop (new CR-01).** `validateFlowDefinition` has no cycle detection; the advance worker has no step budget. A marketer can accidentally (or deliberately) wire a cycle via the canvas and publish it; the resulting run never reaches an exit and hot-loops at full worker speed, growing `flow_run_steps` unboundedly and risking queue/worker saturation. This directly contradicts "leaves when an exit condition is met" for a reachable (not contrived-API-only) input.
4. **`enrollExisting=false` seed race (new CR-02).** The publish route commits first, then enqueues the "seed the do-not-enroll snapshot" job separately; a race with the segment sweep or a job failure can silently mass-enroll the entire segment the marketer explicitly excluded — a compliance/reputation-grade risk for an email-marketing platform whose CLAUDE.md explicitly names suppression/compliance as a core constraint.

**A third finding, discovered by the same fresh review as a Warning but independently confirmed here to directly contradict the LITERAL roadmap wording of truth 3 under completely ordinary usage, is also counted as a gap:**
5. **Segment-triggered re-entry is dead for `every_time`/`once_per_n_days` (fresh-review WR-04, re-numbered here).** `flow_segment_membership_snapshot` rows are inserted once and never deleted; the segment-entry check short-circuits on "already seen" before `canEnterFlow`'s otherwise-correct re-entry logic ever runs a second time. A contact who leaves and rejoins the trigger segment — an entirely ordinary occurrence, not an edge case — never re-enters the flow regardless of configured `reentry_mode`, while the UI presents all three modes as functional for this trigger type.

**Other warnings surfaced by the fresh review, carried forward as non-blocking but real (not independently deep-dived in full, spot-checked at code-reading level where noted above):**
- Trigger-with-no-outgoing-edge is publishable → stuck `current_node_id = NULL` runs, reconciliation nudges forever (fresh-review WR-02)
- `enroll_cursor` never resets between enroll-existing passes → re-publish back-fill can silently skip most of the segment (fresh-review WR-03)
- `deleteSegment`'s 23503 catch queries an aborted transaction → guaranteed 500 instead of 409, a regression from this phase's own D-24 addition (fresh-review WR-01)
- Autosave shows "Сохранено" after a failed save with no automatic retry → silent draft loss risk (fresh-review WR-05)
- `deleteFlow`'s nested pooled transaction under `FOR UPDATE` → pool-exhaustion stall pattern (fresh-review WR-06)
- `enroll-preview`'s unbounded segment count on a member-accessible route → DoS exposure (fresh-review WR-07)

**Recommendation:** Do not proceed to the next phase until at minimum the two new CRITICAL findings (graph-cycle hot loop, enrollExisting=false race) and the segment re-entry dead-control gap are closed — these were independently verified here by direct source reading, not merely inherited from the review narrative, and all three represent genuine, reproducible contradictions of stated roadmap success criteria rather than cosmetic issues. The remaining warnings (WR-01/02/03/05/06/07, fresh numbering) should be triaged next; WR-01 (segment-delete 500 regression) and WR-05 (silent autosave-failure draft loss) are the highest-priority among them given direct user-facing impact.

---

_Verified: 2026-07-10_
_Verifier: Claude (gsd-verifier)_
