---
phase: 10-tenant-isolation-trust-boundaries
plan: 12
subsystem: api
tags: [fastify, rate-limit, ioredis, redis, sendgrid-webhook, fail-open, sec-11, sec-08]

# Dependency graph
requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: 10-11's webhook timestamp-window verification (SEC-07) and the shared signed-fixture pattern reused here for the webhook bucket-isolation tests
provides:
  - "Distributed (Redis-backed) rate limiter shared across API instances, replacing the per-process in-memory store"
  - "Loud fail-open: limiter Redis outage lets requests through and logs a named error, instead of silently degrading"
  - "Independent rate-limit bucket for the SendGrid webhook route (100 req / 10s), previously unlimited"
  - "buildServer({ rateLimitRedisUrl }) test seam for pointing the limiter at a disposable Redis"
affects: [phase-11-delivery-correctness, phase-12-worker-reliability, phase-15-observability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "buildServer(options) accepts an optional override (rateLimitRedisUrl) for test-only Redis injection; production and every other call site are unaffected"
    - "A store/client sitting directly in the request path is configured to fail fast (short connectTimeout, bounded retryStrategy, enableOfflineQueue:false) rather than mirror a BullMQ connection's indefinite-retry contract"
    - "buildServer() waits for a freshly-constructed Redis client to settle (ready or errored once) before returning, closing the startup window where enableOfflineQueue:false would otherwise silently unthrottle the very first requests"

key-files:
  created:
    - apps/api/src/__tests__/rate-limit-distributed.test.ts
  modified:
    - apps/api/src/server.ts
    - apps/api/src/modules/webhooks/webhooks.routes.ts
    - SPECIFICATION.md

key-decisions:
  - "Reused the existing env.REDIS_URL as the limiter's default store (no new env var), with buildServer(options) as the only override seam, kept test-only"
  - "Webhook bucket sized at 100 req / 10s with reasoning against SendGrid's batch-by-size (not fixed-interval) POST cadence, documented inline next to the numbers"
  - "Limiter's Redis client is deliberately separate from every BullMQ connection in the codebase -- fails fast instead of retrying indefinitely, since it sits in the request path"

requirements-completed: [SEC-08, SEC-11]

coverage:
  - id: D1
    description: "Two buildServer() instances sharing one Redis enforce one shared rate limit: request N passes and request N+1 is rejected regardless of which instance receives which"
    requirement: "SEC-11"
    verification:
      - kind: integration
        ref: "apps/api/src/__tests__/rate-limit-distributed.test.ts#Test 2/3: two instances against one Redis reject at the SAME total the single instance did -- the 429 can land on either instance"
        status: pass
    human_judgment: false
  - id: D2
    description: "When the limiter's Redis is unreachable, requests proceed rather than failing, and the limiter's error is logged (loud fail-open)"
    requirement: "SEC-08"
    verification:
      - kind: integration
        ref: "apps/api/src/__tests__/rate-limit-distributed.test.ts#Test 4: with the limiter's Redis unreachable, requests proceed and an error naming the limiter is logged"
        status: pass
    human_judgment: false
  - id: D3
    description: "The webhook route has its own independent rate-limit bucket: exhausting it does not throttle other rate-limited routes, and vice versa"
    requirement: "SEC-08"
    verification:
      - kind: integration
        ref: "apps/api/src/__tests__/rate-limit-distributed.test.ts#Test 5a: exhausting the webhook route's bucket does not throttle a different rate-limited route"
        status: pass
      - kind: integration
        ref: "apps/api/src/__tests__/rate-limit-distributed.test.ts#Test 5b: exhausting another route's bucket does not throttle the webhook route"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-08
status: complete
---

# Phase 10 Plan 12: Distributed Rate Limiter & Webhook Bucket Summary

**Redis-backed `@fastify/rate-limit` store shared across API instances, a loud fail-open on store outage, and an independent 100-req/10s bucket for the SendGrid webhook route -- all proven by a two-instance in-process test against a disposable Redis.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 3
- **Files modified:** 4 (2 modified in Task 1, 1 test file created in Task 2, 1 doc modified in Task 3)

## Accomplishments

- `@fastify/rate-limit` now stores its counters in Redis (`buildServer`'s `rateLimitRedis` client) instead of the per-process in-memory default, so N API replicas enforce ONE shared limit instead of N times the configured `max` -- proven by an exact-count two-instance test, not merely "a 429 eventually appeared."
- A Redis outage for the limiter's client fails open (requests proceed) but is now LOUD: an `error` listener logs a named `"rate-limiter"` entry every time the connection fails, closing the gap where `skipOnError: true` alone would make the degradation silent.
- The SendGrid webhook route (`POST /webhooks/sendgrid/:pathToken`) had no rate limit at all before this plan (`global: false` + no route config = unlimited). It now has its own independent bucket (100 req / 10s), isolated in both directions from every other rate-limited route (invite-accept, contacts API, events API).
- `buildServer()` now waits for the limiter's Redis client to settle (ready or errored once) before returning -- otherwise the very first requests after boot could bypass the limiter purely because the `enableOfflineQueue: false` client hadn't finished its initial handshake, independent of whether Redis was actually healthy.

## Task Commits

1. **Task 1: Redis-backed limiter with a loud fail-open, and an independent webhook bucket** - `b65c225` (feat)
2. **Task 2: Two-instance and Redis-down proofs** - `177c757` (test)
3. **Task 3: Record the limiter topology in SPECIFICATION.md** - `b4123a4` (docs)

_Note: this plan's tasks are ordered implementation-then-comprehensive-test (per each task's own `<action>` text), not strict RED/GREEN -- Task 1's own `<verify>` command targets the test file Task 2's `<action>` explicitly instructs writing._

## Files Created/Modified

- `apps/api/src/server.ts` - constructs a dedicated `ioredis` client for the rate limiter (short `connectTimeout`, bounded `retryStrategy`, `enableOfflineQueue: false`), attaches an `error` listener that logs through pino, registers `@fastify/rate-limit` with `redis`/`nameSpace`/`skipOnError: true`, waits for the client to settle before returning, and closes it in an `onClose` hook. `buildServer(options)` now accepts an optional `rateLimitRedisUrl` override.
- `apps/api/src/modules/webhooks/webhooks.routes.ts` - adds `config: { rateLimit: { max: 100, timeWindow: "10 seconds" } }` to the webhook POST route, with inline reasoning for the numbers.
- `apps/api/src/__tests__/rate-limit-distributed.test.ts` (new) - 5 tests: single-instance limit, two-instance shared exact count, Redis-down fail-open with logged error, and webhook-bucket isolation in both directions.
- `SPECIFICATION.md` - §2.2 (ioredis now directly used), §6.1 (Redis store/namespace/fail-open/readiness-wait), §6.2 (webhook route's rate-limit column), §6.8 (replaces the old "no rate limit" note), §7 (the limiter's error log line).

## Decisions Made

- Reused `env.REDIS_URL` as the limiter's default store rather than introducing a new env var; `buildServer({ rateLimitRedisUrl })` is a test-only override seam, unused by production or any other existing test.
- Webhook bucket sized at 100 req / 10s (10/s sustained) -- an order of magnitude above a plausible SendGrid batch-POST burst rate for a single tenant mid-broadcast, reasoning documented inline in `webhooks.routes.ts` next to the numbers per the plan's own instruction ("so a future change has something to argue against").
- The limiter's Redis client is configured distinctly from every BullMQ connection in this codebase: BullMQ requires `maxRetriesPerRequest: null` (retry forever, since queue workers should hold open), while the limiter sits directly in the request path and must fail fast instead.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added a boot-time readiness wait for the limiter's Redis client**

- **Found during:** Task 2, writing the two-instance/Redis-down test suite -- Tests 1, 2/3, and 5b (all of which drive rate-limited requests immediately after `buildServer()` resolves, with no intervening async work) were consistently unable to observe a 429 within a generous safety cap.
- **Issue:** `enableOfflineQueue: false` (required for the "fail fast" behavior the plan explicitly asks for) means any command issued before the ioredis client's initial TCP handshake completes is immediately rejected -- indistinguishable from a genuine outage. `buildServer()` previously returned as soon as `app.register(rateLimit, ...)` resolved, without waiting for the client's actual connection, so the first several rate-limited requests after boot silently bypassed the limiter via `skipOnError` even against a perfectly healthy Redis. Task 5a's test happened to pass by accident (it does several async DB round-trips -- workspace creation -- before hammering the webhook route, incidentally giving the client time to connect), which is what surfaced this as a real production-relevant gap rather than a test-only artifact.
- **Fix:** `buildServer()` now awaits a bounded promise that resolves when the limiter's Redis client reaches `"ready"` or errors once, before returning. This is bounded by the same `connectTimeout` already configured, so it cannot hang server startup.
- **Files modified:** `apps/api/src/server.ts` (part of Task 1's commit, discovered while writing Task 2)
- **Verification:** All 5 tests in `rate-limit-distributed.test.ts` pass consistently across repeated runs; full `apps/api` suite (342 tests, 58 files) still passes.
- **Committed in:** `b65c225` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Necessary for the plan's own acceptance criteria (the two-instance/Redis-down tests to pass reliably) and for correctness in production -- without it, a freshly-booted or freshly-scaled-up API instance would silently unthrottle its earliest live requests. No scope creep beyond the plan's stated behavior.

## Issues Encountered

- The Redis-down test (Test 4) initially failed to observe a logged error: the reconnect attempt (and its failure) runs on the client's own backoff timer (`retryStrategy`, first attempt ~200ms after disconnect), independent of how fast the in-process `app.inject()` request loop runs -- 30-ish sequential in-process requests complete faster than that. Fixed by polling for the spy call (bounded 2s wait) after the request loop instead of asserting immediately, and by attaching the `vi.spyOn` before calling `redis.stop()` (the failure can fire within milliseconds of that call resolving).
- `npm run verify:redis-config` (listed in the plan's overall `<verification>` block) could not be run in this environment: it requires the `docker compose`-managed Redis container (built from `docker/redis.conf`) to be live, and this sandboxed worktree has no running Docker daemon. This check is unrelated to this plan's code (it verifies `docker/redis.conf`'s `maxmemory`/`appendonly` directives, established in Phase 8/9, unchanged here) and would fail identically with or without this plan's changes in this environment. `npx vitest run --root apps/api` (both the new file alone and the full 342-test suite) and `npm run lint && npm run build --workspaces --if-present` all pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SEC-11 and SEC-08 are closed for this plan's scope: the API's rate limiter is now correctly distributed and its webhook surface is isolated.
- Multi-replica deployment itself (actually running more than one API instance in production) remains out of this milestone per SPEC R8 -- this plan proves correctness in-process; Phase 14's deployment work is where a second real replica would first exist.
- No blockers for downstream phases. `npm run verify:redis-config` should be re-run against the real `docker compose` Redis (or in CI, where the `test` job already starts it) before this phase is considered fully verified end-to-end, though it is unrelated to this plan's own changes.

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-08*
