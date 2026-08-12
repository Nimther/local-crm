---
phase: 14-deployment-database-durability
plan: 04
subsystem: worker-ops
tags: [health-check, readiness, liveness, node-http, graceful-shutdown, deploy-safety, worker]

requires:
  - "packages/db/src/migration-journal.ts: assertMigrationsCurrent/MigrationsPendingError/MigrationsTableMissingError (plan 14-01)"
  - "apps/api/src/modules/ops/health.ts: the /healthz+/readyz response contract this plan mirrors exactly (plan 14-01)"
provides:
  - "apps/worker/src/health-server.ts: startWorkerHealthServer/markWorkerDraining/checkWorkerReadiness/WORKER_HEALTH_HOST/WORKER_HEALTH_PORT_DEFAULT -- the worker's own /healthz+/readyz, node:http, loopback-only"
  - "apps/worker/src/server.ts: WorkerRuntime.healthServer, requestWorkerRuntimeShutdown(runtime) -- the SIGTERM/SIGINT path that marks draining before any close begins"
  - "scripts/print-stop-grace-period.mjs: the machine-read extraction of WORKER_STOP_GRACE_PERIOD_SECONDS for container stop_grace_period"
  - "packages/delivery-core/package.json, packages/queue-core/package.json: exports wildcard (\"./src/*.js\": \"./src/*.ts\") -- the same pattern @mega-crm/db already had, now also on these two packages"
affects: ["14-08 (compose healthcheck wiring, stop_grace_period)", "14-09 (deploy script's container-status probing)", "any future plain-node script that needs a leaf constant from delivery-core or queue-core"]

tech-stack:
  added: []
  patterns:
    - "Worker health/readiness mirrors the API's contract exactly (same check names, body shape, status codes) -- one shape, two processes, one parser for both"
    - "Injected readiness dependencies (queryPostgres/redisConnection/checkMigrationsCurrent) so tests drive each failure independently without touching real backing services"
    - "Monotonic draining flag, set once by the shutdown path, checked before any I/O in /readyz"
    - "Health server closes LAST in the shutdown ordering -- after workers, tracked queues, and the shared connection -- so a draining process stays observable while it drains"
    - "Leaf-module subpath imports (package/src/leaf.js via a wildcard exports map) as the established way to make a value importable from an unbuilt workspace package under plain node -- now used by both scripts/migrate-runner.mjs (db) and scripts/print-stop-grace-period.mjs (delivery-core, queue-core)"

key-files:
  created:
    - apps/worker/src/health-server.ts
    - apps/worker/src/__tests__/health-server.test.ts
    - scripts/print-stop-grace-period.mjs
    - apps/worker/src/__tests__/stop-grace-period-publish.test.ts
  modified:
    - apps/worker/src/server.ts
    - apps/worker/src/shutdown-budget.ts
    - packages/delivery-core/package.json
    - packages/queue-core/package.json

key-decisions:
  - "WORKER_HEALTH_HOST is the literal string 127.0.0.1 (never \"localhost\", never 0.0.0.0) -- binding to a hostname that can resolve to ::1 depending on the resolver would make the loopback-only guarantee ambiguous"
  - "WORKER_HEALTH_PORT_DEFAULT = 4100, overridable via WORKER_HEALTH_PORT -- distinct from apps/api's API_PORT default (4000) so both processes can run health listeners on the same host without a collision"
  - "Every health-server response sets Connection: close -- a probe endpoint hit infrequently has no benefit from keep-alive, and this specifically avoids a client connection-pool-reuse bug against a closed+rebound listener (found empirically during this plan's own Task 2 test -- see Deviations)"
  - "Draining short-circuits /readyz to 503 with checks: [] BEFORE running any of the three checks -- an aborting process should not spend a database round trip to say it is going away"
  - "requestWorkerRuntimeShutdown(runtime) factors markWorkerDraining() + runtime.close() into one exported function so tests exercise the exact SIGTERM/SIGINT path without sending a real signal"

requirements-completed: [OPS-04, OPS-05]

