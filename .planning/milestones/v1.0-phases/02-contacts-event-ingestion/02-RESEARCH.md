# Phase 2: Contacts & Event Ingestion - Research

**Researched:** 2026-07-04
**Domain:** Multi-tenant contact CRUD/CSV-import, freeform server-side event ingestion via queue, API-key auth, 3-state subscription/suppression model
**Confidence:** MEDIUM-HIGH (stack/versions verified directly against the npm registry and this repo's existing code; upsert/idempotency/queue design synthesized from official docs + established patterns, no first-party "Klaviyo-identical" source exists so some judgment calls are flagged `[ASSUMED]`)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Идентификация контакта и merge-конфликты**
- **D-01:** Email уникален внутри воркспейса: один контакт = один email (Klaviyo-модель). Уникальность и upsert детерминированы.
- **D-02:** Минимум идентификаторов — email ИЛИ external_id (хотя бы один). Контакт только с external_id валиден: копит события и свойства, но писем не получает, пока не появится email.
- **D-03:** Upsert-приоритет: сначала матч по external_id; если не найден — по email. Событие/API-вызов с НОВЫМ external_id и email существующего контакта без external_id → external_id ПРИВЯЗЫВАЕТСЯ к существующему контакту.
- **D-04:** Жёсткий конфликт (событие меняет email контакта A на адрес, занятый контактом B): событие и остальные свойства применяются к A, смена email ПРОПУСКАЕТСЯ, конфликт логируется. Ручной merge — v2.
- **D-05:** Видимость конфликтов в v1 — только структурированные серверные логи (Pino); UI-поверхность не строим.
- **D-06:** External_id из UI/CSV можно ЗАДАТЬ (при создании или если пуст), но установленный менять нельзя — якорь идентичности.
- **D-07:** Email контакта можно менять из UI с проверкой уникальности; статус подписки при смене сохраняется.
- **D-08:** Удаление контакта — реальное (контакт + события удаляются), НО unsubscribed/suppressed email остаётся в отдельном suppression-списке воркспейса: ре-импорт/ре-создание не воскрешает subscribed.

**Модель контакта: поля, свойства, статус**
- **D-09:** Стандартные поля: имя, фамилия, телефон, город, страна + теги (массив) + created/updated. Остальное — кастомные свойства (JSONB).
- **D-10:** Авто-реестр обнаруженных кастомных свойств (тип по первому появлению: string/number/bool/date), без enforcement — только подсказки для UI/CSV/сегмент-билдера.
- **D-11:** Дефолтный статус подписки при создании — subscribed для всех каналов. CSV/API могут явно передать другой статус. Suppression-список (D-08) перебивает дефолт.
- **D-12:** Ручная смена статуса в UI асимметрична: subscribed ↔ unsubscribed вручную можно; suppressed снять из UI НЕЛЬЗЯ.
- **D-13:** Список контактов: таблица с поиском (email/имя/external_id) + фильтры по статусу подписки и тегам, сортировка, пагинация. Фильтры по кастомным свойствам — не в этой фазе.
- **D-14:** Карточка контакта показывает простую ленту событий (имя + время + раскрываемый JSON) уже в этой фазе.

**CSV-импорт**
- **D-15:** Политика дубликатов — переключатель: «обновить существующие» (merge, дефолт) или «пропустить существующие».
- **D-16:** Импорт — фоновая джоба через очередь; страница показывает прогресс; масштаб 100k+ строк.
- **D-17:** Превью: первые ~20 строк с маппингом + dry-run валидация ВСЕГО файла до применения.
- **D-18:** Отчёт: сводка на экране + скачиваемый CSV ошибочных строк с колонкой «причина».
- **D-19:** В маппинге колонок можно создать НОВОЕ кастомное свойство на лету.
- **D-20:** История импортов — да; undo импорта — v2.

**API-ключи и интеграционный API**
- **D-21:** Несколько именованных API-ключей на воркспейс; Owner/Admin создаёт/отзывает независимо.
- **D-22:** Секрет показывается полностью один раз; в БД — только хеш; в списке — префикс + последние 4 символа. KMS не нужен.
- **D-23:** Без scopes в v1 — любой ключ даёт полный доступ к Event API и Contacts API; схема расширяемая (колонка scopes на будущее).
- **D-24:** Event API принимает одно событие ИЛИ батч (до ~1000) в POST /events; ответ — по-элементный статус ПРИНЯТИЯ (не финального результата обработки, см. Architecture Patterns below).

### Claude's Discretion
- Нормализация email (lowercase/trim), формат и длина external_id, формат префикса API-ключа — стандартные подходы.
- CSV: кодировки, разделители, лимит размера файла, потоковый парсинг (csv-parse по STACK.md).
- Схема таблиц, партиционирование events (по месяцу, по created_at), индексы, RLS-политики новых таблиц по паттерну Phase 1.
- Очередь: BullMQ + Redis (добавить в docker-compose), структура джоб, ретраи, идемпотентность обработки события, rate limiting Event API (@fastify/rate-limit уже в зависимостях).
- Семантика client-supplied timestamp у событий и дедупликация событий — по ресёрчу (см. Pitfall 1 below).
- UX редактора кастомных свойств в карточке контакта, валидации форм.

### Deferred Ideas (OUT OF SCOPE)
- Ручной merge двух контактов — v2 (конфликты в v1 только логируются)
- UI-поверхность для просмотра data-конфликтов — позже
- Undo/откат импорта — v2
- Scopes у API-ключей — v2, схема закладывается расширяемой
- Реестр типов событий (EVNT-V2-01) — бэклог
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-------------------|
| CONT-01 | CRUD контактов в UI | Contact schema (Standard Stack), feature-module pattern reused from `apps/web/src/features/sendgrid-key`, RHF+Zod forms |
| CONT-02 | CSV-импорт с маппингом, превью, отчётом | csv-parse streaming pattern, `imports:csv` BullMQ queue, progress-polling UI pattern (Code Examples) |
| CONT-03 | Contacts CRUD API | API-key auth pattern (onRequest hook), shared Zod schemas in `packages/shared-schemas` |
| CONT-04 | Upsert по external_id (primary) / email (fallback) | Postgres upsert-priority pattern (Architecture Patterns, Pattern 1) — Postgres cannot do this natively in one statement, documented explicitly |
| CONT-05 | Произвольные кастомные свойства, доступные сегментации | JSONB `properties` column + `workspace_property_registry` auto-discovery table (D-10) |
| EVNT-01 | Freeform события через HTTP API с API-ключом | API-key auth module (new, distinct from better-auth session auth) |
| EVNT-02 | Событие для неизвестного контакта создаёт его (upsert) | Same upsert-priority pattern as CONT-04, invoked from the async event-processing worker, not the ingestion route |
| EVNT-03 | Event API отвечает 2xx сразу, обработка асинхронна | BullMQ `events:ingest` queue + idempotent worker pattern (Pitfall 1) |
| SUBS-01 | 3-state статус подписки (subscribed/unsubscribed/suppressed) | Contact schema `subscription_status` enum + `workspace_suppressions` table (D-08) |
</phase_requirements>

## Summary

This phase introduces the project's **first asynchronous processing pipeline** (Redis + BullMQ, absent from the codebase since only Postgres exists after Phase 1) and its **first non-session authentication mechanism** (workspace-scoped API keys for server-to-server calls, distinct from better-auth's cookie sessions). Both are foundational: every later phase (segmentation's incremental recompute, flow execution, send dispatch, webhook processing) reuses the queue-worker and tenant-context pattern established here, and the Contacts/Event API auth pattern is the template for any future integration surface.

The single hardest correctness problem in this phase is **not** the CRUD itself — it's the **prioritized two-key upsert** (external_id first, email fallback, with identity-attachment and hard-conflict-logging semantics per D-03/D-04). Postgres's `INSERT ... ON CONFLICT` only resolves against **one** named constraint per statement — there is no native "try column A, else column B" upsert. This must be implemented as an explicit `SELECT ... FOR UPDATE` + branch transaction (Pattern 1 below), not a single SQL statement, and it must be **idempotent under BullMQ's at-least-once job retry guarantee** since EVNT-03 defers the actual upsert+event-write to the async worker (not the synchronous ingestion route) — a distinction from the project-level ARCHITECTURE.md's illustrative diagram, which assumed the upsert happened synchronously in the request handler. This phase's CONTEXT.md is explicit that "processing happens asynchronously through the queue," so the plan should treat contact upsert + event-row write as the payload of the async job, gated only by fast auth+shape validation in the synchronous route.

The second major finding: **the tenant-context/pool infrastructure that RLS isolation depends on currently lives only in `apps/api/src/middleware` and `apps/api/src/db.ts`** — there is no shared package a new `apps/worker` process could import. Since CONTEXT.md explicitly calls out "adding the BullMQ worker AND its process" as in-scope for this phase, the plan must either extract `withTenant`/`withTenantTransaction`/the pg `Pool` into a shared package (`packages/db` or a new `packages/tenant-context`) or accept a documented, carefully-mirrored duplication — extraction is recommended to avoid the exact drift risk PITFALLS.md Pitfall 8 warns about (two independent implementations of tenant-scoping logic).

**Primary recommendation:** Build the Event/Contacts ingestion path as: **fast synchronous route** (API-key auth via `onRequest` hook + Zod shape validation + enqueue) → **BullMQ `events:ingest` queue** → **idempotent worker** (SELECT-then-branch upsert inside `withTenantTransaction`, event row insert keyed on a server-generated UUID for `ON CONFLICT (id) DO NOTHING` safety). Extract tenant-context/pool into a shared package before the worker process is built. CSV import follows the identical queue-worker shape (`imports:csv` queue) reusing the same upsert logic.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Contact CRUD (UI) | Frontend Server (SPA) | API / Backend | Vite SPA calls Contacts API; all validation/auth/RLS enforcement lives in the API tier, not the browser |
| Contact CRUD (API) | API / Backend | Database / Storage | Fastify route + repository layer; Postgres is source of truth |
| CSV import (upload + mapping UI) | Frontend Server (SPA) | API / Backend | Column-mapping/preview UI is client-rendered; the actual parse/validate/apply work is server-side (streaming + queue) |
| CSV import (parse, upsert, report) | API / Backend | Database / Storage | Streaming parse (`csv-parse`) + BullMQ worker; never done in-browser given 100k+ row target |
| Event ingestion API | API / Backend | Queue / Async | Auth + shape validation + enqueue only; the actual upsert+write is deferred to the worker tier |
| Event upsert + storage (from event or CSV) | Queue / Async (BullMQ worker) | Database / Storage | Shared upsert logic invoked by both the event worker and the CSV import worker — must be a single function, not duplicated |
| API key issuance/revocation (management) | API / Backend | Database / Storage | Owner/Admin-gated management endpoints under session auth (existing `requirePermission`), distinct from the keys' own runtime auth path |
| API key runtime auth (Event/Contacts API) | API / Backend | — | New `onRequest` hook, separate from better-auth session middleware; resolves `workspace_id` from the key itself, not a URL slug |
| Subscription status / suppression | Database / Storage | API / Backend | `subscription_status` + `workspace_suppressions` are the durable facts; API/UI only read/mutate through the same gated paths (D-12 asymmetric edit rule) |
| Property registry auto-discovery | API / Backend | Database / Storage | Written opportunistically wherever a new property is observed (API, event worker, CSV worker, UI edit) — must be centralized as one helper, not four separate call sites |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| BullMQ | 5.79.2 | Job queue (Redis-backed) for `events:ingest` and `imports:csv` | `[VERIFIED: npm registry]` — confirmed via `npm view bullmq version`; matches project-level STACK.md (5.79.x) exactly |
| ioredis | 5.11.1 | Redis client underlying BullMQ | `[VERIFIED: npm registry]` — matches STACK.md (5.11.x) |
| csv-parse | 7.0.1 | Streaming CSV parser for import | `[VERIFIED: npm registry]` — matches STACK.md (7.0.x); stream/Transform API confirmed via official docs as the scalable choice over the sync API `[CITED: csv.js.org/parse]` |
| @fastify/multipart | 10.0.0 | Streaming multipart upload (CSV file) | `[VERIFIED: npm registry]` — matches STACK.md (10.x); wraps `busboy` for true streaming, never buffers the whole file `[CITED: github.com/fastify/fastify-multipart]` |
| @fastify/rate-limit | 11.1.0 (already a dependency) | Protects Event API from abuse/brute-force on the auth header | Already installed per `apps/api/package.json`; apply per-API-key or per-IP limit on the ingestion route |
| zod | 4.4.3 (already a dependency) | Shape validation for freeform event payloads (name + JSON), contact CRUD, CSV row schema | Already installed; explicit project decision is NOT to enforce event schemas (`Out of Scope: Строгие схемы/валидация событий`) — validate only the envelope shape (event name is a non-empty string, properties is a JSON object, size-bounded), not the properties' internal shape |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @bull-board/api + @bull-board/fastify | 8.1.0 | Queue observability UI | Recommended (per project STACK.md) but not strictly required to satisfy this phase's requirements — useful for debugging `events:ingest`/`imports:csv` depth during development; low cost to add now while the queue infra is first stood up |
| node:crypto (`randomBytes`, `createHash`, `timingSafeEqual`) | built-in | API key secret generation, SHA-256 hashing, constant-time comparison | No external package needed — Node's built-in crypto module covers the entire API-key pattern (see Code Examples) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| BullMQ | pg-boss (Postgres-only queue, no Redis) | Avoids running Redis, but caps around 100-200 jobs/sec due to `SKIP LOCKED` contention — acceptable for this phase's ingestion volume alone, but Redis is already a hard project constraint (used by later phases' rate limiting) so introducing it now (rather than deferring) avoids a second infra-migration later `[CITED: project STACK.md]` |
| SHA-256 hash for API keys | bcrypt/argon2 | Password hashing algorithms are deliberately slow (defense against low-entropy brute force); API keys are high-entropy random secrets (256 bits), so a slow hash only adds latency to every request without a corresponding security benefit — SHA-256 is the documented standard for this specific case (Stripe/GitHub-style) `[CITED: web research, see Sources]` |
| Application-level SELECT-then-branch upsert | Postgres 15+ `MERGE` statement | `MERGE` offers more expressive conditional matching in one statement, but still cannot natively express "try constraint A, else constraint B" without repeating the same branching logic in SQL — no meaningful simplification for this specific two-key-priority case; the imperative version is easier to unit-test and log conflicts from (D-05) `[ASSUMED — no first-party Klaviyo/Postgres source addresses this exact two-key-priority upsert shape]` |

**Installation:**
```bash
npm install bullmq ioredis --workspace apps/api --workspace apps/worker
npm install csv-parse @fastify/multipart --workspace apps/api
npm install @bull-board/api @bull-board/fastify --workspace apps/api
```

**Version verification:** Confirmed live via `npm view <pkg> version` on 2026-07-04:
- `bullmq@5.79.2` (published 2026-06-27)
- `ioredis@5.11.1` (published 2026-06-04)
- `rate-limiter-flexible@11.2.0` (published 2026-06-08) — not needed until Phase 4/6's per-tenant RPS throttle, not this phase
- `csv-parse@7.0.1` (published 2026-07-02)
- `@fastify/multipart@10.0.0` (published 2026-04-07)
- `@bull-board/api@8.1.0` / `@bull-board/fastify@8.1.0` (published 2026-07-02)

All match the project-level `STACK.md` version ranges exactly — no drift since that research was done (2026-07-03).

## Package Legitimacy Audit

| Package | Registry | Age (last publish) | Downloads/wk | Source Repo | Verdict | Disposition |
|---------|----------|---------------------|--------------|--------------|---------|-------------|
| bullmq | npm | 2026-06-27 (recent version bump) | 6.4M | github.com/taskforcesh/bullmq | SUS (`too-new`) | **Approved** — see rationale below |
| ioredis | npm | 2026-06-04 | 21.6M | github.com/luin/ioredis | SUS (`too-new`) | **Approved** |
| rate-limiter-flexible | npm | 2026-06-08 | 2.6M | github.com/animir/node-rate-limiter-flexible | SUS (`too-new`) | **Approved** (not installed this phase; flagged for Phase 4/6) |
| @bull-board/api | npm | 2026-07-02 | 1.6M | github.com/felixmosh/bull-board | SUS (`too-new`) | **Approved** |
| @bull-board/fastify | npm | 2026-07-02 | 174K | github.com/felixmosh/bull-board | SUS (`too-new`) | **Approved** |
| csv-parse | npm | 2026-07-02 | 15.1M | github.com/adaltas/node-csv | SUS (`too-new`) | **Approved** |
| @fastify/multipart | npm | 2026-04-07 | 1.8M | github.com/fastify/fastify-multipart | OK | Approved |

**Rationale for overriding the `SUS`/`too-new` verdicts above:** the automated legitimacy check's `too-new` signal fires on the **most recent published version's timestamp**, not the package's overall age — every package above has a multi-year history, an official/well-known GitHub org, and weekly download counts in the hundreds of thousands to tens of millions, which are strong independent legitimacy signals a slopsquatted or hallucinated package cannot fake. All seven names were also cross-checked against this project's own pre-existing `STACK.md` (written 2026-07-03, itself sourced from direct npm registry metadata plus official docs), which independently recommends the same packages at the same version ranges. Per protocol, these remain tagged `SUS` in this table and the planner should still gate the very first `npm install` of `bullmq`/`ioredis`/`@bull-board/*`/`csv-parse` behind a lightweight `checkpoint:human-verify` (confirm `package.json` after install matches the versions above) rather than skip verification entirely — the cost of one extra check is low and the automated signal, while a false positive here, should not be silently discarded as a matter of process.

**Packages removed due to `SLOP` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** bullmq, ioredis, rate-limiter-flexible, @bull-board/api, @bull-board/fastify, csv-parse — all approved above with rationale; planner should still add one `checkpoint:human-verify` at first install.

## Architecture Patterns

### System Architecture Diagram

```
                    ┌───────────────────────────────────────────┐
                    │              apps/web (SPA)                │
                    │  Contact CRUD forms · CSV upload/mapping/  │
                    │  preview UI · API key management UI        │
                    └───────────────────┬─────────────────────────┘
                                        │ session cookie (better-auth)
                                        ▼
┌──────────────────────────── apps/api (Fastify) ─────────────────────────────┐
│                                                                                │
│  Session-authed routes (existing pattern)         API-key-authed routes (NEW) │
│  ┌────────────────────────────┐                  ┌──────────────────────────┐│
│  │ Contacts UI-facing routes  │                  │ POST /v1/contacts (CRUD) ││
│  │ (CRUD, list, timeline)     │                  │ POST /v1/events (single  ││
│  │ CSV import upload/status   │                  │  or batch, ~1000 max)    ││
│  │ API-key management (CRUD)  │                  │ onRequest: resolve       ││
│  └──────────────┬─────────────┘                  │ workspace_id FROM KEY,   ││
│                 │                                 │ not from a :slug param   ││
│                 │ synchronous, RLS-scoped          └──────────┬───────────────┘│
│                 ▼                                             │ validate shape │
│         Postgres (contacts, workspace_suppressions,            │ (Zod), enqueue,│
│         workspace_property_registry, workspace_api_keys,        │ return 2xx     │
│         csv_imports)                                            ▼                │
│                                                        BullMQ: events:ingest      │
└────────────────────────────────────────────────────────────┬────────────────────┘
                                                               │
                    ┌──────────────────────────────────────────┘
                    ▼
        ┌───────────────────── apps/worker (NEW, separate process) ─────────────────┐
        │  events:ingest worker              imports:csv worker                      │
        │  - re-derive workspace_id from      - stream file → csv-parse → map →      │
        │    job.data (never trust ambient)     validate → batch upsert              │
        │  - withTenantTransaction:            - same upsert-priority function as    │
        │    upsert-priority (Pattern 1)         events:ingest worker                │
        │  - INSERT events row                 - update csv_imports progress row     │
        │    ON CONFLICT (id) DO NOTHING          incrementally for polling UI        │
        │    (idempotency, Pitfall 1)                                                │
        └──────────────────────────┬──────────────────────────────────────────────────┘
                                    ▼
                        Postgres (contacts, events — partition-ready by month)
```

A reader tracing "tenant backend posts an event" follows: `POST /v1/events` (API-key auth, shape validation only) → enqueue → `events:ingest` worker (re-reads `job.data`, opens a tenant transaction, runs the upsert-priority logic, writes the event row idempotently) → Postgres. The UI's contact-timeline read (D-14) queries the same `events` table synchronously through the session-authed route — it never talks to the queue.

### Recommended Project Structure

```
apps/
├── api/src/modules/
│   ├── contacts/            # NEW: contact CRUD (UI + API), CSV import orchestration, upsert-priority logic
│   │   ├── contact.repository.ts       # shared upsert function — called by both event worker and CSV worker
│   │   ├── contacts.routes.ts          # session-authed UI routes
│   │   ├── contacts-api.routes.ts      # API-key-authed integration routes (CONT-03)
│   │   ├── csv-import.routes.ts        # upload, mapping preview, status polling, error-report download
│   │   └── property-registry.ts        # single helper for D-10 auto-discovery, called from all write paths
│   ├── events/              # NEW: event ingestion route + queue producer
│   │   └── events-api.routes.ts
│   └── api-keys/            # NEW: key issuance/revocation (session-authed, Owner/Admin) + the onRequest auth plugin
│       ├── api-keys.routes.ts
│       └── api-key-auth.ts             # onRequest hook, resolves workspace_id from the key
└── worker/                  # NEW app — separate long-running process
    └── src/
        ├── queues/events-ingest.worker.ts
        ├── queues/imports-csv.worker.ts
        └── server.ts        # boots BullMQ Workers, no HTTP server

packages/
├── db/src/schema/
│   ├── contacts.ts          # contacts, workspace_suppressions, workspace_property_registry
│   ├── events.ts            # events (partitioned by month on occurred_at/received_at)
│   ├── api-keys.ts          # workspace_api_keys
│   └── csv-imports.ts       # csv_imports (history, D-20)
├── tenant-context/          # NEW shared package — extracted from apps/api/src/middleware + db.ts
│   └── src/index.ts         # withTenant, withTenantTransaction, pool — imported by BOTH apps/api and apps/worker
└── shared-schemas/src/
    ├── contact.ts           # Zod schemas: contact CRUD, CSV row shape
    ├── event.ts             # Zod schema: event envelope (name + properties), batch wrapper
    └── api-key.ts           # Zod schemas: create/list/revoke
```

### Structure Rationale

- **`packages/tenant-context/` extraction is the single most consequential structural decision in this phase.** Today, `withTenant`/`withTenantTransaction`/the pg `Pool` live only in `apps/api/src/middleware/tenant-context.ts` and `apps/api/src/db.ts` — files a new `apps/worker` process cannot import without either a monorepo path reach-across (fragile, couples worker to api's internal layout) or duplicating the logic (Pitfall-8-adjacent drift risk: two independently-maintained implementations of the exact mechanism that prevents cross-tenant leaks). Extracting before the worker is built is far cheaper than fixing a drifted duplicate later.
- **`apps/worker` as a separate process, not an in-process BullMQ `Worker` inside `apps/api`:** CONTEXT.md's own wording ("Добавление Redis-сервиса, BullMQ-воркера **и его процесса**") explicitly scopes a separate process as part of this phase, matching project ARCHITECTURE.md's `workers/` deployed-separately recommendation and preventing event/CSV processing from ever competing with the low-latency ingestion API for CPU/event-loop time.
- **One shared `contact.repository.ts` upsert function**, called from three places (Contacts API route for direct upsert, `events:ingest` worker for EVNT-02, `imports:csv` worker for CSV row processing) — if this logic is duplicated across those three call sites, D-03/D-04's conflict semantics will inevitably drift between them (exactly the class of bug PITFALLS.md warns about for suppression enforcement, generalized to upsert logic).
- **`property-registry.ts` as one centralized helper**, not four separate "insert into registry if new" call sites (UI edit, CSV import, event properties, API contact create) — same drift-avoidance reasoning as above.

### Pattern 1: Prioritized two-key upsert (external_id first, email fallback) — SELECT-then-branch, not a single INSERT

**What:** Postgres's `INSERT ... ON CONFLICT` resolves against exactly one named unique constraint per statement `[CITED: PostgreSQL wiki UPSERT page, wiki.postgresql.org/wiki/UPSERT]`. There is no native way to express "try matching `external_id`, and only if that misses, try `email`" in one statement. The correct implementation is an explicit transaction: `SELECT ... FOR UPDATE` by `external_id` first, then by `email`, branching in application code to INSERT, UPDATE, or the D-03 "attach external_id" / D-04 "log and skip email change" cases.
**When to use:** Any upsert where priority differs between two nullable, independently-unique identifying columns — this project's contact identity model specifically (D-01 through D-04).
**Trade-offs:** More round-trips than a single `ON CONFLICT` statement, and a `SELECT FOR UPDATE` row lock is held for the duration of the branch logic — acceptable at this project's event-ingestion volume (single-contact-scoped lock, not table-wide), and necessary for correctness given D-04's conflict-detection requirement (you cannot log "email already taken by contact B" from inside a bare `ON CONFLICT DO UPDATE`).

**Example:**
```typescript
// apps/api/src/modules/contacts/contact.repository.ts
// Called from: Contacts API route, events:ingest worker, imports:csv worker.
// Must run inside withTenantTransaction — see packages/tenant-context.
export async function upsertContactByIdentity(
  client: PoolClient,
  workspaceId: string,
  input: { externalId?: string; email?: string; properties?: Record<string, unknown> }
): Promise<{ contactId: string; emailChangeSkipped?: boolean }> {
  // D-02: caller must have validated at least one of externalId/email is present
  // before this function is invoked.

  let existing: { id: string; external_id: string | null; email: string | null } | undefined;

  if (input.externalId) {
    const byExternalId = await client.query(
      `SELECT id, external_id, email FROM contacts
       WHERE workspace_id = $1 AND external_id = $2 FOR UPDATE`,
      [workspaceId, input.externalId]
    );
    existing = byExternalId.rows[0];
  }

  let attachExternalId = false;
  if (!existing && input.email) {
    const byEmail = await client.query(
      `SELECT id, external_id, email FROM contacts
       WHERE workspace_id = $1 AND email = $2 FOR UPDATE`,
      [workspaceId, input.email]
    );
    existing = byEmail.rows[0];
    // D-03: matched by email, no external_id on file yet, incoming call has
    // one -> attach it as the new identity anchor.
    if (existing && !existing.external_id && input.externalId) {
      attachExternalId = true;
    }
  }

  if (!existing) {
    // Neither identifier matched -> new contact.
    // A concurrent insert racing on the same email is still possible between
    // the SELECT above and this INSERT; catch the unique-violation and retry
    // once as an UPDATE path (standard optimistic-upsert defense-in-depth).
    const inserted = await client.query(
      `INSERT INTO contacts (workspace_id, external_id, email, properties, subscription_status)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [workspaceId, input.externalId ?? null, input.email ?? null, input.properties ?? {}, /* D-11/D-08 */ "subscribed"]
    );
    return { contactId: inserted.rows[0].id };
  }

  // D-04: incoming email belongs to a DIFFERENT contact than the one matched
  // by external_id -> skip the email change, log structured conflict, still
  // apply other properties.
  const emailBelongsToAnotherContact =
    input.email && existing.email && input.email !== existing.email
      ? await client
          .query(`SELECT id FROM contacts WHERE workspace_id = $1 AND email = $2 AND id != $3`, [
            workspaceId,
            input.email,
            existing.id,
          ])
          .then((r) => r.rows.length > 0)
      : false;

  await client.query(
    `UPDATE contacts SET
       external_id = COALESCE(external_id, $2),
       email = CASE WHEN $3 THEN email ELSE COALESCE($4, email) END,
       properties = properties || $5,
       updated_at = now()
     WHERE id = $1`,
    [
      existing.id,
      attachExternalId ? input.externalId : null,
      emailBelongsToAnotherContact,
      emailBelongsToAnotherContact ? null : input.email,
      input.properties ?? {},
    ]
  );

  return { contactId: existing.id, emailChangeSkipped: emailBelongsToAnotherContact };
}
```

### Pattern 2: BullMQ worker never trusts job payload as sole truth — re-derive tenant context and idempotency key

**What:** Every job handed to the `events:ingest`/`imports:csv` workers must (a) carry `workspaceId` explicitly in `job.data` and use it to open a fresh `withTenantTransaction` (never rely on any ambient/ALS state left over from the producing request — the worker is a different process), and (b) carry a server-generated, deterministic `eventId` (UUID generated at ingestion time, before enqueue) that the worker uses both as the BullMQ `jobId` (dedupes retries within BullMQ's own retention window) and as the `events.id` primary key with `INSERT ... ON CONFLICT (id) DO NOTHING` (a durable, DB-level safety net if the same job is ever redelivered outside BullMQ's own dedup window — e.g. after a Redis restart during Anti-Pattern-1-style recovery).
**When to use:** Any job whose execution has a durable side effect (contact upsert, event write, future send dispatch) — BullMQ provides at-least-once delivery, never exactly-once `[CITED: docs.bullmq.io/patterns/idempotent-jobs]`.
**Trade-offs:** Requires generating and threading an id through the synchronous route → queue → worker path, and requires per-item structured acceptance responses to only mean "validated and queued," not "processed" — this must be communicated clearly in the Event API's response contract (D-24) so tenant integrators do not mistake 2xx-with-per-item-status for confirmation that the contact was actually created/updated yet.

**Example:**
```typescript
// apps/api/src/modules/events/events-api.routes.ts (synchronous route)
import { randomUUID } from "node:crypto";

