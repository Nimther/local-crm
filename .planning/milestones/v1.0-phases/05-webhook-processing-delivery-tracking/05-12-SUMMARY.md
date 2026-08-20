---
phase: 05-webhook-processing-delivery-tracking
plan: 12
subsystem: api
tags: [sendgrid, webhooks, zod, env-validation, vitest]

requires:
  - phase: 05-webhook-processing-delivery-tracking
    provides: provisionEventWebhook chokepoint (05-07/05-08/05-09/05-11), webhookWarningFor shared copy module (05-09), PROVISION_ERROR_REASONS health mapper (05-09)
provides:
  - "insecure_url" typed ProvisionEventWebhookError, short-circuiting provisionEventWebhook before any SendGrid fetch when callbackUrl is not https
  - WEBHOOK_INSECURE_URL_WARNING actionable Russian copy naming PUBLIC_APP_URL/https/docs/webhook-live-uat.md
  - webhook-health card recognition of a persisted insecure_url reason
  - predev check-env.mjs http:// warning (any scheme, not just localhost)
  - production-boot env.ts hard-fail on a non-https PUBLIC_APP_URL (dev/test still allow http)
affects: [webhook-live-uat, sendgrid-key connect/recheck, webhook-settings reconnect]

tech-stack:
  added: []
  patterns:
    - "Pre-flight scheme guard as the single chokepoint before any outbound fetch (mirrors the 05-09 missing_scope pattern)"
    - "Test-env config must not silently inherit developer-machine .env values for vars whose literal value is behavior-determining (TEST_-prefixed override convention)"

key-files:
  created:
    - apps/api/src/modules/webhooks/__tests__/webhook-warning-copy.test.ts
    - apps/api/src/__tests__/env-schema.test.ts
  modified:
    - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
    - apps/api/src/modules/webhooks/webhook-warning-copy.ts
    - apps/api/src/modules/webhooks/webhook-settings.routes.ts
    - apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts
    - apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts
    - apps/api/src/env.ts
    - scripts/check-env.mjs
    - apps/api/vitest.config.ts

key-decisions:
  - "05-12: provisionEventWebhook's https pre-flight guard placed as the FIRST statement (before the try block) so a scheme test that cannot throw never reaches the SendGrid call on connect, recheck, OR reconnect (one chokepoint, no per-call-site duplication)"
  - "05-12: webhookWarningFor's parameter type changed from an inline literal union to the exported ProvisionEventWebhookError type, so the copy map and the provisioning error union can never drift apart again"
  - "05-12: vitest.config.ts's PUBLIC_APP_URL test default no longer inherits the real dev .env value -- the new https guard makes this var's scheme behavior-determining, so the test suite's pass/fail outcome must not depend on the developer machine's .env; added TEST_PUBLIC_APP_URL override mirroring the existing TEST_DATABASE_URL/TEST_REDIS_URL convention (Rule 1 auto-fix, surfaced by Task 1's own change)"

patterns-established:
  - "Any env var whose literal value changes application branching logic (not just satisfies a schema or gets sent to an already-nocked HTTP endpoint) must have a TEST_-prefixed override in vitest.config.ts, never a bare process.env.X fallback that can silently inherit the real .env"

requirements-completed: [WBHK-01, WBHK-04]

coverage:
  - id: D1
    description: "provisionEventWebhook short-circuits to { error: insecure_url } before any fetch when callbackUrl is not https, on both the create path (no existingWebhookId) and the PATCH/reconnect path (with existingWebhookId)"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#a non-https callbackUrl short-circuits to { error: 'insecure_url' } with no fetch call (05-12)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts#a non-https callbackUrl with an existingWebhookId ALSO short-circuits to { error: 'insecure_url' } with no fetch call -- proves the reconnect/PATCH path is guarded too (05-12)"
        status: pass
    human_judgment: false
  - id: D2
    description: "webhookWarningFor('insecure_url') returns an actionable Russian warning naming PUBLIC_APP_URL, https, and docs/webhook-live-uat.md; the three pre-existing reasons still map correctly (regression)"
    requirement: "WBHK-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-warning-copy.test.ts#maps 'insecure_url' to WEBHOOK_INSECURE_URL_WARNING"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-warning-copy.test.ts#WEBHOOK_INSECURE_URL_WARNING names PUBLIC_APP_URL, https, and the runbook"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-warning-copy.test.ts#regression: the three pre-existing reasons still map to their constants"
        status: pass
    human_judgment: false
  - id: D3
    description: "GET webhook-health recognizes a persisted insecure_url reason and surfaces the actionable copy instead of dropping it (non-null provisionError), still omitting pathToken/publicKey"
    requirement: "WBHK-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts#GET webhook-health recognizes a stored insecure_url reason and surfaces the actionable copy (05-12)"
        status: pass
    human_judgment: false
  - id: D4
    description: "check-env.mjs warns non-fatally on any http:// PUBLIC_APP_URL (not only localhost) with https-requirement wording, still exiting 0"
    requirement: "WBHK-04"
    verification:
      - kind: integration
        ref: "check-env fixture run: node scripts/check-env.mjs with PUBLIC_APP_URL=http://example.com -- warns 'https' and 'Env check passed', exit 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "env.ts exports envSchema and rejects a non-https PUBLIC_APP_URL under NODE_ENV=production, while development/test still accept http"
    requirement: "WBHK-01"
    verification:
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#production + http PUBLIC_APP_URL fails, with an issue on path PUBLIC_APP_URL"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#production + https PUBLIC_APP_URL passes"
        status: pass
      - kind: unit
        ref: "apps/api/src/__tests__/env-schema.test.ts#development + http PUBLIC_APP_URL still passes (local tunnels/localhost allowed)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Live webhook UAT re-run with an https PUBLIC_APP_URL confirms Test 1/3 pass end-to-end (operator step, not codeable)"
    verification: []
    human_judgment: true
    rationale: "Requires a real https tunnel URL and a server restart (PUBLIC_APP_URL is read once at boot) plus a live SendGrid account -- cannot be proven by unit/integration tests in this environment. Tracked for the next phase-level UAT re-run per the plan's <verification> Operator step."

