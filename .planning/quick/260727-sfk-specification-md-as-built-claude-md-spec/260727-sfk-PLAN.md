---
phase: quick-260727-sfk
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - SPECIFICATION.md
  - .claude/CLAUDE.md
  - CLAUDE-md-spec-rule.snippet.md
  - .planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md
autonomous: true
requirements: [QUICK-260727-SFK]

must_haves:
  truths:
    - "260727-sfk-AUDIT-FINDINGS.md exists and carries exactly one verdict row for each SPECIFICATION.md section 1 through 10"
    - "Every claim found factually wrong AND literal-correctable is fixed in place in SPECIFICATION.md"
    - ".claude/CLAUDE.md contains the spec-maintenance rule at a line number greater than the GSD:profile-end marker line"
    - "CLAUDE-md-spec-rule.snippet.md is absent from the working tree if and only if all three gate checks passed"
    - "The gate outcome and its reason are recorded on a GATE: line at the top of the findings file"
  artifacts:
    - ".planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md"
    - "SPECIFICATION.md (audited, literal corrections applied in place)"
    - ".claude/CLAUDE.md (rule appended after the last GSD marker block)"
  key_links:
    - "CLAUDE.md rule body routes new tech to SPECIFICATION.md sections 2-8 by number -> those section numbers must still exist in SPECIFICATION.md after the audit"
    - "SPECIFICATION.md section 8 (расхождения) -> the Technology Stack block inside .claude/CLAUDE.md GSD:stack markers"
    - "Three mechanical gate checks -> deletion of CLAUDE-md-spec-rule.snippet.md"
---

<objective>
Audit `SPECIFICATION.md` as an accurate as-built description of this repo, relocate the
maintenance rule from `CLAUDE-md-spec-rule.snippet.md` into `.claude/CLAUDE.md` outside every
GSD-managed marker block, and delete the temporary snippet only if a mechanically-checkable
gate passes.

Purpose: `SPECIFICATION.md` is written for a pre-production security review. A security
reviewer acting on a wrong version string, a wrong table count, or a stale route list is worse
off than one with no document. The audit is the substantive work; the relocation makes the
document self-maintaining going forward.

Output: an audit findings artifact, a corrected `SPECIFICATION.md`, a `.claude/CLAUDE.md` that
carries the maintenance rule permanently, and a conditional deletion of the snippet.
</objective>

<execution_context>
@/Users/primeropanther/.claude/gsd-core/workflows/execute-plan.md
@/Users/primeropanther/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@CLAUDE-md-spec-rule.snippet.md

Git state (verified at plan time, 2026-07-27):
- `SPECIFICATION.md` (677 lines, ~84KB) and `CLAUDE-md-spec-rule.snippet.md` (30 lines) are both
  UNTRACKED (`??`). `.claude/CLAUDE.md` IS tracked.
- Worktree isolation is DISABLED for this run — you are working directly on the `master` checkout.
  Do not create or switch branches.

Baseline established at plan time — do NOT re-derive, but DO re-verify anything you depend on:
- **No source file has changed since `SPECIFICATION.md` was written.** Verified two ways:
  `find apps packages scripts docker docs -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.sql' -o -name '*.json' \) -not -path '*/node_modules/*' -newer SPECIFICATION.md` returns nothing, and
  `git log --since=2026-07-15 --oneline` shows only three docs/planning commits (README + STATE).
- Consequence: this audit is checking **authoring accuracy**, not drift-from-change. Expect the
  spec to be largely correct. A wave of findings means your verification method is wrong, not
  that the codebase moved. Treat a high finding count as a signal to re-check yourself first.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Audit SPECIFICATION.md section by section against the repo; write findings; correct literal drift in place</name>

  <files>
    SPECIFICATION.md,
    .planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md
  </files>

  <action>
Audit all ten sections of `SPECIFICATION.md` against the actual repository, one section at a
time. Do NOT load all 677 lines at once and do NOT re-read a range you already have in context.
Use this pre-computed section line map with `Read` offset/limit, one section per read:

