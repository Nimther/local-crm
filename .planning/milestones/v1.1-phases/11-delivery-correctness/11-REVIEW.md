---
phase: 11-delivery-correctness
reviewed: 2026-08-09T00:00:00Z
depth: standard
files_reviewed: 28
files_reviewed_list:
  - apps/api/src/modules/analytics/timeline.repository.ts
  - apps/api/src/modules/ops/send-reconciler-watchdog.ts
  - apps/api/src/modules/send-log/send-log.repository.ts
  - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
  - apps/api/src/server.ts
  - apps/web/src/features/campaigns/TestSendPanel.tsx
  - apps/web/src/features/send-log/SendLogPage.tsx
  - apps/web/src/features/send-log/api.ts
  - apps/worker/src/queues/email-broadcast.worker.ts
  - apps/worker/src/queues/email-triggered.worker.ts
  - apps/worker/src/queues/flows/flow-send.ts
  - apps/worker/src/queues/queue-options.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/send-reconciler.worker.ts
  - apps/worker/src/server.ts
  - packages/db/migrations/0047_send_status_reconciling.sql
  - packages/db/migrations/0048_send_status_unknown.sql
  - packages/db/migrations/0049_send_reconciliation_columns.sql
  - packages/db/migrations/0050_send_reconciler_runs.sql
  - packages/db/migrations/0051_sends_campaign_ambiguous_index.sql
  - packages/db/scripts/audit-sends-history.ts
  - packages/db/src/reconciler/reconciler-run.ts
  - packages/db/src/schema/send-reconciler-runs.ts
  - packages/db/src/schema/sends.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/reconciler.ts
  - packages/delivery-core/src/send-id.ts
  - packages/delivery-core/src/send-ledger.ts
  - packages/delivery-core/src/send-mail.ts
  - packages/delivery-core/src/send-state-machine.ts
  - packages/delivery-core/src/transport-classify.ts
  - packages/shared-schemas/src/queues.ts
findings:
  critical: 1
  warning: 3
  info: 2
  total: 6
status: issues_found
---

# Phase 11: Code Review Report

**Reviewed:** 2026-08-09T00:00:00Z
**Depth:** standard
**Files Reviewed:** 28 (some files listed together where they were reviewed as a set, e.g. the five migrations)
**Status:** issues_found

## Summary

The reconciler/state-machine core (`send-state-machine.ts`, `reconciler.ts`, `send-ledger.ts`, `transport-classify.ts`, `send-id.ts`) is careful, well-reasoned, and internally consistent with `ARCHITECTURE.md ##9` — the transaction boundaries around the claim gate, `resolveReconcilingSend`, `sweepStaleDispatchingSend`, and `backfillCampaignSendCounter` are correctly scoped, the exactly-once guarantee for counter backfill is real (guarded by the row lock + `WHERE status IN (...)` UPDATE), and the ms-based window/horizon/threshold constants and their boundary (`>` vs `<=`) semantics all check out.

The one substantive defect found is in the reconciler's own discovery query (`send-reconciler.worker.ts`): it has no upper bound excluding `unknown` rows that are already past the 72h re-scan horizon, so those rows remain eligible for the batch-limited discovery scan forever. Combined with `ORDER BY queued_at ASC LIMIT 500`, this means that once enough permanently-unresolvable `unknown` rows accumulate (which will happen at this platform's target volume), the reconciler's every tick will be entirely consumed by rows it can only ever mark `hold`, and genuinely new `reconciling` rows will never be scanned at all — directly defeating the "does not sit unresolved for long" guarantee this phase exists to provide. This is reported as a Blocker because it is a liveness/correctness failure of the reconciler's core promise, not a mere efficiency concern.

