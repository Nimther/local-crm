---
phase: 09-partition-automation-boundary-safety
fixed_at: 2026-08-06T23:40:00Z
review_path: .planning/phases/09-partition-automation-boundary-safety/09-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 09: Code Review Fix Report

**Fixed at:** 2026-08-06T23:40:00Z
**Source review:** .planning/phases/09-partition-automation-boundary-safety/09-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (CR-01, CR-02, CR-03, CR-04, WR-01, WR-02)
- Fixed: 6
- Skipped: 0

Each finding was fixed as a RED/GREEN commit pair: a `test(09):` commit adds
or extends a test proving the defect (fails against pre-fix code), followed
by a `fix(09):` commit that makes it pass. Working directly on
`gsd/phase-09-partition-automation-boundary-safety` in the main checkout,
per this task's explicit instruction (no isolated worktree).

## Fixed Issues

### CR-01: The alert dead-man's-switch cannot send when the health row has never existed

**Files modified:**
`packages/db/migrations/0040_partition_maintenance_runs_seed.sql` (new),
`packages/db/migrations/meta/_journal.json`,
`apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts`,
`SPECIFICATION.md`

**Commits:** `e20ff59` (test, RED), `148f5b2` (fix, GREEN)

**Applied fix:** New migration `0040` inserts the `id = 1` singleton row
unconditionally (`ON CONFLICT (id) DO NOTHING`), with `last_run_at =
TIMESTAMPTZ 'epoch'` so it always trips `stale_last_run`. Before this,
`claimAlertSlot`'s single conditional `UPDATE ... WHERE id = 1` matched zero
rows on a genuinely fresh database, and `checkPartitionHealthAndAlert` never
sent — exactly the "maintenance worker has never run" condition the
dead-man's-switch exists to catch. Nothing ever deletes this row afterward
(`recordMaintenanceRun`'s own `ON CONFLICT (id) DO UPDATE` only overwrites
it). Chose the migration-seed approach over an upsert-style `claimAlertSlot`
rewrite so the atomic-claim SQL (and its anti-double-send property, load-
bearing for CR-02) stays untouched.

**Test coverage:** New `test 0` in `partition-maintenance-tracer.test.ts`
provisions a fresh ephemeral database through the full migration chain
(nothing has run `runPartitionMaintenance` yet) and asserts
`checkPartitionHealthAndAlert` actually sends — directly closes the gap the
review named (no prior test drove a genuinely row-absent/never-run database
through the alert path). Confirmed RED (`expected +0 to be 1`) before the
migration existed, GREEN after.

### CR-02: `claimAlertSlot` claims the dedup window before the send succeeds

**Files modified:** `apps/api/src/modules/ops/partition-watchdog.ts`,
`apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts`

**Commits:** `c526cdb` (test, RED), `e04c57b` (fix, GREEN)

**Applied fix:** `checkPartitionHealthAndAlert` now wraps `sendMail` in
try/catch. On rejection it resets `last_alert_sent_at` back to `NULL`
(guarded with `WHERE ... last_alert_sent_at = $1` so it only clears the
exact value this call just claimed, never a newer claim written by a
concurrent replica in the meantime) before rethrowing. The claim-before-send
ordering itself is unchanged — that ordering is what keeps the atomic
anti-double-send property across replicas (see `claimAlertSlot`'s own doc
comment, which was read before touching this).

**Test coverage:** Extended test 8 in `partition-watchdog.test.ts`: after
asserting the rejection propagates (existing assertion, unchanged), it now
also asserts that a second `checkPartitionHealthAndAlert` call moments later
(same dedup window) still sends. Confirmed RED (`expected [] to have a
length of 1 but got +0`) before the fix, GREEN after.

### CR-03: The admin-scan safety invariant is violated by the daily worker's actual pool wiring

**Files modified:** `apps/worker/src/queues/partition-maintenance.worker.ts`,
`packages/db/src/partitions/ensure-partitions.ts` (comment correction),
`packages/db/migrations/0039_partition_relocation_admin_scan.sql` (comment
correction), `apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts`,
`SPECIFICATION.md`

**Commits:** `89cf48b` (test, RED), `b53d582` (fix, GREEN)

