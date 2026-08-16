# Oldest Job Age Alert Runbook

Implements requirement **OPS-15** for the **oldest-job-age** alert
(`apps/api/src/modules/ops/oldest-job-age-watchdog.ts`, plan 15-13). Follow
this on receiving an email whose subject is "Mega CRM oldest-job-age alert".

## What this alert means

Every 5 minutes (`OLDEST_JOB_AGE_WATCHDOG_INTERVAL_MS`), this watchdog
evaluates **two independent signals into one alert**, never sending two
emails for the same incident:

1. **A stalled lane** — the oldest still-pending BullMQ job across every
   monitored queue is older than `OLDEST_PENDING_JOB_AGE_ALERT_HOURS` (12h).
   This means a job has not even been *attempted* yet after 12 hours — the
   send pipeline itself has stopped moving on that lane.
2. **A stalled reconciliation backlog** — the oldest `sends` row still in
   `reconciling` status (`reconciling_since`, read platform-wide via the
   `mega_crm_scan` role) is older than `RECONCILING_SEND_AGE_ALERT_HOURS`
   (24h). This means a send was already dispatched to SendGrid, but the
   reconciler has not yet found delivery evidence for it and it is aging
   past the point that is normal.

These are genuinely different failures with genuinely different recovery
paths — read the reason line carefully before picking a recovery action
below.

## What the email body's reasons correspond to

- `<queue-name>: oldest pending job is <N>h old, exceeds threshold <T>h` —
  signal 1 above. Names the queue whose oldest waiting/delayed job is the
  problem.
- `reconciling_since backlog: oldest unresolved send is <N>h old, exceeds
  threshold <T>h` — signal 2 above. This line never names a specific
  workspace or send id (T-15-42) — the age is platform-wide.
- `<queue-name>: unreadable -- blind monitor, treated as unhealthy` — same
  discipline as `queue-depth-alert.md`: an unreadable queue is unhealthy, not
  "no data, assume fine."

Both reasons can appear in the same email if both conditions are true at the
same tick — treat each named reason as its own incident, worth its own
confirmation and recovery below.

## How to confirm the condition independently

**For a stalled-lane reason:** open Bull Board
(`docs/runbooks/bull-board-access.md`) and inspect the named queue's
oldest waiting job directly — the board shows job age. Without the tunnel,
the oldest member of the BullMQ `wait` list can be inspected via `redis-cli`
(the queue's own front-of-list job carries its own timestamp in its BullMQ
job data), but Bull Board is the far faster path for this specific check.

**For a `reconciling_since` reason,** query the age directly:

```bash
docker compose -f docker/docker-compose.prod.yml exec -T db \
  psql -U postgres -d mega_crm -c \
  "SELECT MIN(reconciling_since) AS oldest, now() - MIN(reconciling_since) AS age
   FROM sends WHERE status = 'reconciling';"
```

A `NULL` result here (no rows outstanding) alongside an email you just
received means the condition has already self-resolved between the
watchdog's check and your own — re-run once more a few minutes later before
assuming the alert was spurious; `oldest_reconciling_since` genuinely does
resolve as soon as delivery evidence for the oldest row arrives.

## Recovery actions, least to most disruptive

### For a stalled-lane reason

1. **Confirm `apps/worker` is running and consuming that lane** — identical
   first step to `queue-depth-alert.md`'s own recovery section:
   ```bash
   docker compose -f docker/docker-compose.prod.yml ps worker
   ```
2. **Check the worker's own logs for that queue name** for a processor that
   is throwing on every attempt (occupying a slot without ever advancing the
   oldest job past it):
   ```bash
   docker compose -f docker/docker-compose.prod.yml logs worker --tail 200 \
     | grep '"queue":"<queue-name>"'
   ```
3. **Confirm Redis is reachable** (same `redis-cli INFO memory` check as
   `queue-depth-alert.md`) — a lane that cannot even be dequeued from looks
   identical to a lane nobody is consuming.

### For a `reconciling_since` backlog reason

