---
phase: 06-flows-triggered-chains
verified: 2026-07-10T15:00:00Z
status: gaps_found
score: 3/4 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 1/4
  gaps_closed:
    - "A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met. (CR-01 closed: enqueueFlowRunAdvance is now the sole producer with unique-per-wake jobId; verified by grep — no direct flowRunAdvanceQueue.add() call sites remain — and by running the real Queue/Worker integration test live, 2/2 passing.)"
    - "Editing a live flow happens in a draft that only takes effect on publish; contacts already mid-flight continue on the version they entered, with no duplicate or skipped sends. (CR-03 closed: updateFlowDraft's trigger-column sync is gated on existing.status === 'draft'; publishFlow re-derives trigger columns from the version being published in the same UPDATE. Verified by code inspection and by running the CR-03 regression test live, 1/1 passing.)"
  gaps_remaining:
    - "Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends. (CR-02's vocabulary mismatch IS fixed — worker now branches on 'custom' — but a NEW critical defect found by the 06-REVIEW.md code review remains unfixed: loadContactTimezone in both send-node.ts and delay-node.ts binds SQL parameters in swapped order ([contactId, workspaceId] against `WHERE workspace_id = $1 AND id = $2`), so the contact's own timezone NEVER resolves and quiet-hours/wait_until always fall back to the workspace default timezone. This defeats D-08's explicit per-contact-timezone decision and re-opens the original guarantee for any contact whose timezone differs from the workspace default. Independently reproduced below with a live SQL query, not just code reading.)"
  regressions: []
gaps:
  - truth: "Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends."
    status: failed
    reason: "loadContactTimezone (apps/worker/src/queues/flows/handlers/send-node.ts:46-51 and apps/worker/src/queues/flows/handlers/delay-node.ts:21-26) executes `SELECT timezone FROM contacts WHERE workspace_id = $1 AND id = $2` but is called with `[contactId, workspaceId]` — the bind array positions are swapped relative to the query's own placeholder order. `$1` (matched against workspace_id) receives the contactId value and `$2` (matched against id) receives the workspaceId value. Since contact ids and workspace ids are drawn from disjoint UUID populations, this WHERE clause matches zero rows for every real contact, so the function always returns null and resolveTimezone(null, workspaceDefault) silently falls back to the WORKSPACE default timezone. This is not a hypothetical: reproduced live against the mega_crm_test database by running the exact correct-order query (returns the contact's stored 'America/New_York') vs the exact buggy swapped-order query the code actually executes (returns 0 rows) for the same contact/workspace pair. Consequences: (1) send-node.ts's quiet-hours gate evaluates the custom window in the wrong timezone for every contact whose stored timezone differs from the workspace default — emails can fire inside the contact's local quiet window, or be incorrectly deferred when they should send; (2) delay-node.ts's wait-until (local time-of-day / day-of-week) delays compute next_wake_at in the workspace default timezone, never the contact's, breaking D-08's explicit 'per-contact timezone is the source of truth for quiet hours, tishina must be for the RECIPIENT' decision. The 06-13 gap-closure plan correctly fixed the quiet_hours_mode VOCABULARY mismatch (worker now branches on 'custom' instead of the never-matched legacy 'override'), and that fix is independently confirmed working — but the underlying timezone RESOLUTION this vocabulary fix depends on remains broken, so the phase's headline quiet-hours guarantee is still not met for any contact with an individually configured timezone. All existing quiet-hours/delay tests seed fixture contacts with no timezone set, so the fallback-to-workspace-default masks the bug in every existing test — it is untested and undetected by the test suite. This was flagged as a fresh Critical finding in .planning/phases/06-flows-triggered-chains/06-REVIEW.md (dated after 06-12/06-13/06-14 executed) and remains unaddressed — no 06-15 gap-closure plan exists yet."
    artifacts:
      - path: apps/worker/src/queues/flows/handlers/send-node.ts
        issue: "loadContactTimezone (lines 46-51) binds [contactId, workspaceId] against `WHERE workspace_id = $1 AND id = $2` — swapped order, contact timezone never resolves"
      - path: apps/worker/src/queues/flows/handlers/delay-node.ts
        issue: "Identical duplicated loadContactTimezone (lines 21-26) with the same swapped-order bug — wait_until delays compute in workspace timezone, not the contact's"
    missing:
      - "Swap the parameter array in both files to `[workspaceId, contactId]` (matching the query's own $1=workspace_id, $2=id order); strongly recommend consolidating the duplicated helper into one shared function (e.g. in @mega-crm/delivery-core alongside resolveTimezone) so it cannot diverge again"
      - "A regression test with a contact whose stored timezone places 'now' inside its custom quiet window while the workspace default timezone places it outside (assert defer) — this must fail under the current code and pass after the fix"
      - "An equivalent regression test for delay-node.ts's wait-until path, asserting next_wake_at is computed in the contact's timezone, not the workspace default, when the contact has a stored timezone differing from the workspace default"
