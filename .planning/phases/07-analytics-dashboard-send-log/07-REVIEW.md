---
phase: 07-analytics-dashboard-send-log
reviewed: 2026-07-14T16:05:16Z
depth: standard
files_reviewed: 72
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
  - apps/web/src/features/send-log/CampaignFlowFilter.tsx
  - apps/web/src/features/send-log/SendLogPage.tsx
  - apps/web/src/features/send-log/SendLogRowDrawer.tsx
  - apps/web/src/features/send-log/__tests__/send-log-filters.test.ts
  - apps/web/src/features/send-log/api.ts
  - apps/web/src/features/send-log/send-log-filters.ts
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
  warning: 8
  info: 11
  total: 19
status: issues_found
---

# Phase 07: Code Review Report

**Reviewed:** 2026-07-14T16:05:16Z
**Depth:** standard
**Files Reviewed:** 72
**Status:** issues_found

## Summary

Fresh full-scope review of the Phase 07 analytics/dashboard/send-log implementation, replacing the 2026-07-14T13:03:51Z review after gap-closure plans 07-10 and 07-11 landed.

**Previous-review fix verification:**
- **CR-01 (07-09 dual-writer fix)** — confirmed still in place: `incrementWorkspaceDailyRollup` calls for opened/clicked are gated on `justSet` and bounced on `isFirstNonDeliveryTerminal` (`webhook-events.worker.ts:276-302,305-388`), matching `reconcileWorkspaceDay`'s unique-send/OR-combined semantics, with dedicated invariant coverage (`analytics-rollup-reconciliation-invariant.test.ts`).
- **WR-02 (cmdk identity collision, 07-11)** — confirmed FIXED: `CommandItem value` now uses `sendTargetItemValue(name, id)` = `"{name} {id}"` (`CampaignFlowFilter.tsx:83,100`; `send-log-filters.ts:61-63`), unique per id with regression tests (`send-log-filters.test.ts:122-141`). Not re-reported.

The security posture remains strong: every filter compiles to bound `$N` parameters (`send-log.repository.ts`, `timeline.repository.ts`, `dashboard.repository.ts`), the rollup metric-to-column mapping is a fixed allowlist, both new tables ship ENABLE+FORCE RLS with the NULLIF-guarded policy from their first migration, and all analytics routes carry the enumeration-safe 404 double-gate. No Critical findings.

Eight Warnings remain — seven are unresolved carryovers from the previous review (the codebase in those areas is unchanged), plus one new finding: malformed (non-UUID) path params on the three new id-taking routes escape validation and surface as Postgres 22P02 → 500.

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Session-timezone-dependent `::date` casts diverge from the UTC day bucketing used by the incremental rollup writer and the dashboard's dense window *(carryover, unresolved)*

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:45-54`, `apps/api/src/modules/analytics/dashboard.repository.ts:141-151`
**Issue:** `sends.*_at` and `contacts.created_at` are `timestamptz` (`packages/db/src/schema/sends.ts:61-69`). Casting a `timestamptz` with `::date` resolves against the Postgres **session** `TimeZone`, and neither `@mega-crm/tenant-context` nor `@mega-crm/db` pins the session timezone. Meanwhile `incrementWorkspaceDailyRollup` buckets by a UTC ISO-string slice (`analytics-rollup.ts:48`), and `buildDenseDayWindow`/`recentDays` compute UTC days in JS. On any deployment where the DB's `timezone` setting is not UTC:
- the reconciliation worker (which overwrites rollup rows every 3 minutes) re-attributes counts to *local* calendar days, permanently fighting the incremental writer's UTC days — counts visibly shift between adjacent days on the dashboard after each tick;
- the growth query's `created_at::date` grouping and `created_at >= $2::date` boundary drift from the UTC-labelled dense window, so `newContacts` can land on the wrong day or fall out of the window entirely.

The dashboard repository's own doc-comment (lines 90-95) claims computing "today" in JS closes the timezone gap — it does not, because the casts inside the queries remain session-timezone-dependent. The dual-write invariant test still deliberately dodges this with a noon-UTC fixture (`analytics-rollup-reconciliation-invariant.test.ts:109-113`) rather than the production code fixing it.
**Fix:**
```sql
-- reconcileWorkspaceDay (repeat for every fact column):
count(*) FILTER (WHERE sent_at IS NOT NULL AND (sent_at AT TIME ZONE 'UTC')::date = $2::date)

