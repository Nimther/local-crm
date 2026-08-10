---
phase: 12-worker-reliability-tenant-fairness
plan: 03
subsystem: infra
tags: [bullmq, ioredis, redis, worker, tenant-fairness, concurrency, tdd]

# Dependency graph
requires:
  - phase: 11-delivery-correctness
    provides: SEND_LOCK_DURATION_MS/CLAIM_TX_MARGIN_MS/RECORD_TX_MARGIN_MS (queue-options.ts) and SENDGRID_TIMEOUT_MS (delivery-core) that the lease TTL derives from
provides:
  - "acquireTenantLaneSlot / releaseTenantLaneSlot: TTL-leased sorted-set semaphore keyed on (workspaceId, lane)"
  - "resolveTenantLaneCap + TENANT_LANE_CONCURRENCY_DEFAULTS: versioned per-lane cap with env override and fail-safe fallback"
  - "SEND_SLOT_LEASE_TTL_MS / SEND_SLOT_LEASE_MARGIN_MS: derived lease lifetime, proven below SEND_LOCK_DURATION_MS"
affects: [12-04-wire-semaphore-into-dispatch]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Sorted-set (ZSET) TTL-leased semaphore via a single atomic EVAL (ZREMRANGEBYSCORE purge + ZCARD + ZADD/PEXPIRE), not an INCR/DECR counter -- per-holder expiry instead of key-wide expiry"
    - "Discriminated-result-instead-of-throw Redis primitive (mirrors rate-limiter.ts's consumeTenantToken), with a genuine Redis error propagating rather than resolving to acquired: true/false"

key-files:
  created:
    - apps/worker/src/queues/tenant-lane-semaphore.ts
    - apps/worker/src/queues/__tests__/tenant-lane-semaphore.test.ts
  modified: []

key-decisions:
  - "Cap and lease TTL are both overridable via the acquireTenantLaneSlot options argument so tests can use small caps and short leases without waiting out production-scale values"
  - "Module placed at apps/worker/src/queues/tenant-lane-semaphore.ts (beside rate-limiter.ts) per PLAN.md's explicit D-10 layout-discretion override, superseding 12-PATTERNS.md's earlier packages/queue-core/src/tenant-fairness/ suggestion"

patterns-established:
  - "TENANT_LANE_CONCURRENCY_DEFAULTS: broadcast 3 / triggered 12, ~60% of each lane's worker concurrency (5/20), versioned with rationale comment (Phase 9 D-12 convention)"

requirements-completed: [WRK-02]

coverage:
  - id: D1
    description: "Per-tenant-per-lane TTL-leased concurrency semaphore (acquire/release, cap boundary, lease expiry, both isolation axes, env-override parsing, fail-closed on Redis error)"
    requirement: "WRK-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/tenant-lane-semaphore.test.ts (17 tests)"
        status: pass
      - kind: other
        ref: "npx tsc -p apps/worker/tsconfig.json --noEmit"
        status: pass
    human_judgment: false

# Metrics
duration: 25min
completed: 2026-08-10
status: complete
---

# Phase 12 Plan 03: Tenant-Lane Concurrency Semaphore Summary

**TTL-leased Redis sorted-set semaphore keyed on (workspaceId, lane) closing WRK-02's tenant-fairness gap, built test-first (RED then GREEN).**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-10T16:48Z (approx.)
- **Completed:** 2026-08-10T16:50:24Z
- **Tasks:** 2 (RED, GREEN)
- **Files modified:** 2 (both new)

## Accomplishments
- Built `apps/worker/src/queues/tenant-lane-semaphore.ts`: `acquireTenantLaneSlot`/`releaseTenantLaneSlot` implement a sorted-set (ZSET) semaphore with per-holder lease expiry via one atomic `EVAL` (purge expired holders, count survivors, admit-or-reject) -- deliberately not a counter+key-wide-TTL, which would leak a crashed holder's slot indefinitely under sustained traffic
- `resolveTenantLaneCap` resolves `TENANT_LANE_CONCURRENCY_BROADCAST`/`_TRIGGERED` env overrides, falling back to the versioned defaults (`broadcast: 3`, `triggered: 12`) on any malformed value (absent/empty/non-numeric/fractional/zero/negative) with a `scrubbedConsole.warn`
- `SEND_SLOT_LEASE_TTL_MS` derived from `SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS + SEND_SLOT_LEASE_MARGIN_MS` (40s), asserted (and proven by test) to stay below `SEND_LOCK_DURATION_MS` (60s) so a leaked slot self-heals before BullMQ would consider the job stalled
- A genuine Redis error from the acquire script's evaluation propagates to the caller rather than ever resolving to `acquired: true` or `acquired: false` -- proven with a stub client whose `eval` rejects
- 17-test suite covering: cap boundary, release-frees-one-slot, lease expiry without release, lane-within-tenant isolation (D-02), tenant-within-lane isolation, retry-after bounds, token release/no-op-on-unheld-token semantics, single-EVAL-call-per-acquire, the lease-vs-lock-duration ordering invariant, six `resolveTenantLaneCap` fallback cases plus the positive-integer-parses case, and the fail-closed Redis-error path

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): Failing semaphore test suite** - `066f58d` (test)
2. **Task 2 (GREEN): TTL-leased sorted-set semaphore implementation** - `905f11f` (feat)