deferred: []
---

# Phase 6: Flows — Triggered Chains Verification Report (Re-Verification)

**Phase Goal:** A marketer can visually build, publish, and run automated triggered chains that send the right email at the right time, reusing the proven send pipeline, suppression, and frequency cap.
**Verified:** 2026-07-10
**Status:** gaps_found
**Re-verification:** Yes — after gap-closure plans 06-12 (CR-01), 06-13 (CR-02), 06-14 (CR-03) executed, plus a fresh code review (06-REVIEW.md) of that gap-closure work.

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A user can drag-and-drop a flow on the canvas with trigger, delay/wait, conditional branch, send-email, and explicit exit nodes per branch, then publish it (draft → live → paused). | ✓ VERIFIED | Regression check only (was already ✓ in prior verification, untouched by gap-closure plans): `flow-definition-schema.ts` still defines all 5 node types; `flow.repository.ts`'s `createFlow`/`publishFlow`/`pauseFlow`/`resumeFlow` intact, now with the CR-03 trigger-column fix layered in (see truth 4). |
| 2 | A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met. | ✓ VERIFIED | **CR-01 closed.** `grep -rn "flowRunAdvanceQueue.add"` across `apps/worker/src` and `apps/api/src` shows exactly one call site — inside `enqueueFlowRunAdvance` itself (`flow-queues.ts:89`) — the designated sole producer. `enqueueFlowRunAdvance`'s jobId (`${flowRunId}-${Date.now()}`) is unique per wake; `flowRunAdvanceQueue` now has its own `removeOnComplete: true` / `removeOnFail: {age: 86400}` options instead of the shared 24h-retained defaults. Send/branch non-terminal transitions in `flow-run-advance.worker.ts` now enqueue a forward nudge (WR-08 closed). Ran the actual integration test live (not trusting SUMMARY.md): `npx vitest run apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts` → 2/2 passing against a real Postgres + Redis, covering both a two-send chain and a 2+ delay chain. |
| 3 | Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends. | ✗ FAILED | Re-entry control (`flow-reentry.ts`) confirmed still present/unaffected. **Quiet hours still fails, for a different reason than before.** CR-02's vocabulary mismatch IS fixed — `resolveQuietHoursWindow` in `send-node.ts` now branches on `'custom'` (confirmed by grep and by running the live `'custom' quiet-hours window defers` and `'workspace_default' ... does NOT defer` tests, both passing). But a NEW critical defect (flagged in 06-REVIEW.md, independently reproduced here) means the timezone the window is evaluated in is still wrong: `loadContactTimezone` in both `send-node.ts` and `delay-node.ts` binds SQL params `[contactId, workspaceId]` against a query expecting `[workspaceId, contactId]` — proven live via `psql` against `mega_crm_test`: the correct-order query returns the contact's stored `'America/New_York'`, the buggy swapped-order query (exactly as the code executes it) returns 0 rows for the identical contact/workspace pair. `resolveTimezone` then silently falls back to the workspace default timezone for every contact, defeating D-08's explicit per-contact-timezone decision. Custom quiet-hours windows and wait-until delays are evaluated in the wrong clock whenever a contact's timezone differs from the workspace default. |
| 4 | Editing a live flow happens in a draft that only takes effect on publish; contacts already mid-flight continue on the version they entered, with no duplicate or skipped sends. | ✓ VERIFIED (core claim) — see warnings | **CR-03 closed.** `updateFlowDraft` in `flow.repository.ts` now gates the trigger-column sync on `patch.definition !== undefined && existing.status === "draft"` (confirmed by reading lines 271-273); `publishFlow` re-derives `trigger_type`/`trigger_event_name`/`trigger_segment_id` via `extractTriggerColumns(definition)` in the same UPDATE that repoints `live_version_id` (lines 384, 397-404). Ran the live CR-03 regression test: `npx vitest run -t "CR-03" apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts` → 1/1 passing. Version-pinning for in-flight runs remains correctly implemented (unaffected by gap-closure). **However**, 06-REVIEW.md's fresh code review flags 4 warnings that are new consequences of CR-03's own fix, compounding this same area — see Warnings below; these are edge cases (republishing with a *changed* trigger), not a negation of the core "draft only takes effect on publish" guarantee, so the core truth is verified but the surrounding publish-changes UX has real gaps. |

