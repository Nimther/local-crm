---
phase: 15-observability-alerting-frontend-resilience
plan: 08
subsystem: observability
tags: [bullmq, pino, worker, error-handling, correlation-id, structured-logging]

requires:
  - phase: 15-02
    provides: apps/worker's first Pino logger (apps/worker/src/logger.ts) and the merge-safe withCorrelation/getCorrelationContext primitives in packages/tenant-context this plan's wrapper opens a scope through
provides:
  - wrapProcessor(queueName, handler) -- the single instrumentation point every one of the 20 create*Worker factories in apps/worker/src/queues/** now routes its processor through
  - a control-flow error allowlist (DelayedError, UnrecoverableError) that never reaches the injected error reporter, so BullMQ retry/defer semantics are never corrupted and the failed-send-share denominator is never flooded
  - an injectable, no-op-by-default error reporter seam (setProcessorErrorReporter) that plan 15-10 will wire a real Sentry-backed reporter into after the OPS-09 gate -- no Sentry SDK imported here
  - a filesystem-enumerating coverage test proving every factory routes through the wrapper (witnessed to fail when one doesn't) plus a live-Redis test proving a failing wrapped job still reaches the shared error listeners and dead-letter hook
  - zero raw console.* call sites left under apps/worker/src outside tests
affects: [15-10]

tech-stack:
  added: []
  patterns:
    - "wrapProcessor: one shared BullMQ processor wrapper, applied by wrapping only (factory signature/options/array order unchanged) -- the same single-definition discipline queue-core applied to Redis connection options in Phase 12"
    - "Filesystem-enumerating source-scan test (readdirSync + backreference regex) rather than a hard-coded module list/count, so a future factory addition cannot silently bypass the coverage test the way the ROADMAP's stale '13 processors' count already had"
    - "Injectable error-reporter seam (module-level setter, no-op default) as the Sentry-SDK-free hook a later plan wires into, keeping SDK initialization behind its own gate"

key-files:
  created:
    - apps/worker/src/processor-wrapper.ts
    - apps/worker/src/__tests__/processor-wrapper.test.ts
    - apps/worker/src/__tests__/processor-wrapper-coverage.test.ts
  modified:
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - apps/worker/src/queues/campaign-kickoff.worker.ts
    - apps/worker/src/queues/campaign-scheduler.worker.ts
    - apps/worker/src/queues/email-broadcast.worker.ts
    - apps/worker/src/queues/email-triggered.worker.ts
    - apps/worker/src/queues/erasure-scrub-reclaim.worker.ts
    - apps/worker/src/queues/erasure-scrub.worker.ts
    - apps/worker/src/queues/events-ingest.worker.ts
    - apps/worker/src/queues/imports-csv.worker.ts
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - apps/worker/src/queues/reputation-tick.worker.ts
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/send-reconciler.worker.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/webhook-replay-sweep.worker.ts
    - apps/worker/src/queues/flows/flow-enroll-existing.worker.ts
    - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
    - apps/worker/src/queues/flows/flow-run-advance.worker.ts
    - apps/worker/src/queues/flows/flow-segment-sweep-flow.worker.ts
    - apps/worker/src/queues/flows/flow-segment-sweep.worker.ts
    - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
    - apps/worker/src/__tests__/correlation-tracer.test.ts
    - SPECIFICATION.md

key-decisions:
  - "The control-flow allowlist is DelayedError + UnrecoverableError only -- confirmed by a repo-wide grep for DelayedError|UnrecoverableError|WaitingError|WaitingChildrenError|RateLimitError: DelayedError is thrown exactly once (tenant-deferral.ts:45), UnrecoverableError is allowlisted defensively per BullMQ's own documented control-flow semantics though nothing in this repo throws it yet, and WaitingError/WaitingChildrenError are correctly excluded since this repo has zero BullMQ flow/child-job usage (no moveToWaitingChildren/getChildrenValues anywhere)"
  - "requestId falls back to job.id when the payload carries none (repeatable ticks and webhook-originated jobs have no originating HTTP request) -- this changes correlation-tracer.test.ts's pre-existing legacy-compatibility assertion from the plan-02-era 'req=-' placeholder to 'req=<jobId>', which is the wrapper's own stated contract (Task 1 behavior spec), not a regression"
  - "scrubbedConsole sites are NOT migrated to plain Pino: send-dispatch.ts's Redis-client-error site and test-send-unknown-outcome site, partition-maintenance.worker.ts's run-complete/retention-failure site, and webhook-events.worker.ts's sibling-workspace-drop-signal site all stay on scrubbedConsole -- OPS-06's 'no raw console.*' truth targets bare console.* call sites (this plan found exactly 3, all in erasure-scrub.worker.ts), not scrubbedConsole, and these specific sites carry values scrub()'s value-pattern matching protects that PINO_REDACT_OPTIONS' fixed-depth path list cannot"
  - "erasure-scrub.worker.ts's one console.error->pino conversion for the markErr (DB-write-failure) site logs via PLAIN Pino WITHOUT scrub() -- this file has its own pre-existing, tested architectural invariant (erasure-scrub.test.ts's module-source check) forbidding ANY import from @mega-crm/redaction at all (an allowlist-reconstruction design for GDPR erasure evidence, Phase 13 REVIEWS.md BLOCKER finding 4); importing scrub() here would have violated that invariant and did in fact break that test on first attempt, caught and reverted before commit"
  - "The error reporter call inside wrapProcessor runs in its own try/catch, separate from the handler's -- a reporter that itself throws (e.g. a future misbehaving Sentry-backed reporter from plan 15-10) must never replace the original re-thrown error (T-15-23's 'same value re-thrown on every path' guarantee)"

patterns-established:
  - "A factory's processor argument changes ONLY by wrapping it in wrapProcessor(QUEUE_NAME, handler) -- no change to Worker options, no change to the workers array's construction order (git diff apps/worker/src/server.ts is empty, confirming Task 2's acceptance criterion)"

requirements-completed: [OPS-06]

coverage:
  - id: D1
    description: "wrapProcessor(queueName, handler): opens a withCorrelation scope (jobId + payload requestId, falling back to jobId), times the handler, classifies thrown values against a control-flow allowlist, re-throws every value unchanged on every path, and reports non-control-flow throws through an injectable no-op-by-default seam with no Sentry SDK import"
    requirement: "OPS-06"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/processor-wrapper.test.ts (9 tests: resolve passthrough, DelayedError/UnrecoverableError/plain-Error/thrown-string re-throw + reporter call counts, inner-handler log line carrying jobId, requestId binding + fallback, reporter-throws-but-original-error-still-wins)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every one of the 20 create*Worker factories in apps/worker/src/queues/** (including queues/flows/) routes its processor through wrapProcessor(<same queue name>, handler) -- proven by filesystem enumeration, not a hard-coded list/count; a failing wrapped job still reaches BullMQ's failed event and the onTerminalFailure/dead-letter hook"
    requirement: "OPS-06"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/processor-wrapper-coverage.test.ts (22 tests: 20 per-file wrapping assertions + 1 enumeration sanity check + 1 live-Redis failing-job/dead-letter-hook proof); witnessed failing when campaign-kickoff.worker.ts was temporarily reverted to a bare processor, restored, re-verified green"
        status: pass
    human_judgment: false
  - id: D3
    description: "Zero raw console.* call sites remain under apps/worker/src outside tests; the three that existed (erasure-scrub.worker.ts) now log via the plain Pino logger with object-first/message-second argument order"
    requirement: "OPS-06"
    verification:
      - kind: other
        ref: "grep -rnE '(^|[^.a-zA-Z])console\\.(log|error|warn|info|debug)\\(' apps/worker/src --include=*.ts | grep -v __tests__ | grep -vE stale-comment-lines | grep -vc scrubbedConsole -- returns 0"
        status: pass
    human_judgment: false

duration: 95min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 08: Worker Job Instrumentation Summary

**One shared `wrapProcessor` helper now instruments all 20 BullMQ worker factories in `apps/worker` with correlation-scoped structured logging, a control-flow-error allowlist that never floods the error reporter, and an injectable Sentry-free reporter seam -- with a filesystem-enumerating test that fails the moment a future factory bypasses it.**

## Performance

- **Duration:** ~95 min
- **Completed:** 2026-08-15
- **Tasks:** 3
- **Files modified:** 25 (3 created, 22 modified)

## Accomplishments

- `apps/worker/src/processor-wrapper.ts` exports `wrapProcessor(queueName, handler)`: opens a `withCorrelation({ jobId, requestId })` scope around the handler (requestId from the payload when present, falling back to `job.id`), times execution, classifies any thrown value against a module-level control-flow allowlist (`DelayedError`, `UnrecoverableError`), and re-throws the identical value on every path -- control-flow throws are never reported and are logged distinctly from real failures.
- Every one of the 20 `create*Worker` factories under `apps/worker/src/queues/**` (including `queues/flows/`) now routes its processor through `wrapProcessor` -- wrapping only, with zero changes to any factory's exported signature, `Worker` options, or the `workers` array's construction order (`git diff apps/worker/src/server.ts` is empty).
- `email-broadcast.worker.ts`'s inline `withCorrelation` scope from plan 15-02's targeted tracer fix is retired in favor of the shared wrapper -- one implementation of the instrumentation, not two.
- A filesystem-enumerating coverage test (`processor-wrapper-coverage.test.ts`) asserts every `new Worker(...)` construction's processor argument is `wrapProcessor(<same queue name>, ...)` via a backreference regex (proves the queue name isn't just "some string" -- closing a drift a looser check would miss), plus a live-Redis test proving a failing wrapped job still reaches BullMQ's `failed` event and the `onTerminalFailure`/dead-letter hook.
- Zero raw `console.*` call sites remain under `apps/worker/src` outside tests -- the three that existed (`erasure-scrub.worker.ts`) now log through the Pino logger with the corrected (object-first, message-second) argument order.

## Task Commits

Each task was committed atomically:

1. **Task 1: Build the shared processor wrapper** - `74c2f20` (feat)
2. **Task 2: Apply the wrapper at every factory and prove none was missed** - `5612ced` (feat)
3. **Task 3: Retire the raw console.* sites** - `9b26d47` (feat)

## Files Created/Modified

- `apps/worker/src/processor-wrapper.ts` - `wrapProcessor`, the control-flow allowlist, the injectable error-reporter seam
- `apps/worker/src/__tests__/processor-wrapper.test.ts` - unit coverage of every `<behavior>` case (9 tests)
- `apps/worker/src/__tests__/processor-wrapper-coverage.test.ts` - filesystem-enumerating wrapper-usage proof (20 files) + live-Redis dead-letter-reachability proof
- 20 `apps/worker/src/queues/**/*.worker.ts` files - each factory's processor argument now wrapped in `wrapProcessor(QUEUE_NAME, handler)`
- `apps/worker/src/queues/send-dispatch.ts` - documentation only (no raw console sites existed here; two `scrubbedConsole` sites annotated with the Task 3 decision rule)
- `apps/worker/src/queues/erasure-scrub.worker.ts` - three raw `console.error` sites converted to the Pino logger; the `markErr` site explicitly documented as staying scrub()-free per this file's own tested no-redaction-import invariant
- `apps/worker/src/queues/partition-maintenance.worker.ts` - stale "Pino arrives in Phase 15" comment replaced with the explicit stays-on-scrubbedConsole decision
- `apps/worker/src/__tests__/correlation-tracer.test.ts` - both tests now invoke `handleEmailBroadcastJob` through `wrapProcessor` (the same shape the factory now uses); the legacy-payload test's assertion updated from `req=-` to `req=<jobId>` per the wrapper's own fallback contract
- `SPECIFICATION.md` §7 - documents `wrapProcessor`'s log fields (queue/jobId/duration/correlation), the confirmed allowlist evidence, and the scrubbedConsole-vs-plain-Pino rule per site

## Decisions Made

See `key-decisions` in frontmatter for full detail. Summary:
- Control-flow allowlist is exactly `DelayedError` + `UnrecoverableError`, confirmed by a repo-wide grep (no `WaitingError`/`WaitingChildrenError` usage anywhere -- this repo doesn't use BullMQ's flow/child-job feature).
- `requestId` falls back to `job.id` when absent from the payload (Task 1's own stated behavior) -- this is an intentional, plan-specified change from plan 15-02's narrower inline scope, not a regression, and the pre-existing tracer test was updated to match.
- `scrubbedConsole` sites stay on `scrubbedConsole`; only bare `console.*` sites were migrated to plain Pino.
- `erasure-scrub.worker.ts`'s DB-write-failure log site stays scrub()-free because that file has a pre-existing, separately-tested invariant against importing anything from `@mega-crm/redaction` at all (an allowlist-reconstruction design, not a denylist one, for GDPR erasure evidence hygiene).
- The error reporter call is wrapped in its own try/catch so a throwing reporter can never replace the original re-thrown error.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The error reporter call could have replaced the original re-thrown error if the reporter itself threw**
- **Found during:** Between Task 1 and Task 2 (self-review of the "never swallows" guarantee before building on top of it)
- **Issue:** `processor-wrapper.ts`'s original catch block called `errorReporter(err, ...)` directly inside the same try/catch as the handler's error handling; if the injected reporter itself threw (e.g. a future misbehaving Sentry-backed reporter from plan 15-10), that new error would propagate instead of the original `err`, violating T-15-23's "same value re-thrown on every path" guarantee.
- **Fix:** Wrapped the `errorReporter(...)` call in its own try/catch; a throwing reporter is logged and ignored, the original error is always the one re-thrown.
- **Files modified:** apps/worker/src/processor-wrapper.ts, apps/worker/src/__tests__/processor-wrapper.test.ts (new test: "still re-throws the original error unchanged even when the injected error reporter itself throws")
- **Verification:** New test passes; full processor-wrapper.test.ts suite (9 tests) green.
- **Committed in:** `5612ced` (Task 2 commit)

**2. [Rule 3 - Blocking] `correlation-tracer.test.ts` (plan 15-02) called `handleEmailBroadcastJob` directly, bypassing the factory -- would have broken once the inline `withCorrelation` scope moved into the shared wrapper**
- **Found during:** Task 2
- **Issue:** The plan's `files_modified` list for Task 2 named only `server.ts` and the new coverage test, but `email-broadcast.worker.ts`'s inline correlation scope had to move into `wrapProcessor` per the plan's own action text ("Replace plan 15-02's inline correlation scope ... with the shared wrapper"). `correlation-tracer.test.ts` invoked `handleEmailBroadcastJob` directly with no scope of its own, so its `application_name`/log-line assertions would have started failing (no ALS binding at all) the moment the inline scope was removed.
- **Fix:** Updated both tests in `correlation-tracer.test.ts` to invoke the handler through `wrapProcessor(EMAIL_BROADCAST_QUEUE, ...)`, mirroring the factory's own new shape. The legacy-payload test's assertion changed from expecting the `req=-` placeholder to `req=<jobId>`, since `wrapProcessor`'s fallback-to-`job.id` behavior (Task 1's own spec) now applies where the narrower plan-02 scope didn't have that fallback at all.
- **Files modified:** apps/worker/src/__tests__/correlation-tracer.test.ts
- **Verification:** Both tests pass against a real Postgres+Redis (`ensureTestDbMigrated`/`startTempRedis`-backed fixtures already in the file).
- **Committed in:** `5612ced` (Task 2 commit)

**3. [Rule 1 - Bug] Importing `scrub` from `@mega-crm/redaction` in `erasure-scrub.worker.ts` for the `markErr` log site violated that file's own tested no-redaction-import invariant**
- **Found during:** Task 3
- **Issue:** First attempt logged the `markErr` (DB-write-failure) site via `logger.error({ err: scrub(markErr) }, ...)`. Running `erasure-scrub.test.ts` immediately failed: `"imports nothing from @mega-crm/redaction and defines no PII-shaped regular expression (module source check)"` -- a pre-existing, deliberate Phase 13 architectural invariant (allowlist-reconstruction for GDPR erasure evidence must never regain a denylist/pattern-matching dependency, REVIEWS.md BLOCKER finding 4).
- **Fix:** Reverted the `scrub` import; the `markErr` site logs via plain Pino (`logger.error({ err: markErr }, ...)`) with no scrubbing, documented inline as an intentional exception with the rationale (a Postgres driver/client-level error, not tenant-authored freeform content from the erasure evidence pipeline itself).
- **Files modified:** apps/worker/src/queues/erasure-scrub.worker.ts
- **Verification:** `erasure-scrub.test.ts` (41 tests across the three erasure-scrub test files) passes; full `apps/worker` suite (617 tests) passes.
- **Committed in:** `9b26d47` (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 blocking)
**Impact on plan:** All three were necessary for correctness (the reporter try/catch closes a real gap in the "never swallows" guarantee the plan itself calls critical; the tracer-test update and the scrub-import revert were both required to keep pre-existing, deliberately-tested invariants intact after this plan's own changes). None expand scope beyond what the plan's action text already called for -- the plan's `files_modified` frontmatter list undercounts the 20 individual factory files and `correlation-tracer.test.ts` (see note below), but the `<action>` prose for Task 2 explicitly describes touching "every factory" and "replace plan 15-02's inline correlation scope", so this is a plan-list gap, not a deviation from the plan's actual instructions.

## Plan-List Note (not a deviation)

Task 2's frontmatter `files_modified` and `<files>` tags name only `apps/worker/src/server.ts` and the new coverage test, but the plan's own `<action>` text requires routing "every factory's processor through `wrapProcessor`" -- necessarily touching all 20 `apps/worker/src/queues/**/*.worker.ts` files, plus `correlation-tracer.test.ts` (deviation #2 above). This mirrors the plan's own stated caveat about the ROADMAP's stale "13 processors" count: file-count lists in this codebase's planning artifacts are not always exhaustive, and the plan's prose is authoritative where it conflicts with a list.

## Issues Encountered

None beyond the three deviations documented above -- all were caught and resolved before committing, via running the affected test suites immediately after each change rather than deferring verification to the end.

## User Setup Required

None - no external service configuration required. No new packages installed.

## Next Phase Readiness

- The error-reporter seam (`setProcessorErrorReporter`) is the exact hook plan 15-10 wires a real Sentry-backed reporter into after the OPS-09 gate -- no Sentry SDK is imported or initialized here, keeping that ordering intact.
- All 20 worker factories are now instrumented through one place; a future 21st factory that bypasses `wrapProcessor` fails `processor-wrapper-coverage.test.ts` immediately (witnessed during this plan's own revert-one-factory demonstration).
- No blockers for 15-10.

## Known Stubs

None - every code path added or modified in this plan is fully wired (the error reporter seam is intentionally a no-op by design per this plan's own OPS-09 gate ordering, not an unfinished stub -- plan 15-10 is the named future plan that resolves it).

## Self-Check: PASSED

- FOUND: apps/worker/src/processor-wrapper.ts
- FOUND: apps/worker/src/__tests__/processor-wrapper.test.ts
- FOUND: apps/worker/src/__tests__/processor-wrapper-coverage.test.ts
- FOUND: apps/worker/src/queues/erasure-scrub.worker.ts (converted console sites present)
- FOUND: apps/worker/src/queues/partition-maintenance.worker.ts (updated comment present)
- FOUND: apps/worker/src/queues/send-dispatch.ts (annotated scrubbedConsole sites present)
- FOUND: apps/worker/src/__tests__/correlation-tracer.test.ts (wrapProcessor call sites present)
- FOUND: SPECIFICATION.md (section 7 updated)
- FOUND commit 74c2f20
- FOUND commit 5612ced
- FOUND commit 9b26d47

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
