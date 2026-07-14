---
phase: 07-analytics-dashboard-send-log
plan: 06
subsystem: analytics-rollup
tags: [drizzle, postgres, rls, bullmq, webhook, reconciliation, rollup]

requires:
  - phase: 07-analytics-dashboard-send-log
    plan: 01
    provides: sends.open_count/click_count repeat-engagement counters + webhook worker's justSet gating pattern
  - phase: 06-flows-triggered-chains
    provides: campaign-scheduler.worker.ts's repeatable-tick + per-row withTenant transition shape (reused verbatim for the reconciliation worker)
provides:
  - workspace_daily_rollup table (per-workspace-per-day sent/delivered/opened/clicked/bounced/unsubscribed counters)
  - incrementWorkspaceDailyRollup(client, workspaceId, occurredAt, metric) same-transaction increment helper
  - createAnalyticsReconciliationWorker(connection) repeatable overwrite-from-source reconciliation worker
affects: [07-07-workspace-dashboard]

tech-stack:
  added: []
  patterns:
    - "Same-transaction idempotent increment (justSet gate) extended to a new rollup table, mirroring the existing campaign-counter pattern"
    - "Repeatable BullMQ tick-queue registration (self-produced/self-consumed queue, fixed jobId) reused verbatim from campaign-scheduler.worker.ts for a second, unrelated periodic job"
    - "Reconciliation overwrite (ON CONFLICT DO UPDATE SET col = EXCLUDED.col) as the deliberate architectural opposite of the incremental additive upsert -- same table, two disjoint write disciplines that must never be confused"

key-files:
  created:
    - packages/db/src/schema/workspace-daily-rollup.ts
    - packages/db/migrations/0037_workspace_daily_rollup.sql
    - apps/worker/src/queues/analytics-rollup.ts
    - apps/worker/src/queues/analytics-reconciliation.worker.ts
    - apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts
    - apps/worker/src/queues/__tests__/analytics-rollup-tenant-isolation.test.ts
    - apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts
  modified:
    - packages/db/src/index.ts
    - packages/db/migrations/meta/_journal.json
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/server.ts

key-decisions:
  - "Reconciliation's bounced_count filter groups hard-bounce (bounced_at), address-drop (dropped_at), AND spam-report (spam_reported_at) terminals together, not just bounced_at alone -- mirrors the SAME D-08 grouping the incremental webhook path already applies to bounced_count, so the reconciliation overwrite never regresses a count the incremental path had correctly raised for a drop/spam terminal (RESEARCH.md's illustrative reconcileWorkspaceDay example only checked bounced_at; extended per Rule 1 for correctness)"
  - "Reconciliation's opened_count/clicked_count are computed from sends.first_opened_at/first_clicked_at (unique-recipient, first-occurrence semantics) while the incremental path increments on every genuinely-new open/click event (repeat-count semantics) -- an intentional, plan-specified definitional difference: reconciliation only scans the small sends table (never send_events, the huge partitioned table, per the phase's explicit anti-pattern guidance), so it cannot recompute a true per-day repeat-event count from sends alone. Documented here as a known bound on the reconciliation path's precision for these two columns specifically -- sent_count/delivered_count/bounced_count/unsubscribed_count reconcile to an exact match."
  - "'sent' rollup metric is intentionally NEVER incremented by the webhook worker (a dispatched send produces no webhook event of its own) -- it exists purely as reconciliation's own contribution, matching the plan's explicit design"

requirements-completed: [ANLT-04]

coverage:
  - id: D1
    description: "A workspace_daily_rollup row exists per (workspace_id, day) with sent/delivered/opened/clicked/bounced/unsubscribed counters, RLS ENABLE+FORCE+NULLIF-guarded, applied to the dev DB"
    requirement: "ANLT-04"
    verification:
      - kind: unit
        ref: "npm run build -w packages/db && npm run db:migrate (migration 0037 applied cleanly)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A genuinely-new webhook delivered/opened/clicked/bounced/unsubscribed event increments the matching rollup metric inside the same transaction as the send_events dedup insert; a replayed batch never double-increments"
    requirement: "ANLT-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts (5/5: delivered, opened repeat, clicked, hard-bounce, unsubscribe -- each genuinely-new event increments once, replay is a no-op)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Two workspaces processed in the same run each get their own disjoint rollup row -- no cross-workspace leak"
    requirement: "ANLT-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/analytics-rollup-tenant-isolation.test.ts (1/1)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The reconciliation job overwrites (never adds to) each recent-day rollup row from a fresh COUNT over sends, including sent_count; running it twice with zero new sends leaves counts unchanged; a workspace's counts are computed only from its own sends"
    requirement: "ANLT-04"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts (3/3: fresh-count match including sent_count/grouped bounced_count, idempotent re-run x3, per-workspace scoping)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-07-14