**Score:** 3/4 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/worker/src/queues/flows/flow-queues.ts` | advance queue producer, single dedup-safe entry point | ✓ VERIFIED | `enqueueFlowRunAdvance` is the sole producer; `FLOW_RUN_ADVANCE_JOB_OPTIONS` bounds retention; grep confirms no other `.add()` call site |
| `apps/worker/src/queues/flows/handlers/send-node.ts` | dispatch-time quiet-hours gate, contact-timezone-aware | ⚠️ WIRED BUT DEFECTIVE | Vocabulary branch (`'custom'`) fixed; `loadContactTimezone`'s swapped bind params mean the contact-timezone half of the gate never actually engages |
| `apps/worker/src/queues/flows/handlers/delay-node.ts` | wait-until delay, contact-timezone-aware | ⚠️ WIRED BUT DEFECTIVE | Same swapped-bind-param defect as send-node.ts; `next_wake_at` computed in workspace default timezone, never the contact's |
| `apps/api/src/modules/flows/flow.repository.ts` | draft CRUD, publish/pause/resume, version pin, trigger-column isolation | ✓ VERIFIED | `updateFlowDraft` status-gated sync + `publishFlow` re-derivation both present and correct; `duplicateFlow` (WR-03) and unconditional `status='live'` on publish (WR-04) are new edge-case warnings, not artifact-level failures |
| `apps/web/src/features/flows/detail/FlowDetailPage.tsx` / `PublishEnrollDialog.tsx` | publish-changes action for live/paused flow with accumulated draft | ⚠️ WIRED BUT PARTIAL | Button and dialog now render for live/paused flows (WR-03/old gap closed); but WR-02 shows the dialog/enroll-preview derive trigger facts from the live-pinned columns, not the draft being published — wrong dialog variant / wrong enroll-preview segment when the draft's trigger itself changed |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `handlers/delay-node.ts` / `send-node.ts` / `flow-reconciliation.worker.ts` / `flow-trigger-evaluator.worker.ts` / `flow-enroll-existing.worker.ts` | `flow-queues.ts` (`flowRunAdvanceQueue`) | `enqueueFlowRunAdvance(payload, opts)` | ✓ WIRED | All 6 producers route through the one helper (grep-verified, zero direct `.add()` call sites outside it) |
| `apps/web/.../QuietHoursCard.tsx` (writes `'custom'`) | `handlers/send-node.ts` (`resolveQuietHoursWindow`) | `flows.quiet_hours_mode` column | ✓ WIRED (vocabulary) / ✗ NOT CORRECTLY WIRED (timezone) | Vocabulary now matches; the contact-timezone sub-path it depends on (`loadContactTimezone`) is broken, see gap |
| `apps/api/.../flow.repository.ts` (`updateFlowDraft`) | `flow-trigger-evaluator.worker.ts` / segment sweep | shared `flows.trigger_*` columns | ✓ WIRED (status-gated) | Draft edits on a live/paused flow no longer leak into these columns; publish is the sole re-targeting point |
| `PublishEnrollDialog.tsx` | `flow.repository.ts`'s live-pinned `trigger_type`/`trigger_segment_id` | dialog's `isSegmentTriggered` / enroll-preview endpoint | ✗ NOT CORRECTLY WIRED | Post-CR-03, these columns reflect the *published* trigger, but the dialog needs the *draft's* trigger when republishing a changed trigger — WR-02 |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| FLOW-01 | 01,02,03,04,05,07,08,09,10,11 | Visual canvas builder, 5 node types, publish | ✓ SATISFIED | Unaffected by gap-closure; still verified |
| FLOW-02 | 02,06,08,12 | Trigger by event or segment entry | ✓ SATISFIED | CR-01 closed — advancement no longer stalls; integration test passing live |
| FLOW-03 | 02,05,08,12 | Exit conditions | ✓ SATISFIED | Logic correct; CR-01's advancement-stall risk removed |
| FLOW-04 | 06,11 | Re-entry control | ✓ SATISFIED | `flow-reentry.ts` unaffected, confirmed present |
| FLOW-05 | 07,11,13 | Quiet hours | ✗ BLOCKED | Vocabulary fixed (CR-02) but contact-timezone resolution broken (new critical defect) — custom quiet hours still not honored per D-08 for any contact with a stored timezone |
| FLOW-06 | 01,04,05,09,11,14 | draft → live → paused state machine | ✓ SATISFIED (core) | CR-03 closed — draft edits no longer leak into live trigger columns before publish; WR-02/WR-03/WR-04/WR-05 are real but narrower edge-case defects in the republish flow, tracked as warnings |
| FLOW-07 | 01,03,04,05,09 | Immutable published versions, in-flight pinning | ✓ SATISFIED | Unaffected by gap-closure; still verified |

No orphaned requirements — all 7 FLOW-0X IDs from REQUIREMENTS.md are claimed across the 14 plans (11 original + 3 gap-closure).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/worker/src/queues/flows/handlers/send-node.ts` | 46-51 | `loadContactTimezone` binds SQL params in swapped order — silent always-null result, no error, no test coverage | 🛑 Blocker | Re-opens FLOW-05 / roadmap truth 3 for any contact with an individual timezone |
| `apps/worker/src/queues/flows/handlers/delay-node.ts` | 21-26 | Identical swapped-bind-param duplication of the same helper | 🛑 Blocker | Wait-until delays computed in wrong timezone (D-08 violation) |
| `apps/worker/src/queues/flows/flow-run-advance.worker.ts` | 241, 315 | Forward advance nudge (WR-08) enqueued inside the still-open DB transaction — a second worker can pick it up pre-commit and no-op against the locked row | ⚠️ Warning | Degrades to 60s reconciliation backstop under multi-worker concurrency; correctness preserved, latency regresses |
| `apps/web/src/features/flows/detail/PublishEnrollDialog.tsx` | 62, 106-109 | Dialog/enroll-preview derive trigger facts from the live-pinned columns, not the draft being published | ⚠️ Warning | Wrong dialog variant / wrong enroll-preview target when republishing a flow whose draft changed the trigger (WR-02) |
| `apps/api/src/modules/flows/flow.repository.ts` | 485-518 | `duplicateFlow` copies live-pinned trigger columns alongside the draft definition, which can now diverge post-CR-03 | ⚠️ Warning | Duplicate's trigger columns can mismatch its own graph until first edit/publish (WR-03) |
| `apps/api/src/modules/flows/flow.repository.ts` | 386-396 | `publishFlow` unconditionally sets `status = 'live'`, including for a previously-paused flow, with no UI warning that enrollment/in-flight runs resume | ⚠️ Warning | Marketer publishing a draft fix on a paused flow silently resumes live sends (WR-04) |
| `apps/worker/src/queues/flows/flow-enroll-existing.worker.ts` | 205-209 | `flows.enroll_cursor` never reset on publish | ⚠️ Warning | A republished segment-triggered flow's enroll-existing back-fill can skip lower-UUID contacts (WR-05) |
| `apps/worker/src/queues/flows/flow-queues.ts` / `flow-reconciliation.worker.ts` | 85-93 / 108-119 | Unique-per-wake jobIds + 60s reconciliation with no circuit breaker for a permanently failing run | ⚠️ Warning | Unbounded re-enqueue churn (~1,440 jobs/day per stuck run) for a data-integrity failure, no terminal failed state (WR-06) |

