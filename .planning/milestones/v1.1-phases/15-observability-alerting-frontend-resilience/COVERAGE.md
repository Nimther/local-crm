# Phase 15 — External API Coverage Matrix

Two external SaaS surfaces are integrated in this phase: **Sentry** (error tracking, three projects — web/api/worker, D-05/D-06) and **Grafana Cloud** (Loki log ingest + alerting backstop, D-01/D-02/D-03). Bull Board and Pino are libraries, not external APIs, and are not enumerated here.

Baseline is full coverage; every `OPT-OUT` row carries its reason.

| capability | decision | reason |
|---|---|---|
| sentry: exception capture (captureException) | INTEGRATE | |
| sentry: unhandled error/rejection capture | INTEGRATE | |
| sentry: React ErrorBoundary render-error capture | INTEGRATE | |
| sentry: Fastify error handler integration | INTEGRATE | |
| sentry: beforeSend / beforeSendTransaction scrub hook | INTEGRATE | |
| sentry: event tags (workspace_id, request_id, job_id, send_id) | INTEGRATE | |
| sentry: environment + release tagging from deployed image SHA | INTEGRATE | |
| sentry: alert rules / issue notifications to operator email | INTEGRATE | |
| sentry: message capture (captureMessage) | OPT-OUT | Not needed — this phase reports exceptions; non-exception signals go to structured logs and the in-app watchdog alerts instead. |
| sentry: breadcrumbs (explicit addBreadcrumb calls) | OPT-OUT | Not needed yet — SDK default automatic breadcrumbs are kept; hand-added breadcrumbs would carry tenant data through a path the scrub fixtures do not cover. |
| sentry: user identification (setUser) | OPT-OUT | Explicitly out of scope — attaching an end user identity contradicts OPS-09's no-PII posture; workspace_id tagging carries the needed context. |
| sentry: performance / distributed tracing | OPT-OUT | Explicitly out of scope per D-07 — sampling misses the individual send being debugged; correlation IDs in structured logs satisfy OPS-12. |
| sentry: session replay | OPT-OUT | Explicitly out of scope per D-08 — records tenant screens (contact emails, segment data) with no tested masking story; deferred. |
| sentry: browser performance tracing | OPT-OUT | Explicitly out of scope per D-08 — becomes interesting only once OPS-16's chunk boundaries need measuring; deferred. |
| sentry: profiling | OPT-OUT | Not needed — no CPU-profiling question in this phase's scope. |
| sentry: cron / check-in monitors | OPT-OUT | Not needed — the dead-man's-switch role is filled by the in-app watchdogs (D-03) plus Grafana's no-logs-received rule. |
| sentry: user feedback widget | OPT-OUT | Not needed — no end-user error-report capability is in OPS-06…19. |
| sentry: event attachments | OPT-OUT | Explicitly out of scope — an attachment is an unscrubbed byte blob, the exact leak channel OPS-09 exists to close. |
| sentry: source map upload (@sentry/vite-plugin) | OPT-OUT | Not needed yet — frontend stack traces are minified but readable enough for this phase; adding it means one more build-time credential. Deferred. |
| grafana-cloud: Loki log ingest (loki.write push) | INTEGRATE | |
| grafana-cloud: Docker container log discovery + tailing (Alloy) | INTEGRATE | |
| grafana-cloud: Loki log query (LogQL by request_id) | INTEGRATE | |
| grafana-cloud: alert rules (no-logs dead-man's switch, error-rate spike) | INTEGRATE | |
| grafana-cloud: contact point / notification policy (email) | INTEGRATE | |
| grafana-cloud: Prometheus metrics remote-write | OPT-OUT | Explicitly out of scope — metrics-first alerting is a recorded Deferred Idea; the four business alerts run as in-app watchdog ticks per D-03. |
| grafana-cloud: Tempo traces ingest | OPT-OUT | Explicitly out of scope — full OpenTelemetry tracing is a recorded Deferred Idea (D-07). |
| grafana-cloud: Pyroscope profiles ingest | OPT-OUT | Not needed — no profiling question in this phase's scope. |
| grafana-cloud: synthetic monitoring / k6 checks | OPT-OUT | Not needed — external uptime probing is not in OPS-06…19. |
| grafana-cloud: OnCall / paging schedules | OPT-OUT | Not needed — single-operator project; D-04 locks email as the only notification channel. |
| grafana-cloud: managed dashboards for app metrics | OPT-OUT | Not needed yet — dashboards depend on the metrics pipeline that is opted out above; log Explore views cover this phase's need. |
| grafana-cloud: Alloy host/system metrics collection | OPT-OUT | Not needed — same metrics-first deferral; Alloy is configured for log shipping only. |
