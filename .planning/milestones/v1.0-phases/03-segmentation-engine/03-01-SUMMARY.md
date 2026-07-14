---
phase: 03-segmentation-engine
plan: 01
subsystem: segmentation
tags: [zod, sql-compiler, postgres, vitest, segments-core]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion
    provides: contacts/events schema (packages/db/src/schema/contacts.ts, events.ts), withTenantTransaction/RLS pattern, contact.repository.ts's parameterized-WHERE idiom
provides:
  - "@mega-crm/segments-core: a pure, stateless compileSegmentDefinition(def, workspaceId) -> { whereSql, params }"
  - "packages/shared-schemas/src/segment.ts: the single Zod contract for SegmentDefinition + segment CRUD/preview-count request/response shapes"
affects: [03-02 (segment engine/API), 03-03 (builder UI), 03-04 (detail/members), Phase 4 (campaign audience resolution), Phase 6 (flow trigger/exit checks)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-tier AND/OR SQL compiler: conditions within a group OR'd and always parenthesized, groups AND'd (Pitfall 7 regression covered)"
    - "params: unknown[] push-then-index-length idiom extended from contact.repository.ts's listContacts to a full condition tree"
    - "Fixed STANDARD_FIELD_COLUMNS allow-list; custom-property keys always passed as ->> $N bind params, never interpolated identifiers"
    - "Behavioral EXISTS/NOT EXISTS subqueries against events, with GROUP BY/HAVING count(*) >= N for count>1 at_least conditions"
    - "Tag containment via @> ARRAY[$N]::text[] (GIN-friendly), not = ANY() (contacts.repository.ts's existing, less-optimal tag filter is left untouched, per plan scope)"

key-files:
  created:
    - packages/segments-core/package.json
    - packages/segments-core/tsconfig.json
    - packages/segments-core/src/types.ts
    - packages/segments-core/src/operators.ts
    - packages/segments-core/src/compile.ts
    - packages/segments-core/src/index.ts
    - packages/segments-core/src/__tests__/compile.test.ts
    - packages/shared-schemas/src/segment.ts
  modified:
    - packages/shared-schemas/src/index.ts

key-decisions:
  - "Added `tags: c.tags` to STANDARD_FIELD_COLUMNS (not explicitly listed in RESEARCH.md's illustrative snippet) so has_tag/not_has_tag compile through the same allow-listed path as every other attribute condition, rather than a special-case bypass."
  - "at_least with count>1 compiles to EXISTS(...GROUP BY e.contact_id HAVING count(*) >= N) rather than a repeated-EXISTS form, keeping the subquery shape uniform across count=1 and count>1."
  - "is_empty/is_not_empty implemented via plain ->> text-extraction comparisons (Open Question 2's recommendation), not a jsonb existence operator -- no GIN opclass dependency introduced."

patterns-established:
  - "compileSegmentDefinition is the single source every future count/list/point-check call mode compiles through -- this is what makes SEGM-03's cross-consumer membership guarantee structural rather than test-only."

requirements-completed: [SEGM-01, SEGM-02, SEGM-03]

coverage:
  - id: D1
    description: "Two-tier AND/OR SQL condition compiler (packages/segments-core) turning a versioned SegmentDefinition into one parameterized WHERE fragment"
    requirement: "SEGM-01"
    verification:
      - kind: unit
        ref: "packages/segments-core/src/__tests__/compile.test.ts#compileSegmentDefinition -- attribute conditions"
        status: pass
      - kind: unit
        ref: "packages/segments-core/src/__tests__/compile.test.ts#compileSegmentDefinition -- two-tier AND/OR parenthesization (Pitfall 7)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Behavioral EXISTS/NOT EXISTS conditions with count/timeframe, including negation and count>1"
    requirement: "SEGM-02"
    verification:
      - kind: unit
        ref: "packages/segments-core/src/__tests__/compile.test.ts#compileSegmentDefinition -- behavioral conditions"
        status: pass
    human_judgment: false
  - id: D3
    description: "Shared Zod contract (packages/shared-schemas/src/segment.ts) as the single validation source for API + future frontend builder"
    requirement: "SEGM-03"
    verification:
      - kind: unit
        ref: "npm run build -w packages/shared-schemas (tsc clean) + manual safeParse smoke test (valid/empty-groups/unknown-operator)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Fails-closed SQL-injection mitigation: unknown standard field or unknown operator throws rather than reaching SQL"
    requirement: "SEGM-01"
    verification:
      - kind: unit
        ref: "packages/segments-core/src/__tests__/compile.test.ts#fails closed on an unknown standard field / operator"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-05
status: complete
---

# Phase 3 Plan 1: Segment Condition Compiler Summary

**Pure `@mega-crm/segments-core` package with a two-tier AND/OR SQL condition compiler (`compileSegmentDefinition`) and the shared `segment.ts` Zod contract, proven by 16 passing unit tests with no database dependency.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-05T18:22:00Z (approx.)
- **Completed:** 2026-07-05T18:29:00Z
- **Tasks:** 2 (Task 2 executed as TDD RED → GREEN)
- **Files modified:** 9

## Accomplishments
- New pure package `@mega-crm/segments-core` (no `pg`/`pino` runtime deps -- it's a compiler, not an I/O module) with `types.ts`, `operators.ts`, `compile.ts`, and a barrel `index.ts`.
- `compileSegmentDefinition(def, workspaceId)` turns a versioned `SegmentDefinition` JSON into a single parameterized `whereSql` + `params` array, with every OR-group always parenthesized (D-01, Pitfall 7 regression covered) and a leading `c.workspace_id = $1` clause.
- All 17 D-03 operators implemented (string/number/bool/date/tag, including negations) through a fixed `STANDARD_FIELD_COLUMNS` allow-list and a parameterized `properties ->> $N` path for custom fields -- neither a field name nor an operator ever reaches SQL as a raw client string.
- Behavioral conditions compile to `EXISTS`/`NOT EXISTS` subqueries over `events`, honoring `count > 1` via `GROUP BY e.contact_id HAVING count(*) >= N` (not silently truncated to `>= 1`).
- `packages/shared-schemas/src/segment.ts`: the single Zod contract (`segmentDefinitionSchema`, condition/group/operator schemas, plus `createSegmentSchema`/`updateSegmentSchema`/`segmentResponseSchema`/list-query/`previewCountSchema`) that every future API route and frontend builder validates against.

## Task Commits

Each task was committed atomically:

1. **Task 1: Scaffold @mega-crm/segments-core package + the shared Zod segment contract** - `7e5c402` (feat)
2. **Task 2: Implement the two-tier AND/OR SQL condition compiler (RED → GREEN)** - `4fb819f` (test, RED) + `cc41944` (feat, GREEN)

**Plan metadata:** (this commit)

_Note: Task 2 is a TDD task -- RED and GREEN are separate commits per plan instructions._

## Files Created/Modified
- `packages/segments-core/package.json` - New pure package manifest (`@mega-crm/segments-core`, no `pg`/`pino` deps, `vitest` devDependency)
- `packages/segments-core/tsconfig.json` - Copied verbatim from `contacts-core`
- `packages/segments-core/src/types.ts` - `SegmentDefinition`/`SegmentGroup`/`SegmentCondition`/`AttributeCondition`/`BehavioralCondition`/`ConditionOperator`/`CompiledSegment` TS types
- `packages/segments-core/src/operators.ts` - `STANDARD_FIELD_COLUMNS` allow-list + `compileOperator` covering all 17 operators
- `packages/segments-core/src/compile.ts` - `compileSegmentDefinition`/`compileCondition`/`compileAttributeCondition`/`compileBehavioralCondition`
- `packages/segments-core/src/index.ts` - Barrel export (types + operators + compile)
- `packages/segments-core/src/__tests__/compile.test.ts` - 16 pure-function unit tests, no DB dependency
- `packages/shared-schemas/src/segment.ts` - Zod contract for `SegmentDefinition` + segment CRUD/preview-count API shapes
- `packages/shared-schemas/src/index.ts` - Added `export * from "./segment.js"`

## Decisions Made
- Added `tags: "c.tags"` to `STANDARD_FIELD_COLUMNS` -- RESEARCH.md's illustrative allow-list snippet didn't list it, but `has_tag`/`not_has_tag` need a real allow-listed column and there is exactly one tags column; routing it through the same allow-list (rather than a bypass) keeps the fails-closed guarantee uniform.
- `at_least` with `count > 1` uses `GROUP BY e.contact_id HAVING count(*) >= N` inside the same `EXISTS(...)` shape used for `count = 1`, rather than a structurally different repeated-EXISTS form -- keeps the subquery template consistent regardless of N.
- `is_empty`/`is_not_empty` compile to plain `IS NULL OR = ''` / `IS NOT NULL AND <> ''` text comparisons over the same `->>`-extracted column already used for every other string operator (Open Question 2's recommendation) -- no jsonb existence operator, no new GIN opclass dependency.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `tags` to the STANDARD_FIELD_COLUMNS allow-list**
- **Found during:** Task 2 (writing the has_tag/not_has_tag compiler tests)
- **Issue:** RESEARCH.md's/plan's illustrative `STANDARD_FIELD_COLUMNS` snippet only listed `country/city/firstName/lastName/phone/subscriptionStatus`. Without a `tags` entry, `has_tag`/`not_has_tag` conditions (explicitly required by D-03/SEGM-01) would have no allow-listed column to compile against and would either throw incorrectly or require an allow-list bypass -- both worse than adding the one missing, obviously-safe mapping.
- **Fix:** Added `tags: "c.tags"` to `STANDARD_FIELD_COLUMNS` in `operators.ts`, keeping tag conditions on the exact same fails-closed allow-list path as every other standard field.
- **Files modified:** `packages/segments-core/src/operators.ts`
- **Verification:** `compile.test.ts`'s has_tag/not_has_tag tests pass; `grep -n "@> ARRAY\["` confirms the GIN-friendly containment fragment is present.
- **Committed in:** `cc41944` (Task 2 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Necessary to satisfy SEGM-01's tag-condition requirement and the plan's own has_tag/not_has_tag acceptance criterion; no scope creep beyond the allow-list itself.

### Documentation note (not a code deviation)

The plan's Task 1 acceptance criterion states `conditionOperatorSchema` enumerates "exactly the 16 operators listed." Counting the operators actually named in both the plan's own Task 1 action text and RESEARCH.md's Code Examples (eq, neq, contains, not_contains, is_empty, is_not_empty, gt, gte, lt, lte, is_true, is_false, before, after, in_last_days, has_tag, not_has_tag) yields **17**, not 16. `conditionOperatorSchema` implements exactly this named 17-operator list (verified: `conditionOperatorSchema.options.length === 17`), matching RESEARCH.md's Code Examples verbatim. No operator was added or removed relative to the plan/research's explicit lists -- only the acceptance criterion's summary count appears to be off by one against its own named list.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `@mega-crm/segments-core`'s `compileSegmentDefinition` and `packages/shared-schemas/src/segment.ts` are ready for 03-02 (segment engine/API: `segments` table + migration, `segment.repository.ts`'s count/list/point-check wrappers, `segments.routes.ts`, event-names loose-index-scan endpoint).
- No blockers. The compiler is fully unit-tested in isolation (no DB), matching RESEARCH.md's Wave 0 gap for `packages/segments-core/src/__tests__/compile.test.ts`.

---
*Phase: 03-segmentation-engine*
*Completed: 2026-07-05*

## Self-Check: PASSED

- FOUND: packages/segments-core/package.json
- FOUND: packages/segments-core/src/compile.ts
- FOUND: packages/segments-core/src/operators.ts
- FOUND: packages/segments-core/src/__tests__/compile.test.ts
- FOUND: packages/shared-schemas/src/segment.ts
- FOUND commit: 7e5c402 (Task 1)
- FOUND commit: 4fb819f (Task 2 RED)
- FOUND commit: cc41944 (Task 2 GREEN)
- Re-ran plan verification: `npm run build -w packages/shared-schemas` clean, `npm run build -w packages/segments-core` clean, `npx vitest run packages/segments-core` 16/16 pass, `grep -n "@> ARRAY\["` present in operators.ts