| Section | Title | offset | limit |
|---|---|---|---|
| 1 | Топология | 10 | 38 |
| 2 | Зависимости и версии | 48 | 80 |
| 3 | Секреты | 129 | 101 |
| 4 | Схема данных | 230 | 159 |
| 5 | Планировщик и пайплайн отправки | 389 | 73 |
| 6 | Публичные точки входа | 462 | 134 |
| 7 | Наблюдаемость | 596 | 8 |
| 8 | Расхождения с Technology Stack | 605 | 41 |
| 9 | Сводка вопросов к ревью | 647 | 27 |
| 10 | Поддержание документа | 675 | 3 |

Sections 1, 7, 9 and 10 are already fully in the plan author's verified context and are
summarized below; still read them (they are small) but spend your effort on 2 through 6.

Per-section verification targets:

- **Section 1 (Топология)** — check `apps/` and `packages/` directory listings against the two
  tables, `workspaces` and `engines` in root `package.json`, the two services in
  `docker-compose.yml`, the role attributes in `docker/init-app-role.sql`, and the claim that no
  Dockerfile / CI config / deploy manifest exists.

- **Section 2 (Зависимости)** — the highest-value section and the one the relocated rule most
  depends on. Dump every workspace's declared dependencies in ONE command rather than reading
  twelve files:
  `for f in package.json apps/api/package.json apps/worker/package.json apps/web/package.json packages/*/package.json; do echo "### $f"; jq -r '[(.dependencies//{}|to_entries[]|"\(.key)=\(.value)"),(.devDependencies//{}|to_entries[]|"DEV \(.key)=\(.value)")]|.[]' "$f"; done`
  (verified working at plan time). Compare every version string in the section-2 tables against
  that output. Also re-verify the two "объявлен, но не используется" claims, since they are
  assertions about code and not about manifests: `pino-http` must have zero hits under
  `apps/api/src` and `zustand` zero hits under `apps/web/src`.

- **Section 3 (Секреты)** — verify the env-var list and the boot-guard claims against
  `apps/api/src/env.ts` (3998 bytes; the spec itself names this file as the authority for the
  `superRefine` guards). Also check the KMS provider claims against `packages/kms/`. If your tool
  permissions deny reading `.env` / `.env.example` paths, that is an EXPECTED, NON-BLOCKING
  limitation of this environment: verify section 3 against `apps/api/src/env.ts` alone, note in
  the findings row that the `.env.example` cross-check was not performed and why, and still issue
  an OK verdict if the code agrees with the spec. Do not mark section 3 unverifiable over this.

- **Section 4 (Схема данных)** — verify against `packages/db/migrations/*.sql` and
  `packages/db/src/`. Check the domain-table count, the RLS enable/force claims, the
  partitioning column, and that the highest-numbered migration on disk is reflected.

- **Section 5 (Планировщик)** — verify the worker count and worker names against the
  `create*Worker` imports in `apps/worker/src/server.ts`, and the queue names against
  `packages/shared-schemas/src/queues.ts`. Check the intervals/concurrency claims against the
  individual files under `apps/worker/src/queues/`.

- **Section 6 (Точки входа)** — verify plugin registration, body-parser handling and rate-limit
  config against `apps/api/src/server.ts`, and spot-check the four route-authorization tables
  (6.2 unauthenticated / 6.3 bearer / 6.4 session / 6.5 role-gated) against the actual route
  registrations. Spot-check, do not exhaustively enumerate every route.

- **Section 7 (Наблюдаемость)** — verify the "no bull-board anywhere" and "worker has no
  structured logger" claims.

- **Section 8 (Расхождения)** — cross-check each row against the Technology Stack block inside
  the `GSD:stack-start` / `GSD:stack-end` markers in `.claude/CLAUDE.md`, which is the authority
  the section names. Every 8.1 row asserts an absence; every 8.3 name asserts a version match.

- **Sections 9 and 10** — read only. Section 9 is a list of review questions, not as-built
  claims; section 10 is three lines of maintenance policy. Verify only that section 10 still
  agrees with the rule text being relocated in Task 2 (same section numbers, same routing).

**Calibration — naive greps produce false findings. Two worked examples from plan time:**
1. `grep -rn 'new Worker(' apps/worker/src | grep -v test | wc -l` returns **4**, which looks
   like it contradicts the spec's claim of 13 workers. It does not: workers are built by factory
   functions, and `apps/worker/src/server.ts` imports **13** `create*Worker` factories. The spec
   is right; the grep was wrong.
