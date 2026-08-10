---
phase: 12-worker-reliability-tenant-fairness
plan: 07
subsystem: infra
tags: [bullmq, postgres, drizzle, redaction, dead-letter, worker-reliability]

requires:
  - phase: 12-worker-reliability-tenant-fairness
    provides: "packages/queue-core (connection/queue-options factory, 12-02/12-06) that this plan extends with the shared error-listener helper"
provides:
  - "dead_letter_jobs / dead_letter_alert_state Postgres tables -- the durable, platform-ops-scoped home for a job that exhausts every BullMQ attempt"
  - "writeDeadLetterOnTerminalFailure / isTerminalJobFailure (apps/worker/src/queues/dead-letter/dead-letter-writer.ts) -- the terminal-failure gate and the redacting insert"
  - "attachSharedErrorListeners (packages/queue-core/src/error-listeners.ts) -- the one shared worker error/failed listener attach helper, with an injected onTerminalFailure hook seam"
affects: [12-08, 12-09, 12-11, 15-observability]

tech-stack:
  added: []
  patterns:
    - "Platform-ops-scoped table (no workspace_id, no RLS) for a terminal-failure/alert-dedup record, mirroring partition_maintenance_runs/send_reconciler_runs -- header comment states the exception and the correct remedy if tenant scoping is ever wanted"
    - "Injected onTerminalFailure hook keeps queue-core's tier boundary: the shared listener helper never imports from an app; the app supplies the terminal-vs-mid-retry decision"

key-files:
  created:
    - packages/db/migrations/0054_dead_letter_jobs.sql
    - packages/db/src/schema/dead-letter-jobs.ts
    - apps/worker/src/queues/dead-letter/dead-letter-writer.ts
    - apps/worker/src/queues/__tests__/dead-letter-writer.test.ts
    - packages/queue-core/src/error-listeners.ts
    - packages/queue-core/src/__tests__/error-listeners.test.ts
  modified:
    - packages/db/src/index.ts
    - packages/db/migrations/meta/_journal.json
    - packages/queue-core/src/index.ts
    - packages/queue-core/package.json
    - package-lock.json
    - SPECIFICATION.md

key-decisions:
  - "dead_letter_jobs and dead_letter_alert_state carry no workspace_id and no Row-Level Security -- platform-operations metadata, not tenant data, same exception class as partition_maintenance_runs/send_reconciler_runs; mega_crm_scan is granted nothing on either table"
  - "Terminal gate defaults to attempts=1 when a job has no configured attempts, so an unconfigured job is terminal on its first failure rather than silently never recording"
  - "Redelivered terminal failure for the same (queue_name, job_id) upserts (attempts/payload/error/timestamp refreshed) rather than duplicating, via the unique constraint's conflict clause"
  - "attachSharedErrorListeners takes the terminal-vs-mid-retry decision out of scope entirely -- it always logs and always invokes onTerminalFailure per failed event; the hook itself (dead-letter-writer's isTerminalJobFailure gate) decides whether to write"

patterns-established:
  - "Shared worker error/failed listener: one call, `attachSharedErrorListeners(worker, queueName, { onTerminalFailure })`, at every future `new Worker(...)` construction site -- WeakSet guard makes a repeated attach a no-op"
  - "Dead-letter write path: worker.on('failed') -> attachSharedErrorListeners -> onTerminalFailure hook -> isTerminalJobFailure gate -> scrub(job.data) -> upsert into dead_letter_jobs"

requirements-completed: [WRK-08, WRK-10]

coverage:
  - id: D1
    description: "dead_letter_jobs / dead_letter_alert_state tables: additive migration 0054, no RLS, no mega_crm_scan grant, singleton alert-state seeded unconditionally"
    requirement: "WRK-10"
    verification:
      - kind: unit
        ref: "packages/db test:migrations (56/56, includes migrate-from-empty.test.ts / migrate-incremental.test.ts applying 0054)"
        status: pass
      - kind: other
        ref: "npm run lint:migrations (55 files, no violations)"
        status: pass
    human_judgment: false
  - id: D2
    description: "isTerminalJobFailure gate + writeDeadLetterOnTerminalFailure: terminal write, non-terminal no-op, redaction proof (email/provider-key/bearer-token), duplicate-write idempotency, swallowed DB error"
    requirement: "WRK-10"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/dead-letter-writer.test.ts (6/6 against a real ephemeral database)"
        status: pass
    human_judgment: false
  - id: D3
    description: "attachSharedErrorListeners: exactly one error + one failed listener, scrubbed logging, job-less failure tolerance, injected onTerminalFailure hook invoked once, rejecting hook caught, no double-registration"
    requirement: "WRK-08"
    verification:
      - kind: unit
        ref: "packages/queue-core/src/__tests__/error-listeners.test.ts (7/7, npm test --workspace=packages/queue-core: 15/15 total)"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-08-10
status: complete
---

# Phase 12 Plan 07: Dead-letter path and shared worker error listener Summary

**Postgres `dead_letter_jobs`/`dead_letter_alert_state` tables plus a redacting `writeDeadLetterOnTerminalFailure` writer and a shared BullMQ `attachSharedErrorListeners` helper with an injected terminal-failure hook -- the first `worker.on("error"/"failed")` listener anywhere in `apps/worker`.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-08-10
- **Tasks:** 3
- **Files modified:** 12 (6 created, 6 modified)

## Accomplishments

