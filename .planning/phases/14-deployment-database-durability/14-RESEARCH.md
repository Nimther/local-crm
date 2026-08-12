# Phase 14: Deployment & Database Durability - Research

**Researched:** 2026-08-12
**Domain:** VPS deployment topology (Docker Compose + Caddy + GHCR), exactly-once migration gating, Postgres backup/PITR (pgBackRest), retention, TLS, connection pooling
**Confidence:** MEDIUM (stack choices are already locked in 14-CONTEXT.md at HIGH confidence; the gaps this document closes — journal-parity of `drizzle-orm migrate()`, exact Compose/Caddy/pgBackRest mechanics, and the DB-12 constraint inventory — are MEDIUM/HIGH per-claim, tagged individually below)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions (do not re-litigate)

**Phase Boundary:** The platform can be deployed, rolled back and restored — and the database survives migrations, disasters and the passage of time. Covers OPS-01…OPS-05 and DB-05…DB-07, DB-09…DB-14: Dockerfiles for `api`/`web`/`worker`, one reproducible deploy command to the VPS with a documented rollback, `/healthz` + `/readyz` (readiness gates on Postgres, Redis AND completed migrations), exactly-once gated migrations that survive an unclean death, a rehearsed rollback/roll-forward procedure, automated backups with PITR and an actually-performed restore drill, defined and applied retention, the missing constraints added after data verification, Postgres TLS, and pooling with error handlers on every pool.

**Already locked at ROADMAP level:**
- OPS-04/OPS-05 land before OPS-02. Deployment automation gates on `/readyz`, never a timer.
- DB-05 (Pitfall 16): `pg_try_advisory_lock` bounded retry loop, loud failure path, never blocking `pg_advisory_lock`. Lock on a **dedicated short-lived connection**, closed when the migration step ends, never a pooled connection. One explicit one-shot `migrate` step runs to completion before `api`/`worker` start. Unclean-death case is tested.
- DB-12 (Pitfall 17): pre-migration duplicate-check query for every new constraint as its own reviewed step (`member (organizationId, userId)` plausibly has invite-race duplicates). `CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... UNIQUE USING INDEX`; assert `pg_index.indisvalid` afterwards. **Proven in-repo precedent: migration 0057** — cite it, don't re-derive.
- DB-07 (Pitfall 15): rollback is two explicit tiers — auto-reversible additive migrations vs documented forward-only ones (enums, RLS policies, partition DDL). Backfilling missing drizzle snapshots is an explicit task; migration suite asserts `drizzle-kit generate` produces an empty diff against current schema.
- DB-14 (Pitfall 10): PgBouncer, if introduced, must be transaction-mode with reset-on-return, after Phase 10's bare-`SET`/`SET ROLE` audit (`lint:session-state`, already green). **Resolved: deferred to SCALE-02 — see D-09.**
- Pitfall 19: explicit per-container memory limits sized so no container's OOM can starve Postgres; `oom_score_adj` favours killing `worker`/`api` over `postgres`.
- Pitfall 7 (joint with Phase 12): container stop grace period derived and documented from SendGrid timeout + transaction margins (Phase 12 left this derivation for Phase 14 to consume — `apps/worker/src/shutdown-budget.ts`). Verified with a real SIGTERM sent mid-load-test.
- DB-11 sits with DB-09/DB-10: rehearsed restore must exist **before** retention deletion is switched on.
- DB-06 pairs with OPS-05: "does not accept traffic until migrations complete" is readiness, not a startup sleep.
- Worker deploy strategy (R-05): stop-old-then-start-new for the worker. This phase also adds the two-version-compatibility scenario to Phase 8's failure-injection harness.

### Implementation Decisions