2. `grep -rh 'ENABLE ROW LEVEL SECURITY' packages/db/migrations/*.sql | wc -l` returns **23**,
   which looks like it contradicts the spec's claim of 22 domain tables. It does not: one match
   sits inside a SQL comment. Deduplicating by table name yields exactly **22**. The spec is
   right; the grep was wrong.
   Before you record ANY discrepancy, confirm your counting method matches what the sentence
   actually claims. When a grep disagrees with the spec, your first hypothesis is that the grep
   is wrong.

**Correction boundary — this is a bounded audit, not a rewrite.**

CORRECT in place, by editing `SPECIFICATION.md`: a claim that is factually wrong and whose
correct value is a short mechanically-derived literal — a version string, a count, a file path, a
line reference, a table / column / queue / route name, or a presence-vs-absence assertion. These
are one-token to one-line edits.

REPORT ONLY, recorded in the findings file with `SPECIFICATION.md` left untouched: anything
requiring new prose — an undocumented subsystem that would need a new subsection, a restructure of
section 8's three-way classification, adding or rewording section 9 review questions, or any
single change touching more than about five lines.

Rationale, in one line: the document's entire value is factual accuracy, so a wrong literal must
be fixed on sight, but authoring new analysis is a rewrite and a rewrite is a decision the user
should make with findings in hand rather than one you make mid-audit.

**Write the findings artifact** to
`.planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md`
with this exact shape:

- First line, verbatim, one of: `GATE: PASS` or `GATE: FAIL — <one-line reason>`.
  Write this line LAST, after you know the outcome.
- Then a `## Method` block: the commands you ran, and anything you could not check and why.
- Then a `## Verdicts` markdown table with a header row and exactly ten body rows, one per
  section, first cell in the form `| §1 |` through `| §10 |`, and a final `Status` cell holding
  exactly one of these four words.

Status meanings, applied per section:
  - `OK` — every claim you checked in that section is true as written.
  - `CORRECTED` — one or more wrong literals found and fixed in `SPECIFICATION.md` this run.
    List each correction (old value, new value, evidence) below the table.
  - `REPORT-ONLY` — a divergence exists but is non-material and prose-level (wording, ordering,
    a minor missing cross-reference). Does not mislead a security reviewer. Describe it below
    the table.
  - `BLOCKED` — you could not verify the section, OR it diverges materially in a way no literal
    correction can fix (an undocumented subsystem, a section describing a mechanism that no
    longer exists). Any single row with this status fails the deletion gate in Task 3.
- Then a `## Corrections applied` section and a `## Not corrected` section.

Do NOT add a legend, key, or status-reference table to the findings file — the Task 3 gate greps
the Status column and a legend row would corrupt the count.

Do not edit `.claude/CLAUDE.md` in this task.
  </action>

  <verify>
    <automated>
FINDINGS=.planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md
test -f "$FINDINGS" || { echo "FAIL: findings file missing"; exit 1; }
head -1 "$FINDINGS" | grep -qE '^GATE: (PASS|FAIL)' || { echo "FAIL: first line is not a GATE: line"; exit 1; }
N=$(grep -cE '^\| §([1-9]|10) \|' "$FINDINGS")
test "$N" -eq 10 || { echo "FAIL: expected 10 section verdict rows, found $N"; exit 1; }
grep -cE '^\| §([1-9]|10) \|.*\| *(OK|CORRECTED|REPORT-ONLY|BLOCKED) *\|? *$' "$FINDINGS" | grep -qx 10 || { echo "FAIL: every verdict row must end in a valid status cell"; exit 1; }
git diff --stat SPECIFICATION.md 2>/dev/null; git status --porcelain SPECIFICATION.md
echo "PASS: findings artifact well-formed with 10 section verdicts"
    </automated>
  </verify>

  <done>
`260727-sfk-AUDIT-FINDINGS.md` exists, opens with a `GATE:` line, and contains exactly ten
section verdict rows each ending in one of the four status values. Every wrong literal within the
correction boundary has been fixed in `SPECIFICATION.md`; everything outside that boundary is
described in the findings file and `SPECIFICATION.md` is otherwise unchanged.
  </done>
