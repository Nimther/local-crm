# Bull Board Access Runbook

Implements requirement **OPS-15** for **OPS-14**'s Bull Board — the
read-only queue observability UI mounted by plan 15-16
(`apps/worker/src/bull-board.ts`).

## What Bull Board shows

A read-only view of all 20 BullMQ queues `apps/worker` registers a `Worker`
for (`apps/worker/src/queues/board-queues.ts`), each with live job counts
(waiting/active/delayed/completed/failed) and, per job, its data and
attempt history. This is the fastest way to inspect the exact queue state
several of this phase's own alert runbooks reference —
`docs/runbooks/queue-depth-alert.md` and
`docs/runbooks/oldest-job-age-alert.md` both point here first.

## How to reach it: the exact SSH port-forward command

The board is mounted on `apps/worker`'s own loopback-only health listener
(`WORKER_HEALTH_HOST = 127.0.0.1`, `WORKER_HEALTH_PORT_DEFAULT = 4100`) at
base path `/admin/queues` (`BULL_BOARD_BASE_PATH`,
`apps/worker/src/bull-board.ts`). **No port is published** for this
listener in `docker/docker-compose.prod.yml` — the only path in is an SSH
tunnel to the VPS, forwarding a local port to the worker container's
loopback interface:

```bash
ssh -L 4100:127.0.0.1:4100 <operator-user>@<vps-host>
```

With the tunnel open, visit:

```
http://127.0.0.1:4100/admin/queues
```

This works because `4100` inside the SSH command is the **container's own**
loopback port as seen from inside the VPS host's network namespace where
Docker publishes the worker's listener to `127.0.0.1` — if the compose
topology's `WORKER_HEALTH_PORT` has been changed from its default via the
operator's env file, forward that port instead of `4100` on both ends of
the `-L` argument.

## Why there is no login — and why that is the correct design, not a gap

**Access control here is network placement, not application
authorization (D-09).** The listener binds to `127.0.0.1` only, no port is
published in `docker/docker-compose.prod.yml`
(`scripts/validate-prod-compose.mjs`'s CI gate fails the build if any
service other than `web` ever declares a `ports:` mapping — see
`docs/runbooks/production-topology.md`), and the only path in is the SSH
access an operator already has to the VPS. **The operator's own SSH
credential is the access control for this board** — there is no second,
weaker credential guarding it behind that.

**Do not expose this board through Caddy, and do not add basic auth in
front of it.** Both were considered and explicitly rejected (D-09,
T-15-54): adding either would be a second, redundant control layered on top
of the actual boundary (network reachability) — not a stronger one, and
publishing the port at all would mean the board's own reachability no
longer depends on SSH access at all, defeating the design outright. If a
future need arises for someone without VPS SSH access to view queue state,
that is a new requirement calling for its own reviewed design (a proper
authenticated admin surface), not a quick Caddy route added to this
listener.

## The board is a diagnostic view, not a control panel

Every queue handle the board reads is constructed with `readOnlyMode: true`
(`BullMQAdapter`), enforced **server-side** by `@bull-board/api`'s own
`queueProvider` — any mutating route (retry/remove/promote/clean/pause/
resume/obliterate) returns 405 regardless of what the UI itself renders.
This is not merely hiding buttons in the frontend; attempting a mutating
request directly against the API (bypassing the UI entirely) is refused the
same way. There is no operator action available through this board beyond
looking.

## What to do if the tunnel or the board itself does not work

1. **Confirm the worker container is running and healthy**:
   ```bash
   docker compose -f docker/docker-compose.prod.yml ps worker
   ```
2. **Confirm the health listener itself is up**, from inside the VPS host
   (the tunnel target is loopback-only, so this check has to run on the
   host, not from your own machine):
   ```bash
   curl -s http://127.0.0.1:4100/healthz
   ```
   A response confirms the listener is bound and the board's mount point
   (`beforeListen`, run before `app.listen()`) should also be live, since
   both are registered on the same Fastify instance before it starts
   accepting connections.
3. **If the SSH tunnel itself fails to establish**, this is an SSH
   access/networking problem unrelated to the board — confirm ordinary SSH
   access to the VPS works before suspecting the board.

## Related runbooks

- `docs/runbooks/queue-depth-alert.md` and
  `docs/runbooks/oldest-job-age-alert.md` — both reference this board as
  their fastest confirmation path.
- `docs/runbooks/production-topology.md` — the compose topology this
  listener's port-publishing invariant is part of.
