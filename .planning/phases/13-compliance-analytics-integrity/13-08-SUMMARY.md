---
phase: 13-compliance-analytics-integrity
plan: 08
subsystem: compliance
tags: [postgres, contacts-core, delivery, unsubscribe, fastify, failure-injection]

# Dependency graph
requires:
  - phase: 13-compliance-analytics-integrity (plan 13-05)
    provides: incrementWorkspaceDailyRollup relocated to packages/db/src/analytics/daily-rollup.ts, importable by apps/api
  - phase: 13-compliance-analytics-integrity (plan 13-07)
    provides: send_events dedup key rebase (unrelated code path, but shares the same webhook worker file and wave base)
provides:
  - "applyUnsubscribeWithSendFact (packages/contacts-core/src/unsubscribe-apply.ts) -- the ONE shared unsubscribe write set (status change, consent history, sends.unsubscribed_at fact write), called by all three unsubscribe-producing sites"
  - "setFactColumnOnce/incrementCampaignCounter relocated to packages/db/src/sends/fact-columns.ts, exported, importable by both apps/api and apps/worker"
  - "the public unsubscribe route now sets sends.unsubscribed_at and increments workspace_daily_rollup.unsubscribed_count, neither of which it could do before this plan"
  - "failure:unsubscribe-atomic failure-injection scenario proving the three-write unsubscribe set is atomic at all three interior boundaries"
affects: [13-14]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "PoolClient-first query helper relocated under packages/db/src/<domain>/<module>.ts (packages/db/src/sends/fact-columns.ts), following packages/db/src/reconciler/reconciler-run.ts and packages/db/src/analytics/daily-rollup.ts's identical shape -- the third instance of this pattern in Phase 13"
    - "Query-counting Proxy around a real PoolClient, throwing after the Nth query, to inject a mid-transaction failure at a named interior boundary without adding test-only injection surface to production code"
    - "Minimal bare Fastify() instance registering only the plugin under test (registerUnsubscribeRoutes), instead of a full buildServer() bootstrap, for a cross-app (apps/worker test -> apps/api route) integration test"

key-files:
  created:
    - packages/contacts-core/src/unsubscribe-apply.ts
    - packages/contacts-core/src/__tests__/unsubscribe-apply.test.ts
    - packages/contacts-core/vitest.config.ts
    - packages/db/src/sends/fact-columns.ts
    - apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/unsubscribe-atomic.test.ts
  modified:
    - packages/contacts-core/src/index.ts
    - packages/contacts-core/package.json
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/package.json
    - apps/api/src/modules/delivery/unsubscribe.routes.ts
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "applyUnsubscribeWithSendFact lives in packages/contacts-core, not packages/delivery-core (13-RESEARCH.md Pattern 2 / 13-PATTERNS.md's suggested home) -- contacts-core already depends on delivery-core, so the reverse import would be a workspace dependency cycle. Both call sites already import contacts-core."
  - "The route calls incrementWorkspaceDailyRollup with the same 4 arguments the webhook side uses (no RECONCILE_WINDOW_DAYS import) -- the plan's action text describing a 'standing-window argument' does not match what 13-05 actually shipped (isNotToday's lateness predicate is UTC-calendar-only, independent of RECONCILE_WINDOW_DAYS, per 13-05's own SUMMARY)."
  - "The dropped-with-unsubscribed-outcome branch now sets sends.unsubscribed_at and increments the campaign counter (gated on sendFactJustSet), but does NOT gain a new daily-rollup increment -- the plan's stated scope for this branch names only the campaign counter as a new increment."
  - "Task 3's atomicity proof uses a query-counting Proxy around the real PoolClient (throws after the Nth query) rather than adding an injectable deps parameter to applyUnsubscribeWithSendFact -- keeps the production function free of test-only injection surface while still exercising its real SQL sequence."
  - "The convergence test (Task 2) drives the REAL registerUnsubscribeRoutes plugin on a bare Fastify({ routerOptions: { maxParamLength: 1024 } }) instance rather than the full apps/api buildServer() -- avoids requiring the full app's unrelated auth/Redis/SendGrid bootstrap inside an apps/worker test, while still exercising production route-handler code. fastify added as an apps/worker devDependency (pinned to apps/api's 5.9.0) to build it."

requirements-completed: [CMP-01]

