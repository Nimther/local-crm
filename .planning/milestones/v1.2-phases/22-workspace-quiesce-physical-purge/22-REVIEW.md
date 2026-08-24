---
phase: 22-workspace-quiesce-physical-purge
reviewed: 2026-08-24T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - apps/worker/src/env.ts
  - apps/worker/src/queues/__tests__/dead-letter-retention.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts
  - apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts
  - apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts
  - apps/worker/src/queues/dead-letter-retention.ts
  - apps/worker/src/queues/workspace-purge-auth.ts
  - apps/worker/src/queues/workspace-purge-checkpoint.ts
  - apps/worker/src/queues/workspace-purge.worker.ts
  - apps/worker/src/test/harness/workspace-purge-kill-entrypoint.ts
  - docker/prod.env.example
  - docs/PII-INVENTORY.md
  - docs/runbooks/workspace-purge-and-restore.md
findings:
  critical: 1
  warning: 3
  info: 1
  total: 5
status: issues_found
---

# Phase 22: Code Review Report — Gap-Closure Plans 22-11 / 22-12

**Reviewed:** 2026-08-24
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

This review covers only the two gap-closure plans (22-11: crash-safe auth-step
census; 22-12: bounded `dead_letter_jobs` retention sweep + env invariant) and
their interaction with the existing `workspace-purge.worker.ts` state machine.
It replaces the prior full-phase review (git commit `8583978`).

The four deliberate design points the dispatch prompt flagged as
false-positive bait were checked directly against the code and hold as
described:

- `deleteWorkspaceAuthRows` still issues exactly two `DELETE` statements
  against exactly two tables on the elevated `mega_crm_auth` pool — confirmed.
- `recordAuthPurgeCounts`'s `jsonb_build_object(...) || table_counts` puts the
  existing column on the right, and Postgres's jsonb `||` resolves duplicate
  keys to the right-hand operand — confirmed against Postgres semantics and
  against `workspace-purge-auth.test.ts`'s own write-once assertions.
- The dead-letter sweep runs last in `processWorkspacePurge`, outside any
  try/catch, and its own module never touches `dead_letter_alert_state` —
  confirmed.
- `dead_letter_jobs` is absent from `PURGE_TABLE_ORDER`, `PURGE_SECRET_TABLES`
  and `PURGE_EVIDENCE_TABLES`, and is named as an explicit, documented
  exemption in `workspace-purge-tables.test.ts`'s inventory-reconciliation
  test — confirmed.

None of those four are re-litigated below. What follows are defects found
underneath and around them: a boot-time misconfiguration trap shared by both
of 22-12's new documentation lines, a silent evidence-drift path in 22-11's
own write-once design, a missing concurrency guard on the new sweep, and one
pre-existing defect this review is obligated to carry forward rather than let
disappear by omission (this document replaces the prior review).

## Critical Issues

### CR-01: `WORKSPACE_PURGE_RETENTION_DAYS=` / `DEAD_LETTER_RETENTION_DAYS=` left blank in `docker/prod.env.example` crashes the worker at boot instead of defaulting to 30

**File:** `docker/prod.env.example:137`, `docker/prod.env.example:153`
**File:** `apps/worker/src/env.ts:53-59`, `apps/worker/src/env.ts:69-75`

**Issue:** Both new-and-existing retention variables are documented as
"defaults to 30 when unset" (env.ts's own doc comments, lines 47-51 and
62-67), and `docker/prod.env.example` deliberately ships them **uncommented,
with a bare trailing `=`** (`WORKSPACE_PURGE_RETENTION_DAYS=`,
`DEAD_LETTER_RETENTION_DAYS=`), on the stated rationale that they are
"non-secret... left empty here per this file's own... convention; the real
operational value is the operator's own choice."

That convention is safe for genuine secrets (an `env_file:` line `KEY=` with
nothing after it still needs a real value supplied elsewhere), but it is
**not** safe for a `.default()`-backed optional variable, and this file
itself demonstrates the safe alternative two sections below for exactly this
situation: `API_PORT`/`WORKER_HEALTH_PORT` are **commented out** (`#
API_PORT=4000`), which means the key is genuinely absent from the container's
environment.

