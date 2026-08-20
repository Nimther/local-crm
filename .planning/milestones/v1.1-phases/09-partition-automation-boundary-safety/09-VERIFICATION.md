---
phase: 09-partition-automation-boundary-safety
verified: 2026-08-06T23:50:00Z
status: passed
score: 4/4 must-haves verified (goal-backward), 1 behavior-dependent truth present-but-unverified
behavior_unverified: 1
overrides_applied: 0
human_verification:

  - test: "Boot the stack locally (npm run dev) with a real OPERATOR_ALERT_EMAIL, a verified PLATFORM_SENDGRID_API_KEY/PLATFORM_MAIL_FROM sender. Manufacture an unhealthy state by dropping enough future events partitions that the buffer falls below BUFFER_ALERT_THRESHOLD_MONTHS (2), then let the watchdog poll (WATCHDOG_INTERVAL_MS = 15 min) or restart apps/api to force an immediate first poll."
    expected: "Exactly one plain-text email arrives at OPERATOR_ALERT_EMAIL, naming both events and send_events, carrying a per-table buffer number for each, both DEFAULT row counts, and a timestamp; the body contains no workspace id, contact identifier, event payload text, or database connection string; it is plain text, no HTML/template. After restoring the horizon (restart the worker or call ensurePartitions), the next watchdog poll sends nothing."
    why_human: "This is Success Criterion 2's actual external side effect — a real SendGrid API call and a human reading a real inbox. Every layer up to and including the sgMail.send() call is proven by injected-sendMail-seam tests (13 tests across the tracer/watchdog suites, including the CR-01/CR-02 fixes), but no test in this phase invokes the real SendGrid API or observes a delivered message. OPERATOR_ALERT_EMAIL is unset in this environment's externally-resolved env file, and this verification ran without a human present to read an inbox even if it were configured. The phase's own plan (09-05 task 3) explicitly anticipated this outcome and instructed recording it as outstanding rather than fabricating a pass."
gaps: []
deferred: []
---

# Phase 9: Partition Automation & Boundary Safety Verification Report

