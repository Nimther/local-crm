---
phase: quick-260727-sfk
plan: 01
subsystem: docs
tags: [specification, audit, claude-md, security-review]
status: complete
dependency-graph:
  requires: []
  provides:
    - "SPECIFICATION.md (audited, now tracked in git)"
    - "SPECIFICATION.md maintenance rule permanently in .claude/CLAUDE.md"
  affects:
    - ".claude/CLAUDE.md"
tech-stack:
  added: []
  patterns:
    - "GSD marker-block-safe doc rule placement (content after the last GSD:*-end marker survives regeneration)"
key-files:
  created:
    - ".planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md"
  modified:
    - "SPECIFICATION.md (one literal correction; first commit, was previously untracked)"
    - ".claude/CLAUDE.md (maintenance rule appended after <!-- GSD:profile-end -->)"
  deleted:
    - "CLAUDE-md-spec-rule.snippet.md (gate passed, deleted per plan)"
decisions:
  - "Gate passed on the first pass: SPECIFICATION.md was already accurate as-built, so no
     rewrite decision was deferred to the user."
metrics:
  duration: "~45min"
  completed: "2026-07-27"
---

# Phase quick-260727-sfk Plan 01: Audit SPECIFICATION.md and relocate maintenance rule Summary

Audited all ten sections of `SPECIFICATION.md` against the live repository, found and fixed one
wrong line reference, then relocated the doc-maintenance rule from the temporary snippet into
`.claude/CLAUDE.md` (outside every GSD marker block) and deleted the snippet under a passing gate.

## Gate outcome

**GATE: PASS**

All three mechanical gate checks passed:

- **G1** (findings file has exactly 10 section verdict rows): 10/10 — confirmed.
- **G2** (zero rows carry `BLOCKED`): 0 `BLOCKED` rows — confirmed.
- **G3** (rule heading in `.claude/CLAUDE.md` sits after `<!-- GSD:profile-end -->`): the rule
  heading is at line 196, the marker is at line 194 — confirmed.

Because all three gates passed, `CLAUDE-md-spec-rule.snippet.md` was deleted with a plain `rm`
(it was untracked, so `git rm` was not applicable) and the findings file's first line was set to
`GATE: PASS`.

## Per-section verdict table

| Section | Title | Status |
|---|---|---|
| §1 | Топология | CORRECTED |
| §2 | Зависимости и версии | OK |
| §3 | Секреты | OK |
| §4 | Схема данных | OK |
| §5 | Планировщик и пайплайн отправки | OK |
| §6 | Публичные точки входа | OK |
| §7 | Наблюдаемость | OK |
| §8 | Расхождения с Technology Stack | OK |
| §9 | Сводка вопросов к ревью | OK |
| §10 | Поддержание документа | OK |

Full method (every command run, per section) and the "Not corrected" false-positive
investigations are recorded in
`.planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md`.

## Corrections applied to SPECIFICATION.md

**1. [§1 Топология] Wrong line reference for the worker's "no HTTP listener" comment**

- **Old value:** `apps/worker/src/server.ts:46-47`
- **New value:** `apps/worker/src/server.ts:45-46`
- **Why:** The claim itself ("HTTP-листенера нет") is true. The cited range pointed at the
  closing two lines of the doc-comment block (` * server.` / ` */`), not the sentence that
  actually states "No HTTP listener" — that sentence spans lines 45-46
  (` * No HTTP listener; this is a long-running background process, not a` / ` * server.`).
- **Evidence:** Direct `Read` of `apps/worker/src/server.ts` lines 40-51.

No other corrections were needed. Every other literal checked across sections 2-10 — package
versions, unused-dependency claims, env-var names/validation, file:line citations,
table/column/enum/index/partition names, the full RLS policy-variant classification (12 Variant-A
+ 10 Variant-B tables, independently re-derived from the migrations and matching exactly,
including the `campaigns` migration-0019 override), worker/queue names and counts, the 85-route
count (independently re-derived), the 9 `resolveWorkspaceMember` copy locations, the role-matrix
permission set, and every CLAUDE.md-vs-code discrepancy row in §8 — matched the document as
written.

Two naive greps looked like they contradicted the spec and were investigated per the plan's
calibration guidance; both turned out to be false positives, not spec defects:

- `grep -rn "fastify-plugin" apps/api/src` returns 3 files, but only `auth/plugin.ts:21` has a
  real `import fp from "fastify-plugin"` — the other two hits are prose comments saying "not
  fastify-plugin".
- `grep -rln nanoid apps/api/src` returns 2 files, but only `tenancy/workspaces.ts` has a real
  `import { nanoid } from "nanoid"` — the other hit (`auth.ts:58`) only mentions "nanoid" inside a
  comment.

## Rule relocation

Copied the rule body (from `## Project Specification (SPECIFICATION.md)` onward, excluding the
snippet's leading HTML instruction comment) into `.claude/CLAUDE.md`, placed after
`<!-- GSD:profile-end -->` (line 194) so GSD regeneration cannot destroy it. The section numbers
the rule routes to (2 through 8) were cross-checked against `SPECIFICATION.md`'s actual headings
after Task 1's correction — no renumbering occurred, so the rule text needed no adjustment.

## Deviations from Plan

None — plan executed exactly as written. No architectural decisions or blocking issues arose;
the audit surfaced exactly one literal-correctable finding, which is within the plan's
correction boundary and was fixed in place.

## Auth gates

None encountered.

## Known Stubs

None.

## Threat Flags

None — this plan touched only documentation files (`SPECIFICATION.md`, `.claude/CLAUDE.md`,
the findings artifact) and deleted a temporary snippet; no new runtime surface was introduced.

## Self-Check: PASSED

- `SPECIFICATION.md` exists at repo root: FOUND
- `.claude/CLAUDE.md` contains the rule heading after `GSD:profile-end`: FOUND (line 196 > 194)
- `.planning/quick/260727-sfk-specification-md-as-built-claude-md-spec/260727-sfk-AUDIT-FINDINGS.md`
  exists with `GATE: PASS` as its first line and 10 verdict rows: FOUND
- `CLAUDE-md-spec-rule.snippet.md` absent from working tree: CONFIRMED ABSENT (gate passed)
- Commit `b63ca82` exists in `git log`: FOUND
- `git status --porcelain SPECIFICATION.md .claude/CLAUDE.md` reports no uncommitted changes:
  CONFIRMED CLEAN

## Commits

- `b63ca82`: `docs(quick-260727-sfk): audit SPECIFICATION.md and relocate maintenance rule`
  (all three tasks' changes — findings artifact, `SPECIFICATION.md` correction, `.claude/CLAUDE.md`
  relocation, and the snippet deletion — in one atomic commit per the plan's Task 3 instructions).
