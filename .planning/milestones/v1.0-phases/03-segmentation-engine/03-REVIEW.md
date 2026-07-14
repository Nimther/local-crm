---
phase: 03-segmentation-engine
reviewed: 2026-07-06T05:19:49Z
depth: standard
files_reviewed: 42
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/modules/segments/__tests__/attribute-conditions.test.ts
  - apps/api/src/modules/segments/__tests__/behavioral-conditions.test.ts
  - apps/api/src/modules/segments/__tests__/preview-count.test.ts
  - apps/api/src/modules/segments/__tests__/segments-hardening.test.ts
  - apps/api/src/modules/segments/__tests__/unified-engine-contract.test.ts
  - apps/api/src/modules/segments/event-names.repository.ts
  - apps/api/src/modules/segments/segment.repository.ts
  - apps/api/src/modules/segments/segments.routes.ts
  - apps/api/src/server.ts
  - apps/web/e2e/segments-behavior.spec.ts
  - apps/web/e2e/segments-tags.spec.ts
  - apps/web/e2e/segments.spec.ts
  - apps/web/package.json
  - apps/web/src/App.tsx
  - apps/web/src/components/ui/command.tsx
  - apps/web/src/components/ui/popover.tsx
  - apps/web/src/features/app-shell/AppShell.tsx
  - apps/web/src/features/segments/DeleteSegmentDialog.tsx
  - apps/web/src/features/segments/SegmentBuilder.tsx
  - apps/web/src/features/segments/SegmentCreatePage.tsx
  - apps/web/src/features/segments/SegmentDetailPage.tsx
  - apps/web/src/features/segments/SegmentsListPage.tsx
  - apps/web/src/features/segments/api.ts
  - apps/web/src/features/segments/useDebouncedValue.ts
  - apps/web/src/features/segments/validateDefinition.ts
  - packages/db/migrations/0011_segments.sql
  - packages/db/migrations/0012_segments_rls_and_indexes.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/index.ts
  - packages/db/src/schema/segments.ts
  - packages/segments-core/package.json
  - packages/segments-core/src/__tests__/compile.test.ts
  - packages/segments-core/src/compile.ts
  - packages/segments-core/src/index.ts
  - packages/segments-core/src/operators.ts
  - packages/segments-core/src/types.ts
  - packages/segments-core/tsconfig.json
  - packages/shared-schemas/package.json
  - packages/shared-schemas/src/__tests__/segment.test.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/segment.ts
findings:
  critical: 1
  warning: 6
  info: 7
  total: 14
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-07-06T05:19:49Z
**Depth:** standard
**Files Reviewed:** 42
**Status:** issues_found

## Summary

Post-gap-closure re-review (supersedes the 2026-07-06T00:00:00Z review) of the Phase 3 segmentation engine: the `@mega-crm/segments-core` SQL compiler, Zod boundary schemas, segment CRUD/preview/members API routes and repositories, the loose-index-scan event-names repository, DB migrations (table + RLS + GIN index), and the React segment builder/list/detail/delete UI plus API/E2E tests.

The core injection surfaces are correctly closed: standard fields resolve only through a null-prototype allow-list (with prototype-pollution tests), custom property keys and all values are bind parameters, LIKE wildcards are escaped, groups are always parenthesized, and tenant isolation is enforced three ways (RLS + explicit `workspace_id` predicate + `AsyncLocalStorage` context). The three call modes (count/list/point-check) demonstrably share one compiled WHERE fragment, and the earlier review's WR items (statement timeout on save paths, ILIKE escaping, Object.prototype field names, error-vs-skeleton on detail) are verifiably fixed.

However, the type-compatibility dimension of the boundary validation is still open: the Zod schema validates fields and operators independently but never together, so schema-valid definitions (e.g. `tags` + `eq`, `country` + `has_tag`, `subscriptionStatus` + `contains`) compile into SQL that is guaranteed to error at runtime — the exact "400, not 500" gap the 03-05/03-06 hardening pass closed for field names but left open for operator/value combinations. Several robustness and UI defects follow below.

## Critical Issues

### CR-01: Operator/field-type compatibility is not validated at the boundary — schema-valid definitions produce guaranteed SQL errors (500) on every evaluation route

**File:** `packages/shared-schemas/src/segment.ts:68-93` (also `packages/segments-core/src/operators.ts:60-124`)
**Issue:** `attributeConditionSchema` validates `field` (allow-list) and `operator` (16-value enum) independently, but any operator may be combined with any field, and `value` is `z.unknown().optional()`. The compiler then emits SQL that fails at query time for many schema-valid combinations. All of these pass Zod (`400` is never returned) and instead surface as Postgres errors → Fastify 500 on `POST /segments`, `PATCH /segments/:id`, `POST /segments/preview-count`, and `GET /segments/:id/members`:

- `{source:"standard", field:"tags", operator:"eq", value:"x"}` → `c.tags = $N` — `text[]` compared to a text param → `22P02 invalid array literal`.
- `{source:"standard", field:"tags", operator:"is_empty"}` → `c.tags = ''` — `text[] = text` → type error.
- `{source:"standard", field:"country", operator:"has_tag", value:"x"}` → `c.country @> ARRAY[$N]::text[]` → `42883 operator does not exist: text @> text[]`.
- `{source:"standard", field:"subscriptionStatus", operator:"eq", value:"garbage"}` → `c.subscription_status = 'garbage'` — the column is a Postgres **enum** (`packages/db/src/schema/contacts.ts:40`), so a non-enum value → `22P02 invalid input value for enum`. `contains`/ILIKE on the enum column fails similarly.
- `{source:"standard", field:"country", operator:"gt", value:5}` → `(c.country)::numeric` → cast error as soon as any contact has a non-numeric country (i.e. always).
- `{operator:"eq"}` with **no `value`** → `params.push(undefined)` → pg sends `NULL` → `column = NULL` is always false. This one does not error — it silently saves a segment whose condition can never match (member count 0), which is a wrong-results bug, not just a 5xx.
- `{operator:"in_last_days", value:"abc"}` → `('abc' || ' days')::interval` → `22007` → 500.

Note this is the same defect class the phase's own hardening suite (`segments-hardening.test.ts`, "CR-01: ... returns 400, not 500") claims to have closed — it was closed for unknown *fields* only; the operator and value dimensions remain open. An authenticated member of any workspace can trigger these 500s trivially, and `createSegment`'s in-transaction count means such definitions fail the save with an opaque 500 the frontend renders as a generic error.