Docker Compose's `env_file:` parser sets a bare `KEY=` line to an **empty
string**, not "absent" — the key IS present in `process.env` with value
`""`. Zod's `.default(30)` only substitutes when the field is `undefined`
(key missing); it does not treat an explicit empty string as "use the
default." `z.coerce.number()` then coerces `""` via `Number("")`, which in
JavaScript is `0`, not `NaN`. `0` passes `.int()` but fails
`.refine((n) => n >= 7)` for both variables — so any operator who follows
this file's own literal convention (leave the line blank, uncommented,
because "the real value is the operator's choice") gets a worker that
refuses to boot in production with `WORKSPACE_PURGE_RETENTION_DAYS must be at
least 7 days` / `DEAD_LETTER_RETENTION_DAYS must be at least 7 days`, on
every single deploy, until the operator notices this file's own
`API_PORT`-style commenting convention was not followed for these two lines.

This is not hypothetical: `docker-compose.prod.yml`'s `worker` service (lines
312-335) delivers both names exclusively via `env_file: ${MEGA_CRM_ENV_FILE}`
— there is no compose-level `${VAR}` interpolation for either name that
could mask or override the blank value, so whatever the operator's real env
file contains for these two lines is exactly what the worker process sees.

**Fix:** Either strip empty strings to `undefined` before the `.default()`
applies, or change the example file to the same commented-out convention it
already uses for `API_PORT`/`WORKER_HEALTH_PORT`. The schema fix is more
robust because it survives operator copy-paste regardless of what the
example file says:

```typescript
// apps/worker/src/env.ts
const emptyStringToUndefined = (v: unknown) => (v === "" ? undefined : v);

WORKSPACE_PURGE_RETENTION_DAYS: z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().default(30),
).refine((n) => n >= WORKSPACE_PURGE_RETENTION_DAYS_FLOOR, {
  message: `WORKSPACE_PURGE_RETENTION_DAYS must be at least ${WORKSPACE_PURGE_RETENTION_DAYS_FLOOR} days`,
}),
```

(same wrapper for `DEAD_LETTER_RETENTION_DAYS`), or, as a documentation-only
fix, change both `docker/prod.env.example` lines to `# WORKSPACE_PURGE_RETENTION_DAYS=30`
/ `# DEAD_LETTER_RETENTION_DAYS=30` (commented out, matching the
`API_PORT` precedent two sections later in the same file) so the key is
genuinely absent unless an operator deliberately uncomments and sets it.

## Warnings

### WR-01: `recordAuthPurgeCounts`'s write-once merge can silently diverge from the rows `deleteWorkspaceAuthRows` actually destroys, across a failed-then-resumed auth step, with no drift warning

**File:** `apps/worker/src/queues/workspace-purge-checkpoint.ts:157-169`
**File:** `apps/worker/src/queues/workspace-purge.worker.ts:416-454`

**Issue:** 22-11's fix closes the crash window between "the delete commits"
and "the count gets recorded" by recording BEFORE the delete and making the
merge write-once (first write wins). But the in-code drift check
(`workspace-purge.worker.ts:440-451`) only ever compares one attempt's own
`preCounts` against that SAME attempt's own `authCounts` — it never compares
against the count that is actually PERSISTED in `table_counts` from an
earlier attempt. This makes a specific, realistic sequence silently
undercount the durable evidence record:

1. Tick N: `countWorkspaceAuthRows` reads `member=2`. `recordAuthPurgeCounts`
   commits `{member: 2, invitation: 1}` (write-once, now locked in).
   `deleteWorkspaceAuthRows` then fails (transient connection error, a
   misconfigured `AUTH_DATABASE_URL`, or any other error class this same
   file's own header comment enumerates as falling into the catch-and-mark-
   `failed` path). `purge_records.status` becomes `failed`.
2. Before the documented operator-act resume (`UPDATE purge_records SET
   status = 'purging', purge_error = NULL ...`, which this very runbook and
   `workspace-purge-auth.test.ts`'s own "operator act resumes" case treat as
   the normal, expected, sometimes multi-day-delayed recovery path), a new
   `member` row is added to this same (already soft-deleted) workspace.
   `apps/api/src/modules/tenancy/invites.ts:50-55` documents that its
   recipient-side accept route (`/api/invites/:invitationId/accept`) is
   deliberately NOT gated on the workspace being active — only invite
   **creation** goes through `findActiveWorkspaceBySlug` (which excludes
   soft-deleted workspaces); acceptance of an invite created before the
   soft-delete is not blocked by any equivalent check. (This narrows to
   configurations where `WORKSPACE_PURGE_RETENTION_DAYS` is near its 7-day
   floor, since a pending invite's own 7-day expiry would otherwise elapse
   well before the default 30-day retention window does — but the failed-
   record resume window itself can be arbitrarily long, bounded only by
   operator response time, not by any code-enforced timeout.)
