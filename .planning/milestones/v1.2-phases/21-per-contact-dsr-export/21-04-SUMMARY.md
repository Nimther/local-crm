---
phase: 21-per-contact-dsr-export
plan: 04
subsystem: api
tags: [zod, fastify, postgres, react-query, dsr-export, gdpr]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: contacts.anonymized_at column + CMP-04 tenant-visibility filter (`anonymized_at IS NULL`)
  - phase: 21-per-contact-dsr-export (plan 21-01)
    provides: "the DSR export tracer -- contact:export permission, GET /dsr-export route, ExportContactButton, EXPORT_ERASED_MESSAGE/computeExportErrorMessage"
provides:
  - "anonymizedAt: string | null on contactResponseSchema, always present (list/get/create/patch)"
  - "getContact's additive select returning anonymizedAt (ContactRowWithAnonymizedAt)"
  - "computeExportDisabledReason(contact) on ContactDetailPage.tsx"
  - "disabled-with-reason Export button state for an erased contact, plus mid-session-410 query invalidation"
affects: [21-05-isolation-race-test, 21-06-migrations-docs]

tech-stack:
  added: []
  patterns:
    - "Additive select on getContact mirroring updateContact's existing anonymized_at precedent, without touching the shared CONTACT_COLUMNS or the anonymized_at IS NULL filter set"
    - "toContactResponse normalises an optional row field (undefined on list/create/patch selects) to a non-optional null on the wire, so every route shares one response shape"
    - "computeExportDisabledReason mirrors computeIncompleteReason's inline-copy pattern (LaunchScheduleDialogs.tsx) -- visible disabled state with reason, not a tooltip"

key-files:
  created: []
  modified:
    - packages/shared-schemas/src/contact.ts
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/api/src/modules/contacts/contacts.routes.ts
    - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
    - apps/web/src/features/contacts/ContactDetailPage.tsx
    - apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx

key-decisions:
  - "Widened getContact's return type locally in apps/api's contact.repository.ts (new ContactRowWithAnonymizedAt interface extending the shared ContactRow) instead of touching packages/contacts-core's CONTACT_COLUMNS/ContactRow -- that type is shared with the API-key contact surface and the CSV upsert path, outside this plan's mandate."
  - "toContactResponse reads row.anonymizedAt via a cast to ContactRowWithAnonymizedAt rather than widening its own parameter type to a union -- ContactRowWithAnonymizedAt already IS-A ContactRow (optional extra field), so every existing caller (list/create/patch, all returning plain ContactRow) stays structurally valid without change."
  - "The disabled-reason paragraph and the mutation-error paragraph share ONE rendered slot (`message = disabledReason ?? serverError`) -- reason takes precedence, the two are never rendered together, matching the plan's explicit instruction."
  - "onError now invalidates the [\"workspace\", slug, \"contacts\", contact.id] query on a 410, per D-13/D-14 -- the resulting refetch 404s (Phase 13's filter, unchanged) and the page falls into its existing not-found state; documented inline as the intended, honest outcome rather than a defect."

patterns-established:
  - "Pattern: an additive-select helper type (`XRowWithY extends XRow { y?: Type }`) lets one route widen its own return shape without touching a shared package's base row type or its SELECT column list."

requirements-completed: [DSR-01]

coverage:
  - id: D1
    description: "Every contact response (list/get/create/patch) carries anonymizedAt: null for a live contact, with getContact's select widened and the anonymized_at IS NULL filter set count unchanged (4/4 before and after)"
    requirement: "DSR-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts#DSR-01/D-14: single-contact GET carries anonymizedAt as null for a live contact"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts#DSR-01/D-14: contact list rows carry anonymizedAt as null"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/contact-crud.test.ts#DSR-01/D-14: create and patch responses carry anonymizedAt as null"
        status: pass
    human_judgment: false
  - id: D2
    description: "An erased contact's Export button is visible (not hidden), disabled, and shows the erased-copy reason inline; a live contact shows no reason; computeExportDisabledReason is a direct-testable pure function"
    requirement: "DSR-01"
    verification:
      - kind: unit
        ref: "apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx#erased contact: button is present but disabled with the reason on screen"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx#erased contact: the button is not hidden"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx#live contact: no reason paragraph"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx#computeExportDisabledReason: returns the erased string for a non-null anonymizedAt, null otherwise"
        status: pass
    human_judgment: false
  - id: D3
    description: "A mid-session 410 (contact erased after the card loaded) renders the same erased-reason copy and invalidates the contact query so a stale-enabled button reaches its disabled state on the next render"
    requirement: "DSR-01"
    verification:
      - kind: unit
        ref: "apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx#410 sets the erased reason in the message slot"
        status: pass
      - kind: manual_procedural
        ref: "21-04-PLAN.md Task 2 <human-check> -- live two-tab erase-then-click walkthrough against a running dev stack, not run in this session"
        status: unknown
    human_judgment: true
    rationale: "The human-check requires two real browser tabs against a running dev stack (erase a contact in tab 2, click Export in tab 1) to observe the network-level 410 and the subsequent not-found transition -- not reachable from this automated, mocked-hook test lane. Deferred to the phase's end-of-phase human verification per human_verify_mode: end-of-phase."

