---
phase: 10-tenant-isolation-trust-boundaries
plan: 10
subsystem: api
tags: [fastify, rls, postgres, api-keys, authorization, tdd]

requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: withPreTenantLookup and the fail-closed workspace_isolation policy (plan 10-07)
provides:
  - "requireApiKeyScope enforcing contacts:read/contacts:write/events:write on every API-key route"
  - "migration 0046: backfill + new default for workspace_api_keys.scopes"
  - "route-enumeration test that fails when a future /v1/* route ships without a scope"
affects: [api-keys, contacts-api, events-api, future-scope-picker-ui]

tech-stack:
  added: []
  patterns:
    - "onRequest chain ordering: apiKeyAuth (plugin-scope addHook) always runs before requireApiKeyScope (route-level onRequest option) -- Fastify guarantees plugin hooks resolve before route-level hooks for the same lifecycle stage"
    - "one fixed vocabulary-free 403 body constant (FORBIDDEN_SCOPE_BODY), mirroring the existing UNAUTHORIZED_BODY anti-enumeration precedent"

key-files:
  created:
    - packages/db/migrations/0046_api_key_scopes_backfill.sql
    - apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts
  modified:
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/schema/api-keys.ts
    - apps/api/src/modules/api-keys/api-key-auth.ts
    - apps/api/src/modules/api-keys/api-keys.repository.ts
    - apps/api/src/modules/contacts/contacts-api.routes.ts
    - apps/api/src/modules/events/events-api.routes.ts
    - SPECIFICATION.md

key-decisions:
  - "D-06/D-07 (locked in 10-CONTEXT.md): resource:action taxonomy (contacts:read, contacts:write, events:write); backfill and enforcement ship in the same migration+code change"
  - "Migration 0046 must DISABLE/ENABLE ROW LEVEL SECURITY around its backfill UPDATE -- migration 0044's fail-closed workspace_isolation policy raises for any session with no app.current_workspace_id set, and a migration-time client never sets one"

patterns-established:
  - "requireApiKeyScope(scope) factory returning an onRequest handler, attached via the route's own options object -- the per-route scope declaration pattern future /v1/* routes must follow"

requirements-completed: [SEC-06]

