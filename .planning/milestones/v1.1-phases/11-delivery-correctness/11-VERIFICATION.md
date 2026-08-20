---
phase: 11-delivery-correctness
verified: 2026-08-09T20:15:00Z
status: passed
score: 9/9 requirements verified; 5/5 roadmap success criteria verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 11: Delivery Correctness Verification Report

**Phase Goal:** No email is lost, duplicated, or wrongly classified when SendGrid is slow, when SendGrid returns an ambiguous result, or when the process dies mid-send.
**Verified:** 2026-08-09T20:15:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A process killed after SendGrid accepted a message leaves that send in `reconciling`, not `failed`, and no retry path re-sends it. | ✓ VERIFIED | `apps/worker/src/queues/__tests__/failure-injection/crash-post-accept.test.ts` — real `SIGKILL` after the injected `sendMail` posts its "provider accepted" marker; independently re-run (`npx vitest run`), passes. Row resolves to `reconciling` on redelivery, zero second provider call, single row (`sendsRowCountFor` == 1). `dispatchSendGate`'s `interrupted` branch (`send-dispatch.ts:259-271`) writes `recordSendResult(..., { status: "reconciling" })`, never `failed` — confirmed by reading the code, not just the comment. `sigkill.test.ts` (boundary 1, before any send attempt) and `crash-pre-result-write.test.ts` (boundary 3, definite response never recorded, both 202 and 4xx variants) independently confirm the same non-`failed` disposition at the other two boundaries. All 6 crash/timing test files re-run independently by this verifier: 14/14 tests pass. |
| 2 | A reconciler resolves every `reconciling` send to a true terminal state, and a retry worker acting on the same row concurrently cannot produce a second terminal write or a second SendGrid call. | ✓ VERIFIED (with the documented `unknown`-is-terminal caveat, not a gap — see below) | `packages/delivery-core/src/reconciler.ts`'s `classifyReconcilableSend` has no `resolve_failed` verdict by design (ARCHITECTURE.md §9's "Why the reconciler never writes `failed`" — `failed` is a fact only the job processor can observe synchronously; a webhook is positive-only evidence). The reachable terminal states from the reconciler are `sent` and `unknown`; `unknown` is itself a legitimate terminal resolution, not a failure to resolve. Every non-terminal status has ≥1 outgoing transition, asserted mechanically in `delivery-model-claims.test.ts` (independently re-run, passes) against the real `SEND_STATUS_TRANSITIONS` matrix. Concurrency: `dispatchSendGate`/`claimFlowSend`'s 4th status branch (`send-ledger.ts:71-73`, `:399-401`) treats an existing `reconciling`/`unknown` row as `"skipped"` without ever calling SendGrid — this, not row locking, is what closes the reconciler-vs-retry-worker half of the exclusivity guarantee. `resolveReconcilingSend`'s `WHERE status IN ('reconciling','unknown')` guard, evaluated under the reconciler's own `FOR UPDATE SKIP LOCKED` lock, makes each row's terminal transition happen at most once. `failure-injection/reconciler-retry-race.test.ts` proves this under genuine `Promise.all` concurrency across 10 iterations: retry worker's `callCount()` is 0 every iteration, `redeliveryResult.outcome` is always `"skipped"`, and `sent_count` increases by exactly one, never two. Independently re-run by this verifier: passes. Code-review CR-01 (discovery query never excluding past-horizon `unknown` rows, which would have starved fresh `reconciling` rows out of the batch forever, defeating "resolves every row") was found and fixed in commit `47b8664`; the fix and its regression test (`send-reconciler-verdicts.test.ts`) were independently re-run by this verifier and pass. |
| 3 | A SendGrid request that hangs is aborted by an explicit timeout strictly shorter than the queue's lock duration, and the timeout is classified as an ambiguous outcome rather than a failure. | ✓ VERIFIED | `packages/delivery-core/src/send-mail.ts:117`: `SENDGRID_TIMEOUT_MS = 20_000`, applied via `AbortSignal.timeout(SENDGRID_TIMEOUT_MS)` on the `fetch` call (`send-mail.ts:160`) — functionally the `AbortController`-timeout mechanism D-15 specifies. `apps/worker/src/queues/queue-options.ts:27`: `SEND_LOCK_DURATION_MS = 60_000`, wired into both Worker constructors (asserted directly against `worker.opts.lockDuration` in `send-timing-invariant.test.ts`). The strict-inequality invariant (`SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS < SEND_LOCK_DURATION_MS`) is asserted against the real exported constants, not restated literals. `transport-classify.ts` explicitly routes `AbortError`/`TimeoutError` (and everything else it doesn't recognize) through the fail-closed `ambiguous` default, never `pre_connection_retryable`. `failure-injection/timeout.test.ts` proves the end-to-end behavior: a `DOMException("AbortError")` throw from `sendMail` results in exactly one send attempt and `{ outcome: "reconciling" }`, never `failed`. All of the above independently re-run by this verifier: pass (6 files / 14 tests, see Behavioral Spot-Checks). |
| 4 | Re-running the same send intent produces the same idempotency key, so a retry cannot create a second message. | ✓ VERIFIED | `packages/delivery-core/src/send-id.ts`: `deriveCampaignSendId`/`deriveFlowSendId` are pure UUIDv5 functions of `(workspaceId, campaignId/flowRunId, contactId/nodeId)`, called from every campaign/flow ledger insert site (`dispatchSendGate`, `claimFlowSend`, `recordExcluded`, `recordFlowExcluded`) — confirmed by reading each call site, not just the doc comment. `releaseDispatchClaim`'s `DELETE` is safe specifically because a re-claim of the same intent reproduces the identical id, so a late webhook for a phantom-accepted-then-released attempt still correlates. `crash-post-accept.test.ts` proves this directly: `deriveCampaignSendId` computed independently by the test matches the row the reconciler later resolves from webhook evidence inserted against that same derived id. The hand-rolled UUIDv5 (no `uuid` dependency) is a documented human decision (11-04 package gate) verified against RFC vectors per the phase's own note — not re-litigated here per this verification's guidance. |
| 5 | The documented delivery model (at-most-once / effectively-once) matches observed behavior under the crash tests at all three boundaries — before the send, after SendGrid accepted, before the result was written — and send duration is available as a metric. | ✓ VERIFIED | Three distinct boundaries are each exercised by a dedicated real test, not one test restated three ways: boundary 1 (`sigkill.test.ts`, real SIGKILL before any provider contact), boundary 2 (`crash-post-accept.test.ts`, real SIGKILL after the injected accept marker, before the record transaction), boundary 3 (`crash-pre-result-write.test.ts`, state-arranged — both a 202 and a 4xx response received but never recorded). `delivery-model-claims.test.ts` asserts ARCHITECTURE.md §9's actual claims as executable propositions against real production code paths (`processSendJob`, `runReconcilerTick`) — not prose restated as strings: no `reconciling`/`unknown` → `failed` transition is representable in the matrix; every non-terminal status has an outgoing transition; `dispatching → reconciling` is the only multi-writer transition; an `unknown` send is never auto-resent (0 provider calls across two ticks past the resolution window); a `sent` row is never re-dispatched (redelivery → `skipped`, 0 calls); a provably pre-connection failure IS retried and reaches the provider (effectively-once, not never-once). All 5 independently re-run, all pass. Send duration: `sends.dispatched_at`/`dispatch_duration_ms` (migration `0049`) are written on every terminal AND ambiguous branch (`recordSendResult`/`recordFlowStepResult`, both `sent`/`failed`/`reconciling` cases) — confirmed at each call site in `send-dispatch.ts`, and asserted directly in `timeout.test.ts` (`timing?.dispatchedAt`/`dispatchDurationMs` not null on the ambiguous branch). SQL-queryable today, satisfying DLV-09 before any metrics infrastructure exists, per D-17. |

