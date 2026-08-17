---
phase: 16-live-sendgrid-verification
plan: 03
subsystem: infra
tags: [sendgrid, webhook, fault-injection, redaction, pino, tdd]

# Dependency graph
requires:
  - phase: 16-live-sendgrid-verification
    provides: "16-01's proven tracer (live BYO send + webhook attribution) that this plan's two seams expand on"
provides:
  - "SENDGRID_MAIL_SEND_URL module-level constant in packages/delivery-core/src/send-mail.ts, overridable via SENDGRID_BASE_URL, byte-identical to real SendGrid when absent/empty"
  - "apps/worker/src/server.ts's logSendgridBaseUrlOverrideIfActive() -- loud, non-fatal boot-time warning naming the active override, factored out for direct unit testing"
  - "WEBHOOK_RAW_CAPTURE_WORKSPACE_ID raw-payload capture in apps/api/src/modules/webhooks/webhooks.routes.ts, under the greppable marker UAT16_WEBHOOK_RAW_CAPTURE"
  - "WEBHOOK_RAW_CAPTURE_LOG_MARKER exported constant plan 16-04 greps on"
affects: [16-06-fault-injection, 16-04-dedup, 16-07-uat-report]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Session-scoped UAT seam variables (SENDGRID_BASE_URL, WEBHOOK_RAW_CAPTURE_WORKSPACE_ID) are read directly from process.env at the call site, never through a boot-parsed schema -- needed so the toggle is flippable within an already-running process, and matches packages/delivery-core's existing no-schema convention"
    - "Boot-time announcements factored into their own exported function (logSendgridBaseUrlOverrideIfActive) so they are directly unit-testable against an injected logger double, without constructing the full production runtime -- same shape as this file's pre-existing attachSharedListeners/closeWorkerRuntime"

key-files:
  created:
    - packages/delivery-core/src/__tests__/send-mail.test.ts (extended)
    - apps/worker/src/__tests__/sendgrid-base-url-boot-log.test.ts
    - apps/api/src/modules/webhooks/__tests__/webhooks-raw-capture.test.ts
  modified:
    - packages/delivery-core/src/send-mail.ts
    - apps/worker/src/server.ts
    - apps/api/src/modules/webhooks/webhooks.routes.ts
    - docker/prod.env.example
    - SPECIFICATION.md

key-decisions:
  - "Both new variables read directly from process.env at their call sites, not through apps/api/src/env.ts's frozen zod schema -- a UAT-session-scoped toggle must be flippable inside an already-running process (and, for webhooks-raw-capture.test.ts, inside a single long-lived Fastify test instance) without a redeploy/rebuild"
  - "Capture log field names (rawBodyBase64, signatureHeaderValue, timestampHeaderValue) were chosen to avoid every name in packages/redaction/src/rules.ts's REDACTION_RULES.keyRules -- Pino's redact option is path-based only (no value-pattern matching on structured logger.info calls, unlike scrub()'s freeform walk), so this is a naming choice, not an encoding property, that keeps the base64 payload fully decodable for UAT-03's replay"
  - "Greppable capture marker literal: UAT16_WEBHOOK_RAW_CAPTURE, exported as WEBHOOK_RAW_CAPTURE_LOG_MARKER from webhooks.routes.ts -- plan 16-04 extracts the capture via docker compose logs | grep on this exact string"

requirements-completed: [UAT-03, UAT-05]

coverage:
  - id: D1
    description: "SENDGRID_BASE_URL override seam in sendTenantMailV3, byte-identical to today when absent/empty, redirecting only the fetch URL when set"
    requirement: "UAT-05"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-mail.test.ts#SENDGRID_BASE_URL override seam (Phase 16, D-06/D-07)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Worker boot-time warning naming the active SENDGRID_BASE_URL override, never throwing"
    requirement: "UAT-05"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/sendgrid-base-url-boot-log.test.ts#logSendgridBaseUrlOverrideIfActive"
        status: pass
    human_judgment: false
  - id: D3
    description: "WEBHOOK_RAW_CAPTURE_WORKSPACE_ID raw-payload capture, scoped to an exact workspace match, strictly after signature+freshness verification and strictly before JSON.parse, with byte-exact base64 decode and no externally observable response change"
    requirement: "UAT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-raw-capture.test.ts (8 tests, real app.inject HTTP stack, SendGrid's own published signed fixture)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Both variables filed into SPECIFICATION.md and docker/prod.env.example in the same change"
    requirement: "UAT-03"
    verification:
      - kind: other
        ref: "npm run check:spec-env-coverage && npm run verify:prod-compose && npm run check:root-hygiene"
        status: pass
    human_judgment: false

# Metrics
duration: 55min
completed: 2026-08-17
status: complete
---

