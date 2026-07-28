---
phase: 08-quality-gates-failure-injection-foundation
fixed_at: 2026-07-28T17:47:36Z
review_path: .planning/phases/08-quality-gates-failure-injection-foundation/08-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 5
skipped: 1
status: partial
---

# Phase 08: Code Review Fix Report

**Fixed at:** 2026-07-28T17:47:36Z
**Source review:** .planning/phases/08-quality-gates-failure-injection-foundation/08-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (WR-01 through WR-06; `fix_scope: critical_warning`, IN-01/IN-02 excluded)
- Fixed: 5
- Skipped: 1

## Fixed Issues

### WR-01: A failed advisory-unlock in the migration fixture leaks the pg client and can hang `pool.end()` forever

**Files modified:** `packages/test-support/src/db-fixture.ts`, `packages/test-support/src/__tests__/db-fixture-advisory-unlock.test.ts`
**Commits:** `cd20312` (fix), `2d0bd4c` (lint follow-up: removed unnecessary `async` on non-awaiting test mocks flagged by `@typescript-eslint/require-await`)
**Applied fix:** Wrapped the `pg_advisory_unlock` query in its own inner `try/finally` inside `applyPendingMigrations`'s outer `finally`, so `client.release()` now runs unconditionally even when the unlock query itself throws.
**Test:** New file `db-fixture-advisory-unlock.test.ts` mocks the `pg` module (no real Postgres connection) with a fake client whose `query` rejects specifically on `pg_advisory_unlock` and reports every migration as already applied for everything else. Verified fail-first: with the pre-fix code, `client.release()` was called 0 times; with the fix, exactly once.

### WR-02: The destructive-DDL lint rule only matches statements written on a single line

**Files modified:** `scripts/lint-migrations.mjs`, `packages/test-support/src/__tests__/migration-lint.test.ts`, `tools/migration-fixtures/bad-destructive-multiline.sql` (new fixture)
**Commit:** `f3e9fe8`
**Applied fix:** `checkDestructiveDdl` now groups lines into logical statements (from one `;` to the next) and tests the `DROP COLUMN` / `ADD COLUMN ... NOT NULL` patterns against the whole whitespace-collapsed statement text, rather than one physical line at a time. The marker-adjacency check still walks physical lines — it now looks at the line immediately preceding the statement's first non-blank, non-comment line, which is the correct generalization of the original single-line behavior. Re-verified against all 14 pre-existing test cases (both fixtures, the bare-marker case, the far-marker case, the DEFAULT-present case) plus a new multi-line-statement fixture and a new "marker still applies to a wrapped statement" case; `lintMigrationDirectory` against the real 38-file `packages/db/migrations` corpus still reports zero violations.
**Test:** Fail-first confirmed — without the fix, the new multi-line fixture produced 0 violations (the exact silent-acceptance bug described); with the fix, 1 violation at the correct line.

### WR-04: `checkRatchet` can report a pass without validating the current value it is supposed to be ratcheting

**Files modified:** `scripts/coverage-ratchet.mjs`, `scripts/coverage-ratchet.d.mts`, `packages/test-support/src/__tests__/coverage-ratchet.test.ts`
**Commits:** `021fd52` (fix), `97d0c83` (type-declaration follow-up: `CoverageBaselineLike.lines` changed from `number` to `unknown` to reflect that this is deserialized, untrusted JSON, plus the new optional `reason` field on `RatchetResult`)
**Applied fix:** In the null-base ("introducing commit") branch, `checkRatchet` now checks `Number.isFinite(currentLines)` before returning `pass: true`; on a non-finite value it returns `pass: false` with a `reason` naming `coverage-baseline.json` as malformed. The CLI section prints `result.reason` when present instead of the generic "threshold was LOWERED" message.
**Test:** Two new cases — a string `lines` value and a missing `lines` key, both under the null-base branch. Fail-first confirmed — both cases produced `pass: true` before the fix, `pass: false` with a `/malformed/i` reason after.

### WR-05: The zero-padded-migration-filename check enforces a minimum width, not a uniform one

