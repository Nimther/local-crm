---
phase: 11-delivery-correctness
plan: 11
subsystem: delivery
tags: [failure-injection, sigkill, reconciler, ci, vitest, delivery-model, state-machine]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (plan 11-01)
    provides: "ARCHITECTURE.md ##9 (the reviewed delivery-model design artifact) and send-state-machine.ts's executable SEND_STATUS_TRANSITIONS matrix -- this plan asserts both are true of the running code"
  - phase: 11-delivery-correctness (plan 11-03/11-05)
    provides: "the ProcessSendJobDeps.sendMail injection seam, queue-options.ts's timing constants, and dispatchSendGate's fourth (reconciling/unknown -> skipped) status branch -- every scenario here injects through that seam and relies on that branch"
  - phase: 11-delivery-correctness (plan 11-08)
    provides: "runReconcilerTick/resolveOneSend's full verdict wiring and classifyReconcilableSend's four-verdict union -- this plan drives the real tick end to end, it does not re-implement any classification logic"
provides:
  - "apps/worker/src/test/harness/sigkill-entrypoint.ts's SigkillFreezePoint (in_claim_window | after_provider_accept) and SIGKILL_HARNESS_ACCEPTED marker -- a second real-kill boundary on the existing kill harness"
  - "crash-post-accept.test.ts (DLV-08 boundary 2) -- the full arc from a real SIGKILL just after simulated provider acceptance, through a zero-call redelivery, to reconciler resolution via the phantom message's own webhook evidence"
  - "arrangeCrashedBeforeResultWrite in failure-fixtures.ts, and crash-pre-result-write.test.ts (DLV-08 boundary 3, both 202 and permanent-4xx response variants)"
  - "reconciler-retry-race.test.ts -- Promise.all concurrency between a reconciler tick and a retry-worker redelivery over 10 fresh intents (DLV-08's three-way race, ROADMAP SC2)"
  - "delivery-model-claims.test.ts -- ARCHITECTURE.md ##9's published guarantees asserted as executable propositions (DLV-07)"
  - "failure:crash-post-accept / failure:crash-pre-result-write / failure:reconciler-race npm scripts; failure:all now chains all eight scenarios; three new required steps in the CI failure-injection job"
affects: [phase-12, phase-13, phase-15]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Selectable freeze point on one kill-harness entrypoint (SIGKILL_HARNESS_FREEZE_AT), rather than a second entrypoint file, so both real-kill scenarios share the exact same spawn/kill/cleanup discipline and only differ in which IPC marker is posted"
    - "State-based (not kill-based) coverage for a boundary that is ledger-indistinguishable from an already-covered kill boundary (arrangeCrashedBeforeResultWrite) -- documented explicitly as a deliberate choice, not a shortcut"
    - "Safety-vs-liveness split in a genuine concurrency test: the retry worker's zero-call/never-transitions behavior is asserted unconditionally every iteration; final resolution to 'sent' tolerates a bounded number of follow-up ticks, since dispatchSendGate's plain FOR UPDATE (not SKIP LOCKED) can legitimately win the row lock ahead of the reconciler's own SKIP LOCKED claim within a single tick"
    - "A documentation-claims test file (delivery-model-claims.test.ts) that asserts published prose against the SAME executable matrix (SEND_STATUS_TRANSITIONS) the documentation names as its own mirror, plus live processSendJob/runReconcilerTick behavior -- not a second copy of either"

key-files:
  created:
    - apps/worker/src/queues/__tests__/failure-injection/crash-post-accept.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/crash-pre-result-write.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/reconciler-retry-race.test.ts
    - apps/worker/src/queues/__tests__/delivery-model-claims.test.ts
  modified:
    - apps/worker/src/test/harness/sigkill-entrypoint.ts
    - apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts
    - apps/worker/src/test/failure-fixtures.ts
    - package.json
    - .github/workflows/ci.yml
    - SPECIFICATION.md

