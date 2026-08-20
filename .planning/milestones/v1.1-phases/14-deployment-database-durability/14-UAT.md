---
status: complete
phase: 14-deployment-database-durability
source: [14-01-SUMMARY.md, 14-02-SUMMARY.md, 14-03-SUMMARY.md, 14-04-SUMMARY.md, 14-05-SUMMARY.md, 14-06-SUMMARY.md, 14-07-SUMMARY.md, 14-08-SUMMARY.md, 14-12-SUMMARY.md, 14-13-SUMMARY.md, 14-14-SUMMARY.md]
started: 2026-08-13T07:49:52.025Z
updated: 2026-08-13T09:20:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running dev server/worker. Clear ephemeral state (temp DBs, caches). Start the stack from scratch (npm run dev or your usual boot). API and worker boot without errors, migrations are current, GET /healthz returns 200 and GET /readyz returns 200 on both api and worker once Postgres/Redis are up.
result: pass

### 2. Migration 0062 applied to live dev database (14-02 D4)
expected: Run the production migrate runner against your live development database: npm run migrate:prod (with DATABASE_URL pointing at the dev DB). It exits 0, migration 0062 (member unique constraint) is applied, and the __drizzle_migrations journal records it. If duplicates block it, the fail-closed guard names them and the --resolve tooling clears them.
result: pass

### 3. Dev/CI Postgres serves TLS (14-03 D3)
expected: Start the dev docker-compose db service (docker compose up db). First boot generates a self-signed cert into a named volume (reused on restart). Connecting and querying pg_stat_ssl for your own connection shows ssl = true — the connection actually negotiates TLS, not just config claiming it. (Also runs automatically in CI; confirming a green CI run on this branch counts.)
result: pass

### 4. API + worker Docker images build and run (14-06 D1)
expected: From a clean checkout: docker build -f docker/Dockerfile.api -t megacrm-api:local . and the same for docker/Dockerfile.worker. Both build successfully (multi-stage, Node 22, non-root USER, exec-form node CMD). The api image can run the one-shot migrate step and serve /readyz's applied-vs-shipped migration check.
result: pass
retest_of: "issue G-14-4 — lockfile regenerated under npm 10 by plan 14-14; re-verified by real docker build"