**Files modified:** `packages/test-support/src/migration-runner.ts`, `packages/test-support/src/__tests__/migration-runner.test.ts`
**Commit:** `5ca8cbc`
**Applied fix:** Chose the "sort numerically" branch of the two options the review suggested, rather than capping at a fixed width — it closes the bug for any file count, not just up to a chosen limit, and needs no future rename plan. `listMigrationFiles` now sorts on the parsed leading digit-group (captured by `PADDED_PREFIX`, which already required at least 4 digits) instead of the raw filename string, falling back to a string comparison only for an (implausible) exact-numeric tie so ordering stays fully deterministic.
**Test:** New case with `"0009_ninth.sql"` and `"00010_tenth.sql"` — the exact unsafe pairing the review named (`'9' > '1'` at the differing character position under plain string comparison, even though 9 < 10 numerically). Fail-first confirmed — pre-fix code returned them in `["00010_tenth.sql", "0009_ninth.sql"]` order; post-fix, correctly `["0009_ninth.sql", "00010_tenth.sql"]`.

### WR-06: `buildEphemeralDatabaseName`'s 63-byte truncation can violate its own documented no-collision guarantee

**Files modified:** `packages/test-support/src/provision-db.ts`, `packages/test-support/src/__tests__/provision-db.test.ts`
**Commit:** `ff99119`
**Applied fix:** Chose the "hash the full un-truncated name into the tail" option from the review's two suggestions over the "assert/throw" option — it avoids the collision by construction for every caller rather than requiring every caller to handle a new throw path, and needs no change to the function's existing call sites (`"api"`, `"worker"`, `"e2e"`, `"delivery-core"`, …). When the assembled name exceeds 63 bytes, the tail is now an 8-hex-char SHA-256 digest of the full pre-truncation name rather than a blind slice, so any two distinct `(workspace, runId)` pairs stay distinguishable after truncation.
**Test:** New case with a 60-character workspace string and two different short `runId`s, chosen so the divergent `runId`-derived suffix falls entirely past the 63-byte cutoff. Fail-first confirmed — pre-fix, both names were byte-identical; post-fix, they differ while both still respect the 63-byte limit and the `mega_crm_test_` prefix.

## Skipped Issues

### WR-03: The destructive-DDL rule's coverage is narrower than its own stated purpose

**File:** `scripts/lint-migrations.mjs:1-16, 83-114`
**Reason:** Per orchestrator instruction, skipped as a deliberate judgement call, not a defect. `CONVENTIONS.md` (line 75) explicitly bounds the rule in writing: *"Destructive DDL means dropping a column, or adding a `NOT NULL` column with no default."* `DROP TABLE`, `TRUNCATE`, and `ALTER COLUMN ... TYPE` are real gaps relative to the header comment's looser framing, but broadening the linter's vocabulary to cover them is a scope decision that would change a documented, binding convention — not a code defect to fix silently inside a review-fix pass. The rule's vocabulary was deliberately left unwidened.
**Original issue:** The file's header comment frames rule 2 generally ("Destructive DDL with no visible, reason-bearing marker") but the implementation only recognizes `DROP COLUMN` and unsafe `ADD COLUMN ... NOT NULL`. `DROP TABLE`, `TRUNCATE`, and type changes pass through unmarked and unflagged.

## Verification

All mandatory pre-final checks were run from a clean state after all five fixes (with the required symlinked `node_modules` from the main repo, since this ran in an isolated git worktree):

- `npm run lint` — clean, 0 errors (after the WR-01 test-file `require-await` fix noted above)
- `npm run build --workspaces --if-present` — all 11 workspaces built successfully
- `npm run test -w packages/test-support` — 12 test files, 99 tests, all passed
- `npm run lint:migrations` — 38 files checked, no violations
- `npm run lint:floor` — 436 files checked, floor 390, OK

No `CONVENTIONS.md` or `SPECIFICATION.md` update was needed: all five applied fixes are internal behavior corrections (release ordering, statement-boundary detection, input validation, sort key, collision-avoidance) that do not change any documented rule's wording, add a dependency, add an env var, add a route/queue/schema object, or alter the migration-filename/escape-hatch/test-database conventions as written. WR-02 tightens enforcement of an already-documented rule (`CONVENTIONS.md` line 17: "Filename order IS application order... enforced, not merely documented") without changing its wording.

---

_Fixed: 2026-07-28T17:47:36Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
