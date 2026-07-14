---
phase: 07-analytics-dashboard-send-log
reviewed: 2026-07-14T07:01:48Z
depth: standard
files_reviewed: 68
files_reviewed_list:
  - apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts
  - apps/api/src/modules/analytics/__tests__/dashboard.test.ts
  - apps/api/src/modules/analytics/__tests__/flow-node-analytics.test.ts
  - apps/api/src/modules/analytics/dashboard.repository.ts
  - apps/api/src/modules/analytics/dashboard.routes.ts
  - apps/api/src/modules/analytics/flow-analytics.repository.ts
  - apps/api/src/modules/analytics/flow-analytics.routes.ts
  - apps/api/src/modules/analytics/index.ts
  - apps/api/src/modules/analytics/timeline.repository.ts
  - apps/api/src/modules/analytics/timeline.routes.ts
  - apps/api/src/modules/campaigns/__tests__/campaign-excluded-breakdown.test.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/contacts/__tests__/subscription-status-history.test.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/delivery/unsubscribe.routes.ts
  - apps/api/src/modules/send-log/__tests__/send-log-drawer.test.ts
  - apps/api/src/modules/send-log/__tests__/send-log-filters.test.ts
  - apps/api/src/modules/send-log/send-log.repository.ts
  - apps/api/src/modules/send-log/send-log.routes.ts
  - apps/api/src/server.ts
  - apps/web/package.json
  - apps/web/src/App.tsx
  - apps/web/src/components/ui/sheet.tsx
  - apps/web/src/features/app-shell/AppShell.tsx
  - apps/web/src/features/campaigns/CampaignDetailPage.tsx
  - apps/web/src/features/campaigns/CampaignMetricsSummary.tsx
  - apps/web/src/features/campaigns/CampaignProgress.tsx
  - apps/web/src/features/campaigns/CampaignsListPage.tsx
  - apps/web/src/features/campaigns/__tests__/campaign-metrics.test.ts
  - apps/web/src/features/campaigns/api.ts
  - apps/web/src/features/campaigns/campaign-metrics.ts
  - apps/web/src/features/contacts/ContactEventFeed.tsx
  - apps/web/src/features/dashboard/GrowthChart.tsx
  - apps/web/src/features/dashboard/TrendChart.tsx
  - apps/web/src/features/dashboard/WorkspaceDashboard.tsx
  - apps/web/src/features/dashboard/api.ts
  - apps/web/src/features/flows/api.ts
  - apps/web/src/features/flows/canvas/FlowCanvas.tsx
  - apps/web/src/features/flows/canvas/nodeTypes.tsx
  - apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx
  - apps/web/src/features/flows/detail/FlowDetailPage.tsx
  - apps/web/src/features/send-log/SendLogPage.tsx
  - apps/web/src/features/send-log/SendLogRowDrawer.tsx
  - apps/web/src/features/send-log/api.ts
  - apps/web/src/lib/__tests__/rates.test.ts
  - apps/web/src/lib/rates.ts
  - apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts
  - apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts
  - apps/worker/src/queues/__tests__/analytics-rollup-reconciliation-invariant.test.ts
  - apps/worker/src/queues/__tests__/analytics-rollup-tenant-isolation.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts
  - apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts
  - apps/worker/src/queues/analytics-reconciliation.worker.ts
  - apps/worker/src/queues/analytics-rollup.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/server.ts
  - packages/contacts-core/src/contact-repository.ts
  - packages/contacts-core/src/index.ts
  - packages/contacts-core/src/subscription-status-history.ts
  - packages/db/migrations/0036_analytics_status_history_counts.sql
  - packages/db/migrations/0037_workspace_daily_rollup.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/index.ts
  - packages/db/src/schema/sends.ts
  - packages/db/src/schema/subscription-status-history.ts
  - packages/db/src/schema/workspace-daily-rollup.ts
  - packages/shared-schemas/src/pagination.ts
findings:
  critical: 0
  warning: 11
  info: 10
  total: 21
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-07-14T07:01:48Z
**Depth:** standard
**Files Reviewed:** 68
**Status:** issues_found

## Summary

