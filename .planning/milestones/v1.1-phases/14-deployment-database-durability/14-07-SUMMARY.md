---
phase: 14-deployment-database-durability
plan: 07
subsystem: testing
tags: [failure-injection, bullmq, migrations, sigterm, ci, vitest, deploy-safety]

requires:
  - phase: 14-deployment-database-durability
    provides: "plan 14-01's scripts/migrate-runner.mjs (dedicated-connection advisory lock) and packages/db/src/migration-journal.ts -- the mechanism this plan's Task 1 injects a kill into and asserts against"
  - phase: 14-deployment-database-durability
    provides: "plan 14-04's apps/worker/src/health-server.ts + shutdown-budget.ts (WORKER_STOP_GRACE_PERIOD_SECONDS) -- the drain lifecycle Task 3's scenario verifies end-to-end under a real signal"
provides:
  - "apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts + scripts/migrate-runner.mjs's inert-unless-enabled MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK hook: DB-05's ROADMAP-locked unclean-death case"
  - "apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts: R-05's deploy-safety overlap proven in both directions against a real webhook-events BullMQ Worker"
  - "apps/worker/src/queues/__tests__/failure-injection/sigterm-mid-load.test.ts + apps/worker/src/test/harness/sigterm-load-entrypoint.ts: Pitfall 7's real-SIGTERM-mid-load verification"
  - "three new failure:* npm scripts, all folded into failure:all (now 16 scenarios) and wired as three new named steps in .github/workflows/ci.yml's failure-injection job"
affects: ["14-08 (compose stop_grace_period wiring)", "14-09 (deploy script timeout budget)", "any future plan adding a sixth schemaVersion-gated worker or a fourth real-process-kill scenario"]

tech-stack:
  added: []
  patterns:
    - "Env-gated, inert-unless-explicitly-enabled test-only pause hooks directly inside production scripts (scripts/migrate-runner.mjs), mirroring apps/worker/src/test/harness/sigkill-entrypoint.ts's marker-then-never-settle pattern one level up at the process level"
    - "A harness entrypoint's execution gated behind process.on('message', ...) receiving the run signal, never run unconditionally at module top level -- required whenever the SAME file is also imported by the parent test process for a shared constant, or that import alone executes the harness inside the test runner's own process"
    - "Job counting summed across all five BullMQ queue states, polled to a TERMINAL-state condition (completed+failed === total), not merely 'exists somewhere' -- the G-12-3 lesson applied to a genuinely different assertion (see Issues Encountered)"

key-files:
  created:
    - apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/sigterm-mid-load.test.ts
    - apps/worker/src/test/harness/sigterm-load-entrypoint.ts
  modified:
    - scripts/migrate-runner.mjs
    - package.json
    - .github/workflows/ci.yml
    - docs/failure-injection-scenarios.md

key-decisions:
  - "The kill-landing mechanism for Task 1 is a marker POSTED after the advisory lock is acquired and BEFORE migrate() is ever called (MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK, inert unless explicitly set) -- matches the plan's own suggested mechanism verbatim ('a harness entrypoint that signals readiness after acquiring the lock and before applying'). The starting database is deliberately partially-migrated (not empty), as the more faithful simulation of an unclean death mid-deploy, even though the freeze point itself would prove the same three facts from an empty database."
  - "Task 2's chosen queue is webhook-events.worker.ts, not one of the four periodic-tick workers (send-reconciler/webhook-replay-sweep/reputation-tick/erasure-scrub) that also gate schemaVersion. All five gate identically (validate, defer-by-returning, never throw), but webhookEventsJobSchema is the ONLY one of the five whose schemaVersion field is `.optional()` -- the other four introduced the field as a REQUIRED literal from their very first shipped version, so there is no genuine pre-versioned 'previous form' to enqueue for direction two of R-05's overlap. Testing them would mean enqueuing the same shape under two names."
  - "Version pair exercised: WEBHOOK_EVENTS_SCHEMA_VERSION (1, recognized) vs. WEBHOOK_EVENTS_SCHEMA_VERSION + 1 (2, unrecognized) vs. the genuinely distinct legacy form (neither schemaVersion nor journalId present at all, the actual pre-Phase-13 payload shape) -- all three derived from/attested against the real exported constant and the real optional-field schema, never invented literals."
  - "Task 3 builds a MINIMAL test-scoped worker runtime in the spawned child (one BullMQ Worker + the real health server, both wired exactly as server.ts's buildWorker() wires its own) rather than spawning the full 20-worker production process -- the other 19 workers need fixture wiring (SCAN_DATABASE_URL, UNSUBSCRIBE_TOKEN_SECRET, PUBLIC_APP_URL) with no bearing on the one question under test, and the shutdown path (markWorkerDraining + closeWorkerRuntime) is reused directly from server.ts rather than reimplemented, so the scenario proves the REAL shutdown path."
  - "Load is simulated via a fake sendMail resolving 202 after a fixed short delay (1500ms), never a real SendGrid call -- the same ProcessSendJobDeps.sendMail seam every other failure-injection file uses. 'In flight' is detected deterministically via queue.getActiveCount() > 0 (polled), never a sleep."

