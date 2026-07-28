---
phase: 08-quality-gates-failure-injection-foundation
reviewed: 2026-07-28T00:00:00Z
depth: standard
files_reviewed: 67
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
  critical: 0
  warning: 6
  info: 2
  total: 8
status: issues_found
---

# Phase 08: Code Review Report

**Reviewed:** 2026-07-28T00:00:00Z
**Depth:** standard
**Files Reviewed:** 67
**Status:** issues_found

## Summary

This phase builds the CI/quality-gate infrastructure itself (test-database
provisioning + guard, migration runner, coverage gate/ratchet, lint floor,
Redis-config verifier, migration linter, root-hygiene check, and the five
failure-injection scenarios) plus the process/child-process harnesses that
back them. The security-critical paths — `provision-db.ts`'s DROP DATABASE
name guard, `guard.ts`'s dev-database comparison, and the envelope-encryption
and tenant-isolation tests — hold up under adversarial reading: the ordering
invariants the code comments claim (validate-before-connect, guard-before-publish,
compare-against-the-true-dev-DSN-before-overwrite) are actually implemented in
that order, and the accompanying unit tests exercise the documented edge cases
(loopback aliases, absent ports, quote-injection payloads, byte-identical DSNs).

No Critical findings. The Warnings below are all instances of the specific
failure mode this review was asked to weight toward: a gate whose coverage is
narrower than its own stated purpose, or whose "empty/degenerate input" branch
was not fully hardened against a vacuous pass. None of them are exploitable by
an external actor — they are latent correctness gaps in the gates' own logic,
most requiring an unusual or long-tail input to trigger.

## Warnings

### WR-01: A failed advisory-unlock in the migration fixture leaks the pg client and can hang `pool.end()` forever

**File:** `packages/test-support/src/db-fixture.ts:85-116`
**Issue:** `applyPendingMigrations` acquires a session-level advisory lock, then in a single `finally` block runs the unlock query followed unconditionally by `client.release()`:

```ts
} finally {
  await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
  client.release();
}
```

If the unlock query itself throws (e.g. the connection was already dropped by
the server — a live possibility under CI, where `docker compose` Postgres can
hiccup, or under the `redis-restart`/`sigkill` failure-injection scenarios that
run in the same CI job), the throw propagates out of the `finally` block
*before* `client.release()` executes. The `pg.Pool` client is then never
returned to the pool. `ensureTestDbMigrated()` chains
`applyPendingMigrations(pool).finally(() => pool.end())`, and node-postgres's
`Pool.end()` waits for every checked-out client to be released before it
resolves — so the leaked client causes `pool.end()` (and therefore the whole
`beforeAll` awaiting `ensureTestDbMigrated()`) to hang until the surrounding
`hookTimeout` kills the run, rather than failing fast with the real error.
**Fix:** Release unconditionally regardless of whether the unlock query
succeeded:
```ts
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
  } finally {
    client.release();
  }
}
```

### WR-02: The destructive-DDL lint rule only matches statements written on a single line

**File:** `scripts/lint-migrations.mjs:83-114`
**Issue:** `checkDestructiveDdl` tests `DROP\s+COLUMN` and the unsafe
`ADD COLUMN ... NOT NULL` shape against `lines[i]` individually — one line at
a time. A migration that wraps the statement across lines, e.g.:
```sql
ALTER TABLE "campaigns"
  ADD COLUMN "mandatory_note" text
  NOT NULL;
```
never has both `ADD COLUMN` and `NOT NULL` present on the *same* line, so
`isUnsafeNotNull` is false for every line and the statement is silently
accepted without requiring a `-- destructive:` marker — even though it is
exactly the shape the rule exists to catch. Contrast with
`checkEnumAddValueSameFile`'s regex, which correctly uses `\s+` (matching
newlines) and therefore *does* tolerate multi-line statements. Nothing in
`lintMigrationDirectory`'s current 38-file corpus happens to use this
formatting, which is why `lintMigrationDirectory(MIGRATIONS)` in
`migration-lint.test.ts` reports zero violations — the gate has not actually
been proven against a multi-line destructive statement.
**Fix:** Join each statement (naive approach: collapse runs of whitespace
including newlines before matching, similar to how `checkEnumAddValueSameFile`
already tolerates newlines) before applying the `DROP COLUMN` /
`ADD COLUMN ... NOT NULL` tests, or explicitly scan statement-by-statement
(split on `;`) rather than line-by-line.

