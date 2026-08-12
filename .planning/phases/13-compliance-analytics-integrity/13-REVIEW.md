---
phase: 13-compliance-analytics-integrity
reviewed: 2026-08-12T00:43:56Z
depth: standard
files_reviewed: 74
files_reviewed_list:
  - apps/api/src/__tests__/env-schema.test.ts
  - apps/api/src/modules/analytics/dashboard.repository.ts
  - apps/api/src/modules/campaigns/__tests__/campaign-progress-ambiguous.test.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
  - apps/api/src/modules/contacts/__tests__/contact-erasure.test.ts
  - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
  - apps/api/src/modules/contacts/__tests__/subscription-status.test.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/contacts/contacts.routes.ts
  - apps/api/src/modules/delivery/unsubscribe.routes.ts
  - apps/api/src/modules/ops/__tests__/ingestion-health-watchdog.test.ts
  - apps/api/src/modules/ops/__tests__/reputation-watchdog.test.ts
  - apps/api/src/modules/ops/ingestion-health-watchdog.ts
  - apps/api/src/modules/ops/reputation-watchdog.ts
  - apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts
  - apps/api/src/modules/webhooks/enqueue.ts
  - apps/api/src/modules/webhooks/webhooks.routes.ts
  - apps/api/src/server.ts
  - apps/web/src/features/campaigns/CampaignProgress.tsx
  - apps/web/src/features/campaigns/__tests__/campaign-progress-ambiguous.test.tsx
  - apps/web/src/features/campaigns/api.ts
  - apps/web/src/features/send-log/__tests__/send-log-status-vocabulary.test.ts
  - apps/worker/package.json
  - apps/worker/src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts
  - apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts
  - apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts
  - apps/worker/src/queues/__tests__/analytics-rollup-tenant-isolation.test.ts
  - apps/worker/src/queues/__tests__/erasure-scrub-reclaim.test.ts
  - apps/worker/src/queues/__tests__/erasure-scrub.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/erasure-enqueue-crash.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/erasure-scrub-resume.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/unsubscribe-atomic.test.ts
  - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
  - apps/worker/src/queues/__tests__/reconcile-utc-day.test.ts
  - apps/worker/src/queues/__tests__/reputation-tick.test.ts
  - apps/worker/src/queues/__tests__/scheduler-registration.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-dedup-rebase.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-journal.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-occurred-at-bounds.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-processed.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-status.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts
  - apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts
  - apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts
  - apps/worker/src/queues/analytics-reconciliation.worker.ts
  - apps/worker/src/queues/erasure-scrub-checkpoint.ts
  - apps/worker/src/queues/erasure-scrub-reclaim.worker.ts
  - apps/worker/src/queues/erasure-scrub.worker.ts
  - apps/worker/src/queues/queue-registry.ts
  - apps/worker/src/queues/reputation-tick.worker.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/queues/webhook-replay-sweep.worker.ts
  - apps/worker/src/server.ts
  - packages/contacts-core/package.json
  - packages/contacts-core/src/__tests__/suppression-hash.test.ts
  - packages/contacts-core/src/__tests__/unsubscribe-apply.test.ts
  - packages/contacts-core/src/__tests__/upsert-anonymized.test.ts
  - packages/contacts-core/src/contact-repository.ts
  - packages/contacts-core/src/index.ts
  - packages/contacts-core/src/suppression-hash.ts
  - packages/contacts-core/src/unsubscribe-apply.ts
  - packages/contacts-core/vitest.config.ts
  - packages/db/migrations/0055_webhook_ingress_durability.sql
  - packages/db/migrations/0056_workspace_daily_rollup_dirtied_at.sql
  - packages/db/migrations/0057_send_events_dedup_rebase.sql
  - packages/db/migrations/0058_reputation_and_ingestion_alert_state.sql
  - packages/db/migrations/0059_contact_erasure.sql
  - packages/db/migrations/0060_suppression_hash_expand.sql
  - packages/db/migrations/0061_suppression_hash_contract.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/package.json
  - packages/db/scripts/count-send-event-duplicates.ts
  - packages/db/scripts/rehash-suppressions.ts
  - packages/db/scripts/replay-webhook-journal.ts
  - packages/db/src/__tests__/ingress-journal-queries.test.ts
  - packages/db/src/__tests__/migrate-from-empty.test.ts
  - packages/db/src/__tests__/migration-0056-workspace-daily-rollup-dirtied-at.test.ts
  - packages/db/src/__tests__/migration-0059-contact-erasure.test.ts
  - packages/db/src/__tests__/reputation-and-ingestion-alert-state.test.ts
  - packages/db/src/__tests__/send-events-dedup-rebase.test.ts
  - packages/db/src/__tests__/suppression-hash-migration.test.ts
  - packages/db/src/analytics/daily-rollup.ts
  - packages/db/src/index.ts
  - packages/db/src/schema/contacts.ts
  - packages/db/src/schema/erasure-records.ts
  - packages/db/src/schema/ingestion-alert-state.ts
  - packages/db/src/schema/ingress-journal.ts
  - packages/db/src/schema/reputation-alert-state.ts
  - packages/db/src/schema/send-event-quarantine.ts
  - packages/db/src/schema/send-events.ts
  - packages/db/src/schema/suppressions.ts
  - packages/db/src/schema/workspace-daily-rollup.ts
  - packages/db/src/schema/workspace-suppression-keys.ts
  - packages/db/src/sends/fact-columns.ts
  - packages/db/src/webhooks/ingress-journal.ts
  - packages/db/src/webhooks/quarantine.ts
  - packages/delivery-core/src/__tests__/occurred-at-bounds.test.ts
  - packages/delivery-core/src/__tests__/reputation-rates.test.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/occurred-at-bounds.ts
  - packages/delivery-core/src/reputation-rates.ts
  - packages/segments-core/src/__tests__/compile.test.ts
  - packages/segments-core/src/compile.ts
  - packages/shared-schemas/src/queues.ts
  - packages/tenant-context/src/__tests__/tenant-context.test.ts
