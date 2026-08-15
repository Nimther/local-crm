---
phase: 15-observability-alerting-frontend-resilience
plan: 10
subsystem: observability
tags: [sentry, error-tracking, fastify, bullmq, node, async-local-storage]

requires:
  - phase: 15-06
    provides: sentryBeforeSend (packages/redaction) as a blocking CI-gated redaction hook, safe to point a live DSN at
  - phase: 15-08
    provides: apps/worker's processor-wrapper.ts error-reporter seam (setProcessorErrorReporter, previously a no-op)
provides:
  - apps/api/src/sentry.ts -- Sentry SDK init for the API process, DSN-optional, tracing/profiling off, Fastify error handler wired
  - apps/worker/src/sentry.ts -- Sentry SDK init for the worker process, its own DSN, bounded shutdown flush, real reporter wired into the 15-08 seam
  - processor-wrapper.ts's ProcessorErrorContext widened with requestId/workspaceId (Rule 2 deviation, see below)
  - New optional env vars (SENTRY_DSN_API, SENTRY_DSN_WORKER, SENTRY_ENVIRONMENT) documented in docker/prod.env.example, SPECIFICATION.md, and passed through docker-compose.prod.yml
  - A verified, documented residual gap in API-side workspace_id tagging (see Known Limitations)
affects: ["15-11"]

tech-stack:
  added: []
  patterns:
    - "Sentry init is DSN-optional everywhere: initSentry() returns false, logs once, never throws when no DSN is configured -- boot is never blocked by a missing/misconfigured Sentry project."
    - "Correlation tags attached centrally via Sentry.addEventProcessor (API) reading @mega-crm/tenant-context's ALS store, NOT threaded per capture site -- except where ALS genuinely cannot reach the capture site (see worker's explicit ProcessorErrorContext fields)."
    - "Sentry test transport injection: every sentry.test.ts supplies its own transport factory (recording envelope 'event' items) rather than mocking Sentry.captureException, so beforeSend/tag-processor wiring is proven against the real SDK with zero network access."

key-files:
  created:
    - apps/api/src/sentry.ts
    - apps/worker/src/sentry.ts
    - apps/api/src/__tests__/sentry.test.ts
    - apps/worker/src/__tests__/sentry.test.ts
  modified:
    - apps/api/src/env.ts
    - apps/api/src/server.ts
    - apps/worker/src/server.ts
    - apps/worker/src/processor-wrapper.ts
    - apps/worker/src/__tests__/processor-wrapper.test.ts
    - docker/prod.env.example
    - docker/docker-compose.prod.yml
    - SPECIFICATION.md

key-decisions:
  - "Checkpoint decision: proceed-live-dsn -- wire both backend SDKs fully and supply real DSNs to the deployed environment (human will create the two Sentry EU projects and deliver SENTRY_DSN_API/SENTRY_DSN_WORKER as deploy-time operator setup). This decision also governs plan 15-11 (frontend Sentry) per the plan's own framing -- 15-11's executor should treat the DSN question as already answered, not re-ask it."
  - "Rule 2 deviation: widened apps/worker/src/processor-wrapper.ts's ProcessorErrorContext with requestId/workspaceId, read explicitly off the job payload (extractWorkspaceId, mirroring the existing extractRequestId), instead of having the injected reporter read @mega-crm/tenant-context's ALS correlation store. Verified empirically (see Deviations) that Node's AsyncLocalStorage does not propagate a run() call's bound store to a continuation registered by an external awaiter once that call's promise has settled -- wrapProcessor's own catch block is in exactly that position, so a reporter relying on ALS there would never see workspace_id. This is the only way the plan's own must_haves truth ('tagged with workspace_id, job_id and request_id') can be satisfied through the seam 15-08 built."
  - "The API side has the identical structural limitation (nested withTenant(...) inside each route handler) but was NOT fixed -- doing so would require touching ~10 route modules (resolveWorkspaceMember callers), well outside this plan's declared scope. Documented and proven with an executable test instead of left as an unverified claim; see Known Limitations."
  - "Sentry's release identifier reuses the existing IMAGE_TAG variable (already used to select the deployed image tag) rather than introducing a second, parallel release variable -- IMAGE_TAG is now also forwarded into apps/api/src/env.ts's optional schema and into apps/worker's process.env via an explicit docker-compose.prod.yml environment: entry (it was previously compose-scope only, never passed into the container)."