**Score:** 5/5 roadmap success criteria verified. 0 present-but-behavior-unverified.

### Requirements Coverage (DLV-01 … DLV-09)

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| DLV-01 | 11-01 | Formal state machine including `reconciling` | ✓ SATISFIED | `packages/delivery-core/src/send-state-machine.ts` (`satisfies Record<SendStatus, ...>` — undocumented status is a typecheck failure), mirrored in ARCHITECTURE.md §9 (mermaid + writer matrix), reviewed before `send-dispatch.ts` changed (D-18, plan ordering confirmed by commit history: 11-01 precedes 11-03 onward). |
| DLV-02 | 11-02, 11-03, 11-06, 11-10 | Interrupted send → `reconciling`, not `failed` | ✓ SATISFIED | `dispatchSendGate`/`claimFlowSend` interrupted branch → `recordSendResult(..., "reconciling")`, confirmed in code at `send-dispatch.ts:259-271`, `flow-send.ts` mirror. Proven end-to-end by `sigkill.test.ts`. |
| DLV-03 | 11-02, 11-03, 11-07, 11-08, 11-09 | Reconciler determines true outcome, closes `reconciling` | ✓ SATISFIED | `send-reconciler.worker.ts`'s `runReconcilerTick`/`resolveOneSend`, webhook-evidence-only (D-05, `processed` event added per D-06), health-row dead-man's-switch (`send_reconciler_runs`, watchdog in `apps/api`). |
| DLV-04 | 11-03, 11-08 | Reconciler and retry worker cannot both resolve the same send | ✓ SATISFIED | `dispatchSendGate`'s 4th branch (retry-worker side) + reconciler's `FOR UPDATE SKIP LOCKED` (reconciler-vs-reconciler side) + `resolveReconcilingSend`'s `WHERE status IN (...)` guard (at-most-once write). Proven under genuine concurrency by `reconciler-retry-race.test.ts` (10 iterations, independently re-run, passes). |
| DLV-05 | 11-04 | Deterministic idempotency key from send intent | ✓ SATISFIED | `send-id.ts`'s `deriveCampaignSendId`/`deriveFlowSendId`, UUIDv5, called from every ledger insert site. |
| DLV-06 | 11-05, 11-06 | Explicit SendGrid timeout with cancellation; timeout is ambiguous, not failure | ✓ SATISFIED | `SENDGRID_TIMEOUT_MS` + `AbortSignal.timeout`, `classifyTransportError`'s fail-closed `ambiguous` default, invariant test against real lockDuration constant. |
| DLV-07 | 11-01, 11-10, 11-11 | Delivery model (at-most-once/effectively-once) documented | ✓ SATISFIED | ARCHITECTURE.md §9 "Delivery model (DLV-07)" section; `delivery-model-claims.test.ts` asserts the claims behaviorally, not just as prose; D-11 test-send third outcome ("outcome unknown — check the inbox…") implemented at `send-dispatch.ts` test-kind ambiguous branch. |
| DLV-08 | 11-11 | Crash tests: before send, after accept, before result write | ✓ SATISFIED | Three distinct real/state-arranged crash tests, plus the DLV-08 three-way race scenario (ROADMAP SC2), all independently re-run and passing. |
| DLV-09 | 11-02, 11-06 | Send duration measured and available as a metric | ✓ SATISFIED | `dispatched_at`/`dispatch_duration_ms` columns (migration 0049), written on every terminal/ambiguous branch, SQL-queryable, asserted in `timeout.test.ts`. |