</task>

<task type="auto">
  <name>Task 2: Relocate the maintenance rule into .claude/CLAUDE.md after the last GSD marker block</name>

  <files>.claude/CLAUDE.md</files>

  <action>
Append the rule to `.claude/CLAUDE.md` AFTER the final line `<!-- GSD:profile-end -->`, which is
line 194 and currently the last line of the file. Content placed inside any GSD marker block is
regenerated and destroyed on the next GSD sync — that is the whole reason this rule was staged in
a snippet rather than written directly.

Copy the rule BODY from `CLAUDE-md-spec-rule.snippet.md`: the snippet's lines 7 through 30,
starting at the heading `## Project Specification (SPECIFICATION.md)`. Do NOT copy lines 1-5, the
leading HTML comment — those are instructions to you, not rule content. Preserve the body
verbatim, in Russian, including its bold emphasis and its bullet list; separate it from
`<!-- GSD:profile-end -->` with one blank line.

Before writing, cross-check the section numbers the rule routes to (2 Зависимости, 3 Секреты,
4 Схема данных, 5 Планировщик, 6 Публичные точки входа, 7 Наблюдаемость, 8 Расхождения) against
the actual headings in `SPECIFICATION.md` as they stand after Task 1. If Task 1 renumbered or
retitled any section, adjust the rule text to match reality as you paste it and note the
adjustment in the findings file under `## Corrections applied`. A rule that points at section
numbers which no longer exist is worse than no rule.

Do not modify anything above line 194. Do not delete the snippet in this task.
  </action>

  <verify>
    <automated>
grep -q '^## Project Specification (SPECIFICATION\.md)$' .claude/CLAUDE.md || { echo "FAIL: rule heading not found in CLAUDE.md"; exit 1; }
awk '/GSD:profile-end/{p=NR} /^## Project Specification \(SPECIFICATION\.md\)$/{s=NR} END{ if (p>0 && s>p) { print "PASS: rule at line " s " is after GSD:profile-end at line " p } else { print "FAIL: rule is not positioned after GSD:profile-end (p=" p " s=" s ")"; exit 1 } }' .claude/CLAUDE.md
grep -q 'Добавить в конец' .claude/CLAUDE.md && { echo "FAIL: snippet instruction comment was copied into CLAUDE.md"; exit 1; }
for n in 2 3 4 5 6 7 8; do grep -qE "^## ${n}\." SPECIFICATION.md || { echo "FAIL: SPECIFICATION.md has no section ${n} for the rule to route to"; exit 1; }; done
echo "PASS: rule relocated outside all GSD marker blocks and its section targets exist"
    </automated>
  </verify>

  <done>
`.claude/CLAUDE.md` ends with the maintenance rule, positioned strictly after
`<!-- GSD:profile-end -->`, carrying the snippet body without its instruction comment, and every
section number the rule routes to resolves to a real heading in `SPECIFICATION.md`.
  </done>
</task>

<task type="auto">
  <name>Task 3: Evaluate the deletion gate, conditionally remove the snippet, and commit</name>

  <files>CLAUDE-md-spec-rule.snippet.md</files>

  <action>
Evaluate three mechanical checks. All three must pass for the snippet to be deleted. Nothing here
is a judgment call at this point — the judgment was recorded as status values in Task 1.

- **G1** — the findings file exists and holds exactly ten section verdict rows.
- **G2** — zero verdict rows carry the status meaning "could not verify or materially diverges".
  A single such row means the spec is not trustworthy as-built, so the maintenance rule has not
  yet been proven to describe a document worth maintaining.
- **G3** — the rule heading in `.claude/CLAUDE.md` sits at a greater line number than the
  `GSD:profile-end` marker.

**If all three pass:** set the findings file's first line to `GATE: PASS`, then delete
`CLAUDE-md-spec-rule.snippet.md` with a plain filesystem `rm`. The file is UNTRACKED, so there is
no index entry to remove and `git rm` is the wrong tool and will fail.

