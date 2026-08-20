---
phase: 11-delivery-correctness
plan: 03
subsystem: delivery
tags: [bullmq, postgres, row-level-security, reconciliation, state-machine, vitest, sendgrid]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (plan 11-01)
    provides: "SEND_STATUS_TRANSITIONS executable state machine -- the reconciling->sent/unknown transition table and sole-writer rule this plan implements against"
  - phase: 11-delivery-correctness (plan 11-02)
    provides: "send_status enum values reconciling/unknown, sends.reconciling_since/dispatched_at/dispatch_duration_ms columns, sends_status_queued_at_idx"
  - phase: 10-tenant-isolation-trust-boundaries
    provides: "withCrossWorkspaceScan + mega_crm_scan role -- the reconciler's cross-workspace discovery entry point, adopted not re-implemented"
provides:
  - "resolveReconcilingSend (packages/delivery-core/src/send-ledger.ts) -- the sole audited exit from reconciling/unknown, guarded by its own WHERE status IN (...) clause"
  - "send-reconciler.worker.ts -- classification-only reconciler tick (findReconcilableCandidates, resolveOneSend, runReconcilerTick, createSendReconcilerWorker), registered in apps/worker/src/server.ts"
  - "claimCampaignSend's interrupted branch now writes 'reconciling' (DLV-02), never 'failed', and never increments campaign counters"
  - "Fourth status branch in dispatchSendGate/claimFlowSend: reconciling/unknown -> \"skipped\" (the retry-worker half of DLV-04)"
  - "recordExcluded/recordFlowExcluded's CR-07 guard extended to exclude reconciling/unknown (closes RESEARCH.md Pitfall 3)"
  - "SEND_RECONCILER_QUEUE + sendReconcilerTickJobSchema -- the codebase's first job payload carrying an explicit schemaVersion (R-05)"
affects: [11-04, 11-05, 11-06, 11-07, 11-08, 11-09, 12]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reconciler scan-then-per-tenant-claim shape (mirrors flow-reconciliation.worker.ts): unlocked withCrossWorkspaceScan discovery, then withTenant/withTenantTransaction + FOR UPDATE SKIP LOCKED re-verification inside the lock"
    - "schemaVersion job-payload contract (R-05): a version the worker does not recognize is deferred (logged, returned) rather than best-effort-processed -- first use in the codebase, template for Phase 12/14's retrofit of existing payloads"
    - "Sole-audited-exit function pattern: resolveReconcilingSend is the ONLY function permitted to write a status onto a reconciling/unknown row, enforced by its own WHERE status IN (...) guard, not by convention alone"

key-files:
  created:
    - apps/worker/src/queues/send-reconciler.worker.ts
    - apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts
    - apps/worker/src/queues/__tests__/claim-gate-exclusivity.test.ts
  modified:
    - packages/shared-schemas/src/queues.ts
    - packages/delivery-core/src/send-ledger.ts
    - packages/delivery-core/src/index.ts
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/server.ts
    - apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts
    - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
    - SPECIFICATION.md

key-decisions:
  - "resolveReconcilingSend back-dates sent_at (COALESCE(sent_at, dispatched_at, reconciling_since, queued_at)) rather than stamping now() -- workspace_daily_rollup is computed from sent_at::date, so stamping resolution time would silently move a send into the wrong calendar day"
  - "The interrupted branch's counter-skip (no incrementCampaignSendCounter/tryCompleteCampaign call) is deliberate: the reconciler backfills counters exactly once when it resolves the row (that backfill path itself is NOT implemented yet -- it is 11-04+'s expansion; this plan only stops the double-count risk at the source)"
  - "The retry-worker half of DLV-04 is closed by a status BRANCH (dispatchSendGate/claimFlowSend returning \"skipped\" for reconciling/unknown), not by row locking -- FOR UPDATE SKIP LOCKED in the reconciler only protects reconciler-vs-reconciler"
  - "Four pre-existing tests (send-dispatch-durability, timeout, connection-reset, sigkill failure-injection) asserted the pre-Phase-11 'failed' baseline for the interrupted-claim path and were updated to 'reconciling' in this plan, per the plan's own <verification> instruction -- not a scope deviation, a named required update"
  - "negative-cross-tenant-jobs.test.ts's SEC-16 coverage gate (Test 5) required a dedicated cross-tenant proof for the newly-registered SendReconciler family -- added, mirroring flow-reconciliation's own scan-consumer test shape (Rule 3 auto-fix, see Deviations)"