fastify.post("/v1/events", { onRequest: apiKeyAuth }, async (request, reply) => {
  const workspaceId = request.apiKeyWorkspaceId; // set by apiKeyAuth hook
  const items = parseEventBatch(request.body); // Zod: array of { name, properties, occurredAt? }, max ~1000

  const results = await Promise.all(
    items.map(async (item) => {
      const eventId = randomUUID(); // generated NOW, before enqueue -- this IS the idempotency key
      await eventsIngestQueue.add(
        "ingest-event",
        { workspaceId, eventId, ...item },
        { jobId: eventId } // BullMQ-level dedup if the same id is ever added twice
      );
      return { eventId, status: "accepted" }; // NOT "processed" -- see Pattern 2 trade-offs
    })
  );

  return reply.code(202).send({ results });
});
```

```typescript
// apps/worker/src/queues/events-ingest.worker.ts
new Worker(
  "events:ingest",
  async (job: Job<{ workspaceId: string; eventId: string; name: string; properties: unknown; occurredAt?: string }>) => {
    const { workspaceId, eventId, name, properties, occurredAt } = job.data;
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { contactId } = await upsertContactByIdentity(client, workspaceId, job.data /* externalId/email */);
        await client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at, received_at)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), now())
           ON CONFLICT (id) DO NOTHING`,
          [eventId, workspaceId, contactId, name, properties, occurredAt ?? null]
        );
      })
    );
  },
  { connection: redisConnection }
);
```

