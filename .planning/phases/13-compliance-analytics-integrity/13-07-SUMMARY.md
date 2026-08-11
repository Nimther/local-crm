---
phase: 13-compliance-analytics-integrity
plan: 07
subsystem: database
tags: [postgres, rls, partitioning, drizzle, dedup, webhooks, sendgrid]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: "13-04's classifyOccurredAt bound (occurred_at is bounded to [now-7d, now+5min] before it can enter a partition or a dedup key)"
provides:
  - "send_events dedup identity re-based from (workspace_id, sg_event_id, occurred_at) to (workspace_id, send_id, event_type, occurred_at)"
  - "packages/db/scripts/count-send-event-duplicates.ts: operator-invoked, bounded-batched duplicate count + resolve tool"
  - "migration 0057: fail-closed pre-check, blocking parent-level unique index build, old-constraint drop"
affects: [phase-14-migration-checklist, phase-13-plan-13-12]

tech-stack:
  added: []
  patterns:
    - "Per-workspace PL/pgSQL loop (organization enumeration + set_config) as the way a migration checks a cross-tenant invariant under FORCE ROW LEVEL SECURITY, when temporarily disabling RLS (migration 0046's precedent) is not wanted"
    - "Dedicated migratePool, never shared with a pool that has run tenant-scoped SET LOCAL, for any test that applies a migration file after doing tenant-scoped seeding on the same ephemeral database"

key-files:
  created:
    - packages/db/scripts/count-send-event-duplicates.ts
    - packages/db/migrations/0057_send_events_dedup_rebase.sql
    - packages/db/src/__tests__/send-events-dedup-rebase.test.ts
    - apps/worker/src/queues/__tests__/webhook-events-dedup-rebase.test.ts
  modified:
    - packages/db/package.json
    - package.json
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/schema/send-events.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
    - apps/worker/src/queues/__tests__/webhook-open-click-counts.test.ts
    - apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts
    - SPECIFICATION.md

key-decisions:
  - "Old constraint name send_events_workspace_id_sg_event_id_occurred_at_key confirmed by applying migrations 0000-0020 to a scratch database and querying pg_constraint live, not guessed."
  - "ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX is NOT supported on partitioned tables, verified live against PostgreSQL 17.10 (the project's pinned major version) -- migration 0057 does not attempt one; ON CONFLICT matches the unique index directly."
  - "Migration 0057's fail-closed Step 0 duplicate guard cannot issue one unscoped SELECT across send_events (mega_crm_app is FORCE-RLS'd, and the bare-cast fail-closed predicate raises on a virgin connection) -- fixed with a per-workspace PL/pgSQL loop over organization + set_config, discovered and corrected while writing the migration's own test suite, not assumed."
  - "Two pre-existing tests (webhook-events-idempotency.test.ts, webhook-open-click-counts.test.ts) and one more (webhook-replay-sweep.test.ts) asserted behavior the new key structurally changes (orphan-replay dedup, same-second distinct-sg_event_id counting) -- fixed to prove their original intent under the new key rather than removed or weakened."

requirements-completed: [CMP-07]

coverage:
  - id: D1
    description: "Duplicate blast-radius count + operator-invoked bounded-batched resolution (packages/db/scripts/count-send-event-duplicates.ts)"
    requirement: CMP-07
    verification:
      - kind: unit
        ref: "packages/db/src/__tests__/send-events-dedup-rebase.test.ts#count-send-event-duplicates script (Phase 13, CMP-07, plan 13-07, Task 1)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Migration 0057: fail-closed duplicate guard, blocking unique index build on the partitioned parent, per-partition enforcement proof, old-constraint drop"
    requirement: CMP-07
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/send-events-dedup-rebase.test.ts#migration 0057 (Phase 13, CMP-07, plan 13-07, Task 2)"
        status: pass
      - kind: unit
        ref: "packages/db/src/__tests__/send-events-dedup-rebase.test.ts#migration 0057 static shape (Phase 13, CMP-07, plan 13-07, Task 2)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Worker ON CONFLICT target swapped to the rebased key; a redelivery with an unstable sg_event_id is counted exactly once; repeat-counter trade-off pinned"
    requirement: CMP-07
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-dedup-rebase.test.ts"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts, webhook-events-status.test.ts, webhook-events-suppression.test.ts, webhook-events-attribution.test.ts, webhook-events-processed.test.ts, webhook-events-sibling-drop.test.ts, webhook-events-occurred-at-bounds.test.ts"
        status: pass
    human_judgment: false

duration: 46min
completed: 2026-08-12
status: complete
---

