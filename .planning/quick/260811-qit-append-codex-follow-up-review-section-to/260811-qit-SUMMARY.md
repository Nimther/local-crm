---
task: 260811-qit
title: Append Codex follow-up review section to 13-REVIEWS.md
status: complete
requirements: [QT-260811-qit]
files_modified:
  - .planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md
commits:
  - 40d8259
  - 0c7ea51
  - b37e7bd
---

# Quick Task 260811-qit: Append Codex follow-up review section Summary

One-liner: appended a six-finding "Codex follow-up review" section (4 BLOCKER, 2 WARNING) to
13-REVIEWS.md, each finding grounded with affected-plan citations, acceptance tests, threat-model
updates, and suggested fixes, without touching a byte of the file's existing frontmatter/Claude
review or any Phase 13 PLAN file.

## What was done

Three atomic commits, one per plan task:

1. **40d8259** — appended the section header (`## Codex follow-up review`, reviewer/status/legend
   paragraphs) plus Finding 1 (BLOCKER, 13-10: suppression evidence missing for previously
   subscribed contacts).
2. **0c7ea51** — appended Findings 2-4 (the remaining BLOCKERs): Finding 2 (13-10:
   `UPDATE ... RETURNING` cannot capture the pre-update email after `email = NULL` in the same
   statement), Finding 3 (13-10: `erasure_records` needs durable-outbox semantics with a
   reclaimer), Finding 4 (13-13: `REDACTION_RULES` denylist cannot bound arbitrary tenant-defined
   PII).
3. **b37e7bd** — appended Findings 5-6 (the WARNINGs): Finding 5 (13-07: dedup-index migration
   mechanism left to executor discretion), Finding 6 (13-06: expired incomplete/attempt-capped
   journal rows must leave evidence before pruning). Ran the full-section integrity gate after
   this commit.

The appended section begins at **line 106** of the final 229-line file (`## Codex follow-up
review`); the file's first 102 lines (frontmatter + entire pre-existing Claude review + Consensus
Summary) are confirmed byte-identical throughout — `head -102 | shasum -a 256` returned
`c220eac6d62368978c7bfb8084d54cecec376055400723fa30e6e74c13acaac5` after every one of the three
commits, matching the pinned pre-task value.

## Grounding verification performed before writing each finding

Before authoring each finding's four subsections, the actual line numbers and threat-table rows
cited in the quick-task PLAN's `<read_first>`/`<action>` text were re-confirmed against the
current (post-replan) Phase 13 PLAN files, not assumed from the quick-task plan's own prose:

- **13-10-PLAN.md** (Findings 1-3): confirmed line 194 ("keep the existing conditional
  suppression insert exactly as it is"), line 208 (the acceptance criterion asserting no
  suppression row for a subscribed contact), line 191 (the anonymizing UPDATE claiming to
  return "the pre-update email" via its own RETURNING clause), line 195-196 (the erasure_records
  insert + enqueue-ordering step), and threat rows T-13-10-01/02/04/05/06.
- **13-13-PLAN.md** (Finding 4): confirmed line 106 (`REDACTION_RULES` reuse instruction), line 37
  (the matching key_link), line 264 (`flagged_assumptions` conceding the unknown-tenant-key
  residual risk), and threat rows T-13-13-01/03/06.
- **13-07-PLAN.md** (Finding 5): confirmed lines 180-182 (the `CREATE INDEX CONCURRENTLY` build
  and the "if the runner cannot express that, fall back to..." hand-off), and threat rows
  T-13-07-02/03.
- **13-06-PLAN.md** (Finding 6): confirmed line 26 (the must-have truth "deleted ... whether or
  not they were ingested"), line 126 (the `WEBHOOK_REPLAY_MAX_ATTEMPTS` cap rationale citing the
  13-11 watchdog), line 172 (the prune-after-replay ordering), and threat rows T-13-06-02/06.