patterns-established:
  - "New Sentry-related env vars are passed through EXPLICITLY in docker-compose.prod.yml's api/worker environment: blocks, not via the implicit MEGA_CRM_ENV_FILE env_file passthrough every other application secret uses -- documented inline in prod.env.example."

requirements-completed: [OPS-08]

coverage:
  - id: D1
    description: "apps/api initializes @sentry/node with the shared sentryBeforeSend/beforeSendTransaction, tracing/profiling off, a missing DSN never blocks boot, and Sentry.setupFastifyErrorHandler captures unhandled route exceptions"
    requirement: "OPS-08"
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/sentry.test.ts#with no DSN configured, does not throw and leaves the SDK uninitialized"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/sentry.test.ts#initializes with tracing disabled and the shared beforeSend/beforeSendTransaction"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/sentry.test.ts#captures an exception tagged with workspace_id/request_id from the bound correlation context, scrubbed, with send_id omitted when unbound"
        status: pass
      - kind: integration
        ref: "apps/api/src/__tests__/sentry.test.ts#REAL PATH (documented gap): request_id survives Fastify's onError capture, workspace_id bound inside a route handler's own withTenant does not"
        status: pass
    human_judgment: false
  - id: D2
    description: "apps/worker initializes its own @sentry/node instance and wires a real reporter into plan 15-08's processor-wrapper.ts seam: one captured event per non-control-flow throw (tagged queue/job_id/request_id/workspace_id), zero for DelayedError, a bounded flush on shutdown"
    requirement: "OPS-08"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/sentry.test.ts#a plain thrown Error routed through wrapProcessor produces exactly one captured event tagged with queue/job_id/request_id/workspace_id"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/sentry.test.ts#a DelayedError routed through wrapProcessor produces zero captured events"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/sentry.test.ts#with no DSN configured, the worker's real reporter never throws and captures nothing"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/sentry.test.ts#flushSentry resolves within its explicit timeout and is a no-op when uninitialized"
        status: pass
      - kind: unit
        ref: "apps/worker/src/__tests__/processor-wrapper.test.ts (updated for widened ProcessorErrorContext)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Every new environment variable is documented in docker/prod.env.example and SPECIFICATION.md section 3, passed through docker-compose.prod.yml, and the frontend DSN's build-time/not-a-secret handling is recorded ahead of plan 15-11"
    requirement: "OPS-08"
    verification:
      - kind: other
        ref: "npm run check:spec-env-coverage"
        status: pass
      - kind: other
        ref: "npm run verify:prod-compose"
        status: pass
    human_judgment: false

duration: ~2h (continuation from a pre-Task-1 checkpoint)
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 10: Backend Sentry Wiring Summary

**Sentry (@sentry/node) initialized in both apps/api and apps/worker with DSN-optional boot, shared redaction beforeSend, tracing/profiling off, and correlation tagging -- plus a verified, documented fix to the worker's error-reporter seam so workspace_id/request_id actually reach captured events (a fix the API side structurally cannot get without touching ~10 route modules, honestly documented instead).**

## Performance

