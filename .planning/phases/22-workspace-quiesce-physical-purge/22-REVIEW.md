---
phase: 22-workspace-quiesce-physical-purge
reviewed: 2026-08-24T00:00:00Z
depth: standard
files_reviewed: 61
files_reviewed_list:
  - apps/api/src/modules/api-keys/api-key-auth.ts
  - apps/api/src/modules/events/__tests__/events-api-quiesce.test.ts
  - apps/api/src/modules/ops/__tests__/purge-watchdog.test.ts
  - apps/api/src/modules/ops/purge-watchdog.ts
  - apps/api/src/modules/tenancy/workspace-lookup.ts
  - apps/api/src/modules/webhooks/__tests__/webhooks-quiesce.test.ts
  - apps/api/src/modules/webhooks/webhooks.routes.ts
  - apps/api/src/server.ts
  - apps/worker/package.json
  - apps/worker/src/__tests__/bull-board.test.ts
  - apps/worker/src/env.ts
  - apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts
  - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
  - apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts
  - apps/worker/src/queues/__tests__/workspace-purge-neighbour-safety.test.ts
  - apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts
  - apps/worker/src/queues/__tests__/workspace-purge.test.ts
  - apps/worker/src/queues/__tests__/workspace-quiesce-dispatch.test.ts
  - apps/worker/src/queues/__tests__/workspace-quiesce-ingest.test.ts
  - apps/worker/src/queues/__tests__/workspace-quiesce-scan.test.ts
  - apps/worker/src/queues/analytics-reconciliation.worker.ts
  - apps/worker/src/queues/board-queues.ts
  - apps/worker/src/queues/campaign-kickoff.worker.ts
  - apps/worker/src/queues/events-ingest.worker.ts
  - apps/worker/src/queues/flows/flow-send.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/queues/workspace-purge-auth.ts
  - apps/worker/src/queues/workspace-purge-checkpoint.ts
  - apps/worker/src/queues/workspace-purge.worker.ts
  - apps/worker/src/server.ts
  - apps/worker/src/test/harness/workspace-purge-kill-entrypoint.ts
  - docker/prod.env.example
  - docs/PII-INVENTORY.md
  - docs/runbooks/backups.md
  - docs/runbooks/workspace-purge-and-restore.md
  - docs/runbooks/workspace-purge-stuck-alert.md
  - packages/db/migrations/0068_workspace_purge_records.sql
  - packages/db/migrations/0069_erasure_records_contact_fk_relax.sql
  - packages/db/migrations/0070_scan_policies_exclude_deleted_workspaces.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/migrations/meta/0069_snapshot.json
  - packages/db/package.json
  - packages/db/scripts/restore-workspace.ts
  - packages/db/scripts/verify-restored-database.ts
  - packages/db/scripts/workspace-purge-report.ts
  - packages/db/src/__tests__/migrate-from-empty.test.ts
  - packages/db/src/__tests__/migration-empty-diff.test.ts
  - packages/db/src/__tests__/migration-rollback-rehearsal.test.ts
  - packages/db/src/__tests__/migration-tiers.test.ts
  - packages/db/src/__tests__/workspace-restore.test.ts
  - packages/db/src/index.ts
  - packages/db/src/migration-tiers.ts
  - packages/db/src/schema/auth.ts
  - packages/db/src/schema/erasure-records.ts
  - packages/db/src/schema/purge-records.ts
  - packages/db/src/workspace-purge-report.ts
  - packages/db/src/workspace-purge-tables.ts
  - packages/db/src/workspace-restore.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/workspace-quiesce.ts
findings:
  critical: 1
  warning: 4
  info: 3
  total: 8
status: issues_found
---

# Phase 22: Code Review Report

**Reviewed:** 2026-08-24T00:00:00Z
**Depth:** standard
**Files Reviewed:** 61
**Status:** issues_found

## Summary