duration: 8min
completed: 2026-07-09
status: complete
---

# Phase 5 Plan 12: SendGrid webhook https enforcement Summary

**Pre-flight https guard on `provisionEventWebhook` turns a silent SendGrid `400 "webhook url must use https"` rejection into a typed `insecure_url` reason with actionable Russian copy, plus predev + production-boot env guards on `PUBLIC_APP_URL`.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-07-09T14:32:22Z
- **Completed:** 2026-07-09T14:39:58Z
- **Tasks:** 3
- **Files modified:** 8 (+ 1 deviation file: `apps/api/vitest.config.ts`)

## Accomplishments
- `provisionEventWebhook` short-circuits to `{ error: "insecure_url" }` before any SendGrid `fetch` when `callbackUrl` is not `https://` — one chokepoint covers connect, recheck, AND reconnect (create path and PATCH path alike)
- New `WEBHOOK_INSECURE_URL_WARNING` Russian copy names `PUBLIC_APP_URL`, `https`, and `docs/webhook-live-uat.md`, replacing the generic non-actionable "try reconnecting later" message for this specific failure mode
- The webhook-health card now recognizes a persisted `insecure_url` reason (widened `PROVISION_ERROR_REASONS` set) instead of silently returning `provisionError: null` for an unrecognized stored value
- `scripts/check-env.mjs` warns on ANY `http://` `PUBLIC_APP_URL` (not just localhost), non-fatally, with the SendGrid-specific 400 wording
- `apps/api/src/env.ts` exports `envSchema` and hard-fails a `NODE_ENV=production` boot with a non-https `PUBLIC_APP_URL`, while development/test still allow http (local tunnels)

## Task Commits

Each task was committed atomically (Task 1 followed the RED/GREEN TDD flow per its `tdd="true"` attribute):

1. **Task 1 (RED): failing tests for insecure_url guard + copy** — `0e4f67b` (test)
2. **Task 1 (GREEN): pre-flight https guard + typed insecure_url reason + copy** — `0a1ef82` (feat)
3. **Task 2: health mapper recognizes the insecure_url provision reason** — `9d9da8a` (feat)
4. **Task 3: env guards — predev http warning + production https requirement** — `6cbc268` (feat)

**Plan metadata:** (this commit, made after this SUMMARY) — docs: complete plan

## Files Created/Modified
- `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` — `ProvisionEventWebhookError` widened with `"insecure_url"`; pre-flight `callbackUrl.startsWith("https://")` guard added as the first statement in `provisionEventWebhook`
- `apps/api/src/modules/webhooks/webhook-warning-copy.ts` — `webhookWarningFor` now typed against the exported `ProvisionEventWebhookError` (no more inline literal union); new `WEBHOOK_INSECURE_URL_WARNING` constant + branch
- `apps/api/src/modules/webhooks/webhook-settings.routes.ts` — `PROVISION_ERROR_REASONS` set widened with `"insecure_url"`
- `apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts` — two new tests: http callbackUrl with/without `existingWebhookId`, both asserting `{ error: "insecure_url" }` and zero fetch calls
- `apps/api/src/modules/webhooks/__tests__/webhook-warning-copy.test.ts` — new file: `webhookWarningFor` mapping + copy-content assertions + regression coverage for the three pre-existing reasons
- `apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts` — new test seeding an error-state endpoint row with `provisionError: "insecure_url"` and asserting the health route surfaces the actionable copy
- `apps/api/src/env.ts` — `envSchema` exported; `superRefine` gained a `NODE_ENV === "production" && PUBLIC_APP_URL.startsWith("http://")` issue
- `apps/api/src/__tests__/env-schema.test.ts` — new file (new `__tests__` directory under `apps/api/src/`): production+http fails / production+https passes / development+http passes
- `scripts/check-env.mjs` — new non-fatal `http://` scheme warning (broader than the existing localhost-only reachability warning, which stays)
- `apps/api/vitest.config.ts` — (deviation, see below) `PUBLIC_APP_URL` test default no longer inherits the real dev `.env` value