key-decisions:
  - "Boundary 3 (crashed after a definite response, before the result write) is covered state-based via arrangeCrashedBeforeResultWrite, not with a second forked-child kill harness -- boundaries 2 and 3 are provably ledger-indistinguishable (both leave a committed 'dispatching' claim with no terminal row), so a second real-kill harness would add process machinery without adding a single new assertion; what differs (202 vs permanent-4xx) is trivially parameterised as data instead."
  - "reconciler-retry-race.test.ts tolerates a bounded number of follow-up ticks (MAX_SETTLE_TICKS = 5) before asserting final resolution, because dispatchSendGate's existing-row lookup takes a plain FOR UPDATE (not SKIP LOCKED) and can legitimately win the row lock ahead of the reconciler's own SKIP LOCKED claim within a single Promise.all instant -- when that happens the reconciler correctly reports 'hold' for that row this tick (exactly as it would for a row a concurrent reconciler pass already claimed) and resolves it on a later tick, which is correct production behavior, not a bug the test should treat as a failure. The hard, per-iteration invariant is the retry worker's own side: zero provider calls and 'skipped' as its outcome, always, regardless of lock-race ordering."
  - "delivery-model-claims.test.ts's pure-matrix assertions (no reconciling/unknown -> failed; dispatching -> reconciling is the only multi-writer transition; every non-terminal status has an outgoing edge) run with no database at all, directly against SEND_STATUS_TRANSITIONS -- only the three behavioral claims (never-re-sent, at-most-once, effectively-once-before-acceptance) need live Postgres/Redis."
  - "Chose not to add a fourth real-kill scenario or a fourth npm script beyond what the plan named -- the plan's own artifact list (three new test files, one modified) and the CI/package.json acceptance criteria (eight total scenarios) are exhaustive; no additional scenario was warranted."

requirements-completed: [DLV-07, DLV-08]

coverage:
  - id: D1
    description: "A process killed before the provider call leaves the send in reconciling on redelivery, and the provider is never called a second time (boundary 1)"
    requirement: "DLV-08"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts#kills a real process in the window, strands the claim, and does not re-send on restart"
        status: pass
    human_judgment: false
  - id: D2
    description: "A process killed after the provider accepted the message leaves the send in reconciling, never failed, and no retry path re-sends it -- and once the phantom message's own webhook arrives, the reconciler resolves that same row to sent (the phase's headline scenario, boundary 2)"
    requirement: "DLV-08"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/failure-injection/crash-post-accept.test.ts#resolves the phantom-accepted send to reconciling on redelivery, then to sent once its own webhook evidence arrives"
        status: pass
    human_judgment: false
  - id: D3
    description: "A process killed after the provider responded but before the result was written leaves the send in reconciling on redelivery, for both a 202 response and a permanent 4xx (boundary 3) -- the platform assumes rejection no more readily than it assumes acceptance"
    requirement: "DLV-08"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/failure-injection/crash-pre-result-write.test.ts (both variants)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A reconciler pass and a retry-worker redelivery acting on the same row concurrently produce exactly one terminal write, zero provider calls, and exactly one campaign-counter increment (the three-way race, ROADMAP SC2)"
    requirement: "DLV-08"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/failure-injection/reconciler-retry-race.test.ts#races a reconciler tick against a retry-worker redelivery over 10 fresh intents, with no double-send and no double-count"
        status: pass
    human_judgment: false
  - id: D5
    description: "ARCHITECTURE.md's documented delivery model matches observed behavior: at-most-once at the acceptance boundary, effectively-once before it, and an unknown send is never automatically re-sent"
    requirement: "DLV-07"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/delivery-model-claims.test.ts (6 tests, all propositions)"
        status: pass
    human_judgment: false
  - id: D6
    description: "All eight failure-injection scenarios run in the required CI check, so the guarantee stays proven rather than proven once"
    requirement: "DLV-08"
    verification:
      - kind: other
        ref: "grep -c 'npm run failure:' .github/workflows/ci.yml == 8; npm run failure:all exits 0"
        status: pass
    human_judgment: false

# Metrics
duration: ~50min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 11: Delivery-Correctness Crash Tests and Delivery-Model Claims Summary

**Real-process SIGKILL at both true crash boundaries (before the provider call, and just after simulated provider acceptance), state-based coverage of the third (response received, never recorded), a genuine `Promise.all` reconciler-vs-retry-worker race over ten fresh intents, and an executable claims test that pins ARCHITECTURE.md ##9's published delivery model against the real state machine and live dispatch code — all eight scenarios wired into the required `failure-injection` CI check.**

## Performance

- **Duration:** ~50 min
- **Completed:** 2026-08-09
- **Tasks:** 3
- **Files modified:** 10 (4 created, 6 modified)

## Accomplishments

