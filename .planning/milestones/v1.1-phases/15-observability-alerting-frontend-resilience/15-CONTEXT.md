# Phase 15: Observability, Alerting & Frontend Resilience - Context

**Gathered:** 2026-08-14
**Status:** Ready for planning

<domain>
## Phase Boundary

The system reports its true state — to an operator through structured logs, correlated traces and alerts, and to a user through honest error, empty and stale states. Covers OPS-06…OPS-19 (см. `.planning/REQUIREMENTS.md`): the worker gets a real Pino logger with the shared redaction (OPS-06/07), Sentry receives exceptions from frontend/API/worker with a *tested* guarantee that no SendGrid key, contact email or freeform JSONB reaches it (OPS-08/09), logs ship to a hosted provider with alerts on queue depth, oldest job age, webhook lag and failed-send share (OPS-10/13), one correlation identifier follows a send from HTTP request through queue job to Postgres query (OPS-11/12), Bull Board sits behind administrative access (OPS-14), runbooks exist per alert (OPS-15), and the frontend gains route-level code splitting plus honest error/empty/pagination/stale/unsaved-changes states (OPS-16…OPS-19).

**Already locked at ROADMAP level (do not re-litigate):**
- **OPS-06 lands before OPS-08/OPS-10/OPS-12** — hosted logs, Sentry and trace correlation are meaningless while the worker logs through `console.*`.
- **OPS-09 (Pitfall 18):** Sentry has no retroactive redaction. `beforeSend`/`beforeSendTransaction` on both API and worker SDKs reuse Phase 10's shared redaction rules (`packages/redaction`) plus explicit scrubbing of `email`, `phone` and the freeform `properties`/`payload` JSONB blobs, **tested against representative payloads before Sentry receives live traffic** — including a thrown error from inside `sendTenantMailV3` with the decrypted key in scope, and a contact-upsert error with a `Contact` in context. Pino redaction deepened beyond two levels with wildcard paths.
- **OPS-11/OPS-12:** extend `packages/tenant-context` AsyncLocalStorage from `{workspaceId}` to also carry `requestId`/`jobId` — no parameter threading. Job payload schemas gain an optional `requestId`; repeatable ticks and webhook-driven jobs fall back to `job.id`. `send_id` already exists end to end — it needs to be *logged*, not created. `SET LOCAL application_name` or a SQL comment exposes correlation in `pg_stat_activity` with no schema change.
- **Sentry + BullMQ:** no first-party integration — wrap all `create*Worker` processors through one shared helper that attaches the child logger, times the job, captures the exception and **re-throws**. Never swallow, or BullMQ retry semantics break.
- **OPS-13:** the "oldest job age" and "webhook lag" alerts query Phase 11's `reconciling_since` directly.
- **OPS-18** pairs with Phase 13's rollup semantics — stale analytics must be labelled stale, not rendered as current.
- Deployment substrate is Phase 14's: single VPS, docker compose, Caddy as sole public entry, images from GHCR, `MEGA_CRM_ENV_FILE` for secrets, worker health server on a localhost port (D-14 there).

</domain>

<decisions>
## Implementation Decisions

### Log shipping & alerting stack (OPS-10, OPS-13)

- **D-01:** **Hosted log provider = Grafana Cloud (free tier).** One provider covers Loki log storage/queries, the alerting engine and dashboards, with room to ingest metrics later. Better Stack and Axiom considered and rejected as weaker on query power / alerting maturity respectively. — **Reversibility:** reversible — logs are transient telemetry; switching providers restarts the log history, not the platform.
- **D-02:** **Log shipping = Grafana Alloy agent sidecar in the prod compose file.** Alloy tails all containers' stdout (docker json-file logs) and pushes to Grafana Cloud Loki. Decoupled from app processes — survives app crashes, captures Postgres/Redis/Caddy/pgBackRest logs too, buffers during network blips. Per-process pino transports and the Docker Loki log driver explicitly rejected (app-coupled delivery; host-level plugin with stdout-blocking failure modes).
- **D-03:** **Alert evaluation is hybrid.** The four OPS-13 alerts (queue depth, oldest job age, webhook lag, failed-send share) run as **in-app watchdog ticks** extending the proven `claimAlertSlot`/`OPERATOR_ALERT_EMAIL` stack from Phases 9–13 — they query Redis/BullMQ and `reconciling_since` directly. **Grafana Cloud adds the backstop**: a dead-man's-switch alert on "no logs received" plus error-rate-spike alerts — covering the case where the VPS or worker itself dies, which in-app alerts structurally cannot report.
- **D-04:** **Notification channel = email only.** In-app watchdogs keep sending via `OPERATOR_ALERT_EMAIL`; Grafana Cloud's contact point targets the same address. Telegram/Slack are later additions via Grafana contact points, no code changes.

