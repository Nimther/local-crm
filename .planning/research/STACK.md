# Stack Research — v1.1 Production Hardening

**Domain:** Production operational hardening (CI, Docker/VPS deploy, observability, DB lifecycle, backups, test infra, distributed rate limiting) for an existing multi-tenant email marketing platform
**Researched:** 2026-07-27
**Confidence:** HIGH for exact package versions (verified live against npm registry 2026-07-27); MEDIUM for comparative/qualitative claims (hosted-provider pricing shape, "current best practice" framing) — cross-checked against 2-3 independent sources per topic, flagged individually below.

> **Supersedes for v1.1 scope only:** this file replaces the previous (2026-07-03) v1.0 stack research for the topics covered here. The v1.0 core stack (Fastify, Drizzle, BullMQ, React, etc.) remains valid and is **not** re-researched — see `SPECIFICATION.md` §2 for what's actually installed. This file covers only *new* operational capability for milestone v1.1, per the milestone brief's explicit instruction not to re-litigate the existing, validated stack.

---

## 1. CI — GitHub Actions for the npm-workspaces monorepo

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `actions/checkout` | `v5` | Checkout | Current major as of 2026; no reason to pin lower. |
| `actions/setup-node` | `v4` | Node toolchain + built-in npm cache | `cache: 'npm'` keyed off `package-lock.json` is sufficient for this repo size (8 workspaces, ~57k LOC) — do **not** add Turborepo/Nx remote caching, see "What NOT to Use". |
| `eslint` | `10.8.0` | Lint | Verified live via `npm view eslint version`. ESLint has used **flat config exclusively** since v9 (`eslint.config.js`, no `.eslintrc.*`) — this repo has zero existing lint config, so there is no legacy-format migration cost; start flat-config-native. |
| `typescript-eslint` | `8.65.0` | TS-aware ESLint rules (meta-package: parser + plugin + configs) | Verified live. Use the single `typescript-eslint` meta-package (`tseslint.config(...)`) rather than importing `@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` separately — this is the current recommended entry point and keeps versions in lockstep automatically. |
| `@vitest/coverage-v8` | `4.1.10` | Coverage provider for Vitest | Verified live; matches the already-installed `vitest@4.1.9` (root `apps/api`, `apps/worker`, `apps/web` all pin `4.1.9` per SPECIFICATION.md §2) — **must** stay on the same major/minor line as `vitest` itself since coverage is a first-party provider plugin, not an independent tool. |

### What to add and why

**Lint: ESLint (flat config) as the sole linter — do not add Biome or oxlint as a second linter.** Verified findings:
- **Oxlint** (`1.76.0`, live-checked) has become genuinely fast and its type-aware mode (via `tsgo`) now covers 59/61 of typescript-eslint's type-aware rules as of mid-2026, but it ships with ~520 built-in rules and a materially smaller plugin ecosystem than ESLint. This project has zero existing lint config, so there is no "our codebase is slow to lint" pain to solve yet — the standard 2026 guidance for a repo in this position is: **oxlint is worth adopting when lint speed is already a measured CI bottleneck**, which is not this project's problem (91 test files, standard-sized TS monorepo). Adding it now is speculative tooling, not hardening.
- **Biome** (`2.5.5`, live-checked) is a formatter+linter combo; adopting it would mean either replacing ESLint entirely (losing the mature `typescript-eslint` type-aware ruleset and any React/Fastify-specific plugins) or running it *alongside* ESLint for formatting only, which duplicates Prettier's job with no net gain for a project that has no formatter conflict to solve.
- **Recommendation: ESLint 10 flat config + `typescript-eslint` for both `apps/*` and `packages/*`, single root `eslint.config.js` with per-workspace overrides** (React rules only for `apps/web`, Node-only globals for `apps/api`/`apps/worker`/`packages/*`). This is the lowest-risk, highest-ecosystem-coverage choice for a repo that has never had lint before, and it is what the audit's Phase 1 "lint and coverage" gate actually needs — a working gate, not the fastest possible one.
- If lint speed becomes a real CI bottleneck later (unlikely at this codebase size), revisit oxlint as a **pre-pass before ESLint** (oxlint catches obvious issues fast, ESLint still runs for type-aware/plugin rules) — this is the documented safe migration path, not a rip-and-replace.

**Coverage gate enforcement:** `@vitest/coverage-v8` supports `coverage.thresholds` in `vitest.config.ts` (`{ lines, functions, branches, statements }` or per-glob). Set thresholds in each workspace's `vitest.config.ts` (or a shared root config extended per-workspace) and run `vitest run --coverage` in CI — a threshold miss exits non-zero, which is what makes it a CI *gate* rather than just a report. Do not bolt on a separate coverage-enforcement tool (e.g., `nyc`); v8 coverage via Vitest's own provider is sufficient and avoids a second instrumentation pass.

**Workflow shape for this repo (8 workspaces, single repo, no need for path-filtering complexity):**
- One `ci.yml` triggered on PR + push to `master`, jobs: `lint` (root `eslint .`), `typecheck` (root `tsc --build` or per-workspace `tsc --noEmit`), `test` (root `npm test --workspaces --if-present` — already the pattern used by the existing root `test` script — with `postgres:17` and `redis:7` as **GitHub Actions service containers**, matching the versions already pinned in `docker-compose.yml`), `build` (root `npm run build --workspaces --if-present`, already an existing script).
- Do **not** add a Node version matrix (18/20/22) — `package.json` `engines.node: ">=22"` is a hard constraint per CLAUDE.md; testing on Node versions the project doesn't support wastes CI minutes without reducing risk.
- Cache `~/.npm` via `actions/setup-node`'s built-in `cache: 'npm'`, keyed on `package-lock.json` — sufficient for this size; do not hand-roll `actions/cache` for `node_modules` directly (npm's own cache + `npm ci` is simpler and equally fast at this scale).

---

## 2. Docker deployment on a single self-hosted VPS

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `node:22-alpine` (or `node:22-slim`) | Node 22 LTS matching `engines.node` | Base image for all three runtime images (`api`, `web` build stage, `worker`) | Alpine is smaller; use `-slim` (Debian-based) instead only if a native dependency in the tree needs glibc (check `@aws-sdk/client-kms` and `pg` — both are pure-JS/WASM-free at their current versions, so alpine is fine here). |
| `caddy:2` (or `traefik:v3`) | latest stable 2.x / 3.x | Reverse proxy for TLS termination + rolling zero/low-downtime restarts | Neither exists in the repo today (confirmed: `docker-compose.yml` has only `db`/`redis`, no proxy). A reverse proxy is the mechanism that makes "start-first" rolling restarts possible on a single VPS without an orchestrator — see Deployment Pattern below. Caddy is recommended over Traefik for a small team: automatic HTTPS with zero config (just point a domain at it), simpler Caddyfile vs Traefik's more verbose dynamic config, and it's a single static binary image. Traefik is the better choice only if you anticipate needing its Docker-label-based service discovery for many more services later. |

