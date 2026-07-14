---
phase: 07-analytics-dashboard-send-log
reviewed: 2026-07-14T03:30:17Z
depth: standard
files_reviewed: 63
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
  - apps/web/src/features/campaigns/CampaignProgress.tsx
  - apps/web/src/features/campaigns/CampaignsListPage.tsx
  - apps/web/src/features/campaigns/api.ts
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
  critical: 1
  warning: 8
  info: 7
  total: 16
status: issues_found
---

# Phase 7: Code Review Report

**Reviewed:** 2026-07-14T03:30:17Z
**Depth:** standard
**Files Reviewed:** 63
**Status:** issues_found

## Summary

Phase 7 adds the analytics surface (contact timeline, flow node analytics, workspace dashboard, workspace send log), the `workspace_daily_rollup` table with a dual write path (incremental webhook increments + periodic reconciliation overwrite), the `subscription_status_history` audit log, and per-send repeat open/click counters.

Security posture is strong: every new route uses the established `resolveWorkspaceMember` 404 double-gate, all SQL is parameterized (verified by adversarial tests), RLS ENABLE + FORCE + NULLIF-guarded policies ship in the same migration that creates each new table, and the rollup metric column names come from a fixed allow-list, never caller input.

The most serious defect is a correctness conflict between the rollup's two write paths: the incremental path counts opened/clicked *events* while the reconciliation overwrite counts *unique sends first-opened/clicked that day*. The reconciliation worker runs every 3 minutes and rewrites today/yesterday, so any repeat-open inflation the incremental path produced is clawed back on the next tick — dashboard "Открыто"/clicked numbers visibly oscillate. The two test suites each encode one of the two conflicting semantics and both pass, which is exactly how this slipped through.

## Critical Issues

### CR-01: `opened_count`/`clicked_count` semantics conflict between the incremental and reconciliation rollup writers — dashboard metrics oscillate every reconcile tick

**File:** `apps/worker/src/queues/webhook-events.worker.ts:258-272`, `apps/worker/src/queues/analytics-reconciliation.worker.ts:45-54`
**Issue:** The two write paths for `workspace_daily_rollup` — documented in `packages/db/src/schema/workspace-daily-rollup.ts` as "Maintained two ways that must never conflict" — compute **different metrics** for `opened_count` and `clicked_count`:

- Incremental path (`webhook-events.worker.ts` `open`/`click` cases): increments the rollup on **every genuinely-new open/click event**, explicitly NOT gated by `justSet` ("mirrors sends.open_count -- climbs on every genuinely-new open").
- Reconciliation path (`reconcileWorkspaceDay`): overwrites with `count(*) FILTER (WHERE first_opened_at::date = day)` — a count of **unique sends first-opened that day**.

