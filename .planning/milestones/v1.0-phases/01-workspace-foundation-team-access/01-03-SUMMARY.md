---
phase: 01-workspace-foundation-team-access
plan: 03
subsystem: auth
tags: [sendgrid, better-auth, email, password-reset, verification, profile, vitest, nock]

# Dependency graph
requires:
  - phase: 01-01
    provides: better-auth instance (auth.ts), Pino redaction covering apiKey/token/password
  - phase: 01-02
    provides: authClient.ts (requestPasswordReset/resetPassword/sendVerificationEmail methods), AppShell mounting /w/:slug routes
provides:
  - Platform SendGrid mail module (platformMail) structurally separate from the tenant BYO-key client, reading only PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM
  - In-repo HTML templates for verify-email, reset-password, invite (D-08 — no SendGrid Dynamic Templates for system mail)
  - better-auth sendResetPassword/sendVerificationEmail callbacks wired through platformMail; requireEmailVerification kept OFF (D-02/Pitfall 2)
  - verification-gate.ts: requireVerifiedEmail preHandler + isEmailVerified helper, consumed by 01-05's SendGrid-connect route
  - Web reset-request / reset-password pages and a dismissible VerifyEmailBanner mounted in AppShell
  - Profile page (display name + change password, D-24 v1 scope) and thin API routes over better-auth's updateUser/changePassword
affects: [01-04, 01-05, phase-uat]

# Tech tracking
tech-stack:
  added: ["@sendgrid/mail@8.1.x", "nock (test-only HTTP interceptor)"]
  patterns:
    - "Platform vs tenant SendGrid client separation: platform-mail/client.ts reads only PLATFORM_SENDGRID_API_KEY and never imports the tenant sendgrid-key/KMS module (grep-verified, RESEARCH Pitfall 4)"
    - "Soft email verification: requireEmailVerification stays false globally; verification is enforced per-action via requireVerifiedEmail preHandler, not a global gate"
    - "System email bodies are in-repo string-template HTML (D-08), not SendGrid Dynamic Templates"

key-files:
  created:
    - apps/api/src/modules/platform-mail/client.ts
    - apps/api/src/modules/platform-mail/templates/verify-email.ts
    - apps/api/src/modules/platform-mail/templates/reset-password.ts
    - apps/api/src/modules/platform-mail/templates/invite.ts
    - apps/api/src/modules/auth/verification-gate.ts
    - apps/api/src/modules/tenancy/profile.ts
    - apps/api/src/modules/platform-mail/__tests__/platform-mail.test.ts
    - apps/api/src/modules/auth/__tests__/password-reset.test.ts
    - apps/web/src/routes/reset-request.tsx
    - apps/web/src/routes/reset-password.tsx
    - apps/web/src/features/auth/VerifyEmailBanner.tsx
    - apps/web/src/features/profile/ProfilePage.tsx
  modified:
    - apps/api/package.json
    - apps/api/src/env.ts
    - apps/api/src/modules/auth/auth.ts
    - apps/api/src/server.ts
    - apps/web/src/App.tsx
    - apps/web/src/features/app-shell/AppShell.tsx

key-decisions:
  - "Reset/verify email links are built explicitly from the token by our own callbacks (reset -> web app's own page, verify -> API's verify-email endpoint with callbackURL forced to WEB_URL), not from better-auth's default url/redirectTo, to guarantee links land on our routes"
  - "sendOnSignUp intentionally left unset on emailVerification so registration never attempts an outbound network call by default (soft verification, D-02)"
  - "Task 4 (human live-email verification) DEFERRED to phase-level UAT — see Deviations below"

requirements-completed: [TENANT-01, TENANT-04]

coverage:
  - id: D1
    description: "Platform SendGrid client (platformMail) dispatches sendReset/sendVerification/sendInvite using only PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM, structurally isolated from the tenant key module"
    requirement: "TENANT-04"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/platform-mail/__tests__/platform-mail.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Password reset flow: request-reset issues an email via platformMail, consuming the token sets a new password that authenticates"
    requirement: "TENANT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/auth/__tests__/password-reset.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "isEmailVerified reports false for a freshly registered (unverified) user; requireVerifiedEmail gate exists for downstream (01-05) use"
    requirement: "TENANT-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/auth/__tests__/password-reset.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Live delivery of the reset email through the real platform SendGrid account, arriving from noreply@ and successfully completing the reset in a browser"
    verification: []
    human_judgment: true
    rationale: "Requires a real PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM and an actual inbox; cannot be proven by mocked/unit tests. DEFERRED to phase-level UAT (checkpoint unavailable at execution time)."
  - id: D5
    description: "Verification banner appears for an unverified user in a real browser session, resend delivers a real verification email, and the app remains usable pre-verification"
    verification: []
    human_judgment: true
    rationale: "Requires a running browser session and real email delivery. DEFERRED to phase-level UAT (checkpoint unavailable at execution time)."
  - id: D6
    description: "Profile page display-name edit and change-password flow work end-to-end in a real browser, with no email-change/avatar control present"
    verification:
      - kind: unit
        ref: "apps/web tsc --noEmit / npm run build (structural checks only)"
        status: pass
    human_judgment: true
    rationale: "Structural/build checks pass, but interactive persistence and toast behavior were not exercised in a live browser. DEFERRED to phase-level UAT (checkpoint unavailable at execution time)."

