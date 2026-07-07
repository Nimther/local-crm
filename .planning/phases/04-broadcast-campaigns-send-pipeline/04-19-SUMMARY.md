---
phase: 04-broadcast-campaigns-send-pipeline
plan: 19
subsystem: delivery
tags: [sendgrid, unsubscribe, uuid, worker, postgres, security]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-03 unsubscribe-token signing/verification + public unsubscribe route; 04-04 send-dispatch worker processSendJob; 04-11 unsubscribe route hardening (CR-01 well-formed-token guard, byte-identical response invariant)"
provides:
  - "Worker root-cause fix: kind='test' dispatch signs a real randomUUID() contactId when the job carries none, instead of the non-UUID placeholder literal"
  - "API defense-in-depth: POST /unsubscribe/:token gates the contacts UPDATE on isUuid(payload.contactId), so a structurally-invalid contactId can never reach the uuid-typed column and 500"
  - "Worker regression pinning the signed test-send token decodes to a UUID-shaped contactId"
  - "API regression pinning byte-identical uniform response + no-mutation for a test-send-shaped token, on both POST and GET"
affects: [phase-05-webhook-tracking, phase-06-flows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Redemption-side format guards (isUuid) as defense-in-depth on top of a signing-side root-cause fix -- both layers independently prevent the same class of bug from reaching a typed DB column"
    - "Byte-identical-response invariant preserved by having the guard skip the mutation and fall through to the SAME response block, never adding a new branch on the reply"

key-files:
  created:
    - apps/api/src/modules/delivery/__tests__/unsubscribe-test-send.test.ts
  modified:
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts
    - apps/api/src/modules/delivery/unsubscribe.routes.ts

key-decisions:
  - "Worker fallback contactId changed from the literal \"test-send\" to crypto.randomUUID() -- an unknown-but-valid UUID always resolves to 0 rows updated (safe no-op), whereas a non-UUID literal raised an uncaught Postgres 22P02 (CR-01 root cause)."
  - "API isUuid() guard is gated alongside the existing isValid check in the SAME if-block, with no new response branch -- preserves the POST handler's byte-identical-response invariant (T-04-03-02) rather than adding a distinguishable code path for the non-UUID case."
  - "Pre-existing SEND-05 worker test failure (unrelated PUBLIC_APP_URL env-vs-test-default coupling in vitest.config.ts) reproduced identically before this plan's changes (verified via git stash) -- logged to deferred-items.md per the executor scope-boundary rule, not fixed inline."

patterns-established:
  - "When a signing side and a redemption side share a token payload field whose value crosses a DB type boundary, apply both a root-cause fix at the signer AND a structural guard at the redeemer -- defense-in-depth for a value that traverses a trust boundary via HMAC, not just validation."

requirements-completed: [CAMP-04, SUBS-04]

coverage:
  - id: D1
    description: "Test-send unsubscribe tokens are signed with a valid random UUID contactId (worker root cause)"
    requirement: "CAMP-04"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts#CR-01: a test send with no contactId signs its List-Unsubscribe token with a valid random UUID, not a placeholder literal"
        status: pass
    human_judgment: false
  - id: D2
    description: "Redeeming a test-send-shaped (non-UUID contactId) unsubscribe token returns the uniform 2xx response, byte-identical to the unknown-contact response, with no mutation and no 500"
    requirement: "SUBS-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-test-send.test.ts#POST with a test-send-shaped (non-UUID contactId) token returns 200 with an empty body, byte-identical to an unknown-but-valid-UUID contact token"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-test-send.test.ts#POST with a test-send-shaped token does not mutate a real subscribed contact in the same workspace"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-test-send.test.ts#GET with a test-send-shaped token still returns 200 HTML (no crash)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Live SendGrid UAT re-run (Tests 4/5/6/7/12/13) confirming a real test-send inbox delivery with a working one-click unsubscribe link, after populating UNSUBSCRIBE_TOKEN_SECRET/PUBLIC_APP_URL in .env"
    verification: []
    human_judgment: true
    rationale: "Requires live SendGrid send + manual .env population (harness-denied path) + human browser/inbox verification -- explicitly carried as human_verification from 04-VERIFICATION.md, not executable by this plan per its own scope guardrail."

# Metrics
duration: ~15min
completed: 2026-07-07
status: complete
---

# Phase 04 Plan 19: CR-01 Test-Send Unsubscribe Token Gap Closure Summary

**Worker now signs a real random UUID for test-send unsubscribe tokens (not a non-UUID placeholder literal), and the public unsubscribe route independently guards its contacts UPDATE against any non-UUID contactId, closing the only Critical gap from 04-VERIFICATION.md.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-07T03:40:50Z
- **Tasks:** 2
- **Files modified:** 4 (1 new)

## Accomplishments
- Root-cause fix: `apps/worker/src/queues/send-dispatch.ts`'s `kind='test'` branch now falls back to `randomUUID()` instead of the literal `"test-send"` string when a test-send job carries no `contactId`, so the signed List-Unsubscribe token's `contactId` is always a real UUID.
- Defense-in-depth: `apps/api/src/modules/delivery/unsubscribe.routes.ts`'s POST handler now gates the `UPDATE contacts ...` mutation on a new `isUuid(payload.contactId)` check alongside the existing signature/expiry validity check -- a structurally-invalid contactId falls through to the exact same response-construction block, preserving the byte-identical-response invariant (T-04-03-02) instead of letting a non-UUID literal reach the uuid-typed column and raise an uncaught Postgres 22P02 (a 500).
- Regression coverage added on both ends: a worker test decodes the emitted test-send token and asserts UUID shape; three new API tests pin byte-identical uniform response, no-mutation, and GET no-crash behavior for a test-send-shaped token.
- Logged one pre-existing, unrelated worker test failure (SEND-05 / `PUBLIC_APP_URL` env-vs-test-default coupling) to `deferred-items.md`, confirmed via `git stash` to predate this plan's changes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Sign a real UUID for test-send unsubscribe tokens (worker root cause) + worker regression** - `9443638` (feat)
2. **Task 2: Guard the public unsubscribe POST against a non-UUID contactId (defense-in-depth) + API regression** - `e5196c7` (fix)

**Plan metadata:** (final docs commit follows this SUMMARY)

## Files Created/Modified
- `apps/worker/src/queues/send-dispatch.ts` - `kind='test'` branch signs `randomUUID()` fallback contactId instead of the non-UUID placeholder literal
- `apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts` - new regression decoding the test-send token and asserting UUID-shaped contactId
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` - new `isUuid()` helper; POST mutation gate extended to `isValid && isUuid(payload.contactId)`; threat-model comment updated
- `apps/api/src/modules/delivery/__tests__/unsubscribe-test-send.test.ts` - new file: 3 regressions covering byte-identical response, no-mutation, and GET no-crash for test-send-shaped tokens

## Decisions Made
- Worker fallback contactId changed to `crypto.randomUUID()` (already imported) rather than any other sentinel value -- guarantees the redeemed link always resolves to either a real contact or an unknown-but-valid UUID (0 rows updated, still 2xx).
- API `isUuid()` guard placed inside the SAME `if` condition as the existing `isValid` check (not a separate early-return branch) so the non-UUID case takes the identical code path to the unknown-contact case, preserving byte-identical responses.
- The pre-existing SEND-05 worker test failure (unrelated `PUBLIC_APP_URL` test/env coupling) was left unfixed, per the executor's scope-boundary rule, and logged to `deferred-items.md` with a suggested fix for a future plan.

## Deviations from Plan

None — plan executed exactly as written. Both tasks matched their `<action>` and `<acceptance_criteria>` blocks precisely; no architectural changes, no new dependencies, no auth gates.

## Issues Encountered

- **Pre-existing, out-of-scope worker test failure:** `send-dispatch-idempotency.test.ts`'s "SEND-05/SUBS-03" test asserts the List-Unsubscribe URL starts with `https://api.test.local` (the `vitest.config.ts` fallback default), but the repo's `.env` now has a real `PUBLIC_APP_URL=http://localhost:4000` populated (an operational prerequisite tracked in STATE.md, presumably progressed toward the phase's deferred human-verification UAT). Since `vitest.config.ts` uses `process.env.PUBLIC_APP_URL ?? "https://api.test.local"` (a fallback, not an override), the real `.env` value wins and the test's hardcoded expectation no longer matches. Reproduced identically via `git stash` on the pre-04-19 tree, confirming it is unrelated to this plan's changes. Logged to `.planning/phases/04-broadcast-campaigns-send-pipeline/deferred-items.md` with a suggested fix (force-override the test-only `PUBLIC_APP_URL` value, mirroring the existing `TEST_DATABASE_URL`/`TEST_REDIS_URL` convention in the same file) for a future plan. This plan's own new/modified tests are unaffected -- the new worker regression asserts only the unsubscribe URL/token *shape*, not the base URL.

## User Setup Required

None — no external service configuration required by this plan's executable scope. The phase's carried-forward human verification (populate `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` in `.env`/`.env.example`, then re-run live SendGrid UAT Tests 4/5/6/7/12/13) remains outstanding per 04-VERIFICATION.md and is NOT part of this plan's scope (see `<verification>` in 04-19-PLAN.md).

## Next Phase Readiness

- CR-01 (the sole plannable/Critical gap from 04-VERIFICATION.md) is closed on both the worker signing side and the API redemption side, with regression coverage on both ends.
- Full workspace automated suite: 268/269 passing (1 pre-existing, unrelated, out-of-scope worker test failure logged in `deferred-items.md`; not caused by this plan).
- Remaining outstanding item before Phase 04 can be considered fully verified end-to-end: the human verification step (populate `.env` secrets, live SendGrid UAT re-run) carried from 04-VERIFICATION.md -- unchanged by this plan, still pending a human with `.env` access.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-07*
