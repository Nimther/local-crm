---
phase: 11-delivery-correctness
plan: 05
subsystem: delivery
tags: [bullmq, fetch, abort-signal, sendgrid, transport-classification, rate-limiting, node-http]

# Dependency graph
requires:
  - phase: 11-delivery-correctness (11-01/11-02/11-03/11-04)
    provides: ARCHITECTURE.md §9 state machine, reconciling/unknown enum values, send-reconciler tracer, deterministic UUIDv5 send ids
provides:
  - "classifyTransportError (packages/delivery-core/src/transport-classify.ts) -- fail-closed pre_connection_retryable | ambiguous classifier, exported from @mega-crm/delivery-core"
  - "SENDGRID_TIMEOUT_MS (20s) -- sendTenantMailV3's fetch now carries AbortSignal.timeout(SENDGRID_TIMEOUT_MS)"
  - "apps/worker/src/queues/queue-options.ts -- SEND_LOCK_DURATION_MS/CLAIM_TX_MARGIN_MS/RECORD_TX_MARGIN_MS/SEND_JOB_MAX_ATTEMPTS/SEND_JOB_BACKOFF_DELAY_MS/SEND_MAX_JOB_LIFETIME_MS, the single source Phase 12's WRK-11 is expected to absorb"
  - "Both send Workers declare lockDuration: SEND_LOCK_DURATION_MS explicitly (no longer BullMQ's implicit 30s default)"
  - "SendJobResult's rate_limited variant carries cause: \"tenant_bucket\" | \"provider_backoff\" -- tenant_bucket keeps the non-attempt-consuming worker.rateLimit() path, provider_backoff now consumes one of the job's bounded attempts with BullMQ exponential backoff"
  - "send-timing-invariant.test.ts asserts the SENDGRID_TIMEOUT_MS+margins<SEND_LOCK_DURATION_MS inequality and the SEND_MAX_JOB_LIFETIME_MS margin against the real exported constants"
