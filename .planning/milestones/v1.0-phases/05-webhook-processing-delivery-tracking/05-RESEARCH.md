# Phase 5: Webhook Processing & Delivery Tracking - Research

**Researched:** 2026-07-08
**Domain:** SendGrid Event Webhook ingestion, per-tenant signature verification, delivery-status/suppression state machine
**Confidence:** MEDIUM-HIGH (SendGrid API shapes and ECDSA verification: HIGH, official Twilio/SendGrid docs directly fetched this session; queue/data-model design: MEDIUM, synthesized against this repo's own established Phase 2/4 patterns)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Подключение webhook у тенанта**
- **D-01:** Автонастройка через SendGrid API: при подключённом ключе платформа сама создаёт/обновляет Event Webhook тенантским ключом, включает подписанные события и сама забирает публичный ключ верификации. Ручная инструкция — НЕ основной путь.
- **D-02:** Автонастройка срабатывает автоматически при подключении/смене SendGrid-ключа. Для уже подключённых воркспейсов — кнопка/баннер «Включить отслеживание доставки» в настройках SendGrid-интеграции + пункт в онбординг-чеклисте (Phase 1 D-23).
- **D-03:** Здоровье webhook видно тенанту: индикатор «подключено / не подключено» + «последнее событие получено N назад» + кнопка «Переподключить». Расширенная диагностика (счётчики отклонённых подписей и т.п.) — Phase 7.
- **D-04:** Open/click tracking форсируется пер-письмо: tracking_settings (open + click on) передаются в каждом mail/send — не зависим от настроек аккаунта тенанта. Аналогично отключению subscription tracking (Phase 4 D-15).
- **D-05:** Платформа создаёт СВОЙ отдельный именованный Event Webhook (friendly name), хранит его id и обновляет только его. Существующие webhook'и тенанта не трогаем — его интеграции продолжают работать.

**Модель статуса письма**
- **D-06:** В `sends` добавляются колонки-факты: delivered_at, first_opened_at, first_clicked_at, bounced_at, dropped_at, unsubscribed_at, spam_reported_at (+ причина bounce/drop). «Текущий статус» для UI вычисляется по приоритету: bounced/dropped/spam терминальны > clicked > opened > delivered > sent. Out-of-order события безопасны — факты не перезаписывают друг друга (PITFALLS #3).
- **D-07:** UI этой фазы — счётчики delivered/opened/clicked/bounced (не доставлено)/unsubscribed в уже существующей сводке кампании (Phase 4). Детальный по-письмовый лог с фильтрами — Phase 7, здесь его НЕ строим.
- **D-08:** dropped — отдельный терминальный исход (dropped_at + причина), в счётчиках группируется с bounced в «не доставлено», но причина различима в данных.
- **D-09:** Счётчики opened/clicked в сводке — уникальные получатели (по first_opened_at/first_clicked_at). Повторные открытия/клики — в сырых событиях для Phase 7.

**Правила suppression (SUBS-02)**
- **D-10:** Hard bounce → subscription_status = suppressed сразу. Soft bounce/block → suppressed после 3 подряд неудач (N=3 — платформенная константа, без настройки); успешная доставка сбрасывает счётчик подряд-ошибок. Выбор пользователя: эскалация soft bounce нужна в v1, не отложена.
- **D-11:** spam report → suppressed. unsubscribe / group_unsubscribe → unsubscribed.
- **D-12:** dropped переводит контакт по причине: Bounced Address / Spam Reporting Address / Invalid → suppressed; Unsubscribed Address → unsubscribed; технические причины (например, доставка невозможна по иным причинам) маппятся по смыслу, без смены статуса, если причина не про адрес.
- **D-13:** Webhook-suppression пишет ОДНОВРЕМЕННО subscription_status = suppressed И email в workspace_suppressions с причиной (hard_bounce / spam_report / soft_bounce_streak / dropped_*). Гарантия D-08 (Phase 2) становится немедленной: удаление + реимпорт не воскрешает «мёртвый» адрес. Unsubscribe → только статус (как one-click из Phase 4 D-15).

**Хранение сырых событий**
- **D-14:** Каждое webhook-событие — строка в новой таблице доставочных событий: sg_event_id UNIQUE (это и есть механизм дедупа WBHK-03), ссылка на send, тип события, timestamp события, полезные поля payload (причина bounce, URL клика и т.п.). Таблица partition-ready по времени — паттерн events из Phase 2 / CLAUDE.md.
- **D-15:** Матчинг по маркеру платформы: при отправке платформа кладёт custom_args (send_id, workspace_id) в каждое письмо — SendGrid возвращает их в каждом событии. События БЕЗ нашего маркера (письма тенанта мимо платформы) — подтверждаем (2xx) и отбрасываем, не храним и не суппрессим. Маркированные события без живого send (send удалён) — храним как есть. Тестовые письма (Phase 4 D-12) маркируем признаком test и отбрасываем из статистики и suppression.
- **D-16:** Retention — бессрочно в v1; партиции по месяцам с первого дня; политика удаления старых партиций — отложенное решение (v2/ops).

### Claude's Discretion
- Формат per-tenant webhook URL (path-токен воркспейса), его криптографическая непредсказуемость; хранение public verification key (шифровать ли как SendGrid-ключи — по паттерну Phase 1).
- Схема очереди обработки: одна очередь webhook-событий vs переиспользование существующей инфраструктуры воркеров; батчинг вставки событий (webhook POST несёт 5–50 событий).
- Точный набор SendGrid scopes для автонастройки; поведение при нехватке прав у ключа (graceful ошибка с объяснением; ручной fallback НЕ строим в v1 — сообщение об ошибке достаточно).
- Реализация счётчика soft-bounce-подряд (колонка контакта vs вычисление из событий) — с учётом гонок при параллельной обработке.
- Как считать и обновлять счётчики сводки кампании (инкрементально при обработке vs агрегатный запрос) — с оглядкой на дедуп и идемпотентность.
- Реакция на смену/отключение SendGrid-ключа: перепривязка webhook, инвалидация verification key.
- Обновление статуса «последнее событие получено» без лишней нагрузки (Redis/дебаунс).
- RLS новых таблиц по паттерну Phase 1–4; tenant context в воркере обработки (PITFALLS #5) — обязателен.
- Тексты русскоязычного UI в стиле Phase 2–4.

### Deferred Ideas (OUT OF SCOPE)
- Расширенная диагностика webhook (счётчики отклонённых подписей, лог ошибок обработки за 24ч) — Phase 7 (observability)
- Настройка порога soft bounce на воркспейс — v2; v1 живёт с платформенной константой N=3 (D-10)
- TTL/архивация старых партиций доставочных событий — v2/ops (D-16)
- Total-счётчики открытий/кликов (не уникальные) и по-письмовый лог с фильтрами — Phase 7 (D-07, D-09)
- Suppression по bounce чужих писем тенанта (мимо платформы) — отклонено для v1 (D-15)
- Ручной fallback-путь настройки webhook (показ URL + вставка ключа) — не строим в v1; при нехватке прав ключа — понятная ошибка
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| WBHK-01 | Платформа принимает SendGrid Event Webhook на per-tenant URL с проверкой ECDSA-подписи по сырому телу запроса | Architecture Patterns #1/#2, Code Examples "Raw-body signature verification route"; per-tenant path-token design in Architecture Patterns #1 |
| WBHK-02 | Обрабатываются события delivered / opened / clicked / bounced / unsubscribed / spam report / dropped | Standard Stack + Code Examples "Event type normalization"; SendGrid Event Reference (Sources) confirms exact field shapes for each type |
| WBHK-03 | События дедуплицируются по sg_event_id — повторная доставка webhook не искажает статистику | Architecture Patterns #3 (batch dedup insert via `ON CONFLICT ... RETURNING`), Common Pitfalls #1 |
| WBHK-04 | Webhook-события обновляют статус конкретного письма в send log и статус подписки контакта | Architecture Patterns #4/#5 (COALESCE fact-columns, suppression state machine), Code Examples "Fact-column update + counter increment" |
| SUBS-02 | Unsubscribe/bounce/spam-события из SendGrid webhook автоматически обновляют статус контакта | Architecture Patterns #5, Don't Hand-Roll (suppression precedence table) |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- Fastify 5.9.x + `@fastify/type-provider-zod` — the webhook route's JSON body must NOT go through the global Zod/JSON validator until AFTER raw-body signature verification (CLAUDE.md "What NOT to Use": parsing SendGrid webhook body before signature verification is explicitly forbidden).
- BullMQ 5.79.x — queue names must not contain `:` (already discovered project convention, `packages/shared-schemas/src/queues.ts`); new queue must follow the `webhook-events` (hyphenated) naming style.
- Drizzle ORM 0.45.x / drizzle-kit 0.31.x — partitioned tables are NOT expressible in `pgTable()`; the new delivery-events table must be a **hand-written SQL migration** (established precedent: `packages/db/migrations/0007_events_partitioned.sql` / `0010_events_workspace_scoped_pk.sql`), with a parallel `pgTable()` file for type inference only.
- PostgreSQL 16/17 declarative partitioning by month on the new events table from day one (CLAUDE.md core constraint + D-16).
- KMS envelope encryption pattern (`packages/kms`) is for **secrets** (tenant SendGrid API keys); a webhook verification **public key** is not secret by definition and does not need KMS — plain-text storage is correct (see Architecture Patterns #1).
- RLS: every new tenant-scoped table gets `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a `workspace_isolation` policy using `current_setting('app.current_workspace_id', true)::uuid`, matching every existing migration (0001/0004/0006/0007/0012/0015).
- Two-key discipline (RESEARCH.md Pitfall 4, already enforced in `sendgrid-client.ts`): the webhook auto-provisioning calls are tenant-key calls and must live in `apps/api/src/modules/tenancy/sendgrid-client.ts` (or a sibling module), never touching `platform-mail`.
- Triggered vs. broadcast priority (SEND-03) is unaffected by this phase, but the new webhook-processing queue must be its own lane — do not fold event processing into `email-broadcast`/`email-triggered`.
- Security: `@fastify/helmet` CSP is already global (server.ts) — the new webhook route returns no HTML, so this is a non-issue, but confirm the route is registered as a plain async function (not `fastify-plugin`) so `addContentTypeParser` overrides are encapsulated to this route only (established pattern: `unsubscribe.routes.ts`).

## Summary

This phase closes the send loop: every SendGrid Event Webhook POST must be authenticated (ECDSA signature over the *raw* bytes, verified against a per-workspace public key resolved from an unguessable per-tenant URL segment), acknowledged in well under SendGrid's timeout, and processed asynchronously with exactly-once semantics keyed on `sg_event_id`. The two hardest technical risks — both already flagged in this project's own Phase 1-4 research (PITFALLS.md #2/#3) — are (1) accidentally letting Fastify's global JSON parser consume the body before signature verification, and (2) applying webhook side effects (status flips, suppression, counters) more than once for a retried or reordered batch.

SendGrid's webhook management API (confirmed this session against official Twilio/SendGrid docs) supports creating additional, independently-named Event Webhooks per account (`POST /v3/user/webhooks/event/settings`, `GET .../settings/all`, `PATCH .../settings/{id}`) separate from any pre-existing webhook the tenant configured manually — this directly enables D-05's "own named webhook, don't touch existing ones." Signature verification is a two-step API dance: create the webhook (get an `id`), then `PATCH /v3/user/webhooks/event/settings/signed/{id}` with `{"enabled": true}`, which returns the `public_key` in the same response. The official `@sendgrid/eventwebhook` npm package (same `sendgrid-nodejs` monorepo as the already-installed `@sendgrid/mail`) does the ECDSA verification correctly and is the right choice over hand-rolling ASN.1/ECDSA parsing.

The delivery-tracking data model extends the existing `sends` ledger (Phase 4, already designed for this — see its schema comment) with nullable fact-columns set via `COALESCE` (never overwritten once set, satisfying D-06's out-of-order safety), plus a new hand-written, partitioned `send_events` table mirroring the exact precedent of `events` (0007/0010 migrations) for raw per-event storage and `sg_event_id` dedup. Suppression logic (SUBS-02) is a deterministic mapping from normalized event type + SendGrid's exact bounce/`dropped`-reason strings (verified this session against official docs) to `subscription_status` transitions, writing to both `contacts.subscription_status` and `workspace_suppressions` in the same transaction (D-13).

One concrete gap this research surfaces that the planner must account for: Phase 4's `custom_args` shape (`{ send_id, workspace_id, campaign_id }`, `packages/delivery-core/src/send-mail.ts`) and its `kind: "test"` dispatch path (`apps/worker/src/queues/send-dispatch.ts`) do not currently mark test-sends as distinguishable in the webhook payload, and `tracking_settings` does not yet force `open_tracking`/`click_tracking` on (D-04) — both require small, well-scoped edits to already-shipped Phase 4 files, not new modules.

**Primary recommendation:** Build the webhook receiver as a new Fastify plugin module (`apps/api/src/modules/webhooks/`) using the same raw-body `addContentTypeParser` override pattern already proven in `unsubscribe.routes.ts`; verify with `@sendgrid/eventwebhook`; ack fast by enqueueing the *entire raw verified batch* as one BullMQ job onto a new `webhook-events` queue; process with a single batch `INSERT ... ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING RETURNING *` into the new partitioned `send_events` table, and apply status/suppression side effects only for rows the `RETURNING` clause actually returned (i.e., genuinely new events).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Per-tenant webhook URL routing + ECDSA verification | API / Backend | — | Public HTTPS endpoint, no session; must live in the same Fastify app as the existing public `/unsubscribe/:token` surface (same trust-boundary pattern) |
| SendGrid Event Webhook auto-provisioning (create/update/enable-signing) | API / Backend | — | Tenant-key API calls, same module family as `sendgrid-client.ts`/`sendgrid-key.ts` (connect/recheck flows) |
| Webhook event batch processing (dedupe, status writes, suppression) | API / Backend (worker process) | Database / Storage | Async BullMQ worker in `apps/worker`, mirroring `events-ingest.worker.ts`'s idempotent-worker pattern; all durable facts live in Postgres (Architecture Pattern 1: Postgres-as-truth) |
| Send status fact-columns + current-status derivation | Database / Storage | API / Backend | Columns live on `sends`; "current status" is a read-time CASE expression in a shared query helper, not a stored generated column (keeps priority-order logic changeable without a migration) |
| Suppression list + subscription status | Database / Storage | API / Backend | `contacts.subscription_status` + `workspace_suppressions`, both already exist (Phase 2); this phase adds a new writer, not a new owner |
| Webhook health indicator ("last event N ago", connected/disconnected) | API / Backend | Frontend Server (SSR n/a — SPA) | Debounced Postgres column update inside the same processing transaction; React reads it via existing TanStack Query polling pattern, no new infra |
| Campaign summary counters (delivered/opened/clicked/bounced/unsubscribed) | Database / Storage | API / Backend | Extends `campaigns` table's existing `sentCount`/`failedCount` precedent (04-13); incremented transactionally alongside the fact-column write |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@sendgrid/eventwebhook` | 8.0.0 | ECDSA signature verification of SendGrid Event Webhook payloads | Official SendGrid SDK package (same `sendgrid-nodejs` monorepo/publisher as the already-installed and trusted `@sendgrid/mail@8.1.6`); implements the exact ASN.1-unmarshal + SHA256(timestamp+raw-body) + ECDSA-verify sequence documented by SendGrid — hand-rolling this is a well-known correctness/security trap (Common Pitfalls #1) |

**Version verification:** `npm view @sendgrid/eventwebhook version` → `8.0.0`, published 2026-06-11 (`time.modified`). `npm view` confirms the package is live on the npm registry; repository resolves to `github.com/sendgrid/sendgrid-nodejs`, the identical publisher/repo already used for `@sendgrid/mail` in this project. [VERIFIED: npm registry]

No other new runtime dependencies are required — Fastify, BullMQ, ioredis, Drizzle/pg, Zod are all already installed at the versions documented in `.planning/research/STACK.md` and confirmed still current in `apps/api/package.json`/`apps/worker/package.json`/`packages/db/package.json` this session (`fastify@5.9.0`, `zod@4.4.3`, `bullmq@5.79.1`, `ioredis@5.11.0`, `drizzle-orm@0.45.2`, `pg@8.22.0`, `@fastify/type-provider-zod@1.0.0`). [VERIFIED: package.json read this session]

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `crypto` (Node built-in) | Node 22.x | Generate the per-tenant webhook path-token (`randomBytes(32).toString("base64url")`) | Same primitive already used for envelope-encryption IVs in `packages/kms/src/client.ts` — no new dependency |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@sendgrid/eventwebhook` for signature verification | Hand-rolled `crypto.createVerify('sha256')` + manual ASN.1 DER parsing | Technically possible (Node's built-in `crypto` module supports ECDSA verify given a properly PEM-formatted public key), but SendGrid's public key comes back as a raw base64 string requiring a specific DER-wrapping step before Node's `crypto` will accept it as a PEM key — `@sendgrid/eventwebhook`'s `convertPublicKeyToECDSA()` already does this correctly; reimplementing it duplicates a solved, security-sensitive problem for zero benefit (package is 243k weekly downloads, first-party, MIT-licensed, matches this repo's existing SendGrid SDK dependency) |
| BullMQ job-per-batch (this phase's recommendation) | BullMQ job-per-event | Job-per-event means N jobs per HTTP POST (5-50 events/batch per PITFALLS.md #3) — more Redis round-trips and more BullMQ bookkeeping for no correctness benefit, since the dedup unit is `sg_event_id` at the DB layer regardless of job granularity. Job-per-batch is simpler and matches this project's existing "ack fast, do the real work in one worker invocation" pattern from `events-ingest.worker.ts`; recommend batch inserts within the single job handler using a multi-row `INSERT ... VALUES ($1,$2,...),(...) ON CONFLICT DO NOTHING RETURNING *` |
| A new dedicated `webhook-events` BullMQ queue | Reusing `events-ingest` queue | The existing `events-ingest` queue is for tenant-originated behavioral events (EVNT-01) — a structurally distinct concern (contact events vs. delivery events) with different downstream side effects (segment/flow triggers vs. suppression/status). Sharing the queue would conflate two idempotency/schema contracts and make the queue's job schema a union type for no operational benefit; a dedicated queue costs nothing extra (BullMQ queues are cheap, Redis-key-namespaced) and keeps worker concurrency tunable independently |

**Installation:**
```bash
npm install @sendgrid/eventwebhook --workspace apps/api
```

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `@sendgrid/eventwebhook` | npm | ~2.5 yrs (published 2023-12-05, latest 8.0.0 2026-06-11) | ~243,766/wk | github.com/sendgrid/sendgrid-nodejs | OK | Approved |

Verified via `gsd-tools query package-legitimacy check --ecosystem npm @sendgrid/eventwebhook` this session: `exists: true`, `deprecated: false`, `postinstall: null`, repo resolves to the same monorepo/publisher as the already-trusted `@sendgrid/mail` dependency. [VERIFIED: npm registry + gsd-tools package-legitimacy check]

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** none.

## Architecture Patterns

### System Architecture Diagram

```
                         SendGrid (tenant's own account)
                                    │
                    Event Webhook POST (5-50 events/batch,
                    X-Twilio-Email-Event-Webhook-Signature +
                    -Timestamp headers, JSON body)
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│ apps/api  —  POST /webhooks/sendgrid/:pathToken                       │
│                                                                        │
│  1. Look up workspace + stored public_key by pathToken (indexed,      │
│     outside any RLS tenant context — same "resolve tenant before      │
│     trusting payload" pattern as workspace_api_keys' runtime lookup)  │
│         │                                                              │
│         ▼  unknown token → 404 (no signature check leaks existence)   │
│  2. Content-type parser override captures RAW body bytes (Buffer) —   │
│     Fastify's default JSON parser NEVER touches this route            │
│         │                                                              │
│         ▼                                                              │
│  3. @sendgrid/eventwebhook.verifySignature(publicKey, rawBody,         │
│     signatureHeader, timestampHeader)                                 │
│         │                                                              │
│         ├─ invalid → 400, DROP (no enqueue, no JSON.parse)             │
│         ▼ valid                                                        │
│  4. JSON.parse(rawBody) → array of events                             │
│  5. Enqueue ONE BullMQ job on `webhook-events` queue: the raw event    │
│     array + workspaceId                                                │
│  6. Return 200 immediately (ack-fast, Anti-Pattern 2 avoidance)        │
└───────────────────────────────────────────────────────────────────────┘
                                    │ (async, decoupled)
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│ apps/worker  —  webhook-events.worker.ts                               │
│                                                                        │
│  withTenant(workspaceId) → withTenantTransaction:                     │
│   1. Batch INSERT INTO send_events (...) VALUES (...),(...)           │
│      ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING   │
│      RETURNING * → only genuinely-new rows come back (WBHK-03)        │
│   2. For each newly-inserted row (skip anything already processed):   │
│        a. Resolve custom_args.send_id → sends row (skip silently if   │
│           no marker or no matching row — D-15)                        │
│        b. UPDATE sends SET <fact_col> = COALESCE(<fact_col>, ts) ...  │
│           WHERE id = send_id (D-06: never overwrite an existing fact) │
│        c. If this UPDATE just set a counter-worthy fact for the FIRST │
│           time → UPDATE campaigns SET <counter> = <counter> + 1       │
│        d. Apply suppression state machine (D-10/D-11/D-12/D-13):      │
│           UPDATE contacts.subscription_status + INSERT workspace_     │
│           suppressions, same transaction                               │
│   3. Debounced UPDATE workspace_webhook_endpoints.last_event_at        │
│      (only if stale by > 60s — avoids a write per event)               │
└───────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

```
apps/api/src/modules/webhooks/
├── webhook-endpoint.repository.ts   # pathToken/public_key lookup, provisioning state
├── sendgrid-webhook-provision.ts    # POST create / PATCH update / PATCH signed enable (tenant-key API calls)
├── signature-verify.ts              # thin wrapper around @sendgrid/eventwebhook
├── webhooks.routes.ts               # POST /webhooks/sendgrid/:pathToken (raw-body content-type parser)
└── __tests__/
    ├── webhooks-signature.test.ts       # replay a REAL signed test payload (Pitfall #1's mandated integration test)
    └── webhook-provisioning.test.ts

apps/worker/src/queues/
├── webhook-events.worker.ts         # batch dedupe insert + fact-column + suppression processor
└── __tests__/webhook-events-idempotency.test.ts

packages/delivery-core/src/
├── send-status.ts                   # shared "current status" CASE-expression helper (read-time, D-06 priority order)
└── suppression-rules.ts             # normalized event-type + reason → subscription_status transition table (D-10/11/12)

packages/db/src/schema/
├── send-events.ts                   # pgTable() for type inference ONLY (see events.ts precedent comment)
└── webhook-endpoints.ts             # workspace_webhook_endpoints table

packages/db/migrations/
├── NNNN_sends_delivery_columns.sql      # ALTER TABLE sends ADD COLUMN ... (fact columns + reason columns)
├── NNNN_send_events_partitioned.sql     # hand-written, mirrors 0007/0010 exactly
└── NNNN_webhook_endpoints.sql           # workspace_webhook_endpoints + RLS
```

### Pattern 1: Per-tenant webhook URL is an opaque token, not the workspace_id itself

**What:** Route path is `/webhooks/sendgrid/:pathToken` where `pathToken` is a cryptographically random, per-workspace, unique, indexed value (`crypto.randomBytes(32).toString("base64url")`) generated at first provisioning and stored in a new `workspace_webhook_endpoints` table alongside the SendGrid-issued webhook `id` and the `public_key` returned by the signed-webhook-enable call. The route handler resolves `workspaceId` and `public_key` via a single indexed `SELECT ... WHERE path_token = $1` **before** any RLS tenant context exists — the same "resolve tenant identity via a narrow, purpose-built SELECT-only path outside `withTenant`" pattern already used for `workspace_api_keys`' `api_key_runtime_lookup` policy (Phase 2, 02-03).
**When to use:** Any inbound, unauthenticated-by-session webhook that must first discover *which tenant* before it can even attempt cryptographic verification.
**Why not embed `workspace_id` directly in the URL:** `custom_args.workspace_id` in the *payload* cannot be trusted to select the verification key (ARCHITECTURE.md's explicit warning: "you cannot trust unverified payload data to choose which signing key to verify against") — the URL path is the only pre-verification trust anchor, and an opaque unguessable token avoids leaking real workspace UUIDs into a public URL (defense-in-depth against URL scanning/enumeration, even though the true security boundary is the ECDSA signature, not the token's secrecy).
**Public key storage:** Plain text column, NOT KMS-encrypted — it is by definition public and used on every request; encrypting it would add decrypt-per-request overhead for zero confidentiality benefit. [ASSUMED — reasonable engineering judgment, no compliance requirement mandates encrypting a public key; flagged for planner/user sanity-check per CLAUDE.md's KMS guidance being scoped to *secrets*]

### Pattern 2: Ack-fast via whole-batch enqueue, never per-event

**What:** The HTTP route does the minimum synchronous work: token lookup (1 indexed query), raw-body signature verification (pure CPU, no I/O), then a single `queue.add()` of the entire verified event array, then `reply.code(200).send()`. No database writes happen in the request path.
**When to use:** Any webhook receiver where SendGrid's own retry-on-non-2xx behavior (up to 24h, PITFALLS.md #3) could otherwise create a retry storm if processing is slow.
**Trade-offs:** A worker crash between "job enqueued" and "job processed" is safe (BullMQ redelivers); the batch insert's `ON CONFLICT DO NOTHING` makes redelivery of an already-processed batch a cheap no-op.

### Pattern 3: Batch dedup insert with `RETURNING` gates all side effects

**What:** Insert the whole batch in one multi-row `INSERT ... ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING RETURNING *`. Only rows Postgres actually returns are "new" — iterate exactly those for fact-column updates, counter increments, and suppression transitions. Events that conflict (already processed, from a retried batch) are silently skipped with zero side effects, satisfying WBHK-03 at the database level rather than relying on application-level "have I seen this ID before" caching (which would itself need to be crash-safe and tenant-scoped — Postgres's own unique constraint already is).
**When to use:** Any at-least-once-delivery ingestion path where a unique natural key exists (`sg_event_id`) and side effects must be exactly-once.
**Why per-event dedup, not per-batch-hash:** PITFALLS.md #3 explicitly documents that deduping by request-body hash is wrong — a retried batch is byte-identical, but two separate logical batches are not guaranteed to be, and a partially-processed prior batch (crash mid-loop) needs per-event granularity to resume correctly.

### Pattern 4: Fact columns via `COALESCE`, never plain assignment

**What:** Every "first occurrence" timestamp column on `sends` (`delivered_at`, `first_opened_at`, `first_clicked_at`, `unsubscribed_at`, `spam_reported_at`) is written as `COALESCE(<column>, $newTimestamp)`, and the two hard-terminal columns (`bounced_at`, `dropped_at`) are likewise never overwritten once set. This makes the entire fact-write idempotent AND order-insensitive: replaying the same event twice, or receiving a `bounce` before a delayed `delivered` for the same message, cannot corrupt state (D-06's explicit requirement).
**Current-status derivation:** Compute at read time via a shared SQL/TS helper implementing the exact priority order from D-06 (`bounced_at/dropped_at/spam_reported_at` terminal > `first_clicked_at` > `first_opened_at` > `delivered_at` > `sent_at`/`status='sent'`) — NOT a stored generated column, so the priority rule can change without a migration.
**Counter increment gate:** To increment a campaign-level counter exactly once per send (D-09's "unique recipients"), wrap the fact-column `UPDATE` in a form that reveals whether *this* write was the one that set the value (e.g., a CTE: `UPDATE ... RETURNING (xmax = 0) AS was_insert` doesn't apply here since it's an UPDATE not INSERT — instead compare the column's prior value inside a `SELECT ... FOR UPDATE` read-then-write, or use `RETURNING (first_opened_at = $newTimestamp) AS just_set` after the COALESCE update — only bump the aggregate counter when `just_set` is true). This mirrors the exact idempotent-increment discipline already established for `incrementCampaignSendCounter` in Phase 4 (04-13).

### Pattern 5: Suppression as a pure lookup table, not scattered conditionals

**What:** A single exported table/function (`packages/delivery-core/src/suppression-rules.ts`) maps `(normalizedEventType, reason?)` → `{ status: "suppressed" | "unsubscribed" | null; suppressionReason?: string }`, covering exactly D-10/D-11/D-12's rules. The webhook processor calls this once per new event and, if non-null, performs the D-13 dual write (`contacts.subscription_status` + `workspace_suppressions` insert) inside the same transaction as the event's fact-column update.
**Why:** PITFALLS.md #7 explicitly warns against suppression logic drifting across code paths — centralizing the *decision* (event → status) in one pure function, separate from the *side effect* (the actual UPDATE/INSERT), makes it independently unit-testable against every SendGrid event/reason combination without a database.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| ECDSA signature verification | Manual ASN.1 DER parsing + `crypto.createVerify` | `@sendgrid/eventwebhook` | SendGrid's public key format requires a specific DER-wrapping step before Node's `crypto` module will accept it; the official package already does this correctly (Standard Stack) |
| Raw-body capture ahead of JSON parsing | A generic body-parser plugin (e.g. `fastify-raw-body`) | `fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, ...)` scoped inside the route's own async-function module | This exact technique is already proven in this codebase (`unsubscribe.routes.ts`'s `application/x-www-form-urlencoded` override) — no new dependency needed, and Fastify's per-plugin encapsulation means it cannot weaken body parsing for any other route |
| Webhook event dedup | An application-level in-memory/Redis "seen IDs" cache | Postgres `UNIQUE` constraint + `ON CONFLICT DO NOTHING RETURNING *` | A cache needs its own crash-safety and tenant-scoping story that a database unique constraint already provides for free, and PITFALLS.md #3 explicitly documents in-memory/cache-based dedup as the wrong layer |
| Suppression list bulk mutation | Any endpoint/script that writes many `workspace_suppressions` rows in one unreviewed call | Per-event, per-transaction single-row writes driven only by a verified webhook event | PITFALLS.md/CLAUDE.md Security Mistakes explicitly flags unbounded suppression-list bulk mutation as a reputation-destroying risk vector; this phase's writes are always exactly one row per one verified, dedup-gated event |
| "Is this webhook healthy" status | A separate polling job hitting SendGrid's API on a timer | A debounced `last_event_at` column updated inline during normal processing | D-03 only requires "last event received N ago" — this is already known the instant a batch is processed; polling SendGrid would be redundant network calls for data already flowing through the system |

**Key insight:** Every piece of this phase that looks like it needs new infrastructure (a cache, a scheduler, a bulk-mutation endpoint) is actually already solvable with the transaction the webhook processor is already running — the discipline is keeping all side effects inside that one idempotent, dedup-gated transaction rather than reaching for a second system.

## Common Pitfalls

### Pitfall 1: Global JSON body-parser consumes the webhook body before verification
**What goes wrong:** Fastify's default `application/json` content-type parser (registered globally the moment `Fastify()` is constructed) parses and re-serializes the body before any handler code runs, so a signature computed over SendGrid's raw bytes never matches what your verification code sees.
**Why it happens:** It's the framework default; nothing fails loudly — verification just always returns `false`, and a team under time pressure "fixes" this by disabling verification (CLAUDE.md explicitly forbids this).
**How to avoid:** Register `fastify.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => done(null, body))` **inside the webhooks route module's own async function** (not globally in `server.ts`) so Fastify's plugin encapsulation scopes the override to only `/webhooks/sendgrid/*` — exactly the same technique `unsubscribe.routes.ts` already uses for its content type.
**Warning signs:** Signature verification passes against a hand-built JSON string in a unit test but fails against every real SendGrid request.
**Mandatory verification (already flagged in STATE.md Blockers):** an integration test that replays a real (or SendGrid-provided test) signed payload through the actual HTTP stack — not just a unit test calling `verifySignature()` directly with clean strings.

### Pitfall 2: Test-send events are indistinguishable from real orphaned sends in webhook payloads
**What goes wrong:** Phase 4's `kind: "test"` dispatch path (`apps/worker/src/queues/send-dispatch.ts`) generates a `sendId` via `randomUUID()` but **never inserts a `sends` row** for it (by design — D-12 from Phase 4). When SendGrid later posts webhook events for that test message, `custom_args.send_id` will not resolve to any `sends` row — which is *structurally identical* to the "send was deleted" case D-15 describes, but semantically different (D-15 wants test sends explicitly marked and excluded, distinct from a genuinely orphaned real send).
**Why it happens:** `packages/delivery-core/src/send-mail.ts`'s `SendGridMailSendRequest.personalizations[].custom_args` currently has a fixed 3-key shape (`send_id`, `workspace_id`, `campaign_id`) with no `test` marker, and both the campaign-send and test-send call sites in `send-dispatch.ts` build this identically.
**How to avoid:** Add a 4th custom_arg (e.g. `test: "true"`, since SendGrid custom_args are string-valued) set only on the `kind === "test"` branch of `processSendJob`; the webhook processor checks `custom_args.test === "true"` first and short-circuits to `is_test = true` storage with zero stats/suppression side effects, before ever attempting a `sends` lookup. This is a small, scoped edit to already-shipped Phase 4 code, not a new module.
**Warning signs:** Campaign summary counters look correct in demo testing (few real sends) but a marketer's "send test to myself" clicks start silently appearing to affect delivery stats, or worse, a bounced test address gets suppressed as if it were a real contact.

### Pitfall 3: Open/click tracking not force-enabled per-send (D-04)
**What goes wrong:** WBHK-02 requires `open`/`click` events, but SendGrid only emits them if `tracking_settings.open_tracking`/`click_tracking` are enabled — either at the account level (which the platform does not control, BYO key) or per-message. Phase 4's `buildMailSendRequest` currently only sets `tracking_settings.subscription_tracking.enable: false` and omits `open_tracking`/`click_tracking` entirely, which means their effective value falls back to whatever the tenant's SendGrid account-level Tracking Settings happen to be — exactly what D-04 says the platform must NOT depend on.
**How to avoid:** Extend `packages/delivery-core/src/send-mail.ts`'s `tracking_settings` to explicitly include `open_tracking: { enable: true }` and `click_tracking: { enable: true }` on every `mail/send` call, alongside the existing `subscription_tracking: { enable: false }`.
**Warning signs:** `opened`/`clicked` counts stay at zero in the campaign summary for a tenant whose SendGrid account has tracking disabled at the account level, even though webhook plumbing is otherwise correct.

### Pitfall 4: SendGrid's "no two webhooks to the same URL" constraint + `max_allowed` plan cap on reconnect/re-provision
**What goes wrong:** D-02's re-provisioning flow (auto-runs on every SendGrid key connect/reconnect) must not blindly `POST` a new webhook every time — SendGrid returns an error if a URL is already registered on another webhook for that account, and the account's plan caps how many Event Webhooks can exist (`max_allowed` field on `GET .../settings/all`). If the platform doesn't remember its own previously-provisioned webhook `id`, a reconnect could either error out or (worse) silently accumulate duplicate webhook registrations across repeated connect/disconnect cycles during testing.
**How to avoid:** Persist the SendGrid-issued webhook `id` in `workspace_webhook_endpoints` from the first successful provisioning call; every subsequent auto-configuration run does `PATCH /v3/user/webhooks/event/settings/{id}` (update in place) instead of `POST` (create), exactly matching D-05's "hold its id and update only it."
**Warning signs:** A `422`/`400` from SendGrid on reconnect referencing "URL already in use," or multiple identically-named webhooks appearing in the tenant's SendGrid dashboard after repeated key reconnects during development/testing.

### Pitfall 5 (inherited, PITFALLS.md #5 / #8): tenant context omitted in the async worker
**What goes wrong:** The webhook processing worker runs in `apps/worker`, a separate process from the request that enqueued the job — every database operation must explicitly re-derive `workspaceId` from `job.data` and wrap all writes in `withTenant(workspaceId, () => withTenantTransaction(...))`, exactly like `events-ingest.worker.ts` and `send-dispatch.ts` already do. Skipping this is invisible in a single-tenant dev/test environment and only manifests as a cross-tenant leak under concurrent multi-tenant load.
**How to avoid:** Copy the exact `withTenant`/`withTenantTransaction` wrapping convention already established in this codebase; add the same RLS `ENABLE`+`FORCE`+`workspace_isolation` triplet to every new table in this phase's migrations.

## Code Examples

### Raw-body signature verification route (WBHK-01)
```typescript
// Source: pattern synthesized from official @sendgrid/eventwebhook usage
// (github.com/sendgrid/sendgrid-nodejs/blob/main/docs/use-cases/event-webhook.md)
// + this repo's own unsubscribe.routes.ts raw-body precedent.
import type { FastifyInstance } from "fastify";
import { EventWebhook } from "@sendgrid/eventwebhook";
import { findWebhookEndpointByToken } from "./webhook-endpoint.repository.js";
import { enqueueWebhookBatch } from "./enqueue.js";

export async function registerWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Scoped to this route module only (Fastify plugin encapsulation) --
  // never registered globally, so every other route keeps the default
  // JSON parser/validator pipeline untouched.
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body)
  );

  fastify.post("/webhooks/sendgrid/:pathToken", async (request, reply) => {
    const { pathToken } = request.params as { pathToken: string };
    const endpoint = await findWebhookEndpointByToken(pathToken);
    if (!endpoint) {
      // Generic 404 -- no distinction from "valid token, bad signature"
      // beyond this point avoids leaking which tokens are provisioned.
      return reply.code(404).send();
    }

    const rawBody = request.body as Buffer;
    const signature = request.headers["x-twilio-email-event-webhook-signature"] as string;
    const timestamp = request.headers["x-twilio-email-event-webhook-timestamp"] as string;

    const eventWebhook = new EventWebhook();
    const ecPublicKey = eventWebhook.convertPublicKeyToECDSA(endpoint.publicKey);
    const isValid = eventWebhook.verifySignature(ecPublicKey, rawBody, signature, timestamp);
    if (!isValid) {
      return reply.code(400).send();
    }

    const events = JSON.parse(rawBody.toString("utf8")) as unknown[];
    await enqueueWebhookBatch(endpoint.workspaceId, events);

    // Ack fast -- all real processing happens in apps/worker.
    return reply.code(200).send();
  });
}
```

### SendGrid webhook auto-provisioning (D-01/D-02/D-05)
```typescript
// Source: endpoint shapes confirmed via official Twilio/SendGrid API
// reference docs fetched this session (create/get-all/update/toggle-signed).
// Same raw-fetch-with-Bearer-key convention as sendgrid-client.ts.
export async function provisionEventWebhook(
  apiKey: string,
  callbackUrl: string,
  existingWebhookId?: string
): Promise<{ id: string; publicKey: string }> {
  const eventFlags = {
    delivered: true,
    bounce: true,
    dropped: true,
    open: true,
    click: true,
    unsubscribe: true,
    group_unsubscribe: true, // D-11: group_unsubscribe also -> unsubscribed
    spam_report: true,
  };

  const webhookId = existingWebhookId ?? (await createWebhook());
  await enableSignedVerification(webhookId); // returns { id, public_key }

  async function createWebhook(): Promise<string> {
    const res = await fetch("https://api.sendgrid.com/v3/user/webhooks/event/settings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        url: callbackUrl,
        friendly_name: "Mega CRM Delivery Tracking", // D-05: our own named webhook
        ...eventFlags,
      }),
    });
    if (!res.ok) throw new Error(`SendGrid webhook create failed: ${res.status}`);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  async function enableSignedVerification(id: string): Promise<{ id: string; public_key: string }> {
    const res = await fetch(
      `https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/${id}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }
    );
    if (!res.ok) throw new Error(`SendGrid signed-webhook enable failed: ${res.status}`);
    return (await res.json()) as { id: string; public_key: string };
  }

  const enabled = await enableSignedVerification(webhookId);
  return { id: enabled.id, publicKey: enabled.public_key };
}
```

### Event type normalization (WBHK-02, D-10's hard/soft bounce distinction)
```typescript
// Source: SendGrid Event Webhook Reference (official Twilio docs, fetched
// this session) -- confirms hard vs soft bounce share event:"bounce" and
// are distinguished ONLY by the "type" field ("bounce" vs "blocked").
type NormalizedEventType =
  | "delivered" | "open" | "click"
  | "bounce_hard" | "bounce_soft"
  | "dropped" | "spam_report" | "unsubscribe" | "group_unsubscribe";

function normalizeEventType(raw: { event: string; type?: string }): NormalizedEventType | null {
  switch (raw.event) {
    case "delivered": return "delivered";
    case "open": return "open";
    case "click": return "click";
    case "dropped": return "dropped";
    case "spamreport": return "spam_report";
    case "unsubscribe": return "unsubscribe";
    case "group_unsubscribe": return "group_unsubscribe";
    case "bounce":
      // D-10: type:"bounce" = hard, type:"blocked" = soft.
      return raw.type === "blocked" ? "bounce_soft" : "bounce_hard";
    default:
      return null; // processed/deferred/group_resubscribe/account_status_change -- out of WBHK-02 scope, ack + drop
  }
}
```

### Suppression rule table (D-10/D-11/D-12)
```typescript
// Source: dropped-reason exact strings confirmed via official SendGrid docs
// fetched this session.
type SuppressionOutcome = { status: "suppressed" | "unsubscribed"; reason: string } | null;

const ADDRESS_DROP_REASONS: Record<string, SuppressionOutcome> = {
  "Bounced Address": { status: "suppressed", reason: "dropped_bounced_address" },
  "Spam Reporting Address": { status: "suppressed", reason: "dropped_spam_reporting_address" },
  "Invalid Address": { status: "suppressed", reason: "dropped_invalid_address" },
  "Unsubscribed Address": { status: "unsubscribed", reason: "dropped_unsubscribed_address" },
  // "Invalid SMTPAPI header" / "Spam Content" / "Recipient List over Package
  // Quota" are technical/policy reasons, not address-validity -- no status
  // change (D-12: "маппятся по смыслу, без смены статуса").
};

export function resolveSuppression(
  eventType: NormalizedEventType,
  reason: string | null
): SuppressionOutcome {
  switch (eventType) {
    case "bounce_hard": return { status: "suppressed", reason: "hard_bounce" };
    case "spam_report": return { status: "suppressed", reason: "spam_report" };
    case "unsubscribe":
    case "group_unsubscribe": return { status: "unsubscribed", reason: "unsubscribe" };
    case "dropped": return reason ? ADDRESS_DROP_REASONS[reason] ?? null : null;
    case "bounce_soft": return null; // handled separately -- see soft-bounce streak below
    default: return null;
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Single Event Webhook per SendGrid account (`GET/PATCH /v3/user/webhooks/event/settings`) | Multiple, independently-named Event Webhooks per account (`POST/GET .../settings`, `.../settings/all`, `.../settings/{id}`) | SendGrid added multi-webhook support (exact date not confirmed this session, but confirmed live and current via official docs fetched 2026-07-08) | Directly enables D-05: the platform can add its own webhook without disturbing a tenant's pre-existing manually-configured one — this would not have been possible under the old single-webhook API, where creating a new config would silently replace the tenant's own |

**Deprecated/outdated:** None identified as deprecated within this phase's scope; the legacy single-webhook endpoint (`/v3/user/webhooks/event/settings` GET/PATCH without an `{id}`) still exists per SendGrid's docs but should not be used for this phase's auto-provisioning, since it operates on "the" (singular) webhook rather than a specifically-created one.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Public verification key does not need KMS envelope encryption (plain-text storage is correct since it is not a secret) | Architecture Patterns #1 | Low — even if wrong, storing it encrypted is a mechanical follow-up change, not a design blocker; flagged for explicit user sign-off since CLAUDE.md's KMS pattern is otherwise applied uniformly to all "connection" secrets in this project |
| A2 | The exact SendGrid API scope name(s) required for auto-provisioning are `user.webhooks.event.settings.update`/`.read` | Common Pitfalls #4 / Standard Stack | Low-medium — this only affects the pre-flight scope check message shown to the user on a missing-permission error; the actual gate is the live API call's own success/failure, so a wrong assumed scope name would only make the *error copy* less precise, not break functionality. Verify the exact scope string against a live `/v3/scopes` response for a real test API key before writing the pre-flight check copy |
| A3 | SendGrid's multi-webhook creation endpoint is `POST /v3/user/webhooks/event/settings` (not `.../settings/all`) | Code Examples "SendGrid webhook auto-provisioning" | Medium — the official docs fetched this session did not show a fully explicit example request for the CREATE operation's path (only inferred from navigation structure); if wrong, the create call would 404/405 and must be corrected to `.../settings/all` at implementation time. **Recommend a `checkpoint:human-verify` or a first-task live sandbox-key smoke test against SendGrid before building the rest of the provisioning flow on this assumption** |
| A4 | `max_allowed` (plan-based cap on number of Event Webhooks) will not block a typical tenant from getting the platform's own webhook alongside an existing manual one | Common Pitfalls #4 | Medium — if a tenant's plan caps Event Webhooks at 1 and they already have one configured manually, D-05's "don't touch existing webhooks" and "auto-create our own" become mutually exclusive for that tenant; this is a real product edge case not addressed in CONTEXT.md's decisions and should be surfaced to the user as an open question, not silently handled |

**If this table is empty:** N/A — see rows above; all other technical claims in this document were either directly fetched from official Twilio/SendGrid documentation this session (CITED) or verified against this repository's own code/package.json (VERIFIED).

## Open Questions

1. **Exact SendGrid API path for creating a new (additional) Event Webhook**
   - What we know: `GET /v3/user/webhooks/event/settings/all` (list, confirmed), `PATCH /v3/user/webhooks/event/settings/{id}` (update, confirmed), `PATCH /v3/user/webhooks/event/settings/signed/{id}` (enable signing + get public key, confirmed) are all directly confirmed against official docs this session.
   - What's unclear: whether CREATE is `POST /v3/user/webhooks/event/settings` (no id) or `POST /v3/user/webhooks/event/settings/all` — official docs fetched this session referenced "Create an Event Webhook" as a distinct page but did not return an explicit example request body/path in the fetched content.
   - Recommendation: first implementation task for 05-01 should be a live smoke-test call (sandbox/test SendGrid account, already established precedent per STATE.md's Phase 1 "live SendGrid + browser" checkpoints) against both candidate paths before writing the production provisioning code; do not guess in code without a `checkpoint:human-verify` gate.

2. **What happens when a tenant's plan `max_allowed` Event Webhook cap is already reached by their own pre-existing webhook**
   - What we know: D-05 requires never touching existing webhooks; D-01's fallback for insufficient scopes is "graceful error, no manual fallback in v1."
   - What's unclear: whether a capacity error (vs. a permission error) should get the same generic "couldn't enable tracking" message, or whether it needs a distinct, more actionable copy (e.g., "delete or free up a webhook slot in your SendGrid account").
   - Recommendation: treat it as the same error class as insufficient scopes for v1 (generic graceful failure), consistent with CONTEXT.md's explicit "ручной fallback НЕ строим в v1" — but flag the distinct error string for future Phase 7 diagnostics.

3. **Soft-bounce streak counter storage — column on `contacts` vs. derived from `send_events`**
   - What we know: D-10 requires N=3 consecutive soft-bounce/block failures (reset by a successful delivery) before suppression; discretion explicitly flags race conditions under parallel processing.
   - What's unclear: nothing structurally — recommend a dedicated `contacts.consecutive_soft_bounces` integer column, incremented via a single `UPDATE contacts SET consecutive_soft_bounces = consecutive_soft_bounces + 1 WHERE id = $1` (atomic row-level lock under Postgres MVCC) gated behind the same "only run for genuinely-new rows from the dedup `RETURNING`" guard as every other side effect, and reset to `0` on any `delivered` fact being newly set for that contact. This is a recommendation, not an open question requiring user input — included here for planner visibility.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL | `send_events` partitioned table, `sends`/`contacts`/`workspace_suppressions` writes | ✓ (already in use, Phase 1-4) | 16/17 | — |
| Redis | New `webhook-events` BullMQ queue | ✓ (already in use, Phase 2-4) | 7.x | — |
| A real or sandbox SendGrid account + API key with webhook-management scopes | Live provisioning smoke test (Open Question 1), end-to-end signature verification test | Not confirmed available in this research session | — | Use SendGrid's documented static test payload/public key for unit-level signature verification tests (does not require a live account); defer the live provisioning smoke test to a `checkpoint:human-verify` task, mirroring the exact precedent already set in Phase 1 (01-03/01-04/01-05 deferred live-SendGrid checks to phase-level UAT) |

**Missing dependencies with no fallback:** none — all core infra (Postgres, Redis, BullMQ, Fastify) is already running in this project.

**Missing dependencies with fallback:** live SendGrid account access for the provisioning API smoke test and full webhook signature round-trip — fallback is unit tests against SendGrid's published example payloads/keys plus a deferred human-verify checkpoint, consistent with this project's established `human_verify_mode: end-of-phase` convention (`.planning/config.json`).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x (already configured, `apps/api/vitest.config.ts` / `apps/worker/vitest.config.ts`) |
| Config file | `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts` (existing, no new config needed) |
| Quick run command | `npm run test -w apps/api -- webhooks` / `npm run test -w apps/worker -- webhook-events` |
| Full suite command | `npm run test --workspaces --if-present` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WBHK-01 | Valid signature verified against raw body; invalid signature rejected | integration (real HTTP stack, real/fixture signed payload) | `npm run test -w apps/api -- webhooks-signature` | ❌ Wave 0 |
| WBHK-01 | Unknown pathToken → generic 404, no signature attempted | unit | `npm run test -w apps/api -- webhooks-signature` | ❌ Wave 0 |
| WBHK-02 | Each of delivered/open/click/bounce(hard+soft)/dropped/spam_report/unsubscribe/group_unsubscribe normalizes correctly | unit | `npm run test -w apps/worker -- webhook-events-normalize` | ❌ Wave 0 |
| WBHK-03 | Replayed duplicate batch produces zero additional side effects | integration (real Postgres, real dedup constraint) | `npm run test -w apps/worker -- webhook-events-idempotency` | ❌ Wave 0 |
| WBHK-03 | Out-of-order events (bounce arrives after a later-timestamped open) do not corrupt fact columns | integration | `npm run test -w apps/worker -- webhook-events-idempotency` | ❌ Wave 0 |
| WBHK-04 | New event updates the correct `sends` fact column + campaign counter exactly once | integration | `npm run test -w apps/worker -- webhook-events-status` | ❌ Wave 0 |
| SUBS-02 | Hard bounce → immediate suppressed + workspace_suppressions row; soft bounce streak → suppressed only at N=3, reset on delivery | integration | `npm run test -w apps/worker -- suppression-rules` | ❌ Wave 0 |
| SUBS-02 | Test-send events (Pitfall #2) never affect subscription status or counters | integration | `npm run test -w apps/worker -- webhook-events-test-marker` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** targeted `npm run test -w apps/api -- webhooks` / `-w apps/worker -- webhook-events` (quick run)
- **Per wave merge:** `npm run test --workspaces --if-present` (full suite)
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts` — covers WBHK-01, needs at least one real/fixture signed payload (SendGrid publishes example test payloads/keys for exactly this purpose — use those rather than hand-constructing a fake signature)
- [ ] `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts` — covers WBHK-03, mirrors `events-ingest-idempotency.test.ts`'s structure
- [ ] `apps/worker/src/queues/__tests__/webhook-events-status.test.ts` — covers WBHK-04
- [ ] `packages/delivery-core/src/__tests__/suppression-rules.test.ts` — covers SUBS-02's pure-function decision table, no database needed
- [ ] Migration test/fixture data for the new `send_events` partitioned table (mirrors `packages/delivery-core/src/test/db-fixture.ts` / `apps/worker/src/test/db-fixture.ts` conventions already in place)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | This endpoint is intentionally session-less (public webhook receiver), same class as the existing `/unsubscribe/:token` surface |
| V4 Access Control | Yes | Per-tenant opaque `pathToken` as the pre-verification tenant-resolution key; generic 404 for unknown tokens (no enumeration oracle) |
| V5 Input Validation | Yes | Zod schema validation of the parsed event array happens AFTER signature verification, never before (must not be the gate that decides whether to even attempt verification) |
| V6 Cryptography | Yes | ECDSA signature verification via `@sendgrid/eventwebhook` (never hand-rolled); public key stored plain-text (not a secret) vs. tenant SendGrid API keys which remain KMS envelope-encrypted (unchanged from Phase 1) |
| V13 API and Web Service | Yes | Webhook-specific: raw-body integrity before parsing (this phase's central risk), fail-closed on any verification failure (PITFALLS.md Security Mistakes: "fail closed rather than fail open") |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Forged webhook event (attacker POSTs fabricated delivery/bounce/unsubscribe data) | Spoofing | ECDSA signature verification against the per-tenant public key, fail-closed (400 on any invalid/missing signature) |
| Body tampering between signing and verification (re-serialization mismatch) | Tampering | Raw-byte capture via scoped `addContentTypeParser` override, verify before `JSON.parse` |
| Webhook URL/token enumeration to discover valid tenants | Information Disclosure | Cryptographically random 32-byte `pathToken`; identical generic 404 for "unknown token" as would be given for "token exists but signature invalid" would ideally be indistinguishable too — but since signature verification requires the *correct* public key looked up by token, an unknown-token 404 is unavoidleakage-free by construction (an attacker learns nothing more than "this token doesn't exist," same as any 404) |
| Event-flood / retry-storm DoS via a compromised or malfunctioning SendGrid integration | Denial of Service | Ack-fast pattern decouples HTTP response time from processing time; BullMQ queue absorbs bursts; consider `@fastify/rate-limit` on this route scoped per-pathToken if abuse is observed (not required for MVP per CONTEXT.md's scope, flagged as a Phase 7 diagnostics item) |
| Suppression-list poisoning via a forged "unsubscribe"/"spam_report" event | Tampering / Repudiation | Same ECDSA gate as all other events — no event is trusted without a valid signature, so this reduces to the same mitigation as the first row |

## Sources

### Primary (HIGH confidence)
- [Getting Started with the Event Webhook Security Features | Twilio/SendGrid Docs](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features) — fetched this session; ECDSA header names, signed-string construction (timestamp+raw body), verification steps
- [Get Signed Event Webhook's Public Key | Twilio/SendGrid Docs](https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-signed-event-webhooks-public-key) — fetched this session
- [Toggle Signature Verification for an Event Webhook | Twilio/SendGrid Docs](https://www.twilio.com/docs/sendgrid/api-reference/webhooks/toggle-signature-verification-for-an-event-webhook) — fetched this session; confirms `PATCH .../signed/{id}` returns `public_key` in the same response
- [Get All Event Webhooks | Twilio/SendGrid Docs](https://www.twilio.com/docs/sendgrid/api-reference/webhooks/get-all-event-webhooks) — fetched this session; confirms `GET .../settings/all`, `max_allowed` field
- [Update an Event Webhook | Twilio/SendGrid Docs](https://www.twilio.com/docs/sendgrid/api-reference/webhooks/update-an-event-webhook) — fetched this session; confirms `PATCH /v3/user/webhooks/event/settings/{id}`
- [Event Webhook Reference | Twilio/SendGrid Docs](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event) — fetched this session; exact field shapes per event type, hard/soft bounce `type` field distinction, dropped-event reason strings
- npm registry (`npm view @sendgrid/eventwebhook version`/`time.modified`/`repository.url`) — direct package metadata, fetched this session
- `gsd-tools query package-legitimacy check --ecosystem npm @sendgrid/eventwebhook` — OK verdict, fetched this session
- This repository's own source (read this session): `packages/db/src/schema/{sends,contacts,events,campaigns,sendgrid-keys,suppressions}.ts`, `packages/db/migrations/{0007,0010,0015}*.sql`, `packages/tenant-context/src/index.ts`, `packages/kms/src/client.ts`, `packages/delivery-core/src/send-mail.ts`, `apps/api/src/modules/tenancy/{sendgrid-client,sendgrid-key}.ts`, `apps/api/src/modules/delivery/unsubscribe.routes.ts`, `apps/api/src/server.ts`, `apps/worker/src/{server,queues/{connection,events-ingest.worker,send-dispatch}}.ts`, `packages/shared-schemas/src/queues.ts`

### Secondary (MEDIUM confidence)
- Project's own `.planning/research/{PITFALLS,STACK,ARCHITECTURE}.md` (2026-07-03) — Pitfall #2/#3/#5/#7/#8, dual-queue/priority patterns, Postgres-as-truth architecture, storage model precedent for `email_events`/`sends`
- [SendGrid API Key permissions scope names for webhook settings](https://gist.github.com/derrickreimer/fe666d7a14e0d9783c9f83e0233c6fe0) — cross-checked search result referencing `user.webhooks.event.settings.read`/`.update`; not independently confirmed against a live `/v3/scopes` response this session (see Assumption A2)

### Tertiary (LOW confidence)
- WebSearch-only synthesis on exact CREATE endpoint path (`POST /v3/user/webhooks/event/settings` vs `.../settings/all`) — see Assumption A3, flagged for a live smoke-test before implementation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — single new dependency, official first-party package, version/publisher verified via npm registry and `gsd-tools` legitimacy check
- Architecture: MEDIUM-HIGH — data model and queue design directly extend this project's own already-implemented Phase 2/4 patterns (proven precedent, not novel); the exact SendGrid provisioning endpoint path (Assumption A3) is the one open technical gap
- Pitfalls: HIGH — the two most critical pitfalls (raw-body verification, per-event dedup) were already identified and documented in this project's own prior research (PITFALLS.md #2/#3) before this session began, and this session's fetch of official SendGrid docs directly confirms the exact mechanics needed to avoid them

**Research date:** 2026-07-08
**Valid until:** 2026-08-07 (30 days — SendGrid's webhook API surface is stable, but the one unconfirmed endpoint path (Assumption A3) should be re-verified at implementation time regardless of this window)
