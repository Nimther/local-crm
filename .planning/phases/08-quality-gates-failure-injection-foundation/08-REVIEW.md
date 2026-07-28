---
phase: 08-quality-gates-failure-injection-foundation
reviewed: 2026-07-28T00:00:00Z
depth: standard
files_reviewed: 68
files_reviewed_list:
  - .github/workflows/ci.yml
  - apps/api/src/load-env.ts
  - apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts
  - apps/api/src/server.ts
  - apps/api/src/test/db-fixture.ts
  - apps/api/vitest.config.ts
  - apps/web/e2e/database-isolation.spec.ts
  - apps/web/e2e/global-teardown.ts
  - apps/web/e2e/provision-database.ts
  - apps/web/e2e/register-create-workspace.spec.ts
  - apps/web/playwright.config.ts
  - apps/worker/src/load-env.ts
  - apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/redis-restart.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts
  - apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts
  - apps/worker/src/server.ts
  - apps/worker/src/test/db-fixture.ts
  - apps/worker/src/test/failure-fixtures.ts
  - apps/worker/src/test/harness/sigkill-entrypoint.ts
  - apps/worker/vitest.config.ts
  - docker/redis.conf
  - packages/db/src/__tests__/migrate-from-empty.test.ts
  - packages/db/src/__tests__/migrate-incremental.test.ts
  - packages/db/vitest.config.ts
  - packages/delivery-core/src/send-status.ts
  - packages/delivery-core/src/test/db-fixture.ts
  - packages/delivery-core/vitest.config.ts
  - packages/kms/src/__tests__/envelope.test.ts
  - packages/kms/src/env.ts
  - packages/kms/vitest.config.ts
  - packages/segments-core/vitest.config.ts
  - packages/shared-schemas/vitest.config.ts
  - packages/tenant-context/src/__tests__/tenant-context.test.ts
  - packages/tenant-context/vitest.config.ts
  - packages/test-support/src/__tests__/coverage-gate.test.ts
  - packages/test-support/src/__tests__/coverage-ratchet.test.ts
  - packages/test-support/src/__tests__/db-fixture-advisory-unlock.test.ts
  - packages/test-support/src/__tests__/db-fixture-isolation.test.ts
  - packages/test-support/src/__tests__/guard.test.ts
  - packages/test-support/src/__tests__/lint-gate.test.ts
  - packages/test-support/src/__tests__/migration-lint.test.ts
  - packages/test-support/src/__tests__/migration-runner.test.ts
  - packages/test-support/src/__tests__/provision-db.test.ts
  - packages/test-support/src/__tests__/redis-config.test.ts
  - packages/test-support/src/__tests__/root-hygiene.test.ts
  - packages/test-support/src/__tests__/spawn-and-kill.test.ts
  - packages/test-support/src/db-fixture.ts
  - packages/test-support/src/global-setup.ts
  - packages/test-support/src/guard.ts
  - packages/test-support/src/harness/spawn-and-kill.ts
  - packages/test-support/src/harness/temp-redis.ts
  - packages/test-support/src/index.ts
  - packages/test-support/src/migration-runner.ts
  - packages/test-support/src/provision-db.ts
  - packages/test-support/vitest.config.ts
  - scripts/check-env.mjs
  - scripts/check-lint-file-floor.mjs
  - scripts/check-root-hygiene.mjs
  - scripts/coverage-gate.mjs
  - scripts/coverage-ratchet.mjs
  - scripts/env-path.mjs
  - scripts/lint-migrations.mjs
  - scripts/migrate-dev.mjs
  - scripts/verify-redis-config.mjs
findings:
  critical: 1
  warning: 2
  info: 1
  total: 4
status: issues_found
---

# Phase 08: Code Review Report (re-review)

**Reviewed:** 2026-07-28T00:00:00Z
**Depth:** standard
**Files Reviewed:** 68
**Status:** issues_found

## Summary

This is a re-review of the current tree, including the five fixes made in
response to the previous 08-REVIEW.md pass (WR-01 through WR-06 minus WR-03,
which was a documented-scope decision) and the one new file added since,
`db-fixture-advisory-unlock.test.ts`. None of that fix code had been seen by a
reviewer before this pass.

Four of the five code fixes were traced end-to-end and are correct; their
prior findings do not re-apply and are not carried forward:

- **`packages/test-support/src/db-fixture.ts`** (prior WR-01) — the nested
  `try { unlock } finally { client.release() }` genuinely closes the leak: a
  rejected `pg_advisory_unlock` still releases the client, confirmed against
  `db-fixture-advisory-unlock.test.ts`'s mocked-`pg` reproduction.
- **`scripts/coverage-ratchet.mjs`** (prior WR-04) — the null-base branch now
  correctly fails on a non-finite `currentLines` instead of passing vacuously;
  confirmed against the two new cases in `coverage-ratchet.test.ts`.
- **`packages/test-support/src/migration-runner.ts`** (prior WR-05) — sorting
  on the parsed numeric prefix with a filename tie-break produces a total,
  deterministic order and correctly resolves a 5-digit prefix sorting after a
  4-digit one; the `PADDED_PREFIX` capturing group is used correctly.
- **`packages/test-support/src/provision-db.ts`** (prior WR-06) —
  `buildEphemeralDatabaseName`'s hash-truncation path was hand-traced: the
  kept prefix (54 bytes) always exceeds `mega_crm_test_`'s length (14 bytes),
  so a truncated name always still starts with the required prefix and always
  stays within `[a-z0-9_]`, satisfying both the SAFE_IDENTIFIER allow-list and
  the destructive-drop guard's namespace check. No defect found here.
  (Prior IN-01, the `OWNER mega_crm_app` literal, was not touched by this
  round of fixes and is not re-asserted; it was Info-level and out of this
  review's re-scope.)

The fifth fix — `scripts/lint-migrations.mjs`'s move from per-line to
per-statement matching in `checkDestructiveDdl` (prior WR-02) — does fix the
multi-line evasion it was written for (confirmed against
`bad-destructive-multiline.sql`), but the statement splitter it introduces
walks *raw* lines for the semicolon boundary with no awareness of comments or
string literals. That produces two new, empirically-reproduced defects in the
exact rule whose entire job is to catch dangerous DDL before it reaches
production: a false negative that lets genuinely unsafe multi-line DDL through
silently (Critical — this is the "gate that cannot fail for the reason it
exists" failure mode this phase is otherwise careful to close everywhere
else), and a false positive that can block a merge over someone's unrelated
code comment (Warning). Both are demonstrated below by running the actual
exported function, not hypothesized.

## Structural Findings (fallow)

None supplied for this review.

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: `checkDestructiveDdl`'s statement splitter can be evaded by a semicolon inside an inline comment, letting genuinely unsafe DDL pass QG-05 silently

**File:** `scripts/lint-migrations.mjs:98-150` (root cause at line 104: `if (!lines[i].includes(";")) continue;`)

**Issue:** The fix for the prior WR-02 finding changed statement-boundary
detection from "does this physical line contain the keyword" to "walk lines
until one contains a `;`, then test the joined text" — but the boundary scan
runs over the **raw** lines, with no comment- or string-literal-awareness. A
`;` inside an inline `--` comment (or inside a string literal) is treated
identically to a real SQL statement terminator, which **prematurely closes the
statement** before its second identifying keyword (`NOT NULL`, or the far half
of a wrapped `DROP … COLUMN`) is ever read into the same joined chunk. Neither
resulting fragment then contains both keywords together, so
`isUnsafeNotNull`/`isDropColumn` never fire, and the migration is reported
clean.

Empirically reproduced against the actual exported function:

```
ALTER TABLE campaigns
  ADD COLUMN legacy_flag boolean -- temporary; will backfill via migration N+1
  NOT NULL;
```

`checkDestructiveDdl("evasion.sql", <above>)` returns `[]` — zero violations —
for a column addition that is `NOT NULL` with no `DEFAULT`, unmarked, of
exactly the shape `packages/db/src/__tests__/migrate-incremental.test.ts` in
this same phase proves fails against a populated table at deploy time. CI goes
green having verified nothing about this statement — the precise "gate that
can pass while having verified nothing" / "gate that cannot fail for the
reason it exists" failure class this phase is otherwise careful to close
everywhere (lint file-count floor, coverage empty-denominator, redis-config
policy-only check) — present here, newly, in the fix to the migration linter
itself.

**Fix:** Determine statement boundaries and do keyword matching against
comment-stripped text (reuse `stripSqlComments`, or an equivalent that blanks
`--`/`/* */` content in place rather than removing lines, so line numbers stay
aligned), while continuing to use the **original** raw lines for the
marker-adjacency walk only (the marker is itself a comment and must stay
visible to that half of the logic, which is already correctly designed this
way). Concretely: build a parallel array of comment-stripped lines once per
file; use it to (a) find the true `;` boundaries and (b) build `statementText`
for the `isDropColumn`/`isUnsafeNotNull` tests; keep using the raw `lines`
array only for `isCommentOnlyLine`/`DESTRUCTIVE_MARKER` matching. Add a
regression fixture alongside `bad-destructive-multiline.sql` with a
semicolon-bearing comment between the two keywords, and assert it is still
flagged.

## Warnings

### WR-01: The same statement splitter produces a false positive: an unrelated preceding comment can get a fully safe, nullable column addition flagged as unmarked destructive DDL

**File:** `scripts/lint-migrations.mjs:98-150`

**Issue:** The inverse of CR-01, same root cause. A comment-only line that
does *not* contain a `;` is folded into the *same* joined `statementText` as
the next real statement (there was no earlier terminator to close a separate
chunk), so any word or phrase inside that comment participates in the
`isUnsafeNotNull` keyword test. A comment that happens to contain the words
"not null" — plausible prose in a migration file discussing a schema
convention — causes a completely unconstrained `ADD COLUMN` (no `NOT NULL` on
it at all) to be reported as unmarked destructive DDL.

Empirically reproduced:

```
-- note: legacy columns are NOT NULL by convention
ALTER TABLE foo ADD COLUMN bar text;
```

`checkDestructiveDdl("fp.sql", <above>)` returns one
`destructive-ddl-unmarked` violation at line 2, for a statement that adds a
nullable column with **no constraint whatsoever**.

Unlike CR-01 this fails loud (blocks the merge rather than hiding a risk), so
it is a correctness/maintainability defect rather than a safety one — but a
migration linter that can reject legitimate, safe migrations for reasons that
have nothing to do with their SQL erodes trust in the gate and invites the
"just reword the comment to make CI happy" workaround that makes a linter
meaningless over time.

**Fix:** Same fix as CR-01 — build the keyword-matching text from
comment-stripped lines, not raw ones. Once that is done, this false positive
and CR-01's false negative are both closed by the same change.

### WR-02: `TempRedis.restart()`/`terminate()` does not surface a stuck child process; it silently proceeds to rebind the same port

**File:** `packages/test-support/src/harness/temp-redis.ts:225-232`

**Issue:**

```ts
async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
    child.kill("SIGKILL");
    await waitForExit(child, STOP_TIMEOUT_MS);
  }
}
```

The second `waitForExit`'s boolean return value is discarded. If a child does
not report exit within `STOP_TIMEOUT_MS` even after `SIGKILL` (e.g. it is
wedged in an uninterruptible D-state, or the "exit" event is delayed under
extreme host load), `terminate()` returns normally as though termination
succeeded. `restart()` then immediately calls `spawnServer(binary, args)` with
the **same port** the possibly-still-live process holds, and `stop()`
proceeds to `rm(dir, ...)` the data directory a possibly-still-writing process
still owns. The resulting failure (`awaitReady` reporting "redis-server exited
before becoming ready" or a bind error) would read as flaky infrastructure
rather than naming the real cause: a process that never actually died. This is
exactly the "unhandled exit path" this review was asked to weight toward for
this file, even though in ordinary operation `SIGKILL` is effectively always
fatal and this is a long-tail case.

**Fix:** Check the second `waitForExit`'s return value and throw a clear error
(naming the PID) when a child survives `SIGKILL` for the full timeout, rather
than letting `restart()`/`stop()` proceed as if it had exited.

## Info

### IN-01: The destructive-DDL rule does not cover `DROP TABLE`, `TRUNCATE`, or column type changes

**File:** `scripts/lint-migrations.mjs:98-150`

**Issue:** `checkDestructiveDdl` only recognizes `DROP COLUMN` and unsafe
`ADD COLUMN … NOT NULL` without a `DEFAULT`. A `DROP TABLE`, `TRUNCATE`, or an
in-place column type change in a migration file passes this linter with zero
violations regardless of whether it carries a marker.

This is a **documented scope boundary**, not a defect: CONVENTIONS.md bounds
the rule to exactly these two patterns (this was raised and closed as
out-of-scope in the prior review round, WR-03, rather than fixed). Recording
it here only so this re-review is explicit about having considered it and
found the boundary unchanged — no action implied.

---

_Reviewed: 2026-07-28T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