### Pattern 3: API-key runtime authentication via `onRequest`, resolving `workspace_id` from the key itself

**What:** Unlike every existing route (session-cookie + `:slug` param resolved to an `organizationId` via `findActiveWorkspaceBySlug`), the Event/Contacts integration API has no URL slug — the tenant is identified entirely by which API key was presented. An `onRequest` hook (runs before body parsing, appropriate for a header-only credential check `[CITED: Fastify hooks docs / community pattern]`) extracts the key, looks it up by a non-secret indexed prefix, verifies the secret's hash with `crypto.timingSafeEqual`, and decorates the request with the resolved `workspaceId` for the route handler to use.
**When to use:** Any server-to-server integration endpoint where the caller does not have (and should not need) an interactive session.
**Trade-offs:** A second, parallel auth mechanism to session cookies means two code paths must both stay correct — mitigate by keeping this hook small, well-tested in isolation, and scoped only to `/v1/*` integration routes (register it on a dedicated Fastify plugin scope, never globally).

**Example:**
```typescript
// apps/api/src/modules/api-keys/api-key-auth.ts
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export function generateApiKey() {
  const id = randomBytes(8).toString("hex"); // non-secret, indexed lookup key
  const secret = randomBytes(32).toString("base64url"); // 256 bits entropy
  const fullKey = `mcrm_${id}.${secret}`; // shown to the user exactly once (D-22)
  const secretHash = createHash("sha256").update(secret).digest("hex"); // stored, never the raw secret
  const keyMask = `mcrm_${id.slice(0, 4)}...${secret.slice(-4)}`; // list-display (D-22)
  return { fullKey, id, secretHash, keyMask };
}

export async function apiKeyAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization; // "Bearer mcrm_<id>.<secret>"
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const [prefix, secret] = token?.split(".") ?? [];
  const id = prefix?.replace("mcrm_", "");
  if (!id || !secret) return reply.code(401).send({ error: "Missing or malformed API key" });

  const row = await lookupApiKeyById(id); // indexed lookup, O(1) -- not a scan over all keys
  if (!row || row.revokedAt) return reply.code(401).send({ error: "Invalid API key" });

  const providedHash = Buffer.from(createHash("sha256").update(secret).digest("hex"));
  const storedHash = Buffer.from(row.secretHash);
  if (providedHash.length !== storedHash.length || !timingSafeEqual(providedHash, storedHash)) {
    return reply.code(401).send({ error: "Invalid API key" });
  }

  request.apiKeyWorkspaceId = row.workspaceId; // route handlers/queue producers read this
}
```

