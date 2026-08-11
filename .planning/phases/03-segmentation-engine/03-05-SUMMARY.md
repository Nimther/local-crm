---
phase: 03-segmentation-engine
plan: 05
subsystem: api
tags: [zod, sql-compiler, security, segments, validation]

# Dependency graph
requires:
  - phase: 03-01
    provides: STANDARD_FIELD_COLUMNS allow-list and compileSegmentDefinition/compileAttributeCondition in packages/segments-core
  - phase: 03-02
    provides: segment.ts Zod contract and segment.repository.ts persistence this contract validates before
provides:
  - "STANDARD_FIELD_KEYS exported allow-list (7 keys incl. tags) from @mega-crm/shared-schemas, mirroring segments-core's STANDARD_FIELD_COLUMNS"
  - "attributeConditionSchema superRefine that fails closed on empty/unknown standard field and empty custom field at the Zod boundary (400, not a compiler-thrown 500)"
  - "Prototype-safe STANDARD_FIELD_COLUMNS (Object.create(null)) so constructor/toString/hasOwnProperty/__proto__ never resolve truthy"
  - "LIKE-wildcard escaping (\\, %, _) in contains/not_contains so ILIKE substring matching is correct for wildcard-bearing values"
affects: ["03-06 (API routes consuming this Zod contract)", "03-07 (web segment builder consuming STANDARD_FIELD_KEYS/field type)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Zod superRefine used to enforce a discriminant-conditional allow-list without narrowing the static field type away from string (keeps downstream empty-field sentinel draft state type-checking)"
    - "Object.create(null) allow-list maps as the standard mitigation for prototype-chain lookup injection (fails closed on inherited Object.prototype member names)"
    - "Escape backslash-then-wildcards (in that order) before wrapping a user value for ILIKE, relying on Postgres's default backslash ESCAPE char"

key-files:
  created:
    - packages/shared-schemas/src/__tests__/segment.test.ts
  modified:
    - packages/shared-schemas/src/segment.ts
    - packages/shared-schemas/src/index.ts
    - packages/shared-schemas/package.json
    - packages/segments-core/src/operators.ts
    - packages/segments-core/src/__tests__/compile.test.ts

key-decisions:
  - "attributeConditionSchema.field stays typed as plain string (not narrowed via discriminated union or z.enum) -- the allow-list is enforced only at superRefine parse time, so the web builder's empty-field draft sentinel keeps type-checking"
  - "WR-01 fixed via Object.create(null) on STANDARD_FIELD_COLUMNS rather than adding an Object.hasOwn guard in compile.ts -- the null-prototype object alone makes the existing `if (!mapped) throw` check fail closed on inherited names, so compile.ts required no change"
  - "LIKE escaping order is backslash first, then % and _ -- escaping the literal backslash after the wildcards would double-escape the backslashes just inserted"

patterns-established:
  - "Shared allow-list mirroring: STANDARD_FIELD_KEYS (Zod boundary) and STANDARD_FIELD_COLUMNS (SQL compiler) are two independently-enforced copies of the same 7-key list, each failing closed on its own terms -- neither depends on the other to be correct (defense in depth per the threat model's two trust boundaries)"

requirements-completed: [SEGM-01, SEGM-03]

coverage:
  - id: D1
    description: "Zod contract rejects empty/unknown standard field and empty custom field; accepts a valid tags/has_tag condition; STANDARD_FIELD_KEYS exported with exactly 7 keys"
    requirement: "SEGM-01"
    verification:
      - kind: unit
        ref: "packages/shared-schemas/src/__tests__/segment.test.ts (11 tests, all passing)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Compiler fails closed on inherited Object.prototype field names (constructor, toString, hasOwnProperty, __proto__) via a null-prototype allow-list"
    requirement: "SEGM-03"
    verification:
      - kind: unit
        ref: "packages/segments-core/src/__tests__/compile.test.ts#fails closed on an inherited Object.prototype field name (WR-01)"
        status: pass
    human_judgment: false
  - id: D3
    description: "contains/not_contains escape %, _, \\ before wrapping in ILIKE pattern so membership is correct for wildcard-bearing values"
    requirement: "SEGM-03"
    verification:
      - kind: unit
        ref: "packages/segments-core/src/__tests__/compile.test.ts#escapes LIKE wildcard characters (both contains and not_contains cases)"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-06
status: complete
---

# Phase 3 Plan 5: Zod boundary + SQL compiler hardening Summary

**Zod `attributeConditionSchema` now fails closed on empty/unknown standard fields via a `superRefine`-enforced `STANDARD_FIELD_KEYS` allow-list, and the `segments-core` SQL compiler's own allow-list is rebuilt on `Object.create(null)` with LIKE-wildcard-escaped `contains`/`not_contains`, closing CR-01/WR-01/WR-04 at the root.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-06
- **Tasks:** 2
- **Files modified:** 6 (1 created, 5 modified)

## Accomplishments

- The Zod contract at the API boundary rejects an empty or unknown `source:"standard"` field (and an empty `source:"custom"` field) with a validation failure, instead of letting it reach the compiler where it previously threw an uncaught 500 (CR-01 root cause).
- A `tags` standard field with `has_tag`/`not_has_tag` now passes the Zod contract, since `tags` is one of the 7 allow-listed keys in the newly-exported `STANDARD_FIELD_KEYS` (mirrors segments-core's `STANDARD_FIELD_COLUMNS` name-for-name).
- The SQL compiler's `STANDARD_FIELD_COLUMNS` allow-list is now built on `Object.create(null)`, so a client-supplied field like `constructor`, `toString`, `hasOwnProperty`, or `__proto__` can no longer resolve truthy via inherited-prototype lookup -- the existing `if (!mapped) throw` in `compileAttributeCondition` now genuinely fails closed on every non-allow-listed name, not just unassigned ones (WR-01).
- `contains`/`not_contains` escape `\`, `%`, and `_` in the user-supplied value before wrapping it in `%...%`, so substring membership is correct even when the value itself contains SQL LIKE wildcard characters (WR-04) -- e.g. a coupon code `50%_off` no longer gets misinterpreted as a LIKE pattern.

## Task Commits

Each task was committed atomically:

1. **Task 1: Constrain the standard-field allow-list at the Zod boundary (CR-01/WR-01 root cause)** - `a368199` (feat)
2. **Task 2: Fail-closed prototype-safe compiler + LIKE-wildcard escaping (WR-01, WR-04)** - `41b7df0` (fix)

**Plan metadata:** committed alongside this SUMMARY.

## Files Created/Modified

- `packages/shared-schemas/src/segment.ts` - Added `STANDARD_FIELD_KEYS` (7-key allow-list) and `standardFieldSchema`; `attributeConditionSchema` now wraps its object shape in a `superRefine` enforcing the allow-list for `source:"standard"` and non-empty-string for `source:"custom"`
- `packages/shared-schemas/src/index.ts` - No functional change needed (existing `export * from "./segment.js"` already re-exports `STANDARD_FIELD_KEYS`/`StandardField`)
- `packages/shared-schemas/package.json` - Added `"test": "vitest run"` script and `vitest@4.1.9` devDependency (same pinned version as segments-core)
- `packages/shared-schemas/src/__tests__/segment.test.ts` - New file: 11 vitest cases covering the allow-list, empty-field rejection, tags acceptance, custom-field non-empty enforcement, and full `segmentDefinitionSchema` integration
- `packages/segments-core/src/operators.ts` - `STANDARD_FIELD_COLUMNS` rebuilt via `Object.assign(Object.create(null), {...})`; added `escapeLikeWildcards` helper used by `contains`/`not_contains` in `compileOperator`
- `packages/segments-core/src/__tests__/compile.test.ts` - Added 3 cases: prototype-chain field names throw (looped over 4 names), `contains` wildcard escaping, `not_contains` wildcard escaping

## Decisions Made

- Kept `attributeConditionSchema.field` as plain `string` (not narrowed to a `StandardField`/discriminated-union literal) -- enforcing the allow-list only at `superRefine` parse time preserves the web builder's empty-field draft sentinel's ability to type-check, per the plan's explicit constraint.
- Fixed WR-01 by rebuilding `STANDARD_FIELD_COLUMNS` on `Object.create(null)` rather than adding a separate `Object.hasOwn` guard in `compile.ts` -- verified with a direct Node check that a null-prototype object resolves `constructor`/`toString`/`hasOwnProperty`/`__proto__` as `undefined`, so the existing `if (!mapped) throw` already fails closed with no `compile.ts` changes required.
- Escape order in `escapeLikeWildcards` is backslash first, then `%`/`_` -- escaping the backslashes inserted by the wildcard-escaping step afterward would double-escape them.

## Deviations from Plan

None - plan executed exactly as written. `compile.ts` was listed in the plan's `files_modified` as a possible target ("Either build STANDARD_FIELD_COLUMNS on a null prototype... or guard the lookup in compileAttributeCondition..."), and the null-prototype approach (chosen per the plan's own stated preference in the artifacts list) fully satisfied WR-01 without needing a `compile.ts` edit -- verified via the new "fails closed on an inherited Object.prototype field name" test.

## Issues Encountered

None. Verified with a standalone Node script early on that Zod 4's `discriminatedUnion` correctly accepts a `ZodEffects`-wrapped member (the `attributeConditionSchema.superRefine(...)` result) as one of its options, before committing to the `superRefine`-on-the-object-schema approach the plan specified.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The shared `STANDARD_FIELD_KEYS` allow-list is now importable from `@mega-crm/shared-schemas` for 03-06 (API routes) to reuse directly rather than re-deriving the field list.
- The Zod boundary and SQL compiler each independently fail closed on their own terms (defense in depth) -- 03-06/03-07 can build on a contract that actually rejects the previously-500ing empty/unknown field case, and the web builder (03-07) can safely surface `tags` as a selectable standard field.
- `npm run build` and `npm run test` are clean across the whole workspace (`packages/db`, `packages/contacts-core`, `apps/api`, `apps/web`, `apps/worker` all build; `shared-schemas` 11/11 and `segments-core` 19/19 vitest pass).

---
*Phase: 03-segmentation-engine*
*Completed: 2026-07-06*

## Self-Check: PASSED

All created/modified files present on disk; both task commits (`a368199`, `41b7df0`) verified in git log.
