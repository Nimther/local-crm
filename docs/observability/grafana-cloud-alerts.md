# Grafana Cloud backstop alerts

Implements requirement **OPS-10** and decisions **D-01/D-02/D-03**
(`.planning/phases/15-observability-alerting-frontend-resilience/15-CONTEXT.md`,
`15-RESEARCH.md`). This is the operator-facing record of the two Grafana
Cloud alert rules that back up the nine in-app dead-man's-switches
(SPECIFICATION.md §7) with something that can observe `apps/api` and
`apps/worker` from **outside** those processes — precise enough to
recreate both rules from scratch if the Grafana Cloud stack is ever
rebuilt, plus the end-to-end correlation query an incident needs.

## Why these two live in the cloud, not the app

`apps/api` already runs nine independent dead-man's-switches (partition
maintenance, send reconciler, dead-letter, ingestion health, reputation,
queue depth, oldest job age, webhook lag, failed-send share — SPECIFICATION.md
§7). Every one of them shares the same structural blind spot: **a process
cannot alert on its own death.** If `apps/api` itself stops running — the
VPS goes dark, the container OOM-kills and fails to restart, Docker itself
stops — none of those nine watchdogs fires, because the code that would fire
them is exactly what stopped running.

`docker/alloy/config.alloy` (plan 15-17, D-02) ships every container's own
`json-file` log capture to Grafana Cloud Loki at the infrastructure level —
independent of any application process staying alive. That gives Grafana
Cloud's own alerting engine, which lives entirely outside this platform's
VPS, something the nine in-app watchdogs structurally cannot provide: a
view of whether logs are arriving **at all**. The two rules below are that
view:

