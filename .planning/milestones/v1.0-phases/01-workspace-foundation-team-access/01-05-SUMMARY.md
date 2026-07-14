---
phase: 01-workspace-foundation-team-access
plan: 05
subsystem: tenancy
tags: [kms, envelope-encryption, sendgrid, aws-sdk, vitest, nock, react-hook-form]

# Dependency graph
requires:
  - phase: 01-01
    provides: workspace_sendgrid_keys table with RLS, sendgrid-key.repository.ts upsertKey/getKey, requirePermission('sendgridKey','update')
  - phase: 01-03
    provides: requireVerifiedEmail preHandler + isEmailVerified, platformMail (structurally separate two-key precedent)
  - phase: 01-04
    provides: OnboardingChecklist.tsx (pending done-detection), members list endpoint, AppShell nav pattern
provides:
  - Provider-agnostic KMS envelope-encryption client (kms/client.ts) behind a KMS_PROVIDER=local|aws toggle, with a dev-only static-KEK local provider (production-boot guard) and a real @aws-sdk/client-kms provider
  - Tenant SendGrid client (sendgrid-client.ts) validating a BYO key's mail.send scope + verified senders, structurally separate from platform-mail
  - SendGrid key connect + recheck routes (role + verified-email gated), storing only envelope-encrypted ciphertext + a display mask
  - SendGrid key settings UI (connect form, masked status, verified-senders table, re-check) at /w/:slug/settings/sendgrid
  - Live onboarding checklist done-detection (SendGrid connected / second member present)
affects: [phase-2, phase-3, phase-4, phase-5, phase-6, phase-uat]

# Tech tracking
tech-stack:
  added: ["@aws-sdk/client-kms@3.1079.0"]
  patterns:
    - "KMS envelope encryption behind an internal provider interface (generateDataKey/decryptDataKey), dispatched via dynamic import on KMS_PROVIDER so the aws-sdk client-kms module is never loaded in local dev and local-provider.ts is never loaded in a KMS_PROVIDER=aws production deploy"
    - "Two-layer production-boot guard for KMS_PROVIDER=local: env.ts's zod superRefine (primary, fails before the server starts listening) + a redundant module-level throw in kms/local-provider.ts"
    - "workspaceId used as GCM AAD (local provider) / KMS EncryptionContext (aws provider) to bind a wrapped DEK to the workspace it was generated for"
    - "Tenant vs platform SendGrid client separation continues from 01-03: sendgrid-client.ts never imports platform-mail, different function signature"
    - "withTenant(workspaceId, ...) is invoked directly inside a route handler for the first time in this phase (01-01/01-04's repository functions existed but were previously unwired)"

key-files:
  created:
    - apps/api/src/kms/client.ts
    - apps/api/src/kms/local-provider.ts
    - apps/api/src/kms/aws-provider.ts
    - apps/api/src/modules/tenancy/sendgrid-client.ts
    - apps/api/src/modules/tenancy/sendgrid-key.ts
    - apps/api/src/kms/__tests__/envelope.test.ts
    - apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts
    - packages/shared-schemas/src/sendgrid-key.ts
    - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx
    - apps/web/src/features/sendgrid-key/KeyStatusBadge.tsx
  modified:
    - apps/api/package.json
    - apps/api/src/env.ts
    - apps/api/src/server.ts
    - apps/api/src/modules/tenancy/sendgrid-key.repository.ts
    - apps/api/vitest.config.ts
    - packages/shared-schemas/src/index.ts
    - apps/web/src/App.tsx
    - apps/web/src/features/app-shell/AppShell.tsx
    - apps/web/src/features/onboarding/OnboardingChecklist.tsx