This phase implements a well-designed, carefully-documented quiesce-then-purge
state machine: fail-closed dispatch/ingest quiesce checks, an announce-then-act
report/destroy separation, FK-ordered checkpointed batches, a per-workspace
advisory lock shared with the restore path, and a point-of-no-return refusal
that has no override. The real-SIGKILL failure-injection coverage
(`workspace-purge-resume.test.ts` + the kill harness) is unusually thorough and
exercises the mid-batch, between-tables, and before-tail boundaries with real
process kills rather than mocks.

The one finding that undermines the phase's own stated goal ("PII and secrets
are physically destroyed") is that `dead_letter_jobs` — a table that can carry
raw contact PII in terminally-failed job payloads — has no `workspace_id`
column, is absent from `PURGE_TABLE_ORDER`/`PURGE_EVIDENCE_TABLES`, and is not
mentioned anywhere in `docs/PII-INVENTORY.md` or the purge runbook's "what
survives, and why" table. It is not a documented, deliberate evidence
exception like the four tables that are named — it appears to be a genuine
gap. The remaining findings are narrower: a batch-bound correctness issue on
the two partitioned purge tables (backstopped by RLS, so not a tenant-leak
risk in practice), a real crash-window in the auth-step count bookkeeping that
the existing kill-resume tests do not exercise, and an explicitly-flagged
TODO duplicate that was never cleaned up once both branches landed.

## Critical Issues

### CR-01: `dead_letter_jobs` is untouched by the physical purge and undocumented in the PII inventory

**File:** `packages/db/src/schema/dead-letter-jobs.ts:27-42`, `packages/queue-core/src/dead-letter-writer.ts`, `packages/db/src/workspace-purge-tables.ts:74-150` (`PURGE_TABLE_ORDER`/`PURGE_EVIDENCE_TABLES`), `docs/PII-INVENTORY.md`

**Issue:** `dead_letter_jobs.payload` stores the scrubbed BullMQ `job.data` for
every terminally-failed job across every queue (`writeDeadLetterOnTerminalFailure`
in `packages/queue-core/src/dead-letter-writer.ts`). `scrub()` only redacts
values that match a fixed key-name list (`email`, `phone`, `token`, ...) or a
handful of value-shape patterns (email regex, phone regex, SendGrid-key
regex). It has no coverage for `externalId`, `firstName`/`lastName`,
`testTo` (a raw recipient address on a failed test-send job — not caught by
the `email` key rule because the field is literally named `testTo`), or the
freeform `properties` object an `events:ingest` job payload carries — the
exact same unbounded, tenant-controlled key space that
`docs/PII-INVENTORY.md` itself treats as too dangerous to allowlist for
`events.properties` and `send_events.payload`'s non-evidence keys ("a tenant
can put another subject's email, name, or any other person's data under any
key name"). A terminally-failed `events:ingest`/`email-broadcast` job for a
now-purged workspace therefore leaves this exact class of data sitting in
`dead_letter_jobs`, forever, in cleartext where it isn't a literal email/phone
shape.

This table:
- has **no `workspace_id` column at all** (confirmed in
  `packages/db/src/schema/dead-letter-jobs.ts`'s own header comment), which
  also makes it structurally impossible for the purge to scope a delete to
  one tenant even if it wanted to;
- is **absent from `PURGE_TABLE_ORDER`** (destroyed) and **absent from
  `PURGE_EVIDENCE_TABLES`** (`workspace-purge-tables.ts:74-150` /
  `:246`, deliberately-kept evidence set);
- is **not named anywhere in `docs/PII-INVENTORY.md`**, neither in the
  "Included" table nor the "Excluded tables" table, even though every other
  platform-bookkeeping table this phase touches or deliberately skips
  (`ingress_journal`, `send_event_quarantine`, `reputation_alert_state`,
  `workspace_daily_rollup`, `workspace_suppressions`, `erasure_records`, ...)
  has an explicit row there with a stated reason;
- is **not named anywhere in `docs/runbooks/workspace-purge-and-restore.md`'s
  "What survives, and why" table**, which enumerates exactly four deliberate
  evidence survivors (`erasure_records`, `purge_records`,
  `workspace_suppressions`, `workspace_daily_rollup`) and states as a design
  goal that "an operator or auditor finding these rows after a purge must be
  able to tell 'correct by design' from 'purge incomplete' at a glance" — a
  fifth, unlisted, PII-bearing survivor defeats exactly that goal.

This directly contradicts the phase's own charter (the phase description:
"after the retention window its PII and secrets are physically destroyed")
and the project's DSR/erasure precedent, where the identical unenumerable
tenant-properties problem was treated as a hard scrub target
(`buildScrubbedEventProperties` returns `{}` unconditionally).

