---
phase: 08-quality-gates-failure-injection-foundation
fixed_at: 2026-07-28T23:31:00Z
review_path: .planning/phases/08-quality-gates-failure-injection-foundation/08-REVIEW.md
iteration: 1
findings_in_scope: 4
fixed: 2
skipped: 1
status: partial
---

# Phase 08: Code Review Fix Report

**Fixed at:** 2026-07-28T23:31:00Z
**Source review:** .planning/phases/08-quality-gates-failure-injection-foundation/08-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (`fix_scope: all` — CR-01, WR-01, WR-02, IN-01)
- Fixed: 2 findings, applied as 2 separate atomic commits (CR-01 and WR-01 shared a single root-cause fix and are reported together; WR-02 is unrelated and separate)
- Skipped: 1 (IN-01 — documented scope decision, not a defect; see below)

## Fixed Issues

### CR-01 / WR-01: `checkDestructiveDdl`'s statement splitter evaded/false-positived on comment content

**Files modified:** `scripts/lint-migrations.mjs`, `packages/test-support/src/__tests__/migration-lint.test.ts`, `tools/migration-fixtures/bad-destructive-comment-semicolon.sql` (new)
**Commit:** `0711acd`
**Applied fix:** Added `maskSqlComments(rawSql)`, a length- and line-count-preserving character-by-character mask that blanks `--` line comments and `/* */` block comments (including ones spanning multiple lines) to spaces while leaving newlines untouched. `checkDestructiveDdl` now builds `maskedLines` from this and uses it for both statement-boundary detection (finding `;`) and the `DROP COLUMN` / `ADD COLUMN ... NOT NULL` keyword tests, so a semicolon or keyword-like prose inside a comment can no longer prematurely close a statement (CR-01) or fabricate a false match (WR-01). The marker-adjacency check (`isCommentOnlyLine`, `DESTRUCTIVE_MARKER`) deliberately continues to walk the **raw**, unmasked `lines` array, since the `-- destructive: <reason>` marker is itself a comment and must stay visible to that half of the logic — this was called out explicitly in the review's fix guidance and preserved.

Verification performed:
- Reproduced both original defects against the pre-fix code (`checkDestructiveDdl` returning `[]` for the CR-01 semicolon-in-comment case, and one false-positive violation for the WR-01 case), confirming the review's empirical claims.
- Confirmed both cases are corrected post-fix by re-running the same reproduction inline via `node --input-type=module`.
- Added 4 new fail-first tests to `migration-lint.test.ts`: two CR-01 shapes (fixture-based and inline, including a multi-line `/* */` block-comment variant), and the WR-01 false-positive shape. Caught and fixed one test-hygiene issue along the way: the first draft of the new fixture's own header comment happened to contain the literal phrase "ADD COLUMN ... NOT NULL", which coincidentally made it pass against the pre-fix code for the wrong reason (matching the header prose, not the real statement) — reworded the fixture to avoid that phrase and re-confirmed genuine fail-first behavior via `git stash` (all 4 new tests fail against the pre-fix code, all pass against the fix).
- Confirmed the existing `bad-destructive-multiline.sql` fixture (the original WR-02-round regression test) still fails as before — no regression on the multi-line evasion that fix was written for.
- Ran the full `packages/test-support/src/__tests__/migration-lint.test.ts` suite (19/19 pass) and `node scripts/lint-migrations.mjs` against the real `packages/db/migrations` directory (38 files, no violations, same as pre-fix).
- `node -c scripts/lint-migrations.mjs` passed (plain `.mjs`, no `tsc` applicable).

**Explicitly out of scope, per the review's own instruction to document rather than silently leave unhandled:** `maskSqlComments` does not mask single-quoted string literals or dollar-quoted (`$$ ... $$`) bodies. A `;` or the words "not null" inside a string literal could still perturb statement-boundary detection or the keyword test. No migration in this repo's `packages/db/migrations` does this today (verified — the real-migrations run above still reports zero violations), so this was not folded into the fix. This is a known gap for a future round, not a silent omission.

