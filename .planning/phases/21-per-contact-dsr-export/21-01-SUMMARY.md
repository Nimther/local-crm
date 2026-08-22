---
phase: 21-per-contact-dsr-export
plan: 01
subsystem: api
tags: [fastify, postgres, react-query, dsr-export, gdpr, better-auth]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: contacts.anonymizedAt / erasure_records (CMP-04 erasure)
  - phase: 15-observability-alerting-frontend-resilience
    provides: structured Pino logging + correlation context (@mega-crm/tenant-context)
provides:
  - "contact:[\"export\"] access-control resource (statement/member/admin/owner)"
  - "withTenantTransactionRepeatableRead sibling helper in @mega-crm/tenant-context"
  - "dsrExportDocumentSchema / dsrExportErasedBodySchema in @mega-crm/shared-schemas"
  - "GET /api/workspaces/:slug/contacts/:id/dsr-export route (metadata/profile/customProperties)"
  - "ExportContactButton on ContactDetailPage.tsx"
affects: [21-02-consent-history, 21-03-events-sends, 21-04-flow-campaign-sections, 21-05-isolation-race-test, 21-06-migrations-docs]

tech-stack:
  added: []
  patterns:
    - "REPEATABLE READ transaction sibling helper (BEGIN ISOLATION LEVEL REPEATABLE READ combined statement) instead of an isolation-level option on the shared READ COMMITTED helper"
    - "Conditional-render (not disabled-state) role gate for an action a Member must not see at all"
    - "Deriving inline mutation error copy from useMutation's own `error` field instead of a duplicate useState"

key-files:
  created:
    - apps/api/src/modules/contacts/dsr-export.repository.ts
    - apps/api/src/modules/contacts/dsr-export.routes.ts
    - apps/api/src/modules/contacts/__tests__/dsr-export.test.ts
    - packages/shared-schemas/src/dsr-export.ts
    - apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx
  modified:
    - apps/api/src/modules/auth/access-control.ts
    - packages/tenant-context/src/index.ts
    - packages/shared-schemas/src/index.ts
    - apps/api/src/server.ts
    - apps/api/src/__tests__/negative-cross-tenant.test.ts
    - apps/web/src/features/contacts/ContactDetailPage.tsx

key-decisions:
  - "withTenantTransactionRepeatableRead is a dedicated sibling of withTenantTransaction, not an isolation-level option threaded through it -- the existing helper's first statement is already a SELECT set_config(...), and Postgres forbids raising isolation level after any statement has run in a transaction."
  - "The 410 contact_erased catch branch is documented as deliberately distinct from contacts.routes.ts's contact_anonymized -> 404 mapping: 410 tells an authorised same-tenant DSR requester the data no longer exists; 404 hides existence from a tenant reading a live contact. Both coexist by design."
  - "ExportContactButton derives its inline error copy directly from useMutation's own `error` field (computeExportErrorMessage) instead of a parallel useState -- removes state-duplication and made the Pending/Error test cases mockable by overriding one hook's return value."
  - "D-14 (disabled-with-reason erased-contact button state) is explicitly OUT of this plan's scope -- it requires anonymizedAt on contactResponseSchema, which files_modified does not include. Confirmed with the orchestrator's advisor before implementation; deferred to a later plan in this phase."

patterns-established:
  - "Pattern: role-gated action components return `canExport ? (<div>...</div>) : null` (conditional render) rather than a disabled button, when the requirement is 'the Member must not see this at all', distinct from the disabled+tooltip pattern used for launch/schedule actions elsewhere."
  - "Pattern: vi.hoisted() + vi.mock('@tanstack/react-query') to drive a useMutation hook's pending/error state synchronously in a renderToStaticMarkup-only test lane (no jsdom/@testing-library in this repo)."

requirements-completed: [DSR-01, DSR-04]

