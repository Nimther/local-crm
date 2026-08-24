---
phase: 22-workspace-quiesce-physical-purge
plan: 11
subsystem: database
tags: [postgres, jsonb, bullmq-worker, workspace-purge, better-auth, tdd, sigkill-failure-injection]

# Dependency graph
requires:
  - phase: 22-workspace-quiesce-physical-purge
    provides: "plan 22-07's mega_crm_auth auth-step wiring (deleteWorkspaceAuthRows, recordAuthPurgeCounts, markPurgeTableDone auth marker) and plan 22-09's real-SIGKILL kill-resume harness/test file this plan extends"
provides:
  - "countWorkspaceAuthRows(client, workspaceId) — reads member/invitation counts on the ordinary platform pool, before any destructive delete"
  - "recordAuthPurgeCounts write-once merge (jsonb_build_object as LEFT operand, existing table_counts as RIGHT operand) — a member/invitation key already recorded can never be overwritten by a later zero"
  - "Auth-step statement order in workspace-purge.worker.ts: count -> record -> delete -> afterAuthDelete seam -> mark-done"
  - "afterAuthDelete test-only seam on ProcessWorkspacePurgeDeps, fired the instant deleteWorkspaceAuthRows returns"
  - "after_auth_delete kill mode in workspace-purge-kill-entrypoint.ts, and the eighth real-SIGKILL kill-resume regression case proving the crash window is closed"
  - "SPECIFICATION.md purge_records (§4) and workspace-purge tick (§5) sections reconciled with the new ordering and write-once semantics"
affects: [workspace-quiesce-physical-purge, purge-watchdog, workspace-restore]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Capture-before-destroy: read evidence on the ordinary pool BEFORE the elevated-pool delete runs, so a crash window between delete-commit and checkpoint-write can never lose the evidence"
    - "Write-once jsonb merge via operand order: jsonb_build_object(...) || existing_column (new value LEFT, existing RIGHT) relies on Postgres's right-operand-wins rule for duplicate keys, no WHERE guard needed"

key-files:
  created: []
  modified:
    - apps/worker/src/queues/workspace-purge-auth.ts
    - apps/worker/src/queues/workspace-purge-checkpoint.ts
    - apps/worker/src/queues/workspace-purge.worker.ts
    - apps/worker/src/test/harness/workspace-purge-kill-entrypoint.ts
    - apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts
    - apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts
    - SPECIFICATION.md

key-decisions:
  - "Closed the gap from BOTH ends per the plan's own objective: reordering count/record ahead of the delete alone still lets a resumed tick re-count zero and overwrite; write-once alone still records zero as the first write if nothing was captured earlier. Neither alone is sufficient; together the window is closed by construction."
  - "countWorkspaceAuthRows runs on the ORDINARY mega_crm_app platform pool (migration 0045's existing SELECT grant), never the elevated mega_crm_auth pool — preserves plan 22-07's 'exactly two statements against exactly two tables' invariant on the elevated connection."
  - "Write-once achieved via jsonb || operand order (new object LEFT, existing column RIGHT), not a WHERE guard — Postgres's right-operand-wins rule on duplicate keys handles both auth keys independently with no extra SQL clause."
  - "Migration 0068's own COMMENT ON TABLE text is left untouched (never rewrite an applied migration); SPECIFICATION.md is documented as the reconciled authority for the two auth keys' semantics."

patterns-established:
  - "Test-only seam threading pattern (afterAuthDelete) mirrors the existing afterTableWalk seam exactly — same optional-parameter position, same no-op-in-production doc-comment discipline, same real-SIGKILL harness wiring shape."

requirements-completed: ["PRG-02"]