affects: [11-06 (send-dispatch.ts consumes classifyTransportError to decide reconciling vs retry), 11-07/11-08 (stale-dispatching sweep threshold must exceed SEND_MAX_JOB_LIFETIME_MS with margin), phase-12 WRK-01 (extends the cause discriminator), phase-12 WRK-11 (collapses the three DEFAULT_JOB_OPTIONS copies into queue-options.ts)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AbortSignal.timeout(ms) as the fetch cancellation primitive (no manual setTimeout/AbortController bookkeeping)"
    - "Pure fail-closed classifier module (transport-classify.ts) mirroring parseRetryAfter's shape: explicit branches with a structurally-last safe default"
    - "Single timing-constants file (queue-options.ts) as the pre-consolidation destination for Phase 12's WRK-11"
    - "cause discriminator on a discriminated-union outcome, shaped so a later phase extends rather than reshapes it"

key-files:
  created:
    - packages/delivery-core/src/transport-classify.ts
    - packages/delivery-core/src/__tests__/transport-classify.test.ts
    - apps/worker/src/queues/queue-options.ts
    - apps/worker/src/queues/__tests__/send-timing-invariant.test.ts
  modified:
    - packages/delivery-core/src/send-mail.ts
    - packages/delivery-core/src/index.ts
    - packages/delivery-core/src/__tests__/send-mail.test.ts
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/email-broadcast.worker.ts
    - apps/worker/src/queues/email-triggered.worker.ts
    - apps/worker/src/queues/__tests__/backoff.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts
    - SPECIFICATION.md

key-decisions:
  - "classifyTransportError unwraps exactly one level of `cause` (undici's `TypeError: fetch failed` wrapper) so a genuine ECONNREFUSED is not misclassified as ambiguous -- no deeper unwrapping, since the runtime never produces a deeper chain here."
  - "The real-abort test fixture (both in transport-classify.test.ts and send-mail.test.ts) uses a local, never-responding node:http server plus AbortSignal.timeout(1), not a constructed DOMException -- the environment supported binding an ephemeral loopback listener reliably, so the plan's fallback ('construct the DOMException yourself') was not needed."
  - "SEND_MAX_JOB_LIFETIME_MS adds one full SEND_LOCK_DURATION_MS of margin on top of the computed attempts*lock+backoff-series floor, so it is strictly greater than that floor (not equal to it) -- satisfies the plan's own behavior requirement and gives 11-07/11-08's stale-dispatching sweep threshold room to add its own margin on top."
  - "cause is added to ALL SIX rate_limited return sites in send-dispatch.ts (campaign/flow/test paths x tenant_bucket/provider_backoff), not just the four the plan's action text named for the campaign/flow paths -- the field is non-optional on the type, so the test-send path's two rate_limited sites needed it too for the type to compile; kept them semantically consistent (tenant_bucket for the token-bucket denial, provider_backoff for the SendGrid 429/5xx) rather than picking an arbitrary placeholder."
  - "SPECIFICATION.md's Task 2 update (SendGrid timeout) was deferred into the Task 3 commit rather than split mid-paragraph, since the accurate description of the timeout invariant needs SEND_LOCK_DURATION_MS/queue-options.ts, which Task 3 introduces -- documented here rather than silently reordered."

patterns-established:
  - "Timing/retry constants for a BullMQ queue lane live in one queue-options.ts file per lane family, computed (not hand-typed) where one constant is derived from others, so a future consolidation absorbs a whole file instead of hunting three call sites."
  - "A transport/error classifier is a pure function with the safe branch structurally last and the narrow allowlist first, matching this codebase's existing parseRetryAfter shape."

requirements-completed: [DLV-06]

coverage:
  - id: D1
    description: "sendTenantMailV3's fetch call is bounded by AbortSignal.timeout(SENDGRID_TIMEOUT_MS); a bounded-out call rejects rather than hanging, and the API key stays redacted on that path"
    requirement: "DLV-06"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-mail.test.ts#sendTenantMailV3 timeout/abort (D-15, DLV-06)"
        status: pass
    human_judgment: false
  - id: D2
    description: "classifyTransportError classifies every distinct transport-error shape (ENOTFOUND/EAI_AGAIN/ECONNREFUSED -> pre_connection_retryable; ECONNRESET/AbortError/TimeoutError/real-abort-DOMException/unrecognized/non-object -> ambiguous), including one level of cause-unwrapping, with ambiguous as the fail-closed default"
    requirement: "DLV-06"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/transport-classify.test.ts#classifyTransportError (D-10 fail-closed transport classification)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Both send Workers declare an explicit lockDuration, and SENDGRID_TIMEOUT_MS+margins<SEND_LOCK_DURATION_MS holds for the real exported constants"
    requirement: "DLV-06"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-timing-invariant.test.ts#send lane timing/retry invariants (D-15, D-10)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A per-tenant token-bucket denial produces cause: tenant_bucket (non-attempt-consuming); a SendGrid 429/5xx produces cause: provider_backoff (now attempt-consuming, bounded)"
    requirement: "DLV-06"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-timing-invariant.test.ts#cause routing (D-10): tenant_bucket vs provider_backoff"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/backoff.test.ts#send-dispatch.ts 429/5xx backoff (SEND-07)"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts#failure injection: SendGrid 429 rate limit (QG-06)"
        status: pass
    human_judgment: false

# Metrics
duration: ~50min
completed: 2026-08-09
status: complete
---

# Phase 11 Plan 05: SendGrid timeout + transport classifier + bounded retry Summary

**AbortSignal.timeout(20s) bounds every SendGrid call, a fail-closed classifier maps transport errors to pre_connection_retryable/ambiguous, and a `cause` discriminator lets provider 429/5xx consume bounded BullMQ attempts while tenant throttling still doesn't.**

## Performance

- **Duration:** ~50 min
- **Completed:** 2026-08-09T11:26:45Z
- **Tasks:** 3
- **Files modified:** 12 (4 created, 9 modified, 1 lint follow-up)

## Accomplishments

- `packages/delivery-core/src/transport-classify.ts` exports `classifyTransportError`/`TransportClassification`: a pure, non-throwing classifier that maps DNS-failure/connection-refused errors (including undici's `cause`-wrapped `TypeError: fetch failed`) to `pre_connection_retryable`, and everything else -- resets, aborts, timeouts, unrecognized shapes, non-object input -- to the fail-closed `ambiguous` default (D-10).
- `sendTenantMailV3` (`packages/delivery-core/src/send-mail.ts`) now passes `signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS)` (20s, versioned constant) to its `fetch` call, inside the SAME existing `try`/`catch` -- no second error route around `redactApiKey`. A bare, unbounded fetch that could pin a worker concurrency slot indefinitely is gone.
- `apps/worker/src/queues/queue-options.ts` is the new single source for the send lane's timing/retry numbers: `SEND_LOCK_DURATION_MS` (60s, explicit), `CLAIM_TX_MARGIN_MS`/`RECORD_TX_MARGIN_MS` (5s each), `SEND_JOB_MAX_ATTEMPTS`/`SEND_JOB_BACKOFF_DELAY_MS` (mirroring the three existing producer `DEFAULT_JOB_OPTIONS` literals), and a computed `SEND_MAX_JOB_LIFETIME_MS` floor for a future stale-`dispatching` sweep threshold.
- Both `email-broadcast.worker.ts` and `email-triggered.worker.ts` now declare `lockDuration: SEND_LOCK_DURATION_MS` explicitly instead of riding BullMQ's implicit 30s default.
- `SendJobResult`'s `rate_limited` variant gained `cause: "tenant_bucket" | "provider_backoff"`. Both Workers branch on it: `tenant_bucket` keeps the existing `worker.rateLimit()` + `Worker.RateLimitError()` path (no attempt consumed); `provider_backoff` now throws a plain `Error`, consuming one of the job's bounded `attempts` with BullMQ's exponential backoff between redeliveries -- the previous unbounded `Retry-After`-driven loop for a persistently-failing provider is gone.
- `send-timing-invariant.test.ts` machine-asserts `SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS < SEND_LOCK_DURATION_MS`, the `SEND_MAX_JOB_LIFETIME_MS` margin, both Workers' constructed `lockDuration`, and the `cause`-routing behavior -- all against the real imported constants/values, never a restated literal.

## Task Commits

1. **Task 1: Transport-error classifier with a fail-closed default** - `036cd0b` (feat)
2. **Task 2: Explicit SendGrid timeout with abort** - `b933d6d` (feat)
3. **Task 3: Explicit lockDuration, bounded provider retry, and the machine-asserted timing invariant** - `b21bbd0` (feat, includes a lint follow-up to Task 2's test file and the deferred SPECIFICATION.md §5.5 update)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `packages/delivery-core/src/transport-classify.ts` - `classifyTransportError`/`TransportClassification`, fail-closed pre-connection vs ambiguous classifier
- `packages/delivery-core/src/__tests__/transport-classify.test.ts` - covers every `<behavior>` item, including a real `AbortSignal.timeout(1)` fixture against a local never-responding server and the `cause`-unwrapping case
- `packages/delivery-core/src/send-mail.ts` - `SENDGRID_TIMEOUT_MS` (20s) + `AbortSignal.timeout()` on the existing fetch call
- `packages/delivery-core/src/index.ts` - exports `classifyTransportError`/`TransportClassification`/`SENDGRID_TIMEOUT_MS`
- `packages/delivery-core/src/__tests__/send-mail.test.ts` - timeout/abort/happy-path tests for `sendTenantMailV3`
- `apps/worker/src/queues/queue-options.ts` - `SEND_LOCK_DURATION_MS`/`CLAIM_TX_MARGIN_MS`/`RECORD_TX_MARGIN_MS`/`SEND_JOB_MAX_ATTEMPTS`/`SEND_JOB_BACKOFF_DELAY_MS`/`SEND_MAX_JOB_LIFETIME_MS`
- `apps/worker/src/queues/email-broadcast.worker.ts` - `lockDuration`, `cause`-branching in the `rate_limited` handler
- `apps/worker/src/queues/email-triggered.worker.ts` - same as above, triggered lane
- `apps/worker/src/queues/send-dispatch.ts` - `SendJobResult.rate_limited.cause`, set at all six return sites
- `apps/worker/src/queues/__tests__/send-timing-invariant.test.ts` - the machine-asserted timing/retry invariants
- `apps/worker/src/queues/__tests__/backoff.test.ts` - `toEqual` assertions updated for the new `cause` field
- `apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts` - same
- `SPECIFICATION.md` - §5.5 updated: SendGrid call timeout, explicit `lockDuration`, `cause` discriminator and bounded-retry change, plus a pre-existing drift fix (the `interrupted` branch's documented target status, which code already changed in 11-03 but §5.5's prose had not been updated to match)

## Decisions Made

- `classifyTransportError` unwraps exactly one level of `cause` (undici's `fetch failed` wrapper) and no deeper -- matches the actual runtime shape, avoids speculative generality.
- Real never-responding `node:http` server + real `AbortSignal.timeout(1)` used for the abort fixtures in both `transport-classify.test.ts` and `send-mail.test.ts`, rather than a constructed `DOMException` -- the plan's fallback for an unreliable sandbox was not needed here.
- `SEND_MAX_JOB_LIFETIME_MS` is computed with one full extra `SEND_LOCK_DURATION_MS` of margin over the raw `attempts*lock + backoff-series` floor, satisfying the plan's "strictly greater than" requirement and leaving room for 11-07/11-08's own additional margin.
- `cause` was set at all six `rate_limited` return sites in `send-dispatch.ts` (not just the four the plan's action text named for campaign/flow), since the field is non-optional on the type and the `kind='test'` path's two `rate_limited` sites needed a value to compile -- kept semantically consistent with the other four (tenant_bucket / provider_backoff).
- SPECIFICATION.md's Task 2 (timeout) documentation was folded into the Task 3 commit rather than split mid-paragraph, since an accurate description of the timing invariant needs `SEND_LOCK_DURATION_MS`/`queue-options.ts`, which Task 3 introduces.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed two unnecessary `as typeof fetch` type assertions**
- **Found during:** Task 3 (running `npm run lint` across the whole repo before the final commit)
- **Issue:** Two test-double assignments to `globalThis.fetch` in `send-mail.test.ts` (added in Task 2) carried an unnecessary `as typeof fetch` cast, flagged by `@typescript-eslint/no-unnecessary-type-assertion`.
- **Fix:** Removed both casts; TypeScript already accepted the async arrow functions as assignable to `typeof fetch` without the assertion.
- **Files modified:** `packages/delivery-core/src/__tests__/send-mail.test.ts`
- **Verification:** `npx eslint packages/delivery-core/src/__tests__/send-mail.test.ts --max-warnings=0` exits clean; `npx vitest run --root packages/delivery-core src/__tests__` still 117/117 passing.
- **Committed in:** `b21bbd0` (Task 3 commit)

**2. [Rule 1 - Bug] SPECIFICATION.md §5.5's `interrupted` branch description was stale**
- **Found during:** Task 3 (updating §5.5 for the timeout/lockDuration/cause changes)
- **Issue:** §5.5 still described the `interrupted` branch as writing `failed`, even though 11-03's code change (and §5.10's own text) already moved it to `reconciling`. Pre-existing documentation drift from an earlier plan, unrelated to this plan's own changes but directly adjacent to the paragraph this plan needed to edit anyway.
- **Fix:** Corrected the sentence to match the current code and cross-reference §5.10, in the same edit that added the timeout/lockDuration/cause material.
- **Files modified:** `SPECIFICATION.md`
- **Verification:** Read against the current `claimCampaignSend` code in `send-dispatch.ts` and §5.10's existing (correct) description.
- **Committed in:** `b21bbd0` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1 — a lint cleanup and a documentation-accuracy fix)
**Impact on plan:** Both are minor, no scope creep, no behavior change beyond what the plan already specified.

## Issues Encountered

None beyond the deviations above.

## Known Stubs

None.

## Threat Flags

None — every new surface (the classifier, the timeout, the lockDuration, the cause discriminator) is already covered by this plan's own `<threat_model>` (T-11-05-01 through T-11-05-06).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `classifyTransportError` is built and unit-tested but NOT yet wired into `send-dispatch.ts` -- that consumption (deciding `reconciling` vs a pre-connection retry) is explicitly 11-06's job, per this plan's own `key_links`.
- `SEND_MAX_JOB_LIFETIME_MS` is exported from `apps/worker/src/queues/queue-options.ts` and ready for 11-07/11-08's stale-`dispatching` sweep threshold to import and exceed with its own margin -- do not duplicate the computation.
- Phase 12's WRK-11 has a clean single destination (`queue-options.ts`) to collapse the three existing `DEFAULT_JOB_OPTIONS` literal copies into; Phase 12's WRK-01 has a `cause` field shaped for extension, not reshaping.
- `timeout.test.ts` and `connection-reset.test.ts` (the pre-existing failure-injection suite) still pass unchanged -- they assert today's `send-dispatch.ts` behavior (rejection -> `reconciling` via the interrupted branch), which 11-06 will extend with real classification, not replace.

## Self-Check: PASSED

- FOUND: `packages/delivery-core/src/transport-classify.ts`
- FOUND: `packages/delivery-core/src/__tests__/transport-classify.test.ts`
- FOUND: `apps/worker/src/queues/queue-options.ts`
- FOUND: `apps/worker/src/queues/__tests__/send-timing-invariant.test.ts`
- FOUND: `.planning/phases/11-delivery-correctness/11-05-SUMMARY.md`
- FOUND commit: `036cd0b` (Task 1)
- FOUND commit: `b933d6d` (Task 2)
- FOUND commit: `b21bbd0` (Task 3)

---
*Phase: 11-delivery-correctness*
*Completed: 2026-08-09*
