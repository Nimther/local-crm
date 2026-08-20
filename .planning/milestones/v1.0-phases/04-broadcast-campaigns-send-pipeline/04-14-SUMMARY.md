---
phase: 04-broadcast-campaigns-send-pipeline
plan: 14
subsystem: api
tags: [fastify, content-type-parser, unsubscribe, rfc8058, compliance]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-03's public /unsubscribe/:token GET/POST routes and 04-11's XSS/CSP hardening of the same file"
provides:
  - "A working RFC 8058 one-click unsubscribe endpoint: application/x-www-form-urlencoded POSTs (mailbox-provider one-click and the confirm page's own form submit) are now accepted and mutate subscription_status"
  - "Regression suite pinning both real-world POST shapes plus a scope-guard case proving the fix is narrow"
affects: [05-webhook-tracking, phase-4-uat]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Media-type-specific fastify.addContentTypeParser registered inside a plain (non fastify-plugin) route-registration function to scope body parsing to a single route family without leaking app-wide"

key-files:
  created:
    - apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts
  modified:
    - apps/api/src/modules/delivery/unsubscribe.routes.ts

key-decisions:
  - "04-14: addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer', bodyLimit: 1024 }, (req, payload, done) => done(null, undefined)) registered at the top of registerUnsubscribeRoutes -- body is discarded because the signed token in the URL path is the sole authorization input; the handler never reads request.body"
  - "04-14: registered the specific media type only (no catch-all '*' like auth/plugin.ts uses) so an unrelated content type (application/xml) on the same route still 415s, keeping the fix narrow and provably scoped to /unsubscribe/*"

patterns-established:
  - "When a public unauthenticated route needs to accept a body shape Fastify's default parsers reject, register only that specific media type (not '*') inside the route's own registration function, with an explicit bodyLimit, and discard the buffer if the body carries no authorization signal."

requirements-completed: [SUBS-04]

coverage:
  - id: D1
    description: "Mailbox-provider RFC 8058 one-click POST (urlencoded, List-Unsubscribe=One-Click body) to /unsubscribe/:token returns 2xx and flips the contact to subscription_status=unsubscribed"
    requirement: "SUBS-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts#RFC 8058 one-click POST (urlencoded, List-Unsubscribe=One-Click body) returns 2xx and unsubscribes the contact"
        status: pass
    human_judgment: false
  - id: D2
    description: "Confirm page's own <form method=POST> submission (urlencoded, empty body) to /unsubscribe/:token returns 2xx and flips the contact to subscription_status=unsubscribed"
    requirement: "SUBS-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts#confirm-page form POST (urlencoded, empty body) returns 2xx and unsubscribes the contact"
        status: pass
    human_judgment: false
  - id: D3
    description: "The urlencoded parser is scoped to the unsubscribe routes only -- an unregistered content type (application/xml) on the same POST route still returns 415, proving the fix is narrow"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts#an unregistered content type (application/xml) on the same route still returns 415 (scope guard)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-07-06
status: complete
---

# Phase 04 Plan 14: Unsubscribe urlencoded content-type gap closure Summary

**Registered a media-type-specific `fastify.addContentTypeParser("application/x-www-form-urlencoded")` inside `registerUnsubscribeRoutes`, turning the public one-click unsubscribe endpoint's 415 into a working 2xx for both real-world POST shapes.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-06T14:20:00Z
- **Completed:** 2026-07-06T14:31:18Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Closed SUBS-04 / CR-01: the `List-Unsubscribe` / `List-Unsubscribe-Post` header pair now points to an endpoint that actually accepts both real-world POST shapes (mailbox-provider RFC 8058 one-click, and the confirm page's own form submit)
- Added a 3-case regression suite (`unsubscribe-content-type.test.ts`) that reproduces the 415 defect (RED), verifies the fix (GREEN), and pins the fix's scope with an `application/xml` guard case that must keep returning 415
- Confirmed zero regressions: full `apps/api` suite went from 152/152 to 155/155 passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Add failing regression tests for both urlencoded POST shapes (RED)** - `6737b1e` (test)
2. **Task 2: Register the urlencoded content-type parser scoped to the unsubscribe routes (GREEN)** - `3ed8b4a` (feat)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts` - New regression suite: RFC 8058 one-click POST, confirm-form POST, and an `application/xml` scope-guard case, each with an explicit `content-type` header (the existing suites never set one, which is why they missed this defect)
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` - Registers `fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer", bodyLimit: 1024 }, (req, payload, done) => done(null, undefined))` at the top of `registerUnsubscribeRoutes`, before the route declarations

## Decisions Made
- The urlencoded body is deliberately discarded (`done(null, undefined)`) rather than parsed into key/value pairs -- the signed token in the URL path is the sole authorization input, and the POST handler never reads `request.body`, so there is nothing meaningful to extract from either real-world payload (`List-Unsubscribe=One-Click` or an empty confirm-form body).
- Registered the specific media type only, not a catch-all `"*"` (unlike the precedent in `auth/plugin.ts`) -- this keeps the fix provably narrow, confirmed by Test 3 (`application/xml` still 415) both before and after the change.
- An explicit `bodyLimit: 1024` caps the buffering surface of this public, unauthenticated endpoint (T-04-14-01) while comfortably fitting both real payloads (~24 bytes and empty).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SUBS-04 is now genuinely satisfied end-to-end: Phase 4's 5th success criterion (delivery correctness, receiving half of the one-click unsubscribe loop) passes.
- No known blockers carried forward from this plan. WR-01..WR-06 from 04-REVIEW.md remain explicitly out of scope per this plan's scope fence.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

- FOUND: apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts
- FOUND: apps/api/src/modules/delivery/unsubscribe.routes.ts
- FOUND: .planning/phases/04-broadcast-campaigns-send-pipeline/04-14-SUMMARY.md
- FOUND commit: 6737b1e
- FOUND commit: 3ed8b4a