patterns-established:
  - "A test harness entrypoint that is ALSO imported by its own parent test file (for a shared IPC marker constant) must gate its real work behind an incoming IPC message, never run it unconditionally at module top level -- otherwise importing the file for the constant silently executes the harness inside the test RUNNER's process too."

requirements-completed: [DB-05, OPS-02]

coverage:
  - id: D1
    description: "DB-05's unclean-death case: a migration runner SIGKILLed the instant it holds the advisory lock leaves no lock behind (pg_locks empty), the journal records no partial application, and a second runner drives the journal to the full shipped set, exiting 0"
    requirement: "DB-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts#a runner SIGKILLed the instant it holds the lock leaves no lock behind, and a second runner drives the journal to the full shipped set"
        status: pass
    human_judgment: false
  - id: D2
    description: "R-05's two-version deploy-safety overlap, both directions: an unrecognized-schemaVersion job is deferred (not processed, not failed) while a recognized job and a legacy pre-versioned job interleaved with it both complete"
    requirement: "OPS-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts#an unrecognized-version job is deferred (not processed, not failed); a recognized job and a legacy pre-versioned job interleaved with it both complete"
        status: pass
    human_judgment: false
  - id: D3
    description: "Pitfall 7's real-SIGTERM-mid-load case: a real worker process under sustained load self-terminates inside WORKER_STOP_GRACE_PERIOD_SECONDS with no forced kill, /readyz reports 503 shortly after the signal, and no send is left claimed-but-unresolved"
    requirement: "OPS-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/sigterm-mid-load.test.ts#self-terminates on a real SIGTERM sent while jobs are actively in flight, reports 503 on /readyz, and leaves no send claimed-but-unresolved"
        status: pass
    human_judgment: false
  - id: D4
    description: "All three scenarios run as their own named CI steps in the failure-injection job (16 scenarios total in failure:all); no other CI job changed"
    requirement: "OPS-02"
    verification:
      - kind: other
        ref: "git diff of .github/workflows/ci.yml touches only the failure-injection job's step list; npm run failure:all exits 0 with all 16 scenarios green"
        status: pass
    human_judgment: false

duration: ~1h10m
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 07: Three ROADMAP-Locked Failure-Injection Scenarios Summary

**Three new failure-injection scenarios on the existing 13-scenario harness -- a real SIGKILLed migration runner proves the session-scoped advisory lock dies with its connection (DB-05), a real BullMQ webhook-events Worker proves an unrecognized job-payload version defers in both directions of a rolling deploy (R-05), and a real forked worker process proves it self-terminates on a real SIGTERM inside its 60-second stop-grace-period with `/readyz` observing the drain (Pitfall 7) -- bringing `failure:all` to 16 scenarios, all wired as named CI steps.**

## Performance

- **Duration:** ~1h10m
- **Tasks:** 3 (Task 1 migration-runner kill, Task 2 two-version compatibility, Task 3 real-SIGTERM-mid-load + CI wiring)
- **Files created:** 4
- **Files modified:** 4

## Accomplishments

