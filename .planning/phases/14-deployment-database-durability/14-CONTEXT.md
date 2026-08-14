# Phase 14: Deployment & Database Durability - Context

**Gathered:** 2026-08-12
**Status:** Ready for planning

<domain>
## Phase Boundary

The platform can be deployed, rolled back and restored — and the database survives migrations, disasters and the passage of time. Covers OPS-01…OPS-05 and DB-05…DB-07, DB-09…DB-14 (см. `.planning/REQUIREMENTS.md`): Dockerfiles for `api`/`web`/`worker`, one reproducible deploy command to the VPS with a documented rollback, `/healthz` + `/readyz` (readiness gates on Postgres, Redis AND completed migrations), exactly-once gated migrations that survive an unclean death, a rehearsed rollback/roll-forward procedure, automated backups with PITR and an actually-performed restore drill, defined and applied retention, the missing constraints added after data verification, Postgres TLS, and pooling with error handlers on every pool.

**Already locked at ROADMAP level (do not re-litigate):**
- **OPS-04/OPS-05 land before OPS-02.** Deployment automation gates on `/readyz`, never on a timer — build the health endpoints first.
- **DB-05 (Pitfall 16):** `pg_try_advisory_lock` in a bounded retry loop with a loud failure path — never a blocking `pg_advisory_lock`. Lock taken on a **dedicated short-lived connection** closed when the migration step ends, never on a pooled connection. One explicit one-shot `migrate` step runs to completion before `api`/`worker` start; the advisory lock is the safety net for concurrent deploys, not the primary mechanism. The unclean-death case is tested: kill the migration mid-run, confirm the next deploy proceeds.
- **DB-12 (Pitfall 17):** pre-migration duplicate-check query for every new constraint as its own reviewed step (`member (organizationId, userId)` plausibly has invite-race duplicates); `CREATE UNIQUE INDEX CONCURRENTLY` + `ADD CONSTRAINT ... UNIQUE USING INDEX`; assert `pg_index.indisvalid` afterwards. **Proven in-repo precedent: migration 0057** (duplicate pre-check without DELETE, `RAISE` unless `indisvalid`) — cite it, don't re-derive.
- **DB-07 (Pitfall 15):** rollback is two explicit tiers — auto-reversible additive migrations vs documented forward-only ones (enums, RLS policies, partition DDL). Backfilling the missing drizzle snapshots is an explicit task; the migration suite asserts `drizzle-kit generate` produces an empty diff against current schema.
- **DB-14 (Pitfall 10):** if PgBouncer were introduced it must be transaction-mode with reset-on-return, after Phase 10's bare-`SET`/`SET ROLE` audit (the `lint:session-state` CI gate — already green). Deferral is a legitimate outcome but must be recorded. **Resolved here: deferred — see D-09.**
- **Pitfall 19:** explicit per-container memory limits sized so no container's OOM can starve Postgres; `oom_score_adj` favours killing `worker`/`api` over `postgres`.
- **Pitfall 7 (joint with Phase 12):** the container stop grace period is derived and documented from SendGrid timeout + transaction margins — Phase 12 left the drain-budget derivation expressly for this phase to consume (see `apps/worker` queue-core constants / ARCHITECTURE.md drain-timeout section). Verified with a real SIGTERM sent mid-load-test, not just that shutdown starts.
- **DB-11 sits with DB-09/DB-10:** the rehearsed restore must exist **before** retention deletion is switched on.
- **DB-06 pairs with OPS-05:** "does not accept traffic until migrations complete" is implemented as readiness, not a startup sleep.
- **Worker deploy strategy (ROADMAP § Sequencing Decisions, R-05):** stop-old-then-start-new for the worker — a short queue pause is safe, overlapping incompatible dispatch code is not. **This phase also adds the two-version-compatibility scenario to Phase 8's failure-injection harness** (explicitly assigned to Phase 14 there — do not drop it).

</domain>

<decisions>
## Implementation Decisions

### Deploy topology & pipeline (OPS-01/02/03)

