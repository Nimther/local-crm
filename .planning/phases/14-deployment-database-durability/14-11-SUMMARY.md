---
phase: 14-deployment-database-durability
plan: 11
subsystem: infra
tags: [postgres, pitr, restore, pgbackrest, disaster-recovery, verification]

requires:
  - phase: 14-deployment-database-durability
    provides: docker/pgbackrest/pgbackrest.conf `mega_crm` stanza, off-host Cloudflare R2 repository, retention window, real backup + WAL evidence (plan 14-10)
provides:
  - packages/db/scripts/verify-restored-database.ts — composed, independently-tested check set (row counts vs baseline, partitions attached, RLS enabled-and-forced), exits non-zero on any failed expectation or unreachable database
  - scripts/restore-drill.sh — PITR restore into a scratch container/volume, production-name guard, teardown-on-success/preserve-on-failure asymmetry
  - docs/runbooks/restore-drill.md — prerequisites, ordered commands, PITR target selection, per-stage failure handling, recurrence cadence, cross-reference to the migration rollback runbook
  - Real evidence: a point-in-time restore performed twice against the real off-host repository on the production VPS — once to a target before a marker row (marker absent, proving PITR) and once after (marker present) — verification passed both times, production untouched, scratch resources destroyed
affects: [phase-14-plan-12-retention, phase-14-plan-13-specification]

tech-stack:
  added: []
  patterns:
    - "Verifier exercised on every CI run against an ordinary migrated ephemeral database — a broken check is caught long before an operator relies on it during a real drill, rather than the drill itself being the first time the verifier runs"
    - "Teardown asymmetry as a documented choice: destroy scratch resources on success, deliberately preserve them (with the cleanup command printed) on failure — retention is a stated decision, not an oversight"
    - "Explicit PITR target required, no 'latest' default — forces every drill run to demonstrate point-in-time recovery rather than degrading into 'we unpacked a backup'"

key-files:
  created:
    - packages/db/scripts/verify-restored-database.ts
    - packages/db/src/__tests__/verify-restored-database.test.ts
    - scripts/restore-drill.sh
    - scripts/__tests__/restore-drill-script.test.mjs
    - docs/runbooks/restore-drill.md
  modified:
    - packages/db/package.json
    - package.json

key-decisions:
  - "Verification is enumeration, not spot-check: partitions walked from the catalog with the same query shape as ensure-partitions.ts, RLS read from both relrowsecurity and relforcerowsecurity against the full expected table set — a name-pattern guess or single-table spot-check would pass on a cluster missing exactly the partitions or RLS posture that matter"
  - "Row-count check is a baseline comparison, not an absolute count: the drill script captures a read-only baseline from production and passes it to the verifier, so the claim made is 'the restored cluster matches production at the target timestamp within expected drift', not an arbitrary number"
  - "Post-checkpoint real-host iteration: the drill script's verification step needed to run against the scratch database specifically in local mode — fixed in 8d31abe ('fix(restore): verify scratch database in local mode'), landed on this branch before the checkpoint was approved, touching scripts/restore-drill.sh, scripts/__tests__/restore-drill-script.test.mjs, docs/runbooks/restore-drill.md"
  - "Restore wall-clock duration and disk high-water mark were NOT reported at checkpoint approval, despite the plan's how-to-verify step 8 and resume-signal asking for them. Recorded honestly as not captured rather than invented — capture at the next scheduled drill (docs/runbooks/restore-drill.md's stated recurrence cadence)."

requirements-completed: [DB-10]