The remaining findings are lower-severity: a documented index that does not actually back the query its own migration comment claims to back, a narrow claim-gate race that produces a self-healing but spurious job failure, a stale union member (`{ kind: "failed" }`) left in two claim-result types that no producer emits (the exact shape the phase's own D-10 decision forbids), and two minor robustness nits.

## Critical Issues

### CR-01: Reconciler discovery query never excludes rows past the re-scan horizon — active `reconciling` rows starve behind a growing backlog of dead `unknown` rows

**File:** `apps/worker/src/queues/send-reconciler.worker.ts:144-161`

**Issue:** `discoverReconcilableCandidatesWithOldestReconciling`'s discovery SQL is:

```sql
SELECT id, workspace_id AS "workspaceId", campaign_id AS "campaignId", kind, status,
        queued_at AS "queuedAt", reconciling_since AS "reconcilingSince"
 FROM sends
 WHERE status IN ('reconciling', 'unknown')
    OR (status = 'dispatching' AND queued_at < now() - ($1::bigint * INTERVAL '1 millisecond'))
 ORDER BY queued_at
 LIMIT ${RECONCILER_BATCH_LIMIT}   -- 500
```

`unknown` is a terminal-but-re-examinable status (`RECONCILE_RESCAN_HORIZON_MS`, `reconciler.ts:36-50`): only rows younger than ~72h (measured from `queued_at`) can ever produce a `resolve_sent` verdict; everything past the horizon can only ever classify to `hold` (`reconciler.ts:143-149` — the `now - queuedAt <= RECONCILE_RESCAN_HORIZON_MS` guard). `RECONCILE_RESCAN_HORIZON_MS` is imported and used exactly once, inside `classifyReconcilableSend` — grep confirms it never appears in this discovery query. So an `unknown` row, once past its horizon, remains permanently eligible for this `WHERE` clause, forever, with no upper age bound.

Concretely: the query is `ORDER BY queued_at ASC LIMIT 500` — oldest rows first. Once the platform has accumulated 500+ rows that are `unknown` and past their 72h horizon (a near-certainty at the platform's stated target of "hundreds of thousands of emails per day", even at a very small ambiguous-outcome rate — a few hundred a month is enough), those rows will *always* occupy the entire 500-row batch on every 5-minute tick (`RECONCILER_TICK_MS`), because they are older by `queued_at` than any newly-created `reconciling` row. `resolveOneSend` will re-lock each of them, find no new evidence (or evidence outside the horizon), and re-verify `hold` — burning the whole tick's batch budget on rows that can never do anything else. Meanwhile a `reconciling` row created *today* — the row this phase's whole SLA (`RECONCILE_RESOLUTION_WINDOW_MS`, ~24h) is about — never appears in `SELECT`'s result set at all, because it sorts after 500 older dead rows. It will never resolve to `sent` or `unknown`, will never trip `resolveOneSend`, and the watchdog's own `reconciling_backlog_aged` alert (`send-reconciler-watchdog.ts:109-115`) is the only thing that will ever notice — after 30 hours, once — while the underlying cause silently gets worse every day new ambiguous sends occur.

This is a liveness/correctness defect, not a performance-tuning concern: the reconciler's entire purpose (turning `reconciling` into a real terminal-ish state within a bounded time) permanently stops working once the dead-row backlog exceeds `RECONCILER_BATCH_LIMIT`, and it never self-heals (dead `unknown` rows never leave the predicate).

**Fix:** Bound the `unknown` branch of the discovery predicate to the same horizon `classifyReconcilableSend` already enforces, so a row that can only ever produce `hold` stops being selected at all:

```sql
WHERE (status = 'reconciling')
   OR (status = 'unknown' AND queued_at >= now() - ($2::bigint * INTERVAL '1 millisecond'))
   OR (status = 'dispatching' AND queued_at < now() - ($1::bigint * INTERVAL '1 millisecond'))
ORDER BY queued_at
LIMIT ${RECONCILER_BATCH_LIMIT}
```

passing `RECONCILE_RESCAN_HORIZON_MS` as `$2` (already imported into `delivery-core`'s public surface via `packages/delivery-core/src/index.ts:53`, just not imported into this file today). Consider also ordering by `status` before `queued_at` (dispatching/reconciling first) so a temporary spike in `dispatching` age never starves `reconciling` either, though the horizon fix alone closes the unbounded-growth failure mode.

## Warnings

### WR-01: Migration 0049's `sends_reconciling_since_idx` does not back the query its own comment says it backs

**File:** `packages/db/migrations/0049_send_reconciliation_columns.sql:34-38`, `apps/worker/src/queues/send-reconciler.worker.ts:156-158`

**Issue:** The migration creates `sends_reconciling_since_idx ON sends (reconciling_since) WHERE reconciling_since IS NOT NULL` and its comment claims it serves "the Phase 11 watchdog's oldest-reconciling read (D-14)". That read is:

```sql
SELECT MIN(reconciling_since) AS "oldestReconcilingSince" FROM sends WHERE status = 'reconciling'
```

The query's `WHERE` predicate (`status = 'reconciling'`) is on a different column than the partial index's predicate (`reconciling_since IS NOT NULL`), and the planner cannot statically prove one implies the other (it would require knowing the application invariant that every `reconciling` row has a non-null `reconciling_since`, which the DB schema does not enforce — `reconciling_since` is nullable with no `CHECK` tying it to `status`). Postgres will not use this partial index for this query; it will fall back to a scan filtered by `status` (e.g. via `sends_status_queued_at_idx`, reading `reconciling_since` from the heap for every matching row). Given CR-01 above, the number of rows matching `status = 'reconciling'` is not actually bounded by anything, so this MIN aggregate's cost grows with exactly the same unbounded backlog CR-01 describes.

**Fix:** Either add a matching index for this specific read (`CREATE INDEX ... ON sends (reconciling_since) WHERE status = 'reconciling'`, distinct from the existing partial index which genuinely does serve a different, future consumer — Phase 15's webhook-lag query), or change the query to `WHERE status = 'reconciling' AND reconciling_since IS NOT NULL` and accept that it still won't use the existing index (different leading predicate), and instead update the migration comment so it does not claim a backing relationship that does not hold. At minimum, fixing CR-01 bounds this query's actual cost even without an index change.

### WR-02: `dispatchSendGate`/`claimFlowSend` throw a raw, unclassified Error under a narrow concurrent claim-then-release race, consuming a bounded retry attempt for a self-healing condition

**File:** `packages/delivery-core/src/send-ledger.ts:45-84` (`dispatchSendGate`), `:371-412` (`claimFlowSend`)

**Issue:** Both functions follow: `INSERT ... ON CONFLICT DO NOTHING` → if no row returned, `SELECT ... FOR UPDATE` on the same natural key → branch on `existingStatus`. If the `SELECT` returns zero rows — which happens if a *different* transaction commits `releaseDispatchClaim`'s `DELETE FROM sends WHERE id = $1 AND status = 'dispatching'` in the window between this transaction's `INSERT` (which detected the conflict but, per Postgres `ON CONFLICT DO NOTHING` semantics, does not hold a lock on the conflicting row afterward) and this transaction's own follow-up `SELECT` — then `existingStatus` is `undefined`, none of the status branches match, `sendId` stays `undefined`, and the function reaches:

```ts
if (!sendId) {
  throw new Error("dispatchSendGate: failed to obtain a sends row id (insert and lookup both empty)");
}
```

This scenario is realistic under BullMQ's documented at-least-once delivery: two concurrent deliveries of the same job (e.g. a stalled-checker false-positive redelivery racing the still-live first attempt) can both reach `claimCampaignSend`/`claimFlowSend` for the same `(workspaceId, campaignId, contactId)` intent at nearly the same moment; if the winner's own send later gets rate-limited/5xx'd and calls `releaseDispatchClaim` while the loser is still between its `INSERT` and `SELECT`, the loser hits this throw. The thrown `Error` is not classified by `classifyTransportError` (this happens inside the claim transaction, before any SendGrid call), so it propagates straight out of `processSendJob` and is treated by `handleEmailBroadcastJob`/`handleEmailTriggeredJob` as an ordinary job failure, consuming one of the job's bounded `SEND_JOB_MAX_ATTEMPTS` (5) and landing (transiently) in BullMQ's failed set — which `DEFAULT_JOB_OPTIONS`'s `removeOnFail: false` convention elsewhere in this codebase treats as a signal an operator should look at.

The condition is self-healing (the next attempt's `INSERT` succeeds cleanly since the conflicting row is now gone), so this does not cause a duplicate send or lost send — but it does produce a spurious, hard-to-explain failed-job entry for a purely internal race, muddying the "failed jobs are meaningful" signal this codebase otherwise relies on.

**Fix:** When the post-conflict `SELECT` returns zero rows, retry the `INSERT` once instead of throwing:

```ts
if (existing.length === 0) {
  return dispatchSendGate(client, params); // or a small bounded retry loop
}
```

(mirroring the same pattern in `claimFlowSend`), or at minimum classify this as a distinguishable, retryable condition rather than a generic thrown `Error` indistinguishable from a genuine bug.

### WR-03: Dead `{ kind: "failed" }` claim-result variant contradicts the phase's own D-10 invariant and weakens its enforcement

**File:** `apps/worker/src/queues/send-dispatch.ts:206-211` (`ClaimResult`), `:405-407`; `apps/worker/src/queues/flows/flow-send.ts:108-119` (`FlowClaimResult`); `apps/worker/src/queues/send-dispatch.ts:616-618`

**Issue:** `ClaimResult` and `FlowClaimResult` both still include a `{ kind: "failed"; sendId: string }` member, and `processSendJob`/`processFlowSendJob` both still contain a live branch handling it (`send-dispatch.ts:405-407` and `:616-618`). However, neither `claimCampaignSend` (`send-dispatch.ts:223-287`) nor `claimFlowSend` (`flow-send.ts:131-199`) — the only two producers of these unions — ever construct a `{ kind: "failed" }` value; both functions' own doc comments explicitly say this variant is superseded ("was CR-04's 'record it as failed' — superseded", `send-dispatch.ts:260`, `flow-send.ts:166`) precisely because Phase 11's D-10 decision forbids ever asserting `failed` for an interrupted claim (only the reconciler may resolve it, from webhook evidence).

Leaving the variant in the type does two things: (1) it is dead code — `send-dispatch.ts:405-407`/`:616-618` can never execute — and (2) more importantly, it means the type system no longer enforces the invariant the surrounding prose insists on. A future change that reintroduces "record an interrupted claim as failed" (reverting exactly the bug this phase fixed) would type-check silently instead of being caught, because the shape it needs already exists and is already wired into a handler.

**Fix:** Remove `{ kind: "failed"; sendId: string }` from both `ClaimResult` and `FlowClaimResult`, and delete the now-genuinely-unreachable branches in `processSendJob`/`processFlowSendJob`. If TypeScript's exhaustiveness checking on the resulting narrower union flags anything, that is exactly the safety net this fix is restoring.

## Info

### IN-01: `redactApiKey`/`redactSecret`'s substring-replace approach corrupts output if the key is ever an empty string

**File:** `packages/delivery-core/src/send-mail.ts:124-131`, `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:87-94,105-107`

**Issue:** Both redaction helpers do `text.split(apiKey).join("[REDACTED]")`. If `apiKey` is ever `""` (e.g. a corrupted/empty decrypted secret), `"anything".split("").join("[REDACTED]")` inserts `"[REDACTED]"` between every character of the string, producing unreadable/garbled log output instead of a clean redaction — the opposite of graceful degradation for a function whose entire purpose is safe logging. This requires `decryptTenantSecret` to return an empty string, which should not happen in practice, so this is informational rather than a live risk.

**Fix:** Guard both helpers with an early return when `apiKey.length === 0` (skip redaction — nothing to redact) or fall back to a placeholder string, so a malformed key can never turn a redaction helper into a log-corruption helper.

### IN-02: Watchdog `setInterval` handles are never retained or cleared

**File:** `apps/api/src/server.ts:276-285`, `apps/api/src/modules/ops/send-reconciler-watchdog.ts:288-294`

**Issue:** `startSendReconcilerWatchdog` (like the pre-existing `startPartitionWatchdog`) returns a `NodeJS.Timeout` that `main()` discards without assigning to a variable. This is consistent with the pre-existing `partition-watchdog` pattern (not a regression introduced by this phase), and `apps/api` has no graceful-shutdown handler at all today, so there is currently no code path that would benefit from clearing it. Flagged for awareness only: if graceful shutdown is ever added to `apps/api` (mirroring `apps/worker/src/server.ts`'s `SIGINT`/`SIGTERM` handling), both watchdog intervals need their handles captured and cleared, or the process will hang past the shutdown signal waiting for an interval that will never fire again to be garbage collected.

**Fix:** No action required now; capture and `clearInterval` both handles if/when `apps/api` gains a shutdown handler.

---

_Reviewed: 2026-08-09T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