coverage:
  - id: D1
    description: "Owner/Admin downloads a JSON export (metadata/profile/customProperties) for one contact via a REPEATABLE READ transaction whose first read is the anonymizedAt gate"
    requirement: "DSR-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#profile: an Owner gets a 200 export..."
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#admin can export..."
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#isolation level: withTenantTransactionRepeatableRead..."
        status: pass
    human_judgment: false
  - id: D2
    description: "Member is refused 403 at the API; cross-tenant/nonexistent contact id is a byte-identical 404; invalid uuid is 400; an erased contact returns a typed 410 with no document keys"
    requirement: "DSR-04"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#role guard: member is refused..."
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#cross-tenant: a contact id from another workspace..."
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#invalid contact id..."
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#erased: an anonymized contact returns a typed 410..."
        status: pass
      - kind: integration
        ref: "apps/api/src/__tests__/negative-cross-tenant.test.ts (registerDsrExportRoutes read-only ATTEMPT_CASE)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Owner/Admin see an Export action on the contact card; a Member does not see it rendered at all; pending/error states render inline"
    requirement: "DSR-04"
    verification:
      - kind: unit
        ref: "apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx#Owner/Admin/Member/Pending/Error slot (6 cases)"
        status: pass
      - kind: manual_procedural
        ref: "21-01-PLAN.md Task 3 <human-check> -- blob download + narrow-viewport wrap check, not run in this session"
        status: unknown
    human_judgment: true
    rationale: "The blob-save (URL.createObjectURL, synthetic anchor click) and the narrow-viewport wrap backstop are explicitly deferred to the phase's end-of-phase human verification (21-01-PLAN.md's own note) and were not exercised by an automated browser in this session."

duration: ~75min
completed: 2026-08-22
status: complete
---

# Phase 21 Plan 01: Per-Contact DSR Export Tracer Summary

**Owner/Admin JSON export of one contact's profile + custom properties via a new `contact:export` permission and a REPEATABLE READ transaction wrapper, with the Export button wired onto the contact card.**

## Performance

- **Duration:** ~75 min
- **Tasks:** 3 (all `tdd="true"`)
- **Files created:** 5
- **Files modified:** 6

## Accomplishments

- New `contact: ["export"]` access-control resource (statement + member/admin/owner) gates a brand-new `GET /api/workspaces/:slug/contacts/:id/dsr-export` route via the existing `requirePermission` mechanism.
- `withTenantTransactionRepeatableRead`, a sibling of `withTenantTransaction` in `@mega-crm/tenant-context`, opens `BEGIN ISOLATION LEVEL REPEATABLE READ` combined in one statement (Postgres forbids raising isolation level after any query has run in a transaction) -- the existing helper and its ~100 call sites are untouched, still `READ COMMITTED`.
- `getDsrExportDocument` reads `contacts.anonymized_at` as the FIRST statement inside that snapshot, fails closed with a typed `ContactErasedError` before assembling anything, and otherwise builds `metadata`/`profile`/`customProperties` for exactly one workspace-scoped contact.
- The full refusal triad is proven end-to-end: Member -> 403 (no document assembled, response body checked for absence of the contact's email); cross-tenant and never-existed contact ids -> byte-identical 404 (`NOT_FOUND_BODY`, asserted equal to each other, not just both 404); malformed uuid -> 400; already-erased contact -> 410 with `code: "contact_erased"`, `erasedAt`, `erasureRecordId`, and no `profile`/`customProperties`/`metadata` keys at all.
- `ExportContactButton` on `ContactDetailPage.tsx`: conditional render (`canExport ? (...) : null`), not a disabled state, so a Member never sees the action; reuses `apiGet`'s typed `ApiError` for the 403/404/410 handling; success path builds a `Blob` + synthetic anchor click with the `dsr-export-{contactId}-{date}.json` filename convention (no PII, date at download time); a 410 renders the fixed «Контакт обезличен — персональные данные удалены» copy, every other failure reuses the page's existing `GENERIC_ERROR` paragraph.

## Task Commits

Each task followed the plan's TDD RED/GREEN split:

1. **Task 1: End-to-end DSR export happy path**
   - `13f2d1e` test(21-01): add failing DSR export happy-path tests (RED)
   - `04e14f7` feat(21-01): DSR export happy path -- contact:export gate, REPEATABLE READ transaction, document assembly (GREEN)
2. **Task 2: The refusal triad**
   - `1a5a449` test(21-01): prove the DSR export refusal triad -- all four cases passed against Task 1's existing implementation (no additional production code needed), plus a fix to `negative-cross-tenant.test.ts`'s Test 6 module-coverage gate
3. **Task 3: The Export action on the contact card**
   - `516d404` test(21-01): add failing ExportContactButton markup tests (RED)
   - `2e716fb` feat(21-01): Export action on the contact card (GREEN)

**Plan metadata:** committed separately (see below), includes this SUMMARY.

_Tracer feedback gate: re-ran Task 1's `<verify>` test file after its GREEN commit (per execute-plan.md's tracer protocol) -- passed, so expansion into Task 2/3 proceeded without a checkpoint._