coverage:
  - id: D1
    description: "Every API-key route (POST /v1/contacts, POST /v1/events) declares and enforces a required scope; a key lacking it or holding an empty scope list is refused with a vocabulary-free 403"
    requirement: "SEC-06"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts (9 tests, all pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every pre-existing API key keeps working after enforcement ships -- migration 0046 backfills the full scope set in the same change that starts enforcement"
    requirement: "SEC-06"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts#createApiKey persists the full scope set for a key created without an explicit scopes argument"
        status: pass
      - kind: integration
        ref: "npx vitest run --root apps/api (329 tests, all pass)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A route-enumeration assertion fails if a future /v1/* route ships without a corresponding scope test in this file"
    requirement: "SEC-06"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts#Test 8: every route in the API-key route modules is covered by this file"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-08-08
status: complete
---

# Phase 10 Plan 10-10: API Key Scope Enforcement Summary

**Per-route API-key scope enforcement (contacts:read/contacts:write/events:write) with a same-change backfill for every pre-existing key, wired via a `requireApiKeyScope` onRequest guard that always resolves after authentication.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-08T00:49:00+05:00 (worktree spawn)
- **Completed:** 2026-08-08T01:06:39+05:00
- **Tasks:** 3
- **Files modified:** 8 (2 created, 6 modified) + SPECIFICATION.md

## Accomplishments
- `apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts` (9 tests) covers all eight plan behaviors plus a repository-level default-scope check, written RED before any implementation existed
- Migration `0046_api_key_scopes_backfill.sql` backfills every pre-existing key to the full scope set and changes the column default, in the same migration that starts enforcement (D-07)
- `requireApiKeyScope` in `api-key-auth.ts`: one fixed `FORBIDDEN_SCOPE_BODY` for every scope and every route, registered as a route-level `onRequest` after the plugin-scope `apiKeyAuth` hook so an invalid/revoked key always gets 401, never 403
- `POST /v1/contacts` now requires `contacts:write`; `POST /v1/events` now requires `events:write`
- SPECIFICATION.md §4.2/§4.6 and §6.3/§6.7 updated with the new default, the migration's RLS bracket, the enforced vocabulary, and the 401-before-403 ordering

## Task Commits

Each task was committed atomically:

1. **Task 1: Failing tests for per-route scope enforcement (RED)** - `2a2ba7b` (test)
2. **Task 2: Migration 0046 and the enforcement path (GREEN)** - `df3d94c` (feat)
3. **Task 3: Record scope enforcement in SPECIFICATION.md** - `bf4d4b2` (docs)

**Plan metadata:** worktree final commit is `bf4d4b2` — no separate metadata commit; `.planning/` is gitignored in this repo (see repo-specific gitignore contract) so STATE.md/ROADMAP.md updates are the orchestrator's responsibility after merge.

_TDD gate sequence confirmed in git log: `test(10-10)` (RED) → `feat(10-10)` (GREEN), no `refactor(10-10)` commit was needed._

## Files Created/Modified
- `packages/db/migrations/0046_api_key_scopes_backfill.sql` - backfill UPDATE (RLS-bracketed) + column default change
- `packages/db/migrations/meta/_journal.json` - journal entry idx 46, tag `0046_api_key_scopes_backfill`
- `packages/db/src/schema/api-keys.ts` - `scopes` column default updated to the full taxonomy; doc comment rewritten
- `apps/api/src/modules/api-keys/api-key-auth.ts` - `API_KEY_SCOPES`, `ApiKeyScope`, `apiKeyScopes` request field, `requireApiKeyScope`, `FORBIDDEN_SCOPE_BODY`
- `apps/api/src/modules/api-keys/api-keys.repository.ts` - `ApiKeyLookupRow.scopes`; `lookupApiKeyById`'s SELECT now includes `scopes`
- `apps/api/src/modules/contacts/contacts-api.routes.ts` - `onRequest: requireApiKeyScope("contacts:write")` on `POST /v1/contacts`
- `apps/api/src/modules/events/events-api.routes.ts` - `onRequest: requireApiKeyScope("events:write")` on `POST /v1/events`
- `apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts` - 9 tests: full-scope success, per-route refusal, empty-scope refusal, byte-identical vocabulary-free 403, 401-not-403 ordering, management-route default, repository-level default, route-enumeration coverage
- `SPECIFICATION.md` - §4.2 (`workspace_api_keys.scopes` new default + migration 0046), §4.6 (journal count corrected to 0-46, 0045/0046 entries described, RLS-bracket deviation noted), §6.3 (scope table column), §6.7 (enforcement description replacing "no scopes")

## Decisions Made
- D-06/D-07 (from 10-CONTEXT.md, applied as written): `resource:action` taxonomy limited to the two existing route modules; backfill ships in the same migration as enforcement so no pre-existing integration 403s on its next request
- Execution-time decision: bracket migration 0046's backfill `UPDATE` with `ALTER TABLE ... DISABLE/ENABLE ROW LEVEL SECURITY` inside the migration's own single implicit transaction, rather than introducing a new role or session GUC — narrowest fix for a workspace-unscoped backfill against a table with `FORCE ROW LEVEL SECURITY` and (since migration 0044) a fail-closed policy

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Migration 0046's backfill UPDATE raised under fail-closed RLS**
- **Found during:** Task 2 (Migration 0046 and the enforcement path)
- **Issue:** Migration 0044 (prior plan, 10-07) made every `workspace_isolation` policy fail-closed: `current_setting('app.current_workspace_id')` with no `missing_ok` argument raises `unrecognized configuration parameter` when the session GUC was never set at all, rather than returning NULL. A migration file applies as a single `mega_crm_app` client with no tenant context ever set, and `workspace_api_keys` carries `FORCE ROW LEVEL SECURITY` (migration 0006), so even the owning role is subject to the policy. The plan's originally-specified bare `UPDATE workspace_api_keys SET scopes = ... WHERE scopes = '{}' OR scopes IS NULL;` therefore failed on every row, unconditionally, for every workspace — verified empirically by isolating the migration chain against a scratch database and applying files one at a time.
- **Fix:** Bracketed the backfill `UPDATE` with `ALTER TABLE workspace_api_keys DISABLE ROW LEVEL SECURITY;` before it and `ALTER TABLE workspace_api_keys ENABLE ROW LEVEL SECURITY; ALTER TABLE workspace_api_keys FORCE ROW LEVEL SECURITY;` after it, all inside the migration file's single implicit transaction (each migration file applies as one `client.query(sql)` call) — so `FORCE` is restored before commit and no concurrent connection can ever observe RLS disabled on this table. Documented inline in the migration with the full reasoning.
- **Files modified:** `packages/db/migrations/0046_api_key_scopes_backfill.sql`
- **Verification:** Isolated the full migration chain (0000-0046) against a fresh scratch database via a standalone script — confirmed 0046 applies cleanly after the fix; re-ran the full `apps/api` suite (329 tests) and `lint:migrations` (47 files, no violations)
- **Committed in:** `df3d94c` (Task 2 commit)

**2. [Rule 1 - Bug] Test 8 declared `async` with no `await`**
- **Found during:** Task 2 verification (`npm run lint`)
- **Issue:** The route-enumeration test (Test 8) was written as an `async` arrow function but performs no asynchronous work (reads `app.printRoutes()`, a synchronous call) — `@typescript-eslint/require-await` flagged it, failing `npm run lint --max-warnings=0`.
- **Fix:** Removed `async` from the test's arrow function signature.
- **Files modified:** `apps/api/src/modules/api-keys/__tests__/api-key-scopes.test.ts`
- **Verification:** `npm run lint` exits 0; re-ran the test file, still 9/9 passing
- **Committed in:** `df3d94c` (Task 2 commit, before the commit was created)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes were necessary to make the plan's own acceptance criteria (`npm run lint:migrations`, `npm run lint`, the full `apps/api` suite) pass. No scope creep — the RLS-bracket fix touches only the migration file the plan already specified, and the lint fix touches only the test file the plan already specified.

## Issues Encountered
- The worktree had no `node_modules` installed at task start (`npm ls` showed every workspace as `UNMET DEPENDENCY`) — ran `npm install` before any test could execute. Not a deviation from the plan's scope, just environment setup.
- Local Postgres/Redis were already running on the default ports (no Docker daemon available in this environment) — `packages/test-support`'s ephemeral-database provisioning worked against them without further setup.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- SEC-06 is closed: every API-key route enforces a declared scope, every pre-existing key keeps working, the refusal reveals nothing about the vocabulary, and a coverage assertion protects future routes.
- No scope-picker UI exists yet (deferred per D-07) — every key, old and new, currently holds the full scope set. A future phase introducing per-key scope narrowing has `API_KEY_SCOPES` as its vocabulary source of truth and `requireApiKeyScope` as the enforcement point already in place.
- This was the final plan (10-10) referenced by the phase's dependency chain for `wave: 7`; no other 10-xx plan `depends_on: ["10-10"]` was found in the read files, so nothing downstream is blocked by this plan specifically.

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-08*
