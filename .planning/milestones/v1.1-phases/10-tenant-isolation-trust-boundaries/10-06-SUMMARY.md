---
phase: 10-tenant-isolation-trust-boundaries
plan: 06
subsystem: database
tags: [postgres, rls, tenant-isolation, partitioning, checkpoint-decision]

requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: "plan 10-03's extended mega_crm_scan grants/policies (0042), and Phase 9's attachPartitionCheckFirst / relocateAllDefaultRows (09-01/09-04)"
provides:
  - "attachPartitionCheckFirst's options.adminClient -- an optional elevated connection for attaching a NON-EMPTY child (used only by the DEFAULT-relocation path)"
  - "relocateMonth / relocateAllDefaultRows now REQUIRE an explicit adminClient parameter"
  - "packages/db/scripts/relocate-default-partition-rows.ts reads PARTITION_RELOCATION_ADMIN_DATABASE_URL and constructs a second, elevated Pool"
  - "Migration 0043: drops the five legacy app.admin_scan-gated policies (campaign_scheduler_due_scan, flow_runs_due_scan, flows_segment_sweep_scan, partition_relocation_admin_scan x2)"
  - "scan.test.ts negative proof: the marker grants no additional rows across five tables; catalog assertion that pg_policies references it nowhere"
affects: [10-07-rls-unification, phase-10-remaining-plans]

tech-stack:
  added: []
  patterns:
    - "A non-empty partition ATTACH needs a connection that can bypass row-level security for Postgres's own inherited-FK re-validation -- an explicit, optional adminClient parameter on attachPartitionCheckFirst, not a session GUC"
    - "An operator-only elevated DSN is scoped as narrowly as the SCAN_DATABASE_URL pattern: read by exactly one file, structurally asserted absent from every service process (P3-style test)"
    - "The everyday (always-empty-child) attach path never needs the elevated connection -- zero rows means FK validation trivially passes regardless of visibility"

key-files:
  created:
    - packages/db/migrations/0043_retire_admin_scan_guc_policies.sql
    - packages/db/src/partitions/__tests__/relocate-default-partition-rows.test.ts
  modified:
    - packages/db/src/partitions/ensure-partitions.ts
    - packages/db/src/partitions/relocate-default.ts
    - packages/db/scripts/relocate-default-partition-rows.ts
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - packages/db/src/partitions/__tests__/relocate-default.test.ts
    - packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts
    - packages/db/migrations/meta/_journal.json
    - packages/tenant-context/src/__tests__/scan.test.ts
    - ARCHITECTURE.md
    - SPECIFICATION.md
    - docs/runbooks/relocate-default-partition-rows.md

key-decisions:
  - "Checkpoint decision: option-b -- operator-only elevated DSN (PARTITION_RELOCATION_ADMIN_DATABASE_URL) for the relocation CLI's ATTACH step, keeping Phase 9's UAT'd build-then-attach operator procedure unchanged"
  - "attachPartitionCheckFirst's adminClient is OPTIONAL (defaults to the ordinary client) since the everyday ensurePartitions path never attaches a non-empty child; relocate-default.ts's relocateMonth/relocateAllDefaultRows make it REQUIRED since every call there attaches a non-empty child"
  - "New dedicated test file (relocate-default-partition-rows.test.ts) rather than extending relocate-default.test.ts for the failure-path proof -- a failed ATTACH there would leave a freestanding, un-reattachable child outside relocate-default.test.ts's own DEFAULT-discovery state machine"

patterns-established:
  - "Elevated, RLS-bypassing credentials are scoped to exactly one operator-invoked CLI script, never a service process, structurally asserted absent via a P3-style source-inspection test"

requirements-completed: [SEC-01, SEC-02]

