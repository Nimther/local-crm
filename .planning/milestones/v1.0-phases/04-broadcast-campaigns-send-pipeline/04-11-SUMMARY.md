---
phase: 04-broadcast-campaigns-send-pipeline
plan: 11
subsystem: api
tags: [fastify, helmet, csp, xss, security-hardening, unsubscribe]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: "04-03's public GET/POST /unsubscribe/:token surface (RFC 8058 one-click unsubscribe)"
provides:
  - "isWellFormedUnsubscribeToken + escapeHtmlAttribute helpers neutralizing token reflection on the public unsubscribe page"
  - "Single, app-wide @fastify/helmet registration with an explicit script-blocking CSP"
affects: [phase-05-webhooks-analytics, phase-06-flows]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Format-guard-before-reflection: an untrusted route param is validated against a strict shape before ANY interpolation into HTML, with HTML-attribute-escaping as a second, independent layer"
    - "Single app-wide security-headers registration point (server.ts), not scattered per-module"

key-files:
  created:
    - apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts
  modified:
    - apps/api/src/modules/delivery/unsubscribe.routes.ts
    - apps/api/src/server.ts
    - apps/api/src/modules/auth/plugin.ts

key-decisions:
  - "Consolidated @fastify/helmet into a single registration in server.ts with explicit strict CSP directives, removing a pre-existing duplicate default (permissive) registration nested inside auth/plugin.ts -- two competing onSend hooks setting the same header would have raced, and the plan's own acceptance criteria required helmet visible in server.ts"
  - "Malformed tokens get a fixed, tokenless form action (posts to the current URL) rather than any escaped/sanitized echo -- simplest and strongest: nothing token-derived ever reaches the HTML at all for a non-conforming input"

requirements-completed: [SUBS-04]

coverage:
  - id: D1
    description: "GET /unsubscribe/:token never reflects an attacker-controlled token unescaped into the form action; malformed tokens are not echoed at all"
    requirement: "SUBS-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts#GET does not reflect an HTML-attribute-breaking token unescaped into the form action"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts#GET does not echo a malformed token (fails the base64url shape) at all"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts#GET with a genuinely valid signed token round-trips the token unchanged into the form action"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every response carries a script-blocking Content-Security-Policy header via @fastify/helmet"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts#every response carries a Content-Security-Policy header"
        status: pass
    human_judgment: false
  - id: D3
    description: "RFC 8058 one-click unsubscribe (SUBS-04) still works: a valid signed token unsubscribes the contact and returns 2xx"
    requirement: "SUBS-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts#POST with a valid signed token still unsubscribes the contact and returns 2xx"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts (pre-existing suite, re-run for regression)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 11: Unsubscribe XSS Hardening + Helmet CSP Summary

**Neutralized reflected XSS on the public /unsubscribe/:token page via a strict token-format guard + HTML-attribute escaping, and consolidated a single app-wide @fastify/helmet CSP registration.**

## Performance

- **Duration:** 20 min
- **Started:** 2026-07-06T18:10:00Z
- **Completed:** 2026-07-06T18:30:00Z
- **Tasks:** 2
- **Files modified:** 4 (1 created, 3 modified)

## Accomplishments
- `renderConfirmPage` no longer interpolates a raw, unvalidated `:token` route param into the form action; a malformed token (fails the strict base64url `<payload>.<sig>` shape) now renders the same generic confirm page with a fixed, tokenless form action, and a well-formed token is HTML-attribute-escaped (defense in depth, no-op for genuine tokens)
- `@fastify/helmet` now applies a single, explicit, script-blocking `Content-Security-Policy` (`default-src 'none'`, `style-src 'unsafe-inline'`, `base-uri 'none'`, `frame-ancestors 'none'`) to every response, app-wide
- RFC 8058 one-click POST unsubscribe (SUBS-04) verified unchanged end-to-end: still transitions `subscription_status` to `unsubscribed` and returns 2xx
- New regression test (`unsubscribe-xss.test.ts`, 5 tests) pins the reflection-escaping, malformed-token non-echo, valid-token round-trip, CSP-header-presence, and POST-still-works behaviors

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing XSS + headers test for the public unsubscribe surface** - `4c73de3` (test)
2. **Task 2: Neutralize token reflection + register @fastify/helmet CSP** - `b9115e2` (feat)