-- dashboard growth:
SELECT ((created_at AT TIME ZONE 'UTC')::date)::text as day, ...
GROUP BY (created_at AT TIME ZONE 'UTC')::date
```
Alternatively add `SET LOCAL TIME ZONE 'UTC'` inside `withTenantTransaction` so every tenant transaction is UTC-pinned once, codebase-wide.

### WR-02: Dashboard «Отписки» KPI, rollup, and campaign `unsubscribed_count` miss all unsubscribes performed via the platform's own /unsubscribe route *(carryover, unresolved; previously WR-03)*

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:190-218`; `apps/worker/src/queues/webhook-events.worker.ts:389-397`; `apps/api/src/modules/analytics/dashboard.repository.ts:136`
**Issue:** The rollup's `unsubscribed_count` is fed only by (a) SendGrid `unsubscribe`/`group_unsubscribe` webhook events (incremental path) and (b) `sends.unsubscribed_at` (reconciliation overwrite). But the platform's own RFC 8058 one-click/confirm-page unsubscribe route updates `contacts.subscription_status` + history and **never sets `sends.unsubscribed_at`**, increments no rollup row, and increments no campaign counter — even though the verified token payload carries the exact `sendId` (`packages/delivery-core/src/unsubscribe-token.ts:15`). Since every outgoing email carries the platform's `List-Unsubscribe` URL (while SendGrid's native unsubscribe event only fires for SendGrid's own subscription-tracking links), a large share — likely the majority — of real unsubscribes is invisible in the dashboard KPI, the trend rollup, and the campaign summary's «Отписалось» counter. Reconciliation then *reinforces* the undercount every 3 minutes by overwriting from `sends.unsubscribed_at`.
**Fix:** In the unsubscribe POST's valid-token branch, mirror the webhook worker's contract inside the existing tenant transaction: first-write-gate `UPDATE sends SET unsubscribed_at = now() WHERE id = $sendId AND unsubscribed_at IS NULL RETURNING campaign_id`, and on just-set increment the campaign `unsubscribed_count` (when `campaign_id` is non-null) and `workspace_daily_rollup.unsubscribed_count` — with no new reply branches, preserving the byte-identical-response invariant (T-04-03-02).

