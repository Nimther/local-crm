---
phase: 04-broadcast-campaigns-send-pipeline
plan: 02
subsystem: infra
tags: [kms, envelope-encryption, sendgrid, shared-package, monorepo-workspace]

# Dependency graph
requires:
  - phase: 01-foundation-tenancy
    provides: apps/api/src/kms (envelope-encryption client, local/aws providers) and sendgrid-client.ts's raw-fetch validation convention
  - phase: 02-contacts-event-ingestion
    provides: the shared-package extraction precedent (tenant-context, contacts-core) apps/worker needs to reach app-agnostic logic
provides:
  - "@mega-crm/kms shared package: encryptTenantSecret, decryptTenantSecret, EncryptedSecret, importable by both apps/api and apps/worker"
  - "listTenantSendGridTemplates(apiKey) on sendgrid-client.ts: GET /v3/templates?generations=dynamic for the D-16 campaign template picker"
affects: [04-04-send-dispatch-worker, 04-07-campaign-builder]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "@mega-crm/kms follows the tenant-context/segments-core shared-package convention: type module, main/types -> ./src/index.ts, reads process.env directly (never apps/api's env.ts) to avoid a backward dependency"
    - "Thin re-export shim at the old import path (apps/api/src/kms/client.ts, local-provider.ts) to relocate an implementation into a shared package with zero churn to existing importers/tests"

key-files:
  created:
    - packages/kms/package.json
    - packages/kms/tsconfig.json
    - packages/kms/src/index.ts
    - packages/kms/src/client.ts
    - packages/kms/src/aws-provider.ts
    - packages/kms/src/local-provider.ts
    - packages/kms/src/env.ts
  modified:
    - apps/api/src/kms/client.ts (now a one-line re-export of @mega-crm/kms)
    - apps/api/src/kms/local-provider.ts (now a one-line re-export of @mega-crm/kms/src/local-provider.js)
    - apps/api/src/modules/tenancy/sendgrid-key.ts (imports encrypt/decryptTenantSecret from @mega-crm/kms)
    - apps/api/src/modules/tenancy/sendgrid-client.ts (added listTenantSendGridTemplates + SendGridDynamicTemplate)
    - apps/api/package.json (added @mega-crm/kms dep, removed @aws-sdk/client-kms — moved to packages/kms)

key-decisions:
  - "Kept apps/api/src/kms/client.ts as a re-export shim (per the plan's explicit either/or) rather than deleting and repointing every importer"
  - "Additionally added the same re-export-shim treatment to apps/api/src/kms/local-provider.ts (not explicitly listed in files_modified) so __tests__/envelope.test.ts's second describe block — which imports ../local-provider.js directly to exercise the NODE_ENV=production refusal-to-boot guard — keeps resolving without any test-file edits"
  - "packages/kms/src/env.ts has no validation library dependency (no zod) — plain process.env reads mirroring tenant-context's DATABASE_URL precedent, keeping the shared package dependency-light; apps/api's own zod-validated env.ts remains the primary boot-time guard"
  - "@aws-sdk/client-kms moved from apps/api's dependencies to packages/kms's, since aws-provider.ts (the only importer) now lives there"

patterns-established:
  - "Shared-package env pattern: packages/*/src/env.ts reads process.env directly, no import from apps/api/src/env.ts, ever"

requirements-completed: [CAMP-01, SEND-05]

coverage:
  - id: D1
    description: "@mega-crm/kms package exports encryptTenantSecret/decryptTenantSecret/EncryptedSecret, importable from both apps/api and (once 04-04 wires it) apps/worker; apps/api's existing SendGrid-key connect/recheck flow is unregressed"
    requirement: SEND-05
    verification:
      - kind: unit
        ref: "apps/api/src/kms/__tests__/envelope.test.ts (5 tests: round-trip, no plaintext-DEK leak, DEK zeroing, workspace-binding, production-boot guard)"
        status: pass
      - kind: other
        ref: "cd packages/kms && npx tsc -p tsconfig.json --noEmit"
        status: pass
      - kind: other
        ref: "cd apps/api && npx tsc -p tsconfig.json --noEmit"
        status: pass
    human_judgment: false
  - id: D2
    description: "listTenantSendGridTemplates(apiKey) added to sendgrid-client.ts: GET /v3/templates?generations=dynamic&page_size=200 with the same raw-fetch Bearer-key convention, returns [] on non-ok, no local caching, does not import @sendgrid/mail's singleton"
    requirement: CAMP-01
    verification:
      - kind: other
        ref: "grep -q listTenantSendGridTemplates && grep -q generations=dynamic apps/api/src/modules/tenancy/sendgrid-client.ts"
        status: pass
      - kind: other
        ref: "cd apps/api && npx tsc -p tsconfig.json --noEmit"
        status: pass
    human_judgment: false

duration: 9min
completed: 2026-07-06
status: complete
---

# Phase 4 Plan 2: Shared KMS package + SendGrid dynamic-template listing Summary

**Extracted envelope-encryption into `@mega-crm/kms` (worker-reachable) and added `listTenantSendGridTemplates` to sendgrid-client.ts for the campaign template picker (D-16).**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-06T13:04:16+05:00
- **Completed:** 2026-07-06T13:09:32+05:00
- **Tasks:** 2
- **Files modified:** 13