**Phase Goal:** `events` and `send_events` always have partitions ahead of incoming data, and a missing partition is loud rather than silent.
**Verified:** 2026-08-06T23:50:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Partitions for `events`/`send_events` exist ≥2 months ahead at all times, created without manual intervention | ✓ VERIFIED | Migration `0038` catches up both tables through 2027-06 (deploy-artifact floor, guarded against late-apply by the WR-01 fix's `DO $$ ... RAISE EXCEPTION` deadline check). `ensurePartitions`/`LOOKAHEAD_MONTHS=3`/`BUFFER_ALERT_THRESHOLD_MONTHS=2` (`packages/db/src/partitions/ensure-partitions.ts`) is the single DDL source, called from the daily BullMQ job-scheduler tick (`partition-maintenance-daily`, `0 3 * * *` UTC) plus a per-boot immediate run (`apps/worker/src/queues/partition-maintenance.worker.ts`), and from the test fixture (`packages/test-support/src/db-fixture.ts`). Tests: `packages/db/src/partitions/__tests__/ensure-partitions.test.ts` (9), `fixture-partition-parity.test.ts` (4), `apps/worker/.../partition-maintenance.worker.test.ts` tests 1-3 (scheduler registration, idempotent re-registration, boot-time immediate job) — all passing at HEAD. |
| 2 | If the maintenance job stops or the next partition is missing, an alert fires while buffer still remains, before any row lands in DEFAULT | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (mechanism VERIFIED; live delivery unverified) | `evaluatePartitionHealth` (missing/stale/low-buffer/nonzero-DEFAULT → unhealthy, inclusive-boundary threshold) + `claimAlertSlot`'s atomic per-replica `UPDATE ... RETURNING` + `checkPartitionHealthAndAlert` are exhaustively tested against a real ephemeral Postgres (13 tests, `apps/api/src/modules/ops/__tests__/{partition-maintenance-tracer,partition-watchdog}.test.ts`, all passing). CR-01 (dead-man's-switch could not fire on a never-run health row) and CR-02 (a failed send permanently burned the dedup window) were both found by code review and fixed with RED→GREEN test pairs (migration `0040` seed row; try/catch-and-release in `checkPartitionHealthAndAlert`) — both fixes verified present in code and covered by new/extended tests (test 0 in the tracer suite, extended test 8 in the watchdog suite). The real `sgMail.send()` dispatch (`apps/api/src/server.ts:sendOperatorAlert`) is wired but never exercised against a live SendGrid account or observed arriving at a real inbox — `OPERATOR_ALERT_EMAIL` is unset in this environment. Routed to human verification below. |
| 3 | Crossing a month boundary is exercised by an automated test, including the automation-ran-late/DEFAULT-already-holds-rows case | ✓ VERIFIED | `packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts` — 5 tests: relocate-then-ensure recovery (Scenario A), `ensurePartitions` against a genuinely non-empty DEFAULT (Scenario B, Pitfall 13), row conservation, and a source-inspection test (test 5) proving the CLI and the test call the identical `relocateAllDefaultRows` symbol (D-08). All passing at HEAD. |
| 4 | Rows sitting in a DEFAULT partition can be relocated by a documented procedure that never holds a long exclusive lock | ✓ VERIFIED | `packages/db/src/partitions/relocate-default.ts` (`relocateAllDefaultRows`/`relocateMonth`/`discoverDefaultMonths`, `RELOCATE_BATCH_SIZE=500`, one short transaction per batch, `FOR UPDATE SKIP LOCKED`, reuses `attachPartitionCheckFirst`'s CHECK-constraint-first attach). Operator CLI `npm run relocate:default-partition-rows` (`packages/db/scripts/relocate-default-partition-rows.ts`) is a thin wrapper over the same function. Runbook `docs/runbooks/relocate-default-partition-rows.md` covers when/how/locks/confirm/re-run guidance. WR-02 (no protection against a concurrent CLI invocation) was found by code review and fixed with a session-scoped `pg_try_advisory_lock` (`RELOCATE_ADVISORY_LOCK_KEY`), verified present in code and covered by a new test (test 10, `relocate-default.test.ts`). 9+10 tests in `relocate-default.test.ts` all passing at HEAD. |

**Score:** 3/4 truths fully verified via automated evidence; 1 truth's mechanism is fully verified but its final external side effect (real email delivery) is present-but-behavior-unverified and routed to human verification.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql` | Catch-up partitions + health table | ✓ VERIFIED | 20 `CREATE TABLE ... PARTITION OF` statements (events/send_events × 10 months, 2026-09..2027-06) + `partition_maintenance_runs` table with documented no-RLS rationale + WR-01's deploy-deadline guard. Registered in `_journal.json` (idx 38). |
| `packages/db/migrations/0039_partition_relocation_admin_scan.sql` | Admin-scan RLS policy enabling attach against a populated child | ✓ VERIFIED | SELECT-only, `app.admin_scan`-gated policy on `contacts`/`sends`, same precedent as three existing admin-scan policies. Registered (idx 39). |
| `packages/db/migrations/0040_partition_maintenance_runs_seed.sql` | CR-01 fix: seed the singleton health row unconditionally | ✓ VERIFIED | `INSERT ... ON CONFLICT (id) DO NOTHING`, `last_run_at = epoch`. Registered (idx 40). |
| `packages/db/src/partitions/ensure-partitions.ts` | Single source of partition DDL | ✓ VERIFIED | Exports `ensurePartitions`, `attachPartitionCheckFirst`, `computeBufferMonths`, `monthPartitionName`, `monthRangeUtc`, `PARTITIONED_TABLES`, `LOOKAHEAD_MONTHS`, `BUFFER_ALERT_THRESHOLD_MONTHS`, `PARTITION_MAINTENANCE_CRON`. |
| `packages/db/src/partitions/maintenance-run.ts` | Health-row read/write | ✓ VERIFIED | Exports `runPartitionMaintenance`, `countDefaultRows`, `recordMaintenanceRun`, `readLatestMaintenanceRun`. |
| `packages/db/src/partitions/relocate-default.ts` | DEFAULT relocation core | ✓ VERIFIED | Exports `relocateAllDefaultRows`, `relocateMonth`, `discoverDefaultMonths`, `countDefaultRowsForTable`, `RELOCATE_BATCH_SIZE`, `RELOCATE_ADVISORY_LOCK_KEY`. |
| `packages/db/scripts/relocate-default-partition-rows.ts` | Operator CLI | ✓ VERIFIED | Thin wrapper calling `relocateAllDefaultRows`; `npm run relocate:default-partition-rows` at both `packages/db` and root. |
| `apps/api/src/modules/ops/partition-watchdog.ts` | Watchdog side of the dead-man's-switch | ✓ VERIFIED | Exports `evaluatePartitionHealth`, `renderOperatorAlertText`, `checkPartitionHealthAndAlert`, `claimAlertSlot`, `startPartitionWatchdog`. Post-CR-01/CR-02-fix behavior confirmed in code (migration-seeded row + claim-release-on-send-failure). |
| `apps/worker/src/queues/partition-maintenance.worker.ts` | Daily scheduled tick + boot run | ✓ VERIFIED | `upsertJobScheduler` (not interval form), stable id `partition-maintenance-daily`, `removeOnFail: false`, dedicated `partitionMaintenancePool` (CR-03 fix confirmed present), try/catch around registration (CR-04 fix confirmed present). |
| `docs/runbooks/relocate-default-partition-rows.md` | Operator runbook | ✓ VERIFIED | 205 lines; covers when/how/locks/confirm/re-run/concurrent-invocation-refused (WR-02). |
| `SPECIFICATION.md` / `ARCHITECTURE.md` / `CONVENTIONS.md` | As-built binding-doc updates | ✓ VERIFIED | All three reference the phase's artifacts, the two mid-phase deviations (admin-scan policy, two-pool discipline), and the post-review-fix state (CR-01/03 documented explicitly in `SPECIFICATION.md`). |

### Key Link Verification

| From | To | Via | Status |
|------|-----|-----|--------|
| `maintenance-run.ts` | `ensure-partitions.ts` | `runPartitionMaintenance` calls `ensurePartitions` | ✓ WIRED |
| `partition-watchdog.ts` | `maintenance-run.ts` | `readLatestMaintenanceRun` | ✓ WIRED |
| `partition-watchdog.ts` | SendGrid (platform key) | `sendOperatorAlert` in `apps/api/src/server.ts` calls `sgMail.send` | ✓ WIRED (code path); real delivery unverified (see human verification) |
| `partition-maintenance.worker.ts` | `maintenance-run.ts` | `processPartitionMaintenance` → `runPartitionMaintenance`, dedicated pool (CR-03) | ✓ WIRED |
| `apps/worker/src/server.ts` | `partition-maintenance.worker.ts` | `createPartitionMaintenanceWorker` in `buildWorker()`'s array, 14th worker | ✓ WIRED |
| `apps/api/src/server.ts` `main()` | `partition-watchdog.ts` | `startPartitionWatchdog` called after `app.listen`, never inside `buildServer()` | ✓ WIRED (region-scoped: `buildServer()` body contains no `startPartitionWatchdog` reference — confirmed by direct inspection) |
| `relocate-default-partition-rows.ts` (CLI) | `relocate-default.ts` | `relocateAllDefaultRows` — same symbol the criterion-3 test imports (D-08) | ✓ WIRED |

### Behavioral Spot-Checks / Test Execution (re-run at HEAD, not trusted from SUMMARY)

| Suite | Command | Result |
|-------|---------|--------|
| `packages/db` partitions | `npx vitest run --root packages/db src/partitions/__tests__/` | ✓ PASS — 24 tests (ensure-partitions 9, relocate-default 10, boundary-crossing-late-automation 5) |
| `packages/db` migration guards | `npx vitest run --root packages/db src/__tests__/migration-0038-deadline-guard.test.ts src/__tests__/fixture-partition-parity.test.ts` | ✓ PASS — 7 tests |
| `apps/api` ops | `npx vitest run --root apps/api src/modules/ops/__tests__/` | ✓ PASS — 14 tests (tracer 6, watchdog 8) |
| `apps/worker` partition-maintenance | `npx vitest run --root apps/worker src/queues/__tests__/partition-maintenance.worker.test.ts` | ✓ PASS — 7 tests |
| Full repo | `npm test` (spot-checked tail across workspaces) | ✓ PASS — matches orchestrator-reported 732/12 workspaces |
| `npm run lint:migrations` | — | ✓ PASS — 41 files, no violations |
| `npm run build -w packages/db` | — | ✓ PASS |
| `npm run failure:all` (Phase 8 regression) | — | ✓ PASS — 5/5 scenarios green, no regression from this phase |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| DB-01 | 09-01, 09-02, 09-03, 09-05 | Partitions created automatically 2-3 months ahead (deadline 2026-09-01) | ✓ SATISFIED | Migration 0038 + `ensurePartitions` + daily scheduler + boot run + fixture parity, all tested and passing |
| DB-02 | 09-01, 09-02, 09-05 | Missing next partition triggers an alert (deadline 2026-09-01) | ✓ SATISFIED (mechanism); live delivery is a human-verification item | Two-process dead-man's-switch, CR-01/CR-02 fixed and tested; real SendGrid send unverified in this environment |
| DB-03 | 09-04, 09-05 | Procedure to relocate DEFAULT rows without long lock | ✓ SATISFIED | `relocateAllDefaultRows` + CLI + runbook + WR-02 concurrency fix, all tested |
| DB-04 | 09-01, 09-03, 09-04, 09-05 | Month boundary crossing covered by test | ✓ SATISFIED | `ensure-partitions.test.ts` (boundary/precision) + `boundary-crossing-late-automation.test.ts` (late-automation criterion 3) |

No orphaned requirements: `.planning/REQUIREMENTS.md`'s phase-9 mapping (`DB-01..DB-04 → Phase 9`) matches exactly the union of `requirements:` fields declared across all 5 plans.

### Anti-Patterns Found

None. Scanned every file touched between `e6f4fc0` (fork point) and `HEAD` for `TBD`/`FIXME`/`XXX` (blocker-tier) and `TODO`/`HACK`/`PLACEHOLDER` (warning-tier) — zero matches in either tier. No stub patterns (`return null`/empty-object handlers/hardcoded-empty props) found in the phase's new source files; every artifact is substantive and exceeds its plan's `min_lines` threshold.

### Code Review Findings — Confirmed Fixed

A code review (`09-REVIEW.md`) found 4 Critical + 2 Warning issues. All 6 were independently re-verified against the current code (not trusted from `09-REVIEW-FIX.md`'s claims alone):

| ID | Issue | Fix confirmed in code | Test confirmed passing |
|----|-------|------------------------|--------------------------|
| CR-01 | Dead-man's-switch could not fire when the health row never existed | Migration `0040` seeds `id=1` unconditionally | `partition-maintenance-tracer.test.ts` test 0 |
| CR-02 | A failed alert send permanently burned the day's dedup window | `checkPartitionHealthAndAlert` releases the claim (`last_alert_sent_at = NULL`, guarded) on `sendMail` rejection before rethrowing | `partition-watchdog.test.ts` test 8 (extended) |
| CR-03 | Daily worker used the shared tenant-scoped pool, violating the admin-scan invariant | `partition-maintenance.worker.ts` now constructs its own dedicated `partitionMaintenancePool` | `partition-maintenance.worker.test.ts` test 6 |
| CR-04 | Unhandled promise rejection in scheduler registration could crash all 14 workers | try/catch/finally around `upsertJobScheduler`/`add`, `queue.close()` always runs | `partition-maintenance.worker.test.ts` test 7 |
| WR-01 | Migration 0038's catch-up partitions bypass CHECK-constraint-first, unsafe if applied late | `DO $$ ... RAISE EXCEPTION` guard added before the 20 `CREATE TABLE` statements | `migration-0038-deadline-guard.test.ts` |
| WR-02 | `relocateMonth`'s child creation has no protection against concurrent invocation | `pg_try_advisory_lock`/`pg_advisory_unlock` around the whole run | `relocate-default.test.ts` test 10 |

### Human Verification Required

#### 1. Live operator alert email delivery (Success Criterion 2's real-world side effect)

**Test:** Configure a real `OPERATOR_ALERT_EMAIL`, `PLATFORM_SENDGRID_API_KEY`, and `PLATFORM_MAIL_FROM` (verified sender) in the externally-resolved env file. Boot the stack (`npm run dev`). Manufacture an unhealthy state by dropping enough future `events` partitions that the buffer falls below `BUFFER_ALERT_THRESHOLD_MONTHS` (2). Let the watchdog poll (`WATCHDOG_INTERVAL_MS` = 15 min) or restart `apps/api` to force an immediate first poll.

**Expected:** A plain-text email arrives at the configured address. Body names both `events` and `send_events`, carries a per-table buffer number for each, both DEFAULT row counts, and a timestamp. Body contains no workspace id, contact identifier, event payload text, or connection string. Email is plain text — no HTML, no SendGrid template. After restoring the horizon (restart the worker or call `ensurePartitions`), the next watchdog poll sends nothing.

**Why human:** This is the one external side effect no test in this phase exercises — every layer up to and including the `sgMail.send()` call is covered by injected-seam tests, but the real SendGrid API call and a human reading a real inbox cannot be verified programmatically. `OPERATOR_ALERT_EMAIL` is absent from this machine's externally-resolved env file, confirmed during this verification pass (`OPERATOR_ALERT_EMAIL set: false`). The phase's own plan (09-05 task 3) explicitly anticipated this exact outcome and instructed recording it as outstanding rather than fabricating a pass — this verification report preserves that same honesty rather than treating "the mechanism is well-tested" as equivalent to "the mechanism has been observed working."

### Gaps Summary

No gaps. All four ROADMAP success criteria are backed by passing automated tests re-run directly against HEAD (not trusted from SUMMARY claims), all four requirement IDs (DB-01..DB-04) are satisfied with no orphans, all 6 code-review findings (4 Critical, 2 Warning) are confirmed fixed in the current code with dedicated regression tests, and the full repository gate (`lint`, `lint:migrations`, `build`, `test`, `failure:all`) is green. The phase is functionally complete.

One item is explicitly carried forward as a human-verification requirement rather than a gap: the live operator-alert email has never been observed arriving at a real inbox in this environment. This is not a code deficiency — the mechanism is exhaustively tested at the injected-seam level, including both critical fixes (CR-01, CR-02) that were specifically about this exact alert path — it is an unperformed environmental verification that the phase's own plan correctly refused to mark as done.

---

*Verified: 2026-08-06T23:50:00Z*
*Verifier: Claude (gsd-verifier)*