## Files Created/Modified

- `apps/api/src/modules/auth/access-control.ts` - new `contact: ["export"]` resource (statement + member/admin/owner)
- `packages/tenant-context/src/index.ts` - `withTenantTransactionRepeatableRead` sibling helper
- `packages/shared-schemas/src/dsr-export.ts` (new) - `dsrExportDocumentSchema`, `dsrExportMetadataSchema`, `dsrExportProfileSchema`, `dsrExportErasedBodySchema`, `DSR_EXPORT_FORMAT_VERSION`
- `packages/shared-schemas/src/index.ts` - re-exports the new module
- `apps/api/src/modules/contacts/dsr-export.repository.ts` (new) - `getDsrExportDocument`, `ContactErasedError`, `DSR_EXPORT_PAGE_LIMIT`
- `apps/api/src/modules/contacts/dsr-export.routes.ts` (new) - `registerDsrExportRoutes`, `buildDsrExportAuditLog`
- `apps/api/src/server.ts` - registers the new route module
- `apps/api/src/modules/contacts/__tests__/dsr-export.test.ts` (new) - 7 integration cases (happy path x3, refusal triad x4)
- `apps/api/src/__tests__/negative-cross-tenant.test.ts` - adds `registerDsrExportRoutes` as a read-only `ATTEMPT_CASE` (SEC-16 Test 6 coverage gate)
- `apps/web/src/features/contacts/ContactDetailPage.tsx` - `workspaceQuery`/`viewerRole`/`canExport`, `ExportContactButton`, `computeExportErrorMessage`
- `apps/web/src/features/contacts/__tests__/contact-dsr-export.test.tsx` (new) - 6 markup-level cases

## Decisions Made

- `withTenantTransactionRepeatableRead` is a dedicated sibling helper, not an option on the shared `withTenantTransaction` -- matches RESEARCH.md's resolved Open Question 2 exactly.
- The 410-vs-404 divergence between this route and `contacts.routes.ts`'s `contact_anonymized` mapping is documented inline on the catch branch, per the plan's explicit instruction not to soften 410 into 404.
- `ExportContactButton` derives its error copy from `useMutation`'s own `error` field (`computeExportErrorMessage`) rather than a parallel `useState` -- simpler, and made the component's pending/error states independently testable by overriding one mocked hook return value (`vi.hoisted` + `vi.mock("@tanstack/react-query")`).
- D-14 (disabled-with-reason erased-contact button state) is explicitly deferred -- `packages/shared-schemas/src/contact.ts`'s `contactResponseSchema` does not carry `anonymizedAt` yet and is not in this plan's `files_modified`. Confirmed via advisor consultation before implementation; a later plan in this phase must add the field before D-14 can be wired up.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `negative-cross-tenant.test.ts`'s module-coverage gate failed on the new route**
- **Found during:** Task 2 regression run (`npm run test -w apps/api -- src/__tests__/negative-cross-tenant.test.ts`)
- **Issue:** That suite's Test 6 asserts every `app.register(registerX)` module in `server.ts` has either a covered `ATTEMPT_CASE` or a documented exclusion; `registerDsrExportRoutes` was neither, since it's new this plan.
- **Fix:** Added a read-only `ATTEMPT_CASE` entry (`module: "registerDsrExportRoutes"`) reusing the existing `foreignContactId` fixture -- no `write` case, since the route is GET-only.
- **Files modified:** `apps/api/src/__tests__/negative-cross-tenant.test.ts`
- **Verification:** Suite passes 25/25 (was 24/24 before the new module existed, now 24 real cases + the coverage-gate assertion, no `write` attempt added since there is nothing to write).
- **Committed in:** `1a5a449` (Task 2 commit)