coverage:
  - id: D1
    description: "A purge killed after deleteWorkspaceAuthRows commits but before the auth step is marked complete resumes and ends with purge_records.table_counts carrying the REAL destroyed member/invitation counts, never zeros"
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts#kill after the auth delete commits: the resumed run records the REAL member/invitation counts, never zeros"
        status: pass
    human_judgment: false
  - id: D2
    description: "recordAuthPurgeCounts never replaces a member/invitation key already present in table_counts; a second call with different numbers leaves the first-written numbers intact"
    requirement: "PRG-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#recordAuthPurgeCounts is write-once: a second call with different numbers never overwrites the first-written counts"
        status: pass
    human_judgment: false
  - id: D3
    description: "A workspace with no member/invitation rows still ends with member: 0 and invitation: 0 present in table_counts"
    requirement: "PRG-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#recordAuthPurgeCounts on a genuinely empty workspace still records both keys present at zero"
        status: pass
    human_judgment: false
  - id: D4
    description: "countWorkspaceAuthRows counts member/invitation on the ordinary platform pool, never the elevated mega_crm_auth pool; deleteWorkspaceAuthRows still issues exactly two DELETEs against exactly two tables"
    requirement: "PRG-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts#countWorkspaceAuthRows reads member/invitation on the ordinary pool, scoped to the workspace"
        status: pass
      - kind: other
        ref: "grep -v comments apps/worker/src/queues/workspace-purge-auth.ts | grep -c 'DELETE FROM' == 2"
        status: pass
    human_judgment: false
  - id: D5
    description: "npm run failure:workspace-purge-resume passes with 8 real-SIGKILL cases (was 7)"
    requirement: "PRG-02"
    verification:
      - kind: integration
        ref: "npm run failure:workspace-purge-resume"
        status: pass
    human_judgment: false
  - id: D6
    description: "SPECIFICATION.md §4/§5 reconciled with the reordered auth step and write-once census semantics"
    verification:
      - kind: other
        ref: "grep -n countWorkspaceAuthRows SPECIFICATION.md (§5) and grep -n table_counts SPECIFICATION.md (§4, member+invitation)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-08-24
status: complete
---

# Phase 22 Plan 11: Crash-Safe Auth-Step Purge Census Summary

**Closed a real crash window where a workspace purge killed right after the Better Auth `member`/`invitation` delete committed could permanently overwrite the true destroyed-row census with zeros — fixed by counting on the ordinary pool and writing write-once before the delete, proven with an eighth real-SIGKILL regression case.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-24 (worktree base 1c4ffd4)
- **Completed:** 2026-08-24T11:04Z
- **Tasks:** 3 (TDD RED, TDD GREEN, doc + regression)
- **Files modified:** 7

## Accomplishments
- Added the `afterAuthDelete` test-only seam (mirrors the existing `afterTableWalk` seam) and a new `after_auth_delete` real-SIGKILL harness kill mode, freezing the instant `deleteWorkspaceAuthRows` returns — the last unmarked window inside the auth step.
- Added the eighth kill-resume regression case, proven RED against unmodified production code (received `member: 0, invitation: 0` where `1` was expected) before any fix landed.
- Exported `countWorkspaceAuthRows(client, workspaceId)`, reading `member`/`invitation` on the ordinary `mega_crm_app` platform pool under migration 0045's existing `SELECT` grant — no new grant, no migration.
- Made `recordAuthPurgeCounts` write-once by inverting the jsonb `||` concatenation operand order (new object LEFT, existing `table_counts` RIGHT), relying on Postgres's right-operand-wins rule on duplicate keys.
- Reordered the auth step in `workspace-purge.worker.ts` to `count -> record -> delete -> afterAuthDelete seam -> mark-done`, capturing and durably writing the real counts BEFORE the destructive delete runs at all — closing the crash window from both ends simultaneously.
- Added a drift `logger.warn` (workspaceId + four integers only, no PII) for the rare case the pre-delete count and the delete's own returned count disagree.
- Reconciled `SPECIFICATION.md` §4 (`purge_records.table_counts` semantics) and §5 (auth-step statement ordering) with the new code, without touching migration `0068`'s own `COMMENT ON TABLE` text.

## Task Commits

Each task was committed atomically:

1. **Task 1 (RED): afterAuthDelete seam, after_auth_delete kill mode, and the failing eighth kill-resume case** - `c70e15b` (test)
2. **Task 2 (GREEN): count on the platform pool before the delete, and make the census merge write-once** - `62307c7` (feat)
3. **Task 3: Record the corrected census semantics in SPECIFICATION.md and run the phase regression** - `4c008e2` (docs)