Re-review after gap-closure plans 07-08 (campaign summary enrichment) and 07-09 (rollup dual-writer fix). Scope: the Phase 7 analytics stack — subscription-status history, contact timeline, flow-node analytics, workspace dashboard + `workspace_daily_rollup` (incremental webhook writer + reconciliation backstop), the workspace-wide send log, and the campaign metrics summary UI.

**Prior CR-01 verification (dual-writer semantics divergence): RESOLVED.** The incremental path in `webhook-events.worker.ts` now gates the `opened`/`clicked` rollup increments on the `setFactColumnOnce` `justSet` result (lines 276–284, 294–298), making them unique-send counts identical to `reconcileWorkspaceDay`'s `first_opened_at`/`first_clicked_at` COUNTs, and gates `bounced` on the new `isFirstNonDeliveryTerminal` OR-combined check (lines 156–167), matching the reconciliation's OR-combined filter. The new `analytics-rollup-reconciliation-invariant.test.ts` proves the same-day invariant against real Postgres (two distinct opens → 1; bounce + spam on one send → 1; byte-identical across a reconcile tick). No oscillation remains for the same-day case.

One **residual divergence** from that fix is new finding WR-09: the two writers still disagree when a send accrues two different non-delivery terminals on two *different* UTC days (incremental counts once total; reconciliation counts the send once per day). Bounded, non-oscillating, but the "must never conflict" contract in `workspace-daily-rollup.ts`'s doc-comment is not fully true cross-day.

Eight warnings from the prior review were **not addressed by 07-08/07-09 and remain in the current code** (WR-01…WR-08 below, re-verified line-by-line against the current tree). Two further new warnings were found in this pass (WR-10, WR-11). No security vulnerabilities: all user input reaches SQL via bound parameters or fixed allow-list column maps, every new route enforces workspace membership + RLS with explicit existence-check 404s, and both new tables ship ENABLE + FORCE RLS with the NULLIF-guarded policy from their first migration.

## Warnings

### WR-01: `timestamptz::date` casts bucket by the Postgres session timezone, not UTC — day attribution can diverge from the rest of the pipeline

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:45-54`, `apps/api/src/modules/analytics/dashboard.repository.ts:141-153`
**Issue:** Carried over from the prior review; still unresolved (the invariant test even side-steps it explicitly with a noon-UTC fixture, `analytics-rollup-reconciliation-invariant.test.ts:109-113`). The incremental writer buckets by UTC (`occurredAt.slice(0, 10)`), and the dashboard's dense window is computed in UTC, but `reconcileWorkspaceDay`'s `sent_at::date = $2::date` filters and the dashboard growth query's `created_at::date` grouping resolve against the session `TimeZone` GUC, which nothing in `@mega-crm/tenant-context` or `@mega-crm/db` pins. On any deployment where Postgres's default timezone is not UTC, events near midnight are attributed to a different day by reconciliation than by the incremental writer — and because reconciliation *overwrites*, it will systematically erase incremental increments from the UTC day and move them to the local-TZ day, while the dashboard still labels days as UTC. `dashboard.repository.ts`'s own doc-comment (lines 90-95) flags exactly this hazard for `now()`/`current_date` but then uses the equally session-TZ-dependent `::date` cast three lines of SQL later.
**Fix:** Use an explicit UTC conversion in every day-bucketing expression:
```sql
(sent_at AT TIME ZONE 'utc')::date = $2::date
-- and in the growth query:
(created_at AT TIME ZONE 'utc')::date
```
or add `SET LOCAL TimeZone = 'UTC'` alongside the tenant GUC in `withTenantTransaction`.

### WR-02: Floating promise on repeatable-job registration; tick Queue never closed on shutdown

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:110-118`, `apps/worker/src/server.ts:115-118`
**Issue:** Carried over; still present. `void tickQueue.add(...)` discards the promise with no `.catch()`. If Redis is briefly unavailable at boot, the rejection becomes an unhandled promise rejection, which crashes the Node 22 process by default — and the failure mode is silent otherwise (no repeatable job registered → reconciliation never runs → `sent_count` stays 0 forever, since the incremental path never writes it). Additionally, the `Queue` instance created inside `createAnalyticsReconciliationWorker` is not reachable from `WorkerRuntime.close()`, which only closes `workers` — its Redis connection leaks on graceful shutdown. (Same pattern exists in `campaign-scheduler.worker.ts`, but that file is out of scope.)
**Fix:**
```typescript
tickQueue
  .add("reconcile-rollups", {}, { repeat: { every: RECONCILE_INTERVAL_MS }, jobId: "reconcile-rollups" })
  .catch((err) => console.error("failed to register reconcile-rollups repeatable job", err));
```
and either return the queue for `close()` to await `tickQueue.close()`, or close it after registration since the Worker does not need it.

