---
phase: 10-tenant-isolation-trust-boundaries
plan: 11
subsystem: api
tags: [fastify, sendgrid-webhook, ecdsa, replay-protection, zod, vitest]

# Dependency graph
requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: "plans 10-01..10-10 (scan role, GUC retirement, fail-closed RLS, Better Auth grants, API-key scopes) -- this plan only touches the webhook signature/timestamp path, no dependency on those internals"
provides:
  - "isWebhookTimestampFresh pure predicate + DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS (apps/api/src/modules/webhooks/signature-verify.ts)"
  - "WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS env var, default 600s, coerced positive int (apps/api/src/env.ts)"
  - "webhooks.routes.ts composes freshness with signature verification into the existing single 400 path"
  - "webhook-timestamp-window.test.ts: 8-behavior boundary/replay/composition test suite, self-signing via starkbank-ecdsa"
affects: [11-delivery-correctness, 12-tenant-fair-throttling, 13-compliance-analytics]

# Tech tracking
tech-stack:
  added: ["starkbank-ecdsa 1.2.0 (apps/api devDependency, test-only -- already a transitive dep of @sendgrid/eventwebhook)"]
  patterns:
    - "Pure freshness predicate kept structurally separate from the vendor-wrapped signature verifier; route composes both into one indistinguishable failure path"
    - "vi.useFakeTimers({ toFake: [\"Date\"] }) to get a frozen, exact clock for boundary-sensitive HTTP tests without faking setTimeout/setInterval (avoids disturbing BullMQ/ioredis/pg's real timers)"
    - "Workspace-scoped BullMQ job lookup (filter getJobs() by job.data.workspaceId) instead of global getJobCounts() before/after deltas, to stay race-free when multiple test files enqueue onto the same shared queue"

key-files:
  created:
    - apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts
    - apps/api/src/modules/webhooks/__tests__/starkbank-ecdsa.d.ts
  modified:
    - apps/api/src/modules/webhooks/signature-verify.ts
    - apps/api/src/modules/webhooks/webhooks.routes.ts
    - apps/api/src/env.ts
    - apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts
    - apps/api/package.json
    - SPECIFICATION.md

key-decisions:
  - "Freshness predicate bounds the header timestamp in BOTH directions (past AND future), not just staleness -- a future-dated timestamp is equally a forgery/skew signal (T-10-11-02)"
  - "Predicate reads no environment variable itself; the route resolves WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS from env.ts and passes it in as a parameter, keeping the predicate pure and directly unit-testable"
  - "Deviation: fixed a latent cross-file race in webhooks-signature.test.ts's existing getJobCounts() before/after delta test, exposed by this plan adding a second real-enqueue test file against the same shared BullMQ queue -- switched both files to workspace-scoped job lookups and dropped the destructive queue-wide obliterate() in that file's afterAll"
  - "Deviation: froze Date to the SendGrid fixture's own 2020-09-14 timestamp for the one pre-existing 'valid signature' test that now fails freshness against real wall-clock time, rather than altering the fixture's signed bytes"

patterns-established:
  - "starkbank-ecdsa (the library @sendgrid/eventwebhook verifies with internally) used directly in tests to self-sign fixture payloads at test-controlled timestamps, when a fixed vendor-published fixture can't exercise time-varying behavior"

requirements-completed: [SEC-07]

coverage:
  - id: D1
    description: "A signed delivery whose signature timestamp is exactly 600 seconds old is accepted (200, enqueued)"
    requirement: "SEC-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 1: header timestamp exactly 600 seconds old -> 200 and enqueues"
        status: pass
    human_judgment: false
  - id: D2
    description: "A signed delivery whose signature timestamp is 601 seconds old is rejected (400, nothing enqueued)"
    requirement: "SEC-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 2: header timestamp 601 seconds old -> 400 and enqueues nothing"
        status: pass
    human_judgment: false
  - id: D3
    description: "A malformed or missing signature timestamp is rejected identically (byte-identical body) to a bad signature"
    requirement: "SEC-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 3: non-numeric timestamp header -> 400, body byte-identical to a wrong-signature delivery"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 4: missing timestamp header -> 400, body byte-identical to a wrong-signature delivery"
        status: pass
    human_judgment: false
  - id: D4
    description: "A future-dated signature timestamp beyond the window is rejected (bounded in both directions)"
    requirement: "SEC-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 5: header timestamp 601 seconds in the FUTURE -> 400 (bounded in both directions)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Replaying a previously accepted delivery after the window has elapsed is rejected"
    requirement: "SEC-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 6: replaying an accepted delivery after the window has elapsed is rejected the second time"
        status: pass
    human_judgment: false
  - id: D6
    description: "Freshness composes WITH signature verification, never replaces it -- a fresh timestamp with a wrong signature still fails"
    requirement: "SEC-07"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 7: a fresh timestamp with a WRONG signature still returns 400 (freshness composes with, never replaces, verification)"
        status: pass
    human_judgment: false
  - id: D7
    description: "The window is overridable by environment variable (WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) and defaults to 600 seconds"
    requirement: "SEC-07"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts#Test 8: the pure predicate takes an explicit tolerance override and defaults to 600 seconds when unset"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-08-07
