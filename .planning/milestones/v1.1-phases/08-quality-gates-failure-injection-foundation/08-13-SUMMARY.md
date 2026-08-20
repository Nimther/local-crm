---
phase: 08-quality-gates-failure-injection-foundation
plan: 13
subsystem: testing
tags: [failure-injection, redis, aof, durability, bullmq, restart]

requires:
  - phase: 08-04
    provides: docker/redis.conf with appendonly/appendfsync, and the temp-redis harness this extends
  - phase: 08-08
    provides: the failure-injection directory and the four sibling scenarios
provides:
  - TempRedis.restart() — SIGTERM and restart from the same data directory
  - npm run failure:redis-restart and npm run failure:all
  - docs/failure-injection-scenarios.md — the five-scenario checklist D-20 requires
affects: [08-14, 08-18, phase-11-delivery-state-machine, phase-12-worker-reliability]

tech-stack:
  added: []
  patterns:
    - "Every survival assertion ships with its own discrimination proof — the same sequence against an unconfigured server, asserting loss"
    - "Scenario inventory lives in prose mapped to real paths, asserted mechanically, and explicitly not represented by a coverage number"

key-files:
  created:
    - apps/worker/src/queues/__tests__/failure-injection/redis-restart.test.ts
    - docs/failure-injection-scenarios.md
    - packages/segments-core/vitest.config.ts
    - packages/shared-schemas/vitest.config.ts
  modified:
    - packages/test-support/src/harness/temp-redis.ts
    - vitest.config.ts
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "A real process restart of a temp redis-server replaces docker restart — user-approved, continuing 08-04's resolution; one mechanism everywhere rather than an environment branch"
  - "SIGTERM, not SIGKILL, because Redis fsyncs on clean shutdown and that is what docker restart does"
  - "The discrimination proof is a permanent test, not a recorded observation"
  - "failure:all exists but CI must run the five separately, so an ordering dependency surfaces instead of hiding"

patterns-established:
  - "A package with a test script needs its own vitest.config.ts once a root aggregate exists, or the aggregate leaks into its standalone run"

requirements-completed: [QG-06, WRK-12]

coverage:
  - id: D1
    description: "Jobs enqueued before a real Redis restart are still waiting after it, and are processed afterwards"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/redis-restart.test.ts#keeps jobs enqueued before the restart, and processes them after it"
        status: pass
    human_judgment: false
  - id: D2
    description: "The survival assertion discriminates — the same sequence without the versioned config loses every job"
    requirement: WRK-12
    verification:
      - kind: integration
        ref: "redis-restart.test.ts#loses the same jobs without the versioned config — before=5, after=0"
        status: pass
    human_judgment: false
  - id: D3
    description: "All five audit-named failure modes run individually and green"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "failure:429 (3 tests), failure:timeout (1), failure:reset (1), failure:sigkill (1), failure:redis-restart (2) — each exit 0 run separately"
        status: pass
    human_judgment: false
  - id: D4
    description: "The five scenarios are tracked in a written checklist mapped to real script names and file paths, kept apart from the coverage number"
    requirement: QG-06
    verification:
      - kind: unit
        ref: "the plan's verify command — every listed script exists in package.json and every listed test path exists on disk (8 path references checked)"
        status: pass
    human_judgment: true
    rationale: "Whether the recorded outcomes still describe what each test asserts is a reading judgment; the mechanical check only proves the paths and script names are real."
  - id: D5
    description: "The 08-11 regression that broke standalone runs of the two config-less packages is fixed"
    verification:
      - kind: integration
        ref: "npm run test --workspaces — exit 0 across all nine workspaces, 615 tests; segments-core 19 and shared-schemas 18 run standalone again"
        status: pass
    human_judgment: false

duration: 44 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 13: Redis Restart Survival Summary

**The fifth and last audit-named failure mode — jobs survive a real Redis restart, proven against a server that loses them without the versioned config — plus the written five-scenario checklist a coverage percentage must never stand in for.**

## Performance

- **Duration:** 44 min
- **Started:** 2026-07-28T11:18:00Z
- **Completed:** 2026-07-28T12:02:00Z
- **Tasks:** 3
- **Files modified:** 8 (4 created, 4 modified)

## All five, run individually

| Command | Exit | Tests |
|---|:--:|---|
| `npm run failure:429` | 0 | 3 passed |
| `npm run failure:timeout` | 0 | 1 passed |
| `npm run failure:reset` | 0 | 1 passed |
| `npm run failure:sigkill` | 0 | 1 passed |
| `npm run failure:redis-restart` | 0 | 2 passed |

Run separately, which is the SPEC acceptance criterion — a scenario that only passes when its siblings ran first is not a reproducible failure mode.

## Accomplishments

- **The restart is real.** `TempRedis.restart()` sends SIGTERM, waits for exit, and starts the server again on the same port from the same data directory. SIGTERM rather than SIGKILL because Redis performs a final fsync on a clean shutdown — which is exactly what `docker restart` does to a container, and the reason survival is a guarantee rather than a hope.
- **Both halves are asserted.** The waiting count survives *and* a worker attached afterwards processes all of them. Either alone is satisfiable by the wrong thing: a surviving-but-unprocessable queue, or jobs that something re-enqueued.
- **The scenario carries its own discrimination proof.** A second test runs the identical sequence against a **stock** server — no `docker/redis.conf`, therefore no AOF — and asserts the jobs are **gone**. Verified before it was written: `before=5, after=0`. This is what makes the first assertion a statement about the durability configuration rather than about Redis happening to still be warm, and it turns 08-04's config claim into a behavioural one.
- **`docs/failure-injection-scenarios.md`** maps all five modes to their real script names, file paths, asserted outcomes and injection mechanisms — with every path asserted to exist mechanically, not transcribed from the plan's prose.