### 5. Web image: SPA + Caddy routing (14-06 D2)
expected: docker build -f docker/Dockerfile.web produces one self-contained image with the built SPA and Caddy. Against a stub upstream: server-side paths proxy to api:4000, webhook bodies pass through byte-identical, unknown SPA routes fall back to index.html, hashed /assets/* get long cache headers while index.html does not.
result: pass
retest_of: "blocked on G-14-4 — lockfile fix landed (14-14), web image build re-verified"

### 6. GHCR image workflow on master (14-06 D3)
expected: After merge to master, .github/workflows/images.yml runs: builds and pushes api/web/worker images to GHCR, each tagged with the immutable git SHA (no :latest). Every action is SHA-pinned and ci.yml is untouched. Verify via gh run watch or the Actions tab after the first real push.
result: pass
retest_of: "blocked on G-14-4 — lockfile fixed (14-14); verified via images.yml build-without-push jobs"

### 7. Production compose file validates under real Docker (14-08 D1)
expected: From a clean checkout with Docker: docker compose -f docker/docker-compose.prod.yml config succeeds. The file declares all six services (db, redis, api, worker, web, migrate); every service has mem_limit; db has negative oom_score_adj while api/worker do not; only web publishes ports 80/443; no :latest tags and no build: sections.
result: pass

### 8. Prod Postgres TLS entrypoint in a real container (14-08 D3)
expected: Running the db service from docker-compose.prod.yml (postgres:17 with docker/postgres/prod-tls-entrypoint.sh) boots with ssl=on and the parameterized max_connections/shared_buffers overrides applied. The cert-generation/chown/exec mechanism works inside the actual container (it mirrors the dev entrypoint proven in CI, but this script has not been run in a real postgres:17 container yet).
result: pass

### 9. Data-retention runbook reads well under pressure (14-12 D4)
expected: Open docs/runbooks/data-retention.md and read it as an operator. It clearly states: which evidence-table groups are excluded and why, the 12-month horizon and its rationale, the PARTITION_RETENTION_ENABLED flag and its restore-drill precondition, the combined recovery-horizon arithmetic, and what narrowing the horizon does. Nothing critical is missing or ambiguous.
result: pass

### 10. [14-01 D1] One-shot migrate runner (scripts/migrate-runner.mjs, npm run migrate:prod): dedicated pg.Client, bounded pg_try_advisory_lock retry, drizzle-orm's own migrate(), never falls through to migrating on lock failure
expected: One-shot migrate runner (scripts/migrate-runner.mjs, npm run migrate:prod): dedicated pg.Client, bounded pg_try_advisory_lock retry, drizzle-orm's own migrate(), never falls through to migrating on lock failure
result: pass
source: automated
coverage_id: D1

### 11. [14-01 D2] One shared definition of 'applied' (packages/db/src/migration-journal.ts) resolved against drizzle-orm@0.45.2's actual migrator source, consumed identically by the runner and /readyz
expected: One shared definition of 'applied' (packages/db/src/migration-journal.ts) resolved against drizzle-orm@0.45.2's actual migrator source, consumed identically by the runner and /readyz
result: pass
source: automated
coverage_id: D2

### 12. [14-01 D3] GET /healthz: pure process liveness, zero I/O, 200 regardless of Postgres/Redis reachability
expected: GET /healthz: pure process liveness, zero I/O, 200 regardless of Postgres/Redis reachability
result: pass
source: automated
coverage_id: D3

### 13. [14-01 D4] GET /readyz: Postgres + Redis + migration-currency, 503 naming the failing check(s), 200 only when all three pass
expected: GET /readyz: Postgres + Redis + migration-currency, 503 naming the failing check(s), 200 only when all three pass
result: pass
source: automated
coverage_id: D4

### 14. [14-01 D5] onRequest fail-closed guard: refuses every non-health route with 503 until migrations are confirmed current exactly once per process lifetime; never blocks /healthz or /readyz; invisible once confirmed
expected: onRequest fail-closed guard: refuses every non-health route with 503 until migrations are confirmed current exactly once per process lifetime; never blocks /healthz or /readyz; invisible once confirmed
result: pass
source: automated
coverage_id: D5

### 15. [14-02 D1] Live pg_constraint/pg_index/pg_class audit script covering contacts, workspace_sendgrid_keys, workspace_send_settings, session, organization, user, member, invitation -- confirms member and invitation each carry only their primary key
expected: Live pg_constraint/pg_index/pg_class audit script covering contacts, workspace_sendgrid_keys, workspace_send_settings, session, organization, user, member, invitation -- confirms member and invitation each carry only their primary key
result: pass
source: automated
coverage_id: D1

### 16. [14-02 D2] Read-only + --resolve duplicate-count tooling for member(organizationId, userId), modeled on migration 0057's count-send-event-duplicates.ts
expected: Read-only + --resolve duplicate-count tooling for member(organizationId, userId), modeled on migration 0057's count-send-event-duplicates.ts
result: pass
source: automated
coverage_id: D2

### 17. [14-02 D3] Migration 0062: member(organizationId, userId) unique constraint, fail-closed duplicate guard, indisvalid assertion, Drizzle schema parity
expected: Migration 0062: member(organizationId, userId) unique constraint, fail-closed duplicate guard, indisvalid assertion, Drizzle schema parity
result: pass
source: automated
coverage_id: D3

### 18. [14-03 D1] createPgPool: unconditional scrubbedConsole-routed error listener, single-source TLS decision (connection string only, no ssl object), fail-closed assertDsnRequestsTls in production, named pool sizes with a documented default
expected: createPgPool: unconditional scrubbedConsole-routed error listener, single-source TLS decision (connection string only, no ssl object), fail-closed assertDsnRequestsTls in production, named pool sizes with a documented default
result: pass
source: automated
coverage_id: D1

### 19. [14-03 D2] Every first-party production Postgres pool (17 constructions across 11 files: packages/db/src/index.ts x2, packages/tenant-context x2, apps/worker's two dedicated pools, 7 packages/db/scripts operator CLIs) migrated onto the factory; a CI-enforced gate fails on any future bare new Pool( outside it
expected: Every first-party production Postgres pool (17 constructions across 11 files: packages/db/src/index.ts x2, packages/tenant-context x2, apps/worker's two dedicated pools, 7 packages/db/scripts operator CLIs) migrated onto the factory; a CI-enforced gate fails on any future bare new Pool( outside it
result: pass
source: automated
coverage_id: D2

### 20. [14-04 W1] GET /healthz on the worker: 200 with a static body, zero I/O even when Postgres and Redis would both fail
expected: GET /healthz on the worker: 200 with a static body, zero I/O even when Postgres and Redis would both fail
result: pass
source: automated
coverage_id: W1

### 21. [14-04 W2] GET /readyz on the worker: 503 naming each of the three failing checks independently (postgres/redis/migrations), 200 only when all three pass, and MigrationsPendingError's pending tags are listed in the migrations check's detail
expected: GET /readyz on the worker: 503 naming each of the three failing checks independently (postgres/redis/migrations), 200 only when all three pass, and MigrationsPendingError's pending tags are listed in the migrations check's detail
result: pass
source: automated
coverage_id: W2

### 22. [14-04 W3] Draining flag: /readyz returns 503 the instant markWorkerDraining() is called, even when all three underlying checks would pass; the flag is never cleared
expected: Draining flag: /readyz returns 503 the instant markWorkerDraining() is called, even when all three underlying checks would pass; the flag is never cleared
result: pass
source: automated
coverage_id: W3

### 23. [14-04 W4] The listener is bound to the loopback interface only (never routable), never exposes queue names/DSNs/tenant identifiers, and rejects non-GET/HEAD or unknown paths
expected: The listener is bound to the loopback interface only (never routable), never exposes queue names/DSNs/tenant identifiers, and rejects non-GET/HEAD or unknown paths
result: pass
source: automated
coverage_id: W4

### 24. [14-04 W5] buildWorker() starts the health server and wires it into WorkerRuntime; closeWorkerRuntime closes it LAST (after workers, tracked queues, the shared connection); the SIGTERM/SIGINT path marks draining before any close begins; close() is idempotent; the port frees for reuse
expected: buildWorker() starts the health server and wires it into WorkerRuntime; closeWorkerRuntime closes it LAST (after workers, tracked queues, the shared connection); the SIGTERM/SIGINT path marks draining before any close begins; close() is idempotent; the port frees for reuse
result: pass
source: automated
coverage_id: W5

### 25. [14-04 W6] The container stop-grace-period is a machine-read value (scripts/print-stop-grace-period.mjs), never a hand-typed number; a test fails if the printed value ever drifts from WORKER_STOP_GRACE_PERIOD_SECONDS or falls at/below SENDGRID_TIMEOUT_MS in seconds
expected: The container stop-grace-period is a machine-read value (scripts/print-stop-grace-period.mjs), never a hand-typed number; a test fails if the printed value ever drifts from WORKER_STOP_GRACE_PERIOD_SECONDS or falls at/below SENDGRID_TIMEOUT_MS in seconds
result: pass
source: automated
coverage_id: W6

### 26. [14-05 D1] Every one of 63 shipped migrations classified into exactly one of two tiers, cross-checked against an independent SQL scan for the five documented forward-only signatures, with tierFor throwing on an unknown tag
expected: Every one of 63 shipped migrations classified into exactly one of two tiers, cross-checked against an independent SQL scan for the five documented forward-only signatures, with tierFor throwing on an unknown tag
result: pass
source: automated
coverage_id: D1

### 27. [14-05 D2] Empty-diff smoke test (db:check-empty-diff) proving the TS schema and migration snapshot history agree, plus the snapshot backfill it required (measured: exactly 1 file, not 52)
expected: Empty-diff smoke test (db:check-empty-diff) proving the TS schema and migration snapshot history agree, plus the snapshot backfill it required (measured: exactly 1 file, not 52)
result: pass
source: automated
coverage_id: D2

### 28. [14-05 D3] Revert-and-roll-forward rehearsal against an ephemeral database, using the real production migrate-runner.mjs for roll-forward, asserting full schema-fingerprint equality; fails loudly on a corrupted revert
expected: Revert-and-roll-forward rehearsal against an ephemeral database, using the real production migrate-runner.mjs for roll-forward, asserting full schema-fingerprint equality; fails loudly on a corrupted revert
result: pass
source: automated
coverage_id: D3

### 29. [14-05 D4] docs/runbooks/migration-rollback-and-roll-forward.md: tier determination procedure, auto-reversible steps, forward-only restore-based recovery citing plan 14-11, and the three-proofs table for what db:check-empty-diff does/does not prove
expected: docs/runbooks/migration-rollback-and-roll-forward.md: tier determination procedure, auto-reversible steps, forward-only restore-based recovery citing plan 14-11, and the three-proofs table for what db:check-empty-diff does/does not prove
result: pass
source: automated
coverage_id: D4

### 30. [14-07 D1] DB-05's unclean-death case: a migration runner SIGKILLed the instant it holds the advisory lock leaves no lock behind (pg_locks empty), the journal records no partial application, and a second runner drives the journal to the full shipped set, exiting 0
expected: DB-05's unclean-death case: a migration runner SIGKILLed the instant it holds the advisory lock leaves no lock behind (pg_locks empty), the journal records no partial application, and a second runner drives the journal to the full shipped set, exiting 0
result: pass
source: automated
coverage_id: D1

### 31. [14-07 D2] R-05's two-version deploy-safety overlap, both directions: an unrecognized-schemaVersion job is deferred (not processed, not failed) while a recognized job and a legacy pre-versioned job interleaved with it both complete
expected: R-05's two-version deploy-safety overlap, both directions: an unrecognized-schemaVersion job is deferred (not processed, not failed) while a recognized job and a legacy pre-versioned job interleaved with it both complete
result: pass
source: automated
coverage_id: D2

### 32. [14-07 D3] Pitfall 7's real-SIGTERM-mid-load case: a real worker process under sustained load self-terminates inside WORKER_STOP_GRACE_PERIOD_SECONDS with no forced kill, /readyz reports 503 shortly after the signal, and no send is left claimed-but-unresolved
expected: Pitfall 7's real-SIGTERM-mid-load case: a real worker process under sustained load self-terminates inside WORKER_STOP_GRACE_PERIOD_SECONDS with no forced kill, /readyz reports 503 shortly after the signal, and no send is left claimed-but-unresolved
result: pass
source: automated
coverage_id: D3

### 33. [14-07 D4] All three scenarios run as their own named CI steps in the failure-injection job (16 scenarios total in failure:all); no other CI job changed
expected: All three scenarios run as their own named CI steps in the failure-injection job (16 scenarios total in failure:all); no other CI job changed
result: pass
source: automated
coverage_id: D4

### 34. [14-08 D2] docker/postgres/init-prod-roles.sql creates mega_crm_app/mega_crm_scan/mega_crm_auth with the same grant shape as dev, idempotent, reading passwords via psql \\getenv, fail-loud on a missing password
expected: docker/postgres/init-prod-roles.sql creates mega_crm_app/mega_crm_scan/mega_crm_auth with the same grant shape as dev, idempotent, reading passwords via psql \\getenv, fail-loud on a missing password
result: pass
source: automated
coverage_id: D2

### 35. [14-08 D4] scripts/validate-prod-compose.mjs asserts every compose invariant with no local feedback loop (mem_limit, db oom_score_adj negative / api+worker not, worker stop_grace_period drift against a fresh print-stop-grace-period.mjs run, published-port exclusivity to web, immutable first-party image tags, max_connections above 84, migrate's profile exclusion) and reports service/invariant counts
expected: scripts/validate-prod-compose.mjs asserts every compose invariant with no local feedback loop (mem_limit, db oom_score_adj negative / api+worker not, worker stop_grace_period drift against a fresh print-stop-grace-period.mjs run, published-port exclusivity to web, immutable first-party image tags, max_connections above 84, migrate's profile exclusion) and reports service/invariant counts
result: pass
source: automated
coverage_id: D4

### 36. [14-08 D5] docs/runbooks/production-topology.md documents the six services, published-port rule, secret convention, sizing derivation (including the max_connections and minimum-viable-VPS arithmetic), Pitfall 19 rationale, and both D-09/D-10 deferred decisions with revisit triggers
expected: docs/runbooks/production-topology.md documents the six services, published-port rule, secret convention, sizing derivation (including the max_connections and minimum-viable-VPS arithmetic), Pitfall 19 rationale, and both D-09/D-10 deferred decisions with revisit triggers
result: pass
source: automated
coverage_id: D5

### 37. [14-12 D1] Horizon constant (12 months, versioned, with its irreversibility and combined-recovery-horizon rationale in the comment) and a catalog-driven eligibility walk that reads partition bounds from pg_get_expr, never from a partition's name -- a straddling-by-one-day partition and an eligible-looking-name/ineligible-range partition are both handled correctly
expected: Horizon constant (12 months, versioned, with its irreversibility and combined-recovery-horizon rationale in the comment) and a catalog-driven eligibility walk that reads partition bounds from pg_get_expr, never from a partition's name -- a straddling-by-one-day partition and an eligible-looking-name/ineligible-range partition are both handled correctly
result: pass
source: automated
coverage_id: D1

### 38. [14-12 D2] The five evidence-table groups (sends, workspace_daily_rollup, subscription_status_history, erasure_records, workspace_suppressions) are named exactly and refused rather than silently skipped if ever passed to the eligibility walk
expected: The five evidence-table groups (sends, workspace_daily_rollup, subscription_status_history, erasure_records, workspace_suppressions) are named exactly and refused rather than silently skipped if ever passed to the eligibility walk
result: pass
source: automated
coverage_id: D2

### 39. [14-12 D3] The retention step is wired into the existing daily tick (disabled/ok/failed distinguished in the run record; a failure never blocks the partition-creation work's own recording; no second BullMQ scheduler registered) and each real drop is recorded to partition_retention_drops
expected: The retention step is wired into the existing daily tick (disabled/ok/failed distinguished in the run record; a failure never blocks the partition-creation work's own recording; no second BullMQ scheduler registered) and each real drop is recorded to partition_retention_drops
result: pass
source: automated
coverage_id: D3

### 40. [14-12 D5] No committed configuration file sets the retention enable flag (PARTITION_RETENTION_ENABLED) to its enabling value; the flag is unset in production as of this plan
expected: No committed configuration file sets the retention enable flag (PARTITION_RETENTION_ENABLED) to its enabling value; the flag is unset in production as of this plan
result: pass
source: automated
coverage_id: D5

### 41. [14-13 T1] SPECIFICATION.md sections 2-8 filed with exact values from the nine available SUMMARYs plus code-derived facts for 14-09/14-10/14-11; check-spec-env-coverage.mjs gate wired into CI
expected: SPECIFICATION.md sections 2-8 filed with exact values from the nine available SUMMARYs plus code-derived facts for 14-09/14-10/14-11; check-spec-env-coverage.mjs gate wired into CI
result: pass
source: automated
coverage_id: T1

### 42. [14-13 T2] ARCHITECTURE.md's four new sections (deployment topology with the connection budget table, migration gating, backup/PITR, retention) plus the satisfied drain-timeout rewrite; CONVENTIONS.md's three new rules
expected: ARCHITECTURE.md's four new sections (deployment topology with the connection budget table, migration gating, backup/PITR, retention) plus the satisfied drain-timeout rewrite; CONVENTIONS.md's three new rules
result: pass
source: automated
coverage_id: T2

## Summary

total: 42
passed: 42
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-14-4
  truth: "docker build -f docker/Dockerfile.api and docker/Dockerfile.worker succeed from a clean checkout (npm ci resolves the lockfile cleanly)"
  status: resolved
  resolved_by: 14-14-PLAN.md
  resolved_at: 2026-08-13
  reason: "User reported: Docker image build failed. `npm ci` exits with EUSAGE because package.json and package-lock.json are out of sync: esbuild 0.28.2 and its @esbuild platform packages are missing from the lockfile. Local `npm ls esbuild --all` also reports esbuild@0.25.12 as invalid for Vite's ^0.27.0 || ^0.28.0 requirement. Both API and worker Docker images are currently unbuildable from a clean checkout."
  severity: blocker
  test: 4
  root_cause: "Latent npm-version-dependent lockfile inconsistency, not a bad commit: package-lock.json is npm-11-shaped (dev/CI use Node 26/npm 11, which tolerates vite 8.1.3's optional peer esbuild ^0.27||^0.28 being unsatisfied — only hoisted esbuild@0.25.12 for drizzle-kit exists). Phase 14's Dockerfiles pin node:22-slim (npm 10), whose ideal tree requires esbuild@0.28.2 + 26 @esbuild/* platform packages that are absent from the lockfile, so npm ci exits EUSAGE. Docker builds are the first-ever npm-10 consumer; no pre-merge gate exercises npm 10."
  artifacts:
    - path: "package-lock.json"
      issue: "npm-11-shaped; missing esbuild@0.28.2 + 26 @esbuild/* platform packages that npm 10's ideal tree requires"
    - path: "docker/Dockerfile.api"
      issue: "pins node:22-slim (npm 10) and runs root npm ci — first npm-10 consumer (pin itself is intentional and correct; do not change)"
    - path: ".github/workflows/ci.yml"
      issue: "all jobs run npm ci under .nvmrc Node 26/npm 11 — no gate exercises npm 10, so the desync passes CI"
  missing:
    - "Regenerate package-lock.json under npm 10 (npx npm@10 install --package-lock-only) — verified purely-additive, accepted by both npm 10 and 11"
    - "Pre-merge CI guard: npm ci --dry-run under node:22 (or npx npm@10) so an npm-11 lockfile regen can't silently reintroduce the failure"
    - "Acceptance: at least one end-to-end docker build (also exercises npm prune --omit=dev), not ci --dry-run alone"
  debug_session: ".planning/debug/docker-npm-ci-lockfile-desync.md"

## Notes

- Plans 14-09 (deploy.sh), 14-10 (pgBackRest backups), 14-11 (restore drill) have no SUMMARY — not yet executed (wave 5/6, VPS-dependent). Not covered by this UAT.
- 33 deliverables auto-passed via structured coverage blocks (passing automated tests); not presented as manual checkpoints.
