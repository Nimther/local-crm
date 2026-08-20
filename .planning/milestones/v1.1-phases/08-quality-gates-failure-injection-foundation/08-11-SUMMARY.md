---
phase: 08-quality-gates-failure-injection-foundation
plan: 11
subsystem: testing
tags: [coverage, vitest, v8, monorepo, projects, threshold]

requires:
  - phase: 08-06
    provides: the ephemeral-database provisioning every DB-touching project in the aggregate relies on
provides:
  - Root vitest.config.ts aggregating eight backend projects into one run with one denominator
  - coverage-baseline.json — the measured threshold with its full provenance
  - npm run coverage
  - "@vitest/coverage-v8 in apps/api and apps/worker"
affects: [08-14, 08-16, 08-18]

tech-stack:
  added: ["@vitest/coverage-v8@^4.1.9 in apps/api and apps/worker"]
  patterns:
    - "One aggregated run with one denominator, so packages executed but untested are visible instead of reading 0%"
    - "A threshold is stored with its measurement, its date and its increment — a bare number invites silent downward drift"

key-files:
  created:
    - vitest.config.ts
    - coverage-baseline.json
  modified:
    - apps/api/package.json
    - apps/worker/package.json
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "Bare directory entries in test.projects work in Vitest 4.1.9, so packages/segments-core and packages/shared-schemas did NOT get the minimal configs the plan provisionally called for"
  - "Each project is referenced by its own config path so per-project settings are inherited rather than restated — apps/worker keeps fileParallelism:false with no duplication"
  - "coverage runs with --testTimeout=60000, scoped to that script only: v8 instrumentation pushes a legitimately expensive >50MB upload test past the standard 20s"
  - "`all` stays at its default, so the denominator is the files the run actually loaded (D-17)"
  - "The threshold is stored as an unrounded fraction, never a percentage"

patterns-established:
  - "Adding a backend workspace means adding it to the root projects array; forgetting to would show up as its tests vanishing from the aggregate, not as a silent 0%"

requirements-completed: [QG-03]

coverage:
  - id: D1
    description: "One aggregated run over the backend scope produces one coverage report with one denominator"
    requirement: QG-03
    verification:
      - kind: integration
        ref: "npm run coverage — exit 0, 97 files / 563 tests, coverage/coverage-summary.json written"
        status: pass
    human_judgment: false
  - id: D2
    description: "Packages executed but untested appear with real coverage instead of 0%, and apps/web is absent"
    requirement: QG-03
    verification:
      - kind: manual_procedural
        ref: "coverage-summary.json — kms 45/60, tenant-context 22/24, contacts-core 109/113 lines; apps/web 0 files"
        status: pass
    human_judgment: false
  - id: D3
    description: "A project whose tests fail fails the whole aggregated run, so no workspace can drop out of the denominator"
    requirement: QG-03
    verification:
      - kind: integration
        ref: "deliberately broken packages/flows-core/src/__tests__/wait-until.test.ts — npm run coverage exit 1, failure named; reverted"
        status: pass
    human_judgment: false
  - id: D4
    description: "The threshold is the measurement plus a deliberate increment, recorded as an unrounded fraction with its provenance"
    requirement: QG-03
    verification:
      - kind: unit
        ref: "the plan's own verify command — lines === measuredLines + 0.01 within 1e-9, 0 < lines < 1"
        status: pass
    human_judgment: false
  - id: D5
    description: "apps/worker keeps fileParallelism:false under aggregation"
    verification:
      - kind: manual_procedural
        ref: "root config references apps/worker/vitest.config.ts by path, so the flag is inherited; no restatement was needed"
        status: pass
    human_judgment: true
    rationale: "Inheritance is established by construction and by the run passing, not by a direct observation of the scheduler. A regression here presents as flakiness in flow-run-advance-integration, which is exactly what makes it worth a human's attention if that file ever starts failing intermittently."

duration: 34 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 11: Aggregated Coverage Baseline Summary

**Coverage measured for the first time — 3366/4194 lines = 80.258% — over one aggregated run of eight backend projects, with the threshold recorded a deliberate percentage point above it and the gate red by design until 08-16 closes the gap.**

## Performance

- **Duration:** 34 min
- **Started:** 2026-07-28T10:13:00Z
- **Completed:** 2026-07-28T10:47:00Z
- **Tasks:** 3
- **Files modified:** 6 (2 created, 4 modified)

## The measurement

| Metric | Covered / Total | % |
|--------|----------------:|--:|
| **lines** | **3366 / 4194** | **80.258** |
| statements | 3552 / 4530 | 78.411 |
| functions | 706 / 892 | 79.148 |
| branches | 1672 / 2432 | 68.750 |

**Enforced threshold: `0.8125751072961374`** — the measured `0.8025751072961373` plus `0.01`.

Stored as an unrounded fraction, never a percentage: 08-14 compares `covered / total` against it directly, and SPEC's precision edge turns on that — a run at 84.996% must fail an 85% threshold rather than round up to a pass.

**The gate is RED at this point by construction.** The enforced number is a percentage point above what the suite achieves today, and 08-16's targeted tests on `packages/kms` and `packages/tenant-context` are what close it. `measuredLines`, `measuredAt` (with the raw `covered`/`total` integers) and `increment` sit next to the threshold precisely so a later reader can tell that a lowered value would be a capitulation rather than a correction.

## Why aggregation, not a report merge

`packages/kms`, `packages/tenant-context` and `packages/contacts-core` have **no tests of their own**. Merging per-workspace reports would show all three at 0% and drag the threshold to a number that describes nothing. In one aggregated run:

| Package | Files | Lines covered |
|---------|------:|--------------:|
| `packages/kms` | 5 | 45 / 60 |
| `packages/tenant-context` | 1 | 22 / 24 |
| `packages/contacts-core` | 6 | 109 / 113 |

They are executed constantly by `apps/api`'s and `apps/worker`'s tests. `apps/web` appears in 0 files, as intended.

## Empirical answers the plan asked for

- **Bare directory entries work.** Vitest 4.1.9's `test.projects` accepts a directory for a config-less package: a throwaway config listing `packages/segments-core`, `packages/shared-schemas` and `packages/flows-core` collected 5 files / 52 tests, and both config-less packages appear in the real run under their own package names as project labels. **The two minimal configs the plan provisionally called for were therefore not created** — they would have been ceremony to satisfy an aggregator that did not need them.
- **Per-project settings are inherited** by referencing each project's own config path. `apps/worker`'s `fileParallelism: false` needed no restatement.
- **Project collection, all eight:** api 48, worker 27, delivery-core 8, test-support 7, db 2, flows-core 2, shared-schemas 2, segments-core 1 = **97 files**.
- **A failing project fails the whole run.** A deliberately broken `flows-core` test produced `exit 1` with the failure named `|@mega-crm/flows-core| src/__tests__/wait-until.test.ts`. Reverted.

## Task Commits

All three tasks landed in `dbcc885`. Task 1's outcome was a *finding* rather than a file (the configs proved unnecessary), and Task 3 cannot exist before Task 2's run produces the number it records.

## Files Created/Modified

- `vitest.config.ts` — the aggregate: eight projects, v8 coverage, `text` + `json-summary`, scoped includes
- `coverage-baseline.json` — `lines`, `measuredLines`, `measuredAt`, `increment`, `metric`, `scope`, and a note stating the gate is red on purpose
- `apps/api/package.json`, `apps/worker/package.json` — `@vitest/coverage-v8@^4.1.9`, minor matched to `vitest`
- `package.json` — `coverage` script
- `SPECIFICATION.md` — §1.3 (the aggregate, the coverage settings, the baseline file and its numbers), §2.2 and §2.3 (the provider)

## Decisions Made

- **`--testTimeout=60000` on the coverage script only.** See Deviations — instrumentation is the cost, and normal per-workspace runs stay strict at 20s.
- **`all` left at its default.** The denominator is the files the run actually loaded. With a single aggregated run that is nearly the whole backend; turning it on would pull in code no test imports and make the number describe the wrong thing.
- **`apps/web` excluded.** Outside the coverage scope by D-16, and folding a jsdom project into a node aggregate would mix two denominators anyway.

## Deviations from Plan

### 1. [Rule 1 — Environment] The coverage lane needs a longer per-test timeout

- **Found during:** Task 2, first aggregated run — `exit 1`, one failure: `csv-import.test.ts > WR-04: a truncated upload sets status 'failed' and returns 413`, *timed out in 20000ms*.
- **Isolation:** the file passes in **6.57s uninstrumented** and times out **with coverage alone**, on its own, with no aggregation load. So this is instrumentation cost, not project contention.
- **Why that test:** WR-04 deliberately builds a real **>50 MB** multipart payload (52 rows × ~1 MB of padding) to make the 50 MB cut land mid-value. v8 instrumentation on the multipart and CSV parsing path is what pushes it over.
- **Fix:** `"coverage": "vitest run --coverage --testTimeout=60000"`. Scoped to that script, so `npm run test --workspaces` keeps the strict 20s and stays fast. The timeout is a harness parameter, not a behavioural assertion — raising it for an instrumented run does not weaken anything the test asserts.
- **Verification:** 97 files / 563 tests, exit 0.

### 2. [Rule 1 — Plan branch not taken] Two config files were not created

`packages/segments-core/vitest.config.ts` and `packages/shared-schemas/vitest.config.ts` appear in the plan's `files_modified`, but Task 1's action makes them conditional on bare directory entries *not* working. They do work, verified empirically before anything was written. Recorded rather than created.

### 3. [Rule 1 — Environment] `docker compose up -d --wait` in the `<verify>` blocks

As in 08-08 through 08-10: native services on the same ports and DSNs.

---

**Total deviations:** 2 environmental, 1 plan-branch-not-taken.
**Impact on plan:** No scope reduction. Two files fewer than `files_modified` anticipated, for a reason the plan itself asked to be checked first.

## Issues Encountered

- **The aggregated run takes ~57s wall clock** (114s of test time across parallel projects), against roughly 40s for `npm run test --workspaces`. Instrumentation and the coverage report are the difference. Worth knowing before 08-18 decides whether coverage belongs in the blocking job or a separate one.
- **`npm run coverage` and `npm run test --workspaces` collect different totals** — 97 files / 563 tests versus 102 / 608 — and the difference is exactly `apps/web` (6 files, 45 tests). That is by design, but a reader comparing the two numbers without knowing the scope would think something was missing.

## User Setup Required

None. `npm run coverage` needs the same local Postgres and Redis the rest of the suite uses.

## Next Phase Readiness

- **08-14** consumes `coverage/coverage-summary.json` and `coverage-baseline.json`. Both exist and the `json-summary` reporter is wired. The gate script must compare `covered / total` unrounded against `lines`, with equality passing.
- **08-16** is what makes the gate green. The two packages named in D-19 are exactly the ones with the most uncovered lines relative to their size and consequence: `kms` at 45/60 and `tenant-context` at 22/24 — tenant key encryption and the RLS session boundary.
- **08-18** should decide where coverage runs. It roughly doubles the test-job wall clock, and it is the only lane that needs the raised timeout.
- **QG-03 is not yet marked complete** — 08-14 also declares it.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