- **DB-05's unclean-death case** (`migrate-unclean-death.test.ts`): a new, inert-unless-explicitly-enabled `MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK` hook in `scripts/migrate-runner.mjs` posts an IPC marker the instant the advisory lock is acquired and BEFORE `migrate()` is ever called, then never returns. The test spawns the runner as a real forked child against a partially-migrated ephemeral database, SIGKILLs it on that marker, and asserts three facts directly rather than inferring them: `pg_locks` holds no row for the migration key after the kill (the session-scoped lock genuinely dies with the connection -- the mechanism the whole design rests on), the drizzle journal is byte-for-byte unchanged from the pre-kill seed (no partial application recorded), and a second runner invocation acquires the lock, exits 0, and drives the journal to the full 63-migration shipped set.
- **R-05's two-version compatibility, both directions** (`two-version-compat.test.ts`): confirmed by reading all five `schemaVersion`-gated workers (`webhook-events`, `send-reconciler`, `webhook-replay-sweep`, `reputation-tick`, `erasure-scrub`) that the gate is implemented identically -- validate, defer by returning (never throw) on a parse failure whose every issue is about `schemaVersion`, never best-effort process. Chose `webhook-events.worker.ts` as the one queue whose gate has a genuinely distinct "previous form" to test (its `schemaVersion` field is `.optional()`, the only one of the five -- the other four introduced the field as a required literal from their first shipped version, so they have no real pre-versioned payload shape). Drives a real `Queue`/`Worker` pair (`createWebhookEventsWorker`, the actual production factory) against a throwaway `startTempRedis()` instance with three interleaved jobs: an unrecognized-version job (`schemaVersion: 2`) that must be deferred (zero `send_events` rows, never in BullMQ's `failed` state), a recognized job (`schemaVersion: 1`), and a legacy pre-Phase-13 job with neither `schemaVersion` nor `journalId` at all -- both of the latter two complete and insert their event normally, proving the unrecognized job never stalls the queue.
- **Pitfall 7's real-SIGTERM-mid-load verification** (`sigterm-mid-load.test.ts` + new harness `apps/worker/src/test/harness/sigterm-load-entrypoint.ts`): a real forked child process builds a minimal test-scoped worker runtime (one BullMQ Worker under a fake-`sendMail` seam resolving 202 after a 1500ms delay, plus the real `/healthz`+`/readyz` listener, wired via the SAME `markWorkerDraining`/`closeWorkerRuntime` functions `server.ts`'s production shutdown path uses -- reused directly, not reimplemented). The parent enqueues 20 jobs, polls `queue.getActiveCount() > 0` as a deterministic "genuinely in flight" marker, sends a real `SIGTERM`, and asserts: the child exits on its own (`code: 0`, `signal: null`) well inside `WORKER_STOP_GRACE_PERIOD_SECONDS` (measured ~1.6s against a 60s budget -- ~97% headroom, directly usable by plans 14-08/14-09); a real HTTP `GET /readyz` against the child's health port returns 503 within ~2s of the signal; and querying `sends` for the workspace afterward shows zero rows in `dispatching` (BullMQ's default, non-forced `Worker.close()` waits for the active job's processor to finish, so nothing is abandoned mid-flight) with every row in Phase 11's own terminal/ambiguous vocabulary (`sent`/`failed`/`reconciling`/`unknown`).
- **CI wiring**: three new named steps appended to `.github/workflows/ci.yml`'s `failure-injection` job (`Migration runner killed mid-run`, `Two-version payload compatibility`, `Real SIGTERM mid-load`); `static`, `test`, and `e2e` jobs are byte-for-byte unchanged (confirmed via `git diff`).

## Task Commits

1. **Task 1: DB-05's unclean death** -- `996046f` (test) -- `scripts/migrate-runner.mjs`'s pause hook, the new test file, and (front-loaded for all three tasks) `package.json`'s three new scripts + `failure:all` + `docs/failure-injection-scenarios.md`'s catalogue entries
2. **Task 2: R-05's two-version compatibility** -- `635120e` (test)
3. **Task 3: Pitfall 7's real-SIGTERM-mid-load + the three CI steps** -- `8dbdcd2` (test)

_No separate plan-metadata commit -- SUMMARY.md is committed directly per this worktree's repo-specific rules (`.planning/` is gitignored here)._

## Files Created/Modified