### WR-03: Send-log OFFSET pagination has no unique tie-breaker — rows can repeat or vanish across pages

**File:** `apps/api/src/modules/send-log/send-log.repository.ts:166-171`
**Issue:** Carried over; still present. `ORDER BY COALESCE("sentAt", "queuedAt") DESC` is not a total order: a campaign fan-out writes many sends with effectively identical timestamps, so Postgres is free to return equal-key rows in different orders across the two paginated queries. A user paging through the send log can see the same row on page 1 and page 2, or miss rows entirely.
**Fix:** `ORDER BY COALESCE("sentAt", "queuedAt") DESC, id DESC`.

### WR-04: Reconciliation tick has no per-workspace error isolation — one failing workspace starves all workspaces after it

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:120-129`
**Issue:** Carried over; still present. The Worker processor iterates every organization row sequentially and awaits `reconcileWorkspace` with no try/catch. A single workspace whose reconcile throws (e.g. a transient connection drop mid-loop) fails the whole job, skipping every workspace ordered after it; because ordering from `SELECT id FROM organization` is stable in practice, the *same* trailing workspaces can be starved on every tick.
**Fix:** Wrap the per-workspace call:
```typescript
for (const row of rows) {
  try {
    await reconcileWorkspace(row.id, RECONCILE_WINDOW_DAYS);
  } catch (err) {
    console.error(`reconcile failed for workspace ${row.id}`, err);
  }
}
```

### WR-05: Contact timeline pagination is unreachable — activity silently truncates at 50 rows

**File:** `apps/web/src/features/contacts/ContactEventFeed.tsx:249-254`, `apps/api/src/modules/analytics/timeline.repository.ts:16`
**Issue:** Carried over; still present. The API supports `page` (validated in `timeline.routes.ts:11`) and the repository pages at 50 rows, but `ContactEventFeed` never sends `page` and renders no load-more/pagination affordance. Any contact with more than 50 timeline rows (trivially reached by opens/clicks/events on an active contact) silently loses all older history in the UI — a marketer has no signal that anything is missing.
**Fix:** Add a "Показать ещё" button that increments a `page` state and appends `?page=N` (or use `useInfiniteQuery`), or at minimum render a truncation notice when exactly 50 rows return.

### WR-06: Query errors render as empty states in SendLogPage, SendLogRowDrawer, and ContactEventFeed

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:196-198,323-345`, `apps/web/src/features/send-log/SendLogRowDrawer.tsx:115-121`, `apps/web/src/features/contacts/ContactEventFeed.tsx:281-308`
**Issue:** Carried over; still present. None of the three components branch on `isError`. On a failed fetch (network error, 400 from a malformed deep-link filter, expired session): SendLogPage shows «Отправок пока нет» (data `undefined` → `total = 0`, `hasActiveFilters` false with default filters); the drawer shows «Событий по этому письму пока нет»; ContactEventFeed shows «Активности пока нет». All three are false statements about the data. `WorkspaceDashboard.tsx:100-101` and `FlowAnalyticsTable.tsx:126-128` in this same phase get this right, so the pattern already exists in-tree.
**Fix:** Add an `isError` branch before the empty-state branch in each component, mirroring WorkspaceDashboard's `GENERIC_ERROR` rendering.