**Fix:** Add a `superRefine` to `attributeConditionSchema` that enforces a field-kind → operator matrix (mirror the web builder's `OPERATORS_BY_KIND`, `apps/web/src/features/segments/SegmentBuilder.tsx:59-91`) and validates `value` shape per operator:

```ts
const STANDARD_FIELD_KINDS: Record<StandardField, "string" | "enum" | "tags"> = {
  country: "string", city: "string", firstName: "string", lastName: "string",
  phone: "string", subscriptionStatus: "enum", tags: "tags",
};
const OPERATORS_FOR_KIND: Record<string, ReadonlySet<ConditionOperator>> = {
  string: new Set(["eq","neq","contains","not_contains","is_empty","is_not_empty"]),
  enum:   new Set(["eq","neq"]),
  tags:   new Set(["has_tag","not_has_tag"]),
  // custom fields: allow the full string/number/bool/date sets
};
// in superRefine: reject operator not in the set for the field's kind;
// require a non-empty string/number `value` for value-bearing operators;
// require z.enum(["subscribed","unsubscribed","suppressed"]) for subscriptionStatus eq/neq;
// require z.number() for gt/gte/lt/lte/in_last_days.
```

For custom fields (kind unknowable server-side), at minimum validate `value` presence/primitiveness per operator, and see WR-01 for the cast guard.

## Warnings

### WR-01: Unguarded `::numeric`/`::timestamptz`/`::boolean` casts on custom properties — one bad contact value breaks the entire segment's evaluation

**File:** `packages/segments-core/src/operators.ts:83-109`
**Issue:** Number/date/bool operators on `custom` fields compile to `(c.properties ->> $N)::numeric` (etc.). The cast is applied to every scanned row, so if *any* contact in the workspace has a non-castable value for that property (e.g. `orderTotal: "N/A"` arriving later via event ingestion or CSV import), the whole query raises `22P02` and count/list/point-check all return 500 — including for a segment that saved successfully when the data was still clean. This will also break Phase 4 campaign audience resolution and Phase 6 flow point-checks against that segment, since all consumers share this compiled fragment.
**Fix:** Use a validity-guarded cast so non-castable rows simply don't match instead of aborting the query. On PG 16+:

```sql
CASE WHEN pg_input_is_valid(c.properties ->> $N, 'numeric')
     THEN (c.properties ->> $N)::numeric END > $M
```

or a regex guard (`(c.properties ->> $N) ~ '^-?[0-9]+(\.[0-9]+)?$' AND (c.properties ->> $N)::numeric > $M`) for numeric; analogous guards for timestamptz/boolean.

### WR-02: `timeframe.days` and `in_last_days` value have no upper bound — interval overflow yields 500

**File:** `packages/shared-schemas/src/segment.ts:103` (and `packages/segments-core/src/compile.ts:72-75`, `operators.ts:107-109`)
**Issue:** `days: z.number().int().min(1)` accepts values up to 2^53. Postgres interval day fields are int32, so `days: 10000000000` compiles to `('10000000000 days')::interval` → `22015 interval field value out of range` → 500 on all evaluation routes. Same for the `in_last_days` attribute operator, whose value is completely unvalidated (`z.unknown()`). `count` similarly has `min(1)` but no `max` (harmless today, but unbounded).
**Fix:** `days: z.number().int().min(1).max(3650)` (or another product-sensible ceiling), the same bound on `in_last_days` values once CR-01's value validation exists, and `count: ... .max(100000)`.

### WR-03: Non-UUID `:id` route params surface as Postgres 22P02 → 500 instead of 404

**File:** `apps/api/src/modules/segments/segments.routes.ts:209-293` (via `segment.repository.ts:219-228`)
**Issue:** `GET/PATCH/DELETE /api/workspaces/:slug/segments/:id` and `GET .../:id/members` pass `id` straight into `WHERE id = $2` against a `uuid` column. `GET /segments/not-a-uuid` raises `22P02 invalid input syntax for type uuid` → unhandled → 500. A stray browser URL or fuzzing produces 5xx noise where the correct answer is 404. (Contacts routes share this pattern, so this is a codebase-wide convention — but this phase added four more instances.)
**Fix:** Validate the param up front and short-circuit:

```ts
const uuidSchema = z.string().uuid();
if (!uuidSchema.safeParse(id).success) {
  return reply.code(404).send({ error: "Segment not found" });
}
```

(or catch pg error code `22P02` in the repository and return `null`).

### WR-04: preview-count concurrency is unbounded — statement_timeout bounds duration, not parallelism, of expensive queries against the shared pool

**File:** `apps/api/src/modules/segments/segments.routes.ts:186-207`
**Issue:** The 2s `statement_timeout` (D-08/T-03-04) caps how long *one* preview query runs, but nothing caps how many run concurrently. Each request holds a connection from the single shared `@mega-crm/tenant-context` pool (default pg pool size 10) for up to 2s. One authenticated user scripting parallel preview-count requests with pathological definitions can keep the pool saturated indefinitely, starving every other tenant's API traffic — a cross-tenant availability risk the statement timeout alone does not mitigate. `@fastify/rate-limit` is already registered with `global: false` (`server.ts:33`) exactly so routes can opt in.
**Fix:** Opt the route into rate limiting:

```ts
fastify.post("/api/workspaces/:slug/segments/preview-count",
  { config: { rateLimit: { max: 30, timeWindow: "10 seconds" } } },
  async (request, reply) => { ... });
```

### WR-05: Segments list shows the "Сегментов пока нет" empty state when a page beyond the last becomes empty (e.g. after deleting the last row on page 2)

**File:** `apps/web/src/features/segments/SegmentsListPage.tsx:83-96, 163`
**Issue:** The empty-state card renders whenever `items.length === 0`, and the pagination controls render only when `items.length > 0`. After deleting the only segment on page 2 (or navigating to an out-of-range page), the query returns `items: []` with `total > 0`: the user sees "Сегментов пока нет" — factually wrong — and the pagination controls that would let them navigate back are hidden, stranding them until a full reload.
**Fix:** Clamp the page when data shrinks and gate the empty state on `total`, not `items.length`:

```ts
useEffect(() => {
  if (data && page > 1 && data.items.length === 0 && data.total > 0) {
    setPage(Math.max(1, Math.ceil(data.total / PAGE_SIZE)));
  }
}, [data, page]);
// and: items.length === 0 && total === 0 ? <EmptyState/> : <Table/>
```

### WR-06: Server error messages are discarded — the deliberately crafted "too expensive to evaluate" 400 hint can never reach the user

**File:** `apps/web/src/features/segments/SegmentCreatePage.tsx:38-40`, `apps/web/src/features/segments/SegmentDetailPage.tsx:183-185`, `apps/web/src/features/segments/DeleteSegmentDialog.tsx:48-50`
**Issue:** All three `onError` handlers unconditionally show `GENERIC_ERROR` ("Что-то пошло не так…"). But the API layer (`lib/api.ts`) throws `ApiError` whose `.message`/`.status` carry the server's response — including the WR-03 hardening path's purpose-built `400 "Segment definition is too expensive to evaluate — narrow the conditions"` from create/update/members (routes lines 168, 251, 277). That server-side work is currently unreachable by any user: a statement-timeout save failure looks identical to a network blip, and the user gets no hint to narrow conditions. (Also note the server copy is English while the entire UI is Russian.)
**Fix:** Differentiate 4xx responses:

```ts
onError: (err) => {
  setServerError(err instanceof ApiError && err.status === 400
    ? "Не удалось вычислить сегмент при таких условиях — уберите часть условий и попробуйте снова."
    : GENERIC_ERROR);
},
```

(keyed off a machine-readable error code from the API rather than the message string, ideally — add `code: "definition_too_expensive"` to the route's 400 body).

## Info

### IN-01: types.ts claims `count` is "Required when countOperator === 'at_least' (validated by Zod at the boundary)" — no such validation exists

**File:** `packages/segments-core/src/types.ts:60-62`, `packages/shared-schemas/src/segment.ts:97-106`
**Issue:** `behavioralConditionSchema` declares `count` as plain `.optional()` with no refinement tying it to `countOperator`. The compiler defaults missing count to 1 (`compile.ts:78`), so behavior is well-defined, but the doc comment asserts a boundary guarantee that is not implemented — future readers will rely on it.
**Fix:** Either add the `superRefine` (`countOperator === "at_least" && count === undefined` → issue) or correct the comment to "defaults to 1 in the compiler".

### IN-02: `GENERIC_ERROR` is duplicated in DeleteSegmentDialog despite the "cannot drift" comment

**File:** `apps/web/src/features/segments/DeleteSegmentDialog.tsx:18`
**Issue:** `validateDefinition.ts:9` exports `GENERIC_ERROR` explicitly "so the copy cannot drift between the two flows", yet `DeleteSegmentDialog.tsx` re-declares an identical private copy instead of importing it.
**Fix:** `import { GENERIC_ERROR } from "@/features/segments/validateDefinition";` and delete the local constant.

### IN-03: Array index used as React key for groups and condition rows

**File:** `apps/web/src/features/segments/SegmentBuilder.tsx:578, 604`
**Issue:** `key={groupIndex}` / `key={conditionIndex}` with mid-list removal means React reuses component instances across logical rows. Condition values are controlled (safe), but `FieldCombobox`/`EventCombobox` hold local `open`/`search` state — removing row 0 while row 1's popover is open transfers that popover/search state to the wrong row.
**Fix:** Generate a stable client-side id per condition/group when rows are created (e.g. `crypto.randomUUID()` stored alongside draft state) and key on it.

### IN-04: `createdByUserId` nullability drift across DB, repository type, and response schema

**File:** `packages/db/migrations/0011_segments.sql:6`, `apps/api/src/modules/segments/segment.repository.ts:10`, `packages/shared-schemas/src/segment.ts:173`
**Issue:** DB column is `text NOT NULL`, `SegmentRow` types it `string`, but `segmentResponseSchema` declares `z.string().nullable()`. Also there is no FK to the better-auth `user` table, so deleting a user leaves dangling author ids (the list page degrades to "—" via the members lookup map, so cosmetic today).
**Fix:** Align the three declarations (either make the column nullable with `ON DELETE SET NULL`, or drop `.nullable()` from the schema) and document the deliberate absence of the FK.

### IN-05: `idx_contacts_tags_gin` created without CONCURRENTLY

**File:** `packages/db/migrations/0012_segments_rls_and_indexes.sql:22`
**Issue:** `CREATE INDEX ... USING gin (tags)` takes a write lock on `contacts` for the duration of the build. At the project's target scale (100k–1M contacts) this blocks contact writes/event-driven upserts during deploy. Transactional migration runners can't use `CONCURRENTLY`, so this needs an out-of-band step if applied to a large production table.
**Fix:** Acceptable now (table is small); note in the ops runbook that future large-table index builds need `CREATE INDEX CONCURRENTLY` outside the migration transaction.

### IN-06: `PATCH /segments/:id` accepts an empty body `{}` as a valid no-op that still bumps `updated_at`

**File:** `packages/shared-schemas/src/segment.ts:143-147`, `apps/api/src/modules/segments/segment.repository.ts:274-285`
**Issue:** Both fields optional with no "at least one" refinement — `PATCH {}` runs the full SELECT-FOR-UPDATE + UPDATE cycle and mutates `updated_at`, misleading the list's "Обновлён" column.
**Fix:** `updateSegmentSchema.refine((p) => p.name !== undefined || p.definition !== undefined, "at least one of name/definition required")`.

### IN-07: `neq`/`not_contains` exclude NULL-valued contacts (SQL three-valued logic)

**File:** `packages/segments-core/src/operators.ts:70-78`
**Issue:** `c.country <> 'RU'` and `NOT (c.city ILIKE ...)` evaluate to NULL (not true) for contacts where the column is NULL, so "Страна не равно RU" silently excludes every contact with no country set. Marketers typically expect negation to include unknowns. `is_empty` exists as a workaround, but users must know to OR it in.
**Fix:** Decide the intended semantics explicitly. If NULLs should match negations: `(${column} IS DISTINCT FROM $N)` for `neq` and `(${column} IS NULL OR NOT (${column} ILIKE $N))` for `not_contains`. Otherwise document the current behavior in the builder UI copy.

---

_Reviewed: 2026-07-06T05:19:49Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