**2. [Rule 3 - Blocking] Cross-workspace `@mega-crm/*` package resolution escaped the worktree**
- **Found during:** Task 1, first RED test run.
- **Issue:** This worktree has no local `node_modules` (neither at its root nor in `apps/api`); Node's module resolution walked up past the worktree root and resolved every `@mega-crm/*` bare import from the MAIN repository checkout's `node_modules` symlinks, not this worktree's own edited copies of `packages/*`. Confirmed via a direct `withTenantTransactionRepeatableRead is not a function` failure even though the function had just been added to this worktree's `packages/tenant-context/src/index.ts`.
- **Fix:** Created `node_modules/@mega-crm/{contacts-core,db,delivery-core,flows-core,kms,queue-core,redaction,segments-core,shared-schemas,tenant-context,test-support}` symlinks at the worktree root, pointing at this worktree's own `packages/*` directories, so Node's upward node_modules walk resolves this worktree's edited sources before ever reaching the main checkout. Third-party packages (pg, zod, fastify, react, etc.) continue resolving from the main checkout's `node_modules` as before -- unaffected and correct, since those weren't modified.
- **Verification:** Re-ran the same failing test -- `withTenantTransactionRepeatableRead` resolved correctly, isolation-level assertion passed.
- **Per project safety rule 4:** these symlinks are gitignored (`node_modules/` in `.gitignore`) and were deleted before this executor returned (see below) -- they never entered any commit.

---

**Total deviations:** 2 auto-fixed (2 blocking). No scope creep -- both are test-infrastructure/coverage fixes required to prove the plan's own acceptance criteria, not new behavior.

## Issues Encountered

- **Acceptance criterion `grep -c 'fetch(' apps/web/src/features/contacts/ContactDetailPage.tsx` is 0 is unsatisfiable as literally written.** The file already contains two pre-existing `refetch()` calls (Overview/Properties tab retry handlers), and the substring `"fetch("` matches inside `"refetch("`. Satisfied the criterion's *intent* instead: a word-boundary check (`grep -cE '(^|[^a-zA-Z])fetch\('`) returns `0`, confirming no raw `fetch()` call was introduced and the export request goes through `apiGet` exclusively. The two pre-existing `refetch()` retry handlers are untouched and correctly must stay.
- **`npm run build -w apps/web` cannot run in this sandbox.** `vite` (declared in `apps/web/package.json` devDependencies) is not installed anywhere resolvable from this worktree or the main repository checkout (`find .../node_modules -iname vite*` finds only `vitest`, never `vite`). This is a pre-existing environment gap unrelated to this plan's changes -- confirmed by running `tsc --noEmit --types node` (bypassing the missing `vite/client` type-entry point) directly, which showed zero new type errors in any file this plan touched; the only remaining errors were in `apps/web/src/lib/sentry.ts` (pre-existing, untouched by this plan) and `apps/web/vite.config.ts` (missing `vite`/`@vitejs/plugin-react` modules, environment-only).
- **Two pre-existing, unrelated test failures surfaced during the full regression run, both confirmed untouched by this plan (`git status --short <file>` empty for both):**
  - `apps/api/src/__tests__/sentry.test.ts` -- "with no DSN configured..." fails deterministically on this machine because `~/.config/mega-crm/.env` carries real Sentry DSNs since the 2026-08-16 UAT session (documented pre-existing environmental issue, passes in CI).
  - `apps/web/src/__tests__/playwright-package-source-import.test.ts` -- fails because `node_modules/@playwright/test/cli.js` does not exist in this worktree (Playwright itself was never installed in this sandbox, a separate gap from the `@mega-crm/*` symlink fix above, since this test hard-codes a worktree-relative path rather than using Node's ordinary upward module resolution).
  - Full apps/api regression: 610/611 passed. Full apps/web regression: 126/127 passed. Both single failures are the two above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The document contract (`metadata`/`profile`/`customProperties`) is established and locked per 21-01-PLAN.md's Growth rule -- plans 21-02 through 21-06 must ADD sections, never re-shape these.
- `withTenantTransactionRepeatableRead`, the shared allowlist relocation target (`@mega-crm/delivery-core`), and the `DSR_EXPORT_PAGE_LIMIT` constant are all in place for later plans' keyset walks to reuse.
- D-14 (disabled-erased-button UI state) needs `anonymizedAt` added to `contactResponseSchema` before it can be wired -- flagged for whichever later plan owns that UI-SPEC item.
- Outstanding human verification: 21-01-PLAN.md Task 3's `<human-check>` (real blob download in a browser, narrow-viewport header-row wrap) was not exercised in this automated session -- carries into the phase's end-of-phase human verification pass (per `human_verify_mode: end-of-phase` in config.json).

---
*Phase: 21-per-contact-dsr-export*
*Completed: 2026-08-22*