### WR-03: The destructive-DDL rule's coverage is narrower than its own stated purpose

**File:** `scripts/lint-migrations.mjs:1-16, 83-114`
**Issue:** The file's header comment frames rule 2 generally — "Destructive DDL
with no visible, reason-bearing marker" — but the implementation only
recognizes two shapes: `DROP COLUMN` and `ADD COLUMN ... NOT NULL` with no
`DEFAULT`. `DROP TABLE`, `TRUNCATE`, and `ALTER TABLE ... ALTER COLUMN TYPE`
(a type change can silently truncate or reject existing data) are at least as
destructive and pass through completely unmarked and unflagged. A migration
that drops an entire table requires no `-- destructive:` comment at all under
this linter.
**Fix:** Either narrow the header comment to name exactly the two covered
shapes (so the gate's advertised scope matches its actual scope), or extend
`checkDestructiveDdl` to also match `DROP\s+TABLE`, `TRUNCATE`, and
`ALTER\s+COLUMN\s+\S+\s+TYPE`.

### WR-04: `checkRatchet` can report a pass without validating the current value it is supposed to be ratcheting

**File:** `scripts/coverage-ratchet.mjs:34-44`
**Issue:**
```js
export function checkRatchet(current, base) {
  const currentLines = Number(current?.lines);
  if (base === null || base === undefined) {
    return { pass: true, current: currentLines, base: null, delta: null };
  }
  ...
}
```
When `base` is `null` (the documented "introducing commit" case — the base
branch has no `coverage-baseline.json` yet), the function returns `pass: true`
unconditionally, without checking whether `currentLines` is even a valid
number. If `coverage-baseline.json` on the current commit is malformed (e.g.
the `lines` key was renamed or omitted by a typo in the very commit that
introduces the file), `currentLines` is `NaN`, and the ratchet still reports
`pass: true` — a vacuous pass on the one commit where there is nothing yet to
compare against, exactly the class of gap this review was asked to weight
toward. `checkCoverageGate` (the sibling script) explicitly guards its
equivalent empty-denominator case; `checkRatchet`'s null-base branch does not
have an equivalent guard for an invalid `current`.
**Fix:** Validate `Number.isFinite(currentLines)` before returning `pass: true`
in the null-base branch, and fail with a clear "coverage-baseline.json is
malformed" message otherwise.

### WR-05: The zero-padded-migration-filename check enforces a minimum width, not a uniform one, so its own stated guarantee does not fully hold

**File:** `packages/test-support/src/migration-runner.ts:24-54`
**Issue:** The doc comment states the invariant plainly: *"lexicographic
sorting only agrees with numeric order while every name is padded"* — but
`PADDED_PREFIX = /^\d{4,}_/` only requires **at least** 4 digits, not exactly
4 (or any single fixed width). Lexicographic ordering across differing digit
widths is not numerically monotonic in general: e.g. `"0009_x.sql"` sorts
*after* `"00010_y.sql"` (comparing character-by-character, `'9' > '1'` at
position 4), even though 9 < 10 numerically. Once the migration count crosses
9999 and a 5-digit-prefixed file is added alongside existing 4-digit files
whose leading digit is `>= 1` (which is every file from `0001_` onward), the
new file can sort *before* files it should logically follow, and
`listMigrationFiles`'s regex accepts this without complaint — the exact
silent-misordering failure mode the function's own comment says it exists to
prevent. `migration-runner.test.ts`'s "accepts more than four digits" case
only exercises the coincidentally-safe pairing (`"0000_a.sql"` vs
`"10000_z.sql"`, where the leading `'0'` vs `'1'` happens to sort correctly)
and does not cover the unsafe pairing.
**Fix:** Either enforce a single fixed width (e.g. exactly 4 digits, with an
explicit migration plan for when the count would exceed it), or sort
numerically on the parsed prefix instead of relying on `Array.prototype.sort`'s
lexicographic string order.

### WR-06: `buildEphemeralDatabaseName`'s 63-byte truncation can violate its own documented no-collision guarantee

**File:** `packages/test-support/src/provision-db.ts:49-56`
**Issue:** The function's doc comment states the deliverable directly:
*"unique per workspace and per run (D-10), so two concurrent CI runs can never
collide on one physical database."* But the implementation is a plain
`.slice(0, MAX_IDENTIFIER_LENGTH)` with no collision-avoidance step (e.g. a
hash suffix). `TEST_DATABASE_PREFIX + "_"` already consumes 14 of the 63
available bytes, leaving 49 for `<workspace>_<runId>` combined. Two different
`runId`s for a sufficiently long `workspace` string are silently truncated to
an identical database name, and `dropEphemeralDatabase` combined with
`createEphemeralDatabase` calling it first means the second run's
`createEphemeralDatabase` would drop the first run's still-in-use database out
from under it before recreating it — the opposite of the isolation this
function exists to provide. Current call sites all use short, static workspace
strings (`"api"`, `"worker"`, `"e2e"`, `"delivery-core"`, …), so this is not
observed today, but the function is exported as a general-purpose API
(`packages/test-support/src/index.ts`) with no length guard or warning at the
call boundary.
**Fix:** Either document the effective workspace-name length budget as part of
the function's contract and assert it (throw if the sanitized workspace name
alone would leave too little room for the runId to remain distinguishable), or
truncate by hashing the full un-truncated name into the tail instead of a
blind prefix slice.

