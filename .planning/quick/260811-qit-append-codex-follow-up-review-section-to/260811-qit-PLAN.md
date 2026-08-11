---
phase: quick-260811-qit
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md
autonomous: true
requirements: [QT-260811-qit]

must_haves:
  truths:
    - "A section titled exactly `## Codex follow-up review` exists at the end of 13-REVIEWS.md and contains all six findings verbatim, with their original numbering (1-6) and their original BLOCKER/WARNING severity labels unchanged."
    - "Each of the six findings carries four authored subsections — affected plan(s), required acceptance tests, threat-model update, suggested fix — each grounded in text that actually exists in the cited Phase 13 PLAN files or 13-CONTEXT.md."
    - "The first 102 lines of 13-REVIEWS.md (frontmatter + the entire existing Claude review + Consensus Summary) are byte-identical to their pre-task state: `head -102 | shasum -a 256` still equals `c220eac6d62368978c7bfb8084d54cecec376055400723fa30e6e74c13acaac5`."
    - "The section frames the Claude review above as already incorporated by the replan, and the six new findings as the open, current, actionable set — so a later `/gsd-plan-phase 13 --reviews` run treats them as work to do rather than history."
    - "No Phase 13 PLAN file (13-01 … 13-14) and no file under apps/ or packages/ is modified; the change to 13-REVIEWS.md is append-only (zero deleted lines in its diff)."
  artifacts:
    - ".planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md (modified, append-only — the sole file this plan writes)"
  key_links:
    - "the six verbatim finding strings in `<verbatim_findings>` -> the blockquote lines in the appended section: any re-wrapping across lines, em-dash normalization (— to -), or renumbering breaks both the user's verbatim requirement and the grep-based fidelity gates that detect it"
    - "the appended section's actionable framing -> the `/gsd-plan-phase 13 --reviews` parser: that workflow reads the whole REVIEWS.md body and acts on *current actionable* findings, so a finding recorded as historical commentary would be silently skipped"
    - "the pinned head-102 SHA-256 -> the frontmatter/Claude-review preservation guarantee: it is the only mechanical proof that `reviewers:`, `reviewed_at:`, and the existing review body were not touched"
    - "each finding's `Threat-model update:` subsection -> the concrete T-13-NN rows already present in the affected plan's `<threat_model>` table: naming rows makes the update executable instead of generic advice"
---

<objective>
Append one new section, titled exactly `Codex follow-up review`, to the end of
`.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md`, recording six findings
(4 BLOCKER, 2 WARNING) from a Codex follow-up review pass as the **current, open, actionable**
review set for Phase 13.

Purpose: Phase 13's fourteen plans were already revised once against the Claude review that
occupies lines 14-102 of that file (replan commits `f20ea79`, `967d978`). Six new findings
postdate that replan and are not yet reflected anywhere in the plan set. `/gsd-plan-phase 13
--reviews` consumes REVIEWS.md as its feedback input; recording these findings there — with
enough grounded detail to be executable — is what gets them into the plans on the next
replan pass.

Output: 13-REVIEWS.md, appended in place. Nothing else. This plan revises no PLAN file; the
plan revision happens later, in `/gsd-plan-phase 13 --reviews`.
</objective>

<execution_context>
@/Users/primeropanther/.claude/gsd-core/workflows/execute-plan.md
@/Users/primeropanther/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md

Read-only inputs (source material for the authored subsections — never edited by this plan):
@.planning/phases/13-compliance-analytics-integrity/13-CONTEXT.md
@.planning/phases/13-compliance-analytics-integrity/13-06-PLAN.md
@.planning/phases/13-compliance-analytics-integrity/13-07-PLAN.md
@.planning/phases/13-compliance-analytics-integrity/13-10-PLAN.md
@.planning/phases/13-compliance-analytics-integrity/13-13-PLAN.md
</context>

<hard_constraints>

These are absolute. A task that satisfies its own acceptance criteria while breaking one of
these has failed.

