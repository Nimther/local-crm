---
phase: quick-260825-qhm
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/WINDOWS.md
  - .planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md
autonomous: true
requirements: [QT-260825-qhm]

must_haves:
  truths:
    - "Every one of the ten `status=open` ledger ids — 1, 2, 3, 5, 8, 9, 10, 11, 12, 13 — has its own verdict section in `.planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md`, each carrying execution-time evidence (the actual command run and its actual output), not a restatement of this plan's expectations."
    - "Each verdict is exactly one of four labels: FIXED (evidence attached, ledger updated), WAIVE-PROPOSED (basis stated, ledger NOT touched), DEFECT-CONFIRMED (no waive, `/gsd-debug` recommendation attached), or RESIDUAL-GAP (no waive, next-milestone requirement recommendation attached)."
    - "`total_count` in `.planning/WINDOWS.md` frontmatter is still 13 — no entry is added or removed by this task."
    - "`waived_count` in `.planning/WINDOWS.md` frontmatter is still 0 — this task proposes waives in the report only and never applies one."
    - "`open_count` equals `10` minus the number of ids marked fixed, and `fixed_count` equals `3` plus that same number, both recomputed by the tool rather than typed by hand."
    - "The ship-gate wording survives byte-identical: `.planning/WINDOWS.md` still contains the line `> Cross-phase defect register. \\`/gsd-ship\\` blocks while \\`open_count > 0\\`.`"
    - "Ids 12 and 13 are marked fixed (both independently confirmed at plan time), and every id marked fixed has its confirming evidence recorded in the report before the mutation is applied."
    - "The `.planning/WINDOWS.md` markdown table row and JSON block entry for every mutated id agree with each other and with the frontmatter counts — guaranteed by mutating only through the tool, never by editing the file."
  artifacts:
    - "`.planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md` — the audit report (new file, authored by this plan, left UNCOMMITTED for the orchestrator)"
    - "`.planning/WINDOWS.md` — mutated in place by `gsd-tools windows fixed` only, then committed path-scoped (pre-existing tracked file, NOT authored by this plan)"
  key_links:
    - "`gsd-tools windows fixed <id>` -> the three-way sync: `.planning/WINDOWS.md` holds the same data in three places (frontmatter counts, markdown table, JSON block). The tool rewrites all three atomically and recomputes counts. Any hand-edit, regeneration, or `Write` of this file desynchronizes them and corrupts the ledger — the file must never be opened with Write/Edit."
    - "`windows fixed` -> the report: the subcommand takes an id and NOTHING else (no reason argument, confirmed at plan time). The ledger therefore cannot carry evidence, so the report is the only place evidence exists. The report must be written BEFORE the mutation for every id being marked fixed."
    - "plain `git add .planning/WINDOWS.md` -> the tracked-file exception: `.gitignore` lists `.planning/`, but `WINDOWS.md` is already tracked, so plain path-scoped `git add` stages it. `gsd-tools commit` applies its own ignore check and returns `skipped_gitignored` for `.planning/` paths — it silently does nothing and must not be used for this file."
    - "the git commit -> post-commit grep verification: a tracked file under `.planning/` that is edited and then committed has previously been silently clobbered in this repo by an intervening git operation. Content must be re-grepped AFTER the final git command, not before."
---

<objective>
Audit all ten `status=open` entries in `.planning/WINDOWS.md` against the real current state of
the code and tests, and resolve each one to an evidence-backed verdict before the next milestone
opens.

Purpose: `open_count > 0` blocks `/gsd-ship`. Ten entries are open, but they are not ten defects —
the set is a mix of already-fixed items whose ledger rows were never closed, consciously-ratified
historical deviations, one un-fixable tombstone, and a residue of genuine defects. Shipping is
blocked by all ten indiscriminately, and closing them indiscriminately would hide the real ones.
This task separates the four groups with evidence.

Output: an audit report with a per-id verdict, and a ledger in which exactly the
provably-fixed entries are closed. Waives are PROPOSED in the report, never applied here.
</objective>

<execution_context>
@/Users/primeropanther/.claude/gsd-core/workflows/execute-plan.md
@/Users/primeropanther/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.claude/CLAUDE.md