## Info

### IN-01: `OWNER mega_crm_app` in the CREATE DATABASE statement is a re-typed literal, not derived from `DEFAULT_APP_ROLE`

**File:** `packages/test-support/src/provision-db.ts:30, 136-138`
**Issue:** `DEFAULT_APP_ROLE = "mega_crm_app"` is defined as a named constant
specifically so the role name has one source of truth, but the `CREATE
DATABASE` statement re-types the literal string instead of interpolating the
constant: `` `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER
mega_crm_app` ``. If `DEFAULT_APP_ROLE` is ever changed, this line will not
follow it, and newly-created ephemeral databases would silently get the wrong
owner (and, per the adjacent `buildAppDsn` comment, RLS assertions relying on
running as the app role would become vacuous).
**Fix:** `` `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER
${quoteIdentifier(DEFAULT_APP_ROLE)}` `` (safe here since `DEFAULT_APP_ROLE`
is a module constant, not caller input, matching the code's own reasoning for
why the current literal is "safe").

### IN-02: A failed `restart()` in the temp-Redis harness leaves the new process and its temp directory uncleaned

**File:** `packages/test-support/src/harness/temp-redis.ts:268-275`
**Issue:** `TempRedis.restart()` terminates the old process and calls
`spawnServer` again, then `awaitReady`. If `awaitReady` throws (e.g. the
restarted server fails to come up), nothing in `restart()`'s own code path
calls `stop()` — the new child process is only guaranteed to be killed by the
process-`exit` hook (`live` set), and the new `dir` (a `mkdtemp` temp
directory) is never removed at all, since removal only happens inside
`stop()`. Compare with `startTempRedis`, whose top-level `try { await
awaitReady(...) } catch { await instance.stop(); throw err; }` explicitly
handles this same failure shape.
**Fix:** Wrap the `awaitReady(proc, port, binary)` call inside `restart()`
with the same catch-and-`stop()`-then-rethrow pattern `startTempRedis` already
uses.

---

_Reviewed: 2026-07-28T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
