---
phase: 14-deployment-database-durability
plan: 08
subsystem: infra
tags: [docker-compose, postgres, tls, oom, ci-gate, psql, sizing]

requires:
  - phase: 14-03
    provides: "packages/db/src/pool.ts's PG_POOL_SIZES summed total (84, one instance each of apps/api+apps/worker) -- the max_connections floor this plan configures Postgres above; the sslmode=require&uselibpqcompat=true DSN requirement documented in the runbook and prod.env.example"
  - phase: 14-04
    provides: "scripts/print-stop-grace-period.mjs -- the machine-read value this plan's worker.stop_grace_period interpolates and the CI gate drift-checks against"
  - phase: 14-06
    provides: "the three GHCR image names/SHA-tag scheme, docker/Caddyfile's {$SITE_ADDRESS} placeholder and api:4000 upstream, docker/Dockerfile.api's migrate-runner.mjs command"
provides:
  - "docker/docker-compose.prod.yml -- the six-service production topology (db/redis/api/worker/web/migrate), SHA-tagged first-party images, TLS Postgres, per-container memory limits + oom_score_adj, parameterized max_connections/shared_buffers, migrate as a profile-excluded one-shot, worker stop_grace_period as an interpolated-only variable, only web publishing ports"
  - "docker/postgres/init-prod-roles.sql -- idempotent production role bootstrap (mega_crm_app/scan/auth) reading passwords via psql's \\getenv, fail-loud on a missing password"
  - "docker/postgres/prod-tls-entrypoint.sh -- production TLS entrypoint (separate from dev's), adds the max_connections/shared_buffers -c overrides"
  - "docker/prod.env.example -- every variable name this compose file and the applications require, documented, no credential values"
  - "scripts/validate-prod-compose.mjs + npm run verify:prod-compose -- CI-enforced gate over every compose invariant with no local feedback loop"
  - "docs/runbooks/production-topology.md -- sizing derivation, minimum-viable-VPS arithmetic, secret provenance, D-09/D-10 revisit triggers"
affects: ["14-09 (deploy script orchestrates this compose file: docker compose run --rm migrate, then up -d, exporting WORKER_STOP_GRACE_PERIOD_SECONDS/GHCR_IMAGE_BASE/IMAGE_TAG/SITE_ADDRESS/MEGA_CRM_ENV_FILE first)", "14-13 (SPECIFICATION.md filing -- see 'SPECIFICATION.md items for 14-13' below)", "any future plan changing PG_POOL_SIZES's summed total, SENDGRID_TIMEOUT_MS/CLAIM_TX_MARGIN_MS/RECORD_TX_MARGIN_MS, or the image naming scheme"]

tech-stack:
  added: []
  patterns:
    - "Every production sizing knob (memory limits, oom_score_adj, max_connections, shared_buffers) is an env var with a `${VAR:-default}` fallback in the compose file itself, never a hand-typed literal -- checkpoint decision 'parameterize-with-minimum'"
    - "A hand-rolled, scoped YAML-subset parser (Node built-ins only) for the ONE compose file this repo authors and maintains together with its own gate script, in the same class as scripts/lint-session-state.mjs/scripts/lint-pg-pool-factory.mjs hand-rolling their own scoped parsers rather than adding a dependency"
    - "psql's \\getenv + \\if :{?var} + a variable-free `DO $$ RAISE EXCEPTION $$` guard for fail-loud env-var presence checks inside a docker-entrypoint-initdb.d SQL file -- discovered empirically that \\quit does not accept/honor a numeric exit code in this Postgres version, so a RAISE EXCEPTION (a real SQL error, propagated by ON_ERROR_STOP) is what actually fails the container's init loudly"
    - "psql variable substitution (:'var') does not apply inside a dollar-quoted ($$...$$) PL/pgSQL body -- confirmed empirically; the `SELECT ... WHERE NOT EXISTS (...) \\gexec` pattern keeps every substitution at top-level SQL text instead of inside a DO block"

key-files:
  created:
    - docker/docker-compose.prod.yml
    - docker/postgres/init-prod-roles.sql
    - docker/postgres/prod-tls-entrypoint.sh
    - docker/prod.env.example
    - scripts/validate-prod-compose.mjs
    - scripts/__tests__/validate-prod-compose.test.mjs
    - scripts/__fixtures__/prod-compose/missing-mem-limit.yml
    - scripts/__fixtures__/prod-compose/db-oom-non-negative.yml
    - scripts/__fixtures__/prod-compose/non-db-oom-score-adj-negative.yml
    - scripts/__fixtures__/prod-compose/non-web-service-publishes-port.yml
    - scripts/__fixtures__/prod-compose/mutable-image-tag.yml
    - scripts/__fixtures__/prod-compose/max-connections-at-floor.yml
    - scripts/__fixtures__/prod-compose/stop-grace-period-drift.yml
    - scripts/__fixtures__/prod-compose/migrate-not-excluded.yml
    - docs/runbooks/production-topology.md
  modified:
    - package.json
    - .github/workflows/ci.yml