`.planning/WINDOWS.md` is the payload being audited. Read it (read-only) to get each entry's
full description — but never open it with Write or Edit, and never regenerate it. All ten open
entries' ids and subject matter are already summarized in `<pinned_facts>`.
</context>

<pinned_facts>

Verified at plan time (2026-08-25) from repository root `/Users/primeropanther/Projects/mega-crm`.

**These are EXPECTATIONS, not evidence.** The report must cite the executor's own
execution-time command output. Re-run every check; do not copy a value out of this table.

| Fact | Value |
|------|-------|
| Ledger path | `.planning/WINDOWS.md` (tracked by git; `git ls-files --error-unmatch` succeeds) |
| Ledger counts at plan time | `open_count: 10`, `waived_count: 0`, `fixed_count: 3`, `total_count: 13` |
| Open ids | 1, 2, 3, 5, 8, 9, 10, 11, 12, 13 (ids 4, 6, 7 already `fixed`) |
| `windows` subcommands | `status`, `append`, `waive`, `fixed` (absent from the top-level `--help` list; it exists anyway) |
| `windows fixed` signature | one positional id, **no reason argument** |
| `windows fixed` on a resolved entry | throws `WINDOWS_ALREADY_RESOLVED` and exits non-zero — loud, not silent |
| `windows status` JSON shape | counts are NESTED: `{ ok, ledger: { open_count, waived_count, fixed_count, total_count, entries[] } }` |
| `--pick` trap | `--pick total_count` prints NOTHING (silent empty); the correct form is `--pick ledger.total_count`. Prefer parsing `--raw` output over `--pick` for assertions |
| gsd-tools error path | `error()` calls `process.exit(1)`; exit codes ARE reliable. Piping to `head` replaces `$?` with head's status — check status unpiped |
| Node version | v26.0.0 |
| Repo-local binaries | `node_modules/.bin/tsx`, `node_modules/.bin/playwright` (both present; no network fetch needed) |
| e2e entry point | root `test:e2e` -> `npm run test:e2e -w apps/web` -> `tsx e2e/run-e2e.ts`; config at `apps/web/playwright.config.ts` |
| Archived SUMMARYs (confirmed present) | `.planning/milestones/v1.1-phases/11-delivery-correctness/11-02-SUMMARY.md`, `.planning/milestones/v1.1-phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-05-SUMMARY.md` |
| Scratchpad for throwaway scripts | Use YOUR OWN session scratchpad directory, or `mktemp -d` if none is provided. Do not write throwaway scripts into the repository. |

Plan-time expectations per id (each MUST be independently re-verified):

| id | Subject | Expectation |
|----|---------|-------------|
| 12 | `scripts/deploy.sh` leg isolation | FIXED — commits `393a004` (RED) / `3de6771` (GREEN) exist. **Per-line gate confirmed at plan time:** all 6 mutating compose calls (3 literal `docker compose`, 3 via the `compose` wrapper) carry `--no-deps`; mutating=6, with_no_deps=6 |
| 13 | `apps/web/vite.config.ts` chunk crash | FIXED — commits `bd8a66c` / `2f77147` exist; `strictExecutionOrder` present; `scripts/check-web-chunks.mjs` exists and CI runs `npm run check:web-chunks` at `.github/workflows/ci.yml:78` |
| 10 | alloy never durably deployed | RESIDUAL-GAP — `alloy` appears in `docker/docker-compose.prod.yml` and `docker/alloy/config.alloy` but has **0** non-comment occurrences in `scripts/deploy.sh` |
| 8 | redaction UUID false positive | Unknown — deterministic single-input probe required |
| 2 | Playwright config load failure | Unknown — config-load-only reproduction required |
| 5 | flow-run-advance timing flake | DEFECT-CONFIRMED — shared-Redis test isolation; **zero test runs permitted** |
| 1 | ledger-loss tombstone | WAIVE-PROPOSED — un-fixable by construction |
| 3 | `SCAN_DATABASE_URL` deviation | WAIVE-PROPOSED — cite `11-02-SUMMARY.md` |
| 9 | WAL criterion superseded | WAIVE-PROPOSED — cite `17-05-SUMMARY.md` |
| 11 | pgBackRest 2.59.1 drift | WAIVE-PROPOSED — cite `17-05-SUMMARY.md`; additionally check `docs/runbooks/backups.md` for a stale `2.59.0` residual |