requirements-completed: [DLV-02, DLV-03, DLV-04]

coverage:
  - id: D1
    description: "An interrupted send (committed 'dispatching' claim, prior attempt never reached a terminal write) is redelivered, lands in 'reconciling' (not 'failed'), never re-calls SendGrid, and does not move the campaign's failed_count"
    requirement: "DLV-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "The reconciler tick discovers a 'reconciling' row across workspaces, correlates send_events evidence by send_id inside a per-tenant transaction (no provider call anywhere in the reconciler), and resolves it to 'sent'"
    requirement: "DLV-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts"
        status: pass
      - kind: other
        ref: "grep -rn \"sendTenantMailV3|api.sendgrid.com\" apps/worker/src/queues/send-reconciler.worker.ts (no matches)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Running the reconciler tick twice over the same resolved row produces exactly one terminal write (idempotent); two reconciler passes cannot both resolve the same row (FOR UPDATE SKIP LOCKED); a retry worker redelivered onto a reconciling/unknown row returns 'skipped' with zero provider calls; recordExcluded/recordFlowExcluded leave reconciling/unknown rows untouched"
    requirement: "DLV-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts (second runReconcilerTick() resolved===0)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/claim-gate-exclusivity.test.ts (10 assertions)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts (send-reconciler describe block -- cross-tenant resolveOneSend mismatch returns false)"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 03: Send Reconciler Tracer -- Interrupted Send Resolves reconciling -> sent Summary

**End-to-end DLV-02/03/04 tracer: an interrupted campaign send now lands in `reconciling` instead of `failed`, a new classification-only `send-reconciler.worker.ts` discovers it across workspaces and resolves it to `sent` purely from webhook evidence in `send_events` (never calling SendGrid), and both halves of DLV-04's exclusive-claim guarantee (reconciler-vs-reconciler row locking, retry-worker-vs-reconciler status branch) are independently proven.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-09 (immediately after 11-02's closeout)
- **Completed:** 2026-08-09T10:44:42+05:00 (final Task 2 deviation-fix commit)
- **Tasks:** 2 (tracer + retry-worker-half-of-DLV-04)
- **Files modified:** 15 (3 created, 12 modified)

## Accomplishments