coverage:
  - id: D1
    description: "attachPartitionCheckFirst's options.adminClient mechanism is load-bearing for a non-empty attach: fails without it, succeeds with it"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/relocate-default-partition-rows.test.ts -- both tests pass"
        status: pass
      - kind: integration
        ref: "npx vitest run --root packages/db -- 45/45 passing (8 test files)"
        status: pass
    human_judgment: false
  - id: D2
    description: "No first-party source sets the legacy cross-tenant marker session variable; the relocation path works under the elevated-adminClient mechanism with full regression coverage"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "npm run lint:session-state -- 312 files checked, no violations"
        status: pass
      - kind: other
        ref: "grep -rn \"set_config('app.admin_scan'\" across the repo -- only remaining hit is scan.test.ts's own negative test"
        status: pass
      - kind: integration
        ref: "packages/db/src/partitions/__tests__/relocate-default.test.ts and boundary-crossing-late-automation.test.ts -- Phase 9 regression suite, all passing under the new required adminClient parameter"
        status: pass
    human_judgment: false
  - id: D3
    description: "Migration 0043 drops the five legacy marker-gated policies; a seeded negative test proves the marker grants no additional rows across five tables; a catalog assertion proves no policy references it"
    requirement: "SEC-02"
    verification:
      - kind: integration
        ref: "npm run lint:migrations -- 44 files checked, no violations"
        status: pass
      - kind: integration
        ref: "packages/tenant-context/src/__tests__/scan.test.ts -- 10-06 Test 1 (seeded negative proof) and Test 2 (pg_policies catalog assertion) -- 12/12 passing"
        status: pass
      - kind: integration
        ref: "npx vitest run --root packages/tenant-context -- 19/19 passing; npx vitest run --root apps/worker -- 125/125 passing"
        status: pass
    human_judgment: false

duration: unrecorded (session interrupted by worktree fault; wall-clock not tracked)
completed: 2026-08-07
status: complete
---

# Phase 10 Plan 06: Retire the admin-scan marker GUC and resolve the partition-relocation trust boundary Summary

**Migration 0043 drops the last five `app.admin_scan`-gated RLS policies and `attachPartitionCheckFirst` gains an explicit, optional `adminClient` parameter — an operator-only elevated DSN (`PARTITION_RELOCATION_ADMIN_DATABASE_URL`) that replaces the session-marker GUC for DEFAULT-partition relocation's non-empty ATTACH step, per the checkpoint's selected option-b.**

## Performance

- **Duration:** not recorded — the executor session was interrupted mid-plan by an infrastructure fault (see Deviations) and resumed under a different execution mode; all implementation work itself completed in a single continuous session before the interruption.
- **Tasks:** checkpoint decision + 3/3 auto tasks completed
- **Files modified:** 11 (7 in Task 1, 3 in Task 2, 3 in Task 3 — one file, `packages/db/migrations/meta/_journal.json`, is Task 2's; `ARCHITECTURE.md`/`SPECIFICATION.md`/runbook are Task 3's)

## Checkpoint Decision

The plan's first task was a `checkpoint:decision` (blocking): how does the DEFAULT-partition relocation path obtain the cross-workspace row visibility Postgres's automatic FK re-validation needs when attaching a NON-EMPTY child partition, once the marker-GUC policy that currently supplies it is deleted? Three options were presented (attach-empty-then-move, operator-only elevated DSN, keep one marker-gated policy).

**The human operator selected option-b** (operator-only elevated DSN) via the orchestrator, with explicit implementation guidance: keep Phase 9's build-then-attach relocation procedure and its UAT'd operator flow intact; the CLI obtains a dedicated elevated DSN for the attach step; delete the marker-GUC policies and the `SET LOCAL app.admin_scan` touchpoint; include a structural assertion that neither `apps/api/src` nor `apps/worker/src` reads the elevated DSN; document the credential; keep `npm run lint:session-state` green.

## Accomplishments