**Fix:** Either (a) add `dead_letter_jobs` to a documented, workspace-scoped
purge step — this requires adding a `workspace_id` column (backfilled from
`payload.workspaceId` where derivable) so a purge tick can delete/redact rows
for a specific tenant, or (b) if the deliberate decision is that dead-letter
rows are short-lived operational data that should simply be deleted/redacted
on their own retention timer regardless of purge (the simplest fix, since
these rows already exist purely for operator debugging of a terminal
failure), document that retention/deletion policy explicitly and record the
table in `PII-INVENTORY.md`'s "Excluded tables" section with the stated
reason, and reconcile the runbook's survivor table. Whichever is chosen, this
must be a same-change update to `PII-INVENTORY.md` per that document's own
stated "same-change rule."

## Warnings

### WR-01: `deletePurgeBatch`'s outer DELETE has no `workspace_id` predicate of its own — the 500-row batch bound is not actually enforced on `events`/`send_events`

**File:** `packages/db/src/workspace-purge-tables.ts:259-277`

**Issue:** The outer statement is:

```sql
DELETE FROM ${spec.table}
 WHERE ctid IN (
   SELECT ctid FROM ${spec.table}
    WHERE ${spec.workspaceColumn} = $1
    LIMIT $2
    FOR UPDATE SKIP LOCKED
 )
```

Only the inner subquery is scoped to `workspace_id`; the outer `DELETE`
matches on `ctid` alone. For an ordinary (non-partitioned) table this is
harmless — `ctid` is unique within that one physical relation. For the two
partitioned purge targets, `events` and `send_events`
(`PURGE_TABLE_ORDER` includes both), `ctid` is only unique **within each
monthly child partition** — the same `(block, offset)` pair legitimately
recurs across different partitions. Because the outer `DELETE` is evaluated
as a per-partition scan filtered only by `ctid = ANY(...)`, a `ctid` returned
by the subquery for one month's partition can coincide with an unrelated row
physically located at the same block/offset in a different month's partition
of the **same table**, and that row gets deleted too — even though it was
never selected by the subquery's own `workspace_id`/`LIMIT` predicate. In
practice this is backstopped by `FORCE ROW LEVEL SECURITY` on both tables
(confirmed in migrations `0007_events_partitioned.sql` and
`0020_send_events_partitioned.sql`) and the `withTenant(workspaceId, ...)`
scope every call site wraps this in, so a cross-tenant deletion cannot occur
— RLS makes any other tenant's rows invisible to this session regardless of
which `ctid` the outer scan is comparing against. What RLS does *not* prevent
is the **same tenant's** rows in a different month's partition being swept up
in the same "one batch" delete when their `ctid` happens to collide with a
`ctid` the subquery picked for the target month — silently violating the
500-row-per-transaction bound `PURGE_BATCH_SIZE`/the checkpoint heartbeat
cadence is designed around, for exactly the two tables (`events`,
`send_events`) that hold the highest row volume in this system.

**Fix:** Add the same workspace predicate to the outer statement so it can
never depend on RLS (or on ctid uniqueness assumptions) alone for its own
batch-size correctness:

```sql
DELETE FROM ${spec.table}
 WHERE ${spec.workspaceColumn} = $1
   AND ctid IN (
     SELECT ctid FROM ${spec.table}
      WHERE ${spec.workspaceColumn} = $1
       LIMIT $2
       FOR UPDATE SKIP LOCKED
   )
```

### WR-02: The auth-step's `member`/`invitation` count can be overwritten with zero after a crash between the auth delete and the checkpoint write

**File:** `apps/worker/src/queues/workspace-purge-checkpoint.ts:130-142` (`recordAuthPurgeCounts`), `apps/worker/src/queues/workspace-purge.worker.ts:399-403`

