---
phase: 11-delivery-correctness
plan: 08
subsystem: delivery
tags: [reconciler, state-machine, postgres, row-level-locking, campaign-completion, vitest, bullmq]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (plan 11-03)
    provides: "send-reconciler.worker.ts's original scan-then-claim shape and resolveReconcilingSend's single sent-only exit -- this plan expands both"
  - phase: 11-delivery-correctness (plan 11-05)
    provides: "SEND_MAX_JOB_LIFETIME_MS (apps/worker/src/queues/queue-options.ts) -- the imported floor STALE_DISPATCHING_AGE_MS must exceed with margin"
  - phase: 11-delivery-correctness (plan 11-07)
    provides: "processed webhook evidence provisioned; resolveOneSend already accepted ANY correlated send_events row as evidence, unchanged by this plan"
provides:
  - "packages/delivery-core/src/reconciler.ts -- classifyReconcilableSend, the four-member ReconcileVerdict union, and the three versioned windows (RECONCILE_RESOLUTION_WINDOW_MS, RECONCILE_RESCAN_HORIZON_MS, STALE_DISPATCHING_AGE_MS)"
  - "resolveReconcilingSend widened to a two-verdict union (resolve_sent | resolve_unknown); sweepStaleDispatchingSend and backfillCampaignSendCounter (packages/delivery-core/src/send-ledger.ts)"
  - "tryCompleteCampaign's completion predicate counts reconciling/unknown rows toward sendable_total, backed by migration 0051's sends_campaign_ambiguous_idx"
  - "send-reconciler.worker.ts's full verdict wiring: findReconcilableCandidates discovers reconciling/unknown/stale-dispatching candidates; resolveOneSend switches on all four verdicts; runReconcilerTick returns per-verdict counts"
affects: [11-09, 11-10, 11-11, phase-12, phase-13, phase-15]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure I/O-free verdict-classification module (reconciler.ts) mirroring transport-classify.ts's fail-closed-structural-default shape -- now is always a parameter, never Date.now()"
    - "Narrow discriminated-union verdict parameter (ResolveReconcilingVerdict) as the compile-time enforcement of D-01 -- there is no third member to ever pass 'failed'"
    - "Reconciler-only counter-backfill path (backfillCampaignSendCounter) that deliberately bypasses incrementCampaignSendCounter's WHERE status='sending' guard, exactly-once by construction of the caller's exclusive row transition, not a separate flag column"
    - "Ambiguity-aware campaign completion predicate: dispatching excluded, reconciling/unknown counted, backed by a dedicated partial index (sends_campaign_ambiguous_idx)"

key-files:
  created:
    - packages/delivery-core/src/reconciler.ts
    - packages/delivery-core/src/__tests__/reconciler-classify.test.ts
    - packages/db/migrations/0051_sends_campaign_ambiguous_index.sql
    - apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts
  modified:
    - packages/delivery-core/src/index.ts
    - packages/delivery-core/src/send-ledger.ts
    - packages/db/migrations/meta/_journal.json
    - apps/worker/src/queues/send-reconciler.worker.ts
    - apps/worker/src/queues/__tests__/campaign-completion.test.ts
    - apps/worker/src/queues/__tests__/send-timing-invariant.test.ts
    - apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-processed.test.ts
    - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
    - SPECIFICATION.md