### WR-07: Unsubscribe POST guards `contactId` shape but not `workspaceId` — the same 22P02→500 oracle the guard exists to close

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:177-219`
**Issue:** Carried over; still present. `isUuid(payload.contactId)` exists precisely to keep a structurally invalid id away from a uuid-typed column so the response stays byte-identical (per the CR-01/T-04-19 doc-comment on lines 36-47). But `payload.workspaceId` gets no such check: it flows into `set_config('app.current_workspace_id', ...)` and the RLS policy's `NULLIF(...)::uuid` cast then raises 22P02 inside the transaction → uncaught → 500. A signature-valid token with a non-UUID `workspaceId` (the same legacy-token class the contactId guard defends against) produces a distinguishable 500, breaking the byte-identical-response invariant the handler documents.
**Fix:** Extend the guard: `if (isValid && isUuid(payload.contactId) && isUuid(payload.workspaceId)) { ... }`.

### WR-08: Webhook batch insert is unbounded — a large batch exceeds Postgres's 65,535 bind-parameter limit and permanently fails the job

**File:** `apps/worker/src/queues/webhook-events.worker.ts:458-485`, `packages/shared-schemas/src/queues.ts:228-231`
**Issue:** Carried over; still present. `webhookEventsJobSchema` places no bound on `events` (`z.array(z.unknown())`), and the worker builds ONE multi-row INSERT with 9 parameters per row. At 7,282+ events in a single webhook POST the statement exceeds the wire-protocol's 65,535 bind-parameter limit and throws on every retry — the batch fails permanently, and since side effects are same-transaction, all of its delivery facts/counters are lost until reconciliation partially heals (rollups only; `sends` fact columns and campaign counters are never healed). SendGrid batches are usually ~5-1000 events, but the bound is SendGrid's to break, not this code's to assume.
**Fix:** Chunk the insert (e.g. 1,000 rows per statement) inside the same transaction, accumulating `insertedIds` across chunks; optionally cap `events` in the route before enqueueing.

### WR-09: Residual dual-writer divergence — a send with two non-delivery terminals on two different days is counted twice by reconciliation, once by the incremental path

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:49-53`, `apps/worker/src/queues/webhook-events.worker.ts:156-167`
**Issue:** New (residual from the 07-09 CR-01 closure). `isFirstNonDeliveryTerminal` counts a send toward `bounced_count` only on its FIRST terminal ever — one increment total, on the first terminal's day. `reconcileWorkspaceDay`'s OR-combined filter counts the send once *per day* on which any of `bounced_at`/`dropped_at`/`spam_reported_at` falls. Same-day multi-terminal is consistent (proven by the invariant test's Scenario B), but cross-day is not: hard bounce on day D, spam report on day D+1 → incremental writes D=1, D+1=0; the next reconcile tick (window covers today+yesterday) overwrites D+1 to 1, so the send contributes 2 to the period total. Non-oscillating (reconciliation wins and stays), but the doc-comment contract "maintained two ways that must never conflict" (`workspace-daily-rollup.ts:11`) and the invariant suite's premise are violated for the cross-day case, and dashboard bounce totals overcount.
**Fix:** Make reconciliation attribute each send to a single day — its earliest terminal:
```sql
count(*) FILTER (WHERE LEAST(bounced_at, dropped_at, spam_reported_at)::date = $2::date
                 AND COALESCE(bounced_at, dropped_at, spam_reported_at) IS NOT NULL)
```
(`LEAST` ignores NULLs only when at least one value is non-null; the COALESCE guard covers the all-null row). Add a cross-day case to `analytics-rollup-reconciliation-invariant.test.ts`.

### WR-10: The platform's own unsubscribe route never records the send-level fact — «Отписки» KPI, campaign «Отписалось», rollup `unsubscribed_count`, and send-log status all miss RFC 8058 one-click unsubscribes

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:190-218`
**Issue:** New. Every email's `List-Unsubscribe` points at this platform route, and the token's HMAC payload carries the originating `sendId` (per the handler's own T-04-03-01 comment) — yet the POST handler only flips `contacts.subscription_status` and writes a history row. It never sets `sends.unsubscribed_at`, so: (a) the webhook worker's `unsubscribed` rollup increment never fires for this path, (b) `reconcileWorkspaceDay`'s `unsubscribed_at IS NOT NULL` count can't heal it, (c) `campaigns.unsubscribed_count` (the «Отписалось» cell in `CampaignMetricsSummary`) stays 0, and (d) the send log/timeline never associates the unsubscribe with the message that caused it. SendGrid's own `unsubscribe` webhook event only fires for SendGrid subscription-tracking links, not for a custom List-Unsubscribe URL — so for this platform's primary unsubscribe channel, every unsubscribe metric across the Phase 7 dashboard systematically reads 0. The contact timeline shows the status change (via history), which makes the campaign/dashboard zeros look like a bug to the user.
**Fix:** In the POST handler's tenant transaction, when the token is valid, also run the same first-write-once pattern the webhook worker uses: `UPDATE sends SET unsubscribed_at = now() WHERE id = $sendId AND unsubscribed_at IS NULL RETURNING campaign_id`, and on just-set, increment the campaign counter and `incrementWorkspaceDailyRollup(..., 'unsubscribed')` (extract that helper to a shared package or duplicate the gated upsert). Keep the response byte-identical regardless of outcome.

### WR-11: Non-UUID path params on the new analytics/send-log routes raise Postgres 22P02 → unhandled 500

**File:** `apps/api/src/modules/send-log/send-log.routes.ts:135-146`, `apps/api/src/modules/analytics/timeline.routes.ts:61-73`, `apps/api/src/modules/analytics/flow-analytics.routes.ts:63-71`
**Issue:** New. Query strings are Zod-validated, but the path params are not: `GET /send-log/not-a-uuid/events` reaches `getSendById`, whose `id = $2` comparison against the uuid-typed column throws `22P02 invalid input syntax for type uuid`. No route or global error handler maps it (grep confirms no `setErrorHandler`/22P02 handling in `apps/api/src`), so a workspace member gets a raw 500 instead of the intended uniform 404 — the same failure-mode class `unsubscribe.routes.ts`'s `isUuid` guard documents and closes on its own route. Same for `:id` on the timeline route (via `getContact`) and the flow-analytics route (via `getFlow`).
**Fix:** Validate params before querying, e.g. `const params = z.object({ slug: z.string(), sendId: z.string().uuid() }).safeParse(request.params)` → 404 on failure (404, not 400, to preserve the enumeration-safe uniformity).

## Info

### IN-01: Unused import in WorkspaceDashboard

**File:** `apps/web/src/features/dashboard/WorkspaceDashboard.tsx:10`
**Issue:** Carried over; still present. `computeRate` is imported but never used — all rates arrive pre-computed from the API.
**Fix:** Remove the import.

### IN-02: `resolveWorkspaceMember` copy-pasted into four route files

**File:** `apps/api/src/modules/analytics/timeline.routes.ts:21-40`, `flow-analytics.routes.ts:15-34`, `dashboard.routes.ts:24-43`, `apps/api/src/modules/send-log/send-log.routes.ts:42-61`
**Issue:** Carried over. Four byte-identical copies (each self-describing as "copied verbatim"). A future fix to the membership/404 behavior must land in four+ places or silently drift.
**Fix:** Export it once from a shared module (e.g. `modules/tenancy/resolve-workspace-member.ts`) and import everywhere.

### IN-03: `relativeTime` + send-status label/class maps duplicated across three components

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:24-62`, `SendLogRowDrawer.tsx:16-29`, `apps/web/src/features/contacts/ContactEventFeed.tsx:12-25,48-72`
**Issue:** Carried over. `relativeTime` is triplicated and `SEND_STATUS_LABELS`/`SEND_STATUS_CLASSES` duplicated (already drifting: ContactEventFeed's copy has an `unsubscribed` key the send-log copy lacks).
**Fix:** Extract to `@/lib/relative-time.ts` and a shared `send-status` module.

### IN-04: Dashboard "Отправлено писем" per flow counts excluded/failed send rows

**File:** `apps/api/src/modules/analytics/dashboard.repository.ts:214-225`
**Issue:** Carried over. `count(s.id)` counts every ledger row, including `status='excluded'`/`'failed'` rows that were never sent. `flow-analytics.repository.ts:70` correctly uses `FILTER (WHERE s.sent_at IS NOT NULL)` for the same concept, so the two surfaces can disagree for the same flow.
**Fix:** `count(s.id) FILTER (WHERE s.sent_at IS NOT NULL)::text as "emailsSent"`.

### IN-05: Send-log "no sends yet" empty state is wrong when all sends are older than the default 30-day period

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:194,327-333`
**Issue:** Carried over. The period filter always applies (default 30), but `hasActiveFilters` treats the default period as "no filters" — a workspace whose sends are all >30 days old sees «Отправок пока нет. Письма появятся здесь после первой кампании…», which is false.
**Fix:** Reword the unfiltered empty state to mention the period («Нет отправок за выбранный период») or check an unfiltered total.

### IN-06: dashboard.test.ts re-implements `computeRate` to compute its own expected values

**File:** `apps/api/src/modules/analytics/__tests__/dashboard.test.ts:231-234`
**Issue:** Carried over. The test's expected KPI rates come from a local copy of the same formula under test — a shared rounding bug would pass. Lower-value assertions than literal expected values (`expect(body.kpis.deliveredRate).toBe(87)`).
**Fix:** Assert literal integers for the fixture's known counts.

### IN-07: Suppression/unsubscribe prior-status read is not row-locked

**File:** `apps/worker/src/queues/webhook-events.worker.ts:186-215,219-240`
**Issue:** Carried over. `applySuppression`/`applyUnsubscribe` (and the unsubscribe route's equivalent, `unsubscribe.routes.ts:197-216`) SELECT the prior status and then UPDATE without `FOR UPDATE`. Two concurrent transactions touching the same contact can both read the same `oldStatus` and write duplicate/incorrect history rows. Low likelihood at current worker concurrency; the history table is advisory.
**Fix:** `SELECT ... FOR UPDATE`, or fold the read into the UPDATE via a CTE returning the old value.

### IN-08: `unsubscribes` KPI has no upper day bound — future-dated rollup rows count toward it but not toward the trend KPIs

**File:** `apps/api/src/modules/analytics/dashboard.repository.ts:117,136`, `apps/worker/src/queues/webhook-events.worker.ts:63-70`
**Issue:** New. `periodUnsubscribes` sums every rollup row with `day >= startDay` (no `day <= today`), while sent/delivered/opened KPIs are summed from the dense window that ends today. `extractEventRow` accepts any timestamp inside the full ECMAScript Date range (± ~275,760 years), so a garbage future timestamp from a webhook payload creates a future-day rollup row that inflates only the unsubscribes KPI. Reconciliation never touches future days (2-day trailing window), so the row persists until that day arrives.
**Fix:** Add `AND day <= $3::date` (today) to the rollup query, and/or clamp accepted webhook timestamps to a sane window (e.g. now + 24h).

### IN-09: `reconcileWorkspaceDay` inserts an all-zeros row for every workspace/day, even with zero activity

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:39-66`
**Issue:** New. The aggregate SELECT always returns one row, so every tick upserts 2 rows per workspace (today + yesterday) regardless of activity — a completely idle workspace accrues ~730 zero rows/year. Harmless for correctness (the dashboard zero-fills anyway) but pure table noise.
**Fix:** Wrap the SELECT and add `WHERE` to skip the insert when all six counts are zero, e.g. `INSERT ... SELECT * FROM (SELECT ...) agg WHERE agg.sent_count + agg.delivered_count + ... > 0` (keep the overwrite path unconditional if a previous non-zero row might need zeroing — in that case, keep as-is and accept the noise; document the choice).

### IN-10: Flow-node analytics: non-deterministic `nodeType` pick and silently dropped send rows

**File:** `apps/api/src/modules/analytics/flow-analytics.repository.ts:51,82-99`
**Issue:** New. `(array_agg(frs.node_type))[1]` picks an arbitrary element (no ORDER BY inside the aggregate) — deterministic only under the "type is stable across versions" assumption the comment itself hedges on. Separately, the final map iterates `nodeRows` only: a `sends` row whose `node_id` has no `flow_run_steps` row (partial write, historical data) is silently excluded from the response rather than surfaced as a metrics-only row.
**Fix:** Use `mode() WITHIN GROUP (ORDER BY frs.node_type)` for a deterministic pick; optionally append send-only node ids missing from `nodeRows` with `contactCount: 0`.

---

_Reviewed: 2026-07-14T07:01:48Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
