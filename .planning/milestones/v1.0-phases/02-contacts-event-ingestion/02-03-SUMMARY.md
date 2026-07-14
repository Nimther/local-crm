---
phase: 02-contacts-event-ingestion
plan: 03
subsystem: auth
tags: [api-keys, fastify, crypto, sha256, timingSafeEqual, rls, postgres, drizzle, react, react-hook-form]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion (plan 01)
    provides: contacts/suppressions/property-registry schema + RLS pattern this plan's migration follows
provides:
  - workspace_api_keys table (id/workspace_id/name/secret_hash/key_mask/scopes/created_at/revoked_at)
  - generateApiKey() + apiKeyAuth onRequest hook -- the auth mechanism 02-04/02-06's Contacts/Event API will run behind
  - Owner/Admin-gated key management routes (create/list/revoke) + settings UI
  - apiKeys access-control resource (owner+admin: create/revoke; member: none)
affects: [02-04 (Contacts API), 02-06 (Event API), any future server-to-server integration surface]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Non-session API-key auth via onRequest hook (Pattern 3): resolves workspace_id from a Bearer mcrm_<id>.<secret> key before body parsing"
    - "Dual-permissive-policy RLS: a table can carry both a tenant-scoped workspace_isolation policy AND a narrowly-scoped SELECT-only policy for a pre-tenant-context lookup, without weakening isolation for writes"

key-files:
  created:
    - packages/db/src/schema/api-keys.ts
    - packages/db/migrations/0005_open_lord_hawal.sql
    - packages/db/migrations/0006_api_keys_rls_policies.sql
    - packages/shared-schemas/src/api-key.ts
    - apps/api/src/modules/api-keys/api-key-auth.ts
    - apps/api/src/modules/api-keys/api-keys.repository.ts
    - apps/api/src/modules/api-keys/api-keys.routes.ts
    - apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts
    - apps/api/src/modules/api-keys/__tests__/api-keys-management.test.ts
    - apps/web/src/features/api-keys/ApiKeysSettings.tsx
  modified:
    - packages/db/src/index.ts
    - packages/shared-schemas/src/index.ts
    - apps/api/src/modules/auth/access-control.ts
    - apps/api/src/server.ts
    - apps/web/src/App.tsx
    - apps/web/src/features/app-shell/AppShell.tsx

key-decisions:
  - "workspace_api_keys carries a second, SELECT-only RLS policy (api_key_runtime_lookup) scoped to a single primary-key id via app.api_key_lookup_id, so apiKeyAuth can resolve workspace_id before any tenant context exists, without weakening workspace_isolation for the tenant-scoped management CRUD (T-02-03-05)"
  - "workspace_isolation on workspace_api_keys uses NULLIF(current_setting(...), '')::uuid rather than a bare cast, because lookupApiKeyById is the first read in the codebase to run outside withTenantTransaction on a possibly-reused pooled connection"

patterns-established:
  - "Pattern 3 (api-key-auth.ts): generateApiKey() + apiKeyAuth onRequest hook is the template every future server-to-server integration route reuses"

requirements-completed: [CONT-03, EVNT-01]

coverage:
  - id: D1
    description: "Owner/Admin can create multiple named API keys per workspace and revoke each independently"
    requirement: "CONT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/api-keys/__tests__/api-keys-management.test.ts#Owner creates a named key -- the response includes the full secret exactly once, and a subsequent list never returns it (D-21/D-22)"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/api-keys/__tests__/api-keys-management.test.ts#Admin can create and revoke keys"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/api-keys/__tests__/api-keys-management.test.ts#Member is forbidden (403) from both creating and revoking keys (D-21)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The full secret is returned exactly once at creation; only a SHA-256 hash + display mask is ever persisted"
    requirement: "CONT-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts#the stored row holds only a hash + mask -- never the plaintext secret (D-22)"
        status: pass
    human_judgment: false
  - id: D3
    description: "apiKeyAuth resolves workspace_id from a Bearer mcrm_<id>.<secret> key and rejects every invalid case (missing/malformed/unknown/wrong-secret/revoked) with a uniform 401 body"
    requirement: "EVNT-01"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts#valid key: sets request.apiKeyWorkspaceId to the key's workspace"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts#unknown-prefix and known-prefix-wrong-secret produce an IDENTICAL 401 body (T-02-03-02: uniform 401, no enumeration oracle)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts#revoked key -> 401"
        status: pass
    human_judgment: false
  - id: D4
    description: "API keys settings UI -- masked key list with status, create dialog with one-time secret reveal, revoke confirmation"
    human_judgment: true
    rationale: "Visual/interaction correctness (dialog copy, copy-to-clipboard, role-gated hiding) is not exercised by the automated test suite -- needs human UAT per project convention (human_verify_mode: end-of-phase)."

# Metrics
duration: 16min
completed: 2026-07-04
status: complete
---

# Phase 2 Plan 3: API Keys (Auth + Management) Summary

**Workspace-scoped API keys with mcrm_<id>.<secret> format, SHA-256 hash + timingSafeEqual verification, Owner/Admin-gated management routes, and a settings UI with a one-time secret reveal**

## Performance

- **Duration:** 16 min
- **Started:** 2026-07-04T08:13:17Z
- **Completed:** 2026-07-04T08:28:48Z
- **Tasks:** 3
- **Files modified:** 19

