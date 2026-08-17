# Queue Depth Alert Runbook

Implements requirement **OPS-15** for the **queue-depth** alert
(`apps/api/src/modules/ops/queue-depth-watchdog.ts`, plan 15-13). This
runbook is the recovery procedure an operator follows on receiving an email
whose subject is "Mega CRM queue depth alert" — it does not restate the
alert's own reasons, it tells you what to do about them.

## What this alert means

Every 5 minutes (`QUEUE_DEPTH_WATCHDOG_INTERVAL_MS`), this watchdog reads
`waiting + delayed + active` for every monitored BullMQ lane and compares it
against that lane's own threshold (`QUEUE_DEPTH_THRESHOLDS`,
`apps/api/src/modules/ops/queue-depth-watchdog.ts`). It fires when at least
one lane's depth exceeds its threshold, **or** when a lane is unreadable at
all — an unreadable lane is treated as unhealthy, never as "no data, assume
fine" (T-15-43). This alert answers one question: **is a lane filling up
faster than `apps/worker` is draining it.**

## What the email body's reasons correspond to

The email lists one line per tripped condition, exactly as
`renderQueueDepthAlertText` produces it:

- `<queue-name>: depth <N> exceeds threshold <T>` — that lane's
  `waiting + delayed + active` count is above its threshold. `failed` jobs
  are never counted here — a failed-job pile is `dead-letter-watchdog.ts`'s
  own concern (`docs/runbooks/...` — no separate runbook exists for it yet;
  see `SPECIFICATION.md` §7 for that watchdog).
- `<queue-name>: unreadable -- blind monitor, treated as unhealthy` — the
  watchdog could not read that lane's BullMQ counts at all (Redis
  unreachable, or the specific `Queue` handle threw). Treat this as more
  urgent than a depth breach: it means the platform cannot currently see
  whether that lane is healthy, not merely that it looks unhealthy.

The eight monitored lane names are the `shared-schemas` queue-name
constants: `email-broadcast`, `email-triggered`, `events-ingest`,
`webhook-events`, `campaign-kickoff`, `erasure-scrub`, `imports-csv`,
`flow-enroll-existing` (see `QUEUE_DEPTH_THRESHOLDS`'s own keys for the
exact literal strings, which may differ cosmetically from these
descriptions).

## How to confirm the condition independently

**Fastest: Bull Board** (`docs/runbooks/bull-board-access.md` — open the SSH
tunnel first). The board lists every worker queue with live job counts;
compare the named lane's waiting/delayed/active counts against the
threshold in the email.

**Without the tunnel, or for a queue Bull Board does not show:** query Redis
directly for the same three counts BullMQ itself would report (`bull:<queue
name>:wait`/`:delayed`/`:active` are the underlying BullMQ Redis key
patterns):

```bash
docker compose -f docker/docker-compose.prod.yml exec -T redis \
  redis-cli LLEN "bull:<queue-name>:wait"
docker compose -f docker/docker-compose.prod.yml exec -T redis \
  redis-cli ZCARD "bull:<queue-name>:delayed"
docker compose -f docker/docker-compose.prod.yml exec -T redis \
  redis-cli LLEN "bull:<queue-name>:active"
```

Sum the three numbers and compare against the threshold in the email body.

## Recovery actions, least to most disruptive

1. **Confirm `apps/worker` is actually running and consuming.**
   ```bash
   docker compose -f docker/docker-compose.prod.yml ps worker
   ```
   If the container is not `Up`/healthy, this is the whole story — restart
   it (`docker compose -f docker/docker-compose.prod.yml restart worker`)
   and re-check the depth after a few minutes. A worker that crashed and did
   not restart drains nothing, on any lane, which is exactly this
   condition.