key-decisions:
  - "env.ts's zod superRefine is the primary KMS_PROVIDER=local/NODE_ENV=production boot guard (fails the whole process before it starts listening); local-provider.ts's own module-level throw is a redundant defense for the case where it's imported directly regardless of env parse timing"
  - "Recheck (POST .../sendgrid-key/recheck) is gated by the same requirePermission('sendgridKey','update') as connect -- it performs a live outbound call using the decrypted tenant key, which this phase treats as equivalent sensitivity to connect/change, even though must_haves.truths only explicitly names 'connect or change'"
  - "GET status does not call SendGrid live (no outbound request on every page load); verified senders are only populated in component state right after a connect/recheck response, with a fallback hint text otherwise -- avoids hitting SendGrid's API on every dashboard visit"
  - "Task 4 (live browser + real SendGrid key human verification) DEFERRED to phase-level UAT -- see Deviations below, following the same precedent established in 01-03 and 01-04"

requirements-completed: [TENANT-03, TENANT-04]

coverage:
  - id: D1
    description: "A valid key with mail.send validates live, is envelope-encrypted and stored, and verified senders are returned"
    requirement: "TENANT-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#connects a valid key with mail.send"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#stores the key envelope-encrypted at rest"
        status: pass
    human_judgment: false
  - id: D2
    description: "An invalid/revoked key and a key missing mail.send are each rejected with the exact UI-SPEC copy"
    requirement: "TENANT-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#rejects an invalid/revoked key"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#rejects a key missing the mail.send scope"
        status: pass
    human_judgment: false
  - id: D3
    description: "A Member is refused (403); Owner succeeds. An unverified-email Owner is refused with the exact verify-email copy"
    requirement: "TENANT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#refuses a Member session with 403 while the Owner succeeds"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts#blocks connect for an unverified-email Owner"
        status: pass
    human_judgment: false
  - id: D4
    description: "KMS envelope round-trip (encrypt/decrypt), no plaintext DEK exposure, DEK zeroed after use, workspaceId-bound encryption, and the local-provider production-boot guard"
    requirement: "TENANT-04"
    verification:
      - kind: unit
        ref: "apps/api/src/kms/__tests__/envelope.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "The SendGrid key settings UI (connect form, masked key, status badge, verified senders, re-check) and the live onboarding checklist render correctly and hide the connect control for a Member, exercised in a real browser with real SendGrid keys"
    verification: []
    human_judgment: true
    rationale: "Requires a real SendGrid account (valid key, a key missing mail.send, an invalid/revoked key) and a live browser session to observe the masked display, badge transitions, verified-senders table, and role-based control hiding. DEFERRED to phase-level UAT (checkpoint unavailable at execution time), same as 01-03/01-04's Task 4."

# Metrics
duration: 7min
completed: 2026-07-03
status: complete
---

# Phase 01 Plan 05: SendGrid Key Connect, KMS Envelope Encryption, Onboarding Checklist Summary

**Provider-agnostic KMS envelope encryption (local dev-KEK / AWS KMS toggle) backing a live-validated, role-and-verify-gated SendGrid BYO-key connect flow, surfaced through a masked-status settings UI and a now-live onboarding checklist.**

## Performance

- **Duration:** ~7 min (Tasks 1-3, per commit timestamps 16:21:53-16:27:57)
- **Started:** 2026-07-03T16:21:53+05:00
- **Completed:** 2026-07-03T16:27:57+05:00 (Tasks 1-3); checkpoint deferral recorded 2026-07-03
- **Tasks:** 3 of 4 executed automatically; Task 4 (human-verify) deferred to phase UAT
- **Files modified:** 19 (10 created, 9 modified)

## Accomplishments