- **Duration:** ~2h (this session; resumed from a checkpoint left at the plan's opening blocking decision by a prior executor with zero commits)
- **Completed:** 2026-08-15
- **Tasks:** 3/3 complete
- **Files modified:** 13 (4 created, 9 modified) across 5 commits

## Accomplishments
- `apps/api/src/sentry.ts`: DSN-optional Sentry init, `beforeSend`/`beforeSendTransaction` both literally `sentryBeforeSend` (plan 15-06), tracing off (`tracesSampleRate: 0`), a global event processor tagging `workspace_id`/`request_id`/`send_id` from `@mega-crm/tenant-context`'s correlation store, and `Sentry.setupFastifyErrorHandler(app)` wired unconditionally after every route.
- `apps/worker/src/sentry.ts`: mirrors the API's shape with its own DSN (D-06), a real reporter (`reportProcessorError`) injected into plan 15-08's `processor-wrapper.ts` seam, and a bounded `Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS)` added to the existing shutdown sequence (after workers/queues drain, before the shared Redis connection disconnects and the health server closes).
- Found and fixed (Rule 2 deviation) a structural gap in the worker's reporter seam: `ProcessorErrorContext` only carried `{queue, jobId}`; `workspace_id`/`request_id` are now read explicitly off the job payload (`extractWorkspaceId`, mirroring `extractRequestId`) because Node's `AsyncLocalStorage` cannot deliver them any other way from that call site (see Deviations).
- Documented and proved (not silently left as a gap) the equivalent limitation on the API side, where it was NOT fixed (out of scope): `workspace_id` bound inside a route handler's own `withTenant(...)` call does not reach `setupFastifyErrorHandler`'s onError capture.
- New environment surface (`SENTRY_DSN_API`, `SENTRY_DSN_WORKER`, `SENTRY_ENVIRONMENT`, plus `IMAGE_TAG` reused as the release identifier) documented in `docker/prod.env.example` and `SPECIFICATION.md` sections 3 and 7, passed through explicitly in `docker-compose.prod.yml`'s `api`/`worker` `environment:` blocks.

## Task Commits

1. **Task 1: Initialize Sentry in apps/api and wire the Fastify error handler** - `ecc2d8e` (feat)
2. **Task 2: Initialize Sentry in apps/worker and wire the processor-wrapper reporter** - `d190022` (feat, includes the Rule 2 `processor-wrapper.ts` deviation)
3. **Follow-up (discovered during Task 2, applies to Task 1's claim):** documented and proved the API-side residual gap - `e725fe5` (docs)
4. **Task 3: Document the new environment surface** - `f8d5ec4` (docs, also fixes lint errors introduced by the sentry test files)

_No separate "plan metadata" commit -- `.planning/` is gitignored except `WINDOWS.md`; this SUMMARY.md is committed via `git add -f` per this run's explicit instructions._

## Files Created/Modified
- `apps/api/src/sentry.ts` - Sentry init, correlation-tag event processor, capture helper for apps/api
- `apps/api/src/env.ts` - adds optional `SENTRY_DSN_API`, `SENTRY_ENVIRONMENT`, `IMAGE_TAG`
- `apps/api/src/server.ts` - calls `initSentry()` before the Fastify instance is built; registers `Sentry.setupFastifyErrorHandler(app)` after all routes
- `apps/api/src/__tests__/sentry.test.ts` - mechanism tests (no-DSN no-op, tracing-off, tag+scrub proof) plus a "REAL PATH" test proving the documented workspace_id gap
- `apps/worker/src/sentry.ts` - Sentry init (own DSN), `reportProcessorError` (explicit tags), bounded `flushSentry`
- `apps/worker/src/server.ts` - calls `initSentry()` + `setProcessorErrorReporter(reportProcessorError)` in `buildWorker()`; adds the bounded flush to `closeWorkerRuntime`
- `apps/worker/src/processor-wrapper.ts` - widened `ProcessorErrorContext` with `requestId`/`workspaceId`; added `extractWorkspaceId`
- `apps/worker/src/__tests__/processor-wrapper.test.ts` - updated two reporter-invocation assertions for the widened context shape
- `apps/worker/src/__tests__/sentry.test.ts` - mechanism + reporter-wiring tests
- `docker/prod.env.example` - new Sentry section (`SENTRY_DSN_API`, `SENTRY_DSN_WORKER`, `SENTRY_ENVIRONMENT`)
- `docker/docker-compose.prod.yml` - explicit `environment:` passthrough of the three new vars plus `IMAGE_TAG` for `api`/`worker`
- `SPECIFICATION.md` - section 3 (new env vars, frontend-DSN build-time note) and section 7 (error-tracking topology, the documented residual)

## Decisions Made
- Checkpoint decision `proceed-live-dsn` was already made by the human before this session resumed (see below); no re-ask.
- Sentry's release identifier reuses `IMAGE_TAG` rather than a new parallel variable (per the plan's own instruction) -- `IMAGE_TAG` is now forwarded into both containers' own process environment for the first time.
- `ProcessorErrorContext` widened (Rule 2) rather than leaving the worker's tagging half-satisfied -- see Deviations for the full empirical justification.
- The API-side equivalent gap was documented and proven, not fixed -- fixing it is a cross-cutting change (~10 route modules) outside this plan's scope; flagged explicitly rather than left for a future auditor to rediscover silently.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Widened `ProcessorErrorContext` so the worker's Sentry reporter actually receives `workspace_id`/`request_id`**
- **Found during:** Task 2 (worker Sentry wiring)
- **Issue:** The plan's own `must_haves.truths` requires "an unhandled exception in a worker job reaches Sentry tagged with workspace_id, job_id and request_id." The naive implementation (reading `@mega-crm/tenant-context`'s `getCorrelationContext()` from inside the injected reporter, mirroring the API side's `attachCorrelationTags`) silently produced events missing `workspace_id` (and would have missed `request_id` too, had `processor-wrapper.ts`'s own `child` logger not already bound it separately for logging). Root cause, verified empirically with a minimal reproduction against Node 26's `AsyncLocalStorage`: a `run()` call's bound store is NOT propagated to a continuation registered by an external awaiter once that call's own returned promise has settled. `wrapProcessor`'s `wrappedProcessor` function is exactly in that position -- it awaits `withCorrelation(...)`'s returned promise from outside that call, so its `catch` block (where the reporter is invoked) genuinely cannot see the correlation store, regardless of what `withTenant`/`withCorrelation` bound deeper inside the handler.
- **Fix:** Widened `apps/worker/src/processor-wrapper.ts`'s `ProcessorErrorContext` with `requestId`/`workspaceId`, added `extractWorkspaceId` (mirroring the existing `extractRequestId`), and passed both explicitly at the reporter call site. `apps/worker/src/sentry.ts`'s `reportProcessorError` now reads these fields directly rather than from ALS. `attachCorrelationTags` (the ALS-based tag processor) stays registered regardless -- harmless, and still correct for any future capture made from code that genuinely is still inside an active correlation scope.
- **Files modified:** `apps/worker/src/processor-wrapper.ts`, `apps/worker/src/sentry.ts`, `apps/worker/src/__tests__/processor-wrapper.test.ts`, `apps/worker/src/__tests__/sentry.test.ts`
- **Verification:** `apps/worker/src/__tests__/sentry.test.ts`'s "a plain thrown Error routed through wrapProcessor produces exactly one captured event tagged with queue/job_id/request_id/workspace_id" test, plus the two updated `processor-wrapper.test.ts` assertions. Full `apps/worker` suite (623 tests) and `npm run failure:429` both pass.
- **Committed in:** `d190022` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 2)
**Impact on plan:** Necessary for the plan's own stated truth to actually hold on the worker side. No scope creep beyond the one seam this plan already owned (`ProcessorErrorContext` was created by plan 15-08 explicitly for this plan to fill in).