1. **No-logs-received (dead-man's-switch)** — if the log volume this
   pipeline normally ships falls to zero, something upstream of Alloy
   itself (the host, Docker, or every container on it) has stopped.
2. **Error-rate-spike** — a coarse, label-only signal (no JSON parsing
   needed — see "Label strategy" below) that something is failing loudly
   across the fleet, independent of whether any specific in-app watchdog's
   query condition happens to be tuned to catch it.

Both point at the **same contact point** the in-app alerts use
(`OPERATOR_ALERT_EMAIL`, plain email only — D-04, same discipline as every
watchdog in SPECIFICATION.md §7) — one operator inbox, not a second
parallel paging surface.

## Rule 1: No-logs-received (dead-man's-switch)

| Field | Value |
|---|---|
| **Query** | `sum(count_over_time({service=~".+"}[5m]))` |
| **Condition** | IS BELOW `1` |
| **Evaluation interval** | every `5m` |
| **Pending period (`for`)** | `10m` |
| **Contact point** | operator email (`OPERATOR_ALERT_EMAIL`) |

The query counts every log line across every `service` label value
(`db`, `redis`, `api`, `worker`, `web`, `migrate`, `pgbackrest`, `alloy` —
`scripts/validate-prod-compose.mjs`'s `EXPECTED_SERVICES`) in the trailing
5-minute window. A healthy stack — even one with near-zero user traffic —
still emits Docker healthcheck-driven and periodic-tick log lines from
several of these services every few minutes, so a genuine zero here means
Alloy itself has stopped shipping, not that the platform happened to be
quiet. The 10-minute pending period requires the condition to hold across
two consecutive evaluations before firing, so a single delayed evaluation
cycle (a routine deploy, a brief restart) does not itself trip a false
alarm — the same "don't alert on the first missed tick" reasoning every
in-app watchdog in SPECIFICATION.md §7 already applies to its own staleness
threshold.

## Rule 2: Error-rate-spike

| Field | Value |
|---|---|
| **Query** | `sum(rate({service=~"api\|worker", level=~"50\|60"}[5m])) / sum(rate({service=~"api\|worker"}[5m])) * 100` |
| **Condition** | IS ABOVE `5` (percent) |
| **Evaluation interval** | every `1m` |
| **Pending period (`for`)** | `5m` |
| **Contact point** | operator email (`OPERATOR_ALERT_EMAIL`) |

`level` is a Loki **label** here, not a JSON-body field — `docker/alloy/config.alloy`'s
own `stage.json`/`stage.labels` pipeline promotes pino's numeric log level
(the ONLY body-derived value this pipeline promotes to a label — see that
file's own header) onto every line's label set before it ever reaches
Loki, specifically so this query needs no `| json` parsing stage at all:
`50` is pino's `error` level, `60` is `fatal`. The ratio is scoped to
`api`/`worker` only (`db`/`redis`/`web`/`migrate`/`pgbackrest`/`alloy` do
not run this codebase's Pino loggers, so their `level` label carries
whatever their own log format happens to emit and would only add noise to
this specific ratio). A stack producing zero log lines at all resolves
this query to `0/0` (no data) rather than a false "5% error rate" — that
silent-stack case is exactly what Rule 1 above exists to catch
independently; this rule is not relied on to cover it.

## Correlation query: follow one send across processes

**This is phase success criterion 1's literal check** — an operator should
never have to reconstruct this during an incident:

```logql
{service=~"api|worker"} | json | requestId="<paste-request-id-here>"
```

Paste any `requestId` value captured from a log line or from
`pg_stat_activity.application_name`'s `req=<requestId>` fragment
(`packages/tenant-context/src/index.ts`'s `composeApplicationName`, plan
15-02) into the placeholder above. This returns every log line — across
BOTH `apps/api` (the HTTP request) and `apps/worker` (the BullMQ job that
request enqueued) — carrying that one `requestId`, in time order, letting
an operator trace one send end to end without a second tool.

**Field name note (verified directly against the code, not assumed from
this phase's own research/planning documents):** the correlation field is
camelCase **`requestId`**, matching exactly what
`apps/api/src/logger.ts`/`apps/worker/src/logger.ts`'s shared `mixin()`
(`getCorrelationContext()`, `packages/tenant-context/src/index.ts`) writes
into every JSON log line — NOT the snake_case `request_id` this phase's own
`15-RESEARCH.md` architecture diagram and this plan's own acceptance-grep
assumed. The other three correlation fields follow the same convention:
`jobId`, `sendId`, `workspaceId` (never `job_id`/`send_id`/`workspace_id`).
A query or alert written against the snake_case spelling will silently
match nothing — LogQL's `| json` parser does not fold field name casing.

## Retention window

**14 days**, verified directly against Grafana Cloud's own pricing page
(<https://grafana.com/pricing/>, checked 2026-08-16): the Free tier lists
"14 day retention" for logs specifically (the Pro tier extends this to 30
days). This phase's own `15-RESEARCH.md` did not commit to a specific
figure in advance ("Grafana Cloud specifics: ... log retention window on
the free tier" was listed as an open research question) — this is that
question resolved against the source, not the research document's own
assumption repeated forward.

**What this means for an investigation:** any log line — including the
correlation query above — is only queryable for 14 days after ingestion on
the Free tier. An incident review starting more than two weeks after the
fact cannot use Loki for that window; `sends`/`send_events`/`dead_letter_jobs`
and this codebase's own Postgres-resident evidence (SPECIFICATION.md §4)
remain the durable record beyond that horizon. If the operator upgrades to
a paid tier, this figure changes (30 days on Pro, longer on Enterprise) —
update this section when that happens; do not assume 14 days once billing
changes.

## Recreating both rules

Grafana Cloud → Alerting → Alert rules → New alert rule, one rule per
table above, each pointed at the SAME contact point (Grafana Cloud →
Alerting → Contact points → email pointed at `OPERATOR_ALERT_EMAIL`'s
value). Both rules read from the SAME Loki data source Alloy pushes to
(`GRAFANA_LOKI_PUSH_URL`/`GRAFANA_LOKI_USER` — `docker/prod.env.example`).
`user_setup` (this plan's own frontmatter) names this as the operator step
that provisions both rules; this document is what makes that step
reproducible without re-deriving the queries from scratch.
