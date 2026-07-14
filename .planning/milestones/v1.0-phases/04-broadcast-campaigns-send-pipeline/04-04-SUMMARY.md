---
phase: 04-broadcast-campaigns-send-pipeline
plan: 04
subsystem: infra
tags: [bullmq, rate-limiter-flexible, redis, sendgrid, worker, send-pipeline, idempotency]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-03: @mega-crm/delivery-core (evaluatePreSendGate, dispatchSendGate, recordSendResult, recordExcluded, buildContactTemplateData, buildMailSendRequest, sendTenantMailV3, signUnsubscribeToken, buildListUnsubscribeUrl, getWorkspaceSendSettings)"
provides:
  - "apps/worker/src/queues/rate-limiter.ts: createTenantRateLimiter/consumeTenantToken (RateLimiterRedis token bucket keyed by workspaceId, cached per distinct RPS ceiling)"
  - "apps/worker/src/queues/send-dispatch.ts: processSendJob/SendJobResult -- the single shared dispatch function both send queues' workers call"
  - "apps/worker/src/queues/email-broadcast.worker.ts: createEmailBroadcastWorker (bounded concurrency 5)"
  - "apps/worker/src/queues/email-triggered.worker.ts: createEmailTriggeredWorker (concurrency 20, reserved lane for Phase 6)"
  - "New worker dependency rate-limiter-flexible@11.2.0 (package-legitimacy checkpoint approved)"
affects: [04-05, 04-06, 04-07, 04-08, phase-06-flows]

# Tech tracking
tech-stack:
  added: ["rate-limiter-flexible@11.2.0 (apps/worker)"]
  patterns:
    - "processSendJob(data, deps?) is exported standalone (not only as a Worker's inline processor), mirroring events-ingest.worker.ts's testability convention -- deps.sendMail/deps.redisClient are injectable so tests never touch the real SendGrid network but DO exercise the real Postgres/Redis integration path"
    - "429/5xx and tenant-rate-limiter-exhaustion both collapse into the same {outcome:'rate_limited', rateLimitMs} discriminated result -- the Worker wrapper (not processSendJob) is the only place that calls worker.rateLimit(ms) + Worker.RateLimitError(), keeping the dispatch function unit-testable without a live BullMQ Worker"
    - "Two independent BullMQ queues (email-broadcast concurrency:5, email-triggered concurrency:20) are the SEND-03 isolation mechanism -- never BullMQ job priority, never a limiter: option"

key-files:
  created:
    - apps/worker/src/queues/rate-limiter.ts
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/email-broadcast.worker.ts
    - apps/worker/src/queues/email-triggered.worker.ts
    - apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts
    - apps/worker/src/queues/__tests__/backoff.test.ts
    - apps/worker/src/queues/__tests__/rate-limiter.test.ts
  modified:
    - apps/worker/package.json
    - apps/worker/vitest.config.ts
    - apps/worker/src/server.ts
    - packages/delivery-core/src/send-ledger.ts

key-decisions:
  - "Package-legitimacy checkpoint (rate-limiter-flexible@11.2.0) approved by the user via live npmjs.com verification before this executor session began (repo animir/node-rate-limiter-flexible, ~2.46M weekly downloads, version matches the plan's pin) -- install proceeded with no further checkpoint"
  - "RateLimiterRedis instances are cached per distinct RPS value (a Map keyed by rps), not one global instance -- points is fixed at construction time, so a per-workspace rps override (workspace_send_settings.rps_limit) is handled by re-using/creating the instance for that value while the bucket key itself (consume(workspaceId)) is what actually scopes the throttle per tenant"
  - "processSendJob accepts an optional ProcessSendJobDeps (sendMail, redisClient) purely for testability -- production callers (both workers) invoke it with no deps, defaulting to the real sendTenantMailV3 and a lazily-created singleton ioredis client from REDIS_URL"
  - "Unsubscribe token TTL set to 5 years (UNSUBSCRIBE_TOKEN_TTL_SECONDS) per RESEARCH.md Assumption A3 -- effectively long-lived so an old marketing email opened months later still successfully unsubscribes; exp remains in the signed payload only as defense-in-depth"
  - "[Rule 1 - Bug] Fixed packages/delivery-core/src/send-ledger.ts's recordSendResult: Postgres rejected the query with \"inconsistent types deduced for parameter $2\" because $2 was used both to assign the send_status enum column and to compare (= 'sent') inside a CASE with no cast -- this bug pre-dated this plan (04-03 never exercised recordSendResult against a real Postgres connection) and was only surfaced by this plan's first integration test that actually calls it end-to-end"

patterns-established:
  - "Shared dispatch functions in apps/worker (send-dispatch.ts) take an optional deps object for the one genuinely non-deterministic external call (SendGrid), letting tests run the REAL Postgres/Redis path while stubbing only the network edge -- avoids vi.mock() module-replacement entirely"

