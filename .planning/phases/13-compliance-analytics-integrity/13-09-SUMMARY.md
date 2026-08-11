---
phase: 13-compliance-analytics-integrity
plan: 09
subsystem: database
tags: [postgres, bullmq, drizzle, reputation, compliance, delivery-core]

requires:
  - phase: 13 (plans 13-01, 13-07)
    provides: ingress_journal/send_event_quarantine tables (migration slot precedent), send_events dedup rebase (13-07), migration 0057 as the prior migration in the chain
provides:
  - "classifyReputationRate: pure tiering function for complaint_rate / hard_bounce_rate with sourced, versioned thresholds and a volume floor"
  - "migration 0058: reputation_alert_state (keyed per workspace+metric, no RLS) and ingestion_alert_state (singleton, no RLS, seeded)"
  - "reputation-tick.worker.ts: hourly scheduled tick measuring and recording both ratios for every workspace"
affects: [13-11 (ingestion-health watchdog + reputation alert delivery, consumes reputation_alert_state and ingestion_alert_state), 15 (deferred tenant-facing reputation dashboard)]

tech-stack:
  added: []
  patterns:
    - "Keyed alert-state table (workspace_id, metric) as the explicit anti-pattern-guard against copying a singleton dead-man's-switch shape onto per-tenant data"
    - "Disjoint observed_*/alerted_* column split so a measurement writer and an alert-claim writer can never clobber each other"
    - "Per-ratio window-membership anchoring on the ratio's own numerator fact column, documented explicitly (CMP-02-style ambiguity elimination)"

key-files:
  created:
    - packages/delivery-core/src/reputation-rates.ts
    - packages/delivery-core/src/__tests__/reputation-rates.test.ts
    - packages/db/migrations/0058_reputation_and_ingestion_alert_state.sql
    - packages/db/src/schema/reputation-alert-state.ts
    - packages/db/src/schema/ingestion-alert-state.ts
    - packages/db/src/__tests__/reputation-and-ingestion-alert-state.test.ts
    - apps/worker/src/queues/reputation-tick.worker.ts
    - apps/worker/src/queues/__tests__/reputation-tick.test.ts
  modified:
    - packages/delivery-core/src/index.ts
    - packages/db/src/index.ts
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/__tests__/migrate-from-empty.test.ts
    - packages/shared-schemas/src/queues.ts
    - apps/worker/src/server.ts
    - apps/worker/src/queues/__tests__/scheduler-registration.test.ts
    - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
    - SPECIFICATION.md

key-decisions:
  - "Final threshold values: COMPLAINT_RATE_WARN=0.001, COMPLAINT_RATE_CRITICAL=0.003, HARD_BOUNCE_RATE_WARN=0.02, HARD_BOUNCE_RATE_CRITICAL=0.05, REPUTATION_WINDOW_DAYS=7, REPUTATION_MIN_DELIVERED_FLOOR=500, REPUTATION_TICK_INTERVAL_MS=3600000 (1h)"
  - "Window-membership anchoring: the shared 'delivered' denominator windows on delivered_at; each numerator windows on its own fact column (spam_reported_at / bounced_at) rather than delivered_at uniformly, so a late complaint on an older delivery still counts toward current exposure"
  - "Migration 0042's existing mega_crm_scan grants already cover this plan's only cross-tenant read (SELECT id FROM organization) -- no new grant required for the two new tables"
  - "reputation_alert_state carries a workspace_id column but deliberately gets NO RLS -- migrate-from-empty.test.ts's blanket workspace_id-bearing-table RLS invariant now carries a documented RLS_ACCEPT_EXEMPT allowlist entry citing threat T-13-09-03 (accept)"
  - "reputation-tick.worker.ts is NOT registered in queue-registry.ts, despite the plan text saying to register it -- its tick-registration Queue self-closes in a finally block immediately after boot, and queue-registry.ts's own header comment forbids registering exactly that shape (double-close risk); this matches the send-reconciler/analytics-reconciliation/webhook-replay-sweep precedent"

patterns-established:
  - "A table needing a documented, reviewed exception to a codebase-wide structural invariant test gets an explicit, named allowlist constant with an inline citation to the threat register entry that accepted the risk -- never a silent carve-out"

requirements-completed: [CMP-09]