## Issues Encountered

**API-side equivalent gap, documented but not fixed (out of scope).** While diagnosing the worker's ALS propagation gap above, the same underlying mechanism was checked against `apps/api` (every session-authed route calls `withTenant(workspace.id, () => ...)` from inside its own handler, awaited from outside that call -- structurally identical to the worker's case). Confirmed with a standalone Fastify + real `AsyncLocalStorage` reproduction, then with an executable test against the real `apps/api` server shape (`apps/api/src/__tests__/sentry.test.ts`'s "REAL PATH" test): `request_id` (bound once at the outermost `onRequest` hook) reliably reaches every exception `Sentry.setupFastifyErrorHandler` captures, because Fastify's own dispatch chain re-registers each subsequent stage from inside that still-active scope; `workspace_id` (bound per-route by a route handler's own nested `withTenant` call) does not. An exception thrown from inside a route handler's `withTenant` scope therefore reaches Sentry without `workspace_id`.

This was NOT fixed in this plan: a proper fix means every route module attaching `workspace_id` to the request/reply (or a Sentry scope) BEFORE calling `withTenant`, touching roughly ten route modules across contacts/csv-import/api-keys/send-log/etc. -- a cross-cutting change well beyond "wire the Sentry SDK." Recorded here and as an executable test (not a prose-only claim) plus a doc comment on `attachCorrelationTags` and a SPECIFICATION.md section 7 note, so a future phase or auditor finds it deliberately, not by surprise.

## User Setup Required

**External services require manual configuration.** The checkpoint decision `proceed-live-dsn` authorizes supplying real Sentry DSNs to the deployed environment (the code itself never requires a DSN to boot).

Before the next production deploy, the operator must:
1. Create two Sentry projects in the **EU region** (D-05/D-06): `mega-crm-api` and `mega-crm-worker`.
2. From each project's **Client Keys (DSN)** settings page, copy the DSN value.
3. Add both to the operator's own `MEGA_CRM_ENV_FILE` (never to this repository or to `docker/prod.env.example`):
   - `SENTRY_DSN_API=<api project DSN>`
   - `SENTRY_DSN_WORKER=<worker project DSN>`
4. Optionally set `SENTRY_ENVIRONMENT` (defaults to `NODE_ENV`, i.e. `production`, if unset).
5. Verify: after a deploy, trigger any exception path (or wait for a real one) and confirm an event with `workspace_id`/`request_id` tags (or `job_id`/`workspace_id`/`request_id` for a worker job) appears in the corresponding Sentry project within the EU region.

Until these DSNs are set, both processes boot and run normally with error tracking simply disabled (logged once at boot: "Sentry DSN not configured ... error tracking disabled").

**This same decision (`proceed-live-dsn`) governs plan 15-11** (the frontend's `@sentry/react` wiring) per this plan's own framing -- 15-11's executor should treat the DSN question as already resolved by the human and proceed directly to wiring the SDK, supplying real values through the frontend's own build-time mechanism (a build-time bundled DSN, deliberately NOT part of `MEGA_CRM_ENV_FILE` -- see `SPECIFICATION.md` section 3's note, added by this plan's Task 3, on why a Sentry DSN is not a secret for the frontend specifically). A third Sentry project (`mega-crm-web`, EU region) will need to be created for that plan.

## Next Phase Readiness

- OPS-08's backend half is functionally complete and tested: both apps/api and apps/worker exceptions reach Sentry with the redaction gate already blocking in CI, tracing/profiling off, and a missing DSN never blocking boot.
- The worker's tagging is fully correct (workspace_id/request_id/job_id/queue all present when the job payload carries them, which nearly every queue's schema does per `packages/shared-schemas/src/queues.ts`).
- The API's tagging has one known, documented, tested gap (`workspace_id` absent for exceptions thrown from inside a route handler's own `withTenant` scope) -- not a blocker for phase completion, but worth a small follow-up plan/task if precise per-tenant Sentry filtering on the API side becomes operationally important. Flagged in `SPECIFICATION.md` section 7 and this SUMMARY so it is not rediscovered as a surprise.
- Plan 15-11 (frontend Sentry) can proceed directly to implementation using the `proceed-live-dsn` decision already recorded here -- no further checkpoint needed for that plan's own DSN question.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