### Anti-Patterns to Avoid

- **Single SQL `ON CONFLICT` statement attempting both external_id and email matching:** Postgres cannot express this; attempting to force it via clever `WHERE` clauses on a single conflict target silently produces wrong results for the D-03 attach-identity case. Use Pattern 1's explicit branch.
- **Treating the Event API's 2xx response as confirmation of contact creation:** D-24's "per-element acceptance status" means "validated and queued," not "processed" — documenting this precisely in the API contract (and to the planner) avoids a class of tenant-integration confusion and support tickets ("I got a 200 but the contact isn't there yet").
- **Duplicating `withTenant`/`withTenantTransaction` in `apps/worker` instead of extracting to a shared package:** guarantees eventual drift between the API's and worker's tenant-scoping implementations — exactly Pitfall 8's cross-tenant-leak risk, generalized to a second process.
- **Hashing API-key secrets with bcrypt/argon2:** wasted CPU on every single API request for no security benefit given the secret's already-high entropy; use SHA-256 (see Alternatives Considered).
- **Validating the *contents* of event `properties`:** explicitly out of scope per project decision ("Строгие схемы/валидация событий" is excluded) — only validate the envelope (event name present, properties is a JSON object, total payload size bounded) to prevent abuse, not the freeform shape itself.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Streaming large CSV files without loading them fully into memory | A custom line-by-line file reader/splitter | `csv-parse`'s stream/Transform API piped from `@fastify/multipart`'s `data.file` stream | Handles quoting, escaping, encodings (BOM), and backpressure correctly; a hand-rolled splitter will break on quoted commas/newlines in real-world exported CSVs |
| Job retry/backoff/priority scheduling | A custom setTimeout-based retry loop or DB-polling scheduler | BullMQ (`attempts`, backoff functions, `UnrecoverableError`) | Already the project's chosen job-queue; reinventing retry semantics duplicates a well-tested library and reintroduces Anti-Pattern 1 from project PITFALLS.md (in-process timers losing state on restart) |
| API key secret comparison | String `===` comparison | `crypto.timingSafeEqual` on the hashed value | Plain string comparison leaks timing information proportional to how many leading bytes match — a documented, exploitable side channel for secret comparison |
| CSV column type inference / property registry | A bespoke type-guessing engine per import | The single `property-registry.ts` helper (D-10: observed type on first sight, no enforcement) shared across all four write paths | Four independent implementations of "guess this looks like a date" will disagree with each other; centralize once |
| Table partitioning automation | A custom cron script that creates next month's `events` partition | Native Postgres declarative partitioning (`CREATE TABLE events_2026_08 PARTITION OF events FOR VALUES FROM (...) TO (...)`) driven by a scheduled migration/maintenance job, optionally later upgraded to `pg_partman`'s `run_maintenance_proc` | Declarative partitioning is a first-class Postgres 10+ feature; `pg_partman` is the well-tested automation layer on top of it if/when the extension is available in the hosting environment — don't reimplement its partition-creation logic from scratch `[CITED: crunchydata.com/blog, github.com/pgpartman/pg_partman]` |