### Why the checklist is separate from the coverage number

A coverage percentage measures *which lines executed*, not *which failure modes were reproduced*. Coverage can stay green while a scenario quietly rots, because a deleted assertion still executes the lines around it. D-20 keeps the two apart, and the document says so and names the three assertions Phase 11 must revisit when `send_status` gains its reconciling value.

`failure:all` exists as a local convenience. The document states plainly that **CI runs the five separately**, so an ordering dependency between them surfaces as a failure instead of hiding behind an aggregate script.

## Task Commits

All three tasks landed in `ce459e2`.

## Files Created/Modified

- `apps/worker/src/queues/__tests__/failure-injection/redis-restart.test.ts` — the scenario and its discrimination proof
- `docs/failure-injection-scenarios.md` — the checklist
- `packages/test-support/src/harness/temp-redis.ts` — `restart()`, with the spawn/ready logic factored so start and restart share it
- `packages/segments-core/vitest.config.ts`, `packages/shared-schemas/vitest.config.ts` — see Deviation 2
- `vitest.config.ts` — the two packages now referenced by config path like every other project
- `package.json` — `failure:redis-restart`, `failure:all`
- `SPECIFICATION.md` — §1.2 records `restart()`

## Deviations from Plan

### 1. [Rule 4 — Architectural, user-approved] A process restart replaces the container restart

- **Issue:** the plan's Task 1 artifact is `packages/test-support/src/harness/docker-restart.ts` with `restartContainer`/`waitForHealthy` shelling out to `docker compose`, and its unit test requires a running compose stack. Docker is not installed on this machine — the constraint 08-01 recorded and 08-04 partially resolved. Unlike 08-04, here the **artifact itself** is Docker-shaped, not just its verification.
- **Resolution:** presented to the user with three options; they chose the process restart, continuing the resolution they had already directed in 08-04. `TempRedis.restart()` replaces `restartContainer`/`waitForHealthy`, and no file named `docker-restart.ts` was created — a name describing a mechanism the code does not use would be actively misleading.
- **What this costs:** the container lifecycle (`command:` override, `:ro` mount) is still not exercised locally. That was already recorded in 08-04 as CI-only and is unchanged.
- **What this buys:** one mechanism, identical locally and in CI, with no environment branch — the property the whole phase is built around. The durability question the scenario exists to answer is about AOF surviving a clean shutdown, and a process restart is that same event.

### 2. [Rule 3 — Blocker] An 08-11 regression, caught by this plan's full-suite run

- **Found during:** Task 2's verification, running `npm run test --workspaces`.
- **Issue:** `packages/segments-core` and `packages/shared-schemas` ship no `vitest.config.ts`. With 08-11's root aggregate in place, `vitest run` inside those directories walks **up**, finds the root config, and resolves its `projects` paths relative to *itself* — producing `packages/segments-core/apps/api/vitest.config.ts` and a startup error. `npm run test --workspaces` failed.
- **Why 08-11 missed it:** its Task 1 verified `npm run test -w packages/segments-core` **before** the root config existed, and its Task 2 verification ran the aggregate but not the per-workspace suite. The empirical finding it recorded — that the aggregator accepts bare directory entries — was correct, and the converse was never checked.
- **Fix:** both packages got the minimal config 08-11's plan had provisionally called for, and the root aggregate now references them by path like every other project. The stale comment explaining the bare-directory choice was replaced with the real reason.
- **Verification:** all nine workspaces green standalone, `npm run test --workspaces` exit 0, aggregate still collects 100 files.

### 3. [Rule 1 — Bug, in own work] Wrong relative depth to `docker/redis.conf`

Five `../` instead of six from `failure-injection/`. Caught on the first run by the harness's own "config file not found" guard, which named the wrong path it had built — the guard doing exactly its job.

---

**Total deviations:** 1 architectural (user-approved), 1 blocker (a prior plan's regression), 1 auto-fixed.
**Impact on plan:** One artifact replaced by a differently-named equivalent, for a reason the user decided. Two files beyond `files_modified`, both required to unblock this plan's own verification.

## Issues Encountered

- **08-11's coverage number moved slightly**, from `0.802575` to `0.802347` (3418/4260). The harness files added by 08-12 and 08-13 contribute both covered and uncovered lines. The recorded threshold is unchanged and the gate is still red by design — 08-16 is what closes it.
- **The scenario runs in ~1.3s**, which looks too fast for a durability test. It is not: `appendfsync everysec` means the fsync is already done by the time the queue reports the jobs waiting, and a SIGTERM shutdown flushes the rest. The discrimination test is what proves the speed is not the assertion being vacuous.

## User Setup Required

`redis-server` on `PATH` — already the case. Scenario 5 starts its own throwaway instance and never touches the server on 6379.

## Next Phase Readiness

- **QG-06 is now complete in substance** — all five audit-named modes are reproducible by one command each, with asserted database and queue outcomes. The requirement ID marks complete once the shared-ID gate sees every declaring plan finished.
- **WRK-12 likewise** — 08-04 recorded the configuration, this proves it behaves.
- **08-18** should register the five as separate CI steps, not `failure:all`, for the reason the checklist states.
- **Phase 11** has its map: `docs/failure-injection-scenarios.md` names the three assertions that encode today's terminal state and must be changed deliberately, not treated as regressions.
- **Phase 12** inherits the boundary this plan deliberately did not cross: BullMQ's behaviour at the memory ceiling.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
