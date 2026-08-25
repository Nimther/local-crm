---
phase: quick-260825-qhm
plan: 01
subsystem: infra
tags: [broken-windows-ledger, gsd-tools, playwright, redaction, deploy, vite, pgbackrest]

requires: []
provides:
  - "Evidence-backed verdict for all 10 open WINDOWS.md entries (ids 1,2,3,5,8,9,10,11,12,13)"
  - "3 entries closed through gsd-tools windows fixed (ids 2, 12, 13), reducing open_count 10 -> 7"
  - "4 waive proposals with verified citations, awaiting developer approval (ids 1, 3, 9, 11)"
  - "2 confirmed defects with /gsd-debug recommendations (ids 5, 8)"
  - "1 residual-gap with a next-milestone recommendation (id 10)"
affects: [gsd-ship, next-milestone-planning]

tech-stack:
  added: []
  patterns: ["Ledger mutation only via gsd-tools windows fixed; waive proposals recorded in report, never applied by an executor"]

key-files:
  created:
    - .planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md
  modified:
    - .planning/WINDOWS.md

key-decisions:
  - "Id 2 (Playwright config load) reclassified from Unknown to FIXED: reproduced clean --list run, and dated fix commit 1402968 (2026-08-11) post-dates the ledger entry (recorded 2026-08-07) — the ledger was simply never closed after the fix landed"
  - "Id 8 (redaction UUID false positive) confirmed as a live defect distinct from the 3cd3f0c anchoring fix: all-digit-group UUIDs (no hex letters in any group) have no boundary for that fix's [0-9A-Za-z-] anchor to exploit, so the entire digit run still matches as a phone number"
  - "Id 10 (alloy) confirmed RESIDUAL-GAP not FIXED: alloy is defined in docker-compose.prod.yml but has zero non-comment occurrences in scripts/deploy.sh's mutating up -d calls, which explicitly enumerate services (web api, worker) rather than starting everything"
  - "Id 5 not run at all (constraint): shared-Redis flake proven structurally (no isolation mechanism found in flow-queues.ts/queue-core), not by executing the flaky test"

requirements-completed: [QT-260825-qhm]

coverage: []

duration: ~15min
completed: 2026-08-25
status: complete
---

# Quick Task 260825-qhm: Evidence-Based Audit of `.planning/WINDOWS.md` Summary

**Audited all 10 open broken-window ledger entries against live code/test evidence; closed 3 provably-fixed entries through `gsd-tools windows fixed`, proposed 4 waives for developer approval, and confirmed 2 genuine defects plus 1 residual deploy-path gap — `open_count` dropped from 10 to 7.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-08-25T14:27:39Z
- **Tasks:** 3 (all completed, no checkpoints)
- **Files modified:** 1 (`.planning/WINDOWS.md`), 1 created (`260825-qhm-AUDIT.md`, left uncommitted for the orchestrator)

## Accomplishments

- Every one of the 10 open ids (1, 2, 3, 5, 8, 9, 10, 11, 12, 13) resolved to exactly one of four evidence-backed verdicts, each with the executor's own execution-time command output recorded in `260825-qhm-AUDIT.md`
- 3 entries closed via `gsd-tools windows fixed` (never by hand-editing the file): id 12 (deploy.sh `--no-deps`, 21/21 guard tests pass), id 13 (vite `strictExecutionOrder` + CI-wired `check-web-chunks` gate), id 2 (Playwright config loads clean, fix commit `1402968` identified)
- id 8's root cause pinned precisely: an all-digit-group UUID has no hex-letter boundary for the existing anchoring fix to exploit — a distinct failure mode from the one `3cd3f0c` already fixed, reproduced live with a single fixed input, no probabilistic sampler run
- id 10 correctly discriminated as a real deploy-path gap (not a waivable ratification): alloy is defined in `docker-compose.prod.yml` but absent from every mutating call in `scripts/deploy.sh`
- 4 waive proposals drafted with verified citations (file existence checked before quoting) and single-line pass-through reasons, none applied
- Zero full-suite test runs; zero test runs at all for id 5 per constraint; single fixed UUID input for id 8, never the 5000-sample sampler

## Task Commits

1. **Task 1: Gather execution-time evidence for ids 12, 13, 10, 8, 2, 5** — report-only, no ledger commit (evidence written to `260825-qhm-AUDIT.md`)
2. **Task 2: Establish waive basis for ids 1, 3, 9, 11** — report-only, no ledger commit
3. **Task 3: Close provably-fixed entries and commit the ledger** — `8489c0c` (docs: close provably-fixed broken-window entries after evidence audit)

**Branch:** `fix/auth-session-lifecycle`

_Note: the audit report `260825-qhm-AUDIT.md` is intentionally left UNCOMMITTED per the plan's output spec — the orchestrator owns the docs commit alongside this SUMMARY.md, STATE.md._

## Files Created/Modified