coverage:
  - id: D1
    description: "Verification query set (row counts vs baseline, partitions attached, RLS enabled-and-forced) as composed, independently testable check functions; exits non-zero on any failed expectation or unreachable database"
    requirement: "DB-10"
    verification:
      - kind: unit
        ref: "npx vitest run --root packages/db src/__tests__/verify-restored-database.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Drill script: PITR restore into a scratch container/volume distinct from production, production-name guard, teardown-on-success/preserve-on-failure asymmetry, dry-run ordering"
    requirement: "DB-10"
    verification:
      - kind: unit
        ref: "bash -n scripts/restore-drill.sh && npx vitest run --root scripts __tests__/restore-drill-script.test.mjs"
        status: pass
    human_judgment: false
  - id: D3
    description: "The point-in-time restore has actually been performed against the real off-host repository, twice, demonstrating both directions of target selection (marker absent before, present after), with verification passing and production untouched"
    requirement: "DB-10"
    verification: []
    human_judgment: true
    rationale: "Blocking checkpoint (Task 3) — automation cannot establish that the real repository's bytes decrypt, that WAL replay reaches the requested moment, or how long a real restore of this cluster takes; a mocked restore would prove the opposite of what DB-10 claims. Operator performed both drills against the real repository on the production VPS and reported 'approved' on 2026-08-14, confirming the marker-row procedure in both directions, verification passing, production untouched, and scratch resources destroyed. Restore duration and disk high-water mark were not included in the approval reply."

duration: —
completed: 2026-08-14
status: complete
---

# Phase 14 Plan 11: PITR Restore Drill Summary

**A scripted point-in-time restore into a throwaway container, verified by a tested, catalog-enumerating check set (row counts vs baseline, partitions attached, RLS enabled-and-forced) — rehearsed twice against the real off-host repository on the production VPS, proving both directions of point-in-time target selection.**

## Performance

- **Tasks:** 3 (Task 1 TDD, Task 2 TDD, Task 3 blocking checkpoint)
- **Files modified:** 7 (packages/db/scripts/verify-restored-database.ts, packages/db/src/__tests__/verify-restored-database.test.ts, packages/db/package.json, scripts/restore-drill.sh, scripts/__tests__/restore-drill-script.test.mjs, package.json, docs/runbooks/restore-drill.md) plus the post-checkpoint fix touching three of the same files

## Accomplishments

- **Task 1 (TDD):** `packages/db/scripts/verify-restored-database.ts` composes independently testable check functions — row counts (against a baseline captured from another database, reporting differences rather than only absolute numbers), expected monthly partitions present and attached (enumerated from the catalog the same way `ensure-partitions.ts` does, not a name-pattern guess), and row-level security enabled *and* forced (both `relrowsecurity` and `relforcerowsecurity` read from the catalog and compared against the expected table set derived from the migrations). It exits non-zero on any failed expectation, and — critically — exits non-zero rather than reporting success when it cannot connect or a query fails, so an unreachable cluster can never look like a passing drill. Registered as `db:verify-restored` in `packages/db/package.json`. `packages/db/src/__tests__/verify-restored-database.test.ts` runs the verifier against an ordinary migrated ephemeral database on every CI pass, covering the passing case, a detached partition, an RLS-enabled-but-not-forced table, and the cannot-connect case — this is what makes the drill trustworthy: a broken check is caught in CI long before an operator relies on it during a real restore.
- **Task 2 (TDD):** `scripts/restore-drill.sh` follows plan 14-09's `deploy.sh` conventions (strict shell error handling, named argument-validation rejections, a `--dry-run` printing one command per line with no side effects). It requires an explicit PITR target argument — no "latest" default — so every run exercises point-in-time recovery rather than degrading into unpacking a backup. Before any writing command it asserts every scratch container/volume name differs from the production names, read from the compose file rather than hardcoded so a future rename cannot make the guard stale; a target naming a production resource is refused. It captures a read-only row-count baseline from production, invokes `db:verify-restored` against the scratch cluster, and propagates its exit code. On success it destroys the scratch container and volume; on failure it deliberately preserves them for inspection and prints the cleanup command — the asymmetry is documented, not accidental. `scripts/__tests__/restore-drill-script.test.mjs` drives the dry run and a PATH-stubbed failure path, asserting ordering (restore → verify → teardown), the production-name guard, and the missing-target rejection. `docs/runbooks/restore-drill.md` documents prerequisites, the ordered commands, PITR target selection and how to confirm the restored cluster reflects it, per-stage failure handling, the teardown asymmetry, the recurrence cadence as an operator obligation, the fresh-VPS stretch variant note, and the cross-reference closing the loop plan 14-05 left open for the forward-only migration tier's recovery path.
- **Task 3 (blocking checkpoint — human-verify):** Operator confirmed on 2026-08-14, via the checkpoint prompt, that:
  1. Both PITR restore drills were performed against the real off-host repository on the production VPS (not a mock, not merely CI).
  2. With a PITR target BEFORE the marker row, the restored cluster did NOT contain the marker.
  3. With a PITR target AFTER the marker row, the restored cluster DID contain the marker.
  4. Both directions of target selection were demonstrated — this is real point-in-time recovery, not backup unpacking.
  5. Verification passed on both runs: expected partitions attached, RLS enabled and forced where required, row counts consistent with the production baseline.
  6. Production was untouched throughout both drills.
  7. The scratch container and volume were destroyed after each successful run.

  The restore wall-clock duration and the disk high-water mark, which the plan's how-to-verify step 8 and resume-signal asked the operator to report, were **not included** in the approval reply. This is recorded here as a gap rather than invented: capture both figures at the next scheduled drill per the recurrence cadence documented in `docs/runbooks/restore-drill.md`.

