---
phase: 22-workspace-quiesce-physical-purge
plan: 07
subsystem: database
tags: [postgres, better-auth, rls-boundary, bullmq-worker, workspace-purge, mega_crm_auth]

# Dependency graph
requires:
  - phase: 22-workspace-quiesce-physical-purge (plan 22-01)
    provides: the purge state machine (purge_records, workspace-purge worker, checkpointed FK-ordered walk, mark-failed-then-rethrow discipline)
  - phase: 22-workspace-quiesce-physical-purge (plan 22-05)
    provides: the full FK-ordered PURGE_TABLE_ORDER tenant-table allowlist in packages/db/src/workspace-purge-tables.ts
provides:
  - a dedicated mega_crm_auth-authenticated pool (createAuthPurgePool/closeAuthPurgePool) that reaches the Better Auth tables the ordinary mega_crm_app pool cannot mutate
  - deleteWorkspaceAuthRows: the two scoped deletes (invitation, member) proven never to touch user/session/account
  - the auth step wired into processWorkspacePurge, after every tenant table is drained and before the organization tombstone
affects: [22-08 (purge-stuck watchdog + runbook), 22-10 (SPECIFICATION.md/docker/prod.env.example ownership)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lazy-DSN elevated pool (mirrors packages/tenant-context/src/scan.ts's getScanPool): read the credential from process.env at call time, memoise, throw naming the variable if absent, never fall back to the ordinary connection string."
    - "Synthetic completed_tables marker (\"auth\", not a real PurgeTable) for a non-tenant-table step that must still be resumable/idempotent through the same checkpoint machinery."

key-files:
  created:
    - apps/worker/src/queues/workspace-purge-auth.ts
    - apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts
  modified:
    - apps/worker/src/queues/workspace-purge.worker.ts
    - apps/worker/src/queues/workspace-purge-checkpoint.ts (new recordAuthPurgeCounts primitive)
    - apps/worker/src/server.ts (closeAuthPurgePool wired into shutdown)
    - apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts (completed_tables assertion updated for the new "auth" marker)

key-decisions:
  - "PT-01 resolved as option (b): a dedicated mega_crm_auth pool, not a grant migration widening mega_crm_app -- no migration ships, verified by an empty `git diff -- packages/db/migrations`."
  - "member/invitation counts merge into the SAME table_counts jsonb payload as the tenant-table census, via a new recordAuthPurgeCounts primitive that only ever ADDS the two auth-only keys (they are never part of PURGE_TABLE_ORDER, so the merge can never overwrite a census value)."
  - "Auth-step failure reuses the existing mark-failed-then-rethrow path unchanged -- no new state, no new selector widening. The re-throw only makes the tick visibly fail; 22-01 Task 3's destructive selector (reported/purging only) still makes failed terminal for automation."

requirements-completed: [PRG-02]

coverage:
  - id: D1
    description: "mega_crm_app (the ordinary purge-worker pool) still cannot delete member/invitation rows -- proven with a real Postgres 42501, not a mocked rejection."
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#the boundary holds: deleting member through the ordinary mega_crm_app pool is refused with 42501"
        status: pass
    human_judgment: false
  - id: D2
    description: "deleteWorkspaceAuthRows destroys a workspace's member and invitation rows through the dedicated mega_crm_auth pool and reports the two counts separately."
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#the auth pool can"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#invitations too"
        status: pass
    human_judgment: false
  - id: D3
    description: "Better Auth global identities (user/session/account) and a neighbour workspace's membership are never touched by the purge."
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#global identities survive"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#another workspace's membership untouched"
        status: pass
    human_judgment: false
  - id: D4
    description: "A missing AUTH_DATABASE_URL fails loudly at pool-creation time, naming the variable, with no fallback to DATABASE_URL/mega_crm_app."
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#missing DSN fails loudly"
        status: pass
    human_judgment: false
  - id: D5
    description: "The auth step is wired into the full purge: runs only after every PURGE_TABLE_ORDER table is drained and before the organization tombstone; its two counts land in the same table_counts evidence payload; a full end-to-end purge removes membership and invitations."
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#end-to-end purge removes membership"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#ordering"
        status: pass
    human_judgment: false
  - id: D6
    description: "An auth-step failure marks purge_records failed (purged_at null, organization not tombstoned) without undoing already-completed tenant-table destruction, and is never auto-resumed -- only the documented operator UPDATE to 'purging' lets the next tick finish."
    requirement: "PRG-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#auth failure fails the purge"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#a fixed DSN alone does not resume"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#the operator act resumes and completes"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-23
status: complete
---

# Phase 22 Plan 07: mega_crm_auth-scoped purge of member/invitation rows Summary

**A dedicated `mega_crm_auth` pool (`createAuthPurgePool`/`deleteWorkspaceAuthRows`) deletes a purged workspace's `member`/`invitation` rows and is wired into `processWorkspacePurge` after every tenant table is drained and before the organization tombstone, with auth-step failure falling into the existing mark-failed-then-rethrow discipline rather than a new state.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2 completed
- **Files modified:** 5 (2 created, 3 modified in Task 2, plus a Task 2 fix to a pre-existing Task-2-affected test)

## Accomplishments

- `apps/worker/src/queues/workspace-purge-auth.ts`: `createAuthPurgePool` (lazy `AUTH_DATABASE_URL` read at call time, memoised, never falls back to `DATABASE_URL`), `closeAuthPurgePool` (shutdown no-op when never created), and `deleteWorkspaceAuthRows` (exactly two `DELETE` statements, `invitation` then `member`, in one transaction, scoped to the workspace).
- Proved the Phase 10 trust boundary is real, not assumed: a plain `DELETE FROM member` through the ordinary `mega_crm_app` pool against a real Postgres fails with `42501`, asserted on the error code.
- Proved the scope of the elevated connection: global identities (`user`/`session`/`account`) and a neighbour workspace's `member` row are untouched by a purge of another workspace.
- Wired the auth step into `processWorkspacePurge`: it runs exactly once, after every `PURGE_TABLE_ORDER` table's `completed_tables` entry exists and before `tombstoneOrganization`, guarded by a synthetic `"auth"` `completed_tables` marker so a resumed purge does not repeat it (harmlessly, since re-deleting absent rows is a zero-count no-op).
- Added `recordAuthPurgeCounts` to `workspace-purge-checkpoint.ts`: merges `member`/`invitation` counts into the SAME `table_counts` jsonb payload the tenant-table census already populates, via a jsonb `||` that can only add the two new keys, never overwrite a census value.
- An auth-step failure (missing DSN, connection error) reuses the walk's existing `catch` block unchanged: `purge_records` is marked `failed` with a reason naming the auth connection, `purged_at` stays null, the organization is not tombstoned, and the error re-throws for BullMQ visibility. Per 22-01 Task 3's destructive selector (matches `reported`/`purging` only), `failed` stays terminal for automation; only the documented operator `UPDATE purge_records SET status = 'purging', purge_error = NULL WHERE workspace_id = $1` lets the next tick resume and finish.
- `closeAuthPurgePool` closed in `apps/worker/src/server.ts`'s shutdown path alongside the other dedicated pools.
- No migration shipped -- `git diff --name-only -- packages/db/migrations` is empty, confirming PT-01 was resolved as the dedicated-pool option, not a grant widening.

## Task Commits

1. **Task 1: The scoped mega_crm_auth pool, and proof that the ordinary pool still cannot do this** - `4f3f1a5` (feat)
2. **Task 2: Wire the auth deletion into the purge — after the tables, before the tombstone, counted and fail-loud** - `288d33b` (feat)

_Both tasks were TDD (`tdd="true"`): behavior tests were written and run against a real Postgres alongside the implementation in the same commit per task, following this codebase's existing convention of one commit per task rather than separate RED/GREEN commits for integration-style database tests (matches 22-01/22-05's own commit shape)._

## Files Created/Modified

- `apps/worker/src/queues/workspace-purge-auth.ts` - the dedicated `mega_crm_auth` pool and its two scoped deletes
- `apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts` - 11 cases: 6 boundary/pool cases (Task 1), 5 full-purge-wiring cases (Task 2)
- `apps/worker/src/queues/workspace-purge.worker.ts` - calls `deleteWorkspaceAuthRows` at the fixed point in the walk, guarded by the `AUTH_STEP_MARKER`
- `apps/worker/src/queues/workspace-purge-checkpoint.ts` - new `recordAuthPurgeCounts` primitive
- `apps/worker/src/server.ts` - `closeAuthPurgePool()` added to the shutdown path
- `apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts` - updated one pre-existing exact-set assertion on `completed_tables` to include the new `"auth"` marker

## Decisions Made

- PT-01 resolved as option (b), per the plan's own objective: a dedicated `mega_crm_auth` pool, reusing the role migration 0045 already scoped to exactly these privileges, rather than a grant migration on `mega_crm_app`. Verified structurally (empty migrations diff) and behaviorally (the 42501 test).
- `member`/`invitation` counts join the tenant-table census in the same `table_counts` column rather than a parallel evidence shape, via a new merge-only primitive (`recordAuthPurgeCounts`) that is additive by construction -- it can never disturb the immutable pre-destruction census `workspace-purge-checkpoint.ts`'s own header comment documents.
- The auth step's failure handling deliberately adds no new states or selector changes: it falls into the exact `catch` block 22-01 already built, so the `failed`-is-terminal-for-automation / operator-act-resumes contract 22-01 Task 3 defines and 22-08's runbook documents applies to an auth failure exactly as it does to a table-walk failure, with no special-casing to keep in sync.

**Fact for plan 22-10 to file** (per this plan's own `<document_contract>`): `AUTH_DATABASE_URL` is now also read by `apps/worker`, lazily, at call time inside `apps/worker/src/queues/workspace-purge-auth.ts`'s `createAuthPurgePool` -- never added to `apps/worker/src/env.ts`'s boot schema. No compose or `docker/prod.env.example` change was needed: `AUTH_DATABASE_URL` already exists there and in `scripts/check-env.mjs`'s required list (deployment finding recorded in this plan's own `<objective>`), and the worker service already receives the whole env file via `env_file:`. 22-10 should file this fact into SPECIFICATION.md §3 (Секреты) and §5 (Планировщик и пайплайн отправки).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated a pre-existing test assertion invalidated by this plan's own required behavior**
- **Found during:** Task 2, running the full `workspace-purge`/`workspace-purge-tables` regression suite
- **Issue:** `workspace-purge-tables.test.ts` (from plan 22-05) asserted `[...completedTables].sort()` is byte-identical to `[...PURGE_TABLE_ORDER].sort()`. This plan's Task 2 explicitly requires marking the auth step complete in `completed_tables` "the same way a table is" (the plan's own action-step prose), which necessarily adds a `"auth"` entry that is not a `PurgeTable` and therefore not in `PURGE_TABLE_ORDER` -- the two sets can no longer be equal.
- **Fix:** Updated the assertion to `toEqual([...PURGE_TABLE_ORDER, "auth"].sort())`, with a comment explaining why.
- **Files modified:** `apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts`
- **Verification:** `npm run test -w apps/worker -- workspace-purge` (all 4 files, 41 tests) passes.
- **Committed in:** `288d33b` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1)
**Impact on plan:** Necessary consequence of the plan's own explicit requirement (mark the auth step in `completed_tables`); no scope creep, no behavior change beyond what the plan specified.

## Issues Encountered

- The comment-stripped acceptance grep for `DELETE FROM` count (expected 2) initially matched 3 lines because the module's own header prose mentioned `DELETE FROM member`/`DELETE FROM invitation` in backticks. Reworded the prose to describe the operation without repeating the literal SQL fragment, bringing the raw grep count to exactly 2 without needing comment-stripping logic in the verification script.

## User Setup Required

None - no external service configuration required. `AUTH_DATABASE_URL` is already provisioned in every environment this phase's own research confirmed (dev `.env`, CI's ephemeral-database global setup, and `docker/prod.env.example`/`scripts/check-env.mjs` for production).