**If any check fails:** do NOT delete the snippet — leave it byte-for-byte untouched on disk. Set
the findings file's first line to `GATE: FAIL — <reason>` naming which check failed and which
sections carry the failing status. Then still complete the commit below: the audit findings and
the CLAUDE.md relocation are finished work and are worth keeping regardless. Surface in your
summary exactly which sections need a decision from the user and what that decision is.

**Commit.** Stage and commit in one atomic commit:
- `.planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md`
- `.claude/CLAUDE.md`
- `SPECIFICATION.md` — note this file is currently untracked, so this commit is its first. That
  is intentional: `.claude/CLAUDE.md` now instructs every future change to update it, and a
  tracked instruction pointing at an untracked file would not survive a fresh clone.
- the snippet deletion, if the gate passed.

Commit message: `docs(quick-260727-sfk): audit SPECIFICATION.md and relocate maintenance rule`.
Do not create a branch; commit on `master`.
  </action>

  <verify>
    <automated>
FINDINGS=.planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md
BAD=$(grep -cE '^\| §([1-9]|10) \|.*\| *BLOCKED *\|? *$' "$FINDINGS")
head -1 "$FINDINGS" | grep -qE '^GATE: (PASS|FAIL)' || { echo "FAIL: no GATE verdict line"; exit 1; }
if [ "$BAD" -eq 0 ] && grep -q '^GATE: PASS' "$FINDINGS"; then
  test ! -e CLAUDE-md-spec-rule.snippet.md || { echo "FAIL: gate passed but snippet still present"; exit 1; }
  echo "PASS: gate passed, snippet removed"
else
  test -f CLAUDE-md-spec-rule.snippet.md || { echo "FAIL: gate did not pass but snippet was deleted anyway"; exit 1; }
  head -1 "$FINDINGS" | grep -q '^GATE: FAIL' || { echo "FAIL: unverifiable sections present but gate line does not say FAIL"; exit 1; }
  echo "PASS: gate failed, snippet correctly retained"
fi
git log -1 --oneline | grep -q '260727-sfk' || { echo "FAIL: work not committed"; exit 1; }
git status --porcelain SPECIFICATION.md .claude/CLAUDE.md | grep -q . && { echo "FAIL: tracked changes left uncommitted"; exit 1; }
echo "PASS: gate evaluated consistently and work committed"
    </automated>
  </verify>

  <done>
The findings file opens with a definitive `GATE: PASS` or `GATE: FAIL — <reason>` line. The
snippet is deleted if and only if the gate passed; otherwise it is intact and the reason is
recorded. `SPECIFICATION.md`, `.claude/CLAUDE.md`, the findings file, and any deletion are in one
commit on `master` with no tracked changes left in the working tree.
  </done>
</task>

</tasks>

<verification>
1. `head -1 .planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md`
   returns a `GATE: PASS` or `GATE: FAIL — <reason>` line.
2. The findings file contains exactly ten `| §N |` verdict rows covering sections 1 through 10.
3. `awk` confirms the rule heading in `.claude/CLAUDE.md` is after `<!-- GSD:profile-end -->`.
4. The snippet's presence on disk matches the gate outcome — absent on PASS, present on FAIL.
5. Every section number the relocated rule routes to (2 through 8) resolves to a real
   `## N.` heading in `SPECIFICATION.md`.
6. `git status --porcelain` shows no uncommitted changes to `SPECIFICATION.md` or
   `.claude/CLAUDE.md`.
</verification>

<success_criteria>
- All ten sections of `SPECIFICATION.md` audited against the real repo, with the commands used
  recorded so the audit is reproducible rather than asserted.
- Wrong literals corrected in place; anything larger reported rather than silently rewritten.
- The maintenance rule lives permanently in `.claude/CLAUDE.md`, outside every GSD marker block,
  where regeneration cannot clobber it.
- The snippet is deleted only under a gate that a third party can re-run, and its retention on
  failure is explicit and explained rather than accidental.
</success_criteria>

<output>
Create `.planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-SUMMARY.md` when done.

The summary must state: the gate outcome and why, the per-section verdict table, every correction
applied to `SPECIFICATION.md`, and — if the gate failed — the specific decision needed from the
user to unblock deletion of the snippet.
</output>