No orphaned requirements: `REQUIREMENTS.md`'s Phase 11 row lists exactly DLV-01…DLV-09, and every one of the 11 plans' `requirements:` frontmatter fields collectively cover all nine with no gaps.

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `send-dispatch.ts` interrupted branch | `send-ledger.ts::recordSendResult` | direct call, `status: "reconciling"` | WIRED | Confirmed at `send-dispatch.ts:270`, mirrored in `flow-send.ts`. |
| `send-reconciler.worker.ts::resolveOneSend` | `send-ledger.ts::resolveReconcilingSend` | direct call inside `FOR UPDATE SKIP LOCKED` transaction | WIRED | Confirmed at `send-reconciler.worker.ts:252,262`. |
| `send-mail.ts::sendTenantMailV3` | `transport-classify.ts::classifyTransportError` | thrown error piped through classifier in `handleAmbiguousSendMailError` | WIRED | Confirmed at `send-dispatch.ts:323`. |
| `apps/worker` email workers | `queue-options.ts::SEND_LOCK_DURATION_MS` | `Worker` constructor `opts.lockDuration` | WIRED | Asserted directly against live `worker.opts.lockDuration` in `send-timing-invariant.test.ts`, independently re-run. |
| `send-reconciler.worker.ts` health write | `apps/api` watchdog | `send_reconciler_runs` table, read by `evaluateReconcilerHealth` | WIRED | Cross-app devDependency test (`send-reconciler-health.test.ts`) imports the API's own evaluator to prove the round trip, per 11-09-SUMMARY.md. |