coverage:
  - id: D1
    description: "classifyReputationRate tiers complaint_rate/hard_bounce_rate against sourced, versioned thresholds with an unbypassable volume floor"
    requirement: "CMP-09"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/reputation-rates.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "migration 0058 creates reputation_alert_state (composite PK, cascade delete, no RLS) and ingestion_alert_state (singleton, seeded, no RLS), applies from empty and incrementally"
    requirement: "CMP-09"
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/reputation-and-ingestion-alert-state.test.ts"
        status: pass
      - kind: integration
        ref: "npm run lint:migrations && npm run test:migrations"
        status: pass
    human_judgment: false
  - id: D3
    description: "reputation-tick worker measures both ratios per workspace on an hourly schedule, records every workspace (including healthy/below-floor), overwrites idempotently, and never touches alerted_tier/last_alert_sent_at"
    requirement: "CMP-09"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/reputation-tick.test.ts"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/scheduler-registration.test.ts (reputation-tick scheduler describe block)"
        status: pass
    human_judgment: false

duration: ~70min
completed: 2026-08-11
status: complete
---

# Phase 13 Plan 09: Reputation Rate Measurement Summary

**Pure complaint/hard-bounce rate tiering with versioned Gmail/Yahoo thresholds, a keyed (never-singleton) per-workspace-per-metric alert-state table, and an hourly scheduled tick that measures every tenant's reputation without pausing, throttling, or blocking any sending.**

## Performance

- **Tasks:** 3/3 completed
- **Files created:** 8
- **Files modified:** 9

## Accomplishments

