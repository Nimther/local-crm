# Phase 7: Analytics, Dashboard & Send Log - Pattern Map

**Mapped:** 2026-07-14
**Files analyzed:** 19 (new + modified)
**Analogs found:** 19 / 19

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/db/src/schema/subscription-status-history.ts` | model | event-driven (append-only log) | `packages/db/src/schema/flow-run-steps.ts` | exact |
| `packages/db/src/schema/workspace-daily-rollup.ts` | model | batch/CRUD (upsert-by-key) | `packages/db/src/schema/campaigns.ts` (counter columns) | role-match |
| `packages/db/src/schema/flow-node-daily-rollup.ts` | model | batch/CRUD (upsert-by-key) | `packages/db/src/schema/campaigns.ts` + `flow-run-steps.ts` | role-match |
| `packages/db/migrations/00XX_analytics_rollups.sql` | migration | CRUD (DDL) | `packages/db/migrations/0026_flows.sql` | exact |
| `apps/api/src/modules/analytics/analytics.routes.ts` | route | request-response | `apps/api/src/modules/contacts/contacts.routes.ts` | exact |
| `apps/api/src/modules/analytics/rollup.repository.ts` | service | CRUD (read aggregate) | `apps/api/src/modules/contacts/contact.repository.ts` (`listContacts`) | role-match |
| `apps/api/src/modules/analytics/timeline.repository.ts` | service | CRUD (read, UNION ALL) | `contact.repository.ts` (`listContactEvents`) | role-match |
| `apps/api/src/modules/send-log/send-log.routes.ts` | route | request-response | `apps/api/src/modules/campaigns/campaigns.routes.ts` | exact |
| `apps/api/src/modules/send-log/send-log.repository.ts` | service | CRUD (filtered list) | `contact.repository.ts` (`listContacts`) | exact |
| `apps/worker/src/queues/analytics-rollup.worker.ts` (helpers used inside webhook worker) | service/utility | event-driven (same-tx increment) | `apps/worker/src/queues/webhook-events.worker.ts` (`setFactColumnOnce`/`incrementCampaignCounter`) | exact |
| `apps/worker/src/queues/analytics-reconciliation.worker.ts` | service | event-driven (repeatable scan) | `apps/worker/src/queues/campaign-scheduler.worker.ts` | exact |
| `packages/contacts-core/src/subscription-status-history.ts` (shared helper) | utility | event-driven (write-on-change) | `webhook-events.worker.ts`'s `applySuppression`/`applyUnsubscribe` | role-match |
| `apps/web/src/features/dashboard/WorkspaceDashboard.tsx` | component | request-response | `apps/web/src/features/workspace-home/WorkspaceHome.tsx` | role-match |
| `apps/web/src/features/dashboard/TrendChart.tsx` / `GrowthChart.tsx` | component | request-response | `apps/web/src/features/campaigns/CampaignProgress.tsx` (query+render) | role-match |
| `apps/web/src/features/send-log/SendLogPage.tsx` | component | request-response | `apps/web/src/features/contacts/ContactsListPage.tsx` (TanStack Table + filters, pattern 02-13) | exact |
| `apps/web/src/features/send-log/SendLogRowDrawer.tsx` | component | request-response | `apps/web/src/features/contacts/ContactEventFeed.tsx` (Collapsible/detail row) | role-match |
| `apps/web/src/features/contacts/ContactEventFeed.tsx` (evolves) | component | request-response | itself (existing file, extend query+union) | exact |
| `apps/web/src/features/campaigns/CampaignProgress.tsx` (extended) | component | request-response | itself (existing file, add rate %/excluded row) | exact |
| `apps/web/src/features/flows/canvas/nodeTypes.tsx` (extended) | component | request-response | itself (existing `NodeShell` overlay) | exact |
| `apps/web/src/features/flows/detail/FlowAnalyticsTable.tsx` | component | request-response | `apps/web/src/features/flows/detail/FlowDetailPage.tsx` (Tabs pattern) | role-match |
| `apps/web/src/features/app-shell/AppShell.tsx` (add nav items) | component | request-response | itself (existing `NavLink` list) | exact |

## Pattern Assignments

### `packages/db/src/schema/subscription-status-history.ts` (model, event-driven)

**Analog:** `packages/db/src/schema/flow-run-steps.ts` (full file, 27 lines — append-only audit log shape)

**Core pattern (copy structure verbatim, adapt columns):**
```typescript
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { contacts } from "./contacts.js";

