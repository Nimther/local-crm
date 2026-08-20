---
phase: 13-compliance-analytics-integrity
reviewed: 2026-08-12T00:00:00Z
depth: standard
files_reviewed: 91
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
  - packages/db/src/__tests__/quarantine-retention.test.ts
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
  warning: 6
  info: 1
  total: 7
status: issues_found
---

# Phase 13: Code Review Report

**Reviewed:** 2026-08-12T00:00:00Z
**Depth:** standard
**Files Reviewed:** 91 (listed files plus the newest gap-closure diff: `quarantine.ts`, `quarantine-retention.test.ts`, `webhook-replay-sweep.worker.ts` + its test, `erasure-scrub.worker.ts`, `SPECIFICATION.md`, `ARCHITECTURE.md`)
**Status:** issues_found

## Summary

This is a re-review of Phase 13 after gap-closure plan 13-16 landed (commits `4369a14..700eed7`), which added `send_event_quarantine` retention (`pruneSendEventQuarantine`) and wired it into `webhook-replay-sweep.worker.ts`'s existing replay-then-retention transaction. That specific gap-closure is solid: the new function is correctly scoped (`received_at` only, never a provider-supplied value), independently configurable from `INGRESS_JOURNAL_RETENTION_DAYS`, ordered after the replay step in the same transaction, and thoroughly tested (`quarantine-retention.test.ts` covers tenant isolation, idempotency, and the "old candidate/recent received_at survives" cases explicitly). **The prior review's WR-01 ("`send_event_quarantine` retains PII indefinitely with no purge mechanism") is now resolved** and does not reappear below.

The rest of this pass re-verified the four warnings and one info item from the prior 13-REVIEW.md against the current code: three of the four warnings still hold unchanged (the code they cite was not touched by the gap-closure diff), and this pass adds two new findings surfaced by reading the newest files more closely (a bare-`console.error` regression relative to the codebase's own documented redaction invariant, and an error-isolation asymmetry between the phase's newest tick workers) plus one additional, lower-confidence finding about UTC day-bucketing on a non-`timestamptz` column. None of the findings below constitute a proven cross-tenant leak or an active correctness regression in a path this phase's own tests exercise — RLS remains fail-closed and forced everywhere it should be, the erasure/suppression HMAC design is sound, and the newest quarantine-retention work is well-tested.

## Warnings

### WR-01: `setFactColumnOnce`/`incrementCampaignCounter` interpolate column names into SQL with no allow-list

**File:** `packages/db/src/sends/fact-columns.ts:33-53`

**Issue:** Both exported functions build SQL by directly interpolating their `column`/`reasonColumn` string parameters:
```ts
const sql = reasonWrite
  ? `UPDATE sends SET ${column} = $2, ${reasonWrite.reasonColumn} = $3 WHERE id = $1 AND ${column} IS NULL RETURNING id`
  : `UPDATE sends SET ${column} = $2 WHERE id = $1 AND ${column} IS NULL RETURNING id`;
```
and
```ts
await client.query(`UPDATE campaigns SET ${column} = ${column} + 1, updated_at = now() WHERE id = $1`, [campaignId]);
```
Every call site today passes a hardcoded literal, so there is no live exploit — but this is the only dynamic-column-name helper touched by this phase that does *not* go through a fixed literal-union allow-list, unlike every sibling: `packages/db/src/analytics/daily-rollup.ts`'s `METRIC_COLUMN` map, `apps/worker/src/queues/erasure-scrub-checkpoint.ts`'s `cursorColumnFor`/`countColumnFor` (both correctly narrow to a two-member union before interpolating — see IN-01), and `packages/segments-core/src/compile.ts`'s `STANDARD_FIELD_COLUMNS`. `fact-columns.ts` takes bare `string` parameters, so a future caller (or a refactor deriving `column` from a less-trusted source) gets no compile-time or runtime protection.

**Fix:** Narrow `column`/`reasonColumn` to a literal union of the actual `sends`/`campaigns` fact columns (mirroring `RollupMetric`/`METRIC_COLUMN`), or validate against a `Set` before interpolating.

### WR-02: Several `contacts`/`sends` reads and writes drop the explicit `workspace_id` predicate this codebase treats as load-bearing defense-in-depth everywhere else

**File:** `packages/contacts-core/src/unsubscribe-apply.ts:116-119,125-127`, `apps/worker/src/queues/webhook-events.worker.ts:198-209` (`isFirstNonDeliveryTerminal`'s `sends` SELECT), `apps/worker/src/queues/webhook-events.worker.ts:228-237` (`applySuppression`'s `contacts` SELECT/UPDATE)