3. Tick N+1 (resumed): `countWorkspaceAuthRows` now reads `member=3` (the
   real, current count). `recordAuthPurgeCounts` is called again with
   `{member: 3, ...}`, but the write-once jsonb merge discards it — the
   ALREADY-PRESENT `member: 2` from tick N wins. `deleteWorkspaceAuthRows`
   then deletes all 3 real rows and returns `authCounts.memberCount = 3`.
   The drift check compares THIS attempt's own `preCounts.memberCount` (3)
   against THIS attempt's own `authCounts.memberCount` (3) — they agree, so
   **no drift warning is logged at all**, even though the persisted
   `table_counts.member` (2) now permanently understates what was actually
   destroyed.

The physical delete is still complete and correct — no member/invitation row
survives the purge, so there is no PII-retention defect. The defect is in
the durable evidence record itself: `purge_records.table_counts` is
documented (this file's own header comment, the runbook's "What a purge
removes" section) as "the per-table row counts destroyed," and this sequence
makes that claim silently false for an operator or auditor reading the
`purge_records` row after the fact, with no log line anywhere pointing at
the discrepancy.

**Fix:** Have `recordAuthPurgeCounts` read back (or `RETURNING`) the
persisted `table_counts` values after the merge, and compare those against
`deleteWorkspaceAuthRows`'s own returned counts for the drift check — that
compares "what the evidence will say" against "what was actually destroyed,"
which is the comparison that actually protects the evidence record's own
claim:

```typescript
// workspace-purge-checkpoint.ts
export async function recordAuthPurgeCounts(
  client: PurgeRecordsClient,
  workspaceId: string,
  counts: { memberCount: number; invitationCount: number },
): Promise<{ memberCount: number; invitationCount: number }> {
  const { rows } = await client.query<{ tableCounts: Record<string, number> }>(
    `UPDATE purge_records
        SET table_counts = jsonb_build_object('member', $2::int, 'invitation', $3::int) || table_counts,
            updated_at = now()
      WHERE workspace_id = $1
      RETURNING table_counts AS "tableCounts"`,
    [workspaceId, counts.memberCount, counts.invitationCount],
  );
  const persisted = rows[0]?.tableCounts ?? {};
  return { memberCount: persisted.member ?? 0, invitationCount: persisted.invitation ?? 0 };
}
```

then compare the delete's own returned counts against this persisted value
(not against `preCounts`) in `workspace-purge.worker.ts`'s drift check.

### WR-02: `sweepExpiredDeadLetterJobs` has no single-flight guard and its batch-selection subquery has no `ORDER BY`, unlike every other destructive statement in this same tick

**File:** `apps/worker/src/queues/dead-letter-retention.ts:59-80`
**File:** `apps/worker/src/queues/workspace-purge.worker.ts:539-552`

**Issue:** Every other destructive operation in this file is protected by a
per-workspace `pg_try_advisory_lock` (`runWorkspacePurgeWalk`) before it
touches a row. The dead-letter sweep has no equivalent guard at all, and
`createWorkspacePurgeWorker` (this same file, lines 579-608) enqueues a fresh
per-boot immediate job on every worker process start — so a multi-replica
deploy, or a boot-immediate job overlapping the scheduled cron tick, can run
two `processWorkspacePurge()` calls concurrently, each independently calling
`sweepExpiredDeadLetterJobs` against the same platform pool with no
coordination between them.

The batch selector itself compounds this: `SELECT id FROM dead_letter_jobs
WHERE failed_at < $1 LIMIT $2` has no `ORDER BY`, so which specific rows two
concurrent sweeps select for their respective batches is plan-dependent and
not guaranteed to be disjoint. Two overlapping single-statement `DELETE ...
WHERE id IN (...)` calls targeting overlapping id sets will, at minimum,
serialize on row locks (extra round trips, wasted batches once a row already
deleted by the other sweep returns `rowCount` short of expectations) and, in
less-common index-scan-order scenarios, is a plausible ingredient for lock-
wait contention this design was careful to avoid everywhere else in the same
tick via the advisory lock.

This is self-healing (a losing sweep simply retries on the next tick; no
`purge_records` state is involved) and does not affect correctness of what
eventually gets swept, so it is not a data-integrity issue — but it is an
inconsistency with the rest of this file's own concurrency discipline and a
real, if narrow, source of avoidable lock contention.

**Fix:** Add `ORDER BY id` to the subquery (removes the batch-overlap
ambiguity across concurrent sweeps at negligible cost, since `id` is already
the primary key and the DELETE's own driving predicate) and consider gating
the sweep call itself behind a dedicated `pg_try_advisory_lock` the way every
other destructive path in this file already is, so a losing sweep skips
cleanly instead of contending:

```sql
SELECT id FROM dead_letter_jobs
 WHERE failed_at < $1
 ORDER BY id
 LIMIT $2
```

### WR-03: Carried forward — `findEligibleWorkspaces`'s bare `$1::timestamp` cast against `organization."deletedAt"` was flagged by the prior review and remains unresolved

**File:** `apps/worker/src/queues/workspace-purge.worker.ts:112-119`

**Issue:** `dead-letter-retention.ts`'s own doc comment (lines 42-46) states
that "this phase's own verification report already flagged a bare
`::timestamp` cast elsewhere in the purge code as a session-`TimeZone`-
dependent defect class" and explicitly contrasts its own cutoff parameter
(bound with no cast, so `pg` sends it as `timestamptz`) against that
class. The "elsewhere" it refers to is `findEligibleWorkspaces`'s
`"deletedAt" <= $1::timestamp`, which is still present, unchanged by either
gap-closure plan in this review's scope.

`organization."deletedAt"` is declared `timestamp` (without time zone) in
migration `0000_init_auth.sql`, so this specific cast does not have the
"comparing a cast literal against a `timestamptz` column" shape that makes
that defect class dangerous in the general case — but it does mean the
eligibility comparison's correctness now depends on the `pg` driver
serializing the JS `Date` the same way, relative to the same reference
timezone, on both the write path (Better Auth's own adapter setting
`deletedAt` at soft-delete time) and this read path (computing `cutoff` and
casting it here) — a dependency this repository's own verification process
already flagged as worth removing rather than relying on.

Since this review replaces the prior one (git commit `8583978`) rather than
supplementing it, silently omitting this item would make a previously-known,
still-open finding disappear from the active review record. Neither 22-11
nor 22-12 touches this line, but both plans' own retention-day arithmetic
(`WORKSPACE_PURGE_RETENTION_DAYS`, and now `DEAD_LETTER_RETENTION_DAYS`'s
boot-time invariant against it) is only meaningful if the eligibility query
this runbook and both env vars ultimately gate against is itself correct.

**Fix:** Not part of this gap-closure's scope to resolve, but should not be
dropped from the tracked backlog. Suggested fix when addressed: drop the
`::timestamp` cast (bind `cutoff` directly, matching
`sweepExpiredDeadLetterJobs`'s own precedent) or, if a cast is required for
some driver-level reason, cast explicitly against the column's own type
rather than a bare `::timestamp`.

## Info

### IN-01: Three structurally identical `Pool | PoolClient` type aliases duplicated across files

**File:** `apps/worker/src/queues/workspace-purge.worker.ts:84` (`PlatformClient`)
**File:** `apps/worker/src/queues/workspace-purge-checkpoint.ts:47` (`PurgeRecordsClient`)
**File:** `apps/worker/src/queues/dead-letter-retention.ts:22` (`DeadLetterRetentionClient`)

**Issue:** All three are `type X = Pool | PoolClient;` with no other
distinguishing constraint. `DeadLetterRetentionClient` is new in this gap
closure and reproduces the same alias a second and third time rather than
importing one shared definition.

**Fix:** Not urgent, but worth consolidating into one exported alias (e.g.
in `@mega-crm/db` or a small shared worker-internal module) the next time any
of these three files is touched, so a future reader doesn't have to confirm
by inspection that all three names mean the same thing.

---

_Reviewed: 2026-08-24_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
