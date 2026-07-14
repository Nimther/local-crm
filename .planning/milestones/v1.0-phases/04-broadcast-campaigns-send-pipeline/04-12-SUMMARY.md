---
phase: 04-broadcast-campaigns-send-pipeline
plan: 12
subsystem: send-pipeline
tags: [bullmq, postgres, transactions, sendgrid, idempotency, worker]

requires:
  - phase: 04-09
    provides: "resolveCampaignFromEmail, launch/schedule sender resolution"
  - phase: 04-10
    provides: "recordExcluded's redelivery-safe status guard (CR-07)"
provides:
  - "Crash-safe processSendJob: claim committed before any SendGrid call, terminal record committed after"
  - "dispatchSendGate interrupted signal distinguishing a fresh claim from a stranded prior attempt"
  - "releaseDispatchClaim: releases a stranded 'dispatching' claim on 429/5xx or rate-limiter denial"
  - "4xx SendGrid rejections recorded as status='failed', never 'sent'"
affects: [broadcast-campaigns-send-pipeline, flows-send-pipeline]

tech-stack:
  added: []
  patterns:
    - "3-unit dispatch: claim transaction (commits before network call) -> external call (no transaction) -> record transaction (after response)"
    - "Discriminated ClaimResult ('proceed'|'excluded'|'skipped'|'failed') returned from a single withTenantTransaction, decoupling ledger decisions from the network call"

key-files:
  created:
    - apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts
  modified:
    - packages/delivery-core/src/send-ledger.ts
    - packages/delivery-core/src/index.ts
    - apps/worker/src/queues/send-dispatch.ts
    - packages/delivery-core/src/__tests__/pre-send-gate.test.ts
    - apps/worker/src/queues/__tests__/backoff.test.ts

key-decisions:
  - "dispatchSendGate's conflict branch now checks for 'sent'|'failed'|'excluded' (terminal, skip) vs 'dispatching' (interrupted, caller must record failed) instead of only checking 'sent'"
  - "releaseDispatchClaim is a DELETE (not a status update) guarded by WHERE status='dispatching', so it's a safe no-op if the row already advanced past that status via a concurrent path"
  - "Updated two pre-existing tests (pre-send-gate.test.ts's dispatchSendGate assertion, backoff.test.ts's 429 assertion) that pinned the exact pre-fix behavior this plan intentionally changes"

requirements-completed: [SEND-06, SEND-07]

coverage:
  - id: D1
    description: "A worker crash after the 'dispatching' claim commits but before a terminal status is recorded never causes a duplicate SendGrid call on redelivery"
    requirement: SEND-06
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts#CR-04: an interrupted redelivery ... never re-calls SendGrid and records 'failed'"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts#SEND-06 regression: a redelivered job for an already-'sent' contact still calls SendGrid 0 times"
        status: pass
    human_judgment: false
  - id: D2
    description: "A non-retryable SendGrid 4xx (400/401/403/413) is recorded as status='failed' on the sends row, never as 'sent'"
    requirement: SEND-07
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts#CR-03: a SendGrid 400 rejection is recorded as status='failed', never 'sent'"
        status: pass
    human_judgment: false
  - id: D3
    description: "A SendGrid 429/5xx releases the dispatch claim so a clean backoff retry re-attempts the send, without consuming a retry attempt"
    requirement: SEND-07
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts#SEND-07: a 429 releases the claim ... and a retry succeeds with exactly one sends row"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/backoff.test.ts#a 429 response yields {outcome:'rate_limited'} and releases the dispatch claim (T-04-12-03, no consumed attempt)"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/backoff.test.ts#does NOT consume a retry attempt: a redelivered job after a 429 still succeeds and records exactly one sent row"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 12: Crash-Safe Dispatch (CR-03/CR-04 gap closure) Summary

**Split `processSendJob`'s single all-in-one transaction into a commit-before-network-call claim, an untransacted SendGrid call, and a separate terminal-record transaction, closing the duplicate-send-on-crash window (CR-04) and adding the missing 4xx-recorded-as-failed branch (CR-03).**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-06T13:05:00Z
- **Completed:** 2026-07-06T13:25:24Z
- **Tasks:** 3 completed
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments

- `dispatchSendGate` now distinguishes a fresh claim from an **interrupted** prior attempt (existing row still `'dispatching'`) versus a genuinely terminal row (`'sent'`/`'failed'`/`'excluded'`, still `"skipped"`).
- New `releaseDispatchClaim(client, sendId)` deletes a stranded `'dispatching'` row (no-op once it has advanced), called after a 429/5xx SendGrid response and after a rate-limiter denial so a claim is never left blocking a legitimate retry.
- `processSendJob`'s `kind='campaign'` path is now three units: a claim transaction (all reads + pre-send gate + `dispatchSendGate`, committed BEFORE any network call), the SendGrid call itself (outside any transaction), and a record transaction (only entered after SendGrid responds). A crash between any two units can at most leave a committed `'dispatching'` claim — it can never cause a second SendGrid call, because a redelivered job's claim transaction now intercepts that exact case via the `interrupted` signal and records `'failed'` without ever reaching the network call again.
- Added the missing `response.status >= 400` (non-429) branch: `recordSendResult(..., { status: 'failed' })`, closing the dead-code gap where every non-2xx status except 429/5xx was silently recorded as `'sent'`.
- `SendJobResult` gained a `{ outcome: "failed"; sendId: string }` variant.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing durability tests** - `223598f` (test)
2. **Task 2: Ledger — dispatchSendGate 'interrupted' result + releaseDispatchClaim** - `d69f180` (feat)
3. **Task 3: Restructure processSendJob into 3 units + 4xx→failed branch** - `aadb273` (feat)