**Plan metadata:** (this SUMMARY's own commit, made by the worktree executor immediately after this file)

## Files Created/Modified
- `apps/worker/src/queues/workspace-purge-auth.ts` - new exported `countWorkspaceAuthRows`, running on the ordinary platform pool
- `apps/worker/src/queues/workspace-purge-checkpoint.ts` - `recordAuthPurgeCounts` write-once merge + reconciled doc comments
- `apps/worker/src/queues/workspace-purge.worker.ts` - auth-step block reordered (count -> record -> delete -> seam -> mark-done), `afterAuthDelete` dep field threaded through, drift-warning log added
- `apps/worker/src/test/harness/workspace-purge-kill-entrypoint.ts` - new `after_auth_delete` kill mode
- `apps/worker/src/queues/__tests__/failure-injection/workspace-purge-resume.test.ts` - eighth real-SIGKILL kill-resume case
- `apps/worker/src/queues/__tests__/workspace-purge-auth.test.ts` - five new unit cases for `countWorkspaceAuthRows` and the write-once merge
- `SPECIFICATION.md` - §4/§5 reconciled with the new ordering and semantics

## Decisions Made
- Closed the gap from both ends per the plan's own objective: neither reordering alone nor write-once alone is sufficient (reordering alone still lets a resumed tick re-count zero and overwrite; write-once alone still records zero as the first write). Together they close the window by construction.
- `countWorkspaceAuthRows` deliberately stays on the ordinary `mega_crm_app` pool, never the elevated `mega_crm_auth` pool, to preserve plan 22-07's "exactly two statements against exactly two tables" invariant on the elevated connection.
- Write-once implemented via jsonb `||` operand order rather than a `WHERE` guard — simpler, and handles both auth keys independently without extra SQL.
- Migration `0068`'s own `COMMENT ON TABLE` text is left untouched (an applied migration is never rewritten); `SPECIFICATION.md` is now the explicitly-documented reconciled authority for the two auth keys' semantics.

## Deviations from Plan

None - plan executed exactly as written. One self-correction during execution: an early `SPECIFICATION.md` edit accidentally duplicated the pre-existing "Провал auth-шага" paragraph; caught and fixed before committing Task 3 (verified via `grep -c` returning 1, not 2).

## Issues Encountered
- An observed, non-reproducible test-DB load flake (`WorkspaceRestoredError` thrown inside `beginDestructivePhase`) surfaced twice when running multiple `workspace-purge*` test files together in one vitest invocation (once combining `workspace-purge-auth.test.ts` + `workspace-purge.test.ts`, once running the full `src/queues/__tests__/` directory and hitting `workspace-purge-neighbour-safety.test.ts`). Confirmed unrelated to this plan's changes: isolated single-file runs passed cleanly, and the exact acceptance-criteria command (the four purge-related suites run together, no other files sharing the invocation) passed 46/46 on its own. Documented in `deferred-items.md` under `## Plan 22-11`; not fixed here (out of scope — the failure is inside `beginDestructivePhase`'s restore-guard, code this plan never touches).
- The full `npm run test -w apps/worker` run showed only the two already-documented pre-existing failures (`sentry.test.ts` no-DSN case, `stop-grace-period-publish.test.ts` build prerequisite); `erasure-enqueue-crash.test.ts` did not fail on this particular run, consistent with it being an intermittent (not deterministic) pre-existing flake per plans 22-04/22-09's own notes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `purge_records.table_counts` is now provably crash-safe end to end for the auth step, closing verification gap 2 from `22-VERIFICATION.md`/`22-REVIEW.md`.
- No blockers for gap-closure plan 22-12 or the phase's overall completion.

## Self-Check: PASSED

All 7 code/spec files and both `.planning` artifact files confirmed present on disk; all 4 commits (`c70e15b`, `62307c7`, `4c008e2`, plus this SUMMARY's own `30e4f3e`) confirmed present in `git log`.

---
*Phase: 22-workspace-quiesce-physical-purge*
*Completed: 2026-08-24*
