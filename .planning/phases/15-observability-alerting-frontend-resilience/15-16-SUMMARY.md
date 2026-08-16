---
phase: 15-observability-alerting-frontend-resilience
plan: 16
subsystem: infra
tags: [bull-board, fastify, bullmq, worker, health-check, queue-observability, read-only-admin-ui]

# Dependency graph
requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "15-01 installed @bull-board/api@8.6.1/@bull-board/fastify@8.6.1 and promoted apps/worker's fastify to a runtime dependency; 15-08 wrapped all 20 worker queue factories via processor-wrapper.ts"
provides:
  - "apps/worker's /healthz and /readyz re-hosted on Fastify with a provably byte-identical externally-observed contract"
  - "board-queues.ts: 20 read-only BullMQ Queue handles (one per queue the worker registers a Worker for), derived from queue-name constants, reusing 5 existing tracked producers"
  - "bull-board.ts: a read-only Bull Board UI mounted on the worker's loopback-only health listener at /admin/queues, enforced server-side (405 on any mutating route), reachable only via SSH tunnel"
  - "bullmq bumped 5.79.1 -> 5.79.4 in lockstep across apps/api, apps/worker, packages/db, packages/queue-core -- an undiscovered peer-dependency resolution gap for @bull-board/api, fixed and documented"
affects: []

# Tech tracking
tech-stack:
  added:
    - "apps/worker/src/health-server.ts now built on fastify@5.9.0 (was node:http) -- first genuine runtime use of the dependency plan 15-01 promoted"
    - "@bull-board/api@8.6.1 and @bull-board/fastify@8.6.1 -- first genuine runtime use (plan 15-01 installed manifest-only)"
    - "bullmq bumped 5.79.1 -> 5.79.4 (patch, same 5.79.x line) in apps/api, apps/worker, packages/db, packages/queue-core"
  patterns:
    - "beforeListen(app) hook on startWorkerHealthServer -- lets a sibling module (bull-board.ts) mount plugins onto the built-but-not-yet-listening Fastify instance without health-server.ts importing it, keeping the module boundary one-directional"
    - "board-queues.ts reuses existing module-scope tracked producer Queue instances by name (Map lookup) rather than constructing a duplicate handle, falling back to a fresh registered handle for every other queue name"

key-files:
  created:
    - apps/worker/src/bull-board.ts
    - apps/worker/src/queues/board-queues.ts
    - apps/worker/src/__tests__/health-server-contract.test.ts
    - apps/worker/src/__tests__/bull-board.test.ts
  modified:
    - apps/worker/src/health-server.ts
    - apps/worker/src/server.ts
    - apps/worker/src/queues/campaign-scheduler.worker.ts
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - apps/api/package.json
    - apps/worker/package.json
    - packages/db/package.json
    - packages/queue-core/package.json
    - package-lock.json
    - SPECIFICATION.md

key-decisions:
  - "Bumped bullmq 5.79.1 -> 5.79.4 in lockstep across all four workspaces that declare it (not just apps/worker) -- @bull-board/api@8.6.1's peer dependency (^5.79.2 || ^6.0.0, optional) was silently unresolvable at the project's pinned 5.79.1, a real production-shipping bug (confirmed via the pre-bump package-lock.json's own placement records: bullmq lived only under each workspace's own node_modules, never hoisted to root, so @bull-board/api had no resolvable path to it in any real npm ci, not just this worktree)"
  - "Classified the bullmq bump as Rule 1/3 auto-fixable, not the package-install human-verify checkpoint (T-15-SC) -- same already-approved package name, patch-level version within the CLAUDE.md-recommended 5.79.x line, verified live against the npm registry before bumping"
  - "beforeListen hook design on StartWorkerHealthServerDeps -- keeps health-server.ts and bull-board.ts's import relationship one-directional (bull-board.ts imports health-server.ts's types; health-server.ts never imports bull-board.ts), and gives Task 3's mount point the exact 'after routes exist, before listen()' timing the plan specifies"
  - "board-queues.ts reuses 5 existing module-scope tracked producer Queues (campaign-broadcast-producer.ts's emailBroadcastQueue; flow-queues.ts's emailTriggeredQueue/flowRunAdvanceQueue/flowTriggerEvaluatorQueue/flowSegmentSweepFlowQueue) by identity, never constructing or registering a duplicate handle for those 5 queue names"
  - "Exported CAMPAIGN_SCHEDULER_QUEUE and ANALYTICS_RECONCILE_QUEUE (previously unexported module-local consts) so board-queues.ts derives its list entirely from constants -- no hand-typed queue-name string anywhere in the file"