</pinned_facts>

<hard_constraints>

**Ledger mutation**

1. The ONLY permitted mutation of `.planning/WINDOWS.md` is
   `node /Users/primeropanther/.claude/gsd-core/bin/gsd-tools.cjs windows fixed <id>`.
2. Never open `.planning/WINDOWS.md` with Write or Edit. Never hand-edit the frontmatter counts,
   the markdown table, or the JSON block. The three must stay in sync and only the tool does that.
3. Never run `windows waive`. Waive bases are written into the report as PROPOSALS; the
   orchestrator applies them after the developer approves. An executor-applied waive is a
   task failure even if the basis is correct.
4. Never run `windows append`. No new ledger entries. Residual findings (for example a stale
   version string in a runbook) go in the report, not the ledger.
5. Do not create a fresh `WINDOWS.md`, do not `git add -f` it, do not restructure it.
   This task runs in the MAIN checkout — there is no worktree.
6. Mark an id fixed ONLY when its evidence is already written into the report. Report first,
   mutate second.

**Test evidence**

7. Never run the full test suite. Targeted single-file runs only. `apps/api` and `apps/worker`
   `sentry.test.ts` fail deterministically on this machine (real DSNs in the resolved env file),
   and full-suite parallel load produces known flakes — either would pollute the evidence.
8. Never use `run_in_background` for a test run. A backgrounded run that outlives the task
   loses its output.
9. For id 8, never run the 5000-sample probabilistic test — it is the thing under suspicion.
   Use a single fixed input.
10. For id 5, run no tests at all. An isolated pass is the documented signature of this flake
    (see `.planning/debug/knowledge-base.md`), so a green run is not evidence of a fix and a red
    run is not new information.
11. When checking a command's exit status, do not pipe it to `head`/`tail` — the pipeline
    reports the last command's status.

**Grep discipline**

12. Filter comments before counting: `grep -v '^\s*#'` for shell, `grep -v '^\s*//'` for TS.
    An unfiltered count can be satisfied by prose in a header.

**Commit discipline**

13. Stage exactly one path: `git add .planning/WINDOWS.md`. No `git add -A`, no `git add .`.
14. Use plain `git commit`. `gsd-tools commit` returns `skipped_gitignored` for `.planning/`
    paths and silently does nothing.
15. Leave the audit report UNCOMMITTED. Do not commit `SUMMARY.md`, `PLAN.md`, or `STATE.md` —
    the orchestrator owns the docs commit.
16. Re-grep `.planning/WINDOWS.md` content AFTER the final git command. A tracked file under
    `.planning/` has been silently clobbered by an intervening git operation in this repo before.
17. Record the output of `git branch --show-current` in the report so the orchestrator knows
    where the ledger commit landed.

</hard_constraints>

<tasks>

<task type="tracer">
  <name>Task 1: Gather execution-time code and test evidence for the six code-touching entries (ids 12, 13, 10, 8, 2, 5)</name>
  <files>.planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md</files>
  <precondition>Working directory is the main checkout `/Users/primeropanther/Projects/mega-crm` (not a worktree) and `.planning/WINDOWS.md` exists with `open_count: 10`.</precondition>
  <action>
Read `.planning/WINDOWS.md` (read-only) for the full description text of each open entry, then
create the audit report and fill in the six code-touching verdicts. This is the thin end-to-end
slice: it establishes the report structure, proves the evidence-gathering method, and produces
the FIXED determinations that Task 3 acts on.

**Report heading convention (required — the verify greps depend on it):** every entry section
heading is exactly `## Entry <id>` — for example `## Entry 12` — optionally followed by a short
title on the same line. One section per id, no zero-padding, no other heading form.

Capture the pre-mutation baseline first and paste it verbatim into the report:
`node /Users/primeropanther/.claude/gsd-core/bin/gsd-tools.cjs windows status`

Then, per id, run the check and record the ACTUAL command plus its ACTUAL output:

**id 12 — deploy.sh leg isolation.** Confirm commits `393a004` and `3de6771` exist via
`git log -1 --format='%h %s' <sha>`. Then apply the per-line gate, not a global count: extract
the mutating compose invocations (lines matching `compose` together with `up -d` or `run --rm`)
from `scripts/deploy.sh` with comments filtered, and assert every one of them carries
`--no-deps`. Record the extracted lines in the report. A global occurrence count is insufficient
evidence — the entry is specifically about the mutating calls. Optionally locate the guard test
with `git show 393a004 --stat` and run that single test file (targeted, allowed).

**id 13 — vite chunk crash.** Confirm commits `bd8a66c` and `2f77147` exist. Confirm
`strictExecutionOrder` is present in `apps/web/vite.config.ts` outside comments. Confirm
`scripts/check-web-chunks.mjs` exists. Confirm the gate is actually WIRED, not merely present:
grep `.github/workflows/` for the script or its npm alias and quote the matching workflow line
with its file:line. Optionally locate and run the guard test from `git show bd8a66c --stat`.

**id 10 — alloy deploy durability.** The open question is deploy durability, not whether alloy
was started live once. Grep `scripts/deploy.sh` (comments filtered) for `alloy`, AND grep the
compose files under `docker/` to establish whether alloy is defined as a service at all. The
discriminator: alloy defined in compose but absent from every deploy.sh startup path means the
gap is real. Absent from the deploy path -> RESIDUAL-GAP with a next-milestone requirement
recommendation, NOT a waive. Present in the deploy path -> candidate FIXED with the quoted line.

**id 8 — redaction UUID false positive.** Do NOT run the existing 5000-sample test. Read
`packages/redaction/src` to locate the phone valueRule and the order of the scrub pipeline.
Primary probe: write a throwaway script into your own session scratchpad directory — or into
`$(mktemp -d)` if you have none — never into the repository. Have it import the real scrub entry
point by absolute path and feed it the single fixed UUID
`17240210-0546-4077-9954-207876832048`, then run it with the repo-local `node_modules/.bin/tsx`.
Fallback if the import will not resolve: extract the phone rule's regex verbatim, evaluate it
against that UUID with `node -e`, and read the pipeline for any upstream UUID-shaped guard.
Still redacted -> DEFECT-CONFIRMED, no waive, with a `/gsd-debug` recommendation naming the file
and the two candidate fix directions from the entry. Not redacted -> before claiming FIXED,
check `git log` on `packages/redaction` for a fix landing after 2026-08-11 and cite it; an
unexplained pass is not a fix.

**id 5 — flow-run-advance timing flake.** Run NO tests. Inspect
`apps/worker/src/queues/__tests__/flow-run-advance-integration.test.ts` and any shared-Redis test
setup/helper for evidence that an isolation fix landed (for example per-suite unique key prefixes
or a dedicated Redis database per worker). Cite `.planning/debug/knowledge-base.md` on the
isolation-pass-equals-flake signature. Verdict DEFECT-CONFIRMED (shared-Redis test isolation) with
a `/gsd-debug` recommendation. If an isolation fix appears to have landed, record that as a note
supporting the recommendation — it does not by itself justify FIXED, because no run can confirm it.

**id 2 — Playwright config load.** Reproduce config-load only, cheaply, using the repo-local
binary (never a bare fetch-capable invocation): run the playwright CLI with `--list` against
`apps/web/playwright.config.ts` under a short timeout. Also inspect `apps/web/e2e/run-e2e.ts`,
the real entry point named by the root script, for the `.ts` deep specifier the entry blames.
Still errors -> DEFECT-CONFIRMED as an environment defect under Node v26, with a recommendation.
Loads clean -> FIXED, with the command output attached as evidence.

Write each verdict with exactly one label — FIXED, WAIVE-PROPOSED, DEFECT-CONFIRMED, or
RESIDUAL-GAP — and never assign WAIVE-PROPOSED to ids 5, 8, or 10.
  </action>
  <verify>
    <automated>test -f .planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md &amp;&amp; for i in 12 13 10 8 2 5; do grep -q "^## Entry $i\b" .planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md || { echo "MISSING entry $i"; exit 1; }; done; echo "six code-entry sections present"</automated>
    <automated>grep -c 'FIXED\|WAIVE-PROPOSED\|DEFECT-CONFIRMED\|RESIDUAL-GAP' .planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md</automated>
  </verify>
  <done>The report exists with a section per id 12, 13, 10, 8, 2, 5; each carries the actual command run, its actual output, and exactly one verdict label. The pre-mutation `windows status` baseline is recorded verbatim. Ids 5, 8, 10 carry no waive proposal. `.planning/WINDOWS.md` is still unmodified at this point.</done>