key-decisions:
  - "The unknown -> resolve_sent late-evidence re-scan (D-04) measures its horizon from queuedAt, not reconcilingSince -- matching the plan's own <behavior> spec literally; the reconciling -> resolve_unknown resolution-window check uses reconcilingSince (falling back to queuedAt) instead, since that is where ambiguity actually began for that transition."
  - "sent_at's back-dating COALESCE chain dropped the redundant leading sent_at term (11-03's version led with it): a row entering resolve_sent from reconciling/unknown is guaranteed to have sent_at NULL already, so COALESCE(dispatched_at, reconciling_since, queued_at) is behaviorally identical and one term shorter."
  - "resolveOneSend's discriminated outcome type (ResolveOneSendOutcome) replaces the prior boolean return -- a deliberate, plan-mandated shape change ('Return a discriminated outcome the tick can count'), not an incidental break."
  - "runReconcilerTick's return shape renamed resolved -> resolvedSent and split into resolvedSent/markedUnknown/swept, per the plan's own <behavior> spec naming these four keys explicitly."
  - "STALE_DISPATCHING_AGE_MS > SEND_MAX_JOB_LIFETIME_MS and RECONCILE_RESCAN_HORIZON_MS > RECONCILE_RESOLUTION_WINDOW_MS are BOTH asserted in apps/worker's send-timing-invariant.test.ts (not split across packages) -- the plan's own fallback text permits moving both together when the cross-package import is unavailable; only the first inequality strictly needed the move, but keeping both windows' invariants in one file was clearer than splitting an otherwise-identical two-assertion pair across two test projects."
  - "The RECONCILER_BATCH_LIMIT test (505 seeded 'reconciling' rows) was placed LAST in send-reconciler-verdicts.test.ts, with an explicit cleanup DELETE at the end -- vitest's fileParallelism:false guarantees no cross-FILE pollution, but within-file test order is sequential, and 505 rows sorted first by queued_at would otherwise starve every EARLIER test's own (much smaller) candidate set out of the shared discovery LIMIT."

requirements-completed: [DLV-03, DLV-04]

coverage:
  - id: D1
    description: "Every reconciling send reaches a true terminal state: sent when evidence exists, unknown once the resolution window elapses with none -- no row stays ambiguous forever"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/reconciler-classify.test.ts (21 cases, every behavior item + boundaries)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts (resolve_sent/resolve_unknown describe blocks)"
        status: pass
    human_judgment: false
  - id: D2
    description: "An unknown row that receives late evidence inside the re-scan horizon is upgraded to sent by the same sole writer and the same idempotent counter path; past the horizon it is immutable"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts#unknown -> resolve_sent (late evidence within the re-scan horizon, D-04)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A dispatching row older than the stale threshold is swept into reconciling and resolves through the normal evidence path on a later tick; a fresh dispatching row is left alone"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts#sweep_to_reconciling (stale-dispatching sweep, D-08)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The reconciler never writes failed -- resolveReconcilingSend's parameter type admits only resolve_sent/resolve_unknown, a compile-time guarantee, not a review convention"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/reconciler-classify.test.ts#no input combination ever yields a verdict that would write 'failed'"
        status: pass
      - kind: other
        ref: "TypeScript: ResolveReconcilingVerdict has exactly two members; npx tsc -p tsconfig.json --noEmit exits 0 across delivery-core/worker/api"
        status: pass
    human_judgment: false
  - id: D5
    description: "Resolving to sent increments the campaign's sent_count exactly once, even after the campaign has already reached sent, and re-running the tick increments nothing further; a campaign whose last outstanding recipient is ambiguous still completes"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/campaign-completion.test.ts (4 completion cases + 6 direct ledger-function cases)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts#resolve_sent (evidence found)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Two reconciler passes running concurrently over the same candidate set produce exactly one terminal write per row"
    requirement: "DLV-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts#exclusivity: two concurrent ticks produce exactly one terminal write per row (DLV-04)"
        status: pass
    human_judgment: false
  - id: D7
    description: "The reconciler makes zero provider calls across a full tick pass, including flow-kind sends which never touch a campaign counter or completion check"
    requirement: "DLV-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts#no network call anywhere in a full tick pass (D-01/D-05); #flow-kind sends never touch a campaign counter or completion check"
        status: pass
    human_judgment: false

# Metrics
duration: ~90min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 08: Full Reconciler Verdict Wiring Summary

**The `reconciler.ts` pure verdict function (four verdicts, three versioned windows, no `resolve_failed`), `send-ledger.ts`'s widened resolution/sweep/backfill functions, an ambiguity-aware campaign completion predicate backed by a new partial index, and `send-reconciler.worker.ts`'s full discovery/classification/counter-backfill wiring -- every ambiguous or orphaned `sends` row now reaches a true terminal state, with campaign completion never blocked by a single unresolved ambiguous recipient.**