/**
 * Append-only log of every subscription_status transition (D-09). One row
 * per change -- never updated, never deleted. `source` records which call
 * site produced the change (webhook_suppression | unsubscribe_route |
 * manual_ui | csv_import | api | shared_upsert).
 */
export const subscriptionStatusHistory = pgTable("subscription_status_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  oldStatus: text("old_status"),
  newStatus: text("new_status").notNull(),
  source: text("source").notNull(),
  reason: text("reason"),
  changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
});
```

---

### `packages/db/src/schema/workspace-daily-rollup.ts` / `flow-node-daily-rollup.ts` (model, batch)

**Analog:** `packages/db/src/schema/campaigns.ts` lines 39-69 (counter-column shape) — copy the `integer(...).notNull().default(0)` counter-column convention, plus a `unique()` composite key like `sends.ts` lines 71-73 (`sends_workspace_campaign_contact_unique`) for the upsert-conflict target (`(workspace_id, day)` / `(workspace_id, flow_id, node_id, day)`).

```typescript
// workspace-daily-rollup.ts shape
export const workspaceDailyRollup = pgTable("workspace_daily_rollup", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  sentCount: integer("sent_count").notNull().default(0),
  deliveredCount: integer("delivered_count").notNull().default(0),
  openedCount: integer("opened_count").notNull().default(0),
  clickedCount: integer("clicked_count").notNull().default(0),
  bouncedCount: integer("bounced_count").notNull().default(0),
  unsubscribedCount: integer("unsubscribed_count").notNull().default(0),
}, (t) => [unique("workspace_daily_rollup_workspace_day_unique").on(t.workspaceId, t.day)]);
```

---

### `packages/db/migrations/00XX_analytics_rollups.sql` (migration)

**Analog:** `packages/db/migrations/0026_flows.sql` lines 113-144 — copy RLS block verbatim per new table (subscription_status_history, workspace_daily_rollup, flow_node_daily_rollup):

```sql
ALTER TABLE workspace_daily_rollup ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_daily_rollup FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_daily_rollup
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
```
Apply the identical block (renaming the table) to `flow_node_daily_rollup` and `subscription_status_history`. Note: `flow_run_steps`'s composite-key/partial-index pattern in this same migration file is the template if any new table needs a partial unique index Drizzle can't express (mirrors `sends_flow_run_node_unique` precedent in migration 0028).

---

### `apps/api/src/modules/analytics/analytics.routes.ts` (route, request-response)

**Analog:** `apps/api/src/modules/contacts/contacts.routes.ts` (full file, 211 lines)

**Imports pattern** (lines 1-19):
```typescript
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { contactListQuerySchema } from "@mega-crm/shared-schemas"; // -> new dashboardQuerySchema/timelineQuerySchema
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
```

**Auth/membership-resolution pattern** (lines 58-77, `resolveWorkspaceMember`): copy verbatim — every analytics/send-log/timeline route must call this exact 404-on-non-member helper (or import a shared version of it) before touching data, since analytics is readable by all members including Member role (no elevated-role check needed, unlike sendgrid-key routes).

**Core request-response pattern** (lines 128-138, `GET /contacts/:id` shape — 404 if not found, `withTenant` wrap):
```typescript
fastify.get("/api/workspaces/:slug/dashboard", async (request, reply) => {
  const { slug } = request.params as { slug: string };
  const parsed = dashboardQuerySchema.safeParse(request.query); // period=7|30|90
  if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
  const workspace = await resolveWorkspaceMember(request, reply, slug);
  if (!workspace) return;
  const result = await withTenant(workspace.id, () => getDashboard(parsed.data));
  return reply.send(result);
});
```

**IDOR double-gate pattern** (lines 145-160, `GET /contacts/:id/events`): for `send-log/:sendId/events`, mirror this exact double-check — explicit existence lookup (404, not empty array) PLUS ambient RLS, so a foreign-workspace sendId 404s rather than silently returning zero rows.

---

### `apps/api/src/modules/analytics/rollup.repository.ts` / `timeline.repository.ts` / `apps/api/src/modules/send-log/send-log.repository.ts` (service, CRUD read)

**Analog:** `apps/api/src/modules/contacts/contact.repository.ts` — `listContacts` (lines 141-205) for filter-compilation, and `listContactEvents` (lines 83-96) for paginated read.

**Filter-compilation + pagination pattern** (lines 141-205, D-13 style — copy directly for send-log filters contact/campaignOrFlow/status/period):
```typescript
export async function listContacts(query: ListContactsQuery): Promise<ListContactsResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const conditions: string[] = ["workspace_id = $1"];
    const params: unknown[] = [workspaceId];
    // ...push $N conditions per filter (status, tags, search)...
    const whereClause = conditions.join(" AND ");
    const { rows: countRows } = await client.query(`SELECT count(*) FROM contacts WHERE ${whereClause}`, params);
    const { rows } = await client.query(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE ${whereClause} ORDER BY created_at DESC LIMIT $N OFFSET $N`,
      params
    );
    return { items: rows, total: Number(countRows[0].count), page: query.page, pageSize: query.pageSize };
  });
}
```

**Simple paginated read pattern** (lines 83-96, `listContactEvents` — template for `timeline.repository.ts`'s UNION query and `send-log.repository.ts`'s drawer query):
```typescript
export async function listContactEvents(contactId: string, opts: { page: number }): Promise<ContactEventRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query(
      `SELECT id, name, properties, occurred_at, received_at FROM events
       WHERE workspace_id = $1 AND contact_id = $2
       ORDER BY occurred_at DESC LIMIT $3 OFFSET $4`,
      [workspaceId, contactId, CONTACT_EVENTS_PAGE_SIZE, (page - 1) * CONTACT_EVENTS_PAGE_SIZE]
    );
    return rows;
  });
}
```

**Pagination constant:** reuse `EXHAUSTIVE_LOOKUP_PAGE_SIZE` convention from `packages/shared-schemas/src/pagination.ts` (full file, 15 lines) — add a new named constant for send-log/timeline page sizes rather than a magic number, following this exact single-source-of-truth precedent shared between Zod schema `max` bound and web call site.

---

### `apps/worker` rollup increment + reconciliation (service, event-driven)

**Analog for incremental rollup:** `apps/worker/src/queues/webhook-events.worker.ts` lines 119-140 (`setFactColumnOnce`/`incrementCampaignCounter`) and lines 189-297 (`applyEventSideEffects` — the `if (justSet) { ... }` gating pattern).

**Exact gating pattern to copy (critical for Pitfall 1 — never increment outside `justSet`):**
```typescript
case "delivered": {
  const justSet = await setFactColumnOnce(client, send.id, "delivered_at", event.occurredAt);
  if (justSet) {
    if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "delivered_count");
    // NEW: same-transaction rollup increment, same idempotency guarantee
    await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "delivered");
  }
  break;
}
```

**Analog for reconciliation worker:** `apps/worker/src/queues/campaign-scheduler.worker.ts` (full file, 125 lines) — copy the entire repeatable-tick + admin-scan-discovery + per-row-`withTenant`-transition shape:
- `findDueCampaignCandidates` (lines 36-53): `pool.connect()` direct admin scan pattern — but per the research's Anti-Pattern note, the reconciliation job does NOT need this admin-scan variant; instead enumerate `organization.id` directly (a small, non-sensitive list) since every read/write is already tenant-scoped once workspace id is known.
- `transitionToSending` (lines 69-87): copy the `withTenant(workspaceId, () => withTenantTransaction(async (client) => {...}))` wrapping shape verbatim for `reconcileWorkspaceDay`.
- `createCampaignSchedulerWorker` (lines 101-125): copy the `Queue` + `tickQueue.add(..., { repeat: { every: MS }, jobId: "..." })` self-produced/self-consumed tick-queue registration verbatim for `createAnalyticsReconciliationWorker`.

**Reconciliation overwrite semantics (Pitfall 2 — must NOT match increment pattern, must be `DO UPDATE SET count = EXCLUDED.count`, never additive):** no existing direct analog in this codebase (all existing counters are increment-only) — this is genuinely new logic; write it carefully per RESEARCH.md's Pattern 2/Pitfall 2 code example, not copied from any existing file.

---

### `packages/contacts-core` shared subscription-status-history write helper (utility, event-driven)

**Analog:** `webhook-events.worker.ts` lines 142-172 (`applySuppression`/`applyUnsubscribe`) shows the existing per-call-site status-mutation shape that the new helper must wrap. Per RESEARCH.md's explicit Anti-Pattern warning, do NOT leave four independent hand-written INSERTs — export one `recordSubscriptionStatusChange(client, workspaceId, contactId, oldStatus, newStatus, source, reason?)` helper from `packages/contacts-core` (new file `subscription-status-history.ts`) and call it unconditionally from all four sites:
- `apps/api/src/modules/contacts/contact.repository.ts` (`updateContact`, lines ~306-312 — status-mutation branch)
- `packages/contacts-core/src/contact-repository.ts` (`upsertContactByIdentity`, lines ~327-338)
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` (line 192)
- `apps/worker/src/queues/webhook-events.worker.ts` (`applySuppression` line 156, `applyUnsubscribe` line 172)

Each call site's existing `UPDATE contacts SET subscription_status = ...` statement gets the new helper call added immediately after, gated on `nextStatus !== existing.subscriptionStatus`.

---

### `apps/web/src/features/dashboard/WorkspaceDashboard.tsx` (component, request-response)

**Analog:** `apps/web/src/features/workspace-home/WorkspaceHome.tsx` (full file, 58 lines) — this file's onboarding-checklist rendering block is preserved verbatim per D-08a ("онбординг-чеклист остаётся блоком сверху"); the dashboard component wraps it and adds trend/growth charts + KPI cards below.

**Query pattern (analog):** `apps/web/src/features/campaigns/CampaignProgress.tsx` lines 28-33 — `useQuery` with `queryKey: ["workspace", slug, ...]`, `apiGet` fetcher. Reuse identically for `useQuery({ queryKey: ["workspace", slug, "dashboard", period], queryFn: () => apiGet(...) })`.

---

### `apps/web/src/features/dashboard/TrendChart.tsx` / `GrowthChart.tsx` (component)

**No direct analog** — first Recharts usage in this codebase (no existing chart library installed). Follow `CampaignProgress.tsx`'s `useQuery` + presentational-render split (data-fetching in parent `WorkspaceDashboard.tsx`, these two components receive pre-fetched series as props and render pure Recharts `<LineChart>`/`<AreaChart>`). Use existing Tailwind/shadcn CSS variables (`--primary`, `--muted-foreground`) for chart colors per RESEARCH.md's Don't-Hand-Roll guidance — do not hand-pick hex values.

---

### `apps/web/src/features/send-log/SendLogPage.tsx` (component, request-response)

**Analog:** the codebase's established filterable-list pattern (02-13: `keepPreviousData` + skeleton + `isPlaceholderData` dim) — same TanStack Table + TanStack Query combination already used for the contacts list. Reuse `EXHAUSTIVE_LOOKUP_PAGE_SIZE`-style pagination constant convention and URL-param-driven filter state (D-13's cross-page prefilter links via URL params) matching how campaign/flow/contact detail pages already link into this codebase's other filtered lists.

**Row-click drawer analog:** `ContactEventFeed.tsx`'s `Collapsible`/expand-row pattern (lines 26-53, `EventRow`) — for `SendLogRowDrawer.tsx`, adapt this same expand-on-click shape (though a full `Drawer`/`Sheet` component from shadcn/ui, not an inline `Collapsible`, per D-14's "drawer/панель" spec) and reuse `relativeTime`/`RELATIVE_TIME_FORMAT` (lines 11-24) verbatim for event timestamps in the per-message history.

---

### `apps/web/src/features/campaigns/CampaignProgress.tsx` (extended, D-01/D-04/D-07)

**Analog:** itself — this exact file (92 lines) already renders the 5-counter `<dl>` grid (lines 66-87). Extend by adding computed rate percentages next to each counter (using a new shared `computeRate(numerator, denominator)` helper per RESEARCH.md's Don't-Hand-Roll table) and one new "Пропущено: N" excluded row with reason breakdown, plus a link into `SendLogPage` with a `?campaign=<id>` URL param (D-04). Do not add new tabs — this is a same-component enrichment per D-04's explicit constraint.

---

### `apps/web/src/features/flows/canvas/nodeTypes.tsx` (extended, D-03) and `FlowAnalyticsTable.tsx` (new)

**Analog for badge overlay:** itself, `nodeTypes.tsx`'s existing `NodeShell` component (260 lines total) — add an optional `metrics` prop rendering a small read-only badge overlay with the per-node visit count (and send/delivered/opened/clicked/bounced counts on send-nodes), sourced from one aggregated `GET /flows/:id/analytics` response keyed by `nodeId`.

**Analog for table tab:** `apps/web/src/features/flows/detail/FlowDetailPage.tsx` lines 229-251 (`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` structure) — add a fourth `<TabsTrigger value="analytics">Аналитика</TabsTrigger>` following the exact same three-tab pattern already there (`canvas`/`settings`/`runs`).

---

### `apps/web/src/features/app-shell/AppShell.tsx` (extended — new nav items)

**Analog:** itself, existing `NavLink` list (lines 30-59) — add two more entries following the identical `<NavLink to={...} className={navLinkClassName}>Label</NavLink>` shape:
```typescript
<NavLink to={`/w/${slug}/dashboard`} className={navLinkClassName} end>Дашборд</NavLink>
<NavLink to={`/w/${slug}/send-log`} className={navLinkClassName}>Журнал отправок</NavLink>
```
Per D-08a, the dashboard route also becomes the workspace's index route (replacing `WorkspaceHome` as `/w/:slug` default), so the router config (not shown here, check `apps/web/src/app/routes.tsx` or equivalent) needs its index-route target swapped.

---

## Shared Patterns

### Tenant-scoped repository read/write
**Source:** `contact.repository.ts` (`withTenantTransaction`, `getWorkspaceId()`)
**Apply to:** All new repository files (`rollup.repository.ts`, `timeline.repository.ts`, `send-log.repository.ts`, `subscription-status-history.ts` helper)
```typescript
import { withTenantTransaction, getWorkspaceId } from "@mega-crm/tenant-context";
export async function someRead(...): Promise<...> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    // parameterized query only, never string-interpolated filter values
  });
}
```

### Workspace-membership route guard
**Source:** `contacts.routes.ts` lines 58-77 (`resolveWorkspaceMember`)
**Apply to:** All new route files (`analytics.routes.ts`, `send-log.routes.ts`) — every GET route in this phase is member-readable (no elevated role check), per CONTEXT.md's discretion note.

### RLS ENABLE+FORCE+NULLIF-guard on new tables
**Source:** `packages/db/migrations/0026_flows.sql` lines 113-144
**Apply to:** `subscription_status_history`, `workspace_daily_rollup`, `flow_node_daily_rollup` migration DDL.

### Same-transaction idempotent increment (`justSet` gate)
**Source:** `webhook-events.worker.ts` lines 119-140, 189-297
**Apply to:** `analytics-rollup.worker.ts`'s increment helpers, called from inside webhook-events worker's existing `if (justSet)` branches and from the flow-run-advance step-completion write — never as an independently-gated check (Pitfall 1).

### Repeatable BullMQ tick-queue registration
**Source:** `campaign-scheduler.worker.ts` lines 101-125
**Apply to:** `analytics-reconciliation.worker.ts` — `Queue` + `tickQueue.add(..., { repeat: { every: MS }, jobId: "fixed-id" })`.

### Relative-time formatting (Russian)
**Source:** `ContactEventFeed.tsx` lines 11-24 (`relativeTime`, `RELATIVE_TIME_FORMAT`)
**Apply to:** Timeline rows, send-log drawer event history — reuse verbatim or extract to a shared util if used in 3+ places (dashboard doesn't need it, but timeline + send-log drawer both do).

### Percent-rate computation
**Source:** none existing (new shared helper per RESEARCH.md's Don't-Hand-Roll table)
**Apply to:** `CampaignProgress.tsx` (D-01), `FlowAnalyticsTable.tsx`, node badges — one `computeRate(numerator, denominator): number | null` helper (returns `null` on zero-denominator, never `NaN`), placed in a shared location such as `packages/shared-schemas` or a new `apps/web/src/lib/rates.ts`.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/web/src/features/dashboard/TrendChart.tsx` / `GrowthChart.tsx` | component | request-response | First Recharts usage in this codebase — no chart library precedent exists; follow RESEARCH.md's Code Examples and shadcn CSS-variable color guidance instead. |
| Reconciliation overwrite logic (`analytics-reconciliation.worker.ts`'s core UPSERT) | service | batch | All existing counters in this codebase are increment-only; the "overwrite, never add" correctness property (Pitfall 2) has no precedent to copy — implement per RESEARCH.md's Pattern 2 code example directly. |

## Metadata

**Analog search scope:** `packages/db/src/schema/`, `apps/api/src/modules/{contacts,campaigns,delivery,events}/`, `apps/worker/src/queues/`, `apps/web/src/features/{contacts,campaigns,flows,workspace-home,app-shell}/`, `packages/shared-schemas/`, `packages/contacts-core/`, `packages/db/migrations/`
**Files scanned:** ~25 (targeted reads, no full-repo scan needed — CONTEXT.md/RESEARCH.md already named exact file paths)
**Pattern extraction date:** 2026-07-14
