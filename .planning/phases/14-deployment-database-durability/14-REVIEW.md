---
phase: 14-deployment-database-durability
reviewed: 2026-08-13T00:00:00Z
depth: standard
files_reviewed: 54
files_reviewed_list:
  - .github/workflows/ci.yml
  - .github/workflows/images.yml
  - apps/api/src/modules/campaigns/campaign-queues.ts
  - apps/api/src/modules/ops/health.ts
  - apps/api/src/server.ts
  - apps/worker/src/health-server.ts
  - apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts
  - apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts
  - apps/worker/src/queues/dead-letter/dead-letter-writer.ts
  - apps/worker/src/queues/partition-maintenance.worker.ts
  - apps/worker/src/server.ts
  - apps/worker/src/shutdown-budget.ts
  - docker/Dockerfile.api
  - docker/Dockerfile.web
  - docker/Dockerfile.worker
  - docker/docker-compose.prod.yml
  - docker/patch-workspace-mains.mjs
  - docker/pg-tls-entrypoint.sh
  - docker/pgbackrest/backup-entrypoint.sh
  - docker/pgbackrest/crontab
  - docker/pgbackrest/pgbackrest.conf
  - docker/postgres/Dockerfile
  - docker/postgres/init-prod-roles.sql
  - docker/postgres/prod-tls-entrypoint.sh
  - docker/prod.env.example
  - packages/db/migrations/0062_member_unique_org_user.sql
  - packages/db/migrations/0063_partition_retention_drops.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/scripts/audit-missing-constraints.ts
  - packages/db/scripts/check-empty-diff.ts
  - packages/db/scripts/rehash-suppressions.ts
  - packages/db/scripts/relocate-default-partition-rows.ts
  - packages/db/scripts/replay-webhook-journal.ts
  - packages/db/scripts/verify-restored-database.ts
  - packages/db/src/index.ts
  - packages/db/src/migration-journal.ts
  - packages/db/src/migration-tiers.ts
  - packages/db/src/partitions/index.ts
  - packages/db/src/partitions/maintenance-run.ts
  - packages/db/src/partitions/retention.ts
  - packages/db/src/pool.ts
  - packages/db/src/schema/partition-maintenance-runs.ts
  - packages/db/src/schema/partition-retention-drops.ts
  - packages/tenant-context/src/index.ts
  - packages/tenant-context/src/scan.ts
  - scripts/__tests__/deploy-script.test.mjs
  - scripts/__tests__/validate-prod-compose.test.mjs
  - scripts/check-spec-env-coverage.mjs
  - scripts/deploy.sh
  - scripts/lint-pg-pool-factory.mjs
  - scripts/migrate-runner.mjs
  - scripts/print-stop-grace-period.mjs
  - scripts/restore-drill.sh
  - scripts/validate-prod-compose.mjs
findings:
  critical: 1
  warning: 7
  info: 1
  total: 9
status: issues_found
---

# Phase 14: Code Review Report

**Reviewed:** 2026-08-13T00:00:00Z
**Depth:** standard
**Files Reviewed:** 54 of 115 files in scope (see note below)
**Status:** issues_found

## Summary