- **Task 1 — `options.adminClient` mechanism:** `attachPartitionCheckFirst` (`packages/db/src/partitions/ensure-partitions.ts`) no longer sets `app.admin_scan` anywhere; it now accepts an optional `options.adminClient` — when supplied, the whole five-statement CHECK-constraint-first sequence runs on a connection checked out of it instead of the ordinary `client`. The everyday `ensurePartitions` call path (always an empty new month) never supplies it. `relocate-default.ts`'s `relocateMonth`/`relocateAllDefaultRows` make `adminClient` a REQUIRED second parameter (every call there attaches a non-empty child, so there is no legitimate omission), threaded straight through to `attachPartitionCheckFirst`. The CLI (`packages/db/scripts/relocate-default-partition-rows.ts`) reads `PARTITION_RELOCATION_ADMIN_DATABASE_URL`, fails fast with a descriptive error before opening any connection if it is absent, and constructs a second, dedicated `Pool` from it. `partition-maintenance.worker.ts`'s dedicated-pool comment updated for accuracy (no logic change — its call path never attaches a non-empty child).
- **New test file `relocate-default-partition-rows.test.ts`:** proves the mechanism is load-bearing end-to-end against a real freestanding non-empty child — attaching WITHOUT `adminClient` fails with a spurious FK violation, attaching the SAME child WITH the elevated `adminClient` succeeds and the row is readable through the parent under the owning workspace's ordinary tenant context afterward. Also carries the P3-style structural check (mirroring plan 10-01's pattern): no file under `apps/api/src` or `apps/worker/src` reads `process.env.PARTITION_RELOCATION_ADMIN_DATABASE_URL`; only the CLI script does.
- **Existing Phase 9 relocation suites updated for the new required parameter:** `relocate-default.test.ts` and `boundary-crossing-late-automation.test.ts`'s Scenario A both gained a `relocationAdminPool` built from the ephemeral database's own Postgres superuser DSN (the same role class production's env var documents — BYPASSRLS or superuser), threaded into every `relocateAllDefaultRows` call. All prior assertions in both suites pass unchanged.
- **Task 2 — Migration `0043_retire_admin_scan_guc_policies.sql`:** drops all five legacy marker-gated policies (`campaign_scheduler_due_scan` on `campaigns`, `flow_runs_due_scan` on `flow_runs`, `flows_segment_sweep_scan` on `flows`, `partition_relocation_admin_scan` on both `contacts` and `sends`), each preceded by the migration linter's `-- destructive:` marker with the real reason. Journal updated to `idx: 43`.
- **`scan.test.ts` negative proof (SPEC R2):** a new test seeds real rows in two workspaces across all five tables the marker used to gate, then compares row counts visible on a genuinely fresh (never tenant-scoped) tenant-pool connection with and without the marker set transaction-locally — both are zero, proving the marker grants nothing now that no policy reads it. A second new test asserts zero rows in `pg_policies` reference `app.admin_scan` in `qual` or `with_check`.
- **Task 3 — `ARCHITECTURE.md`/`SPECIFICATION.md`/runbook updated to as-built:** §6 describes the elevated-adminClient mechanism; §7 adds the ownership-constraint rationale and the three checkpoint options with option-b's selection recorded; the "Forward-looking" section's Phase 10 bullet now says the GUC pattern is fully retired, not partially. `SPECIFICATION.md` §3.2 documents the new env var; §3.6 adds it as a fifth, CLI-only pool (not counted among the four persistent service pools); §4.3's GUC table drops the four removed rows; §4.6's journal count updated to 44 entries; §9's review item 1 marked closed. The DEFAULT-relocation runbook (`docs/runbooks/relocate-default-partition-rows.md`) gained a pre-flight step for the new required env var (added beyond the plan's literal file list — Rule 2, since the mechanism change directly affects the operator-facing procedure it documents).

## Task Commits

1. **Task 1: `options.adminClient` mechanism + CLI env var + new/updated tests** - `72c7c5c` (feat)
2. **Task 2: Migration 0043 + journal + scan.test.ts negative proof** - `0387092` (feat)
3. **Task 3: ARCHITECTURE.md/SPECIFICATION.md/runbook updates** - `c05c365` (docs)

## Files Created/Modified

- `packages/db/migrations/0043_retire_admin_scan_guc_policies.sql` — 5 `DROP POLICY` statements with destructive markers
- `packages/db/migrations/meta/_journal.json` — journal entry idx 43
- `packages/db/src/partitions/ensure-partitions.ts` — `attachPartitionCheckFirst`'s `options.adminClient`, doc comment rewritten
- `packages/db/src/partitions/relocate-default.ts` — `relocateMonth`/`relocateAllDefaultRows` require `adminClient`
- `packages/db/scripts/relocate-default-partition-rows.ts` — reads/validates `PARTITION_RELOCATION_ADMIN_DATABASE_URL`, second `Pool`
- `apps/worker/src/queues/partition-maintenance.worker.ts` — dedicated-pool comment updated
- `packages/db/src/partitions/__tests__/relocate-default-partition-rows.test.ts` — new: mechanism proof + P3-style structural check
- `packages/db/src/partitions/__tests__/relocate-default.test.ts` — `relocationAdminPool`, `adminDsnForDatabase` helper
- `packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts` — same, Scenario A only
- `packages/tenant-context/src/__tests__/scan.test.ts` — 2 new tests (seeded negative proof, catalog assertion)
- `ARCHITECTURE.md` — §6, §7, Forward-looking section
- `SPECIFICATION.md` — §3.2, §3.6, §4.3, §4.4, §4.6, §9
- `docs/runbooks/relocate-default-partition-rows.md` — new pre-flight step, command example, locking-section note