### Error tracking & tracing (OPS-08, OPS-09, OPS-12)

- **D-05:** **Sentry SaaS, EU region.** Free/dev tier covers current volume; EU data residency softens PII exposure; zero ops burden on the VPS. GlitchTip-on-VPS rejected (error tracker dying with the VPS it watches); self-hosted Sentry rejected (~16GB multi-service stack). The tested `beforeSend` redaction is the actual safety mechanism regardless of hosting. — **Reversibility:** reversible — DSNs are config; but note Pitfall 18: any PII leaked to SaaS before the redaction test gate would be irreversible, which is why the test lands before live traffic.
- **D-06:** **Three Sentry projects: web / api / worker.** Separate DSNs, separate alert rules, release tracking per deployed image (matches the three-image deploy from Phase 14). Events tagged with `workspace_id`, `request_id`/`job_id`, `send_id` where in scope.
- **D-07:** **OPS-12 is satisfied by correlation IDs in structured logs, not a tracing system.** The ALS extension carries `request_id`/`job_id`/`send_id` through HTTP → queue → worker into every log line; `SET LOCAL application_name` (or SQL comment) makes the correlation visible in `pg_stat_activity`; a Loki query by `request_id` follows one send end-to-end — success criterion 1 verbatim. Sentry performance tracing and full OpenTelemetry both explicitly rejected this phase (sampling misses the send you're debugging; OTel is a new subsystem a 14-requirement phase doesn't need). Sentry events carry the same IDs as tags so an exception links back to its log trail.
- **D-08:** **Frontend Sentry captures errors only.** Exceptions + ErrorBoundary-caught render errors, tagged with workspace/route. Session Replay stays OFF — it records tenant screens (contact emails, segment data) and is exactly the PII channel OPS-09 exists to prevent. Browser tracing off. — **Reversibility:** reversible — turning replay on later requires a tested masking story first (recorded in Deferred).

### Bull Board access model (OPS-14)

- **D-09:** **Access = SSH tunnel only.** Bull Board binds to localhost on the VPS; the operator reaches it via `ssh -L` port forward. Zero public attack surface, no auth code to write or get wrong, no new credential — same trust model as the operator's existing SSH access. Caddy basic-auth and an in-app platform-admin role both rejected (public admin surface / inventing a new authz concept for a one-person tool).
- **D-10:** **Bull Board mounts on the worker's localhost-only health server** (Phase 14 D-14) — the worker already registers all ~20 queues, so the board sees exactly what the worker processes, and the port is already localhost-bound by design. If `@bull-board/fastify` requires it, the health server becomes/embeds a small Fastify instance (planner discretion on the exact server shape).

### Frontend resilience UX (OPS-16…OPS-19)

