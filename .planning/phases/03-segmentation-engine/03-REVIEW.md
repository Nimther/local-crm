---
phase: 03-segmentation-engine
reviewed: 2026-07-06T00:00:00Z
depth: standard
files_reviewed: 36
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/modules/segments/__tests__/attribute-conditions.test.ts
  - apps/api/src/modules/segments/__tests__/behavioral-conditions.test.ts
  - apps/api/src/modules/segments/__tests__/preview-count.test.ts
  - apps/api/src/modules/segments/__tests__/unified-engine-contract.test.ts
  - apps/api/src/modules/segments/event-names.repository.ts
  - apps/api/src/modules/segments/segment.repository.ts
  - apps/api/src/modules/segments/segments.routes.ts
  - apps/api/src/server.ts
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
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/segment.ts
findings:
  critical: 1
  warning: 7
  info: 10
  total: 18
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-07-06
**Depth:** standard
**Files Reviewed:** 36
**Status:** issues_found

## Summary

Reviewed the segmentation engine end to end: the SQL condition compiler (`packages/segments-core`), Zod boundary schemas, the RLS-scoped `segments` table and migrations, the evaluation repository and segments routes, and the builder/list/detail UI, plus the four API test suites and the e2e spec.

The core security posture is sound where it was designed to be: **values are always parameterized** (verified across every operator branch in `operators.ts`), **custom-property keys are bind params, never identifiers** (`compile.ts:53-54`), the compiled WHERE always carries `c.workspace_id = $1` as app-level defense-in-depth on top of RLS, `segments` gets the same ENABLE + FORCE + `workspace_isolation` triplet as other tenant tables (`0012_segments_rls_and_indexes.sql`), and `contacts`/`events` were confirmed FORCE-RLS'd from earlier migrations. The 404-not-401 workspace-oracle pattern is applied consistently, and the unified-engine contract test genuinely proves count/list/point-check agreement.

However, the review found one BLOCKER in the primary save flow (default builder state produces a 500 that the UI silently swallows), and a cluster of warnings around the validation boundary: the Zod schema is far looser than the compiler assumes (any `field` string, any operator against any field kind), which converts user-reachable inputs into raw Postgres statement errors (500s) instead of 400s, breaks the allow-list's fail-closed guarantee via prototype-chain lookup, and leaves the stated DoS bound (statement_timeout) covering only one of four evaluation paths.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: Default builder state saves to a 500; error is silently swallowed — broken primary create flow

