---
status: resolved
trigger: "PR #38 CI fails on 2026-09-01 before product tests because historical migration 0038 refuses to apply on or after its safety cutoff"
created: 2026-09-01
updated: 2026-09-01T17:25:00+05:00
---

# Debug Session: migration-0038-ci-deadline

## Symptoms

- **Expected behavior:** Fresh ephemeral CI databases can apply the complete migration chain and run API, worker, failure-injection, and E2E tests; production safety checks remain fail-closed.
- **Actual behavior:** Every fresh database aborts while applying migration 0038 once the wall clock reaches 2026-09-01, before the current change's tests execute.
- **Errors:** PostgreSQL P0001: migration 0038 refuses to apply on/after 2026-09-01; secondary teardown errors occur because pools/apps were never initialized.
- **Timeline:** Began exactly at migration 0038's encoded 2026-09-01 cutoff. Reproduces locally and in GitHub Actions run 33500894712.
- **Reproduction:** Run any DB-backed suite or PR CI job that creates an empty ephemeral database and applies migrations from 0000.

## Current Focus

- **bug_class:** bohrbug
- **hypothesis:** Migration 0038's unconditional post-cutoff branch rejects every database because it tests only wall-clock time; the safe discriminator already available inside the migration is whether either `events_default` or `send_events_default` contains a row.
- **test:** Execute the exact shipped guard with a forced-past cutoff against real empty DEFAULT partitions, then seed each DEFAULT partition independently and repeat.
- **expecting:** Current SQL rejects the empty case (RED); a state-aware guard permits only the both-empty case and continues to reject either non-empty case.
- **next_action:** complete — archive session and commit the migration plus regression atomically.
- **reasoning_checkpoint:**
  - **hypothesis:** The time-only `IF now() >= cutoff THEN RAISE` causes the fresh-chain failure because it has no database-state predicate.
  - **confirming_evidence:** GitHub and local failures stop at the exact P0001 from this branch; both the test fixture and production runner execute the shipped SQL unchanged; migrations 0010 and 0020 create the two DEFAULT partitions before 0038.
  - **falsification_test:** If the exact current guard permits a forced-post-cutoff execution when both DEFAULT partitions are empty, the hypothesis is wrong.
  - **fix_rationale:** Gate the exception on post-cutoff AND evidence of rows in either DEFAULT partition, preserving the operational refusal exactly where plain partition attachment can scan live fallback data.
  - **blind_spots:** The regression still needs to prove both individual non-empty neighbors reject, and the complete fresh migration chain must pass after the fix.
  - **candidate_causes:** code — unconditional time-only branch in migration 0038; environment — CI wall clock crossed the encoded cutoff; data — fresh ephemeral DEFAULT partitions are empty while a risky live database may not be.
  - **and_gate:** yes — the CI symptom requires both the unconditional code branch and a post-cutoff clock; unsafe production attachment requires the post-cutoff context plus non-empty DEFAULT data, which the fix must continue to reject.
- **tdd_checkpoint:** GREEN confirmed — the regression and both independently non-empty fail-closed neighbors pass (4/4), including under the package's standard global-setup path. Oracle type is specified by the migration safety contract.

## Evidence

- timestamp: 2026-09-01T11:10:00Z
  observation: GitHub Actions failure-injection job 99833734190 aborts in applyMigrationFile on migration 0038 with P0001 before the first scenario.
- timestamp: 2026-09-01T11:10:00Z
  observation: E2E and local DB-backed suites fail at the same migration cutoff; independent static and image build jobs pass.
- timestamp: 2026-09-01T17:05:00+05:00
  observation: `0038_partition_catchup_and_maintenance_runs.sql` raises solely on `now() >= 2026-09-01`; it never inspects `events_default` or `send_events_default`.
- timestamp: 2026-09-01T17:05:00+05:00
  observation: Both `packages/test-support` and `scripts/migrate-runner.mjs` execute the shipped migration SQL unchanged, so a test-runner-only bypass would diverge from production while a SQL data-state predicate covers both paths.
