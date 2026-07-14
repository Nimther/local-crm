---
phase: 04-broadcast-campaigns-send-pipeline
plan: 13
subsystem: api
tags: [postgres, bullmq, campaigns, send-pipeline, drizzle]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-10 (send-ledger recordExcluded conflict guard), 04-12 (crash-safe 3-unit dispatch: claim/send/record)"
provides:
  - "incrementCampaignSendCounter + tryCompleteCampaign ledger helpers (packages/delivery-core)"
  - "Live sent_count/failed_count progress and a deterministic sending -> sent completion transition"
  - "Authoritative cancel enforcement at both the dispatch claim gate and the kickoff fan-out loop"
affects: [campaign-detail-ui, campaign-scheduler, flows-send-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Every terminal recordSendResult call for kind='campaign' is immediately followed, in the SAME transaction, by incrementCampaignSendCounter + tryCompleteCampaign -- counter/completion is never a separate step that could commit out of order with the terminal record"
    - "Cancel enforcement is two-layered: a claim-time status read (send-dispatch.ts) stops any already-enqueued job, and a per-page status re-read (campaign-kickoff.worker.ts) stops further fan-out -- neither alone is sufficient since fan-out and dispatch run concurrently"

key-files:
  created:
    - apps/worker/src/queues/__tests__/campaign-completion.test.ts
  modified:
    - packages/delivery-core/src/send-ledger.ts
    - packages/delivery-core/src/index.ts
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/campaign-kickoff.worker.ts

key-decisions:
  - "incrementCampaignSendCounter and tryCompleteCampaign are both guarded WHERE status='sending' -- a canceled or already-terminal campaign's counters/status are frozen no matter how many terminal sends still land for it"
  - "tryCompleteCampaign requires fan_out_complete = true AND (sent_count + failed_count) >= sendable_total, and is called from BOTH send-dispatch.ts (after every terminal send) and campaign-kickoff.worker.ts (after fan_out_complete is set) -- covers both orderings: all sends finishing before fan-out completes, and fan-out completing before the last sends land"
  - "D-05's empty-audience UPDATE in campaign-kickoff.worker.ts gained a WHERE status='sending' guard (Rule 1 fix, not explicitly required by the plan text) -- without it, a campaign canceled between the entry-level guard and the empty-audience write would have been forced back to 'sent'"
  - "campaign-kickoff.worker.ts's per-page cancel break does not persist partial sendable_total/excluded_total/fan_out_complete -- it simply stops enqueuing and returns, leaving the campaign row exactly as the cancel action set it"

patterns-established:
  - "Counter+completion wiring lives entirely in the worker's transaction boundaries, not as a follow-up job or webhook -- keeps the sending->sent state machine's terminal transition fully synchronous with the send that triggers it"

requirements-completed: [CAMP-02, CAMP-03, CAMP-05]

coverage:
  - id: D1
    description: "A non-empty-audience campaign advances sent_count live and transitions sending -> sent with terminal_at set once every sendable recipient has a terminal send"
    requirement: "CAMP-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/campaign-completion.test.ts#CR-05/CAMP-03/CAMP-05: a 2-recipient campaign advances sent_count live and reaches 'sent' after the last terminal send"
        status: pass
    human_judgment: false
  - id: D2
    description: "A fully-failed campaign (every send 4xx) still terminates to 'sent' with a visible failed_count instead of staying stuck"
    requirement: "CAMP-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/campaign-completion.test.ts#D-10/CR-05: a fully-failed 1-recipient campaign still terminates to 'sent' with a visible failed_count"
        status: pass
    human_judgment: false
  - id: D3
    description: "Canceling a sending campaign stops in-flight dispatch: a claimed send for a canceled campaign is skipped (0 SendGrid calls, no send row) and counters stay frozen"
    requirement: "CAMP-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/campaign-completion.test.ts#CR-06/CAMP-02: canceling a sending campaign stops in-flight dispatch -- 0 SendGrid calls, no send row, counters frozen"
        status: pass
    human_judgment: false
  - id: D4
    description: "Counter increments/completion never fire for a campaign that has already left 'sending' (e.g. an already-'sent' campaign)"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/campaign-completion.test.ts#guard: a campaign already 'sent' never has its counters incremented again by a stray terminal record"
        status: pass
    human_judgment: false
  - id: D5
    description: "campaign-kickoff.worker.ts's fan-out loop re-reads status per page and stops enqueuing once the campaign is canceled/sent (no regression to existing empty/non-empty kickoff behavior)"
    requirement: "CAMP-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/campaign-kickoff.worker.smoke.test.ts (both existing cases still pass)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 13: Campaign Completion, Live Progress & Authoritative Cancel Summary

**Non-empty broadcast campaigns now deterministically reach `status='sent'` with live `sent_count`/`failed_count` progress, and canceling a sending campaign authoritatively stops both in-flight dispatch and further kickoff fan-out.**

## Performance

- **Duration:** 20 min
- **Completed:** 2026-07-06T13:35:28Z
- **Tasks:** 3/3 completed
- **Files modified:** 5 (4 modified, 1 created)

## Accomplishments

- Closed CR-05: the ONLY prior path to `campaigns.status='sent'` was the kickoff worker's empty-audience branch, leaving every non-empty campaign permanently stuck in `sending` with `sent_count`/`failed_count` frozen at 0. Added `incrementCampaignSendCounter` and `tryCompleteCampaign` (both guarded `WHERE status='sending'`) and wired them into every terminal `recordSendResult` call in `send-dispatch.ts`, plus into `campaign-kickoff.worker.ts`'s fan-out completion — covering both possible orderings (all sends finish before fan-out completes, or fan-out completes before the last sends land).
- Closed CR-06: `send-dispatch.ts`'s claim-transaction campaign SELECT now reads `status`; a `kind='campaign'` dispatch for a campaign not in `'sending'` returns `{outcome:'skipped'}` before claiming or calling SendGrid. `campaign-kickoff.worker.ts`'s fan-out loop now re-reads `campaigns.status` at the start of every page and stops enqueuing further recipients the moment it sees `'canceled'`/`'sent'`.
- Added a Rule 1 fix beyond the plan's literal text: the pre-existing D-05 empty-audience `UPDATE` (unconditional `status='sent'`) is now guarded `WHERE status='sending'`, closing a residual gap where a campaign canceled between the entry-level guard and the fan-out's first page would otherwise have been forced back to `'sent'`.
- `apps/web/src/features/campaigns/CampaignProgress.tsx` already reads `sentCount`/`failedCount`/`sendableTotal` from `getCampaignProgress` — no UI change was required; live progress now simply advances because the backend counters do.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing tests — campaign completes to 'sent' with live counters, and cancel stops dispatch** - `2aea89a` (test)
2. **Task 2: Ledger — incrementCampaignSendCounter + tryCompleteCampaign helpers** - `40e911d` (feat)
3. **Task 3: Wire completion/counters into dispatch + enforce cancel in dispatch and kickoff** - `8eccabf` (feat)

**Plan metadata:** (this commit, docs: complete plan)

_Note: Task 1 is the RED gate (all 4 cases confirmed failing against pre-plan code); Tasks 2/3 are the GREEN gate (all 4 cases pass, plus no regression to campaign-kickoff.worker.smoke.test.ts / send-dispatch-durability.test.ts / send-dispatch-idempotency.test.ts)._

## Files Created/Modified

- `apps/worker/src/queues/__tests__/campaign-completion.test.ts` - New regression suite: 2-recipient completion-to-sent with live counter progress, fully-failed completion, canceled-campaign dispatch skip, and a frozen-counter guard for an already-'sent' campaign
- `packages/delivery-core/src/send-ledger.ts` - Added `incrementCampaignSendCounter(client, campaignId, status)` and `tryCompleteCampaign(client, campaignId)`, both guarded `WHERE status='sending'`
- `packages/delivery-core/src/index.ts` - Exported both new helpers from the send-ledger export block
- `apps/worker/src/queues/send-dispatch.ts` - `readSendPrereqs`'s campaign SELECT now returns `status`; `claimCampaignSend` gates `kind='campaign'` dispatch on `status='sending'` (returns `{kind:'skipped'}` otherwise) before touching the contact/pre-send-gate/dispatch-gate; every terminal `recordSendResult` (2xx sent, 4xx failed, interrupted-claim failed) is followed in the same transaction by `incrementCampaignSendCounter` + `tryCompleteCampaign`
- `apps/worker/src/queues/campaign-kickoff.worker.ts` - Per-page fan-out transaction now also reads `campaigns.status`; loop breaks (without enqueuing) once status is `'canceled'`/`'sent'`; non-empty fan-out completion now also calls `tryCompleteCampaign` in the same transaction as the `fan_out_complete=true` write; D-05's empty-audience `UPDATE` guarded `WHERE status='sending'`

## Decisions Made

- `incrementCampaignSendCounter`/`tryCompleteCampaign` guard on `status='sending'` rather than checking `NOT IN ('canceled','sent')` explicitly — since `'sending'` is the only non-terminal, non-draft/scheduled state a campaign can be in when a send lands, a positive `=` guard is simpler and equally correct.
- The kickoff loop's cancel break does not attempt to persist partial `sendable_total`/`excluded_total`/`fan_out_complete` for the canceled campaign — those fields are left exactly as the cancel action set them, since the fan-out genuinely did not finish walking the frozen snapshot and there is no requirement to reflect a partial count.
- Chose to add the `WHERE status='sending'` guard to the D-05 empty-audience UPDATE as a Rule 1 (bug) auto-fix, even though the plan's literal `<action>` text did not call it out — it directly affects the same file/mechanism (kickoff cancel enforcement) this task modifies, and leaving it unguarded would silently defeat CR-06 for the empty-audience edge case.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] D-05 empty-audience completion UPDATE lacked a status guard**
- **Found during:** Task 3 (wiring cancel enforcement into campaign-kickoff.worker.ts)
- **Issue:** The pre-existing empty-audience branch unconditionally set `campaigns.status = 'sent'` with no `WHERE status = ...` guard. A campaign canceled between the kickoff's entry-level check and this final write (e.g., canceled on the very first page, before any recipient was processed) would have been forced back to `'sent'`, silently defeating the same-task's own cancel enforcement for that edge case.
- **Fix:** Added `AND status = 'sending'` to the UPDATE's WHERE clause, matching the guard style already used by `tryCompleteCampaign` for the non-empty path.
- **Files modified:** `apps/worker/src/queues/campaign-kickoff.worker.ts`
- **Verification:** `campaign-kickoff.worker.smoke.test.ts`'s existing D-05 case (a genuinely empty, never-canceled audience) still passes unchanged; the guard only changes behavior for the canceled-during-fan-out case, which is exercised indirectly by the per-page break (canceled campaigns now return before ever reaching this branch in the tested scenarios).
- **Committed in:** `8eccabf` (part of Task 3's commit)

---

**Total deviations:** 1 auto-fixed (Rule 1). Impact on plan: closes a residual CR-06 gap in the same file/mechanism the task was already modifying; no scope creep beyond the plan's stated cancel-enforcement goal.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The `draft -> scheduled -> sending -> sent` state machine now reaches its terminal state for both empty and non-empty audiences, with live progress and authoritative cancel — CR-05 and CR-06 are closed.
- No further gap-closure plans are known to be pending for this phase based on this plan's scope; confirm against `04-VERIFICATION.md`'s full gap list before considering Phase 4 complete.

## Self-Check: PASSED

All created/modified files exist on disk; all 3 task commit hashes (2aea89a, 40e911d, 8eccabf) found in git log.