status: complete
---

# Phase 7 Plan 6: Workspace Daily Rollup Foundation Summary

**New `workspace_daily_rollup` table maintained two ways: near-real-time incremental increments from the webhook worker's genuinely-new-event gates, and a periodic BullMQ reconciliation worker that overwrites recent days from a fresh COUNT over `sends` (the sole source of `sent_count`)**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-14
- **Tasks:** 3 (all completed)
- **Files modified:** 11 (7 created, 4 modified)

## Accomplishments

- `workspace_daily_rollup` table (migration 0037, RLS ENABLE+FORCE+NULLIF-guarded) with a `(workspace_id, day)` unique key as the `ON CONFLICT` target for both write paths, applied to the dev database
- `incrementWorkspaceDailyRollup(client, workspaceId, occurredAt, metric)` in `analytics-rollup.ts`, wired into the webhook worker's `delivered`/`bounce_hard`/`bounce_soft`-threshold/`dropped`/`spam_report`/`unsubscribe`/`group_unsubscribe` genuinely-new-event (`justSet`) branches, and alongside the unconditional per-event `open_count`/`click_count` increments for `open`/`click` -- every write happens inside the SAME transaction as the `send_events` dedup insert, so a replayed webhook batch never double-increments
- `createAnalyticsReconciliationWorker(connection)`: a repeatable BullMQ tick (mirroring `campaign-scheduler.worker.ts`'s self-produced/self-consumed queue + fixed-jobId registration shape) that enumerates all workspaces and overwrites each one's last 2 UTC days' rollup row from a fresh `COUNT(*) FILTER` scan of its own `sends`, inside a fresh `withTenant`/`withTenantTransaction` scope per workspace -- registered in `apps/worker/src/server.ts`'s `buildWorker`
- The reconciliation overwrite is the sole writer of `sent_count` (the incremental path never sets it, since a dispatched send produces no webhook event of its own)

## Task Commits

Each task was committed atomically:

1. **Task 1: workspace_daily_rollup table + migration 0037 + [BLOCKING] apply** - `b784f3f` (feat)
2. **Task 2: Incremental rollup increments in the webhook worker** - `33eecf6` (test, RED) then `86581d3` (feat, GREEN)
3. **Task 3: Repeatable reconciliation worker (overwrite, per-workspace withTenant)** - `4d99110` (test, RED) then `33c551b` (feat, GREEN)

**Plan metadata:** (this commit)

## Files Created/Modified

- `packages/db/src/schema/workspace-daily-rollup.ts` - Drizzle table definition (six `integer(...).notNull().default(0)` counters, `unique()` composite key)
- `packages/db/migrations/0037_workspace_daily_rollup.sql` - CREATE TABLE + FK + UNIQUE constraint + RLS block, applied to dev DB
- `packages/db/migrations/meta/_journal.json` - idx 37 entry
- `packages/db/src/index.ts` - registered the new schema module in the barrel
- `apps/worker/src/queues/analytics-rollup.ts` - `incrementWorkspaceDailyRollup` (fixed metric-to-column allow-list, additive upsert)
- `apps/worker/src/queues/webhook-events.worker.ts` - wired the increment call into 7 genuinely-new-event branches
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` - `reconcileWorkspaceDay` (overwrite upsert) + `createAnalyticsReconciliationWorker` (repeatable tick + per-workspace loop)
- `apps/worker/src/server.ts` - registered the reconciliation worker in `buildWorker`
- `apps/worker/src/queues/__tests__/analytics-rollup-idempotency.test.ts` - 5 tests (delivered, opened, clicked, hard-bounce, unsubscribe)
- `apps/worker/src/queues/__tests__/analytics-rollup-tenant-isolation.test.ts` - 1 test (two-workspace disjoint rows)
- `apps/worker/src/queues/__tests__/analytics-reconciliation.test.ts` - 3 tests (fresh-count match, idempotent re-run, per-workspace scoping)

## Decisions Made

- Reconciliation's `bounced_count` filter groups `bounced_at` OR `dropped_at` OR `spam_reported_at` together (all three fold into "не доставлено" per the existing D-08 convention already used by `campaigns.bounced_count` and the incremental webhook path). RESEARCH.md's illustrative `reconcileWorkspaceDay` code example only checked `bounced_at` -- extending it to all three terminal columns was necessary so reconciliation's "correctness backstop" role (Pitfall 2's stated purpose: correct any incremental drift "without ever needing to trust the incremental path as the sole source of truth") doesn't itself introduce drift by silently regressing a count the incremental path had correctly raised for a drop/spam terminal. Classified as a Rule 1 auto-fix (bug: the naive single-column filter would produce demonstrably wrong `bounced_count` values whenever a drop/spam terminal occurred on a day with no hard bounce).
- Reconciliation's `opened_count`/`clicked_count` are computed from `sends.first_opened_at`/`first_clicked_at` (unique-recipient, first-occurrence semantics) while the incremental path increments on every genuinely-new open/click event (repeat-count semantics). This is an accepted, documented definitional gap rather than a bug: reconciliation deliberately only scans the small `sends` table (never `send_events`, the fastest-growing partitioned table, per the phase's explicit anti-pattern guidance against per-tick scans of that table), so it structurally cannot recompute a true per-day repeat-open/-click count from `sends` alone. `sent_count`/`delivered_count`/`bounced_count`/`unsubscribed_count` reconcile to an exact fresh-count match; `opened_count`/`clicked_count` reconcile to a unique-recipient approximation. Flagged here for whoever builds the 07-07 dashboard read path.
- `RECONCILE_WINDOW_DAYS = 2` (today + yesterday, UTC) and `RECONCILE_INTERVAL_MS = 3 minutes` were chosen as reasonable defaults within D-08b's "a few minutes" freshness bound -- not specified as an exact literal by the plan, so implemented as named constants for easy future tuning.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Reconciliation's bounced_count filter widened from bounced_at-only to bounced_at OR dropped_at OR spam_reported_at**
- **Found during:** Task 3 implementation
- **Issue:** RESEARCH.md's illustrative `reconcileWorkspaceDay` code example (the plan's own cited reference) filtered `bounced_count` on `bounced_at` alone. Since Task 2's incremental path (established in this same plan) explicitly groups hard-bounce, soft-bounce-threshold, dropped, and spam-report terminals into the SAME `bounced_count` rollup metric (mirroring `campaigns.bounced_count`'s existing D-08 grouping), a reconciliation overwrite using only `bounced_at` would silently regress `bounced_count` to a smaller number on any day with a drop/spam-report terminal but no hard bounce -- defeating reconciliation's own stated correctness-backstop purpose.
- **Fix:** Widened the `bounced_count` `COUNT(*) FILTER` clause to `(bounced_at IS NOT NULL AND ...) OR (dropped_at IS NOT NULL AND ...) OR (spam_reported_at IS NOT NULL AND ...)`.
- **Files modified:** `apps/worker/src/queues/analytics-reconciliation.worker.ts`
- **Commit:** `33c551b`

No other deviations - the rest of the plan executed as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required. Migration 0037 was applied to the local dev database as part of Task 1.

## Next Phase Readiness

- `workspace_daily_rollup` is live in the dev DB, incrementally maintained by the webhook worker, and periodically corrected by the reconciliation worker -- ready for 07-07 (workspace dashboard) to read trend/KPI data from without scanning `sends`/`send_events`/`events`.
- Known bound for 07-07 to be aware of: `opened_count`/`clicked_count` are unique-recipient counts once reconciled (vs. repeat-event counts between reconciliation ticks) -- see Decisions above.
- No blockers identified for downstream plans in this phase.

---
*Phase: 07-analytics-dashboard-send-log*
*Completed: 2026-07-14*

## Self-Check: PASSED

All 7 created files verified present on disk; all five task commit hashes (`b784f3f`, `33eecf6`, `86581d3`, `4d99110`, `33c551b`) verified present in git history.