**Issue:** The auth-step tail is three separate statements/commits on two
different connections: (1) `deleteWorkspaceAuthRows` deletes and commits on
the dedicated `mega_crm_auth` pool; (2) `recordAuthPurgeCounts` writes the
returned counts into `purge_records.table_counts` on the platform pool; (3)
`markPurgeTableDone` appends the `"auth"` marker to `completed_tables`. A
crash between (1) and (2)/(3) leaves `completed_tables` still missing
`"auth"`. The next tick resumes, sees `AUTH_STEP_MARKER` absent, and re-runs
the whole block: `deleteWorkspaceAuthRows` now deletes **zero** rows (they
are already gone), and `recordAuthPurgeCounts` writes `{member: 0,
invitation: 0}` into `table_counts` — **overwriting or being the first
successful write of** the real destroyed counts with zero. This is the exact
opposite of `table_counts`'s own stated invariant elsewhere in this same file
("the immutable pre-destruction census, written once ... and never
overwritten afterward").

The doc comment on `recordAuthPurgeCounts` claims "a resumed purge that
re-runs an already-completed auth step ... writes the same two numbers
again, which is harmless" — this is only true when step (2) already
succeeded before the crash. It is false in the (1)-succeeded-but-(2)-never-ran
window, which is exactly the crash window a checkpoint-and-resume design
exists to make survivable. The `before_tail` kill-resume test
(`workspace-purge-resume.test.ts`) freezes strictly **before** the auth step
begins, so it proves resumability up to that boundary but does not exercise
this specific window inside the auth step itself — there is no regression
coverage for this gap.

**Fix:** Make the merge in `recordAuthPurgeCounts` write-once, e.g. only set
each key if absent (`table_counts = table_counts || jsonb_build_object(...)
WHERE NOT (table_counts ? 'member')`), or move the count-capture to happen
atomically with the delete itself (return counts from a single statement on
the auth pool and persist them in the same transaction as the delete,
before ever returning to the platform-pool caller). Either way, correct the
doc comment's "harmless" claim once fixed, and add a kill-resume case that
freezes between the auth delete's commit and `recordAuthPurgeCounts`.

### WR-03: TODO-flagged duplicate quiesce lookups were never removed once both branches landed

**File:** `apps/worker/src/queues/events-ingest.worker.ts:11-30`, `apps/worker/src/queues/webhook-events.worker.ts:31-52`

**Issue:** Both files contain a local `isWorkspaceSoftDeletedFor*` function
with a `TODO(22-02)` comment stating: "Whichever of 22-02/22-03 merges second
MUST delete this local copy in favour of importing the shared helper -- do
not leave two lookups with two rules on the branch past the wave boundary."
The shared helper this TODO refers to
(`packages/delivery-core/src/workspace-quiesce.ts`'s `isWorkspaceSoftDeleted`,
and `apps/api/src/modules/tenancy/workspace-lookup.ts`'s
`isWorkspaceSoftDeletedById`) is present and in use elsewhere in this same
phase (`send-dispatch.ts`, `flows/flow-send.ts`, `campaign-kickoff.worker.ts`,
`api-key-auth.ts`, `webhooks.routes.ts`). Both duplicate local copies are
still present in the final diff, past the wave boundary the comment itself
calls out as the deadline. This is exactly the kind of drift risk the
project's shared-lookup pattern exists to prevent: the two local copies
implement the rule correctly today, but nothing enforces that a future change
to the canonical fail-closed rule (e.g. an added `purge_records` join, or a
change to what counts as "not found") gets applied to these two call sites as
well.

**Fix:** Replace both local functions with imports of the shared helper
(`isWorkspaceSoftDeleted` needs a `PoolClient`, so this would need a small
`withTenant`/`withTenantTransaction` wrapper at these two call sites, or a
new platform-pool-compatible export mirroring `isWorkspaceSoftDeletedById`),
and delete the TODO comments once done.

### WR-04: `findEligibleWorkspaces`/`loadEligibleOrganizations` cutoff comparison casts to a bare `timestamp`, making it session-`TimeZone`-dependent

**File:** `apps/worker/src/queues/workspace-purge.worker.ts:111-118`, `packages/db/src/workspace-purge-report.ts:102-109`

**Issue:** Both the tick's own eligibility query and the report CLI's
duplicate of it compute `cutoff = now - retentionDays` in JavaScript and then
compare against `organization."deletedAt"` (itself a bare, non-timezone
`timestamp` column — `packages/db/src/schema/auth.ts:91`) via `<=
$1::timestamp`. `analytics-reconciliation.worker.ts`'s own header comment in
this same codebase documents at length why casting a value without pinning
`AT TIME ZONE 'UTC'` explicitly makes a day-bucketing/cutoff computation
depend on which pooled connection's session `TimeZone` GUC happens to be
active, rather than on any fact about the data. The consequence here is much
smaller in practice (a multi-day retention window absorbs an hours-scale
timezone skew that a daily-bucket rollup cannot), but it is the same class of
bug the codebase has already identified and fixed elsewhere, left
unaddressed at two call sites in this phase.

**Fix:** Not urgent given the day-scale window, but for consistency with the
rest of the codebase's own stated discipline, bind the comparison
unambiguously (e.g. compare `deletedAt <= $1::timestamptz` reasoned in UTC,
or normalize `cutoff`/`deletedAt` through `AT TIME ZONE 'UTC'` the way
`reconcileWorkspaceDay` does) rather than relying on the session default.

## Info

### IN-01: `docker/prod.env.example` documents `WORKSPACE_PURGE_RETENTION_DAYS` but omits `WORKSPACE_PURGE_TICK_CRON`

**File:** `docker/prod.env.example:126-137`

**Issue:** This file's own stated purpose is "an operator has one place that
names every variable and where its real value should come from," and every
other optional-with-a-safe-default worker variable introduced by earlier
phases (`API_PORT`, `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID`, ...) gets at least a
commented-out line. `WORKSPACE_PURGE_TICK_CRON` (`apps/worker/src/env.ts`,
default `"17 3 * * *"`) has no line here at all, commented or otherwise.

**Fix:** Add a commented-out `# WORKSPACE_PURGE_TICK_CRON=17 3 * * *` line
mirroring the `API_PORT`/`WORKER_HEALTH_PORT` convention already used in this
file.

### IN-02: `migration-tiers.ts`'s header comment states a stale migration count

**File:** `packages/db/src/migration-tiers.ts:64`

**Issue:** "Classified by reading every migration in
`packages/db/migrations/*.sql` (63 files, tags 0000-0062 at this commit)" —
this phase adds migrations through `0070`, so the file count and tag range in
this prose are now stale (71 files, 0000-0070). Purely a comment; the
`MIGRATION_TIERS` record itself is correctly extended through `0070`.

**Fix:** Update the header comment's count/range, or drop the specific
numbers in favor of "as of the newest migration below."

### IN-03: Deleted-workspace webhook drop costs an extra DB round-trip that an unknown-`pathToken` response does not

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:149-151`

**Issue:** The route's own comment correctly asserts that the deleted-workspace
404 and the unknown-`pathToken` 404 are body/header-identical, and the
accompanying test (`webhooks-quiesce.test.ts`) confirms that. However, the
deleted-workspace path additionally performs the `isWorkspaceSoftDeletedById`
query (a second round-trip after `findWebhookEndpointByToken`) before
returning, while the unknown-token path returns immediately after the first
lookup. A response-time side channel could in principle let an attacker
holding a *guessed* token distinguish "no such token" from "token exists,
workspace deleted" by timing — a narrower version of the exact enumeration
concern this code's own comments otherwise take great care to close via
identical status/headers/body. This is likely acceptable given the very
narrow audience (an attacker would first need a plausible-looking
`pathToken`, which is itself high-entropy and provisioned per-workspace), and
the phase's chosen tradeoff already documents payload-content risk
explicitly — flagging for completeness rather than as a required fix.

**Fix:** No action required unless the team wants byte-for-byte-equal timing
too; if so, the check would need to run unconditionally (or be replaced with
a single joined query) rather than being skipped for the unknown-token case.

---

_Reviewed: 2026-08-24T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
