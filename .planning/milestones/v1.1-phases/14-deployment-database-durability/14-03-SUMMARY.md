---
phase: 14-deployment-database-durability
plan: 03
subsystem: database
tags: [postgres, pg, tls, connection-pooling, ci-gate, redaction]

requires:
  - phase: 14-01
    provides: "packages/db/src/migration-journal.ts, apps/api /healthz+/readyz (unrelated surface, no direct dependency, but same phase/package)"
provides:
  - "packages/db/src/pool.ts: createPgPool(options) -- the one factory every first-party production Postgres pool now goes through (error handler, TLS decision, named size)"
  - "PG_POOL_SIZES / PG_POOL_DEFAULT_MAX / poolSizeFor / assertDsnRequestsTls -- exported from @mega-crm/db"
  - "scripts/lint-pg-pool-factory.mjs + npm run lint:pg-pool-factory -- CI-enforced gate against any bare `new Pool(...)` in first-party production source"
  - "docker/pg-tls-entrypoint.sh + docker-compose.yml's db service -- TLS-serving dev/CI Postgres with a self-signed cert in a dedicated named volume"
  - "packages/db/src/__tests__/pg-tls.test.ts -- pg_stat_ssl proof of TLS negotiation, environment-gated (skips the positive assertion locally, runs it in CI)"
affects: ["14-08 (production DSN must carry sslmode=require&uselibpqcompat=true, and sets Postgres max_connections against this plan's pool-size sum)", "14-13 (SPECIFICATION.md filing, the pool-size budget table)", "any future plan constructing a Postgres pool anywhere in apps/api, apps/worker, or packages/db/scripts"]

tech-stack:
  added: []
  patterns:
    - "One definition of 'how a Postgres pool is built' -- packages/db/src/pool.ts's createPgPool, mirroring @mega-crm/queue-core's createRedisConnection (WRK-11) for the Redis side"
    - "TLS driven by exactly one mechanism (the connection string), never a separately-constructed ssl config object -- confirmed against installed pg@8.22.0/pg-connection-string@2.14.0 source, not documentation prose"
    - "A CI-enforced guard (scripts/lint-pg-pool-factory.mjs) in the same self-contained, Node-builtins-only class as scripts/lint-session-state.mjs, with a documented single-line suppression marker and a repo-wide clean-run test"

key-files:
  created:
    - packages/db/src/pool.ts
    - packages/db/src/__tests__/pool-factory.test.ts
    - packages/db/src/__tests__/pg-tls.test.ts
    - scripts/lint-pg-pool-factory.mjs
    - scripts/__tests__/lint-pg-pool-factory.test.mjs
    - scripts/__fixtures__/pg-pool-factory/violating.ts
    - scripts/__fixtures__/pg-pool-factory/compliant.ts
    - docker/pg-tls-entrypoint.sh
  modified:
    - packages/db/src/index.ts
    - packages/tenant-context/src/index.ts
    - packages/tenant-context/src/scan.ts
    - packages/tenant-context/package.json
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - apps/worker/src/queues/dead-letter/dead-letter-writer.ts
    - packages/db/scripts/relocate-default-partition-rows.ts
    - packages/db/scripts/count-send-event-duplicates.ts
    - packages/db/scripts/replay-webhook-journal.ts
    - packages/db/scripts/rehash-suppressions.ts
    - packages/db/scripts/audit-sends-history.ts
    - packages/db/scripts/audit-missing-constraints.ts
    - packages/db/scripts/count-member-duplicates.ts
    - package.json
    - package-lock.json
    - .github/workflows/ci.yml
    - docker-compose.yml
    - .gitignore

