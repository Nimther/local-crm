# Phase 14: Deployment & Database Durability - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-12
**Phase:** 14-deployment-database-durability
**Areas discussed:** Deploy topology & pipeline, Backups restore drill & retention, PgBouncer & Postgres TLS posture, Migration runner & readiness gating

---

## Deploy topology & pipeline (OPS-01/02/03)

### Q1: What does the production environment look like?

| Option | Description | Selected |
|--------|-------------|----------|
| One VPS, all containerized | Postgres, Redis, api, web, worker as containers under docker compose — dev pattern promoted to prod | ✓ |
| One VPS + managed Postgres | Apps/Redis on VPS; Postgres managed/external (provider handles backups/PITR partly) | |
| Two hosts: app VPS + db VPS | Postgres on a separate VPS; TLS between hosts genuinely needed | |

### Q2: What serves the web SPA and terminates public HTTPS?

| Option | Description | Selected |
|--------|-------------|----------|
| Caddy (Recommended) | Automatic Let's Encrypt, serves SPA static files, reverse-proxies api | ✓ |
| nginx | More explicit config, certbot management | |
| Traefik | Label-driven docker-native proxy; heavier than needed for one VPS | |
| Already exists / other | Existing proxy/CDN in front | |

### Q3: How do images get built and delivered to the VPS?

| Option | Description | Selected |
|--------|-------------|----------|
| CI builds → registry → VPS pulls (Recommended) | GitHub Actions builds on merge, pushes to GHCR by git SHA; rollback = previous tag | ✓ |
| Build on the VPS from git | compose build on the server; burns VPS resources, rollback rebuilds | |
| Build locally → push to registry | Developer machine builds; reproducibility depends on builder | |

### Q4: Who triggers a production deploy?

| Option | Description | Selected |
|--------|-------------|----------|
| Operator runs one command (Recommended) | deploy.sh <sha> on/against the VPS; human decides when, command is reproducible | ✓ |
| CI auto-deploys on merge | Every green merge deploys; heavier than a single-operator project wants mid-hardening | |
| CI deploy job, manually triggered | workflow_dispatch button; deploy secrets live in GitHub | |

---

## Backups, restore drill & retention (DB-09/10/11)

### Q1: What tooling provides automated backups + PITR?

| Option | Description | Selected |
|--------|-------------|----------|
| pgBackRest (Recommended) | Full/diff/incr + WAL archiving, retention expiry, verification, S3-native; sidecar sharing data volume | ✓ |
| WAL-G | Lighter; less built-in verification/retention tooling | |
| Provider VPS snapshots + WAL archiving | Cheapest; weakest guarantees | |

### Q2: Where do backups live?

| Option | Description | Selected |
|--------|-------------|----------|
| S3-compatible object storage (Recommended) | Off-host, durable, repo-cipher encrypted; one new credential in the env file | ✓ |
| Second VPS / storage box | pgBackRest over SSH | |
| Local volume + rclone off-host sync | Window where the only copy is local | |

### Q3: What does the restore drill restore INTO?

| Option | Description | Selected |
|--------|-------------|----------|
| Scratch container on the VPS (Recommended) | Fresh throwaway Postgres container, PITR to timestamp, verify, destroy; scripted and repeatable | ✓ |
| Local/dev machine restore | Proves repo readable, not the VPS toolchain | |
| Full DR rehearsal on a fresh VPS | Strongest proof; noted as stretch variant | |

### Q4: Retention line for events/send_events partitions (DB-11)?

| Option | Description | Selected |
|--------|-------------|----------|
| Drop partitions after ~12 months (Recommended) | Partition-drop mechanism; evidence tables (sends, rollups, consent, hashed suppression) persist | ✓ |
| Drop after 24+ months | Longer forensic tail, ~2x storage | |
| No partition drops yet — define but don't enable | Weakest reading of "retention is applied" | |

---

## PgBouncer & Postgres TLS posture (DB-13/14)

### Q1: DB-14 — PgBouncer now or defer to SCALE-02?