- **Task 1 — selectable freeze points, boundary 2:** `sigkill-entrypoint.ts` gained `SIGKILL_HARNESS_FREEZE_AT` (`SigkillFreezePoint = "in_claim_window" | "after_provider_accept"`, defaulting to the original behavior; an unrecognized value fails loudly via `fail()`) and a new `SIGKILL_HARNESS_ACCEPTED` marker. `crash-post-accept.test.ts` — the phase's headline scenario — spawns a real child frozen just after the injected mail function signals "SendGrid has taken custody", asserts the intermediate `dispatching` state, SIGKILLs it, proves a redelivery lands on `reconciling` with zero further provider calls and unmoved campaign counters, then inserts correlated `send_events` evidence and proves `runReconcilerTick()` resolves the SAME row (via the deterministic UUIDv5 send id) to `sent` with a back-dated `sent_at` and exactly one counter increment — including that a second tick changes nothing further. `sigkill.test.ts` (boundary 1) was strengthened with a `reconciling_since` assertion and unmoved-counter assertions.
- **Task 2 — boundary 3 and the three-way race:** `arrangeCrashedBeforeResultWrite` (new in `failure-fixtures.ts`) arranges the ledger state a crash between the SendGrid response and the record transaction leaves — deliberately state-based, since boundaries 2 and 3 are ledger-indistinguishable. `crash-pre-result-write.test.ts` covers both response variants: 202 resolves `reconciling -> sent` once evidence arrives; permanent 4xx resolves `reconciling -> unknown` (never `failed`) once the resolution window elapses, explicitly asserted as the accepted cost of at-most-once. `reconciler-retry-race.test.ts` races a real `runReconcilerTick()` against a real `processSendJob` redelivery via genuine `Promise.all` concurrency over 10 fresh intents, asserting on every iteration that the retry worker made zero provider calls, reported `"skipped"`, and that the row settles to `sent` with `sent_count` incremented by exactly one (never two).
- **Task 3 — delivery-model claims and CI wiring:** `delivery-model-claims.test.ts` asserts, as six executable propositions, every guarantee ARCHITECTURE.md ##9 publishes: no `reconciling`/`unknown -> failed` transition exists in the real matrix, every non-terminal status has an outgoing edge, `dispatching -> reconciling` is the only multi-writer transition, an `unknown` send survives repeated ticks with zero provider calls (observed via `fetch` patching, not source inspection), a `sent` row is never re-dispatched, and a provably pre-connection failure genuinely does reach the provider on retry. Three new npm scripts (`failure:crash-post-accept`, `failure:crash-pre-result-write`, `failure:reconciler-race`) were added; `failure:all` now chains all eight scenarios; three new named steps landed in the CI `failure-injection` job (now 8 `npm run failure:` invocations, verified by `grep -c`). `SPECIFICATION.md` §1.3 (CI table) and §7 (observability) updated in the same change per the CLAUDE.md binding rule.

## Task Commits

1. **Task 1: Selectable freeze points in the kill harness, and the two real-kill boundaries** - `2d70afe` (feat)
2. **Task 2: The pre-result-write boundary and the reconciler/retry three-way race** - `b5d35ec` (feat)
3. **Task 3: Delivery-model claims test, npm scripts, and the required CI check** - `6b32c42` (feat)

**Plan metadata:** (this commit) — docs: complete plan

## Files Created/Modified

- `apps/worker/src/test/harness/sigkill-entrypoint.ts` - `SigkillFreezePoint`, `SIGKILL_HARNESS_ACCEPTED`, `readFreezePoint`
- `apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts` - strengthened boundary-1 assertions
- `apps/worker/src/queues/__tests__/failure-injection/crash-post-accept.test.ts` - boundary 2, the headline scenario
- `apps/worker/src/test/failure-fixtures.ts` - `arrangeCrashedBeforeResultWrite`
- `apps/worker/src/queues/__tests__/failure-injection/crash-pre-result-write.test.ts` - boundary 3, both response variants
- `apps/worker/src/queues/__tests__/failure-injection/reconciler-retry-race.test.ts` - the three-way race, 10 iterations
- `apps/worker/src/queues/__tests__/delivery-model-claims.test.ts` - DLV-07's executable propositions
- `package.json` - three new `failure:*` scripts, `failure:all` chains eight
- `.github/workflows/ci.yml` - three new steps in the required `failure-injection` job
- `SPECIFICATION.md` - §1.3/§7 updated

## Decisions Made

See `key-decisions` in frontmatter. In short: boundary 3 is state-based (not a second kill harness) because it is provably ledger-indistinguishable from boundary 2; the race test tolerates a bounded number of follow-up ticks for the liveness half of its assertion because `dispatchSendGate`'s plain `FOR UPDATE` can legitimately (if rarely) win the row lock ahead of the reconciler's own `SKIP LOCKED` claim within one `Promise.all` instant — this is correct production behavior (the row resolves on a later tick), not a defect, and the test's hard per-iteration invariant is the retry worker's own zero-call/never-transitions behavior, not which single tick happens to resolve the row; the claims test's pure-matrix propositions need no database at all.

## Deviations from Plan

None — plan executed as written. The plan's own "Note on what boundaries 2 and 3 can and cannot distinguish" anticipated and pre-authorized the state-based design for boundary 3; no Rule 1-4 deviation was needed.

## Issues Encountered