- **Layer 1 (queue contract):** `SEND_RECONCILER_QUEUE`, `SEND_RECONCILER_TICK_SCHEMA_VERSION = 1`, and `sendReconcilerTickJobSchema` in `packages/shared-schemas/src/queues.ts` -- the codebase's first job payload carrying an explicit `schemaVersion` (R-05 deploy-safety contract).
- **Layer 2 (the sole audited exit):** `resolveReconcilingSend` in `packages/delivery-core/src/send-ledger.ts` -- the ONLY function permitted to write a status onto a `reconciling`/`unknown` row, enforced by its own `WHERE status IN ('reconciling', 'unknown')` guard. Back-dates `sent_at` via `COALESCE(sent_at, dispatched_at, reconciling_since, queued_at)` rather than stamping resolution time, so `workspace_daily_rollup`'s `sent_at::date` grouping is never silently shifted. `recordSendResult`'s status union widened to include `"reconciling"`, setting `reconciling_since` once via `COALESCE(reconciling_since, now())`.
- **Layer 3 (the worker's interrupted branch):** `claimCampaignSend`'s `interrupted` branch now calls `recordSendResult(client, sendId, { status: "reconciling" })`, stops calling `incrementCampaignSendCounter`/`tryCompleteCampaign` (the reconciler owns that backfill in a later plan), and returns a new `{ kind: "reconciling"; sendId }` claim result. `SendJobResult` gains `{ outcome: "reconciling"; sendId }`.
- **Layer 4 (the reconciler):** `apps/worker/src/queues/send-reconciler.worker.ts` -- `findReconcilableCandidates()` (unlocked `withCrossWorkspaceScan` discovery, `RECONCILER_BATCH_LIMIT = 500`), `resolveOneSend(row)` (`withTenant`/`withTenantTransaction`, `FOR UPDATE SKIP LOCKED`, evidence read from `send_events` only inside the per-tenant transaction since `mega_crm_scan` has no grant there), `runReconcilerTick()`, and `createSendReconcilerWorker()` (`upsertJobScheduler`, `RECONCILER_TICK_MS = 5 * 60_000`, fire-and-forget `try/catch/finally` registration copied in shape from `partition-maintenance.worker.ts`). No dedicated `Pool` -- all per-tenant work goes through the shared `@mega-crm/tenant-context` pool.
- **Layer 5 (registration):** `createSendReconcilerWorker` added to `apps/worker/src/server.ts`'s `workers` array and the startup log line (now 15 registered workers).
- **Layer 6 (the end-to-end proof):** `send-reconciler-tracer.test.ts` drives the whole path against live Postgres/Redis: interrupted redelivery -> `reconciling` (zero provider calls, `failed_count` unchanged) -> `send_events` evidence inserted -> `runReconcilerTick()` resolves to `sent` (back-dated `sent_at`, `reconciling_since` null, zero provider calls) -> a second tick reports `resolved === 0`.
- **Task 2 (the retry-worker half of DLV-04):** fourth status branch in `dispatchSendGate`/`claimFlowSend` returns `"skipped"` for `reconciling`/`unknown` -- this branch, not row locking, is what stops a redelivered/retried job from ever calling SendGrid for a row the reconciler owns. `recordExcluded`/`recordFlowExcluded`'s CR-07 `NOT IN` guard extended to the same two states, closing RESEARCH.md Pitfall 3 (a redelivered exclusion re-walk can no longer stomp an in-flight reconciliation back to `excluded`). `claim-gate-exclusivity.test.ts` proves all eight `<behavior>` items plus the `processSendJob`-level zero-provider-call case and the pre-existing `excluded`-row re-classification regression guard.
- `SPECIFICATION.md` §5 gained §5.10 documenting the `send-reconciler` queue, its scheduler registration, discovery/claim/classification mechanics, the `schemaVersion` convention, and the `send-dispatch.ts` interrupted-branch change -- per the binding CLAUDE.md rule.

## Task Commits

Each task was committed atomically (plus one required deviation-fix commit inside Task 2's scope):

1. **Task 1: End-to-end "an interrupted send is reconciled to sent"** - `fbfaae8` (feat)
2. **Task 2: The retry-worker half of DLV-04** - `dd18565` (feat)
3. **Deviation fix (Rule 3, within Task 2): SEC-16 coverage gate for SendReconciler** - `90f044f` (fix)

**Plan metadata:** (this commit) — docs: complete plan

## Files Created/Modified

- `packages/shared-schemas/src/queues.ts` - `SEND_RECONCILER_QUEUE`, `SEND_RECONCILER_TICK_SCHEMA_VERSION`, `sendReconcilerTickJobSchema`
- `packages/delivery-core/src/send-ledger.ts` - `resolveReconcilingSend`, `recordSendResult`'s widened status union, fourth status branch in `dispatchSendGate`/`claimFlowSend`, extended `NOT IN` guards in `recordExcluded`/`recordFlowExcluded`
- `packages/delivery-core/src/index.ts` - Exports `resolveReconcilingSend`/`ResolveReconcilingResult`
- `apps/worker/src/queues/send-dispatch.ts` - Interrupted branch rewrite, `SendJobResult`/`ClaimResult` gain `reconciling` variants
- `apps/worker/src/queues/send-reconciler.worker.ts` - New reconciler tick worker (discovery, claim, classification, registration)
- `apps/worker/src/server.ts` - Registers `createSendReconcilerWorker`, updates startup log
- `apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts` - New end-to-end proof
- `apps/worker/src/queues/__tests__/claim-gate-exclusivity.test.ts` - New DLV-04 retry-worker-half proof
- `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts` - CR-04 assertion updated `failed` -> `reconciling`
- `apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts` - Same update, named baseline supersession
- `apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts` - Same update
- `apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts` - Same update
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` - New `send-reconciler` scan-consumer describe block; `SendReconciler` added to `COVERED_FAMILIES`
- `SPECIFICATION.md` - New §5.10, updates to §5.1/§5.2/§5.3/§5.8

## Decisions Made

See `key-decisions` in frontmatter. In short: `resolveReconcilingSend`'s back-dated `sent_at` is load-bearing for rollup correctness; the interrupted branch's counter-skip is deliberate incompleteness (the actual backfill path is a later plan's job); DLV-04's retry-worker half is a status branch, not a lock; four pre-existing tests' `failed` assertions were the named, planned update this plan executes; the SEC-16 coverage gate required a new cross-tenant test for the newly-registered worker family.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `negative-cross-tenant-jobs.test.ts`'s Test 5 coverage gate failed after registering `createSendReconcilerWorker`**
- **Found during:** Task 2 (post-commit full `apps/worker` test run)
- **Issue:** Task 1 registered `createSendReconcilerWorker` in `apps/worker/src/server.ts`'s `workers` array. `negative-cross-tenant-jobs.test.ts`'s Test 5 mechanically scans `server.ts` for every `create*Worker(` call and asserts each is either in `COVERED_FAMILIES` (a dedicated cross-tenant proof) or `EXCLUDED_FAMILIES` (a documented exclusion reason). `SendReconciler` was neither, so the coverage assertion failed with `expected [ 'SendReconciler' ] to deeply equal []`.
- **Fix:** Added a `send-reconciler (findReconcilableCandidates / resolveOneSend, scan consumer)` describe block mirroring `flow-reconciliation`'s own scan-consumer test shape exactly: seeds two workspaces each with a `reconciling` send correlated to `send_events` evidence, proves discovery returns both with correct `workspaceId`s, then proves `resolveOneSend({ id: a.sendId, workspaceId: b.workspaceId })` returns `false` (RLS-scoped, not just "happy path succeeded") BEFORE resolving the real candidates -- so the negative result is provably due to the workspace mismatch, not an already-resolved status. Added `"SendReconciler"` to `COVERED_FAMILIES`.
- **Files modified:** `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
- **Verification:** `npx vitest run --root apps/worker src/queues/__tests__/negative-cross-tenant-jobs.test.ts` (15 tests pass); full `apps/worker` suite (36 files / 159 tests) passes.
- **Committed in:** `90f044f`

---

**Total deviations:** 1 auto-fixed (1 blocking-issue fix)
**Impact on plan:** Necessary consequence of Layer 5's worker registration tripping a pre-existing Phase 10 (SEC-16) mechanical gate. No new access path, no scope creep -- the new test only exercises the discovery/claim functions this plan already built.

Additionally, four pre-existing tests (`send-dispatch-durability.test.ts`'s CR-04 case, `timeout.test.ts`, `connection-reset.test.ts`, `sigkill.test.ts`) asserted the pre-Phase-11 `failed` baseline for the interrupted-claim redelivery path. All four explicitly named, in their own comments, that this exact update was expected once Phase 11 landed -- this is the plan's own `<verification>` instruction ("update that assertion as part of this plan, do not weaken it"), not an unplanned deviation, but is recorded here for completeness since it touched files outside the plan's literal `files_modified` list.

## Issues Encountered

None beyond the documented deviation above.

## User Setup Required

None - no external service configuration required. Both Postgres and Redis were already running locally; no new environment variables introduced.

## Next Phase Readiness

- `resolveReconcilingSend` is now demonstrably the sole exit from `reconciling`/`unknown`, `send-reconciler.worker.ts` is registered and proven end to end, and both halves of DLV-04 are independently tested. `DLV-02`/`DLV-03`/`DLV-04` are complete for the one path this plan proves (campaign sends, evidence-found resolution only).
- Explicitly NOT built here, and owned by named later plans: `unknown` terminal resolution and the ~24h resolution window (11-07), the stale-`dispatching` sweep (two-writer transition, D-08), counter backfill on reconciler resolution (the interrupted branch's `incrementCampaignSendCounter` call was removed but nothing yet re-adds it from the reconciler side -- campaigns with an unresolved `reconciling` send will under-count until that plan lands), the reconciler health row / watchdog alerting (D-14), the `AbortController` timeout (DLV-06/D-15), UUIDv5 deterministic ids (DLV-05/D-09), and flow-path parity (this plan's scope was campaign sends only; `claimFlowSend`'s own interrupted branch in `apps/worker/src/queues/flows/flow-send.ts` still writes `failed`, unchanged).
- No stub was left where an architectural decision belongs -- the gaps above are functional omissions each named to a specific later plan, per the plan's own success criteria.

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*

## Self-Check: PASSED

- FOUND: apps/worker/src/queues/send-reconciler.worker.ts
- FOUND: apps/worker/src/queues/__tests__/send-reconciler-tracer.test.ts
- FOUND: apps/worker/src/queues/__tests__/claim-gate-exclusivity.test.ts
- FOUND: resolveReconcilingSend export in packages/delivery-core/src/index.ts
- FOUND: commit fbfaae8 in git log
- FOUND: commit dd18565 in git log
- FOUND: commit 90f044f in git log
- FOUND: this SUMMARY.md on disk