key-decisions:
  - "sslmode=require alone is NOT libpq's classic 'encrypt, don't verify' on this codebase's installed pg@8.22.0 / pg-connection-string@2.14.0 -- it aliases to full verify-full certificate-chain validation unless the DSN ALSO carries uselibpqcompat=true, confirmed by reading pg-connection-string's own switch(config.sslmode) block, not assumed from libpq docs. Against a self-signed cert (this plan's dev/CI Postgres), a bare sslmode=require FAILS the handshake with a certificate error. Plan 14-08's production DSN needs sslmode=require&uselibpqcompat=true, not sslmode=require alone."
  - "packages/tenant-context now depends on @mega-crm/db (deep import of @mega-crm/db/src/pool.js, never the package root, which throws at import time if DATABASE_URL is unset and eagerly builds its own pools) -- this SUPERSEDES the 10-13 (SEC-13) decision to stay off scrubbedConsole for 'dependency-light' reasons; DB-14's CI-enforced invariant now outranks that argument. Recorded inline at the supersession site in tenant-context/src/index.ts."
  - "The tenant-context pool now throws at import time if DATABASE_URL is unset, where it previously deferred the failure to first connect (bare new Pool() never validates its DSN eagerly) -- a deliberate fail-fast improvement consistent with @mega-crm/db's own root index.ts, not a regression; every touched test suite still passes."
  - "The pool-factory guard's exclusion set extends the plan's named list (__tests__, dist, test-support, e2e) with this codebase's established src/test/ fixture-directory convention (apps/api/src/test, apps/worker/src/test, packages/delivery-core/src/test all hold shared db-fixture.ts/fixture helpers consumed only by tests) -- apps/worker/src/test/failure-fixtures.ts constructs a throwaway pool under exactly that convention and is excluded for the same reason test-support is, even though it isn't literally named __tests__."
  - "PG_POOL_SIZES lists only the long-running production consumers (db, auth, tenant-context, tenant-context-scan, worker-partition-maintenance, worker-dead-letter); every packages/db/scripts operator CLI falls through to PG_POOL_DEFAULT_MAX=2 rather than getting its own entry -- each runs as a single sequential process, never concurrently with itself."

requirements-completed: [DB-13, DB-14]