**Applied fix:** `partition-maintenance.worker.ts` now constructs its own
module-level `Pool` (`partitionMaintenancePool`, with the same
`pool.on("error", ...)` guard `@mega-crm/tenant-context`'s pool has),
matching the CLI script's (`relocate-default-partition-rows.ts`) and every
test suite's own two-pool discipline. `processPartitionMaintenance` now
defaults to this dedicated pool instead of the shared, tenant-scoped
`@mega-crm/tenant-context` pool. Also corrected the comments in
`ensure-partitions.ts` and migration `0039` that asserted the invariant held
"by construction" for every caller — that assertion was false for this
worker; corrected wording describes it as a discipline each caller must
uphold (now true again for every caller in the codebase).

**Test coverage:** New test 6 in `partition-maintenance.worker.test.ts`
calls `processPartitionMaintenance()` with no `client` override (exercising
the actual default-wiring line production hits, unlike tests 4/5 which
always inject a client) and asserts the client `runMaintenance` was called
with is not the same object as `@mega-crm/tenant-context`'s `pool`.
Confirmed RED (`expected {...} not to be {...}` — same object) before the
fix, GREEN after.

### CR-04: Unhandled promise rejection in the scheduler-registration IIFE

**Files modified:** `apps/worker/src/queues/partition-maintenance.worker.ts`,
`apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts`,
`SPECIFICATION.md`

**Commits:** `3cb2a88` (test, RED), `e377ba6` (fix, GREEN)

**Applied fix:** The fire-and-forget registration IIFE in
`createPartitionMaintenanceWorker` now wraps `upsertJobScheduler`/`add` in
try/catch (logs via `console.error`, does not rethrow) and always closes its
internal `Queue` handle in `finally` (`queue.close().catch(() => undefined)`).
Previously a rejection became an unhandled promise rejection (nobody in
production ever awaits/catches this promise) that could terminate the whole
`apps/worker` process under Node's default `--unhandled-rejections=throw`,
and `queue.close()` — the last statement in the old chain — was skipped on
any earlier failure, leaking that connection.

**Test coverage:** New test 7 mocks `Queue.prototype.upsertJobScheduler` to
reject once, then asserts `waitForPartitionMaintenanceRegistration(worker)`
resolves (not rejects), `queue.close()` was still called, and the failure was
logged. Confirmed RED (`promise rejected "Error: simulated redis hiccup at
boot" instead of resolving`) before the fix, GREEN after.

### WR-01: Migration 0038's catch-up partitions bypass CHECK-constraint-first

**Files modified:** `packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql`,
`packages/db/src/__tests__/migration-0038-deadline-guard.test.ts` (new),
`SPECIFICATION.md`

**Commits:** `5d8b820` (test, RED), `09ea2d1` (fix, GREEN)

**Applied fix:** Chose the "gate deployment operationally" remediation
option over duplicating the CHECK-constraint-first sequence inside the
migration — CONVENTIONS.md's "Partition maintenance" section explicitly
names migration `0038` as the ONE sanctioned exception to "that sequence
exists in exactly one function," and duplicating it a second time inside
this same migration would violate that binding rule. Added a `DO $$ ... IF
now() >= TIMESTAMPTZ '2026-09-01 00:00:00+00' THEN RAISE EXCEPTION ... END
IF; END $$;` guard immediately before the 20 `CREATE TABLE ... PARTITION OF`
statements, so applying this migration on/after its own safety deadline now
fails loudly and immediately instead of silently repeating the "ACCESS
EXCLUSIVE scan of DEFAULT" cost twenty times.

**Test coverage:** New test file extracts the guard block verbatim from the
committed migration file (not a retyped copy) and executes it against a real
ephemeral Postgres: unmodified (real "now" is before the cutoff — must not
raise) and with only the cutoff literal substituted for a definitely-past
date (must raise). Confirmed RED (the extraction itself threw — no guard
block existed) before the fix, GREEN after (all 3 assertions pass, including
`lint:migrations`, unaffected by a comment/DO-block-only addition).

### WR-02: `relocateMonth`'s freestanding child creation has no protection against concurrent invocation

**Files modified:** `packages/db/src/partitions/relocate-default.ts`,
`packages/db/src/partitions/__tests__/relocate-default.test.ts`,
`docs/runbooks/relocate-default-partition-rows.md`, `SPECIFICATION.md`

**Commits:** `d7e10aa` (test, RED), `dd30812` (fix, GREEN)

**Applied fix:** `relocateAllDefaultRows` now takes a non-blocking
`pg_try_advisory_lock` (new `RELOCATE_ADVISORY_LOCK_KEY = 8_472_995`,
distinct from `packages/test-support`'s `MIGRATION_ADVISORY_LOCK_KEY =
8_472_991`) on a dedicated connection held for the whole function's
duration, explicitly `pg_advisory_unlock`-ed before that connection is
released back to the pool (a plain `.release()` alone would not release the
session-level lock, since the underlying physical connection survives the
checkout/release cycle). A second concurrent invocation now fails fast with
a clear "another DEFAULT-relocation run already holds the relocation
advisory lock" error instead of possibly racing `relocateMonth`'s `CREATE
TABLE IF NOT EXISTS` into a duplicate-relation error. Runbook updated with a
new "Concurrent invocations are refused, not undefined" section.

**Test coverage:** New test 10 deterministically simulates "another
invocation already running" by acquiring the same advisory lock directly on
a held connection, then asserts `relocateAllDefaultRows` rejects with the
expected message; releases the lock and asserts a subsequent normal run
still succeeds (not a permanent deadlock). Confirmed RED (fails because the
exported lock key did not exist yet) before the fix, GREEN after.

## Skipped Issues

None — all six in-scope findings were fixed.

## Verification (from repo root)

| Command | Result |
|---|---|
| `npm run build` | **PASS** — 11/11 workspaces |
| `npm test` | **PASS** — 12/12 workspaces, 732 tests total (apps/api 281, apps/web 45, apps/worker 124, packages/db 40, packages/delivery-core 70, packages/flows-core 15, packages/kms 10, packages/segments-core 19, packages/shared-schemas 18, packages/tenant-context 7, packages/test-support 103) |
| `npm run lint` | **PASS** — `eslint . --max-warnings=0`, zero violations |
| `npm run lint:migrations` | **PASS** — 41 file(s) checked, no violations |
| `npm run failure:all` | **PASS** — all five failure-injection scenarios (429, timeout, connection-reset, sigkill, redis-restart) green |

---

_Fixed: 2026-08-06T23:40:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
