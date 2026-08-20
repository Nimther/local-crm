---
phase: 09-partition-automation-boundary-safety
reviewed: 2026-08-06T17:49:25Z
depth: standard
files_reviewed: 27
files_reviewed_list:
  - apps/api/src/__tests__/env-schema.test.ts
  - apps/api/src/env.ts
  - apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts
  - apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts
  - apps/api/src/modules/ops/partition-watchdog.ts
  - apps/api/src/server.ts
  - apps/api/vitest.config.ts
  - apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts
  - apps/worker/src/queues/partition-maintenance.worker.ts
  - apps/worker/src/server.ts
  - docs/runbooks/relocate-default-partition-rows.md
  - packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql
  - packages/db/migrations/0039_partition_relocation_admin_scan.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/package.json
  - packages/db/scripts/relocate-default-partition-rows.ts
  - packages/db/src/__tests__/fixture-partition-parity.test.ts
  - packages/db/src/index.ts
  - packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts
  - packages/db/src/partitions/__tests__/ensure-partitions.test.ts
  - packages/db/src/partitions/__tests__/relocate-default.test.ts
  - packages/db/src/partitions/ensure-partitions.ts
  - packages/db/src/partitions/maintenance-run.ts
  - packages/db/src/partitions/relocate-default.ts
  - packages/db/src/schema/partition-maintenance-runs.ts
  - packages/test-support/package.json
  - packages/test-support/src/db-fixture.ts
  - scripts/check-env.mjs
findings:
  critical: 4
  warning: 2
  info: 0
  total: 6
status: issues_found
---

# Phase 09: Code Review Report

**Reviewed:** 2026-08-06T17:49:25Z
**Depth:** standard
**Files Reviewed:** 27
**Status:** issues_found

## Summary

This phase builds the partition-automation dead-man's-switch (daily maintenance
worker + API-side watchdog + operator alert) and the DEFAULT-partition
relocation procedure, plus a new admin-scan RLS policy (migration 0039) that
grants the relocation code cross-tenant SELECT visibility into `contacts` and
`sends` during partition attach.

The DDL-safety mechanics (`attachPartitionCheckFirst`'s CHECK-constraint-first
sequence, the batched `SKIP LOCKED` relocation loop, row-conservation, and the
extensive boundary/idempotency test suites in `ensure-partitions.test.ts` /
`relocate-default.test.ts` / `boundary-crossing-late-automation.test.ts`) are
well-built and the tests genuinely exercise the boundary/idempotency claims
they make.

However, tracing the actual production call graph (not just the unit tests,
which all route through dedicated, correctly-isolated pools) surfaces four
concrete, must-fix defects, three of which sit directly in the dead-man's
switch's own failure path — the exact mechanism this phase exists to make
trustworthy:

1. The alert dead-man's-switch cannot fire at all for its single worst-case
   condition (the maintenance job has never written a health row).
2. A failed alert send permanently burns the day's alert-dedup window.
3. The documented "the maintenance worker uses its own dedicated pool, never
   the app's tenant-scoped pool" invariant — the load-bearing safety argument
   behind the new admin-scan RLS policy — is contradicted by the actual
   production wiring of the daily worker.
4. The daily worker's own fire-and-forget queue-scheduler registration has no
   error handling and can crash the entire `apps/worker` process (all 14
   registered BullMQ workers, not just this one) on a transient Redis hiccup
   at boot.

## Critical Issues

### CR-01: The alert dead-man's-switch cannot send when the health row has never existed — the exact case it's built to catch

**File:** `apps/api/src/modules/ops/partition-watchdog.ts:181-218`
**Issue:**
`claimAlertSlot` is a single conditional `UPDATE partition_maintenance_runs
... WHERE id = 1 AND (...) RETURNING last_alert_sent_at`. If no row with
`id = 1` exists yet — the exact `missing_health_row` condition
`evaluatePartitionHealth` is written to detect (the daily maintenance worker
has never successfully run, e.g. a fresh deploy before its first tick, or a
worker that fails on every boot before it can write anything) — this `UPDATE`
matches **zero rows**, so `claimAlertSlot` returns `false`, and
`checkPartitionHealthAndAlert` takes its `if (!claimed) return;` branch
**without ever calling `sendMail`**.