## Accomplishments
- New `@mega-crm/kms` shared package (client.ts/aws-provider.ts/local-provider.ts/env.ts moved from apps/api/src/kms), exporting `encryptTenantSecret`, `decryptTenantSecret`, `EncryptedSecret` — the missing enabler for 04-04's send-dispatch worker to decrypt a tenant's SendGrid key outside apps/api
- Package reads `KMS_PROVIDER`/`KMS_LOCAL_KEK`/`KMS_KEK_ID`/`NODE_ENV` directly from `process.env`, with zero import path back into apps/api (verified via grep — only doc comments mention apps/api, no imports)
- apps/api's SendGrid-key connect/recheck flow (`sendgrid-key.ts`) now imports encrypt/decrypt from `@mega-crm/kms`; existing 5-test KMS suite still passes unmodified
- `listTenantSendGridTemplates(apiKey)` added to `sendgrid-client.ts`: `GET /v3/templates?generations=dynamic&page_size=200`, same raw-fetch convention as `validateTenantSendGridKey`, `[]` on non-ok, handles both SendGrid response shapes (`result`/`templates`)

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract kms into the @mega-crm/kms shared package** - `7080036` (feat)
2. **Task 2: Add listTenantSendGridTemplates to sendgrid-client (D-16)** - `bf018cc` (feat)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified
- `packages/kms/package.json` - New workspace package, `@aws-sdk/client-kms` dependency moved here
- `packages/kms/tsconfig.json` - Extends root tsconfig.base.json, mirrors segments-core
- `packages/kms/src/index.ts` - Public exports: encryptTenantSecret, decryptTenantSecret, EncryptedSecret
- `packages/kms/src/client.ts` - Moved envelope-encryption client (unchanged logic, DEK zeroing preserved)
- `packages/kms/src/aws-provider.ts` - Moved AWS KMS provider (unchanged)
- `packages/kms/src/local-provider.ts` - Moved dev-only static-KEK provider (unchanged, production-boot guard preserved)
- `packages/kms/src/env.ts` - New: reads KMS_PROVIDER/KMS_LOCAL_KEK/KMS_KEK_ID/NODE_ENV from process.env directly
- `apps/api/src/kms/client.ts` - Reduced to `export * from "@mega-crm/kms"` re-export shim
- `apps/api/src/kms/local-provider.ts` - Reduced to `export * from "@mega-crm/kms/src/local-provider.js"` re-export shim (deviation, see below)
- `apps/api/src/kms/aws-provider.ts` - Deleted (moved to packages/kms/src, nothing in apps/api imported it directly)
- `apps/api/src/modules/tenancy/sendgrid-key.ts` - Import repointed to `@mega-crm/kms`
- `apps/api/src/modules/tenancy/sendgrid-client.ts` - Added `listTenantSendGridTemplates` + `SendGridDynamicTemplate`
- `apps/api/package.json` - Added `@mega-crm/kms` dependency, removed `@aws-sdk/client-kms` (now packages/kms's)

## Decisions Made
- Chose the re-export-shim path for `apps/api/src/kms/client.ts` (plan's explicit either/or) over delete-and-repoint, minimizing churn to `sendgrid-key.ts` and the existing test suite.
- `packages/kms/src/env.ts` intentionally has no validation library (no zod) — plain `process.env` reads, matching `tenant-context`'s dependency-light convention; apps/api's zod-validated `env.ts` remains the authoritative boot-time guard (`superRefine` still rejects `KMS_PROVIDER=local` under `NODE_ENV=production` before the server starts listening).
- `@aws-sdk/client-kms` moved from apps/api's `dependencies` to `packages/kms`'s, since `aws-provider.ts` (its only importer) now lives exclusively in the shared package.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added a re-export shim for apps/api/src/kms/local-provider.ts (not listed in files_modified)**
- **Found during:** Task 1 (kms extraction)
- **Issue:** The plan's frontmatter `files_modified` only names `apps/api/src/kms/client.ts` as a re-export target. But `apps/api/src/kms/__tests__/envelope.test.ts`'s second `describe` block imports `../local-provider.js` directly (relative path) to exercise the `NODE_ENV=production` refusal-to-boot guard. Moving `local-provider.ts` into `packages/kms/src/` without a shim would leave that import unresolvable, breaking the plan's own verify command (`npm run test -- kms`) and its acceptance criterion "apps/api's existing KMS test suite must pass."
- **Fix:** Added `apps/api/src/kms/local-provider.ts` as a one-line re-export (`export * from "@mega-crm/kms/src/local-provider.js"`), the same shim technique the plan explicitly sanctions for `client.ts`, applied symmetrically to the one other file the test suite reaches into directly. `packages/kms`'s `package.json` has no `exports` map, so the deep subpath import resolves via normal Node module resolution.
- **Files modified:** apps/api/src/kms/local-provider.ts
- **Verification:** `cd apps/api && npm run test -- kms` — 5/5 tests pass, including the production-boot-guard test.
- **Committed in:** 7080036 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to satisfy the plan's own stated acceptance criterion (KMS test suite must pass) without editing the test file itself. No scope creep — same shim pattern the plan already prescribed for client.ts.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required. No new environment variables introduced (KMS_PROVIDER/KMS_LOCAL_KEK/KMS_KEK_ID were already required by apps/api's env.ts since Phase 1).

## Next Phase Readiness
- 04-04's send-dispatch worker can now `import { decryptTenantSecret } from "@mega-crm/kms"` to decrypt a tenant's SendGrid key at send time (SEND-05 unblocked).
- 04-07's campaign builder has a live `listTenantSendGridTemplates` source for the D-16 template picker's "refresh list" action.
- No blockers identified for downstream plans in this wave.

---
*Phase: 04-broadcast-campaigns-send-pipeline*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 13 created/modified files verified present on disk. Both task commits (`7080036`, `bf018cc`) verified present in git log.