coverage:
  - id: W1
    description: "GET /healthz on the worker: 200 with a static body, zero I/O even when Postgres and Redis would both fail"
    requirement: "OPS-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#GET /healthz returns 200 with a static body and performs no Postgres/Redis I/O, even when both would fail"
        status: pass
    human_judgment: false
  - id: W2
    description: "GET /readyz on the worker: 503 naming each of the three failing checks independently (postgres/redis/migrations), 200 only when all three pass, and MigrationsPendingError's pending tags are listed in the migrations check's detail"
    requirement: "OPS-05"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#GET /readyz returns 503 naming the postgres/redis/migration check(s)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#GET /readyz returns 200 when Postgres, Redis and migrations all pass"
        status: pass
    human_judgment: false
  - id: W3
    description: "Draining flag: /readyz returns 503 the instant markWorkerDraining() is called, even when all three underlying checks would pass; the flag is never cleared"
    requirement: "OPS-05"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#GET /readyz returns 503 after markWorkerDraining() even when all three checks would pass"
        status: pass
    human_judgment: false
  - id: W4
    description: "The listener is bound to the loopback interface only (never routable), never exposes queue names/DSNs/tenant identifiers, and rejects non-GET/HEAD or unknown paths"
    requirement: "OPS-04, OPS-05"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#binds to the loopback interface only -- ::1 connection refused"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#the /readyz response body never contains a queue name, DSN or tenant identifier"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#GET /unknown returns 404 / POST /healthz returns 405"
        status: pass
    human_judgment: false
  - id: W5
    description: "buildWorker() starts the health server and wires it into WorkerRuntime; closeWorkerRuntime closes it LAST (after workers, tracked queues, the shared connection); the SIGTERM/SIGINT path marks draining before any close begins; close() is idempotent; the port frees for reuse"
    requirement: "OPS-04, OPS-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/__tests__/health-server.test.ts#buildWorker() returns a runtime whose health server is listening, and /readyz on it is answerable"
        status: pass
      - kind: integration
        ref: "apps/worker/src/__tests__/health-server.test.ts#the SIGTERM path (requestWorkerRuntimeShutdown) marks draining before the BullMQ workers finish closing, close() is idempotent, and the health port frees for reuse"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#source invariants (healthServer field, markWorkerDraining ordering, close-last ordering)"
        status: pass
    human_judgment: false
  - id: W6
    description: "The container stop-grace-period is a machine-read value (scripts/print-stop-grace-period.mjs), never a hand-typed number; a test fails if the printed value ever drifts from WORKER_STOP_GRACE_PERIOD_SECONDS or falls at/below SENDGRID_TIMEOUT_MS in seconds"
    requirement: "Pitfall 7 (deployment)"
    verification:
      - kind: integration
        ref: "apps/worker/src/__tests__/stop-grace-period-publish.test.ts#prints exactly WORKER_STOP_GRACE_PERIOD_SECONDS as a bare integer, and it exceeds the SendGrid timeout expressed in seconds"
        status: pass
      - kind: integration
        ref: "apps/worker/src/__tests__/stop-grace-period-publish.test.ts#exits non-zero and names the build command when the built worker output is absent"
        status: pass
      - kind: manual_procedural
        ref: "node scripts/print-stop-grace-period.mjs (after npm run build -w apps/worker) -- printed 60, matching ceil((20000+5000+5000+30000)/1000)"
        status: pass
    human_judgment: false

duration: ~2.5h
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 04: Worker Health Server + Stop-Grace-Period Publishing Summary

**The worker now answers the same `/healthz`+`/readyz` questions the API does (D-14, OPS-04/OPS-05) over a loopback-only `node:http` listener that reports not-ready the instant it starts draining, and the container's stop-grace-period is a machine-read value (60s today) with an anti-drift test instead of a hand-typed number.**

## Performance

