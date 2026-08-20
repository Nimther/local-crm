---
phase: 15-observability-alerting-frontend-resilience
plan: 02
subsystem: observability
tags: [asynclocalstorage, pino, correlation-id, postgres, application_name, fastify, bullmq]

requires:
  - phase: 15-01
    provides: dependency landing (pino, fastify-as-real-dependency, bullmq, @sentry/node, @bull-board/*) already installed in apps/worker's package.json before this plan touched code
provides:
  - merge-safe correlation context (workspaceId/requestId/jobId/sendId) in packages/tenant-context, replacing the tenant-only ALS store
  - application_name correlation folded into withTenantTransaction's existing set_config call, with a deterministic 63-byte truncation
  - apps/worker's first structured (Pino) logger, mirroring apps/api's construction with a correlation mixin
  - a globally-unique, echo-or-generate request id (genReqId) on apps/api, bound to the request's whole lifecycle via withCorrelation
  - one proven end-to-end path: campaign test-send route -> email-broadcast queue job -> Postgres transaction, carrying one requestId
affects: [15-03, 15-05, 15-09]

tech-stack:
  added: []
  patterns:
    - "AsyncLocalStorage merge-forward: every tenantContext.run() call spreads the current store before adding its own fields, in both nesting orders"
    - "pino mixin() reading getCorrelationContext() as the zero-parameter-threading correlation stamping mechanism"
    - "application_name folded into an existing set_config call rather than a second round trip"

key-files:
  created:
    - packages/tenant-context/src/__tests__/correlation-context.test.ts
    - packages/tenant-context/src/__tests__/application-name-correlation.test.ts
    - apps/worker/src/logger.ts
    - apps/worker/src/__tests__/correlation-tracer.test.ts
  modified:
    - packages/tenant-context/src/index.ts
    - apps/api/src/logger.ts
    - apps/api/src/server.ts
    - apps/api/src/middleware/tenant-context.ts
    - apps/api/src/modules/campaigns/campaigns.routes.ts
    - apps/worker/src/queues/email-broadcast.worker.ts
    - packages/shared-schemas/src/queues.ts
    - SPECIFICATION.md

key-decisions:
  - "Promoted the ALS store's identity from {workspaceId} to a general CorrelationStore (per plan's assumption_delta_decision) -- workspaceId is now one field among requestId/jobId/sendId, not the whole store"
  - "withCorrelation typed as fn: () => T (not () => Promise<T>) so Fastify's synchronous done() callback can run inside the ALS scope without an unnecessary async wrapper"
  - "application_name composed and truncated deterministically to 63 bytes on a whole-character boundary, never relying on Postgres's own silent cut"
  - "requestId added to emailBroadcastJobSchema as a purely optional field -- no schemaVersion bump, verified by comparing SCHEMA_VERSION declaration counts against HEAD"

patterns-established:
  - "Correlation-context test files exercise the REAL nested call shape (one with* call inside another) rather than binding one field at a time, per RESEARCH.md Pitfall 7's own warning that single-field tests can never catch a store-replacement bug"

requirements-completed: [OPS-11, OPS-12, OPS-06]

coverage:
  - id: D1
    description: "packages/tenant-context's ALS store promoted to a merge-safe CorrelationStore (withCorrelation/getCorrelationContext added, withTenant/withTenantTransaction merge-forward, getWorkspaceId throws in a correlation-only scope)"
    requirement: "OPS-11"
    verification:
      - kind: unit
        ref: "packages/tenant-context/src/__tests__/correlation-context.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "application_name correlation folded into withTenantTransaction's existing set_config call, deterministically truncated to the 63-byte Postgres budget"
    requirement: "OPS-12"
    verification:
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/application-name-correlation.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "apps/worker's first Pino logger (apps/worker/src/logger.ts), mirroring apps/api's construction with the same correlation mixin"
    requirement: "OPS-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/__tests__/correlation-tracer.test.ts#carries one requestId into a captured worker log line and into pg_stat_activity.application_name for a transaction opened during job processing"
        status: pass
    human_judgment: false
  - id: D4
    description: "One requestId proven end to end: genReqId override + onRequest correlation binding on apps/api, requestId threaded onto the email-broadcast job, worker processor rebinding jobId+requestId, both visible in a real worker log line and pg_stat_activity.application_name"
    requirement: "OPS-11"
    verification:
      - kind: integration
        ref: "apps/worker/src/__tests__/correlation-tracer.test.ts"
        status: pass
      - kind: unit
        ref: "apps/api/src/server.ts -- grep -c 'genReqId' apps/api/src/server.ts (returns 2)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 02: Correlation Tracer Summary

**Merge-safe AsyncLocalStorage correlation context (workspaceId/requestId/jobId/sendId) threading one request id from an HTTP request through a BullMQ job into a Postgres session's `application_name` and both apps' Pino logs, with a byte-budgeted `application_name` and a globally-unique `genReqId`.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-08-15T10:35:24Z (approx, first task commit)
- **Completed:** 2026-08-15T10:55:24Z
- **Tasks:** 3
- **Files modified:** 12 (8 modified, 4 created)

## Accomplishments

- `packages/tenant-context`'s AsyncLocalStorage store promoted from `{ workspaceId }` to a general `CorrelationStore` (`workspaceId?`, `requestId?`, `jobId?`, `sendId?`); `withTenant`/`withCorrelation` both spread the current store forward (RESEARCH.md Pitfall 7) so nested scopes accumulate rather than replace, proven in both nesting orders plus three-level accumulation
- `withTenantTransaction`'s existing `set_config` call extended with a second argument setting `application_name` to a compact `req=.../job=...` pair, deterministically truncated to Postgres's 63-byte limit on a whole-character boundary
- `apps/worker` got its first structured (Pino) logger, byte-for-byte mirroring `apps/api/src/logger.ts`'s construction (redact + correlation mixin)
- `apps/api`'s Fastify instance overrides `genReqId` to echo a bounded-length-safe `x-request-id` header or generate a `crypto.randomUUID()`, and binds that id via `withCorrelation` as the first `onRequest` hook so it survives into every later hook and the route handler
- The campaign test-send route reads the bound request id back and includes it on the enqueued `email-broadcast` job (purely additive optional field, no `schemaVersion` bump); the worker's `email-broadcast` processor rebinds `{ jobId, requestId }` around its whole body
- Proven end to end by a real integration test: one request id appears in a captured worker log line (via a tampered `process.stdout` + a runtime-bumped log level) AND in `pg_stat_activity.application_name` for a transaction opened during that job's processing

## Task Commits

Each task was committed atomically:

1. **Task 1: Promote the tenant ALS store to a merge-safe correlation context** - `d13193b` (feat)
2. **Task 2: Stamp correlation onto Postgres sessions and every log line in both processes** - `0f86f31` (feat)
3. **Task 3: Wire the one send path end to end and prove it** - `41e9a64` (feat)

_Note: no separate RED/GREEN/REFACTOR commits -- `tdd="true"` tasks here wrote the test and implementation together per task and verified before committing (test infra required real discovery, e.g. the byte-budget truncation surfaced from the test itself, not a separate pre-commit)._

## Files Created/Modified

- `packages/tenant-context/src/index.ts` - CorrelationStore type, withCorrelation, getCorrelationContext, merge-forward withTenant, composeApplicationName + APPLICATION_NAME_BYTE_BUDGET, withTenantTransaction's extended set_config
- `packages/tenant-context/src/__tests__/correlation-context.test.ts` - ALS merge-forward proof (both nesting orders, 3-level accumulation, correlation-only throw, undefined-doesn't-erase)
- `packages/tenant-context/src/__tests__/application-name-correlation.test.ts` - real transaction + pg_stat_activity proof, byte-budget truncation cases
- `apps/api/src/logger.ts` - added `mixin()` returning `getCorrelationContext()`
- `apps/api/src/server.ts` - `genReqId` override, first `onRequest` hook binding `withCorrelation({ requestId })`
- `apps/api/src/middleware/tenant-context.ts` - re-exports `withCorrelation`/`getCorrelationContext` alongside the existing tenant exports (deviation, see below)
- `apps/api/src/modules/campaigns/campaigns.routes.ts` - test-send handler reads back `getCorrelationContext().requestId` and includes it on the enqueued job
- `apps/worker/src/logger.ts` - new file, mirrors `apps/api/src/logger.ts` exactly
- `apps/worker/src/queues/email-broadcast.worker.ts` - `handleEmailBroadcastJob` wrapped in `withCorrelation({ jobId, requestId })`, logs via the new worker logger
- `apps/worker/src/__tests__/correlation-tracer.test.ts` - tracer proof test (worker log + application_name, legacy no-requestId payload compatibility)
- `packages/shared-schemas/src/queues.ts` - `requestId` optional field on `emailBroadcastJobSchema`, no `schemaVersion` change
- `SPECIFICATION.md` §7 - documents the correlation model, `application_name`, and the new worker logger

## Decisions Made

- Promoted the ALS store's identity per the plan's own `assumption_delta_decision` (promote, not add-alongside) -- a second parallel ALS instance would have reintroduced exactly the nested-run clobbering bug this plan exists to fix
- `withCorrelation` typed `fn: () => T` rather than `() => Promise<T>` (matching `AsyncLocalStorage.run`'s own generic signature) so the Fastify `onRequest` hook's synchronous `done()` callback runs inside the ALS scope directly, without an `async () => { done(); }` wrapper that would have added a needless microtask tick and tripped `@typescript-eslint/require-await`
- `composeApplicationName` truncates on a whole-character boundary (iterating code points, not raw byte-slicing) rather than a plain `Buffer.subarray`, since `requestId` ultimately derives from attacker-controlled input (T-15-04) even though the `genReqId` gate constrains it to a safe character set before it reaches this function
- Tracer test imports `../logger.js` and `../queues/email-broadcast.worker.js` via dynamic `import()` inside `beforeAll`, after tampering `process.stdout.write` -- pino's own `hasBeenTampered` check (verified against `node_modules/pino/lib/tools.js`) picks `process.stdout` as its destination stream once tampering is detected, instead of a raw-fd `SonicBoom` writer that bypasses `process.stdout` entirely and cannot be captured by a spy at all; a static top-level import would run before the tamper call (ES module imports are hoisted)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `getWorkspaceId`'s and `withTenantTransaction`'s throw-if-absent check was insufficient after the store's promotion**
- **Found during:** Task 1
- **Issue:** After widening the ALS store to `CorrelationStore`, the original `if (!ctx)` check would pass for a truthy correlation-only store (e.g. `{ requestId }` with no `workspaceId`), letting `withTenantTransaction` silently bind an empty-string `workspaceId` to `set_config` instead of throwing
- **Fix:** Both checks now test `!ctx || ctx.workspaceId === undefined`
- **Files modified:** packages/tenant-context/src/index.ts
- **Verification:** correlation-context.test.ts's "getWorkspaceId throws inside a correlation-only scope" case
- **Committed in:** d13193b (Task 1 commit)

**2. [Rule 3 - Blocking] `apps/api/src/middleware/tenant-context.ts` re-export shim needed `withCorrelation`/`getCorrelationContext`**
- **Found during:** Task 3
- **Issue:** The plan's file list didn't name this shim, but `campaigns.routes.ts` (and every other route module) imports tenant helpers through it, not directly from `@mega-crm/tenant-context` -- without adding the two new exports here, the test-send route couldn't read the bound correlation id back
- **Fix:** Added `withCorrelation`/`getCorrelationContext` to the shim's re-export list
- **Files modified:** apps/api/src/middleware/tenant-context.ts
- **Verification:** `npx tsc --noEmit` on apps/api; campaigns.routes.ts compiles and the tracer path works
- **Committed in:** 41e9a64 (Task 3 commit)

**3. [Rule 3 - Blocking] `withCorrelation`'s original `() => Promise<T>` signature forced an unnecessary async wrapper, tripping a lint rule**
- **Found during:** Task 3
- **Issue:** `app.addHook("onRequest", (request, _reply, done) => { withCorrelation({...}, () => done()) })` failed to typecheck (`done()` returns `void`, not `Promise<T>`); the initial workaround (`async () => { done(); }`) typechecked but tripped `@typescript-eslint/require-await` (an async function with no `await`)
- **Fix:** Widened `withCorrelation`'s signature to `fn: () => T` (matching `AsyncLocalStorage.run`'s own generic), which is a strict generalization -- every existing async caller is unaffected since `T` is simply inferred as the `Promise<X>` the async arrow already returns
- **Files modified:** packages/tenant-context/src/index.ts, apps/api/src/server.ts
- **Verification:** `npx tsc --noEmit` and `npm run lint` both clean; full `apps/api`/`apps/worker`/`packages/tenant-context` suites pass
- **Committed in:** 41e9a64 (Task 3 commit)

**4. [Rule 3 - Blocking] `apps/worker/dist` was missing, failing an unrelated pre-existing test**
- **Found during:** final overall verification (full `apps/worker` suite run)
- **Issue:** `stop-grace-period-publish.test.ts` (unrelated to this plan's files) imports a compiled artifact from `apps/worker/dist`, which does not exist in a fresh worktree checkout until built at least once
- **Fix:** Ran `npm run build -w apps/worker` (gitignored `dist/` output, nothing committed)
- **Files modified:** none (build artifact only, gitignored)
- **Verification:** full `apps/worker` suite: 586/586 passing after the build
- **Committed in:** n/a (no source change, no commit needed)

---

**Total deviations:** 4 auto-fixed (1 bug, 3 blocking)
**Impact on plan:** All four were necessary for correctness or to unblock verification; none expand scope beyond what Task 1-3's action text already called for.

## Issues Encountered

- The tracer test's first draft used this codebase's REAL `jobId` format (`${workspaceId}-test-${campaignId}-${Date.now()}`, ~90 chars) for its `toContain(jobId)` assertion, which failed because `composeApplicationName`'s 63-byte truncation correctly cuts it off before the assertion's expected substring -- this was the truncation working as designed, not a bug. Fixed by using a short `crypto.randomUUID()`-shaped `jobId` in the test (the byte-budget behavior itself is separately and thoroughly proven in `application-name-correlation.test.ts`).

## User Setup Required

None - no external service configuration required. No new packages installed (everything used here -- `pino`, `fastify` as a real dependency, `bullmq`, `@sentry/node`, `@bull-board/*` -- was already landed in `apps/worker/package.json` by plan 15-01's blocking-human-verified dependency install).

## Next Phase Readiness

- The correlation context, worker logger, and `application_name` mechanism established here are the foundation plan 15-05 builds on (the general-purpose BullMQ processor wrapper across ~20 worker factories) and plan 15-09 (Sentry tagging) will read from `getCorrelationContext()`.
- Scope discipline held: only the campaign test-send -> email-broadcast path was wired; every other route and worker factory is untouched, exactly as the plan's objective specifies.
- No blockers for 15-03 (redaction depth / Sentry setup) or 15-05 (general processor wrapper).

## Known Stubs

None - no stub patterns introduced. Every code path added in this plan is fully wired (no hardcoded empty values, no placeholder UI text, no unwired data sources).

## Self-Check: PASSED

- FOUND: packages/tenant-context/src/index.ts
- FOUND: packages/tenant-context/src/__tests__/correlation-context.test.ts
- FOUND: packages/tenant-context/src/__tests__/application-name-correlation.test.ts
- FOUND: apps/api/src/logger.ts
- FOUND: apps/api/src/server.ts
- FOUND: apps/api/src/middleware/tenant-context.ts
- FOUND: apps/api/src/modules/campaigns/campaigns.routes.ts
- FOUND: apps/worker/src/logger.ts
- FOUND: apps/worker/src/queues/email-broadcast.worker.ts
- FOUND: apps/worker/src/__tests__/correlation-tracer.test.ts
- FOUND: packages/shared-schemas/src/queues.ts
- FOUND: SPECIFICATION.md (section 7 updated)
- FOUND commit d13193b
- FOUND commit 0f86f31
- FOUND commit 41e9a64

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
