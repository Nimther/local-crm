# Phase 15: Observability, Alerting & Frontend Resilience - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-14
**Phase:** 15-observability-alerting-frontend-resilience
**Areas discussed:** Log shipping & alerting stack, Error tracking & tracing, Bull Board access model, Frontend resilience UX

---

## Log shipping & alerting stack

**Q1 — Hosted log provider (OPS-10)**

| Option | Description | Selected |
|--------|-------------|----------|
| Grafana Cloud | Free tier: ~50GB logs/mo + Loki queries + full alerting engine + dashboards in one provider; can ingest metrics later | ✓ |
| Better Stack (Logtail) | Simplest setup, built-in alerting; weaker querying/dashboards | |
| Axiom | Very generous free tier, fast queries; younger alerting, no metrics story | |

**Q2 — Log shipping mechanism**

| Option | Description | Selected |
|--------|-------------|----------|
| Grafana Alloy sidecar | Agent container tails all containers' stdout, pushes to Loki; decoupled from app processes, covers Postgres/Redis/Caddy/pgBackRest | ✓ |
| pino transport per process | No extra container but app-coupled delivery, only covers api/worker | |
| Docker Loki log driver | Host-level plugin outside compose; known stdout-blocking failure modes | |

**Q3 — Alert evaluation location (OPS-13)**

| Option | Description | Selected |
|--------|-------------|----------|
| Hybrid: in-app + cloud backstop | Four OPS-13 alerts as in-app watchdog ticks (claimAlertSlot/OPERATOR_ALERT_EMAIL); Grafana dead-man's-switch + error-rate alerts cover process/VPS death | ✓ |
| All alerts in Grafana Cloud | Requires building a Prometheus metrics endpoint + re-expressing DB-derived signals as metrics | |
| All alerts in-app | Cheapest but structurally blind to total-process/VPS death | |

**Q4 — Notification channel**

| Option | Description | Selected |
|--------|-------------|----------|
| Email only | Existing OPERATOR_ALERT_EMAIL + Grafana contact point at the same address; other channels addable later | ✓ |
| Email + Telegram | Better wake-up latency; small Telegram sender needed in-app | |
| Email + Slack | Same shape via Slack webhook | |

---

## Error tracking & tracing

**Q1 — Sentry hosting (OPS-08)**

| Option | Description | Selected |
|--------|-------------|----------|
| Sentry SaaS, EU region | Free/dev tier, EU data residency, zero VPS ops; tested beforeSend is the safety mechanism either way | ✓ |
| GlitchTip on the VPS | Keeps payloads in own boundary but error tracker dies with the VPS it watches | |
| Self-hosted Sentry elsewhere | ~16GB multi-service stack; real ops cost | |

**Q2 — Project layout**

| Option | Description | Selected |
|--------|-------------|----------|
| Three projects: web/api/worker | Separate DSNs, alert rules, release tracking per deployed image | ✓ |
| Two: web + backend | Fewer projects, muddier api/worker routing | |
| One project | Simplest; quota/alert noise shared across apps | |

**Q3 — OPS-12 trace correlation mechanism**

| Option | Description | Selected |
|--------|-------------|----------|
| Correlation IDs in logs | ALS-carried request_id/job_id/send_id in every log line + application_name in pg_stat_activity; Loki query follows a send end-to-end | ✓ |
| Sentry performance tracing | Sampled transactions + custom BullMQ propagation; sampling may miss the send being debugged | |
| Full OpenTelemetry stack | Most complete, but a significant new subsystem this phase | |

**Q4 — Frontend Sentry capture scope**

| Option | Description | Selected |
|--------|-------------|----------|
| Errors only, no replay | Exceptions + ErrorBoundary errors, workspace/route tags; Session Replay OFF (PII channel), browser tracing off | ✓ |
| Errors + Session Replay on-error | Masking must be trusted over freeform tenant data — second redaction surface | |
| Errors + browser tracing | Spends quota on performance data not asked for this phase | |

---

## Bull Board access model

**Q1 — Administrative access enforcement (OPS-14)**

| Option | Description | Selected |
|--------|-------------|----------|
| SSH tunnel only | localhost bind + ssh -L; zero public surface, no auth code, no new credential | ✓ |
| Caddy + basic-auth path | Reachable from anywhere but adds a public admin surface + credential to rotate | |
| Platform-admin role in app | New authz concept for a one-person tool — real scope | |

**Q2 — Mount point**

| Option | Description | Selected |
|--------|-------------|----------|
| Worker health server | Phase 14 D-14 localhost port; worker already registers all ~20 queues | ✓ |
| API app, localhost-only port | Fastify already there but API lacks queue connections; board dies with API | |
| Separate tiny admin service | Cleanest isolation, one more image/deploy unit | |

---

## Frontend resilience UX

**Q1 — Failed API call presentation (OPS-17)**

| Option | Description | Selected |
|--------|-------------|----------|
| Layered: inline + boundary | Inline per-region error + Retry (TanStack Query); route-level ErrorBoundaries keep shell alive; toasts only for action failures | ✓ |
| Route-level boundary only | One failed widget takes down a whole working page | |
| Toast-centric | Dismissed toast leaves an error masquerading as empty state | |

**Q2 — Stale analytics labelling (OPS-18)**

| Option | Description | Selected |
|--------|-------------|----------|
| Timestamp + stale banner | Always "Data as of HH:MM" from rollup watermark + amber banner past threshold | ✓ |
| Banner only when stale | "Fresh" becomes an unsubstantiated implicit claim | |
| Timestamp only | 4-hour lag looks identical to 30 seconds unless the user reads carefully | |

**Q3 — Unsaved canvas changes (OPS-19)**

| Option | Description | Selected |
|--------|-------------|----------|
| Blocker dialog + error banner | Dirty tracking + router blocker + beforeunload; failed save = persistent inline banner with Retry, editor stays dirty | ✓ |
| Autosave drafts | Invents a draft-vs-published model the flow engine doesn't have — own phase | |
| beforeunload only | In-app SPA navigation would still silently discard work | |

**Q4 — Code splitting granularity (OPS-16)**

| Option | Description | Selected |
|--------|-------------|----------|
| Lazy all feature routes | React.lazy() everywhere + Suspense skeletons + manualChunks for @xyflow/react and recharts | ✓ |
| Only heavy routes lazy | Mixed pattern; every new route re-asks eager-or-lazy | |
| Route groups (3-4 chunks) | Manual grouping to maintain | |

---

## Claude's Discretion

- Grafana Cloud/Loki config details, Alloy config shape, dead-man's-switch rule details
- OPS-13 alert threshold values (versioned constants)
- Runbook format/location (OPS-15)
- OPS-06 rollout mechanics across ~20 workers; shared processor-wrapper design
- request_id generation/propagation; application_name vs SQL comment
- Sentry SDK config (sampling, releases, sourcemaps, beforeSend test fixtures)
- Suspense skeletons, empty-state design, pagination presentation specifics
- Bull Board server shape, read-only vs actions, tunnel port

## Deferred Ideas

- Full OpenTelemetry tracing (Tempo)
- Sentry Session Replay / browser tracing (needs tested masking story)
- Telegram/Slack alert channels
- Autosave / draft model for the flow canvas
- Metrics-first alerting (Prometheus endpoint + Grafana-only rules)