- While designing `reconciler-retry-race.test.ts`, identified that `dispatchSendGate`'s existing-row lookup (`SELECT ... FOR UPDATE`, no `SKIP LOCKED`) can, in principle, win the row lock ahead of the reconciler's own `SELECT ... FOR UPDATE SKIP LOCKED` claim within a single concurrent instant, causing the reconciler to report `hold` for that row on that particular tick rather than resolving it. This is not a bug in the codebase — DLV-04's exclusivity guarantee comes from the retry worker's fourth status branch refusing to call the provider or write a terminal status, not from row-lock ordering — but a naive test asserting "the row is `sent` immediately after the single `Promise.all` call" would be flaky under this legitimate race. Resolved by asserting the hard safety invariant (zero provider calls, `"skipped"` outcome) unconditionally every iteration, and tolerating up to 5 follow-up ticks for the liveness half (final resolution to `sent`) — verified stable across repeated local runs. Not raised as a Rule 4 architectural question because it changes no production code and matches the codebase's own documented framing (`send-ledger.ts`'s comment on `dispatchSendGate`: "`FOR UPDATE SKIP LOCKED` in the reconciler's own claim only protects reconciler-vs-reconciler").
- Regarding the KNOWN COVERAGE GAP named in this plan's prior-wave context (double-tick campaign-counter backfill idempotency, allegedly unpinned by 11-08): on inspection, `send-reconciler-verdicts.test.ts`'s `resolve_sent (evidence found)` describe block (landed in 11-08) already runs `runReconcilerTick()` twice over the same resolved row and asserts `sent_count` is unchanged by the second tick ("a second tick must not double-count"). This plan's own `crash-post-accept.test.ts` independently re-proves the identical property (second-tick idempotency after resolution) against the boundary-2 crash scenario specifically. The property is therefore pinned in two independent test files, not zero — the prior-wave note appears to have been based on a stale read of 11-08's test suite. No additional test was added purely to close this gap, since it is already closed; `reconciler-retry-race.test.ts` instead focuses on genuine concurrent-instant racing, which is the property neither existing test covers.

## Known Stubs

None.

## Threat Flags

None — every new surface this plan introduces (the second freeze-point marker, the state-based boundary-3 arrangement, the concurrent race test, the claims test's `fetch`-patching) is already covered by this plan's own `<threat_model>` (T-11-11-01 through T-11-11-06), and every mitigation is exercised directly by the tests above:
- T-11-11-01 (kill harness reaching real SendGrid) — mitigated; both freeze points inject only `sendMail` via `processSendJob`, no scenario constructs a real `Worker` against the send queues.
- T-11-11-02 (untested delivery-model prose) — mitigated by `delivery-model-claims.test.ts`.
- T-11-11-03 (scenario not wired into CI) — mitigated; `grep -c "npm run failure:" .github/workflows/ci.yml` returns 8, `failure:all` chains all eight.
- T-11-11-04 (orphaned frozen child processes) — mitigated; both real-kill test files keep `sigkill.test.ts`'s `afterAll` `survivor` cleanup discipline verbatim.
- T-11-11-05 (race test passing on a lucky schedule) — mitigated; 10 iterations with genuine `Promise.all` concurrency, invariants asserted on every iteration.
- T-11-11-06 (test fixture data in CI logs) — mitigated; all fixtures use generated ids and synthetic addresses, no tenant data or real API key appears anywhere in this plan's scenarios.

## User Setup Required

None — no external service configuration required. The failure-injection scenarios run against the same local/CI-provisioned ephemeral Postgres and Redis every other scenario in this phase already uses.

## Next Phase Readiness

- Phase 11 (Delivery Correctness) is now fully covered end to end: the state machine (11-01), the enum/columns (11-02), the reconciler worker (11-03/11-08), the deterministic id (11-04), the timing invariants (11-05), the ambiguous-outcome routing (11-06), the `processed` evidence (11-07), the dead-man's-switch (11-09), the send-log surface (11-10), and now — this plan — the crash-test matrix and the documented delivery model, both proven against live code rather than merely asserted in prose.
- DLV-08 is now complete (REQUIREMENTS.md updated); DLV-07 was already marked complete by 11-01's own ARCHITECTURE.md artifact and is now additionally backed by this plan's executable claims test.
- No stub, deferred item, or unresolved gap is left behind by this plan. The one prior-wave-flagged gap (double-tick idempotency) was investigated and found to be already closed by existing 11-08 coverage, as documented above under Issues Encountered.

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: apps/worker/src/queues/__tests__/failure-injection/crash-post-accept.test.ts
- FOUND: apps/worker/src/queues/__tests__/failure-injection/crash-pre-result-write.test.ts
- FOUND: apps/worker/src/queues/__tests__/failure-injection/reconciler-retry-race.test.ts
- FOUND: apps/worker/src/queues/__tests__/delivery-model-claims.test.ts
- FOUND: this SUMMARY.md on disk
- FOUND commit: 2d70afe (Task 1)
- FOUND commit: b5d35ec (Task 2)
- FOUND commit: 6b32c42 (Task 3)