key-decisions:
  - "Checkpoint resolved as 'parameterize-with-minimum' (the user's verbatim selection): no VPS provisioned yet, so every sizing value (DB_MEM_LIMIT, REDIS_MEM_LIMIT, API_MEM_LIMIT, WORKER_MEM_LIMIT, WEB_MEM_LIMIT, MIGRATE_MEM_LIMIT, DB_OOM_SCORE_ADJ, PG_MAX_CONNECTIONS, PG_SHARED_BUFFERS) is an env var with a documented conservative default, never a hardcoded literal in the compose file. Minimum viable VPS derived and recorded: 8GB RAM / 2vCPU (4vCPU recommended) -- see docs/runbooks/production-topology.md's 'Minimum viable VPS' section for the full arithmetic (steady-state mem_limit sum 4608MiB, +512MiB migrate transient peak, x1/0.6 for ~40% OS/page-cache/burst headroom, rounded up)."
  - "PG_MAX_CONNECTIONS default 200, not merely '>84' -- deliberately covers a rolling-restart transient doubling of the single-instance pool sum (84 -> ~168) plus superuser_reserved_connections plus concurrent operator scripts, not just the steady-state single-instance figure."
  - "Two separate TLS entrypoint scripts (docker/pg-tls-entrypoint.sh for dev/CI, docker/postgres/prod-tls-entrypoint.sh for production), not one script with a runtime branch -- the production posture (the one that matters during an incident) stays reviewable on its own; mirrors docker/redis.conf's own precedent of NOT parameterizing dev's fixed sizing."
  - "init-prod-roles.sql covers the FULL role set (mega_crm_app + mega_crm_scan + mega_crm_auth) in one first-boot file, unlike dev's split between docker/init-app-role.sql (first-boot) and scripts/ensure-db-roles.mjs (catch-up for existing volumes) -- production has no developer machine to run a catch-up pass, so there is no second file to split the work with."
  - "init-prod-roles.sql uses `SELECT ... WHERE NOT EXISTS (...) \\gexec` instead of `DO $$ IF NOT EXISTS THEN ... END IF $$` -- found empirically (see below) that psql's own `:'var'` substitution does not apply inside a dollar-quoted PL/pgSQL body at all, which silently breaks password interpolation if written the more natural-looking way."
  - "The missing-password guard inside init-prod-roles.sql uses a `DO $$ RAISE EXCEPTION $$` block, not `\\quit 1` -- found empirically (see below) that `\\quit` in this Postgres version ignores/does not honor a numeric exit-code argument and still exits 0, which would make a tripped guard look like a SUCCESSFUL initdb to docker-entrypoint.sh."
  - "The compose-invariant gate's Docker-less YAML fallback is a hand-rolled, scoped parser (Node built-ins only), not the `yaml` npm package -- `yaml` is only ever a transitive devDependency of other tooling in this repo (eslint/vitest), never a declared first-party dependency, and depending on it here would rely on a package this repo's own package.json does not record."
  - "api's/worker's Docker healthcheck probes /readyz, not /healthz -- their ports are never published (T-14-43), so the container's OWN health status (Docker `inspect`/`compose ps`) is the ONLY way the deploy script (plan 14-09) can observe true readiness rather than mere liveness."
  - "web (Caddy) gets persistent /data and /config volumes (mega_crm_caddy_data_prod/mega_crm_caddy_config_prod) -- a Rule 2 completion not named in the plan text: without them, every container restart re-issues a fresh ACME certificate for the same domain, risking Let's Encrypt rate limits."

requirements-completed: [OPS-01, OPS-02, DB-13]