- `.planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md` — full per-id evidence report, all 10 verdicts, summary table, waive proposals, defect recommendations (created, left uncommitted)
- `.planning/WINDOWS.md` — mutated only via `gsd-tools windows fixed <id>` for ids 12, 13, 2; committed path-scoped as `8489c0c`

## Decisions Made

- Id 2 reclassified FIXED (was "Unknown" at plan time) — see key-decisions above
- Id 8 confirmed DEFECT-CONFIRMED with a precisely identified root cause (all-digit-group UUID case), distinct from the already-fixed mid-token case
- Id 10 confirmed RESIDUAL-GAP, not eligible for waive
- Id 5 verdict reached with zero test executions, per hard constraint 10

## Deviations from Plan

None — plan executed exactly as written. All hard constraints honored: ledger mutated only via the tool, no `windows waive`/`windows append` run, no full-suite or backgrounded test runs, no Write/Edit ever opened on `.planning/WINDOWS.md`, commit staged path-scoped and made with plain `git commit`, post-commit re-grep performed and passed.

## Issues Encountered

None. All automated `<verify>` blocks from the plan (task 1, task 2, task 3) were run and passed:
- Six code-entry sections present; verdict-label grep count 21
- Four deviation sections present; all ten ids covered; ledger untouched before Task 3
- Ledger invariants held (`total_count` 13, `waived_count` 0, `open_count`/`fixed_count` moved by exactly 3); ship-gate wording intact; `git show --numstat` names only `.planning/WINDOWS.md`; ledger committed clean

## Waive Proposals Awaiting Developer Approval

| id | proposed reason |
|----|------------------|
| 1 | Un-fixable tombstone: pre-phase-12 ledger loss (5 entries) from a worktree force-commit overwriting an untracked file on merge; WINDOWS.md is now git-tracked (git ls-files confirms) and the exact recurrence action is now forbidden by standing executor constraints — nothing further can restore the lost entry or prevent a structurally identical loss. |
| 3 | Documented design deviation (11-02-SUMMARY.md, Rule 3 blocking-fix): audit-sends-history.ts uses SCAN_DATABASE_URL + a rollback-only per-workspace loop instead of a single DATABASE_URL connection, because RLS on sends/send_events makes the literal plan design structurally impossible; still the shipped code (packages/db/scripts/audit-sends-history.ts:220). |
| 9 | Superseded plan assertion, not a defect: 17-05's literal WAL criterion ('failed_count is 0 in both reads') was unsatisfiable against this host's cumulative pg_stat_archiver history and was ratified-replaced by a strictly-better criterion (archived_count strictly increases, failed_count unchanged from baseline, last_failed unmoved), independently confirmed twice in the same plan (17-05-SUMMARY.md). |
| 11 | pgBackRest 2.59.1-vs-2.59.0 drift ratified as expected (17-05-SUMMARY.md): unpinned apt-get install against pgdg, provenance/tag-immutability threats unaffected, cross-version restore (2.59.0-written backups restored by 2.59.1) proven live; docs/runbooks/backups.md already corrected to 2.59.1. |

## Confirmed Defects / Recommendations

| id | verdict | recommendation |
|----|---------|-----------------|
| 5 | DEFECT-CONFIRMED | `/gsd-debug` — shared-Redis test isolation for `apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts`; candidate fix: per-suite unique BullMQ queue-name prefix or dedicated Redis logical DB per worker test file |
| 8 | DEFECT-CONFIRMED | `/gsd-debug` — `packages/redaction/src/rules.ts` phone valueRule; fix direction: exclude UUID-shaped values before applying the rule |
| 10 | RESIDUAL-GAP | next-milestone requirement — add `alloy` to `scripts/deploy.sh`'s mutating-service startup path so a fresh production bring-up durably (re)establishes the sidecar |

**Informational, non-blocking:** `docker/postgres/Dockerfile`'s header comment (lines 32, 37) still reads "2.59.0" — cosmetic, already acknowledged as out-of-scope by 17-05-SUMMARY.md; suggested `/gsd-quick` to update the string, no urgency.

## Ledger State

- Branch: `fix/auth-session-lifecycle`
- Commit sha: `8489c0c7a02ff99707d519fdea2cb433bf408da1`
- `open_count`: 10 → **7**
- `fixed_count`: 3 → **6**
- `waived_count`: 0 (unchanged — zero waives applied)
- `total_count`: 13 (unchanged)
- Remaining open ids (1, 3, 5, 8, 9, 10, 11) continue to block `/gsd-ship` by design until the developer approves the waive proposals and/or the confirmed defects are fixed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The orchestrator should present the 4 waive proposals to the developer for approval; upon approval, apply via `gsd-tools windows waive <id> "<reason>"` (never by this executor).
- The 2 confirmed defects (ids 5, 8) and the 1 residual gap (id 10) are candidates for `/gsd-debug` sessions or next-milestone requirements respectively.
- `/gsd-ship` remains blocked (`open_count: 7 > 0`) until further action on the remaining entries.

---
*Quick task: 260825-qhm*
*Completed: 2026-08-25*
