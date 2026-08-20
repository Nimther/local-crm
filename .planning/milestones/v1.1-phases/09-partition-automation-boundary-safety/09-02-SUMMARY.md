---
phase: 09-partition-automation-boundary-safety
plan: 02
subsystem: database
tags: [bullmq, job-scheduler, cron, postgresql, partitioning, sendgrid, dead-mans-switch, apps/worker, apps/api]

# Dependency graph
requires:
  - phase: 09-01
    provides: "runPartitionMaintenance/PARTITIONED_TABLES/LOOKAHEAD_MONTHS/BUFFER_ALERT_THRESHOLD_MONTHS/PARTITION_MAINTENANCE_CRON (packages/db/src/partitions), and startPartitionWatchdog/checkPartitionHealthAndAlert/OperatorAlertMessage (apps/api/src/modules/ops/partition-watchdog.ts) -- both implemented and tested, but neither yet scheduled/wired into a boot process"
provides:
  - "apps/worker/src/queues/partition-maintenance.worker.ts: createPartitionMaintenanceWorker registers a stable-id BullMQ job scheduler (partition-maintenance-daily, 0 3 * * * UTC) via upsertJobScheduler, plus one per-boot immediate run; processPartitionMaintenance is the injectable processor body"
  - "apps/worker/src/server.ts: partition-maintenance registered as the fourteenth worker in buildWorker()'s composition root"
  - "apps/api/src/env.ts / scripts/check-env.mjs / .env.example: OPERATOR_ALERT_EMAIL is a boot-required, email-validated configuration variable"
  - "apps/api/src/server.ts: startPartitionWatchdog armed in main() after app.listen, with a real plain-text SendGrid dispatch through the platform key -- completes the two-process dead-man's-switch"