findings:
  critical: 0
  warning: 4
  info: 1
  total: 5
status: issues_found
---

# Phase 13: Code Review Report

**Reviewed:** 2026-08-12T00:43:56Z
**Depth:** standard
**Files Reviewed:** 74 (of the files listed for review; several test/schema files were read as corroborating evidence, not separately enumerated as findings sources)
**Status:** issues_found

## Summary

This phase (compliance & analytics integrity: webhook ingress durability/replay, occurred-at bounding + quarantine, dedup re-basing, contact erasure + async PII scrub, HMAC'd suppression hashing, reputation/ingestion watchdogs, campaign ledger completeness) is unusually well-instrumented: nearly every function under review carries an explicit doc comment tracing back to a threat id, a prior review finding, or a specific test that pins the behavior. Tenant isolation (RLS + `withTenant`/`withCrossWorkspaceScan` discipline), webhook signature verification ordering, and the erasure/suppression HMAC design are all sound and internally consistent with the codebase's own stated conventions.

The findings below are the places where an implementation detail quietly breaks a convention the codebase enforces everywhere else, or where a documented design intent ("retention can be pruned independently") was never actually built. None of them constitute a proven cross-tenant data leak or an active correctness regression in the paths this phase's own tests exercise — they are latent robustness/completeness gaps that are worth closing given the depth of care evident elsewhere in this phase.

## Warnings

### WR-01: `send_event_quarantine` retains raw webhook PII indefinitely with no purge mechanism, and is never touched by the CMP-04 erasure scrub

**File:** `packages/db/migrations/0055_webhook_ingress_durability.sql:121-146`, `packages/db/src/webhooks/quarantine.ts:43-64`, `apps/worker/src/queues/erasure-scrub.worker.ts` (whole file)

**Issue:** `send_event_quarantine.raw_event` stores the complete, unredacted raw SendGrid webhook event body (including the recipient's `email`, IP, user agent, etc.) for every event whose `occurred_at` fails `classifyOccurredAt`'s bounds check. Migration 0055's own comment states this table's "quarantine retention... needs to be pruneable independently of the partitioned table's own retention policy" — but no pruning/retention job exists anywhere in the codebase (confirmed by searching every reference to `send_event_quarantine`: only the INSERT-only writer and the RLS policy exist). Contrast this with `ingress_journal`, whose 7-day retention + tombstone-purge is explicitly implemented (`packages/db/src/webhooks/ingress-journal.ts`'s `pruneIngressJournal`/`purgeExpiredIngressJournalPayloads`, driven by `webhook-replay-sweep.worker.ts`) and whose exclusion from the erasure scrub is explicitly reasoned about ("this horizon expires faster than an erasure request's own SLA"). No equivalent reasoning exists for `send_event_quarantine`, and the table also has no `contact_id` column, so even a future scrub pass would need to parse `raw_event` to find anything to redact.

Net effect: a contact who exercises their erasure right (CMP-04) can still have their email address and other PII sitting in `send_event_quarantine.raw_event` forever, for any webhook event about them that happened to arrive with a bad/missing timestamp. This directly undercuts CMP-04's stated guarantee ("no plaintext form of it survives anywhere") for exactly the subset of events that get routed here.

**Fix:** Either (a) give `send_event_quarantine` the same bounded retention `ingress_journal` has (age-out delete, since quarantined rows are diagnostic-only and have no replay value once resolved), or (b) if retention is intentionally deferred to a later phase, add an explicit `contact_id` correlation (or an allowlist-based scrub like `buildScrubbedSendEventPayload`) so the erasure scrub can reach it, and record the deferral decision explicitly in the migration/plan docs the way `ingress_journal`'s exclusion is recorded.

### WR-02: `setFactColumnOnce`/`incrementCampaignCounter` interpolate column names into SQL with no allow-list, unlike every sibling dynamic-column helper in this codebase

**File:** `packages/db/src/sends/fact-columns.ts:33-53`

**Issue:** Both exported functions build SQL by directly interpolating their `column`/`reasonColumn` string parameters:
```ts
const sql = reasonWrite
  ? `UPDATE sends SET ${column} = $2, ${reasonWrite.reasonColumn} = $3 WHERE id = $1 AND ${column} IS NULL RETURNING id`
  : `UPDATE sends SET ${column} = $2 WHERE id = $1 AND ${column} IS NULL RETURNING id`;
```
Every call site today passes a hardcoded literal, so there is no live exploit — but this is the only dynamic-column-name helper in the phase's diff that does *not* go through a fixed allow-list, and the codebase explicitly documents the alternative elsewhere: `packages/db/src/analytics/daily-rollup.ts`'s `METRIC_COLUMN` map ("caller input is never string-interpolated into the SQL, since the `metric` TypeScript union already constrains callers"), `apps/worker/src/queues/erasure-scrub-checkpoint.ts`'s `cursorColumnFor`/`countColumnFor`, and `packages/segments-core/src/compile.ts`'s `STANDARD_FIELD_COLUMNS`. `fact-columns.ts` takes bare `string` parameters instead of a literal union, so a future caller (or a refactor that starts deriving `column` from any less-trusted source, e.g. an event-type-to-column map read from configuration) gets no compile-time or runtime protection against building an invalid or injectable UPDATE.

**Fix:** Narrow `column`/`reasonColumn` to a literal union of the actual `sends` fact columns (mirroring `RollupMetric`/`METRIC_COLUMN`), or validate against a `Set` before interpolating, so this exported cross-app primitive can't silently become an injection point if a future call site's input becomes less trusted.

### WR-03: Several `contacts`/`sends` reads and writes drop the explicit `workspace_id` predicate the same files use as defense-in-depth everywhere else

**File:** `packages/contacts-core/src/unsubscribe-apply.ts:116-127` (contacts SELECT/UPDATE), `apps/worker/src/queues/webhook-events.worker.ts:198-209` (`isFirstNonDeliveryTerminal`'s `sends` SELECT), `apps/worker/src/queues/webhook-events.worker.ts:228-237` (`applySuppression`'s `contacts` SELECT/UPDATE)

**Issue:** These queries scope entirely by RLS (`WHERE id = $1`), while sibling queries in the very same functions/files explicitly add `AND workspace_id = $N` "as defense-in-depth on top of RLS... matching this codebase's existing convention" (the exact wording used in `unsubscribe-apply.ts`'s own comment for its `sends` lookup one block above the un-scoped `contacts` lookup). In every call path exercised today the `contactId`/`sendId` reaching these queries has already been validated as belonging to the active tenant (an HMAC-signed unsubscribe token binding `workspaceId`+`contactId` together, or a `sends` row already resolved via an explicit `workspace_id`-scoped SELECT one step earlier) — so this is not a demonstrated cross-tenant leak today. It is, however, an inconsistency with a convention this codebase treats as load-bearing enough to call out in comments at nearly every other query site, and it means a future edit that starts passing a less-trusted id into `applyUnsubscribeWithSendFact`, `applySuppression`, or `isFirstNonDeliveryTerminal` has no explicit second gate to catch the mistake — it would depend entirely on RLS being correctly forced and the session GUC being correctly set for that connection.

**Fix:** Add the explicit `AND workspace_id = $N` predicate to these three queries, matching the convention already documented and applied one query away in the same files.

### WR-04: `checkReputationHealthAndAlert` resends already-delivered alert emails on a retry after a partial mid-batch send failure

**File:** `apps/api/src/modules/ops/reputation-watchdog.ts:326-357`

**Issue:** For a claimed (workspace, metric) row, the function sends the operator email, then loops over every resolved tenant member sending the same alert text. If any `sendMail` call in that sequence rejects (e.g. the 3rd of 5 tenant recipients), the `catch` block releases the claim (resets `alerted_tier`/`last_alert_sent_at`) and rethrows. On the next tick (or the next replica), the same row is read again, the claim is re-acquired, and the **entire** send sequence — the operator email plus every tenant recipient, including the ones that already succeeded — is attempted again. This is "at-least-once, not idempotent-per-recipient": a transient SendGrid hiccup partway through a workspace with many members can cause the operator and some tenant members to receive the same reputation alert twice (or more, if the flaky recipient keeps failing while others succeed each time).

**Fix:** Either track per-recipient send success and only retry the recipients that failed (rather than releasing the whole claim), or accept and explicitly document duplicate-send risk as a deliberate at-least-once trade-off (the way other watchdogs in this file document their own deliberate trade-offs) rather than leaving it implicit.

## Info

### IN-01: `advanceErasureScrubCheckpoint`'s countColumn interpolation is safe but silently duplicates the same allow-list pattern for review

**File:** `apps/worker/src/queues/erasure-scrub-checkpoint.ts:116-132`

**Issue:** Not a defect — `cursorColumnFor`/`countColumnFor` correctly restrict `table` to the two-member `ScrubTable` union before interpolating, exactly the pattern WR-02 above recommends for `fact-columns.ts`. Noted only so a reviewer comparing the two files understands why one is flagged and the other isn't: this file does the allow-list correctly; `fact-columns.ts` is the outlier.

---

_Reviewed: 2026-08-12T00:43:56Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