- `kms/client.ts`: `encryptTenantSecret`/`decryptTenantSecret` envelope-encrypt a tenant's SendGrid key via a fresh per-call DEK, dispatching on `KMS_PROVIDER` through dynamic import so only the active provider module ever loads; the plaintext DEK is zeroed (`Buffer.fill(0)`) immediately after use and never returned to the caller.
- `kms/local-provider.ts` (dev-only static KEK, aes-256-gcm, `workspaceId` as AAD) and `kms/aws-provider.ts` (`@aws-sdk/client-kms` `GenerateDataKey`/`Decrypt`, `workspaceId` as `EncryptionContext`) implement the same two-function interface; the local provider refuses to boot under `NODE_ENV=production`, backed primarily by a `zod` `superRefine` in `env.ts` that fails the entire process at startup.
- `sendgrid-client.ts`: `validateTenantSendGridKey` calls `GET /v3/scopes` then `/v3/verified_senders`, structurally separate from `platform-mail/client.ts` (no shared import, different signature -- continuing 01-03's two-key discipline).
- `sendgrid-key.ts`: connect route chains `requirePermission('sendgridKey','update')` then `requireVerifiedEmail`, validates live, encrypts, and stores via the tenant-scoped repository (RLS-protected, first route in this phase to actually invoke `withTenant`); recheck route re-validates the stored (decrypted) key and updates status/`last_checked_at`.
- Web: `SendGridKeySettings.tsx` (not-connected empty state with an Owner/Admin-only connect form; connected view with masked key in `font-mono`, status badge, verified-senders table, «Проверить сейчас»), `KeyStatusBadge.tsx` (green/red/neutral semantic badge), and `OnboardingChecklist.tsx`'s done-detection now reads live SendGrid-status and member-count queries instead of hardcoded `false`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing tests -- validation, envelope round-trip, role/verify gates, no-plaintext** - `8e525d5` (test)
2. **Task 2: KMS envelope module + tenant SendGrid client + connect/recheck routes** - `02bf775` (feat)
3. **Task 3: SendGrid key settings UI + status badge + onboarding checklist finalize** - `accca9c` (feat)

**Task 4 status:** `checkpoint:human-verify` -- DEFERRED to phase-level UAT (see below). No implementation work was skipped; automated coverage for Tasks 1-3 is green.

_Note: This plan used TDD (`tdd="true"` on Tasks 2 and 3); RED (`8e525d5`) precedes GREEN (`02bf775`, `accca9c`)._

## Verification Performed (this session)

- `cd apps/api && npx vitest run` -> **8 test files passed, 32/32 tests passed** (includes the 5 new envelope tests + 6 new sendgrid-key-connect tests)
- `cd apps/api && npm run build` (tsc) -> clean, exit 0
- `cd apps/web && npx tsc --noEmit` -> clean, exit 0
- `cd apps/web && npm run build` (tsc + vite build) -> clean, exit 0 (pre-existing >500kB chunk-size advisory only, out of scope)

## Files Created/Modified

- `apps/api/src/kms/client.ts` / `local-provider.ts` / `aws-provider.ts` -- envelope encryption, provider dispatch, boot guard
- `apps/api/src/modules/tenancy/sendgrid-client.ts` -- `validateTenantSendGridKey`
- `apps/api/src/modules/tenancy/sendgrid-key.ts` -- `registerSendgridKeyRoutes` (GET status, POST connect, POST recheck)
- `apps/api/src/modules/tenancy/sendgrid-key.repository.ts` -- `last_checked_at` on connect, new `updateKeyStatus` for recheck
- `apps/api/src/env.ts` -- `KMS_PROVIDER`/`KMS_LOCAL_KEK`/`KMS_KEK_ID` + `superRefine` boot guard
- `apps/api/src/server.ts` -- registers `registerSendgridKeyRoutes` (deviation, see below)
- `apps/api/package.json` -- `@aws-sdk/client-kms@3.1079.0`
- `apps/api/vitest.config.ts` -- test-safe `KMS_PROVIDER=local`/`KMS_LOCAL_KEK` defaults
- `packages/shared-schemas/src/sendgrid-key.ts` -- `connectSendgridKeySchema`, `sendgridKeyStatusSchema`, `verifiedSenderSchema`
- `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx`, `KeyStatusBadge.tsx`
- `apps/web/src/features/onboarding/OnboardingChecklist.tsx` -- live done-detection
- `apps/web/src/App.tsx` -- registers `/w/:slug/settings/sendgrid`
- `apps/web/src/features/app-shell/AppShell.tsx` -- "SendGrid" nav link (deviation, see below)
- `apps/api/src/kms/__tests__/envelope.test.ts`, `apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts` -- RED/GREEN test coverage

## Decisions Made

- `env.ts`'s schema-level `superRefine` (not just `local-provider.ts`'s own check) is the primary "refuse to boot" guard for `KMS_PROVIDER=local` + `NODE_ENV=production`, since it fires at process startup regardless of whether the connect route is ever hit.
- Recheck is gated by the same `requirePermission('sendgridKey','update')` as connect, treating it as equivalent sensitivity (it decrypts and re-validates the live key) even though the plan's truths only named "connect or change" explicitly.
- GET status intentionally does not call SendGrid live on every page load; verified senders populate in UI state only right after a connect/recheck response, with fallback hint text otherwise -- avoids an outbound SendGrid call on every dashboard visit while still satisfying D-21's "show verified senders" requirement at the moments that matter (connect, recheck).
- Task 4 (live browser + real SendGrid key human verification) is DEFERRED to phase-level UAT rather than blocking plan completion -- see Deviations.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Registered the new routes in `server.ts`**
- **Found during:** Task 2
- **Issue:** The plan's file list for this plan did not include `apps/api/src/server.ts`, but `registerSendgridKeyRoutes` must be mounted on the Fastify app for the connect/recheck/status routes (and the connect test) to be reachable at all.
- **Fix:** Added `import { registerSendgridKeyRoutes } from "./modules/tenancy/sendgrid-key.js"` and `await app.register(registerSendgridKeyRoutes)` to `buildServer()`.
- **Files modified:** `apps/api/src/server.ts`
- **Verification:** `sendgrid-key-connect.test.ts` (6/6) exercises every route through `app.inject()`.
- **Committed in:** `02bf775` (Task 2 commit)