| Option | Description | Selected |
|--------|-------------|----------|
| Defer to SCALE-02 (Recommended) | Explicit accepted decision with owner + revisit trigger; app pools get sizes + error handlers + connection budget | ✓ |
| Introduce PgBouncer now | Pays SET LOCAL/advisory-lock diligence for capacity nothing demands | |

### Q2: DB-13 — TLS for co-located dockerized Postgres?

| Option | Description | Selected |
|--------|-------------|----------|
| Enable TLS with self-signed cert (Recommended) | ssl=on, sslmode=require; verify-full deferred until a real network path exists | ✓ |
| Re-scope: documented accepted decision | Zero config; finding closes as accepted-risk | |
| Full verify-full setup now | Self-managed CA on one host where the threat model is thin | |

### Q3: How to enforce "every pool has an error handler"?

| Option | Description | Selected |
|--------|-------------|----------|
| Shared pool factory + guard (Recommended) | createPgPool() in packages/db; all sites migrate; lint/test guard on bare new Pool (WRK-11 precedent) | ✓ |
| Add handlers in place | Discipline, not construction | |
| You decide | Planner picks the mechanism | |

---

## Migration runner & readiness gating (DB-05/06/07, OPS-04/05)

### Q1: What runs migrations in the one-shot migrate step?

| Option | Description | Selected |
|--------|-------------|----------|
| Programmatic runner script (Recommended) | drizzle-orm migrate() with pg_try_advisory_lock on a dedicated connection, bounded retry, loud failure; Node 22 LTS images | ✓ |
| Keep drizzle-kit CLI, wrap it | Lock held by a different connection than the migrator — split-brain risk | |
| You decide | | |

### Q2: How does /readyz know migrations completed?

| Option | Description | Selected |
|--------|-------------|----------|
| Verify applied vs shipped (Recommended) | Image knows its migration set; readiness checks the drizzle journal; stale-DB container refuses readiness | ✓ |
| Ordering only | Guarantee lives solely in deploy sequencing | |
| You decide | | |

### Q3: Worker health/readiness exposure?

| Option | Description | Selected |
|--------|-------------|----------|
| Tiny HTTP health server in worker (Recommended) | localhost-only /healthz + /readyz; uniform gate across all three services; Phase 15 reuses the port | ✓ |
| Healthcheck script command | Docker exec probe; readiness semantics in two shapes | |
| You decide | | |

### Q4: DB-07 rollback/roll-forward rehearsal shape?

| Option | Description | Selected |
|--------|-------------|----------|
| Scripted rehearsal in CI + runbook (Recommended) | Apply history, revert newest auto-reversible tier, roll forward, assert schema equality — every PR; forward-only tier documented restore path | ✓ |
| One-time manual rehearsal + runbook | Satisfies "rehearsed" literally but decays | |
| Restore-based rollback only | Every bad additive migration becomes a restore event | |

---

## Claude's Discretion

- Compose layout, image/tag naming, Caddyfile shape, web-image split
- Deploy script internals (failure handling, readyz wait, stop-old-then-start-new sequencing)
- pgBackRest schedule/retention/cipher; drill verification queries and cadence
- Partition-drop horizon constant and whether the drop is scheduled or operator-confirmed (Phase 9 D-08 tension noted)
- Pool sizing, connection budget, createPgPool API shape
- DB-12 constraint inventory (researcher), duplicate-check queries
- Memory limits / oom_score_adj values (needs actual VPS RAM figure)
- Health-server port and probe parameters
- Two-version-compatibility harness scenario shape

## Deferred Ideas

- PgBouncer / external pooler → SCALE-02 (explicit accepted decision with preconditions)
- Postgres TLS verify-full + managed CA → when Postgres has a real network path
- Full fresh-VPS DR rehearsal → stretch variant of the restore drill
- CI auto-deploy on merge → revisit when operator step becomes a bottleneck
- Sentry / hosted logs / real alerting / Bull Board → Phase 15
- Multi-instance workers / leader election → SCALE-01