coverage:
  - id: D1
    description: "createPgPool: unconditional scrubbedConsole-routed error listener, single-source TLS decision (connection string only, no ssl object), fail-closed assertDsnRequestsTls in production, named pool sizes with a documented default"
    requirement: "DB-14"
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/pool-factory.test.ts (17 tests, all behaviors in the plan's <behavior> block)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every first-party production Postgres pool (17 constructions across 11 files: packages/db/src/index.ts x2, packages/tenant-context x2, apps/worker's two dedicated pools, 7 packages/db/scripts operator CLIs) migrated onto the factory; a CI-enforced gate fails on any future bare new Pool( outside it"
    requirement: "DB-14"
    verification:
      - kind: integration
        ref: "npm run lint:pg-pool-factory (252 files checked, 0 violations)"
        status: pass
      - kind: unit
        ref: "scripts/__tests__/lint-pg-pool-factory.test.mjs (17 tests: positive/negative fixtures, comment-stripping, suppression marker, factory allow-list, repo-wide clean-run)"
        status: pass
      - kind: integration
        ref: "npm run build --workspaces --if-present (all 15 workspaces); npx vitest run --root packages/db (176 pass, 1 skip) / apps/worker (553 pass) / apps/api (472 pass) / packages/tenant-context (25 pass) / scripts (48 pass)"
        status: pass
    human_judgment: false
  - id: D3
    description: "TLS-serving dev/CI Postgres (self-signed cert generated on first boot into a dedicated named volume, reused on restart) and a pg_stat_ssl proof that a connection actually negotiates TLS -- config inspection is explicitly not the assertion"
    requirement: "DB-13"
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/pg-tls.test.ts -- negative case (no sslmode -> ssl=false) run and PASSING against this sandbox's native Postgres"
        status: pass
      - kind: integration
        ref: "packages/db/src/__tests__/pg-tls.test.ts -- positive case (sslmode=require&uselibpqcompat=true -> ssl=true, non-empty cipher) via pg_stat_ssl"
        status: unknown
    human_judgment: true
    rationale: "This sandbox has no Docker daemon at all (confirmed: `docker compose` subcommand absent, no daemon socket, no Docker Desktop/colima/podman) and provisions test/dev Postgres against a native (non-TLS) Homebrew install instead. The positive assertion is environment-gated (probed via `SHOW ssl` at test-file top level) and SKIPPED here rather than weakened to a config check, per this task's own instruction. It will execute for real on every CI pass once docker-compose.yml's db service starts under this plan's entrypoint change -- a human (or the next CI run) must confirm that actually happens post-merge."

duration: ~2.5h
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 03: Postgres Pool Factory + Dev/CI TLS Summary

**One `createPgPool()` factory (packages/db/src/pool.ts) now owns every first-party production Postgres pool's error handler, TLS decision and size — enforced by a new CI gate (`scripts/lint-pg-pool-factory.mjs`) migrating 17 pool-construction sites across 11 files — plus a TLS-serving dev/CI Postgres container proven by `pg_stat_ssl`, not config inspection.**

## Performance

- **Duration:** ~2.5h
- **Tasks:** 3 (Task 1 factory + TDD, Task 2 migration + CI guard, Task 3 dev/CI TLS + TDD)
- **Files created:** 8
- **Files modified:** 17

## Accomplishments

- **The factory** (`packages/db/src/pool.ts`, `createPgPool`): wires an unconditional `pool.on("error", ...)` listener through `@mega-crm/redaction`'s `scrubbedConsole` (never bare `console.error`, never optional), never constructs a separate `ssl` config object (the connection string is the ONLY TLS input), throws in production when the DSN doesn't request TLS (`assertDsnRequestsTls`, checked at call time via `process.env.NODE_ENV`), and resolves an explicit named size from `PG_POOL_SIZES`/`PG_POOL_DEFAULT_MAX`.
- **The pg@8.22.0 finding this plan was told to verify against installed source, not prose:** `pg-connection-string@2.14.0` treats `sslmode=require` (and `prefer`/`verify-ca`) as an ALIAS for `verify-full` (full certificate-chain verification against the system trust store) UNLESS the DSN also carries `uselibpqcompat=true` — confirmed by reading `node_modules/pg-connection-string/index.js`'s own `switch (config.sslmode)` block. Against this plan's self-signed certificate, a bare `sslmode=require` fails the handshake with a certificate-verification error, not "encrypt, don't verify" as classic libpq semantics would suggest. **This is load-bearing for plan 14-08**: the production DSN needs `sslmode=require&uselibpqcompat=true`, not `sslmode=require` alone, or the first production deploy's database connections will fail outright.
- **17 pool-construction sites across 11 files migrated** (more than the plan's own "~13" estimate — the acceptance grep's repo-wide scope caught two `packages/db/scripts` files (`audit-missing-constraints.ts`, `count-member-duplicates.ts`) not in this plan's `files_modified` list): `packages/db/src/index.ts` (`db`, lazy `auth`), `packages/tenant-context/src/index.ts` + `scan.ts` (shared RLS pool, lazy scan pool), `apps/worker`'s partition-maintenance and dead-letter pools, and all 7 `packages/db/scripts` operator CLIs.
- **Two pools had NO error listener at all before this change**: `packages/db/scripts/relocate-default-partition-rows.ts` (both its app and admin pools, Phase 9 origin) and `replay-webhook-journal.ts` (Phase 13 origin — the **newer** of the two). The other five scripts and both worker pools already had a hand-written listener (some via bare `console.error`, some via `scrubbedConsole`). That the newest script was the one missing the convention is DB-14's decay thesis proven by evidence, not the plan's own guess about which sites would be missing it (the plan named the two worker pools as "the concrete reason DB-14 exists" — both already had listeners by the time this plan ran, from Phase 9/12 hardening).
- **`scripts/lint-pg-pool-factory.mjs`**: a CI-enforced gate in the exact class of `scripts/lint-session-state.mjs` (Node built-ins only, comment-stripped matching so a doc-comment mention can't trip or hide a finding, exported pure helpers, a `pg-pool-factory-exception:`-with-reason suppression marker, a repo-wide clean-run test proving the scan examined a non-zero file count). Scoped to `apps/*/src`, `packages/*/src` (excluding `test-support`), and `packages/db/scripts`; extends the plan's own exclusion list with this codebase's established `src/test/` fixture-directory convention (see Deviations).
- **TLS-serving dev/CI Postgres**: `docker/pg-tls-entrypoint.sh` generates a self-signed certificate on first boot into the dedicated `mega_crm_db_certs` named volume (never the data directory, never the working tree), sets the key-file permissions Postgres demands, then execs the official image's own `docker-entrypoint.sh` with `postgres -c ssl=on` plus the cert/key paths. Runs as root (before the image's own entrypoint drops privileges) — required for the `chown`. A missing `openssl` fails loudly rather than silently falling back to plaintext.
- **`packages/db/src/__tests__/pg-tls.test.ts`**: proves TLS by the server's own `pg_stat_ssl` view (never by inspecting pool config) — RESEARCH.md Pitfall B's failure mode is exactly "looks configured in review, wire is plaintext", which only the server's own session view can catch. Environment-gated: probes `SHOW ssl` at file-load time via top-level `await`, and skips the positive assertion with a loud `console.warn` naming the exact command to re-run once a TLS-capable Postgres exists, rather than weakening it to a config check.

## Task Commits

1. **Task 1: The factory** — RED `7bdd802` (test) → GREEN `cd4841b` (feat)
2. **Task 2: Migrate every production pool site + CI guard** — `440237f` (feat)
3. **Task 3: Serve TLS from the dev/CI Postgres** — RED `099b405` (test) → GREEN `ef6017e` (feat) → fixup `9c86640` (fix, lint-only)

_No separate plan-metadata commit — SUMMARY.md is committed directly per this worktree's repo-specific rules (`.planning/` is gitignored here)._

## Files Created/Modified

- `packages/db/src/pool.ts` — the factory: `createPgPool`, `assertDsnRequestsTls`, `poolSizeFor`, `PG_POOL_SIZES`, `PG_POOL_DEFAULT_MAX`
- `packages/db/src/index.ts` — `db`/`auth` pools built through the factory; re-exports `pool.js`
- `packages/tenant-context/src/index.ts`, `src/scan.ts`, `package.json` — shared RLS pool + lazy scan pool through the factory; new `@mega-crm/db` dependency
- `apps/worker/src/queues/partition-maintenance.worker.ts`, `src/queues/dead-letter/dead-letter-writer.ts` — dedicated worker pools through the factory
- `packages/db/scripts/*.ts` (7 files) — every operator CLI's pool(s) through the factory
- `scripts/lint-pg-pool-factory.mjs` + `scripts/__tests__/lint-pg-pool-factory.test.mjs` + `scripts/__fixtures__/pg-pool-factory/{violating,compliant}.ts` — the CI guard and its tests
- `package.json` / `package-lock.json` — `lint:pg-pool-factory` script; tenant-context's new `@mega-crm/db` dependency edge
- `.github/workflows/ci.yml` — "Pool factory audit" step in the `static` job
- `docker/pg-tls-entrypoint.sh` — the TLS entrypoint wrapper
- `docker-compose.yml` — `db` service's entrypoint override + `mega_crm_db_certs` volume
- `.gitignore` — defensive `docker/certs/`, `docker/*.key`, `docker/*.pem`, `docker/*.crt` patterns
- `packages/db/src/__tests__/pool-factory.test.ts`, `pg-tls.test.ts` — the plan's two TDD test files

## Decisions Made

See `key-decisions` in frontmatter for the full rationale on each. Summary:
- **pg@8.22.0's `sslmode=require`→`verify-full` aliasing** (needs `uselibpqcompat=true` for classic libpq semantics) — confirmed from installed source, flagged to 14-08.
- **tenant-context now depends on `@mega-crm/db`** (deep import, not the root) — supersedes the 10-13 dependency-light decision; DB-14's CI-enforced invariant wins.
- **tenant-context's pool now fails fast at import time** if `DATABASE_URL` is unset (previously deferred to first connect) — deliberate improvement, not a regression; every touched suite still passes.
- **Guard's exclusion set extended** to cover the `src/test/` fixture-directory convention already established in this codebase (see Deviations).
- **PG_POOL_SIZES lists only long-running processes**; operator scripts share `PG_POOL_DEFAULT_MAX=2`.

### PG_POOL_SIZES — full table, effective deltas, and the summed total (for 14-08/14-13)

| Consumer | New `max` | Previous `max` (pg-pool's implicit default) | Delta |
|---|---|---|---|
| `db` | 10 | 10 | unchanged |
| `auth` | 10 | 10 | unchanged |
| `tenant-context` | 20 | 10 | **10→20** |
| `tenant-context-scan` | 5 | 10 | **10→5** |
| `worker-partition-maintenance` | 2 | 10 | **10→2** |
| `worker-dead-letter` | 2 | 10 | **10→2** |
| every `packages/db/scripts` operator CLI (unlisted, `PG_POOL_DEFAULT_MAX`) | 2 | 10 | **10→2** |

Every migrated pool previously ran at `pg-pool`'s own implicit default of `max: 10` (nobody had set `max` explicitly anywhere) — this plan is the first time any of these sizes were deliberate rather than accidental. `db`/`auth` keep 10 (genuinely concurrent HTTP-request-path consumers); every low-concurrency consumer dropped, most sharply the two worker pools and every operator script (10→2).

**Sum of maxima, one instance each of `apps/api` + `apps/worker`** (the number plan 14-08 sizes Postgres's `max_connections` against, and plan 14-13's budget table either confirms or refines with the real per-process inventory):
- `apps/api`: `db`(10) + `auth`(10) + `tenant-context`(20) + `tenant-context-scan`(5) = **45**
- `apps/worker`: `db`(10) + `tenant-context`(20) + `tenant-context-scan`(5) + `worker-partition-maintenance`(2) + `worker-dead-letter`(2) = **39**
- **TOTAL (one instance of each process): 84**

This assumes one instance each of `apps/api`/`apps/worker` and does NOT account for horizontal scaling, operator scripts run concurrently with the services, or the migration runner's own dedicated connection — 14-13 owns refining it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical scope] Two `packages/db/scripts` files not in this plan's `files_modified` list needed migration**
- **Found during:** Task 2's inventory grep (run before writing the guard, per the plan's own acceptance-criteria grep being repo-wide)
- **Issue:** `audit-missing-constraints.ts` and `count-member-duplicates.ts` (both from an earlier Phase 14 plan, not this one) construct bare `new Pool(...)` too. The guard's acceptance criteria scans `packages/db/scripts` in full, so leaving these two unmigrated would make the CI gate fail immediately on merge.
- **Fix:** Migrated both onto the factory, same as the five named scripts (`audit-missing-constraints` → `PG_POOL_DEFAULT_MAX`, `count-member-duplicates-auth` → `PG_POOL_DEFAULT_MAX`).
- **Files modified:** `packages/db/scripts/audit-missing-constraints.ts`, `packages/db/scripts/count-member-duplicates.ts`
- **Verification:** `npm run lint:pg-pool-factory` (0 violations), `npm run build -w packages/db` (clean)
- **Committed in:** `440237f` (Task 2 commit)

**2. [Rule 2 - Missing critical scope] Guard's exclusion set extended to cover an established test-fixture-directory convention the plan's illustrative grep didn't know about**
- **Found during:** Task 2's inventory grep
- **Issue:** `apps/worker/src/test/failure-fixtures.ts` constructs a bare `new Pool(...)` too, but it is a test-only fixture file (its own header: "shared fixtures for the failure-injection scenarios") — the same class of code the plan explicitly says to leave alone ("Test fixtures legitimately construct throwaway single-connection pools... forcing them through a factory... would make the test suite's connection behavior harder to reason about, not easier"). It lives under `apps/{api,worker}/src/test/` and `packages/delivery-core/src/test/` — an established convention (each holds a shared `db-fixture.ts`/fixture helper consumed only by test files) the plan's own named exclusion list (`__tests__`, `dist`, `test-support`, `e2e`) didn't anticipate, since this file wasn't in `files_modified`.
- **Fix:** Added `"test"` to the guard's `SKIP_DIR_NAMES` (alongside `__tests__`/`__fixtures__`), matching the exact rationale the plan already gives for `test-support`. Left `apps/worker/src/test/failure-fixtures.ts` unmigrated.
- **Tradeoff accepted, recorded here rather than left implicit:** any FUTURE directory literally named `test` anywhere under `apps/*/src` or `packages/*/src` will also be silently unscanned by this gate. Given the convention is already established in three places (`apps/api`, `apps/worker`, `packages/delivery-core`) purely for test fixtures, this is judged acceptable, but it is a real widening of the exclusion surface worth knowing about if a future plan ever finds a bare pool the gate should have caught.
- **Files modified:** `scripts/lint-pg-pool-factory.mjs`
- **Verification:** `scripts/__tests__/lint-pg-pool-factory.test.mjs`'s repo-wide clean-run test passes with a non-zero scanned-file count (252 files); the acceptance criteria's own illustrative grep (which doesn't know about `src/test/`) still shows this one file, documented as an intentional, principled divergence from the illustrative command rather than the actual guard's behavior.
- **Committed in:** `440237f` (Task 2 commit)

**3. [Rule 1 - Architectural note, plan-directed] `packages/tenant-context` gains a dependency on `@mega-crm/db`, superseding the 10-13 decision**
- **Found during:** Task 2, migrating `packages/tenant-context/src/index.ts`'s exported pool
- **Issue:** The plan explicitly directs migrating this pool onto the factory, which lives in `@mega-crm/db` and unconditionally routes its error listener through `@mega-crm/redaction`'s `scrubbedConsole` — but `tenant-context/src/index.ts` had a recorded 10-13 (SEC-13) decision to stay on bare `console.error` specifically to avoid a new dependency and keep this widely-imported package "dependency-light".
- **Fix:** Added `@mega-crm/db` as a dependency (deep import of `@mega-crm/db/src/pool.js`, never the package root, to avoid the root's eager `DATABASE_URL`-or-throw pool construction leaking into every tenant-context consumer). Recorded the supersession inline at the exact comment site the 10-13 decision used to live, rather than silently deleting the old reasoning.
- **Files modified:** `packages/tenant-context/src/index.ts`, `src/scan.ts`, `package.json`, root `package-lock.json`
- **Verification:** No circular dependency (grepped `packages/db/src` and `packages/queue-core/src` for `tenant-context` imports — none found, only comments); `npm run build --workspaces --if-present` clean; `npx vitest run --root packages/tenant-context` (25/25), `--root apps/worker` (553/553), `--root apps/api` (472/472) all pass.
- **Committed in:** `440237f` (Task 2 commit)

---

**Total deviations:** 3 (2 Rule-2 scope completions the plan's own acceptance criteria required, 1 plan-directed architectural supersession recorded rather than silently applied).
**Impact on plan:** All three were necessary for the CI gate to actually pass on merge (items 1-2) or were explicitly directed by the plan text itself (item 3, documented rather than silently done). No scope creep beyond what DB-13/DB-14 required.

## Issues Encountered

- **No Docker daemon in this execution environment.** Confirmed thoroughly, not assumed: `docker --version` succeeds (CLI present) but `docker compose` is an unrecognized subcommand (the compose plugin itself is absent, not merely inactive), `docker info` reports no daemon socket, and there is no Docker Desktop app, colima, or podman installed on this machine. Test/dev Postgres in this sandbox is a native Homebrew `postgresql@17` install on `localhost:5432` (confirmed via `lsof`/`ps`), not a container — this is a persistent, shared substitute for what would be `docker-compose.yml`'s `db` service on a machine with Docker, and it is NOT the "dev Postgres container" the repo-specific rules refer to. Per this task's own explicit instruction, the TLS work was NOT weakened into a config assertion to compensate — `docker/pg-tls-entrypoint.sh` and `docker-compose.yml` were written and are believed correct against the official `postgres:17` image's documented behavior, but **could not be run end-to-end in this environment**. See the `coverage` block's `D3` entry (`human_judgment: true`) for the exact unverified claim.
- **`openssl` presence in `postgres:17` is assumed, not confirmed.** The entrypoint script's `command -v openssl` guard fails loudly if it's absent rather than silently falling back to plaintext, and it is very likely present in the Debian-based official image — but this could not be verified empirically without Docker. **If CI's `test`/`failure-injection` jobs go red on `docker compose up -d --wait` timing out on the `db` service's healthcheck after this merge, `openssl` absence in the image is suspect #1** to check first (the entrypoint script would exit 1 immediately, and the container would never become healthy).
- **Local verification commands for a human/CI to run**, exactly as the plan's `<verify>` block specifies:
  ```
  docker compose down -v && docker compose up -d --wait
  docker compose exec -T db psql -U postgres -tAc "SHOW ssl"   # expect: on
  npx vitest run --root packages/db src/__tests__/pg-tls.test.ts  # expect: 2/2 pass, none skipped
  ```

## User Setup Required

None — no new environment variables or external service configuration. `lint:pg-pool-factory` is a new npm script with no config; TLS is entirely self-contained inside the `db` service's own container.

## Next Phase Readiness

- **Plan 14-08 (deploy/compose)** MUST use `sslmode=require&uselibpqcompat=true` in the production `DATABASE_URL`/`SCAN_DATABASE_URL`/`AUTH_DATABASE_URL`, not `sslmode=require` alone — a bare `require` will fail the handshake against this phase's self-signed certificate (or any self-signed cert without a matching CA). It also needs to set Postgres's `max_connections` above this plan's documented sum (84 for one instance each of `apps/api`/`apps/worker` — see the PG_POOL_SIZES table above).
- **Plan 14-13 (SPECIFICATION.md filing)** needs, per this worktree's deferred-filing rule:
  - **§2 (Зависимости и версии):** `packages/tenant-context/package.json` gained a `@mega-crm/db` runtime dependency (deep-imports `@mega-crm/db/src/pool.js`, not the package root).
  - **§3 (Секреты):** no new secret/env var this plan; TLS cert/key are container-internal, never an env var.
  - **§4 (Схема данных):** no schema change this plan.
  - **§5 (Планировщик и пайплайн отправки):** new npm script `lint:pg-pool-factory` → `node scripts/lint-pg-pool-factory.mjs` (CI static-job gate, not a pipeline step).
  - **§6 (Публичные точки входа):** none — this plan touches no HTTP route.
  - **§8 (Расхождения):** the pg@8.22.0/`pg-connection-string@2.14.0` `sslmode=require`→`verify-full`-alias finding, and the budget table (PG_POOL_SIZES sum = 84 for one api+worker instance) for the `max_connections` sizing decision.
  - **Docker/compose:** `docker-compose.yml`'s `db` service gained an `entrypoint:` override (`docker/pg-tls-entrypoint.sh`) and a new named volume `mega_crm_db_certs` — worth a line in whichever doc tracks the compose topology.
- **Merge-conflict watch for the orchestrator** (not actioned here, per this worktree's isolation): `package-lock.json` got a small, targeted edit (the new `tenant-context`→`@mega-crm/db` dependency edge) while wave-2 sibling plans 14-04/14-05 (on separate branches, not visible in this worktree) also touched `package.json`s in `packages/delivery-core`, `packages/queue-core`, and `packages/db`. A lockfile conflict on merge resolves cleanly by re-running `npm install` after the merge, not by hand-editing the lockfile.
- **Gate-vs-sibling-branch watch for the orchestrator:** plan 14-04 (worker health server, invisible branch in this worktree) may construct its own bare `pg.Pool` for a new health-check surface — if so, `npm run lint:pg-pool-factory` will fail post-merge on that site. This is expected and correct (the gate doing its job on code this worktree never saw), not a bug in this plan's work; the orchestrator/next executor should migrate that site onto `createPgPool` rather than suppress the gate.
- **Everything else this plan touches is independently green**: `npm run build --workspaces --if-present` (all 15 workspaces), `npm run lint` (0 warnings), `npm run lint:pg-pool-factory` (252 files, 0 violations), and every test suite for a touched workspace (`packages/db` 176/177 incl. 1 environment-gated skip, `packages/tenant-context` 25/25, `apps/worker` 553/553, `apps/api` 472/472, `scripts` 48/48).
- **Dev Postgres left exactly as found**: this plan never touched the native Homebrew Postgres install other machines/sessions share — confirmed healthy and accepting connections (`SELECT 1`) at the end of this plan's work, with no leftover ephemeral test databases from this plan's own test runs.

## Self-Check: PASSED

All 8 created files confirmed present on disk (`packages/db/src/pool.ts`, `packages/db/src/__tests__/pool-factory.test.ts`, `packages/db/src/__tests__/pg-tls.test.ts`, `scripts/lint-pg-pool-factory.mjs`, `scripts/__tests__/lint-pg-pool-factory.test.mjs`, `scripts/__fixtures__/pg-pool-factory/violating.ts`, `scripts/__fixtures__/pg-pool-factory/compliant.ts`, `docker/pg-tls-entrypoint.sh`). All 6 task commit hashes confirmed present in `git log 5395d6f..HEAD` (`7bdd802`, `cd4841b`, `440237f`, `099b405`, `ef6017e`, `9c86640`). `git diff --diff-filter=D --name-only 5395d6f..HEAD` returned empty (no accidental deletions). `git status --short | grep '^??'` returned nothing (no untracked files left).

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