## Accomplishments
- `workspace_api_keys` table + RLS migration, following the project's shared-schema+RLS pattern with a novel dual-policy design that lets the runtime auth hook read a single key by id before any tenant context exists
- `generateApiKey()` (256-bit secret, SHA-256 hash, prefix+last4 mask) and the `apiKeyAuth` onRequest hook, verified with `crypto.timingSafeEqual` and a uniform 401 across every failure path (missing/malformed/unknown/wrong-secret/revoked)
- Owner/Admin-gated management routes (create/list/revoke) wired through the existing `requirePermission`/`access-control.ts` role-gate pattern, with the full secret returned exactly once at creation
- API keys settings UI: masked key table, create dialog with a one-time secret reveal + copy button, revoke `AlertDialog` with the exact D-21 confirmation copy, route + nav wired

## Task Commits

1. **Task 1: Failing tests for api-key auth (crypto + uniform 401) and management routes (role gating)** - `3972c15` (test)
2. **Task 2: [BLOCKING] api-keys schema + migration + crypto + repository + management routes + access-control** - `b488e11` (feat)
3. **Task 3: API keys settings UI -- masked list + create dialog (secret-once) + revoke confirm** - `9ddbcb8` (feat)

**Plan metadata:** (this commit)

## Files Created/Modified
- `packages/db/src/schema/api-keys.ts` - `workspace_api_keys` Drizzle table definition
- `packages/db/migrations/0005_open_lord_hawal.sql` - drizzle-kit-generated table + FK
- `packages/db/migrations/0006_api_keys_rls_policies.sql` - hand-authored ENABLE+FORCE+workspace_isolation, plus the SELECT-only `api_key_runtime_lookup` policy
- `packages/shared-schemas/src/api-key.ts` - `createApiKeySchema`/`apiKeyListItemSchema`/`apiKeyCreatedSchema`
- `apps/api/src/modules/auth/access-control.ts` - `apiKeys: ["create","revoke"]` granted to owner+admin
- `apps/api/src/modules/api-keys/api-key-auth.ts` - `generateApiKey()` + `apiKeyAuth` onRequest hook
- `apps/api/src/modules/api-keys/api-keys.repository.ts` - `createApiKey`/`listApiKeys`/`revokeApiKey` (tenant-scoped) + `lookupApiKeyById` (non-tenant, id-scoped)
- `apps/api/src/modules/api-keys/api-keys.routes.ts` - `registerApiKeyRoutes` (create/list/revoke)
- `apps/api/src/server.ts` - registers `registerApiKeyRoutes`
- `apps/web/src/features/api-keys/ApiKeysSettings.tsx` - masked list + create/revoke UI
- `apps/web/src/App.tsx` / `apps/web/src/features/app-shell/AppShell.tsx` - route + nav link

## Decisions Made
- **Dual RLS policy for `workspace_api_keys`**: kept the standard `workspace_isolation` policy (covers all tenant-scoped reads/writes via `withTenantTransaction`) and added a second, SELECT-only `api_key_runtime_lookup` policy gated on `app.api_key_lookup_id`, so `lookupApiKeyById` can resolve `workspace_id` from the key alone -- before any `:slug`/session exists to derive a tenant context from -- without opening cross-tenant read access for anyone who hasn't already set that GUC to the exact non-secret id they possess.
- **NULLIF guard on the tenant policy's cast**: `workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid` rather than a bare cast, because `lookupApiKeyById`'s pooled connection can carry a leftover `''` (not `NULL`) GUC value from a previously-committed, unrelated `SET LOCAL` on the same physical connection -- casting `''` to `uuid` throws a 500, not a graceful non-match. Every other table's `workspace_isolation` policy is safe without this guard because those tables are only ever queried inside `withTenantTransaction`, which always sets a real value first.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] NULLIF guard added to workspace_api_keys' workspace_isolation RLS policy**
- **Found during:** Task 2 (first test run against the applied migration)
- **Issue:** `current_setting('app.current_workspace_id', true)::uuid` threw `invalid input syntax for type uuid: ""` (500) when `lookupApiKeyById`'s pooled connection had previously carried a real tenant GUC that reverted to `''` (not `NULL`) after an earlier transaction committed -- 3 of 11 Task 1 tests failed with 500s.
- **Fix:** Rewrote the policy predicate as `NULLIF(current_setting(...), '')::uuid`, converting the leftover `''` to a true `NULL` before casting, so the comparison evaluates to `NULL` (excluded) instead of erroring. Applied the fix directly to both the dev and test databases (via a small corrective script) and folded it into migration `0006` before committing, so no broken intermediate state was ever committed.
- **Files modified:** `packages/db/migrations/0006_api_keys_rls_policies.sql`
- **Verification:** All 11 api-key tests pass; full `apps/api` suite (63/63) green.
- **Committed in:** `b488e11` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary for correctness of the novel non-tenant-context read path this plan introduces. No scope creep -- the fix is scoped to the one migration file this plan owns.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `apiKeyAuth` and `generateApiKey()` are ready for 02-04 (Contacts API) and 02-06 (Event API) to register routes behind, per Pattern 3.
- The dual-RLS-policy technique (tenant-scoped + narrowly-scoped pre-tenant-context SELECT) is a reusable precedent for any future non-session auth surface that needs to resolve tenant identity from a presented credential.
- Human UAT still needed for the settings UI (dialog copy, copy-to-clipboard, role-gated hiding) per `human_verify_mode: end-of-phase`.

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-04*

## Self-Check: PASSED

All 10 created files verified present on disk; all 4 task/summary commit hashes (`3972c15`, `b488e11`, `9ddbcb8`, `31fd7be`) verified present in git history.