**Key insight:** every "don't hand-roll" item above already has a project-approved library or a native Postgres feature; the only genuinely novel logic this phase must write by hand is the prioritized two-key upsert (Pattern 1) — because no existing library encodes this project's specific D-01 through D-04 identity rules, and that is exactly why it needs the most test coverage.

## Common Pitfalls

### Pitfall 1: Event/import processing job re-runs and double-writes because idempotency wasn't designed in from the first worker

**What goes wrong:** A worker crashes or times out after the contact upsert commits but before the job is acknowledged; BullMQ redelivers the job; the event row (or, worse, a property-registry insert, or a tags-array append) is applied a second time.
**Why it happens:** BullMQ is at-least-once by contract `[CITED: docs.bullmq.io/patterns/idempotent-jobs]` — this is not a bug to fix, it's a guarantee to design around. It's easy to build the happy path first and add idempotency later, but this project's own PITFALLS.md documents this exact failure mode (there generalized to sends) as something that "must be architected in from the first version of the worker, not retrofitted."
**How to avoid:** Server-generate the `eventId` (UUID) synchronously in the ingestion route, before enqueue; use it as both the BullMQ `jobId` and the `events.id` primary key with `ON CONFLICT (id) DO NOTHING` (Pattern 2). For CSV import, the analogous key is `(csv_import_id, row_number)` — make it a unique constraint on the staging/error-report table so a redelivered chunk-processing job is a safe no-op.
**Warning signs:** Duplicate rows in `events` for what should be one client-side event; a contact's tags array containing the same tag twice after a retried CSV batch.

