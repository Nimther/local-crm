---
phase: 08-quality-gates-failure-injection-foundation
plan: 05
subsystem: database
tags: [migrations, linter, expand-contract, postgres, enum, ddl, tdd]

requires:
  - phase: 08-01
    provides: "@mega-crm/test-support workspace hosting the linter's unit tests"
provides:
  - "scripts/lint-migrations.mjs — stripSqlComments, checkEnumAddValueSameFile, checkDestructiveDdl, lintMigrationFile, lintMigrationDirectory"
  - "Root npm script lint:migrations"
  - "Marker convention: -- destructive: <reason>, line-scoped, reason mandatory"
  - "tools/migration-fixtures/ — 4 fixtures (2 violating, 2 clean)"
affects: [08-17, 08-18, 11]

tech-stack:
  added: []
  patterns:
    - "Dependency-free Node CLI in the scripts/check-env.mjs style, importable for tests via an import.meta.url guard"
    - "Line-scoped suppression with a mandatory reason — never file-scoped"

key-files:
  created:
    - scripts/lint-migrations.mjs
    - tools/migration-fixtures/bad-enum-same-file.sql
    - tools/migration-fixtures/bad-destructive-unmarked.sql
    - tools/migration-fixtures/good-destructive-marked.sql
    - tools/migration-fixtures/good-enum-separate-file.sql
    - packages/test-support/src/__tests__/migration-lint.test.ts
  modified:
    - package.json

key-decisions:
  - "Marker syntax fixed as `-- destructive: <reason>` — 08-17's CONVENTIONS.md must quote this exactly rather than reinvent it"
  - "Rewrote RESEARCH's isUnsafeNotNull as a plain per-line test; the sample's slice/indexOf form was wrong for repeated lines"
  - "Marker lookup skips blank lines to find the preceding NON-BLANK line, per the plan's wording"

patterns-established:
  - "Success output prints the checked-file count, so '0 files checked' is distinguishable from a genuine pass"

requirements-completed: [DB-08]

coverage:
  - id: D1
    description: "Linter fails a file that adds an enum value with ALTER TYPE ... ADD VALUE and uses that literal in the same file"
    requirement: DB-08
    verification:
      - kind: unit
        ref: "migration-lint.test.ts — checkEnumAddValueSameFile, incl. multi-ADD-VALUE and comment-only cases"
        status: pass
      - kind: other
        ref: "node scripts/lint-migrations.mjs tools/migration-fixtures/bad-enum-same-file.sql → exit 1"
        status: pass
    human_judgment: false
  - id: D2
    description: "Linter fails unmarked destructive DDL, reporting each violation's own line number"
    requirement: DB-08
    verification:
      - kind: unit
        ref: "migration-lint.test.ts — checkDestructiveDdl, 2 violations at distinct lines"
        status: pass
      - kind: other
        ref: "CLI on bad-destructive-unmarked.sql → exit 1, violations at lines 5 and 9"
        status: pass
    human_judgment: false
  - id: D3
    description: "The marker suppresses only the statement below it, and only with a non-empty reason"
    requirement: DB-08
    verification:
      - kind: unit
        ref: "migration-lint.test.ts — bare-marker and far-marker cases both still violate"
        status: pass
    human_judgment: false
  - id: D4
    description: "Linter exits 0 across all 38 existing migrations, none of them edited"
    requirement: DB-08
    verification:
      - kind: other
        ref: "node scripts/lint-migrations.mjs → '38 file(s) checked, no violations', exit 0; git diff --stat packages/db/migrations/ empty"
        status: pass
    human_judgment: false

duration: 8 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 05: Migration Linter Summary

**A dependency-free Node linter that refuses a migration adding an enum value and using it in the same file — the exact shape that would break Phase 11's `'reconciling'` addition at deploy time — and that forces destructive DDL to carry a line-scoped, reason-bearing marker.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-28T06:07:00Z
- **Completed:** 2026-07-28T06:15:00Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments

- **`enum-add-value-used-same-file`** — handles multiple `ADD VALUE` statements per file (all are stripped before usage detection, so one cannot mask another) and is immune to the literal appearing only in a comment.
- **`destructive-ddl-unmarked`** — per-line detection with per-line numbers, covering `DROP COLUMN` and `ADD COLUMN ... NOT NULL` with no `DEFAULT`.
- **Suppression cannot be blanket** — the marker is honoured only on the immediately preceding non-blank line and only with a non-empty reason. Both constraints are unit-asserted, including a far-marker case that still violates.
- **All 38 real migrations pass unedited** — the SPEC's requirement. Every existing `ADD COLUMN ... NOT NULL` in this repo carries a `DEFAULT`, so the rule is correctly scoped rather than over-broad.
- **13 tests / 20 assertions**, all driving the exported rule functions directly — no process spawning.

## Task Commits

1. **Task 1 (RED): fixtures + failing tests** — `03af1e5` (test)
2. **Task 2 (GREEN): linter + npm script** — `d5d08d7` (feat)

## Decisions Made

**Marker syntax — 08-17 must quote this verbatim:**

```
-- destructive: <reason>
```

A single-line SQL comment, the word `destructive`, a colon, then at least one non-whitespace character of reason. It applies to the immediately following statement only.

**Rewrote RESEARCH's `isUnsafeNotNull`.** The sample expression used `rawSql.slice(0, rawSql.indexOf(line))` to decide whether an `ALTER TABLE` preceded the line. Beyond being hard to reason about, `indexOf(line)` returns the *first* occurrence, so any repeated line text evaluates against the wrong position. The plan anticipated this and directed a straightforward per-line test; that is what shipped.

**Marker lookup skips blank lines** to locate the preceding non-blank line, matching the plan's "immediately preceding non-blank line" wording. A marker separated from its statement by blank lines still suppresses; one separated by another *statement* does not.

## Deviations from Plan

None — plan executed as written. The `isUnsafeNotNull` rewrite was explicitly directed by the plan's `read_first`, not a deviation.

## Issues Encountered

**RESEARCH's "no marker retrofit expected" claim was worth re-verifying, and it held.** A scan found 7 migration files containing `ADD COLUMN ... NOT NULL`, which looked at first like 12 violations. All 12 lines carry a `DEFAULT` (`integer DEFAULT 0 NOT NULL`), so the rule correctly ignores them. Had the rule keyed only on `NOT NULL`, this plan would have needed to retrofit markers onto real schema history — which the SPEC forbids.

## User Setup Required

None.

## Next Phase Readiness

**Ready.** `lint:migrations` is wired as a root npm script; 08-18 adds it to CI's `static` job. 08-17 must quote the marker syntax above in `CONVENTIONS.md`.

**For Phase 11:** the linter now blocks the exact failure it was built for — `'reconciling'` must be added in its own standalone migration, applied and confirmed before any deploy ships code referencing it.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