### WR-03: Reconciliation worker — one failing workspace aborts the whole tick; repeatable-job registration rejection is unhandled *(carryover, unresolved; previously WR-04)*

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:114-127`
**Issue:** Two robustness gaps: (1) the processor iterates every workspace sequentially with no per-workspace error isolation — a single workspace whose transaction fails (org deleted mid-scan, transient error) throws and abandons every workspace after it in the list, on every 3-minute tick, silently stalling rollup freshness for the tail of the list. (2) `void tickQueue.add(...)` discards the promise — if Redis is unavailable at that moment, this becomes an unhandled promise rejection (process-terminating on Node 22) instead of a logged, retryable failure.
**Fix:**
```ts
for (const row of rows) {
  try {
    await reconcileWorkspace(row.id, RECONCILE_WINDOW_DAYS);
  } catch (err) {
    console.error("analytics-reconcile: workspace failed, continuing", { workspaceId: row.id, err });
  }
}
```
and `tickQueue.add(...).catch((err) => console.error("analytics-reconcile: repeatable registration failed", err));`

### WR-04: OFFSET pagination without a deterministic tiebreaker in send-log and timeline queries *(carryover, unresolved; previously WR-05)*

**File:** `apps/api/src/modules/send-log/send-log.repository.ts:168`, `apps/api/src/modules/analytics/timeline.repository.ts:118`
**Issue:** `ORDER BY COALESCE("sentAt", "queuedAt") DESC` and `ORDER BY occurred_at DESC` are not total orders — a broadcast dispatch stamps many sends with identical (or near-identical) timestamps, so rows with equal keys may be returned in different physical order across page requests, causing rows to duplicate on one page and vanish from another while a marketer pages through the log.
**Fix:** Append a unique tiebreaker: `ORDER BY COALESCE("sentAt", "queuedAt") DESC, id DESC` (send-log); for the timeline union, include a stable secondary key (e.g. a per-branch id surfaced into the union) or at minimum `ORDER BY occurred_at DESC, kind`.

### WR-05: Send-log and timeline fetch errors render as empty states («Ничего не найдено» / «Активности пока нет») *(carryover, unresolved; previously WR-06)*

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:206-208,339-357`, `apps/web/src/features/contacts/ContactEventFeed.tsx:281-308`
**Issue:** Neither page branches on `query.isError`. On failure `data` is `undefined`, so `items = []` / `total = 0` and the UI shows the *empty-result* card. This is trivially reachable: a hand-edited or stale deep-link like `?campaign=not-a-uuid` or an unknown `?status=` value produces a 400 from the route schema (`send-log.routes.ts:19-34`), and the user sees "nothing found — try changing the period" for filters that were never applied; any 5xx presents the same lie. `WorkspaceDashboard.tsx:100-101` handles this correctly — these two pages should match.
**Fix:** Add an `isError` branch rendering error copy (mirror `WorkspaceDashboard`'s `GENERIC_ERROR` pattern) before the empty-state branches.

### WR-06: Contact timeline hard-capped at the first 50 rows — API pagination exists but the UI never uses it *(carryover, unresolved; previously WR-07)*

**File:** `apps/web/src/features/contacts/ContactEventFeed.tsx:249-254`; `apps/api/src/modules/analytics/timeline.repository.ts:16`
**Issue:** The endpoint supports `?page=` (`timeline.routes.ts:11`) with a fixed page size of 50, but `ContactEventFeed` never passes a page and renders no "load more" affordance — and since the response is a bare array with no `total`, the UI cannot even detect truncation. For any active contact (>50 combined events/sends/status changes/flow entries), older activity is silently unreachable, undercutting ANLT-03's unified-history purpose.
**Fix:** Track a `page` state (accumulate pages), pass it to the fetch, and render «Показать ещё» when the last page returned exactly 50 rows — or extend the API response to `{ items, total }`.

### WR-07: Status-change history writes use unguarded read-then-write — concurrent transitions can record duplicate/incorrect history rows *(carryover, unresolved; previously WR-08)*

**File:** `apps/worker/src/queues/webhook-events.worker.ts:186-215,221-239`, `apps/api/src/modules/delivery/unsubscribe.routes.ts:197-216`
**Issue:** `applySuppression`, `applyUnsubscribe`, and the unsubscribe route each `SELECT subscription_status` (no `FOR UPDATE`) and then `UPDATE`. Two concurrent transitions for the same contact — e.g. a webhook `unsubscribe` event racing a one-click `/unsubscribe` POST, or a hard bounce racing a spam report processed by two worker transactions — can both observe the pre-transition status and both write a `subscribed → unsubscribed`/`suppressed` history row, producing duplicate entries (and a stale `oldStatus`) in the append-only audit log the contact timeline renders. The webhook dedup gate only serializes identical `sg_event_id`s, not distinct events or the route path.
**Fix:** Lock the row while capturing the prior value inside the already-open transaction:
```sql
SELECT subscription_status as "subscriptionStatus" FROM contacts WHERE id = $1 FOR UPDATE
```
or collapse to one atomic statement (`UPDATE ... WHERE subscription_status <> 'unsubscribed'` with prev-value capture via a CTE) and gate the history write on the UPDATE's row count.

### WR-08: Malformed (non-UUID) path params on the new id-taking routes escape validation and surface as Postgres 22P02 → 500 *(new)*

**File:** `apps/api/src/modules/analytics/timeline.routes.ts:61-71`, `apps/api/src/modules/analytics/flow-analytics.routes.ts:63-69`, `apps/api/src/modules/send-log/send-log.routes.ts:135-141`
**Issue:** The `:id`/`:sendId` path params are read via `request.params as {...}` with no shape validation, then passed straight into uuid-typed comparisons: `getContact(id)` (`contact.repository.ts:211`), `getFlow(id)` (`flow.repository.ts:205`), and `getSendById(sendId)` (`send-log.repository.ts:191`) all run `WHERE ... id = $2` against a `uuid` column. A request like `GET /api/workspaces/{slug}/contacts/not-a-uuid/timeline` (or `/flows/x/analytics`, `/send-log/x/events`) makes Postgres raise `22P02 invalid input syntax for type uuid`, which no handler catches — the caller gets a raw 500 (and an error-level log entry) instead of the 404 the routes' own enumeration-safe design intends. Query-string ids on the same routes ARE validated (`sendLogQuerySchema` uses `z.string().uuid()`), so this is an inconsistency confined to path params. Reachable by any authenticated workspace member with a typo'd or truncated deep-link; also makes the 404-for-everything contract leak a distinguishable malformed-vs-foreign signal.
**Fix:** Validate the param before querying — either a Zod params schema per route (`z.object({ id: z.string().uuid() })`, 404 on failure to keep responses uniform) or reuse the existing `isUuid` regex guard (`unsubscribe.routes.ts:45-47`) and return the same 404 body:
```ts
if (!isUuid(id)) return reply.code(404).send({ error: "Contact not found" });
```

## Info

### IN-01: `resolveWorkspaceMember` copy-pasted into four route modules

**File:** `apps/api/src/modules/analytics/timeline.routes.ts:21`, `analytics/flow-analytics.routes.ts:15`, `analytics/dashboard.routes.ts:24`, `send-log/send-log.routes.ts:42`
**Issue:** The identical membership-gate helper is duplicated verbatim (each copy even carries a "copied verbatim … not exported there" comment). Five+ copies now exist codebase-wide; a future change to the enumeration-safe 404 behavior must touch all of them.
**Fix:** Export one `resolveWorkspaceMember` from a shared module (e.g. `modules/tenancy/workspace-member-guard.ts`) and import it everywhere.

### IN-02: `relativeTime` helper duplicated verbatim in three components

**File:** `apps/web/src/features/contacts/ContactEventFeed.tsx:15`, `send-log/SendLogPage.tsx:29`, `send-log/SendLogRowDrawer.tsx:19`
**Issue:** Identical 11-line formatter (plus module-level `Intl.RelativeTimeFormat`) copy-pasted three times.
**Fix:** Move to `apps/web/src/lib/relative-time.ts` and import.

### IN-03: Dashboard active-flows `emailsSent` counts excluded/failed ledger rows, all-time, on a period-scoped dashboard

**File:** `apps/api/src/modules/analytics/dashboard.repository.ts:214-225`
**Issue:** `count(s.id)` counts every `sends` row for the flow — including `status='excluded'` (never dispatched) and `failed` — with no date bound, under a header controlled by a 7/30/90-day period picker. The «Отправлено писем» column overstates and ignores the selected period.
**Fix:** `count(s.id) FILTER (WHERE s.sent_at IS NOT NULL)` at minimum; optionally bound by the period start.

### IN-04: Dashboard `deliveredRate` unclamped — can exceed 100% at period boundaries

**File:** `apps/api/src/modules/analytics/dashboard.repository.ts:166-167`
**Issue:** Deliveries land on the delivery day while `sent_count` lands on the dispatch day; a 7-day window opening just after a large dispatch counts its deliveries but not its sends, so `computeRate(periodDelivered, periodSent)` can print e.g. «180%». Same applies to `openedRate`.
**Fix:** Clamp (`Math.min(100, …)`) or accept and document the boundary artifact.

### IN-05: `(array_agg(frs.node_type))[1]` is a non-deterministic pick

**File:** `apps/api/src/modules/analytics/flow-analytics.repository.ts:51`
**Issue:** Without an `ORDER BY` inside the aggregate, "take any one" can flip between requests if a node_id ever carried two types across versions, making the analytics table's «Узел» label unstable.
**Fix:** `(array_agg(frs.node_type ORDER BY frs.node_type))[1]` (or `mode() WITHIN GROUP`).

### IN-06: Campaign/flow filter lookup truncates at 200 entries; stale deep-links show a raw UUID as the filter label

**File:** `apps/web/src/features/send-log/CampaignFlowFilter.tsx:34-46`, `send-log-filters.ts:73-88`
**Issue:** `EXHAUSTIVE_LOOKUP_PAGE_SIZE = 200` fetches only the newest 200 campaigns/flows; in a mature workspace older campaigns can't be selected from the combobox, and an old deep-link's id resolves to the bare UUID as the trigger-button label (deliberate fallback, but user-hostile).
**Fix:** Acceptable for v1 (documented tradeoff for segments/campaigns); consider a server-side name-search param on the list endpoints, and label unresolved ids as «не найдено» text instead of the raw UUID.

### IN-07: URL can carry both `?campaign=` and `?flow=` — chips show both, clearing one silently activates the other

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:127-135,275-290`
**Issue:** Mutual exclusion is enforced only by `applySendTargetToParams` (07-10) — a hand-crafted deep-link with both params renders both chips while the API only receives the campaign (`campaignId ?? flowId`); clicking the campaign chip's × then switches the result set to the flow filter without any user-visible cue.
**Fix:** Normalize at parse time: when both params are present, ignore `flow` for chip rendering (or delete it on load).

### IN-08: Webhook `isTest` gate only recognizes the string `"true"`

**File:** `apps/worker/src/queues/webhook-events.worker.ts:99`
**Issue:** `event.test === "true" || customArgs?.test === "true"` — a boolean `true` from any future non-string producer would bypass the test gate and fire real status/counter/suppression side effects. The current in-repo test-send path stamps the string form, so this is defensive hardening only.
**Fix:** Also accept boolean `true` in both positions.

### IN-09: Multi-row `send_events` INSERT can exceed Postgres's 65,535 bind-parameter limit on very large batches

**File:** `apps/worker/src/queues/webhook-events.worker.ts:458-485`
**Issue:** 9 params/row means a single webhook job with >~7,280 events fails the whole INSERT (`bind message has too many parameters`) and the batch retries indefinitely. SendGrid's typical webhook POST batches are well below this, but the queue contract itself doesn't bound the array.
**Fix:** Chunk `resolvedRows` into ≤5,000-row inserts inside the same transaction (or bound the batch size at enqueue time in the webhook route).

### IN-10: `dispatching` send rows render an untranslated raw status and cannot be filtered in the send log *(new)*

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:42-76`; `apps/api/src/modules/send-log/send-log.repository.ts:12-24,78-90`
**Issue:** `COMPUTED_STATUS_SQL`'s `ELSE s.status::text` passes `dispatching` through for an in-flight send, but `SEND_STATUS_LABELS`/`SEND_STATUS_CLASSES` have no `dispatching` entry (the badge falls back to the raw English string "dispatching" in an otherwise fully Russian UI), and `SEND_LOG_STATUSES` excludes it, so these rows appear in the unfiltered list but no status filter can select or exclude them. The timeline's `SEND_STATUS_LABELS` (`ContactEventFeed.tsx:48-59`) has the same gap.
**Fix:** Add a `dispatching: "Отправляется"` label + neutral badge class in both components (filterability optional — in-flight rows are transient).

### IN-11: Terminal-campaign SummaryView caches metrics with `staleTime: Infinity` although webhook counters keep climbing after the campaign is terminal *(new)*

**File:** `apps/web/src/features/campaigns/CampaignDetailPage.tsx:126-134`
**Issue:** The doc-comment asserts "a terminal campaign's counts do not change, so no polling is needed" — but delivered/opened/clicked/unsubscribed counters continue to rise for hours or days after a campaign reaches `sent` (webhook events arrive long after dispatch). With `staleTime: Infinity`, revisiting the page within a session shows frozen numbers; only a hard reload (or cache GC) refreshes them. Not a correctness bug in stored data, but the summary understates engagement during exactly the window a marketer checks it most.
**Fix:** Use a finite `staleTime` (e.g. 30-60s) or drop the option and rely on the default refetch-on-mount behavior.

---

_Reviewed: 2026-07-14T16:05:16Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