- `apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts` -- DB-05's scenario
- `apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts` -- R-05's scenario
- `apps/worker/src/queues/__tests__/failure-injection/sigterm-mid-load.test.ts` -- Pitfall 7's scenario
- `apps/worker/src/test/harness/sigterm-load-entrypoint.ts` -- the new child-process harness the SIGTERM scenario spawns
- `scripts/migrate-runner.mjs` -- the inert-unless-enabled `MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK` hook + `MIGRATE_RUNNER_TEST_PAUSE_MARKER`
- `package.json` -- `failure:migrate-unclean-death`, `failure:two-version-compat`, `failure:sigterm-mid-load`, all three folded into `failure:all` (now 16 scenarios)
- `.github/workflows/ci.yml` -- three new named steps in the `failure-injection` job only
- `docs/failure-injection-scenarios.md` -- catalogue entries for all three (see Issues Encountered for a pre-existing staleness note)

## Decisions Made

See `key-decisions` in the frontmatter above for the full rationale on: the kill-landing mechanism and partially-migrated seed choice (Task 1); the queue choice and version pair (Task 2); the minimal-runtime and load-simulation choices (Task 3).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Harness entrypoint executed inside the parent test process on import**
- **Found during:** Task 3, first run of `sigterm-mid-load.test.ts`
- **Issue:** `sigterm-load-entrypoint.ts` called `main()` unconditionally at module top level (mirroring an earlier draft, not `sigkill-entrypoint.ts`'s actual pattern). The parent test file imports this SAME module directly to reach the shared `SIGTERM_LOAD_HARNESS_READY` IPC marker constant -- that import alone executed the harness (reading env vars absent in the parent's own environment, calling `process.exit`) inside the vitest test-runner process, not just inside the forked child. Vitest intercepted the resulting `process.exit(2)` and surfaced it as an "Unhandled Rejection", which would have made the test suite's exit status unreliable in CI even though the single test itself reported green.
- **Fix:** Gated all real work behind `process.on("message", (message) => { if (message !== RUN) return; ... })`, matching `sigkill-entrypoint.ts`'s actual established pattern exactly -- importing the file for its constant is now inert everywhere except inside the forked child `spawnAndAwaitReady` sends the run message to.
- **Files modified:** `apps/worker/src/test/harness/sigterm-load-entrypoint.ts`
- **Verification:** Re-ran the scenario three times consecutively with zero unhandled-error output; `npx vitest run --root apps/worker` (full 577-test suite) also clean.
- **Committed in:** `8dbdcd2` (Task 3 commit -- caught before the first commit of this file, not a follow-up fix)

**2. [Rule 1 - Bug] Job-settlement poll condition summed across states without waiting for a terminal state**
- **Found during:** Task 2, first run of `two-version-compat.test.ts`
- **Issue:** The initial poll loop broke as soon as `waiting+active+delayed+completed+failed >= 3` -- but that sum is trivially 3 the instant all three jobs are enqueued (every job is always counted in exactly one of the five states, including `waiting`), so the loop exited before any job had actually been processed, and the subsequent `getState()` assertion on the recognized job failed with `'active'` instead of `'completed'`.
- **Fix:** Restructured the poll to require `completed + failed === 3` (every job has reached a TERMINAL state), while still summing across all five states on every iteration to fail loudly (rather than hang) if a job is ever lost or duplicated -- preserving the G-12-3 sum-across-states discipline for the failure mode it actually guards against, applied to the correct wait condition.
- **Files modified:** `apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts`
- **Verification:** Re-ran the scenario; passes deterministically.
- **Committed in:** `635120e` (Task 2 commit -- caught before the first commit of this file)

---

**Total deviations:** 2 auto-fixed (both Rule 1 bugs, both caught and fixed during this plan's own execution before either file's first commit -- neither shipped in a red state). No scope creep beyond what DB-05/OPS-02 required.

## Issues Encountered

