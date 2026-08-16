# Log Shipping and Backstop Alerts Runbook

Implements requirement **OPS-15** for **OPS-10**'s log-shipping pipeline and
its two Grafana Cloud backstop alert rules (plan 15-17,
`docker/alloy/config.alloy`, `docs/observability/grafana-cloud-alerts.md`).
This runbook is the operator's own verification procedure for OPS-10 —
**no automated check in this repository can prove logs actually reach
Grafana Cloud or that either alert rule actually fires**; that is exactly
why this document exists, not merely why it references
`docs/observability/grafana-cloud-alerts.md`.

Read `docs/observability/grafana-cloud-alerts.md` first — it documents the
two rules' exact queries and thresholds precisely enough to recreate them.
This runbook does not restate those values; it gives the operator's
step-by-step verification and recovery procedure around them.

## What this covers, and why it is two alerts, not one

`apps/api` runs nine independent in-app watchdogs (`SPECIFICATION.md` §7),
each answering "is a specific business condition healthy." Every one of them
shares the same structural blind spot: **a process cannot alert on its own
death.** If `apps/api` itself stops — the VPS goes dark, a container
OOM-kills and does not restart, Docker itself stops — none of those nine
watchdogs fires, because the code that would fire them is exactly what
stopped running.

The two Grafana Cloud rules exist entirely **outside** this platform's VPS,
watching the log stream Alloy ships there:

1. **No-logs-received (dead-man's-switch)** — fires when log volume falls
   to zero, meaning something upstream of Alloy itself (the host, Docker, or
   every container on it) has stopped.
2. **Error-rate-spike** — fires when the fraction of `api`/`worker` log
   lines at `error`/`fatal` level crosses a threshold, independent of
   whether any specific in-app watchdog's own condition happens to be tuned
   to catch it.

## What the alert emails mean

Both rules point at the same contact point every in-app watchdog uses
(`OPERATOR_ALERT_EMAIL`) — the email subject and body come from Grafana
Cloud's own alerting engine, not from this codebase, so the exact wording is
whatever you configured when creating the rule (see "Recreating both rules"
in `docs/observability/grafana-cloud-alerts.md`).

- **No-logs-received fired:** the entire log-shipping pipeline has gone
  silent for at least 10 minutes (the rule's pending period) — this is the
  most severe signal this platform has, because it means every other alert
  channel that depends on `apps/api` staying alive is also silent right
  now, for the same reason.
- **Error-rate-spike fired:** more than 5% of `api`/`worker` log lines in
  the last 5 minutes are `error`/`fatal` level, sustained for at least 5
  minutes — something is failing loudly across the fleet, whether or not a
  specific in-app watchdog has also caught it.

## How to confirm logs are arriving in Loki (OPS-10 verification)

1. Open Grafana Cloud → Explore, select the Loki data source Alloy pushes to
   (the same one `GRAFANA_LOKI_PUSH_URL`/`GRAFANA_LOKI_USER` point at —
   `docker/prod.env.example`).
2. Run a query for the last 15 minutes:
   ```logql
   {service=~".+"}
   ```
3. Confirm log lines are present, spanning all eight expected `service`
   label values (`db`, `redis`, `api`, `worker`, `web`, `migrate`,
   `pgbackrest`, `alloy` — `scripts/validate-prod-compose.mjs`'s
   `EXPECTED_SERVICES`). A healthy stack emits Docker healthcheck-driven and
   periodic-tick lines from several of these every few minutes even with
   near-zero user traffic — absence of lines from a specific service for
   more than a few minutes, while others are present, is itself worth
   investigating even before either alert rule fires.

## How to run the end-to-end correlation query (phase success criterion 1)

This is the literal check this phase's own success criterion names: an
operator should never have to reconstruct this query during an incident.

1. Trigger one real test send through the platform (a broadcast test send,
   or any triggered send) and capture its `requestId` from either a log line
   or `pg_stat_activity.application_name`'s `req=<requestId>` fragment.
2. In Grafana Cloud → Explore, run:
   ```logql
   {service=~"api|worker"} | json | requestId="<paste-the-requestId-here>"
   ```
3. Confirm the result includes **both** an `apps/api` line (the HTTP
   request) and an `apps/worker` line (the BullMQ job that request
   enqueued), in time order. If only one process's lines appear, one half
   of the pipeline is not correlating — re-check that both
   `apps/api/src/logger.ts` and `apps/worker/src/logger.ts` are stamping the
   same `requestId` (they should be, by shared construction via
   `getCorrelationContext()`; a mismatch here would indicate a code
   regression, not an operator-side configuration problem).

**Field name reminder:** the correlation field is camelCase `requestId`,
never snake_case `request_id` — a query against the wrong spelling silently
matches nothing (`docs/observability/grafana-cloud-alerts.md`'s own field
name note explains why this was easy to get wrong).

## How to test that the dead-man's-switch rule actually fires

This is a deliberate, operator-invoked drill — not something that should be
discovered for the first time during a real incident.

1. Stop only the `alloy` container (never `api`/`worker`/`db` — this drill
   tests the log-shipping path, not the application itself):
   ```bash
   docker compose -f docker/docker-compose.prod.yml stop alloy
   ```
2. Wait past the rule's own evaluation interval plus pending period —
   **~15 minutes** (5m evaluation + 10m pending, per
   `docs/observability/grafana-cloud-alerts.md`'s Rule 1 table) — before
   expecting the alert to fire. Checking earlier than this and concluding
   the rule is broken is the most common false negative in this drill.
3. Confirm the alert email arrives at `OPERATOR_ALERT_EMAIL`.
4. Restart `alloy`:
   ```bash
   docker compose -f docker/docker-compose.prod.yml start alloy
   ```
5. Confirm log shipping resumes (re-run the "logs are arriving" check
   above) and that Grafana Cloud's own rule state returns to normal within
   its own evaluation cadence.

**Do not stop `db`, `redis`, `api`, or `worker` to run this drill** —
stopping any of those affects real application availability, not merely
log shipping, and is a completely different (and much more disruptive) test
than this one.

## How to test that the error-rate-spike rule actually fires

This rule is harder to safely provoke on purpose in production (a real
5%-of-lines error rate sustained for 5 minutes is, by design, a genuinely
bad state) — verify the rule's **query and threshold are configured
correctly** by inspecting it in Grafana Cloud → Alerting → Alert rules
rather than by deliberately degrading production traffic. If a real
incident causes this rule to fire, that occurrence itself is the
confirmation that it works; there is no safe, repeatable drill for this one
in production the way there is for the dead-man's-switch above.

## Recovery actions, least to most disruptive

### No-logs-received fired

1. **Confirm this is not the drill above left mid-run** — check whether
   `alloy` is stopped (`docker compose -f docker/docker-compose.prod.yml ps
   alloy`) and simply start it if so.
2. **Check whether the whole host is reachable at all** — if SSH itself is
   unreachable, this is a VPS-level incident (the host is down, not merely
   a container), and no container-level recovery step applies until the
   host itself is back.
3. **Check whether Docker itself is running**:
   ```bash
   docker compose -f docker/docker-compose.prod.yml ps
   ```
   If no containers show as running at all, Docker itself stopped or the
   host rebooted without the compose stack restarting — bring the stack
   back up:
   ```bash
   docker compose -f docker/docker-compose.prod.yml up -d
   ```
4. **If only `alloy` itself is unhealthy** (host and other containers fine),
   check its own logs before restarting it — a credential rotation on the
   Grafana Cloud side (`GRAFANA_LOKI_PUSH_URL`/`GRAFANA_LOKI_USER`/
   `GRAFANA_CLOUD_API_TOKEN`) is a plausible cause distinct from an
   infrastructure failure:
   ```bash
   docker compose -f docker/docker-compose.prod.yml logs alloy --tail 100
   ```

### Error-rate-spike fired

1. **Identify which process (`api` or `worker`) and which errors** —
   Grafana Cloud → Explore:
   ```logql
   {service=~"api|worker", level=~"50|60"} | json
   ```
   over the alert's own firing window.
2. **Cross-reference against Sentry** — every error this platform's own
   code raises through a normal exception path is also captured in the
   relevant Sentry project (`SPECIFICATION.md` §7's Sentry section); Sentry
   groups and deduplicates in a way raw log lines do not, and is usually the
   faster path to the actual root cause once you know which process is
   affected.
3. **Check whether this correlates with a recent deploy**
   (`docs/runbooks/deploy-and-rollback.md`) — a spike immediately following
   a deploy is the most common cause and that runbook's own rollback
   procedure is the fastest recovery if so.
4. **If the spike does not correlate with a deploy and is not yet
   understood**, treat it as an active incident: the specific recovery
   depends entirely on what the errors are. This alert is a coarse,
   label-only signal by design (no JSON parsing needed to detect it) — it
   exists to tell you *that* something is failing loudly, not *what*; the
   log/Sentry cross-reference above is how you find out what.

## What to check afterwards to confirm recovery

- **No-logs-received:** re-run the "logs are arriving" check above; confirm
  fresh lines from all eight expected services within the last few minutes.
- **Error-rate-spike:** re-run the `level=~"50|60"` query over a fresh
  5-minute window; the error-line volume relative to total volume should
  have dropped back under 5%.
- Both rules clear automatically in Grafana Cloud once their own condition
  is no longer true for a full evaluation cycle — no manual
  acknowledgment or reset step exists in this platform's own code for
  either rule, because they are entirely Grafana Cloud's own state, not
  anything this repository's Postgres tracks.

## How to tune the thresholds

Both rules' exact values live in Grafana Cloud itself (Alerting → Alert
rules), **not** in any file this repository ships — `docker/alloy/config.alloy`
only ships the logs; the rules themselves are provisioned by hand per
`docs/observability/grafana-cloud-alerts.md`'s "Recreating both rules"
section, which is also therefore the reference for what to edit and where.
That document's own tables are the single source of truth for each rule's
query, condition, evaluation interval, and pending period — this runbook
does not duplicate the values, only the recovery procedure around them,
per this repository's own "restate nothing, link instead" convention
(`ARCHITECTURE.md`'s own header rule).

If either rule needs retuning: edit it directly in Grafana Cloud's UI, then
**update `docs/observability/grafana-cloud-alerts.md`'s own table to
match** — a rule that drifts from its own documentation is exactly the
failure mode `check:runbook-coverage` cannot catch (that check only proves
a runbook file exists per in-app alert name; it has no visibility into
Grafana Cloud's own configuration state).

## Related runbooks

- `docs/observability/grafana-cloud-alerts.md` — the two rules' exact
  queries, the correlation query, and the retention window; read this
  first.
- `docs/runbooks/deploy-and-rollback.md` — rollback procedure if an
  error-rate-spike correlates with a recent deploy.