**Issue:** These queries scope entirely by RLS (`WHERE id = $1`), while sibling queries in the very same functions/files add `AND workspace_id = $N` explicitly. `unsubscribe-apply.ts`'s own doc comment states the workspace predicate is applied "as defense-in-depth on top of RLS... matching this codebase's existing convention" for its `sends` lookup one block above — and then the very next query (`contacts`) omits it. ARCHITECTURE.md §4 states this precisely: "RLS is defence in depth, not the only defence... relying on every engineer remembering the filter on every query, forever, is a single forgotten `WHERE` away from a cross-tenant leak." In every call path exercised today the `contactId`/`sendId` reaching these queries has already been validated as belonging to the active tenant (an HMAC-signed unsubscribe token binding `workspaceId`+`contactId`, or a `sends` row already resolved via an explicit `workspace_id`-scoped SELECT one step earlier), so this is not a demonstrated cross-tenant leak today — but it is an inconsistency with the codebase's own stated convention, on a compliance-critical write path (subscription status / unsubscribe), and there is no negative test covering cross-tenant behavior for these three specific queries (`unsubscribe-apply.test.ts` and the webhook-events suppression/unsubscribe tests exercise only single-workspace scenarios).

**Fix:** Add the explicit `AND workspace_id = $N` predicate to all three queries, matching the convention already documented and applied one query away in the same files.

### WR-03: `checkReputationHealthAndAlert` resends already-delivered alert emails on a retry after a partial mid-batch send failure

**File:** `apps/api/src/modules/ops/reputation-watchdog.ts:326-357`

**Issue:** For a claimed `(workspace, metric)` row, the function sends the operator email, then loops over every resolved tenant member sending the same alert text. If any `sendMail` call in that sequence rejects (e.g. the 3rd of 5 tenant recipients), the `catch` block releases the claim (resets `alerted_tier`/`last_alert_sent_at` to their pre-claim values) and rethrows. The next check (this replica or another, still inside the dedup window) re-acquires the claim and resends the **entire** sequence — operator email plus every tenant recipient, including the ones that already succeeded. This is at-least-once, not idempotent-per-recipient: a transient SendGrid hiccup partway through a many-member workspace can duplicate the same reputation alert to several recipients.

**Fix:** Either track per-recipient send success and retry only the failed recipients, or explicitly document the duplicate-send risk as a deliberate at-least-once trade-off (as this file already does for other design choices) rather than leaving it implicit.

### WR-04: `erasure-scrub.worker.ts` logs through bare `console.error`, contradicting the codebase's own documented redaction invariant

**File:** `apps/worker/src/queues/erasure-scrub.worker.ts:444,469,513`

**Issue:** SPECIFICATION.md §7 states as a hard invariant: "с 10-13 каждый прямой `console.*`-вызов в `apps/worker/src` (вне `__tests__`) идёт через `scrubbedConsole`... а не голый `console.log`/`console.error`" — with exactly one documented, named exception (`pool.on("error")` in `packages/tenant-context`). This file has three more, undocumented exceptions:
```ts
console.error("erasure-scrub: erasure_records row not found, skipping", { erasureRecordId });          // line 444
console.error("erasure-scrub: failed to record scrub failure on the erasure record", markErr);          // line 469
console.error("erasure-scrub: deferring job with an unrecognized payload shape", { jobId: job.id });     // line 513
```
Confirmed via `grep -rn "console\." apps/worker/src --include="*.ts" | grep -v __tests__ | grep -v scrubbedConsole`: these are the only three hits outside the documented tenant-context exception and comments referencing `console.error`. Every sibling file this phase touches (`webhook-replay-sweep.worker.ts`, `erasure-scrub-reclaim.worker.ts`, `reputation-tick.worker.ts`, `ingestion-health-watchdog.ts`) imports and uses `scrubbedConsole` consistently. Line 469 is the substantive risk: `markErr` is whatever error a failed Postgres write to `erasure_records` raised — a `pg` driver error's `detail`/`message` fields can echo back literal values from the failed statement, which `scrubbedConsole`'s `scrub()` pass exists specifically to catch (per-key and per-value redaction) before it reaches process stdout/log aggregation.

**Fix:** Replace all three `console.error` calls with `scrubbedConsole.error` (the module already needs an import from `@mega-crm/redaction`, which every sibling file in this phase already has).

### WR-05: `webhook-replay-sweep.worker.ts`'s tick has no per-workspace error isolation, unlike this same phase's later `erasure-scrub-reclaim.worker.ts`

**File:** `apps/worker/src/queues/webhook-replay-sweep.worker.ts:362-378`