status: complete
---

# Phase 10 Plan 11: Webhook Signature-Timestamp Freshness Window Summary

**Bounds SendGrid Event Webhook signature-timestamp age to 600s in both directions (env-overridable), rejecting stale/future/malformed/missing timestamps and replay-after-window identically to a bad signature, via a pure predicate composed alongside (not replacing) the existing ECDSA verification.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-08-07T20:15:46Z (approx, first commit 2026-08-08T01:25:46+05:00)
- **Completed:** 2026-08-07T20:29:58Z (2026-08-08T01:29:58+05:00)
- **Tasks:** 2 (RED + GREEN, `type: tdd` plan)
- **Files modified:** 8 (2 created, 6 modified)

## Accomplishments

- `isWebhookTimestampFresh` — a pure, unit-testable predicate bounding the `x-twilio-email-event-webhook-timestamp` header's age in both directions, plus its default 600s tolerance constant
- `webhooks.routes.ts` composes freshness with signature verification into the SAME existing 400 return — stale, future-dated, malformed, missing-timestamp, and bad-signature deliveries are now byte-identically indistinguishable to the caller
- `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` env var (default 600, coerced positive int) lets the window be widened/narrowed without a deploy
- Replay of an already-accepted delivery is rejected once the window elapses, proven with a frozen-clock test rather than a real sleep
- Fixed a latent cross-file BullMQ-queue race the new test file exposed in the pre-existing `webhooks-signature.test.ts`

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing boundary tests for the signature-timestamp window (RED)** - `03c4b04` (test)
2. **Task 2: The freshness predicate, its wiring, and the environment override (GREEN)** - `5330c15` (feat)

**Plan metadata:** not committed to `.planning/` — this repo gitignores `.planning/` and `.claude/` (see `<repo_specific_gitignore_contract>`); this SUMMARY lives only in the worktree for the orchestrator to copy out.

_TDD gate sequence confirmed in git log: `test(10-11)` (RED) precedes `feat(10-11)` (GREEN)._

## Files Created/Modified

- `apps/api/src/modules/webhooks/__tests__/webhook-timestamp-window.test.ts` - 8-behavior boundary/replay/composition test suite; self-signs fixture payloads via `starkbank-ecdsa` at test-chosen timestamps
- `apps/api/src/modules/webhooks/__tests__/starkbank-ecdsa.d.ts` - minimal ambient typing for the untyped `starkbank-ecdsa` package (test-only)
- `apps/api/src/modules/webhooks/signature-verify.ts` - adds `isWebhookTimestampFresh` + `DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`; `verifyWebhookSignature` unchanged
- `apps/api/src/modules/webhooks/webhooks.routes.ts` - composes both checks into the single existing 400 path; threat-model doc comment updated
- `apps/api/src/env.ts` - `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`, coerced positive int, default 600
- `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts` - workspace-scoped job lookups (race fix) + frozen Date for the fixed 2020 fixture's "valid signature" test
- `apps/api/package.json` - `starkbank-ecdsa` devDependency (test-only, already a transitive dep of `@sendgrid/eventwebhook`)
- `SPECIFICATION.md` - §2.2 devDependency entry, §3.2 new env var, §6.8 webhook endpoint window/identical-response contract (replaces prior "no replay protection" warning)

## Decisions Made

- Freshness predicate bounds the header timestamp in **both** directions (past and future) — a future-dated timestamp is equally a forgery/clock-skew signal (T-10-11-02), not just staleness
- Predicate reads no environment variable itself; the route resolves `env.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` and passes it in, keeping the predicate pure and directly unit-testable
- Only the signature-timestamp HEADER is bounded — each event's own `timestamp` field inside the batch body is a structurally different value (RESEARCH.md Pitfall 6) and is deliberately untouched, reserved for Phase 13's CMP-05

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a latent cross-file race in `webhooks-signature.test.ts`'s "valid signature" test**
- **Found during:** Task 1, first full run of `apps/api/src/modules/webhooks` after adding the new test file
- **Issue:** `webhooks-signature.test.ts`'s "valid signature -> 200 and exactly one job enqueued" test used a global `webhookEventsQueue.getJobCounts("waiting")` before/after delta. Prior to this plan it was the ONLY apps/api test file enqueueing real jobs onto the shared BullMQ `webhook-events` queue, so the delta was always accurate. This plan's new test file also enqueues real jobs against the same queue, and vitest runs test files concurrently by default — the two files' counts raced, intermittently reporting `2` instead of `1`. That file's `afterAll` also called `webhookEventsQueue.obliterate({ force: true })`, which could wipe a sibling file's in-flight jobs mid-assertion.
- **Fix:** Switched both `webhooks-signature.test.ts`'s "valid signature" test and every HTTP-level assertion in the new `webhook-timestamp-window.test.ts` to filter `getJobs(["waiting"])` by `job.data.workspaceId` (each test provisions its own fresh, uniquely-named workspace, giving a natural per-test key). Removed the destructive `.obliterate()` call from `webhooks-signature.test.ts`'s `afterAll`, keeping only `.close()` — CI starts Redis fresh per run (`docker compose up -d --wait`), so the only cost is job accumulation across repeated *local* dev test runs, not correctness.
- **Files modified:** `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts`
- **Verification:** `npx vitest run --root apps/api src/modules/webhooks` — 44/44 passing, repeated runs stable (no flake observed across multiple invocations)
- **Committed in:** `03c4b04` (Task 1 commit)