No unresolved `TBD`/`FIXME`/`XXX` markers found in any file reviewed.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| CR-01 real Queue/Worker multi-step advancement (send chain + 2+ delay chain) | `npx vitest run apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts` (live Postgres + Redis) | 2/2 tests passed | ✓ PASS |
| CR-02 vocabulary fix: `'custom'` window defers, `'workspace_default'` (disabled) does not | `npx vitest run -t "custom quiet-hours window defers"` / `-t "workspace_default"` on `flow-run-advance.test.ts` | 1/1 and 1/1 passed | ✓ PASS |
| CR-03 draft-trigger isolation through the real HTTP/repository path | `npx vitest run -t "CR-03" apps/api/src/modules/flows/__tests__/flow-lifecycle.test.ts` | 1/1 passed | ✓ PASS |
| loadContactTimezone swapped-bind-param defect | Direct `psql` query against `mega_crm_test`: correct-order `WHERE workspace_id=$1 AND id=$2` with `[workspaceId, contactId]` returns the contact's stored `'America/New_York'`; the buggy order the code actually executes (`[contactId, workspaceId]`) returns 0 rows for the identical pair | Buggy order returns 0 rows; correct order returns the row | ✗ FAIL — confirms the gap independently of code reading |
| No unrouted direct `flowRunAdvanceQueue.add()` call sites remain | `grep -rn "flowRunAdvanceQueue.add" apps/worker/src apps/api/src` | Exactly 1 hit, inside `enqueueFlowRunAdvance` itself | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` files exist in this repository and no probes are declared in the phase's PLAN/SUMMARY files. Step 7c: SKIPPED (no probes declared or discovered).

### Human Verification Required

None — the remaining gap (contact-timezone swapped bind params) was independently confirmed by both static code inspection and a live SQL reproduction; no runtime/visual/UX judgment is needed to establish it as a defect.

### Gaps Summary

**What CLOSED in this re-verification round:**
1. **CR-01 (advance-queue job shadowing)** — genuinely closed. `enqueueFlowRunAdvance` is the sole producer with a unique-per-wake jobId; the real Queue/Worker integration test (run live, not trusted from SUMMARY.md) passes for both a send-chain and a 2+ delay chain.
2. **CR-03 (draft trigger leak into live enrollment)** — genuinely closed. The trigger-column sync is gated on draft status; publish is now the sole re-derivation point. The live CR-03 regression test passes.

**What did NOT close:**
3. **Quiet hours (roadmap truth 3 / FLOW-05) remains broken**, but for a different, newly-discovered root cause than the original CR-02. The 06-13 gap-closure plan correctly fixed the `quiet_hours_mode` vocabulary mismatch (worker branches on `'custom'` now). But `loadContactTimezone` — the function that vocabulary fix depends on to resolve the RIGHT clock to evaluate the window in — binds its SQL parameters in swapped order in both `send-node.ts` and `delay-node.ts`, so it always returns `null` and silently falls back to the workspace default timezone. This defeats D-08's explicit "quiet hours must be silence for the RECIPIENT, per-contact timezone is the source of truth" decision. Independently reproduced live via `psql`: the exact swapped-order query the code runs returns 0 rows for a real contact/workspace pair, while the correct order returns the contact's timezone. This was flagged as a fresh Critical finding in `06-REVIEW.md` (dated after the three gap-closure plans executed) and no fourth gap-closure plan has addressed it yet.

**New warnings surfaced by this round's fresh code review** (not blocking, but real defects introduced or exposed by 06-12/06-13/06-14 themselves, concentrated in the republish/publish-changes flow that CR-03's fix enabled):
- WR-01: forward advance nudge enqueued pre-commit, degrades to 60s backstop under multi-worker concurrency (latency only, not correctness)
- WR-02: publish dialog/enroll-preview derive trigger facts from live-pinned columns, not the draft — wrong dialog variant/target when republishing a changed trigger
- WR-03: `duplicateFlow` can produce a duplicate whose trigger columns mismatch its own copied definition
- WR-04: publishing a paused flow's draft silently resumes live enrollment/sends, with no warning — safety/UX risk
- WR-05: `enroll_cursor` never resets on publish — republished back-fill can skip contacts
- WR-06: no circuit breaker for a permanently failing run — unbounded queue churn

**Recommendation:** Do not proceed to the next phase until the `loadContactTimezone` swapped-bind-param defect is fixed (swap to `[workspaceId, contactId]` in both `send-node.ts` and `delay-node.ts`, ideally consolidated into one shared helper), with a regression test using a contact whose stored timezone places "now" inside its quiet window while the workspace default places it outside. The 6 warnings (WR-01 through WR-06) should be triaged; WR-04 (silent resume-on-publish for a paused flow) is the highest-priority warning given its direct safety implication (unintended live sends), followed by WR-02 (broken publish-changes UX for the exact scenario 06-14 was built to support).

---

_Verified: 2026-07-10_
_Verifier: Claude (gsd-verifier)_