### Pitfall 2: The prioritized upsert's "attach external_id" and "hard conflict" branches are undertested because the happy path (simple create) looks done first

**What goes wrong:** D-03's identity-attachment case (email match with NULL external_id + incoming external_id) and D-04's hard-conflict case (email belongs to a different contact) are the least-frequently-hit code paths in manual testing, but they are the entire reason this upsert can't be a single `ON CONFLICT` statement. A plan that only writes a happy-path "create new contact" test will look done while silently mishandling onboarding traffic (D-03's explicit stated scenario: "сшивка CSV-базы с боевым трафиком, классический онбординг тенанта").
**Why it happens:** These branches require deliberately constructing pre-existing contact rows in specific partial states before exercising the upsert — more setup than a straightforward create test, so they're the ones skipped under time pressure.
**How to avoid:** The plan's verification steps must include explicit test cases for: (a) external_id match, (b) email match with no external_id → attach, (c) email match with a *different* pre-existing external_id already set → per this research's interpretation (see Open Questions), and (d) email collision with a second contact → log-and-skip email change (D-04).
**Warning signs:** No test file exercises "contact exists with email only, event arrives with both email and a new external_id."

### Pitfall 3: Body-parsing/streaming interaction breaks either the CSV upload or the API-key header check

**What goes wrong:** Registering `@fastify/multipart` globally (rather than scoped to the CSV upload route) can interfere with the global JSON body parser used by every other route; conversely, the API-key `onRequest` hook must run and complete *before* Fastify's content-type-based body parsing kicks in for the Event/Contacts API routes, since those bodies can be large batches (~1000 events) and unauthenticated large-JSON parsing is itself a DoS vector.
**Why it happens:** This project's own project-level PITFALLS.md documents an adjacent but structurally similar bug class (SendGrid webhook signature verification breaking due to body-parser ordering) — the same "hook/middleware ordering matters" lesson applies here even though there's no signature to verify in this phase.
**How to avoid:** Register `@fastify/multipart` as a route-scoped plugin only on the CSV upload route (Fastify's plugin encapsulation makes this natural — don't call `fastify.register(multipart)` at the root). Use `onRequest` (not `preHandler`) for the API-key check so it runs before Fastify's body parsing occurs at all `[CITED: Fastify hooks lifecycle docs]`.
**Warning signs:** CSV upload works in isolation but breaks JSON parsing on unrelated routes once both are registered; API-key auth failures only reproduce with large request bodies, not small test payloads.

### Pitfall 4: Freeform JSONB `properties`/custom-property registry becomes an unbounded-growth or mass-assignment vector