**Plan metadata:** (this commit)

_Note: TDD RED → GREEN cycle; no separate refactor commit needed._

## Files Created/Modified
- `apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts` - New XSS + security-headers regression test (5 cases)
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` - Added `isWellFormedUnsubscribeToken` + `escapeHtmlAttribute`; `renderConfirmPage` now format-guards before interpolating the token
- `apps/api/src/server.ts` - Registered `@fastify/helmet` app-wide with an explicit strict CSP, before route registrations
- `apps/api/src/modules/auth/plugin.ts` - Removed a pre-existing duplicate, permissive `@fastify/helmet` registration nested inside `authPlugin`

## Decisions Made
- Discovered `@fastify/helmet` was already registered (with library defaults, no CSP directives configured) inside `auth/plugin.ts`, contradicting the plan's assumption ("no `@fastify/helmet` registered anywhere"). Because `@fastify/helmet` wraps itself with `fastify-plugin`, that registration's hooks applied app-wide despite being nested inside an encapsulated child plugin -- verified two helmet registrations do not throw an avvio name-collision error, but would leave two competing `onSend` hooks setting the same header (last-registered wins), which is fragile and would silently override the plan's intended strict directives depending on registration order. Consolidated to a single registration in `server.ts` (satisfying the plan's own acceptance criterion that `grep helmet apps/api/src/server.ts` show the registration) and removed the duplicate from `auth/plugin.ts`.
- Malformed tokens render with `form action=""` (empty, resolves to the current URL) rather than any sanitized echo of the token — the plan's action text explicitly allows this ("a fixed action target such as posting to the current URL is acceptable — do not echo the raw token").

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed a duplicate, permissive `@fastify/helmet` registration in `auth/plugin.ts`**
- **Found during:** Task 2 (registering `@fastify/helmet` in `server.ts`)
- **Issue:** `@fastify/helmet` was already registered without CSP options inside `authPlugin` (nested but de-encapsulated via `fastify-plugin`), which the plan's threat model did not know about. Leaving both registrations in place would create two `onSend` hooks racing to set the same `Content-Security-Policy` header with different (one strict, one permissive-default) directives.
- **Fix:** Removed the old registration from `auth/plugin.ts`; `server.ts` is now the single source of truth for the CSP actually served, registered before all route registrations per the plan's action text.
- **Files modified:** `apps/api/src/modules/auth/plugin.ts`, `apps/api/src/server.ts`
- **Verification:** `grep -n "helmet" apps/api/src/server.ts` shows the single registration; full `apps/api` vitest suite (152/152) and `tsc --noEmit` both clean after the change.
- **Committed in:** `b9115e2` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug/consolidation, Rule 1)
**Impact on plan:** Necessary correctness fix to avoid two competing security-header registrations; no scope creep — same two files the plan already targeted (`server.ts`, plus the pre-existing `auth/plugin.ts` registration it duplicated).

## Issues Encountered
None beyond the helmet-duplication finding documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CR-01 (blocker) and WR-05 are closed; the public unsubscribe surface can no longer reflect executable markup and now carries a script-blocking CSP app-wide.
- No blockers introduced for subsequent phase-04 gap-closure plans (04-09 through 04-13) or for Phase 5 (webhooks/analytics).

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

- FOUND: apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts
- FOUND: apps/api/src/server.ts
- FOUND: apps/api/src/modules/delivery/unsubscribe.routes.ts
- FOUND: apps/api/src/modules/auth/plugin.ts
- FOUND commit: 4c73de3
- FOUND commit: b9115e2