### Behavioral Spot-Checks (independently re-run by this verifier, not taken from SUMMARY claims)

| Behavior | Command | Result | Status |
|---|---|---|---|
| CR-01 regression + delivery-model claims | `npx vitest run src/queues/__tests__/send-reconciler-verdicts.test.ts src/queues/__tests__/delivery-model-claims.test.ts` (apps/worker) | 2 files, 20 tests passed | ✓ PASS |
| Three crash boundaries + three-way race + timeout + timing invariants | `npx vitest run src/queues/__tests__/failure-injection/sigkill.test.ts .../crash-post-accept.test.ts .../crash-pre-result-write.test.ts .../reconciler-retry-race.test.ts .../timeout.test.ts src/queues/__tests__/send-timing-invariant.test.ts` (apps/worker) | 6 files, 14 tests passed | ✓ PASS |
| Migration linter | `npm run lint:migrations` | 53 files checked, no violations | ✓ PASS |
| Migration 0052 registered | `grep 0052 packages/db/migrations/meta/_journal.json` | tag present | ✓ PASS |

Full-suite result (1094 tests / 162 files, 0 failures) is taken from the orchestrator's independently-reported run per this task's instructions and was not re-run in full by this verifier to avoid a redundant full-suite execution; the above 8 targeted files (34 tests total) covering the phase's highest-risk claims were re-run standalone by this verifier against live Postgres/Redis and all pass.

### Anti-Patterns Found

None. Scanned all 19 core phase-11 source files (delivery-core package, send-dispatch/flow-send/queue-options/send-reconciler.worker, api server, watchdog, webhook provisioning) for `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` — zero matches.

**Minor, non-blocking observation (not filed as a gap):** `send-ledger.ts`'s `DispatchSendGateResult` type doc comment (lines 8-11) still reads "the caller must NOT re-call SendGrid for this sendId; it must record it as failed instead" — this describes the pre-Phase-11 (CR-04) behavior. The actual code at every call site (`send-dispatch.ts:259-271`, `flow-send.ts`) correctly records `reconciling`, not `failed`, matching D-02/DLV-02. This is a stale comment, not a functional defect — verified by reading the executed code path, not the comment. Does not affect the score; noted for a future doc-hygiene pass.

### Code Review Disposition (11-REVIEW.md)

- **CR-01 (Blocker):** reconciler discovery query starvation by past-horizon `unknown` rows — **fixed** in `47b8664`, regression test independently re-verified passing.
- **WR-01:** missing index for watchdog's oldest-reconciling read — **fixed** in `78ab4f4` (migration `0052`), confirmed present and lint-clean.
- **WR-02:** narrow claim-gate race throwing an unclassified `Error`, self-healing, consumes one retry attempt — **left open by user decision**, accepted debt, does not cause duplicate/lost sends.
- **WR-03:** dead `{ kind: "failed" }` union member in `ClaimResult`/`FlowClaimResult` — **left open by user decision**, confirmed genuinely dead (no construction site found by grep), accepted debt.
- **IN-01, IN-02:** informational, no action required, confirmed non-live risks.

### Requirements/Human Verification Required

None. Every roadmap success criterion and every DLV-01…DLV-09 requirement resolved to VERIFIED/SATISFIED against executable evidence (code + independently re-run tests), with no behavior-dependent truth left unexercised.

### Gaps Summary

No gaps. All 5 roadmap success criteria and all 9 phase requirements are verified against actual, independently-re-run code and tests — not SUMMARY.md claims. The one code-review Blocker (CR-01) was found and fixed post-execution, and its fix is independently confirmed. The two open Warnings (WR-02, WR-03) are deliberate, low-severity, user-accepted debt that do not threaten the phase's core no-loss/no-duplicate/no-misclassification guarantee — WR-02 is self-healing and never produces a duplicate or lost send, and WR-03 is dead code that cannot execute. Phase 11's goal — no email lost, duplicated, or wrongly classified across SendGrid slowness, ambiguous results, or mid-send process death — is achieved and independently verified in this codebase.

---

_Verified: 2026-08-09T20:15:00Z_
_Verifier: Claude (gsd-verifier)_