1. **Confirm webhook delivery evidence is actually arriving from
   SendGrid** — this is exactly `webhook-lag-alert.md`'s own concern; if
   that alert has *also* fired recently, start there — a stalled webhook
   pipeline is the most common root cause of a growing `reconciling`
   backlog, since the reconciler resolves `reconciling -> sent` only when a
   matching `send_events` row exists.
2. **Confirm `apps/worker`'s `send-reconciler` tick is actually running**
   (a 5-minute-class background tick inside `apps/worker`, distinct from
   this API-side watchdog):
   ```bash
   docker compose -f docker/docker-compose.prod.yml exec -T db \
     psql -U postgres -d mega_crm -c \
     "SELECT last_run_at, oldest_reconciling_since, rows_resolved, rows_marked_unknown
      FROM send_reconciler_runs;"
   ```
   A `last_run_at` more than a few minutes in the past means the reconciler
   tick itself has stopped — restart `apps/worker`
   (`docker compose -f docker/docker-compose.prod.yml restart worker`) and
   re-check.
3. **Do not attempt to manually resolve individual `reconciling` rows** —
   there is no operator tool for this, by design (`ARCHITECTURE.md` §9): the
   reconciler is the only writer permitted to move a row out of
   `reconciling`, and it does so strictly from `send_events` evidence, never
   from an operator's guess about what probably happened.

## What to check afterwards to confirm recovery

- For a stalled lane: the named queue's oldest-pending age should be
  dropping tick over tick in Bull Board, not merely below 12h once.
- For a `reconciling_since` backlog: re-run the SQL query above; the age
  should be falling as the reconciler catches up, and eventually the row
  count should reach zero (or a small, recently-dispatched steady state)
  once the backlog clears.
- The dedup window (`OLDEST_JOB_AGE_ALERT_DEDUP_HOURS = 6`) suppresses a
  repeat email for 6 hours even if the condition persists — check the
  underlying signal directly rather than relying on "no second email" as
  proof of recovery.

## How to tune the threshold

**`OLDEST_PENDING_JOB_AGE_ALERT_HOURS = 12`**
(`apps/api/src/modules/ops/oldest-job-age-watchdog.ts`) — a first estimate,
chosen generously enough that a very large legitimate broadcast, draining
under normal per-tenant throttling, should fully drain well within this
window. Tune upward only with real evidence that a legitimate large send
routinely takes longer than 12 hours to clear; tune downward only with
evidence that a genuine stall has gone unnoticed for a meaningful fraction
of this window.

**`RECONCILING_SEND_AGE_ALERT_HOURS = 24`** (same file) — **read this file's
own doc comment before changing this constant.** It is deliberately kept
strictly below `send-reconciler-watchdog.ts`'s own
`RECONCILING_AGE_ALERT_HOURS = 30`, and a **module-load runtime guard throws
at `apps/api` boot** if this ordering is ever violated:

```ts
if (RECONCILING_SEND_AGE_ALERT_HOURS >= RECONCILING_AGE_ALERT_HOURS) {
  throw new Error(/* ... */);
}
```

This is not a soft warning — an edit that violates the ordering will
**prevent `apps/api` from starting at all**, in every environment, until the
constants are brought back into the documented relationship. The 6-hour gap
between the two thresholds exists so this watchdog's own live read of
`sends` surfaces an early warning roughly 6 hours before
`send-reconciler-watchdog.ts`'s worker-health-row-based alert would
independently fire on the same underlying backlog — the two are staggered
warnings on one condition, not simultaneous duplicates. If you tune either
constant, re-verify the inequality holds and that `apps/api` still boots
before deploying.

## Related runbooks

- `docs/runbooks/queue-depth-alert.md` — a related but distinct signal (a
  lane that is filling up, not necessarily stalled).
- `docs/runbooks/webhook-lag-alert.md` — the most common root cause of a
  `reconciling_since` backlog.
- `docs/runbooks/bull-board-access.md` — for inspecting a stalled lane
  directly.