**2. [Rule 1 - Bug] Froze `Date` for the pre-existing "valid signature" test's fixed 2020 fixture**
- **Found during:** Task 2, after wiring the freshness predicate into the route
- **Issue:** `webhooks-signature.test.ts` reuses SendGrid's own published fixture, whose real timestamp (`1600112502`, 2020-09-14) is now genuinely more than 600 seconds old relative to real wall-clock time. Once the freshness check went live, this previously-passing "valid signature -> 200" test started failing with 400, correctly — the fixture really is stale by 2026.
- **Fix:** Wrapped just that one test with `vi.useFakeTimers({ toFake: ["Date"] })` frozen to the fixture's own timestamp instant, so the pinned signature stays inside the window without touching its signed bytes (re-timestamping would invalidate the real ECDSA signature). `afterEach(() => vi.useRealTimers())` added as a safety net.
- **Files modified:** `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts`
- **Verification:** Full `apps/api` suite (337 tests) green
- **Committed in:** `5330c15` (Task 2 commit)

**3. [Rule 3 - Blocking] Added `starkbank-ecdsa` as an explicit `apps/api` devDependency**
- **Found during:** Task 1, writing the boundary/replay tests
- **Issue:** SendGrid's own published test fixture is a single fixed payload/signature/timestamp — signing is over `timestamp + payload` bytes, so no boundary or replay test that varies the timestamp can use it without a private key to re-sign. `@sendgrid/eventwebhook` only exposes verification, not signing.
- **Fix:** Imported `starkbank-ecdsa` directly (the exact library `@sendgrid/eventwebhook` already uses internally for ECDSA verification, and already an installed transitive dependency, version 1.2.0 per `package-lock.json`) to generate a self-consistent test key pair and sign fixture payloads at test-chosen timestamps. Declared it explicitly in `apps/api/package.json`'s `devDependencies` (required by the repo's `import-x/no-extraneous-dependencies` ESLint rule, which only exempts already-*declared* devDependencies for test files, not transitive-only packages) and added a minimal ambient `.d.ts` (the package ships no types). No `npm install` against the network was needed — already resolved in the lockfile. Documented in `SPECIFICATION.md` §2.2 per CLAUDE.md's dependency-tracking rule.
- **Files modified:** `apps/api/package.json`, `package-lock.json`, `apps/api/src/modules/webhooks/__tests__/starkbank-ecdsa.d.ts`, `SPECIFICATION.md`
- **Verification:** `npm run build --workspaces --if-present` (tsc type-checks test files too, confirmed clean); `npm run lint` clean
- **Committed in:** `03c4b04` (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (2 bug fixes, 1 blocking-issue fix)
**Impact on plan:** All three were necessary for the plan's own required verification (`npx vitest run --root apps/api` exiting 0, deterministically) to actually hold. No scope creep — no other files touched, no architectural changes.

## Issues Encountered

None beyond the deviations above.

## User Setup Required

None — no external service configuration required. `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS` is optional (defaults to 600); no `.env.example` update needed since it's not required for boot.

## Next Phase Readiness

- SEC-07 closed. `apps/worker/src/queues/webhook-events.worker.ts` was confirmed unchanged (acceptance criterion) — Phase 13's CMP-05 (per-event `timestamp` field bounding) remains untouched and open for that phase.
- SEC-08 (webhook's own rate limit) is the next item in this phase's requirement list and was explicitly out of scope here (noted in the updated SPECIFICATION.md §6.8).
- Full `apps/api` suite (337 tests), `npm run lint`, `npm run build --workspaces --if-present`, and `npm run lint:session-state` all green at hand-off.

## Known Stubs

None.

## Threat Flags

None — this plan closes threats already registered in the plan's own `<threat_model>` (T-10-11-01..06); no new unregistered surface was introduced.

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-07*
