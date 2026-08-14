# Phase 15: Observability, Alerting & Frontend Resilience - Research

**Researched:** 2026-08-14
**Domain:** Structured logging + log shipping/alerting (Grafana Cloud/Alloy), error tracking with PII redaction (Sentry), request/job/query correlation (ALS extension), BullMQ admin UI exposure (Bull Board over SSH tunnel), and frontend resilience (React error boundaries, TanStack Query error states, route-level code splitting, unsaved-changes guarding)
**Confidence:** HIGH for stack/architecture (every locked decision cross-checked against the actual codebase), MEDIUM for exact library versions/thresholds (npm-verified but training-data package names), LOW for Grafana Cloud free-tier exact operational limits (web-search only)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Log shipping & alerting stack (OPS-10, OPS-13)**
- **D-01:** Hosted log provider = Grafana Cloud (free tier). One provider covers Loki log storage/queries, the alerting engine and dashboards, with room to ingest metrics later. Better Stack and Axiom considered and rejected as weaker on query power / alerting maturity respectively. Reversible.
- **D-02:** Log shipping = Grafana Alloy agent sidecar in the prod compose file. Alloy tails all containers' stdout (docker json-file logs) and pushes to Grafana Cloud Loki. Decoupled from app processes. Per-process pino transports and the Docker Loki log driver explicitly rejected.
- **D-03:** Alert evaluation is hybrid. The four OPS-13 alerts (queue depth, oldest job age, webhook lag, failed-send share) run as in-app watchdog ticks extending the proven `claimAlertSlot`/`OPERATOR_ALERT_EMAIL` stack from Phases 9–13. Grafana Cloud adds the backstop: a dead-man's-switch alert on "no logs received" plus error-rate-spike alerts.
- **D-04:** Notification channel = email only. In-app watchdogs keep sending via `OPERATOR_ALERT_EMAIL`; Grafana Cloud's contact point targets the same address. Telegram/Slack are later additions via Grafana contact points, no code changes.

**Error tracking & tracing (OPS-08, OPS-09, OPS-12)**
- **D-05:** Sentry SaaS, EU region. Free/dev tier covers current volume; EU data residency softens PII exposure; zero ops burden on the VPS. GlitchTip-on-VPS and self-hosted Sentry rejected. The tested `beforeSend` redaction is the actual safety mechanism regardless of hosting. Reversible, but note Pitfall 18: any PII leaked to SaaS before the redaction test gate would be irreversible.
- **D-06:** Three Sentry projects: web / api / worker. Separate DSNs, separate alert rules, release tracking per deployed image. Events tagged with `workspace_id`, `request_id`/`job_id`, `send_id` where in scope.
- **D-07:** OPS-12 is satisfied by correlation IDs in structured logs, not a tracing system. The ALS extension carries `request_id`/`job_id`/`send_id` through HTTP → queue → worker into every log line; `SET LOCAL application_name` (or SQL comment) makes the correlation visible in `pg_stat_activity`; a Loki query by `request_id` follows one send end-to-end. Sentry performance tracing and full OpenTelemetry both explicitly rejected this phase.
- **D-08:** Frontend Sentry captures errors only. Exceptions + ErrorBoundary-caught render errors, tagged with workspace/route. Session Replay stays OFF. Browser tracing off. Reversible — turning replay on later requires a tested masking story first (recorded in Deferred).

**Bull Board access model (OPS-14)**
- **D-09:** Access = SSH tunnel only. Bull Board binds to localhost on the VPS; the operator reaches it via `ssh -L` port forward. Zero public attack surface, no auth code to write or get wrong. Caddy basic-auth and an in-app platform-admin role both rejected.
- **D-10:** Bull Board mounts on the worker's localhost-only health server (Phase 14 D-14) — the worker already registers all ~20 queues, so the board sees exactly what the worker processes, and the port is already localhost-bound by design. If `@bull-board/fastify` requires it, the health server becomes/embeds a small Fastify instance (planner discretion on the exact server shape).

**Frontend resilience UX (OPS-16…OPS-19)**
- **D-11:** Failed API calls present layered: inline + boundary. Each data region (list, chart, detail panel) renders its own inline error state with a Retry button (TanStack Query `isError` + `refetch`); render/unexpected errors are caught by route-level ErrorBoundaries showing a contained error panel — the shell and nav stay alive. Toasts only for action failures (save, delete), never the sole record of a load failure.
- **D-12:** Stale analytics (OPS-18): always-visible timestamp + conditional stale banner. Every analytics view shows "Data as of HH:MM" from the rollup watermark the API already knows; when the watermark lags beyond a threshold, an amber banner appears. Honest in both normal and degraded states.
- **D-13:** Unsaved canvas changes (OPS-19): dirty tracking + router blocker + beforeunload + persistent save-error banner. In-app navigation intercepted by a router blocker dialog (stay / discard); tab close guarded by native `beforeunload`; a failed save shows a persistent inline banner with Retry on the canvas itself (not a transient toast) and the editor stays dirty. Autosave/draft model explicitly rejected.
- **D-14:** Code splitting (OPS-16): lazy-load every feature route. `React.lazy()` for all feature routes in App.tsx behind route-level Suspense skeletons, plus Vite `manualChunks` pinning the heavy vendors (`@xyflow/react`, `recharts`) so canvas/dashboard chunks load only when those routes open. Uniform pattern — no per-route eager/lazy judgment calls to revisit.

### Claude's Discretion