</task>

<task type="auto">
  <name>Task 2: Establish the waive basis for the four documented-deviation entries (ids 1, 3, 9, 11)</name>
  <files>.planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md</files>
  <action>
Append four more sections to the report. These four entries describe consciously-accepted
historical deviations and one un-fixable tombstone: they cannot be proven fixed by a code check,
so each gets a concrete waive BASIS that the orchestrator can hand to the developer for approval.
Do not run `windows waive`.

Before citing any SUMMARY, `ls` the path to confirm it exists, and quote the specific passage
that ratifies the deviation. A citation to a file you did not open is not a basis.

**id 1 — ledger-loss tombstone.** Cannot be fixed by construction: it records the permanent loss
of a prior ledger's entry. Waive basis has three legs, each of which must be verified and the
verification recorded: (a) the loss is documented in the entry text itself, making the tombstone
self-describing; (b) `.planning/WINDOWS.md` is now git-tracked, so the clobber mechanism no longer
applies — verify with `git ls-files --error-unmatch .planning/WINDOWS.md`; (c) the recurrence path
is closed by the project's own guidance forbidding a fresh force-added ledger from a worktree.

**id 3 — `SCAN_DATABASE_URL` deviation.** Read
`.planning/milestones/v1.1-phases/11-delivery-correctness/11-02-SUMMARY.md` and quote its
Deviations section. Also confirm the deviation is still the shipped reality by grepping
`packages/db/scripts/audit-sends-history.ts` for `SCAN_DATABASE_URL`. Basis: a design deviation
documented and accepted at the time of shipping, still accurately describing the code.

**id 9 — WAL criterion superseded.** Read the phase 17-05 SUMMARY at
`.planning/milestones/v1.1-phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-05-SUMMARY.md`
and quote the ratified corrected WAL criterion. Basis: the original plan's acceptance text was
unsatisfiable against real cumulative `pg_stat_archiver` history and was replaced by a ratified
criterion — a superseded plan assertion, not a product defect.

**id 11 — pgBackRest patch drift.** Quote the 17-05 SUMMARY passage ratifying 2.59.1 as expected
rather than a defect. Then check whether `docs/runbooks/backups.md` still documents `2.59.0`;
if it does, flag that one-line documentation residual in the report as a separate note with a
next-milestone or `/gsd-quick` recommendation. The residual does not block the waive proposal and
must not become a new ledger entry.

For each of the four, state the proposed waive reason as a single quoted line the orchestrator
can pass straight through, and mark the section clearly as awaiting developer approval.
  </action>
  <verify>
    <automated>for i in 1 3 9 11; do grep -q "^## Entry $i\b" .planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md || { echo "MISSING entry $i"; exit 1; }; done; echo "four deviation sections present"</automated>
    <automated>for i in 1 2 3 5 8 9 10 11 12 13; do grep -q "^## Entry $i\b" .planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md || { echo "MISSING entry $i"; exit 1; }; done; echo "all ten open ids covered"</automated>
    <automated>git diff --quiet -- .planning/WINDOWS.md &amp;&amp; echo "ledger still untouched before Task 3"</automated>
  </verify>
  <done>All ten open ids now have a report section. Ids 1, 3, 9, 11 each carry a WAIVE-PROPOSED verdict with a verified citation, a single-line proposed reason, and an explicit awaiting-approval marker. Id 11 additionally records the `backups.md` version-string finding if present. No waive has been applied and `.planning/WINDOWS.md` is still unmodified.</done>
</task>

<task type="auto">
  <name>Task 3: Close the provably-fixed entries through the tool, verify recomputed counts, and commit the ledger</name>
  <files>.planning/WINDOWS.md, .planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-AUDIT.md</files>
  <precondition>Every id about to be marked fixed already has its FIXED verdict and supporting evidence written into `260825-qhm-AUDIT.md` by Task 1.</precondition>
  <action>
