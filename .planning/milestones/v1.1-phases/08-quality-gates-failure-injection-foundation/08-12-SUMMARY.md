---
phase: 08-quality-gates-failure-injection-foundation
plan: 12
subsystem: testing
tags: [failure-injection, sigkill, ipc, child-process, send-dispatch, crash-recovery]

requires:
  - phase: 08-08
    provides: the failure-injection directory, the shared fixtures and the stranded-claim assertion chain this scenario reuses
provides:
  - packages/test-support/src/harness/spawn-and-kill.ts — domain-free spawn / await-ready / SIGKILL orchestration
  - apps/worker/src/test/harness/sigkill-entrypoint.ts — the child that freezes inside the claim window
  - npm run failure:sigkill
affects: [08-13, 08-18, phase-11-delivery-state-machine]

tech-stack:
  added: []
  patterns:
    - "Kill timing driven by an IPC marker emitted from inside the injected seam, never by a timer or a poll"
    - "Generic orchestration in packages/*, domain-specific entrypoint in apps/*, passed by path — keeps every dependency arrow pointing app -> package"

key-files:
  created:
    - packages/test-support/src/harness/spawn-and-kill.ts
    - packages/test-support/src/__tests__/spawn-and-kill.test.ts
    - apps/worker/src/test/harness/sigkill-entrypoint.ts
    - apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts
  modified:
    - packages/test-support/src/index.ts
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "node:child_process.fork over execa — the IPC channel is the primitive the module exists to provide, and execa would wrap exactly that. execa remains declared-but-unused"
  - "D-22's entrypoint location deviated from deliberately: generic orchestration in packages/test-support, worker-specific entrypoint in apps/worker, so no packages/* module depends on an apps/* one"
  - "The freezing fake posts the ready marker BEFORE returning the never-settling promise; reversing those two lines reintroduces the race D-23 removed"
  - "No timer anywhere in the entrypoint — the open IPC channel is what keeps the frozen child alive"

patterns-established:
  - "A harness helper that must cross the workspace boundary earns it by naming no domain concept — asserted by grep, not by intent"

requirements-completed: [QG-06]

coverage:
  - id: D1
    description: "A real separate OS process running the real processSendJob against live services is killed with SIGKILL, not simulated in-process"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts — asserts exit.signal === 'SIGKILL' and exit.code === null"
        status: pass
    human_judgment: false
  - id: D2
    description: "The kill lands inside the claim-committed-but-not-recorded window, driven by an IPC marker rather than a timer or a poll"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "sigkill.test.ts — intermediate sends status is 'dispatching' immediately after the kill"
        status: pass
      - kind: manual_procedural
        ref: "grep -cE 'setTimeout|setInterval' on the entrypoint returns 0; grep -cE 'setTimeout|sleep|waitFor.*status' on the test returns 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "A restart does not re-send: zero further send attempts and no duplicate row"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "sigkill.test.ts — counting sendMail call count 0, outcome 'failed', sends row count 1"
        status: pass
    human_judgment: false
  - id: D4
    description: "The scenario is deterministic, not flaky"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "npm run failure:sigkill run five consecutive times — exit 0 on all five"
        status: pass
    human_judgment: false
  - id: D5
    description: "The spawn/kill helper is domain-free and adds no dependency on an app workspace"
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/spawn-and-kill.test.ts — 4 tests"
        status: pass
      - kind: manual_procedural
        ref: "grep -cE 'processSendJob|sends|worker|campaign' on the helper returns 0; test-support declares no @mega-crm/* dependency"
        status: pass
    human_judgment: false
  - id: D6
    description: "No scenario reaches the real SendGrid endpoint; the real queue runtime is never booted"
    requirement: QG-06
    verification:
      - kind: manual_procedural
        ref: "neither harness file references api.sendgrid.com or boots the queue runtime; only sendMail is injected"
        status: pass
    human_judgment: false

duration: 31 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 12: SIGKILL Crash-Recovery Scenario Summary

**A real child process running the real dispatch path is frozen inside the claim window by an IPC marker, SIGKILLed, observed stranded at `dispatching`, and proven not to re-send on restart — five consecutive runs, no timer anywhere in the mechanism.**

## Performance

- **Duration:** 31 min
- **Started:** 2026-07-28T10:47:00Z
- **Completed:** 2026-07-28T11:18:00Z
- **Tasks:** 3
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments

- **A real process dies.** The other four scenarios inject a fake and stay in-process. This forks a child, lets it run the real `processSendJob` against the same live Postgres and Redis the parent uses, and SIGKILLs it — a signal that cannot be caught, blocked or ignored, so the child runs no shutdown path on the way out.
- **The kill is deterministic and lands where it must.** SPEC R6 states outright that an arbitrary kill moment proves nothing. The child's injected mail function posts an IPC marker and *then* returns a promise that never settles; the parent kills in response to that marker. Because the marker is emitted from inside the call that the claim commit immediately precedes, the process is provably frozen **in** the window rather than approaching it.
- **The intermediate assertion is what proves the landing.** `sends` status is `dispatching` immediately after the kill. Without that observation, a child that died before ever committing its claim would satisfy the final no-duplicate assertion just as well — and prove nothing.
- **`npm run failure:sigkill` — five consecutive runs, all exit 0.** This is the one scenario in the phase with a real process boundary; a flaky one would be worse than useless as a Phase 11 baseline.

### The D-22 deviation, stated openly

D-22 places the harness entrypoint in `packages/test-support`. Taken literally that requires the package to `import { processSendJob } from "@mega-crm/worker"` — but `apps/worker/package.json` declares no `main`, `types` or `exports`, and **no `packages/*` workspace in this repository depends on any `apps/*` workspace**. Every dependency arrow points app → package.