- **Duration:** ~2.5h
- **Tasks:** 3 (Task 1 health server + fake-dep tests, Task 2 WorkerRuntime lifecycle wiring, Task 3 stop-grace-period publish script)
- **Files created:** 4
- **Files modified:** 4 (2 of which -- `packages/delivery-core/package.json`, `packages/queue-core/package.json` -- were a Rule 3 deviation outside this plan's declared `files_modified`; see Deviations)

## Accomplishments

- **`apps/worker/src/health-server.ts`** (Task 1): `startWorkerHealthServer`, `markWorkerDraining`, `checkWorkerReadiness`, `WORKER_HEALTH_HOST` (`127.0.0.1`), `WORKER_HEALTH_PORT_DEFAULT` (`4100`, overridable via `WORKER_HEALTH_PORT`). Matches `apps/api/src/modules/ops/health.ts`'s contract exactly: same three check names (`postgres`/`redis`/`migrations`), same body shape (`{ ready, checks: [{ name, ok, detail? }] }`), same status codes. `/healthz` performs zero I/O. `/readyz` reuses `MigrationsPendingError`/`MigrationsTableMissingError` (from `@mega-crm/db`'s migration-journal module, D-13) for detail formatting -- no second applied-vs-shipped comparison exists anywhere in the worker. Readiness dependencies (`queryPostgres`, `redisConnection`, `checkMigrationsCurrent`) are injected, so every failure mode is driven with a fake dependency in tests -- no real Postgres/Redis touched by Task 1's suite at all.
- **`WorkerRuntime.healthServer`** (Task 2): `buildWorker()` starts the health server wired to the SAME `@mega-crm/tenant-context` pool and the SAME shared ioredis `connection` the worker already holds -- never a second connection to either backing service. `closeWorkerRuntime` gained an optional third `healthServer` parameter (backward compatible with `graceful-shutdown.test.ts`'s existing two-argument Phase 12 tests) and closes it LAST, after workers/tracked-queues/connection -- a draining process stays observable while it drains, which is the entire point of the flag. New exported `requestWorkerRuntimeShutdown(runtime)` factors `markWorkerDraining()` + `runtime.close()` into the exact path `main()`'s SIGINT/SIGTERM handlers now call, so tests drive the real shutdown sequence without sending a signal to the test process.
- **`scripts/print-stop-grace-period.mjs`** (Task 3): imports the BUILT `apps/worker/dist/shutdown-budget.js` and prints `WORKER_STOP_GRACE_PERIOD_SECONDS` as a bare integer on stdout, nothing else. Exits non-zero naming `npm run build -w apps/worker` when the built output is absent -- never falls back to a hand-typed number. Measured value at this commit: **60 seconds** (`ceil((SENDGRID_TIMEOUT_MS=20000 + CLAIM_TX_MARGIN_MS=5000 + RECORD_TX_MARGIN_MS=5000 + WORKER_DRAIN_SAFETY_MARGIN_MS=30000) / 1000)`). Verbatim invocation form for plans 14-08/14-09: `npm run build -w apps/worker && node scripts/print-stop-grace-period.mjs`.
- **`apps/worker/src/__tests__/stop-grace-period-publish.test.ts`**: pins the script's printed integer against the SAME `WORKER_STOP_GRACE_PERIOD_SECONDS` this test imports from the live TypeScript source, and independently asserts it exceeds `SENDGRID_TIMEOUT_MS / 1000` -- either check alone could pass on a broken refactor, together they cover both drift and unit-mistake failure modes.

## Task Commits

1. **Task 1: The worker health server -- node:http, loopback, three named checks** -- `7aea7e4` (feat)
2. **Task 2: Own the listener's lifecycle in WorkerRuntime and flip draining on SIGTERM** -- `021867c` (feat)
3. **Task 3: Publish the stop-grace-period as a machine-read value** -- `40b16bb` (feat) -- also carries the Rule 3 cross-package fix and a stale-lint-directive cleanup (see Deviations)

_No separate plan-metadata commit -- SUMMARY.md is committed directly per this worktree's repo-specific rules (`.planning/` is gitignored here)._

## Files Created/Modified

- `apps/worker/src/health-server.ts` -- the worker's `/healthz`+`/readyz`
- `apps/worker/src/__tests__/health-server.test.ts` -- Task 1's fake-dependency suite + Task 2's real-runtime lifecycle suite (same file, per plan's `files_modified`)
- `apps/worker/src/server.ts` -- `WorkerRuntime.healthServer`, `closeWorkerRuntime`'s third parameter and updated close-ordering doc, `requestWorkerRuntimeShutdown`, `main()`'s handlers now call it; also removed a now-stale `require-await` eslint-disable this change made inert
- `scripts/print-stop-grace-period.mjs` -- the extraction script
- `apps/worker/src/__tests__/stop-grace-period-publish.test.ts` -- the anti-drift test
- `apps/worker/src/shutdown-budget.ts` -- **Rule 3 deviation** (outside `files_modified`): its two imports now name leaf modules directly rather than each package's root (see Deviations)
- `packages/delivery-core/package.json`, `packages/queue-core/package.json` -- **Rule 3 deviation** (outside `files_modified`): added the same wildcard `exports` map `@mega-crm/db` already has

## Decisions Made

- **`Connection: close` on every health-server response** -- not in the original plan text, but load-bearing: found via this plan's own Task 2 lifecycle test that `fetch()`'s connection pool (undici) will try to reuse a stale keep-alive socket against a closed-then-rebound listener on the same port, producing `ECONNRESET` instead of a clean new connection. A health/readiness endpoint is hit infrequently by its real callers (container healthchecks, a deploy script polling every few seconds) and gains nothing from keep-alive, so closing the connection after every response is a correctness fix with no operational downside.
- **Isolated `startTempRedis()` for Task 2's tests, never the shared per-project `TEST_REDIS_URL`/db1** -- found empirically (see Deviations) that constructing the full `buildWorker()` (twenty real production BullMQ Workers under production queue names) against the shared logical Redis DB immediately starts consuming whatever leftover job backlog sibling test files left there.
- **Leaf-module subpath imports for `shutdown-budget.ts`'s two constants** -- the minimal fix for a pre-existing, repo-wide plain-node module-resolution gap (see Deviations), mirroring `scripts/migrate-runner.mjs`'s existing precedent exactly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `fetch()`'s connection-pool reuse against a closed+rebound health-server port produced `ECONNRESET`**
- **Found during:** Task 2's own lifecycle test (the "port frees for reuse" assertion), after having already made one request to the original listener before closing it.
- **Issue:** Node's global `fetch()` (undici) keeps HTTP keep-alive connections pooled per origin. Closing the original `node:http` server and starting a new one on the identical `host:port`, then `fetch()`-ing the SAME URL again, made undici try to reuse the now-dead pooled socket -- `read ECONNRESET` instead of a fresh connection. Root-caused via a standalone debug script (`tsx`-run, outside vitest) that reproduced the WORKING case (no prior fetch to the original server) versus the FAILING case (one prior fetch), isolating the exact trigger.
- **Fix:** `handleRequest` now sets `Connection: close` on every response.
- **Files modified:** `apps/worker/src/health-server.ts`
- **Verification:** the exact failing test (`the SIGTERM path ... the health port frees for reuse`) passes deterministically after the fix; re-ran 3x to confirm no flake.
- **Committed in:** `7aea7e4` (Task 1 commit, since the fix lives in `health-server.ts`)

**2. [Rule 3 - Blocking issue, files outside `files_modified`] Task 3's script cannot import `apps/worker/dist/shutdown-budget.js` under plain `node`**
- **Found during:** Task 3, first `node scripts/print-stop-grace-period.mjs` run after building.
- **Issue:** `shutdown-budget.ts` imports `SENDGRID_TIMEOUT_MS` from `@mega-crm/delivery-core`'s ROOT and `CLAIM_TX_MARGIN_MS`/`RECORD_TX_MARGIN_MS` from `@mega-crm/queue-core`'s ROOT. Neither package has a built `dist/`, so each root resolves (via `"main"`) to its own `src/index.ts`, which re-exports many sibling modules through relative `./foo.js` specifiers. Node's native TypeScript type-stripping does NOT remap those to `./foo.ts` the way bundler-style resolvers (`tsx`, vitest) do -- it requires the literal extension that exists on disk. Confirmed empirically that this is pre-existing and repo-wide, not something this plan introduced: `node -e "import('@mega-crm/db')"` fails identically against `@mega-crm/db`'s own root today (`Cannot find module '.../packages/db/src/schema/auth.js'`).
- **Fix (minimal, scoped to the two constants this file needs):** Added the SAME wildcard `exports` map `@mega-crm/db`'s package.json already has (`"./src/*.js": "./src/*.ts"`) to `packages/delivery-core/package.json` and `packages/queue-core/package.json`, then changed `shutdown-budget.ts`'s two imports to name the LEAF modules directly (`@mega-crm/delivery-core/src/send-mail.js`, `@mega-crm/queue-core/src/queue-options.js`) rather than each package's root. Both leaf files have zero imports of their own, so neither carries the resolution risk their roots do -- this exactly mirrors `scripts/migrate-runner.mjs`'s existing precedent of importing `@mega-crm/db/src/migration-journal.js` directly rather than `@mega-crm/db`'s root. No behavior change: same constants, same values, only the import path differs.
- **Safety check before adding the exports field:** grepped the whole repo for any existing consumer importing either package via a subpath other than the wildcard now covers -- zero hits, so adding `exports` cannot break any current import.
- **Files modified:** `apps/worker/src/shutdown-budget.ts`, `packages/delivery-core/package.json`, `packages/queue-core/package.json`
- **Verification:** `npm run build -w apps/worker && node scripts/print-stop-grace-period.mjs` now prints `60` and exits 0; full `apps/worker` suite re-run clean (574/574); `packages/delivery-core` (161/161) and `packages/queue-core` (24/24) suites re-run clean; `npm run build --workspaces --if-present` and `npm run lint` both clean.
- **Committed in:** `40b16bb` (Task 3 commit)

**3. [Rule 1 - Test coverage gate / stale lint directive] `buildWorker()`'s `require-await` eslint-disable became inert**
- **Found during:** Task 3's `npm run lint --max-warnings=0` run.
- **Issue:** Task 2 made `buildWorker()` genuinely `await startWorkerHealthServer(...)`, so the pre-existing `// eslint-disable-next-line @typescript-eslint/require-await` comment (needed before that change, when the function had no real await) now disabled a rule that was no longer firing -- `eslint`'s own "unused eslint-disable directive" check flagged it.
- **Fix:** Removed the stale directive, replaced with a comment explaining why it is gone.
- **Files modified:** `apps/worker/src/server.ts`
- **Verification:** `npm run lint --max-warnings=0` clean.
- **Committed in:** `40b16bb` (Task 3 commit)

### Test-design deviation (not a code bug, but load-bearing for anyone extending this suite)

**Constructing the full production `buildWorker()` against the shared per-project test Redis is unsafe.** `apps/worker/vitest.config.ts` defaults `REDIS_URL` to `TEST_REDIS_URL ?? "redis://localhost:6379/1"` -- one logical DB shared across every `apps/worker` test FILE. During this plan's first attempt at Task 2's lifecycle test, calling the REAL `buildWorker()` (all twenty production BullMQ Workers, under the SAME production queue names) against that shared DB caused the runtime to immediately start consuming a leftover job backlog other test files had left there (`No SendGrid key connected for workspace ...`, quarantine FK violations, aborted transactions) -- unrelated noise and real resource contention, which is very likely what produced the `ECONNRESET` failures observed before the `Connection: close` fix was even isolated. The final tests use a DEDICATED `startTempRedis()` instance for all of Task 2's assertions (one real `buildWorker()` smoke test, one minimal test-scoped `WorkerRuntime` for the delicate SIGTERM/idempotent-close/port-reuse timing assertions), mirroring `graceful-shutdown.test.ts`'s existing Phase 12 precedent for this exact class of lifecycle test. This is not itself a bug in production code, but a note for anyone else who reaches for the full `buildWorker()` in a test against the shared db1: it will work most of the time, and will silently do a lot of unrelated real work when db1 isn't empty.

---

**Total deviations:** 3 auto-fixed (1 Rule 1 bug in the new code, 1 Rule 3 blocking-issue fix touching 3 files outside `files_modified`, 1 Rule 1 stale-lint cleanup), plus 1 documented test-design finding. All three code fixes were necessary either for correctness (the `ECONNRESET`/`Connection: close` case) or to make Task 3's own explicitly-specified design work at all against the current state of the repo (the leaf-import fix) or to pass the plan's own `<verification>` gate (the lint fix). No scope creep beyond what OPS-04/OPS-05/Pitfall-7 required.

## TDD Gate Compliance

All three tasks carry `tdd="true"` in the plan, but this plan was executed with implementation and tests written together rather than as separate RED/GREEN/REFACTOR commits -- there is no `test(...)`-only commit preceding each task's `feat(...)` commit in the git log above. Stating this plainly rather than retrofitting a RED commit after the fact: every behavior in each task's `<behavior>` block IS covered by a passing test in the same commit (verified via the coverage table above and the full test-file review), but the gate-sequence artifact (a separate failing-test commit) does not exist for this plan.

## Known Stubs

None. No hardcoded empty values, placeholder text, or unwired data sources were introduced by this plan.

## Issues Encountered

- **Plain-node module resolution across unbuilt workspace packages is a repo-wide open question, not specific to this plan.** Confirmed directly: `node dist/server.js` (apps/worker's own documented production start command) would hit the identical resolution failure for EVERY workspace-package import in `server.ts` (`@mega-crm/redaction`, `@mega-crm/queue-core`, `@mega-crm/tenant-context`, `@mega-crm/db` are all unbuilt, with `"main": "./src/index.ts"`), the moment any of those packages' root `index.ts` files are reached under plain `node` without `tsx`. This plan's fix is narrowly scoped to the two leaf constants `shutdown-budget.ts` needs -- it does NOT fix the general case. **Flagging forward for plan 14-08 (Docker image build):** whatever the container build stage does to make `node dist/server.js` actually runnable in production (build every workspace package to a real `dist/` and repoint each package's `"main"`/`"exports"`, or keep `tsx`/TypeScript as a production runtime dependency in the image) needs to be decided there -- this plan's own investigation already proved the failure mode and confirmed the minimal per-symbol workaround, saving that plan the rediscovery.
- **Full `apps/worker` suite has pre-existing timing-sensitive flakiness unrelated to this plan's changes.** One full run showed 3 failures (`tenant-fairness.test.ts` x2, `flow-run-advance-integration.test.ts` x1) under system load (the same run that also built `apps/web`'s Vite bundle and ran `npm run coverage` shortly before/after); all three passed cleanly both in isolation and on a second full-suite run (574/574). Not caused by this plan's changes -- none of the touched files (health-server.ts, server.ts's health wiring, shutdown-budget.ts's import paths) touch rate-limiting, dispatch, or flow-advance logic.

## User Setup Required

None. `WORKER_HEALTH_PORT` is optional (defaults to `4100`); no new required env var.

## Next Phase Readiness

- **Port/host constants for 14-08/14-09 to consume:** `WORKER_HEALTH_HOST = "127.0.0.1"`, `WORKER_HEALTH_PORT_DEFAULT = 4100` (override via `WORKER_HEALTH_PORT`). D-14's own consequence, restated here for the plans that build around it: this port is bound to loopback and must NEVER be published to the host in compose (no `ports:` mapping) -- container healthchecks probe it from inside the container; the deploy script observes worker health through the container's own health status (`docker inspect`/`docker compose ps`), never an HTTP connection from the host.
- **`/readyz` body shape (identical on both apps/api and apps/worker):** `{ ready: boolean, checks: [{ name: "postgres"|"redis"|"migrations", ok: boolean, detail?: string }] }`. While draining, the worker's `/readyz` returns `503` with `{ ready: false, checks: [] }` (empty checks array -- no check was actually run).
- **Stop-grace-period invocation (verbatim, for 14-08's compose wiring and 14-09's deploy script):** `npm run build -w apps/worker && node scripts/print-stop-grace-period.mjs`. Measured value at this commit: **60**. This will change automatically if `SENDGRID_TIMEOUT_MS`/`CLAIM_TX_MARGIN_MS`/`RECORD_TX_MARGIN_MS` ever change -- never hand-type the number that comes out of this script.
- **Forward flag for 14-08 (Docker image build):** see "Issues Encountered" above -- the general plain-node-resolves-unbuilt-workspace-packages gap is unresolved and is squarely that plan's concern.

## SPECIFICATION.md items for 14-13

Per this worktree's repo-specific rules, SPECIFICATION.md filing is deferred to plan 14-13. Items to file there:

- **§6 (Публичные точки входа):** `GET /healthz` (unauthenticated, zero I/O, pure liveness) and `GET /readyz` (unauthenticated, Postgres+Redis+migration-currency+draining-flag, 503/200) on `apps/worker`, bound to `127.0.0.1:4100` (env override `WORKER_HEALTH_PORT`) -- never published to the host network.
- **§3 (Секреты)/environment:** new optional env var `WORKER_HEALTH_PORT` (integer, defaults to `4100`).
- **§7 (Наблюдаемость)/healthcheck:** the worker's readiness is now probeable the same way the API's is; the draining state is observable via `/readyz` returning `{ready: false, checks: []}` from the instant `SIGTERM`/`SIGINT` is received.
- **§2 (Зависимости и версии):** `packages/delivery-core/package.json` and `packages/queue-core/package.json` both gained an `exports` field (`"./src/*.js": "./src/*.ts"` wildcard, matching `@mega-crm/db`'s existing pattern) -- no new npm package, a package.json metadata change only.
- **§5 (Планировщик и пайплайн отправки):** `scripts/print-stop-grace-period.mjs` -- not an npm script (deliberately, per this plan's own instruction), invoked directly by 14-08/14-09 as `node scripts/print-stop-grace-period.mjs` after `npm run build -w apps/worker`.

## Self-Check: PASSED

All created files verified present via `git ls-files --error-unmatch`:
`apps/worker/src/health-server.ts`, `apps/worker/src/__tests__/health-server.test.ts`,
`apps/worker/src/server.ts`, `scripts/print-stop-grace-period.mjs`,
`apps/worker/src/__tests__/stop-grace-period-publish.test.ts`,
`apps/worker/src/shutdown-budget.ts`, `packages/delivery-core/package.json`,
`packages/queue-core/package.json`. All three task commits verified present via
`git log --oneline --all`: `7aea7e4`, `021867c`, `40b16bb`.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