patterns-established:
  - "Contract-characterization test written and verified passing against the OLD implementation before a transport migration, then re-run unchanged (git diff empty) against the new implementation -- health-server-contract.test.ts as the template for any future re-hosting of an existing HTTP surface"

requirements-completed: [OPS-14]

coverage:
  - id: D1
    description: "The worker's health listener binds to 127.0.0.1 only; a request to the IPv6 loopback interface on the same port is refused"
    requirement: "OPS-14"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts#binds to the loopback interface only -- a connection via the IPv6 loopback address (::1) on the same port is refused"
        status: pass
    human_judgment: false
  - id: D2
    description: "GET /healthz returns 200 with zero I/O; GET /readyz returns 200/503 with the documented body shape and draining short-circuit -- contract proven byte-identical across the node:http -> Fastify migration"
    requirement: "OPS-14"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server-contract.test.ts (6 tests, run against both the pre-migration and post-migration implementation; test file diff between the two commits is empty)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/health-server.test.ts (18 pre-existing tests, unmodified, passing against the Fastify implementation)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The Bull Board UI is mounted on the worker's loopback-only listener and shows every queue the worker processes, with job counts"
    requirement: "OPS-14"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/bull-board.test.ts#the board's base path responds on the loopback listener"
        status: pass
    human_judgment: false
  - id: D4
    description: "The board is read-only: no route it exposes can retry, remove, promote, pause, or otherwise mutate a job -- enforced server-side via BullMQAdapter's readOnlyMode, not merely hidden UI controls"
    requirement: "OPS-14"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/bull-board.test.ts#the board is read-only: a mutating route (pause) is refused with 405, never performing the mutation"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every Queue handle constructed for the board is registered with the shutdown registry and closed on shutdown, leaving no open Redis connection"
    requirement: "OPS-14"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/bull-board.test.ts#every handle -- reused or newly constructed -- is registered with the shutdown registry, and closing empties it"
        status: pass
      - kind: other
        ref: "npx vitest run --root apps/worker (638 tests, 87 files) exits 0 with no hanging Redis handle"
        status: pass
    human_judgment: false
  - id: D6
    description: "docker-compose.prod.yml publishes no port for the worker health listener; the prod-compose validation gate keeps passing"
    requirement: "OPS-14"
    verification:
      - kind: other
        ref: "npm run verify:prod-compose (exit 0); git diff docker/docker-compose.prod.yml empty for this plan"
        status: pass
    human_judgment: false
  - id: D7
    description: "The board's queue list is derived from queue-name constants rather than hand-enumerated, so a new queue appears on the board without a code change to board-queues.ts (backstop-verified via filesystem enumeration)"
    requirement: "OPS-14"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/bull-board.test.ts#the number of *.worker.ts factory files on disk matches boardQueues' length (backstop against a forgotten future queue)"
        status: pass
    human_judgment: false
  - id: D8
    description: "bullmq bumped 5.79.1 -> 5.79.4 in lockstep across all four workspaces that declare it, resolving @bull-board/api's peer-dependency requirement -- a discovered, unplanned dependency fix, documented as such rather than silently folded in"
    verification:
      - kind: other
        ref: "npm ls bullmq shows one deduped bullmq@5.79.4 at repo root; node -e \"require('@bull-board/api/bullMQAdapter')\" resolves cleanly; npm run check:lockfile-npm10 passes"
        status: pass
    human_judgment: true
    rationale: "This is a dependency-version decision touching four workspaces and the shared package-lock.json outside this plan's originally declared scope (T-15-SC states 'No installs in this plan'). Fully justified and verified in this SUMMARY and SPECIFICATION.md section 2.7.2, but a human should confirm the classification (patch-bump-of-an-already-approved-package, not a new-package install requiring the blocking legitimacy checkpoint) is accepted before this ships."

# Metrics
duration: ~55min
completed: 2026-08-16
status: complete
---

# Phase 15 Plan 16: Bull Board Behind Closed Administrative Access Summary