**File:** `packages/shared-schemas/src/segment.ts:44`, `apps/web/src/features/segments/SegmentCreatePage.tsx:18-35,52-59`, `packages/segments-core/src/compile.ts:47-50`
**Issue:** Three gaps compose into a broken happy path:
1. `attributeConditionSchema` validates `field: z.string()` — empty string and any unknown field name pass Zod for `source: "standard"`.
2. Client-side `validateDefinition` (SegmentCreatePage.tsx:18) only validates **behavioral** conditions; attribute conditions with an empty field (the builder's default `newAttributeCondition()` state, SegmentBuilder.tsx:117-119) pass untouched. The preview path is gated by `isConditionReadyForPreview`, but the save path is not.
3. The create mutation (SegmentCreatePage.tsx:52-59) has **no `onError`** and never renders `mutation.isError`, and there is no global MutationCache handler (`lib/queryClient.ts`).

Concrete reproduction: user opens «Создать сегмент», types a name, never touches the pre-filled empty condition row, clicks «Сохранить сегмент». POST passes Zod, `createSegment` runs, `compileSegmentDefinition` throws `Unknown standard field: ` inside the route handler → Fastify 500 → the UI shows nothing at all; the button just appears to do nothing. The same server gap makes preview-count/POST/PATCH return 500 (not 400) for any unknown-field definition sent directly to the API. Note the test `"rejects an unknown-field definition with 400"` (preview-count.test.ts:120) actually sends a bogus *operator*, not a bogus field — the unknown-field-over-HTTP path is untested and returns 500.
**Fix:**
```ts
// shared-schemas/src/segment.ts — validate standard fields at the boundary:
const standardFieldSchema = z.enum(["country", "city", "firstName", "lastName", "phone", "subscriptionStatus", "tags"]);
export const attributeConditionSchema = z.discriminatedUnion("source", [
  z.object({ type: z.literal("attribute"), source: z.literal("standard"), field: standardFieldSchema, operator: conditionOperatorSchema, value: z.unknown().optional() }),
  z.object({ type: z.literal("attribute"), source: z.literal("custom"), field: z.string().min(1), operator: conditionOperatorSchema, value: z.unknown().optional() }),
]);
```
Additionally: extend the client `validateDefinition` to reject attribute conditions with empty `field` (and missing `value` for value-requiring operators), and add `onError: () => setServerError(GENERIC_ERROR)` + error rendering to the create mutation (mirroring SegmentDetailPage).

## Warnings

### WR-01: Prototype-chain lookup breaks the allow-list's fail-closed guarantee

**File:** `packages/segments-core/src/compile.ts:47-51`, `packages/segments-core/src/operators.ts:17-25`
**Issue:** `STANDARD_FIELD_COLUMNS` is a plain object literal, so `STANDARD_FIELD_COLUMNS[cond.field]` resolves **inherited** `Object.prototype` members. Verified empirically: `field: "constructor"`, `"toString"`, `"hasOwnProperty"`, `"__proto__"` all return truthy values, bypass the `if (!mapped) throw` guard, and get template-interpolated into the SQL as e.g. `function Object() { [native code] } = $2`. The interpolated text is fixed native-code stringification (not attacker-controlled), so this is not an injection vector, but the phase's stated primary SQLi mitigation ("a client-supplied field NEVER reaches SQL as a raw identifier ... fails closed") is factually violated: a non-allow-listed client string selects what gets interpolated, and the result is a Postgres syntax error surfacing as a 500 instead of a clean rejection. CR-01's Zod enum closes the HTTP path, but the compiler must be fail-closed on its own terms — it is the documented last line of defense and has other callers (worker, future phases).
**Fix:**
```ts
// operators.ts — remove the prototype chain entirely:
export const STANDARD_FIELD_COLUMNS: Record<string, string> = Object.assign(Object.create(null), {
  country: "c.country", /* ... */
});
// or in compile.ts:
const mapped = Object.hasOwn(STANDARD_FIELD_COLUMNS, cond.field) ? STANDARD_FIELD_COLUMNS[cond.field] : undefined;
```
Add a compile test asserting `field: "constructor"` throws.

### WR-02: No per-field-kind operator/value validation — accepted definitions produce runtime statement errors (500s), including data-dependent breakage of saved segments

**File:** `packages/shared-schemas/src/segment.ts:41-60`, `packages/segments-core/src/operators.ts:62-94`
**Issue:** Zod validates the operator against the full 17-operator enum regardless of field kind, and `value` is `z.unknown()`. The compiler then emits hard casts. Every one of these passes validation and dies as a Postgres statement error → unhandled 500 (preview-count only maps `57014`; `22P02`/`42883` rethrow):
- `gt/gte/lt/lte` on a text column or custom property: `(c.country)::numeric` / `(c.properties ->> $N)::numeric` errors (`22P02`) if **any** in-tenant row holds a non-numeric value.
- `has_tag` on any non-array column (`c.country @> ARRAY[...]` — operator does not exist, `42883`); `is_empty`/`eq` with a non-label value on `subscription_status` (Postgres enum → invalid input value).
- `before/after/in_last_days` with a non-date/non-numeric `value` (`22P02`); `days`/`count` have `min(1)` but no max — `days: 10**15` overflows `::interval` (`22015`).

The worst variant is time-delayed: a `gt`-on-custom-property segment saved while all property values are numeric starts **permanently 500ing on GET /members and on any PATCH** the moment one contact later receives a non-numeric value for that property (event ingestion and CSV import both write freeform `properties`). RLS confines the blast radius to the tenant's own rows (policy quals evaluate before non-leakproof user quals), but within the tenant this is a real production-breakage path with no recovery in the UI.
**Fix:** Two layers: (1) in shared-schemas, constrain operator per source/kind where knowable and give `value` a concrete schema per operator (`z.coerce.number()` for gt/gte/lt/lte/in_last_days with a sane `max`, `z.string()` for string/tag ops, enum labels for subscriptionStatus); (2) in operators.ts, compile numeric/timestamp comparisons defensively so bad row data excludes the row instead of aborting the statement, e.g.:
```sql
-- instead of (col)::numeric > $N
(col ~ '^-?[0-9]+(\.[0-9]+)?$' AND (col)::numeric > $N)
```
(or a `safe_numeric` SQL helper). At minimum, map non-timeout Postgres data errors (`22xxx` class) on the preview path to a 400/degraded response rather than 500.

### WR-03: statement_timeout DoS bound covers only preview-count; create, update, and members evaluate definitions unbounded

**File:** `apps/api/src/modules/segments/segments.routes.ts:28-36,140-143,206-214,233`, `apps/api/src/modules/segments/segment.repository.ts:93-118,145-171,217-254`
**Issue:** The route comment claims preview-count "is the one call mode where a client can submit an arbitrary (unsaved) definition" — that is not true. `POST /segments` and `PATCH /segments/:id` accept an equally arbitrary definition and synchronously run the same `count(*)` inside `createSegment`/`updateSegment` with **no** `statementTimeoutMs`, and `GET /:id/members` runs count + list for the saved definition unbounded on every page view. A member can hammer POST/PATCH with pathological definitions (many custom-property `->>` conditions the 0012 migration comment explicitly says have no index and rely on the timeout as "the DoS safety net") at the same rate as preview, holding tenant-pool connections indefinitely — exactly the T-03-04 scenario the timeout was added to prevent. Extra sting: create/update hold the timeout-less count **inside the INSERT/UPDATE transaction** (with `FOR UPDATE` on the row in updateSegment), extending lock hold times.
**Fix:** Pass a statement timeout on every evaluation path — a generous one (e.g. 10–15s) for create/update/members if 2s is deemed too tight for saves — and map `57014` on create/update to a 4xx "definition too expensive" response. Alternatively compute the initial member_count outside the write transaction.

### WR-04: LIKE wildcards not escaped in contains/not_contains — wrong membership for values containing %, _ or \

**File:** `packages/segments-core/src/operators.ts:52-57`
**Issue:** `params.push(`%${String(value)}%`)` embeds the raw user value inside an ILIKE pattern. `%` and `_` in the value are interpreted as wildcards: `contains "50%_off"` matches "50 anything off…", `contains "%"` matches every non-null row, and a trailing `\` can produce an invalid pattern. Parameterized (no injection), but the computed membership — the product's core promise — is silently wrong for these values.
**Fix:**
```ts
const escaped = String(value).replace(/[\\%_]/g, (m) => `\\${m}`);
params.push(`%${escaped}%`);
return `${column} ILIKE $${params.length}`; // backslash is the default ESCAPE char
```

### WR-05: Segments list UI hardcodes page 1 — segments beyond the first 20 are unreachable

**File:** `apps/web/src/features/segments/SegmentsListPage.tsx:22,40-45`
**Issue:** The query is fixed at `{ page: 1, pageSize: PAGE_SIZE }` with no pagination controls; `total` from the response is never used. The 21st segment a tenant creates is invisible in the UI (it exists only via direct URL), with no indicator that anything is missing. D-10 specifies a paginated list; the API supports it; the UI doesn't.
**Fix:** Add `page` state + Назад/Вперёд controls exactly as `SegmentMembersTable` already does in `SegmentDetailPage.tsx:140-158`.

### WR-06: Segment detail page shows an infinite skeleton on 404/error; the not-found branch is unreachable

**File:** `apps/web/src/features/segments/SegmentDetailPage.tsx:230-249`
**Issue:** `if (segmentQuery.isLoading || !definition) return <Skeleton/>` — when `getSegment` rejects (deleted segment, bad id, network error), `isLoading` becomes false but `definition` stays `null`, so the skeleton renders forever. The subsequent `if (!segmentQuery.data)` "Сегмент не найден" card can never render, because reaching it requires `definition` to be set, which only happens from `segmentQuery.data`. Dead code masking a hang.
**Fix:** Check the error state first:
```tsx
if (segmentQuery.isError) return <NotFoundCard />;
if (segmentQuery.isLoading || !definition) return <Skeleton />;
```

### WR-07: Create-segment mutation has no error feedback of any kind

**File:** `apps/web/src/features/segments/SegmentCreatePage.tsx:52-59`
**Issue:** Beyond the CR-01 validation scenario, **any** failure of `createSegment` (network error, 5xx, session expiry) is silent: the mutation defines no `onError`, `mutation.isError` is never rendered, and there is no global MutationCache handler. The user clicks save and nothing happens. The sibling flows (SegmentDetailPage save, DeleteSegmentDialog) both set and render `serverError` — the create page omits the pattern.
**Fix:** Add `onError: () => setServerError(GENERIC_ERROR)` and render it, matching `SegmentDetailPage.tsx:195-209,269`.

## Info

### IN-01: `:id` route params not validated as UUID — non-UUID ids return 500, not 404

**File:** `apps/api/src/modules/segments/segments.routes.ts:182-187,196,223,240`
**Issue:** `GET /segments/not-a-uuid` reaches `WHERE id = $2` and dies with Postgres `22P02` → 500. Matches the pre-existing contacts-routes pattern, so flagged for consistency, not regression.
**Fix:** `z.string().uuid()` on `:id` params (in both modules), returning 404 on failure.

### IN-02: Doc claims Zod requires `count` for `at_least` — it does not

**File:** `packages/segments-core/src/types.ts:60-62`, `packages/shared-schemas/src/segment.ts:55`
**Issue:** The comment says "Required when countOperator === 'at_least' (validated by Zod at the boundary)" but the schema has plain `count: ...optional()` with no refine. The compiler silently defaults to 1 — sane, but the documented invariant is false and future consumers may rely on it.
**Fix:** Add `.superRefine` requiring `count` when `countOperator === "at_least"`, or correct the comment.

### IN-03: tags conditions supported by engine and tested, but not exposed in the builder UI

**File:** `apps/web/src/features/segments/SegmentBuilder.tsx:42-49,58-86`
**Issue:** `has_tag`/`not_has_tag` and the `tags` field exist in the compiler, schemas, GIN index (0012), and API tests — but `STANDARD_FIELDS`/`OPERATORS_BY_KIND` never offer them, so no user can build a tag condition. Tests writing `field: "tags" as never` also hint at type friction. If deliberate deferral, document it; otherwise a shipped-but-unreachable feature.
**Fix:** Add `{ field: "tags", label: "Теги", kind: "tags" }` with a `tags` operator group, or record the deferral.

### IN-04: `validateDefinition` duplicated verbatim across create and detail pages

**File:** `apps/web/src/features/segments/SegmentCreatePage.tsx:18-35`, `apps/web/src/features/segments/SegmentDetailPage.tsx:26-43`
**Issue:** Identical 18-line function copy-pasted; the CR-01 fix must touch both or they drift.
**Fix:** Extract to `features/segments/validateDefinition.ts` and import in both.

### IN-05: Array-index React keys for group/condition rows

**File:** `apps/web/src/features/segments/SegmentBuilder.tsx:573,599`
**Issue:** `key={groupIndex}` / `key={conditionIndex}` with mid-list removal means uncontrolled row-local state (combobox `open`/`search` in FieldCombobox/EventCombobox) can attach to the wrong row after a deletion.
**Fix:** Generate a stable client-side id per group/condition on creation and use it as the key.

### IN-06: `segments` list ordering has no tie-breaker and `workspace_id` has no index

**File:** `apps/api/src/modules/segments/segment.repository.ts:181-186`, `packages/db/migrations/0011_segments.sql`
**Issue:** `ORDER BY created_at DESC` without `id` tie-breaker can paginate unstably for equal timestamps — the contacts/members paths deliberately added one (Open Question 3) but listSegments didn't. No index on `segments(workspace_id)` for the list filter/RLS qual or the FK cascade; fine at current cardinality, cheap to add now.
**Fix:** `ORDER BY created_at DESC, id ASC`; `CREATE INDEX ON segments (workspace_id, created_at DESC)`.

### IN-07: `created_by_user_id` has no FK, and repo/response types disagree on nullability

**File:** `packages/db/migrations/0011_segments.sql:6`, `apps/api/src/modules/segments/segment.repository.ts:10`, `packages/shared-schemas/src/segment.ts:127`
**Issue:** Column is `text NOT NULL` with no FK to the auth user table (dangling author after user deletion — list UI already tolerates it with "—"), while `SegmentRow.createdByUserId: string` and `segmentResponseSchema...nullable()` disagree with each other. Pick one contract.
**Fix:** Either add `REFERENCES "user"(id) ON DELETE SET NULL` and make the column/type nullable, or keep NOT NULL and drop `.nullable()` from the response schema.

### IN-08: statement_timeout set via string interpolation

**File:** `apps/api/src/modules/segments/segment.repository.ts:75-77`
**Issue:** `SET LOCAL statement_timeout = ${Number(opts.statementTimeoutMs)}` — the `Number()` guard prevents injection (worst case `NaN` → SQL syntax error), and the only current caller passes a constant, but it is the one non-parameterized value interpolation in the module.
**Fix:** `await client.query("SELECT set_config('statement_timeout', $1, true)", [String(ms)])` — matches the tenant-context GUC pattern.

### IN-09: event-names endpoint returns an unbounded list

**File:** `apps/api/src/modules/segments/event-names.repository.ts:11-31`
**Issue:** The loose-index-scan CTE is the right pattern (correct termination via the `IS NOT NULL` recursion guard), but there is no cap on distinct names — a tenant ingesting high-cardinality event names (e.g. names with embedded ids) makes this response arbitrarily large and the recursion arbitrarily deep on every builder mount.
**Fix:** Add a `LIMIT` (e.g. 500) to the outer select and a matching iteration cap; the combobox is a picker, not an export.

### IN-10: `neq`/`not_contains` never match NULL columns — likely surprising membership semantics

**File:** `packages/segments-core/src/operators.ts:49-57`
**Issue:** `c.country <> $N` excludes contacts with `country IS NULL` (standard SQL three-valued logic). A marketer building «Страна не равно RU» almost certainly expects contacts with no country set to be included. Same for `not_contains`. This is a product-semantics decision, but it is currently implicit and untested.
**Fix:** Decide explicitly; if NULLs should match negations, compile `(${column} IS DISTINCT FROM $N)` for `neq` and `(${column} IS NULL OR NOT (${column} ILIKE $N))` for `not_contains`, and add tests pinning the choice.

---

_Reviewed: 2026-07-06_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