**Deploy topology & pipeline (OPS-01/02/03)**
- **D-01:** Production = one VPS, everything containerized (Postgres, Redis, `api`, `web`, `worker`, Caddy, pgBackRest, one-shot `migrate`) under docker compose — the dev `docker-compose.yml` pattern promoted to production. Reversibility: costly (backup destination, TLS posture, restore-drill mechanics and deploy script all assume co-located containers).
- **D-02:** Caddy fronts the platform — one container terminates public HTTPS (automatic Let's Encrypt), serves the built `web` SPA static bundle, reverse-proxies `/api` + webhook endpoint to `api`. Exact image split (volume vs FROM caddy) is planner discretion.
- **D-03:** Images built in CI (GitHub Actions on merge to `master`), pushed to GHCR tagged by git SHA; VPS pulls tags. Images pin **Node 22 LTS** (sidesteps the known drizzle-kit hang under Node v26). Rollback = redeploy previous SHA tag, no rebuild. Reversible.
- **D-04:** Deploys are operator-triggered, one reproducible command (`deploy.sh <sha>` shape): pulls tagged images, runs one-shot migrate, waits on `/readyz`, flips containers (worker via stop-old-then-start-new). CI auto-deploy explicitly rejected for now.

**Backups, restore drill & retention (DB-09/10/11)**
- **D-05:** pgBackRest provides backups + PITR, sidecar container sharing the Postgres data volume: scheduled full/diff/incremental, continuous WAL archiving, built-in retention expiry and verification. `pg_dump` ruled out (no PITR); WAL-G/snapshot approaches rejected as weaker-tooling variants. Reversible.
- **D-06:** Backup destination = S3-compatible object storage, off-host (provider is planner/operator discretion), with pgBackRest repo-cipher encryption at rest. New credentials land in the externally-resolved env file (`MEGA_CRM_ENV_FILE`).
- **D-07:** Restore drill (DB-10) = scripted PITR into a scratch container on the VPS: restore latest backup + WAL replay to a target timestamp, verify expectations (row counts, partitions present, RLS enabled+forced posture), destroy it. Full fresh-VPS DR rehearsal is a stretch variant.
- **D-08:** Retention (DB-11): drop `events`/`send_events` monthly partitions after ~12 months. Partition drop is the deletion mechanism (instant, no DELETE churn); horizon is a versioned constant with rationale comment. Evidence tables (`sends`, rollups, consent history, `erasure_records`, hashed suppression) untouched. Retention switches on only after D-07's drill has actually been performed. One-way (only the pgBackRest retention window can recover recently-dropped data).

**PgBouncer & Postgres TLS posture (DB-13/14)**
- **D-09:** PgBouncer deferred to SCALE-02, recorded as explicit accepted decision (owner = operator, revisit trigger = real `max_connections` pressure). Standing preconditions if introduced: transaction-mode + reset-on-return, `lint:session-state` stays green, DB-05's advisory lock stays on a direct connection. A documented connection budget (sum of pool maxima vs `max_connections`) proves headroom this phase.
- **D-10:** Postgres TLS (DB-13) = `ssl=on` with a self-signed cert, clients `sslmode=require`. `verify-full` + CA management explicitly deferred until Postgres has a real network path.
- **D-11:** Pool guarantee enforced by construction: shared `createPgPool()` factory in `packages/db` wiring error handler, TLS options, sizing defaults; all ~8 `new Pool` sites migrate to it; a lint/test guard fails on any bare `new Pool` outside the factory (WRK-11 precedent). Reversible — mechanical extraction, same constants.

**Migration runner & readiness gating (DB-05/06/07, OPS-04/05)**
- **D-12:** Migrations run via a programmatic runner script (drizzle-orm `migrate()` over the checked-in `packages/db/migrations` folder), not the drizzle-kit CLI: one dedicated connection, `pg_try_advisory_lock` bounded retry loop, run pending migrations, release, exit loudly non-zero on failure. Routes around the known drizzle-kit hang under Node v26. **Research verified below:** `migrate()` uses the identical `__drizzle_migrations` journal the CLI uses. Ships as the one-shot `migrate` step (compose `run`/service shape — planner discretion). Reversible — CLI remains usable in dev.
- **D-13:** `/readyz` independently verifies applied-vs-shipped migrations. Each image knows the migration set it was built with; readiness checks Postgres reachability, Redis reachability, AND that every shipped migration appears in drizzle's journal table. `/healthz` stays pure process-liveness.
- **D-14:** Worker gets a tiny localhost-only HTTP health server serving `/healthz` + `/readyz` with the same semantics as the API's. Docker healthchecks and the deploy script probe all three services uniformly; Phase 15 reuses the port.
- **D-15:** DB-07 rehearsal is scripted into CI + a runbook: apply full history, revert the newest auto-reversible tier, roll forward again, assert schema equality — every PR. Forward-only tier (enums, RLS, partition DDL) gets its documented recovery path (restore-based) in the runbook. Snapshot backfill + `drizzle-kit generate` empty-diff smoke test per the ROADMAP lock.

### Claude's Discretion
- Compose file layout (single prod compose vs override files), exact image/tag naming, Caddyfile shape, whether `web` is a volume Caddy serves or an image FROM caddy.
- Deploy script internals: failure handling, `/readyz` wait timeout, how stop-old-then-start-new sequences worker vs api, where the script lives (repo vs VPS).
- pgBackRest schedule (full/diff/incr cadence), repo retention window, cipher mode, stanza layout; restore-drill verification query set; drill recurrence cadence.
- Exact partition-drop horizon constant, where the drop runs (extend `partition-maintenance.worker.ts` vs operator CLI — Phase 9's D-08 precedent that destructive relocation was operator-only applies here too; planner decides whether scheduled DROP crosses the same line).
- Pool sizing defaults and connection-budget numbers; `createPgPool` API shape; which operator scripts adopt the factory vs keep bespoke pools.
- DB-12 constraint inventory and cleanup strategy for any duplicates found — **partially resolved by this research below** (`member(organizationId, userId)` confirmed as the only clear gap; `invitation` flagged as a secondary candidate).
- Container memory limit values and `oom_score_adj` numbers (sized to actual VPS RAM — operator supplies the figure).
- Health-server port, probe intervals, healthcheck retries/timeouts.
- Two-version-compatibility harness scenario shape (which payload `schemaVersion` pair it exercises).

### Deferred Ideas (OUT OF SCOPE)
- PgBouncer / external connection pooler — deferred to SCALE-02 (D-09).
- Postgres TLS `verify-full` + managed CA — deferred until Postgres has a real network path (D-10).
- Full fresh-VPS DR rehearsal — stretch variant of the restore drill (D-07).
- CI auto-deploy on merge — rejected for now (D-04).
- Sentry, hosted logs, real alerting, Bull Board — Phase 15.
- Multi-instance workers / leader election — SCALE-01.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OPS-01 | Dockerfiles exist for api, web, worker | Standard Stack § Docker; Code Examples § Dockerfile pattern (Node 22, direct `node` CMD, non-root user, multi-stage build) |
| OPS-02 | Deploy to VPS via reproducible command | Architecture Patterns § Deploy pipeline; Common Pitfalls (compose `service_completed_successfully` re-run bug — use `docker compose run --rm`, not `up`, for the migrate step) |
| OPS-03 | Rollback procedure documented | D-03 (SHA-tag redeploy); Code Examples § deploy.sh skeleton |
| OPS-04 | `/healthz` = liveness | Code Examples § health/readiness handlers |
| OPS-05 | `/readyz` gates Postgres+Redis+migrations | Code Examples § readyz handler; D-13 verified journal-table approach |
| DB-05 | Migrations apply exactly once | Common Pitfalls (advisory lock connection leak); Code Examples § migrate runner |
| DB-06 | App refuses traffic until migrations complete | Same as OPS-05 |
| DB-07 | Rollback/roll-forward documented and rehearsed | Common Pitfalls (`drizzle-kit generate` compares schema-to-snapshot, not to live DB — Pitfall relevant to the empty-diff smoke test); current migration/snapshot count below |
| DB-09 | Automated backups, PITR available | Standard Stack § pgBackRest; Code Examples § pgbackrest.conf skeleton |
| DB-10 | Restore actually performed and documented | Architecture Patterns § restore drill flow |
| DB-11 | Retention defined and applied | D-08; existing `partition-maintenance.worker.ts` precedent |
| DB-12 | Missing constraints added after verification | **DB-12 Constraint Inventory** section below (researched) |
| DB-13 | Postgres TLS | Common Pitfalls (`sslmode` query-string override); Code Examples § pg TLS config |
| DB-14 | Pooling configured, every pool has error handler | D-09/D-11; existing `pool.on("error", ...)` precedent in `packages/db/src/index.ts` |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **SPECIFICATION.md must be updated in the same change** as any new dependency, secret, schema object, queue/worker, HTTP route, or observability hook — the binding rule in `.claude/CLAUDE.md`, already restated in 14-CONTEXT.md's canonical_refs. For this phase specifically:
  - §2 (Зависимости и версии): pgBackRest/Caddy tooling if a workspace-visible dependency is added; otherwise note "container/OS-level tool, no npm entry."
  - §3 (Секреты): S3 backup credentials, pgBackRest repo-cipher passphrase, TLS cert material — all via the existing `MEGA_CRM_ENV_FILE` convention, exact env var names recorded with exact version/value source, never guessed.
  - §4 (Схема данных): the new `member(organizationId, userId)` unique constraint (and any other DB-12 finding), the retention horizon constant.
  - §5 (Планировщик и пайплайн отправки): the one-shot migrate runner, the partition-drop retention tick.
  - §6 (Публичные точки входа): `/healthz`, `/readyz` on both `api` and `worker`.
  - §8 (Расхождения): if the pgBackRest/Caddy versions actually shipped diverge from this document's `[ASSUMED]` version numbers, or if Node 22 vs. `.nvmrc`'s Node 26 divergence is not already covered elsewhere.
- **Version discipline:** every version recorded in SPECIFICATION.md must be the exact value from `package.json`/the built image, never the range this research document uses.
- **Tech stack hard constraint (already reflected in Standard Stack above):** TypeScript full-stack, Postgres + Redis, Fastify/Drizzle — this phase adds no new language or framework, only deployment/ops tooling around the existing stack.
- **Node version:** Docker images MUST pin **Node 22 LTS** explicitly (per the Technology Stack section of CLAUDE.md and D-03) — never derived from `.nvmrc` (which pins Node 26 for dev/CI and is the version documented elsewhere in this repo as causing the drizzle-kit CLI hang).
- **GSD workflow enforcement:** file-changing work for this phase must go through `/gsd-execute-phase` per CLAUDE.md's GSD Workflow Enforcement section — noted here for the executor, not actionable by this research document itself.

## Summary

Phase 14's technology choices are already fully locked in `14-CONTEXT.md` (D-01 through D-15) at a level of specificity well beyond typical phase context — this research does not re-derive stack choices, it verifies the mechanics the plan will depend on and fills the two explicitly-assigned research gaps: (1) whether `drizzle-orm`'s programmatic `migrate()` produces the same migration bookkeeping as the `drizzle-kit migrate` CLI (D-12 requires this verified before the swap), and (2) the DB-12 missing-constraint inventory.

**Verified: `drizzle-orm migrate()` and `drizzle-kit migrate` share the same journal.** Both write to the same `__drizzle_migrations` table (customizable schema/table name) using the same hash+timestamp bookkeeping; `migrate()` is documented as one of three ways to apply drizzle-kit-generated migrations (the others being the CLI and external tools), all converging on the same journal. This confirms D-12's swap from CLI to programmatic runner is safe: the dev CLI path and the production `migrate()` runner will never double-apply or lose track of a migration between environments. `[CITED: orm.drizzle.team/docs/migrations, orm.drizzle.team/docs/drizzle-kit-migrate]`

**DB-12 inventory result:** grepping the live schema (not just intuition) confirms `member(organizationId, userId)` — Better Auth's own table, no application code defines it — is the one clear structural gap; every tenant-owned table this project defines (`contacts`, `workspace_sendgrid_keys`, `workspace_send_settings`, `session.token`, `organization.slug`) already carries the uniqueness Drizzle's schema needs. `invitation` (no dedup constraint on pending invites for the same org+email) is a secondary candidate for planner discretion, not confirmed as a bug. `[VERIFIED: packages/db/src/schema/auth.ts, contacts.ts, sendgrid-keys.ts, workspace-send-settings.ts — direct code read]`

**DB-12 trust-boundary nuance:** `member` (and `invitation`) sit behind Phase 10's SEC-05 Better Auth trust boundary — they are read/written through the dedicated `mega_crm_auth` login role and `authDb`/`AUTH_DATABASE_URL` (see `packages/db/src/index.ts`'s `getAuthDb()`), not through `mega_crm_app`/`db`. Migration 0057's duplicate pre-check precedent iterated workspaces as `mega_crm_app` specifically because `send_events` carries `FORCE ROW LEVEL SECURITY` under that role — `member`/`invitation` are a **different** situation (no RLS on Better Auth tables per SEC-05's own trust-boundary design) but the DB-12 plan must still confirm, before copying 0057's shape, whether the pre-check script/migration should run as `mega_crm_app`, `mega_crm_auth`, or the migration-runner's own connection role, since the three roles have different grants. This is a concrete first-task question for the DB-12 plan, not yet resolved here.