- Grafana Cloud specifics: Loki label/index strategy, log retention window on the free tier, Alloy config shape, dead-man's-switch and error-rate alert rule details.
- Alert thresholds for the four OPS-13 watchdogs (queue depth, oldest job age, webhook lag, failed-send share) — versioned constants with rationale comments, per repo convention.
- Runbook format and location (OPS-15) — one runbook per alert describing recovery, joining Phase 14's deploy/rollback/restore runbooks wherever those live.
- OPS-06 rollout mechanics across the ~20 workers: shared processor-wrapper design (logger child + timing + Sentry capture + re-throw in one helper), replacement order for the 6 raw `console.*` sites, whether `scrubbedConsole` survives as a fallback.
- `request_id` generation/propagation details (Fastify `req.id` vs header echo), exact `application_name` vs SQL-comment choice, job payload `schemaVersion` handling when adding the optional `requestId` field.
- Sentry SDK config details: sample rates (error-only posture), release naming from git SHA, CI sourcemap upload for web, `beforeSend` test fixture design (must include the two roadmap-named scenarios).
- Suspense skeleton design, empty-state copy/design, pagination presentation specifics (OPS-17's pagination handling builds on whatever list pattern exists per feature).
- Bull Board server shape on the worker (embed Fastify vs adapter), read-only vs action-enabled board, tunnel port number + runbook documentation.

### Deferred Ideas (OUT OF SCOPE)

- Full OpenTelemetry tracing (Grafana Tempo) — revisit if correlation-IDs-in-logs proves insufficient for debugging real incidents.
- Sentry Session Replay / browser performance tracing — requires a tested masking story over freeform tenant data first; browser tracing becomes interesting once OPS-16's chunks need measuring.
- Telegram/Slack alert channels — addable later as Grafana contact points (and a small in-app sender) with no architectural change.
- Autosave / draft model for the flow canvas — new capability (draft-vs-published semantics in the flow engine), its own phase if ever.
- Metrics-first alerting (Prometheus /metrics endpoint + Grafana-only alert rules) — the "all alerts in cloud" alternative; revisit at SCALE if the watchdog-tick pattern strains.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-------------------|
| OPS-06 | Worker логирует структурно через Pino | Pattern 1 (pino `mixin()`); Standard Stack (worker gains `pino` 10.3.1 as a new dependency, mirroring `apps/api/src/logger.ts`); Wave 0 test `apps/worker/src/logger.test.ts` |
| OPS-07 | Redaction применяется к логам worker и API единообразно | Pitfall re: deepening `PINO_REDACT_OPTIONS` wildcard depth; Code Examples section shows the exact current-state-to-target-state diff; extends the existing `rules-parity.test.ts` |
| OPS-08 | Sentry принимает исключения frontend, API и worker | Standard Stack (`@sentry/node` for API+worker, `@sentry/react` for web — 3 separate DSNs per D-06); confirmed no separate `@sentry/fastify` package exists |
| OPS-09 | Секреты и PII не попадают в Sentry — подтверждено тестом | Pitfall 3 (Pitfall 18, the phase's highest-priority finding); Code Examples `sentry-scrub.ts` reusing `scrub()`; Wave 0 test `sentry-scrub-fixtures.test.ts` as a required blocking CI check |
| OPS-10 | Логи уходят в hosted-провайдер с настроенными алертами | Architecture diagram (Alloy sidecar → Loki); Pitfall 5 (json-file log rotation); Environment Availability (Grafana Cloud account is an operator prerequisite) |
| OPS-11 | `request_id`, `tenant_id`, `job_id` и `send_id` проходят сквозь HTTP, очередь и worker | Pattern 1 (ALS `mixin()`); Pitfall 6 (Fastify `genReqId` default is per-process, not globally unique) |
| OPS-12 | Trace correlation связывает HTTP-запрос, job и запрос к Postgres | Pattern 4 (`application_name` folded into existing `SET LOCAL`); Architecture diagram shows the full HTTP→queue→Postgres path |
| OPS-13 | Алерты настроены на queue depth, oldest job age, webhook lag и долю неуспешных отправок | Recommended Project Structure (three new watchdog files under `apps/api/src/modules/ops/`); Open Question 2 (shared vs. per-alert dedup storage); Pitfall re: control-flow-error allowlist affecting the failed-send-share denominator |
| OPS-14 | Bull Board доступен под закрытым административным доступом | Pitfall 4 (`Worker[]` vs `Queue[]`); Pitfall re: `fastify` moving from devDependency to dependency; Security Domain (V4 — loopback bind + SSH tunnel as the control) |
| OPS-15 | Runbook'и описывают типовые инциденты и порядок восстановления | Recommended Project Structure lists five new runbook files under `docs/runbooks/`, matching Phase 14's existing runbook location convention |
| OPS-16 | Frontend использует route-level code splitting; canvas/editor и тяжёлые dashboard-компоненты грузятся лениво | Pitfall 2 (Vite 8/Rolldown `manualChunks` object form unsupported) + Pattern 5 (`advancedChunks` alternative) — the single most load-bearing correction to a locked decision's literal wording in this research |
| OPS-17 | Frontend корректно обрабатывает ошибки API, пустые состояния и пагинацию | Don't Hand-Roll (`Sentry.ErrorBoundary` vs. hand-rolled boundary); existing TanStack Query `isError`/`refetch` primitives already in `apps/web` per CONTEXT.md's own code-context notes |
| OPS-18 | Устаревшая аналитика отображается честно | Architectural Responsibility Map (browser renders, API computes the watermark — no new backend contract needed) |
| OPS-19 | Несохранённые изменения canvas вызывают предупреждение; ошибка сохранения видна пользователю | Pitfall 1 (`useBlocker` requires a data router — the single most load-bearing new finding in this research) + Pattern 2 (the minimal-diff migration path) |
</phase_requirements>

## Summary

This phase has 14 requirements but almost no genuinely open design questions — `15-CONTEXT.md` already locked 14 decisions (D-01…D-14) at the discuss-phase stage. This research's job is narrower than usual: verify each locked decision against the **actual code** it attaches to, and surface the mechanical gotchas that will break a plan built on a correct-sounding but stale assumption. Three such gotchas were found that the CONTEXT.md's own decisions do not anticipate:

1. **D-13's router blocker (`useBlocker`) requires a React Router *data router*.** `apps/web/src/App.tsx` currently renders `<BrowserRouter><Routes>...` — the declarative form. `useBlocker` throws `"useBlocker must be used within a data router"` under that setup in every React Router version since the 6.4 data-router work, and `react-router@8.1.0` (this repo's version) has not reverted that requirement. The fix is a small, well-documented migration: wrap the existing JSX route tree in `createRoutesFromElements()`, pass it to `createBrowserRouter()`, and swap `<BrowserRouter>` for `<RouterProvider router={router} />` — the `<Route>` JSX itself does not need to change shape. D-14's route-level `React.lazy()` code splitting is unaffected either way; only D-13 depends on this migration.
2. **`WorkerRuntime.workers` (the array `server.ts` builds) holds BullMQ `Worker` instances, not `Queue` instances.** Bull Board's `BullMQAdapter` wraps a `Queue`, not a `Worker` — the worker process must construct ~20 additional lightweight, read-only `Queue` handles (one per queue name already defined across `apps/worker/src/queues/*`) purely for the board to introspect, and register each through the existing `registerTrackedQueue` shutdown registry (`queue-registry.ts`) so they close cleanly on SIGTERM.
3. **`apps/worker/package.json` declares `fastify` as a `devDependency` only** (used today solely by its own test suite). D-10 says "if `@bull-board/fastify` requires it, the health server becomes/embeds a small Fastify instance" — it does require it, so `fastify` moves to a real `dependency`, and whatever HTTP surface change happens must preserve `health-server.ts`'s exact `/healthz`/`/readyz` response contract (status codes, body shape, `Connection: close`) byte-for-byte, since `docker-compose.prod.yml`'s two container healthchecks and the deploy script's readiness gate both depend on that contract unchanged.

A fourth mechanical trap sits inside the shared BullMQ processor wrapper the roadmap already calls for: BullMQ's own rate-limiting deferral mechanism (Phase 12, `DelayedError`/`job.moveToDelayed`) throws a control-flow error from inside the processor on every legitimate rate-limit defer. If the shared wrapper's Sentry-capture-then-re-throw logic treats every thrown error as a reportable exception, every deferred send floods Sentry and the "share of failed sends" alert (OPS-13) miscounts routine backpressure as failure. The wrapper needs an explicit pass-through allowlist (`DelayedError`, BullMQ's `UnrecoverableError`, and any other intentional control-flow throw) that skips Sentry capture but still re-throws unchanged.

**Primary recommendation:** Implement OPS-06/07 (worker Pino logger + redaction) and OPS-11/12 (ALS + `requestId`/`jobId` extension) first, since every other requirement in this phase — Sentry tagging, Loki correlation queries, the shared BullMQ wrapper — depends on both existing. Then land the Sentry `beforeSend` redaction test (OPS-09) as a **blocking CI check** before any Sentry SDK is initialized against production traffic, per Pitfall 18. Frontend resilience work (OPS-16…19) is independent of the backend observability work and can proceed in parallel once the data-router migration for D-13 is scoped.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Structured worker logging (OPS-06/07) | API/Backend (worker process) | — | Pino instance lives in the worker process itself; mirrors `apps/api/src/logger.ts` exactly |
| Log shipping to Grafana Cloud (OPS-10) | Infrastructure (compose sidecar) | — | Grafana Alloy tails Docker's own `json-file` driver output at the host/container level — no application code ships logs itself |
| Error tracking (OPS-08/09) | Browser + API/Backend (worker + API) | — | Three independent Sentry SDK inits: `@sentry/react` (browser), `@sentry/node` (API), `@sentry/node` (worker) — each is its own trust boundary for PII scrubbing |
| Correlation IDs (OPS-11/12) | API/Backend | Database | ALS extension lives in `packages/tenant-context`; the Postgres-visible half (`application_name`) is a one-line addition to the same `SET LOCAL`/`set_config` call already in `withTenantTransaction` |
| Alerting (OPS-13) | API/Backend (in-app watchdogs) | Infrastructure (Grafana Cloud backstop) | Hybrid per D-03: business-logic alerts stay in the proven `claimAlertSlot` pattern (API process); "is anything alive at all" is Grafana Cloud's job because an API-process alert cannot report the API process being dead |
| Bull Board (OPS-14) | API/Backend (worker process) | — | Mounts on the worker's own health server (already localhost-bound); SSH tunnel is an operator-access concern, not an application-tier one |
| Runbooks (OPS-15) | Docs (no tier) | — | `docs/runbooks/` — same location as Phase 14's deploy/rollback/restore runbooks |
| Code splitting (OPS-16) | Browser | CDN/Static | `React.lazy()` decides chunk boundaries; Vite's build step (Rolldown) and the static-asset host serve the resulting chunk files |
| Frontend error/empty/pagination states (OPS-17) | Browser | API/Backend | TanStack Query `isError`/`refetch` already fetches from the API; this requirement is purely presentational on data the API already returns correctly |
| Stale analytics labelling (OPS-18) | Browser | API/Backend | The rollup watermark timestamp is computed by the API (Phase 13); the frontend's job is to render it honestly, not compute staleness itself |
| Unsaved canvas changes (OPS-19) | Browser | — | Dirty tracking, router blocker, and `beforeunload` are all client-only state; no new API contract |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `pino` | 10.3.1 (already pinned in `apps/api/package.json`) | Structured worker logger | Matches `apps/api`'s existing logger exactly (OPS-06 mirrors OPS-07's established pattern); worker has zero `pino` dependency today — this is a genuinely new runtime dependency for `apps/worker/package.json` |
| `@sentry/node` | 10.70.0 `[VERIFIED: npm registry, verdict SUS — see Package Legitimacy Audit]` | Error tracking for API + worker processes | Sentry's own official Node SDK; ships the Fastify integration helper (`Sentry.setupFastifyErrorHandler`) inside this single package — **there is no separate `@sentry/fastify` npm package** (confirmed 404 on `npm view`) |
| `@sentry/react` | 10.70.0 `[VERIFIED: npm registry, verdict SUS — see Package Legitimacy Audit]` | Error tracking for the frontend, including `Sentry.ErrorBoundary` | Ships its own `ErrorBoundary` React component with built-in Sentry reporting — no separate error-boundary package needed for D-11's route-level boundaries |
| `@bull-board/api` | 8.6.1 `[VERIFIED: npm registry, verdict SUS]` | Bull Board core (queue introspection) | De facto standard BullMQ admin UI; `readOnlyMode: true` recommended per D-09's "no action-enabled board" discretion point |
| `@bull-board/fastify` | 8.6.1 `[VERIFIED: npm registry, verdict SUS]` | Fastify adapter for Bull Board | Requires `apps/worker` to run Fastify as a real HTTP framework — currently only a devDependency there |
| Grafana Alloy (Docker image `grafana/alloy`) | latest stable tag (pin explicit, not `:latest`, per this repo's own GHCR-immutable-tag convention) | Log shipping agent (sidecar in prod compose) | `[CITED: grafana.com/docs/alloy]` — the currently-recommended successor to Promtail/Grafana Agent for exactly this "tail Docker JSON logs → push to Loki" use case |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `react-router` | 8.1.0 (already pinned) | Data-router migration for `useBlocker` | No new dependency — this is a usage-pattern change (`createRoutesFromElements`/`createBrowserRouter`/`RouterProvider`) within the already-installed package |
| `@sentry/vite-plugin` | 5.4.0 `[ASSUMED — not yet cross-checked against legitimacy gate; verify before use]` | CI sourcemap upload for readable frontend stack traces | Only needed if the "CI sourcemap upload for web" discretion point is exercised this phase; otherwise defer — Sentry works without it, just with minified stack traces |
| `nanoid` | 5.1.16 (already an `apps/api` dependency) | `request_id` generation, if not reusing Fastify's own `genReqId` hook | Already imported elsewhere in `apps/api`; no new dependency needed for ID generation regardless of which generator is chosen |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Sentry SaaS EU (D-05, locked) | Self-hosted GlitchTip/Sentry | Rejected in CONTEXT.md already — dies with the VPS it watches / ~16GB multi-service ops burden. Not re-litigated here. |
| Grafana Alloy sidecar (D-02, locked) | Docker's native `loki` logging driver, or per-process pino-loki transports | Rejected in CONTEXT.md already — host-level plugin vs. app-coupled delivery, both explicitly rejected. Not re-litigated here. |
| `@bull-board/fastify` embedding into the worker's health server | A fully separate Fastify process for Bull Board only | Would duplicate readiness-check plumbing and add a second HTTP surface on the VPS; D-10 already locks "mounts on the worker's own health server" |
| `Vite manualChunks` (D-14's literal wording) | Rolldown's native `output.advancedChunks` (groups/`test` regex) | See Pitfall below — Vite 8's default Rolldown bundler does not support the object form of `manualChunks`; the *intent* behind D-14 is honored either by the function form of `manualChunks` (still Rollup-compat-shimmed) or the Rolldown-native `advancedChunks` API |

**Installation:**
```bash
# apps/worker (new deps)
npm install pino@10.3.1 @sentry/node@10.70.0 @bull-board/api@8.6.1 @bull-board/fastify@8.6.1 fastify@5.9.0 -w apps/worker

# apps/api (new deps)
npm install @sentry/node@10.70.0 -w apps/api

# apps/web (new deps)
npm install @sentry/react@10.70.0 -w apps/web
```

**Version verification:** All four package versions above were checked live against the npm registry on 2026-08-14 (`npm view <pkg> version`). Package **names** were recalled from training data, not discovered via an authoritative source this session — per the provenance rule, they are tagged `[ASSUMED]` for the name itself even though the version number is `[VERIFIED: npm registry]`. Re-run `npm view <pkg> version` immediately before installing, since a `too-new` legitimacy verdict on all of them (see audit below) reflects genuinely frequent point releases from actively maintained projects, not registry drift risk.

## Package Legitimacy Audit

| Package | Registry | Age (repo) | Downloads/wk | Source Repo | Verdict | Disposition |
|---------|----------|-----------|--------------|-------------|---------|-------------|
| `@sentry/node` | npm | multi-year (`getsentry/sentry-javascript`) | 31.6M | github.com/getsentry/sentry-javascript | `SUS` (reason: `too-new` — latest *point release* published 2 days before this research) | Kept — see note below |
| `@sentry/react` | npm | multi-year (same monorepo) | 22.5M | github.com/getsentry/sentry-javascript | `SUS` (`too-new`, same reason) | Kept — see note below |
| `@bull-board/api` | npm | multi-year (`felixmosh/bull-board`) | 1.76M | github.com/felixmosh/bull-board | `SUS` (`too-new`, latest release hours before this research) | Kept — see note below |
| `@bull-board/fastify` | npm | multi-year (same repo) | 195.9K | github.com/felixmosh/bull-board | `SUS` (`too-new`, same reason) | Kept — see note below |
| `rate-limiter-flexible` | npm | multi-year (already a runtime dep, unaffected by this phase) | 2.9M | github.com/animir/node-rate-limiter-flexible | `OK` | Already installed, no action |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `@sentry/node`, `@sentry/react`, `@bull-board/api`, `@bull-board/fastify` — all four flagged solely because their *most recent published version* is very new (days old), which is the automated heuristic's `too-new` trigger. In every case the underlying package has a multi-year GitHub history, an actively-maintained first-party repo, and weekly download counts from 195K to 31.6M — signals of a mature, frequently-released project, not a slopsquatted or hallucinated one. **The planner must still add a `checkpoint:human-verify` task before the install step for this batch**, per the Package Legitimacy Gate protocol — do not silently upgrade these to `OK` on the strength of this research's own read of the signals.

*Packages discovered via WebSearch or training data that have not been verified against an authoritative source are tagged `[ASSUMED]` and the planner must gate each install behind a `checkpoint:human-verify` task — this applies to every package name in this document, per the provenance rule, regardless of the version-number verification above.*

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────┐     exception + tags      ┌──────────────────────┐
│   Browser    │ ─────────────────────────▶│  Sentry (web project) │
│ (React SPA)  │                            └──────────────────────┘
│              │  HTTP request (X-Request-Id? or none)
│              │──────────────┐
└──────────────┘              ▼
                    ┌───────────────────────┐
                    │   apps/api (Fastify)   │
                    │  onRequest hook:       │
                    │  - generate/echo       │
                    │    request_id (UUID)   │
                    │  - ALS.run({workspace  │
                    │    Id, requestId})     │
                    └───────────┬────────────┘
                                │ every log line: pino mixin()
                                │ reads ALS store → stamps
                                │ {requestId, workspaceId}
                                ▼
                    ┌───────────────────────┐        exception + tags
                    │  Pino stdout (JSON)    │───┐   (requestId, workspaceId,
                    └───────────┬────────────┘   │    send_id if in scope)
                                │                 ▼
                                │       ┌──────────────────────┐
                                │       │ Sentry (api project)  │
                                │       └──────────────────────┘
                                │
                    BullMQ enqueue: job payload carries
                    optional `requestId` (falls back to job.id
                    for repeatable/webhook-originated jobs)
                                │
                                ▼
                    ┌───────────────────────┐
                    │  apps/worker           │
                    │  shared processor      │
                    │  wrapper:               │
                    │  - ALS.run({workspaceId,│
                    │    jobId, requestId})   │
                    │  - child pino logger    │
                    │  - time the job         │
                    │  - on throw: classify   │
                    │    (control-flow vs     │
                    │    real error) → Sentry │
                    │    capture + RE-THROW   │
                    └───────────┬────────────┘
                                │ every log line stamped
                                │ same way as apps/api
                                ▼
                    ┌───────────────────────┐        exception + tags
                    │  Pino stdout (JSON)    │───┐
                    └───────────┬────────────┘   ▼
                                │       ┌──────────────────────┐
                                │       │ Sentry (worker project)│
                                │       └──────────────────────┘
                                │
                    withTenantTransaction:
                    SET LOCAL application_name = 'requestId=<uuid> jobId=<id>'
                                │
                                ▼
                    ┌───────────────────────┐
                    │  PostgreSQL            │  ← visible in pg_stat_activity
                    │  (send_id already      │    by application_name, joining
                    │   flows through here)  │    the send_id already on `sends`
                    └───────────────────────┘

     ── both host + all containers' stdout (docker json-file) ──
                                │
                                ▼
                    ┌───────────────────────┐
                    │  Grafana Alloy sidecar │  (prod compose only,
                    │  (discovery.docker +   │   never dev)
                    │   loki.source.docker)  │
                    └───────────┬────────────┘
                                │ push
                                ▼
                    ┌───────────────────────┐
                    │  Grafana Cloud (Loki)  │──▶ Loki query by
                    │  + alerting engine     │    `| json | request_id="<uuid>"`
                    └───────────────────────┘    follows ONE send end-to-end

     ── separately, in-app watchdogs (D-03) ──
                    apps/api process ticks (existing claimAlertSlot
                    pattern) query Redis/BullMQ queue depth + oldest
                    job age + `reconciling_since` + failed-send share
                    → OPERATOR_ALERT_EMAIL via platform SendGrid key
                    (same email Grafana Cloud's dead-man's-switch
                    contact point also targets)
```

### Recommended Project Structure

```
apps/worker/src/
├── logger.ts                     # NEW — mirrors apps/api/src/logger.ts exactly
├── sentry.ts                     # NEW — Sentry.init() for the worker project, beforeSend wired to shared redaction
├── processor-wrapper.ts          # NEW — the single shared helper: child logger + timing + Sentry capture (with control-flow allowlist) + re-throw
├── bull-board.ts                 # NEW — constructs ~20 read-only Queue handles, registers with queue-registry, mounts BullMQAdapter
├── health-server.ts              # MODIFIED — becomes/embeds Fastify (D-10); preserves /healthz//readyz contract exactly
└── queues/*.worker.ts            # MODIFIED — every create*Worker call site wraps its processor through processor-wrapper.ts

apps/api/src/
├── logger.ts                     # MODIFIED — deepen PINO_REDACT_OPTIONS wildcard paths (Pitfall 18), add mixin() reading ALS
├── sentry.ts                     # NEW — Sentry.init() for the api project, beforeSend wired to shared redaction, Sentry.setupFastifyErrorHandler(app)
├── server.ts                     # MODIFIED — onRequest hook generates/echoes request_id, wraps route handling in ALS.run
└── modules/ops/
    ├── queue-depth-watchdog.ts    # NEW (OPS-13)
    ├── failed-send-share-watchdog.ts  # NEW (OPS-13) — extends reconciling_since-aware queries from send-reconciler-watchdog.ts
    └── webhook-lag-watchdog.ts    # NEW (OPS-13)

packages/tenant-context/src/
└── index.ts                      # MODIFIED — ALS store type extends {workspaceId} → {workspaceId, requestId?, jobId?}; withTenantTransaction's SET LOCAL gains application_name

packages/redaction/src/
├── rules.ts                      # MODIFIED — REDACTION_RULES gains deeper wildcard depth entries + Sentry-specific scrub targets (properties/payload JSONB)
├── pino-redact.ts                # MODIFIED — wildcard paths deepened beyond *.* (see Pitfall 18 detail below)
└── sentry-scrub.ts               # NEW — beforeSend/beforeSendTransaction hook shared by all three Sentry SDK inits

apps/web/src/
├── lib/sentry.ts                 # NEW — Sentry.init() for the web project (tracing off, replay off per D-08)
├── App.tsx                       # MODIFIED — createRoutesFromElements + createBrowserRouter + RouterProvider (D-13); React.lazy() per route (D-14)
├── components/RouteErrorBoundary.tsx  # NEW — Sentry.ErrorBoundary wrapper with contained fallback panel (D-11)
├── components/StaleDataBanner.tsx     # NEW (OPS-18)
└── features/flows/useUnsavedChangesGuard.ts  # NEW (OPS-19) — useBlocker + beforeunload

docker/
├── docker-compose.prod.yml       # MODIFIED — new `alloy` service (no ports:, per T-14-43 invariant), logging: max-size/max-file on every service
└── alloy/config.alloy            # NEW — discovery.docker + loki.source.docker + loki.write

docs/runbooks/
├── queue-depth-alert.md          # NEW (OPS-15)
├── oldest-job-age-alert.md       # NEW (OPS-15)
├── webhook-lag-alert.md          # NEW (OPS-15)
├── failed-send-share-alert.md    # NEW (OPS-15)
└── bull-board-access.md          # NEW (OPS-14/15) — SSH tunnel instructions
```

### Pattern 1: Pino `mixin()` for zero-parameter-threading correlation stamping

**What:** A pino `mixin` function runs on every single log call and merges its return value into that line's fields — the exact mechanism that satisfies "extend ALS... rather than threading parameters" (D-07/OPS-11).
**When to use:** Both `apps/api/src/logger.ts` and the new `apps/worker/src/logger.ts`.
**Example:**
```typescript
// Source: pino official docs (getting-started.md, "mixin" option) — CITED
import pino from "pino";
import { PINO_REDACT_OPTIONS } from "@mega-crm/redaction";
import { getCorrelationContext } from "@mega-crm/tenant-context"; // new export alongside getWorkspaceId

export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  redact: PINO_REDACT_OPTIONS,
  mixin() {
    const ctx = getCorrelationContext(); // returns {} if no ALS store active (e.g. boot-time logs)
    return ctx;
  },
});
```

### Pattern 2: Data-router migration preserving existing JSX (D-13 prerequisite)

**What:** The minimal-diff path from `<BrowserRouter>` to a data router, required for `useBlocker`.
**When to use:** Once, in `App.tsx`, before implementing OPS-19's router blocker.
**Example:**
```typescript
// Source: reactjs.org / reactrouter.com official docs (createRoutesFromElements, createBrowserRouter) — CITED
import { createBrowserRouter, createRoutesFromElements, Route, RouterProvider } from "react-router";

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route path="/" element={<RootRedirect />} />
    // ...every existing <Route> element, completely unchanged
  )
);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}
```
Then, inside the flow canvas component: `const blocker = useBlocker(({ currentLocation, nextLocation }) => isDirty && currentLocation.pathname !== nextLocation.pathname);`

### Pattern 3: Shared BullMQ processor wrapper with control-flow-error allowlist

**What:** The single helper every `create*Worker` factory routes its processor function through — attaches the child logger, times the job, classifies the thrown error, and always re-throws.
**When to use:** All ~20 worker factories in `apps/worker/src/queues/**`.
**Example:**
```typescript
// Pattern synthesized from BullMQ's own DelayedError/UnrecoverableError docs
// (CITED: docs.bullmq.io) + this repo's existing tenant-deferral.ts helper
import { DelayedError, UnrecoverableError } from "bullmq";
import * as Sentry from "@sentry/node";

const CONTROL_FLOW_ERRORS = [DelayedError, UnrecoverableError];

export function wrapProcessor<T>(
  queueName: string,
  handler: (job: Job<T>) => Promise<unknown>
) {
  return async (job: Job<T>) => {
    const child = logger.child({ queue: queueName, jobId: job.id });
    const start = Date.now();
    try {
      return await withCorrelation({ jobId: job.id, requestId: job.data.requestId }, () =>
        handler(job)
      );
    } catch (err) {
      const isControlFlow = CONTROL_FLOW_ERRORS.some((cls) => err instanceof cls);
      if (!isControlFlow) {
        Sentry.captureException(err, { tags: { queue: queueName, jobId: job.id } });
      }
      child.error({ err, durationMs: Date.now() - start, controlFlow: isControlFlow }, "job failed");
      throw err; // NEVER swallow — BullMQ retry/defer semantics depend on this
    }
  };
}
```

### Pattern 4: `application_name` correlation, folded into the existing `SET LOCAL`

**What:** One additional `set_config` argument in `withTenantTransaction`'s existing statement — no schema change, no new query round trip.
**Example:**
```typescript
// packages/tenant-context/src/index.ts — extends the existing statement
await client.query(
  "SELECT set_config('app.current_workspace_id', $1, true), set_config('application_name', $2, true)",
  [ctx.workspaceId, `req=${ctx.requestId ?? "-"} job=${ctx.jobId ?? "-"}`]
);
```
Note: `application_name` has a hard 63-byte limit in Postgres — a UUID (36 chars) plus the `req=`/`job=` prefixes fits comfortably, but do not append additional fields without checking the budget.

### Pattern 5: Rolldown-native code-splitting boundary (Vite 8)

**What:** D-14 says "Vite `manualChunks`" — Vite 8's default bundler (Rolldown) does not support the *object* form of that option (see Pitfall below). Use the function form (Rollup-compat) or the native `advancedChunks`.
**Example:**
```typescript
// vite.config.ts — Rolldown-native form, CITED: vite.dev/guide/rolldown.html
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: "canvas-vendor", test: /node_modules\/@xyflow\/react/ },
            { name: "charts-vendor", test: /node_modules\/recharts/ },
          ],
        },
      },
    },
  },
});
```

### Anti-Patterns to Avoid

- **A pino-loki transport, or any per-process log-shipping code, inside `apps/api`/`apps/worker`:** D-02 explicitly rejects this — Alloy tails Docker's stdout capture at the infrastructure level so log delivery survives an app crash. Do not add `pino-loki` or any transport target to either logger.
- **Sentry Session Replay or browser performance tracing, even "just to try it":** D-08 turns both off; Session Replay specifically records tenant screens (contact emails, segment data) with no tested masking story yet (Pitfall 18's exact concern, just in a different SDK feature).
- **Treating a `too-new`/`SUS` legitimacy verdict as a blocker for well-known, high-download packages:** the four flagged packages in this phase are legitimate, actively-maintained, high-traffic dependencies — the verdict reflects a fast release cadence, not a hallucination risk. Still route through `checkpoint:human-verify` per protocol; do not silently reclassify to `OK`, and do not skip the checkpoint either.
- **Capturing every thrown error inside the shared BullMQ wrapper to Sentry:** floods Sentry with routine `DelayedError`/rate-limit-defer control flow and corrupts the OPS-13 failed-send-share alert's denominator. See Pattern 3.
- **Loki labels for `request_id`/`job_id`/`send_id`:** high-cardinality values as Loki *labels* (rather than in the log line body, queried with `| json`) blow up Loki's index and are explicitly against Grafana's own labelling guidance `[CITED: grafana.com/docs/loki, "best practices" — series cardinality]`. Keep labels to `service`/`container`/`level`; correlation IDs live in the structured JSON body.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Frontend error boundaries with Sentry reporting | A custom `class ErrorBoundary extends React.Component` plus manual `Sentry.captureException` in `componentDidCatch` | `@sentry/react`'s own `Sentry.ErrorBoundary` component | Handles the catch/report/fallback wiring atomically; a hand-rolled version duplicates logic Sentry already tests |
| BullMQ admin UI | A custom queue-inspection dashboard hitting Redis directly | `@bull-board/api` + `@bull-board/fastify` | De facto standard; hand-rolling reintroduces every BullMQ internal-state edge case (delayed vs. waiting vs. active, retry counts) Bull Board already solves |
| Log shipping with retry/backoff/buffering | A custom stdout-tailer + HTTP-push script | Grafana Alloy | Buffering-during-network-blips, backpressure handling, and multi-source (Postgres/Redis/Caddy logs too) tailing are exactly Alloy's job — a hand-rolled tailer re-solves durability primitives Alloy already has |
| Router navigation blocking for unsaved changes | Manual `history.listen`/`window.onpopstate` interception | React Router's `useBlocker` (once on a data router) | React Router's data-router mode already integrates blocking with its own navigation state machine; a manual listener races against the router's own internal transitions |

**Key insight:** Every "don't hand-roll" item in this phase already has a locked, correct choice in CONTEXT.md — the risk here is not *choosing the wrong tool*, it's implementing the *chosen* tool against a stale assumption about how the surrounding code is wired (declarative vs. data router; `Worker[]` vs. `Queue[]`; devDependency vs. dependency).

## Common Pitfalls

### Pitfall 1: `useBlocker` silently requires a data router
**What goes wrong:** Calling `useBlocker` under the current `<BrowserRouter>`/`<Routes>` setup throws `Error: useBlocker must be used within a data router` — an immediate hard crash of the flow editor route the very first time OPS-19 code renders.
**Why it happens:** React Router's declarative (`<BrowserRouter>`) and data (`createBrowserRouter`) router modes are two different runtime code paths since v6.4; the imperative navigation-blocking API only exists on the data router's internal state machine.
**How to avoid:** Migrate `App.tsx` to `createRoutesFromElements` + `createBrowserRouter` + `RouterProvider` (Pattern 2 above) before writing any `useBlocker` call. Confirmed via web search against `react-router`'s own GitHub issue tracker and migration guide `[CITED: github.com/remix-run/react-router]`.
**Warning signs:** Any `useBlocker`/`unstable_usePrompt` call added to a codebase still rendering `<BrowserRouter>` directly.

### Pitfall 2: Vite 8's Rolldown bundler does not accept the object form of `manualChunks`
**What goes wrong:** A `manualChunks: { "canvas-vendor": ["@xyflow/react"] }` config (the classic Rollup pattern, and the literal words in D-14) either silently no-ops or errors under Rolldown, depending on how it's spread through `rollupOptions`.
**Why it happens:** Vite 8 ships Rolldown as its default production bundler `[CITED: vite.dev/blog/announcing-vite8]`; Rolldown implements Rollup's config *API surface* for compatibility but does not support `manualChunks`'s object shorthand — only the function form, or its own native `advancedChunks`/`groups` option.
**How to avoid:** Use the function form of `manualChunks(id)` (still accepted, Rollup-compat) or migrate directly to `output.advancedChunks` with `groups`/`test` regex entries (Pattern 5 above) — the latter is the forward-compatible, Rolldown-native choice.
**Warning signs:** A production build where the `recharts`/`@xyflow/react` chunk boundary silently does not materialize (check the build's chunk manifest, not just "it built without error").

### Pitfall 3 (Pitfall 18 from PITFALLS.md, phase-locked): Sentry has no retroactive redaction
**What goes wrong:** Any PII or secret that reaches Sentry before the `beforeSend` scrub is tested is permanently in Sentry's storage; the only remedy is deleting the entire project's event history.
**Why it happens:** Sentry's default scrubbing (data-scrubber, PII toggle) covers a fixed list of common patterns and does **not** cover this system's specific secret/PII shapes — a decrypted SendGrid key in scope when `sendTenantMailV3` throws, or a contact's email/phone in a caught error's context.
**How to avoid:** `beforeSend`/`beforeSendTransaction` on all three SDK inits (web/api/worker) must reuse `packages/redaction`'s `REDACTION_RULES`/`scrub()` — not Sentry's own default scrubber alone — and the test suite must throw the two roadmap-named representative payloads (a `sendTenantMailV3` error with the decrypted key in scope; a contact-upsert error with a `Contact` in error context) through the real `beforeSend` function and assert **zero** matches for the plaintext value, before any SDK is initialized against a live DSN.
**Warning signs:** A Sentry SDK `init()` call landing in a PR before the corresponding `beforeSend` fixture test exists and is required-checked in CI.

### Pitfall 4: `Worker[]` is not `Queue[]` — Bull Board needs its own handles
**What goes wrong:** Attempting to pass `runtime.workers` (an array of BullMQ `Worker` instances) directly into `BullMQAdapter` — Bull Board's adapter constructor expects a `Queue`, and `Worker` does not satisfy that interface.
**Why it happens:** `apps/worker/src/server.ts`'s `WorkerRuntime.workers` was built purely for consumer-side job processing and graceful shutdown; it was never meant to double as a producer-side introspection handle.
**How to avoid:** Construct one lightweight `new Queue(name, { connection })` per existing queue name (grep every `create*Worker(...)` call site's underlying queue-name constant), wrap each in `registerTrackedQueue` (the existing shutdown registry), and pass those into `BullMQAdapter`. This is additive — it does not touch the existing `workers` array.
**Warning signs:** A TypeScript error at the Bull Board wiring site ("Worker is not assignable to Queue"), or (if forced past the type error with a cast) a Bull Board UI that shows zero jobs for every queue.

### Pitfall 5: Docker's own `json-file` log driver has no rotation configured in the prod compose file today
**What goes wrong:** Adding Alloy to tail `json-file` logs does not, by itself, bound how large those files grow on the VPS's disk — a busy worker process logging structurally (this phase's own OPS-06 change) can grow a single container's log file unboundedly.
**Why it happens:** `docker-compose.prod.yml` sets no `logging:` block on any of its six services today; Docker's default `json-file` driver has no size cap unless one is configured per-service (or in the daemon's own `/etc/docker/daemon.json`).
**How to avoid:** Add `logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }` (or an equivalent bound) to every service in the same change that adds structured worker logging and the Alloy sidecar — this phase is exactly when log volume will materially increase for the first time.
**Warning signs:** VPS disk-usage alerts (or `df` on the host) climbing steadily after this phase ships, tracing back to `/var/lib/docker/containers/*/*.log`.

### Pitfall 6: Fastify's default `req.id` is a per-process monotonic counter, not a stable correlation ID
**What goes wrong:** Using Fastify's built-in `request.id` unmodified for OPS-11's `request_id` gives every request a small integer that resets to `1` on every process restart — two different deploys, or two API replicas, can log the identical `request_id` for two completely unrelated requests, defeating the entire point of a Loki correlation query.
**Why it happens:** Fastify's default `genReqId` is `req-<incrementing-counter>` scoped to the process lifetime, optimized for local debugging readability, not cross-process uniqueness `[CITED: fastify.io/docs/latest/Reference/Server, "requestIdHeader"/"genReqId"]`.
**How to avoid:** Override `genReqId` in the Fastify server options: `genReqId: (req) => req.headers["x-request-id"] as string ?? crypto.randomUUID()` — this both accepts an upstream-supplied ID (useful behind a future reverse proxy that generates its own) and guarantees global uniqueness when none is supplied. `crypto.randomUUID()` needs no new dependency (Node 22 built-in); `nanoid` (already an `apps/api` dependency) is an equally valid alternative if a shorter ID is preferred.
**Warning signs:** A Loki query for a specific small-integer `request_id` returning log lines from multiple, clearly-unrelated requests.

## Code Examples

### Deepening pino redaction beyond two levels (Pitfall 18's explicit instruction)

```typescript
// packages/redaction/src/pino-redact.ts — CURRENT STATE (verified this session):
// paths enumerated at exactly 3 depths per key: `field`, `*.field`, `*.*.field`.
// Pitfall 18 requires deepening this because JSONB nesting (event `properties`,
// webhook `payload`) is not schema-bounded — a tenant-chosen freeform object can
// nest arbitrarily deep, and fast-redact's wildcard `*` matches exactly ONE
// level per `*` token (no recursive/glob-style "any depth" wildcard exists in
// Pino's redact option -- CITED: getpino.io/#/docs/redaction, "Path is limited").
//
// Practical fix: add one or two more explicit depths (`*.*.*.field`,
// `*.*.*.*.field`) for defense-in-depth, but treat this as a BOUNDED
// improvement, not a full fix — `scrub()` (the value-pattern + unlimited-depth
// walker already in this package) remains the ONLY tool that actually bounds
// freeform JSONB risk. The Sentry `beforeSend` hook and any log line that
// embeds `event.properties` or `send_events.payload` verbatim must route
// through `scrub()`, never rely on the pino path list alone.
export const PINO_REDACT_OPTIONS: { paths: string[]; censor: string } = {
  paths: REDACTION_RULES.keyRules.flatMap((rule) => [
    rule.key,
    `*.${rule.key}`,
    `*.*.${rule.key}`,
    `*.*.*.${rule.key}`,      // NEW — one more level of defense-in-depth
    `*.*.*.*.${rule.key}`,    // NEW
  ]),
  censor: CENSOR,
};
```

### Sentry `beforeSend` reusing the shared `scrub()` (all three SDK inits)

```typescript
// packages/redaction/src/sentry-scrub.ts — NEW
// Source pattern: Sentry official docs (beforeSend signature) — CITED
import * as Sentry from "@sentry/node"; // or @sentry/react for the web init
import { scrub } from "./scrub.js";

export const sentryBeforeSend: Sentry.EventHintOrCaptureContext["beforeSend"] = (event) => {
  return scrub(event) as typeof event; // recursively walks the ENTIRE event body,
  // including extra/context/breadcrumbs — the depth-unbounded tool this
  // package already built for exactly this freeform-payload problem.
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Rollup as Vite's production bundler | Rolldown (Rust-based) as Vite 8's single default bundler | Vite 8.0 (2026) | `manualChunks` object form no longer supported directly — use function form or `advancedChunks` |
| React Router `<Prompt>`/`history.block` for navigation guarding | `useBlocker` on a data router (`createBrowserRouter`) | React Router 6.4+ (data routers), unchanged through 8.x | Any pre-6.4-era navigation-blocking tutorial/snippet found via search is stale for this codebase's `react-router@8.1.0` |
| Promtail as Grafana's log-shipping agent | Grafana Alloy | Promtail entered LTS/maintenance mode; Alloy is the actively-developed successor `[CITED: grafana.com/docs/alloy]` | Do not follow older Promtail-based tutorials for the sidecar config |
| Manual OpenTelemetry span propagation for BullMQ | `bullmq-otel` package (BullMQ 5's own telemetry support, announced 2026) `[ASSUMED — surfaced by web search, not verified against npm]` | 2026 | Not adopted this phase — D-07 explicitly defers full tracing; noted here only so the planner does not mistake this phase's correlation-IDs-in-logs approach for the OTel alternative, which remains a deferred idea |

**Deprecated/outdated:**
- Grafana Promtail: superseded by Alloy for new setups; not used in this phase's design.
- React Router's old imperative `<Prompt>` component (removed pre-v6): irrelevant to `react-router@8.1.0`, but frequently surfaces in stale tutorials — do not follow.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Package names `@sentry/node`, `@sentry/react`, `@bull-board/api`, `@bull-board/fastify`, `grafana/alloy` (Docker image), `@sentry/vite-plugin` are the correct, currently-maintained packages for their stated purposes | Standard Stack, Package Legitimacy Audit | If any name is subtly wrong (e.g., a renamed/forked package), install fails loudly at `npm install` — low blast radius, but still gate behind `checkpoint:human-verify` per protocol |
| A2 | Grafana Cloud's free tier includes 50GB logs / 14-day retention, 10K active metric series, and no explicit alert-rule cap | Standard Stack (D-01 sizing context) | If the free tier's actual limits differ, the "no self-hosted stack, use SaaS free tier" cost assumption behind D-01 could be wrong at scale — verify against `grafana.com/pricing` directly before relying on specific numbers in a plan |
| A3 | `bullmq-otel` exists as BullMQ's first-party telemetry package (announced Jan 2026 per a web search result) | State of the Art table | Irrelevant to this phase's scope (OTel is deferred) — risk is near-zero, included only for the planner's future reference |
| A4 | Rolldown's `advancedChunks`/`groups` API shape shown in Pattern 5 matches the exact config surface in the installed `vite@8.1.3` — verified via web search summary of Vite's own migration guide, not by running a build against this repo | Architecture Patterns, Pitfall 2 | If the exact API shape has since changed, the planner's first local build attempt will surface a Vite config error immediately — low risk, cheap to detect |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **`docker/redis.conf`'s `maxmemory 512mb` sizing — explicitly flagged in that file's own comment as "Phase 15's concern" — is not named in any OPS-06…19 requirement or CONTEXT.md decision.**
   - What we know: The comment in `docker/redis.conf` (found this session) reads that sizing Redis's `maxmemory` against the real production VPS host belongs to Phase 15.
   - What's unclear: Whether this phase's scope silently includes revisiting that number, or whether it was simply mis-tagged and belongs to Phase 14 (already complete) or a future SCALE item.
   - Recommendation: Surface this explicitly to the user/planner as an in-scope-or-out-of-scope call rather than silently adopting or ignoring it — it is cheap to resolve with one sentence in the phase plan's scope note, and expensive to discover as a gap during Phase 15's own verification.

2. **Storage/dedup mechanism for the four new OPS-13 watchdog alerts.**
   - What we know: The existing pattern (`claimAlertSlot`) is a single dedicated row per watchdog (`partition_maintenance_runs.id = 1`, `send_reconciler` equivalent, etc.) with its own `last_alert_sent_at` column, atomically claimed via `UPDATE ... RETURNING`.
   - What's unclear: Whether the four new alerts (queue depth, oldest job age, webhook lag, failed-send share) each get their own dedicated single-row table (matching precedent exactly) or share one new small `ops_alert_state` table keyed by alert name — CONTEXT.md leaves this to "Claude's Discretion."
   - Recommendation: A single `ops_alert_state(alert_name text primary key, last_alert_sent_at timestamptz)` table is lower-migration-overhead than four new dedicated tables and preserves the exact same atomic-claim SQL shape (`UPDATE ... WHERE alert_name = $1 AND (...) RETURNING`) — recommend this as the default unless the planner has a reason to prefer per-alert tables for consistency with the existing three watchdogs' exact shape.

3. **Frontend Sentry DSN delivery mechanism — build-time `VITE_SENTRY_DSN` baked into the GHCR-published web image, vs. runtime injection.**
   - What we know: `apps/web` is built once per deploy SHA into a static bundle served by Caddy (Phase 14's topology) — there is no runtime environment-variable injection point for a static SPA bundle the way `apps/api`/`apps/worker` have via `MEGA_CRM_ENV_FILE`.
   - What's unclear: Whether the DSN should be a `VITE_*` build-time env var (baked into the bundle at `docker build` time, requiring the CI image-build workflow to receive it) or whether a small runtime-config endpoint (`/api/config` returning the DSN) is preferred.
   - Recommendation: A Sentry DSN is **not a secret** by Sentry's own design (it authorizes sending events TO a project, not reading FROM it) — bake it in at build time via a `VITE_SENTRY_DSN` build arg in the CI image workflow. This also means it should NOT be routed through `MEGA_CRM_ENV_FILE` (which exists specifically for genuine secrets) — flag this explicitly in `SPECIFICATION.md` §3 so a future contributor does not "fix" it into the secrets file by habit.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Grafana Cloud account + Loki stack + write token | OPS-10 (log shipping), OPS-13 (dead-man's-switch backstop) | ✗ (operator prerequisite, not yet provisioned per this session's file inspection) | — | None — this is a hard operator-provisioning checkpoint before OPS-10 can be verified end-to-end; the plan must include a `checkpoint:human-verify` for "Grafana Cloud stack created, write token issued, both live in `MEGA_CRM_ENV_FILE`" |
| Sentry SaaS org (EU region) + 3 projects (web/api/worker) + 3 DSNs | OPS-08, OPS-09 | ✗ (operator prerequisite) | — | None — same class of gate; the DSNs must exist before any `Sentry.init()` call is exercised against real traffic, and per Pitfall 18 the redaction test must pass BEFORE that init ever points at a live DSN |
| `check:spec-env-coverage` CI gate (root `package.json` script) | Every new env var this phase introduces (Grafana/Sentry credentials, `VITE_SENTRY_DSN`) | ✓ (script exists in this repo) | — | N/A — not a fallback question; a plan that adds a new env var without a matching `SPECIFICATION.md` §3 entry will fail this gate in CI, so treat "update SPECIFICATION.md §3 in the same change" as a hard requirement, not a nice-to-have |
| `docker/redis.conf` `maxmemory` sizing decision | Possibly this phase (see Open Question 1) | N/A | — | N/A |
| `fastify` as a real dependency of `apps/worker` | OPS-14 (Bull Board mount) | Currently devDependency-only (verified this session) — must move to `dependencies` in `apps/worker/package.json` | 5.9.0 (already used elsewhere in this monorepo, version-pinned) | None needed — this is a `package.json` edit, not a missing tool |

**Missing dependencies with no fallback:**
- Grafana Cloud stack/token and Sentry org/projects/DSNs — both are genuine external SaaS provisioning steps outside this codebase's control; the plan must gate the corresponding tasks behind explicit `checkpoint:human-verify` (or `checkpoint:decision` if the operator needs to choose plan tiers) rather than assuming they already exist.

**Missing dependencies with fallback:**
- None identified — every other dependency this phase needs is either already installed or a straightforward `npm install`.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 (already the project standard across `apps/api`, `apps/worker`, `apps/web`, `packages/*`) |
| Config file | Root `vitest.config.ts` aggregates backend projects; `apps/web` has its own separate config (excluded from the backend aggregate, per that file's own header comment found this session) |
| Quick run command | `npx vitest run --root apps/worker src/logger.test.ts` (per-module, per this repo's existing per-workspace `test` script convention) |
| Full suite command | `npm test` (root script — runs `test` across every workspace via `--workspaces --if-present`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| OPS-06 | Worker logs structurally via Pino, not `console.*` | unit | `vitest run --root apps/worker src/logger.test.ts` | ❌ Wave 0 |
| OPS-07 | Redaction applies uniformly to worker + API logs | unit | `vitest run --root packages/redaction src/__tests__/rules-parity.test.ts` (extend existing parity test) | Existing file to extend, not new |
| OPS-08 | Sentry receives exceptions from all three surfaces | integration | `vitest run --root apps/api src/sentry.test.ts` / worker / web equivalents, asserting `Sentry.captureException` invocation via SDK test transport | ❌ Wave 0 |
| OPS-09 | No PII/secrets reach Sentry — the Pitfall 18 gate | unit, **required CI check** | `vitest run --root packages/redaction src/__tests__/sentry-scrub-fixtures.test.ts` — throws the two roadmap-named representative payloads and asserts the resulting event body contains no plaintext SendGrid key/email/phone | ❌ Wave 0 — this is the single most important new test file in the phase |
| OPS-10 | Logs reach the hosted provider with alerts configured | manual (infra) | No automated command — verified via a real Grafana Cloud query after deploy, documented in a runbook | N/A — infra verification, not unit-testable |
| OPS-11 | `request_id`/`tenant_id`/`job_id`/`send_id` flow through HTTP → queue → worker | integration | `vitest run --root packages/tenant-context src/__tests__/correlation-context.test.ts` | ❌ Wave 0 |
| OPS-12 | Trace correlation links HTTP request, job, and Postgres query | integration | `vitest run --root packages/tenant-context src/__tests__/application-name-correlation.test.ts` — asserts `pg_stat_activity.application_name` reflects the injected IDs against a real test Postgres | ❌ Wave 0 |
| OPS-13 | Alerts on queue depth / oldest job age / webhook lag / failed-send share | unit | `vitest run --root apps/api src/modules/ops/__tests__/{queue-depth,oldest-job-age,webhook-lag,failed-send-share}-watchdog.test.ts` | ❌ Wave 0 (4 new files, mirroring existing watchdog test shape) |
| OPS-14 | Bull Board reachable only behind admin access | integration | `vitest run --root apps/worker src/bull-board.test.ts` — asserts the board listener binds to `127.0.0.1` only, never `0.0.0.0` | ❌ Wave 0 |
| OPS-15 | Runbook exists per alert | manual (docs) | No automated command — a doc-existence check could be scripted (`test -f docs/runbooks/<alert>.md`) if the team wants this in CI | N/A |
| OPS-16 | Route-level code splitting; canvas/dashboard chunks load lazily | integration (build-output assertion) | A Playwright or build-manifest assertion that `dist/assets/*.js` contains a chunk uniquely matching `@xyflow/react` that is NOT present in the initial `index.html` script tags | ❌ Wave 0 |
| OPS-17 | Failed API call / empty list / paginated list show honest state | component/E2E | Existing Playwright suite (`apps/web/e2e/`) extended with new specs per feature area | Existing suite to extend |
| OPS-18 | Stale analytics labelled honestly | component | Vitest + Testing Library component test asserting the banner renders above the configured lag threshold | ❌ Wave 0 |
| OPS-19 | Unsaved canvas changes warn; save errors are visible | E2E | Playwright spec exercising the router-blocker dialog + `beforeunload` (via Playwright's `page.on('dialog')`) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the relevant per-module `vitest run --root <workspace> <file>` command from the table above.
- **Per wave merge:** `npm test` (full aggregate) plus `npm run test:e2e -w apps/web` for the OPS-16…19 wave.
- **Phase gate:** Full suite green before `/gsd-verify-work`, with OPS-09's redaction fixture test additionally wired as a **required, blocking** CI check (per Pitfall 18 and this repo's `tdd_mode: true` / `security_block_on: "high"` config) — not merely part of the aggregate `npm test` run.

### Wave 0 Gaps
- [ ] `apps/worker/src/logger.test.ts` — covers OPS-06
- [ ] `packages/redaction/src/__tests__/sentry-scrub-fixtures.test.ts` — covers OPS-09, the highest-priority new test in this phase
- [ ] `packages/tenant-context/src/__tests__/correlation-context.test.ts` — covers OPS-11
- [ ] `packages/tenant-context/src/__tests__/application-name-correlation.test.ts` — covers OPS-12 (needs a real test Postgres connection, per this repo's existing ephemeral-test-DB convention)
- [ ] Four new watchdog test files under `apps/api/src/modules/ops/__tests__/` — covers OPS-13
- [ ] `apps/worker/src/bull-board.test.ts` — covers OPS-14
- [ ] Build-manifest or Playwright assertion for chunk boundaries — covers OPS-16
- [ ] Component test for the stale-analytics banner — covers OPS-18
- [ ] Playwright spec for the unsaved-changes guard — covers OPS-19
- [ ] Framework install: none needed — Vitest and Playwright are both already installed and configured project-wide.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | This phase adds no new authentication surface |
| V3 Session Management | No | No session-handling change |
| V4 Access Control | Yes | Bull Board (OPS-14): access control is achieved by network topology (loopback-only bind + SSH tunnel, per D-09) rather than an application-layer authz check — document this as the deliberate control, not an omission |
| V5 Input Validation | No (indirectly touched) | No new user-facing input surface; the correlation-ID plumbing (`requestId` field on job payloads) is an internal, schema-versioned addition, not externally-supplied input requiring new validation |
| V6 Cryptography | No | No new cryptographic material — Grafana/Sentry credentials are bearer tokens/DSNs handled via the existing `MEGA_CRM_ENV_FILE` secret-provenance convention, not a KMS-wrapped key like the tenant SendGrid keys |
| V7 Error Handling & Logging | Yes | The entire phase, essentially — structured logging (OPS-06/07), redaction depth (OPS-09/Pitfall 18), and honest frontend error states (OPS-17) are all direct ASVS V7 controls |
| V9 Communications | Yes (partially) | Grafana Alloy's push to Grafana Cloud and both Sentry SDKs' event submission are outbound HTTPS to third-party SaaS — verify Alloy's config uses `https://` Loki push endpoints (not plaintext) and that Sentry SDK defaults (HTTPS-only) are not overridden |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| PII/secret leak into a third-party SaaS error tracker (Sentry) with no way to retroactively delete a specific leaked field | Information Disclosure | `beforeSend`/`beforeSendTransaction` reusing `packages/redaction`'s `scrub()`, tested against representative payloads BEFORE any SDK points at a live DSN (Pitfall 18) — this is the core control this phase exists to build |
| Unauthenticated exposure of an internal admin/ops tool (Bull Board) to the public internet | Elevation of Privilege | Loopback-only bind (`127.0.0.1`) + no `ports:` mapping in `docker-compose.prod.yml` (enforced today by `scripts/validate-prod-compose.mjs`'s CI gate) + SSH tunnel as the only access path (D-09) |
| Docker socket exposure via the Alloy sidecar's own Docker-discovery mechanism | Elevation of Privilege | `discovery.docker` requires mounting `/var/run/docker.sock` into the Alloy container — this is effectively root-equivalent access to the host's container runtime. Document this explicitly as an accepted risk of the chosen shipping mechanism (D-02), scoped to a single trusted sidecar container, not silently mounted without comment |
| Log-injection via a tenant-controlled freeform field (event `properties`, contact name) breaking structured-log parsing or forging a fake log line | Tampering | Pino's JSON-structured output is inherently injection-resistant for the *parser* (a value can't break out of its JSON string), but the SAME freeform field can still carry PII into the log stream unredacted — this is exactly what `scrub()`'s value-pattern rules (not just key-name rules) exist to catch; do not rely on key-based redaction alone for any field whose content is tenant-authored |

## Sources

### Primary (HIGH confidence)
- Direct codebase inspection (this session): `apps/api/src/logger.ts`, `apps/worker/src/server.ts`, `apps/worker/src/health-server.ts`, `apps/worker/src/queues/queue-registry.ts`, `packages/tenant-context/src/index.ts`, `packages/redaction/src/{rules,pino-redact}.ts`, `apps/web/src/App.tsx`, `apps/web/vite.config.ts`, `docker/docker-compose.prod.yml`, `docs/runbooks/production-topology.md`, `apps/api/src/modules/ops/partition-watchdog.ts`, `.planning/config.json`, `vitest.config.ts`, and every `package.json` in `apps/*`.
- `npm view <pkg> version` (2026-08-14) for: `@sentry/node`, `@sentry/react`, `@sentry/browser`, `@bull-board/api`, `@bull-board/fastify`, `@fastify/routes`, `@sentry/vite-plugin`, `rate-limiter-flexible` — direct registry metadata.
- `gsd-tools query package-legitimacy check --ecosystem npm` (2026-08-14) for the same package set — direct legitimacy-seam output (age/downloads/repo/postinstall signals).

### Secondary (MEDIUM confidence)
- [Grafana Alloy: Use Grafana Alloy to send logs to Loki](https://grafana.com/docs/alloy/latest/tutorials/send-logs-to-loki/) — official Grafana docs, WebSearch-summarized.
- [Grafana Alloy: Monitor Docker containers](https://grafana.com/docs/alloy/latest/monitor/monitor-docker-containers/) — official Grafana docs.
- [Sentry: Fastify integration docs](https://docs.sentry.io/platforms/javascript/guides/fastify/configuration/integrations/fastify/) — confirms `Sentry.setupFastifyErrorHandler` lives inside the Node SDK, no separate Fastify package.
- [Sentry: React ErrorBoundary docs](https://docs.sentry.io/platforms/javascript/guides/react/features/error-boundary) — confirms `Sentry.ErrorBoundary` component API.
- [react-router: useBlocker data-router requirement, GitHub issue #9939](https://github.com/remix-run/react-router/issues/9939) and [decisions/0001-use-blocker.md](https://github.com/remix-run/react-router/blob/main/decisions/0001-use-blocker.md) — official repo, confirms the data-router requirement is by design, not a bug.
- [react-router: createRoutesFromElements API docs](https://reactrouter.com/api/utils/createRoutesFromElements) — official docs, confirms the minimal-diff migration path.
- [Vite: Rolldown Integration guide](https://vite.dev/guide/rolldown.html) — official Vite docs, confirms `manualChunks` object-form incompatibility and the `advancedChunks` alternative.
- [Vite 8.0 announcement](https://vite.dev/blog/announcing-vite8) — official Vite blog, confirms Rolldown is the default bundler as of Vite 8.
- [Grafana pricing page](https://grafana.com/pricing/) — official pricing reference for free-tier limits (A2 in Assumptions Log).
- `npm view @sentry/fastify` returning 404 (2026-08-14, this session) — direct negative confirmation that no such package exists.

### Tertiary (LOW confidence)
- WebSearch results on BullMQ+Sentry manual-capture patterns (dev.to/blog aggregator content, cross-checked against Sentry's own `captureException`/`withScope` API shape but not against a first-party BullMQ+Sentry integration doc, because none exists).
- WebSearch results on Grafana Cloud free-tier specific numbers (50GB/14-day retention, 10K series) — aggregator/pricing-comparison sites, not the primary `grafana.com/pricing` page itself; treated as `[ASSUMED]` in the Assumptions Log (A2).
- WebSearch result mentioning `bullmq-otel` (BullMQ's own telemetry package, announced 2026) — single aggregator source, not cross-checked against BullMQ's own changelog; irrelevant to this phase's locked scope regardless.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version number checked live against the npm registry this session; package *names* are training-data-sourced per the provenance rule, hence tagged `[ASSUMED]` for name even where version is `[VERIFIED]`.
- Architecture: HIGH — every architectural claim (ALS shape, worker `Worker[]` vs `Queue[]`, Fastify devDependency status, `application_name` injection point, current React Router mode) was verified by reading the actual source file this session, not inferred from CONTEXT.md's description alone.
- Pitfalls: HIGH for the three code-verified pitfalls (useBlocker/data-router, Worker-vs-Queue, fastify devDependency), MEDIUM for the Vite/Rolldown pitfall (verified via WebSearch summaries of official docs, not by running a build against this exact repo), LOW for Grafana Cloud free-tier numeric specifics (aggregator-sourced).

**Research date:** 2026-08-14
**Valid until:** 30 days for the architectural findings (stable — codebase structure doesn't shift quickly); 7 days for exact package versions (Sentry/Bull Board both ship frequent point releases per the legitimacy audit's own `too-new` signal) — re-verify versions immediately before the install step regardless of this date.