## Performance

- **Duration:** ~90 min
- **Completed:** 2026-08-09
- **Tasks:** 3
- **Files modified:** 14 (4 created, 10 modified)

## Accomplishments

- **Task 1 -- pure verdict function:** `packages/delivery-core/src/reconciler.ts` exports `classifyReconcilableSend`, the four-member `ReconcileVerdict` union (`resolve_sent | resolve_unknown | sweep_to_reconciling | hold` -- deliberately no `resolve_failed`), and three versioned constants with rationale comments: `RECONCILE_RESOLUTION_WINDOW_MS` (~24h), `RECONCILE_RESCAN_HORIZON_MS` (~72h), `STALE_DISPATCHING_AGE_MS` (2h, a floor strictly above `SEND_MAX_JOB_LIFETIME_MS`). Pure and I/O-free -- `now` is always a parameter, never `Date.now()` inside the module. 21 test cases in `reconciler-classify.test.ts` cover every `<behavior>` item including exact threshold boundaries and the local `RECONCILE_RESCAN_HORIZON_MS > RECONCILE_RESOLUTION_WINDOW_MS` invariant.
- **Task 2 -- widened ledger + ambiguity-aware completion:** `resolveReconcilingSend`'s verdict parameter narrowed to a two-member union (`resolve_sent | resolve_unknown`) so writing `failed` from the reconciler is a compile error. New `sweepStaleDispatchingSend` (the second writer of `dispatching -> reconciling`, guarded `WHERE status = 'dispatching'`) and `backfillCampaignSendCounter` (the reconciler-only, post-completion counter path, callable only when `resolveReconcilingSend` reports an actual transition). `tryCompleteCampaign`'s predicate now counts `reconciling`/`unknown` rows toward `sendable_total` (deliberately excluding `dispatching`), backed by new migration `0051_sends_campaign_ambiguous_index.sql`'s `sends_campaign_ambiguous_idx`. 14 tests in `campaign-completion.test.ts` cover all four completion cases and six direct ledger-function behaviors.
- **Task 3 -- full verdict wiring:** `send-reconciler.worker.ts`'s discovery query widened to find `reconciling`/`unknown` rows plus stale-`dispatching` rows (age bound passed as a parameter, `now() - ($1::bigint * INTERVAL '1 millisecond')`, never interpolated). `resolveOneSend` re-verifies the full candidate shape under `FOR UPDATE SKIP LOCKED`, classifies via `classifyReconcilableSend`, and switches on all four verdicts -- `resolve_sent` backfills the campaign counter and checks completion only when the row actually transitioned AND `campaignId` is non-null (flow-kind sends never touch either); `sweep_to_reconciling` performs no further classification in the same transaction. `runReconcilerTick` returns `{ scanned, resolvedSent, markedUnknown, swept }`. New `send-reconciler-verdicts.test.ts` (11 tests) proves every `<behavior>` item against live Postgres, including the `Promise.all` two-concurrent-ticks exclusivity proof, the zero-network-call assertion, and the batch-limit cap.
- `SPECIFICATION.md` gained/updated entries in §4.5 (new index), §4.6 (migration count/journal), and a full rewrite of §5.10 (the three windows, the widened discovery/resolution/counter-backfill wiring), per the binding CLAUDE.md rule.

## Task Commits

1. **Task 1: Pure reconciliation verdict function with versioned windows** - `bea875c` (feat)
2. **Task 2: Sole-writer resolution widened, idempotent counter backfill, ambiguity-aware completion** - `a1f30a8` (feat)
3. **Task 3: Full verdict wiring in the reconciler tick** - `3415044` (feat, includes the necessary pre-existing-test updates described below)

**Plan metadata:** (this commit) — docs: complete plan

## Files Created/Modified