## Task Commits

Each task was committed atomically:

1. **Task 1: The verification query set, tested against an ordinary migrated database (TDD)** - `0a45fb8` (test), `d27ce55` (feat)
2. **Task 2: The drill script and its runbook (TDD)** - `2b74ae2` (test), `659e9bf` (feat)
3. **Task 3: Perform the point-in-time restore drill against the real repository** - checkpoint approved by operator 2026-08-14, no code change of its own (recorded in this SUMMARY)

Real-host iteration discovered during the drill, landed on this branch before approval:
- `8d31abe` — "fix(restore): verify scratch database in local mode": the drill script's verification invocation needed to target the scratch database explicitly when running in local mode; fixed across `scripts/restore-drill.sh`, `scripts/__tests__/restore-drill-script.test.mjs`, and `docs/runbooks/restore-drill.md`.

**Plan metadata:** committed together with this SUMMARY.md (see below).

## Files Created/Modified

- `packages/db/scripts/verify-restored-database.ts` - Composed check functions: row counts vs baseline, partitions attached (catalog-enumerated), RLS enabled-and-forced (catalog-enumerated); exits non-zero on any failure or unreachable database
- `packages/db/src/__tests__/verify-restored-database.test.ts` - Passing case, detached-partition case, RLS-enabled-but-not-forced case, cannot-connect case — run against an ordinary migrated ephemeral database on every CI pass
- `packages/db/package.json` - `db:verify-restored` script registered
- `scripts/restore-drill.sh` - PITR restore into a scratch container/volume, production-name guard read from the compose file, baseline capture, verifier invocation, teardown-on-success/preserve-on-failure
- `scripts/__tests__/restore-drill-script.test.mjs` - Dry-run ordering, production-name guard, missing-target rejection, PATH-stubbed failure path
- `package.json` - `test:restore-drill-script` script registered
- `docs/runbooks/restore-drill.md` - Prerequisites, ordered commands, PITR target selection and confirmation, per-stage failure handling, teardown asymmetry, recurrence cadence, fresh-VPS stretch-variant note, cross-reference to `docs/runbooks/migration-rollback-and-roll-forward.md`

## Decisions Made

- Verification is enumeration from the catalog (partitions via the same query shape as `ensure-partitions.ts`; RLS via both `relrowsecurity` and `relforcerowsecurity` against the full expected table set), not a name-pattern guess or single-table spot-check.
- Row-count checking is a baseline comparison against a production-captured snapshot, not an absolute count — the claim a drill makes is "matches production at the target timestamp within expected drift".
- No PITR target defaults to "latest" — an explicit target is mandatory so the drill always demonstrates point-in-time recovery, not backup unpacking.
- Teardown asymmetry (destroy on success, preserve-with-cleanup-instructions on failure) is a documented, deliberate choice in `docs/runbooks/restore-drill.md`, not an oversight.
- Post-checkpoint real-host iteration: the verification step needed to target the scratch database explicitly in local mode (8d31abe), on this branch, before the checkpoint could be approved.
- Restore duration and disk high-water mark are explicitly recorded as not reported at this approval, rather than backfilled with invented figures — to be captured at the next scheduled drill.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Drill script's verification step needed to target the scratch database explicitly in local mode**
- **Found during:** Task 3 (real-host checkpoint verification)
- **Issue:** Running the drill locally, the verification invocation did not resolve to the scratch database's connection details, so `db:verify-restored` could not be pointed correctly at the just-restored cluster in local mode.
- **Fix:** `scripts/restore-drill.sh` updated to pass the scratch database's connection explicitly to the verification step when running in local mode; test and runbook updated to match.
- **Files modified:** scripts/restore-drill.sh, scripts/__tests__/restore-drill-script.test.mjs, docs/runbooks/restore-drill.md
- **Verification:** Both real-host drills (target-before-marker and target-after-marker) completed and verified successfully after the fix; confirmed by the operator's checkpoint approval.
- **Committed in:** `8d31abe` (on this branch, prior to checkpoint approval)