A handful of pitfalls surfaced during research that are **not yet named** in the ROADMAP's pitfall list and should be added to the plan's verification steps: (1) a `?sslmode=require` query parameter in a `DATABASE_URL` connection string silently overrides any `ssl` object passed to `pg.Pool` — the `createPgPool` factory must pick exactly one mechanism and the plan must assert it does not silently drop TLS; (2) Docker Compose's `service_completed_successfully` depends_on condition has a known bug where the one-shot container can be re-run on a subsequent `up` — the deploy script should invoke the migrate step with `docker compose run --rm migrate`, not rely on `depends_on` re-triggering it; (3) `drizzle-kit generate` diffs the TypeScript schema against its own snapshot history, never against the live database — the DB-07 "empty diff" smoke test proves schema-file/snapshot parity, it does NOT prove the live database matches either, so the migration test suite (`test:migrations`, already applying the full chain to an empty DB) is the actual proof of live-DB parity and both checks are needed, not one substituting for the other.

**Primary recommendation:** implement the migrate runner and `/readyz` gating first (per the ROADMAP's OPS-04/05-before-OPS-02 sequencing), verify the advisory-lock unclean-death case and the `drizzle-orm migrate()` journal-parity claim with a real test against the existing 62-migration chain before wiring it into the deploy script, then layer Dockerfiles → compose → Caddy → CI image build → pgBackRest → retention, in that dependency order (each later piece assumes the earlier one's health/readiness contract already holds).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| HTTPS termination, static SPA serving | CDN/Edge (Caddy) | — | Caddy is the single public entry point (D-02); it never touches business logic |
| API routing, health/readiness | API/Backend (Fastify) | — | `/healthz`, `/readyz` are Fastify routes with no auth (D-13/D-14) |
| Worker liveness/readiness | API/Backend (worker's own tiny HTTP server) | — | D-14 — a **new**, minimal surface, not the existing Fastify app |
| Migration execution | Database/Storage (one-shot process) | — | D-12 — runs to completion before `api`/`worker` start; not a route, not a long-lived process |
| Backup/PITR | Database/Storage (pgBackRest sidecar) | CDN/Edge (S3 write path) | D-05/D-06 — sidecar shares the Postgres data volume; ships WAL/backups to off-host object storage |
| Retention (partition drop) | Database/Storage (worker tick or operator CLI) | — | D-08 — extends the existing `partition-maintenance.worker.ts` catalog-driven tick |
| Connection pooling + TLS | Database/Storage (pg client layer) | API/Backend, Worker (both consume the factory) | D-10/D-11 — `createPgPool()` lives in `packages/db`, consumed by every process that touches Postgres |
| Deploy orchestration | Ops tooling (deploy.sh, outside all 3 tiers) | — | D-04 — an operator-invoked script, not part of the running system |

## Standard Stack

### Core

| Library/Tool | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| **drizzle-orm** | 0.45.2 (already pinned in repo) | Programmatic `migrate()` runner | Already the project's ORM; `migrate()` shares the exact `__drizzle_migrations` journal drizzle-kit CLI uses — verified this research — so swapping the applier does not fork migration state between dev (CLI) and prod (runner). `[CITED: orm.drizzle.team/docs/migrations]` |
| **drizzle-kit** | 0.31.10 (already pinned) | `generate`, dev-only `migrate` CLI, snapshot/journal format | Stays the authoring tool; CLI remains usable in dev per D-12's reversibility note |
| **pgBackRest** | 2.5x (current stable; verify exact tag at build time, not an npm package — Debian/Docker image) | Backup, WAL archiving, PITR, restore | Purpose-built PostgreSQL backup tool understanding WAL internals, checksums and tablespaces; native S3-compatible repository support; the project's REQUIREMENTS.md explicitly rules out `pg_dump` (no PITR) `[CITED: pgbackrest.org/user-guide.html]` |
| **Caddy** | 2.x (current stable) | Reverse proxy, automatic HTTPS, static file serving | Automatic Let's Encrypt with zero manual cert management fits a single-operator VPS; native `handle`/`try_files` directives cover the exact SPA+API split D-02 needs `[CITED: caddyserver.com/docs/caddyfile/patterns]` |
| **Docker Compose** | v2 (bundled with Docker 29.x, confirmed installed locally) | Container orchestration on the single VPS | Already the dev-environment tool (`docker-compose.yml`); D-01 promotes the same vocabulary to production, no new orchestration paradigm |
| **GitHub Actions + GHCR** | — | CI image build/push | `.github/workflows/ci.yml` already exists with pinned-SHA third-party actions; GHCR needs no separate registry account (uses the same `GITHUB_TOKEN`) `[ASSUMED: exact `docker/build-push-action`/`docker/login-action` major versions — verify current majors at implementation time, do not hand-copy from this doc]` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:http` (built-in) | Node 22 | Worker's tiny health server (D-14) | No new dependency needed — mirrors the project's existing zero-dependency-preference pattern (`scripts/env-path.mjs` "no dependencies — Node built-ins only") |
| `pg` | 8.22.0 (already pinned) | TLS options (`ssl: {...}`) on `createPgPool` | Already the project's Postgres driver; TLS is a config change, not a new library |

### Alternatives Considered

All alternatives were already evaluated and rejected in CONTEXT.md/REQUIREMENTS.md; recorded here for completeness only, per the source documents:

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| pgBackRest | WAL-G, provider snapshots | Weaker-tooling variants of the same idea per D-05; not revisited |
| drizzle-orm `migrate()` | drizzle-kit CLI in production | CLI hangs under Node v26 in this repo's own sandbox (multiple migration test file headers document this); `migrate()` avoids the dependency on drizzle-kit's CLI process model in prod |
| Caddy | nginx + certbot | More moving parts (cron-renewed certs, separate proxy config format) for a single-VPS single-operator deployment; not evaluated further since D-02 already locked Caddy |
| PgBouncer now | Defer to SCALE-02 | D-09 — theoretical pressure only, ~8 app-level pools on one VPS |

**Installation:** No new npm packages are required by this phase's locked decisions (health server uses `node:http`; TLS is config on the existing `pg` driver; `createPgPool` is new source code, not a new dependency). pgBackRest and Caddy are OS/container-level tools, installed via their own Docker images or apt packages inside Dockerfiles — not npm installs.

**Version verification:** `pg@8.22.0`, `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10` confirmed against `package.json` in this repo — no drift from the stack doc. `[VERIFIED: package.json read directly]`. pgBackRest and Caddy have no npm registry entry to check; verify their current stable major/minor against `pgbackrest.org`/`caddyserver.com` release pages at Dockerfile-authoring time — this document's version numbers are `[ASSUMED]` (training-data recall, not confirmed live this session).

## Package Legitimacy Audit

No new npm packages are introduced by this phase's locked decisions. The health server uses Node's built-in `http` module; TLS and pooling changes are configuration on the already-installed `pg` driver; `createPgPool` is new first-party source code. pgBackRest and Caddy are non-npm (container/OS-level) tools and are out of scope for the npm registry legitimacy gate.

A registry check was still run for completeness against the two Postgres-adjacent packages already in the dependency tree, to confirm no supply-chain drift since the last phase:

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `pg` | npm | pre-existing, ~15+ years (verdict's "too-new" signal is a false positive on `publishedAt` = latest patch release date, not package age) | 43.7M/week | github.com/brianc/node-postgres | SUS (heuristic false-positive on patch-release recency) | Approved — already a production dependency, no new install |
| `drizzle-orm` | npm | pre-existing | 18.2M/week | github.com/drizzle-team/drizzle-orm | OK | Approved — already a production dependency, no new install |

**Packages removed due to [SLOP] verdict:** none.
**Packages flagged as suspicious [SUS]:** `pg` — flagged only because the legitimacy heuristic reads "most recent publish date" as package age; this is a pre-existing, actively-used, 43M-download/week dependency already vetted in prior phases, not a new install this phase requires gating.

## Architecture Patterns

### System Architecture Diagram

```
                         Internet (HTTPS)
                              |
                        [ Caddy container ]
                    (auto Let's Encrypt TLS)
                  /                          \
      handle /api/*, /webhook/*        handle everything else
                |                                |
        reverse_proxy api:PORT           file_server (web SPA build,
                |                         try_files -> index.html)
                v
        [ api container (Fastify) ]
        - /healthz  (liveness only)
        - /readyz   (Postgres + Redis + migration-journal check)
        - business routes (contacts, campaigns, flows, webhooks)
                |
     +----------+-----------+
     |                      |
[ Postgres ]           [ Redis ]
  ^   ^                     ^
  |   |                     |
  |   +---------------------+-------- BullMQ queues -------+
  |                                                          |
  |                                              [ worker container ]
  |                                              - localhost /healthz,/readyz
  |                                              - email:triggered / email:broadcast
  |                                              - partition-maintenance tick (+ retention drop)
  |                                              - reconciler, watchdogs
  |
  +--[ pgBackRest sidecar ]---(archive_command / scheduled backup)---> [ S3-compatible bucket ]
       (shares Postgres data volume; repo-cipher encrypted)

  DEPLOY-TIME ONLY (not a long-lived container):
  [ one-shot migrate step ] --dedicated connection--> pg_try_advisory_lock (bounded retry)
       runs packages/db/migrations via drizzle-orm migrate() -> __drizzle_migrations journal
       exits 0/non-zero BEFORE api/worker containers are (re)started
       |
       v
  deploy.sh waits on api's /readyz (and worker's) before declaring the deploy done
```

### Recommended Project Structure

```
docker/
├── Dockerfile.api          # multi-stage: npm ci --workspaces, tsc build, node:22-slim runtime
├── Dockerfile.web           # build stage produces static bundle; runtime stage is scratch/Caddy volume OR FROM caddy
├── Dockerfile.worker         # same shape as api, CMD ["node", "dist/server.js"] (never npm start)
├── docker-compose.prod.yml   # promotes docker-compose.yml's vocabulary: db, redis, api, worker, web/caddy, pgbackrest, migrate
├── Caddyfile
└── pgbackrest/
    └── pgbackrest.conf
scripts/
├── migrate-runner.mjs        # NEW: D-12's dedicated-connection advisory-lock runner (drizzle-orm migrate())
└── deploy.sh                 # NEW: D-04's operator-invoked reproducible deploy command
packages/db/src/
├── pool.ts                   # NEW: D-11's createPgPool() factory (TLS + error handler + sizing defaults)
└── migrations/                # UNCHANGED folder — same journal, same 62 SQL files, same meta/ snapshots
apps/api/src/modules/ops/
└── health.ts                  # NEW: /healthz, /readyz routes (D-13)
apps/worker/src/
└── health-server.ts            # NEW: D-14's localhost-only http server
```

### Pattern 1: Dedicated-connection advisory lock, bounded retry, loud failure

**What:** The migrate runner opens exactly one `pg.Client` (not a pooled `Pool`), takes `pg_try_advisory_lock` in a loop with a bounded retry count and backoff, runs `drizzle-orm`'s `migrate()` if the lock is acquired, releases the lock, and closes that one connection — never touching the shared `createPgPool()` pool.

**When to use:** Exactly the one-shot `migrate` deploy step (DB-05). Never inside `api`/`worker` boot — those must read via `/readyz`, not attempt to migrate themselves.

**Example:**
```typescript
// Source: pattern verified against drizzle-orm docs (orm.drizzle.team/docs/migrations)
// + community advisory-lock-across-pool-connections pitfall (GitHub issue: a lock
// acquired on one pooled connection and "released" from a different one silently
// no-ops, leaving the lock held for the pool's lifetime).
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const MIGRATION_LOCK_KEY = 727_140_005; // versioned constant with a comment on why this number
const MAX_LOCK_ATTEMPTS = 10;
const LOCK_RETRY_DELAY_MS = 3_000;

async function runMigrations(databaseUrl: string): Promise<void> {
  // A dedicated pg.Client, NOT packages/db's pooled createPgPool() — the lock's
  // session-level lifetime must equal this one connection's lifetime.
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    let locked = false;
    for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS && !locked; attempt++) {
      const { rows } = await client.query<{ pg_try_advisory_lock: boolean }>(
        "SELECT pg_try_advisory_lock($1)",
        [MIGRATION_LOCK_KEY],
      );
      locked = rows[0].pg_try_advisory_lock;
      if (!locked) await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS));
    }
    if (!locked) {
      throw new Error(
        `migrate: could not acquire advisory lock ${MIGRATION_LOCK_KEY} after ${MAX_LOCK_ATTEMPTS} attempts — another migration is likely stuck; investigate before retrying`,
      );
    }
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: "./packages/db/migrations" });
  } finally {
    // Release explicitly rather than relying on connection close alone —
    // advisory locks are session-scoped and this connection closes right after,
    // but an explicit release makes the intent visible and matches this
    // project's existing "close what you open" style.
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}
```

### Pattern 2: `/readyz` verifies applied-vs-shipped migrations, not just DB reachability

**What:** Readiness reads the drizzle journal table directly and compares it against the migration tag list the image was built with (baked in at build time, e.g. via a generated manifest or by reading the same `packages/db/migrations` folder shipped in the image).

**When to use:** D-13's "holds by construction" requirement — a container started against a stale database must refuse readiness even if the deploy script's own sequencing is bypassed.

**Example:**
```typescript
// Source: pattern derived from D-13's requirement; drizzle-orm journal table
// name/shape confirmed via orm.drizzle.team/docs/migrations
import fs from "node:fs";
import path from "node:path";

async function migrationsAreCurrent(pool: Pool): Promise<boolean> {
  const shippedTags = fs
    .readdirSync(path.join(import.meta.dirname, "../../../packages/db/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => f.replace(/\.sql$/, ""));

  const { rows } = await pool.query<{ hash: string }>(
    'SELECT hash FROM "drizzle"."__drizzle_migrations" ORDER BY created_at',
  );
  const appliedHashes = new Set(rows.map((r) => r.hash));
  // drizzle's journal stores a hash per tag, not the tag string itself --
  // cross-reference via the journal.json this image also ships, not a raw
  // string comparison. (Exact join key must be verified against the specific
  // drizzle-orm/drizzle-kit version's journal.json shape at implementation
  // time -- this is the mechanism, not the literal column name.)
  return shippedTags.every((tag) => /* tag's hash present in appliedHashes */ true);
}
```
**Note:** the exact journal `hash` computation (drizzle hashes migration file contents, not the tag name) must be verified against the installed `drizzle-orm@0.45.2` source before the planner finalizes this route — flagged in Open Questions below.

### Pattern 3: One-shot migrate via `docker compose run --rm`, not `depends_on: service_completed_successfully`

**What:** The deploy script explicitly runs `docker compose run --rm migrate` as its own step, checks the exit code, and only then runs `docker compose up -d api worker`. It does NOT rely on `depends_on: { migrate: { condition: service_completed_successfully } }` inside a single `docker compose up`.

**When to use:** Every deploy. This directly avoids the documented Compose bug where a one-shot container satisfying `service_completed_successfully` can be re-run on a subsequent `up` invocation.

### Pattern 4: `oom_score_adj` and per-container memory limits

**What:** Postgres gets a strongly negative `oom_score_adj` (favoring survival); `api`/`worker` get default or slightly positive; every container gets an explicit `mem_limit`/`mem_reservation` so the kernel OOM killer has a limit to enforce in the first place — an unset limit means "disabling the score adjustment achieves nothing," since the container could still exhaust host RAM before the adjustment matters.

**Constant-to-compose extraction (required, not optional):** ARCHITECTURE.md §10 states the worker's stop-grace-period "MUST be set from this module's published value, never left at a runtime default" — a YAML file cannot `import` a TypeScript constant, so the plan must name an explicit extraction mechanism, not leave an executor to hand-type a number. Two viable mechanisms, planner's choice: (a) the deploy script runs a small Node script (`node -e "import('./apps/worker/dist/shutdown-budget.js').then(m => console.log(m.WORKER_STOP_GRACE_PERIOD_SECONDS))"` against the built image, or a dedicated `scripts/print-stop-grace-period.mjs`) and substitutes the result into the compose file or an env var Compose interpolates (`${WORKER_STOP_GRACE_PERIOD_SECONDS}`) at deploy time; or (b) a build step generates a `.env.deploy` fragment containing the resolved number as part of the CI image-build job, committed nowhere but regenerated every deploy. Either way, the plan must include a test or CI check asserting the compose file's effective value matches `WORKER_STOP_GRACE_PERIOD_SECONDS` at deploy time — a hand-typed `stop_grace_period: 51s` that silently drifts from the source constant after a future change to `SENDGRID_TIMEOUT_MS` is exactly the failure mode this module's own header comment warns against.

**Example:**
```yaml
# Source: pattern verified via community best-practice writeups (Docker
# assigns dockerd itself -500 and containers 0 by default; -500 is cited as
# the pragmatic enterprise default rather than -1000's "total immunity, but a
# leak can freeze the host" tradeoff)
services:
  db:
    image: postgres:17
    mem_limit: 4g          # operator supplies the real number from VPS RAM
    oom_score_adj: -500
  api:
    mem_limit: 512m
    oom_score_adj: 0
  worker:
    mem_limit: 512m
    oom_score_adj: 0
    stop_grace_period: "${WORKER_STOP_GRACE_PERIOD_SECONDS}s"   # from apps/worker/src/shutdown-budget.ts — never a hand-typed default