Derive the fixed set strictly from Task 1's FIXED verdicts. Ids 12 and 13 are expected to
qualify; ids 2 and 10 qualify only if Task 1's evidence actually showed them resolved. Ids 1, 3,
5, 8, 9, 11 must NOT be touched.

For each id in the fixed set, run one id per invocation:

`cd /Users/primeropanther/Projects/mega-crm && node /Users/primeropanther/.claude/gsd-core/bin/gsd-tools.cjs windows fixed <id>`

The `cd` prefix is required, not decorative: bash invocations reset the working directory between
calls, and gsd-tools resolves the project root from cwd — without it the tool can resolve a
different (or no) ledger. Passing `--cwd /Users/primeropanther/Projects/mega-crm` is an equally
acceptable alternative. Check each invocation's exit status without piping it (a pipe replaces
`$?` with the last command's status), and paste the returned JSON into the report. A `WINDOWS_ALREADY_RESOLVED` error means
that id was already closed — record it and move on rather than retrying blindly.

Then capture the post-mutation state with `windows status` and reconcile it in the report against
the Task 1 baseline: `total_count` still 13, `waived_count` still 0, `open_count` down by exactly
the number of ids marked fixed, `fixed_count` up by that same number. If any of these does not
hold, stop and report — do not attempt a repair by editing the file.

Confirm the ship gate is intact by grepping the ledger for the fixed string
`blocks while ` together with `open_count > 0` and quoting the matched line.

Commit path-scoped: stage only `.planning/WINDOWS.md` with plain `git add`, then plain
`git commit`. Use subject `docs(windows): close provably-fixed broken-window entries after
evidence audit`. Do not stage the audit report or any other path.

AFTER the commit completes, re-grep the committed file to prove the content survived the git
operation: confirm the ship-gate line is still present, confirm the frontmatter counts still read
what `windows status` reported, and confirm `git show --numstat --format= HEAD` names
`.planning/WINDOWS.md` as the only path. Record `git branch --show-current` and the new commit sha
in the report.

Finally, close the report with a summary table (id, verdict, one-line evidence pointer), a
consolidated list of the waive proposals awaiting approval, and a consolidated list of the
`/gsd-debug` and next-milestone recommendations. State the resulting `open_count` and note
explicitly that the remaining open entries continue to block `/gsd-ship` by design.
  </action>
  <verify>
    <automated>WS=$(mktemp); node /Users/primeropanther/.claude/gsd-core/bin/gsd-tools.cjs windows status --raw > "$WS"; node -e 'const l=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).ledger; const st=id=>(l.entries.find(e=>e.id===id)||{}).status; let bad=[]; if(l.total_count!==13)bad.push("total_count="+l.total_count); if(l.waived_count!==0)bad.push("waived_count="+l.waived_count); if(l.open_count+l.fixed_count+l.waived_count!==l.total_count)bad.push("counts-no-sum"); for(const id of [12,13]) if(st(id)!=="fixed") bad.push(id+" not fixed ("+st(id)+")"); for(const id of [1,3,5,8,9,11]) if(st(id)!=="open") bad.push(id+" no longer open ("+st(id)+")"); if(bad.length){console.error("FAIL: "+bad.join("; "));process.exit(1);} console.log("ledger invariants hold; open_count="+l.open_count+" fixed_count="+l.fixed_count);' "$WS"; RC=$?; rm -f "$WS"; exit $RC</automated>
    <automated>grep -q 'blocks while' .planning/WINDOWS.md &amp;&amp; grep -q 'open_count > 0' .planning/WINDOWS.md &amp;&amp; echo "ship gate wording intact"</automated>
    <automated>test "$(git show --numstat --format= HEAD | awk '{print $3}' | sort -u | wc -l | tr -d ' ')" = "1" &amp;&amp; git show --numstat --format= HEAD | awk '{print $3}' | grep -qx '.planning/WINDOWS.md' &amp;&amp; echo "HEAD touches only the ledger"</automated>
    <automated>git diff --quiet -- .planning/WINDOWS.md &amp;&amp; echo "ledger committed clean"</automated>
  </verify>
  <done>`total_count` is 13 and `waived_count` is 0. `open_count` and `fixed_count` moved by exactly the size of the fixed set and were recomputed by the tool. Ids 12 and 13 read `fixed` in the ledger. The ship-gate line is present after the commit. `git show --numstat --format= HEAD` names only `.planning/WINDOWS.md`. The audit report is complete and uncommitted, and records the branch, the commit sha, both `windows status` snapshots, the waive proposals awaiting approval, and the defect recommendations.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| executor -> `.planning/WINDOWS.md` | A three-way-redundant file (frontmatter counts, markdown table, JSON block) that a direct write desynchronizes; the only safe writer is the tool |