### Multi-stage Dockerfile pattern (three images from one monorepo)

Given `apps/api`, `apps/web`, `apps/worker` share internal `packages/*` via npm workspaces, the standard current pattern is:

1. **Base stage**: `FROM node:22-alpine AS base`, `WORKDIR /app`, copy only `package.json` + `package-lock.json` + every workspace's `package.json` (not full source) first, so `npm ci` is cache-friendly across builds when only source changes.
2. **Deps stage**: `npm ci` (full, including dev deps — needed for the build step).
3. **Build stage**: copy full source, run `npm run build --workspaces --if-present` (already an existing root script), which produces `dist/` in `apps/api`, `apps/worker`, and the Vite `dist/` in `apps/web`.
4. **Prune stage** (the key size lever): `npm prune --omit=dev` **is not sufficient alone** for npm workspaces — it prunes devDependencies but does not remove *other* workspaces' `node_modules` that a given app doesn't need. Use `npm ci --omit=dev --workspace=apps/api --include-workspace-root` (npm ≥9 supports `--workspace` + `--omit=dev` together) in a **fresh stage** copying only the built `dist/` + that workspace's `package.json` + the lockfile, rather than trying to prune an already-installed `node_modules` tree. This produces a materially smaller final image than copying the full monorepo `node_modules` into each of the three final images.
5. **Runtime stage**: `FROM node:22-alpine`, copy the pruned `node_modules` + `dist/` from stage 4, `USER node` (non-root — the official Node images ship a `node` user), `CMD ["node", "dist/server.js"]`.

Three separate final images (`Dockerfile.api`, `Dockerfile.worker`, `Dockerfile.web`) sharing the same base/deps/build stages via Docker's multi-stage `--target` or BuildKit's shared-stage caching is the current standard for this shape of monorepo — avoids three independent `npm ci` runs in CI.

`apps/web` is a **static SPA build** (Vite), not a Node runtime — its "image" should be `nginx:alpine` (or served directly by Caddy as a static file mount) serving the `dist/` output, not a Node process. This matters for the deployment pattern below: `web` doesn't need the zero-downtime restart machinery the same way `api`/`worker` do, since static file swaps are already atomic.

### Migration gate: advisory-lock pattern, not an init container or separate CI job

The audit (§7) flags "no migration gate before app start, not defined whether migration runs as one process." Recommendation, concretely:

- **Do not** run migrations from `predev`-style npm lifecycle hooks in production (that's the current dev-only pattern per SPECIFICATION.md §4.6 — `scripts/migrate-dev.mjs` is explicitly dev-only and neither `api` nor `worker` currently invoke a migrator at start).
- **Do not** add a separate migration-runner npm package (`node-pg-migrate`, `postgres-migrations`, etc.) — this project already has `drizzle-kit@0.31.10` doing SQL-first migrations; adding a second migration tool would fragment the single source of truth the codebase already has (38 sequential migrations in `packages/db/migrations/`, journal-tracked).
- **Recommended pattern**: a dedicated, short-lived "migrate" step in the deploy pipeline (a `docker run --rm <api-image> npm run db:migrate -w packages/db` invocation, run **once**, before the `api`/`worker` containers are (re)started) that first takes a **PostgreSQL advisory lock** (`SELECT pg_advisory_lock($1)` with a fixed application-chosen integer key) before invoking `drizzle-kit migrate`, and releases it (`pg_advisory_unlock`) in a `finally`. This is what protects against the deploy script accidentally being triggered twice concurrently (e.g., a retried CI job), which is the actual risk an "init container" or "run exactly once" requirement is guarding against on a single-VPS (no orchestrator to guarantee a job runs exactly once for you).
- No new npm package is strictly required for this — `pg` (already a dependency of `packages/db` and `packages/tenant-context`) is sufficient to issue the two advisory-lock statements around the existing `npm run db:migrate` call. If a slightly more ergonomic wrapper is wanted, the `advisory-lock` npm package (small, single-purpose) is a reasonable optional add — but it is genuinely optional, not required.
- **Important constraint to document now, not discover later**: advisory locks do not survive PgBouncer's transaction-mode pooling (a lock taken on one pooled connection can be released on a different physical connection, silently breaking the lock). The audit also flags "external connection pool not defined" as a separate gap. **If/when PgBouncer is added** (transaction-mode pooling, as CLAUDE.md's existing stack recommendation already calls for), the migration step must connect **directly to Postgres, bypassing PgBouncer** — a second `DATABASE_URL`-shaped env var pointing at the non-pooled port is the standard fix. Flag this as a phase-planning dependency: PgBouncer introduction and the migration-gate advisory lock must be designed together, not sequentially.

### Deployment: compose-based, not systemd-based

Given `docker-compose.yml` already exists and defines `db`+`redis`, extend it rather than introducing a parallel systemd-unit-per-container scheme — two deployment mechanisms for one VPS is unnecessary complexity. Add `api`, `worker`, `web` (nginx), and a reverse proxy (`caddy`) service to the same compose file (or a `docker-compose.prod.yml` overlay). For the "low-downtime restart" requirement specifically:

- Docker Compose (current CLI, `docker compose`) supports `start-first`-style rolling restarts by starting a new container of a service before stopping the old one, combined with the reverse proxy's health-check-aware routing — Caddy/Traefik only route to a container once its healthcheck passes, so a start-first pattern (new container starts, passes healthcheck, THEN old container is stopped) gives low-downtime restarts without Kubernetes/Swarm. This requires the `/healthz`/`/readyz` endpoints the audit already calls for in scope 7 — they are a **prerequisite** for this deployment pattern, not just an observability nicety.
- **Rollback**: keep the previous image tag (`api:<git-sha-1>`) available on the VPS (don't `docker system prune` images aggressively) — rollback is `docker compose up -d --no-deps api` after retagging/re-pinning the compose file to the previous SHA, then re-running the migration-gate step only if a **down**-migration is needed (expand/contract migration discipline — see Database Lifecycle section — is what makes rollback-without-a-down-migration the common case).

---

## 3. Observability

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@sentry/node` | `10.68.0` | Exception tracking — API + worker | Verified live via npm registry. As of the v8+ SDK line (current major is 10), Fastify integration is **built into `@sentry/node` itself** — there is no separate `@sentry/fastify` package (confirmed: `npm view @sentry/fastify` returns nothing; the correct API is `Sentry.setupFastifyErrorHandler(app)` after registering routes, per Sentry's own Fastify integration docs). |
| `@sentry/react` | `10.68.0` | Exception tracking — `apps/web` | Same major/version line as `@sentry/node` — keep in lockstep across frontend/backend for consistent release-tracking/source-map behavior. |
| `@sentry/opentelemetry` | `10.68.0` | Bridges OpenTelemetry spans into Sentry's tracing product | Needed only if you adopt the OTel trace-correlation setup below and want those traces to *also* show up in Sentry (not just the hosted logs provider). Same version line as `@sentry/node`. |

**No dedicated Sentry↔BullMQ integration package exists** (verified: no `@sentry/bullmq` on npm). Two paths for worker error capture:
1. **Minimum viable (recommended for this milestone)**: wrap each Worker's job processor in a try/catch that calls `Sentry.captureException(err, { extra: { jobId, queueName, tenantId } })` before rethrowing (rethrow is required — BullMQ needs the throw to mark the job failed/retry). This is a few lines per worker, not a new dependency, and directly gives per-job tenant/queue context in Sentry — more useful than a generic auto-instrumentation would provide for this project's multi-tenant debugging needs.
2. **If you also want distributed traces** (SendGrid call ↔ BullMQ job ↔ originating HTTP request), use BullMQ's **native OpenTelemetry telemetry support** (built into BullMQ since v5.71 — this project is already on `5.79.1` per SPECIFICATION.md, so no BullMQ version bump is needed) via the `bullmq-otel` package (`2.0.0`, verified live) passed as the `telemetry` option on `Queue`/`Worker` construction. This automatically propagates trace context from the HTTP request that enqueued a job through to the worker processing it, and (via `@sentry/opentelemetry`) those spans land in Sentry's trace view too.

### Hosted logs/metrics/alerts provider — comparison

| Provider | Pino ingestion | Metrics | Alert rules | Pricing shape (small team) | Verdict |
|---|---|---|---|---|---|
| **Better Stack** (formerly Logtail) | First-party `@logtail/pino` (`0.5.8`, verified live) — a Pino transport, so it plugs directly into the existing `pino`/`pino.transport()` config in `apps/api/src/logger.ts` with **zero code restructuring**, and can be added to `apps/worker` (which today has no structured logger at all — see "Integration point" below) the same way. | Basic uptime/metrics dashboards included; not a full metrics backend (no PromQL-equivalent). | Included — log-based and uptime-based alert rules with Slack/email/PagerDuty out of the box. | Plans from ~$29/mo per public pricing pages; storage-tier based (not per-GB ingest), with hot/cold retention tuning to control cost. | **Recommended.** Best fit for a small team wanting managed simplicity and the least integration work — a Pino `transport` array entry is genuinely all the code change needed. |
| **Axiom** | First-party `@axiomhq/pino` (`1.8.0`, verified live). | Has a metrics/traces product (OTel-native) beyond pure logs. | Included, log-based. | Per-GB ingestion pricing with a large free tier (500GB/mo per public pricing). | Strong alternative if ingest volume is expected to be large and unpredictable (per-GB pricing rewards bursty/low-baseline usage) — reasonable second choice, not wrong, just more moving parts (their OTel-first model is more than this project needs on day one). |
| **Grafana Cloud** | Via `pino-loki` (`3.0.0`, verified live) pushing to managed Loki, or via an OTel Collector. | Full metrics stack (Prometheus-compatible) in the same bill — the strongest metrics story of the four. | Full Grafana alerting (most powerful/flexible of the options). | ~$0.50/GB ingested (2x Axiom's rate) but bundles logs+metrics+traces in one bill; generous free tier (10K series, 50GB logs). | Consider if you specifically want Prometheus-style metrics (e.g., BullMQ queue-depth gauges, per-tenant send-rate histograms) alongside logs in one place — genuinely the better tool for the audit's "queue depth, oldest job age" alerting requirement if you're willing to run/configure an OTel Collector or `prom-client` exporter. More setup than Better Stack for the log side. |
| **Highlight.io** | `@highlight-run/pino` (backend logging package). | Bundles session replay, frontend error monitoring, backend logs/traces as one product. | Included. | Paid plans start ~$150/mo (public pricing), scaling with sessions+errors+logs+traces combined. | **Not recommended for this project.** It's a full-stack observability product (session replay is its core differentiator) — this project already has Sentry for exceptions and doesn't need session replay; paying for it as a Pino log sink is the most expensive option here for a capability the other three provide more cheaply. |

**Recommendation: Better Stack for logs/alerts.** For the audit's specific alerting requirements (queue depth, oldest job age, webhook lag, send failures — all listed in PROJECT.md's target features), these are most naturally exposed as **BullMQ-derived metrics** rather than pure log lines. Two options, not mutually exclusive:
- Emit them as structured Pino log lines on a fixed interval (`{ msg: "queue_depth", queue: "email:triggered", depth, oldestJobAgeMs }`) and set up Better Stack log-based alert rules on them — zero new infra, works with the recommended provider above.
- If/when the team wants proper time-series metrics (not just log-derived alerting), revisit Grafana Cloud for its native metrics story — but that is a bigger lift (Collector or `prom-client` + `/metrics` endpoint) than this milestone's "get basic ops visibility live" goal requires. Don't build this now; the log-line approach is sufficient for MVP-of-hardening.

**Integration point — worker needs a real logger first.** SPECIFICATION.md §7 confirms `apps/worker` currently has **no structured logging at all** (`console.log`/`console.error` only). Before any hosted-logs integration is meaningful for the worker, add `pino` (already `10.3.1` in `apps/api` and `packages/contacts-core` — reuse the same version, don't introduce a second logging library) to `apps/worker`, with the redaction config unified per the audit's §4.8 finding ("worker has no redaction policy"). This is a prerequisite, not optional groundwork — a hosted-logs provider ingesting unstructured `console.log` output gets far less value (no per-tenant/per-job filtering, no redaction) than one ingesting structured Pino JSON.

### OpenTelemetry for Node — minimal setup for trace correlation

| Package | Version | Role |
|---|---|---|
| `@opentelemetry/api` | `1.9.1` | Stable API surface, required by any instrumentation. |
| `@opentelemetry/sdk-node` | `0.221.0` | Node SDK bootstrap (auto-registers context propagation, exporters). |
| `@opentelemetry/instrumentation-fastify` | `0.57.0` | Auto-instruments Fastify HTTP request spans. |
| `@opentelemetry/instrumentation-pg` | `0.73.0` | Auto-instruments `pg` query spans — directly relevant given the project's two-pool `pg.Pool` architecture (`packages/tenant-context`, `packages/db`), gives per-query spans nested under the request span. |
| `@opentelemetry/instrumentation-ioredis` | `0.69.0` | Auto-instruments Redis calls (BullMQ's queue operations, `rate-limiter-flexible`'s Redis calls). |
| `bullmq-otel` | `2.0.0` | BullMQ's own telemetry hook (see Sentry section above) — this is what actually links "HTTP request enqueued job X" → "worker processed job X" spans; the generic `instrumentation-ioredis` package alone does **not** give you job-level correlation, only raw Redis command spans. |
| `@opentelemetry/exporter-trace-otlp-http` | `0.221.0` | Exports spans via OTLP/HTTP — point this at Grafana Cloud's OTLP endpoint (if chosen for metrics) or Sentry's OTLP-compatible ingestion, depending on where you want traces to land. |

**Minimal setup for this stack specifically:** register `sdk-node` with `[getNodeAutoInstrumentations()]` filtered down to just `fastify`, `pg`, `ioredis` (skip the dozens of irrelevant auto-instrumentations, e.g., `graphql`, `mongodb`, that this project doesn't use — reduces startup overhead and noise) in both `apps/api` and `apps/worker` entry points, pass `bullmq-otel`'s `BullMQOtel` instance as the `telemetry` option on every `Queue`/`Worker` construction (all 13 workers listed in SPECIFICATION.md §5.2), and set `correlationId`/`request_id`/`tenant_id`/`job_id`/`send_id` (already an explicit PROJECT.md requirement) as **span attributes**, not just log fields — this is what makes them queryable across the trace view in whichever backend you pick.

**Does it integrate with Sentry? Yes** — `@sentry/opentelemetry` (same version line as `@sentry/node`, verified above) lets Sentry consume the OTel SDK's spans directly, so a single OTel setup can feed both Sentry's trace view and (via the OTLP exporter) a hosted backend, without instrumenting twice. This is the current recommended pattern (Sentry's own SDK is OTel-based internally as of the v8+ line) rather than running two parallel tracing systems.

**Confidence note:** the OTel package version numbers above are HIGH confidence (direct npm registry query, 2026-07-27). The "BullMQ native telemetry since 5.71" claim is MEDIUM confidence — corroborated by BullMQ's own docs site (`docs.bullmq.io/guide/telemetry`) and a 2026 changelog reference, but not independently cross-verified against the BullMQ changelog file itself in this research pass.

---

## 4. PostgreSQL partition automation

**Hard constraint from PROJECT.md**: dedicated partitions exist only through August 2026; this must ship **before 2026-09-01**.

### Recommended path: application-level BullMQ repeatable job (not pg_partman)

This project already has a working, proven pattern for exactly this shape of problem: **4 existing BullMQ repeatable jobs** (`campaign-scheduler`, `flow-reconciliation`, `analytics-reconciliation`, `flow-segment-sweep`, per SPECIFICATION.md §5.1) that tick on a fixed interval and do idempotent, restart-safe scans. A 5th repeatable job — e.g. `partition-maintenance`, ticking daily — that:
1. Queries `pg_catalog` (via `information_schema.tables` or `pg_partition_tree` on Postgres 17, which is already the pinned version per `docker-compose.yml`) for the current set of `events_YYYY_MM` / `send_events_YYYY_MM` partitions,
2. `CREATE TABLE IF NOT EXISTS events_YYYY_MM PARTITION OF events FOR VALUES FROM (...) TO (...)` for the next 3 months (satisfying the audit's "2-3 months ahead" requirement) via raw SQL through the existing `pg` pool,
3. Logs/alerts (via the observability stack above) if the *next* month's partition is ever found missing (monitoring requirement),

...is the **lowest-risk, zero-new-infrastructure option**, and it is explicitly the right fit for this project because:
- It requires **no new Postgres extension and no custom Postgres Docker image** — the official `postgres:17` image (already pinned in `docker-compose.yml`) is untouched.
- It reuses infrastructure (BullMQ, Redis-backed repeatable-job scheduling, the existing `pg` pool) that is already proven, tested, and understood by the team — this is exactly the "don't rewrite, harden" philosophy PROJECT.md states for this milestone.
- It sidesteps the audit's own caveat: *"an extension may or may not be installable on the target VPS Postgres"* — since this is fully self-hosted Docker (the team controls the Postgres image), extensions ARE technically installable, but only by building and maintaining a **custom Postgres image** (`FROM postgres:17` + `apt-get install postgresql-17-partman postgresql-17-cron`), which is new ongoing maintenance surface (image rebuilds on every Postgres patch release) for a problem this project's actual scale (2 partitioned tables, monthly granularity) does not need pg_partman's more elaborate feature set (sub-partitioning, complex retention policies, `partman.part_config` management) to solve.

### Alternative: pg_partman + pg_cron (cover this path since the milestone brief asks for both)

If the team prefers not to hand-roll partition SQL and is willing to maintain a custom Postgres image:
- `pg_partman` automates partition creation *and* retention/detachment via `run_maintenance_proc()`.
- `pg_cron` (also requires `shared_preload_libraries = 'pg_cron'` set at Postgres startup, i.e. a custom image + compose config change) schedules `run_maintenance_proc()` inside the database itself, independent of the application.
- **Tradeoff vs the BullMQ approach**: pg_partman's `partition_data_proc` also directly solves the "move rows out of DEFAULT without a long lock" requirement (see below) with a maintained, tested implementation — that's a genuine advantage. The cost is: a new Postgres image to build/maintain, `shared_preload_libraries` changes requiring a Postgres restart to adopt, and a second scheduling mechanism (`pg_cron`) alongside the BullMQ repeatable-job pattern already used everywhere else in the worker — which the audit's own §11 "Поддерживаемость" section already flags this project for having too many *duplicated* patterns (queue defaults, Redis options, TTLs) across files; introducing a *second, different* scheduling paradigm for one feature adds exactly the kind of inconsistency that section is warning against.

**Recommendation: application-level BullMQ job, primary. pg_partman is a legitimate choice only if the team independently decides they want the extension's data-movement tooling badly enough to accept custom-image maintenance — not required for this milestone's deadline.**

### Moving rows out of the DEFAULT partition without a long table lock

Regardless of which path above is chosen, the technique is the same (confirmed via Crunchy Data's documented pattern and EDB's row-movement writeup, cross-checked, MEDIUM-HIGH confidence):
1. Create the *correct* partition for the DEFAULT-partition rows' actual date range (if it doesn't already exist).
2. Move rows in **small batches** (e.g., a few thousand rows per transaction, by primary key range or `occurred_at` range) via `INSERT INTO events_YYYY_MM SELECT * FROM events_default WHERE occurred_at >= $1 AND occurred_at < $2` followed by `DELETE FROM events_default WHERE ...` **in the same batch's transaction**, committing between batches — this avoids the multi-minute exclusive lock that a single giant move (or a full-table `ATTACH PARTITION` re-validation scan) would take.
3. `pg_partman`'s `partition_data_proc` automates exactly this batching if that path is chosen instead.
- Do **not** attempt to `ATTACH` a partition covering ranges that still have DEFAULT-partition data without first migrating that data out — `ATTACH PARTITION` on a table with a `DEFAULT` partition containing overlapping data requires a full-table scan to validate the constraint, which is the long-lock scenario this whole requirement exists to avoid.

---

## 5. Backups / PITR for self-hosted Postgres

### Recommendation: pgBackRest

| Technology | Note |
|---|---|
| `pgbackrest` | Not an npm package — a system binary (apt/dnf package or built from source) that must be present alongside the `postgres:17` process, either via a custom Postgres image or a sidecar container sharing the `PGDATA`/WAL-archive volume. |

**Why pgBackRest over WAL-G, Barman, or plain `pg_dump` + cron** (cross-checked across 3 independent 2026 comparison sources, MEDIUM-HIGH confidence):
- **vs plain `pg_dump` + cron**: `pg_dump` is a **logical** backup — it gives you daily/nightly snapshots, not point-in-time recovery. The audit explicitly requires PITR ("backup/PITR + restore drill"), which `pg_dump` cannot provide at all (no WAL-based recovery-to-any-point capability). Rule this out immediately for this requirement regardless of team size.
- **vs WAL-G**: WAL-G's strength is being the simplest option when your backup repository lives in cloud object storage (S3-compatible) and you want minimal configuration — genuinely the better choice if the team is *also* comfortable standing up S3-compatible storage (e.g., a Hetzner/Backblaze B2 bucket) as the backup target. For a **single self-hosted VPS**, pgBackRest is more commonly recommended in 2026 sources as "the de facto standard for production PostgreSQL backup" specifically because it supports **local + S3 + Azure + GCS repositories interchangeably**, parallel backup/restore (materially faster restore times, which matters for the audit's "restore drill" requirement), and more mature retention-policy management out of the box.
- **vs Barman**: Barman is comparable in maturity but is more commonly deployed as a *dedicated backup server* pulling from Postgres — for a single-VPS setup where you likely don't want a second server just for backups, pgBackRest's more flexible "runs alongside Postgres, ships to local disk or cloud" model fits better.

**Concrete setup for this project's Docker-on-VPS shape:**
- `pgbackrest` needs to run where it can both read `PGDATA`/WAL files and receive `archive_command` calls from Postgres. The two standard container patterns are: (a) install `pgbackrest` into a **custom Postgres image** (same tradeoff discussion as pg_partman above — if you're already building a custom image for pg_partman, bundling pgbackrest into the same image is a reasonable consolidation), or (b) a **separate `pgbackrest` sidecar container** sharing the Postgres data volume (read access) and a dedicated backup-repository volume — cleaner separation of concerns, doesn't require rebuilding the Postgres image on every backup-tool update.
- Recommend **(b), the sidecar pattern**, specifically because it decouples backup-tool upgrades from Postgres image upgrades, and because `archive_command` in `postgresql.conf` just needs to invoke the `pgbackrest` binary, which works identically whether that binary lives in the same container or a sidecar with a shared volume mount.
- Backup repository target: local disk on the VPS is the minimum viable option but does **not** protect against VPS-level disk failure — for a genuine production posture, ship the repository to off-VPS object storage (S3-compatible; most VPS providers or a cheap third-party bucket). This is a cost/ops tradeoff the team should make explicitly, not a hard requirement of this research.

### Restore-drill automation

Not a library — a **documented, scripted procedure** run on a schedule (e.g., monthly) against a disposable Postgres instance (could reuse the same Docker Compose infra, spun up fresh): `pgbackrest restore` to a scratch data directory, start a throwaway Postgres container against it, run a smoke-test query (row counts on `contacts`/`sends`/`events` matching expectations within tolerance), tear down. This satisfies the audit's "restore drill" requirement as a repeatable, auditable script rather than a one-time manual verification — recommend committing this as a shell script (`scripts/restore-drill.sh`) alongside a runbook doc, consistent with the audit's own call for runbooks in scope 7.

---

## 6. Testing infrastructure

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@testcontainers/postgresql` | `12.0.4` | Isolated, ephemeral Postgres instance per test run/suite | Verified live (part of the `testcontainers` monorepo, all sub-packages share the `12.0.4` version). Directly solves the audit's §10 requirement: "Playwright не входит в стандартный тестовый прогон и может использовать development-базу. E2E должен работать только с отдельной временной БД." — Testcontainers spins up a genuinely isolated Postgres container per test run, eliminating any chance of E2E tests touching the dev database. |
| `@testcontainers/redis` | `12.0.4` | Isolated Redis instance for BullMQ/rate-limiter integration tests | Same rationale — needed for testing the send-dispatch pipeline (BullMQ + `rate-limiter-flexible`, both Redis-backed) without cross-contaminating a shared dev Redis. |
| `testcontainers` | `12.0.4` | Base library both of the above depend on | Peer dependency — install alongside the module-specific packages. |

**Integration point**: this project already has a `apps/api/src/test/db-fixture.ts` (per SPECIFICATION.md §4.6, the only other place `migrate(` is invoked outside dev scripts) and a `TEST_DATABASE_URL`/`TEST_REDIS_URL` pattern in `vitest.config.ts`. Testcontainers **replaces the assumption of an externally-running test Postgres/Redis** (currently, whatever `TEST_DATABASE_URL` points at must already exist and be migrated) with a **provisioned-per-run** container, which is what makes CI runs and local Playwright runs safe by construction rather than by convention. Recommend wiring Testcontainers specifically for: (a) the new isolated Playwright E2E setup (global setup/teardown spins up Postgres+Redis, runs `db:migrate` against them, tears down after), and (b) new migration tests (spin up a bare Postgres container, run all 38 migrations forward, assert schema shape — directly addresses the audit's "нет проверки совместимости... нет migration tests" gap).

### Failure-injection for BullMQ workers and outbound HTTP

| Technology | Version | Purpose | Why fits THIS stack specifically |
|---|---|---|---|
| `undici` (MockAgent) | `8.9.0` (already a transitive dependency of Node 22's built-in `fetch`; install directly for `MockAgent`/`setGlobalDispatcher`) | Mock outbound HTTP calls at the dispatcher level | **This is the correct tool, not `nock`, for this specific codebase.** SPECIFICATION.md §5.5 confirms `packages/delivery-core/src/send-mail.ts` uses a **raw `fetch()`** call to SendGrid — Node 22's global `fetch` is undici-backed. `nock` (already a dev-dependency in `apps/api`, `14.0.16` per SPECIFICATION.md §2.2) intercepts at the `http`/`https` module level and has had documented compatibility gaps with global `fetch()` specifically (multiple open undici/nock GitHub issues on this exact interaction). `undici.MockAgent` + `setGlobalDispatcher(mockAgent)` intercepts at the layer `fetch()` actually goes through, so it reliably simulates SendGrid timeouts (`mockAgent.get(url).intercept({...}).replyWithError(...)` or a delayed reply exceeding the `AbortController` timeout the audit calls for in delivery correctness), 429s (`.reply(429, body, { headers: { 'retry-after': '2' }})` — directly exercises the `Retry-After`/`X-RateLimit-Reset` parsing logic documented in SPECIFICATION.md §5.5), and connection resets. |
| `nock` | `14.0.16` (already installed) | Keep for existing tests only | Don't rip out existing `nock`-based tests, but **new** tests against `send-mail.ts`'s raw-`fetch` call path should use `undici.MockAgent` — this is a "use the right tool for the new surface area" call, not a full migration. Do not add `msw`/`msw-node` as a third HTTP-mocking library; it would duplicate both `nock` and `MockAgent`'s job with no advantage for this project's server-side-only mocking needs (`msw`'s main differentiator — one mock definition shared between browser and Node — doesn't apply here since SendGrid is only ever called from the worker, never the browser). |

**Mid-flight process crash simulation** — not a library, a test pattern. Given SPECIFICATION.md §5.5's documented three-phase send flow (claim transaction → token consume → SendGrid call → result-write transaction), the audit's required crash tests ("падение до отправки, после принятия SendGrid, перед записью результата") are best implemented as: spawn the worker as a real **child process** (Node's `child_process.fork`), inject a controlled delay/kill-signal at each of the three boundaries (via an env-var-gated hook or a `undici.MockAgent` reply-delay long enough to `SIGKILL` the child mid-request), then assert on Postgres state after restart. This is process-level integration testing, not something a library provides — Testcontainers-provisioned Postgres/Redis (above) is what makes this safe to automate in CI without touching real infrastructure.

---

## 7. Distributed rate limiting

### Recommendation: `@fastify/rate-limit` with a Redis store — no new package needed

| Technology | Version | Note |
|---|---|---|
| `@fastify/rate-limit` | `11.1.0` — **already installed** (confirmed in SPECIFICATION.md §2.2) | Currently registered with `{ global: false }` and (per §6.4) applied per-route with in-memory storage — this is the audit's §4.7 finding: "in-memory limiter... at >1 replica, effective limit multiplies by replica count." |

`@fastify/rate-limit` natively supports a shared Redis-backed store via its `redis` option (accepts an `ioredis` client instance). **`ioredis` is already a dependency** of `apps/api` (`5.11.0`, per SPECIFICATION.md §2.2, used for BullMQ). The fix for the audit's distributed-rate-limit finding is: construct one shared `ioredis` client in `apps/api` (or reuse whichever one already backs BullMQ producers there, if connection-pooling constraints allow a shared client — check BullMQ's own guidance on sharing vs dedicating Redis connections first) and pass it as `@fastify/rate-limit`'s `redis` option. **This requires zero new npm packages.**

**Do not use `rate-limiter-flexible` for this.** It is already a dependency (`11.2.0`, `apps/worker` only per SPECIFICATION.md §2.3) and is the correct, already-proven tool for the **per-tenant SendGrid RPS token bucket** inside the worker (a completely different concern — tenant-scoped outbound throttling, not inbound API request throttling). Reusing it for `apps/api`'s inbound rate limiting would mean hand-rolling the Fastify plugin glue (`onRequest` hook, 429 response shape, `Retry-After` header) that `@fastify/rate-limit` already provides out of the box, for no benefit — `@fastify/rate-limit`'s Redis-store support is a first-party, already-integrated fit for exactly this problem. Keep the two libraries doing the two different jobs they're already doing.

---

## 8. Anything else genuinely required

**`pino` in `apps/worker`** (already covered in §3 above, restated here because it's a genuine gap, not padding): the worker has zero structured logging today. This is required groundwork for the hosted-logs provider, for the audit's §4.8 redaction-policy gap, and for correlating `job_id`/`send_id`/`tenant_id` across log lines — it is not optional infrastructure, it's a load-bearing prerequisite for half of the observability scope. No new package: reuse `pino@10.3.1`, already in the monorepo.

**Not recommending, explicitly, and why:**
- **Turborepo/Nx** — this monorepo (8 workspaces) doesn't have a build-time-scaling problem yet; adding a build-orchestration layer now is speculative complexity the audit never asked for.
- **`node-cron` / `node-schedule`** — BullMQ's repeatable jobs already own all scheduling in this codebase (4 existing jobs, a proposed 5th for partitions); introducing a second, non-Redis-backed scheduling mechanism would fragment the "state lives in Redis, survives restarts, dedupes by jobId" guarantee the project already relies on.
- **`node-pg-migrate` or any second migration tool** — `drizzle-kit` already owns this; the gap is a *deploy-process* gap (when/how migrations run), not a tooling gap.
- **Kubernetes-shaped tooling of any kind** (Helm, kustomize, k8s health-check libraries) — explicitly out of scope per the fixed VPS/Docker decision; flagging only to note that some "production hardening" guides default to k8s patterns that do not apply here.
- **A dedicated metrics library (`prom-client`) for this milestone** — covered in §3: start with log-derived alerting via the hosted-logs provider; revisit `prom-client` + Grafana Cloud only if/when the team decides they want real time-series metrics beyond what log-based alert rules give them. Don't build both observability paths in one milestone.

---

## Installation (new packages only — see body for exact placement per workspace)

```bash
# CI / lint (root)
npm install -D eslint@10 typescript-eslint@8

# Coverage (per workspace that already has vitest)
npm install -D @vitest/coverage-v8@4.1.10

# Observability — apps/api
npm install @sentry/node@10 pino@10.3.1
npm install -D undici@8

# Observability — apps/worker (pino currently absent here)
npm install pino@10.3.1 @sentry/node@10
npm install -D undici@8

# Observability — apps/web
npm install @sentry/react@10

# OpenTelemetry (apps/api + apps/worker)
npm install @opentelemetry/api@1.9 @opentelemetry/sdk-node@0.221 \
  @opentelemetry/instrumentation-fastify@0.57 \
  @opentelemetry/instrumentation-pg@0.73 \
  @opentelemetry/instrumentation-ioredis@0.69 \
  @opentelemetry/exporter-trace-otlp-http@0.221 \
  bullmq-otel@2 @sentry/opentelemetry@10

# Hosted logs — pick ONE per the comparison above (Better Stack recommended)
npm install @logtail/pino@0.5.8

# Testing (root or apps/api + apps/web for Playwright E2E)
npm install -D @testcontainers/postgresql@12 @testcontainers/redis@12 testcontainers@12

# Distributed rate limiting — no new package (ioredis + @fastify/rate-limit already present)
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| ESLint 10 flat config + typescript-eslint | oxlint | Once lint speed is a measured CI bottleneck (not the case today); run as a pre-pass before ESLint, don't replace it. |
| ESLint 10 flat config | Biome | If the team also wants to replace Prettier and is willing to lose typescript-eslint's mature type-aware ruleset — not warranted here. |
| Better Stack (Pino transport) for hosted logs | Grafana Cloud | If the team wants native Prometheus-style metrics (queue depth, oldest-job-age as real time series) in the same product as logs — more setup (OTel Collector or `prom-client`), stronger metrics story. |
| Better Stack | Axiom | If ingest volume is large/bursty and per-GB pricing is preferred over storage-tier pricing — comparable integration effort (`@axiomhq/pino`, same pattern). |
| Application-level BullMQ partition job | pg_partman + pg_cron | If the team is already building/maintaining a custom Postgres image (e.g., for pgBackRest) and wants pg_partman's more elaborate retention/data-movement tooling — accept the added extension-maintenance surface deliberately, not by default. |
| pgBackRest (sidecar container) | WAL-G | If the team is committing to S3-compatible object storage as the backup target from day one and wants the simplest possible env-var-driven setup over pgBackRest's more powerful-but-more-configuration approach. |
| undici `MockAgent` for new SendGrid failure-injection tests | `nock` | Keep using `nock` for any existing test that already relies on it (already installed, `14.0.16`) — don't force a migration of passing tests; only use `MockAgent` for new tests targeting the raw-`fetch` code path. |
| `@fastify/rate-limit` + Redis store | `rate-limiter-flexible` for API rate limiting too | Never for this project — keep `rate-limiter-flexible` scoped to the worker's per-tenant SendGrid throttle, its proven existing job. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| Biome or oxlint as ESLint replacement | No existing lint pain to solve; would sacrifice typescript-eslint's mature type-aware rules and broader plugin ecosystem for a speed gain the project doesn't need yet. | ESLint 10 flat config + `typescript-eslint` |
| A second migration tool (`node-pg-migrate`, `postgres-migrations`) | `drizzle-kit` already owns migrations; the actual gap is *when/how* migrations run in deploy, not which tool generates them. | Wrap the existing `drizzle-kit migrate` invocation in a Postgres advisory lock inside the deploy pipeline. |
| `node-cron`/`node-schedule` for partition maintenance | Fragments the "all scheduling lives in BullMQ repeatable jobs, backed by Redis, restart-safe" invariant the project already relies on for 4 other jobs. | A 5th BullMQ repeatable job, same pattern as the existing 4. |
| `nock` for new tests against `send-mail.ts`'s raw `fetch()` call | Documented compatibility gaps between `nock` and Node's undici-backed global `fetch`. | `undici.MockAgent` + `setGlobalDispatcher`. |
| `rate-limiter-flexible` for the API-layer distributed rate limit | Would duplicate `@fastify/rate-limit`'s built-in Redis-store support and Fastify plugin glue for no benefit; also blurs the line between two genuinely different rate-limiting concerns (inbound API vs outbound per-tenant SendGrid). | `@fastify/rate-limit`'s native `redis` option with the already-installed `ioredis` client. |
| Highlight.io as the hosted-logs provider | Full session-replay/frontend-observability product priced (~$150/mo+) for a capability need (Pino JSON log ingestion + alerting) that Better Stack/Axiom/Grafana Cloud serve more cheaply and with less unrelated surface area. | Better Stack (recommended) or Axiom/Grafana Cloud per the tradeoffs above. |
| Kubernetes-oriented tooling (Helm, k8s-native health probes libraries, etc.) | Explicitly contradicts the fixed Docker-on-VPS deployment decision. | Docker Compose overlay + Caddy/Traefik reverse-proxy health-check-gated rolling restarts. |
| Building/maintaining a custom Postgres image purely for pg_partman when the BullMQ-job path solves the same deadline-critical requirement with zero new infrastructure | Adds ongoing image-maintenance surface (rebuild on every Postgres patch) for a 2-table, monthly-granularity partitioning need that doesn't require pg_partman's more elaborate feature set. | Application-level BullMQ repeatable job doing raw `CREATE TABLE ... PARTITION OF`. |
| `pg_dump` + cron as the backup strategy | Logical-only backup; cannot provide point-in-time recovery, which is an explicit audit requirement. | pgBackRest with WAL archiving. |

## Stack Patterns by Variant

**If PgBouncer is added later (per the v1.0 stack research recommendation, still valid):**
- Route the migration-gate advisory-lock connection **around** PgBouncer, direct to Postgres.
- Because advisory locks do not survive transaction-mode connection pooling — a lock acquired on one physical connection can be silently released on a different one, defeating the single-run guarantee the migration gate exists to provide.

**If the team decides they want real time-series metrics (not just log-derived alerts) later:**
- Add `prom-client` + a `/metrics` endpoint on `apps/api`/`apps/worker`, and move the hosted-logs choice toward Grafana Cloud (or run an OTel Collector feeding whichever backend).
- Because Better Stack's metrics story is secondary to its logs product, while Grafana Cloud's is genuinely first-class — don't half-adopt this now, it's a bigger lift than this milestone's scope.

**If the team commits to S3-compatible object storage as the backup target from day one:**
- Use WAL-G instead of pgBackRest.
- Because WAL-G's whole design center is "minimal config, direct-to-object-storage," and that constraint removes pgBackRest's main comparative advantage (flexible local/cloud/hybrid repository support) for this specific case.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| `@vitest/coverage-v8@4.1.10` | `vitest@4.1.9` (already installed) | Keep on the same major.minor line as `vitest` — coverage providers are versioned in lockstep with the test runner, not independently. |
| `bullmq-otel@2.0.0` | `bullmq@5.79.1` (already installed, native telemetry support since `5.71`) | No BullMQ version bump required for this project. |
| `@sentry/node@10.68.0` | `@sentry/react@10.68.0`, `@sentry/opentelemetry@10.68.0` | Keep all `@sentry/*` packages on the same major/minor to avoid cross-package API drift within the v10 line. |
| `@opentelemetry/sdk-node@0.221.0` | `@opentelemetry/instrumentation-{fastify,pg,ioredis}` (all `0.5x`–`0.7x` range, verified compatible via live npm resolution) | The OTel JS ecosystem versions instrumentation packages independently from the SDK core; verify `npm install` resolves without peer-dependency warnings before locking versions in `package.json`, since this ecosystem moves fast. |
| `@testcontainers/postgresql@12.0.4` | `@testcontainers/redis@12.0.4`, `testcontainers@12.0.4` | All three are published from the same monorepo release — always keep in lockstep. |
| `@fastify/rate-limit@11.1.0` (already installed) | `ioredis@5.11.0` (already installed) | No version change needed for either — this is a configuration change (add the `redis` option), not an upgrade. |

## Sources

- npm registry (`npm view <pkg> version`) — direct package metadata, HIGH confidence, verified live 2026-07-27 for: eslint, @eslint/js, typescript-eslint, @typescript-eslint/eslint-plugin, @biomejs/biome, oxlint, @vitest/coverage-v8, @sentry/node, @sentry/react, @sentry/profiling-node, @sentry/opentelemetry, @opentelemetry/{api,sdk-node,instrumentation-fastify,instrumentation-pg,instrumentation-ioredis,exporter-trace-otlp-http,exporter-trace-otlp-proto,sdk-trace-node,sdk-trace-base,context-async-hooks,resources,semantic-conventions,instrumentation-http}, @fastify/rate-limit, @fastify/under-pressure, @fastify/redis, rate-limiter-flexible, @testcontainers/{postgresql,redis}, testcontainers, undici, nock, msw, pino-pretty, pino-loki, @logtail/{pino,node}, @axiomhq/{pino,js}, axiom, node-cron, node-pg-migrate, bullmq (5.81.2 latest — project pins 5.79.1, no action needed), bullmq-otel, dockerode.
- `SPECIFICATION.md` (this repo, as-built 2026-07-15) — authoritative source for what's actually installed today; used throughout to avoid re-recommending existing dependencies and to identify genuine integration points (e.g., worker's missing structured logger, raw-`fetch` SendGrid call, existing repeatable-job pattern).
- [Sentry Fastify integration docs](https://docs.sentry.io/platforms/javascript/guides/fastify/) — MEDIUM-HIGH confidence, first-party Sentry documentation, confirms `setupFastifyErrorHandler` is the current API and no separate `@sentry/fastify` package exists.
- [BullMQ telemetry docs](https://docs.bullmq.io/guide/telemetry/getting-started) and [BullMQ telemetry announcement](https://bullmq.io/news/241104/telemetry-support/) — MEDIUM confidence, first-party BullMQ documentation on native OTel support and the `bullmq-otel` implementation package.
- [Better Stack vs Grafana Cloud comparison](https://betterstack.com/community/comparisons/better-stack-vs-grafana-cloud/), [Axiom vs Grafana Cloud pricing](https://www.matchyoursaas.com/tools/compare/axiom-vs-grafana), [Axiom alternatives 2026 (SigNoz)](https://signoz.io/comparisons/axiom-alternatives/) — MEDIUM confidence, cross-checked across 3 independent comparison sources with converging pricing-shape conclusions; exact current prices should be re-verified against each vendor's live pricing page before committing budget.
- [Oxlint vs ESLint 2026 (Better Stack Community)](https://betterstack.com/community/guides/scaling-nodejs/oxlint-vs-eslint/), [oxc.rs type-aware linting docs](https://oxc.rs/docs/guide/usage/linter/type-aware.html) — MEDIUM-HIGH confidence, cross-checked across multiple 2026 comparison articles converging on "oxlint mature but ESLint remains the safer default for plugin-ecosystem-dependent, security-sensitive codebases."
- [pgBackRest vs Barman vs WAL-G comparison (DBLog)](https://dblog.co.kr/en/posts/postgresql-part-5), [pgBackRest PITR in Docker demo](https://dataegret.com/2025/12/pgbackrest-pitr-in-docker-a-simple-demo/), [pgBackRest vs Barman vs WAL-G 2026 (kunalganglani)](https://www.kunalganglani.com/blog/postgresql-backup-tools-compared) — MEDIUM-HIGH confidence, cross-checked across 3 independent 2026 sources converging on "pgBackRest is the de facto self-hosted standard; WAL-G is simpler if the repository is cloud-object-storage-first."
- [pg_partman + pg_cron automation guide](https://alexandrubagu.github.io/blog/pg-partman-guide.html), [PlanetScale pg_cron/pg_partman_bgw changelog](https://planetscale.com/changelog/postgres-extensions-pg-cron-partman-bgw) — MEDIUM confidence, corroborates the extension pair's mechanics and the `shared_preload_libraries` requirement.
- [Crunchy Data: Postgres Partitioning with a Default Partition](https://www.crunchydata.com/blog/postgres-partitioning-with-a-default-partition), [EDB: Row Movement Across PostgreSQL Partitions](https://www.enterprisedb.com/blog/row-movement-across-postgresql-partitions-made-easy) — MEDIUM-HIGH confidence, first-party vendor engineering blogs on the batched-move technique for evacuating a DEFAULT partition without long locks.
- [undici MockAgent / global fetch interception (Code with Hugo)](https://codewithhugo.com/node-test-native-fetch-intercept-undici/), [nodejs/undici issue #1882: fetch not intercepted by MockAgent under Jest](https://github.com/nodejs/undici/issues/1882) — MEDIUM confidence; the compatibility-gap claim for `nock` vs global `fetch` is corroborated by open upstream GitHub issues rather than a single vendor's marketing claim.
- [Zero-downtime Docker Compose deployments (jmh.me)](https://jmh.me/blog/zero-downtime-docker-compose-deploy), [Zero-downtime deployments with Podman/Docker/Compose (GitHub)](https://github.com/evolutics/zero-downtime-deployments-with-podman-docker-or-docker-compose) — MEDIUM confidence, cross-checked pattern description (start-first + health-check-gated reverse proxy) across 2 independent sources.
- [advisory-lock npm package](https://www.npmjs.com/package/advisory-lock), [node-pg-migrate advisory lock discussion](https://dev.to/axiom_agent/nodejs-database-migrations-in-production-zero-downtime-strategies-that-actually-work-feo) — MEDIUM confidence on the general pattern; the PgBouncer transaction-pooling incompatibility with advisory locks is a well-known Postgres operational fact, independently corroborated (not vendor-specific).

---
*Stack research for: Mega CRM v1.1 Production Hardening*
*Researched: 2026-07-27*
