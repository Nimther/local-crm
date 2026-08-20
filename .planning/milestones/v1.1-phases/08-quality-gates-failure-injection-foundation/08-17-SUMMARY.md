---
phase: 08-quality-gates-failure-injection-foundation
plan: 17
subsystem: documentation
tags: [architecture, conventions, documentation, expand-contract, rls, envelope-encryption]

requires:
  - phase: 08-13
    provides: the failure-scenario checklist this document points at
  - phase: 08-14
    provides: the coverage ratchet cited as the escape-hatch policy's teeth
  - phase: 08-15
    provides: the env-path resolver and root-hygiene check cited as conventions
provides:
  - ARCHITECTURE.md — five load-bearing decisions, one diagram
  - CONVENTIONS.md — every rule cited to a real file
  - A binding documentation-update rule covering three documents with per-document triggers
affects: [phase-09-partitions, phase-10-rls-unification, phase-11-delivery-state-machine, phase-13-secrets]

tech-stack:
  added: []
  patterns:
    - "Three documents, three non-overlapping roles, stated at the top of each"
    - "A convention is only recorded if a live repository file demonstrates it"
    - "A written rule quotes what the enforcing tool accepts, verbatim"

key-files:
  created:
    - ARCHITECTURE.md
    - CONVENTIONS.md
  modified:
    - .claude/CLAUDE.md

key-decisions:
  - "Exactly one diagram, for the event-to-send path — every diagram is another surface to update on every architectural change"
  - "No package version, table name, column name or environment-variable name is restated; facts link to SPECIFICATION.md"
  - "Present tense only where a cited file backs it; everything scheduled for Phases 9-16 sits under a labelled forward-looking section naming the phase"
  - "Per-document trigger lists in .claude/CLAUDE.md rather than one merged list, with identical obligating wording for all three"

patterns-established:
  - "A new convention must arrive with the file that demonstrates it, or it does not go in CONVENTIONS.md"

requirements-completed: [QG-08, QG-09, QG-10]

coverage:
  - id: D1
    description: "ARCHITECTURE.md covers all five named blocks with exactly one diagram and defers as-built facts"
    requirement: QG-08
    verification:
      - kind: unit
        ref: "the plan's verify command — five block keywords present, exactly 1 mermaid diagram, links to SPECIFICATION.md"
        status: pass
      - kind: manual_procedural
        ref: "grep -c SPECIFICATION.md = 6; grep -cE '[0-9]+\\.[0-9]+\\.[0-9]+' = 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "CONVENTIONS.md records only conventions backed by a real repository file"
    requirement: QG-09
    verification:
      - kind: unit
        ref: "the plan's verify command — 20 distinct cited paths, all resolving on disk"
        status: pass
    human_judgment: false
  - id: D3
    description: "The expand/contract marker syntax quoted in the document is what the linter actually accepts"
    requirement: QG-09
    verification:
      - kind: integration
        ref: "lintMigrationDirectory run against a fixture written from the document's own quoted example — zero violations"
        status: pass
    human_judgment: false
  - id: D4
    description: "The documentation-update rule covers three documents with concrete per-document triggers, and both placeholders are gone"
    requirement: QG-10
    verification:
      - kind: unit
        ref: "the plan's verify command — all three named, no placeholder text; ARCHITECTURE.md and CONVENTIONS.md each referenced 6 times"
        status: pass
      - kind: manual_procedural
        ref: "git diff shows removals limited to the two placeholders and the replaced header line; the SPECIFICATION.md routing list is untouched"
        status: pass
    human_judgment: false
  - id: D5
    description: "Neither document describes planned behaviour as current"
    requirement: QG-08
    verification: []
    human_judgment: true
    rationale: "SPEC states outright that this is a judgment, not a machine check. Both documents were written with present tense reserved for cited files and a labelled forward-looking section per document; whether every sentence honours that is a reading a human should make."

duration: 24 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 17: ARCHITECTURE.md and CONVENTIONS.md Summary

**Two documents that say why and how, a rule that keeps all three current with triggers concrete enough to act on, and a `CLAUDE.md` that no longer claims neither document exists.**

## Performance

- **Duration:** 24 min
- **Started:** 2026-07-28T13:57:00Z
- **Completed:** 2026-07-28T14:21:00Z
- **Tasks:** 3
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments

- **`ARCHITECTURE.md`** — the five load-bearing decisions and what each costs, with exactly one diagram and six links to `SPECIFICATION.md` in place of restated facts.
- **`CONVENTIONS.md`** — four areas, every rule followed by a repository file that demonstrates it. **Twenty cited paths, all asserted to exist on disk.**
- **One binding update rule for three documents**, with separate trigger lists per document and identical obligating wording throughout.

### What each document actually says

`ARCHITECTURE.md`'s five blocks are written as decisions with costs, not as descriptions:

- **The app/package boundary** — including the case where the rule *changed a design* rather than merely describing one: the SIGKILL harness needed a child process running worker code, and rather than invert the dependency arrow, the generic orchestration went into `packages/test-support` naming no domain concept, with the worker-specific entrypoint staying in `apps/worker`. The constraint produced a cleaner separation than the shortcut would have.
- **The event-to-send path** — the one block with a diagram, including why dispatch is three units and precisely where the duplicate-send window sits.
- **Two send queues, not priorities** — because priority reorders a queue but the workers are already busy.
- **Shared schema with RLS** — why not schema- or database-per-tenant, why RLS is defence in depth rather than the only defence, and why `FORCE` matters when the application role owns the tables.
- **Envelope encryption** — framed by what a database compromise yields under each alternative, which is the only framing that makes the choice legible.

`CONVENTIONS.md`'s escape-hatch section states the symmetry outright: a lint suppression, a destructive-DDL marker and a coverage exclusion are **one principle, not three coincidences** — scoped to the site, naming the thing excepted, carrying a reason, with blanket forms forbidden everywhere.

### The written rule and the enforced rule cannot drift

The expand/contract section quotes the destructive-DDL marker syntax verbatim from what `scripts/lint-migrations.mjs` accepts. That was not taken on trust: a fixture was written **from the document's own quoted example** and run through the real linter, which returned zero violations. A written rule worded differently from the enforced one produces exactly the argument it was meant to prevent.

### Nothing planned is described as current

Both documents reserve the present tense for statements a cited file backs. Everything scheduled for Phases 9 through 16 — partition growth, RLS unification, the delivery state machine's new state, per-tenant concurrency caps, the deployment story — sits under a labelled forward-looking section naming its phase.

This is the one SPEC prohibition here that is explicitly a judgment rather than a check, and it is the single most likely way either document becomes actively misleading: a reader who believes a protection is in place stops looking for it.

## Task Commits

All three tasks landed in `bde19ff`.

## Files Created/Modified

- `ARCHITECTURE.md` — 9.8 KB, five blocks, one mermaid diagram, forward-looking section
- `CONVENTIONS.md` — 8.2 KB, four areas, 20 cited paths, forward-looking section
- `.claude/CLAUDE.md` — the two placeholders replaced with pointers; the documentation section extended from one document to three with per-document triggers

## Decisions Made

- **One diagram, deliberately.** The event-to-send path is the product's centre and has been stable since Phase 4. Every additional diagram is another surface to update on every architectural change — the rot the update rule exists to prevent.
- **Separate trigger lists, not one merged list.** SPEC R12's acceptance criterion is specifically that triggers are named *per document*. A merged list would make it ambiguous which document a given change obliges.
- **The obligating wording is identical across all three.** A recommendation-shaped sentence for two of the three would make the whole section optional in practice.
- **The existing `SPECIFICATION.md` routing list was left byte-identical.** It is precise, it works, and rewriting it risks losing a routing rule a previous plan added for a specific reason. `git diff` confirms the only removals are the two placeholders and the replaced header line.

## Deviations from Plan

### 1. [Rule 1 — Bug, in own work] The section heading did not match the plan's own check

`CONVENTIONS.md`'s section was written as "Expand / contract", and the plan's verify command matches `/expand\/contract/i` — no spaces. Renamed. A small thing, but the fourth time in this phase a check has turned on exact wording, which is itself worth noting: these checks are prose-sensitive by design.

### 2. [Rule 1 — Bug, in own work] A Russian typo in the new trigger list

"домменное" → "доменное" in the `ARCHITECTURE.md` trigger list. Caught on re-read.

---

**Total deviations:** 2 auto-fixed.
**Impact on plan:** None. Every artifact exists as specified.

## Issues Encountered

- **`.claude/CLAUDE.md`'s Conventions and Architecture sections carry GSD generator markers** (`<!-- GSD:conventions-start source:CONVENTIONS.md -->`). The pointers written into them are consistent with what a regeneration from those source files would produce, but if that generator runs it will overwrite the prose. Worth knowing before someone wonders why an edit vanished.
- **`ARCHITECTURE.md` deliberately contains no version numbers**, which the acceptance check asserts as a proxy for fact-copying. That proxy is imperfect — a table name could still be copied without tripping it — so the no-duplication property rests on the writing, not on the check.

## User Setup Required

None.

## Next Phase Readiness

- **QG-08, QG-09 and QG-10 are complete.** All three documents exist, in three non-overlapping roles, with a rule that obliges keeping them so.
- **08-18** is the last plan in the phase: four CI jobs and the required-status-check registration, which includes an operator checkpoint for branch protection.
- **Phases 9, 10, 11 and 13 each have a named entry** in one or both forward-looking sections, pointing at the tests that pin today's behaviour. Whoever plans them should read those sections first — they say what the harness currently guarantees, which is what those phases have to change deliberately.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