**2. [Rule 3 - Blocking] Added a "SendGrid" nav link in `AppShell.tsx`**
- **Found during:** Task 3
- **Issue:** The plan's file list for Task 3 did not include `AppShell.tsx`, but the new `/w/:slug/settings/sendgrid` route needs a discoverable entry point (matching the same gap/fix pattern as 01-03's `VerifyEmailBanner`/profile-link addition).
- **Fix:** Added a "SendGrid" `Link` to `AppShell.tsx`'s sidebar, alongside the existing "Команда"/"Профиль" links.
- **Files modified:** `apps/web/src/features/app-shell/AppShell.tsx`
- **Verification:** `npm run build` (web) passes; route is reachable from the sidebar.
- **Committed in:** `accca9c` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 -- blocking issues needed to wire the feature into the running app, consistent with prior plans' precedent for the same kind of gap).
**Impact on plan:** No scope creep; no architectural changes (Rule 4 not triggered).

### Checkpoint Deferral (Task 4)

**Task 4 -- Human verification -- SendGrid key connect and gates** requires a real SendGrid account (a valid key with `mail.send`, a key missing that scope, and an invalid/revoked key) and a live browser session -- neither is available in this non-interactive execution context. Per the precedent established in 01-03 and 01-04 (both deferred their equivalent live-verification checkpoints to phase-level UAT when the user was unavailable), Task 4 is **DEFERRED to phase-level UAT** rather than blocking completion of this plan, on the strength of:

- 32/32 vitest passing (including the 5 new envelope tests + 6 new sendgrid-key-connect tests added in this plan)
- Clean `apps/api` and `apps/web` builds
- Clean `tsc --noEmit` (web)

**Task 4 is recorded as DEFERRED, not PASSED.** The following manual checks remain outstanding and must be completed during phase-level UAT with a real SendGrid account and `KMS_PROVIDER=local`/`KMS_LOCAL_KEK` (or a real AWS KMS key) configured:

1. **Empty state** -- With `KMS_PROVIDER=local` + `KMS_LOCAL_KEK` set, open `/w/{slug}/settings/sendgrid` as Owner/Admin and confirm the empty state «SendGrid не подключён».
2. **Invalid / missing-scope keys** -- Paste a real SendGrid key WITHOUT `mail.send` -> confirm «Ключ действителен, но не имеет права mail.send…»; paste an invalid/revoked key -> confirm «SendGrid отклонил ключ…».
3. **Valid connect** -- Paste a valid `mail.send` key -> confirm it connects, the value shows masked (`SG.xxxx…yyyy`, monospace) with an «Активен» badge, and the account's verified senders are listed. Click «Проверить сейчас» -> confirm the badge/timestamp refreshes.
4. **Unverified-email gate** -- As an unverified-email user, confirm connect is blocked with «Подтвердите email, чтобы подключить SendGrid…».
5. **Member hiding** -- As a Member, confirm the connect/change control is not shown (and the API refuses if forced via direct request).
6. **Onboarding checklist** -- Confirm the workspace-home checklist marks «Подключите SendGrid» done after connecting, and «Пригласите команду» done once a second member exists.
7. **(Optional) DB integrity check** -- Inspect the `workspace_sendgrid_keys` row directly and confirm no column contains the plaintext key (automated coverage already asserts this at the repository level; this is a belt-and-suspenders live-DB spot check).

No live SendGrid account or browser interaction was attempted during this execution session, per the same non-interactive constraints documented in 01-03/01-04.

## Issues Encountered

None beyond the documented Task 4 deferral.

## User Setup Required

**External services require manual configuration** for the deferred UAT checks to run:

- `KMS_PROVIDER` -- `local` for continued local dev (default), or `aws` for any environment approaching production.
- `KMS_LOCAL_KEK` -- dev-only, generate via `openssl rand -base64 32`. Never used when `KMS_PROVIDER=aws`; the server refuses to boot with `KMS_PROVIDER=local` under `NODE_ENV=production`.
- `KMS_KEK_ID` -- required only when `KMS_PROVIDER=aws`: the AWS KMS key ARN/ID for the platform KEK.
- A real SendGrid account/API key (with and without `mail.send`, plus a deliberately invalid one) to exercise the deferred UAT checks above.

These were already specified in the plan's `user_setup` block and are unchanged.

## Next Phase Readiness

- Phase 1 (workspace-foundation-team-access) is now feature-complete across all 5 plans. Phase-level UAT must complete the deferred manual checks from 01-03 (3 checks), 01-04 (7 checks), and 01-05 (7 checks above) before the phase's `must_haves.truths` are considered fully proven end-to-end -- automated coverage proves every code path; UAT proves live email delivery, live SendGrid validation, and the interactive browser experience.
- `kms/client.ts`'s `encryptTenantSecret`/`decryptTenantSecret` and the `KMS_PROVIDER` toggle are stable and reusable if any future phase needs to encrypt another tenant-owned secret.
- No blockers for Phase 2.

---
*Phase: 01-workspace-foundation-team-access*
*Completed: 2026-07-03*

## Self-Check: PASSED
- FOUND: apps/api/src/kms/client.ts, local-provider.ts, aws-provider.ts
- FOUND: apps/api/src/modules/tenancy/sendgrid-client.ts, sendgrid-key.ts
- FOUND: apps/api/src/kms/__tests__/envelope.test.ts, apps/api/src/modules/tenancy/__tests__/sendgrid-key-connect.test.ts
- FOUND: packages/shared-schemas/src/sendgrid-key.ts
- FOUND: apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx, KeyStatusBadge.tsx
- FOUND: .planning/phases/01-workspace-foundation-team-access/01-05-SUMMARY.md
- FOUND commits: 8e525d5, 02bf775, accca9c