coverage:
  - id: D1
    description: "docker/docker-compose.prod.yml declares all six services (db, redis, api, worker, web, migrate); every service has an explicit mem_limit; db carries a negative oom_score_adj while api/worker do not; only web publishes ports (80/443); no :latest tag, no build: section anywhere in the committed file"
    requirement: "OPS-01"
    verification:
      - kind: unit
        ref: "grep -v '^\\s*#' docker/docker-compose.prod.yml | grep -c ':latest' -> 0; same for 'build:' -> 0"
        status: pass
      - kind: unit
        ref: "node -e requiring the 'yaml' package (ad hoc, not committed) to parse docker/docker-compose.prod.yml -- confirmed valid YAML, 6 services, only web has a non-null ports list (['80:80','443:443'])"
        status: pass
      - kind: integration
        ref: "npm run verify:prod-compose (scripts/validate-prod-compose.mjs, YAML-fallback path) -- 6 services, 29 invariants checked, 0 violations"
        status: pass
      - kind: manual_procedural
        ref: "docker compose -f docker/docker-compose.prod.yml --env-file docker/prod.env.example config"
        status: unknown
    human_judgment: true
    rationale: "No Docker daemon and no `docker compose` subcommand exist in this sandbox (confirmed directly: `docker compose` -> 'unknown command'; `docker info` -> no daemon socket). Per this worktree's repo-specific rules, scripts/validate-prod-compose.mjs's own YAML-parsing fallback is the local proof; a human (or CI, which DOES have Docker) must run the exact `docker compose ... config` command above from a clean checkout to close this."
  - id: D2
    description: "docker/postgres/init-prod-roles.sql creates mega_crm_app/mega_crm_scan/mega_crm_auth with the same grant shape as dev, idempotent, reading passwords via psql \\getenv, fail-loud on a missing password"
    requirement: "DB-13"
    verification:
      - kind: integration
        ref: "Real local Postgres (this sandbox's Homebrew psql 17.10 + native Postgres, not Docker): first run against a fresh throwaway database created all three roles with the correct attributes (rolcanlogin=t, rolsuper/rolcreatedb/rolcreaterole/rolbypassrls=f) and set the database owner to mega_crm_app; second run (idempotency) produced zero errors and zero duplicate-role errors"
        status: pass
      - kind: integration
        ref: "Missing-password guard: unset MEGA_CRM_SCAN_PASSWORD against a fresh database -- script exits non-zero (exit code 3) and prints the exact 'refusing to create mega_crm_scan with a blank password' message; confirmed mega_crm_app/mega_crm_auth end up created (script processes top-to-bottom and aborts at the first missing var) but mega_crm_scan does not -- a partial-but-loudly-failed init, not a silent success, matching this repo's fail-loud convention"
        status: pass
    human_judgment: false
  - id: D3
    description: "docker/postgres/prod-tls-entrypoint.sh sets ssl=on plus the parameterized max_connections/shared_buffers -c overrides; separate from the dev/CI entrypoint"
    requirement: "DB-13"
    verification:
      - kind: unit
        ref: "bash -n docker/postgres/prod-tls-entrypoint.sh (syntax check, this sandbox has bash but no Docker); scripts/validate-prod-compose.mjs's bonus checkTlsEntrypointServesSsl grep-confirms ssl=on is present on disk"
        status: pass
      - kind: manual_procedural
        ref: "docker compose -f docker/docker-compose.prod.yml --env-file <real secrets> up -d db; docker compose exec -T db psql -U postgres -tAc 'SHOW ssl'"
        status: unknown
    human_judgment: true
    rationale: "Same no-Docker-daemon constraint as D1 -- the certificate-generation/chown/exec mechanism mirrors plan 14-03's dev entrypoint exactly (proven end-to-end there against a real Postgres container in CI), but this specific script's exec line has not been run inside an actual postgres:17 container in this sandbox."
  - id: D4
    description: "scripts/validate-prod-compose.mjs asserts every compose invariant with no local feedback loop (mem_limit, db oom_score_adj negative / api+worker not, worker stop_grace_period drift against a fresh print-stop-grace-period.mjs run, published-port exclusivity to web, immutable first-party image tags, max_connections above 84, migrate's profile exclusion) and reports service/invariant counts"
    requirement: "OPS-02"
    verification:
      - kind: unit
        ref: "npx vitest run --root scripts __tests__/validate-prod-compose.test.mjs -- 17/17 pass (value-normalization helpers, the committed file passing with a non-zero count, one fixture per required failing invariant plus the bonus non-db-oom fixture, and a vacuous-scan-is-impossible assertion)"
        status: pass
      - kind: integration
        ref: "npm run verify:prod-compose -- exits 0, prints '6 service(s), 29 invariant(s) checked.'"
        status: pass
      - kind: integration
        ref: "npx vitest run --root scripts -- full lane, 5 test files / 64 tests, all pass (no regression in sibling guard scripts)"
        status: pass
      - kind: unit
        ref: "npm run lint (eslint . --max-warnings=0) -- 0 warnings; npm run build --workspaces --if-present -- all 15 workspaces clean"
        status: pass
    human_judgment: false
  - id: D5
    description: "docs/runbooks/production-topology.md documents the six services, published-port rule, secret convention, sizing derivation (including the max_connections and minimum-viable-VPS arithmetic), Pitfall 19 rationale, and both D-09/D-10 deferred decisions with revisit triggers"
    requirement: "OPS-01"
    verification:
      - kind: unit
        ref: "Direct read-back of docs/runbooks/production-topology.md against the plan's own action text checklist -- every named section present"
        status: pass
    human_judgment: false

