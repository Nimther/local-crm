# Phase 7: Analytics, Dashboard & Send Log - Research

**Researched:** 2026-07-14
**Domain:** Read-side analytics/rollup aggregation over an existing multi-tenant email-marketing send ledger (Postgres + BullMQ), plus one new write path (subscription-status history)
**Confidence:** HIGH (stack/architecture — verified against this codebase's own established patterns); MEDIUM (rollup-schema/chart-library choices — cross-checked web sources); LOW (none — every ASSUMED claim is logged below)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Метрики кампаний и шагов (ANLT-01, ANLT-02)**
- D-01: Проценты — индустриальный стандарт: open rate = opened/delivered, click rate = clicked/delivered; delivery rate и bounce rate — от sent. Один знаменатель на метрику, вторые проценты не показываем.
- D-02: Per-step метрики цепочки — по ВСЕМ узлам: на каждом узле количество прошедших контактов (источник — flow_run_steps, включая исходы развилок); на send-узлах дополнительно sent/delivered/opened/clicked/bounced.
- D-03: Размещение per-step метрик — двойное: бейджи с цифрами прямо на узлах canvas (read-only оверлей, модель Klaviyo) + табличная вкладка «Аналитика» на странице цепочки для сравнения шагов списком.
- D-04: Метрики кампании живут в СУЩЕСТВУЮЩЕЙ сводке на детальной странице — обогащаем блок процентами и переходом в send log с предфильтром по кампании. Новых вкладок на странице кампании нет.
- D-05: Агрегация per-step метрик по версиям цепочки — по nodeId сквозно через все версии (метрика узла = сумма по всем версиям, где nodeId встречался). Canvas показывает live-версию; узлы, удалённые из live, остаются видимыми только во вкладке-таблице.
- D-06: Метрики в списках: кампании — sent / delivered% / opened% / clicked%; цепочки — активные runs + отправлено писем.
- D-07: Excluded-письма видны в сводке кампании/цепочки отдельной строкой с разбивкой по причинам (подписка/suppression, frequency cap): «Пропущено: N». В проценты не входят.

**Дашборд воркспейса (ANLT-04)**
- D-08: Состав: график отправок/доставок/открытий по дням + график роста базы контактов + KPI-карточки за период (отправлено, delivered%, opened%, новые контакты, отписки) + мини-списки последних кампаний и активных цепочек с ключевыми метриками. Период: пресеты 7/30/90 дней, дефолт 30, гранулярность по дням; произвольный date-range — v2.
- D-08a: Дашборд становится ДОМАШНЕЙ страницей воркспейса (заменяет WorkspaceHome); онбординг-чеклист Phase 1 остаётся блоком сверху, пока не завершён.
- D-08b: Свежесть данных дашборда/трендов: лаг до нескольких минут допустим (инкрементальная rollup-агрегация). Счётчики кампаний остаются near-real-time как есть. Никаких тяжёлых on-the-fly сканов сырых партиций на каждый заход.

**Timeline контакта (ANLT-03)**
- D-09: Смены статуса подписки — НОВАЯ таблица истории (contact × старый→новый статус, источник/причина, timestamp), пишется из ВСЕХ точек смены: webhook-suppression, unsubscribe, ручная правка UI, CSV-импорт, API, shared upsert. История начинается с этой фазы — ретроспективную реконструкцию старых смен не делаем.
- D-10: Единый timeline: ContactEventFeed эволюционирует в общую хронологическую ленту (кастомные события + отправки + открытия/клики + смены статуса) с фильтром по типу записи (всё/события/письма/статусы). Отдельных вкладок нет.
- D-11: Повторные открытия/клики одного письма схлопываются: одна запись на первое открытие со счётчиком «×N»; клики аналогично, по URL. Сырые повторы остаются в send_events.
- D-12: Расширенный состав сверх ANLT-03: входы/выходы из цепочек (из flow_runs, с причиной выхода) и excluded-письма с причиной.

**Send log (ANLT-05)**
- D-13: Отдельная страница «Журнал отправок» в сайдбаре — весь воркспейс, все фильтры (контакт, кампания/цепочка, статус, период). Со страниц кампании/цепочки/контакта — ссылки сюда с предвыставленным фильтром через URL-параметры.
- D-14: Клик по строке — drawer/панель с полной хронологией событий письма из send_events (отправлено → доставлено → открыто ×N → клики по конкретному URL), причинами bounce/drop/exclusion и ссылками на контакт/кампанию/цепочку.
- D-15: Колонка и фильтр «статус» — ОДИН вычисляемый итоговый статус по цепочке Phase 5 D-06, расширенный failed и excluded; фильтр — multi-select по этим значениям.
- D-16: CSV-экспорт send log — НЕ в этой фазе (deferred).

### Claude's Discretion
- Схема rollup-таблиц (per-day × workspace / campaign / flow-node), механика инкрементальной агрегации и периодической сверки; выбор триггера инкремента (при обработке webhook-событий vs периодический скан) — с оглядкой на идемпотентность и дедуп send_events.
- Выбор chart-библиотеки: Recharts или Tremor (CLAUDE.md допускает обе; в проекте ещё нет ни одной).
- Пагинация send log и timeline на больших объёмах (курсорная vs offset; партиционированные таблицы — учесть pruning по occurred_at), стратегия индексов под фильтры.
- Как считать «рост базы контактов» (created_at контактов vs дневные снапшоты) и «новые контакты» за период.
- RLS ENABLE+FORCE для всех новых таблиц (rollups, status history) по паттерну Phase 1–6; NULLIF-guard в policy; tenant context в воркерах агрегации.
- Доступ по ролям: аналитика читается всеми членами воркспейса (Member включительно) — если ресёрч не выявит причин иного.
- Русские UI-тексты в стиле Phase 2–6; терминология статусов согласована с существующими бейджами (SubscriptionStatusBadge, счётчики кампаний).
- Детали UI (лейауты, скелетоны, empty states) — UI-SPEC придёт из /gsd-ui-phase (ui_phase: yes).

### Deferred Ideas (OUT OF SCOPE)
- CSV-экспорт send log по текущим фильтрам — фоновая генерация на сотнях тысяч строк, отдельная задача (D-16).
- Произвольный date-range picker на дашборде — v1 живёт с пресетами 7/30/90 (D-08).
- Селектор версии цепочки в per-step аналитике — v1 агрегирует по nodeId сквозно (D-05).
- Ретроспективная реконструкция смен subscription status до этой фазы (D-09).
- Расширенная диагностика webhook (счётчики отклонённых подписей, лог ошибок за 24ч) — остаётся в бэклоге, НЕ входит в ANLT-01…05.
- Второй знаменатель процентов (от sent) как настройка — отклонено для v1 (D-01).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ANLT-01 | Пользователь видит метрики кампании: sent/delivered/opened/clicked/bounced/unsubscribed (счётчики и проценты) | `campaigns` table already carries all six counters (Phase 5) — this phase adds rate calculations (D-01) + excluded-row (D-07) on top of the existing `CampaignProgress`/`SummaryView` components. No new counter columns needed. |
| ANLT-02 | Пользователь видит метрики каждого шага цепочки | `flow_run_steps` (append-only, one row per node visit) is the exact source Phase 6 built for this. Aggregation happens in the new per-step rollup table, grouped by `node_id` across flow versions (D-05). |
| ANLT-03 | Timeline контакта: события, письма, открытия, клики, смены статуса | Union of `events`, `sends`+`send_events`, new `subscription_status_history`, `flow_runs` — all already exist except the history table. See Architecture Patterns § Contact Timeline. |
| ANLT-04 | Сводный дашборд воркспейса: тренды + рост базы | New `workspace_daily_rollup` table (incrementally updated + periodically reconciled per ROADMAP 07-01) is the read path; avoids scanning partitioned `sends`/`send_events`/`events` on every dashboard load (D-08b). |
| ANLT-05 | Per-message send log с фильтрами | `sends` (not partitioned) is the primary list source; `send_events` (partitioned) backs the drawer's per-message history (D-14). Status column reuses Phase 5 D-06's priority chain, extended with `failed`/`excluded` (D-15). |
</phase_requirements>

## Summary

This phase is overwhelmingly a **read/aggregation** phase, not a new-write phase. Every fact this phase displays is already durably recorded by Phases 4–6: `sends` (unified ledger with delivery-fact columns and flow attribution), `send_events` (raw append-only webhook log, partitioned by month), `flow_run_steps` (append-only node-visit log, purpose-built in Phase 6 for exactly this analytics need), `campaigns` (near-real-time unique-recipient counters), `events` (custom event log, partitioned by month), and `flow_runs` (entry/exit history). The only genuinely new *write* path this phase introduces is a `subscription_status_history` table (D-09), fed from four existing call sites that already mutate `contacts.subscription_status`.

The phase's real engineering weight is in **07-01** (rollup tables + incremental aggregation + periodic reconciliation) — everything downstream (07-02 through 07-05) is UI/query work built on top of that foundation, or, for the send log (07-05) and per-message drawer, direct queries against `sends`/`send_events` with no rollup needed at all (per-message detail is inherently row-level, not aggregate).

**Primary recommendation:** Build two new rollup tables — `workspace_daily_rollup` (one row per workspace × day) and `flow_node_daily_rollup` (one row per workspace × flow × node_id × day) — incrementally updated inside the *same transactions* that already write to `sends`/`campaigns`/`flow_run_steps` (webhook-events worker, flow-run-advance worker, campaign counter increments), with a BullMQ repeatable reconciliation job (mirroring the existing `campaign-scheduler.worker.ts` self-healing pattern) that re-derives the last N days from source tables every few minutes to correct any missed increments. Campaign/flow-list metrics and the per-message send log read directly from existing tables (`campaigns`, `sends`) with no rollup involved — only the workspace dashboard and time-series trend charts read from rollups. Use **Recharts** (not Tremor) for charts — verified below. Keep the codebase's established **offset/limit pagination** convention for the send log and contact timeline rather than introducing cursor-based pagination; the phase's own data volumes do not warrant the added complexity, and no other list in this codebase uses cursors.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Campaign/flow metric percentages (ANLT-01/02 D-01) | API / Backend | — | Pure derived-field computation (opened/delivered etc.) belongs in the route/response-shaping layer, not the DB (no new columns) or the client (avoids re-deriving the same formula in multiple UI spots). |
| Per-step node-visit counts (ANLT-02) | Database / Storage | API / Backend | `flow_run_steps` already exists; a `GROUP BY node_id` read (or the new rollup table) is a storage-tier aggregation, exposed via a thin API read. |
| Canvas node metric badges (D-03) | Browser / Client | API / Backend | Rendering is client-side (`FlowCanvas`/`nodeTypes.tsx`'s existing `NodeShell` overlay pattern); API supplies one aggregated payload per flow. |
| Rollup incremental aggregation (07-01) | API / Backend (worker process) | Database / Storage | BullMQ worker processes own the increment-on-write logic inside the same transaction as the source-of-truth write (mirrors `webhook-events.worker.ts`'s existing counter-increment pattern) — this is backend business logic, not a DB trigger. |
| Periodic reconciliation scan (07-01) | API / Backend (worker process) | — | A repeatable BullMQ job, same architectural slot as `campaign-scheduler.worker.ts`'s existing 60s tick — backend-owned, not a pg_cron/DB-level job (project has no pg_cron precedent or dependency). |
| Contact timeline union query (ANLT-03) | API / Backend | Database / Storage | A `UNION ALL` across 4-5 tables is naturally a backend query-composition concern; DB just needs the right indexes. |
| Subscription-status history write (D-09) | API / Backend | Database / Storage | Each of the 4 existing mutation call sites (API repository, contacts-core shared upsert, unsubscribe route, webhook worker) gets a small backend-side insert; the table itself is a plain audit-log storage concern. |
| Workspace dashboard charts (ANLT-04) | Browser / Client | API / Backend | Recharts renders client-side from a pre-aggregated JSON payload the API assembles from rollup tables — no heavy computation in the browser. |
| Send log filters/pagination (ANLT-05) | API / Backend | Database / Storage | Filter compilation (contact/campaign-or-flow/status/period) is backend query-building over indexed columns on `sends`, matching every other filterable list in this codebase (`contact.repository.ts`, `campaign.repository.ts`). |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| **Recharts** | 3.9.2 (installed today) | Dashboard charts (trend lines, growth chart) | `[VERIFIED: npm registry]` — `npm view recharts version` → 3.9.2, `peerDependencies` explicitly include `react: "^19.0.0"`. 45.9M weekly downloads, actively maintained (`repository.url` = `github.com/recharts/recharts`, not deprecated). CLAUDE.md already names Recharts/Tremor as the two acceptable options; this research resolves the choice in Recharts' favor (see Alternatives Considered). |
| **@tanstack/react-table** | ^8.21.3 (already installed) | Send log table, per-step comparison table (D-03's table tab) | `[VERIFIED: codebase]` — already a project dependency (`apps/web/package.json`), used by `ContactsListPage`/`FlowRunsTable`. No new library needed for either new table surface. |
| **@tanstack/react-query** | 5.101.2 (already installed) | Server-state fetching for dashboard/timeline/send-log/analytics-tab queries | `[VERIFIED: codebase]` — every existing data-fetching surface in this codebase (`CampaignProgress`, `ContactEventFeed`, `FlowRunsTable`) uses this; this phase's new queries follow the identical `useQuery`/pagination pattern already established. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| **date-fns** (or plain `Intl`) | not yet installed | Period-preset (7/30/90-day) date-range math, daily bucket labels on X-axis | `[ASSUMED]` — the codebase currently hand-rolls relative-time formatting via `Intl.RelativeTimeFormat` (`ContactEventFeed.tsx`) with zero date-math library. For fixed day-count range subtraction (`now() - 7 days`) plain `Date` arithmetic or `Intl.DateTimeFormat` may suffice without adding a dependency — recommend the planner default to **no new dependency** (native `Date`/`Intl`) unless a concrete need for timezone-aware bucketing surfaces, matching this codebase's existing zero-date-library convention. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Recharts | @tremor/react (Tremor) | `[VERIFIED: npm registry]` Tremor's `peerDependencies` cap at `react: "^18.0.0"` (`npm view @tremor/react peerDependencies`) — **incompatible** with this project's installed React 19.2.7. Tremor's last publish was 2025-01-13 (over a year stale relative to Recharts' days-old latest release). Tremor's pre-styled KPI-card/chart component system is also a competing design language against this codebase's already-established shadcn/ui `Card`/`Badge` primitives (`CampaignProgress.tsx`, `WorkspaceHome.tsx`) — adopting Tremor's opinionated components would fight the existing visual system rather than compose with it. Recharts is the clear, unambiguous choice for this project. |
| Incremental-only rollup (no reconciliation) | Pure recompute-on-read (no rollup table at all) | Rejected by the user's own ROADMAP/CONTEXT decision (07-01, D-08b) — "no heavy on-the-fly scans of raw partitions on every dashboard load." Documented here only because it's the naive alternative a planner might default to. |
| Offset/limit pagination (send log, timeline) | Cursor/keyset pagination | Keyset pagination is the theoretically more scalable choice for very large, frequently-appended tables (general Postgres guidance, see Sources), but **every existing list endpoint in this codebase** (`contact.repository.ts`, `campaign.repository.ts`, flow-runs) uses plain `LIMIT/OFFSET` with a `page`/`pageSize` contract shared via `EXHAUSTIVE_LOOKUP_PAGE_SIZE`/pagination.ts. Introducing a second pagination paradigm for exactly two new endpoints (send log, timeline) adds API-shape inconsistency for a scale this MVP does not yet need (a single contact's timeline is inherently bounded; workspace-wide send log at hundreds-of-thousands-per-day volumes is a legitimate future concern but not a Phase 7 MVP blocker if `sends` has the right composite indexes). Recommend staying with offset/limit for consistency; flag keyset pagination as a documented v2 follow-up if send-log row counts prove painful in practice. |

**Installation:**
```bash
npm install recharts --workspace apps/web
```

**Version verification:** `npm view recharts version` → `3.9.2`, published `2026-07-04` (days before this research date — i.e. an active, current release cadence, not stale). `npm view recharts peerDependencies` confirms `react: "^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0"`.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| recharts | npm | Package itself is long-established (multi-year); **latest published version** (3.9.2) is from days before this research — the legitimacy-check heuristic flags "too-new" against that specific version's publish timestamp, not the package's age | 45,988,452/week | `github.com/recharts/recharts` | SUS (heuristic "too-new" signal on latest patch release only) | Flagged — planner should add a `checkpoint:human-verify` before `npm install`, but this is a false-positive-shaped flag: 45.9M weekly downloads, non-deprecated, canonical GitHub org repo, and the project's own CLAUDE.md already names this library as a pre-approved option. Recommend the checkpoint be a quick confirm-and-proceed, not a blocking investigation. |
| @tremor/react | npm | ~1+ year since last publish (2025-01-13) | 279,126/week | `github.com` tremorlabs org (not independently re-verified this session) | Not selected | REMOVED from recommendation — React 19 peer-dependency incompatibility (`^18.0.0` cap) makes it unusable in this codebase regardless of legitimacy. |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** recharts — see disposition above (benign "too-new" heuristic trigger on a routine patch release, not a hallucination/slopsquat signal). Planner should insert one `checkpoint:human-verify` task immediately before the `npm install recharts` step.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────── WRITE PATH (already exists, Phases 4-6) ───────────────────────────────┐
│                                                                                                          │
│  SendGrid Webhook ──▶ webhook-events.worker.ts ──▶ sends (fact columns) + campaigns (counters)          │
│                                        │                                                                │
│                                        └────────────▶ [NEW] increment workspace_daily_rollup /           │
│                                                         flow_node_daily_rollup (same transaction)         │
│                                                                                                          │
│  Flow engine (flow-run-advance.worker.ts) ──▶ flow_run_steps (node-visit log)                           │
│                                        │                                                                │
│                                        └────────────▶ [NEW] increment flow_node_daily_rollup             │
│                                                                                                          │
│  contact.repository.ts / contacts-core upsert /                                                         │
│  unsubscribe.routes.ts / webhook applySuppression+applyUnsubscribe                                      │
│                                        │                                                                │
│                                        └────────────▶ [NEW] insert subscription_status_history row        │
│                                                         whenever subscription_status actually changes    │
│                                                                                                          │
│  [NEW] BullMQ repeatable reconciliation job (mirrors campaign-scheduler.worker.ts's 60s tick pattern)   │
│    every N minutes: re-derive rollups for last ~2 days from sends/flow_run_steps, UPSERT to correct     │
│    any missed increment (crash-safe, idempotent by construction)                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
┌─────────────────────────────── READ PATH (this phase's UI, 07-02..07-05) ─────────────────────────────┐
│                                                                                                          │
│  CampaignDetailPage (D-04)     ──▶ GET /campaigns/:id        ──▶ campaigns row (existing counters)      │
│                                                                    + derived rates (D-01) + excluded row │
│                                                                                                          │
│  FlowDetailPage "Аналитика" tab ──▶ GET /flows/:id/analytics ──▶ flow_node_daily_rollup GROUP BY node_id │
│  FlowCanvas node badges (D-03)  ──▶ (same response, keyed by nodeId, overlaid on existing NodeShell)     │
│                                                                                                          │
│  ContactDetailPage timeline (D-10) ──▶ GET /contacts/:id/timeline                                       │
│                                          ──▶ UNION ALL: events + sends(+send_events collapse, D-11)      │
│                                              + subscription_status_history + flow_runs (enter/exit)      │
│                                                                                                          │
│  WorkspaceHome→Дашборд (D-08a)  ──▶ GET /workspaces/:slug/dashboard?period=7|30|90                       │
│                                          ──▶ workspace_daily_rollup (trend charts, KPI cards)             │
│                                              + campaigns/flows mini-lists (existing tables, no rollup)   │
│                                                                                                          │
│  Журнал отправок / Send Log (D-13) ──▶ GET /workspaces/:slug/send-log?contact=&campaignOrFlow=&status=& │
│                                          period=  ──▶ sends JOIN contacts/campaigns/flows (no rollup —   │
│                                          row-level detail, not an aggregate view)                        │
│  Send Log row drawer (D-14)     ──▶ GET /send-log/:sendId/events ──▶ send_events WHERE send_id=...      │
│                                                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
packages/db/src/schema/
├── subscription-status-history.ts   # NEW (D-09) -- plain table, mirrors flow-run-steps.ts's shape
├── workspace-daily-rollup.ts        # NEW (07-01) -- one row per (workspace_id, day)
└── flow-node-daily-rollup.ts        # NEW (07-01) -- one row per (workspace_id, flow_id, node_id, day)

packages/db/migrations/
└── 00XX_analytics_rollups.sql       # drizzle-kit generate output + hand-appended RLS block (mirrors 0026_flows.sql's pattern)

apps/api/src/modules/analytics/       # NEW module
├── analytics.routes.ts               # GET dashboard, GET flow analytics, GET contact timeline
├── rollup.repository.ts              # read queries against the two new rollup tables
└── timeline.repository.ts            # the UNION ALL contact-timeline query

apps/api/src/modules/send-log/        # NEW module (or extend delivery/ module)
└── send-log.routes.ts                # GET send-log list (filters) + GET :sendId/events (drawer)

apps/worker/src/queues/
├── analytics-rollup.worker.ts        # NEW -- increments called from webhook-events.worker.ts /
│                                       flow-run-advance.worker.ts's existing transactions
└── analytics-reconciliation.worker.ts # NEW -- repeatable job, mirrors campaign-scheduler.worker.ts

apps/web/src/features/
├── dashboard/                        # NEW -- replaces workspace-home/WorkspaceHome.tsx as index route
│   ├── WorkspaceDashboard.tsx
│   ├── TrendChart.tsx                 # Recharts line/area chart
│   └── GrowthChart.tsx
├── send-log/                         # NEW
│   ├── SendLogPage.tsx
│   └── SendLogRowDrawer.tsx
├── contacts/
│   └── ContactEventFeed.tsx          # EVOLVES into unified timeline (D-10) -- same file, expanded query
├── campaigns/
│   └── CampaignProgress.tsx          # EXTENDED with rate %, excluded row (D-01/D-07) -- same file
└── flows/
    ├── canvas/nodeTypes.tsx          # EXTENDED -- NodeShell gains an optional metric-badge prop (D-03)
    └── detail/FlowAnalyticsTable.tsx # NEW -- fourth FlowDetailPage tab (D-03's table half)
```

### Pattern 1: Same-transaction incremental rollup increment

**What:** Every place that already writes a delivery fact or counter (webhook-events worker's `setFactColumnOnce`/`incrementCampaignCounter`, flow-run-advance's step-completion write) also performs an `INSERT ... ON CONFLICT (workspace_id, day, ...) DO UPDATE SET count = count + 1` against the new rollup table, inside the *same* `withTenantTransaction` block.

**When to use:** For 07-01's incremental half. This is the same idempotency shape already proven in this codebase (`setFactColumnOnce`'s `WHERE column IS NULL` pattern) — the rollup increment should only fire when the *fact write itself* just-set (i.e., gated on the same `justSet` boolean the webhook worker already computes), never on a replayed/no-op event.

**Example:**
```typescript
// Source: this codebase's own webhook-events.worker.ts (existing pattern, Phase 5)
// The pattern to extend for 07-01: rollup increment gated on the SAME
// `justSet` flag that already gates campaign-counter increments.
case "delivered": {
  const justSet = await setFactColumnOnce(client, send.id, "delivered_at", event.occurredAt);
  if (justSet) {
    if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "delivered_count");
    // NEW (07-01): same-transaction rollup increment, same idempotency guarantee
    await incrementWorkspaceDailyRollup(client, workspaceId, event.occurredAt, "delivered");
  }
  break;
}
```

### Pattern 2: Repeatable reconciliation job (mirrors existing campaign-scheduler)

**What:** A BullMQ repeatable job, registered exactly like `createCampaignSchedulerWorker`'s `tickQueue.add(..., { repeat: { every: SCAN_INTERVAL_MS }, jobId: "..." })`, that re-derives rollup rows for a bounded recent window (e.g., last 2 days) directly from source tables (`sends`, `flow_run_steps`) via a fresh `GROUP BY`, and `UPSERT`s the result over the incrementally-maintained rows.

**When to use:** For 07-01's periodic-reconciliation half (ROADMAP's explicit requirement). This corrects any rollup drift from a crashed increment, a race, or a bug — without ever needing to trust the incremental path as the sole source of truth.

**Example:**
```typescript
// Source: this codebase's own campaign-scheduler.worker.ts (existing pattern, Phase 4)
// The reconciliation job for 07-01 follows the identical shape: a
// self-produced/self-consumed tick queue, idempotent registration via a
// fixed jobId, and a plain-tenant-scoped write per workspace discovered.
const tickQueue = new Queue(ANALYTICS_RECONCILE_QUEUE, { connection });
void tickQueue.add(
  "reconcile-rollups",
  {},
  { repeat: { every: RECONCILE_INTERVAL_MS }, jobId: "reconcile-rollups" }
);
```
Unlike the campaign scheduler (which needs a cross-tenant admin-scan RLS policy because it doesn't know which workspace a *due campaign* belongs to ahead of time), the reconciliation job can iterate known workspaces (`SELECT id FROM organization`) and re-enter `withTenant(workspaceId, ...)` per workspace for the actual `GROUP BY`/`UPSERT` — no new admin-scan RLS policy is needed here, since every read/write is already properly tenant-scoped once the workspace id is known.

### Pattern 3: Contact timeline as a UNION ALL, collapsed at read time (D-11)

**What:** `ContactEventFeed` evolves into a single query unioning `events`, `sends` (one row per message, joined to `send_events` only for the drawer/expansion, not the list), `subscription_status_history`, and `flow_runs` (entry/exit rows), each mapped to a common `{ type, occurredAt, ... }` shape, sorted by `occurredAt DESC`, paginated with the existing `page`/`pageSize` convention.

**When to use:** ANLT-03/D-10. The "collapse repeated opens/clicks into one row with a ×N counter" requirement (D-11) is satisfied for free by reading from `sends.first_opened_at`/`first_clicked_at` (already the *first* occurrence) for the timeline row itself, with the ×N count coming from a `SELECT count(*) FROM send_events WHERE send_id = ... AND event_type = 'open'` — either inlined as a subquery per send row, or (cheaper) precomputed as a `sends.open_count`/`click_count` pair maintained by the same webhook-worker increment path as Pattern 1 (recommended: add these two integer columns to `sends` in this phase, incremented on every open/click event — not just the first — since Phase 5 only tracked *first* open/click).

**Example:**
```sql
-- Illustrative UNION shape (source: architectural inference from this
-- codebase's existing table shapes, not a copied external snippet)
SELECT 'event' AS kind, occurred_at, name AS label, properties AS detail FROM events WHERE contact_id = $1
UNION ALL
SELECT 'send', sent_at, template_or_campaign_label, jsonb_build_object('status', status, ...) FROM sends WHERE contact_id = $1
UNION ALL
SELECT 'status_change', changed_at, old_status || ' → ' || new_status, jsonb_build_object('reason', reason) FROM subscription_status_history WHERE contact_id = $1
UNION ALL
SELECT 'flow_entry_exit', entered_at, 'Вошёл в цепочку', jsonb_build_object('exitedAt', exited_at, 'exitReason', exit_reason) FROM flow_runs WHERE contact_id = $1
ORDER BY occurred_at DESC
LIMIT $2 OFFSET $3;
```

### Anti-Patterns to Avoid

- **Recomputing rollups by scanning `sends`/`send_events`/`events` on every dashboard page load:** Explicitly rejected by D-08b. These are the fastest-growing, partitioned tables in the schema; a live `GROUP BY` over them on every request is the exact Pitfall #5 (segmentation-query-slowness) pattern applied to analytics instead of segments — same root cause, same fix (precomputed rollup table).
- **A single shared `subscription_status_history` write helper called optionally:** Because D-09 requires ALL four mutation call sites to write history, make the insert impossible to skip accidentally — e.g., a single exported `recordSubscriptionStatusChange(client, ...)` helper in `contacts-core` (or a new shared package) that every one of the four call sites imports and calls unconditionally whenever `nextStatus !== existing.subscriptionStatus`, rather than four independently-hand-written `INSERT` statements that can drift.
- **Building a second RLS admin-scan policy for the reconciliation worker:** Unlike `campaign-scheduler.worker.ts`'s genuine need for a cross-tenant discovery scan (it doesn't know which workspace a *due* campaign belongs to), the rollup-reconciliation job CAN enumerate `organization.id` directly (a small, non-sensitive, always-tenant-scoped list) and then re-enter `withTenant(id, ...)` normally per workspace — no new admin-scan RLS policy needed. Adding one anyway is unnecessary attack surface.
- **Tremor for charts:** React 19 peer-dependency incompatibility, confirmed above — not merely a "nice to avoid," an actual install-time failure risk.
- **Per-request open/click counts computed via ad-hoc `COUNT(*) FROM send_events` in the send-log drawer's hot path with no index:** `send_events` already has `idx_send_events_workspace_send (workspace_id, send_id)` (migration 0020) — the drawer's `WHERE send_id = $1` lookup is already covered; no new index needed for D-14, but this phase SHOULD add `sends.open_count`/`click_count` (see Pattern 3) so the send-log LIST view (not just the drawer) can show "×N" cheaply without a join-and-count per row.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Relative "X minutes ago" timestamps | Custom pluralization/relative-time logic | `Intl.RelativeTimeFormat("ru", { numeric: "auto" })` | Already the established pattern in this exact codebase (`ContactEventFeed.tsx`'s `relativeTime` helper) — reuse it verbatim for the timeline and send-log rows rather than reintroducing a parallel implementation. |
| Russian plural forms for chart axis labels / counts ("1 день" / "2 дня" / "5 дней") | Ad-hoc if/else plural branching | The existing `pluralRu` helper in `flows/canvas/nodeTypes.tsx` | Already solved once in this codebase for exactly this class of problem (day/hour/minute Russian pluralization) — extract to a shared util if reused across dashboard + flow canvas, rather than re-deriving the mod-10/mod-100 rule a third time. |
| Percent-rate math (open rate, click rate, delivery rate) | Inline `Math.round((x/y)*100)` scattered across components | One small shared `computeRate(numerator, denominator)` helper (returns `null` when denominator is 0, never `NaN`/`Infinity`) | D-01 fixes the denominator per metric (delivered for open/click, sent for delivery/bounce) — a single shared helper prevents a future edit from silently changing one denominator without the others, and centralizes the "0 delivered ⇒ show — not NaN%" edge case across campaign summary, flow analytics tab, and node badges. |
| Chart color/palette decisions | Hand-picked hex values per chart | The project's existing Tailwind/shadcn CSS variables (`--primary`, `--muted-foreground`, etc.) already used by `Progress`/`Badge` components | Keeps dashboard charts visually consistent with the rest of the app's existing design tokens rather than introducing a second, chart-specific color system. |

**Key insight:** Almost nothing in this phase needs a new algorithm — the hard problems (idempotent counting, tenant isolation, partition-safe writes) were already solved in Phases 4-6 for the *source* tables. This phase's job is disciplined reuse of those exact patterns for two new small aggregate tables and one new small history table, not new architecture.

## Runtime State Inventory

Not applicable — this is a purely additive/greenfield phase (new tables, new routes, new UI surfaces), not a rename/refactor/migration of existing state. No existing runtime state (stored data, live service config, OS-registered state, secrets, build artifacts) needs to change identity or be migrated as part of this phase.

## Common Pitfalls

### Pitfall 1: Rollup increment fires on a replayed/duplicate webhook event

**What goes wrong:** A redelivered SendGrid webhook batch (already deduped at the `send_events` insert level via `ON CONFLICT ... DO NOTHING`) still causes a *second* rollup increment if the increment call isn't gated on the same "this event was genuinely new" check the counter-increment logic already uses.

**Why it happens:** The rollup increment is new code being added into an existing function; it's easy to place the `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` call in the wrong place (e.g., inside the per-row loop unconditionally) rather than inside the `if (justSet)` branch that already gates the campaign counter increment.

**How to avoid:** Always increment the rollup inside the exact same `if (justSet)` (or equivalent) block that gates the existing `incrementCampaignCounter` call — never as an independent check. Add a test mirroring the existing `webhook-events-idempotency.test.ts` that replays a duplicate batch and asserts the rollup count did NOT double.

**Warning signs:** Dashboard trend numbers exceed the corresponding `campaigns.delivered_count`/`opened_count` totals for the same period.

### Pitfall 2: Reconciliation job double-counts instead of correcting

**What goes wrong:** A naive reconciliation implementation `INSERT`s freshly-computed counts alongside the incrementally-maintained row instead of replacing/overwriting it, so a workspace's daily rollup count grows unboundedly every reconciliation tick.

**Why it happens:** "Reconciliation" is conceptually a re-derivation from source of truth, but if implemented as another `+1` increment rather than a `SET count = <freshly computed count>` (an idempotent overwrite, not an increment), it silently compounds.

**How to avoid:** The reconciliation job's `UPSERT` must be `ON CONFLICT (...) DO UPDATE SET count = EXCLUDED.count` (an absolute overwrite from a fresh `COUNT(*)`/`SUM(...)` over the source table for that bucket), never `DO UPDATE SET count = rollup.count + EXCLUDED.count`. This is the single most important correctness property of the whole 07-01 design and should be the first thing verified in that plan's tests.

**Warning signs:** Dashboard numbers grow every few minutes even with zero new sends.

### Pitfall 3: subscription_status_history missed at one of the four write sites

**What goes wrong:** D-09 requires history at ALL four mutation points (`contact.repository.ts` create/update, `contacts-core`'s shared `upsertContactByIdentity`, `unsubscribe.routes.ts`, and `webhook-events.worker.ts`'s `applySuppression`/`applyUnsubscribe`) — if even one is missed, the contact timeline silently has gaps for status changes originating from that path (e.g., CSV-import-driven suppression changes never show up, since CSV import goes through `upsertContactByIdentity`).

**Why it happens:** These four call sites live in three different packages/apps (`apps/api`, `packages/contacts-core`, `apps/worker`) with no single chokepoint enforcing the write — easy to implement history-writing in the most obvious call site (the API route) and forget the others.

**How to avoid:** Grep for every `subscription_status = ` / `subscriptionStatus =` assignment across the codebase (this research found exactly 4 files: `apps/api/src/modules/contacts/contact.repository.ts`, `packages/contacts-core/src/contact-repository.ts`, `apps/api/src/modules/delivery/unsubscribe.routes.ts`, `apps/worker/src/queues/webhook-events.worker.ts`) before considering 07's status-history plan complete, and add one integration test per call site asserting a history row was written.

**Warning signs:** A contact's timeline shows a subscription-status badge change (via `SubscriptionStatusBadge`) with no corresponding history entry for the same transition.

### Pitfall 4: Per-step metrics double-count contacts revisiting the same node

**What goes wrong:** `flow_run_steps` is append-only and a contact CAN pass through the same node multiple times in different flow runs (or, for loopable branch/delay patterns within a single run, though FLOW-06/07's cycle-detection at publish time should prevent true infinite loops within one run). If per-step "count of contacts that passed" (D-02) is computed as `COUNT(*)` rather than `COUNT(DISTINCT flow_run_id)` or `COUNT(DISTINCT contact_id)`, a single contact's flow re-entry inflates the "how many people reached this node" number.

**Why it happens:** `flow_run_steps` intentionally has no uniqueness constraint (it's an audit log of every visit, by design) — the aggregation query has to explicitly choose the right grain.

**How to avoid:** Decide explicitly (and document in the plan) whether per-step metrics count *runs* (`COUNT(DISTINCT flow_run_id)`, matching "how many times did contacts pass through this node," including re-entries) or *unique contacts* (`COUNT(DISTINCT contact_id)`, "how many distinct people"). D-02's phrasing ("количество прошедших контактов") suggests unique-contact counting is the intended semantic — flag this as an explicit decision point for the planner rather than letting the aggregation query default to a raw row count.

**Warning signs:** Per-step node badge counts exceed the flow's total enrolled-contact count.

### Pitfall 5: Tenant context missing inside the new rollup worker's transaction

**What goes wrong:** (Carried forward from PITFALLS.md #8, called out explicitly in CONTEXT.md's Claude's Discretion section.) A new worker function that writes to `workspace_daily_rollup`/`flow_node_daily_rollup` forgets to run inside `withTenant(workspaceId, () => withTenantTransaction(...))` — either because it's a genuinely new code path not copy-pasted from an existing tenant-scoped function, or because the reconciliation job's cross-workspace loop reuses a single connection/transaction across multiple workspaces without resetting the GUC between them.

**How to avoid:** Every rollup write (increment or reconciliation-overwrite) must be its own `withTenant(workspaceId, ...)` call, never sharing a transaction across two different workspace ids. The reconciliation job's per-workspace loop should call `withTenant` fresh for each workspace id in its list, exactly like `campaign-scheduler.worker.ts`'s `transitionToSending` does per campaign row (never batching multiple workspaces' writes into one transaction).

**Warning signs:** A pooling-failure/chaos test (per PITFALLS.md's "Looks Done But Isn't" checklist) reveals one workspace's rollup row was written under another workspace's tenant context.

## Code Examples

### Same-transaction rollup increment (extends existing webhook worker)
```typescript
// Source: pattern derived from this codebase's own
// apps/worker/src/queues/webhook-events.worker.ts (setFactColumnOnce /
// incrementCampaignCounter, Phase 5) -- illustrative extension for 07-01,
// not a verbatim external reference.
async function incrementWorkspaceDailyRollup(
  client: PoolClient,
  workspaceId: string,
  occurredAt: string,
  metric: "sent" | "delivered" | "opened" | "clicked" | "bounced" | "unsubscribed"
): Promise<void> {
  const day = occurredAt.slice(0, 10); // YYYY-MM-DD, UTC bucket
  await client.query(
    `INSERT INTO workspace_daily_rollup (workspace_id, day, ${metric}_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (workspace_id, day)
     DO UPDATE SET ${metric}_count = workspace_daily_rollup.${metric}_count + 1`,
    [workspaceId, day]
  );
}
```

### Reconciliation overwrite (never additive)
```typescript
// Source: illustrative -- correctness property described in Pitfall 2 above.
async function reconcileWorkspaceDay(client: PoolClient, workspaceId: string, day: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_daily_rollup (workspace_id, day, sent_count, delivered_count, opened_count, clicked_count, bounced_count, unsubscribed_count)
     SELECT $1, $2,
       count(*) FILTER (WHERE sent_at IS NOT NULL AND sent_at::date = $2::date),
       count(*) FILTER (WHERE delivered_at IS NOT NULL AND delivered_at::date = $2::date),
       count(*) FILTER (WHERE first_opened_at IS NOT NULL AND first_opened_at::date = $2::date),
       count(*) FILTER (WHERE first_clicked_at IS NOT NULL AND first_clicked_at::date = $2::date),
       count(*) FILTER (WHERE bounced_at IS NOT NULL AND bounced_at::date = $2::date),
       count(*) FILTER (WHERE unsubscribed_at IS NOT NULL AND unsubscribed_at::date = $2::date)
     FROM sends WHERE workspace_id = $1
     ON CONFLICT (workspace_id, day) DO UPDATE SET
       sent_count = EXCLUDED.sent_count,
       delivered_count = EXCLUDED.delivered_count,
       opened_count = EXCLUDED.opened_count,
       clicked_count = EXCLUDED.clicked_count,
       bounced_count = EXCLUDED.bounced_count,
       unsubscribed_count = EXCLUDED.unsubscribed_count`,
    [workspaceId, day]
  );
}
```

### Contact growth calculation (Claude's Discretion item resolved)
For "рост базы контактов" / "новые контакты за период" (D-08's growth chart + KPI), recommend **`contacts.created_at` grouped by day**, not a separate daily-snapshot table:
```sql
-- New contacts per day (source: contacts.created_at already exists, Phase 2)
SELECT created_at::date AS day, count(*) AS new_contacts
FROM contacts
WHERE workspace_id = $1 AND created_at >= now() - ($2 || ' days')::interval
GROUP BY created_at::date
ORDER BY day;
```
`[ASSUMED — recommendation, not a locked decision]` Rationale: `contacts.created_at` is already indexed implicitly via the table's natural growth pattern and requires zero new write path (a daily-snapshot table would need its own incremental-write job for a metric that's a trivial `GROUP BY` over an existing immutable timestamp column). "Total base size at day X" (if needed for the growth *trend line*, not just "new contacts" KPI) is a cumulative `SUM() OVER (ORDER BY day)` of the same daily-new-contacts query, or — if unsubscribes/suppressions should reduce the visible "active base" line — a similar rollup counting `subscription_status_history` transitions away from `subscribed`. Flag this exact semantic (does "growth" mean raw signups, or net-of-unsubscribes active base?) as an **Open Question** for the planner/UI-SPEC to resolve with the user, since D-08 doesn't specify which.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `reactflow` (npm package) | `@xyflow/react` | Already resolved in this codebase (Phase 6, 06-10) | Not relevant to this phase directly, but confirms the project's existing "verify current package name before installing" discipline — applied here to Recharts vs Tremor. |
| Tremor v2 (React 18-only) | Tremor v3 branch reportedly targets React 19 per some community discussion, but the currently-published `@tremor/react` registry version (3.18.7) still declares `^18.0.0` only | Not yet shipped to the npm registry as of this research (verified via `npm view`) | Do not plan around an unreleased future Tremor version — the installable-today reality is the `^18.0.0` cap. |

**Deprecated/outdated:** None specific to this phase beyond the Tremor/React-19 mismatch already covered above.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | No new date-math library (date-fns etc.) is needed; native `Date`/`Intl` suffice for 7/30/90-day period presets and daily bucket labels | Standard Stack § Supporting | Low — if timezone-aware bucketing across contact timezones turns out to be required for the dashboard (unlikely; D-08b's dashboard is workspace-wide, not per-contact-timezone), the planner may need to add `date-fns`/`date-fns-tz` mid-phase. Easy to add later; no architectural lock-in either way. |
| A2 | "Рост базы контактов" (D-08) should be computed from `contacts.created_at` (raw signups per day), not a separate daily-snapshot table, and cumulative "active base" is a secondary/open question rather than the primary requirement | Code Examples § Contact growth calculation | Medium — if the user actually wants a cumulative "active subscribed base over time" line (net of unsubscribes/suppressions) as the PRIMARY growth metric rather than "new contacts per day," the read query changes (needs `subscription_status_history` join) though the write-side (no new snapshot table) recommendation still holds. Flagged as an Open Question below — confirm with user/UI-SPEC before locking the dashboard's growth-chart semantics. |
| A3 | Per-step metric "count of contacts passed" (D-02) means unique contacts (`COUNT(DISTINCT contact_id)`), not raw visit count or run count | Common Pitfalls § Pitfall 4 | Medium — if the intended semantic is actually "number of times this node was executed" (including re-entries), the aggregation grouping changes from `contact_id` to `flow_run_id` or a raw count. Should be confirmed with the user during planning/UI-SPEC, not assumed silently in the plan. |
| A4 | `sends` gains new `open_count`/`click_count` integer columns (incremented on every open/click event, not just the first) to cheaply back D-11's "×N" collapse in both the timeline AND the send-log list view | Architecture Patterns § Pattern 3 | Low-Medium — this is a schema addition beyond what Phase 5 built (which only tracks first_opened_at/first_clicked_at). If the planner instead computes ×N via a per-row subquery against `send_events` at read time, it still works functionally but is materially more expensive at send-log-list scale (N subqueries per page) versus O(1) column reads. Recommend the column addition, but it is this phase's call to make, not a locked user decision. |

## Open Questions

1. **Does "рост базы контактов" (D-08) mean raw new-contact signups per day, or net active-subscribed-base over time?**
   - What we know: D-08 lists it alongside "новые контакты" as a separate KPI, implying the growth *chart* might be the raw signup trend while "новые контакты" is the KPI-card number for the same underlying metric — these could be the same data rendered two ways, OR the chart could be a cumulative "total contacts" line.
   - What's unclear: Whether unsubscribes/suppressions should visually reduce the growth line (i.e., is it "total contacts" or "net-subscribed contacts"?).
   - Recommendation: Default to the simplest, most defensible interpretation — a cumulative count of all contacts ever created (raw signups, `SUM() OVER` of daily `contacts.created_at` counts) for the growth *chart*, with "новые контакты" as the KPI card showing the period's new-contact count. Confirm this reading with the user during `/gsd-ui-phase` if the UI-SPEC surfaces ambiguity.

2. **Does D-02's "количество прошедших контактов" per node count unique contacts or total visits/runs?**
   - What we know: `flow_run_steps` is append-only with no dedup; a contact re-entering a flow (per FLOW-04's re-entry modes) creates a second set of node-visit rows.
   - What's unclear: Whether the marketer wants "how many distinct people reached this node" (unique-contact semantics, more intuitive for "which step underperforms" analysis) or "how many times this node fired" (raw execution count, useful for volume/cost reasoning).
   - Recommendation: Default to `COUNT(DISTINCT contact_id)` per node (unique-contact semantics) as the primary displayed number — it more directly answers "which step underperforms" (D-02's stated goal), matching how Klaviyo's own per-step analytics are described in this project's own CONTEXT.md reference. Confirm during planning if ambiguous.

3. **Should `sends` gain `open_count`/`click_count` columns in this phase, or is a read-time subquery against `send_events` acceptable for v1?**
   - What we know: Phase 5 only tracks `first_opened_at`/`first_clicked_at` (unique-recipient semantics for campaign counters, per Phase 5 D-09). D-11 needs a "×N" repeat count for both the contact timeline AND (implicitly, for consistency) the send-log list.
   - What's unclear: Whether a per-row subquery's cost is acceptable at the send-log list's expected page sizes (20-50 rows/page — a subquery per row is cheap at that count) versus the schema-simplicity cost of adding two more columns to an already-wide `sends` table.
   - Recommendation: Add the two columns (Assumption A4) — the increment is a one-line addition to the existing webhook-worker `open`/`click` case branches (which already run on every open/click event, only gated differently for the counter-increment side), and it keeps both the drawer and the list view O(1) per row instead of introducing a second, subtly-different query pattern for what should be the same underlying number.

## Environment Availability

Not applicable — this phase has no new external tool/service dependencies. It reuses the project's existing Postgres, Redis/BullMQ, and Node.js runtime, all already verified available and in use since Phase 1-2. The one new npm dependency (Recharts) is a plain client-side library with no runtime/service dependency of its own.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 (already configured in `apps/api`, `apps/worker`, `apps/web`) |
| Config file | `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, `apps/web/vitest.config.ts` (all pre-existing) |
| Quick run command | `npm run test -w apps/api` / `-w apps/worker` / `-w apps/web` |
| Full suite command | `npm run test` (root script runs all workspaces) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ANLT-01 | Campaign rate percentages compute correctly (D-01: correct denominator per metric, 0-denominator returns null not NaN) | unit | `npx vitest run apps/api/src/modules/analytics/__tests__/campaign-rates.test.ts` | ❌ Wave 0 |
| ANLT-01 | Excluded-count row with reason breakdown appears and excludes from rate denominators (D-07) | integration | `npx vitest run apps/api/src/modules/campaigns/__tests__/campaign-excluded-summary.test.ts` | ❌ Wave 0 |
| ANLT-02 | Per-node visit counts aggregate correctly across flow versions by nodeId (D-05), unique-contact semantics (Open Question 2) | integration | `npx vitest run apps/api/src/modules/analytics/__tests__/flow-node-analytics.test.ts` | ❌ Wave 0 |
| ANLT-03 | Timeline UNION query returns correctly-typed/sorted rows across all 4 sources, repeated opens/clicks collapse to ×N (D-11) | integration | `npx vitest run apps/api/src/modules/analytics/__tests__/contact-timeline.test.ts` | ❌ Wave 0 |
| ANLT-03 | subscription_status_history row written at all 4 mutation call sites (D-09, Pitfall 3) | integration | `npx vitest run apps/api/src/modules/contacts/__tests__/subscription-status-history.test.ts` | ❌ Wave 0 |
| ANLT-04 | Rollup increment is idempotent against replayed webhook batch (Pitfall 1) | integration | `npx vitest run apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts` | ❌ Wave 0 |
| ANLT-04 | Reconciliation job overwrites (not adds to) existing rollup rows (Pitfall 2, the phase's single most important correctness property) | integration | `npx vitest run apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts` | ❌ Wave 0 |
| ANLT-04 | Dashboard tenant isolation — rollup write inside its own `withTenant` per workspace, never a shared cross-workspace transaction (Pitfall 5) | integration | `npx vitest run apps/worker/src/queues/__tests__/analytics-rollup-tenant-isolation.test.ts` | ❌ Wave 0 |
| ANLT-05 | Send log filters (contact/campaign-or-flow/status/period) compile to correct SQL, multi-select status includes failed/excluded (D-15) | integration | `npx vitest run apps/api/src/modules/send-log/__tests__/send-log-filters.test.ts` | ❌ Wave 0 |
| ANLT-05 | Drawer's per-message event history reads `send_events` scoped to workspace+send_id (D-14) | integration | `npx vitest run apps/api/src/modules/send-log/__tests__/send-log-drawer.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run test -w <affected-workspace>`
- **Per wave merge:** `npm run test` (full monorepo suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/api/src/modules/analytics/__tests__/` directory — new module, no existing test scaffolding
- [ ] `apps/worker/src/queues/__tests__/analytics-*.test.ts` — new rollup/reconciliation worker tests; reuse existing `db-fixture.ts` real-Postgres integration harness (already established in `packages/delivery-core`/`apps/worker` per 04-10/06-12 decisions)
- [ ] `apps/api/src/modules/send-log/__tests__/` directory — new module
- [ ] No new test framework/config needed — Vitest is already fully wired across all three workspaces

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No (new) | Reuses existing better-auth session/JWT — no new auth surface introduced by this phase. |
| V3 Session Management | No (new) | Same as above. |
| V4 Access Control | Yes | Analytics/dashboard/send-log routes are readable by all workspace roles including Member (per CONTEXT.md's discretion note — no evidence found in this codebase's existing role model, `packages/auth`/`requirePermission`, that analytics should be more restricted than the underlying campaign/flow/contact data those roles can already read). No new mutating-by-Member surface is introduced (subscription-status-history writes happen only via existing authenticated mutation paths, not a new user-facing analytics-write endpoint). |
| V5 Input Validation | Yes | Send-log/timeline/dashboard query params (period preset, status multi-select, contact/campaign/flow id filters) must be validated via `zod` schemas in `packages/shared-schemas`, matching every existing list endpoint's `*ListQuerySchema` convention (`segmentListQuerySchema`, `campaignListQuerySchema`, `flowRunListQuerySchema`). |
| V6 Cryptography | No (new) | No new secrets/keys introduced by this phase. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Cross-tenant data leak via the new rollup tables or subscription_status_history missing RLS | Information Disclosure | `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + NULLIF-guarded `workspace_isolation` policy on both new tables, mirroring every other tenant-scoped table since Phase 1 (0026_flows.sql's `flow_run_steps`/`flow_segment_membership_snapshot` policies are the most recent, directly analogous precedent). |
| Cross-tenant leak via the reconciliation worker's cross-workspace loop (Pitfall 5) | Information Disclosure / Tampering | Fresh `withTenant(workspaceId, ...)` per workspace inside the loop, never a shared transaction/connection carrying stale GUC state across workspaces — same mitigation class as PITFALLS.md #8. |
| SQL injection via send-log filter parameters (contact/campaign/status/period passed into dynamic `WHERE` clause construction) | Tampering | Parameterized queries only (`$1`, `$2`, ...), matching every existing filterable-list repository in this codebase (`contact.repository.ts`'s D-13 filter-compilation code) — never string-interpolate a filter value into SQL. |
| Enumeration of another workspace's send/contact/campaign ids via the send-log drawer or contact-timeline endpoint (IDOR) | Information Disclosure | Every new route must scope by `workspace_id` via RLS (ambient tenant context) AND, where the codebase's own precedent already double-checks (e.g., `listContactEvents`'s explicit `getContact(id)` 404 check alongside RLS, per Phase 2 T-02-08-01), consider the same double-gate for `send-log/:sendId/events` — a `sendId` that exists but belongs to another workspace should 404, not silently return zero rows in a way that lets an attacker distinguish "doesn't exist" from "exists in another tenant." |

## Sources

### Primary (HIGH confidence)
- This codebase itself — `packages/db/src/schema/{sends,send-events,flow-run-steps,flow-runs,campaigns,events,contacts}.ts`, `apps/worker/src/queues/{webhook-events,campaign-scheduler}.worker.ts`, `packages/db/migrations/{0018,0019,0020,0026}*.sql`, `apps/web/src/features/{contacts/ContactEventFeed.tsx,campaigns/CampaignProgress.tsx,flows/canvas/nodeTypes.tsx,flows/detail/FlowDetailPage.tsx,app-shell/AppShell.tsx}` — direct inspection this session.
- `npm view recharts version` / `peerDependencies` / `time.modified` — npm registry, verified this session (2026-07-14).
- `npm view @tremor/react version` / `peerDependencies` / `time.modified` — npm registry, verified this session (2026-07-14).
- `gsd-tools query package-legitimacy check --ecosystem npm recharts` — seam tool output, verified this session.

### Secondary (MEDIUM confidence)
- [Recharts v3 vs Tremor vs Nivo: React Charts 2026 — PkgPulse Guides](https://www.pkgpulse.com/guides/recharts-v3-vs-tremor-vs-nivo-react-charting-2026) — cross-checked against npm registry's own download/peer-dependency data.
- [tremor/react vs chart.js vs d3 vs echarts vs plotly.js vs recharts — npmtrends](https://npmtrends.com/@tremor/react-vs-chart.js-vs-d3-vs-echarts-vs-plotly.js-vs-recharts) — download-count cross-check.
- [Scalable incremental data aggregation on Postgres and Citus — Citus Data](https://www.citusdata.com/blog/2018/06/14/scalable-incremental-data-aggregation/) — informed the incremental+reconciliation rollup design pattern.
- [Cumulative Data Without the Pain: PostgreSQL Rollups with Time Buckets — DEV Community](https://dev.to/kushpranjale/cumulative-data-without-the-pain-postgresql-rollups-with-time-buckets-43b9) — general rollup-table column design guidance.
- [PostgreSQL Keyset Pagination vs Offset: Cursor-Based Guide — Stacksync](https://www.stacksync.com/blog/keyset-cursors-postgres-pagination-fast-accurate-scalable) — informed the pagination-approach comparison (Alternatives Considered).
- [Keyset Cursors, Not Offsets, for Postgres Pagination — Sequin](https://blog.sequinstream.com/keyset-cursors-not-offsets-for-postgres-pagination/) — same.

### Tertiary (LOW confidence)
- None — every claim not directly verified against this codebase or the npm registry this session is explicitly tagged `[ASSUMED]` in the Assumptions Log above, rather than presented as fact.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — Recharts choice is directly verified against the npm registry (version, peer deps, download count) and resolved by a hard React-19-incompatibility fact for the alternative, not a subjective preference.
- Architecture: HIGH — every pattern recommended here is a direct extension of an already-implemented, already-tested pattern in this exact codebase (incremental counters, repeatable BullMQ jobs, RLS+NULLIF table setup, tenant-scoped transactions), not a novel architecture requiring external validation.
- Pitfalls: MEDIUM-HIGH — Pitfalls 1, 3, 5 are directly derived from this codebase's own existing code and prior PITFALLS.md research; Pitfalls 2 and 4 are inferred from general rollup/analytics-aggregation reasoning and flagged with explicit "how to avoid" tests the planner should write.

**Research date:** 2026-07-14
**Valid until:** 2026-08-13 (30 days — stable domain; the only fast-moving fact checked, Recharts' latest patch version, should be re-verified with `npm view recharts version` at actual implementation time regardless of this date).