- `packages/delivery-core/src/reconciler.ts` - `classifyReconcilableSend`, `ReconcileVerdict`, `ReconcileInput`, the three versioned window constants
- `packages/delivery-core/src/__tests__/reconciler-classify.test.ts` - 21 cases covering every Task 1 `<behavior>` item
- `packages/delivery-core/src/index.ts` - exports the new reconciler.ts symbols and send-ledger.ts's widened/new functions
- `packages/delivery-core/src/send-ledger.ts` - `resolveReconcilingSend` widened, `sweepStaleDispatchingSend`, `backfillCampaignSendCounter`, `tryCompleteCampaign`'s ambiguity-aware predicate
- `packages/db/migrations/0051_sends_campaign_ambiguous_index.sql` - `sends_campaign_ambiguous_idx`
- `packages/db/migrations/meta/_journal.json` - registers migration 51
- `apps/worker/src/queues/__tests__/campaign-completion.test.ts` - 4 completion cases + 6 direct ledger-function cases
- `apps/worker/src/queues/send-reconciler.worker.ts` - widened discovery, full `resolveOneSend` verdict switch, `runReconcilerTick`'s new per-verdict counts
- `apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts` - new, 11 tests covering every Task 3 `<behavior>` item
- `apps/worker/src/queues/__tests__/send-timing-invariant.test.ts` - the two cross-package inequality assertions (`STALE_DISPATCHING_AGE_MS`/`RECONCILE_RESCAN_HORIZON_MS`)
- `apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts` - `.resolved` -> `.resolvedSent` (necessary rename update)
- `apps/worker/src/queues/__tests__/webhook-events-processed.test.ts` - same rename update
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` - `resolveOneSend`'s call site widened to the full candidate shape; assertions updated to the discriminated outcome
- `SPECIFICATION.md` - §4.5/4.6/5.10 updated

## Decisions Made

See `key-decisions` in frontmatter. In short: the `unknown` re-scan horizon measures age from `queuedAt` per the plan's literal `<behavior>` wording, while the `reconciling` resolution window measures from `reconcilingSince` (falling back to `queuedAt`); `sent_at`'s back-dating COALESCE chain dropped a redundant leading term; `resolveOneSend`/`runReconcilerTick`'s return shapes changed deliberately per the plan's own instructions, not incidentally; both cross-package inequality assertions landed together in `apps/worker`'s test file since only one strictly needed the move; the batch-limit test was placed last with explicit cleanup to avoid starving earlier tests' candidate sets out of the shared discovery LIMIT within the same file.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1/3 - Necessary consequence of a plan-mandated shape change] Pre-existing tests referencing `runReconcilerTick`'s old `resolved` field and `resolveOneSend`'s old boolean return**
- **Found during:** Task 3 (repo-wide typecheck after rewriting `send-reconciler.worker.ts`)
- **Issue:** The plan's own Task 3 `<action>` explicitly mandates renaming/widening these return shapes ("Widen `runReconcilerTick` to accumulate and return `{ scanned, resolvedSent, markedUnknown, swept }`"; "Return a discriminated outcome the tick can count"). Three pre-existing test files -- `send-reconciler-tracer.test.ts`, `webhook-events-processed.test.ts` (both asserting `.resolved`), and `negative-cross-tenant-jobs.test.ts` (calling `resolveOneSend` with a partial object and asserting a boolean) -- failed to typecheck/assert correctly against the new shapes. The plan's own acceptance criteria explicitly require all three files to still pass (`send-reconciler-tracer.test.ts` and `webhook-events-processed.test.ts` named directly; `negative-cross-tenant-jobs.test.ts` via the general "no regression" expectation and its own SEC-16 coverage-gate role).
- **Fix:** Renamed `.resolved` -> `.resolvedSent` at both call sites; widened `negative-cross-tenant-jobs.test.ts`'s manually-constructed candidate object to the full `ReconcilableCandidateRow` shape (the extra fields are inert placeholders for its cross-tenant-mismatch case, which never reaches classification) and updated its two boolean assertions to `.toEqual({ kind: "hold" })` / `.toEqual({ kind: "resolve_sent", resolved: true })`.
- **Files modified:** `apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts`, `apps/worker/src/queues/__tests__/webhook-events-processed.test.ts`, `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
- **Verification:** `npx tsc -p tsconfig.json --noEmit` (apps/worker) exits 0; all three files' full suites pass (7 + 15 tests respectively, verified together and individually).
- **Committed in:** `3415044` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (a necessary, plan-anticipated consequence of a deliberate return-shape change -- mirrors 11-03's own precedent of updating pre-existing tests when a plan's action explicitly changes a function's contract).
**Impact on plan:** None beyond the named files -- no new access path, no scope creep, no behavior change beyond what Task 3's own `<action>` text already specified.

## Issues Encountered

- The RECONCILER_BATCH_LIMIT test's 505 seeded rows initially starved a later test's own candidate set out of the shared discovery `LIMIT` (both tests share one physical test database, `queued_at ASC` ordering means the earliest-seeded rows always sort first). Resolved by moving the batch-limit describe block to the end of the file and adding an explicit cleanup `DELETE` at the end of that test -- not a plan deviation, a test-design correction made before any commit.

## Known Stubs

None.

## Threat Flags

None -- every new surface (the widened discovery query's bound parameter, the ambiguity-aware completion subquery, the reconciler-only counter backfill) is already covered by this plan's own `<threat_model>` (T-11-08-01 through T-11-08-07), and this plan's tests exercise each one directly:
- T-11-08-01 (double counter increment) -- mitigated, proven by `campaign-completion.test.ts`'s "guard" tests and `send-reconciler-verdicts.test.ts`'s re-run-the-tick assertions.
- T-11-08-02 (concurrent ticks) -- mitigated, proven by the `Promise.all` exclusivity test.
- T-11-08-03 (stale sweep racing a live job) -- mitigated by the imported `SEND_MAX_JOB_LIFETIME_MS` floor, asserted in `send-timing-invariant.test.ts`.
- T-11-08-04 (reconciler inventing a `failed` verdict) -- mitigated at the type level; `ReconcileVerdict`/`ResolveReconcilingVerdict` admit no such member.
- T-11-08-05 (evidence read crossing tenants) -- unchanged from 11-03's existing `withTenant`/`withTenantTransaction` discipline; no new surface introduced.
- T-11-08-06 (unbounded tick work) -- mitigated by `RECONCILER_BATCH_LIMIT`, proven (best-effort, within-file) by the batch-cap test.
- T-11-08-07 (tick logging) -- mitigated; `scrubbedConsole.log` carries only the four counts.

## User Setup Required

None - no external service configuration required. Both Postgres and Redis were already running locally via the existing test harness; no new environment variables introduced.

## Next Phase Readiness

- `DLV-03`/`DLV-04` are now complete for the full reconciler surface: `resolve_sent`, `resolve_unknown`, `sweep_to_reconciling`, and their interaction with campaign completion are all implemented and tested. No row can remain ambiguous forever, and no row can be stuck in `dispatching` forever regardless of what Redis lost.
- Explicitly NOT built here, and owned by named later plans: the reconciler health row / watchdog alerting (D-14, likely 11-09), flow-path parity beyond the flow-kind resolve_sent case already proven here (this plan's flow coverage is the resolve_sent path only -- `claimFlowSend`'s own interrupted branch and flow-specific crash scenarios are DLV-08's job), and the `AbortController` timeout work already landed in 11-05.
- No stub was left where an architectural decision belongs -- every gap above is a functional omission already named to a specific later plan.

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: packages/delivery-core/src/reconciler.ts
- FOUND: packages/delivery-core/src/__tests__/reconciler-classify.test.ts
- FOUND: packages/db/migrations/0051_sends_campaign_ambiguous_index.sql
- FOUND: apps/worker/src/queues/__tests__/send-reconciler-verdicts.test.ts
- FOUND: this SUMMARY.md on disk
- FOUND commit: bea875c (Task 1)
- FOUND commit: a1f30a8 (Task 2)
- FOUND commit: 3415044 (Task 3)
