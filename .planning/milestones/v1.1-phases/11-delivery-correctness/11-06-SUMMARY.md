---
phase: 11-delivery-correctness
plan: 06
subsystem: delivery
tags: [transport-classification, reconciling, send-duration, flow-parity, bullmq]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (11-01/11-02/11-03/11-04/11-05)
    provides: "ARCHITECTURE.md §9 state machine, reconciling/unknown enum + reconciliation columns, campaign-side reconciler proof, deterministic send ids, classifyTransportError (built but not yet wired)"
provides:
  - "classifyTransportError is now consumed at the dispatch level -- every ambiguous throw from sendMail on BOTH the campaign and flow send paths lands in reconciling on the FIRST call, no redelivery required"
  - "handleAmbiguousSendMailError (apps/worker/src/queues/send-dispatch.ts) -- the ONE place the classification decision becomes a ledger write, shared by processSendJob's campaign branch and processFlowSendJob so the two paths cannot drift"
  - "recordSendResult/recordFlowStepResult (packages/delivery-core/src/send-ledger.ts) accept optional dispatchedAt/dispatchDurationMs, COALESCE-guarded so an omitted measurement never erases a recorded one; recordFlowStepResult's status widened to include reconciling"
  - "claimFlowSend's interrupted branch (apps/worker/src/queues/flows/flow-send.ts) now writes reconciling, not failed -- FlowClaimResult gained a reconciling member, processFlowSendJob handles it"
  - "sendsTimingFor test helper (apps/worker/src/test/failure-fixtures.ts)"