No hedging was required in any of the six findings — every line reference and T-13-NN row named
in the authored subsections was verified present at the cited location in the actual PLAN file
text (not just asserted from the quick-task plan's own prose), so no finding's grounding had to be
softened or generalized away from a specific anchor.

## T-13-NN threat rows each finding was mapped to

| Finding | Plan | Threat rows amended |
|---|---|---|
| 1 (BLOCKER) | 13-10 | T-13-10-04, T-13-10-05 |
| 2 (BLOCKER) | 13-10 | T-13-10-01, T-13-10-04 |
| 3 (BLOCKER) | 13-10 | T-13-10-02 (stays valid), T-13-10-06 |
| 4 (BLOCKER) | 13-13 | T-13-13-01, T-13-13-06, T-13-13-03 (surviving obligation) |
| 5 (WARNING) | 13-07 | T-13-07-02, T-13-07-03 |
| 6 (WARNING) | 13-06 | T-13-06-02, T-13-06-06 |

## Verification gate substitution (worktree vs. main-checkout paths)

The plan's `<verify>` blocks hardcode absolute main-repo paths (`/Users/primeropanther/Projects/
mega-crm/...`) and a `git -C "$G"` invocation against that main checkout. Running as written
inside the worktree would have graded the main repo's untouched 13-REVIEWS.md (every finding-grep
would FAIL) and the harness had already refused an earlier compound `git -C` command for reaching
outside the worktree. Every gate was re-run in worktree-relative form instead, after each commit:

- `head -102 .planning/.../13-REVIEWS.md | shasum -a 256` — confirmed match to the pinned hash
  three times (after each task's commit).
- `grep -Fc '<verbatim finding string>' .planning/.../13-REVIEWS.md` — confirmed count 1, per
  finding, cumulatively (1 → 4 → 6 findings present as each task landed).
- `grep -c '^### Finding '` and the four `grep -c '^\*\*Label:\*\*'` counts — confirmed 1/4/6
  matching the number of findings landed at each commit, and each of the four bold labels at
  exactly that same count.
- `git diff --numstat -- .planning/.../13-REVIEWS.md` — confirmed 0 deleted lines at every step.
- `git status --porcelain -- apps packages` — confirmed empty at every step (no source-tree
  writes).

**One gate substitution, noted per the advisor's guidance:** the plan's pinned collective-hash
check (`shasum -a 256 "$D13"/13-*-PLAN.md "$D13"/13-CONTEXT.md | shasum -a 256` == `298d2635...`)
is unreproducible from inside the worktree, because the outer `shasum` digests each inner line
*including the path string it was computed against*, and the worktree's absolute paths differ
from the main checkout's. This was not chased. The equivalent-strength substitute used instead:
`git status --porcelain -- .planning/phases/13-compliance-analytics-integrity` lists exactly one
modified file (`13-REVIEWS.md`) at every checkpoint. Since the worktree's HEAD (`e8c66c47`) is the
same commit the pinned hash was originally computed against, "clean in git for every other file in
that directory" is logically equivalent to "byte-identical to the pinned state" for the fourteen
PLAN files and CONTEXT.md — git would show a modified/`??` entry for any of them otherwise. This
substitution was verified after every one of the three commits, not just once at the end.

## Final state

- 13-REVIEWS.md: 229 lines total, first 102 lines byte-identical to pre-task state, section
  starting at line 106, six findings (`### Finding 1` … `### Finding 6`) each with all four bold
  subsection labels (`**Affected plan(s):**`, `**Required acceptance tests:**`,
  `**Threat-model update:**`, `**Suggested fix:**`), original BLOCKER/WARNING severity and
  1-6 numbering preserved verbatim from the six supplied finding strings.
- Zero deleted lines across the full diff (`git diff --numstat` against the pre-task HEAD).
- No Phase 13 PLAN file, no `13-CONTEXT.md`, and nothing under `apps/` or `packages/` was
  modified — confirmed by `git status --porcelain` returning empty for those paths after every
  commit.
- Three commits, each touching exactly one path (`git show --name-only --format= HEAD` confirmed
  after each): `40d8259`, `0c7ea51`, `b37e7bd`.

## Self-Check: PASSED

- `.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md` — FOUND, 229 lines, section
  present at line 106.
- Commit `40d8259` — FOUND in `git log --oneline`.
- Commit `0c7ea51` — FOUND in `git log --oneline`.
- Commit `b37e7bd` — FOUND in `git log --oneline`.
- `head -102 | shasum -a 256` — matches pinned `c220eac6d62368978c7bfb8084d54cecec376055400723fa30e6e74c13acaac5`.
- `grep -c '^### Finding '` — 6.
- All four bold labels — 6 each.
- `git status --porcelain -- apps packages` — empty.