The split therefore runs along the boundary rather than inverting it:

| Piece | Location | Why |
|---|---|---|
| spawn / IPC / kill orchestration | `packages/test-support/src/harness/spawn-and-kill.ts` | generic and reusable, exactly as D-22 requires |
| the child entrypoint importing `processSendJob` | `apps/worker/src/test/harness/sigkill-entrypoint.ts` | worker-specific; passed to the helper by path |

Every substantive clause of D-22 holds: a real separate process, the real dispatch path, live Postgres and Redis, only `sendMail` injected, no new seam in `send-dispatch.ts`. 08-RESEARCH.md flags the same gap and makes the same recommendation (§ D-22 mechanics gap, A5). The helper earns its place across the boundary by **naming no domain concept at all** — asserted by grep, not by intention.

### fork over execa

`node:child_process.fork` was chosen because the IPC channel is the primitive this module exists to provide, and execa would add a layer over exactly the feature in use. The rest of the harness in this package (`temp-redis.ts`) is already built on Node built-ins. `execa@10.0.0` remains declared in the manifest and unused — now recorded as such in SPECIFICATION.md §2.5, rather than left looking like a pending dependency waiting for this plan.

## Task Commits

All three tasks landed in `a96f3ba`. The helper, the entrypoint and the scenario are only meaningful together, and the run that verifies any of them verifies all three.

## Files Created/Modified

- `packages/test-support/src/harness/spawn-and-kill.ts` — `spawnAndAwaitReady` / `killAndAwaitExit`, with the child's stdout and stderr attached to every rejection
- `packages/test-support/src/__tests__/spawn-and-kill.test.ts` — 4 tests against throwaway fixture entrypoints written to a temp directory
- `apps/worker/src/test/harness/sigkill-entrypoint.ts` — the child; posts the marker, then freezes
- `apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts` — the scenario
- `packages/test-support/src/index.ts`, `package.json`, `SPECIFICATION.md` (§1.2 harness helpers, §2.5 execa's real status, §3.2 `SIGKILL_HARNESS_JOB_DATA`)

## Decisions Made

- **The freezing fake's statement order is load-bearing.** `process.send(marker)` comes first; the never-settling promise second. Reversing them, or emitting the marker from anywhere outside the injected function, reintroduces precisely the race D-23 removed.
- **No timer in the entrypoint at all.** The open IPC channel is what keeps the frozen child alive, so none is needed — and one would be the very thing SPEC R6 rejects.
- **The bounded wait in the helper is documented as a hang-to-failure converter, not the kill trigger.** Without that note, the next reader sees a timeout and assumes the kill is timer-driven.
- **The child's stderr is attached to rejections.** An entrypoint that throws during module load exits before reporting, and a bare timeout reads as flakiness — which attracts a retry loop instead of a fix.
- **`TEST_DATABASE_URL` is forwarded explicitly.** The child is a separate process and does not inherit vitest globalSetup's in-process assignment. Silent connection elsewhere would make the status query read a row that does not exist, and the failure would look like a broken harness rather than broken wiring.

## Deviations from Plan

### 1. [Rule 4 — Architectural, pre-recorded in the plan] D-22's entrypoint location

Described above. The plan itself records this deviation and its rationale; nothing new was decided at execution time. Carried into this summary as the plan instructs.

### 2. [Rule 1 — Bug, in own work] Two acceptance greps tripped on my own prose

- `grep -cE "processSendJob|sends|worker|campaign"` on the helper: an early draft used ordinary English words — "posts the run message", "the worker" — that the genericity check matches as substrings. Reworded to "posts"/"child process". The check exists to prove the module names no domain concept, and prose counts.
- `grep -c "server.js\|server.ts\|buildServer\|createEmailBroadcastWorker"` on the entrypoint: my doc comment explaining that the real boot is *not* started named the file it does not start. Reworded to "does NOT boot the real queue runtime". Same class of problem as 08-07's async-rule register.

### 3. [Rule 1 — Bug, in own work] Barrel export shape

`grep -c "spawnAndAwaitReady\|killAndAwaitExit"` counts lines, and both names sat on one export line. Split across two lines — the criterion's intent (both exported) and its letter now agree.

### 4. [Rule 1 — Environment] `docker compose up -d --wait` in the `<verify>` blocks

As in 08-08 through 08-11: native services on the same ports and DSNs.

---

**Total deviations:** 1 architectural (pre-recorded in the plan), 3 auto-fixed.
**Impact on plan:** None on scope. Every artifact exists as specified.

## Issues Encountered

None substantive. The scenario worked on the first run and stayed green across five.

Worth recording for whoever writes the next process-boundary scenario: the frozen child stays alive purely because its IPC channel is open. If a future entrypoint closes that channel or is spawned without one, it will exit as soon as its stack unwinds and the parent will see a hang-to-timeout rather than an obvious cause.

## User Setup Required

None. `npm run failure:sigkill` needs the same local Postgres and Redis the rest of the worker suite uses. The child runs TypeScript through `--import tsx`, already a devDependency.

## Next Phase Readiness

- **08-13** is the last of the five scenarios and the last one blocked on infrastructure this machine lacks — it restarts the Redis *container*. `startTempRedis` from 08-04 is the obvious substrate: a throwaway server booted from `docker/redis.conf` can be stopped and restarted for real, which is closer to the intent than a container restart is to being testable here.
- **QG-06 is still not marked complete** — 08-13 also declares it, and the shared-ID gate holds it open until every declaring plan has a SUMMARY. After 08-13 it closes.
- **Phase 11** now has the duplicate-send window pinned against a real process boundary, not just an in-process simulation. The `dispatching` and `failed` assertions here are the same pre-change baseline 08-08 flagged, and will need the same deliberate update.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