| executor -> ship gate | Closing entries reduces `open_count`, which is the mechanism gating `/gsd-ship`; over-closing silently unblocks a release |
| executor -> waive authority | Waiving is a developer decision; the executor may only propose |
| executor -> git working tree | A path-scoped commit in the main checkout can sweep in unrelated dirty paths |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-qhm-01 | Tampering | `.planning/WINDOWS.md` three-way sync | high | mitigate | Mutations only via `windows fixed`; Write/Edit on the file forbidden (constraints 1-2); counts reconciled against the tool's own recompute in Task 3 |
| T-qhm-02 | Elevation of Privilege | ship gate / waive authority | high | mitigate | `windows waive` forbidden outright (constraint 3); waive bases recorded as proposals marked awaiting approval; `waived_count: 0` asserted as a must-have and a Task 3 verify |
| T-qhm-03 | Repudiation | evidence-free closure | high | mitigate | Report-before-mutate ordering (constraint 6); every FIXED id carries the actual command and output; `windows fixed` accepts no reason, so the report is the sole evidence record |
| T-qhm-04 | Denial of Service | test-run pollution | medium | mitigate | Full-suite runs forbidden; targeted files only; zero runs for id 5; single fixed input for id 8; no `run_in_background` (constraints 7-10) |
| T-qhm-05 | Information Disclosure | lost ledger content on commit | medium | mitigate | Post-commit re-grep of the ship-gate line and counts (constraint 16), plus a one-path `git show --numstat` assertion |
| T-qhm-06 | Spoofing | plan-time facts passed off as evidence | medium | mitigate | `<pinned_facts>` labelled expectations-only; report must cite execution-time output; id 12 requires a per-line gate rather than the plan's global count |
| T-qhm-07 | Tampering | scope creep into the ledger | low | mitigate | `windows append` forbidden (constraint 4); residual findings such as the `backups.md` version string go to the report only |
</threat_model>

<verification>
1. All ten open ids (1, 2, 3, 5, 8, 9, 10, 11, 12, 13) have a verdict section with
   execution-time evidence in `260825-qhm-AUDIT.md`.
2. `windows status` reports `total_count: 13` and `waived_count: 0`.
3. `open_count` + `fixed_count` + `waived_count` equals 13, and `open_count` fell by exactly the
   number of ids marked fixed.
4. Ids 12 and 13 read `fixed`; ids 1, 3, 5, 8, 9, 11 still read `open`.
5. The ship-gate line is present in `.planning/WINDOWS.md` after the final git command.
6. `git show --numstat --format= HEAD` names `.planning/WINDOWS.md` and nothing else.
7. Ids 5, 8, and 10 carry no waive proposal; each carries a `/gsd-debug` or next-milestone
   recommendation instead.
8. No full-suite test run appears anywhere in the execution record.
</verification>

<success_criteria>
- Every open ledger entry is resolved to one of four evidence-backed verdicts, with the evidence
  being the executor's own command output rather than a restatement of this plan.
- Exactly the provably-fixed entries are closed, through the tool, with counts recomputed
  automatically.
- Zero waives applied; waive bases delivered as approval-ready proposals.
- Genuine defects survive as open entries with actionable next steps, and the `/gsd-ship`
  gate wording is untouched.
</success_criteria>

<output>
Create `.planning/quick/260825-qhm-evidence-based-audit-of-planning-windows/260825-qhm-SUMMARY.md`
when done (do NOT commit it — the orchestrator owns the docs commit).

The SUMMARY must state, for the orchestrator: the final `open_count`, the list of ids marked
fixed, the list of waive proposals awaiting developer approval with their proposed reason lines,
the list of confirmed defects with their recommendations, and the branch and sha of the ledger
commit.
</output>