Phase 14 delivers the migration runner, health/readiness endpoints, the `createPgPool` factory, partition retention, Docker images, the production compose topology, the deploy/rollback script, pgBackRest backups, and the restore drill. The TypeScript (migration-journal, migration-tiers, pool.ts, health.ts/health-server.ts, shutdown-budget.ts, partitions/*, dead-letter-writer.ts) is unusually rigorous — every non-obvious decision carries an inline rationale, prior review findings are cross-referenced by ID, and the failure-injection tests genuinely assert behavior (not just "did not throw"). No bugs were found in that layer beyond one defense-in-depth inconsistency (WR-03).

The defects that *were* found sit at integration boundaries the TypeScript-level tests cannot see: how the container images actually run as their declared non-root users, how Compose's `${VAR}` interpolation turns an "unset" operator variable into a "set-but-empty" one before it reaches `psql`, and how the deploy/restore-drill shell scripts interact with values that live outside the source tree (the local working tree's checked-out commit, a password containing URL-special characters). The most serious of these (CR-01) plausibly breaks the phase's own stated goal for the `web` service (persistent ACME state across restarts) and has no automated check that would catch it, because neither the compose file nor `deploy.sh` health-gates on `web` at all.

**Scope note:** given the size of this phase (115 files), this review prioritized the new production-critical logic and the shell/YAML/SQL integration surface (migration runner, health checks, pool factory, partition retention, Docker/Compose, deploy and restore-drill scripts, and their direct tests) over generated schema files, package manifests, fixture inputs, and prose runbooks. 54 files were read in full; the remainder (chiefly `scripts/__fixtures__/**`, additional `packages/db/src/__tests__/*`, and `docs/runbooks/*.md`) were not opened for this pass.

## Critical Issues

### CR-01: `web` container runs as non-root with no ownership grant on its persistent ACME storage

**File:** `docker/Dockerfile.web:62-70` (cf. `docker/docker-compose.prod.yml:294-302`)
**Issue:** The runtime stage switches to `USER caddyweb` (uid 1000, no home directory) but never `chown`s `/data` or `/config` — the two paths `docker-compose.prod.yml` mounts named volumes onto specifically so that "Caddy's default `/data`/`/config` paths inside its image, given real volumes here, survive a restart" (compose file's own comment, lines 295-299). The upstream `caddy:2` image creates `/data` and `/config` as root during its own build (Caddy has never run as a non-root user by default), so those directories — and the named volumes Docker copies their content/ownership into on first attach — end up root-owned, mode `0755`. A process running as uid 1000 cannot write into a root-owned `0755` directory. At minimum, Caddy's ACME certificate/account storage under `/data/caddy` cannot persist (defeating the stated purpose of `mega_crm_caddy_data_prod`/`mega_crm_caddy_config_prod` and risking Let's Encrypt rate-limit exhaustion on every restart, the exact failure this code explicitly says it wants to avoid); at worst, Caddy fails to initialize its storage at all and the container does not come up.

This is compounded by two other facts already in this phase: (a) `web` has no `healthcheck:` in `docker-compose.prod.yml`, and (b) `scripts/deploy.sh` only health-gates on `api`'s `/readyz` and the `worker` container's Docker health status — it never checks `web` at all. A deploy where `web` fails to start (or silently loses ACME persistence) would still report "deploy of `<sha>` complete," on the one and only externally-reachable service in this topology (T-14-43).
**Fix:**
```dockerfile
# after: COPY --from=build --chown=caddyweb:caddyweb /app/apps/web/dist /srv/web
RUN mkdir -p /data /config && chown -R caddyweb:caddyweb /data /config
USER caddyweb
```
Additionally worth doing in the same change: add a `healthcheck:` to the `web` service (e.g. a plain HTTP probe against `/`) and have `scripts/deploy.sh` wait on it the same way it waits on `api`'s `/readyz`, so a broken `web` container fails the deploy loudly instead of silently.

## Warnings

### WR-01: `db` healthcheck can report healthy during Postgres's own first-boot bootstrap window

**File:** `docker/docker-compose.prod.yml:141-145`
**Issue:** `test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-postgres}"]` passes no `-h`, so it resolves the connection the same way the client library defaults (typically the local Unix socket). The official Postgres entrypoint runs a *temporary* server on the Unix socket only (no TCP) while it executes `docker-entrypoint-initdb.d/*` on a genuinely fresh volume — `pg_isready` without an explicit host can report "accepting connections" against that temporary server, before `init-prod-roles.sql` has finished creating `mega_crm_app`/`mega_crm_scan`/`mega_crm_auth` and before the real server (with `ssl=on`, `archive_mode=on`, etc.) is listening. `migrate`, `api`, `worker`, and `pgbackrest` all gate on `db: condition: service_healthy`; on the very first bring-up against a fresh `mega_crm_db_data_prod` volume this creates a race where a dependent container can start against the bootstrap server rather than the real one.
**Fix:** Force a TCP probe of the real listener: `pg_isready -h 127.0.0.1 -U ${POSTGRES_USER:-postgres}`.

### WR-02: Blank-password guard in `init-prod-roles.sql` does not fire in its most realistic failure mode

**File:** `docker/postgres/init-prod-roles.sql:57-73` (cf. `docker/docker-compose.prod.yml:93-95`)
**Issue:** The guard is `\getenv app_password MEGA_CRM_APP_PASSWORD` followed by `\if :{?app_password}` — this only detects an *unset* psql variable. But `docker-compose.prod.yml` delivers this value as `MEGA_CRM_APP_PASSWORD: ${MEGA_CRM_APP_PASSWORD}`; if the operator's env file never sets `MEGA_CRM_APP_PASSWORD`, Compose's own `${VAR}` substitution resolves to an empty string, and the container's environment variable is *set* (to `""`), not absent. `\getenv` therefore succeeds with `app_password = ''`, `\if :{?app_password}` evaluates true (defined), and the guard's own `RAISE EXCEPTION 'refusing to create ... with a blank password'` never runs — `CREATE ROLE mega_crm_app WITH LOGIN PASSWORD ''` executes instead. (In practice Postgres stores an empty password as no-password, so the role ends up unable to authenticate at all — a confusing downstream connection-auth failure rather than a weak credential — but the guard's own stated promise, "refuse to create a role with a blank password," is not delivered for the exact scenario it was written for: an operator who forgot to set the variable in their env file.)
**Fix:** Also assert non-emptiness, e.g. `\if :{?app_password}\if :'app_password' = ''` … or more simply, gate on both conditions in one guard:
```sql
\getenv app_password MEGA_CRM_APP_PASSWORD
SELECT CASE WHEN :'app_password' = '' THEN 1 ELSE 0 END AS is_blank \gset
DO $guard$ BEGIN IF :is_blank = 1 THEN RAISE EXCEPTION 'init-prod-roles: MEGA_CRM_APP_PASSWORD is unset or empty -- refusing to create mega_crm_app with a blank password.'; END IF; END $guard$;
```
(applies identically to `MEGA_CRM_SCAN_PASSWORD`/`MEGA_CRM_AUTH_PASSWORD`).

### WR-03: Partition-drop DDL interpolates catalog-sourced identifiers without the allowlist discipline used elsewhere in the same phase

**File:** `packages/db/src/partitions/retention.ts:272-273`
**Issue:** `dropExpiredPartitions` builds `ALTER TABLE ${partition.parentTable} DETACH PARTITION ${partition.partitionName}` and `DROP TABLE ${partition.partitionName}` by direct string interpolation of values read from `pg_class.relname` via the catalog query in `findExpiredPartitions`. This is not currently exploitable (both values are catalog-sourced, and `parentTable` additionally comes from the hardcoded `PARTITIONED_TABLES` config), but it is inconsistent with the discipline this same phase applies one file over: `verify-restored-database.ts`'s `checkRowCounts` explicitly validates every catalog-sourced relation name against `SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/` before interpolating it into `SELECT count(*) FROM "${relname}"`, specifically because "refusing anything else is cheap insurance against ever interpolating something else." `retention.ts` performs no equivalent check before running irreversible `DROP TABLE` DDL — the one operation this file's own header calls out as "the only IRREVERSIBLE operation this phase adds."
**Fix:** Validate `partition.partitionName` (and `partition.parentTable`) against the same identifier-shape regex before use, or quote both with `format('%I', ...)` server-side via a parameterized `format()` call, mirroring the discipline `verify-restored-database.ts` already established.

### WR-04: `validate-prod-compose.mjs`'s `oom_score_adj` invariant does not cover `pgbackrest`

**File:** `scripts/validate-prod-compose.mjs:459-474`
**Issue:** The check only evaluates `oom_score_adj` polarity for services literally named `"db"` (must be negative) or `"api"`/`"worker"` (must not be negative) — no `else` branch covers any other service. But `docker-compose.prod.yml`'s own comment for the `pgbackrest` service (line ~183) states explicitly: "a backup process must never win an OOM contest against the database it protects -- ... the SAME non-negative (kernel-default) oom_score_adj treatment `api`/`worker` get, never `db`'s protective -500" (T-14-65). The gate that is supposed to make every other "no local feedback loop" invariant machine-checked has no case for this one — a future accidental `oom_score_adj: -500` on `pgbackrest`, `web`, `redis`, or `migrate` would pass CI silently. Confirmed by reading the test fixtures for this gate (`scripts/__tests__/validate-prod-compose.test.mjs`): there is a `db-oom-non-negative.yml`/`non-db-oom-score-adj-negative.yml` pair covering `db` vs. `api`, but no fixture at all exercises a negative `oom_score_adj` on `pgbackrest`.
**Fix:** Extend the check to an explicit set of "never-negative" services (`api`, `worker`, `web`, `migrate`, `pgbackrest`, `redis`) rather than an `if (db) / else if (api || worker)` pair, and add a fixture that trips it for `pgbackrest`.

### WR-05: `deploy.sh` derives the worker's stop-grace-period from the local working tree, not from the target SHA being deployed

**File:** `scripts/deploy.sh:170-177, 303-306`
**Issue:** `resolve_worker_stop_grace_period` runs `npm run build -w apps/worker` against whatever is currently checked out on the deploy host, then reads `WORKER_STOP_GRACE_PERIOD_SECONDS` from that freshly-compiled output — it never verifies (or checks out) that the local tree matches `TARGET_SHA`. The whole point of `apps/worker/src/shutdown-budget.ts` and this exact script (per its own extensive commentary on Pitfall 7) is that the container's `stop_grace_period` must "MUST come from the published constant, NEVER a hand-typed literal" and must never disagree with what the *deployed image* actually does. If an operator runs `scripts/deploy.sh <sha>` from a checkout that isn't at `<sha>` (the ordinary case for `--rollback-to` an older commit, or any CI/multi-operator setup where the checkout lags or leads the SHA being deployed), the grace period exported to `docker compose stop --timeout ...` reflects the *locally checked-out* commit's `SENDGRID_TIMEOUT_MS`/margins, not the pulled image's. This is exactly the class of drift the script's own header says must never happen ("this script and that compose file are maintained together"), applied to the wrong axis (working tree vs. deployed SHA rather than working tree vs. compose file).
**Fix:** Either `git checkout "$TARGET_SHA" -- apps/worker packages/queue-core packages/delivery-core` (or the whole tree) before building, or — more robustly — extract the constant from inside the pulled `worker` image itself (e.g. `docker compose run --rm --entrypoint node worker apps/worker/dist/print-grace-period-equivalent.js`) so the number provably comes from what is actually about to run.

### WR-06: `restore-drill.sh` builds a connection URL by unencoded string interpolation of a password

**File:** `scripts/restore-drill.sh:364-365`
**Issue:** `VERIFY_RESTORED_DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${SCRATCH_PORT}/${POSTGRES_DB:-mega_crm}"` interpolates the real, restored cluster's superuser password directly into a URL with no percent-encoding. If that password (which "came back with the physical backup" per this script's own comment, i.e. is whatever `POSTGRES_PASSWORD` was at backup time, not a value this script controls) contains any URL-significant character (`@`, `:`, `/`, `#`, `%`, whitespace), the resulting string is not a valid connection URL — `new URL(...)` (used by `createPgPool`'s `assertDsnRequestsTls` in production, and by `pg-connection-string`'s own parser) will either throw or misparse the credential/host boundary, most likely misreading part of the password as the hostname. This would make every real restore drill against a password containing such a character fail with a confusing parse/auth error rather than the actual verification outcome.
**Fix:** `encodeURIComponent` the password before interpolating: `VERIFY_RESTORED_DATABASE_URL="postgresql://postgres:$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$POSTGRES_PASSWORD")@127.0.0.1:${SCRATCH_PORT}/${POSTGRES_DB:-mega_crm}"` (or an equivalent `jq -rn --arg p "$POSTGRES_PASSWORD" '$p|@uri'`).

### WR-07: No healthcheck (and no deploy-time gate) exists for the `web` service at all

**File:** `docker/docker-compose.prod.yml:284-307`, `scripts/deploy.sh:315-317`
**Issue:** Every other long-lived service in this compose file (`db`, `redis`, `api`, `worker`) has a `healthcheck:`, and `deploy.sh` explicitly waits on `api`'s `/readyz` and `worker`'s Docker health status before declaring success. `web` — the *only* service this topology publishes to the internet (T-14-43) — has neither. `compose up -d web api` in `deploy.sh` returns as soon as the containers are *started*, with no verification that Caddy actually finished acquiring/loading its TLS certificate or is serving traffic. This is independently true of CR-01 (a storage-permission failure) but is what makes CR-01 (and any other `web`-only failure) invisible to both the compose file's own health machinery and the deploy script.
**Fix:** Add a `healthcheck:` to `web` (e.g. `wget --spider -q http://127.0.0.1/` inside the Caddy container, or a `caddy validate`-based check) and have `deploy.sh` wait for it the same way it waits for `api`.

## Info

### IN-01: Migration-currency `onRequest` guard matches `request.url` by exact string, not path-only

**File:** `apps/api/src/server.ts:223-224`
**Issue:** `if (request.url === "/healthz" || request.url === "/readyz") return;` compares the full raw URL including any query string. A probe hitting `/readyz?foo=bar` (harmless today, but plausible for a future load-balancer health-check convention that appends a cache-buster) would fail this exact-match check and fall through into `ensureMigrationsCurrentOnce()` — functionally harmless once migrations are confirmed (the check short-circuits immediately after the first success) but pointless overhead on every subsequent request during the pre-confirmation window, and surprising if someone greps for "why did /readyz go through the migration guard."
**Fix:** Match on `request.url.split("?")[0]` or use Fastify's `request.routeOptions`/`request.url` path-only accessor if available in this Fastify version.

---

_Reviewed: 2026-08-13T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