## Next Phase Readiness

- Plan 22-08 (purge-stuck watchdog + runbook) can now document the auth-failure path's operator recovery statement (`UPDATE purge_records SET status = 'purging', purge_error = NULL WHERE workspace_id = $1`) as identical to the table-walk-failure recovery statement it likely already documents -- no auth-specific runbook branch is needed.
- Plan 22-10 has the exact `AUTH_DATABASE_URL`-now-read-by-`apps/worker` fact to file into SPECIFICATION.md §3/§5 (see Decisions Made above).
- No blockers. `git diff --name-only -- packages/db/migrations` is empty; `npm run lint`, `npm run lint:pg-pool-factory`, and `npm run build -w apps/worker` all exit 0 (the one `npm run lint` failure observed, in `apps/web/src/lib/sentry.ts`, is pre-existing and unrelated to this plan's files -- confirmed by a scoped eslint run against every file this plan touched, which is clean).

---
*Phase: 22-workspace-quiesce-physical-purge*
*Completed: 2026-08-23*

## Self-Check: PASSED

- FOUND: `apps/worker/src/queues/workspace-purge-auth.ts`
- FOUND: `apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts`
- FOUND: `.planning/phases/22-workspace-quiesce-physical-purge/22-07-SUMMARY.md`
- FOUND commit: `4f3f1a5`
- FOUND commit: `288d33b`