This means the single most catastrophic failure mode this phase exists to
detect — the maintenance job has never run at all — is structurally the one
condition under which no alert can ever be sent, silently. The code correctly
marks this state `healthy: false` (per the `evaluatePartitionHealth` doc
comment's own stated goal, "a dead-man's switch that defaults to healthy on
missing data is worse than no switch at all"), but the downstream claim step
defeats that intent for exactly this row.

Confirmed by the test suite's own gap: `partition-watchdog.test.ts`'s
`describe("evaluatePartitionHealth / renderOperatorAlertText (pure, no DB)")`
test 2 only exercises the pure function with `row = null` directly — it never
drives a genuinely row-absent database through `checkPartitionHealthAndAlert`.
Every DB-backed test in the file (`describe("claimAlertSlot dedup /
checkPartitionHealthAndAlert...")`, tests 5–8) calls `seedHealthRow(...)`
first, so the singleton row always exists before `claimAlertSlot` runs. No
test proves an alert is actually sent on a table with zero rows.

**Fix:** Make the claim succeed even when no row exists, e.g. seed a
sentinel row for `id = 1` at migration time (with `last_run_at` far in the
past so `missing_health_row`/`stale_last_run` still trips), or change
`claimAlertSlot` to an upsert:
```sql
INSERT INTO partition_maintenance_runs (id, last_alert_sent_at, last_run_at, ...)
VALUES (1, $1, '-infinity', ...)
ON CONFLICT (id) DO UPDATE SET last_alert_sent_at = $1
WHERE partition_maintenance_runs.last_alert_sent_at IS NULL
   OR partition_maintenance_runs.last_alert_sent_at < $1::timestamptz - make_interval(hours => $2)
RETURNING last_alert_sent_at
```
(the other `NOT NULL` columns need either relaxed nullability or defaults for
this to work as a bare upsert) — or add an explicit `if (!row) { /* claim and
send unconditionally, bypassing the UPDATE-on-nonexistent-row path */ }`
branch in `checkPartitionHealthAndAlert`. Add a test that provisions a fresh
migrated database with zero rows in `partition_maintenance_runs` and asserts
`checkPartitionHealthAndAlert` actually sends.

### CR-02: `claimAlertSlot` claims the dedup window *before* the send succeeds — a failed send burns the day's alert

**File:** `apps/api/src/modules/ops/partition-watchdog.ts:204-218`
**Issue:**
```ts
const claimed = await claimAlertSlot(deps.client, deps.now, ALERT_DEDUP_HOURS);
if (!claimed) return;
const text = renderOperatorAlertText(row, result.reasons, deps.now);
await deps.sendMail({ to: deps.operatorEmail, text });
```
`claimAlertSlot`'s `UPDATE` commits (auto-commit, no surrounding transaction)
before `sendMail` is even attempted. If `sendMail` rejects — SendGrid down,
network blip, an expired platform API key — the rejection is correctly left
to propagate (per the doc comment, "never swallowed"), but
`last_alert_sent_at` has *already* been written. The next `ALERT_DEDUP_HOURS`
(20h) worth of `checkPartitionHealthAndAlert` calls, from this replica or any
other, will see the row as "already alerted this window" and silently skip
sending — even though the operator never actually received an email and the
underlying condition (e.g. a stalled maintenance job) is still live. This is
precisely the scenario flagged for scrutiny: a failed alert send silently
disarms the alert channel for the rest of the dedup window.

`partition-watchdog.test.ts` test 8 only asserts that the rejection
propagates — it never asserts that a subsequent (successful) attempt can
still claim and send, so this regression has no test coverage either
direction.

**Fix:** Reorder to claim only after a successful send, or make the claim
provisional and roll it back on failure, e.g.:
```ts
const claimed = await claimAlertSlot(deps.client, deps.now, ALERT_DEDUP_HOURS);
if (!claimed) return;
try {
  await deps.sendMail({ to: deps.operatorEmail, text });
} catch (err) {
  // release the slot so the next check (this replica or another) can retry
  await deps.client.query(
    `UPDATE partition_maintenance_runs SET last_alert_sent_at = NULL WHERE id = 1 AND last_alert_sent_at = $1`,
    [deps.now],
  );
  throw err;
}
```
Add a test: seed an unhealthy row, inject a rejecting `sendMail`, assert the
call rejects, then call `checkPartitionHealthAndAlert` again with a
succeeding `sendMail` and assert it actually sends (not deduped away by the
first attempt's failed claim).

### CR-03: The admin-scan safety invariant the new RLS policy depends on is violated by the daily worker's actual pool wiring

**File:** `apps/worker/src/queues/partition-maintenance.worker.ts:85-95` (uses `@mega-crm/tenant-context`'s shared `pool`); `packages/db/src/partitions/ensure-partitions.ts:218-228` and `packages/db/migrations/0039_partition_relocation_admin_scan.sql:43-57` (the documented invariant)
**Issue:**
Migration 0039's own comment, and `attachPartitionCheckFirst`'s comment, both
state the safety argument for the new cross-tenant `contacts`/`sends` SELECT
policy this way: *"the maintenance worker/CLI script that owns `client` here
constructs its own dedicated pool, never shared with the app's tenant-scoped
`@mega-crm/tenant-context` pool, so this invariant holds by construction, not
by convention."* That invariant matters because a connection recycled from a
prior tenant-scoped `withTenantTransaction` call reverts
`app.current_workspace_id` to `''` (not `NULL`), which throws inside
`contacts`'/`sends`' pre-Phase-10 bare-cast `workspace_isolation` policy the
moment Postgres's automatic inherited-FK re-validation runs against a
non-empty attached child.

That invariant is true for the CLI script (`relocate-default-partition-rows.ts`
constructs its own `new Pool(...)`) and for every test suite (all of which
explicitly build a second, dedicated pool). It is **not** true for the daily
worker:
```ts
// apps/worker/src/queues/partition-maintenance.worker.ts
import { pool } from "@mega-crm/tenant-context";
...
export async function processPartitionMaintenance(deps = {}) {
  const client = deps.client ?? pool;   // <-- the SAME pool withTenantTransaction uses everywhere
  ...
}
```
`@mega-crm/tenant-context`'s `pool` is explicitly documented (in that
package's own `index.ts`) as *"shared by both apps/api and apps/worker"* and
is the exact pool `withTenantTransaction` checks connections out of for every
other tick worker running in the same process (flow-run-advance,
campaign-kickoff, webhook-events, thirteen others). `attachPartitionCheckFirst`
calls `client.connect()` on whatever pool it's handed — for the daily worker,
that means it can (and in a live system routinely will) receive a physical
connection that was, moments earlier, used by an unrelated tenant-scoped
transaction elsewhere in the same worker process.

Today this is not yet exploitable/crashing only because `ensurePartitions`
(the daily worker's only call path) always attaches a **freshly-created,
empty** child — Postgres's inherited-FK re-validation is a no-op against zero
rows, so the bare-cast policy is never actually evaluated against a
meaningful predicate for this path. The only code path that attaches a
**non-empty** child (`relocateMonth`, in `relocate-default.ts`) is reached
exclusively through the CLI's own dedicated pool today. But this is an
unenforced, implicit property of the current call graph, not a guarantee —
exactly the "mitigation, not a guarantee" the two-pool discipline is supposed
to be a genuine guarantee of. Any future change that lets `attachPartitionCheckFirst`
be invoked against a pre-populated child through this shared pool (e.g. a
future retry/backfill path, or a refactor that reuses `processPartitionMaintenance`'s
client for something else) reactivates T-09-06 ("safe by default already
failed once") with no defence in place, and the documented invariant will
have actively misled whoever reviews it into believing the guard already
exists.

**Fix:** Give `createPartitionMaintenanceWorker`/`processPartitionMaintenance`
their own dedicated `Pool` (matching the CLI script and every test suite's own
two-pool discipline), rather than defaulting to `@mega-crm/tenant-context`'s
shared `pool`. At minimum, update the comments in `ensure-partitions.ts` and
migration `0039` to accurately describe which callers actually satisfy the
invariant, since as written they assert something false about production
code.

### CR-04: Unhandled promise rejection in the worker's fire-and-forget scheduler registration can crash the entire `apps/worker` process

**File:** `apps/worker/src/queues/partition-maintenance.worker.ts:186-197`
**Issue:**
```ts
const registration = (async () => {
  await queue.upsertJobScheduler(
    JOB_SCHEDULER_ID,
    { pattern: PARTITION_MAINTENANCE_CRON, tz: "UTC" },
    { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS },
  );
  await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });
  await queue.close();
})();
registrationSettled.set(worker, registration);
```
This promise is never awaited or `.catch()`-handled anywhere in production
code (`buildWorker()` in `apps/worker/src/server.ts` never calls
`waitForPartitionMaintenanceRegistration`; that helper is test-only). If
`queue.upsertJobScheduler` or `queue.add` rejects for any reason — a
transient Redis connection error at boot is entirely plausible, the same
class of failure `pool.on("error", ...)` elsewhere in this codebase is
explicitly defended against — this becomes an unhandled promise rejection.
Under Node.js's default `--unhandled-rejections=throw` behavior (the default
since Node 15, and this project targets Node 22 LTS per the stack), an
unhandled rejection terminates the process. That would take down all 14
BullMQ workers registered in `apps/worker/src/server.ts`, not just
partition-maintenance, over a failure in what is meant to be a best-effort
boot-time registration step.

This also leaks the internal `queue` handle on that failure path: `queue.close()`
is the last statement in the chain and is skipped whenever an earlier
`await` throws, so the short-lived internal `Queue`'s Redis connection is
never released.

Existing precedent workers (`campaign-scheduler.worker.ts`,
`analytics-reconciliation.worker.ts`, etc.) use a single unguarded
`void tickQueue.add(...)` fire-and-forget call, which has the same
unhandled-rejection exposure in principle — but none of them chain three
sequential `await`s (including a `.close()` that can be skipped) inside one
un-caught async IIFE, so this instance meaningfully compounds the existing
weakness rather than merely repeating it.

**Fix:**
```ts
const registration = (async () => {
  try {
    await queue.upsertJobScheduler(
      JOB_SCHEDULER_ID,
      { pattern: PARTITION_MAINTENANCE_CRON, tz: "UTC" },
      { name: JOB_NAME, opts: DEFAULT_JOB_OPTIONS },
    );
    await queue.add(JOB_NAME, {}, { ...DEFAULT_JOB_OPTIONS, jobId: bootJobId });
  } catch (err) {
    console.error("partition-maintenance: scheduler registration failed", err);
  } finally {
    await queue.close().catch(() => undefined);
  }
})();
registrationSettled.set(worker, registration);
```
so a registration failure is logged (the daily-run watchdog will independently
catch a job that never runs) instead of crashing the process, and the internal
`queue` handle is always released.

## Warnings

### WR-01: Migration 0038's catch-up partitions bypass the CHECK-constraint-first technique this phase exists to enforce

**File:** `packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql:33-73`
**Issue:**
The migration's own header comment explains its motivation entirely in terms
of Pitfall 13: "every subsequent `ATTACH PARTITION` [against a table with a
non-empty `DEFAULT`] pays a full scan of DEFAULT under an `ACCESS EXCLUSIVE`
lock ... an ingestion outage on the live events table." Yet the 20
`CREATE TABLE ... PARTITION OF events|send_events FOR VALUES FROM (...) TO (...)`
statements in this migration are plain DDL — they do **not** go through
`attachPartitionCheckFirst`'s CHECK-constraint-first sequence (add `NOT
VALID` exclusion CHECK on `DEFAULT`, `VALIDATE CONSTRAINT` under
`SHARE UPDATE EXCLUSIVE`, only then attach). `CREATE TABLE ... PARTITION OF`
is subject to the exact same DEFAULT-partition re-validation scan under
`ACCESS EXCLUSIVE` as an `ATTACH PARTITION` of a freestanding table — the
same Postgres behavior this phase's application code was built specifically
to avoid.

This is safe only as long as `events_default`/`send_events_default` are
genuinely empty at the moment this migration is applied — true if it deploys
before any row would overflow into `DEFAULT` (i.e. before 2026-09-01, the
literal boundary baked into this migration). If deployment slips past that
date for any reason (review delay, CI backlog, a rollback-and-retry), applying
this migration re-triggers the exact "ingestion outage on the live events
table" its own comment says it exists to prevent — for all 20 new partitions
in one migration run, against a `DEFAULT` that has been silently accumulating
real production rows in the meantime. Given this phase's own framing ("safe
by default already failed once", T-09-06), a one-time bootstrap migration
that has no defence against being applied late is a real gap, not a
theoretical one.

**Fix:** Either gate this migration's deployment operationally with a hard
alarm if it lands after 2026-09-01, or make the migration itself defensive by
having it call the same CHECK-constraint-first sequence `ensure-partitions.ts`
uses (a `DO` block invoking the same three-statement pattern per partition,
or simply running `ensurePartitions`/`attachPartitionCheckFirst` from a
one-off script instead of raw SQL) so the migration is safe regardless of when
it actually lands.

### WR-02: `relocateMonth`'s freestanding child creation has no protection against a concurrent CLI invocation

**File:** `packages/db/src/partitions/relocate-default.ts:139-151`
**Issue:**
```ts
await client.query(`CREATE TABLE IF NOT EXISTS ${childName} (LIKE ${table.parentTable} INCLUDING ALL)`);
```
`CREATE TABLE IF NOT EXISTS` is not atomic against genuine concurrency in
PostgreSQL — two sessions can both pass the existence check and both attempt
the `CREATE`, with one raising a duplicate-relation error. Nothing in this
module or the operator-facing CLI (`relocate-default-partition-rows.ts`)
takes an advisory lock the way `packages/test-support/src/db-fixture.ts`'s
migration runner does (`pg_advisory_lock(MIGRATION_ADVISORY_LOCK_KEY)`)
before performing DDL of this shape. The runbook instructs operators to
"re-run the command" on a non-zero residual count but does not warn against
running two instances concurrently (e.g. an operator re-running in a second
terminal after the first appears to hang). The failure mode is a loud
exception rather than data loss, but it is an avoidable, untested gap for a
script explicitly designed to be operator-invoked and re-run.

**Fix:** Take a session-scoped Postgres advisory lock (a distinct key from
`MIGRATION_ADVISORY_LOCK_KEY`) around `relocateAllDefaultRows`'s per-table
work, or document explicitly in the runbook that concurrent invocations
against the same database are unsupported and must not be attempted.

---

_Reviewed: 2026-08-06T17:49:25Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