# Phase 13 Plan 07: send_events dedup rebase (CMP-07) Summary

**Re-based send_events' dedup identity from the provider-controlled, verified-unstable `sg_event_id` onto the server-observed `(workspace_id, send_id, event_type, occurred_at)`, via migration 0057, an operator-invoked duplicate count/resolve script, and a matching `ON CONFLICT` swap in the webhook worker.**

## Performance

- **Duration:** ~46 min
- **Started:** 2026-08-12T00:34:35+05:00 (wave base commit)
- **Completed:** 2026-08-12T01:19:55+05:00
- **Tasks:** 3
- **Files modified:** 14 (4 created, 10 modified, across two commits' worth of pre-existing-test fixes and one SPECIFICATION.md update)

## Accomplishments

- `packages/db/scripts/count-send-event-duplicates.ts`: read-only per-workspace/total duplicate count under the new key (`send_id IS NOT NULL` scoped), plus a `--resolve` mode doing bounded, per-batch-committed deletion (keeping the earliest-`received_at` row, tie-broken by `id`), idempotent on a second run. No new database grant. Run against the real dev database (12 organizations): **0 duplicate groups, 0 rows to resolve** — both the count and `--resolve` paths confirmed against it directly.
- Migration `0057_send_events_dedup_rebase.sql`: fail-closed pre-check (raises naming `db:resolve-send-event-duplicates` if any duplicate under the new key survives), a single blocking `CREATE UNIQUE INDEX send_events_dedup_v2_idx` on the partitioned parent (both rejected alternatives — a non-blocking per-partition build, and moving the index build to an operator script like the duplicate cleanup — recorded with reasons in the migration header), an explicit `pg_index.indisvalid` assertion, and a final drop of the old auto-generated constraint (`send_events_workspace_id_sg_event_id_occurred_at_key`, name confirmed from a live catalog query).
- `webhook-events.worker.ts`'s `processWebhookEventBatch` insert now targets `ON CONFLICT (workspace_id, send_id, event_type, occurred_at)`, matching the new index exactly.
- Two accepted, tested trade-offs of the new key: orphan (`send_id IS NULL`) rows never dedupe against each other; two genuinely-new events of the same type on the same send in the same second collapse to one row (SendGrid's own timestamp granularity).

## Task Commits

1. **Task 1: Duplicate blast-radius count + operator-invoked batched resolution** - `7c5a857` (feat)
2. **Task 2: Migration 0057** - `e1fe6d0` (test, RED) → `b0e844e` (feat, GREEN)
3. **Task 3: ON CONFLICT swap** - `707a528` (test, RED) → `c129044` (feat, GREEN)

**Plan metadata / SPECIFICATION.md:** `8d9fcd5` (docs)

## Files Created/Modified

- `packages/db/scripts/count-send-event-duplicates.ts` — the count/resolve operator CLI (Task 1)
- `packages/db/package.json`, `package.json` — `db:count-send-event-duplicates`, `db:resolve-send-event-duplicates` scripts
- `packages/db/migrations/0057_send_events_dedup_rebase.sql`, `packages/db/migrations/meta/_journal.json` — the migration
- `packages/db/src/schema/send-events.ts` — dedup-key doc comment rewritten (not appended)
- `packages/db/src/__tests__/send-events-dedup-rebase.test.ts` — Task 1 (script behavior, pre-0057 schema) + Task 2 (migration apply behavior across three ephemeral databases, plus static-shape checks) halves
- `apps/worker/src/queues/webhook-events.worker.ts` — the `ON CONFLICT` swap + repeat-counter trade-off comments
- `apps/worker/src/queues/__tests__/webhook-events-dedup-rebase.test.ts` — the CMP-07 contract test suite (7 cases)
- `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts`, `webhook-open-click-counts.test.ts`, `webhook-replay-sweep.test.ts` — fixture fixes for pre-existing tests broken by the key change (see Deviations)
- `SPECIFICATION.md` — §4.2/§4.5/§4.6 updated for the new dedup key, index, dropped constraint, and migration entry

## Decisions Made

- **Old constraint name, verified live, not guessed:** applied migrations 0000–0020 against a scratch database and queried `pg_constraint` — `send_events_workspace_id_sg_event_id_occurred_at_key`.
- **`ADD CONSTRAINT ... UNIQUE USING INDEX` unsupported on partitioned tables, verified live:** against a scratch PostgreSQL 17.10 database (the project's pinned major version), this raises `ALTER TABLE / ADD CONSTRAINT USING INDEX is not supported on partitioned tables`. Migration 0057 does not attempt one — the unique index alone enforces uniqueness and is the `ON CONFLICT` target directly.
- **Index-build route: one blocking `CREATE UNIQUE INDEX` on the partitioned parent**, not a non-blocking per-partition build and not an operator/pre-deploy script — recorded with both rejected alternatives and their reasons in the migration header (mirrors the plan's own pre-decided text). The lock cost is accepted because `send_events` has exactly one writer (the worker), and ROADMAP R-05 stops it for the whole migration window.
- **Duplicate resolution lives entirely outside the migration** (Task 1's script), because a `DO $$ ... END $$;` block is one transaction end to end and cannot commit per batch.
- **Step 0's cross-tenant duplicate guard is a per-workspace PL/pgSQL loop, not a `NO FORCE ROW LEVEL SECURITY` toggle** (migration 0046's own precedent for a similar problem): loops `organization` (readable by `mega_crm_app` without any GUC) and calls `set_config('app.current_workspace_id', ..., true)` per iteration before counting that workspace's own duplicates. No new grant, no RLS toggle. This was **discovered as a real bug, not assumed** — the first version of the guard issued one unscoped `SELECT` and failed with `unrecognized configuration parameter` against a real ephemeral Postgres while writing this migration's own test suite (see Deviations/Issues below).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Migration 0057's Step 0 guard could not query `send_events` cross-tenant as originally written**
- **Found during:** Task 2, writing `send-events-dedup-rebase.test.ts`'s migration-apply tests
- **Issue:** The plan's Step 0 guard, as a single unscoped `SELECT ... FROM send_events GROUP BY workspace_id, ...`, cannot run: migrations apply as `mega_crm_app`, `send_events` carries `FORCE ROW LEVEL SECURITY`, and the bare-cast fail-closed `workspace_isolation` policy (migration 0044) raises `unrecognized configuration parameter "app.current_workspace_id"` on a connection that has never touched that GUC. This is not a hypothetical — it reproduced immediately against a real ephemeral Postgres.
- **Fix:** Rewrote Step 0 as a PL/pgSQL loop over `organization` (readable by `mega_crm_app` with no GUC), calling `set_config('app.current_workspace_id', ws.id::text, true)` per iteration and accumulating each workspace's own duplicate count. No new grant, no RLS toggle (unlike migration 0046's `DISABLE/ENABLE ROW LEVEL SECURITY` precedent for a structurally similar problem).
- **Files modified:** `packages/db/migrations/0057_send_events_dedup_rebase.sql`
- **Verification:** All 25 tests in `send-events-dedup-rebase.test.ts` pass, including the fail-closed-guard-raises and two-partition-independent-enforcement cases.
- **Committed in:** `b0e844e`

**2. [Rule 3 - Blocking] Test file's migration-applying pool was contaminated by prior tenant-scoped writes**
- **Found during:** Task 2, same test-writing session
- **Issue:** `applyMigrationFile` calls issued on the same `Pool` instance that had earlier run tenant-scoped `SET LOCAL app.current_workspace_id` transactions failed with `invalid input syntax for type uuid: ""` — a recycled connection reverts that custom GUC to `''` (Postgres's placeholder default), not `NULL`, once released, and the bare-cast policy then fails casting `''` to `uuid` instead of raising the virgin-connection error.
- **Fix:** Introduced a dedicated `migratePool` per ephemeral-database describe block, used ONLY for `applyMigrationsUpTo`/`applyMigrationFile`, never for tenant-scoped seeding (mirrors `relocate-default.test.ts`'s own `pool` vs `relocationPool` separation).
- **Files modified:** `packages/db/src/__tests__/send-events-dedup-rebase.test.ts`
- **Verification:** All 25 tests pass.
- **Committed in:** `b0e844e`

**3. [Rule 1 - Bug] Three pre-existing tests asserted behavior the new dedup key correctly changes**
- **Found during:** Task 3, running the required verify suite plus a broader regression check across `apps/worker`
- **Issue:**
  - `webhook-events-idempotency.test.ts`: two tests replayed orphan (`send_id: null`) fixture events expecting zero re-inserts. Under the new key, `NULL` is always distinct in a unique index, so orphan replay is NEVER deduped (an explicitly accepted trade-off of this plan) — the tests would fail asserting stale behavior.
  - `webhook-open-click-counts.test.ts`: "a second distinct open/click" used the SAME `occurred_at` as the first event, varying only `sg_event_id`. Under the new key that is now the identical dedup tuple, so the second event no longer inserts (0, not the asserted increment to 2).
  - `webhook-replay-sweep.test.ts`: the double-processing test used an orphan event, hitting the same NULL-never-dedupes issue as #1.
- **Fix:** Attached real, distinct `send_id`s (idempotency test), used a one-second-later timestamp for the "second distinct" event (open/click test — exactly the T-13-07-06 pinned trade-off), and added a real fixture send (replay-sweep test) — each fix preserves the test's ORIGINAL stated intent under the new key rather than weakening or deleting the assertion.
- **Files modified:** `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts`, `webhook-open-click-counts.test.ts`, `webhook-replay-sweep.test.ts`
- **Verification:** Full `apps/worker` suite (68 files, 470 tests) and `apps/api` suite (64 files, 409 tests) pass; `npm run build` and `npm run lint` (0 warnings) pass.
- **Committed in:** `c129044`

**4. [Rule 2 - Missing critical] SPECIFICATION.md not in this plan's files list but CLAUDE.md requires it**
- **Found during:** end of Task 3
- **Issue:** CLAUDE.md's hard rule requires any new migration/index/dropped constraint to be recorded in `SPECIFICATION.md` §4 in the same change; this plan's `files_modified` list did not include it.
- **Fix:** Updated §4.2 (new dedup key, two accepted trade-offs, the guard mechanism), §4.5 (new index row), §4.6 (journal entry 57, the per-workspace-loop precedent alongside migration 0046's).
- **Files modified:** `SPECIFICATION.md`
- **Committed in:** `8d9fcd5`

**5. [Rule 3 - Blocking] Task 1's own `<verify>` referenced a test file not in Task 1's `files_modified` list**
- **Found during:** start of Task 1
- **Issue:** Task 1's `<verify>` runs `npx vitest run --root packages/db src/__tests__/send-events-dedup-rebase.test.ts`, but that file is only listed under Task 2's `files_modified`.
- **Fix:** Created the file during Task 1 with the script-behavior half; Task 2 appended the migration-apply half to the same file, as the plan's own structure implies.
- **Files modified:** `packages/db/src/__tests__/send-events-dedup-rebase.test.ts`
- **Committed in:** `7c5a857` (Task 1 half), `e1fe6d0`/`b0e844e` (Task 2 half)

---

**Total deviations:** 5 (2 bugs auto-fixed during migration authoring, 1 bug-class auto-fixed across 3 pre-existing test files, 1 missing-critical doc update, 1 blocking-issue file-list correction)
**Impact on plan:** All fixes were necessary for correctness (the migration's guard genuinely could not run as originally specified) or for keeping pre-existing tests honest about the new, intentional behavior. No scope creep beyond what CMP-07 requires.

## Issues Encountered

- The migration's Step 0 guard, as literally specified in the plan text (a single cross-tenant `SELECT`), is not expressible under this codebase's RLS model — resolved per Deviation #1 above. This is the same class of problem migration 0046 (Phase 10) hit and solved with a temporary `NO FORCE ROW LEVEL SECURITY` toggle; 0057 solves it differently (a per-workspace loop, no RLS toggle at all), and both approaches are now documented side by side in `SPECIFICATION.md` §4.6 for a future migration author to choose between.
- `npm run db:migrate` (drizzle-kit CLI) still hangs in this dev sandbox under Node v26 (STATE.md's pre-existing operational note) — migration 0057 is proven via `npm run test:migrations` against ephemeral databases, not applied to the shared dev DB in this session. The dev DB (12 organizations, migrated to roughly `0037`) was used only as the target for the real duplicate-count run (Task 1), which needs only the `send_events` table shape from `0020` and is unaffected by that gap.

## User Setup Required

None — no external service configuration required. The operator sequence (`npm run db:count-send-event-duplicates` → `npm run db:resolve-send-event-duplicates` if non-zero → apply migrations) is recorded in migration 0057's own header for whoever runs the actual deploy; plan 13-14's phase checklist is expected to reproduce it verbatim.

## Next Phase Readiness

- CMP-07 closed: a redelivered webhook event with an unstable `sg_event_id` is now stored and counted exactly once.
- The new unique index is valid on every attached partition (proven against a two-partition, row-holding schema, not just a fresh empty one).
- Historical duplicates (currently zero against the real dev DB) are resolvable boundedly via the operator script, with `workspace_daily_rollup` totals proven unchanged by a migration apply.
- No blockers for subsequent Phase 13 plans. Plan 13-12 and plan 13-14's phase checklist should reference this plan's migration header for the exact operator sequence rather than re-deriving it.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-12*