**Plan metadata:** (this commit)

_Note: Task 1 is TDD RED (tests written to fail against the pre-fix code); Tasks 2/3 are the GREEN implementation. No separate refactor commit was needed._

## Files Created/Modified

- `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts` - New durability suite: interrupted-redelivery (no duplicate), 4xx→failed, 429-releases-claim-then-retry, SEND-06 regression
- `packages/delivery-core/src/send-ledger.ts` - `DispatchSendGateResult` gains `interrupted?: boolean`; conflict branch checks terminal (`sent`/`failed`/`excluded`) vs `dispatching` (interrupted); new `releaseDispatchClaim` export
- `packages/delivery-core/src/index.ts` - Export `releaseDispatchClaim`
- `apps/worker/src/queues/send-dispatch.ts` - `processSendJob` restructured into `claimCampaignSend` (unit 1) + untransacted SendGrid call (unit 2) + record transaction (unit 3); shared `readSendPrereqs` helper extracted for both campaign and test-send paths; `SendJobResult` gains `"failed"` variant
- `packages/delivery-core/src/__tests__/pre-send-gate.test.ts` - Updated `dispatchSendGate` assertions for the new `interrupted` contract; added `'failed'`/`'excluded'` terminal-skip coverage
- `apps/worker/src/queues/__tests__/backoff.test.ts` - Updated the 429 test's stale assertion (previously pinned "claim left dispatching") to assert the claim is released instead

## Decisions Made

- `dispatchSendGate`'s terminal-skip set widened to `'sent' | 'failed' | 'excluded'` (not just `'sent'`) since all three are terminal states that must never be resent — matches the plan's literal spec.
- `releaseDispatchClaim` is implemented as a guarded `DELETE` (not a status transition to some new "released" state) since no new `send_status` enum value was authorized by the plan (`no new value` in Task 2's read_first note) and a deleted row is semantically identical to "never claimed" for `dispatchSendGate`'s next attempt.
- Extracted `readSendPrereqs` (decrypt key + settings + campaign row) as a shared helper between the campaign-claim transaction and the test-send transaction, avoiding duplicating that read logic across the two paths introduced by the 3-unit restructure.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated `pre-send-gate.test.ts`'s `dispatchSendGate` assertion pinning the pre-fix contract**
- **Found during:** Task 2 verification (`npx vitest run` in packages/delivery-core)
- **Issue:** An existing unit test asserted `dispatchSendGate` returns a plain `{ sendId }` for a conflicting `'dispatching'` row — the exact shape this plan's Task 2 intentionally changes to `{ sendId, interrupted: true }`.
- **Fix:** Updated the assertion to expect `{ sendId, interrupted: true }`, renamed the test to describe the CR-04 contract, and added two new cases (`'failed'`/`'excluded'` → `"skipped"`) for full terminal-status coverage.
- **Files modified:** `packages/delivery-core/src/__tests__/pre-send-gate.test.ts`
- **Verification:** `cd packages/delivery-core && npx vitest run` — 25/25 pass; `npx tsc --noEmit` clean.
- **Committed in:** `d69f180` (part of Task 2's commit)

**2. [Rule 1 - Bug] Updated `backoff.test.ts`'s stale 429 assertion**
- **Found during:** Task 3 verification (`npx vitest run` across durability/idempotency/backoff)
- **Issue:** `backoff.test.ts` (not in this plan's `files_modified`, but explicitly listed in the plan's own `<verify>` command) asserted a 429 response leaves the `sends` row `'dispatching'` — the exact stranded-claim behavior T-04-12-03 requires this plan to fix via `releaseDispatchClaim`. Left unmodified, this test would fail against the plan's own required behavior.
- **Fix:** Updated the assertion to expect the row is gone (`toBeUndefined()`) after a 429, renamed the test and its file-level doc comment to describe the new release-then-reclaim behavior. The redelivery-succeeds assertions in the same file (`does NOT consume a retry attempt...`) needed no changes — a released claim followed by a fresh claim on retry still ends with exactly one `sent` row.
- **Files modified:** `apps/worker/src/queues/__tests__/backoff.test.ts`
- **Verification:** `cd apps/worker && npx vitest run src/queues/__tests__/send-dispatch-durability.test.ts src/queues/__tests__/send-dispatch-idempotency.test.ts src/queues/__tests__/backoff.test.ts` — 13/13 pass; full worker suite (`npx vitest run`) — 35/35 pass; `npx tsc --noEmit` clean.
- **Committed in:** `aadb273` (part of Task 3's commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — stale pre-existing tests pinning the exact pre-fix behavior this plan's own spec required changing).
**Impact on plan:** Both fixes were necessary consequences of implementing the plan's literal behavior spec (T-04-12-01/T-04-12-03). No scope creep — no new files, no architectural changes beyond what the plan itself specified.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CR-03 and CR-04 from 04-VERIFICATION.md are closed: dispatch is now provably crash-safe (claim commits before any network call) and 4xx rejections are recorded truthfully.
- The 3-unit dispatch pattern (claim txn / untransacted external call / record txn) is now the established shape for any future SendGrid-calling worker code (e.g. Phase 6 flow-triggered sends reusing this same `processSendJob`).
- No blockers for downstream phases.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All created/modified files and all task commit hashes (223598f, d69f180, aadb273, 438895a) verified present on disk / in git log.