1. **13-REVIEWS.md is the only file this plan writes.** Do not edit any Phase 13 PLAN file
   (13-01 through 13-14), 13-CONTEXT.md, ROADMAP.md, SPECIFICATION.md, or anything under
   `apps/` or `packages/`. The four PLAN files and 13-CONTEXT.md are read-only source
   material. (`.planning/STATE.md` and this quick task's own SUMMARY.md are the quick
   workflow's bookkeeping, written by the workflow itself, not by these tasks.)

2. **Append only.** Every byte of the existing file's first 102 lines — the YAML frontmatter
   and the entire `# Cross-AI Plan Review — Phase 13` body through `**Overall risk: MEDIUM** …
   drops to LOW risk.` — must survive untouched. Do **not** add `codex` to the frontmatter's
   `reviewers:` list, do not update `reviewed_at:`, do not reflow or re-punctuate the existing
   prose. New content goes after the last existing line, nowhere else.

3. **Verbatim means verbatim.** The six finding strings in `<verbatim_findings>` are copied
   character-for-character. Do not paraphrase, do not renumber, do not change a BLOCKER to a
   WARNING or vice versa, do not "fix" Finding 2's PostgreSQL wording, do not normalize the
   em-dashes (`—`) to hyphens, do not convert `...` to `…`, do not re-wrap a finding across
   multiple lines. **Each finding occupies exactly one physical line in the output file** (a
   single `> ` blockquote line running from its number through its final period). The
   verification greps are line-based and will fail on a re-wrap.

4. **Commit exactly one path.** When committing a task, `git add` only
   `.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md` and commit that path
   alone. Never `git add -A` / `git add .`. (Verified for this repo: `.planning/` is *not*
   gitignored here and 13-REVIEWS.md is already tracked — plain `git add` + `git commit`
   works; no `-f` needed.)

</hard_constraints>

<verbatim_findings>

The six findings, exactly as supplied. Copy each into the output file character-for-character
as a single-line blockquote. These are the strings the verification greps search for.

```text
1. BLOCKER — 13-10 must create suppression evidence for every contact erasure, including previously subscribed contacts. 13-CONTEXT.md says erasure must not weaken suppression and every erased address must remain unmailable after re-import.

2. BLOCKER — 13-10 cannot capture the old email using a normal UPDATE ... RETURNING after setting email = NULL; PostgreSQL returns the updated row. Read and lock the contact first with SELECT ... FOR UPDATE, or use a CTE that explicitly preserves pre-update values.

3. BLOCKER — Make erasure_records a durable outbox. Commit anonymization, suppression and the pending erasure record atomically; enqueue only after commit. Add a scheduled or boot-time reclaimer for pending and lease-expired records using deterministic job IDs. Test a crash after database commit but before BullMQ enqueue.

4. BLOCKER — 13-13 must not rely on REDACTION_RULES or a denylist to remove arbitrary PII. Reconstruct send_events.payload from a strict evidence allowlist. Clear events.properties to {} unless an explicit evidence allowlist is defined. Add tests for PII stored under unknown tenant-defined keys.

5. WARNING — 13-07 must choose an executable dedup-index migration mechanism before execution. Do not leave CREATE INDEX CONCURRENTLY compatibility or the non-concurrent fallback to executor discretion. Use an explicit operator/pre-deploy script plus a fail-closed contract migration, or document one concrete tested non-concurrent path.

6. WARNING — 13-06 must not silently delete an expired incomplete or attempt-capped journal row. Before pruning it, persist a non-PII failure tombstone or durable health state that remains alertable. Test that an incomplete batch cannot disappear without evidence.
```

</verbatim_findings>

<section_template>

The exact shape of the appended section. Task 1 emits the header block and Finding 1; Tasks 2
and 3 append further `### Finding N` blocks in the same shape. The four bold labels must each
start at column 1 of their own line, spelled exactly as shown — the verification counts them.

````markdown

---

## Codex follow-up review

**Reviewer:** codex — follow-up pass, 2026-08-11, run against the Phase 13 plan set after the Claude review above had already been incorporated.

**Status of the Claude review above:** incorporated and closed. Its 3 HIGH / 5 MEDIUM / 5 LOW findings were addressed by the replan at commits `f20ea79` and `967d978`; treat them as history, not as work.

**Status of this section:** the six findings below postdate that replan and are the **open, current, actionable** review set for Phase 13. Each one must be closed in the relevant PLAN.md — or explicitly deferred/rejected there with a written rationale — by the next `/gsd-plan-phase 13 --reviews` run. None of them is addressed by the plan set as it stands.

**Severity legend:** BLOCKER — must be closed in the plan text before Phase 13 executes. WARNING — must be decided in the plan text before execution, never left to executor discretion.

### Finding 1 — BLOCKER: {short title} ({affected plan ids})

**Finding (verbatim):**

> 1. BLOCKER — 13-10 must create suppression evidence for every contact erasure, including previously subscribed contacts. 13-CONTEXT.md says erasure must not weaken suppression and every erased address must remain unmailable after re-import.

**Affected plan(s):** {plan ids, and the specific task / step / acceptance criterion inside them the finding lands on, with line references}

**Required acceptance tests:**

- {one bullet per test, each phrased as an assertable acceptance criterion in the same register the Phase 13 plans already use}

**Threat-model update:** {which existing T-13-NN row(s) this amends or invalidates, and the new or corrected row}

**Suggested fix:** {the concrete plan-text change, grounded in what the plan currently says}
````

</section_template>

<tasks>

<task type="tracer">
  <name>Task 1: End-to-end slice — section header plus Finding 1, appended and gated</name>
  <files>.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md</files>
  <read_first>
    - `.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md` — the whole file (102 lines). Note the existing heading levels (`## Claude Review` at line 14, `## Consensus Summary` at line 80) and the `---` horizontal rule at line 78; the new section matches that register.
    - `.planning/phases/13-compliance-analytics-integrity/13-CONTEXT.md` lines 21-35 (Implementation Decisions D-01…D-07, especially D-01/D-02/D-04 on erasure shape and hashed suppression) and lines 135-155 (the non-negotiables, especially the bullet "Erasure must not weaken suppression: the deleted person's address must remain unmailable … even though no plaintext survives", and "Mail stops immediately on delete").
    - `.planning/phases/13-compliance-analytics-integrity/13-10-PLAN.md` lines 20-70 (must_haves truths/key_links and the objective) and lines 165-220 (Task 2 — the `deleteContact` rewrite). Line 194 is where the plan says to keep the existing conditional suppression insert "exactly as it is, including … its unsubscribed-or-suppressed status gate"; the acceptance criteria at lines 207-208 pin the resulting behavior — a previously *unsubscribed* contact gets a `workspace_suppressions` row, a previously *subscribed* contact gets none. Also read lines 290-305 (the `<threat_model>` table, rows T-13-10-01 … T-13-10-SC).
  </read_first>
  <action>
Append to the end of 13-REVIEWS.md — after its current final line, with nothing above it disturbed — the header block from `<section_template>` (the `---` rule, the `## Codex follow-up review` heading, and the four bold status/legend paragraphs), followed by the complete `### Finding 1` block.

Copy Finding 1's text from `<verbatim_findings>` character-for-character into a single-line blockquote. Slow down on the em-dash and on the two sentence boundaries; this is the step where verbatim fidelity is actually decided, and the greps that check it derive from the same source string.

Author the four subsections against what 13-10-PLAN.md and 13-CONTEXT.md actually say, not against a general notion of GDPR erasure:

- **Affected plan(s):** name 13-10 and the specific place the finding lands — Task 2's step 2 (line 194, "keep the existing conditional suppression insert exactly as it is") and the acceptance criterion at line 208, which currently asserts the *opposite* of what the finding requires: that a previously subscribed contact's erasure writes no suppression row at all. Note that 13-12 later converts that column to a hash across all four call sites, so the fix must be expressed in terms that survive that conversion.
- **Required acceptance tests:** derive them from the plan's existing criteria list so they can be dropped in. At minimum: erasing a previously *subscribed* contact writes a `workspace_suppressions` row for that address (the inverse of the current line-208 criterion, which must be replaced rather than supplemented); the suppression reason distinguishes erasure from a genuine unsubscribe so consent history is not falsified; and re-importing the erased address after erasure — through both the CSV import path and the shared `contacts-core` upsert — produces a contact that the pre-send suppression gate still refuses to mail.
- **Threat-model update:** this lands on 13-10's `T-13-10-04` ("Mail continuing to an erased address", high/mitigate) and `T-13-10-05` ("Resurrecting an erased contact via re-import or update", medium/mitigate). Both currently claim the guarantee holds; state that T-13-10-04's mitigation text is false for the previously-subscribed case as the plan is written, and give the corrected mitigation.
- **Suggested fix:** the concrete plan-text edit — make the suppression insert unconditional on erasure (with an erasure-specific reason), delete the contradicting acceptance criterion, and add the re-import assertions.

Use the exact bold labels from `<section_template>`, each starting at column 1. Do not touch anything above the appended region.
  </action>
  <verify>
    <automated>D13=/Users/primeropanther/Projects/mega-crm/.planning/phases/13-compliance-analytics-integrity; R="$D13"/13-REVIEWS.md; G=/Users/primeropanther/Projects/mega-crm; test "$(head -102 "$R" | shasum -a 256 | cut -d' ' -f1)" = c220eac6d62368978c7bfb8084d54cecec376055400723fa30e6e74c13acaac5 || { echo "FAIL: first 102 lines changed"; exit 1; }; DEL=$(git -C "$G" diff --numstat -- .planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md | cut -f2); test "${DEL:-0}" = 0 || { echo "FAIL: diff deletes lines, not append-only"; exit 1; }; test "$(grep -c '^## Codex follow-up review$' "$R")" = 1 || { echo "FAIL: section heading"; exit 1; }; grep -Fq '1. BLOCKER — 13-10 must create suppression evidence for every contact erasure, including previously subscribed contacts. 13-CONTEXT.md says erasure must not weaken suppression and every erased address must remain unmailable after re-import.' "$R" || { echo "FAIL: finding 1 not verbatim on one line"; exit 1; }; for L in 'Affected plan(s)' 'Required acceptance tests' 'Threat-model update' 'Suggested fix'; do test "$(grep -c "^\*\*$L:\*\*" "$R")" = 1 || { echo "FAIL: label $L count != 1"; exit 1; }; done; test "$(grep -c '^### Finding ' "$R")" = 1 || { echo "FAIL: finding heading count != 1"; exit 1; }; test "$(shasum -a 256 "$D13"/13-*-PLAN.md "$D13"/13-CONTEXT.md | shasum -a 256 | cut -d' ' -f1)" = 298d26358e01d58e81c627bedb23bfe34f9e2be35332c77b9544ec622250caba || { echo "FAIL: a Phase 13 PLAN or CONTEXT file was modified"; exit 1; }; test -z "$(git -C "$G" status --porcelain -- apps packages)" || { echo "FAIL: source tree modified"; exit 1; }; echo OK</automated>
  </verify>
  <done>13-REVIEWS.md ends with the `Codex follow-up review` header block and a complete, grounded Finding 1; the pre-existing 102 lines hash unchanged; no other file is dirty.</done>
</task>

<task type="auto">
  <name>Task 2: Findings 2, 3 and 4 — the remaining BLOCKERs</name>
  <files>.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md</files>
  <read_first>
    - `.planning/phases/13-compliance-analytics-integrity/13-10-PLAN.md` lines 103-165 (Task 1 — migration 0059 and the `erasure_records` column list, including `status` with its CHECK, the count columns, and the two `jsonb` cursor columns). Lines 165-220 are already in context from Task 1: line 191 is the anonymizing UPDATE that claims "returning the pre-update `email` and `subscription_status`" — the exact claim Finding 2 refutes — and line 196 is the enqueue-ordering step that Finding 3 targets ("Enqueue after the transaction commits, or inside it if the existing codebase convention for API-side enqueues does so … State which you did and why in the SUMMARY").
    - `.planning/phases/13-compliance-analytics-integrity/13-13-PLAN.md` lines 15-45 (must_haves truths and key_links, including the `REDACTION_RULES` key_link at line 37), lines 85-200 (Task 1's `scrubJsonbPii` built over `REDACTION_RULES` at line 106 with its explicit "Do not write a new heuristic" instruction, and Task 2's checkpointed scrub), and lines 245-275 (the `<threat_model>` table T-13-13-01 … T-13-13-SC, plus the review-notes block).
    - `.planning/phases/13-compliance-analytics-integrity/13-CONTEXT.md` line 27 (D-03 — "rewritten to strip email/PII fields, keeping event type + timestamps as delivery evidence"), already in context from Task 1.
  </read_first>
  <action>
Append `### Finding 2`, `### Finding 3` and `### Finding 4` blocks, in that order, to the end of the section Task 1 created. Same shape, same four bold labels, each finding verbatim on a single blockquote line.

Finding 2 is the one to transcribe most carefully: it contains `UPDATE ... RETURNING`, `email = NULL`, and `SELECT ... FOR UPDATE`, all with the exact spacing shown in `<verbatim_findings>`, plus a semicolon mid-sentence. Copy, do not retype from memory.

Ground the authored subsections:

- **Finding 2** lands on 13-10 Task 2 step 1 (line 191). The plan asserts the UPDATE's own RETURNING clause yields the pre-update email and calls that capture "load-bearing" for the suppression insert in step 2 — but PostgreSQL's `UPDATE … RETURNING` yields post-update values, so the plan as written captures `NULL` and the suppression insert silently writes nothing usable. Acceptance tests: erasing a contact writes a suppression entry whose stored value corresponds to the address the contact actually had (not null, not empty); the same test proves the capture mechanism, so it must assert the *value*, not merely row presence. Threat-model: `T-13-10-01` ("Incomplete PII scrub on the contacts row") and `T-13-10-04` both rest on this capture — T-13-10-04's "suppression and status are resolved synchronously in the delete request" is unachievable with a null capture. Suggested fix: state the mechanism in the plan text (lock-then-read with `SELECT … FOR UPDATE`, or a CTE preserving pre-update values), rather than leaving the RETURNING claim standing. Note the interaction with Finding 1: an unconditional suppression insert makes the correct capture mandatory on *every* erasure path, not just the unsubscribed one.
- **Finding 3** lands on 13-10 Task 2 step 3 (line 195, the same-transaction erasure record) and step 4 (line 196, the enqueue). The atomicity half is already right; what is missing is that step 4 explicitly leaves the commit/enqueue ordering to executor discretion and no plan reclaims a committed `pending` record whose enqueue never happened. Acceptance tests: a crash injected after the database commit and before the BullMQ enqueue leaves a `pending` record that a subsequent reclaimer pass picks up and completes; the reclaimer's deterministic job id makes a double reclaim a no-op. Threat-model: `T-13-10-02` ("Erasure with no auditable proof it occurred") stays valid, but `T-13-10-06` ("Duplicate scrub jobs from a retried request") needs the reclaimer's job-id derivation folded in, and a new row is required for the un-enqueued-pending-record class — note that 13-11's watchdog covers the ingress journal, not `erasure_records`, so nothing currently surfaces a stuck erasure. Suggested fix: pin the ordering (commit first, enqueue after) in the plan text and add the scheduled/boot-time reclaimer plus its crash test as named work.
- **Finding 4** lands on 13-13 Task 1 (line 106) and its key_link at line 37, both of which mandate reuse of `REDACTION_RULES`. State plainly that this finding **contradicts** the plan's current direction rather than refining it: a key/value denylist tuned for log scrubbing cannot bound PII in tenant-defined `events.properties`, where key names are arbitrary. Acceptance tests: PII stored under an unknown tenant-defined key (a key matching no rule) does not survive the scrub; `send_events.payload` after a scrub contains only allowlisted evidence fields; `events.properties` is `{}` after a scrub unless an explicit evidence allowlist is defined for it. Threat-model: `T-13-13-01` ("PII surviving in `send_events.payload` after erasure") is only satisfiable under an allowlist, and `T-13-13-06` ("A new PII heuristic reintroducing known false positives") must be rewritten — its stated mitigation *is* the defect, and the false-positive concern it protects against is moot once payloads are reconstructed rather than filtered. Note the surviving obligation from `T-13-13-03` ("Rows are rewritten, never deleted") — `event_type`, `occurred_at` and `received_at` must be in whatever allowlist is chosen, or the evidence guarantee breaks.

Do not edit 13-13-PLAN.md, 13-10-PLAN.md, or their threat tables — describe the required change in REVIEWS.md only.
  </action>
  <verify>
    <automated>D13=/Users/primeropanther/Projects/mega-crm/.planning/phases/13-compliance-analytics-integrity; R="$D13"/13-REVIEWS.md; G=/Users/primeropanther/Projects/mega-crm; test "$(head -102 "$R" | shasum -a 256 | cut -d' ' -f1)" = c220eac6d62368978c7bfb8084d54cecec376055400723fa30e6e74c13acaac5 || { echo "FAIL: first 102 lines changed"; exit 1; }; grep -Fq '2. BLOCKER — 13-10 cannot capture the old email using a normal UPDATE ... RETURNING after setting email = NULL; PostgreSQL returns the updated row. Read and lock the contact first with SELECT ... FOR UPDATE, or use a CTE that explicitly preserves pre-update values.' "$R" || { echo "FAIL: finding 2 not verbatim on one line"; exit 1; }; grep -Fq '3. BLOCKER — Make erasure_records a durable outbox. Commit anonymization, suppression and the pending erasure record atomically; enqueue only after commit. Add a scheduled or boot-time reclaimer for pending and lease-expired records using deterministic job IDs. Test a crash after database commit but before BullMQ enqueue.' "$R" || { echo "FAIL: finding 3 not verbatim on one line"; exit 1; }; grep -Fq '4. BLOCKER — 13-13 must not rely on REDACTION_RULES or a denylist to remove arbitrary PII. Reconstruct send_events.payload from a strict evidence allowlist. Clear events.properties to {} unless an explicit evidence allowlist is defined. Add tests for PII stored under unknown tenant-defined keys.' "$R" || { echo "FAIL: finding 4 not verbatim on one line"; exit 1; }; for L in 'Affected plan(s)' 'Required acceptance tests' 'Threat-model update' 'Suggested fix'; do test "$(grep -c "^\*\*$L:\*\*" "$R")" = 4 || { echo "FAIL: label $L count != 4"; exit 1; }; done; test "$(grep -c '^### Finding ' "$R")" = 4 || { echo "FAIL: finding heading count != 4"; exit 1; }; DEL=$(git -C "$G" diff --numstat -- .planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md | cut -f2); test "${DEL:-0}" = 0 || { echo "FAIL: diff deletes lines"; exit 1; }; test "$(shasum -a 256 "$D13"/13-*-PLAN.md "$D13"/13-CONTEXT.md | shasum -a 256 | cut -d' ' -f1)" = 298d26358e01d58e81c627bedb23bfe34f9e2be35332c77b9544ec622250caba || { echo "FAIL: a Phase 13 PLAN or CONTEXT file was modified"; exit 1; }; test -z "$(git -C "$G" status --porcelain -- apps packages)" || { echo "FAIL: source tree modified"; exit 1; }; echo OK</automated>
  </verify>
  <done>All four BLOCKER findings are recorded verbatim with grounded affected-plan, acceptance-test, threat-model and suggested-fix subsections; the pre-existing 102 lines still hash unchanged.</done>
</task>

<task type="auto">
  <name>Task 3: Findings 5 and 6 — the WARNINGs — and full-section integrity gate</name>
  <files>.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md</files>
  <read_first>
    - `.planning/phases/13-compliance-analytics-integrity/13-07-PLAN.md` lines 100-245 (Tasks 1-3). The decisive passage is lines 180-182: the per-partition `CREATE UNIQUE INDEX CONCURRENTLY` build, the `ALTER INDEX … ATTACH PARTITION` step, and then the explicit hand-off to executor discretion — "Check how this project's migration runner wraps statements … If the runner cannot express that, fall back to a non-concurrent per-partition `CREATE UNIQUE INDEX` and record the trade in the SUMMARY". Also read lines 265-285 (`<threat_model>`, rows T-13-07-01 … T-13-07-SC).
    - `.planning/phases/13-compliance-analytics-integrity/13-06-PLAN.md` lines 20-60 (must_haves truths — line 26 states "Journal rows older than the retention horizon are deleted by the prune step, whether or not they were ingested", which is precisely what Finding 6 forbids — plus the objective), lines 100-195 (Task 1's `WEBHOOK_REPLAY_MAX_ATTEMPTS` cap and its rationale at line 126, and Task 2's `pruneIngressJournal` call and replay-then-prune ordering at line 172), and lines 250-266 (`<threat_model>` plus the review-notes block).
  </read_first>
  <action>
Append `### Finding 5` and `### Finding 6` blocks, in that order, completing the section. Same shape, same labels, each finding verbatim on a single blockquote line. Finding 5 contains `CREATE INDEX CONCURRENTLY` in caps and an `operator/pre-deploy` slash — copy exactly.

Ground the authored subsections:

- **Finding 5** lands on 13-07 Task 2, lines 180-182. The plan already resolved the duplicate-row question (T-13-07-03: a bounded operator script rather than an in-migration DELETE) but left the *index build mechanism* as a conditional the executor discovers at apply time — including a silent fallback to a non-concurrent build with a write lock per partition. Acceptance tests: the chosen mechanism is named in the migration/plan text before execution and is exercised end to end by `test:migrations` against a database with the real attached-partition set; the parent index's `pg_index.indisvalid` is asserted true after the run; a migration that would emit `CREATE INDEX CONCURRENTLY` inside a transaction block fails closed rather than at apply time. Threat-model: `T-13-07-02` ("Non-enforcing invalid index after a partial build", high/mitigate) currently assumes the build succeeds by some route — its mitigation must name the route; `T-13-07-03`'s bounded-operator-script precedent is the model the index build should follow. Note the environment fact the decision has to survive: per STATE.md, `npm run db:migrate` (drizzle-kit CLI) hangs in the dev sandbox under Node v26, so "we will find out at apply time" is not an available strategy — `test:migrations` is the proof mechanism. Suggested fix: pick one — an explicit operator/pre-deploy script that builds and attaches the indexes, followed by a fail-closed contract migration that verifies validity and refuses otherwise; or one concrete, tested non-concurrent path documented with its lock cost.
- **Finding 6** lands on 13-06's must-have at line 26 and Task 2's prune step at line 172. The current design deletes journal rows past the retention horizon "whether or not they were ingested", and Task 1's `WEBHOOK_REPLAY_MAX_ATTEMPTS` cap stops re-enqueueing a poison batch — so an attempt-capped or never-completed row eventually vanishes, taking its own evidence with it. The plan's own safety argument (line 126: the cap is safe because 13-11's watchdog surfaces capped rows) holds only while the row still exists; prune silently ends that window. Acceptance tests: a journal row that reaches the retention horizon while still incomplete, or while attempt-capped, leaves behind a durable non-PII record (tombstone row or health state) after pruning; that record is visible to the ingestion-health watchdog and still alertable; an incomplete batch cannot transition to absent without such evidence. Threat-model: `T-13-06-06` ("Journal PII retention", medium/mitigate) is the row that justifies the prune and must be amended to separate PII disposal from evidence disposal — the raw payload can go, the fact of the failure cannot; `T-13-06-02`'s attempt-cap mitigation inherits the same gap. Suggested fix: split the prune into "always drop the raw payload past the horizon" and "for a row that never completed, persist a tombstone/health record first", and add the corresponding must-have to 13-06 in place of the current unconditional-deletion truth.

Then verify the whole appended section end to end: all six findings verbatim, original numbering and severity labels intact, four subsections each, the pre-existing 102 lines byte-identical, and 13-REVIEWS.md the only repository file this task changed.
  </action>
  <acceptance_criteria>
    - `head -102` of 13-REVIEWS.md hashes to `c220eac6d62368978c7bfb8084d54cecec376055400723fa30e6e74c13acaac5`.
    - `grep -c '^## Codex follow-up review$'` returns 1; `grep -c '^### Finding '` returns 6.
    - All six verbatim finding strings from `<verbatim_findings>` are found by `grep -F`, each on a single line.
    - Each of the four bold subsection labels appears exactly 6 times, each at column 1.
    - `git diff --numstat` for 13-REVIEWS.md shows 0 deleted lines.
    - The fourteen Phase 13 PLAN files plus 13-CONTEXT.md still hash collectively to `298d26358e01d58e81c627bedb23bfe34f9e2be35332c77b9544ec622250caba` via `shasum -a 256 "$D13"/13-*-PLAN.md "$D13"/13-CONTEXT.md | shasum -a 256`, with `D13` the absolute phase directory — the commit-independent proof that no plan was edited.
    - `git status --porcelain -- apps packages` is empty.
    - After committing, `git show --name-only --format= HEAD` lists exactly one path: `.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md`.
  </acceptance_criteria>
  <verify>
    <automated>D13=/Users/primeropanther/Projects/mega-crm/.planning/phases/13-compliance-analytics-integrity; R="$D13"/13-REVIEWS.md; G=/Users/primeropanther/Projects/mega-crm; test "$(head -102 "$R" | shasum -a 256 | cut -d' ' -f1)" = c220eac6d62368978c7bfb8084d54cecec376055400723fa30e6e74c13acaac5 || { echo "FAIL: first 102 lines changed"; exit 1; }; grep -Fq '1. BLOCKER — 13-10 must create suppression evidence for every contact erasure, including previously subscribed contacts. 13-CONTEXT.md says erasure must not weaken suppression and every erased address must remain unmailable after re-import.' "$R" || { echo "FAIL: finding 1"; exit 1; }; grep -Fq '2. BLOCKER — 13-10 cannot capture the old email using a normal UPDATE ... RETURNING after setting email = NULL; PostgreSQL returns the updated row. Read and lock the contact first with SELECT ... FOR UPDATE, or use a CTE that explicitly preserves pre-update values.' "$R" || { echo "FAIL: finding 2"; exit 1; }; grep -Fq '3. BLOCKER — Make erasure_records a durable outbox. Commit anonymization, suppression and the pending erasure record atomically; enqueue only after commit. Add a scheduled or boot-time reclaimer for pending and lease-expired records using deterministic job IDs. Test a crash after database commit but before BullMQ enqueue.' "$R" || { echo "FAIL: finding 3"; exit 1; }; grep -Fq '4. BLOCKER — 13-13 must not rely on REDACTION_RULES or a denylist to remove arbitrary PII. Reconstruct send_events.payload from a strict evidence allowlist. Clear events.properties to {} unless an explicit evidence allowlist is defined. Add tests for PII stored under unknown tenant-defined keys.' "$R" || { echo "FAIL: finding 4"; exit 1; }; grep -Fq '5. WARNING — 13-07 must choose an executable dedup-index migration mechanism before execution. Do not leave CREATE INDEX CONCURRENTLY compatibility or the non-concurrent fallback to executor discretion. Use an explicit operator/pre-deploy script plus a fail-closed contract migration, or document one concrete tested non-concurrent path.' "$R" || { echo "FAIL: finding 5"; exit 1; }; grep -Fq '6. WARNING — 13-06 must not silently delete an expired incomplete or attempt-capped journal row. Before pruning it, persist a non-PII failure tombstone or durable health state that remains alertable. Test that an incomplete batch cannot disappear without evidence.' "$R" || { echo "FAIL: finding 6"; exit 1; }; test "$(grep -c '^## Codex follow-up review$' "$R")" = 1 || { echo "FAIL: section heading"; exit 1; }; test "$(grep -c '^### Finding ' "$R")" = 6 || { echo "FAIL: finding heading count != 6"; exit 1; }; for L in 'Affected plan(s)' 'Required acceptance tests' 'Threat-model update' 'Suggested fix'; do test "$(grep -c "^\*\*$L:\*\*" "$R")" = 6 || { echo "FAIL: label $L count != 6"; exit 1; }; done; DEL=$(git -C "$G" diff --numstat -- .planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md | cut -f2); test "${DEL:-0}" = 0 || { echo "FAIL: diff deletes lines"; exit 1; }; test "$(shasum -a 256 "$D13"/13-*-PLAN.md "$D13"/13-CONTEXT.md | shasum -a 256 | cut -d' ' -f1)" = 298d26358e01d58e81c627bedb23bfe34f9e2be35332c77b9544ec622250caba || { echo "FAIL: a Phase 13 PLAN or CONTEXT file was modified"; exit 1; }; test -z "$(git -C "$G" status --porcelain -- apps packages)" || { echo "FAIL: source tree modified"; exit 1; }; echo OK</automated>
  </verify>
  <done>The `Codex follow-up review` section is complete: six findings verbatim with intact numbering and BLOCKER/WARNING labels, four grounded subsections each, appended without disturbing a byte of the existing frontmatter or Claude review, in a commit that touches only 13-REVIEWS.md.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| this quick task -> the Phase 13 plan set | The task reads 14 planning artifacts but is authorized to write exactly one; an errant edit would silently mutate an executable plan contract. |
| this REVIEWS.md section -> `/gsd-plan-phase 13 --reviews` | The appended text is the sole input by which these six findings reach the plans; misframing or truncation loses them with no error. |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-QIT-01 | Tampering | The existing frontmatter and Claude review in 13-REVIEWS.md | high | mitigate | Every task's `<verify>` re-checks the pinned SHA-256 of the first 102 lines and asserts zero deleted lines in the file's diff, so an accidental mid-file edit fails at the task that made it rather than at the end. |
| T-QIT-02 | Tampering | Phase 13 PLAN files 13-01…13-14 | high | mitigate | `<hard_constraints>` forbids editing them; every task's verify asserts `git status --porcelain -- .planning/phases` lists exactly one path and `apps packages` is clean. |
| T-QIT-03 | Repudiation | Verbatim fidelity of the six findings | high | mitigate | Each full finding string is asserted by `grep -F` against the file, with the one-physical-line rule making a re-wrap or an em-dash normalization a hard failure rather than a silent drift. |
| T-QIT-04 | Information Disclosure | Findings recorded as history rather than open work | medium | mitigate | The section header states explicitly that the Claude review above is closed by commits `f20ea79`/`967d978` and that these six are the open actionable set, so the `--reviews` planner neither skips them nor re-litigates closed findings. |
| T-QIT-05 | Tampering | Commit scope | medium | mitigate | `git add` is restricted to the single REVIEWS.md path, and the post-commit gate asserts `git show --name-only --format= HEAD` lists exactly one file. |
| T-QIT-SC | Tampering | npm/pip/cargo installs | high | mitigate | This plan installs nothing and runs no package manager. Any install proposed during execution requires slopcheck plus a blocking human checkpoint. |
</threat_model>

<verification>
Run from the repository root after the final task's commit:

1. Prefix integrity — `head -102 .planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md | shasum -a 256` equals `c220eac6d62368978c7bfb8084d54cecec376055400723fa30e6e74c13acaac5`.
2. Append-only — `git show --stat HEAD` reports insertions only for 13-REVIEWS.md, zero deletions.
3. Commit isolation — `git show --name-only --format= HEAD` prints exactly one line: `.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md`.
4. Section completeness — `grep -c '^### Finding '` returns 6; each of the four bold labels returns 6; all six `grep -F` finding literals from Task 3's verify still match.
5. Plan set untouched — with `D13=/Users/primeropanther/Projects/mega-crm/.planning/phases/13-compliance-analytics-integrity`, the command `shasum -a 256 "$D13"/13-*-PLAN.md "$D13"/13-CONTEXT.md | shasum -a 256` still yields `298d26358e01d58e81c627bedb23bfe34f9e2be35332c77b9544ec622250caba`. This is commit-independent — it holds whether or not the work has been committed — and it is the gate that actually enforces "no PLAN file was edited".

   **The absolute path form is load-bearing.** `shasum` prints each file's digest *followed by the path as given*, and the outer `shasum` digests those lines, so running the same check with relative paths produces a different, non-matching hash. Use `"$D13"/…` exactly as written, from any working directory.
</verification>

<success_criteria>
- 13-REVIEWS.md carries a new final section titled exactly `Codex follow-up review`, containing all six findings verbatim with original numbering and BLOCKER/WARNING labels.
- Every finding has affected-plan(s), required acceptance tests, threat-model update, and suggested fix — each traceable to real text in 13-06/13-07/13-10/13-13-PLAN.md or 13-CONTEXT.md, and each naming the specific T-13-NN threat rows it amends.
- The section states that the Claude review above is already incorporated and that these six are the open, current, actionable set for `/gsd-plan-phase 13 --reviews`.
- The file's first 102 lines are byte-identical to their pre-task state; the frontmatter is unmodified.
- The commit touches only `.planning/phases/13-compliance-analytics-integrity/13-REVIEWS.md`.
</success_criteria>

<output>
Create `.planning/quick/260811-qit-append-codex-follow-up-review-section-to/260811-qit-SUMMARY.md` when done.

Record: the line number at which the appended section begins; confirmation of the head-102 hash match; the six `T-13-NN` threat rows each finding was mapped to; and any place where a finding's authored subsection had to be hedged because the affected plan did not contain the expected anchor.
</output>
