---
phase: 12-worker-reliability-tenant-fairness
plan: 13
subsystem: docs
tags: [documentation, gap-closure, worker-reliability]

# Dependency graph
requires:
  - phase: 12-worker-reliability-tenant-fairness
    provides: "plan 12-12's autorun-clobber fix (commit 4bc0750) and its regression test worker-autorun-default.test.ts, which this plan's §5.1/§5.2 re-verification cites as evidence"
provides:
  - "ARCHITECTURE.md's forward-looking Phase 12 entry reduced to the one genuinely unshipped item (backing-store memory ceiling), with the shipped retention policy pointed at SPECIFICATION.md §5.3 instead of restated as open"
  - "SPECIFICATION.md §5.1/§5.2 re-verified against observed consumption: the autorun mechanism documented as-built, registration-vs-consumption stated as separate facts, and the sixteen-workers-operational claim re-attributed from the registration log line to actual evidence"
  - "A recorded finding (not a fix) that ARCHITECTURE.md's Phase 10 and Phase 11 forward-looking bullets are themselves now stale -- out of this gap's scope"
affects: ["any future phase editing ARCHITECTURE.md's forward-looking section or SPECIFICATION.md §5.1/§5.2/§9"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SPECIFICATION.md §9 numbered-item convention reused for a new entry (#22) recording that a claim was previously stated from registration alone -- same voice as the existing plan-closed-this-point entries"

key-files:
  modified:
    - ARCHITECTURE.md
    - SPECIFICATION.md

key-decisions:
  - "Task 1 scope held strictly to the Phase 12 bullet: the Phase 10 (RLS unification) and Phase 11 (delivery state machine) forward-looking bullets are also now stale but were reported as findings below, not rewritten, per the plan's explicit instruction that they belong to their own phases' documentation"
  - "SPECIFICATION.md §5.2's claim about the eleven workers never affected by G-12-1 cites the G-12-1 runtime diagnosis's live Redis BZPOPMIN inspection and each worker's own behavioral test suites, not a post-fix live boot log -- the plan's action text asked for 'the post-fix boot observation', but 12-12's own SUMMARY records that check as an outstanding human-check item (D5) that was never performed; citing an observation that doesn't exist would recreate this gap's own root cause one paragraph later"

requirements-completed: [WRK-09, WRK-13]

coverage:
  - id: D1
    description: "The forward-looking Phase 12 bullet names only the memory-ceiling item as unshipped and points at SPECIFICATION.md §5.3 for the shipped retention policy"
    requirement: "WRK-09"
    verification:
      - kind: automated
        ref: "grep -q '^- \\*\\*Phase 12 — worker reliability.*memory ceiling' ARCHITECTURE.md && grep '^- \\*\\*Phase 12 — worker reliability' ARCHITECTURE.md | grep -c 'remain open' -> 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "SPECIFICATION.md §5.1 documents the autorun run-loop option as as-built, citing the regression test and the plan that closed the defect"
    requirement: "WRK-13"
    verification:
      - kind: automated
        ref: "grep -q 'autorun' SPECIFICATION.md && grep -q 'worker-autorun-default.test.ts' SPECIFICATION.md && grep -q '12-12' SPECIFICATION.md"
        status: pass
    human_judgment: false
  - id: D3
    description: "SPECIFICATION.md §5.2 still records sixteen workers and attributes the operational claim to observed consumption evidence, not the registration log line"
    requirement: "WRK-13"
    verification:
      - kind: manual
        ref: "Manual re-read of the amended §5.2 paragraph against the plan's acceptance criteria"
        status: pass
    human_judgment: true
    rationale: "No automated check can verify a document no longer 'attributes a claim to a boot log' -- this is a prose-content check, done via careful re-read (and caught two factual errors on the first pass, corrected in a follow-up commit before this SUMMARY was written)."
  - id: D4
    description: "Both files show bounded, scoped edits, not whole-file rewrites"
    verification:
      - kind: automated
        ref: "git diff --stat 830ab19f6ca3d83215cee9d9686a5a593545e8c8 HEAD -- ARCHITECTURE.md SPECIFICATION.md -> ARCHITECTURE.md 2 +-, SPECIFICATION.md 9 +++++++++ (net across all three commits)"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-11
status: complete
---

# Phase 12 Plan 13: Documentation staleness gap closure (G-12-2) Summary

**Reduced ARCHITECTURE.md's forward-looking Phase 12 entry to the one genuinely unshipped item and re-verified SPECIFICATION.md's worker-scheduling sections against observed consumption evidence rather than the registration log line, catching and fixing two of its own factual errors in the process before this summary was written.**

## Performance

- **Duration:** 45 min
- **Tasks:** 2 (plus one corrective follow-up commit found via advisor review before completion)

## Accomplishments

- **Task 1 (ARCHITECTURE.md):** Rewrote the forward-looking Phase 12 bullet in place. It previously claimed queue retention policy was unshipped, directly contradicting SPECIFICATION.md §5.3 (which documents plan 12-09's 7-day `removeOnFail` and the durable dead-letter path from plans 12-07/12-10). The bullet now states retention is shipped, points readers at §5.3 for the policy and rationale, and names the backing store's memory-ceiling behaviour as the only genuinely open item. Scanned the rest of ARCHITECTURE.md for other stale retention/dead-letter claims -- found none beyond the one bullet.
- **Task 2 (SPECIFICATION.md §5.1/§5.2):** Verified the precondition (`worker-autorun-default.test.ts` green, 8/8 passing) before editing. Added an as-built paragraph to §5.1 documenting the `autorun` option as a test-only factory argument never read from configuration/environment, the omission mechanism (conditional spread, not nullish-coalescing), the five affected factory files, and the history of how the defect originated (Phase 9, plan 09-02) and spread (Phase 11's `send-reconciler.worker.ts` at creation, then Phase 12's three-worker migration in plan 12-08) before being closed by plan 12-12. Added a second §5.1 paragraph and a §5.2 amendment stating that scheduler registration and job consumption are separate facts, and re-attributing the sixteen-workers-operational claim to actual evidence (the regression test for the five previously-broken workers; the G-12-1 runtime diagnosis's live BZPOPMIN inspection plus each worker's own behavioral suites for the other eleven) instead of the registration log line the claim previously rested on. Added a §9 history entry (item 22) recording that this claim was once stated from registration alone.
- **Self-caught correction:** an advisor review before finalizing found two factual errors in the first draft of the §5.1/§5.2 edits -- see Deviations below. Both were fixed in a follow-up commit before this SUMMARY was written.

## Task Commits

1. **Task 1: Reduce the forward-looking Phase 12 entry** - `5482ecd` (docs)
2. **Task 2: Re-verify worker-scheduling sections** - `b9e8c09` (docs)
3. **Corrective follow-up (deviation, see below)** - `8d4168b` (docs)

## Files Created/Modified

- `ARCHITECTURE.md` - forward-looking Phase 12 bullet rewritten in place (1 line changed)
- `SPECIFICATION.md` - §5.1 gained two new paragraphs (autorun mechanism/history, registration-vs-consumption), §5.2 gained one new paragraph (sixteen-workers evidence re-attribution), §9 gained one new numbered entry (22)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] flow-segment-sweep.worker.ts incorrectly included in the "six factories accepting autorun" claim**
- **Found during:** Advisor review before finalizing, cross-checked against the plan's own earlier grep output (zero `autorun` matches in that file)
- **Issue:** The first draft of the new §5.1 paragraph said "each of six tick factories (..., `flow-segment-sweep.worker.ts`) accepts an optional `autorun`" -- but that file declares no such parameter at all, which the same draft's next paragraph correctly stated two sentences later. A specification asserting a factory signature the code doesn't have is exactly the failure mode this gap-closure plan exists to eliminate.
- **Fix:** Changed "six" to "five", removed `flow-segment-sweep.worker.ts` from the list of factories accepting the parameter, and added a clause naming it as the factory that declares no such parameter at all.
- **Files modified:** SPECIFICATION.md
- **Commit:** 8d4168b

**2. [Rule 1 - Bug] §5.2 cited a post-fix live boot observation that the record shows was never performed**
- **Found during:** Advisor review before finalizing, cross-checked against 12-12-SUMMARY.md's own coverage table (item D5: `human_judgment: true`, "This executor ran in an isolated worktree with no access to that environment... could not perform this check")
- **Issue:** The plan's action text asked this section to cite "the post-fix boot observation" as evidence that the eleven workers never affected by G-12-1 are confirmed consuming. 12-12's own SUMMARY records that exact live-boot check as an outstanding, unperformed human-check item. Writing a citation to an observation that was never made would recreate this gap's own root cause (an operational claim asserted without the evidence behind it) one paragraph after correcting the original instance of it.
- **Fix:** Replaced the citation with evidence that does exist in the record: the G-12-1 UAT runtime diagnosis's live Redis inspection ("exactly 5 of 16 workers have no blocked BZPOPMIN connection" -- meaning the other eleven held one) plus each of those eleven workers' own behavioral test suites, which construct and run them against real jobs. Added a closing sentence noting the live post-fix boot observation in the target environment remains a separate, not-yet-performed step (plan 12-12, human-check D5), so this paragraph does not appear to substitute for it.
- **Files modified:** SPECIFICATION.md
- **Commit:** 8d4168b

**3. [Rule 1 - Bug] §5.1 mechanism paragraph mistagged with G-12-2 instead of G-12-1**
- **Found during:** Same advisor review pass
- **Issue:** The paragraph documenting the autorun mechanism and defect (which is G-12-1's subject matter -- the bug and its fix, plan 12-12) was tagged "(план 12-12, WRK-13, G-12-2)". G-12-2 is this plan's own documentation-staleness gap, not the runtime defect being documented.
- **Fix:** Changed the tag to G-12-1. (The separate §5.2 paragraph, which is genuinely this plan's G-12-2 work, was already correctly tagged and left unchanged.)
- **Files modified:** SPECIFICATION.md
- **Commit:** 8d4168b

---

**Total deviations:** 3 auto-fixed (Rule 1 -- factual/attribution errors caught before finalizing, none reaching the committed-and-declared-done state uncorrected)
**Impact on plan:** No change to scope. All three corrections tightened accuracy of the same two paragraphs written for Task 2; no new content or restructuring was introduced.

## Findings (not fixed -- out of this gap's scope)

Task 1's read_first instructed checking whether the neighbouring Phase 10 and Phase 11 forward-looking bullets are still accurate, since both phases have since completed, and reporting rather than silently rewriting them if stale. Both are stale:

- **Phase 10 — RLS unification bullet is stale.** It says "Unifying them must go in the fail-closed direction" as future work. SPECIFICATION.md §9 item 2 records that plan 10-07 (migration `0044_workspace_isolation_fail_closed.sql`) already unified all 22 tables onto one fail-closed, role-scoped predicate. This bullet now describes work that shipped in Phase 10.
- **Phase 11 — delivery state machine bullet is stale.** It says "A reconciling state is planned." ARCHITECTURE.md's own state-machine section (§9, lines ~146-182, in the same file) documents the `reconciling` state, its transition matrix, and the reconciler as already-shipped, present-tense mechanisms.

Both are outside G-12-2's scope (which named only the Phase 12 bullet and the specification's worker-scheduling sections) and belong to their own phases' documentation upkeep. Recorded here per the plan's explicit instruction, not corrected in this plan.

## Known Stubs

None.

## Threat Flags

None -- this plan edited only prose in two Markdown files; no new endpoint, auth path, file-access pattern, or schema change was introduced.

## Verification

- `vitest run --root apps/worker src/queues/__tests__/worker-autorun-default.test.ts` -- 8/8 passing (precondition for Task 2, re-confirmed before editing)
- `grep -q '^- \*\*Phase 12 — worker reliability.*memory ceiling' ARCHITECTURE.md` -- exits 0
- `grep '^- \*\*Phase 12 — worker reliability' ARCHITECTURE.md | grep -c 'remain open'` -- 0
- `grep -q 'autorun' SPECIFICATION.md && grep -q 'worker-autorun-default.test.ts' SPECIFICATION.md && grep -q '12-12' SPECIFICATION.md` -- all match
- `git diff --stat 830ab19f6ca3d83215cee9d9686a5a593545e8c8 HEAD -- ARCHITECTURE.md SPECIFICATION.md` -- `ARCHITECTURE.md 2 +-`, `SPECIFICATION.md 9 +++++++++` -- two bounded edits, no whole-file rewrites
- All added SPECIFICATION.md prose confirmed in Russian (spot-checked; only code identifiers, `Phase N`, and test filenames are in English, matching the document's existing convention)

## Next Phase Readiness

- G-12-2 is closed: the two documents no longer contradict each other about failed-job retention/the dead-letter path, and the worker-scheduling sections describe consumption as an observed fact backed by a named test.
- This was the last plan in the phase's gap-closure wave (12-12 closed G-12-1, 12-13 closes G-12-2). Both UAT gaps from `12-UAT.md` are now closed.
- **Carried-forward outstanding item (not this plan's to close):** plan 12-12's own D5 human-check -- booting the worker process against the real development Redis instance that held the originally-reported backlog and confirming live drain -- was never performed (this executor and the 12-12 executor both ran in isolated worktrees with no access to that environment). SPECIFICATION.md §5.2 now explicitly notes this remains a separate, unperformed step rather than silently presenting it as done.
- **New findings recorded, not fixed:** ARCHITECTURE.md's Phase 10 and Phase 11 forward-looking bullets are now stale (see Findings above) and should be corrected by a future quick task or as part of those phases' own documentation upkeep.

---
*Phase: 12-worker-reliability-tenant-fairness*
*Completed: 2026-08-11*

## Self-Check: PASSED

- FOUND: ARCHITECTURE.md (modified, bounded edit confirmed via git diff --stat)
- FOUND: SPECIFICATION.md (modified, bounded edit confirmed via git diff --stat)
- FOUND commit: 5482ecd (Task 1)
- FOUND commit: b9e8c09 (Task 2)
- FOUND commit: 8d4168b (corrective follow-up)