- **D-11:** **Failed API calls present layered: inline + boundary.** Each data region (list, chart, detail panel) renders its own inline error state with a Retry button (TanStack Query `isError` + `refetch`); render/unexpected errors are caught by route-level ErrorBoundaries showing a contained error panel — the shell and nav stay alive. Toasts only for action failures (save, delete), never the sole record of a load failure. Toast-centric and boundary-only approaches rejected (dismissed toast leaves an error masquerading as an empty state; one failed widget shouldn't kill a working page).
- **D-12:** **Stale analytics (OPS-18): always-visible timestamp + conditional stale banner.** Every analytics view shows "Data as of HH:MM" from the rollup watermark the API already knows; when the watermark lags beyond a threshold, an amber banner appears ("Analytics is delayed — numbers may not include recent activity"). Honest in both normal and degraded states.
- **D-13:** **Unsaved canvas changes (OPS-19): dirty tracking + router blocker + beforeunload + persistent save-error banner.** In-app navigation intercepted by a router blocker dialog (stay / discard); tab close guarded by native `beforeunload`; a failed save shows a persistent inline banner with Retry on the canvas itself (not a transient toast) and the editor stays dirty. **Autosave/draft model explicitly rejected** — it invents a draft-vs-published capability the flow engine doesn't have (deferred, own phase).
- **D-14:** **Code splitting (OPS-16): lazy-load every feature route.** `React.lazy()` for all feature routes in App.tsx behind route-level Suspense skeletons, plus Vite `manualChunks` pinning the heavy vendors (`@xyflow/react`, `recharts`) so canvas/dashboard chunks load only when those routes open. Uniform pattern — no per-route eager/lazy judgment calls to revisit.

### Claude's Discretion

- Grafana Cloud specifics: Loki label/index strategy, log retention window on the free tier, Alloy config shape, dead-man's-switch and error-rate alert rule details.
- Alert thresholds for the four OPS-13 watchdogs (queue depth, oldest job age, webhook lag, failed-send share) — versioned constants with rationale comments, per repo convention.
- Runbook format and location (OPS-15) — one runbook per alert describing recovery, joining Phase 14's deploy/rollback/restore runbooks wherever those live.
- OPS-06 rollout mechanics across the ~20 workers: shared processor-wrapper design (logger child + timing + Sentry capture + re-throw in one helper), replacement order for the 6 raw `console.*` sites, whether `scrubbedConsole` survives as a fallback.
- `request_id` generation/propagation details (Fastify `req.id` vs header echo), exact `application_name` vs SQL-comment choice, job payload `schemaVersion` handling when adding the optional `requestId` field.
- Sentry SDK config details: sample rates (error-only posture), release naming from git SHA, CI sourcemap upload for web, `beforeSend` test fixture design (must include the two roadmap-named scenarios).
- Suspense skeleton design, empty-state copy/design, pagination presentation specifics (OPS-17's pagination handling builds on whatever list pattern exists per feature).
- Bull Board server shape on the worker (embed Fastify vs adapter), read-only vs action-enabled board, tunnel port number + runbook documentation.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and phase boundaries
- `.planning/ROADMAP.md` § Phase 15 — goal, 5 success criteria, sequencing/pitfall notes (OPS-06 first; Pitfall 18 Sentry redaction; ALS extension; shared re-throwing worker wrapper; `reconciling_since` alerts) and § Phase 10 cross-phase notes (SEC-13 shared redaction, SEC-14 single membership resolver as the tagging point)
- `.planning/REQUIREMENTS.md` — OPS-06…OPS-19
- `.planning/research/PITFALLS.md` — Pitfall 18 (Sentry no-retroactive-redaction)

### Redaction & tenant context (the two locked attachment points)
- `packages/redaction/src/index.ts` (+ `rules.ts`, `pino-redact.ts`, `scrub.ts`, `scrubbed-console.ts`) — SEC-13's shared rule set; `PINO_REDACT_OPTIONS` feeds pino, `scrub`/rules feed Sentry `beforeSend`; the single definition both must reuse
- `packages/tenant-context/src/index.ts` — AsyncLocalStorage `{workspaceId}` context that D-07/OPS-11 extends to `requestId`/`jobId`
- `apps/api/src/logger.ts` — existing API pino logger + redaction wiring; the pattern the worker logger mirrors (OPS-06/07); redaction depth deepened here per Pitfall 18

### Worker & queue infrastructure
- `apps/worker/src/server.ts` — `WorkerRuntime` with all ~20 BullMQ workers registered; where the shared processor wrapper applies and where Bull Board + health server live (D-10)
- `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/erasure-scrub.worker.ts`, `apps/worker/src/queues/partition-maintenance.worker.ts` — the remaining raw `console.*` sites OPS-06 replaces
- `apps/api/src/modules/ops/` (dead-letter-watchdog, reputation-watchdog, ingestion-health-watchdog) — the `claimAlertSlot`/`OPERATOR_ALERT_EMAIL` watchdog pattern D-03's four new alerts extend
- Phase 11's `reconciling_since` column — the direct query target for oldest-job-age/webhook-lag alerts (see `.planning/phases/11-delivery-correctness/11-CONTEXT.md`)

### Frontend
- `apps/web/src/App.tsx` — all routes eagerly imported today; D-14's lazy conversion target; no ErrorBoundary exists anywhere yet
- `apps/web/src/features/flows/` — the canvas editor D-13's dirty tracking/blocker instruments
- `apps/web/src/features/dashboard/`, `apps/web/src/features/campaigns/` — analytics views D-12's watermark timestamp/banner lands on (rollup watermark semantics from Phase 13)

### Deployment substrate (Phase 14)
- `.planning/phases/14-deployment-database-durability/14-CONTEXT.md` — prod compose topology (Alloy joins it), worker health server D-14, `MEGA_CRM_ENV_FILE` convention (Grafana/Sentry credentials join it), runbook locations
- `docker-compose.yml` / prod compose file — where the Alloy sidecar container lands

### Documents that MUST be updated in the same change
- `SPECIFICATION.md` — §2 (new deps: Sentry SDKs, @bull-board, worker pino), §3 (Grafana Cloud + Sentry DSN env vars), §5 (watchdog ticks), §6 (Bull Board mount, any new routes), §7 (наблюдаемость — this phase largely *writes* this section) — per the binding rule in `.claude/CLAUDE.md`
- `ARCHITECTURE.md` — observability/correlation model, alerting topology
- Runbooks — one per OPS-13 alert (OPS-15 requires them), Bull Board tunnel access

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`packages/redaction`** (SEC-13, Phase 10) — `REDACTION_RULES`, `PINO_REDACT_OPTIONS`, `scrub`, `scrubbedConsole`: the single rule set both the worker's new pino logger and all three Sentry `beforeSend` hooks consume. Already built for exactly this reuse.
- **`apps/api/src/logger.ts`** — working pino + redaction wiring the worker logger copies.
- **Watchdog stack** (`claimAlertSlot`, `OPERATOR_ALERT_EMAIL`, three existing watchdogs in `apps/api/src/modules/ops/`) — the four OPS-13 alerts are additional consumers of a proven tick + alert-dedup + email pattern.
- **`packages/tenant-context` ALS** — extension point for `requestId`/`jobId` (roadmap-locked), giving every log line and Sentry event its correlation tags without parameter threading.
- **Worker health server** (Phase 14 D-14) — localhost-bound port Bull Board mounts behind.
- **`send_id` end-to-end** — `custom_args.send_id` already flows through SendGrid requests and webhook events; OPS-11 logs it rather than creating anything new.
- **TanStack Query everywhere in `apps/web`** — `isError`/`refetch` primitives D-11's inline error states build on; 72 existing error-handling touchpoints to normalize rather than invent.

### Established Patterns
- Versioned constants with rationale comments — alert thresholds, staleness threshold, watermark lag window all follow it.
- Fail-closed posture — the Sentry redaction test gate before live traffic is the same discipline as Phase 14's readiness-by-construction.
- Single-definition moves (`queue-core` Redis options, Phase 14's `createPgPool`) — the shared worker processor wrapper is the same move for job instrumentation.
- Phase-branch → PR with blocking CI — the OPS-09 redaction test joins the required checks.

### Integration Points
- `apps/worker`: new pino logger module, shared processor wrapper around all `create*Worker` sites, Sentry SDK init, Bull Board + health server, four watchdog ticks (or API-side ticks — planner decides placement per existing watchdog precedent).
- `apps/api`: ALS/request_id wiring (onRequest hook), Sentry SDK init, deepened pino redaction, `application_name`/SQL-comment correlation in the pg layer (`packages/db` / `packages/tenant-context`).
- `apps/web`: Sentry init + ErrorBoundaries, `React.lazy` route conversion + Suspense skeletons, Vite `manualChunks`, stale-analytics banner, canvas dirty tracking + blocker.
- Prod compose (Phase 14): Alloy sidecar container + Grafana/Sentry credentials in `MEGA_CRM_ENV_FILE`.
- Job payload schemas (`packages/shared-schemas` or queue-core equivalents): optional `requestId` field, respecting the `schemaVersion` deploy-safety contract from Phase 11.

</code_context>

<specifics>
## Specific Ideas

- **"The thing that alerts cannot report its own death"** — the reason D-03 is hybrid: in-app watchdogs own the four business alerts, Grafana Cloud's dead-man's-switch owns "the VPS went dark".
- **Session Replay is a PII channel, not a debugging feature** — rejected outright under OPS-09's posture; any future enablement needs a tested masking story first.
- **A dismissed toast must never be the only record of a failure** — load failures live inline in the region that failed, with Retry.
- **Autosave is not resilience** — the user explicitly kept OPS-19 as honest warnings + visible save errors, not a new draft model.

</specifics>

<deferred>
## Deferred Ideas

- **Full OpenTelemetry tracing (Grafana Tempo)** — revisit if correlation-IDs-in-logs proves insufficient for debugging real incidents.
- **Sentry Session Replay / browser performance tracing** — requires a tested masking story over freeform tenant data first; browser tracing becomes interesting once OPS-16's chunks need measuring.
- **Telegram/Slack alert channels** — addable later as Grafana contact points (and a small in-app sender) with no architectural change.
- **Autosave / draft model for the flow canvas** — new capability (draft-vs-published semantics in the flow engine), its own phase if ever.
- **Metrics-first alerting (Prometheus /metrics endpoint + Grafana-only alert rules)** — the "all alerts in cloud" alternative; revisit at SCALE if the watchdog-tick pattern strains.

</deferred>

---

*Phase: 15-observability-alerting-frontend-resilience*
*Context gathered: 2026-08-14*