affects: [11-07/11-08 (stale-dispatching sweep and unknown-horizon expansion resolve rows this plan now routes correctly), 11-09 (reconciler-watchdog reads reconciling_since this plan's ambiguous branch sets), phase-15 (webhook-lag alert queries reconciling_since; send-duration metric now backed by real data on both paths)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "A classification decision consumed by two structurally-parallel code paths lives in ONE shared function taking the per-path write as a callback parameter, not duplicated with a per-path if/else -- prevents the exact drift Phase 11 exists to close"
    - "COALESCE($n, column) for optional timing fields on a shared UPDATE, so a write that doesn't carry a measurement never nulls out one recorded by an earlier write to the same row"

key-files:
  created:
    - apps/worker/src/queues/__tests__/send-duration.test.ts
    - apps/worker/src/queues/__tests__/ambiguous-outcome.test.ts
  modified:
    - packages/delivery-core/src/send-ledger.ts
    - apps/worker/src/test/failure-fixtures.ts
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts
    - apps/worker/src/queues/flows/flow-send.ts
    - apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts
    - SPECIFICATION.md

key-decisions:
  - "The ambiguity decision (classify -> release-and-rethrow vs write-reconciling) is factored into ONE shared function (handleAmbiguousSendMailError) taking the sendId, dispatchedAt, and a writeReconciling callback -- the campaign and flow branches differ only in which record function (recordSendResult vs recordFlowStepResult) that callback invokes. This satisfies the plan's parity requirement structurally, not by convention: the two paths cannot express a different classification rule even by accident, because there is only one function that makes that decision."
  - "processFlowSendJob's handling of claimResult.kind === 'reconciling' was deliberately NOT added in Task 2 alongside the try/catch wiring, even though it is the natural place to reach for it -- FlowClaimResult did not yet have that member (Task 3's job), and TypeScript's literal-union comparison check (TS2367) would have failed the comparison against a kind not yet in the union. Added in Task 3, in the same commit as the FlowClaimResult widening, so every commit in this plan typechecks in isolation."
  - "timeout.test.ts/connection-reset.test.ts's core assertion changed shape, not just its expected value: pre-11-06 these tests asserted a REJECTED processSendJob call followed by a SECOND (redelivered) call to observe reconciling. Post-11-06, the ambiguous disposition is observable on the FIRST call -- the test now asserts { outcome: 'reconciling' } directly and then ADDS a second redelivery to prove the claim-gate's 'skipped' branch (not a second SendGrid call) intercepts a genuine subsequent retry. This is a strengthening (asserts one more invariant: sendMail called exactly once) not a loosening."
  - "sendsTimingFor's parameter order is (sendId, workspaceId) -- opposite of sendsStatusFor's (workspaceId, campaignId, contactId) -- because the ledger row is looked up by primary key here (both campaign and flow rows share the same id-keyed lookup), not by the campaign-specific composite key sendsStatusFor uses. Kept as its own function rather than overloading sendsStatusFor's signature."

patterns-established:
  - "A decision consumed by two structurally-parallel branches (campaign/flow, in this codebase's recurring pattern) is factored into one function parameterized by the per-branch write, not duplicated -- this plan's own concrete instance of a pattern already implicit in claimCampaignSend/claimFlowSend and recordSendResult/recordFlowStepResult existing as siblings."

requirements-completed: [DLV-02, DLV-06, DLV-09]

coverage:
  - id: D1
    description: "recordSendResult/recordFlowStepResult write dispatchedAt/dispatchDurationMs via COALESCE on every status (sent/failed/reconciling); an omitted measurement on a later call preserves the earlier one; reconciling_since only advances on first entry into reconciling"
    requirement: "DLV-09"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-duration.test.ts#recordSendResult/recordFlowStepResult dispatch timing (10 cases, both ledger functions)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A rejected sendMail call is classified inline (no redelivery needed): TimeoutError/ECONNRESET/unrecognized Error all resolve to reconciling on the first call, on BOTH the campaign and flow paths, with dispatch timing recorded and campaign counters/status untouched; ECONNREFUSED releases the claim and rethrows"
    requirement: "DLV-02, DLV-06"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/ambiguous-outcome.test.ts (14 cases: campaign x6, flow x6, plus the pre-connection-retryable case on each path)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts, connection-reset.test.ts (strengthened: exactly-once sendMail call, first-call reconciling, redelivery skipped)"
        status: pass
    human_judgment: false
  - id: D3
    description: "claimFlowSend's interrupted branch writes reconciling (not failed) and returns { kind: 'reconciling', sendId }; processFlowSendJob handles it with no provider call; a redelivered job onto that row returns { outcome: 'skipped' } with zero provider calls"
    requirement: "DLV-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts (2 new cases: interrupted-claim parity, redelivery-skip)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Pre-existing suites unaffected by this plan's changes still pass: send-reconciler-tracer, claim-gate-exclusivity, send-dispatch-durability, backoff, send-timing-invariant, rate-limit-429"
    requirement: "DLV-02, DLV-06"
    verification:
      - kind: unit
        ref: "full apps/worker vitest suite (198/198 passing) + npm run failure:timeout/failure:reset/failure:429"
        status: pass
    human_judgment: false

# Metrics
duration: ~55min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 06: Wire classifyTransportError into both send paths + dispatch-duration ledger writes Summary

**Both send-dispatch branches now classify a rejected SendGrid call inline via one shared decision function -- ambiguous throws land in `reconciling` on the first attempt, provably pre-connection failures retry, dispatch timing is recorded on every write, and the flow path's interrupted-claim branch reaches parity with the campaign path (no code anywhere still writes `failed` for an unobserved outcome).**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-08-09T11:45:30Z
- **Tasks:** 3
- **Files modified:** 10 (2 created, 8 modified)

## Accomplishments

- `packages/delivery-core/src/send-ledger.ts`'s `recordSendResult`/`recordFlowStepResult` accept optional `dispatchedAt`/`dispatchDurationMs`, written with `COALESCE($n, <col>)` so an omitted measurement never erases a recorded one; `recordFlowStepResult`'s status widened to include `"reconciling"` with the same first-entry-only `reconciling_since` guard `recordSendResult` already had.
- `apps/worker/src/queues/send-dispatch.ts` wraps unit 2 (the `sendMail` call) in `try`/`catch` on **both** the campaign branch (`processSendJob`) and the flow branch (`processFlowSendJob`). A caught error routes through one new shared function, `handleAmbiguousSendMailError`: `classifyTransportError`'s `pre_connection_retryable` releases the claim and rethrows the original error (BullMQ's bounded retry applies); `ambiguous` (the fail-closed default) writes `reconciling` directly -- on the **first** call, no redelivery needed -- via the caller-supplied write callback (`recordSendResult` for campaign, `recordFlowStepResult` for flow), touching no campaign counter or completion check. Both branches also now pass `dispatchedAt`/`dispatchDurationMs` into their `sent`/`failed` writes.
- `apps/worker/src/queues/flows/flow-send.ts`'s `claimFlowSend` interrupted branch, which previously wrote `{ status: "failed" }`, now writes `{ status: "reconciling" }` and returns a new `FlowClaimResult` member (`{ kind: "reconciling"; sendId }`), mirroring `claimCampaignSend`'s identical branch exactly. `processFlowSendJob` handles the new kind the same way the campaign branch handles its own `reconciling` claim result.
- `apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts` and `connection-reset.test.ts` are strengthened, not loosened: the ambiguous disposition is now asserted on the injecting call itself (`throwing.callCount()` === 1, `result.outcome === "reconciling"`), and a follow-up redelivery is asserted to be `skipped` with zero provider calls, replacing the old two-call "reject, then redeliver into reconciling" shape that pre-11-06 code required.
- `SPECIFICATION.md` §5.5 documents the `classifyTransportError` wiring, the shared decision function, the timing columns, and the flow-side parity fix -- all in the same change that introduced them.
- Two new test files: `send-duration.test.ts` (10 cases, both ledger functions, driven directly against live Postgres) and `ambiguous-outcome.test.ts` (14 cases across campaign and flow, driven through `processSendJob` via the `ProcessSendJobDeps.sendMail` seam).

## Task Commits

1. **Task 1: Ledger writes carry dispatch timing and the reconciling status** - `4d864b1` (feat)
2. **Task 2: Classified throw path around the provider call on both send branches** - `721abaa` (feat)
3. **Task 3: Flow-side interrupted branch reaches parity with the campaign path** - `68b49bd` (feat)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `packages/delivery-core/src/send-ledger.ts` - `recordSendResult`/`recordFlowStepResult` widened with optional `dispatchedAt`/`dispatchDurationMs`, COALESCE-guarded; `recordFlowStepResult` status widened to include `reconciling`
- `apps/worker/src/test/failure-fixtures.ts` - `sendsTimingFor(sendId, workspaceId)` reader helper
- `apps/worker/src/queues/__tests__/send-duration.test.ts` - new, covers every Task 1 `<behavior>` item
- `apps/worker/src/queues/send-dispatch.ts` - `classifyTransportError` import, `handleAmbiguousSendMailError` shared helper, try/catch on both branches, timing on every write, flow claim-result `"reconciling"` handling
- `apps/worker/src/queues/__tests__/ambiguous-outcome.test.ts` - new, covers every Task 2 `<behavior>` item, campaign and flow
- `apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts` - strengthened for the inline-classification behavior
- `apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts` - same
- `apps/worker/src/queues/flows/flow-send.ts` - `FlowClaimResult` gained `{ kind: "reconciling"; sendId }`; interrupted branch writes `reconciling`, not `failed`
- `apps/worker/src/queues/__tests__/flow-send-idempotency.test.ts` - two new cases: interrupted-claim parity, redelivery-onto-reconciling skip
- `SPECIFICATION.md` - §5.5 updated with the classification wiring, timing columns, and flow-side parity fix

## Decisions Made

- The ambiguity decision is factored into one shared function (`handleAmbiguousSendMailError`) parameterized by a write callback, not duplicated per branch -- structurally prevents the campaign and flow paths from ever expressing a different classification rule, satisfying the plan's parity requirement by construction rather than by review discipline.
- `processFlowSendJob`'s handling of the new `"reconciling"` claim-result kind was deliberately deferred from Task 2 to Task 3 (even though Task 2 touches the same function) because `FlowClaimResult` didn't have that member until Task 3 widened it -- adding the comparison earlier would have failed TypeScript's literal-union exhaustiveness check (TS2367). Keeps every task's commit independently typechecking.
- `timeout.test.ts`/`connection-reset.test.ts` needed a shape change, not just a value change: the pre-11-06 test asserted a rejected `processSendJob` call followed by a redelivered second call to observe `reconciling`. Post-11-06 the first call itself resolves to `reconciling`, so the test now asserts that directly and adds a second redelivery specifically to prove the claim-gate's `skipped` branch (not a second SendGrid call) covers a genuine subsequent retry -- a strengthening (one more asserted invariant: exactly-once `sendMail` call), not a loosening.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `npm run typecheck` does not exist as a script in this repo**
- **Found during:** Task 1 (following the plan's own acceptance criteria literally)
- **Issue:** The plan's acceptance criteria for all three tasks specify `npm run typecheck`, but no such script is defined at the repo root or in any workspace `package.json` (checked directly; grep across all `package.json` files found nothing). `npm run lint` does exist and was run as specified.
- **Fix:** Substituted `npx tsc --noEmit -p <workspace>/tsconfig.json` for the affected workspaces (`packages/delivery-core`, `apps/worker`) at each task boundary -- the same compiler check `npm run typecheck` would presumably invoke, run directly since the wrapper script is absent. All three tasks' changes typecheck cleanly under this substitution.
- **Files modified:** None (verification-only; no source change).
- **Verification:** `npx tsc --noEmit -p packages/delivery-core/tsconfig.json` and `npx tsc --noEmit -p apps/worker/tsconfig.json` both exit 0 after every task.
- **Committed in:** N/A (no file change; documented here for the executor record).

---

**Total deviations:** 1 (Rule 3 -- a missing script substituted with the equivalent direct compiler invocation, no source-level scope creep)
**Impact on plan:** None beyond the verification-command substitution; every acceptance criterion's actual intent (typecheck exits 0) was satisfied.

## Issues Encountered

None beyond the deviation above.

## Known Stubs

None.

## Threat Flags

None -- every new surface this plan introduces (the `try`/`catch` around `sendMail`, the shared classification helper, the widened ledger functions, the flow-side `reconciling` write) is already covered by this plan's own `<threat_model>` (T-11-06-01 through T-11-06-05), and no threat there is left unmitigated:
- T-11-06-01 (Repudiation, outcome classification) -- mitigated: `ambiguous-outcome.test.ts` asserts `reconciling` (never `failed`) for timeout/reset/unrecognized-throw on both paths.
- T-11-06-02 (Tampering, campaign counters) -- mitigated: `ambiguous-outcome.test.ts`'s campaign cases assert `sentCount`/`failedCount`/`status` are byte-identical before and after an ambiguous outcome.
- T-11-06-03 (Tampering, pre-connection retry) -- mitigated: the ECONNREFUSED case is asserted at the `processSendJob`/`processFlowSendJob` level (claim released, error rethrown), not only in `transport-classify.test.ts`'s own unit tests.
- T-11-06-04 (Information Disclosure, thrown error reaching logs) -- no new logging was added anywhere in this plan; the thrown value is only ever passed to `classifyTransportError` (never logged) or rethrown as-is.
- T-11-06-05 (DoS, claim stranded by a rethrow) -- mitigated: `handleAmbiguousSendMailError`'s `pre_connection_retryable` branch releases the claim via `releaseDispatchClaim` BEFORE rethrowing, on both paths; `ambiguous-outcome.test.ts`'s ECONNREFUSED cases assert the row count returns to zero.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Every row this plan writes to `reconciling` (via the ambiguous-throw path on both campaign and flow, or via the flow-side interrupted-claim parity fix) is exactly the shape 11-03's reconciler already resolves (campaign) and 11-07/11-08 will extend to cover the flow path's own resolution and the `unknown` horizon -- no new row shape was introduced, only new writers of the existing shape.
- `dispatched_at`/`dispatch_duration_ms` are now populated by every write on both send paths (not just the campaign path 11-02's migration anticipated) -- `SELECT avg(dispatch_duration_ms) FROM sends WHERE dispatched_at > now() - interval '1 day'` is answerable today, ready for 11-09's watchdog or Phase 15's dashboard to consume without any further plumbing.
- `handleAmbiguousSendMailError` is not exported outside `send-dispatch.ts` -- it is intentionally file-private, since nothing outside the two send branches it serves should ever need to make this classification decision. Future call sites that dispatch to SendGrid (none currently exist) should import `classifyTransportError` directly and decide their own disposition, not reach into this helper.
- `FlowClaimResult`'s `"reconciling"` member and `processFlowSendJob`'s handling of it are structurally identical to the campaign side's `ClaimResult`/`processSendJob` handling -- a future refactor unifying the two claim-result types (not attempted here, out of this plan's scope) has no remaining semantic gap to close first.

## Self-Check: PASSED

- FOUND: `apps/worker/src/queues/__tests__/send-duration.test.ts`
- FOUND: `apps/worker/src/queues/__tests__/ambiguous-outcome.test.ts`
- FOUND: `packages/delivery-core/src/send-ledger.ts` (recordSendResult/recordFlowStepResult widened)
- FOUND: `apps/worker/src/queues/send-dispatch.ts` (handleAmbiguousSendMailError, try/catch on both branches)
- FOUND: `apps/worker/src/queues/flows/flow-send.ts` (FlowClaimResult `reconciling` member)
- FOUND: `SPECIFICATION.md` (§5.5 updated)
- FOUND commit: `4d864b1` (Task 1)
- FOUND commit: `721abaa` (Task 2)
- FOUND commit: `68b49bd` (Task 3)

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*