- **D-01:** **Production = one VPS, everything containerized.** Postgres, Redis, `api`, `web`, `worker` (plus Caddy, pgBackRest, one-shot `migrate`) run as containers under docker compose on a single VPS — the dev `docker-compose.yml` pattern promoted to a production compose file. Pitfall 19 (memory limits, `oom_score_adj` protecting Postgres) applies directly on this host. — **Reversibility:** costly — backup destination, TLS posture, restore-drill mechanics and the deploy script all assume co-located containers; moving Postgres off-host later re-opens DB-13's verify-full question and the backup topology.
- **D-02:** **Caddy fronts the platform.** One Caddy container terminates public HTTPS (automatic Let's Encrypt), serves the built `web` SPA static bundle, and reverse-proxies `/api` + the webhook endpoint to `api`. The `web` Dockerfile's output is the static bundle Caddy serves (exact image split — Caddy serving a volume vs a web image FROM caddy — planner discretion).
- **D-03:** **Images are built in CI and pulled from a registry.** GitHub Actions builds `api`/`web`/`worker` images on merge to `master`, pushes to GHCR tagged by git SHA; the VPS pulls tags. Images pin **Node 22 LTS** (per the stack doc; also sidesteps the known drizzle-kit hang under Node v26). Rollback (OPS-03) = redeploy the previous SHA tag — no rebuild, no manual surgery. — **Reversibility:** reversible — switching to build-on-VPS later is a script change.
- **D-04:** **Deploys are operator-triggered, one reproducible command.** A deploy script (`deploy.sh <sha>` shape) invoked by the operator: pulls the tagged images, runs the one-shot migrate step, waits on `/readyz`, flips containers (worker via stop-old-then-start-new per R-05). A human decides WHEN; the command is what's reproducible. CI auto-deploy explicitly rejected for now — every merge becoming a prod deploy is heavier than a single-operator project wants mid-hardening.

### Backups, restore drill & retention (DB-09/10/11)

- **D-05:** **pgBackRest provides backups + PITR.** Runs as a sidecar container sharing the Postgres data volume: scheduled full/diff/incremental backups, continuous WAL archiving, built-in retention expiry and verification. `pg_dump` already ruled out in REQUIREMENTS (no PITR); WAL-G and provider-snapshot approaches rejected as weaker-tooling variants of the same idea. — **Reversibility:** reversible — the repo format is tool-specific but replacing the tool restarts the backup chain, not the platform.
- **D-06:** **Backup destination = S3-compatible object storage**, off-host (S3/B2/Hetzner Object Storage — provider is planner/operator discretion), with pgBackRest repo-cipher encryption at rest. One new credential set lands in the externally-resolved env file (`MEGA_CRM_ENV_FILE` convention). A backup living only on the VPS is explicitly not acceptable.
- **D-07:** **Restore drill (DB-10) = scripted PITR into a scratch container on the VPS.** Restore the latest backup + WAL replay to a target timestamp into a throwaway Postgres container, verify expectations (row counts, partitions present, RLS enabled+forced posture), destroy it. Scripted so the drill is repeatable, written up as the DB-10 runbook. Full fresh-VPS DR rehearsal noted as a stretch variant, not the baseline.
- **D-08:** **Retention (DB-11): drop `events`/`send_events` monthly partitions after ~12 months.** Partition drop is the deletion mechanism (instant, no DELETE churn); the horizon is a versioned constant with rationale comment. Evidence tables persist: `sends` ledger, rollups, consent history, `erasure_records`, hashed suppression are untouched — Phase 13's erasure-evidence model survives retention. Journal/quarantine/dead-letter/failed-jobs retention already bounded in Phases 12–13 (documented, not rebuilt). Ordering: retention switches on only after D-07's drill has actually been performed. — **Reversibility:** one-way — dropped partitions are gone; only the backup horizon (pgBackRest retention window) can recover recently-dropped data, and only until backups expire.

### PgBouncer & Postgres TLS posture (DB-13/14)

- **D-09:** **PgBouncer deferred to SCALE-02 — recorded as an explicit accepted decision** (milestone DoD language: owner = operator, revisit trigger = real `max_connections` pressure, e.g. sustained connection count approaching the configured ceiling). Rationale: single VPS, single `api` + single `worker` instance, ~8 app-level pools — pressure is theoretical. Standing preconditions if ever introduced: transaction-mode + reset-on-return, Phase 10's bare-`SET` audit stays green (`lint:session-state`), DB-05's advisory lock must stay on a direct connection. A documented connection budget (sum of pool maxima vs `max_connections`) proves headroom this phase.
- **D-10:** **Postgres TLS (DB-13) = ssl=on with a self-signed cert, clients `sslmode=require`.** Satisfies DB-13 literally at low cost across the docker network; config is already correct the day Postgres moves off-host. `verify-full` + CA management explicitly deferred until a real network path exists (noted alongside D-09's revisit trigger).
- **D-11:** **Pool guarantee enforced by construction: shared `createPgPool()` factory** in `packages/db` wiring the error handler, TLS options and sizing defaults; all ~8 `new Pool` sites (db index, tenant-context, scan, dead-letter writer, partition maintenance, operator scripts, test-support as applicable) migrate to it; a lint/test guard fails on any bare `new Pool` outside the factory — the same single-definition move `@mega-crm/queue-core` made for Redis options (WRK-11 precedent). — **Reversibility:** reversible — mechanical extraction, same constants.

### Migration runner & readiness gating (DB-05/06/07, OPS-04/05)

- **D-12:** **Migrations run via a programmatic runner script** (drizzle-orm `migrate()` over the checked-in `packages/db/migrations` folder), not the drizzle-kit CLI: opens one dedicated connection, takes `pg_try_advisory_lock` in a bounded retry loop, runs the pending migrations, releases, exits loudly non-zero on failure. Full control over DB-05's lock-on-dedicated-connection semantics, which the CLI cannot express; also routes around the known drizzle-kit hang under Node v26. **Research must verify** drizzle-orm `migrate()` journal parity with the CLI (same `__drizzle_migrations` bookkeeping) before the swap. The runner ships as the one-shot `migrate` step in the deploy (compose `run`/service shape — planner discretion). — **Reversibility:** reversible — the migrations folder and journal are unchanged; the CLI remains usable in dev.
- **D-13:** **`/readyz` independently verifies applied-vs-shipped migrations.** Each image knows the migration set it was built with; readiness checks Postgres reachability, Redis reachability, AND that every shipped migration appears in drizzle's journal table. A container started against a stale database refuses readiness even if someone bypasses the deploy script — OPS-05's guarantee holds by construction, not by sequencing. `/healthz` stays pure process-liveness.
- **D-14:** **The worker gets a tiny localhost-only HTTP health server** serving `/healthz` + `/readyz` with the same semantics as the API's. Docker healthchecks and the deploy script probe all three services uniformly; Phase 15's observability reuses the port. (The API's endpoints live in the existing Fastify app.)
- **D-15:** **DB-07 rehearsal is scripted into CI + a runbook.** The migration test suite gains a rehearsal scenario: apply full history, revert the newest auto-reversible tier, roll forward again, assert schema equality — running on every PR so the rehearsal cannot rot. The forward-only tier (enums, RLS, partition DDL) gets its documented recovery path (restore-based, leaning on D-05/D-07) in the runbook. Snapshot backfill + `drizzle-kit generate` empty-diff smoke test per the ROADMAP lock.

### Claude's Discretion

- Compose file layout (single prod compose vs override files), exact image/tag naming, Caddyfile shape, and whether `web` is a volume Caddy serves or an image FROM caddy.
- Deploy script internals: failure handling, `/readyz` wait timeout, how stop-old-then-start-new sequences worker vs api, where the script lives (repo vs VPS).
- pgBackRest schedule (full/diff/incr cadence), repo retention window, cipher mode, stanza layout; restore-drill verification query set; drill recurrence cadence.
- Exact partition-drop horizon constant, where the drop runs (extend `partition-maintenance.worker.ts` vs operator CLI — note Phase 9's D-08 precedent that destructive relocation was operator-only; planner must decide whether scheduled partition DROP crosses the same line and may choose operator-confirmed drops).
- Pool sizing defaults and the connection-budget numbers; `createPgPool` API shape; which operator scripts adopt the factory vs keep bespoke pools.
- DB-12 constraint inventory (which constraints are missing — researcher task; `member (organizationId, userId)` is the named suspect), duplicate-check queries, and cleanup strategy for any duplicates found.
- Container memory limit values and `oom_score_adj` numbers (sized to the actual VPS RAM — operator supplies the figure at plan/execution time).
- Health-server port, probe intervals, healthcheck retries/timeouts.
- Two-version-compatibility harness scenario shape (which payload `schemaVersion` pair it exercises).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and phase boundaries
- `.planning/ROADMAP.md` § Phase 14 — goal, 5 success criteria, sequencing/pitfall notes (Pitfalls 7/10/15/16/17/19, DB-06↔OPS-05 pairing, DB-10-before-DB-11 ordering) **and § Sequencing Decisions** — stop-old-then-start-new for the worker + the two-version-compatibility scenario assigned to this phase
- `.planning/REQUIREMENTS.md` — OPS-01…OPS-05, DB-05…DB-07, DB-09…DB-14 (DB-08 complete in Phase 8; SCALE-01/02 explicitly future)
- `.planning/AUDIT-2026-07-27-production-readiness.md` — v1.1 requirements source; deployment/database findings
- `.planning/research/PITFALLS.md` — Pitfall 7 (container stop grace), 10 (transaction-mode pooling vs session state), 15 (forward-only drizzle migrations), 16 (advisory-lock migration gating), 17 (CONCURRENTLY + invalid index), 19 (OOM starving Postgres)

### Existing deployment/database code (as-is state)
- `docker-compose.yml` + `docker/redis.conf` + `docker/init-app-role.sql` — dev-only compose (Postgres 17, Redis 7 with WRK-12 durability config); the pattern D-01 promotes; no Dockerfiles exist yet, no healthz/readyz anywhere, no TLS on any pg connection
- `scripts/migrate-dev.mjs` + `scripts/env-path.mjs` — current migration entry (predev, drizzle-kit CLI via `npm run db:migrate`) and the `MEGA_CRM_ENV_FILE` resolution convention every new script/credential follows
- `packages/db/migrations/` (63 entries) + `packages/db/drizzle.config.ts` — the migration history D-12's runner must replay identically and D-15's rehearsal exercises; migration `0057_send_events_dedup_rebase.sql` is the DB-12 pattern precedent (duplicate pre-check, `indisvalid` RAISE)
- `packages/db/src/index.ts`, `packages/tenant-context/src/index.ts`, `packages/tenant-context/src/scan.ts`, `apps/worker/src/queues/dead-letter/dead-letter-writer.ts`, `apps/worker/src/queues/partition-maintenance.worker.ts`, `packages/db/scripts/*.ts` — the `new Pool` sites D-11's factory absorbs
- `apps/worker/src/queues/partition-maintenance.worker.ts` + `ensurePartitions` — the tick D-08's partition-drop retention naturally extends (same catalog-driven walk, opposite end of the timeline); Phase 9's CHECK-constraint-first and operator-only-relocation conventions
- `apps/worker/src/server.ts` — `WorkerRuntime` boot/shutdown; where D-14's health server and the documented drain budget live
- `scripts/ensure-db-roles.mjs` — role bootstrap the production Postgres container needs an equivalent of (dev uses `docker/init-app-role.sql` + this script)
- `scripts/lint-session-state.mjs` — the CI-enforced bare-`SET` audit that is D-09's standing PgBouncer precondition
- `.github/workflows/` — existing CI (static/test/failure-injection/e2e) that D-03's image-build job joins

### Phase 8–13 infrastructure this phase builds on
- `.planning/phases/12-worker-reliability-tenant-fairness/12-CONTEXT.md` — the drain-timeout derivation left for this phase's stop grace period (WRK-07/Pitfall 7); `queue-core` single-definition precedent D-11 mirrors
- `.planning/phases/11-delivery-correctness/11-CONTEXT.md` — `schemaVersion` deploy-safety contract the two-version-compatibility scenario proves; reconciler/watchdog patterns
- `.planning/phases/09-partition-automation-boundary-safety/09-CONTEXT.md` — partition machinery conventions (versioned constants, operator-only destructive ops, watchdog/`OPERATOR_ALERT_EMAIL` stack any new backup/retention alerting reuses)
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md` — failure-injection harness (the two-version scenario and DB-05's unclean-death test join it); migration test suite D-15 extends; root-hygiene/env conventions
- `ARCHITECTURE.md` — §9 delivery state machine + drain-timeout section (stop-grace input); gains deployment topology + backup/restore + retention sections this phase
- `CONVENTIONS.md` — versioned-constants rule; gains pool-factory / TLS / deploy conventions as applicable

### Documents that MUST be updated in the same change
- `SPECIFICATION.md` — §2 (any new packages/deps: pgBackRest tooling, health server), §3 (S3 credentials, TLS cert paths, new env vars), §4 (retention policy, new constraints), §5 (partition-drop tick, migrate runner), §6 (`/healthz`/`/readyz` routes), §7 (backup/restore observability), §8 (deploy topology) — per the binding rule in `.claude/CLAUDE.md`
- `ARCHITECTURE.md` — deployment topology, migration gating flow, backup/PITR/restore model, retention model
- Runbooks — deploy, rollback, restore drill (DB-10 requires the write-up), forward-only migration recovery (D-15)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Dev `docker-compose.yml`** (Postgres 17 + Redis with proven `redis.conf`) — the compose vocabulary and the Redis durability config carry straight into the prod compose file.
- **`MEGA_CRM_ENV_FILE` resolver** (`scripts/env-path.mjs`, Phase 8) — the prod env file on the VPS follows the same out-of-repo convention; S3/TLS credentials join it.
- **Failure-injection harness** (13 scenarios, `packages/test-support`) — DB-05's unclean-death test, the two-version-compatibility scenario, and the mid-load SIGTERM verification are new scenarios on existing machinery.
- **Migration test suite** (`test:migrations`, empty + seeded DB) — D-15's rehearsal scenario and the snapshot-backfill smoke test extend it.
- **Partition-maintenance worker + watchdog stack** (`claimAlertSlot`, `OPERATOR_ALERT_EMAIL`) — D-08's partition-drop retention and any backup-failure alerting are additional consumers of the proven tick + watchdog pattern.
- **`queue-core` single-definition precedent** (WRK-11) — D-11's `createPgPool` factory + guard is the identical move for pg pools.
- **Migration 0057** — the DB-12 constraint-migration pattern (duplicate pre-check, no DELETE, `indisvalid` assert) already proven in this repo.

### Established Patterns
- Versioned constants with rationale comments (retention horizon, drain budget, pool sizes, readiness timeouts all follow it).
- Operator-invoked-only destructive operations (Phase 9 D-08) — planner must decide where scheduled partition DROP sits relative to this line.
- Expand/contract migration discipline + migration linter (DB-08) — the constraint migrations follow it.
- Fail-closed defaults everywhere — readiness refusing on stale migrations (D-13) is the same posture.
- Phase-branch → PR with blocking static/test/failure-injection CI checks; new CI jobs (image build) join the existing workflow.

### Integration Points
- New: `Dockerfile.api` / `Dockerfile.web` / `Dockerfile.worker` (or per-app Dockerfiles), prod compose file, Caddyfile, deploy script, pgBackRest config, migrate-runner script.
- `apps/api` — `/healthz` + `/readyz` routes (new module, no auth, excluded from rate-limit concerns at planner's discretion).
- `apps/worker/src/server.ts` — health server + verified stop-grace behavior.
- `packages/db` — `createPgPool` factory, migrate runner, snapshot backfill, constraint migrations, partition-drop retention.
- `.github/workflows/` — image build+push job.
- CI failure-injection job — unclean-death, two-version, mid-load SIGTERM scenarios.

</code_context>

<specifics>
## Specific Ideas

- **"The command is reproducible; the human decides when"** — the user's deploy philosophy: operator-triggered `deploy.sh <sha>`, no auto-deploy on merge while the platform is still being hardened.
- **A backup on the same VPS that dies with the VPS is not a backup** — off-host object storage is non-negotiable in D-06.
- **Readiness must hold by construction, not by sequencing** — the user chose applied-vs-shipped verification in `/readyz` specifically so a mis-sequenced container start cannot serve a stale schema.
- **Rehearsals must not rot** — DB-07's rehearsal was deliberately put in CI (every PR) rather than performed once and written up.

</specifics>

<deferred>
## Deferred Ideas

- **PgBouncer / external connection pooler** — explicitly deferred to SCALE-02 (D-09) with recorded preconditions and revisit trigger; not silently dropped.
- **Postgres TLS `verify-full` + managed CA** — deferred until Postgres has a real network path (D-10); revisit alongside any off-host move.
- **Full fresh-VPS DR rehearsal** — stretch variant of the restore drill (D-07); baseline is the scratch-container drill.
- **CI auto-deploy on merge** — rejected for now (D-04); revisit when deploy frequency makes the operator step a bottleneck.
- **Sentry, hosted logs, real alerting, Bull Board** — Phase 15 (OPS-06…OPS-15); this phase's observability is limited to health endpoints and the existing watchdog email channel.
- **Multi-instance workers / leader election** — SCALE-01, explicitly out of v1.1 scope (WRK-13 documents the single-instance constraint).

</deferred>

---

*Phase: 14-deployment-database-durability*
*Context gathered: 2026-08-12*