- **`docs/failure-injection-scenarios.md` predates Phase 11-13's additions to `failure:all` and was never kept current.** The file's own header already distinguishes "coverage percentage" from "which scenarios exist reproducibly" as separate claims -- but the table itself only ever documented the original 5 (Phase 8) scenarios, never the 8 added since (crash-post-accept, crash-pre-result-write, reconciler-retry-race, redis-restart's WRK-12 half aside, segment-sweep-resume, tenant-fairness, unsubscribe-atomic, erasure-scrub-resume, erasure-enqueue-crash). This plan's own three new rows are appended under a new "Phase 14 additions" heading with an explicit note that the pre-existing gap is not this plan's to close (scope boundary) -- `package.json`'s own script list remains the authoritative complete set at any commit.
- **Confirming the harness-entrypoint-imported-by-its-own-test-file trap (see Deviation 1) is worth flagging forward:** `sigkill-entrypoint.ts` avoids this by construction (its top-level code only registers a `process.on("message", ...)` listener, doing nothing else), but that safety property is not obvious from reading `sigkill.test.ts` alone -- a future scenario author writing a NEW harness entrypoint from scratch, rather than copying `sigkill-entrypoint.ts` verbatim, could easily reintroduce this exact bug. Documented explicitly in `sigterm-load-entrypoint.ts`'s own header comment for the next author.

## User Setup Required

None -- no external service configuration required. All three scenarios run against the existing dev Postgres/Redis or a throwaway `startTempRedis()` instance, exactly like their siblings.

## Next Phase Readiness

- **Measured drain time for 14-08/14-09:** ~1.6s observed drain duration (SIGTERM to process exit) under this scenario's 20-job/1500ms-per-send synthetic load, against the `WORKER_STOP_GRACE_PERIOD_SECONDS = 60` budget plan 14-04 established -- roughly 97% headroom. Plans 14-08 (compose `stop_grace_period`) and 14-09 (deploy script's own timeout) can cite this measurement as evidence the 60s budget has substantial real-world margin, not just a theoretical one derived from constants.
- **Acceptable in-flight send end states, for any later plan writing a similar assertion:** `sent`, `failed`, `reconciling`, `unknown` (Phase 11's `SEND_STATUSES` minus `dispatching`/`excluded`) -- never `dispatching` once the owning process has exited.
- `npm run failure:all` now runs 16 scenarios, all green; `npx vitest run --root apps/worker` (577 tests), `npm run lint` (repo-wide), and `npm run build --workspaces --if-present` (all 14 workspaces) all confirmed clean at this commit.
- `.github/workflows/ci.yml`'s `failure-injection` job now lists 13 named steps total (10 pre-existing + 3 new); `static`/`test`/`e2e` untouched.

## SPECIFICATION.md items for 14-13

Per this worktree's repo-specific rules, SPECIFICATION.md filing is deferred to plan 14-13. Items to file there:

- **§5 (Планировщик и пайплайн отправки) / dev-and-CI tooling:** three new root `package.json` scripts -- `failure:migrate-unclean-death`, `failure:two-version-compat`, `failure:sigterm-mid-load` -- all folded into `failure:all` (now 16 scenarios). None is a production runtime path; all are CI/operator-invoked failure-injection checks.
- **§3 (Секреты)/environment:** no new required env var. Task 1 adds a TEST-ONLY, inert-unless-explicitly-set env var `MIGRATE_RUNNER_TEST_PAUSE_AFTER_LOCK` read by `scripts/migrate-runner.mjs` -- never set by any production invocation. Task 3's harness reads test-only env vars (`SIGTERM_LOAD_HARNESS_*`) that only exist inside its own forked child process.
- **§2 (Зависимости и версии):** no new npm package -- all three scenarios use the existing Vitest suite, `packages/test-support` harness, and `@mega-crm/*` workspace packages already pinned.
- **§4 (Схема данных):** no new production schema, migration, or RLS policy.
- **§6/§7:** no new production HTTP route or logging surface -- Task 3's harness reuses the EXISTING worker `/healthz`+`/readyz` contract (plan 14-04) verbatim, adding no new endpoint.

## Self-Check: PASSED

All four created files verified present via `git log --stat` across the three task commits: `apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts`, `apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts`, `apps/worker/src/queues/__tests__/failure-injection/sigterm-mid-load.test.ts`, `apps/worker/src/test/harness/sigterm-load-entrypoint.ts`. All three task commits verified present via `git log --oneline`: `996046f`, `635120e`, `8dbdcd2`. `npm run failure:all` (16/16 scenarios), `npx vitest run --root apps/worker` (577/577), `npm run lint` (repo-wide, 0 warnings), and `npm run build --workspaces --if-present` (14/14 workspaces) all re-confirmed clean immediately before writing this summary.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