## Decisions Made
- Pre-flight guard placed before the `try` block in `provisionEventWebhook` since a scheme string test cannot throw, and to guarantee the guard fires even before any listing/create/patch call is attempted.
- `webhookWarningFor`'s signature widened to the exported type rather than adding a fourth inline literal, closing off future drift between the provisioning module's error union and the copy map.
- `apps/api/vitest.config.ts`'s `PUBLIC_APP_URL` default changed to only accept an explicit `TEST_PUBLIC_APP_URL` override (mirroring `TEST_DATABASE_URL`/`TEST_REDIS_URL`) rather than falling back to whatever the real `.env` happens to contain — see Deviations below.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `apps/api/vitest.config.ts`'s `PUBLIC_APP_URL` test default silently inherited the real dev `.env` value**
- **Found during:** Task 1 verification (`npm run test -w apps/api -- webhook-provisioning webhook-warning-copy`)
- **Issue:** `vitest.config.ts` loads the repo-root `.env` via `process.loadEnvFile` and then builds its `test.env.PUBLIC_APP_URL` fallback as `process.env.PUBLIC_APP_URL ?? "https://api.test.local"`. Because `loadEnvFile` already populated `process.env.PUBLIC_APP_URL` from the real `.env` (which in this environment is `http://...` — the exact misconfiguration this plan exists to catch), the `??` fallback never fired, so every test run silently inherited a real, developer-machine-dependent, non-https value. Before this plan's guard existed, the scheme of `PUBLIC_APP_URL` was inert in tests (nock/fetchMock only match on the SendGrid-domain leg of the call); after Task 1's new https pre-flight check, the scheme became behavior-determining, and three pre-existing tests in `sendgrid-key-webhook-provisioning.test.ts` (substring-matched by the same `-- webhook-provisioning` test filter) started failing non-deterministically depending on the machine's `.env` contents.
- **Fix:** Changed `PUBLIC_APP_URL: process.env.PUBLIC_APP_URL ?? "https://api.test.local"` to `PUBLIC_APP_URL: process.env.TEST_PUBLIC_APP_URL ?? "https://api.test.local"`, mirroring the existing `TEST_DATABASE_URL`/`TEST_REDIS_URL` override convention already used for the other machine-dependent, behavior-determining vars in the same file.
- **Files modified:** `apps/api/vitest.config.ts`
- **Verification:** Full `apps/api` test suite re-run after the fix: 201/201 tests pass across 36 files (no other test depended on the removed fallback).
- **Committed in:** `0a1ef82` (part of Task 1's GREEN commit, since the fix was required for Task 1's own verification command to pass deterministically)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug: non-deterministic test environment)
**Impact on plan:** Necessary for Task 1's verification step to pass reliably on any machine (including this one, where `.env`'s `PUBLIC_APP_URL` happens to be exactly the http value this plan is about). No scope creep — the fix is scoped to test-environment determinism, not to the plan's actual feature surface.

## Issues Encountered
None beyond the deviation above.

## User Setup Required

None — no external service configuration required. However, per the plan's `<verification>` **Operator step** (not codeable, tracked for phase UAT re-run): the live webhook UAT (`docs/webhook-live-uat.md`, Tests 1-3) must be re-run with `PUBLIC_APP_URL` set to a real https tunnel URL and the dev server RESTARTED (the value is read once at boot). Test 2 must additionally use a key that genuinely lacks the Event Webhook management scope, since the round-4 run's key had it (the 400 proved scope was fine — the URL scheme was the actual failure).

## Next Phase Readiness
- All three round-4 UAT gaps' shared root cause (non-https `PUBLIC_APP_URL`) is now closed at every layer: provisioning pre-flight, warning copy, health-card recognition, predev warning, and production boot guard.
- No blockers for downstream work. The one remaining item is the operator-driven live UAT re-run (D6 above), which is a human-judgment verification step, not a code gap.

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-09*

## Self-Check: PASSED

All 11 created/modified files confirmed present on disk; all 4 task commit hashes (`0e4f67b`, `0a1ef82`, `9d9da8a`, `6cbc268`) confirmed present in git log.