- timestamp: 2026-09-01T17:05:00+05:00
  observation: Migrations 0010 and 0020 create `events_default` and `send_events_default` before migration 0038, so the guard can query both relations on every valid migration-chain execution.
- timestamp: 2026-09-01T17:16:00+05:00
  observation: The new regression executed the exact shipped guard with only the cutoff forced into the past; the both-empty case failed with P0001 while the two independently non-empty fail-closed cases passed (Vitest: 1 failed, 3 passed).
- timestamp: 2026-09-01T17:18:00+05:00
  observation: After adding the locked emptiness predicate, the focused regression passed 4/4 both in isolation and through `npm run test:migrations`, whose global setup itself applies the complete chain.
- timestamp: 2026-09-01T17:21:00+05:00
  observation: Full-chain/partition neighbors passed 12/12; migration lint checked 72 files with no violations; DB TypeScript build and repository ESLint passed.
- timestamp: 2026-09-01T17:21:00+05:00
  observation: The full packages/db suite passed 262 tests (30 files) and failed only the independent new 0071 From Name rollback-rehearsal inverse gap; no 0038 or partition test failed.
- timestamp: 2026-09-01T17:25:00+05:00
  observation: Revert-and-reconfirm passed: removing only migration 0038's new predicate restored the exact RED result (1 failed, 3 passed); reapplying it restored GREEN (4/4) through standard package global setup.

## Eliminated

- hypothesis: The new 0071 campaign From Name migration is invalid.
  reason: migration lint, static metadata/tier tests, TypeScript build, and production-compose validation pass; failure occurs at historical migration 0038.

## Resolution

- **root_cause:** Migration 0038 treated the 2026-09-01 wall-clock cutoff as proof that DEFAULT partitions were unsafe, so its unconditional post-cutoff `RAISE` rejected fresh ephemeral databases even when both DEFAULT partitions were empty; the post-cutoff environment condition and the time-only code branch formed the failure AND-gate.
- **fix:** After the cutoff, acquire `ACCESS EXCLUSIVE NOWAIT` locks on both DEFAULT partitions, reject if either contains a row, and otherwise allow the migration to proceed; this preserves fail-closed behavior for non-empty data and concurrent ingestion while restoring fresh-chain bootstrap.
- **oracle_type:** specified — after cutoff, both-empty is allowed; either independently non-empty DEFAULT partition must reject.
- **verification:**
  - **target_test:** pass — 4/4 focused tests green, including standard global setup.
  - **mutation_check:** skipped — Stryker is not installed or configured in this repository.
  - **no_op_deletion:** pass — the diff adds locking and two explicit data predicates; no behavior or assertion is deleted/short-circuited.
  - **adjacent_tests:** pass — focused/full-chain/partition neighbors 12/12; DB package 262 tests across 30 files passed. The 31st file's sole failure is the independent 0071 From Name inverse-registration gap, recorded and handed to the parent task.
  - **revert_and_reconfirm:** pass — bug returned on predicate-only revert and disappeared on reapply.
  - **lint_build:** pass — migration lint 72/72, DB TypeScript build, and repository ESLint.
  - **guardrail_verdict:** accepted.
- **files_changed:**
  - `packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql`
  - `packages/db/src/__tests__/migration-0038-deadline-guard.test.ts`

## Prevention

- **why_not_caught:** The existing migration test encoded the temporary assumption that real time was before 2026-09-01, so it expired with the deadline and no standing post-cutoff fresh-chain oracle existed.
- **recurrence_guard:** `packages/db/src/__tests__/migration-0038-deadline-guard.test.ts` now forces a stable post-cutoff clock and covers the both-empty safe case plus each non-empty DEFAULT partition independently.
- **blameless_branches:** Code used time as a proxy for data risk; environment eventually crossed the literal deadline as designed; tests depended on calendar time instead of pinning both sides of the state boundary. The durable guard now asserts data state directly.