## Decisions Made

- Checkpoint option-b selected by the human operator (see Checkpoint Decision above) — implemented exactly per the guidance provided, no further open decisions within the plan's own scope.
- `adminClient` optional on `attachPartitionCheckFirst` but required on `relocateMonth`/`relocateAllDefaultRows`: the asymmetry reflects that the everyday `ensurePartitions` path never attaches a non-empty child (optional, defaults to the ordinary client is correct and simpler for its callers), while every call into `relocate-default.ts` always does (required, so there is no silent misuse path).
- New dedicated test file rather than extending `relocate-default.test.ts` for the failure-path proof: a failed ATTACH inside that suite's own DEFAULT-discovery pipeline would leave a freestanding, un-reattachable child (rows already moved out of DEFAULT by the batch loop, not rediscoverable on retry) — isolating the failure-path assertion in its own suite, built directly on `attachPartitionCheckFirst`, avoids perturbing that suite's shared, ordered test state.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixtures' `adminDsn` pointed at the wrong database**
- **Found during:** first `npx vitest run --root packages/db` after wiring `relocationAdminPool` from `createEphemeralDatabase`'s `adminDsn` field directly
- **Issue:** `createEphemeralDatabase`'s `adminDsn` field is the CLUSTER's maintenance-database DSN (used for `CREATE DATABASE`/`DROP DATABASE`), not a superuser DSN scoped to the ephemeral database itself — passing it straight to `new Pool(...)` connected to the wrong database (`relation "events" does not exist`).
- **Fix:** Added a small `adminDsnForDatabase(adminDsn, databaseName)` helper (swap only the pathname, keep the superuser credentials) in all three affected test files.
- **Files modified:** `relocate-default.test.ts`, `boundary-crossing-late-automation.test.ts`, `relocate-default-partition-rows.test.ts`
- **Verification:** Full `packages/db` suite passes (45/45)
- **Committed in:** `72c7c5c` (Task 1 commit)

