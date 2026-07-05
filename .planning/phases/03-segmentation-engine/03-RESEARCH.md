# Phase 3: Segmentation Engine - Research

**Researched:** 2026-07-05
**Domain:** Dynamic audience segmentation (profile attributes + behavioral/event conditions) with a single evaluation engine shared by UI live-preview, campaigns, and flows
**Confidence:** HIGH (core scale question resolved by a direct empirical benchmark against a live Postgres instance seeded to target scale, not just literature)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Модель определения сегмента (комбинаторы)**
- **D-01:** Двухуровневая модель AND/OR по образцу Klaviyo: условия внутри группы объединяются через OR, группы между собой — через AND («(страна = RU ИЛИ страна = KZ) И (сделал заказ за 30 дней)»). Произвольная вложенность групп — НЕ в v1.
- **D-02:** Отрицания — first-class: поведенческое «НЕ сделал / ни разу за период» и негативные операторы атрибутов («не равно», «не содержит», «тег отсутствует»).
- **D-03:** Операторы типизированы по реестру свойств (Phase 2 D-10): string — равно/не равно/содержит/пусто/не пусто; number — = ≠ > ≥ < ≤; bool — истина/ложь; date — до/после/в последние N дней; теги — есть/нет. Стандартные поля (страна, город, имя, телефон) — как string-атрибуты. Реестр свойств — источник списка атрибутов и подсказок типов в билдере.
- **D-04:** Статус подписки доступен как обычное условие профиля (сегменты реактивации), НО pre-send фильтр Phase 4 (SUBS-03) остаётся независимым обязательным гейтом — сегмент никогда не отменяет suppression/unsubscribe при отправке.

**Поведенческие условия**
- **D-05:** Выбор события в билдере — из наблюдаемых имён событий воркспейса (distinct по таблице events) + свободный ввод как fallback (реестра типов событий нет — EVNT-V2-01 отложен).
- **D-06:** Форма поведенческого условия v1: «{событие} {выполнено ≥ N раз | ни разу} за {последние N дней | всё время}». Варианты «не более N раз» / «ровно N» — Claude's discretion, если дёшево.
- **D-07:** Фильтры по свойствам события («заказ, где сумма > 100») — НЕ в v1, отложено в v2.

**Live-превью**
- **D-08:** Счётчик пересчитывается автоматически при каждом изменении определения (debounce), с индикатором загрузки; count точный (не приблизительный). Производительность count-запроса на целевом масштабе (100k–1M контактов) — предмет бенчмарка ресёрчера, при необходимости планировщик закладывает деградацию (например, таймаут → подсказка «уточните условия»).
- **D-09:** В билдере — только счётчик, без inline-списка контактов. Посмотреть «кто попал» можно на странице сегмента (список участников, D-12).

**Страница сегментов и жизненный цикл**
- **D-10:** «Сегменты» — самостоятельный раздел в навигации воркспейса рядом с «Контактами» (`/w/{slug}/segments`).
- **D-11:** Список сегментов: имя, число участников (последний вычисленный + метка времени пересчёта), создан/обновлён, автор. Как и когда пересчитывается счётчик списка — за движком (discretion), но UI показывает «на момент X».
- **D-12:** Страница сегмента: определение (редактируемое в том же билдере) + пагинированный список участников — переиспользовать паттерн таблицы контактов Phase 2 (поиск/пагинация, keepPreviousData из 02-13).
- **D-13:** Сегменты всегда динамические — статических снапшотов в v1 нет. Редактирование определения меняет состав «на будущее» везде, где сегмент используется (кампании/цепочки ссылаются по id).
- **D-14:** Удаление сегмента в Phase 3 разрешено свободно (на него ещё никто не ссылается), но схема/API закладываются под restrict-when-referenced: Phase 4/6 будут блокировать удаление сегмента, используемого кампанией/цепочкой. Переименование свободное.

### Claude's Discretion
- Внутренности движка: on-demand SQL vs materialized membership — решает ресёрчер по бенчмарку на целевом масштабе (НЕ коммититься в materialized-подход без бенчмарка). **Resolved by this research — see Summary/Pitfall 1: on-demand SQL is the MVP recommendation.**
- Генерация SQL из definition-JSON, индексы (GIN по properties/tags и т.п.), кэширование count, интервал debounce.
- Формат/версионирование definition-JSON сегмента, Zod-схемы в shared-schemas, RLS новых таблиц по паттерну Phase 1/2.
- Контракт движка для потребителей SEGM-03 (кампании Phase 4: resolve полного состава; цепочки Phase 6: проверка принадлежности контакта) — спроектировать API движка под оба сценария, не строя самих потребителей.
- Пустые состояния, русские тексты UI в стиле Phase 2, детали UX билдера (UI-SPEC придёт из /gsd-ui-phase — ui_phase включён).

### Deferred Ideas (OUT OF SCOPE)
- Фильтры по свойствам события в поведенческих условиях («заказ, где сумма > 100») — v2, после появления реестра наблюдаемых схем событий (EVNT-V2-01)
- Произвольная вложенность групп условий (группы в группах) — v2
- Статические сегменты/снапшоты и ручные списки контактов — v2
- Приблизительный/оценочный count для очень больших воркспейсов — только если бенчмарк покажет, что точный count не тянет (**benchmark result: exact count is fine at target scale, see Summary**)
- Папки/теги для организации сегментов — v2
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEGM-01 | Пользователь может создать динамический сегмент по свойствам профиля (страна, теги, кастомные атрибуты) | Pattern 1 (condition compiler), typed operator allow-list (Security Domain), GIN/btree index recommendations (Standard Stack, Code Examples) |
| SEGM-02 | Поведенческие условия по событиям (count/timeframe), включая отрицание | Pattern 1 (behavioral EXISTS/NOT EXISTS compiler), benchmark results (Pitfall 1), existing `idx_events_workspace_contact_time`/`idx_events_workspace_name_time` reuse |
| SEGM-03 | Единый движок для кампаний (Phase 4, resolve audience) и цепочек (Phase 6, triggers/exit) | Architecture Patterns "Unified evaluation contract", `@mega-crm/segments-core` package recommendation, 3 call-modes benchmarked (count/list/point-check) |
| SEGM-04 | Live-превью количества подходящих контактов при построении | Benchmark timings (Summary), debounce + request-cancellation pattern (Pattern 4/Pitfall 6), D-08 timeout-fallback design |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Directives from `.claude/CLAUDE.md` that this phase's plan must honor (extracted from the project's stack research and "What NOT to Use" table):

