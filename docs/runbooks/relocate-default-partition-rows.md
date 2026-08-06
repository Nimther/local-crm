# Relocate DEFAULT Partition Rows Runbook

Implements decision **D-08** (an executable script plus this runbook, with the
criterion-3 automated test running the exact same code the operator runs) and
satisfies requirement **DB-03** ("a documented, operator-invoked procedure
empties either DEFAULT partition without holding a long exclusive lock on the
live table").

## What this procedure is for

`events` and `send_events` are `RANGE`-partitioned by `occurred_at`, with a
`DEFAULT` partition (`events_default` / `send_events_default`) as a catch-all
for any row whose timestamp does not fall inside an already-created monthly
partition. A row landing in `DEFAULT` is not a correctness failure — it is
still there, still queryable through the parent — but it is a permanent tax:
every future `ATTACH PARTITION` against a table with a non-empty `DEFAULT`
forces Postgres to scan `DEFAULT` under an `ACCESS EXCLUSIVE` lock to prove
the new month's range holds no rows, unless the CHECK-constraint-first
technique is used (this codebase's `attachPartitionCheckFirst` always uses
it — see `packages/db/src/partitions/ensure-partitions.ts`). Rows in
`DEFAULT` do not go away on their own; Postgres has no primitive for moving a
row between partitions, so someone has to run this procedure.

## How you find out you need to run this

`apps/api/src/modules/ops/partition-watchdog.ts`'s daily health check treats
a non-zero `events_default`/`send_events_default` count as **unhealthy** and
sends a plain-text operator alert email naming which table has rows and
instructing you to run this procedure — this is D-10's detection loop
closing on a human. You should not need to go looking for this condition;
the alert finds you. If you are reading this runbook without having received
that alert, you can still check manually (see **Pre-flight check** below).

## Pre-flight check

1. **Confirm which database you are about to modify.** `DATABASE_URL` (or
   whatever `MEGA_CRM_ENV_FILE` resolves to) determines the target — the
   command below prints the resolved database **name** (never the full
   connection string, which carries credentials) as its first line of
   output. Read it before doing anything else. Do not run this against a
   database you have not verified.
2. **Record the current state**, so you can verify conservation afterward:

   ```sql
   SELECT count(*) FROM events_default;
   SELECT count(*) FROM send_events_default;
   SELECT count(*) FROM events;       -- inside a tenant-scoped session, or
   SELECT count(*) FROM send_events;  -- via the per-table breakdown the report gives you
   ```

   The relocation procedure only ever *moves* rows — it never deletes one and
   never drops a partition (see **What this procedure deliberately does
   not do**, below) — so the parent table's total row count must be
   identical before and after a successful run.

## The command

From the repository root:

```bash
npm run relocate:default-partition-rows
```

This delegates to `packages/db`'s own `relocate:default-partition-rows`
script (`tsx scripts/relocate-default-partition-rows.ts`), which is a thin
wrapper — all relocation logic lives in
`packages/db/src/partitions/relocate-default.ts`'s `relocateAllDefaultRows`,
the exact same function `packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts`
calls directly. The documented procedure and the automated evidence for it
can never diverge into two implementations.

## What it locks, and for how long

For each month discovered in `DEFAULT` (see **How months are discovered**),
the procedure:

1. Creates a freestanding (not yet attached) table for that month, if it does
   not already exist.
2. Moves rows out of `DEFAULT` into it in bounded batches of 500 rows, one
   short transaction per batch (`FOR UPDATE SKIP LOCKED`, so a batch never
   blocks on a row a concurrent writer or a concurrent run already has
   locked — it skips it instead). No single transaction holds a lock for
   longer than one batch of 500 rows takes to move.
3. Attaches the now-populated table via the same CHECK-constraint-first
   sequence every other partition attach in this codebase uses: a
   metadata-only `NOT VALID` constraint on `DEFAULT` (near-instant), a
   `VALIDATE CONSTRAINT` scan under `SHARE UPDATE EXCLUSIVE` (concurrent
   reads and writes to `DEFAULT` continue normally during this scan), then a
   scan-free `ATTACH PARTITION` (fast, because Postgres trusts the
   just-validated constraint instead of re-scanning `DEFAULT` itself).

At no point does ingestion into `events` or `send_events` block for the
duration of the move. The only locks held are: row-level locks on the 500
rows in the current batch, and the brief metadata/validation locks the
CHECK-constraint-first attach sequence takes on `DEFAULT` itself (the same
locks every other automated partition creation in this system already takes,
daily, without operator involvement).

## How months are discovered

The procedure does not assume a bounded "how many months back" window — it
queries `DEFAULT` directly (`SELECT DISTINCT date_trunc('month', ...)`) for
every month bucket actually present in the data, and relocates every one it
finds, including a month far outside any expected range.

## Reading the report

The command prints one block per table (`events`, `send_events`):

| Field | Meaning |
|---|---|
| `<month> -> <partition>: N row(s) moved in B batch(es)` | One line per month found in `DEFAULT`. `B` batches means the month had somewhere between `500*(B-1) + 1` and `500*B` rows — more than one batch is expected and normal for a month that accumulated a large backlog. |
| `total rows moved` | Sum of every month's `N` for this table. |
| `residual DEFAULT count` | The table's `DEFAULT` row count **after** this run. This is the number that matters most — see below. |

A table with nothing to relocate prints `(no months found in DEFAULT --
nothing to relocate)` and a residual count of `0` — this is what a healthy,
already-relocated (or never-defaulted) table looks like, and it is what
running this command against a database with an empty `DEFAULT` will always
print.

## How to confirm it worked

All three of the following must be true:

1. **Both residual `DEFAULT` counts are `0`.** The command itself checks
   this and exits non-zero if either is above zero — see **What to do on a
   non-zero residual count** below. You can also re-run the pre-flight
   `SELECT count(*) FROM events_default` / `send_events_default` queries
   yourself.
2. **Each parent's total row count is unchanged** from what you recorded in
   the pre-flight check. The procedure only moves rows between partitions of
   the same parent table — the parent's own total is conserved by
   construction, and this is one of the automated test suite's own
   assertions (row-conservation, in both
   `relocate-default.test.ts` and `boundary-crossing-late-automation.test.ts`).
3. **No relation matching `events_%` or `send_events_%` is left with
   `relispartition = false`.** A freestanding, unattached table left behind
   after a crash mid-run would show up here — it is not properly protected
   by the parent's Row-Level Security policy while unattached (T-09-19), so
   this check matters for tenant isolation, not just tidiness:

   ```sql
   SELECT c.relname
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND NOT c.relispartition
      AND (c.relname LIKE 'events_%' OR c.relname LIKE 'send_events_%');
   ```

   An empty result set is correct.

## What to do on a non-zero residual count

The command exits non-zero and names the residual total whenever either
table's `DEFAULT` still holds rows after the run. This is expected, not a
bug: each batch claims rows with `FOR UPDATE SKIP LOCKED`, which deliberately
skips (rather than blocks on) a row a concurrent writer is touching at that
exact moment — a row inserted into `DEFAULT` for a month this run has already
passed, or a row a concurrent relocation run has locked, can be left behind.

**Re-run the command.** It is idempotent: a re-run against an already-empty
`DEFAULT` reports zero months and zero rows moved for every table, and does
nothing further. Keep re-running until both residual counts reach zero.

## What this procedure deliberately does not do

- **It never deletes a row.** A row is moved from `DEFAULT` into the correct
  monthly partition of the same parent table — it remains fully queryable
  through the parent, with an identical value, for the same tenant, the
  entire time.
- **It never drops a partition.** Retention (deciding when a partition's data
  is old enough to remove) is Phase 14 / **DB-11** — a distinct, later
  concern from relocation, which is purely about correctness (rows should
  not sit in the catch-all forever) rather than data lifecycle.

## A month far outside any expected window is not a fault

A provider-supplied timestamp that lands far in the future — for example, a
SendGrid event whose `occurred_at` reads as the year **2031** — is relocated
exactly like any other month: the procedure creates and attaches a
correspondingly-named partition (e.g. `events_2031_04`) for it. This is
**intended behaviour under D-09**, not something to investigate as a bug.
`send_events.occurred_at` is a SendGrid-supplied event timestamp, not a
platform-controlled ingestion time, and it is not bounded at ingestion until
**Phase 13 / CMP-05** adds that validation. Until then, a wildly-future
timestamp producing a wildly-future partition is the correct, accepted
behaviour (see also threat T-09-18 in `09-04-PLAN.md`'s threat register,
which records the unbounded-partition-count risk as explicitly accepted, not
mitigated, for this phase).