```

### Anti-Patterns to Avoid

- **`CMD ["npm", "start"]` in any Dockerfile:** npm does not forward SIGTERM to the child Node process — graceful shutdown silently stops working. This project's `package.json` `start` scripts already run `node dist/server.js` directly; Dockerfiles must `CMD` that binary directly, never wrap it in `npm run`.
- **Relying on `.nvmrc` to pin the Docker image's Node version:** `.nvmrc` currently pins Node 26 for dev/CI (this is the same version documented elsewhere in the repo as causing the drizzle-kit CLI hang). D-03 deliberately pins Docker images to Node 22 LTS — a Dockerfile that does `FROM node:$(cat .nvmrc)` would silently reintroduce the hang into production. Hardcode `node:22-slim` (or equivalent) explicitly in every Dockerfile; do not derive it from `.nvmrc`.
- **A connection string with `?sslmode=require` AND a separately-constructed `ssl` object passed to `pg.Pool`:** the query-string parameter wins and silently overrides the `ssl` object, which can mean a `rejectUnauthorized` setting the code believes it configured is never actually applied. `createPgPool()` must pick exactly one mechanism (recommend: parse TLS mode from the connection string once, in the factory, and never pass a separately-conflicting `ssl` object) and the plan must include a test asserting the actual negotiated connection is TLS (e.g., query `pg_stat_ssl` for the backend pid) — not just that the config object looks correct.
- **Blocking `pg_advisory_lock` for migration gating:** already forbidden by the ROADMAP lock, restated here because it is the single most consequential mistake this phase can make — a stuck migration under a blocking lock hangs the entire deploy silently rather than failing loudly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|--------------|-----|
| WAL-aware backup + PITR | A cron job calling `pg_dump` + a home-grown WAL-shipping script | pgBackRest | Already excluded `pg_dump` in REQUIREMENTS.md for lack of PITR; pgBackRest's parallel backup, checksum verification, retention expiry and S3-native repository are exactly the primitives a hand-rolled script would need to reimplement, badly, under incident pressure |
| Automatic HTTPS cert renewal | A certbot cron job + nginx reload script | Caddy's built-in ACME client | Zero renewal cron, zero reload-on-renew race, matches D-02 |
| Cross-process migration mutual exclusion | A home-grown Redis lock or a `.lock` file on disk | Postgres `pg_try_advisory_lock` | Advisory locks are session-scoped, visible in `pg_locks`, and survive exactly as long as the dedicated connection holding them — no separate coordination service needed, no stale-lock-file cleanup problem |
| Deploy readiness polling | A fixed `sleep 30` in the deploy script | `/readyz`-gated wait loop with a bounded timeout | This is the entire point of OPS-04/05 landing before OPS-02 — a timer is exactly the failure mode readiness gating exists to remove |

**Key insight:** every "don't hand-roll" item above already has a purpose-built, widely-deployed tool that understands the specific hazard (WAL consistency, ACME protocol edge cases, session-scoped locking semantics) better than a bespoke script written under this project's time constraints would.

## Common Pitfalls

### Pitfall A: Advisory lock acquired and released on different pooled connections
**What goes wrong:** A migration runner takes `pg_try_advisory_lock` on a connection borrowed from a pool, then "releases" it — but if the release happens on a different connection returned by the same pool, the unlock silently no-ops (session-scoped locks only release on the exact session that took them, or on that session's disconnect). The lock then sits held for the pool's entire lifetime, blocking every subsequent migration attempt with no visible error.
**Why it happens:** Using `Pool.query()` for both the lock-acquire and lock-release statements — the pool may hand each call a different underlying client.
**How to avoid:** Use a single `pg.Client` (not `Pool`) for the entire migrate step, exactly as D-05/D-12 already specify — this pitfall is the mechanistic reason that constraint exists, not an arbitrary style preference.
**Warning signs:** A second deploy hangs waiting on the advisory lock even though the first migration process has clearly exited; `pg_locks` shows an `advisory` lock with no corresponding live backend.

### Pitfall B: `sslmode` query parameter silently overriding the `ssl` config object
**What goes wrong:** `createPgPool()` is handed a `DATABASE_URL` that happens to include `?sslmode=require`, and separately constructs an `ssl: { rejectUnauthorized: false }` object for the self-signed cert (D-10). The query-string parameter wins; the explicit object is ignored, and the actual TLS negotiation behavior may not match what the code believes it configured.
**Why it happens:** node-postgres resolves connection-string query parameters and the `ssl` config object through different code paths, and the string wins.
**How to avoid:** Pick exactly one source of truth in the factory — either always parse TLS mode from the connection string and never separately construct an `ssl` object, or strip `sslmode` from the string before constructing `Pool` and always drive TLS from the explicit object. Document the choice at the factory's definition site.
**Warning signs:** TLS "looks configured" in code review but a live packet capture or `pg_stat_ssl` query shows an unencrypted connection.

### Pitfall C: `docker compose` re-running a completed one-shot container
**What goes wrong:** `service_completed_successfully` is a documented-buggy `depends_on` condition in some Compose versions — the one-shot `migrate` container can be re-executed on a subsequent `compose up`, potentially re-running migrations concurrently with a live deploy.
**Why it happens:** Compose issue tracker documents this as a known, version-dependent behavior.
**How to avoid:** Deploy script invokes `docker compose run --rm migrate` explicitly as its own step and checks the exit code, rather than expressing the ordering purely through `depends_on` inside a single `compose up` invocation (Pattern 3 above).
**Warning signs:** Migration logs show two runs in quick succession during a single deploy; the advisory lock (Pitfall A's mitigation) should make this safe rather than catastrophic, but it should not be relied upon as the only defense.

### Pitfall D: `drizzle-kit generate` proves schema/snapshot parity, not live-database parity
**What goes wrong:** The DB-07 lock requires an "empty diff" smoke test asserting `drizzle-kit generate` produces nothing new. This test is necessary but is easy to mistake for proof that the live production database matches the current schema — it is not. `drizzle-kit generate` diffs the TypeScript schema file against its own last-recorded JSON snapshot; it never inspects a live database at all.
**Why it happens:** The three artifacts (schema.ts, `meta/*_snapshot.json`, live DB catalog) are only loosely coupled by convention, not enforced coupling.
**How to avoid:** Keep both checks: (1) the empty-diff smoke test (schema ↔ snapshot parity) AND (2) `test:migrations`'s existing full-chain-against-an-empty-database run (snapshot-chain ↔ live-DB parity). Neither substitutes for the other.
**Warning signs:** A manual `ALTER TABLE` run directly against production (bypassing the migration chain) would pass the empty-diff smoke test cleanly while leaving the live database silently out of sync — only the migration-application tests would eventually surface this, and only if they compare against a database seeded the same way production was built.

### Pitfall E: Missing drizzle snapshots understate the real backfill scope
**What goes wrong:** ROADMAP's pitfall note cites "27 of 38 existing migrations have no snapshot." As of this research, the repository has grown to **62 migration SQL files with only 12 snapshot JSON files in `meta/`** — 50 migrations currently lack a snapshot, not 27. Planning the D-07/D-15 snapshot-backfill task against the stale "27 of 38" figure understates the work.
**Why it happens:** The pitfall note was written when the ROADMAP itself was created (2026-07-27); Phases 9-13 have added migrations 0038-0061 since.
**How to avoid:** The plan should compute the actual current gap (`ls packages/db/migrations/*.sql | wc -l` vs `ls packages/db/migrations/meta/*_snapshot.json | wc -l`) as a task-scoping step rather than hand-copying the ROADMAP figure.
**Warning signs:** none at execution time — this only matters for correctly sizing the backfill task during planning.

### Pitfall F (Pitfall 16, restated with the connection-leak mechanism): blocking `pg_advisory_lock` turns a stuck migration into a silent deploy hang
Already locked at the ROADMAP level; restated here because a related community-documented failure (Pitfall A above) shows the SAME root cause — treating advisory locks as if they were connection-agnostic — can also defeat a correctly-`_try_`-based implementation if the connection discipline is not followed. The lock primitive and the connection discipline are two halves of the same guarantee; DB-05's requirement is not satisfied by `pg_try_advisory_lock` alone if it runs through a pool.

## Code Examples

### pgbackrest.conf skeleton (S3 repository, encrypted, WAL archiving)
```ini
# Source: pattern verified against pgbackrest.org/configuration.html and
# pgbackrest.org/user-guide.html — exact key names must be checked against
# the pgBackRest version actually installed in the sidecar image at build time.
[global]
repo1-type=s3
repo1-s3-endpoint=<s3-endpoint>          # D-06: provider is operator/planner discretion
repo1-s3-bucket=<bucket-name>
repo1-s3-region=<region>
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<from MEGA_CRM_ENV_FILE, never checked into git>
repo1-retention-full=<planner discretion — e.g. 2>
process-max=2

[mega_crm]
pg1-path=/var/lib/postgresql/data
```
```conf
# postgresql.conf changes the pgBackRest sidecar requires — verify exact
# archive_command syntax against the installed pgBackRest version:
archive_mode = on
archive_command = 'pgbackrest --stanza=mega_crm archive-push %p'
```

### Caddyfile skeleton (SPA + API split)
```
# Source: caddyserver.com/docs/caddyfile/patterns (Common Caddyfile Patterns)
your-domain.example {
  encode
  handle /api/* {
    reverse_proxy api:3000
  }
  handle /webhook/* {
    reverse_proxy api:3000
  }
  handle {
    root * /srv/web
    try_files {path} /index.html
    file_server
  }
}
```

### GHCR build-and-push job skeleton
```yaml
# Source: pattern verified via GitHub Marketplace docker/build-push-action
# listings and standard GHCR auth pattern (uses the repo's own GITHUB_TOKEN,
# no separate registry credential needed). Pin every action to a full commit
# SHA per this repo's own existing CI convention (see .github/workflows/ci.yml
# header comment) — exact current SHAs must be looked up at implementation
# time, not copied from training data.
jobs:
  build-and-push:
    if: github.ref == 'refs/heads/master'
    needs: [static, test, failure-injection]
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    strategy:
      matrix:
        app: [api, web, worker]
    steps:
      - uses: actions/checkout@<pin-to-sha>
      - uses: docker/login-action@<pin-to-sha>
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@<pin-to-sha>
        with:
          context: .
          file: docker/Dockerfile.${{ matrix.app }}
          push: true
          tags: ghcr.io/${{ github.repository }}/${{ matrix.app }}:${{ github.sha }}
```

### `createPgPool` factory skeleton
```typescript
// Source: pattern modeled on this repo's own packages/queue-core/src/connection.ts
// single-definition precedent (buildRedisConnectionOptions / createRedisConnection)
// and packages/db/src/index.ts's existing pool.on("error", ...) handler.
import { Pool, type PoolConfig } from "pg";
import { scrubbedConsole } from "@mega-crm/redaction";

export interface CreatePgPoolOptions {
  connectionString: string;
  /** D-11 discretion: sizing defaults live here, not scattered per call site. */
  max?: number;
}