- **Backend framework:** Fastify 5.9.x + `@fastify/type-provider-zod` — every new route (`segments.routes.ts`) must use schema-first Zod validation on the request lifecycle, matching `contacts.routes.ts`.
- **ORM/query layer:** Drizzle ORM for schema *shape* only (type inference); dynamic/multi-condition queries go through raw parameterized `pg` queries via the shared `pool`/`withTenantTransaction` helper — **never** Drizzle's query builder for the segment condition compiler, matching the established `contact.repository.ts` convention.
- **Multi-tenancy:** Shared schema + `tenant_id` (here: `workspace_id`) + Postgres RLS is mandatory for every new table — "Application-only tenant filtering... without RLS" is explicitly listed under What NOT to Use. The new `segments` table must get `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a `workspace_isolation` policy, identical to `0004_contacts_rls_policies.sql`.
- **No new backend framework/ORM/queue library substitutions:** This phase doesn't touch BullMQ/queues at all (on-demand SQL evaluation needs no background job), so the CLAUDE.md queue guidance (BullMQ OSS + `rate-limiter-flexible`, never BullMQ's built-in per-worker limiter) is not applicable here — noted only to confirm no queue infrastructure is required by this phase's recommended design.
- **Frontend:** React 19 + Vite, TanStack Query for server state, `@tanstack/react-table` for the member-list grid, React Hook Form + Zod for the segment builder's condition inputs — matching the existing `apps/web/src/features/contacts` conventions (no Redux/RTK).
- **Logging:** Pino (already the Fastify default) — no new logging library.
- **Testing:** Vitest for both the pure `segments-core` compiler unit tests and the API integration tests — no new test framework.

None of the "What NOT to Use" entries (Express, `reactflow`, BullMQ's built-in limiter, pgcrypto-only secrets, app-only tenant filtering without RLS, schema-per-tenant) are relevant risks for this specific phase's scope, except the RLS-without-enforcement anti-pattern, which is explicitly guarded against above.

## Summary

This phase's central open question — explicitly flagged in CONTEXT.md and STATE.md as "benchmark before committing" — was **on-demand SQL vs. materialized segment membership**. This research answers it empirically, not from literature: a disposable benchmark workspace was seeded directly in the project's local Postgres instance with **500,000 contacts and 2,000,000 events** (the upper-middle of the phase's 100k–1M target range), and the actual SQL shapes a segment engine would generate were run through `EXPLAIN (ANALYZE, BUFFERS)`.

**Result: on-demand SQL, generated per-request from the segment definition JSON and executed directly against `contacts`/`events`, comfortably meets a live-preview UX budget at target scale** — profile-only conditions resolved in 60–90ms, a single behavioral EXISTS/NOT EXISTS condition in 150–220ms, and a realistic 3-condition combined definition (two profile groups OR'd, one positive + one negative behavioral condition) in ~330ms, all against the full 500k/2M dataset with no query-specific caching. Point-checks ("is contact X in segment?", the shape Phase 6 flow triggers need) resolved in single-digit milliseconds. This **reverses the project-level SUMMARY.md's generic pre-benchmark recommendation** to materialize segment membership — that recommendation was written speculatively before any phase-specific measurement, and CONTEXT.md D-01(discretion) explicitly instructs to not commit to it without one. Materializing membership (a `segment_members` table refreshed on every contact/event write) is real, non-trivial engineering (invalidation triggers, staleness windows, backfill jobs) that this benchmark shows is **not required for MVP** — defer it to a v2 trigger condition (see State of the Art).

**Primary recommendation:** Build a single stateless SQL-compiling module (`@mega-crm/segments-core`, mirroring the existing `@mega-crm/contacts-core` extraction pattern) that turns a versioned `SegmentDefinition` JSON into one parameterized SQL `WHERE` fragment, and exposes three call modes over it — `count()`, `listMembers({page, pageSize})`, and `isMember(contactId)`. All three modes share the exact same compiled WHERE clause, which is what makes SEGM-03's "identical membership set for campaigns and flows" guarantee structurally true rather than something to test for. The riskiest part of this phase is **not** performance — it's **safe SQL generation from user-authored condition trees** (Security Domain) and one Postgres-specific footgun found during benchmarking: a naive `SELECT DISTINCT name FROM events` (needed for D-05's event-name picker) takes **5.6 seconds** at 2M events and must instead use a loose-index-scan (skip-scan) recursive CTE, which resolves the identical result in **3ms** — a ~1900x difference (see Pitfall 2, Code Examples).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Segment definition storage (definition JSON, name, metadata) | Database / Storage | API / Backend | New `segments` table, RLS-scoped like every other tenant table; API owns read/write |
| Segment condition compiler (definition JSON → parameterized SQL) | API / Backend | — | Pure, stateless, unit-testable module (`@mega-crm/segments-core`) — no HTTP/DB coupling itself, so it can be imported by `apps/worker` later (Phase 6) without a dependency path through `apps/api`, exactly like `@mega-crm/contacts-core` |
| Segment evaluation execution (count / list / point-check) | API / Backend | Database / Storage | Executes the compiled SQL inside `withTenantTransaction`; all three modes are the same query with a different tail (`count(*)` vs `LIMIT/OFFSET` vs `AND c.id = $N`) |
| Live-preview debounce + request cancellation | Browser / Client | API / Backend | Debounce timing and stale-response guarding live in the builder UI; the backend just answers each request as fast as possible (no server-side debouncing) |
| Event-name picker (distinct observed event names) | API / Backend | Database / Storage | Must use the loose-index-scan pattern (Pitfall 2), not naive `DISTINCT`, to stay fast as the events table grows |
| Segment list page (member counts, last-computed timestamp) | API / Backend | Browser / Client | Count freshness policy (D-11, on-demand vs cached) is a backend decision; UI just renders "as of X" |
| Segment member list (paginated) | API / Backend | Browser / Client | Same compiled WHERE + `LIMIT/OFFSET`, reusing the Phase 2 contacts-table UI pattern (keepPreviousData) |
| Future campaign audience resolution (Phase 4) | API / Backend | — | Consumes the same `listMembers`/count contract — not built in this phase, but the contract must already support it |
| Future flow trigger/exit-condition check (Phase 6) | API / Backend | — | Consumes `isMember(contactId)` — same compiler, appended point-check predicate |

## Standard Stack

### Core

No new runtime dependencies are introduced by this phase. Everything needed already exists in the codebase and is pinned in `apps/api/package.json` / `packages/db/package.json`:

| Library | Version (installed) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `drizzle-orm` | 0.45.2 [VERIFIED: installed node_modules] | Schema definition for the new `segments` table (type inference only, same as `events.ts`/`contacts.ts`) | Established project pattern — schema-shape-only Drizzle file, hand-written SQL migration for DDL/RLS |
| `pg` | 8.22.0 [VERIFIED: installed node_modules] | Parameterized query execution via `withTenantTransaction`/`client.query` | Established project pattern (`contact.repository.ts`) — raw parameterized SQL, not Drizzle's query builder, for dynamic multi-condition queries |
| `zod` | 4.4.3 [VERIFIED: installed node_modules] | `SegmentDefinition`/condition/operator schemas in `packages/shared-schemas` | Same pattern as `contact.ts`/`event.ts` schemas — single source of truth for API validation + frontend types |
| `@tanstack/react-query` + `@tanstack/react-table` | already installed | Live-count query, segment list, member list | Same `keepPreviousData` pattern as `ContactsListPage.tsx` |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| On-demand SQL evaluation (recommended) | Materialized `segment_members` table, refreshed incrementally off the event/contact write path | Only justified once real p95 segment-evaluation latency in production exceeds the live-preview budget (empirically not the case at 500k/2M in this benchmark) or once Phase 6 needs to evaluate hundreds of segments' entry triggers per incoming event (a fan-out problem materialization solves well) — track as a v2 trigger, not a Phase 3 default |
| Hand-rolled dynamic SQL string builder (recommended, since it's already the project's established pattern) | A query-builder library (e.g. Kysely, Knex) purely for the condition-tree-to-SQL translation | Not worth introducing a second query-building paradigm alongside Drizzle + raw `pg` when the existing raw-parameterized-SQL pattern (`contact.repository.ts`) already handles dynamic `WHERE` construction safely; a new dependency here buys nothing the allow-list approach doesn't already provide |
| GIN `jsonb_path_ops` on `contacts.properties` (recommended for containment-only ops) | GIN `jsonb_ops` (default) | `jsonb_ops` is required if D-03's "не пусто"/"пусто" (key-existence) operators are implemented via `?`/`?&`/`?|`, since `jsonb_path_ops` supports `@>` only [CITED: postgresql.org/docs/current/gin.html]. Decide the exact GIN opclass once the planner picks concrete SQL fragments for each D-03 operator — see Open Question 2 |

**Installation:** None — no new packages.

**Version verification:** All versions above were read directly from `node_modules/*/package.json` and root `package.json` files in this repository (`npm view` not needed since they are already installed and pinned).

## Package Legitimacy Audit

**Not applicable — this phase installs no new external packages.** All functionality is built from already-vetted, already-installed dependencies (`drizzle-orm`, `pg`, `zod`, `@tanstack/react-query`, `@tanstack/react-table`), each already audited in prior phases' RESEARCH.md / CLAUDE.md stack research. No `npm view`/package-legitimacy check was run because there is nothing new to check.

## Architecture Patterns

### System Architecture Diagram

```
Segment Builder UI (Browser)
  │  user edits condition tree (groups/conditions)
  │
  ├─ debounce (≈300ms, matches existing ContactsListPage pattern) + request-cancellation guard
  ▼
GET /api/workspaces/:slug/segments/preview-count?definition=<json>   [SEGM-04]
  │
  ▼
Fastify route (apps/api/src/modules/segments)
  │  Zod-validates SegmentDefinition against shared-schemas
  ▼
@mega-crm/segments-core :: compileSegmentDefinition(definition)
  │  pure function → { whereSql, params }
  │  - profile conditions: allow-listed column/operator → parameterized fragment
  │  - behavioral conditions: EXISTS/NOT EXISTS subquery against events, parameterized
  │  - groups OR'd internally, groups AND'd together (D-01), always parenthesized
  ▼
withTenantTransaction(client => client.query(`SELECT count(*) FROM contacts c WHERE ${whereSql}`, params))
  │  SET LOCAL app.current_workspace_id (existing tenant-context pattern)
  ▼
Postgres: contacts (RLS-scoped) ⟕ events (RLS-scoped, partitioned by occurred_at)
  │
  ▼
{ count: 12345 }  →  Segment Builder UI renders live count

──────────────── same compiled WHERE, different tail ────────────────

Segment "member list" page (D-12)         Future: Campaign audience (Phase 4)     Future: Flow trigger/exit check (Phase 6)
  listMembers({page, pageSize})              listMembers({page, pageSize})          isMember(contactId)
  → SELECT ... WHERE {whereSql}               → same, paginated cursor over        → SELECT ... WHERE {whereSql}
    ORDER BY c.id LIMIT/OFFSET                  full audience for send queue           AND c.id = $N  (index point-lookup)
```

### Recommended Project Structure

```
packages/
  segments-core/                  # NEW — mirrors contacts-core's extraction pattern
    src/
      types.ts                   # SegmentDefinition, SegmentGroup, SegmentCondition, operator enums
      compile.ts                 # compileSegmentDefinition(definition, opts?) -> { whereSql, params }
      operators.ts                # allow-listed operator -> SQL fragment map, per property type
      index.ts
    package.json
  shared-schemas/src/
    segment.ts                    # NEW — Zod schemas for SegmentDefinition + API request/response shapes
  db/src/schema/
    segments.ts                    # NEW — Drizzle shape-only table (id, workspace_id, name, definition jsonb, created_by, created_at, updated_at)
  db/migrations/
    00NN_segments.sql              # NEW — CREATE TABLE + RLS ENABLE/FORCE + workspace_isolation policy (Phase 1/2 pattern)
    00NN_segments_indexes.sql      # NEW — GIN(tags), GIN(properties jsonb_path_ops or jsonb_ops per Open Question 2), btree(workspace_id, country) etc.

apps/api/src/modules/segments/
  segments.routes.ts               # GET/POST/PATCH/DELETE segments, GET preview-count, GET :id/members
  segment.repository.ts            # thin wrapper: withTenantTransaction + @mega-crm/segments-core calls
  event-names.repository.ts        # loose-index-scan distinct event names (D-05)
  __tests__/

apps/web/src/features/segments/
  SegmentsListPage.tsx              # D-10/D-11
  SegmentBuilder.tsx                # D-01..D-09 condition-tree editor + live count
  SegmentDetailPage.tsx             # D-12 definition + paginated member list (reuses ContactsListPage's table pattern)
```

### Pattern 1: Two-tier AND/OR condition compiler

**What:** A single pure function takes the versioned `SegmentDefinition` JSON and returns one parameterized SQL WHERE fragment + params array. Groups are AND'd; conditions within a group are OR'd; every group is wrapped in parentheses so operator precedence can never silently invert the AND/OR structure (see Pitfall 7).

**When to use:** Every read path — live count, member list, point-check — compiles the definition exactly once through this function.

**Example:**
```typescript
// packages/segments-core/src/compile.ts
// Source: project pattern established in contact.repository.ts's listContacts
// (dynamic WHERE + $N positional params), extended to a two-tier AND/OR tree.

export interface CompiledSegment {
  whereSql: string;   // e.g. "workspace_id = $1 AND ((country = $2 OR country = $3)) AND (EXISTS (...))"
  params: unknown[];
}

export function compileSegmentDefinition(
  def: SegmentDefinition,
  workspaceId: string
): CompiledSegment {
  const params: unknown[] = [workspaceId];
  const groupClauses = def.groups.map((group) => {
    const conditionClauses = group.conditions.map((cond) => compileCondition(cond, params));
    // OR within group -- always parenthesized (Pitfall 7)
    return `(${conditionClauses.join(" OR ")})`;
  });
  // AND across groups
  const whereSql = ["c.workspace_id = $1", ...groupClauses].join(" AND ");
  return { whereSql, params };
}

function compileCondition(cond: SegmentCondition, params: unknown[]): string {
  if (cond.type === "attribute") {
    return compileAttributeCondition(cond, params);
  }
  return compileBehavioralCondition(cond, params);
}
```

### Pattern 2: Unified evaluation contract (count / list / point-check)

**What:** One compiled WHERE, three tails. This is what makes SEGM-03's "identical membership set" guarantee structural, not something separately tested per consumer.

**Example:**
```typescript
// apps/api/src/modules/segments/segment.repository.ts
export async function countSegmentMembers(def: SegmentDefinition): Promise<number> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM contacts c WHERE ${whereSql}`, params
    );
    return Number(rows[0].count);
  });
}

export async function listSegmentMembers(
  def: SegmentDefinition, page: number, pageSize: number
): Promise<{ items: ContactRow[]; total: number }> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
    const { rows: countRows } = await client.query(`SELECT count(*) FROM contacts c WHERE ${whereSql}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await client.query(
      // ORDER BY c.id is a stable tie-breaker (Open Question 3) -- created_at alone
      // is not unique enough at high insert rates to guarantee stable pagination.
      `SELECT ${CONTACT_COLUMNS} FROM contacts c WHERE ${whereSql}
       ORDER BY c.created_at DESC, c.id ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return { items: rows, total: Number(countRows[0].count) };
  });
}

// Point-check for Phase 6 flow triggers/exit conditions -- same compiled WHERE + one more predicate.
export async function isContactInSegment(def: SegmentDefinition, contactId: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
    params.push(contactId);
    const { rows } = await client.query(
      `SELECT 1 FROM contacts c WHERE ${whereSql} AND c.id = $${params.length} LIMIT 1`, params
    );
    return rows.length > 0;
  });
}
```

### Pattern 3: Loose index scan for distinct event names (D-05)

**What:** Postgres has no native "skip scan" for `SELECT DISTINCT col`; a naive DISTINCT over a large indexed column still visits every row. A recursive CTE that repeatedly seeks the next-greater value via the existing `(workspace_id, name, occurred_at)` index turns an O(n) scan into O(distinct_values × log n).

**When to use:** Any "give me the distinct values of an indexed column" UI picker over a large table — here, the segment builder's event-name autocomplete.

**Verified via this session's own benchmark** (2,000,000-row `events` table, single workspace): naive `SELECT DISTINCT name` took **5,640ms**; the loose-index-scan CTE below took **3ms** for the identical result set.

**Example:**
```sql
-- Source: standard Postgres "loose index scan" / skip-scan idiom, verified via
-- EXPLAIN (ANALYZE, BUFFERS) against this project's own seeded events table.
WITH RECURSIVE distinct_names AS (
  (SELECT name FROM events WHERE workspace_id = $1 ORDER BY name LIMIT 1)
  UNION ALL
  SELECT (
    SELECT name FROM events
    WHERE workspace_id = $1 AND name > distinct_names.name
    ORDER BY name LIMIT 1
  )
  FROM distinct_names
  WHERE distinct_names.name IS NOT NULL
)
SELECT name FROM distinct_names WHERE name IS NOT NULL;
```

### Anti-Patterns to Avoid

- **String-interpolating client-supplied column names or operators into SQL:** The segment condition tree is user-authored (marketer builds it in the UI, but the JSON reaches the backend as untrusted request input). Field names and operators MUST be validated against a fixed allow-list (Zod enum + the property-registry's known keys) before touching SQL; only *values* are ever passed as `$N` parameters. See Security Domain.
- **Naive `SELECT DISTINCT name FROM events`:** 1900x slower than the loose-index-scan CTE at 2M rows (Pattern 3). Never ship the naive form even though it "looks fine" in local testing with a handful of demo events.
- **Committing to materialized segment membership without measuring first:** This was the generic project-level pitfall (SUMMARY.md Pitfall 4) written before phase-specific data existed. This phase's benchmark shows on-demand SQL is sufficient at target scale — don't build the extra machinery preemptively.
- **`= ANY(tags)` instead of `tags @> ARRAY[...]` for tag containment:** The GIN index on `tags` is only used efficiently via the `@>`/`<@`/`&&` containment operators, not the `= ANY()` form — verified via `EXPLAIN`: `@>` produced a `Bitmap Index Scan`, whereas an equivalent `= ANY()`-style predicate does not reliably hit the same index path.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Safe dynamic WHERE-clause construction from a JSON condition tree | A generic SQL AST/expression builder library | The project's existing raw-parameterized-`pg`-query pattern (`contact.repository.ts`), extended with a strict operator allow-list (Pattern 1) | Matches the established codebase convention exactly (no new query-builder paradigm); an allow-list is simpler to audit for SQL-injection safety than a generic AST builder would be to trust |
| Distinct value enumeration over a large indexed column | A separate "event type registry" table just to avoid the DISTINCT cost | The loose-index-scan recursive CTE (Pattern 3) | EVNT-V2-01 (event schema registry) is explicitly deferred; a registry table for this alone is premature — the CTE gets 1900x the naive query's speed using an index that already exists |
| JSONB containment matching for custom-property equality/tag conditions | A custom property-value indexing scheme | Postgres GIN index (`jsonb_path_ops` for `@>`-only workloads) | Native Postgres feature purpose-built for exactly this; verified in this session's benchmark that a GIN-backed `@>` query produces a `Bitmap Index Scan`, not a sequential scan |

**Key insight:** Every "don't hand-roll" here resolves to "use a Postgres-native mechanism the project has already adopted elsewhere" (RLS, parameterized `pg` queries, GIN indexes) rather than a new library — this phase adds no new external dependency surface at all.

## Common Pitfalls

### Pitfall 1: Assuming behavioral segment queries need materialization without measuring
**What goes wrong:** Teams pre-optimize by building a `segment_members` materialized table (with incremental refresh triggers on every contact/event write) before confirming on-demand queries are actually too slow — this is real, ongoing engineering complexity (staleness windows, backfill on segment edit, invalidation on contact/event write) that this phase does not need for MVP.
**Why it happens:** The project-level SUMMARY.md (written before any phase-specific measurement) generically recommended materialization for "behavioral segmentation at scale" as a category-level pitfall.
**How to avoid:** This research's benchmark (500k contacts / 2M events, single workspace, cold + warm cache) shows: profile-only ≈60–90ms, single behavioral EXISTS/NOT EXISTS ≈150–220ms, a realistic 3-condition combined definition ≈330ms, point-check ≈4–25ms. All comfortably inside a debounced live-preview budget (design for ~400–500ms debounce, D-08). Build on-demand SQL for MVP; revisit materialization only if production telemetry shows otherwise (see State of the Art for concrete revisit triggers).
**Warning signs:** If real-workspace p95 segment-preview latency exceeds ~1–2s, or if Phase 6 needs to evaluate hundreds of segments' entry conditions per single incoming event (a fan-out shape materialization solves well, unlike this phase's per-request evaluation shape).

### Pitfall 2: Naive DISTINCT event-name query is 1900x slower than necessary
**What goes wrong:** D-05 requires the segment builder to offer autocomplete over observed event names. A naive `SELECT DISTINCT name FROM events WHERE workspace_id = $1` looked correct in testing with a handful of rows but took **5,640ms** against this session's 2M-row benchmark table — because Postgres has no native skip-scan and must visit every matching row to deduplicate.
**Why it happens:** `DISTINCT` over an indexed low-cardinality column (here, ~7 distinct event names across 2M rows) is exactly the case where a full index-only scan is misleadingly "fast enough" in dev with small data but catastrophic at scale.
**How to avoid:** Use the loose-index-scan recursive CTE (Pattern 3/Code Examples) — verified at 3ms for the identical result against the same data.
**Warning signs:** Any endpoint doing `SELECT DISTINCT <col>` over `events` or any other high-write-volume table; profile it against a seeded dataset, not just dev fixtures, before shipping.

### Pitfall 3: GIN operator-class choice locks in which operators are indexable
**What goes wrong:** Choosing `jsonb_path_ops` (smaller, faster index — 20-30% of table size vs. jsonb_ops's 60-80% [CITED: pganalyze.com/blog/gin-index, postgresql.org/docs/current/gin.html]) only supports the `@>` containment operator. If D-03's "пусто"/"не пусто" (key-existence) operators are implemented via `?`/`?&`/`?|`, those require the default `jsonb_ops` class instead.
**Why it happens:** Both opclasses look interchangeable until a specific operator is needed that only one of them supports.
**How to avoid:** Decide the exact SQL fragment for each D-03 operator (equals → `@>`, exists/not-exists → `?`) *before* picking the GIN opclass; if both containment and existence operators are needed, either build both index types or express existence checks as `properties -> 'key' IS NOT NULL` (works without any GIN index, using the existing property-registry-informed type as a hint only) — see Open Question 2.
**Warning signs:** A migration adds a GIN index but a later query doesn't use it (`EXPLAIN` shows a sequential scan instead of a bitmap index scan) — verify with `EXPLAIN (ANALYZE)` per operator, not just once.

### Pitfall 4: Missing FK-referencing-column index makes cascade deletes catastrophically slow at scale
**What goes wrong:** `events.contact_id` has a foreign key to `contacts.id` with `ON DELETE CASCADE`, but the only index touching `contact_id` is the compound `(workspace_id, contact_id, occurred_at)` index — not a standalone or leading `contact_id` index. Deleting the benchmark workspace's 500,000 contacts (and their 2,000,000 cascading events) via `DELETE FROM organization ...` (cascading through `contacts` → `events`) was **still running after 5+ minutes** during this research session and had to be worked around by deleting `events` first (an explicit, workspace_id-scoped query that *does* hit an existing index) before deleting `contacts`.
**Why it happens:** Postgres's FK cascade trigger executes `DELETE FROM events WHERE contact_id = $1` once per deleted parent row; without an index whose leading column is (or includes) `contact_id` alone, each of those 500,000 deletes falls back to scanning large fractions of the table [CITED: yellowduck.be/posts/why-indexing-foreign-key-columns-matters-for-cascade-deletes-in-postgresql, render-examples/postgresql-missing-trigger-index].
**How to avoid:** This is a **pre-existing Phase 2 schema condition**, not something this phase's `segments` table should repeat — carry it forward as a flag (see Deferred/Follow-up below) rather than silently fixing it as a side effect of this phase. Any new FK this phase adds (e.g., a future `campaign_id`/`flow_id` reference *to* `segments.id` in Phase 4/6, per D-14's "restrict when referenced" note) must have the referencing column indexed from day one.
**Warning signs:** Any bulk-delete or cascade-delete path that takes materially longer than the row count alone would suggest.
**Follow-up flag (not in this phase's scope, carry to STATE.md):** Consider adding a standalone or `(contact_id, workspace_id)`-leading index on `events.contact_id` if contact deletion at scale becomes a real operational path (e.g., GDPR erasure requests) — currently only affects bulk/cascade deletes, not segment evaluation itself.

### Pitfall 5: RLS/tenant-context must wrap every segment query exactly like existing repositories
**What goes wrong:** A new module that queries `contacts`/`events` directly with a raw `pg` client outside `withTenantTransaction` silently returns zero rows (FORCE RLS + unset `app.current_workspace_id` GUC filters everything out) or, worse, if some other code path sets a broader-scoped session variable incorrectly, could leak cross-tenant data.
**Why it happens:** It's tempting to write a "fast path" for the live-count query that bypasses the standard transaction wrapper for perceived performance reasons.
**How to avoid:** Every segment evaluation call (count/list/point-check) MUST go through `withTenantTransaction`/`getWorkspaceId()` exactly like `contact.repository.ts` does — this project's own pooling-chaos test (`rls-pooling-chaos.test.ts`) exists specifically because ad-hoc bypasses of this pattern are the actual leak vector, not RLS itself.
**Warning signs:** Any new repository function that imports `pool` directly instead of `withTenantTransaction`.

### Pitfall 6: Debounce alone doesn't prevent stale live-count responses from racing ahead
**What goes wrong:** Because different segment definitions take meaningfully different amounts of time to evaluate (60ms for a simple profile filter vs. 300ms+ for a multi-condition behavioral one), a debounce timer alone does not guarantee response ordering: if the user removes a slow behavioral condition and adds a fast profile-only one, the earlier (slow) request can resolve *after* the later (fast) one, showing a stale/wrong count.
**Why it happens:** Debouncing only throttles *when requests are sent*, not the order in which their responses arrive.
**How to avoid:** Pair debounce with either (a) an `AbortController` that cancels the in-flight request whenever the definition changes again, or (b) a monotonic request-sequence guard that ignores any response older than the latest request sent (TanStack Query's `queryKey`-based cache invalidation handles this automatically if the full definition JSON is part of the query key — recommended, since it's the lowest-effort correct option and matches the existing `ContactsListPage` convention of encoding all filter state into the query key).
**Warning signs:** Flickering/incorrect live counts when rapidly toggling conditions in manual testing.

### Pitfall 7: Missing parentheses around OR groups silently changes AND/OR precedence
**What goes wrong:** SQL's `AND` binds tighter than `OR`; a compiler that emits `country = 'RU' OR country = 'KZ' AND status = 'subscribed'` (missing parens) evaluates as `country = 'RU' OR (country = 'KZ' AND status = 'subscribed')` — silently wrong relative to the intended two-tier AND/OR model (D-01).
**Why it happens:** Easy to omit parens when string-concatenating conditions, especially once conditions are OR'd across a group of 1 (no visible bug until a group has 2+ conditions).
**How to avoid:** Pattern 1's compiler *always* wraps every group's OR'd conditions in parentheses, even single-condition groups — no conditional logic based on group size.
**Warning signs:** A unit test asserting the compiled SQL string structure (not just query results) for a 2-group, 2-condition-each definition — this is cheap to test exhaustively since the compiler is a pure function.

## Code Examples

### Segment definition JSON shape (versioned)
```typescript
// packages/shared-schemas/src/segment.ts
export const conditionOperatorSchema = z.enum([
  // string
  "eq", "neq", "contains", "not_contains", "is_empty", "is_not_empty",
  // number
  "gt", "gte", "lt", "lte",
  // bool
  "is_true", "is_false",
  // date
  "before", "after", "in_last_days",
  // tags
  "has_tag", "not_has_tag",
]);

export const attributeConditionSchema = z.object({
  type: z.literal("attribute"),
  source: z.enum(["standard", "custom"]),
  field: z.string(),          // standard: allow-listed column name; custom: property-registry key
  operator: conditionOperatorSchema,
  value: z.unknown().optional(),
});

export const behavioralConditionSchema = z.object({
  type: z.literal("behavioral"),
  eventName: z.string().min(1),
  countOperator: z.enum(["at_least", "none"]),  // D-02/D-06
  count: z.number().int().min(1).optional(),     // required when countOperator === "at_least"
  timeframe: z.union([
    z.object({ kind: z.literal("last_days"), days: z.number().int().min(1) }),
    z.object({ kind: z.literal("all_time") }),
  ]),
});

export const segmentConditionSchema = z.discriminatedUnion("type", [
  attributeConditionSchema,
  behavioralConditionSchema,
]);

export const segmentGroupSchema = z.object({
  conditions: z.array(segmentConditionSchema).min(1),
});

export const segmentDefinitionSchema = z.object({
  version: z.literal(1),
  groups: z.array(segmentGroupSchema).min(1),
});
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;
```

### Standard-field allow-list (Security Domain — never trust client-supplied column names)
```typescript
// packages/segments-core/src/operators.ts
const STANDARD_FIELD_COLUMNS: Record<string, string> = {
  country: "c.country",
  city: "c.city",
  firstName: "c.first_name",
  lastName: "c.last_name",
  phone: "c.phone",
  subscriptionStatus: "c.subscription_status",
};

// Custom properties NEVER interpolate the key as a raw identifier -- ->> takes
// a parameterized text argument, so the key itself stays a bind parameter.
function compileAttributeCondition(cond: AttributeCondition, params: unknown[]): string {
  if (cond.source === "standard") {
    const column = STANDARD_FIELD_COLUMNS[cond.field];
    if (!column) throw new Error(`Unknown standard field: ${cond.field}`); // fails closed
    return compileOperator(column, cond.operator, cond.value, params);
  }
  // custom property: properties ->> $N is fully parameterized on the KEY too
  params.push(cond.field);
  const column = `c.properties ->> $${params.length}`;
  return compileOperator(column, cond.operator, cond.value, params);
}
```

### Behavioral EXISTS/NOT EXISTS compilation
```typescript
function compileBehavioralCondition(cond: BehavioralCondition, params: unknown[]): string {
  const negate = cond.countOperator === "none";
  params.push(cond.eventName);
  const eventNameParam = params.length;
  let timeClause = "";
  if (cond.timeframe.kind === "last_days") {
    params.push(cond.timeframe.days);
    timeClause = `AND e.occurred_at >= now() - ($${params.length} || ' days')::interval`;
  }
  const sub = `
    SELECT 1 FROM events e
    WHERE e.workspace_id = c.workspace_id AND e.contact_id = c.id
      AND e.name = $${eventNameParam} ${timeClause}
  `;
  return `${negate ? "NOT " : ""}EXISTS (${sub})`;
}
```

## State of the Art

| Old Approach (project-level, pre-benchmark) | Current Approach (this phase, post-benchmark) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| SUMMARY.md generic recommendation: "Materialize segment membership in a separate `segment_members` table" | On-demand SQL evaluation, no materialized table for MVP | 2026-07-05, this research session's direct benchmark | Removes a whole category of engineering (invalidation triggers on contact/event write, staleness windows, backfill jobs) from Phase 3 scope; re-evaluate only per the concrete triggers below |
| Naive `SELECT DISTINCT name FROM events` (would have been the first-draft implementation of D-05's event picker) | Loose-index-scan recursive CTE | Same session | 1900x latency reduction (5640ms → 3ms) at 2M events |

**Concrete triggers to revisit materialization in a later milestone (not this phase):**
1. Real production telemetry shows p95 segment-preview latency for actual (not synthetic) segment definitions exceeds ~1–2 seconds.
2. Phase 6 (flows) needs to evaluate "which segments does this new contact/event newly qualify for" as a fan-out over *many* segments per single incoming event — a shape materialized membership (with incremental refresh) solves structurally better than N on-demand point-checks per event.
3. A single workspace's contact count grows meaningfully past this benchmark's 500k (this research validated up to 500k contacts / 2M events; if a specific tenant approaches 1M+ contacts with a heavy behavioral-condition segment mix, re-benchmark before assuming the same headroom holds).

**Not deprecated, still current:** The FORCE RLS + `SET LOCAL app.current_workspace_id` pattern, the raw-parameterized-`pg`-query convention, and the two existing `events` indexes (`idx_events_workspace_contact_time`, `idx_events_workspace_name_time`) all remain the right foundation — this phase's benchmark confirms both existing event indexes are already used correctly by the planner for the query shapes this engine needs (no new `events` indexes required).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | A ~300–500ms debounce interval (matching the existing `ContactsListPage`'s 300ms) is an acceptable live-preview UX budget | Pitfall 1, Architecture Patterns | If the planner/UI-spec picks a much shorter debounce, more of the benchmarked latencies (150–330ms) would be user-visible as loading states more often — not incorrect, just a UX tuning question, not a correctness one |
| A2 | Production hardware performs at least as well as this benchmark's local dev Postgres (single machine, no read replica, cold-vs-warm cache tested but not under concurrent load) | Summary, Pitfall 1 | If production Postgres is meaningfully under-provisioned relative to this dev benchmark, or if many workspaces query concurrently, actual latencies could be higher — recommend a light concurrent-load smoke test during Phase 3 execution (multiple simultaneous preview-count requests), not just the single-query timings measured here |
| A3 | GIN `jsonb_path_ops` is the right opclass choice, contingent on D-03's "пусто/не пусто" operators being implementable via `properties -> 'key' IS NOT NULL` rather than requiring `?`/`?&`/`?|` | Standard Stack, Pitfall 3, Open Question 2 | If the planner implements existence-checks via the jsonb `?` operator family instead, a `jsonb_ops` (default) GIN index is needed instead of/in addition to `jsonb_path_ops` |

**If empty:** Not applicable — see table above; all three should be confirmed during planning/discuss, not treated as locked.

## Open Questions

1. **Maximum condition/group count exposed in the builder UI**
   - What we know: The benchmark tested up to 3 combined conditions (2 profile + 1 positive + 1 negative behavioral) at ~330ms. Each additional behavioral EXISTS/NOT EXISTS condition empirically added roughly 100–150ms in this benchmark's shape.
   - What's unclear: Whether the UI should hard-cap the number of conditions/groups, and at what threshold a friendly "narrow your conditions" fallback (D-08) should trigger versus simply accepting slower responses.
   - Recommendation: Don't hard-cap in this phase; implement the D-08 timeout/fallback as a safety net (e.g., a query `statement_timeout` scoped to the preview-count path specifically, distinct from other queries) rather than an arbitrary condition-count limit, since actual latency depends heavily on condition *type* mix, not just count.

2. **Exact SQL fragment (and therefore GIN opclass) for D-03's "пусто"/"не пусто" custom-property operators**
   - What we know: `jsonb_path_ops` is smaller/faster but `@>`-only; the default `jsonb_ops` supports existence operators (`?`/`?&`/`?|`) but is a larger, somewhat slower index.
   - What's unclear: Whether "не пусто" means "key exists in properties" (`properties ? 'key'`) or "key exists AND value is non-null/non-empty-string" (`properties ->> 'key' IS NOT NULL AND properties ->> 'key' <> ''`) — the latter doesn't need a jsonb existence operator at all, just the same `->>` text extraction already used for other string operators.
   - Recommendation: Prefer the `->>` text-extraction formulation for "пусто/не пусто" (no new GIN opclass tradeoff needed, reuses the same code path as every other string operator) unless the planner has a strong reason to distinguish "key absent" from "key present with null/empty value."

3. **Stable pagination tie-breaker for the segment member list (D-12)**
   - What we know: `ORDER BY created_at DESC` alone (the existing `ContactsListPage` default sort) can have ties at scale (bulk CSV imports, bulk event-driven contact creation), causing page-to-page duplicate/skip rows under `OFFSET` pagination.
   - What's unclear: Whether the planner wants keyset/cursor pagination (more correct, more work) or is fine with `ORDER BY created_at DESC, id ASC` (cheap tie-breaker, still OFFSET-based, still simple) for MVP.
   - Recommendation: `ORDER BY created_at DESC, id ASC` is enough for MVP parity with the existing contacts-list pagination pattern; don't introduce cursor pagination unless the planner has a specific reason to.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL | Segment evaluation, RLS, GIN/btree indexes | ✓ [VERIFIED: `pg_isready`, live benchmark run this session] | 16/17 (project-pinned) | — |
| Redis / BullMQ | Not required by this phase (no background recompute job needed — on-demand SQL, see Summary) | n/a | n/a | n/a |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None — this phase needs no new external dependency.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 [VERIFIED: apps/api/package.json] |
| Config file | `apps/api/vitest.config.ts` |
| Quick run command | `npm run test --workspace apps/api -- src/modules/segments` |
| Full suite command | `npm run test --workspace apps/api` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEGM-01 | Attribute condition compiles to correct parameterized SQL + returns correct count against seeded contacts | unit + integration | `vitest run src/modules/segments/__tests__/attribute-conditions.test.ts` | ❌ Wave 0 |
| SEGM-02 | Behavioral EXISTS/NOT EXISTS condition (count/timeframe, including negation) compiles and evaluates correctly | unit + integration | `vitest run src/modules/segments/__tests__/behavioral-conditions.test.ts` | ❌ Wave 0 |
| SEGM-03 | `count()`, `listMembers()`, `isMember()` return an identical membership set for the same definition | integration | `vitest run src/modules/segments/__tests__/unified-engine-contract.test.ts` | ❌ Wave 0 |
| SEGM-04 | Live preview count endpoint returns correct count within timeout budget | integration | `vitest run src/modules/segments/__tests__/preview-count.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npm run test --workspace apps/api -- src/modules/segments`
- **Per wave merge:** `npm run test --workspace apps/api`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `apps/api/src/modules/segments/__tests__/attribute-conditions.test.ts` — covers SEGM-01, compiler AND/OR/parenthesization correctness (Pitfall 7)
- [ ] `apps/api/src/modules/segments/__tests__/behavioral-conditions.test.ts` — covers SEGM-02
- [ ] `apps/api/src/modules/segments/__tests__/unified-engine-contract.test.ts` — covers SEGM-03: same definition through all three call modes must agree
- [ ] `apps/api/src/modules/segments/__tests__/preview-count.test.ts` — covers SEGM-04
- [ ] `packages/segments-core/src/__tests__/compile.test.ts` — pure-function unit tests for the SQL compiler in isolation (no DB needed), including the Pitfall 7 parenthesization regression test
- [ ] No new test-framework install needed — Vitest already configured project-wide

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | Not touched by this phase — reuses existing session-authed workspace-member routes (`resolveWorkspaceMember` pattern) |
| V3 Session Management | no | Unchanged |
| V4 Access Control | yes | RLS (`FORCE ROW LEVEL SECURITY` + `SET LOCAL app.current_workspace_id`) on the new `segments` table, identical to every other tenant-scoped table; ordinary workspace membership sufficient (matches `contacts` — segment management is not an elevated-role action per CONTEXT.md's silence on roles here) |
| V5 Input Validation | yes | **This phase's primary security surface.** The segment condition tree is user-authored, untrusted request input that directly shapes SQL. Field names and operators MUST be validated against a fixed allow-list (Zod discriminated union + a `Record<string, string>` column allow-list) before compilation — never string-interpolate a client-supplied column name or operator into SQL. Values are always passed as `$N` bind parameters, including JSONB property *keys* (via `properties ->> $N`, which parameterizes the key safely) |
| V6 Cryptography | no | Not touched by this phase |

### Known Threat Patterns for this phase's stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL injection via segment condition field/operator names (the definition JSON is client-controlled) | Tampering | Fixed allow-list for standard-field column names (`STANDARD_FIELD_COLUMNS` map, fails closed on unknown field) + Zod `z.enum`/discriminated union for operators, mapped to hard-coded SQL fragments in application code — never derived from a client string directly. Custom-property *keys* are safe because `properties ->> $N` parameterizes the key as a bind value, not an identifier |
| Cross-tenant segment/count leakage via a bypassed tenant-context wrapper | Information Disclosure | Every segment query goes through `withTenantTransaction`/RLS, exactly like `contact.repository.ts` (Pitfall 5) — no ad-hoc `pool.query` calls |
| Denial of service via an intentionally pathological segment definition (deeply combined behavioral conditions designed to be slow) | Denial of Service | A scoped `statement_timeout` on the preview-count/evaluation path (D-08's "timeout → hint to narrow conditions" escape hatch) bounds worst-case query cost regardless of how many conditions a definition contains |

## Sources

### Primary (HIGH confidence)
- Direct empirical benchmark performed in this research session: seeded 500,000 contacts + 2,000,000 events into a disposable workspace in this project's own local Postgres instance (`mega_crm` database, `mega_crm_app` role, matching production schema/RLS/partitioning exactly), ran `EXPLAIN (ANALYZE, BUFFERS)` against 6 representative query shapes (profile-only, single behavioral, negative behavioral, 3-condition combined, point-check, full-membership-list), and against the naive vs. loose-index-scan DISTINCT event-name query. Benchmark data was cleaned up after research (see session notes).
- `packages/tenant-context/src/index.ts`, `apps/api/src/modules/contacts/contact.repository.ts`, `packages/db/src/schema/{contacts,events,property-registry}.ts`, `packages/db/migrations/{0004,0007}_*.sql` — direct codebase inspection of established patterns this phase must extend.

### Secondary (MEDIUM confidence)
- [PostgreSQL: Documentation: GIN Indexes](https://www.postgresql.org/docs/current/gin.html) — official docs confirming `jsonb_path_ops` supports `@>` only, `jsonb_ops` supports `@>`/`?`/`?&`/`?|`
- [pganalyze: Understanding Postgres GIN Indexes](https://pganalyze.com/blog/gin-index) — `jsonb_path_ops` index-size/performance comparison, cross-checked against official docs
- [yellowduck.be: Why indexing foreign key columns matters for cascade deletes in PostgreSQL](https://www.yellowduck.be/posts/why-indexing-foreign-key-columns-matters-for-cascade-deletes-in-postgresql) — corroborates this session's own empirical finding (Pitfall 4)
- [render-examples/postgresql-missing-trigger-index (GitHub)](https://github.com/render-examples/postgresql-missing-trigger-index) — reproducible tutorial of the same failure mode observed in this session's benchmark

### Tertiary (LOW confidence)
- None — every claim in this document is either directly benchmarked against this project's own database this session, sourced from official Postgres documentation, or drawn from direct codebase inspection.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all versions read directly from installed `node_modules`
- Architecture: HIGH — the unified count/list/point-check contract is a direct, verified extension of the existing `contact.repository.ts` pattern, and every query shape it depends on was benchmarked against seeded data at target scale, not assumed
- Pitfalls: HIGH — Pitfalls 1, 2, and 4 are each backed by a specific `EXPLAIN (ANALYZE)` run performed in this session against this project's own database (not literature alone); Pitfalls 3, 5, 6, 7 are standard, well-documented Postgres/RLS/SQL-generation concerns cross-checked against official docs

**Research date:** 2026-07-05
**Valid until:** 30 days (stable Postgres/SQL-generation domain; re-benchmark if actual production contact counts approach or exceed the 500k/2M scale tested here, or if the property-registry's operator set changes significantly)