Concrete failure: one send opened 5 times today → incremental sets `opened_count = 5`; within 3 minutes the reconciliation worker (RECONCILE_INTERVAL_MS = 180 000, window = today+yesterday) overwrites it to `1`. The dashboard "Открыто" KPI and trend chart values visibly flap between the two numbers, and `openedRate = opened/delivered` can transiently exceed 100% under event-count semantics. Cross-day repeat opens are also permanently lost (an open today of a send first-opened yesterday increments today's count, then reconciliation zeroes it).

A second instance of the same conflict: a send that accumulates BOTH `bounced_at` and `spam_reported_at` (bounce then spam report) is incremented into `bounced_count` **twice** by the incremental path (two separate `justSet` gates at lines 276-284 and 331-339) but counted **once** by the reconciliation's OR-combined filter (lines 49-53) — same oscillation.

The conflict is codified in the tests: `analytics-rollup-idempotency.test.ts:153-170` asserts `opened_count` climbs 1→2 on a repeat open, while `analytics-reconciliation.test.ts:148-177` asserts `opened_count = 1` for a send with `first_opened_at` set. Both pass individually; running reconciliation after the incremental test's scenario would fail it.

**Fix:** Pick one semantic. The cheapest consistent fix is unique-send semantics (matches the reconciliation backstop, the campaign counters, and keeps rates ≤ 100%): gate the rollup increment on `justSet`, exactly like `delivered`:

```typescript
case "open": {
  const justSet = await setFactColumnOnce(client, send.id, "first_opened_at", event.occurredAt);
  if (justSet) {
    if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "opened_count");
    await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "opened");
  }
  // per-send repeat counter still climbs on every new open:
  await client.query(`UPDATE sends SET open_count = open_count + 1 WHERE id = $1`, [send.id]);
  break;
}
```

(Same for `click`.) For the bounce/spam double-count, gate the second terminal's `bounced` rollup+campaign increment on the send not already having another non-delivery terminal fact, or accept the reconciliation value as authoritative and mirror its OR-grouping. Then fix `analytics-rollup-idempotency.test.ts` to assert `opened_count` stays 1 on a repeat open, and add a test that runs `reconcileWorkspaceDay` after incremental increments and asserts the counts are unchanged (that invariant — the entire point of the dual-write design — is currently untested).

## Warnings

### WR-01: `timestamptz::date` casts bucket by the Postgres session timezone, not UTC — day attribution diverges from the rest of the pipeline

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:45-54`, `apps/api/src/modules/analytics/dashboard.repository.ts:141-151`
**Issue:** The incremental path buckets days by UTC (`occurredAt.slice(0, 10)` in `analytics-rollup.ts:46`), and `buildDenseDayWindow` computes the dashboard window in UTC. But `reconcileWorkspaceDay`'s filters (`sent_at::date = $2::date`, etc.) and the growth query's `created_at::date` cast a `timestamptz` to `date` using the **session TimeZone GUC** — and `withTenantTransaction` (packages/tenant-context) never sets it, so it inherits the server default. On any Postgres not configured to UTC, the reconciliation overwrite re-buckets events into different days than the incremental path wrote them to (systematic drift near midnight), and growth `newContacts` counts disagree with the JS-computed UTC window. The dashboard repository's own doc comment (lines 90-95) claims this exact pitfall was avoided by binding `$2` — but the `::date` casts on the column side reintroduce it.
**Fix:** Use an explicit UTC conversion in every cast: `(sent_at AT TIME ZONE 'UTC')::date = $2::date` (and `(created_at AT TIME ZONE 'UTC')::date` in the growth query), or add `SET LOCAL TIME ZONE 'UTC'` alongside the tenant GUC in `withTenantTransaction`.

### WR-02: Floating promise on repeatable-job registration; tick Queue never closed

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:110-118`
**Issue:** `void tickQueue.add("reconcile-rollups", {}, { repeat: ... })` discards the promise. If the Redis `add` rejects (transient connection error at boot), the rejection is unobserved — on Node 22 an unhandled rejection terminates the worker process by default; even with a global handler, the repeatable schedule silently never registers and reconciliation never runs (including `sent_count`, whose SOLE writer is this worker). Additionally, the `Queue` instance created here is never closed — `buildWorker().close()` only closes `workers`, so graceful shutdown leaks this connection.
**Fix:** `tickQueue.add(...).catch((err) => logger.error({ err }, "failed to register reconcile schedule"))` at minimum (ideally retry or crash loudly on purpose), and return/track the Queue so `close()` can call `tickQueue.close()`.

### WR-03: Send-log OFFSET pagination has no unique tie-breaker — rows can repeat or vanish across pages

**File:** `apps/api/src/modules/send-log/send-log.repository.ts:166-171`
**Issue:** `ORDER BY COALESCE("sentAt", "queuedAt") DESC` with `LIMIT/OFFSET`. Broadcast dispatch writes many `sends` rows within the same instant (identical `queued_at` from a batch default `now()`), so ordering among ties is unspecified and can differ between the page-1 and page-2 queries — a row can appear on both pages or on neither. At `SEND_LOG_PAGE_SIZE = 50` against a campaign of thousands, this is a routinely visible defect, not a corner case.
**Fix:** Add a deterministic tie-breaker: `ORDER BY COALESCE("sentAt", "queuedAt") DESC, id DESC`.

### WR-04: Reconciliation tick has no per-workspace error isolation — one failing workspace starves all workspaces after it

**File:** `apps/worker/src/queues/analytics-reconciliation.worker.ts:120-129`
**Issue:** The processor iterates every `organization` row sequentially and `await`s each `reconcileWorkspace` with no try/catch. Any error for one workspace (transient deadlock, RLS/GUC hiccup, bad data) throws out of the processor, fails the whole job, and skips every remaining workspace for that tick. If the failure is persistent (a poison workspace), all workspaces enumerated after it never get reconciled again — and since this worker is the sole writer of `sent_count`, their dashboards permanently show 0 sent.
**Fix:** Wrap the per-workspace call: `try { await reconcileWorkspace(...) } catch (err) { logger.error({ err, workspaceId: row.id }, "reconcile failed") }` so one tenant's failure cannot affect the others.

### WR-05: Contact timeline pagination is unreachable — activity silently truncates at 50 rows

**File:** `apps/web/src/features/contacts/ContactEventFeed.tsx:249-254`, `apps/api/src/modules/analytics/timeline.routes.ts:76-79`
**Issue:** The timeline API supports `?page` (fixed page size 50) but the UI never passes it and renders no "load more"/pagination control — any contact with more than 50 combined events/sends/status-changes/flow-entries silently shows only the newest 50 with no indication more exist. Compounding this, the route returns a bare array with no `total`/`hasMore`, so even a future client cannot know whether another page exists without probing.
**Fix:** Either add a "Показать ещё" control that increments `page` and appends (and have the API return `{ items, page, pageSize, hasMore }` or fetch pageSize+1), or document/enforce the 50-row cap visibly in the UI.

### WR-06: Query errors render as empty states in SendLogPage, SendLogRowDrawer, and ContactEventFeed

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:323-346`, `apps/web/src/features/send-log/SendLogRowDrawer.tsx:115-121`, `apps/web/src/features/contacts/ContactEventFeed.tsx:271-308`
**Issue:** None of these three components check `isError`. On a 4xx/5xx the queries settle with `data === undefined`, which falls through to `items = []` / `rows = []` and renders the *empty-data* copy («Отправок пока нет», «Событий по этому письму пока нет», «Активности пока нет») — a server failure is indistinguishable from "no data", the exact failure mode `WorkspaceDashboard` and `FlowAnalyticsTable` correctly guard against with dedicated error copy. SendLogPage also forwards unvalidated `?status=` URL values straight to the API (`searchParams.getAll("status") as SendLogStatus[]`, line 125), so any stale/typo'd deep-link status yields a 400 → the misleading «Ничего не найдено» card, with «Сбросить фильтры» being the only escape the user can't know they need.
**Fix:** Add an `isError` branch with the existing GENERIC_ERROR pattern to all three components; filter `statuses` against the known vocabulary before building `apiParams` (drop unknown values instead of sending them).

### WR-07: Unsubscribe POST guards `contactId` shape but not `workspaceId` — the same 22P02→500 oracle the guard exists to close

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:177-190`
**Issue:** The handler applies `isUuid(payload.contactId)` specifically because "a structurally-invalid id reaching a uuid-typed column raises an uncaught 22P02 and produces a distinguishable 500, breaking the byte-identical-response invariant" (its own doc comment). But `payload.workspaceId` gets no such check before `withTenant(payload.workspaceId, ...)`: the value goes into `set_config('app.current_workspace_id', ...)` and the RLS policy's `NULLIF(current_setting(...), '')::uuid` cast throws 22P02 on the first query, producing exactly the distinguishable 500 for a signature-valid token carrying a non-UUID workspaceId (the pre-04-19 test-send tokens signed placeholder literals — the same legacy-token class the contactId guard was added for).
**Fix:** Extend the existing guard: `if (isValid && isUuid(payload.contactId) && isUuid(payload.workspaceId)) { ... }` — falls through to the identical response block, preserving the invariant.

### WR-08: Webhook batch insert is unbounded — a large batch exceeds Postgres's 65 535 bind-parameter limit and permanently fails the job

**File:** `apps/worker/src/queues/webhook-events.worker.ts:411-439`, `packages/shared-schemas/src/queues.ts:228-231`
**Issue:** `webhookEventsJobSchema` allows `events: z.array(z.unknown())` with no max, and the worker builds ONE multi-row `INSERT` with 9 bound parameters per event. At >7 281 events the statement exceeds the wire-protocol limit of 65 535 parameters and throws — and since the error is deterministic, BullMQ retries exhaust into the failed set and the entire batch of delivery facts is lost. SendGrid retries whole webhook POSTs and can deliver very large bodies during backlog flushes, so this is a reachable production path, not a theoretical one.
**Fix:** Chunk the insert (e.g. 1 000 rows per statement inside the same transaction), or cap batch size at enqueue time in the webhook route and split oversized posts into multiple jobs.

## Info

### IN-01: Unused import in WorkspaceDashboard

**File:** `apps/web/src/features/dashboard/WorkspaceDashboard.tsx:10`
**Issue:** `computeRate` is imported but never used (all rates arrive precomputed from the API). Will break the build if `noUnusedLocals` is ever enabled.
**Fix:** Remove the import.

### IN-02: `resolveWorkspaceMember` copy-pasted into four route files

**File:** `apps/api/src/modules/analytics/timeline.routes.ts:21-40`, `dashboard.routes.ts:24-43`, `flow-analytics.routes.ts:15-34`, `apps/api/src/modules/send-log/send-log.routes.ts:42-61`
**Issue:** Four byte-identical copies of the membership/404 gate (each with a "copied verbatim... not exported there" comment). A future fix to the enumeration-safety behavior must now be applied in ≥6 places (these four plus the contacts/flows originals) or they drift.
**Fix:** Extract once (e.g. `modules/tenancy/resolve-workspace-member.ts`) and import everywhere.

### IN-03: `relativeTime` + send-status label/class maps duplicated across three components

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:24-62`, `SendLogRowDrawer.tsx:16-29`, `apps/web/src/features/contacts/ContactEventFeed.tsx:12-72`
**Issue:** `relativeTime` is copied verbatim into three files, and `SEND_STATUS_LABELS`/`SEND_STATUS_CLASSES` into two (already divergent: ContactEventFeed's map has an `unsubscribed` entry, SendLogPage's does not).
**Fix:** Move `relativeTime` to `@/lib` and the status vocabulary maps to a shared `features/send-log/status.ts`.

### IN-04: Dashboard "Отправлено писем" per flow counts excluded/failed send rows

**File:** `apps/api/src/modules/analytics/dashboard.repository.ts:214-224`
**Issue:** `count(s.id)` over the `sends` join has no status/`sent_at IS NOT NULL` filter, so flow sends with status `excluded`/`failed`/`dispatching` inflate the "emails sent" mini-list metric.
**Fix:** `count(s.id) FILTER (WHERE s.sent_at IS NOT NULL)`.

### IN-05: Send-log "no sends yet" empty state is wrong when all sends are older than the default 30-day period

**File:** `apps/web/src/features/send-log/SendLogPage.tsx:127-129,194,327-333`
**Issue:** `period` is always applied to the query (default 30), but `hasActiveFilters` treats the default period as "no filter". A workspace whose newest send is 40 days old gets `total === 0 && !hasActiveFilters` → «Отправок пока нет. Письма появятся здесь после первой кампании...», which is false and hides the fact that switching to «90 дней» would show data.
**Fix:** Show the "Ничего не найдено — попробуйте изменить период" card whenever `total === 0` but the (unfiltered, all-time) log is non-empty, or word the empty state to mention the period.

### IN-06: dashboard.test.ts re-implements `computeRate` to compute its own expected values

**File:** `apps/api/src/modules/analytics/__tests__/dashboard.test.ts:177-178,231-234`
**Issue:** `expect(body.kpis.deliveredRate).toBe(computeRate(13, 15))` where the test defines a local `computeRate` identical to the implementation's — the expectation is tautological with respect to the rounding/null contract (a rounding bug shared by both would pass).
**Fix:** Assert literal values: `expect(body.kpis.deliveredRate).toBe(87)` / `expect(body.kpis.openedRate).toBe(46)`.

### IN-07: Suppression/unsubscribe prior-status read is not row-locked

**File:** `apps/worker/src/queues/webhook-events.worker.ts:160-168,195-201`
**Issue:** `applySuppression`/`applyUnsubscribe` SELECT the contact's current status without `FOR UPDATE` before the UPDATE. Two concurrent webhook batches (multiple worker processes) touching the same contact can both read `subscribed` and both write a history row with the same `old_status`, producing a duplicate/incoherent transition in `subscription_status_history`. Low likelihood with current single-worker deployment; becomes real under horizontal scaling.
**Fix:** `SELECT ... FOR UPDATE`, or fold the read into the UPDATE via a CTE (`UPDATE ... FROM (SELECT ... FOR UPDATE)` / `RETURNING` on a conditional `WHERE subscription_status <> 'suppressed'`).

---

_Reviewed: 2026-07-14T03:30:17Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