2. **Check the worker's own logs for the affected lane** for a stuck or
   repeatedly-failing job (a processor throwing on every attempt occupies a
   BullMQ concurrency slot without ever draining the backlog behind it):
   ```bash
   docker compose -f docker/docker-compose.prod.yml logs worker --tail 200 \
     | grep '"queue":"<queue-name>"'
   ```
   If one job is stuck, `dead_letter_jobs` (after the job's own
   `attempts` are exhausted) is where it will land — check via Bull Board's
   read-only view or a direct query; the watchdog for that table is a
   separate alert (`dead-letter-watchdog.ts`), not this one.

3. **Confirm Redis itself is reachable and not evicting under memory
   pressure** — a queue that looks like it is backing up in BullMQ's own
   counters can also be a symptom of Redis rejecting writes:
   ```bash
   docker compose -f docker/docker-compose.prod.yml exec -T redis redis-cli INFO memory \
     | grep -E 'used_memory_human|maxmemory_human|evicted_keys'
   ```
   A non-zero, climbing `evicted_keys` alongside `used_memory` near
   `maxmemory` means Redis itself is the bottleneck, not `apps/worker`'s
   processing rate — this is an infrastructure sizing question
   (`docs/runbooks/production-topology.md`'s Redis `mem_limit`/`maxmemory`
   section), not a worker restart.

4. **Most disruptive — scale worker concurrency for the affected lane.**
   Per-lane BullMQ `Worker` concurrency is a code-level constant in
   `apps/worker/src/queues/**`, not an environment variable; raising it
   requires a code change and a redeploy
   (`docs/runbooks/deploy-and-rollback.md`). Reserve this for a
   confirmed, sustained legitimate-volume increase (a genuinely larger
   broadcast pattern than this system has seen before) — not a first
   response to a transient backlog, which the earlier, less disruptive
   steps above should already have resolved or explained.

## What to check afterwards to confirm recovery

- Re-run the Bull Board or `redis-cli` check above; the lane's depth should
  be trending down tick over tick, not merely below the threshold once.
- The watchdog's own dedup window (`QUEUE_DEPTH_ALERT_DEDUP_HOURS = 6`)
  means no second email arrives for the same lane within 6 hours even if the
  condition briefly persists — absence of a second email is not
  confirmation of recovery, only absence of a *repeat* alert. Check the
  queue depth directly.

## How to tune the threshold

Every threshold is a named key in the `QUEUE_DEPTH_THRESHOLDS` record
(`apps/api/src/modules/ops/queue-depth-watchdog.ts`) — one per monitored
lane, each with its own rationale comment. These are explicitly **first
estimates** (15-13-PLAN.md's own flagged-assumption note), not values
validated against a real production load test, because this system does not
yet have one.

To raise or lower a lane's threshold: edit that lane's entry in
`QUEUE_DEPTH_THRESHOLDS` directly, with a comment recording **what evidence
justified the change** (e.g. "raised from 2,000 to 5,000 after observing a
sustained legitimate triggered-lane depth of 3,200 during the 2026-Q4
holiday campaign, confirmed non-stalled via Bull Board over 45 minutes") —
this is a versioned source-code edit reviewed like any other change, never a
runtime setting an operator flips without a code change. A threshold lowered
without evidence just moves the false-alarm rate around; a threshold raised
without evidence risks silencing a genuine stall.

The dedup window (`QUEUE_DEPTH_ALERT_DEDUP_HOURS = 6`) and poll interval
(`QUEUE_DEPTH_WATCHDOG_INTERVAL_MS`, 5 minutes) are separate constants in
the same file — tune only if the 6-hour re-alert cadence is itself found to
be too sparse or too noisy during a real incident, not as a substitute for
getting the depth threshold right.

## Related runbooks

- `docs/runbooks/bull-board-access.md` — the SSH tunnel and the board's URL.
- `docs/runbooks/oldest-job-age-alert.md` — a related but distinct signal
  (a queue that has *stopped* draining, not merely filled up).
- `docs/runbooks/production-topology.md` — Redis sizing (`mem_limit`,
  `maxmemory`) if the Redis-pressure check above turns up something.