- `classifyReputationRate` (`packages/delivery-core`) tiers a complaint or hard-bounce ratio against sourced, versioned thresholds (`0.1%`/`0.3%` complaint, `2%`/`5%` hard-bounce) with a `REPUTATION_MIN_DELIVERED_FLOOR = 500` volume gate that returns tier `none` with a null rate rather than a misleadingly precise percentage on thin data. Every threshold constant documents its `>=` inclusivity explicitly, per REVIEWS.md's LOW finding.
- Migration `0058` adds `reputation_alert_state`, keyed `PRIMARY KEY (workspace_id, metric)` — the specific anti-pattern (copying an existing watchdog's singleton shape onto per-tenant data) 13-RESEARCH.md's Pitfall 5 warned against — with `observed_*` and `alerted_*` columns disjoint so this plan's tick and plan 13-11's future watchdog claim can never clobber each other. Also adds `ingestion_alert_state`, a singleton dead-man's-switch table for plan 13-11's ingestion-health watchdog, created here because this wave owns the phase's one migration slot.
- `reputation-tick.worker.ts` runs hourly (`upsertJobScheduler`, stable id `reputation-tick`), enumerates every workspace via `withCrossWorkspaceScan`, and inside each workspace's own `withTenant`/`withTenantTransaction` scope computes both ratios from `sends`' existing fact columns, tiers them, and upserts the observation — recording every workspace (including healthy and below-floor ones) so an unmeasured tenant is distinguishable from a healthy one.

## Task Commits

1. **Task 1: Pure reputation rate tiering with versioned thresholds** - `d14b34e` (feat)
2. **Task 2: Keyed alert-state tables and migration apply** - `75fd1bd` (feat)
3. **Task 3: Scheduled reputation tick computing both ratios per workspace** - `437b1d9` (feat)

**Plan metadata:** (this SUMMARY commit)

## Files Created/Modified

- `packages/delivery-core/src/reputation-rates.ts` - pure `classifyReputationRate` + versioned threshold constants
- `packages/delivery-core/src/__tests__/reputation-rates.test.ts` - boundary-pinned tests for every threshold
- `packages/db/migrations/0058_reputation_and_ingestion_alert_state.sql` - the two new tables + seed
- `packages/db/src/schema/{reputation-alert-state,ingestion-alert-state}.ts` - type-inference-only Drizzle declarations
- `packages/db/src/__tests__/reputation-and-ingestion-alert-state.test.ts` - schema-level constraint proofs
- `packages/db/src/__tests__/migrate-from-empty.test.ts` - documented `RLS_ACCEPT_EXEMPT` allowlist
- `apps/worker/src/queues/reputation-tick.worker.ts` - the scheduled worker
- `apps/worker/src/queues/__tests__/reputation-tick.test.ts` - end-to-end tick behavior + cross-tenant isolation
- `apps/worker/src/queues/__tests__/scheduler-registration.test.ts` - dedicated `reputation-tick` scheduler describe block
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` - `ReputationTick` added to the coverage gate's `COVERED_FAMILIES`
- `packages/shared-schemas/src/queues.ts` - `REPUTATION_TICK_SCHEMA_VERSION`/`reputationTickJobSchema`
- `apps/worker/src/server.ts` - 18th registered worker
- `SPECIFICATION.md` - migration 0058, table/RLS-exception counts, worker/queue counts, new §5.14

## Decisions Made

- Final constant values, window anchoring, and grant-coverage findings: see `key-decisions` in frontmatter above.
- Window-membership anchoring is a planner decision the task required to be stated in a comment (13-RESEARCH.md flagged this as an open ambiguity): the shared "delivered" denominator windows on `delivered_at`; each metric's numerator windows on its OWN fact column (`spam_reported_at`/`bounced_at`). This means a send delivered outside the 7-day window but complained about inside it still counts toward the current complaint exposure — matching what a mailbox provider actually judges (recent complaint volume), not complaints paired to recently-delivered mail.
- `HARD_BOUNCE_RATE_CRITICAL = 0.05` and `REPUTATION_MIN_DELIVERED_FLOOR = 500` are both planner defaults without an in-repo or external precedent (13-RESEARCH.md Open Question 2) — recorded honestly in the code comments as reasoned defaults expected to be tuned against real tenant volume distributions, not measured constants.
- Migration 0042's existing `mega_crm_scan` grant list already covers this plan's only cross-tenant read (`SELECT id FROM organization`) — no new grant was required for either new table.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `migrate-from-empty.test.ts`'s blanket workspace_id-bearing-table RLS invariant needed a documented exemption**
- **Found during:** Task 2 (migration apply verification)
- **Issue:** `reputation_alert_state` carries a `workspace_id` column (required for its composite PK and FK) but the plan explicitly and repeatedly specifies NO tenant `workspace_isolation` policy for it (threat T-13-09-03, disposition: accept). The pre-existing structural drift-guard test asserts "every workspace_id-bearing table must have RLS ENABLE+FORCE" with no exemption mechanism, so it failed against the new table.
- **Fix:** Added an explicit `RLS_ACCEPT_EXEMPT` allowlist constant to `migrate-from-empty.test.ts`, naming `reputation_alert_state` with an inline comment citing threat T-13-09-03, migration 0058's own table comment, and the Phase 15 remedy (a future tenant-facing dashboard must add a real policy and remove this exemption). The test also asserts the exempted table still exists in the workspace_id-bearing result set, so a rename/drop of the table fails the guard loudly instead of silently widening the exemption.
- **Files modified:** `packages/db/src/__tests__/migrate-from-empty.test.ts`
- **Verification:** `npm run test:migrations` exits 0; `packages/tenant-context` suite still shows exactly 25 `workspace_isolation` policies (unaffected, since this table never had one).
- **Committed in:** `75fd1bd` (Task 2 commit)

**2. [Rule 3 - Blocking] `reputation_alert_state`'s `ON DELETE CASCADE` verified via catalog introspection, not a live `DELETE FROM organization`**
- **Found during:** Task 2 (writing the cascade behavior test)
- **Issue:** Migration `0045` (Phase 10) revoked ALL privileges from `mega_crm_app` on `invitation`/`member` (re-granting only SELECT). Postgres's FK cascade-enforcement trigger for a referencing table runs under that table's OWNER privileges regardless of which role issues the top-level `DELETE` — confirmed empirically (including as a genuine cluster superuser) that `DELETE FROM organization` now always fails with `permission denied for table invitation` before it can reach any other referencing table, including `reputation_alert_state`. This is a pre-existing, unrelated limitation: organizations are hard-deletable by nothing in this codebase today (`workspaces.ts`'s delete route only ever sets `deletedAt`).
- **Fix:** Replaced the live-delete cascade test with a `pg_constraint` catalog assertion (`confdeltype = 'c'`, `confrelid = organization`) documenting why a live delete cannot be exercised here, rather than silently reversing Phase 10's security boundary or leaving the acceptance criterion unverified.
- **Files modified:** `packages/db/src/__tests__/reputation-and-ingestion-alert-state.test.ts`
- **Verification:** `npm run test:migrations` exits 0.
- **Committed in:** `75fd1bd` (Task 2 commit)

**3. [Rule 3 - Blocking] `reputation-tick.worker.ts` NOT registered in `queue-registry.ts`, despite the plan text**
- **Found during:** Task 3 (worker construction)
- **Issue:** The plan's action text says "Register the queue name in `apps/worker/src/queues/queue-registry.ts`." That file's own header comment explicitly forbids registering a tick-registration `Queue` that already self-closes in a `finally` block right after boot (as `send-reconciler.worker.ts`/`analytics-reconciliation.worker.ts`/`webhook-replay-sweep.worker.ts` — this plan's own cited read-first models — all correctly do not), because doing so would double-close an already-closed handle.
- **Fix:** Followed the established codebase convention instead of the plan's literal instruction: `reputation-tick.worker.ts` is not registered in `queue-registry.ts`, matching every sibling self-closing tick worker.
- **Files modified:** none beyond `apps/worker/src/queues/reputation-tick.worker.ts` itself (no registry entry added)
- **Verification:** `queue-core-single-definition.test.ts` and `scheduler-registration.test.ts` both pass; no double-close warning in any test run.
- **Committed in:** `437b1d9` (Task 3 commit)

**4. [Rule 3 - Blocking] Added `ReputationTick` to `negative-cross-tenant-jobs.test.ts`'s coverage gate**
- **Found during:** Task 3 (server.ts wiring)
- **Issue:** That file's "Test 5" coverage gate fails if any `create*Worker(` call in `server.ts` is neither in `COVERED_FAMILIES` nor `EXCLUDED_FAMILIES`. Adding `createReputationTickWorker(...)` to `server.ts` tripped this gate.
- **Fix:** Added `"ReputationTick"` to `COVERED_FAMILIES` with a comment pointing to `reputation-tick.test.ts`'s own cross-tenant isolation proof (two workspaces seeded, each workspace's own sends counted, never a sibling's).
- **Files modified:** `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
- **Verification:** `negative-cross-tenant-jobs.test.ts` passes (16/16 tests).
- **Committed in:** `437b1d9` (Task 3 commit)

**5. [Rule 1/3] Task 2's TDD behavior list needed a dedicated schema-level test file**
- **Found during:** Task 2
- **Issue:** The task carries `tdd="true"` with concrete behavior/acceptance criteria (duplicate `(workspace_id, metric)` rejected, `id=2` rejected on `ingestion_alert_state`, exactly one seed row, workspace-delete cascade) but no application module exists yet to exercise them against (the reputation tick worker is Task 3, plan 13-11's watchdog doesn't exist yet).
- **Fix:** Wrote `packages/db/src/__tests__/reputation-and-ingestion-alert-state.test.ts` exercising the raw SQL constraints directly against an ephemeral, fully-migrated database, covering every behavior/acceptance criterion in the task.
- **Files modified:** `packages/db/src/__tests__/reputation-and-ingestion-alert-state.test.ts` (new)
- **Verification:** 9/9 tests pass.
- **Committed in:** `75fd1bd` (Task 2 commit)

**6. Task 1's single feat commit (no separate RED commit)**
- Task 1 was written test-and-implementation together rather than as a strict RED-then-GREEN two-commit sequence — the test file and `reputation-rates.ts` were authored in the same pass and committed together once both passed. Not a correctness issue (all 12 tests in `reputation-rates.test.ts` pass and pin every boundary from the behavior list), just noting the TDD gate sequence for this task is a single `feat` commit rather than `test` → `feat`.

---

**Total deviations:** 6 (4 blocking, 1 blocking test-authoring gap, 1 process note)
**Impact on plan:** All fixes were necessary to keep the plan's own stated invariants true (the RLS exemption and cascade catalog test both preserve, rather than weaken, Phase 10's security boundaries) or to follow the codebase's own established conventions where they conflicted with the plan's generic instruction text (queue-registry registration). No scope creep — no new tables, queues, or application surface beyond what the plan specified.

## Issues Encountered

- **`npm run verify:redis-config` fails locally, unrelated to this plan.** A local Redis daemon is already running on port 6379 outside the project's `docker/redis.conf`-based throwaway-server mechanism (`maxmemory=0`, `appendonly=no` instead of the required `maxmemory>0`/`appendonly=yes`). This is a pre-existing local environment configuration gap, not a regression from this plan — no code in this plan touches Redis configuration, and every BullMQ-facing test in this plan's own suite (which boots its own throwaway `redis-server` via `@mega-crm/test-support`'s `startTempRedis`) passes cleanly. Flagged here rather than silently worked around.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `reputation_alert_state` and `ingestion_alert_state` are schema-provisioned and populated (the tick writes an observation for every workspace on every run); plan 13-11 can build its watchdog claim directly against both tables using the exact column names/semantics documented in migration 0058's own comments and this plan's `key_links`.
- No blockers. `ingestion_alert_state` is currently write-once (the seed row) and read/written by nothing else yet — expected, since plan 13-11 owns wiring a reader/writer to it.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-11*