_No REFACTOR commit was needed -- the GREEN implementation was clean on first pass._

**Plan metadata:** commit will follow this SUMMARY (worktree mode: STATE.md/ROADMAP.md updates deferred to the orchestrator).

## Files Created/Modified
- `apps/worker/src/queues/__tests__/tenant-lane-semaphore.test.ts` - 17-case RED-then-GREEN suite proving the semaphore's full contract against a real test Redis, plus a stub-client fail-closed case
- `apps/worker/src/queues/tenant-lane-semaphore.ts` - the semaphore itself: `acquireTenantLaneSlot`, `releaseTenantLaneSlot`, `resolveTenantLaneCap`, `TENANT_LANE_CONCURRENCY_DEFAULTS`, `SEND_SLOT_LEASE_TTL_MS`, `SEND_SLOT_LEASE_MARGIN_MS`, types `TenantLane`/`AcquireSlotResult`/`AcquireSlotOptions`

## Decisions Made
- Followed PLAN.md's explicit module-placement override: the semaphore lives in `apps/worker/src/queues/` beside `rate-limiter.ts`, not in `packages/queue-core` as 12-PATTERNS.md's earlier draft suggested -- PLAN.md's "Module placement note" is the more recent, authoritative instruction and this plan follows it
- `acquireTenantLaneSlot`'s `options.cap`/`options.leaseTtlMs` are test-facing overrides on top of the production defaults (`resolveTenantLaneCap(lane)` / `SEND_SLOT_LEASE_TTL_MS`) -- this is what let the test suite prove the cap-boundary and lease-expiry behaviors without either a huge fixture loop or a tens-of-seconds sleep

## Deviations from Plan

None - plan executed exactly as written. No new dependency was added (the implementation uses `ioredis`'s existing `Redis#eval`, `node:crypto`'s `randomUUID`, and the already-installed `@mega-crm/redaction`/`@mega-crm/delivery-core` packages), so no `SPECIFICATION.md` update was required per `.claude/CLAUDE.md`'s "if a package is declared but not yet used, note it explicitly" rule -- not applicable here since no new package was declared.

## Issues Encountered
- The worktree had no `node_modules` (only a partial rescue copy of `.planning/` was present, consistent with `.planning/` being gitignored per project memory). Ran `npm install --prefer-offline` in the worktree to populate workspace-linked `node_modules` before any test could run; verified the `@mega-crm/*` symlinks resolved into this worktree's own `packages/*` (not the main checkout's). The install incidentally touched `package-lock.json` (an unrelated `@mega-crm/api` devDependency entry) -- reverted that file with `git checkout -- package-lock.json` before staging any task commit, since it was an environment-setup side effect, not a plan change.
- Confirmed a local Redis (`redis-cli ping` → `PONG`) was reachable at the default test URL before relying on it for the suite's real-Redis-backed cases.

## User Setup Required

None - no external service configuration required. (`TENANT_LANE_CONCURRENCY_BROADCAST`/`TENANT_LANE_CONCURRENCY_TRIGGERED` are optional env overrides with safe versioned defaults; no action needed to ship this plan.)

## Next Phase Readiness
- The semaphore primitive is complete, proven in isolation, and ready to be wired into `send-dispatch.ts`'s acquire-before-dispatch call site around the existing `consumeTenantToken` check -- that wiring (the `try`/`finally` acquire+release plus the `tenant_bucket`/`moveToDelayed` routing for a rejected acquire) is 12-04's job, not this plan's.
- No blockers. `TENANT_LANE_CONCURRENCY_DEFAULTS`, `SEND_SLOT_LEASE_TTL_MS`, and `SEND_SLOT_LEASE_MARGIN_MS` are all exported and stable for 12-04 to import directly.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-10*