**Worker health listener re-hosted on Fastify (contract proven byte-identical) with a read-only Bull Board mounted at /admin/queues, showing all 20 worker queues over the existing loopback-only, unpublished listener — plus a discovered-and-fixed bullmq peer-dependency gap that would have broken this in any real `npm ci`.**

## Performance

- **Duration:** ~55 min
- **Completed:** 2026-08-16T06:39:00Z
- **Tasks:** 3 (both tdd="true" tasks executed as separate RED/GREEN-equivalent commits per their own explicit two-stage acceptance criteria; Task 3 executed as a single commit plus two unplanned fix commits for a discovered dependency issue)
- **Files modified:** 13 application/config files + `package-lock.json` (see Files Created/Modified)

## Accomplishments

- Re-hosted `apps/worker`'s `/healthz`/`/readyz` listener from `node:http` onto Fastify, with the externally-observed contract (status codes, body shape, `Connection: close` header, draining short-circuit) proven byte-identical via a characterization test written and verified passing against the OLD implementation first, then re-run unchanged against the new one
- Built `board-queues.ts`: 20 read-only BullMQ `Queue` handles, one per queue the worker registers a `Worker` for, derived entirely from queue-name constants (no hand-typed string), reusing 5 existing tracked producer `Queue` instances instead of opening duplicate handles, and registering the other 15 with the existing shutdown registry
- Mounted a read-only Bull Board (`bull-board.ts`) on that same Fastify instance at `/admin/queues` — read-only mode enforced server-side by `@bull-board/api`'s own `queueProvider` (405 on any mutating route), reachable only via the existing SSH-tunnel access path (no port published, `docker-compose.prod.yml` untouched)
- **Discovered and fixed an unplanned, real dependency bug:** `@bull-board/api@8.6.1`'s optional peer dependency on `bullmq: "^5.79.2 || ^6.0.0"` was unsatisfiable at the project's pinned `5.79.1` — confirmed via the pre-bump `package-lock.json` itself (bullmq was never hoisted to the repo root, only into each of the four declaring workspaces' own `node_modules`), meaning this would have broken identically in a real `npm ci` / Docker build, not just in this worktree. Bumped to `5.79.4` (the latest `5.79.x` patch) in lockstep across all four workspaces, regenerated the lockfile under npm 10 per the established remediation, and documented the discovery, the classification rationale (not a new-package install), and the fix in `SPECIFICATION.md` section 2.7.2

## Task Commits

Each task was committed atomically (two of three tasks are `tdd="true"` and produced RED+GREEN-equivalent commit pairs per their own explicit two-stage acceptance criteria):

1. **Task 1: Pin the health contract, then re-host it on Fastify**
   - `d86f139` (test) — `health-server-contract.test.ts` added and verified passing against the pre-migration `node:http` implementation
   - `f9e0f2d` (feat) — `health-server.ts` migrated to Fastify; the same contract test passes unchanged (file diff between the two commits is empty)
2. **Task 2: Read-only queue handles for board introspection**
   - `ded75ae` (test) — `bull-board.test.ts` added, failing (module not found: `board-queues.ts` did not exist yet); also exports `CAMPAIGN_SCHEDULER_QUEUE`/`ANALYTICS_RECONCILE_QUEUE`, the RED test's own prerequisites
   - `b4fd2a0` (feat) — `board-queues.ts` created; the test passes
   - `f3aa909` (fix) — widened a reused-producer `Queue` map past a TypeScript generic-unification error discovered by `tsc -p apps/worker/tsconfig.json`
3. **Task 3: Mount the read-only board and document the access path**
   - `c04da43` (fix, unplanned) — bumped `bullmq` `5.79.1` → `5.79.4` in lockstep across four workspaces (peer-dependency resolution for `@bull-board/api`), regenerated `package-lock.json`, documented in `SPECIFICATION.md` §2.7.2
   - `419fbf0` (feat) — `bull-board.ts` created and wired into `server.ts`; `bull-board.test.ts` extended with the mount/read-only integration tests; `SPECIFICATION.md` sections 2, 6, 7, 8, 9 updated

**Plan metadata:** committed separately per `<planning_dir_git_rules>` — `git add -f .planning/phases/15-observability-alerting-frontend-resilience/15-16-SUMMARY.md && git commit` (this file's own commit, made immediately after this Write).

## Files Created/Modified

- `apps/worker/src/health-server.ts` — re-hosted on Fastify; adds `beforeListen(app)` hook to `StartWorkerHealthServerDeps`
- `apps/worker/src/bull-board.ts` — new; `mountBullBoard(app)`, `BULL_BOARD_BASE_PATH`
- `apps/worker/src/queues/board-queues.ts` — new; exports `boardQueues: Queue[]`
- `apps/worker/src/server.ts` — wires `beforeListen: mountBullBoard` into `startWorkerHealthServer(...)`
- `apps/worker/src/queues/campaign-scheduler.worker.ts` — exports `CAMPAIGN_SCHEDULER_QUEUE` (was module-local)
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` — exports `ANALYTICS_RECONCILE_QUEUE` (was module-local)
- `apps/worker/src/__tests__/health-server-contract.test.ts` — new; the pre/post-migration characterization test
- `apps/worker/src/__tests__/bull-board.test.ts` — new; board-queues.ts coverage + bull-board.ts mount/read-only integration tests
- `apps/api/package.json`, `apps/worker/package.json`, `packages/db/package.json`, `packages/queue-core/package.json` — `bullmq` `5.79.1` → `5.79.4`
- `package-lock.json` — regenerated (real `npm install` + npm-10 `--package-lock-only` remediation)
- `SPECIFICATION.md` — §2.3/§2.5/§2.7.2 (bullmq bump + bull-board now-used), §6.17 (Fastify migration) + new §6.22 (Bull Board mount), §7 (four stale "Bull Board отсутствует" mentions corrected), §8.1/§8.3 (resolved discrepancy row moved), §9 item 10 updated

## Decisions Made

- Bumped `bullmq` in lockstep across all four declaring workspaces rather than only `apps/worker` — a single mismatched exact pin would have reproduced the non-hoist for whichever workspace was left behind
- Classified the bullmq bump as a Rule 1/3 auto-fix (bug/blocking-issue fix), not the package-install human-verify checkpoint (T-15-SC) — same already-approved package, patch-level bump within the CLAUDE.md-recommended `5.79.x` line, version verified live against the npm registry before bumping. Recorded as `human_judgment: true` in this SUMMARY's coverage block specifically for this classification call, even though the technical fix itself is fully verified
- Deleted the worktree's ad-hoc `node_modules` symlinks (into the main checkout) before running a REAL `npm install`, to avoid mutating the shared main-checkout tree mid-flight — the real install materialized a private `node_modules` tree scoped to this worktree
- `board-queues.ts` reuses 5 existing tracked producer `Queue` instances by identity (`Map` lookup on queue name) rather than constructing fresh handles for them — verified with `toBe` (reference equality), not just `toEqual`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] bullmq 5.79.1 unresolvable by @bull-board/api's peer dependency**
- **Found during:** Task 3 (mounting Bull Board — the first real runtime use of `@bull-board/api`/`@bull-board/fastify` since plan 15-01 installed them manifest-only)
- **Issue:** `@bull-board/api@8.6.1` declares `peerDependencies.bullmq: "^5.79.2 || ^6.0.0"` (optional). The project's pinned `bullmq@5.79.1` is one patch below that minimum. Because the peer is optional, npm does not force a satisfying nested copy on mismatch — `require('bullmq')` from inside `@bull-board/api`'s own code had no resolvable path. Confirmed this was a real, pre-existing, production-shipping bug (not a worktree artifact) via the PRE-bump `package-lock.json`'s own placement records: `bullmq` was recorded only under each of the four declaring workspaces' own `node_modules`, never at the repo root
- **Fix:** Bumped `bullmq` `5.79.1` → `5.79.4` (latest `5.79.x` patch, verified live against the npm registry) in `apps/api`, `apps/worker`, `packages/db`, `packages/queue-core`; ran a real `npm install`, then regenerated `package-lock.json` under npm 10 per plans 15-01/15-11's own established remediation
- **Files modified:** `apps/api/package.json`, `apps/worker/package.json`, `packages/db/package.json`, `packages/queue-core/package.json`, `package-lock.json`, `SPECIFICATION.md` (new §2.7.2)
- **Verification:** `npm ls bullmq` shows one deduped `bullmq@5.79.4`; `node -e "require('@bull-board/api/bullMQAdapter')"` resolves cleanly; `npm run check:lockfile-npm10` passes; full `apps/worker` suite (638 tests) passes
- **Committed in:** `c04da43` (separate `fix` commit, ahead of the `feat` commit that actually mounts the board)

**2. [Rule 1 - Bug] TypeScript generic-unification error in board-queues.ts's reused-producer map**
- **Found during:** Task 3 (running `tsc -p apps/worker/tsconfig.json` after wiring `bull-board.ts` into `server.ts`)
- **Issue:** A `Map<string, Queue>` literal holding five `Queue<SpecificJobType>` instances with mutually-incompatible job-payload generics failed to typecheck — TypeScript tried to unify their `add()` signatures into one impossible type
- **Fix:** Widened each entry to the untyped `Queue` via an explicit cast (a Bull Board handle has no use for the job-payload generic)
- **Files modified:** `apps/worker/src/queues/board-queues.ts`
- **Verification:** `tsc -p apps/worker/tsconfig.json` exits 0; `bull-board.test.ts` still passes (reference-equality assertions on the reused producers unaffected)
- **Committed in:** `f3aa909` (separate `fix` commit)

---

**Total deviations:** 2 auto-fixed (1 blocking dependency-resolution bug, 1 TypeScript compile bug)
**Impact on plan:** Deviation 1 is load-bearing — without it, Task 3's deliverable (the Bull Board mount) would fail to even import in any real install (including the production Docker build), not just fail a test. Both are necessary for correctness; no scope creep. Deviation 1 does touch four package.json files and the shared lockfile outside this plan's originally-declared "no installs" scope (T-15-SC) — documented prominently here and in `SPECIFICATION.md` §2.7.2 rather than silently folded in, and flagged with `human_judgment: true` in this SUMMARY's coverage block (D8) specifically for the classification call (not the technical fix, which is fully verified).

## Issues Encountered

- **Worktree had no `node_modules` at all** (fresh checkout). Initially worked around this by symlinking the main checkout's `node_modules` directories into the worktree — sufficient until Task 3 needed a REAL dependency-graph change (the bullmq bump), at which point the symlinks were deleted and a genuine `npm install` was run in the worktree instead, to avoid mutating the shared main-checkout tree mid-flight. All symlinks were removed before the final commit; `git status` is clean (no leftover untracked artifacts).
- Port `4190` (the initially-chosen test port for `health-server-contract.test.ts`) is on the WHATWG fetch spec's "bad ports" blocklist (`sieve`/ManageSieve) — `fetch()` refused to even attempt a connection (`TypeError: fetch failed` / `Error: bad port`). Switched to port `4191`, documented in the test file's own comment so a future reader doesn't rediscover this the hard way.

## User Setup Required

None — no external service configuration required by this plan. The Bull Board is reachable only through the SSH access an operator already has to the production host (D-09); no new credential, environment variable, or account is introduced.

## Next Phase Readiness

- `apps/worker`'s health listener is on Fastify with a provably unchanged external contract — any future plan needing to add another route/plugin to this listener (the explicit reason Phase 14 reserved it) can now do so via the same `beforeListen`-style pattern or direct `app.register(...)` calls, without another transport migration
- `board-queues.ts`'s `boardQueues` export is available for any future observability work that needs read-only handles to every worker queue
- Phase success criterion 3's Bull Board half (OPS-14: "the board is reachable only behind administrative access") is satisfied and test-proven
- One open item for a human to explicitly ratify: the bullmq version bump's classification (Rule 1/3 auto-fix vs. requiring T-15-SC's blocking package-legitimacy checkpoint) — the technical fix itself is fully verified and low-risk (patch bump of an already-approved package), but it does touch four `package.json` files and the shared lockfile outside this plan's originally-declared scope

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-16*

## Self-Check: PASSED

All 7 claimed files confirmed present on disk (`apps/worker/src/bull-board.ts`, `apps/worker/src/queues/board-queues.ts`, `apps/worker/src/health-server.ts`, `apps/worker/src/server.ts`, `apps/worker/src/__tests__/health-server-contract.test.ts`, `apps/worker/src/__tests__/bull-board.test.ts`, this SUMMARY.md). All 7 task/fix commit hashes (`d86f139`, `f9e0f2d`, `ded75ae`, `b4fd2a0`, `f3aa909`, `c04da43`, `419fbf0`) confirmed present in `git log --oneline --all`.