affects: [09-03, 09-04-default-relocation, 09-05-boundary-validation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "BullMQ job-scheduler API (upsertJobScheduler/getJobSchedulers) for a fixed-UTC-hour cron, deliberately distinct from the four existing tick workers' interval-measured-from-boot repeat form -- first use of this API in the codebase"
    - "Test-only autorun:false + a WeakMap-backed waitForPartitionMaintenanceRegistration hook, so a worker-construction test can assert on BullMQ job-scheduler/queue state without racing a live Worker's own real job processing"
    - "sgMail plain-text dispatch through the platform SendGrid key/sender, structurally separate from the templated modules/platform-mail/client.ts path -- used only for the operator alert body"

key-files:
  created:
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts
  modified:
    - apps/worker/src/server.ts
    - apps/api/src/env.ts
    - apps/api/src/__tests__/env-schema.test.ts
    - apps/api/vitest.config.ts
    - scripts/check-env.mjs
    - .env.example
    - apps/api/src/server.ts

key-decisions:
  - "createPartitionMaintenanceWorker takes an optional second CreatePartitionMaintenanceWorkerOptions.autorun parameter (always left at BullMQ's default/true in production) plus an exported waitForPartitionMaintenanceRegistration(worker) test hook -- BullMQ Workers start processing immediately on construction, and tests asserting on registered scheduler/job state must not race a real processPartitionMaintenance() run"
  - "The worker's own internal Queue handle (used only for upsertJobScheduler/add) is closed once both calls settle, rather than left open for the process lifetime like the four existing tick workers' internal queues -- prevents a resource leak that produced flaky 'Connection is closed' unhandled rejections when a test's temp Redis is torn down"
  - "The real SendGrid dispatch for the operator alert is a small inline sendOperatorAlert in apps/api/src/server.ts (plain text, platform key/sender), not a reuse of modules/platform-mail/client.ts's platformMail object -- that module only exposes templated HTML sends (verify/reset/invite), and D-04 requires the watchdog's channel not depend on any template"

requirements-completed: [DB-01, DB-02]

coverage:
  - id: D1
    description: "The worker process registers a daily 03:00 UTC partition-maintenance job scheduler with the stable id partition-maintenance-daily, and re-registering it on every boot never creates a second competing schedule"
    requirement: DB-01
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts#test 1: registers exactly one job scheduler with the stable daily id/pattern/UTC tz"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts#test 2: constructing the worker twice still leaves exactly one scheduler with that id"
        status: pass
    human_judgment: false
  - id: D2
    description: "Constructing the worker also enqueues one immediate off-schedule job (not owned by the scheduler) so a restart repairs the partition horizon within seconds instead of waiting up to 24h"
    requirement: DB-01
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts#test 3: boot enqueues one immediate job with a per-boot jobId, not owned by the scheduler"
        status: pass
    human_judgment: false
  - id: D3
    description: "The processor delegates to runPartitionMaintenance exactly once with the injected client/instant and returns its snapshot; a rejecting runPartitionMaintenance causes the processor to reject, never swallowed"
    requirement: DB-02
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts#test 4: the processor delegates to runPartitionMaintenance once with the injected client and instant"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts#test 5: a rejecting runPartitionMaintenance causes the processor to reject, never swallowed"
        status: pass
    human_judgment: false
  - id: D4
    description: "OPERATOR_ALERT_EMAIL is required and email-validated in apps/api's zod env schema (API refuses to boot without it) and is a hard-fail presence check in scripts/check-env.mjs (npm run dev aborts before the stack starts); documented in .env.example"
    requirement: DB-02
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#envSchema OPERATOR_ALERT_EMAIL enforcement (3 cases: absent fails, non-email fails, valid passes)"
        status: pass
      - kind: other
        ref: "node scripts/check-env.mjs against a fixture env file missing OPERATOR_ALERT_EMAIL -- exits 1 naming the variable; with it present -- exits 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "The API process arms the partition watchdog at boot, in main() only (never inside buildServer(), which every integration test calls) -- no leaked interval in the test suite, and no configuration value or SendGrid-key-derived data in the boot log line"
    requirement: DB-02
    verification:
      - kind: other
        ref: "region-scoped assertion: buildServer()'s body contains no startPartitionWatchdog reference"
        status: pass
      - kind: integration
        ref: "npm run test -w apps/api (280/280 passing, no hung test process)"
        status: pass
    human_judgment: false

duration: ~20min
completed: 2026-08-06
status: complete
---

# Phase 9 Plan 2: Partition Maintenance Automation & Watchdog Boot-Wiring Summary

**Daily 03:00 UTC BullMQ job-scheduler tick (plus a per-boot immediate run) drives `runPartitionMaintenance` from `apps/worker`; `OPERATOR_ALERT_EMAIL` is now boot-required in `apps/api`; and `startPartitionWatchdog` is armed inside `apps/api`'s own process at boot, completing the two-process dead-man's-switch 09-01 built but never scheduled.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-08-06
- **Tasks:** 3 (task 1: auto, tdd; task 2: auto; task 3: auto)
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- `apps/worker/src/queues/partition-maintenance.worker.ts`: `createPartitionMaintenanceWorker` registers a daily 03:00 UTC schedule via BullMQ's `upsertJobScheduler` job-scheduler API (stable id `partition-maintenance-daily`) instead of the interval-measured-from-boot `repeat`/`every` form the four existing tick workers use — re-registering on every boot never creates a second competing schedule. A separate per-boot-unique `jobId` immediate run repairs the partition horizon within seconds of any restart. `processPartitionMaintenance` is factored out with an injected client/clock/`runPartitionMaintenance`, defaulting to the pooled client, `Date.now`, and the real implementation — no `try`/`catch` anywhere in the file, so a DDL failure fails the BullMQ job loudly (`removeOnFail: false` keeps it inspectable).
- Registered as the fourteenth worker in `apps/worker/src/server.ts`'s `buildWorker()` composition root and appended to the boot log line.
- `apps/api/src/env.ts`: `OPERATOR_ALERT_EMAIL` is a required, email-validated field (no `.optional()`/`.default()`) — the API refuses to boot without the watchdog's only alert address. `scripts/check-env.mjs` hard-fails `npm run dev` on the same missing variable. `.env.example` documents it next to `PLATFORM_MAIL_FROM`.
- `apps/api/src/server.ts`'s `main()` calls `startPartitionWatchdog` after `app.listen` resolves, passing the pooled client, `env.OPERATOR_ALERT_EMAIL`, and a real plain-text SendGrid dispatch through the platform key/sender (never a tenant BYO key, never a Dynamic Template). Started only in `main()`, never inside `buildServer()`, so no timer or real-SendGrid path leaks into the integration test suite. One boot log line records the poll interval and staleness threshold; no secret or address literal is logged.

## Task Commits

Each task was committed atomically; task 1 followed the RED → GREEN TDD sequence:

1. **Task 1: Daily cron-scheduled maintenance worker plus boot-time immediate run** (auto, tdd)
   - `adf32ac` test(09-02): add failing test for the daily partition-maintenance worker
   - `3ac9d48` feat(09-02): add the daily cron-scheduled partition-maintenance worker
2. **Task 2: OPERATOR_ALERT_EMAIL enforced at API boot and at predev** (auto)
   - `b67cff7` feat(09-02): enforce OPERATOR_ALERT_EMAIL at API boot and at predev
3. **Task 3: Start the watchdog interval inside the API process** (auto)
   - `5232a83` feat(09-02): start the partition watchdog inside the API process

**Plan metadata:** commit pending (final docs commit, see completion format)

## Files Created/Modified

- `apps/worker/src/queues/partition-maintenance.worker.ts` - `createPartitionMaintenanceWorker`, `processPartitionMaintenance`, `waitForPartitionMaintenanceRegistration`, `PARTITION_MAINTENANCE_QUEUE`
- `apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts` - 5-test suite: scheduler registration, idempotent re-registration, boot-time immediate run, processor delegation, loud failure propagation
- `apps/worker/src/server.ts` - Registered `createPartitionMaintenanceWorker` as the fourteenth worker; boot log line updated
- `apps/api/src/env.ts` - `OPERATOR_ALERT_EMAIL` required email-validated field
- `apps/api/src/__tests__/env-schema.test.ts` - 3 new cases: absent fails, non-email fails, valid passes
- `apps/api/vitest.config.ts` - Test-safe `OPERATOR_ALERT_EMAIL` default (deviation, see below)
- `scripts/check-env.mjs` - `OPERATOR_ALERT_EMAIL` added to `baseRequired`
- `.env.example` - `OPERATOR_ALERT_EMAIL=` documented next to `PLATFORM_MAIL_FROM`
- `apps/api/src/server.ts` - `startPartitionWatchdog` armed in `main()`; `sendOperatorAlert` real plain-text SendGrid dispatch

## Decisions Made

- **Test-only `autorun: false` + `waitForPartitionMaintenanceRegistration`.** A real BullMQ `Worker` starts processing immediately on construction. Tests 1-3 assert what gets *registered* (scheduler shape, boot job) without wanting a genuine `processPartitionMaintenance()` run — against the real pooled client, hitting a real (if ephemeral) test database — to race those assertions. `createPartitionMaintenanceWorker` accepts an optional `{ autorun }` override (always left at BullMQ's own default in production, i.e. `apps/worker/src/server.ts`'s call site passes only the connection) and exposes a `WeakMap`-backed `waitForPartitionMaintenanceRegistration(worker)` so a test can deterministically wait for the worker's own fire-and-forget scheduler/job registration (and its internal `Queue` handle's close) to settle before tearing down its temp Redis.
- **The worker's internal registration `Queue` handle is explicitly closed once registration settles.** The four existing tick workers (`analytics-reconciliation`, `campaign-scheduler`, `flow-reconciliation`, `flow-segment-sweep`) all construct an internal `Queue` for their own repeatable-tick registration and never close it — harmless in production (the process lives forever), but in a test that spins up and tears down a throwaway Redis per suite, that leaked connection produced flaky `Error: Connection is closed` unhandled rejections when the temp Redis stopped mid-run. Closing it here (after `upsertJobScheduler`/`add` both settle) removes the leak without touching the other four workers' established pattern.
- **`OPERATOR_ALERT_EMAIL`'s real SendGrid dispatch is a small inline function in `apps/api/src/server.ts`, not a reuse of `modules/platform-mail/client.ts`.** That module's `platformMail` object only exposes templated HTML sends (verification/reset/invite); D-04 requires the watchdog's emergency channel not depend on any template existing in the platform SendGrid account, so `sendOperatorAlert` calls `sgMail.send` directly with a plain-text body, using the same `PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM` credentials.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `apps/api/vitest.config.ts` needed a test-safe `OPERATOR_ALERT_EMAIL` default**
- **Found during:** Task 2, first test run after adding the required field to `envSchema`
- **Issue:** `apps/api/src/env.ts` parses `process.env` at module-load time and throws if `envSchema.safeParse` fails. `apps/api/vitest.config.ts`'s `test.env` block supplies test-safe defaults for every other boot-required variable (`PLATFORM_SENDGRID_API_KEY`, `PLATFORM_MAIL_FROM`, etc.) but had no entry for the newly-required `OPERATOR_ALERT_EMAIL` — every single `apps/api` test file failed to even import, since `env.ts`'s top-level `throw` fires before any test body runs.
- **Fix:** Added `OPERATOR_ALERT_EMAIL: process.env.OPERATOR_ALERT_EMAIL ?? "ops@megacrm.test"` to the same `test.env` block, immediately after `PLATFORM_MAIL_FROM`, matching that entry's `??` fallback shape exactly.
- **Files modified:** `apps/api/vitest.config.ts` (not in this plan's declared `files_modified`)
- **Verification:** `npm run test -w apps/api` (280/280 passing, up from a suite-wide import failure)
- **Committed in:** `b67cff7` (task 2 commit)

**2. [Rule 1 - Bug] `schedulers[0].id` does not exist on BullMQ's returned `JobSchedulerJson` — the field is `key`**
- **Found during:** Task 1, first GREEN run of tests 1/2 against a real temp Redis
- **Issue:** The initial test assertions read `schedulers[0].id`, matching the TypeScript `.d.ts` shape's optional `id?` field, but at runtime (bullmq 5.79.1) `Queue.getJobSchedulers()`'s underlying `transformSchedulerData` never populates `id` — the scheduler is identified by `key` (the id passed to `upsertJobScheduler`), confirmed by reading `node_modules/bullmq/dist/esm/classes/job-scheduler.js` directly.
- **Fix:** Changed both assertions to read `schedulers[0].key` instead of `.id`.
- **Files modified:** `apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts`
- **Verification:** Tests 1/2 pass consistently across repeated runs
- **Committed in:** `adf32ac` (RED commit, corrected before the GREEN commit)

**3. [Rule 1 - Bug] Flaky `Error: Connection is closed` unhandled rejection during temp-Redis teardown**
- **Found during:** Task 1, repeated runs of the full test file surfaced an intermittent unhandled rejection that flipped the process exit code to 1 even when all 5 assertions passed
- **Issue:** `createPartitionMaintenanceWorker`'s internal `Queue` (used only for `upsertJobScheduler`/`add`) was never closed, mirroring the four existing tick workers' own pattern. In production this is harmless (the process runs forever); in a test that starts and stops a throwaway `redis-server` per suite, the leaked connection occasionally threw during `redis.stop()`'s teardown, and — because the registration itself is fire-and-forget — a test could proceed to its own cleanup before that background `close()` call had settled, letting it race a Redis that was already shutting down.
- **Fix:** (a) the internal registration `Queue` is now explicitly closed once `upsertJobScheduler` and `add` both resolve; (b) an exported `waitForPartitionMaintenanceRegistration(worker)` test hook (backed by a `WeakMap`) lets the test `await` that settlement deterministically before its own `finally` block runs `worker.close()`/`queue.obliterate()`/`queue.close()`.
- **Files modified:** `apps/worker/src/queues/partition-maintenance.worker.ts`, `apps/worker/src/queues/__tests__/partition-maintenance.worker.test.ts`
- **Verification:** `npx vitest run --root apps/worker src/queues/__tests__/partition-maintenance.worker.test.ts` run 5+ times consecutively with exit 0 and no unhandled-rejection warnings
- **Committed in:** `3ac9d48` (GREEN commit)

---

**Total deviations:** 3 auto-fixed (1 Rule 3 — blocking test-suite failure, 2 Rule 1 — bugs discovered while making the plan's own written tests genuinely pass, not planned scope).
**Impact on plan:** All three are internal to test correctness and resource-leak hygiene against real BullMQ/Redis/env-parsing behavior; no behavior described in the plan was changed.

## Issues Encountered

- **`.env.example` is a denied path for file-editing tools in this repository (confirmed, matching the plan's own note).** Both the `Read` tool and a plain `Bash(cat .env.example)` were refused by the permission system. Used the plan's documented escape hatch: a `node -e` one-liner through `node:fs` to insert the new block, and a second `node -e` to verify the result (`/^OPERATOR_ALERT_EMAIL=/m` against the file contents) — never a file-reading tool.
- **Worktree had no `node_modules`.** Matches 09-01's own note. Ran `npm ci --prefer-offline` from the worktree root before any test/build could run.

## User Setup Required

None — no external service configuration required. `OPERATOR_ALERT_EMAIL` must be set to a real address in this machine's externally-resolved env file before `npm run dev` will start the stack (enforced by `scripts/check-env.mjs`), but that is exactly the kind of per-environment provisioning `.env.example` documents, not a one-time manual step tied to this plan.

## Next Phase Readiness

- The two-process dead-man's-switch 09-01 built is now fully wired end to end: `apps/worker` writes the health row on a predictable daily schedule (plus a boot-time immediate run), and `apps/api` reads it on its own 15-minute poll from a genuinely separate process, alerting the configured operator address.
- 09-04 (DEFAULT-relocation script) and 09-05 (boundary validation) can proceed independently — neither depends on any file this plan touched beyond what 09-01 already exported.
- No blockers.

## Self-Check: PASSED

All 2 created files verified present on disk; all 4 task commits (`adf32ac`, `3ac9d48`, `b67cff7`, `5232a83`) verified present in `git log --oneline --all`.

---
*Phase: 09-partition-automation-boundary-safety*
*Completed: 2026-08-06*