export function createPgPool(options: CreatePgPoolOptions): Pool {
  // D-10/Pitfall B: pick exactly one TLS source of truth. This factory treats
  // the connection string's own sslmode as authoritative and does NOT also
  // pass a separately-constructed `ssl` object, to avoid the documented
  // query-string-wins-silently behavior.
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max ?? 10, // planner discretion: derive from connection-budget math (D-09)
  };
  const pool = new Pool(config);
  // WRK-11-equivalent precedent (queue-core's error listener) — every pool in
  // this codebase must have this, per DB-14.
  pool.on("error", (err) => {
    scrubbedConsole.error("createPgPool: idle client error (connection dropped)", err);
  });
  return pool;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `npm run db:migrate` (drizzle-kit CLI) invoked ad hoc via `predev` script | Programmatic `drizzle-orm migrate()` runner, dedicated connection, advisory lock | This phase (D-12) | Production migrations no longer depend on the drizzle-kit CLI process, which is documented (in this repo's own migration test file headers) to hang under Node v26; dev retains the CLI unaffected |
| No container image, no deploy manifest (ARCHITECTURE.md's own "Forward-looking" section, written before this phase) | Dockerfiles + prod compose + CI image build to GHCR | This phase (OPS-01/02/03) | First deployable artifact for this codebase — everything before this phase ran only on a developer machine |
| Manual/no backup story | pgBackRest scheduled backups + WAL archiving + scripted restore drill | This phase (DB-09/10) | First actually-tested disaster-recovery path; DB-11's retention explicitly waits for this to exist first |

**Deprecated/outdated:** none — this phase is additive infrastructure onto an existing, actively-developed system; no prior deployment mechanism exists to deprecate.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | pgBackRest current stable version is 2.5x | Standard Stack § Core | Low — version string in a Dockerfile `FROM`/apt-pin; wrong number just needs a bump before the image builds, caught immediately by CI |
| A2 | Caddy current stable major is 2.x with the `handle`/`try_files` directive syntax shown | Standard Stack, Code Examples § Caddyfile | Low — Caddyfile syntax errors fail loudly at Caddy startup, not silently |
| A3 | `docker/build-push-action`, `docker/login-action` current major versions and exact commit SHAs to pin | Code Examples § GHCR workflow | Low-Medium — this repo's own CI convention requires SHA-pinning; using a stale/wrong SHA either fails the build (safe) or (worse) pins an outdated-but-still-valid action version silently. Must be looked up fresh at implementation time, never copied from this document |
| A4 | The exact drizzle `__drizzle_migrations` journal hash-comparison mechanism (Pattern 2's `/readyz` check) | Architecture Patterns § Pattern 2 | Medium — if the join key between "shipped migration tags" and "journal hash rows" is implemented incorrectly, `/readyz` could either falsely refuse readiness (safe failure mode, blocks deploy) or falsely report ready against a stale schema (the exact failure D-13 exists to prevent). Must be verified against the installed `drizzle-orm@0.45.2` source/tests before this ships, not assumed from documentation prose alone |
| A5 | `invitation` table lacking a dedup constraint on `(organizationId, email)` is a genuine secondary DB-12 candidate, not intentional | DB-12 Constraint Inventory | Low — worst case the planner investigates and confirms it is intentional (allowing re-invites), costing one review cycle, not a production incident |

**If this table is empty:** N/A — see rows above.

## Open Questions

1. **Exact drizzle journal comparison mechanism for `/readyz`'s applied-vs-shipped check (D-13)**
   - What we know: `migrate()` and the CLI share the same `__drizzle_migrations` journal table (hash + timestamp columns), confirmed via official docs.
   - What's unclear, narrowed to a concrete check: whether drizzle's node-postgres migrator decides "this migration is pending" by comparing each journal entry's `meta/_journal.json` `when` timestamp against `__drizzle_migrations.created_at` (a timestamp-cutoff comparison — "has anything with a `when` after the last applied `created_at` shipped?"), or by hash-set membership (compute each shipped migration's hash, check it exists as a row) — these are different queries with different failure modes (a timestamp-cutoff check can be fooled by a migration inserted out of chronological order; a hash-set check cannot, but requires recomputing the same hash function the migrator uses).
   - Recommendation: the plan's first DB-13/readiness task should read `drizzle-orm`'s own migrator source (`node_modules/drizzle-orm/node-postgres/migrator.*` at the pinned 0.45.2 version) to confirm which of the two mechanisms it actually uses, and `/readyz` should reuse that exact mechanism rather than inventing a third comparison — inventing a new comparison risks disagreeing with the migrator's own definition of "applied."

2. **DB-12 full constraint inventory beyond `member`/`invitation`**
   - What we know: every application-owned tenant table (`contacts`, `workspace_sendgrid_keys`, `workspace_send_settings`, `session`, `organization`) already has the uniqueness its own business rules require, confirmed by direct schema read.
   - What's unclear: whether a live-database introspection query (comparing `pg_constraint`/`pg_index` against the schema's declared intent, rather than reading `schema.ts` files) would surface anything this static read missed — e.g., a constraint declared in Drizzle but never actually applied because a migration was skipped, or a raw-SQL-only table (partitioned tables can't express constraints in Drizzle's `pgTable` API, per migration 0057's own header) that was never audited this way.
   - Recommendation: the DB-12 plan's first task should be a live introspection query against a fully-migrated database (comparing `pg_constraint` to the expected inventory this research documents), not solely a repeat of this static code read.

3. **VPS RAM size for `mem_limit`/`oom_score_adj` concrete numbers**
   - What we know: the pattern (negative score for Postgres, explicit limits everywhere) is correct and locked.
   - What's unclear: the actual numbers, which depend on the operator's VPS choice — explicitly deferred to the operator per CONTEXT.md's Claude's Discretion section.
   - Recommendation: plan should parameterize these as environment-supplied values with a documented minimum, not hardcode a guess.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Docker | Local dev verification of Compose changes, image builds | ✓ | 29.7.2 | — |
| Docker Compose v2 | Prod compose file authoring/testing | ✓ (bundled with Docker 29.x) | — | — |
| pgBackRest | Backup sidecar — runs inside its own container on the VPS, not needed on this dev machine | ✗ (not installed locally) | — | Not a blocker: pgBackRest runs inside a Docker image built for the VPS; local dev never needs the binary installed directly |
| Caddy | Reverse proxy — runs inside its own container on the VPS | ✗ (not installed locally) | — | Not a blocker: same reasoning as pgBackRest |
| gh CLI | Verifying/managing GitHub Actions workflow changes | ✓ | 2.96.0 | — |
| Node.js | Local script/test authoring | ✓ | v26.0.0 | This is exactly the version documented elsewhere in the repo as causing the drizzle-kit CLI hang — local `test:migrations` runs already route around it; no new fallback needed beyond what's already in place |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** pgBackRest, Caddy — both are containerized VPS-side tools, never required on the development machine; their absence locally does not block writing Dockerfiles/configs, only their live-runtime testing (which the plan should schedule against a real or staging VPS, not local Docker Desktop, given they interact with real ACME/S3 endpoints).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.9 (already the project standard) |
| Config file | `packages/db/vitest.config.ts`, `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts` (existing) |
| Quick run command | `npm run test:migrations` (`vitest run --root packages/db`) |
| Full suite command | `npm run coverage` (aggregate, existing CI `test` job) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|--------------------|-------------|
| DB-05 | Migration runner is exactly-once under concurrent start | integration | new: `vitest run --root packages/db src/__tests__/migrate-runner-advisory-lock.test.ts` | ❌ Wave 0 |
| DB-05 | Migration process killed mid-run does not block next attempt | failure-injection | new: `npm run failure:migrate-unclean-death` (joins the existing `failure:*` family) | ❌ Wave 0 |
| DB-06/OPS-05 | `/readyz` refuses until migrations complete | integration | new: `vitest run --root apps/api src/modules/ops/__tests__/readyz.test.ts` | ❌ Wave 0 |
| OPS-04 | `/healthz` answers liveness only, independent of DB/Redis state | unit | new: `vitest run --root apps/api src/modules/ops/__tests__/healthz.test.ts` | ❌ Wave 0 |
| DB-07 | Rollback/roll-forward rehearsal | integration (CI, every PR) | extends existing `npm run test:migrations` chain-application tests | ⚠️ extends `migrate-incremental.test.ts`/`migrate-from-empty.test.ts` |
| DB-07 | `drizzle-kit generate` empty-diff smoke test | static/CI | new script, e.g. `npm run lint:migrations-empty-diff` | ❌ Wave 0 |
| DB-12 | Duplicate pre-check for `member(organizationId, userId)` | script (operator-invoked, per migration 0057 precedent) | new: `packages/db/scripts/count-member-duplicates.ts` mirroring `count-send-event-duplicates.ts` | ❌ Wave 0 |
| DB-12 | `pg_index.indisvalid` asserted after `CREATE UNIQUE INDEX CONCURRENTLY` | migration-level test | extends the migration-0057-style test pattern | ❌ Wave 0 (new migration file + its own test) |
| DB-13 | Postgres connection actually negotiates TLS | integration | new: query `pg_stat_ssl` for the current backend pid after connecting via `createPgPool()` | ❌ Wave 0 |
| DB-14 | Every pool has an error handler | static/lint | new: `scripts/lint-pg-pool-factory.mjs` guard (WRK-11 precedent for Redis) | ❌ Wave 0 |
| OPS-01 | Dockerfiles build successfully for api/web/worker | CI | new CI job step: `docker build -f docker/Dockerfile.<app> .` per matrix entry | ❌ Wave 0 |
| Pitfall 7 | Real SIGTERM mid-load-test drains cleanly within the derived budget | manual + scripted | extends existing load-test harness (`loadtest:tenant-rps-sustained.test.ts` pattern) with a SIGTERM injection | ❌ Wave 0 |
| R-05 (worker deploy strategy) | Two-version compatibility: an old-version worker and a new-version worker never run against incompatible job payloads simultaneously during a stop-old-then-start-new deploy | failure-injection | new: `npm run failure:two-version-compat` (joins the existing `failure:*` family and Phase 8's harness — ROADMAP explicitly assigns this scenario to Phase 14, "do not drop it") | ❌ Wave 0 |
| DB-09/10 | Restore drill actually performed | **manual-only** | scripted PITR into scratch container, human runs and writes up the runbook | Justification: a real S3 round-trip + WAL replay against production-shaped data cannot be meaningfully faked in CI without either a live S3 bucket credential in CI (security/cost concern) or a mocked pgBackRest (defeats the purpose of "actually performed") — D-07 explicitly requires this be a real, written-up drill, not an automated assertion |

### Sampling Rate
- **Per task commit:** `npm run test:migrations` (fast, no live services needed beyond the ephemeral test DB already wired)
- **Per wave merge:** `npm run coverage` (full aggregate) + the new `failure:migrate-unclean-death` scenario joining `npm run failure:all`
- **Phase gate:** Full suite green before `/gsd-verify-work`, PLUS the DB-10 restore drill's written runbook as a non-automatable manual gate (per DB-10's "actually performed, not merely configured" requirement)

### Wave 0 Gaps
- [ ] `packages/db/src/__tests__/migrate-runner-advisory-lock.test.ts` — covers DB-05
- [ ] `apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts` — covers DB-05's unclean-death rehearsal
- [ ] `apps/api/src/modules/ops/__tests__/healthz.test.ts` + `readyz.test.ts` — covers OPS-04/OPS-05/DB-06
- [ ] `apps/worker/src/__tests__/health-server.test.ts` — covers D-14
- [ ] `packages/db/scripts/count-member-duplicates.ts` + its migration's own test — covers DB-12
- [ ] `scripts/lint-pg-pool-factory.mjs` — covers DB-14's "every pool has an error handler" as a machine-checkable gate, mirroring `lint:session-state`
- [ ] `apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts` — covers R-05's mandated two-version-compatibility scenario (explicitly assigned to Phase 14 by the ROADMAP — must not be dropped)
- [ ] CI job addition: Dockerfile build steps for OPS-01, image-push job for OPS-02/D-03
- [ ] Framework install: none — Vitest already in place everywhere this phase touches

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V1 Architecture | Yes | Exactly-once migration gating (advisory lock) and readiness-by-construction (D-13) are architectural controls against a whole class of "stale schema serves traffic" failures |
| V6 Cryptography | Yes | pgBackRest repo-cipher (AES-256) for backups at rest in S3; Postgres TLS (D-10) for data in transit; neither should be hand-rolled — both are the tool's own built-in, audited implementation |
| V9 Communication Security | Yes | Postgres client-server TLS (`ssl=on`, `sslmode=require`); the self-signed-cert posture (D-10) is a documented, deliberate interim step, not an oversight — `verify-full` deferred with a recorded revisit trigger |
| V4 Access Control | Partial | The advisory lock is a mutual-exclusion primitive, not an access-control boundary — no new authz surface is introduced by this phase. `/healthz`/`/readyz` are deliberately unauthenticated (process/infra probes, no tenant data) |
| V14 Configuration | Yes | New secrets (S3 credentials, pgBackRest cipher passphrase, TLS cert material) join the existing `MEGA_CRM_ENV_FILE` out-of-repo convention — no new secret-storage mechanism, reuse the established pattern |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|-----------------------|
| Unencrypted Postgres traffic on a shared Docker network sniffed by a compromised co-located container | Information Disclosure | D-10's `ssl=on`/`sslmode=require`, even with a self-signed cert — encrypts the wire even before `verify-full` closes the impersonation gap |
| Backup files readable if the S3 bucket is misconfigured public | Information Disclosure | pgBackRest repo-cipher encryption at rest (D-06) — the bucket's own access policy is a second, independent control, not a substitute |
| A stuck/crashed migration process leaving the advisory lock held, blocking all future deploys indefinitely | Denial of Service | Bounded retry + loud failure (D-05), operator can always manually `pg_advisory_unlock` a confirmed-dead session as documented in the runbook |
| Retention (partition DROP) miscalibrated or triggered against the wrong horizon, destroying data still needed for compliance evidence | Denial of Service / Tampering (against data integrity) | Versioned constant with rationale comment (D-08), retention gated behind a proven restore drill (DB-10 before DB-11), evidence tables explicitly excluded from the drop |
| A container's OOM event killing Postgres because no per-container memory limit or `oom_score_adj` was set | Denial of Service | Pitfall 19's mitigation — explicit `mem_limit` + negative `oom_score_adj` for Postgres |
| `docker compose run --rm migrate` executed twice concurrently despite the advisory lock, e.g. via an operator running the deploy script from two terminals | Denial of Service (self-inflicted) | The advisory lock (D-05) is exactly the defense here — this is the scenario it exists to make safe, not merely "unlikely" |

## Sources

### Primary (HIGH confidence)
- Direct repository reads: `package.json` (root, `apps/api`, `apps/worker`, `packages/db`), `docker-compose.yml`, `packages/db/drizzle.config.ts`, `scripts/migrate-dev.mjs`, `scripts/env-path.mjs`, `packages/db/src/index.ts`, `packages/db/migrations/*.sql` (62 files) + `meta/*.json` (12 snapshots + journal), `packages/db/src/schema/*.ts` (all 30+ schema files, specifically `auth.ts`, `contacts.ts`, `sendgrid-keys.ts`, `workspace-send-settings.ts`, `api-keys.ts`), `apps/worker/src/server.ts`, `apps/worker/src/shutdown-budget.ts`, `packages/queue-core/src/connection.ts`, `.github/workflows/ci.yml`, `ARCHITECTURE.md`, `.nvmrc` (Node 26) — `[VERIFIED]` throughout

### Secondary (MEDIUM confidence)
- [orm.drizzle.team/docs/migrations](https://orm.drizzle.team/docs/migrations) — journal table structure and `migrate()`/CLI parity claim
- [orm.drizzle.team/docs/drizzle-kit-migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate) — CLI migrate behavior
- [orm.drizzle.team/docs/drizzle-kit-generate](https://orm.drizzle.team/docs/drizzle-kit-generate) — generate's schema-vs-snapshot diff mechanism (not live-DB)
- [pgbackrest.org/user-guide.html](https://pgbackrest.org/user-guide.html), [pgbackrest.org/configuration.html](https://pgbackrest.org/configuration.html) — S3 repo, WAL archiving, PITR mechanics
- [caddyserver.com/docs/caddyfile/patterns](https://caddyserver.com/docs/caddyfile/patterns) — SPA + API handle-block pattern
- [node-postgres.com/features/ssl](https://node-postgres.com/features/ssl) and multiple brianc/node-postgres GitHub issues (#2880, #3355, #2558, #2009) — `sslmode` query-param override behavior, `rejectUnauthorized` semantics

### Tertiary (LOW confidence — WebSearch only, flagged for validation)
- GHCR build-push-action exact current major/SHA pins — must be re-verified at implementation time
- pgBackRest/Caddy exact current stable version numbers — verify at Dockerfile-authoring time
- Docker Compose `service_completed_successfully` re-run bug — corroborated by a GitHub issue reference but not independently reproduced this session
- `oom_score_adj: -500` as "enterprise standard" — a commonly-repeated community heuristic, not a formal specification; the actual number remains an operator/planner decision per CONTEXT.md

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every major choice was already locked in CONTEXT.md; this document only verifies mechanics (drizzle journal parity confirmed via official docs)
- Architecture: HIGH for the overall topology (fully specified in CONTEXT.md); MEDIUM for the exact `/readyz` journal-hash comparison mechanism (flagged as Open Question 1, requires source-level verification before implementation)
- Pitfalls: MEDIUM-HIGH — several newly-surfaced pitfalls (sslmode override, compose re-run bug, stale snapshot-count figure) are corroborated by direct code inspection or well-documented upstream issues, not single-source speculation
- DB-12 constraint inventory: HIGH for the confirmed gap (`member`), MEDIUM for the secondary candidate (`invitation`) which requires planner/operator judgment on intent

**Research date:** 2026-08-12
**Valid until:** 30 days (stack versions and third-party action SHAs move fast; the architectural decisions themselves, being locked in CONTEXT.md, do not expire on the same clock)