# Metrics
duration: 8min
completed: 2026-07-03
status: complete
---

# Phase 01 Plan 03: Platform Mail, Password Reset, Soft Verification, Profile Summary

**Platform-key-only SendGrid mail path (in-repo HTML templates) powering password reset, soft email verification with a per-action gate, and a display-name/change-password profile page.**

## Performance

- **Duration:** 8 min (Tasks 1-3, per commit timestamps 15:09:52-15:16:18)
- **Started:** 2026-07-03T15:09:52+05:00
- **Completed:** 2026-07-03T15:16:18+05:00 (Tasks 1-3); checkpoint deferral resolved 2026-07-03
- **Tasks:** 3 of 4 executed automatically; Task 4 (human-verify) deferred to phase UAT
- **Files modified:** 18 (12 created, 6 modified)

## Accomplishments
- Platform SendGrid client (`platformMail`) with `sendVerification`/`sendReset`/`sendInvite`, authenticated only with `PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM`, sending in-repo HTML templates — structurally separate from the tenant BYO-key module (RESEARCH Pitfall 4 locked via source/import assertion in tests)
- better-auth wired so `sendResetPassword` and `sendVerificationEmail` route through `platformMail`, with `requireEmailVerification` kept `false` globally (soft verification, D-02) and a `requireVerifiedEmail` preHandler + `isEmailVerified` helper for per-action gating (consumed by 01-05)
- Web reset-request/reset-password pages and a dismissible amber `VerifyEmailBanner` (resend action) mounted in `AppShell`
- Profile page (display name + change password only, D-24 v1 scope) with thin API routes wrapping better-auth's `updateUser`/`changePassword`

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing tests — reset flow, verification token, platform-key-only dispatch** - `324260b` (test)
2. **Task 2: Platform mail module + better-auth reset/verification wiring + verification gate + reset/verify UI** - `9bfa18c` (feat)
3. **Task 3: Profile page — display name + change password** - `68ff004` (feat)

**Task 4 status:** `checkpoint:human-verify` — DEFERRED to phase-level UAT (see below). No implementation work was skipped; automated coverage for Tasks 1-3 is green.

_Note: This plan used TDD (tdd="true" on Task 2); RED (`324260b`) precedes GREEN (`9bfa18c`, `68ff004`)._

## Files Created/Modified
- `apps/api/src/modules/platform-mail/client.ts` - `platformMail.sendVerification/sendReset/sendInvite`, platform-key-only
- `apps/api/src/modules/platform-mail/templates/{verify-email,reset-password,invite}.ts` - in-repo HTML templates (D-08)
- `apps/api/src/modules/auth/verification-gate.ts` - `requireVerifiedEmail` preHandler + `isEmailVerified`
- `apps/api/src/modules/auth/auth.ts` - `sendResetPassword`/`sendVerificationEmail` callbacks call `platformMail`; `requireEmailVerification: false` retained
- `apps/api/src/modules/tenancy/profile.ts` - thin routes over better-auth `updateUser`/`changePassword`
- `apps/api/src/env.ts` - `PLATFORM_SENDGRID_API_KEY`, `PLATFORM_MAIL_FROM`
- `apps/api/src/server.ts` - registers profile routes
- `apps/web/src/routes/reset-request.tsx` / `reset-password.tsx` - reset flow pages
- `apps/web/src/features/auth/VerifyEmailBanner.tsx` - amber soft-verification banner with resend
- `apps/web/src/features/profile/ProfilePage.tsx` - display-name + change-password forms
- `apps/web/src/features/app-shell/AppShell.tsx` - mounts `VerifyEmailBanner`, adds profile nav link (deviation, see below)
- `apps/web/src/App.tsx` - registers new routes
- `apps/api/src/modules/platform-mail/__tests__/platform-mail.test.ts`, `apps/api/src/modules/auth/__tests__/password-reset.test.ts` - RED/GREEN test coverage