duration: ~50min
completed: 2026-08-22
status: complete
---

# Phase 21 Plan 04: Erased-Contact Export Disabled State Summary

**`anonymizedAt` added to the contact response wire shape, and a visible-but-disabled Export button state with on-screen erasure reason plus mid-session 410 query invalidation on `ContactDetailPage.tsx`.**

## Performance

- **Duration:** ~50 min
- **Tasks:** 2 (both `tdd="true"`)
- **Files modified:** 6 (0 created)

## Accomplishments

- `contactResponseSchema` gained `anonymizedAt: z.string().nullable()`, always present (never optional) on every contact route's response -- list, get, create, patch all now carry it, closing D-14's missing precondition that plan 21-01 flagged and deferred.
- `getContact`'s select was widened to also read `anonymized_at as "anonymizedAt"`, mirroring `updateContact`'s existing additive-select precedent in the same file; the `anonymized_at IS NULL` filter itself is untouched -- verified by an unchanged before/after grep count (4/4) and a `git diff --stat` proving `packages/contacts-core/src/contact-repository.ts` (the shared `CONTACT_COLUMNS`/`ContactRow` definition) was not modified at all.
- `computeExportDisabledReason(contact)` is now exported from `ContactDetailPage.tsx`, a single source for the erased-contact copy shared by both the disabled-button state and the pre-existing 410 error branch (`grep -c` for the Russian copy string returns exactly `1`).
- `ExportContactButton` keeps rendering for an erased contact (never hidden, unlike the Member role gate one level up) but folds the reason into its `disabled` expression and shows the reason in the same reserved paragraph slot the mutation-error copy already used -- the two never render together.
- The mutation's `onError` now invalidates the `["workspace", slug, "contacts", contact.id]` query on a 410, so a stale-enabled button (loaded before an erasure happened in another session) reaches its disabled state on the next render instead of staying clickable. The resulting refetch legitimately 404s (Phase 13's tenant-visibility filter is unchanged), and the page falls into its existing "Контакт не найден" not-found state -- documented inline as the intended honest outcome, per the plan's flagged assumption.

## Task Commits

Each task followed the plan's TDD RED/GREEN split:

1. **Task 1: Put `anonymizedAt` on the contact response**
   - `4f81426` test(21-04): add failing test for anonymizedAt on contact response (RED)
   - `e6567bb` feat(21-04): put anonymizedAt on the contact response (GREEN)
2. **Task 2: Erased-contact Export state**
   - `728756f` test(21-04): add failing tests for erased-contact disabled Export state (RED)
   - `6895f0a` feat(21-04): erased-contact Export state -- visible, disabled, with reason on screen (GREEN)

**Plan metadata:** committed separately (see below), includes this SUMMARY.

## Files Created/Modified

- `packages/shared-schemas/src/contact.ts` - `anonymizedAt: z.string().nullable()` added to `contactResponseSchema`
- `apps/api/src/modules/contacts/contact.repository.ts` - new `ContactRowWithAnonymizedAt` type; `getContact`'s select widened
- `apps/api/src/modules/contacts/contacts.routes.ts` - `toContactResponse` now emits `anonymizedAt`, normalising `undefined` (list/create/patch, whose selects don't fetch the column) to `null`
- `apps/api/src/modules/contacts/__tests__/contact-crud.test.ts` - 3 new cases (single-GET, list, create+patch all carry `anonymizedAt: null`)
- `apps/web/src/features/contacts/ContactDetailPage.tsx` - `computeExportDisabledReason` exported; `ExportContactButton` disabled expression + reason slot + `onError` query invalidation
- `apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx` - 5 new cases (erased disabled+reason, not-hidden, live-no-reason, 410 message slot, `computeExportDisabledReason` unit assertions); `baseContact()` fixture gained `anonymizedAt: null`

## Decisions Made

- Widened `getContact`'s return type locally (`ContactRowWithAnonymizedAt` in `apps/api`'s `contact.repository.ts`) rather than touching `packages/contacts-core`'s shared `ContactRow`/`CONTACT_COLUMNS` -- that type is shared with the API-key contact surface and the CSV upsert path, outside this plan's `files_modified` mandate.
- `toContactResponse` keeps its plain `ContactRow` parameter type and reads the extra field via an inline cast (`(row as ContactRowWithAnonymizedAt).anonymizedAt`) rather than widening the parameter to a union -- `ContactRowWithAnonymizedAt` is already structurally assignable to `ContactRow` (an optional extra field), so no caller needed a type change.
- The disabled-reason paragraph and the mutation-error paragraph share one rendered slot (`disabledReason ?? serverError`) so the two states are never shown simultaneously, per the plan's explicit instruction.
- `onError`'s query invalidation on a 410 documents inline that the resulting refetch legitimately 404s (Phase 13's filter is unchanged) and that this is the correct, honest outcome, not a bug to route around -- matching the plan's `<flagged_assumptions>` note verbatim.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `@mega-crm/*` bare imports resolved to the main checkout's stale packages, not this worktree's edits**
- **Found during:** Task 1 and Task 2 GREEN verification (`apps/web` typecheck and full regression)
- **Issue:** This worktree has no local `node_modules` (root or per-app). Node/TypeScript's upward module resolution walked past the worktree root and resolved every `@mega-crm/*` bare import (in particular `@mega-crm/shared-schemas`) from the MAIN repository checkout's stale copies, which do not have `anonymizedAt` on `contactResponseSchema`. This produced `TS2353`/`TS2339` type errors in `ContactDetailPage.tsx` and the test file even though the edits were correct in this worktree. `apps/api`'s tests were unaffected because `contacts.routes.ts` never attaches `contactResponseSchema` as a Fastify response schema -- it hand-builds a plain object, so no runtime dependency on the shared package's zod schema exists there.
- **Fix:** Per project safety rule 4 and the 21-01 precedent, created temporary `node_modules/@mega-crm/{contacts-core,db,delivery-core,flows-core,kms,queue-core,redaction,segments-core,shared-schemas,tenant-context,test-support}` symlinks at the worktree root pointing at this worktree's own `packages/*`, ran the full verification suite (typecheck, tests, lint, builds), then deleted the symlinks and every generated cache artifact (`apps/api/dist`, `apps/api/node_modules`, `apps/web/node_modules`, root `node_modules`) before this task's commit and before returning. `git status --short --ignored` confirmed clean both times.
- **Verification:** Re-ran `npx tsc --noEmit --types node -p apps/web/tsconfig.json` with the symlinks in place -- zero new type errors, only the two pre-existing environment-only errors (`vite/client` types, `vite.config.ts` module resolution) that 21-01-SUMMARY.md already documents as this sandbox's baseline.
- **Per project safety rule 4:** these symlinks and cache directories are gitignored and were deleted before any commit in this plan; they never entered any commit.