duration: ~2h (continuation from a resolved checkpoint; no prior task work existed)
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 08: Production Compose Topology + Compose-Invariant CI Gate Summary

**One production `docker-compose.prod.yml` (db/redis/api/worker/web/migrate) with every Pitfall-19 memory/OOM safeguard, D-09's Postgres connection headroom, and the ARCHITECTURE.md §10 worker stop-grace-period all parameterized rather than hardcoded, backed by a new `scripts/validate-prod-compose.mjs` CI gate and a topology runbook recording the "parameterize-with-minimum" checkpoint's full sizing derivation.**

## Performance

- **Duration:** ~2h (continuation agent; the prior executor stopped at Task 0's blocking checkpoint with zero task work done)
- **Tasks:** 2 (Task 1: the compose file + Postgres bootstrap/TLS; Task 2: the CI gate + runbook)
- **Files created:** 15
- **Files modified:** 2 (`package.json`, `.github/workflows/ci.yml`)

## Accomplishments

- **`docker/docker-compose.prod.yml`**: six services promoting the development compose file's own vocabulary (named volumes, healthcheck style, the exact `docker/redis.conf` mount + `command:` override). `api`/`worker`/`web`/`migrate` reference `${GHCR_IMAGE_BASE}/<app>:${IMAGE_TAG}` only — no `:latest`, no `build:` anywhere (grep-confirmed over non-comment lines). `db` runs the new `docker/postgres/prod-tls-entrypoint.sh`, gets `PG_MAX_CONNECTIONS`/`PG_SHARED_BUFFERS` via environment (never a literal), an explicit `mem_limit` and a negative `oom_score_adj`; `api`/`worker` get `mem_limit` but no `oom_score_adj` override (the kernel default). `worker.stop_grace_period` is `${WORKER_STOP_GRACE_PERIOD_SECONDS}s` — an interpolated variable only. `migrate` carries the `manual` compose profile so a plain `up` never starts it, and its `depends_on: { db: { condition: service_healthy } }` is a safe health-wait, never the buggy `service_completed_successfully` completion condition RESEARCH.md's Pitfall C warns against. Only `web` declares a `ports:` mapping (`80:80`, `443:443`); `api`/`worker`'s Docker healthchecks probe `/readyz` (not just `/healthz`) since their ports are never published — the container's own health status is the only way the deploy script can observe true readiness from outside.
- **`docker/postgres/init-prod-roles.sql`**: the production role bootstrap, verified end-to-end against a REAL local Postgres (this sandbox's Homebrew `psql 17.10` + native server — no Docker daemon exists here) rather than merely reasoned through. Two genuine bugs were found and fixed by that verification, not assumed away:
  1. psql's `:'var'` substitution does **not** apply inside a dollar-quoted (`$$...$$`) PL/pgSQL body — a `DO $$ ... :'app_password' ... $$` block fails with a syntax error. Fixed by using `SELECT ... WHERE NOT EXISTS (...) \gexec` instead, which keeps every substitution at top-level SQL text.
  2. The originally-written `\quit 1` guard for a missing password does not actually fail loudly in this Postgres version — `\quit` ignores/does not honor a numeric exit-code argument and still exits 0. Fixed by raising a real SQL exception (`DO $$ RAISE EXCEPTION $$` — no variable substitution needed inside it, so bug #1 does not recur) instead, which propagates as psql's own error and a non-zero process exit under `ON_ERROR_STOP=1` (the official postgres image's own default for `docker-entrypoint-initdb.d/*.sql`).
  Confirmed via direct testing: first run creates all three roles correctly; second run is a true no-op (idempotent); a missing password aborts the whole script with exit code 3 and the correct message, leaving the specific role uncreated (a loud partial failure, not a silent success).
- **`docker/postgres/prod-tls-entrypoint.sh`**: mirrors plan 14-03's dev TLS mechanism (self-signed cert into a dedicated volume, chown/chmod, exec `docker-entrypoint.sh postgres -c ssl=on ...`) but is a SEPARATE script that also owns the `max_connections`/`shared_buffers` `-c` overrides this plan's checkpoint decision requires — recorded as a deliberate two-scripts-not-one-branch decision, mirroring `docker/redis.conf`'s own precedent of not parameterizing dev's fixed sizing.
- **`docker/prod.env.example`**: every variable the compose file and the applications require (cross-checked against `scripts/check-env.mjs`'s own required-variable list, `apps/api/src/env.ts`, and `packages/kms/src/aws-provider.ts`'s AWS SDK default credential chain), each commented with what it is and where its real value comes from. No credential value anywhere — genuine secrets are always empty; non-secret sizing knobs and the deploy-identity variables (`GHCR_IMAGE_BASE`, `IMAGE_TAG`, `SITE_ADDRESS`) show real or placeholder-shaped values so `docker compose config` resolves cleanly against this file in isolation.
- **`scripts/validate-prod-compose.mjs`**: resolves the compose file via `docker compose config --format json` when available, else a hand-rolled `${VAR}`/`${VAR:-default}` substitution plus a line-based, scoped YAML-subset structural parse — Node built-ins only, no dependency on the `yaml` package (which is only ever a transitive devDependency of other tooling in this repo). The Docker-less fallback is not theoretical here: this sandbox's `docker compose` subcommand does not exist at all (confirmed directly), so every local/CI-static-job run of this gate in this environment exercises exactly that path. Asserts: every service has a positive memory limit; `db`'s `oom_score_adj` is negative while `api`/`worker`'s is not (if present); only `web` publishes a port; every first-party image (`api`/`worker`/`web`/`migrate`) resolves to a non-mutable tag; `PG_MAX_CONNECTIONS` exceeds 84 (plan 14-03's pool-sum floor); `migrate` carries a compose profile; and — the strictest check — `worker`'s resolved `stop_grace_period` matches a **fresh** invocation of `node scripts/print-stop-grace-period.mjs` exactly, not a remembered number. A bonus invariant beyond the plan's own `<behavior>` list (Rule 2: same class of "no local feedback loop" gap the plan's `<done>` criterion targets) greps the on-disk TLS entrypoint for `ssl=on`. Reports `N service(s), M invariant(s) checked` on every run so a vacuous scan is visible — currently `6 service(s), 29 invariant(s)`.
- **`scripts/__tests__/validate-prod-compose.test.mjs`** + 8 fixtures under `scripts/__fixtures__/prod-compose/`: 17 tests — value-normalization helper unit tests, the real committed file passing with a non-zero count (both via the exported function and the real CLI subprocess), one minimal fixture per required failing invariant (missing mem_limit, `db` non-negative `oom_score_adj`, non-`web` port publication, mutable image tag, `max_connections` at the floor, `migrate` missing its profile) plus a bonus fixture for `api`/`worker` carrying a negative `oom_score_adj`, a dedicated stop-grace-period drift fixture, a "compliant service trips nothing" fixture, and a vacuous-scan-is-impossible assertion (`EXPECTED_SERVICES.length` checks fire even against zero services).
- **`docs/runbooks/production-topology.md`**: the six services and why only `web` publishes ports; where every secret comes from (the `MEGA_CRM_ENV_FILE` convention, `env_file`'s `required: false` rationale); the full sizing derivation for every memory limit, `oom_score_adj`, `PG_MAX_CONNECTIONS` (with the deploy-time-doubling margin explained), and `PG_SHARED_BUFFERS`; the **minimum viable VPS arithmetic** (8GB RAM / 2vCPU floor, 4vCPU recommended, with the full byte-sum-then-headroom derivation shown); the risk that an un-revisited default becomes the production value by omission, stated explicitly per the user's checkpoint answer; the D-09 (PgBouncer) and D-10 (`verify-full` TLS) revisit triggers; the dev-vs-prod TLS entrypoint script split rationale; and the `migrate` service's profile-exclusion mechanism.

## Task Commits

1. **Task 1: The production compose file (+ Postgres bootstrap/TLS)** — `79f2a0e` (feat)
2. **Task 2: The compose-invariant CI gate + topology runbook** — `cf3345d` (feat)

_No separate plan-metadata commit — this SUMMARY.md is committed directly per this worktree's repo-specific rules._

## Files Created/Modified

- `docker/docker-compose.prod.yml` — the six-service production topology
- `docker/postgres/init-prod-roles.sql` — production role bootstrap (`\getenv` + `\gexec`, fail-loud via `RAISE EXCEPTION`)
- `docker/postgres/prod-tls-entrypoint.sh` — production TLS entrypoint (separate from dev's)
- `docker/prod.env.example` — every variable name, no credential values
- `scripts/validate-prod-compose.mjs` — the CI gate (docker-compose path + YAML fallback + shared evaluator)
- `scripts/__tests__/validate-prod-compose.test.mjs` — 17 tests
- `scripts/__fixtures__/prod-compose/*.yml` (8 files) — one per invariant
- `docs/runbooks/production-topology.md` — sizing derivation, secret provenance, revisit triggers
- `package.json` — `verify:prod-compose` script
- `.github/workflows/ci.yml` — "Production compose invariants" step in the `static` job

## Decisions Made

See `key-decisions` in frontmatter for full rationale on each. Summary:
- Checkpoint resolved as **parameterize-with-minimum**: every sizing knob is an env var with a documented default; minimum viable VPS derived as **8GB RAM / 2vCPU** (4vCPU recommended), full arithmetic in the runbook.
- `PG_MAX_CONNECTIONS` default **200**, deliberately covering a rolling-restart transient doubling of the 84-connection single-instance floor, not just the steady-state figure.
- **Two** TLS entrypoint scripts (dev, prod), not one with a branch — production posture stays independently reviewable.
- `init-prod-roles.sql` covers the full role set in one file (no dev-style split with a catch-up script) — production has no developer machine to run a second pass.
- The gate's Docker-less fallback is a hand-rolled scoped parser, not the `yaml` package — avoids depending on an undeclared transitive dependency.
- `api`/`worker` healthchecks probe `/readyz`, not `/healthz` — the only way to observe true readiness given neither port is published.
- `web` gets persistent ACME volumes (Rule 2 completion) to avoid Let's Encrypt rate-limit risk on every restart.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug, found via direct empirical testing] `init-prod-roles.sql`'s original `DO $$ IF NOT EXISTS THEN ... :'password' ... END IF $$` design does not work — psql variable substitution is inert inside dollar-quoted bodies**
- **Found during:** Task 1, first attempt to run the file against a real local Postgres (this sandbox has no Docker daemon, but does have a real Homebrew `psql 17.10` + native server, used deliberately for genuine end-to-end proof rather than reasoning through the SQL unexecuted).
- **Issue:** `psql -f init-prod-roles.sql` failed with `ERROR: syntax error at or near ":"` at the `:'app_password'` reference inside a `DO $$ ... $$` block. Isolated directly: an identical `:'var'` reference at TOP-LEVEL SQL text substitutes correctly; the same reference one line inside a `DO $$ ... $$` body does not, because psql's lexer treats a dollar-quoted string as opaque and never scans it for `:name` tokens.
- **Fix:** Rewrote every conditional `CREATE ROLE` as `SELECT 'CREATE ROLE ... ' || quote_literal(:'password') || ' ...' WHERE NOT EXISTS (...) \gexec` — keeps the substitution at top level, and `\gexec` executes the resulting statement only when the `SELECT` produces a row (i.e., only when the role doesn't already exist), giving the same conditional-DDL semantics a `DO $$ IF NOT EXISTS $$` block would have, without the substitution problem.
- **Files modified:** `docker/postgres/init-prod-roles.sql`
- **Verification:** Direct execution against a real throwaway database — first run creates all three roles with correct attributes and sets database ownership; second run is a genuine no-op (0 `CREATE ROLE` statements executed, `ALTER DATABASE`/`GRANT` re-asserted harmlessly).
- **Committed in:** `79f2a0e` (Task 1 commit)

**2. [Rule 1 - Bug, found via direct empirical testing] The missing-password guard's original `\quit 1` does not fail loudly in this Postgres version**
- **Found during:** Task 1, testing the fail-loud guard path (unsetting one of the three password env vars and re-running against a fresh database).
- **Issue:** `\quit 1` printed `warning: \quit: extra argument "1" ignored` and the script still exited **0** — the exact opposite of the fail-loud behavior the guard exists to provide. Had this shipped unfixed, an operator forgetting to set `MEGA_CRM_SCAN_PASSWORD` would see a "successful" `docker compose up` with `mega_crm_scan` silently never created.
- **Fix:** Replaced `\warn ... \quit 1` with a variable-free `DO $guard$ BEGIN RAISE EXCEPTION '...'; END $guard$;` (no `:'var'` substitution needed inside it, so deviation #1's bug class does not recur here) — a genuine SQL exception, which `ON_ERROR_STOP=1` (the official postgres image's own default for `docker-entrypoint-initdb.d/*.sql`) turns into a non-zero process exit.
- **Files modified:** `docker/postgres/init-prod-roles.sql`
- **Verification:** Re-ran the missing-password scenario after the fix — script now exits with code `3` and prints the exact intended error message; confirmed via `pg_roles` query that the roles created before the aborted statement (in password-declaration order) exist while the one after the missing variable does not — a loud partial failure, not a silent success.
- **Committed in:** `79f2a0e` (Task 1 commit)

**3. [Rule 2 - Missing critical functionality] `web`'s Caddy container had no persistent ACME state**
- **Found during:** Task 1, while writing the `web` service.
- **Issue:** The plan's own action text does not mention Caddy's `/data`/`/config` paths. Without a persistent volume for them, every container restart (a routine deploy, or a host reboot) would make Caddy re-request a fresh Let's Encrypt certificate for the same domain — risking ACME's own issuance rate limits, a real availability risk for a single-VPS topology with no fallback certificate.
- **Fix:** Added `mega_crm_caddy_data_prod` and `mega_crm_caddy_config_prod` named volumes, mounted at Caddy's own default `/data`/`/config` paths.
- **Files modified:** `docker/docker-compose.prod.yml`
- **Verification:** `npm run verify:prod-compose` still passes (the gate does not assert this specific invariant, but the addition does not break any existing one); documented explicitly in `docs/runbooks/production-topology.md`'s services table comment.
- **Committed in:** `79f2a0e` (Task 1 commit)

---

**Total deviations:** 3 (2 Rule-1 bugs found via direct empirical testing of code that would otherwise have shipped silently broken, 1 Rule-2 missing-functionality completion). All three were necessary for the plan's own stated correctness bar ("idempotent," "fail-loud," and the general "no local feedback loop gap left unclosed" spirit of the `<done>` criterion) — no scope creep beyond what DB-13/OPS-01/OPS-02 required.

## Issues Encountered

- **No Docker daemon, no `docker compose` subcommand at all in this sandbox** (confirmed directly: `docker compose version` → "unknown command"; `docker info` → no daemon socket). Every assertion genuinely requiring either is deferred to CI/a human, with the exact command recorded in this SUMMARY's `coverage` block (`human_judgment: true` entries D1/D3) and in `docs/runbooks/production-topology.md`. Everything that could be proven without Docker was proven directly against a real local Postgres (Homebrew `psql`/`postgres` — the same substitute this repo's own 14-03 plan used for its equivalent no-Docker gap), not merely reasoned through: `init-prod-roles.sql`'s idempotency, its fail-loud guard, and both bugs documented above were all found by actually running the SQL, not by review.
- **This sandbox's own pre-existing dev roles (`mega_crm_app`/`mega_crm_scan`/`mega_crm_auth`) were temporarily overwritten during `init-prod-roles.sql`'s own testing** (their passwords were reset to test values while proving the script against a throwaway database) and were **restored to the documented dev convention password (`mega_crm_dev_pw`) before finishing** — confirmed the real dev/test databases (`mega_crm`, `mega_crm_test`, etc.) were never touched (only role-level `ALTER ROLE ... PASSWORD`, never any `DROP DATABASE` against a real dev database; only the dedicated throwaway `mega_crm_init_prod_roles_test` database was created/dropped). A stray `mega_crm_app_test2` role created during interactive `\gexec` experimentation was also dropped before finishing.
- **`docker/prod.env.example`'s `IMAGE_TAG` placeholder (`0000...0000`, 40 zeros) superficially matches a "long opaque value" heuristic** when grepped for credential-shaped strings — confirmed by inspection this is an all-zero placeholder, not a real credential, and is documented as such in the file's own comment (a syntactically SHA-shaped, deliberately fake value so the mutable-tag check and `docker compose config` both have something concrete to resolve against).

## User Setup Required

None new beyond what the plan's own `user_setup` frontmatter already declared (VPS/DNS/GHCR token/`MEGA_CRM_ENV_FILE` — all deferred to plan 14-09's actual deploy, per the checkpoint's own resolution). This plan did not provision a VPS, did not start the stack, and did not require any new external service configuration to execute its own two tasks.

## Next Phase Readiness

- **Plan 14-09 (deploy script)** consumes: `docker/docker-compose.prod.yml` directly (`docker compose run --rm migrate` then `up -d`), must export `WORKER_STOP_GRACE_PERIOD_SECONDS` (from `node scripts/print-stop-grace-period.mjs`, after `npm run build -w apps/worker`), `GHCR_IMAGE_BASE`/`IMAGE_TAG` (the SHA being deployed), `SITE_ADDRESS`, and `MEGA_CRM_ENV_FILE` before every compose invocation. `docs/runbooks/production-topology.md` is the reference for every sizing/secret variable; that runbook explicitly defers deploy/rollback procedures to 14-09's own runbook rather than duplicating them.
- **Plan 14-13 (SPECIFICATION.md filing)** needs, per this worktree's deferred-filing rule:
  - **§2 (Зависимости и версии):** no new npm package this plan — `scripts/validate-prod-compose.mjs` is Node built-ins only.
  - **§3 (Секреты):** every env var name in `docker/prod.env.example`'s "Application secrets" and "Postgres bootstrap" sections is new to the production surface (though most already existed as dev/CI env vars from earlier phases) — `MEGA_CRM_ENV_FILE`, `MEGA_CRM_APP_PASSWORD`/`MEGA_CRM_SCAN_PASSWORD`/`MEGA_CRM_AUTH_PASSWORD`, `GHCR_IMAGE_BASE`, `IMAGE_TAG`, `SITE_ADDRESS`, and every sizing knob (`DB_MEM_LIMIT`, `REDIS_MEM_LIMIT`, `API_MEM_LIMIT`, `WORKER_MEM_LIMIT`, `WEB_MEM_LIMIT`, `MIGRATE_MEM_LIMIT`, `DB_OOM_SCORE_ADJ`, `PG_MAX_CONNECTIONS`, `PG_SHARED_BUFFERS`, `WORKER_STOP_GRACE_PERIOD_SECONDS`) are new for §3's filing.
  - **§4 (Схема данных):** no schema/migration change this plan — role creation is a cluster-level bootstrap (`init-prod-roles.sql`), not a Drizzle migration.
  - **§5 (Планировщик и пайплайн отправки):** new npm script `verify:prod-compose` → `node scripts/validate-prod-compose.mjs` (CI static-job gate, not a pipeline step).
  - **§6 (Публичные точки входа):** no new HTTP route — this plan only touches deploy topology.
  - **Docker/compose:** first `docker-compose.prod.yml` this repository has — worth its own line distinct from the existing dev `docker-compose.yml` entry; base images `postgres:17`/`redis:7` are the same pinned versions the dev compose file already uses, not new pins.
  - **§8 (Расхождения):** the two empirically-found psql bugs (variable substitution inert inside dollar-quoted bodies; `\quit`'s exit-code argument ignored in this Postgres version) are implementation findings specific to this plan's SQL authoring, not a stack-vs-recommendation divergence — noted here for completeness but likely belongs in this SUMMARY/the runbook rather than §8 proper.
- **Everything this plan touches is independently green**: `npm run lint` (0 warnings), `npm run build --workspaces --if-present` (all 15 workspaces), `npm run verify:prod-compose` (6 services, 29 invariants, 0 violations), `npx vitest run --root scripts` (5 files, 64 tests, all pass — no regression in sibling guard scripts), `npm run lint:floor` (628 files checked, floor 390, OK).
- **Forward flag for 14-09**: the runbook's "Changing a sizing value safely" section notes that `PG_SHARED_BUFFERS` proportionality to `DB_MEM_LIMIT` is a review discipline, not a machine-checked one — worth a future gate addition if this ever drifts in practice, but out of this plan's own scope.

## Known Stubs

None. Every file this plan created is a real, functioning artifact (compose topology, SQL bootstrap, shell entrypoint, CI gate, tests, runbook) — no placeholder text, no hardcoded empty values feeding a UI, no unwired data source.

## Self-Check: PASSED

All 15 created files confirmed present on disk: `docker/docker-compose.prod.yml`, `docker/postgres/init-prod-roles.sql`, `docker/postgres/prod-tls-entrypoint.sh`, `docker/prod.env.example`, `scripts/validate-prod-compose.mjs`, `scripts/__tests__/validate-prod-compose.test.mjs`, and all 8 `scripts/__fixtures__/prod-compose/*.yml` files, `docs/runbooks/production-topology.md`. Both task commit hashes confirmed present via `git log --oneline -5`: `79f2a0e`, `cf3345d`. `git diff --diff-filter=D --name-only` against the pre-plan commit (`cac2e44`) returns empty (no accidental deletions). `git status --short | grep '^??'` returns nothing (no untracked files left). `npm run verify:prod-compose` and `npx vitest run --root scripts __tests__/validate-prod-compose.test.mjs` both re-run clean immediately before writing this SUMMARY.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