---

**Total deviations:** 1 auto-fixed (1 blocking — scratch-database targeting in local mode, discovered only once the drill was run against a real host, which Task 2 deliberately deferred to the checkpoint)
**Impact on plan:** Necessary for the drill to actually verify the restored cluster in local mode rather than the production cluster or nothing; no scope creep — the fix is scoped exactly to the verification-invocation step the plan already specified.

## Issues Encountered

- **Restore duration and disk high-water mark not reported at approval.** The plan's how-to-verify step 8 and resume-signal both asked the operator to record the wall-clock restore duration and the disk high-water mark during the restore. Neither figure was included in the "approved" reply. Rather than inventing numbers, this is recorded as an open item: capture both at the next scheduled drill, per the recurrence cadence `docs/runbooks/restore-drill.md` documents as an operator obligation. This does not block DB-10 — the requirement is that a restore has actually been performed and verified, which is independently confirmed — but it does leave plan 14-10's first-principles RTO estimate (under an hour) without a real measurement to replace it yet.

No other issues beyond the local-mode scratch-database targeting gap recorded above as a deviation.

## User Setup Required

None beyond what plan 14-10 already established (VPS access, off-host repository reachability). The operator additionally confirmed, ahead of running the drill, sufficient free disk on the VPS for a second copy of the cluster and the presence of at least one full backup plus a WAL span in the repository (`pgbackrest info`), per the plan's `user_setup` prerequisites — the specific disk figure was not recorded in the approval reply (see restore-duration/high-water-mark gap above).

## Next Phase Readiness

- DB-10 is closed: a point-in-time restore has been performed against the real off-host repository, twice, demonstrating both directions of PITR target selection (marker absent before the target, present after), verified by the tested query set, with production untouched and scratch resources destroyed both times.
- **Plan 14-12's retention deletion is un-gated.** D-08 gated retention-tier deletion on this drill having actually been performed; that condition is now met. Plan 14-12 can proceed with switching retention to active deletion.
- Plan 14-05's migration runbook gap is closed: the forward-only migration tier's recovery path (restore) is now a rehearsed procedure, not a documented intention.
- Plan 14-13 (SPECIFICATION.md) needs: `db:verify-restored` and `test:restore-drill-script` npm scripts, the drill script's production-safety guard mechanism (names read from the compose file), and the teardown asymmetry — all recorded above for the relevant SPECIFICATION.md sections.
- Open follow-up for the next scheduled drill (not blocking): capture and record the real restore wall-clock duration and disk high-water mark, which plan 14-10's RTO estimate (first-principles, under an hour) is still waiting on.
- The Pending Checkpoints section in STATE.md is now fully resolved for Phase 14 — this was the last of the three real-host checkpoints (14-09, 14-10, 14-11).

## Self-Check: PASSED

- FOUND: `packages/db/scripts/verify-restored-database.ts`
- FOUND: `packages/db/src/__tests__/verify-restored-database.test.ts`
- FOUND: `scripts/restore-drill.sh`
- FOUND: `scripts/__tests__/restore-drill-script.test.mjs`
- FOUND: `docs/runbooks/restore-drill.md`
- FOUND: commit `0a45fb8` (Task 1 test)
- FOUND: commit `d27ce55` (Task 1 feat)
- FOUND: commit `2b74ae2` (Task 2 test)
- FOUND: commit `659e9bf` (Task 2 feat)
- FOUND: commit `8d31abe` (post-checkpoint local-mode fix, on this branch)
- Task 3 has no commit of its own (checkpoint approval, no code) — recorded here per the plan's blocking-checkpoint convention.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-14*