---

**Total deviations:** 1 auto-fixed (1 blocking, test/build-infrastructure only). No scope creep -- required solely to run this worktree's own verification against its own edited packages.

## Issues Encountered

- **`npm run build -w apps/web` still cannot run in this sandbox** -- `vite` (declared in `apps/web/package.json` devDependencies) is not installed anywhere resolvable from this worktree or the main repository checkout, a pre-existing environment gap unrelated to this plan's changes and already documented in 21-01-SUMMARY.md. Confirmed via `tsc --noEmit --types node` (bypassing the missing `vite/client` type-entry point), which showed zero new type errors in any file this plan touched; the only remaining errors were in `apps/web/src/lib/sentry.ts` (pre-existing, untouched) and `apps/web/vite.config.ts` (missing `vite`/`@vitejs/plugin-react` modules, environment-only).
- **One pre-existing, unrelated test failure confirmed untouched by this plan (`git status --short <file>` empty):**
  - `apps/web/src/__tests__/playwright-package-source-import.test.ts` -- fails because `node_modules/@playwright/test/cli.js` does not exist in this worktree (Playwright was never installed in this sandbox). Full `apps/web` regression: 131/132 passed, matching 21-01's documented baseline (126/127) plus this plan's 5 new tests, same single pre-existing failure.
- **`apps/api`'s `contact-crud.test.ts` sign-up rate-limit flake** -- one test ("CMP-04: PATCHing an anonymized (erased) contact returns 404...") intermittently fails with a 429 from `/api/auth/sign-up/email` when run alongside this file's ~20 other `owner()` calls (each of which signs up a fresh account) in quick succession. Confirmed pre-existing and unrelated to this plan's changes: the same test passes deterministically when run in isolation (`-t "CMP-04: PATCHing an anonymized"`), and its assertions never touch `anonymizedAt`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `anonymizedAt` is now a stable, always-present field on `ContactResponse` -- any later plan in this phase (or beyond) that needs to know a contact's erasure status from the client has a field to read.
- `computeExportDisabledReason` and `EXPORT_ERASED_MESSAGE` are the single source of the erased-contact copy; a later plan should extend, not duplicate, this pattern if another action needs the same disabled-with-reason treatment.
- Outstanding human verification: 21-04-PLAN.md Task 2's `<human-check>` (live two-tab erase-then-click walkthrough against a running dev stack) was not exercised in this automated session -- carries into the phase's end-of-phase human verification pass (per `human_verify_mode: end-of-phase` in config.json), alongside 21-01's already-carried human-check.
- No Phase 13 visibility filter was weakened: `anonymized_at IS NULL` predicate count in `contact.repository.ts` is unchanged (4 before, 4 after this plan).

---
*Phase: 21-per-contact-dsr-export*
*Completed: 2026-08-22*

## Self-Check: PASSED

All 6 modified files + this SUMMARY.md verified present on disk; all 4 commit hashes (`4f81426`, `e6567bb`, `728756f`, `6895f0a`) verified present in `git log --oneline --all`.