**Issue:** `runWebhookReplaySweep`'s main loop:
```ts
for (const workspaceId of workspaceIds) {
  const result = await runWorkspaceTick(workspaceId, thresholds);
  ...
  for (const candidate of result.enqueueCandidates) {
    await producerQueue.add("webhook-events", buildWebhookEventsJobPayload(workspaceId, events, candidate.id));
    rowsEnqueued += 1;
  }
}
```
has no `try/catch` around either the per-workspace DB transaction (`runWorkspaceTick`, which does the replay step *and* the newly-added quarantine/journal retention in the same transaction) or the subsequent Redis `producerQueue.add` call. A single workspace's failure — a query error, a Redis enqueue rejection — throws out of the loop, aborting replay *and* retention (including the gap-closure plan 13-16 quarantine prune) for every workspace after it in that tick's enumeration order, not just the failing one. This directly contradicts the isolation pattern this same phase's `erasure-scrub-reclaim.worker.ts` (plan 13-15, shipped one plan earlier in this phase) explicitly documents and implements: "A single workspace's failure... is caught and logged so it does not abort the remaining workspaces — a single tenant's transient failure must not stop every other tenant's [ticks]." (`erasure-scrub-reclaim.worker.ts:234-237`, implemented at `:263-269`). `reputation-tick.worker.ts` and `analytics-reconciliation.worker.ts` share the same unisolated pattern as pre-existing code, so this is not a new regression specific to 13-16 — but 13-16's own change (adding the quarantine-retention call inside the same unprotected per-workspace transaction) increases what one workspace's failure can now delay for every other tenant on this specific tick.

**Fix:** Wrap the per-workspace body of `runWebhookReplaySweep`'s loop in a `try/catch` that logs and continues, mirroring `erasure-scrub-reclaim.worker.ts`'s `workspacesErrored` counter pattern — the retry-on-next-tick behavior already assumed safe (BullMQ will retry the whole job on an uncaught rejection) is strictly worse than per-workspace isolation, since it does not narrow which workspace actually failed and re-does successfully-completed workspaces' work redundantly (harmless here since operations are idempotent, but wasteful and it delays failing-workspace visibility).

### WR-06: Dashboard growth-chart day-bucketing casts a naive `timestamp` column with no verified UTC pinning anywhere in the connection stack

**File:** `apps/api/src/modules/analytics/dashboard.repository.ts:145-153`, `packages/db/migrations/0003_eminent_meltdown.sql:15`

**Issue:** `getWorkspaceDashboard`'s growth series buckets by day via:
```sql
SELECT created_at::date::text as day, count(*)::text as "newContacts"
FROM contacts
WHERE workspace_id = $1 AND created_at >= $2::date AND anonymized_at IS NULL
GROUP BY created_at::date
```
`contacts.created_at` is declared `timestamp` (without time zone), not `timestamptz` (migration `0003`, line 15: `"created_at" timestamp DEFAULT now() NOT NULL`). This phase's own CMP-02/CMP-03 day-semantics contract (ARCHITECTURE.md §11, `analytics-reconciliation.worker.ts`'s extensive comment on the identical hazard for `sends.*_at`) states plainly that a bare `::date` cast is unsafe specifically because it converts through the session's `TimeZone` GUC — but the mechanism differs for a naive `timestamp` column: there is no per-read conversion, but the *value stored* was itself produced by Postgres's own `now()` default evaluated against whatever `TimeZone` GUC was in effect on the connection that ran the `INSERT`, and this codebase pins no explicit `TimeZone` anywhere (`docker-compose.yml`, `packages/tenant-context/src/index.ts`, and `apps/api/src/db.ts` all have zero references to `TimeZone`/`TZ`). If the Postgres server's configured default timezone is ever not UTC — an operator-settable parameter-group setting on a managed database, not something this codebase's own migrations or pool configuration verifiably pin — every `contacts.created_at` value (and therefore this chart's day boundaries) silently shifts by that offset, with no error and no test able to catch it against a database whose default already happens to be UTC (which the CI/dev Postgres almost certainly is). This is a narrower-scope version of the exact hazard class this phase spent real effort closing for `sends`/`send_events`/`workspace_daily_rollup`.

**Fix:** Either force `AT TIME ZONE 'UTC'` at the read site (mirroring `reconcileWorkspaceDay`'s `(col AT TIME ZONE 'UTC')::date` pattern) despite the column being timestamp-without-timezone (harmless — `AT TIME ZONE` on a naive timestamp reinterprets it as already being in that zone, which is the correct assumption if writers are always meant to write UTC-intended wall-clock values), or explicitly pin the connection's `TimeZone` to `'UTC'` once at the pool level so every `now()`-derived naive-timestamp write across the whole codebase (not just this one read site) is provably UTC-anchored, and add a test that fails if the effective session `TimeZone` is ever not `'UTC'`.

## Info

### IN-01: `erasure-scrub-checkpoint.ts`'s column interpolation is safe and correctly uses an allow-list — contrast case for WR-01

**File:** `apps/worker/src/queues/erasure-scrub-checkpoint.ts:72-78,116-132`

**Issue:** Not a defect — `cursorColumnFor`/`countColumnFor` correctly restrict `table` to the two-member `ScrubTable` union (`"sends" | "events"`) before interpolating the resulting literal into SQL, exactly the pattern WR-01 recommends for `fact-columns.ts`. Recorded only so a reviewer comparing the two files understands why one is flagged and the other is not.

---

_Reviewed: 2026-08-12T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