coverage:
  - id: D1
    description: "One shared atomic unsubscribe helper (applyUnsubscribeWithSendFact) performs the status change, consent-history write, and sends.unsubscribed_at fact write on the caller's own transaction, covering every case in the plan's behavior list (idempotent replay, no sends row, contactId resolved from send, non-UUID CR-01 fallthrough, already-unsubscribed no-op, correct prior status)."
    requirement: CMP-01
    verification:
      - kind: unit
        ref: "packages/contacts-core/src/__tests__/unsubscribe-apply.test.ts (7 cases)"
        status: pass
      - kind: unit
        ref: "npm run build (tsc across all workspaces, no dependency cycle)"
        status: pass
    human_judgment: false
  - id: D2
    description: "All three unsubscribe-producing call sites (route, webhook unsubscribe/group_unsubscribe, webhook dropped-with-unsubscribed-outcome) route through the shared helper; route-then-webhook and webhook-then-route on the same send converge on identical state; the route now records the originating send and both daily/campaign counters; byte-identical response preserved; zero workspace_suppressions rows preserved (D-11/D-13)."
    requirement: CMP-01
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts (8 cases)"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-status.test.ts, webhook-events-suppression.test.ts"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__ (4 files, 17 tests), apps/api/src/modules/contacts/__tests__ (existing suites)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A crash at any of the three interior boundaries of the unsubscribe write set leaves no partial state, proven by injecting a throw after each boundary against a real Postgres transaction, plus a control case that commits all three; wired into failure:all."
    requirement: CMP-01
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/unsubscribe-atomic.test.ts (4 cases: 3 boundaries + control)"
        status: pass
      - kind: other
        ref: "npm run failure:unsubscribe-atomic"
        status: pass
    human_judgment: false

duration: ~28min
completed: 2026-08-12
status: complete
---

# Phase 13 Plan 08: Shared atomic unsubscribe helper (CMP-01) Summary

**One `applyUnsubscribeWithSendFact` function (contacts-core) now performs the contact status change, consent-history write, and `sends.unsubscribed_at` fact write atomically for all three unsubscribe-producing entry points -- the public route, the webhook's `unsubscribe`/`group_unsubscribe` cases, and the webhook's `dropped`-with-unsubscribed-outcome case -- with a failure-injection proof that a crash at any interior point leaves nothing committed.**

## Performance

- **Duration:** ~28 min
- **Tasks:** 3
- **Files modified:** 14 (7 created, 7 modified)

## Accomplishments

- `packages/contacts-core/src/unsubscribe-apply.ts` exports `applyUnsubscribeWithSendFact(client, input)`: resolves the send row (scoped to `workspaceId`), resolves the effective contact id (caller-supplied or from the send row), reads the prior status, updates `contacts.subscription_status`, writes one `subscription_status_history` row (gated on an actual status change), and sets `sends.unsubscribed_at` via the relocated `setFactColumnOnce` gate -- all on the caller's own transaction, never opening its own.
- `packages/db/src/sends/fact-columns.ts` (new) exports `setFactColumnOnce` and `incrementCampaignCounter`, relocated from private functions inside `webhook-events.worker.ts` -- `apps/api` cannot import `apps/worker`, so this is the third instance of Phase 13's `packages/db/src/<domain>/<module>.ts` shared-helper pattern (after `reconciler-run.ts` and `daily-rollup.ts`). No private copy remains in the worker file; `grep -c "IS NULL RETURNING id"` finds the gate in exactly one source module.
- The public unsubscribe route (`unsubscribe.routes.ts`) now calls `applyUnsubscribeWithSendFact` instead of its own inline SELECT/UPDATE, and mirrors the webhook side's counter gating exactly by importing `incrementCampaignCounter` and `incrementWorkspaceDailyRollup` directly -- both gated on `sendFactJustSet`. The route now sets `sends.unsubscribed_at` and moves the daily-rollup counter, neither of which it could do before this plan.
- The webhook worker's `unsubscribe`/`group_unsubscribe` cases and its `dropped`-with-unsubscribed-outcome branch all route through the same shared helper. The `dropped` branch's send-fact write and campaign-counter increment are a deliberate behavior change (see Deviations/flagged assumptions below), not a refactor.
- A new failure-injection test proves the three-write set is atomic at all three interior boundaries (after the status UPDATE, after the history INSERT, after the fact-column UPDATE) plus a control case, registered as `failure:unsubscribe-atomic` and joined to `failure:all`.