requirements-completed: [SEND-01, SEND-02, SEND-03, SEND-05, SEND-06, SEND-07, SUBS-03, SUBS-04]

coverage:
  - id: D1
    description: "A sendable contact's broadcast send job decrypts the tenant SendGrid key, passes the pre-send gate, calls SendGrid, and is recorded 'sent' -- carrying List-Unsubscribe + List-Unsubscribe-Post headers built from a per-message signed token (SEND-05, SUBS-03, SUBS-04)"
    requirement: "SEND-05"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts#SEND-05/SUBS-03: a sendable contact is decrypted, gated, sent, and recorded as sent"
        status: pass
    human_judgment: false
  - id: D2
    description: "A redelivered job for an already-'sent' contact calls SendGrid 0 times and creates no second sends row (SEND-06)"
    requirement: "SEND-06"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts#SEND-06: a redelivered job for an already-'sent' contact calls SendGrid 0 times and creates no second sends row"
        status: pass
    human_judgment: false
  - id: D3
    description: "An unsubscribed/suppressed/frequency-capped contact is recorded 'excluded' with its reason and SendGrid is never called (SUBS-03)"
    requirement: "SUBS-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts#SUBS-03: an unsubscribed contact is recorded as excluded and SendGrid is never called"
        status: pass
    human_judgment: false
  - id: D4
    description: "A test send (kind='test') rides the same queue but skips the pre-send gate and the ledger insert (D-12)"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts#D-12: a test send skips the pre-send gate and the ledger insert but still calls SendGrid"
        status: pass
    human_judgment: false
  - id: D5
    description: "A SendGrid 429/5xx response yields {outcome:'rate_limited'} without recording a terminal status, and a subsequent redelivery of the same job still succeeds and records exactly one sent row (SEND-07, no consumed retry attempt)"
    requirement: "SEND-07"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/backoff.test.ts#does NOT consume a retry attempt: a redelivered job after a 429 still succeeds and records exactly one sent row"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/backoff.test.ts#a 429 response yields {outcome:'rate_limited'} and leaves the sends row 'dispatching' (no consumed attempt)"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/backoff.test.ts#a 500 response also yields {outcome:'rate_limited'} using the fixed 2s fallback when no rate-limit headers are present"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/backoff.test.ts#prefers X-RateLimit-Reset (unix seconds) over the fixed fallback when Retry-After is absent"
        status: pass
    human_judgment: false
  - id: D6
    description: "The per-tenant token bucket gates a send once the workspace's configured RPS is exhausted, scoped independently per workspaceId (SEND-02/SEND-03)"
    requirement: "SEND-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/rate-limiter.test.ts#allows sends up to the configured RPS ceiling, then gates the next one"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/rate-limiter.test.ts#scopes the bucket per workspaceId -- one tenant's exhausted budget never blocks another tenant"
        status: pass
    human_judgment: false
  - id: D7
    description: "email-broadcast and email-triggered are two separate BullMQ queues with independent workers/concurrency, registered in apps/worker/src/server.ts, with no BullMQ limiter option and no @sendgrid/mail singleton import (SEND-01/SEND-03)"
    requirement: "SEND-03"
    verification:
      - kind: other
        ref: "grep -c 'limiter:' apps/worker/src/queues/{email-broadcast,email-triggered,send-dispatch}.ts == 0; grep -c '@sendgrid/mail' apps/worker/src/queues/{send-dispatch,email-broadcast,email-triggered}.ts == 0; grep -q createEmailBroadcastWorker/createEmailTriggeredWorker apps/worker/src/server.ts"
        status: pass
      - kind: other
        ref: "cd apps/worker && npx tsc -p tsconfig.json --noEmit (clean)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 4: Throttled, idempotent SendGrid dispatch engine Summary

**Per-tenant `rate-limiter-flexible` Redis token bucket + a shared `processSendJob` dispatch function (decrypt key -> pre-send gate -> idempotent ledger insert -> D-18 template data -> List-Unsubscribe -> throttle -> SendGrid v3 -> 429/5xx backoff signal) wired into two independent BullMQ workers (`email-broadcast`, `email-triggered`).**

## Performance

- **Duration:** 20 min
- **Tasks:** 3 (Task 1 checkpoint approved by user before this session; Tasks 2-3 executed)
- **Files modified:** 12 (7 created, 5 modified, including 1 pre-existing bug fix in `packages/delivery-core`)