**2. [Rule 2 - Missing critical functionality] Runbook left stale after the mechanism change**
- **Found during:** Task 3, while confirming the plan's `<human-check>` verification item ("the DEFAULT-partition relocation runbook still describes a procedure an operator can follow")
- **Issue:** `docs/runbooks/relocate-default-partition-rows.md` (not in the plan's literal `<files>` list for any task) instructed an operator to run the CLI with only `DATABASE_URL` set — omitting the newly-required `PARTITION_RELOCATION_ADMIN_DATABASE_URL`, which the CLI now fails fast without. Following the runbook as written would have produced a confusing boot-time error with no guidance.
- **Fix:** Added a pre-flight step documenting the new env var (what role class it must be, what it is used for, why it must never appear in a service environment), and updated the command example and locking-section prose to match.
- **Files modified:** `docs/runbooks/relocate-default-partition-rows.md`
- **Verification:** Re-read the full runbook end-to-end for internal consistency
- **Committed in:** `c05c365` (Task 3 commit)

### Infrastructure Fault (not a plan deviation, documented for the record)

**3. Worktree isolation was lost mid-execution and self-recovered by the orchestrator, not by this agent**

- **What happened:** The `<worktree_branch_check>` gate passed correctly at task start (HEAD on `refs/heads/worktree-agent-ad4ad0388c87f2018`, base `9a23b36...`, as dispatched). All implementation work (checkpoint decision through Task 3, including all verification runs) completed successfully inside that context. Immediately before the first task commit, the pre-commit HEAD safety assertion discovered the isolated worktree no longer existed on disk (`.claude/worktrees/` empty, `git worktree list` showing only the main checkout) and that the working directory was now the main checkout on branch `gsd/phase-10-tenant-isolation-trust-boundaries` at HEAD `9a23b36` — a branch outside the required `worktree-agent-*` namespace.
- **Response:** Per the mandatory absolute-prohibition guidance ("HALT immediately... Do NOT self-recover, do NOT commit"), the executor halted without committing anything and returned a structured FATAL report to the orchestrator, with all completed work preserved as uncommitted working-tree changes.
- **Orchestrator resolution:** The orchestrator (lifecycle owner) diagnosed the root cause — the original worktree was auto-reaped by the harness after an earlier checkpoint return with zero commits, and the subsequent resume legitimately placed the agent in the main checkout — verified no other executor agents were running, confirmed the working tree contained exactly the reported 11 modified + 2 untracked files, and issued an explicit recovery decision reclassifying this run as **sequential-mode execution directly on the main checkout's `gsd/phase-10-tenant-isolation-trust-boundaries` branch**, superseding the original worktree-mode dispatch.
- **Outcome:** No re-implementation was needed — the orchestrator's recovery decision explicitly directed committing the already-finished, already-verified work in task-shaped slices under the new sequential-mode contract, which this plan's three task commits above do.

---

**Total deviations:** 2 auto-fixed (both necessary for the plan's own tests/verify to pass or for the operator-facing runbook to remain accurate) + 1 infrastructure fault (resolved by orchestrator directive, not a code or plan deviation).
**Impact on plan:** No scope creep. The runbook update is the only file touched outside the plan's literal `<files>` lists, and it is a direct, necessary consequence of Task 3's own mechanism change.

## Issues Encountered

- See "Infrastructure Fault" above — the only issue encountered was environmental (worktree lifecycle), not code-related. No test flakiness, no missing dependencies, no build failures beyond the one fixture bug documented as deviation #1.

## User Setup Required

**Operational (before this plan's changes take effect against any real database):** an operator running the DEFAULT-partition relocation CLI (`npm run relocate:default-partition-rows`) must now set `PARTITION_RELOCATION_ADMIN_DATABASE_URL` in their shell before running it — a DSN for a Postgres role capable of bypassing row-level security (the cluster superuser, or an operator-managed role with `BYPASSRLS`). The CLI fails fast with a descriptive error if it is absent. This variable must never be set in any service (`apps/api`/`apps/worker`) environment — documented in `SPECIFICATION.md` §3.2, `ARCHITECTURE.md` §7, and the runbook's pre-flight check.

No new environment variables are required for normal application operation (API/worker boot) — this is exclusively an operator-CLI concern.

## Next Phase Readiness

- The `app.admin_scan` marker-GUC pattern is now fully retired from both the catalog (migration 0043) and first-party source (zero remaining `set_config('app.admin_scan', ...)` calls outside the negative test that proves the pattern is inert).
- All five named cross-tenant scan consumers this phase set out to migrate are now off the legacy GUC pattern: four via `mega_crm_scan`/`withCrossWorkspaceScan` (campaign-scheduler, flow-reconciliation, flow-segment-sweep, analytics-reconciliation — plans 10-01/10-03), and the fifth (DEFAULT-partition relocation) via this plan's operator-only elevated DSN.
- This plan explicitly resolves the precondition plan 10-07 (RLS fail-closed unification) depends on: after that unification, an app-role connection that has never set the tenant context will throw rather than return zero rows, and every path that previously relied on being tenant-context-free (the partition-relocation ATTACH step) is now resolved through a mechanism that does not depend on that behavior.
- No blockers for continuing the phase's remaining plans.

## Self-Check: PASSED

- FOUND: packages/db/migrations/0043_retire_admin_scan_guc_policies.sql
- FOUND: packages/db/src/partitions/__tests__/relocate-default-partition-rows.test.ts
- FOUND: packages/db/src/partitions/ensure-partitions.ts (modified)
- FOUND: packages/db/src/partitions/relocate-default.ts (modified)
- FOUND: packages/db/scripts/relocate-default-partition-rows.ts (modified)
- FOUND: apps/worker/src/queues/partition-maintenance.worker.ts (modified)
- FOUND: packages/db/src/partitions/__tests__/relocate-default.test.ts (modified)
- FOUND: packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts (modified)
- FOUND: packages/db/migrations/meta/_journal.json (modified)
- FOUND: packages/tenant-context/src/__tests__/scan.test.ts (modified)
- FOUND: ARCHITECTURE.md (modified)
- FOUND: SPECIFICATION.md (modified)
- FOUND: docs/runbooks/relocate-default-partition-rows.md (modified)
- FOUND commit: 72c7c5c
- FOUND commit: 0387092
- FOUND commit: c05c365

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-07*