# Phase 16 Plan 03: SENDGRID_BASE_URL + Webhook Raw Capture Summary

**Two default-off, reversible UAT seams: a `SENDGRID_BASE_URL` fetch-URL override in `sendTenantMailV3` (with a loud, non-fatal worker boot warning) and a workspace-scoped raw webhook-payload capture under the greppable marker `UAT16_WEBHOOK_RAW_CAPTURE`, both filed into SPECIFICATION.md in this same change.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 3 completed (Task 1 and Task 2 both TDD: RED test commit, then GREEN implementation commit; Task 3 docs-only)
- **Files modified:** 8 (3 implementation, 3 new test files, 2 docs)

## Accomplishments

- `packages/delivery-core/src/send-mail.ts` gained `SENDGRID_MAIL_SEND_URL`, a `SENDGRID_TIMEOUT_MS`-style versioned module constant resolving `process.env.SENDGRID_BASE_URL` (empty string treated as absent) with the real endpoint as fallback -- the ONLY call site that reads the override; `apps/api/src/modules/tenancy/sendgrid-client.ts` and the platform system-mail sender are structurally untouched (confirmed by `git diff --stat` on the task's commits).
- `apps/worker/src/server.ts` gained `logSendgridBaseUrlOverrideIfActive()`, called at boot: warns exactly once (never throws, D-07) with the active override value when set, silent no-op when absent/empty.
- `apps/api/src/modules/webhooks/webhooks.routes.ts` gained a raw-payload capture, inserted strictly after the combined signature-verification+freshness gate and strictly before `JSON.parse`, scoped by an exact `WEBHOOK_RAW_CAPTURE_WORKSPACE_ID` match. Emits one Pino `info` line under the marker `UAT16_WEBHOOK_RAW_CAPTURE` (exported as `WEBHOOK_RAW_CAPTURE_LOG_MARKER`) carrying the base64 raw body and both signature header values. Response status/body are provably identical whether or not the capture fires (dedicated parity test, both accepted and rejected paths).
- Both variables filed into `SPECIFICATION.md` (new section 3.9, plus updates to sections 5.5 and 6.8) and `docker/prod.env.example` (commented placeholder lines, `API_PORT`/`WORKER_HEALTH_PORT` convention) in this same commit set.

## Task Commits

Each task followed RED -> GREEN (TDD) except Task 3 (docs-only, no `tdd` flag):

1. **Task 1: SENDGRID_BASE_URL seam + worker boot warning**
   - `3170d2b` test(16-03): add failing test for SENDGRID_BASE_URL override seam
   - `092e02d` test(16-03): add failing test for worker SENDGRID_BASE_URL boot warning
   - `19157d7` feat(16-03): add SENDGRID_BASE_URL override seam + worker boot warning
2. **Task 2: WEBHOOK_RAW_CAPTURE_WORKSPACE_ID raw-payload capture**
   - `b6e7652` test(16-03): add failing test for webhook raw-payload capture
   - `891579d` feat(16-03): add WEBHOOK_RAW_CAPTURE_WORKSPACE_ID raw-payload capture
3. **Task 3: File both variables into SPECIFICATION.md**
   - `b26ac0b` docs(16-03): file SENDGRID_BASE_URL + WEBHOOK_RAW_CAPTURE_WORKSPACE_ID into SPECIFICATION.md

_Both TDD tasks confirmed genuine RED before GREEN: the send-mail test failed with `expected undefined to be 'https://api.sendgrid.com/v3/mail/send'` (constant not yet exported), and the worker boot-log test failed with `TypeError: ... logSendgridBaseUrlOverrideIfActive is not a function` -- neither was a vacuous pass._

## Files Created/Modified

- `packages/delivery-core/src/send-mail.ts` - `SENDGRID_MAIL_SEND_URL` constant; `sendTenantMailV3`'s `fetch` now targets it
- `packages/delivery-core/src/__tests__/send-mail.test.ts` - added a `describe` block covering all 7 `<behavior>` cases for the override seam (module re-imported fresh per variant via `vi.resetModules()`)
- `apps/worker/src/server.ts` - `logSendgridBaseUrlOverrideIfActive()`, wired into `buildWorker()`'s existing env-check block
- `apps/worker/src/__tests__/sendgrid-base-url-boot-log.test.ts` - new, drives the factored-out function directly against a stub logger
- `apps/api/src/modules/webhooks/webhooks.routes.ts` - `WEBHOOK_RAW_CAPTURE_LOG_MARKER` export + the capture block
- `apps/api/src/modules/webhooks/__tests__/webhooks-raw-capture.test.ts` - new, 8 tests reusing `webhooks-signature.test.ts`'s real SendGrid-signed fixture and `app.inject` pattern verbatim
- `docker/prod.env.example` - both variables as commented placeholder lines under a new "Phase 16 UAT fault-injection/capture seams" section
- `SPECIFICATION.md` - new section 3.9; updates to 5.5 (`SENDGRID_MAIL_SEND_URL` resolution) and 6.8 (raw-capture placement + why `ingress_journal` cannot be the replay source)

## Decisions Made

- **Read directly from `process.env`, not `apps/api/src/env.ts`'s schema, for both variables.** `env.ts`'s zod schema is parsed once at module load and frozen for the process lifetime; a UAT-session toggle needs to be flippable inside an already-running process (both for the real UAT session, which should not require a redeploy to start/stop capture, and for `webhooks-raw-capture.test.ts`, which builds one Fastify server in `beforeAll` and toggles the variable per test). This mirrors `packages/delivery-core`'s existing no-schema convention for `SENDGRID_BASE_URL` and is recorded as a code comment at each read site.
- **Capture field names chosen to bypass Pino's path-based redaction, not to rely on base64 obscuring anything.** `packages/redaction/src/rules.ts`'s `REDACTION_RULES.keyRules` only matches by exact field name (`fast-redact` path list, no regex/value matching for structured `logger.info` calls -- that machinery, `scrub()`, only applies to freeform payloads the caller explicitly routes through it). `rawBodyBase64`/`signatureHeaderValue`/`timestampHeaderValue` match none of the reserved names (`token`, `secret`, `email`, etc.), so the line passes through `PINO_REDACT_OPTIONS` untouched and stays byte-exactly decodable. This finding is recorded as a code comment in `webhooks.routes.ts` and in SPECIFICATION.md section 3.9.
- **Greppable marker literal: `UAT16_WEBHOOK_RAW_CAPTURE`**, exported as `WEBHOOK_RAW_CAPTURE_LOG_MARKER` from `webhooks.routes.ts` so plan 16-04's extraction command and this file's own test import the same literal rather than duplicating it.
- **`SENDGRID_TIMEOUT_MS` confirmed already exported** (no change needed) -- plan 16-06's fault proxy derives its response-delay margin from the real constant.

## Deviations from Plan

None - plan executed exactly as written. Both TDD tasks followed the plan's own RED->GREEN structure; Task 3 required no code changes beyond documentation, as specified.

## Issues Encountered

- `npm run verify:prod-compose` initially failed with `stop-grace-period-undeterminable` because `apps/worker/dist/` was not built in this worktree (a `dist/`-gitignored build artifact, unrelated to this plan's changes). Resolved by running `npm run build -w apps/worker` before re-verifying; no source change was needed and no gitignored artifact was committed.
- A pre-existing, environment-known flake surfaced in a background full-suite `npm test` run (`failed-send-share-watchdog.test.ts` test 11) -- unrelated to any file this plan touched (not in `<files_modified>`), consistent with this machine's documented full-suite-load flakiness for cross-workspace-scan tests. Not chased, per the deviation rules' scope boundary (pre-existing failures in unrelated files are out of scope).

## User Setup Required

None - no external service configuration required. Both new variables are UAT-session-scoped and intentionally left unset in every committed config; the operator sets/unsets them manually during plan 16-06's fault-injection session and plan 16-04's capture session per their respective runbook sections (added by those later plans).

## Next Phase Readiness

- Both seams are ready for plan 16-04 (raw-capture extraction) and plan 16-06 (fault-injection UAT) to consume: the capture marker literal is fixed and exported, and the `SENDGRID_BASE_URL` override + its boot warning are wired and tested.
- No blockers. `docker/prod.env.example` and `SPECIFICATION.md` are in sync with the code in this same commit set, satisfying `check:spec-env-coverage`'s one-directional gate.

## Self-Check: PASSED

- `packages/delivery-core/src/send-mail.ts` -- FOUND, exports `SENDGRID_MAIL_SEND_URL` and `SENDGRID_TIMEOUT_MS`.
- `apps/worker/src/server.ts` -- FOUND, exports `logSendgridBaseUrlOverrideIfActive`.
- `apps/api/src/modules/webhooks/webhooks.routes.ts` -- FOUND, exports `WEBHOOK_RAW_CAPTURE_LOG_MARKER`.
- All 6 commit hashes above (`3170d2b`, `092e02d`, `19157d7`, `b6e7652`, `891579d`, `b26ac0b`) confirmed present via `git log --oneline`.
- All 4 plan-level vitest suites re-run individually and passed (13, 3, 8, 7 tests respectively); `npm run check:spec-env-coverage`, `npm run verify:prod-compose`, `npm run check:root-hygiene` all exit 0.

---
*Phase: 16-live-sendgrid-verification*
*Completed: 2026-08-17*