**What goes wrong:** Since events and contact properties are explicitly freeform (project decision: no schema enforcement), a malicious or buggy tenant integration can (a) send an enormous number of distinct property keys, bloating the `workspace_property_registry` and JSONB storage indefinitely, or (b) send a property key that collides with a *reserved* internal field name (e.g. `subscription_status`, `id`, `workspace_id`) that, if naively merged via `properties || $incoming` into the wrong column, could corrupt platform-managed state.
**Why it happens:** "No schema enforcement" is correctly interpreted as "don't validate the *shape* of tenant-supplied properties," but is sometimes over-applied to also skip basic *size* and *reserved-key* bounds, which are an operational/security concern, not a schema-enforcement one.
**How to avoid:** Enforce a request-level size cap on the total JSON payload (via Fastify's body-limit config) and a reasonable cap on distinct property-registry entries per workspace (e.g., log/alert past a threshold, don't hard-block at this phase, but don't build the registry table without an index that would degrade gracefully). Explicitly reject/strip reserved top-level keys before merging into `contacts.properties` — properties should always be written into their own JSONB column, never string-templated into a raw `UPDATE contacts SET x = y` — the parameterized-query pattern already used in this codebase (see `sendgrid-key.repository.ts`) naturally prevents SQL injection here; the residual risk is purely "which JSON keys are allowed to reach which columns," an application-logic concern.
**Warning signs:** No test verifies that a property literally named `subscription_status` in an event payload cannot silently flip a contact's subscription state.

## Code Examples

### Contact schema (Drizzle)
```typescript
// packages/db/src/schema/contacts.ts
// Source: pattern established by sendgrid-keys.ts (this repo, Phase 1)
import { pgTable, text, timestamp, uuid, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

export const subscriptionStatusEnum = pgEnum("subscription_status", [
  "subscribed",
  "unsubscribed",
  "suppressed",
]);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    externalId: text("external_id"), // D-06: settable once, immutable after
    email: text("email"), // D-07: editable with uniqueness check
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    city: text("city"),
    country: text("country"),
    tags: text("tags").array().notNull().default([]),
    properties: jsonb("properties").notNull().default({}), // D-09/D-10 custom properties
    subscriptionStatus: subscriptionStatusEnum("subscription_status").notNull().default("subscribed"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Postgres treats multiple NULLs as distinct by default -- these plain
    // UNIQUE constraints correctly allow many external_id-only or
    // email-only contacts without a partial-index workaround.
    { externalIdUnique: unique().on(t.workspaceId, t.externalId) },
    { emailUnique: unique().on(t.workspaceId, t.email) },
  ]
);
```

### Events table (partition-ready)
```sql
-- packages/db/migrations/000X_events_table.sql
-- Source: pattern from project ARCHITECTURE.md's Storage Model + STACK.md partitioning guidance
CREATE TABLE events (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at) -- partition key must be part of the PK/unique constraints
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_07 PARTITION OF events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
-- Subsequent months created by a scheduled migration/maintenance job (see
-- Don't Hand-Roll: pg_partman is the standard automation layer if adopted).

CREATE INDEX idx_events_workspace_contact_time ON events (workspace_id, contact_id, occurred_at);
CREATE INDEX idx_events_workspace_name_time ON events (workspace_id, name, occurred_at);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `reactflow` npm package | `@xyflow/react` | Package rebrand, last `reactflow` publish June 2024 | Not directly used in this phase (flow canvas is Phase 6), but noted since `apps/web` will eventually depend on it — don't let a future phase accidentally install the stale name |
| BullMQ group-key rate limiting (OSS) | Removed in BullMQ v3+, requires app-level `rate-limiter-flexible` or BullMQ Pro | BullMQ v3 (documented in project STACK.md) | Not needed this phase (no per-tenant rate limiting requirement yet — only Event API abuse protection via `@fastify/rate-limit`), but the worker/queue foundation built here is what Phase 4/6 extends with `rate-limiter-flexible` |

**Deprecated/outdated:** none specific to this phase's own scope beyond the two carried-forward notes above.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | When an event/API call matches an existing contact by email (external_id absent or non-matching) and that existing contact **already has a different external_id set**, the incoming external_id is ignored (external_id is immutable per D-06) and only email-collision-adjacent handling applies — not explicitly covered by D-03/D-04. | Architecture Patterns Pattern 1, Common Pitfalls Pitfall 2 | If wrong, a tenant's onboarding event stream with inconsistent external_ids could either silently reassign identity anchors (violating D-06) or throw unhandled errors; needs explicit confirmation before planning locks the upsert branch logic |
| A2 | `apps/worker` should be built as a new sibling npm workspace (separate `package.json`, separate long-running process), not an in-process BullMQ `Worker` started inside `apps/api`. | Architecture Patterns, Recommended Project Structure | If the team actually wants an in-process worker for MVP simplicity (deferring the separate-process split to a later phase), the `packages/tenant-context` extraction is still correct but the deployment/dev-script wiring in the plan would need to change |
| A3 | API key format `mcrm_<8-byte-hex-id>.<32-byte-base64url-secret>`, with the `id` portion used for O(1) indexed lookup before hash comparison. | Architecture Patterns Pattern 3, Code Examples | Low risk — this is a well-established pattern (Stripe/GitHub-style), but the exact prefix string (`mcrm_`) and separator character are this research's own choice, not dictated by CONTEXT.md (which left "формат префикса API-ключа" to discretion) |
| A4 | Postgres `MERGE` (PG15+) is not meaningfully simpler than the SELECT-then-branch pattern for this project's specific two-key-priority upsert. | Standard Stack, Alternatives Considered | Low risk to the plan either way — both approaches require the same branching logic; if wrong, only affects code style, not correctness |
| A5 | A monthly-partition-creation cron/migration job (manual) is an acceptable MVP substitute for `pg_partman` if that extension isn't available in the hosting Postgres instance. | Don't Hand-Roll | If the hosting Postgres (managed service) doesn't allow arbitrary extensions AND doesn't include `pg_partman`, the plan needs an explicit "create next month's partition" scheduled task — flagged here so it isn't missed |

**If this table is empty:** N/A — see entries above; all other technical claims in this document are `[VERIFIED: npm registry]` (versions) or `[CITED: <source>]` (patterns from official docs).

## Open Questions

1. **Email-collision-with-existing-different-external_id branch (see A1)**
   - What we know: D-03 covers "email match, no external_id yet, incoming has one → attach." D-04 covers "incoming event's *email* change collides with a different existing contact's email → skip email change, log conflict."
   - What's unclear: what happens when the incoming *external_id* doesn't match anything, but the email match lands on a contact that **already has a different external_id**. This is neither D-03's attach case (external_id slot isn't empty) nor cleanly D-04's case (D-04 is about email collisions, not external_id collisions).
   - Recommendation: treat as "external_id in the incoming call is ignored (D-06: immutable anchor), proceed with the rest of the update as normal, log a structured conflict entry analogous to D-04/D-05" — surface this interpretation to the user during `/gsd-discuss-phase` follow-up or plan review before locking Pattern 1's implementation, since it's a genuine gap in the locked decisions, not a discretion area.

2. **Should the Event API's per-item response include a distinguishable "duplicate `eventId`" status?**
   - What we know: D-24 specifies per-element acceptance status for a batch. Pattern 2 generates `eventId` server-side per item, so a tenant cannot supply their own idempotency key today.
   - What's unclear: whether tenants need a way to supply their own dedup key (e.g., their own order-confirmation event ID) so retried *their-side* HTTP calls to `/v1/events` don't create duplicate events — server-generated `eventId` alone only protects against *this platform's* queue retries, not the tenant's own retried HTTP POSTs.
   - Recommendation: out of scope for v1 per this phase's requirements (EVNT-01 says "без предварительной регистрации типов," not "with client dedup keys"), but flag for the planner as a natural, cheap addition — accepting an optional client-supplied `event_id` in the payload (falling back to server-generated if absent) would close this gap with minimal extra work, since Pattern 2's `ON CONFLICT (id) DO NOTHING` already makes the id the natural place to plug it in.

3. **CSV import worker's file storage location between upload and streaming parse**
   - What we know: `@fastify/multipart` streams the upload; `csv-parse`'s stream API should consume it without buffering the whole file. D-16 requires the import to survive the marketer navigating away and returning (background job + progress polling), which implies the file itself must persist somewhere the worker process can read it, not just an in-memory stream tied to the original HTTP request's lifecycle.
   - What's unclear: this project has no object storage (S3-equivalent) configured yet, and `apps/worker` is a separate process/container from `apps/api`, so a shared local filesystem cannot be assumed in every deployment target.
   - Recommendation: for MVP, write the uploaded file to a shared volume/path both `apps/api` and `apps/worker` can access (documented explicitly in docker-compose and any deployment config), OR stream directly into Postgres as a staging table row-by-row from the upload request itself, with the worker only picking up already-persisted rows to process — the plan must pick one explicitly rather than leave it implicit, since "the worker can just re-read the uploaded file" silently assumes shared storage that doesn't exist yet in this project's infrastructure.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Redis | BullMQ (`events:ingest`, `imports:csv` queues) | ✗ (not in `docker-compose.yml` yet) | — | None — this phase must add a `redis` service to `docker-compose.yml` (image `redis:7` or `valkey/valkey:8`, per project STACK.md) as an explicit infra task before any queue code can run locally |
| Docker | Local dev Postgres + (new) Redis service | ✗ in this research sandbox (`docker` command not found) | — | Not a planning blocker — this sandbox is the research/coding environment only; confirm Docker is available on the actual dev machine before execution begins (existing `docker-compose.yml` already assumes Docker for Postgres since Phase 1, so this is a pre-existing project assumption, not a new one) |
| Node.js | `apps/worker` new process, all existing apps | ✓ | v26.0.0 (repo requires `>=22` per root `package.json` `engines`) | — |
| npm | workspace installs | ✓ | 11.12.1 | — |

**Missing dependencies with no fallback:**
- Redis must be added to `docker-compose.yml` and `.env`/`env.ts` (a `REDIS_URL` variable, following the existing `env.ts` Zod-validated pattern used for `DATABASE_URL`/`KMS_*`) before BullMQ code can be exercised, even in tests — this is a Wave 0 infra task for the plan, not optional.

**Missing dependencies with fallback:**
- Docker's absence in this research sandbox has no bearing on plan feasibility; noted only for completeness.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 (already configured, `apps/api/vitest.config.ts`) |
| Config file | `apps/api/vitest.config.ts` — routes `DATABASE_URL` to `TEST_DATABASE_URL`, excludes `dist/**` |
| Quick run command | `npm run test -w apps/api -- --run <path-to-file>` |
| Full suite command | `npm run test -w apps/api` (and, once created, `npm run test -w apps/worker`) |

**Wave 0 gap:** `apps/worker` does not exist yet — it needs its own `vitest.config.ts` mirroring `apps/api`'s pattern (test-safe env vars, `TEST_DATABASE_URL` routing) before any worker-specific test can run. A `REDIS_URL`/test-Redis convention (e.g. a dedicated logical DB index for tests, or `ioredis-mock` for pure-unit tests of queue-adjacent logic) should be decided explicitly — this project has no precedent for test-Redis yet, unlike the existing `TEST_DATABASE_URL` convention.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|---------------------|--------------|
| CONT-01 | Contact CRUD via UI-facing API routes | integration | `vitest run apps/api/src/modules/contacts/__tests__/contact-crud.test.ts` | ❌ Wave 0 |
| CONT-02 | CSV import: mapping, preview, dry-run, error report | integration | `vitest run apps/api/src/modules/contacts/__tests__/csv-import.test.ts` | ❌ Wave 0 |
| CONT-03 | Contacts CRUD API (API-key authed) | integration | `vitest run apps/api/src/modules/contacts/__tests__/contacts-api.test.ts` | ❌ Wave 0 |
| CONT-04 | Upsert priority (external_id → email, attach, conflict) | unit + integration | `vitest run apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts` | ❌ Wave 0 — see Pitfall 2, must cover all 4 branches explicitly |
| CONT-05 | Custom properties stored + property registry auto-discovery | unit | `vitest run apps/api/src/modules/contacts/__tests__/property-registry.test.ts` | ❌ Wave 0 |
| EVNT-01 | Freeform event ingestion via API key | integration | `vitest run apps/api/src/modules/events/__tests__/events-api.test.ts` | ❌ Wave 0 |
| EVNT-02 | Event for unknown contact creates it | integration | shared with `upsert-priority.test.ts` (same underlying function, invoked from the worker) | ❌ Wave 0 |
| EVNT-03 | Event API 2xx fast, async processing | integration + chaos | `vitest run apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts` — simulate job redelivery, confirm no duplicate event row (Pitfall 1) | ❌ Wave 0 |
| SUBS-01 | 3-state subscription status + suppression persistence across delete/re-create | integration | `vitest run apps/api/src/modules/contacts/__tests__/subscription-status.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run test -w apps/api -- --run <touched-file>`
- **Per wave merge:** `npm run test -w apps/api && npm run test -w apps/worker` (once the worker app exists)
- **Phase gate:** Full suite green before `/gsd-verify-work`, including the events-ingest idempotency chaos test (Pitfall 1) and the upsert-priority four-branch test (Pitfall 2)

### Wave 0 Gaps
- [ ] `apps/api/src/modules/contacts/__tests__/*` — new test directory, no existing coverage
- [ ] `apps/worker/vitest.config.ts` + `apps/worker/src/test/` fixtures — new app, mirror `apps/api`'s `db-fixture.ts` pattern
- [ ] Test-Redis convention (dedicated DB index, or `ioredis-mock` for pure unit tests) — no existing precedent in this repo
- [ ] Framework install: none — Vitest already a dependency; `apps/worker`'s `package.json` needs it added when the app is scaffolded

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|----------------|---------|-------------------|
| V2 Authentication | Yes | API keys are a machine-credential authentication mechanism (distinct from better-auth's user sessions) — SHA-256 hash storage, high-entropy (256-bit) secrets, shown once (D-22) |
| V3 Session Management | No (for the new API-key path) | API keys are not sessions — no expiry/refresh semantics required this phase; existing better-auth session handling (Phase 1) is unaffected |
| V4 Access Control | Yes | Two layers: (1) Postgres RLS `workspace_isolation` policy on every new tenant-scoped table (contacts, events, workspace_api_keys, workspace_suppressions, workspace_property_registry, csv_imports), following the exact `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + policy pattern from `migrations/0001_rls_policies.sql`; (2) API-key management routes (create/revoke) gated Owner/Admin via existing `requirePermission` |
| V5 Input Validation | Yes | Zod schemas on contact CRUD fields, event envelope shape (name + properties, NOT properties' internal shape per project decision), CSV row shape post-mapping, API-key create/revoke payloads — all in `packages/shared-schemas` per existing convention |
| V6 Cryptography | Yes | API-key secrets: SHA-256 hash at rest, `crypto.timingSafeEqual` comparison, no reversible encryption needed (unlike the SendGrid key, which must be decrypted for use — API keys are only ever compared, never decrypted) — explicitly do NOT reuse the KMS envelope-encryption pattern here per D-22 |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| API key brute-force / credential stuffing against `/v1/*` routes | Spoofing | `@fastify/rate-limit` on the API-key-authed routes (per-IP and/or per-key-prefix-attempt), constant-time hash comparison (Pattern 3) |
| Reserved-field mass assignment via freeform `properties` JSON (e.g. a property literally named `subscription_status`) | Tampering | Explicit allowlist/denylist of top-level keys before merging into `contacts.properties`; never string-template tenant JSON into a column name or raw SQL fragment (Pitfall 4) |
| Cross-tenant data leak via the new worker process's tenant-context handling | Information Disclosure / Elevation of Privilege | Extract `withTenant`/`withTenantTransaction` into a shared package (Architecture Patterns) so the worker uses the identical, already-chaos-tested mechanism as the API — do not let the worker invent its own tenant-scoping | 
| Unbounded event/CSV payload size (memory/CPU DoS) | Denial of Service | Fastify body-size limits on `/v1/events`; `@fastify/multipart` `fileSize` limit + streaming (never full-buffer) for CSV uploads; cap batch size at ~1000 events (D-24) |
| API key enumeration via timing or error-message differences (valid-prefix-invalid-secret vs invalid-prefix) | Information Disclosure | Return an identical generic 401 body/timing for both "key not found" and "key found, hash mismatch" cases — do not let response shape/timing distinguish them |

## Sources

### Primary (HIGH confidence)
- npm registry (`npm view <pkg> version`) — direct package metadata, verified 2026-07-04 for: bullmq, ioredis, rate-limiter-flexible, csv-parse, @fastify/multipart, @bull-board/api, @bull-board/fastify
- [BullMQ: Idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs) — official docs, at-least-once delivery guarantee confirmed
- [PostgreSQL wiki: UPSERT](https://wiki.postgresql.org/wiki/UPSERT) — official community wiki, single-constraint-per-statement limitation confirmed
- This repository's existing code: `apps/api/src/middleware/tenant-context.ts`, `apps/api/src/middleware/role-guard.ts`, `packages/db/src/rls.ts`, `packages/db/src/schema/sendgrid-keys.ts`, `apps/api/src/modules/tenancy/sendgrid-key.repository.ts`, `packages/db/migrations/0001_rls_policies.sql`, `apps/api/src/db/__tests__/rls-pooling-chaos.test.ts`

### Secondary (MEDIUM confidence)
- [Fastify hooks: onRequest vs preHandler for header-only auth](https://github.com/fastify/fastify-bearer-auth) — official Fastify org plugin, cross-checked against general Fastify hooks documentation
- [@fastify/multipart README](https://github.com/fastify/fastify-multipart) — official plugin docs, streaming/busboy behavior
- API key hashing pattern (SHA-256, show-once, prefix-mask) — cross-checked across [dennisokeeffe.com](https://www.dennisokeeffe.com/blog/2025-04-07-roll-your-own-api-keys), [LogRocket](https://blog.logrocket.com/understanding-api-key-authentication-node-js/), and general Stripe/GitHub-style convention knowledge
- [Crunchy Data: Time Partitioning with pg_partman](https://www.crunchydata.com/blog/time-partitioning-and-custom-time-intervals-in-postgres-with-pg_partman) — vendor blog, cross-checked against pg_partman's own GitHub repo
- csv-parse streaming/mapHeaders pattern — [csv.js.org official docs](https://csv.js.org/parse/), [DigitalOcean tutorial](https://www.digitalocean.com/community/tutorials/how-to-read-and-write-csv-files-in-node-js-using-node-csv)

### Tertiary (LOW confidence)
- Two-key-priority upsert as a named/documented pattern — no first-party source addresses this exact shape; synthesized from general Postgres `ON CONFLICT` single-constraint limitation plus this project's own D-01–D-04 decisions (Assumption A1, A4)
- Manual monthly-partition-creation as an MVP substitute for `pg_partman` — reasonable inference, not independently verified against this project's actual hosting target (Assumption A5)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all versions directly verified via `npm view`, matching pre-existing project-level STACK.md exactly; no drift found
- Architecture: MEDIUM-HIGH — queue/worker/idempotency patterns are well-documented BullMQ conventions; the two-key upsert pattern (Pattern 1) is a project-specific synthesis with no first-party precedent, flagged accordingly
- Pitfalls: MEDIUM — Pitfalls 1 and 3 extend directly from this project's own pre-existing PITFALLS.md findings (duplicate sends, body-parser ordering) generalized to this phase's specific mechanisms; Pitfalls 2 and 4 are original findings from this phase's own decision analysis (CONTEXT.md D-03/D-04, freeform-properties scope)

**Research date:** 2026-07-04
**Valid until:** 2026-08-03 (30 days — stable ecosystem, no fast-moving dependencies in this phase's scope)