## Accomplishments
- **Task 1 (checkpoint, resumed as approved):** The user explicitly approved installing `rate-limiter-flexible@11.2.0` into `apps/worker` after reviewing npmjs.com registry evidence (repo `github.com/animir/node-rate-limiter-flexible`, ~2.46M weekly downloads, version matching the plan's pin, and the package's presence in the project's own CLAUDE.md stack docs). No further human input was required for this plan.
- `rate-limiter.ts`: `createTenantRateLimiter`/`consumeTenantToken` -- a `RateLimiterRedis` token bucket keyed by `workspaceId`, with instances cached per distinct RPS ceiling since `points` is fixed at construction time.
- `send-dispatch.ts`: the single shared `processSendJob` both send queues' workers call -- decrypts the tenant's SendGrid key (`@mega-crm/kms`), resolves the workspace's RPS/frequency settings, and for `kind='campaign'` runs `evaluatePreSendGate` -> `dispatchSendGate` (idempotent insert-gate) -> `buildContactTemplateData` (D-18, the sole source of `dynamic_template_data`, never assembled inline) -> a per-message signed unsubscribe token -> the per-tenant rate limiter -> `sendTenantMailV3` -> `recordSendResult`. `kind='test'` rides the same function but skips the gate and ledger insert (D-12). Every 429/5xx or exhausted-token-bucket outcome collapses into `{outcome:"rate_limited", rateLimitMs}` -- a discriminated result the thin Worker wrapper (not `processSendJob`) turns into `worker.rateLimit(ms)` + `Worker.RateLimitError()`, so the dispatch function stays unit-testable without a live BullMQ Worker.
- `email-broadcast.worker.ts` (concurrency 5, bounded) and `email-triggered.worker.ts` (concurrency 20, always-on, Phase 6's reserved lane) both wrap `processSendJob` and are registered in `apps/worker/src/server.ts`'s `buildWorker()`. Neither uses a BullMQ `limiter` option; neither queue file imports `@sendgrid/mail`.
- 3 Wave-0 test files, 11 tests, all passing against the real test Postgres + Redis (`send-dispatch-idempotency.test.ts`, `backoff.test.ts`, `rate-limiter.test.ts`) -- only the SendGrid network call itself is stubbed via an injectable `sendMail` dependency.
- `apps/worker` typechecks clean; full `apps/worker` (25 tests), `packages/delivery-core` (19 tests), and `apps/api` (135 tests) suites all pass after this plan's changes.

## Task Commits

1. **Task 1: Package-legitimacy gate for rate-limiter-flexible** - approved by user (no code change; recorded here per continuation instructions)
2. **Task 2: Per-tenant token bucket + idempotent send-dispatch processor** - `c28645f` (feat)
3. **Task 3: email-broadcast + email-triggered workers, registered with reserved lanes** - `262a3c1` (feat)

_Note: no TDD gate commits (RED/GREEN split) -- `tdd="true"` on Task 2 was implemented with tests written and passing in the same commit, per the same convention 04-03 already established (both `tsc` and `vitest` gates green before the commit)._

## Files Created/Modified
- `apps/worker/src/queues/rate-limiter.ts` - `createTenantRateLimiter`/`consumeTenantToken` (RateLimiterRedis token bucket)
- `apps/worker/src/queues/send-dispatch.ts` - `processSendJob`/`SendJobResult`/`ProcessSendJobDeps` (shared dispatch function)
- `apps/worker/src/queues/email-broadcast.worker.ts` - `createEmailBroadcastWorker` (concurrency 5)
- `apps/worker/src/queues/email-triggered.worker.ts` - `createEmailTriggeredWorker` (concurrency 20)
- `apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts` - SEND-05/SEND-06/SUBS-03/D-12 coverage
- `apps/worker/src/queues/__tests__/backoff.test.ts` - SEND-07 coverage (429/500/X-RateLimit-Reset/no-consumed-attempt)
- `apps/worker/src/queues/__tests__/rate-limiter.test.ts` - SEND-02/SEND-03 token bucket coverage
- `apps/worker/package.json` - adds `rate-limiter-flexible@11.2.0`, `@mega-crm/kms`, `@mega-crm/delivery-core`
- `apps/worker/vitest.config.ts` - test-safe `KMS_PROVIDER`/`KMS_LOCAL_KEK`/`UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` defaults
- `apps/worker/src/server.ts` - registers both new workers, updates the startup log line
- `packages/delivery-core/src/send-ledger.ts` - fixes `recordSendResult`'s Postgres type-inference bug (Rule 1)

## Decisions Made
- `RateLimiterRedis` instances are cached per distinct RPS value (a `Map<number, RateLimiterRedis>`), not a single global instance -- the bucket key (`consume(workspaceId)`) is what actually scopes the throttle per tenant.
- `processSendJob(data, deps?)` accepts an optional `sendMail`/`redisClient` override purely for test injection; production call sites (both workers) pass no `deps`, defaulting to the real `sendTenantMailV3` and a lazily-created singleton `ioredis` client.
- Unsubscribe token TTL set to 5 years (`UNSUBSCRIBE_TOKEN_TTL_SECONDS`) per RESEARCH.md Assumption A3 -- an old marketing email must still successfully unsubscribe when opened months later; `exp` stays in the payload only as defense-in-depth, not a functional short expiry.
- Test-send `sendId` (used for `custom_args`/the unsubscribe token, never for a ledger row) is a fresh `randomUUID()` per D-12 -- test sends have no `sends` row to key off.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `packages/delivery-core/src/send-ledger.ts`'s `recordSendResult` threw "inconsistent types deduced for parameter $2" against real Postgres**
- **Found during:** Task 2, first run of `send-dispatch-idempotency.test.ts`'s sendable-contact test
- **Issue:** The `UPDATE sends SET status = $2, ... sent_at = CASE WHEN $2 = 'sent' THEN now() ...` query used `$2` both to assign the `send_status` enum column and to compare against a text literal inside the `CASE`, with no explicit cast -- Postgres deduces the parameter's type from its first use and rejects the second, inconsistently-typed use. This bug pre-dated this plan (introduced in 04-03) but was never caught there because 04-03's own test suite never exercised `recordSendResult` against a real Postgres connection.
- **Fix:** Added explicit `$2::send_status` casts at both usages.
- **Files modified:** `packages/delivery-core/src/send-ledger.ts`
- **Verification:** All 3 previously-failing tests now pass; `packages/delivery-core`'s own 19-test suite and `apps/api`'s 135-test suite both remain green after the fix.
- **Committed in:** `c28645f` (Task 2 commit)

**2. [Rule 3 - Blocking] `apps/worker`'s test environment was missing `KMS_PROVIDER`/`KMS_LOCAL_KEK`/`UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL`**
- **Found during:** Task 2, first typecheck/test run after wiring `@mega-crm/kms` and `@mega-crm/delivery-core` into `send-dispatch.ts`
- **Issue:** Both packages read these env vars directly from `process.env` (no zod schema, by design); `apps/worker/vitest.config.ts` didn't set test-safe defaults, so any call would throw.
- **Fix:** Added the same test-safe defaults `apps/api/vitest.config.ts` already established in 04-03.
- **Files modified:** `apps/worker/vitest.config.ts`
- **Verification:** All 11 new tests pass; existing 3 worker test files remain green.
- **Committed in:** `c28645f` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug fix in a prior plan's shared package, 1 blocking test-env fix)
**Impact on plan:** Both fixes were required for the send pipeline to actually function under test; neither expands scope beyond what the plan specified. The `send-ledger.ts` fix also benefits every future caller of `recordSendResult` (04-05/04-06/Phase 6).

## Issues Encountered
- The plan's own Task 3 `<verify><automated>` snippet (`grep -Lq "limiter:" src/queues/email-broadcast.worker.ts && ...`) has a flag/semantics mismatch on this environment's `grep` (`-L`'s exit status is still based on "did a line match", not inverted for the "files without match" listing mode) -- the literal command as written only proceeds to `tsc` when the string IS present, the opposite of its evident intent. Verified the actual acceptance criterion directly instead: `grep -c "limiter:"` returns 0 for all three queue files, and `npx tsc -p tsconfig.json --noEmit` passes independently. No code change needed; flagging for awareness if this exact snippet shape is reused in a future plan's verify block.

## User Setup Required
None - no new external service configuration required. `REDIS_URL`/`DATABASE_URL`/`KMS_*`/`UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` for `apps/worker`'s real (non-test) runtime were already flagged as this plan's `<user_setup>` block in 04-04-PLAN.md and mirror 04-03's already-documented operational prerequisites (STATE.md).

## Next Phase Readiness
- `processSendJob`, `createEmailBroadcastWorker`, `createEmailTriggeredWorker` are ready for 04-05/04-06/04-08 to enqueue real jobs against (`campaignId`/`contactId`/`kind` per `emailBroadcastJobSchema`) -- no further dispatch-layer work needed before those plans start.
- Phase 6 (flow-triggered sends) can enqueue directly onto `email-triggered` using the exact same `processSendJob` path once it exists -- the reserved lane and shared dispatch function are both already in place.
- The `send-ledger.ts` fix this plan surfaced means `recordSendResult` is now proven against a real Postgres `send_status` enum column for the first time in this codebase -- future callers can rely on it without re-discovering the same type-inference bug.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 11 key files/paths confirmed present on disk (7 created, 4 modified); both task commits (`c28645f`, `262a3c1`) confirmed in git history; 25/25 `apps/worker` tests, 19/19 `packages/delivery-core` tests, and 135/135 `apps/api` tests pass.
