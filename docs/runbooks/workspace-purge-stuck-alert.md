# Workspace Purge Stuck Alert Runbook

Implements requirements **PRG-01** and **PRG-03** for the
**workspace-purge-stuck** alert
(`apps/api/src/modules/ops/purge-watchdog.ts`, plan 22-08). Follow this on
receiving an email whose subject is "Mega CRM workspace-purge-stuck alert".

## What fires this

A `purge_records` row (the platform-level checkpoint for the workspace
physical-purge state machine, migration 0068) in one of two states:

- **`purging` past the stuck threshold without progressing.** The worker
  (`apps/worker/src/queues/workspace-purge.worker.ts`) heartbeats
  `last_progress_at` on every batch it commits. This fires when that
  heartbeat (or, before the very first batch has landed,
  `first_destructive_batch_at`) is older than
  `WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS`.
- **`failed`.** A recorded terminal failure, carrying the `purge_error` the
  worker wrote when it gave up.

**A row sitting at `reported` is normal and does NOT fire this alert**,
regardless of how long it has been there. `reported` means the
pre-destruction census has been written and destruction starts on the
worker's next tick (`WORKSPACE_PURGE_TICK_CRON`, once daily by default) — a
purge sitting there for a whole tick is the announce-then-act design
(D-07) working as intended, not a stall.

## How to confirm

**Read the `purge_records` row for the named workspace** (the alert body
names the workspace id):

```bash
docker compose -f docker/docker-compose.prod.yml exec -T db \
  psql -U postgres -d mega_crm -c \
  "SELECT workspace_id, status, reported_at, first_destructive_batch_at,
          last_progress_at, purged_at, completed_tables, purge_error
     FROM purge_records
    WHERE workspace_id = '<workspace-id-from-the-alert>';"
```

**Run the on-demand report CLI** for the current census and per-table
progress on that workspace (`db:workspace-purge-report`, plan 22-06):

```bash
npm run db:workspace-purge-report -- --workspace-id <workspace-id-from-the-alert>
```

## What it means

The purge is resumable and checkpointed — `completed_tables` records exactly
which tables have already been fully deleted, and the worker's own walk
skips them on every retry. Nothing has been half-deleted in an unrecoverable
way. The usual cause of a stuck or failed purge is an **environment
problem**, not a code or data-integrity problem: a missing
`AUTH_DATABASE_URL`, an unavailable database, or a held advisory lock (the
worker takes a session-scoped advisory lock under
`PURGE_ADVISORY_LOCK_NAMESPACE` for the whole tick).

That said, the compliance consequence is real and should be stated plainly:
while a purge sits stuck or failed, the tenant's data is still on disk past
the retention promise the platform made when it announced the purge
(`reported_at`). Time-to-resolution on this alert is a compliance metric,
not just an operational one.

## Remediation

The two statuses recover completely differently — read the row's `status`
before choosing an action. Conflating them is how an operator either waits
forever on a row that needs manual intervention, or resumes something that
was deliberately stopped.

### A row stuck at `purging`

1. Fix the underlying cause — restore the missing environment variable,
   bring the database back, or wait out/clear the held advisory lock
   (`SELECT pid, granted FROM pg_locks WHERE locktype = 'advisory'` on the
   worker's platform pool).
2. Let the next tick resume on its own. **No status edit is needed** —
   `purging` is already the status the worker's own destructive selector
   matches (`reported` and `purging` only). The walk skips every table
   already present in `completed_tables`, so nothing is repeated and no
   per-table count is doubled.

### A row at `failed`

**Not retried automatically, by design.** Per
`workspace-purge.worker.ts`'s own header comment on its destructive
selector (22-01 Task 3): the selector matches `reported` and `purging`
ONLY — `failed` is a terminal state for automation, deliberately, so that a
purge a `WorkspaceRestoredError` refused mid-walk (PRG-05: the workspace was
restored while its purge was running) can never silently resume and destroy
a live tenant's data.

**Before running anything**, confirm BOTH of the following:

1. **`organization."deletedAt"` is still set for this workspace.** If it is
   `NULL`, the workspace has been restored — that `failed` record is the
   PRG-05 refusal doing exactly its job, not a fault to clear. Do NOT run
   the recovery statement below; see "What NOT to do."
2. **The recorded `purge_error` names a cause that has actually been
   fixed.** Re-running against an unfixed cause (e.g. `AUTH_DATABASE_URL`
   still missing) just produces the same `failed` row again on the next
   tick.

Once both are confirmed, the single documented exit from `failed` is this
exact statement, copy-pasteable, run against the platform database:

```sql
UPDATE purge_records SET status = 'purging', purge_error = NULL WHERE workspace_id = '<id>';
```

This is the SAME mechanism plan 22-07's auth-failure resume test exercises —
the runbook and the test describe one recovery path, not two. After this
statement commits, the next tick resumes the walk from `completed_tables`
exactly as an interrupted purge does.

## What NOT to do

- **Do not restore the workspace to clear the alert.** Restore refuses once
  the first destructive batch has started (`firstDestructiveBatchAt` is
  set) — a partially purged workspace must never come back live with some
  tables gone and others intact.
- **Do not delete the `purge_records` row.** It is both the resume
  checkpoint (`completed_tables`) and the durable evidence record (D-10) of
  what was purged, when, and what the pre-destruction census counted. It
  survives the destruction of every tenant table it walks, and it survives
  independently of `organization` itself — deleting it destroys evidence a
  compliance review may later need.
- **Do not flip a `failed` row back to `purging` without confirming
  `organization."deletedAt"` is still set first.** See the two-step
  confirmation above.

## Threshold tuning

Three related constants live together in
`apps/api/src/modules/ops/purge-watchdog.ts`, each a first estimate
(this plan's own flagged-assumption note — no purge has ever run at
production scale here):

- **`WORKSPACE_PURGE_STUCK_THRESHOLD_HOURS = 6`** — how long `purging` can
  go without a progress heartbeat before this alert fires. A healthy purge's
  `last_progress_at` should move on the order of seconds to minutes (every
  batch commit), even for a large tenant, so 6 hours is generous headroom
  against a single slow batch or a brief worker restart while still
  catching a genuinely wedged purge within the same working day it starts.
- **`WORKSPACE_PURGE_ALERT_DEDUP_HOURS = 6`** — the minimum gap between two
  alert emails for the same unhealthy condition, matching the same
  event-driven 6-hour window `dead-letter-watchdog.ts` and
  `failed-send-share-watchdog.ts` use. Unlike those siblings, a healthy
  evaluation here also releases the claim early (see `purge-watchdog.ts`'s
  own header comment) — a resolved incident re-arms the switch immediately,
  it does not wait out this window.
- **`WORKSPACE_PURGE_WATCHDOG_INTERVAL_MS`** (15 minutes) — how often the
  watchdog polls `purge_records`. Widening the poll interval delays
  detection; narrowing it has no real cost, since the read is a single
  indexed-status query over a small platform table.

Tune any of these only with evidence from real operation — a versioned edit
to the constant with a comment recording what evidence justified the
change, never a runtime setting.

## Related runbooks

- `docs/runbooks/workspace-purge-and-restore.md` — the general operator
  procedure for the purge/restore lifecycle this alert is one signal inside.
- `docs/runbooks/failed-send-share-alert.md` — the house structure this
  runbook follows.