### WR-02: `TempRedis.terminate()` discarded the second `waitForExit` result

**Files modified:** `packages/test-support/src/harness/temp-redis.ts`
**Commit:** `d47fdd3`
**Applied fix:** The second `waitForExit(child, STOP_TIMEOUT_MS)` call (after `SIGKILL`) now has its boolean result checked. If the child still has not exited, `terminate()` throws a named error identifying the PID, instead of returning normally as if termination had succeeded. This prevents `restart()` from rebinding the same port a still-live process holds and `stop()` from `rm`-ing a data directory a still-writing process still owns.

Verification performed:
- Re-read the modified function; confirmed the fix text is present and surrounding logic (the SIGTERM-then-SIGKILL structure, the early-return for an already-exited child) is intact.
- `npx tsc --noEmit -p packages/test-support/tsconfig.json` — no errors.
- Ran `packages/test-support/src/__tests__/redis-config.test.ts` (12/12 pass) and the broader `packages/test-support` suite (103/103 pass) — the normal termination path (child exits promptly) is unaffected; the new throw only triggers on the SIGKILL-survives-timeout long-tail path, which is not exercised by the existing suite (spawning a genuinely SIGKILL-immune child is impractical to construct in a fast unit test, consistent with the review calling this "a long-tail case"). No new test was added for the throw path itself; flagging this as unverified-by-automated-test in case a future round wants a fault-injected child to exercise it.

## Skipped Issues

### IN-01: The destructive-DDL rule does not cover `DROP TABLE`, `TRUNCATE`, or column type changes

**File:** `scripts/lint-migrations.mjs:98-150`
**Reason:** Per explicit orchestrator instruction, skipped as a documented scope decision, not a defect. The review itself states this is a "documented scope boundary" that CONVENTIONS.md bounds to exactly `DROP COLUMN` and unsafe `ADD COLUMN ... NOT NULL` (`CONVENTIONS.md:75`: "Destructive DDL means dropping a column, or adding a `NOT NULL` column with no default."), and that it was already raised and closed as out-of-scope in the prior review round (WR-03). No action was taken, and the rule's vocabulary was not widened.
**Original issue:** `DROP TABLE`, `TRUNCATE`, and in-place column type changes pass the linter with zero violations regardless of marker presence.

## Full Verification Sweep (run against the actual working tree, not assumed)

- `npm run lint` — exit 0, no ESLint errors (`eslint . --max-warnings=0`)
- `npm run build --workspaces --if-present` — exit 0, all 12 workspaces built clean (api, web, worker, contacts-core, db, delivery-core, flows-core, kms, segments-core, shared-schemas, tenant-context, test-support)
- `npm run test --workspaces --if-present` — exit 0, all workspace test suites passed: api 264/264, web 45/45, worker 117/117, db 9/9, delivery-core 70/70, flows-core 15/15, kms 10/10, segments-core 19/19, shared-schemas 18/18, tenant-context 7/7, test-support 103/103
- `npm run lint:migrations` — exit 0, "38 file(s) checked, no violations"
- `npm run lint:floor` — exit 0, "436 file(s) checked, floor 390. OK"
- `npm run check:root-hygiene` — exit 0, "27 entries ... none blacklisted. OK"

No gate was weakened, no threshold lowered, no assertion relaxed to make anything pass.

## Documentation cross-check

Both fixes restore intended behavior of an existing, already-documented rule; neither changes migration rules, escape-hatch policy, the test-database convention, module structure/naming, or adds a dependency/env var/route/queue/schema object. Checked `CONVENTIONS.md`'s destructive-DDL wording (`CONVENTIONS.md:53,68-75`) against the fixed linter behavior — the marker convention, marker form, and "drop a column, or add a NOT NULL column with no default" scope description all still match what `checkDestructiveDdl` enforces post-fix. No update to `CONVENTIONS.md` or `SPECIFICATION.md` was required.

---

_Fixed: 2026-07-28T23:31:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