## Decisions Made
- Reset/verify links are constructed explicitly by our own callbacks from the token (reset -> web app page, verify -> API endpoint with `callbackURL` forced to `WEB_URL`) instead of relying on better-auth's default `url`/`redirectTo`, to guarantee correct routing.
- `sendOnSignUp` intentionally left unset on `emailVerification` so registration never triggers an outbound network call by default.
- Task 4 (live-email human verification) is DEFERRED to phase-level UAT rather than blocking plan completion — see Deviations.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Mounted VerifyEmailBanner in AppShell + added profile nav link**
- **Found during:** Task 2
- **Issue:** The plan's file list for Task 2 did not include `AppShell.tsx`, but the plan's own action text requires the banner to be "mounted in the AppShell for unverified users" — without editing AppShell the banner would never render.
- **Fix:** Modified `apps/web/src/features/app-shell/AppShell.tsx` to mount `VerifyEmailBanner` and added a minimal sidebar link to `/w/:slug/profile` for discoverability.
- **Files modified:** `apps/web/src/features/app-shell/AppShell.tsx`
- **Verification:** `npm run build` (web) passes; banner renders per component test/manual review of JSX.
- **Committed in:** `9bfa18c` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3 - blocking, scope-consistent with the plan's own action text)
**Impact on plan:** Necessary to satisfy the plan's own stated behavior (banner must mount in AppShell). No scope creep.

### Checkpoint Deferral (Task 4)

**Task 4 — Human verification — reset, verification, and profile** was reached in a prior execution session. The user was unavailable at the checkpoint. Per orchestrator ruling, live-email human verification is **DEFERRED to phase UAT** rather than blocking completion of this plan, on the strength of:
- 11/11 vitest passing (including the 6 platform-mail/password-reset tests added in this plan)
- Clean `apps/api` and `apps/web` builds
- Clean `tsc --noEmit`

**Task 4 is recorded as DEFERRED, not PASSED.** The following manual checks remain outstanding and must be completed during phase-level UAT with real `PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM` credentials:

1. **Password-reset email delivery** — From `/login`, click "Забыли пароль?", enter an email, confirm a reset email actually arrives from the platform `noreply@` sender (via the real platform SendGrid key), and confirm the new password authenticates.
2. **Verification banner + resend** — As a freshly registered (unverified) user, confirm the amber "Подтвердите email…" banner appears in the app shell, click "Отправить письмо ещё раз", and confirm a real verification email arrives; confirm the app remains usable before verifying.
3. **Profile display-name/password change in browser** — On `/w/{slug}/profile`, confirm editing display name persists and re-renders, confirm changing password with the correct current password succeeds with the "Пароль изменён" toast, and confirm no email-change or avatar control is present.

No live email sending was attempted during this continuation session, per resume instructions.

## Issues Encountered
None beyond the documented Task 4 deferral.

## User Setup Required

**External services require manual configuration** for the deferred UAT checks to run:
- `PLATFORM_SENDGRID_API_KEY` — Platform-owned SendGrid account -> Settings -> API Keys (Mail Send scope); distinct from any tenant key.
- `PLATFORM_MAIL_FROM` — a `noreply@` address on the platform domain with SPF/DKIM configured, e.g. `noreply@megacrm.app`.
- SendGrid Dashboard -> Settings -> Sender Authentication: configure SPF + DKIM for the platform sending domain and verify the `noreply@` sender.

These were already specified in the plan's `user_setup` block and are unchanged; they must be in place before phase UAT exercises the 3 deferred manual checks above.

## Next Phase Readiness
- `platformMail` and `requireVerifiedEmail`/`isEmailVerified` are ready for 01-04 (invites) and 01-05 (SendGrid-connect verification gate) to consume.
- Phase-level UAT must complete the 3 deferred manual checks (reset email delivery, verification banner/resend delivery, profile browser flow) before this plan's `must_haves.truths` are considered fully proven end-to-end — automated coverage proves the code paths; UAT proves live delivery.

---
*Phase: 01-workspace-foundation-team-access*
*Completed: 2026-07-03*

## Self-Check: PASSED
- FOUND: .planning/phases/01-workspace-foundation-team-access/01-03-SUMMARY.md
- FOUND: 324260b, 9bfa18c, 68ff004, 1b87fe3