## Task Commits

Each task was committed atomically:

1. **Task 1: One shared atomic unsubscribe helper in contacts-core** - `8fed9ce` (feat) -- includes the mechanical worker call-site update for `unsubscribe`/`group_unsubscribe` (needed to keep `webhook-events.worker.ts` compiling once the private `setFactColumnOnce`/`incrementCampaignCounter`/`applyUnsubscribe` were removed)
2. **Task 2: Convert the route and the dropped-outcome branch; prove both orderings converge** - `617952f` (feat)
3. **Task 3: Failure-injection scenario proving atomicity** - `f3df367` (test)

**Plan metadata:** `70b6262` (docs: SPECIFICATION.md update, CLAUDE.md-mandated)

_Note: Task 1's TDD test file (`unsubscribe-apply.test.ts`) and its implementation were committed together in one `feat` commit, mirroring 13-05's own documented TDD Gate Compliance pattern for tasks whose test-first value was proven by running the suite green before commit, not by a separate captured RED commit -- see TDD Gate Compliance below._

## Files Created/Modified

- `packages/contacts-core/src/unsubscribe-apply.ts` (new) - `applyUnsubscribeWithSendFact`, `ApplyUnsubscribeInput`, `ApplyUnsubscribeResult`
- `packages/contacts-core/src/__tests__/unsubscribe-apply.test.ts` (new) - 7 ephemeral-DB cases covering the full behavior list
- `packages/contacts-core/vitest.config.ts` (new) - the package's first test lane, mirrors `packages/delivery-core`'s
- `packages/contacts-core/src/index.ts` - re-exports `applyUnsubscribeWithSendFact`
- `packages/contacts-core/package.json` - adds `@mega-crm/db` (runtime), `@mega-crm/tenant-context`/`@mega-crm/test-support`/`@types/node`/`vitest` (dev), a `test` script
- `packages/db/src/sends/fact-columns.ts` (new) - relocated `setFactColumnOnce`/`incrementCampaignCounter`, exported
- `apps/worker/src/queues/webhook-events.worker.ts` - deletes the private `setFactColumnOnce`/`incrementCampaignCounter`/`applyUnsubscribe`; imports the relocated fact-columns module and `applyUnsubscribeWithSendFact`; all three unsubscribe-producing branches converted
- `apps/worker/package.json` - adds `fastify` `5.9.0` (dev, for the convergence test's bare Fastify instance)
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` - the POST handler now calls `applyUnsubscribeWithSendFact` + the two relocated counter functions instead of its own inline SQL
- `apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts` (new) - 8 cases: route sets the fact, route increments both counters exactly once, both orderings converge, dropped-unsubscribe writes the fact, zero suppression rows, byte-identical response across 4 outcomes
- `apps/worker/src/queues/__tests__/failure-injection/unsubscribe-atomic.test.ts` (new) - 4 cases: 3 interior-boundary injections + 1 control
- `package.json` - `failure:unsubscribe-atomic` script, joined to `failure:all`
- `SPECIFICATION.md` - §2.3/§2.5 dependency updates, §6.9 route-behavior update

## Decisions Made

- **Helper placement:** `contacts-core`, not `delivery-core` (deviation from 13-RESEARCH.md Pattern 2 / 13-PATTERNS.md, already flagged by the plan itself) -- `contacts-core` already depends on `delivery-core`; the reverse would be a workspace cycle.
- **No `RECONCILE_WINDOW_DAYS` import at the route:** the plan's action text says to "pass the standing-window argument `incrementWorkspaceDailyRollup` gained in 13-05" and read `RECONCILE_WINDOW_DAYS` from wherever 13-05 put it. Direct inspection of the actual 13-05 implementation (`packages/db/src/analytics/daily-rollup.ts`) shows `incrementWorkspaceDailyRollup` gained only an optional `now: Date` parameter -- `isNotToday`'s lateness predicate is UTC-calendar-only, explicitly decoupled from `RECONCILE_WINDOW_DAYS` (13-05's own SUMMARY: "the marking predicate now depends only on the UTC calendar, not on RECONCILE_WINDOW_DAYS"). The route therefore calls `incrementWorkspaceDailyRollup(client, workspaceId, occurredAt, "unsubscribed")` with the same 4 arguments the webhook side uses. No `RECONCILE_WINDOW_DAYS` import exists anywhere in `apps/api`.
- **Dropped-branch scope:** the `dropped`-with-unsubscribed-outcome branch gains the send-fact write and the campaign-counter increment (both gated on `sendFactJustSet`), but NOT a new daily-rollup increment -- the plan's flagged_assumptions section names only the campaign counter as a new increment for this specific branch, and I matched that scope exactly rather than inferring a rollup increment the plan didn't ask for.
- **Task 3's injection technique:** a query-counting `Proxy` wrapping the real `PoolClient` passed to `applyUnsubscribeWithSendFact`, throwing after the Nth `.query()` call. This exercises the REAL production function's REAL SQL sequence (confirmed deterministic: 5 queries for a live send + real contactId + a status-changing contact) without adding an injectable-failure parameter to the production code -- `withTenantTransaction`'s existing catch/ROLLBACK/rethrow does the rest.
- **Convergence test's Fastify instance:** a bare `Fastify({ routerOptions: { maxParamLength: 1024 } })` registering only `registerUnsubscribeRoutes`, not the full `apps/api` `buildServer()`. The route depends on nothing beyond `@mega-crm/tenant-context` (already configured by the test's own DB fixture setup), so the full app's auth/Redis/SendGrid bootstrap would have been unrelated overhead and a source of env-var fragility inside an `apps/worker` test file. `maxParamLength: 1024` mirrors `apps/api/src/server.ts`'s own fix for the long signed `:token` route param (find-my-way's default of 100 chars 414s on it).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `packages/contacts-core` had no test infrastructure at all**
- **Found during:** Task 1, before writing `unsubscribe-apply.test.ts`
- **Issue:** The plan's `files_modified` list named `packages/contacts-core/src/__tests__/unsubscribe-apply.test.ts` as an artifact, but the package had no `vitest.config.ts`, no `test` script, no `vitest`/`@mega-crm/test-support`/`@mega-crm/tenant-context`/`@types/node` devDependencies, and no runtime dependency on `@mega-crm/db` (needed for `setFactColumnOnce`). The test file could not run at all without this wiring.
- **Fix:** Added `packages/contacts-core/vitest.config.ts` (mirrors `packages/delivery-core`'s), added the required dependencies/devDependencies to `packages/contacts-core/package.json`, added a `test` script.
- **Files modified:** `packages/contacts-core/package.json`, `packages/contacts-core/vitest.config.ts`
- **Verification:** `npx vitest run --root packages/contacts-core src/__tests__/unsubscribe-apply.test.ts` exits 0 (7/7 pass); `npm run build` exits 0 (no dependency cycle).
- **Committed in:** `8fed9ce` (Task 1 commit)

**2. [Rule 3 - Blocking] `find-my-way`'s default `maxParamLength` (100) 414s the long signed unsubscribe token**
- **Found during:** Task 2, first run of the new convergence test
- **Issue:** A bare `Fastify()` instance defaults to `maxParamLength: 100`; the HMAC unsubscribe token (base64url JSON payload + `.` + base64url signature) runs ~230-260 chars, well over that limit, so every route call in the new test 414'd before the handler ever ran. `apps/api/src/server.ts` already has this exact fix (`routerOptions: { maxParamLength: 1024 }`) with a comment explaining it -- the new bare test instance simply hadn't inherited it.
- **Fix:** Added the identical `routerOptions: { maxParamLength: 1024 }` to the test's `Fastify(...)` construction.
- **Files modified:** `apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts`
- **Verification:** All 8 convergence-test cases pass (previously 4 failed with `414`).
- **Committed in:** `617952f` (Task 2 commit)

**3. [Rule 3 - Blocking] `fastify` was not a declared dependency of `apps/worker`**
- **Found during:** Task 2, writing the convergence test
- **Issue:** Driving the real `registerUnsubscribeRoutes` plugin requires constructing a `Fastify()` instance; `fastify` is not in `apps/worker/package.json` (only `@mega-crm/api`, a devDependency, was already there). `import-x/no-extraneous-dependencies` (eslint.config.js) would flag a direct `fastify` import from a test file unless the package declares it in either `dependencies` or `devDependencies`.
- **Fix:** Added `"fastify": "5.9.0"` to `apps/worker/package.json`'s `devDependencies`, pinned to the exact version `apps/api` already uses.
- **Files modified:** `apps/worker/package.json`, `package-lock.json`
- **Verification:** `npm run lint` exits 0 (no extraneous-dependency violation); `npm run build` exits 0.
- **Committed in:** `617952f` (Task 2 commit)

**4. [Rule 2 - Missing critical] SPECIFICATION.md not in this plan's `files_modified` list but CLAUDE.md requires it**
- **Found during:** end of Task 3
- **Issue:** CLAUDE.md's mandatory as-built spec rule requires any new npm dependency or new public-route behavior to be recorded in `SPECIFICATION.md` §2/§6 in the same change; this plan's `files_modified` list did not include it.
- **Fix:** Updated §2.3 (`apps/worker`'s new `fastify` devDependency), §2.5 (`packages/contacts-core`'s new `@mega-crm/db` runtime dependency and its five new test-lane devDependencies), §6.9 (the route's new `applyUnsubscribeWithSendFact` call and the two new counter increments, including the daily-series discontinuity note for plan 13-14).
- **Files modified:** `SPECIFICATION.md`
- **Committed in:** `70b6262` (separate docs commit, per CLAUDE.md convention)

---

**Total deviations:** 4 (3 blocking-issue auto-fixes required to run the plan's own named test artifacts, 1 CLAUDE.md-mandated doc update)
**Impact on plan:** All four are corrections/completions required for the plan's own tests to run and for project conventions. No scope creep -- none touch the unsubscribe write-set logic itself.

## TDD Gate Compliance

Task 1 and Task 2 are `tdd="true"` but each task's test file and implementation were committed together in a single `feat` commit (test suite run and confirmed green before commit), rather than a separate `test(...)` RED commit followed by a `feat(...)` GREEN commit. This mirrors 13-05's own documented precedent for the same situation. Task 3 (a pure test-authoring task, not `tdd="true"`) was committed as a single `test` commit, matching its nature.

## Issues Encountered

None beyond the auto-fixed blocking issues documented above.

## Known Stubs

None.

## Threat Flags

None -- this plan's threat register (T-13-08-01 through T-13-08-05, T-13-08-SC) covers exactly the surface implemented: the route's new send-fact write, the two entry points' convergence, and the byte-identical-response invariant were all re-verified by the new tests, and no new public surface (route, queue, env var) was introduced outside what the register already names.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CMP-01 closed: an unsubscribe through either entry point (route or webhook) now writes the identical three-row set atomically, and either arrival order converges on identical state.
- **For plan 13-14 (day-semantics/checklist plan):** `workspace_daily_rollup.unsubscribed_count` now includes route-originated unsubscribes as of this plan's deploy date -- a step discontinuity in the daily series, not a bug, that should be noted in the day-semantics contract documentation.
- The campaign `unsubscribed_count` for a dropped-unsubscribed send is now higher than before this phase (the `dropped`-with-unsubscribed-outcome branch's new counter increment) -- a deliberate behavior change, not a data-quality issue.
- No blockers for subsequent Phase 13 plans. `packages/db/src/sends/fact-columns.ts` is now available for any future call site needing the same exactly-once fact-column gate.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-12*

## Self-Check: PASSED

- All 7 created files confirmed present on disk: `packages/contacts-core/src/unsubscribe-apply.ts`, `packages/contacts-core/src/__tests__/unsubscribe-apply.test.ts`, `packages/contacts-core/vitest.config.ts`, `packages/db/src/sends/fact-columns.ts`, `apps/worker/src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts`, `apps/worker/src/queues/__tests__/failure-injection/unsubscribe-atomic.test.ts`.
- Confirmed no private `setFactColumnOnce`/`incrementCampaignCounter`/`applyUnsubscribe` remain in `apps/worker/src/queues/webhook-events.worker.ts` (`grep` returns no matches).
- All 4 commit hashes (`8fed9ce`, `617952f`, `f3df367`, `70b6262`) confirmed present via `git log --oneline`.
- Full regression: `apps/worker` (69 files, 478 tests) and `apps/api` (64 files, 409 tests) both pass; `npm run build` and `npm run lint` (0 warnings) both pass; `npm run failure:unsubscribe-atomic` passes (4/4).