- `dead_letter_jobs` (unique on `queue_name`+`job_id`, indexed on `failed_at`) and `dead_letter_alert_state` (singleton alert-dedup row) exist as platform-ops-scoped tables with no RLS and no `mega_crm_scan` grant, matching the `partition_maintenance_runs`/`send_reconciler_runs` precedent exactly
- `writeDeadLetterOnTerminalFailure` scrubs every payload snapshot through `@mega-crm/redaction`'s `scrub` before it is written, gates on `isTerminalJobFailure` so mid-retry failures record nothing, upserts on the unique constraint so a redelivered terminal failure refreshes rather than duplicates, and swallows a database error rather than rethrowing
- `attachSharedErrorListeners` (`packages/queue-core`) attaches exactly one error listener and one failed listener to any `Worker`, logs through `scrubbedConsole`, and safely invokes an injected `onTerminalFailure` hook without ever importing from an app

## Task Commits

Each task was committed atomically:

1. **Task 1: dead_letter_jobs and dead_letter_alert_state tables** - `184f098` (feat)
2. **Task 2: Redacting terminal-failure writer** - `46add7a` (test, RED) / `0d21987` (feat, GREEN)
3. **Task 3: Shared worker error-listener helper in queue-core** - `a331239` (test, RED) / `6c2d463` (feat, GREEN)

_No refactor commits needed -- both TDD tasks reached GREEN cleanly on the first implementation pass._

## Files Created/Modified

- `packages/db/migrations/0054_dead_letter_jobs.sql` - both tables, unique constraint, index, singleton seed, header comment on the no-RLS exception
- `packages/db/src/schema/dead-letter-jobs.ts` - type-inference-only Drizzle module for both tables
- `packages/db/src/index.ts` - registers the new schema module in the import/spread/export triple
- `packages/db/migrations/meta/_journal.json` - journal entry for `0054`
- `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` - `isTerminalJobFailure`, `writeDeadLetterOnTerminalFailure`, dedicated pg `Pool`
- `apps/worker/src/queues/__tests__/dead-letter-writer.test.ts` - 6 tests against a real ephemeral database
- `packages/queue-core/src/error-listeners.ts` - `attachSharedErrorListeners`
- `packages/queue-core/src/__tests__/error-listeners.test.ts` - 7 tests against a minimal event-emitter stand-in
- `packages/queue-core/src/index.ts` - re-exports the new helper
- `packages/queue-core/package.json` - adds `@mega-crm/redaction` as a dependency (needed for `scrubbedConsole`)
- `package-lock.json` - workspace link update for the new dependency
- `SPECIFICATION.md` - SS4.2 (both tables' full column/constraint/RLS-exception documentation), SS4.6 (migration count 53->55, `0054` entry; also corrected a pre-existing off-by-one in the migration count that predated this plan)

## Decisions Made

- Both new tables follow the platform-ops-scoped, no-RLS pattern rather than the tenant-scoped pattern `flow_segment_sweep_checkpoint` (0053, prior plan) established -- a dead-letter row is an operator diagnostic record, not tenant business data, so there is deliberately no `workspace_id` column
- `isTerminalJobFailure` defaults unconfigured `attempts` to `1` (BullMQ's own default), per the plan's explicit behavior spec, rather than treating an unconfigured job as never-terminal
- The rededelivered-terminal-failure case is handled via `ON CONFLICT (queue_name, job_id) DO UPDATE` refreshing `attempts_made`/`payload`/`error_message`/`error_stack`/`failed_at` -- simpler and more complete than only updating the two fields the plan's behavior text names (error message and timestamp), since a redelivery could plausibly carry a different payload or attempt count too
- `attachSharedErrorListeners`'s `onTerminalFailure` hook is invoked unconditionally on every `failed` event (terminal or not) -- the helper itself makes no terminal/mid-retry distinction; that decision is entirely the hook's own responsibility (`isTerminalJobFailure` inside the dead-letter writer), keeping the queue-core/app tier boundary exact

## Deviations from Plan

None - plan executed exactly as written. `packages/queue-core/package.json` gaining `@mega-crm/redaction` as an explicit dependency is a mechanical consequence of Task 3's own action text ("logging through the redaction package's scrubbed console"), not a deviation.

## Issues Encountered

- **`npm run db:migrate` (drizzle-kit CLI) hangs in this sandbox**, reproducing the exact environment issue documented in the prior plan's SUMMARY (12-06, migration `0053`): the CLI's progress-spinner UI never completes against this Node v26.0.0 sandbox (drizzle-kit targets Node 22 LTS). This is unrelated to migration `0054`'s content -- `npm run test:migrations` (56/56, including `migrate-from-empty.test.ts`/`migrate-incremental.test.ts`, which apply the full chain through `0054` via `@mega-crm/test-support`) and every `apps/worker` test that provisions an ephemeral database via `ensureTestDbMigrated()` (338/338 passing) independently prove the migration applies correctly through the programmatic path. Confirmed via direct query against the shared dev database that the CLI hang is pre-existing (the dev database was still at migration index 52/`0052` before this plan ran, meaning `0053` from the prior plan was never actually applied through the CLI there either) -- not a regression introduced by this plan. Not blocking, per the same precedent.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `dead_letter_jobs`/`dead_letter_alert_state` and both new helpers exist and are independently tested, but are NOT yet wired into any of the 15 workers in `apps/worker/src/server.ts` -- this plan built the mechanism (WRK-08/WRK-10's writer and listener), not the wiring across every `new Worker(...)` call site. That wiring, plus shortening per-queue `removeOnFail` retention now that a durable record exists (WRK-09/WRK-11, Pitfall 7's causal ordering), is later-plan scope within this phase (12-09 per the roadmap's own dependency note in this plan's objective).
- The `db:migrate` CLI/Node-version incompatibility (first surfaced in 12-06, reconfirmed here) remains worth a follow-up investigation but has not blocked any plan in this phase so far -- two independent programmatic proofs (packages/db's own migration tests, apps/worker's ephemeral-database tests) cover every migration through `0054`.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-10*
