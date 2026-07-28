---
phase: 08-quality-gates-failure-injection-foundation
plan: 14
subsystem: testing
tags: [coverage, threshold, ratchet, ci-gate, tdd]

requires:
  - phase: 08-11
    provides: coverage-baseline.json, the aggregated json-summary report, and the measured threshold these enforce
provides:
  - scripts/coverage-gate.mjs — unrounded threshold comparison, equality passes
  - scripts/coverage-ratchet.mjs — a lowered threshold is a failing check
  - npm run coverage:gate and npm run coverage:ratchet
affects: [08-16, 08-18]

tech-stack:
  added: []
  patterns:
    - "Gate scripts are Node-builtins-only with a pure exported function and a CLI behind an import.meta.url guard, so tests drive the logic with in-memory fixtures"
    - "A threshold ships with a ratchet; a number anyone can lower in the commit that broke it is not a gate"

key-files:
  created:
    - scripts/coverage-gate.mjs
    - scripts/coverage-gate.d.mts
    - scripts/coverage-ratchet.mjs
    - scripts/coverage-ratchet.d.mts
    - packages/test-support/src/__tests__/coverage-gate.test.ts
    - packages/test-support/src/__tests__/coverage-ratchet.test.ts
  modified:
    - package.json

key-decisions:
  - "Equality passes (`>=`): failing on equality would make the recorded number unreachable by construction"
  - "No rounding anywhere before the comparison — the SPEC precision edge turns entirely on this"
  - "A zero denominator fails with its own message rather than producing NaN"
  - "No margin in the ratchet, of any size: a permitted margin is a smaller version of the loophole it closes"
  - "A base ref with no baseline file passes (the introducing commit); any other git failure is an error, not a pass"

patterns-established:
  - "Prove a check in both directions before trusting it — a ratchet that has only been seen to pass is indistinguishable from one that always passes"

requirements-completed: [QG-03]

coverage:
  - id: D1
    description: "A run exactly at the threshold passes; one line below fails; one line above passes"
    requirement: QG-03
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/coverage-gate.test.ts#checkCoverageGate — the boundary"
        status: pass
    human_judgment: false
  - id: D2
    description: "The comparison is the unrounded fraction — 0.84996 fails a 0.85 threshold instead of rounding into a pass"
    requirement: QG-03
    verification:
      - kind: unit
        ref: "coverage-gate.test.ts#fails a fraction that only reaches the threshold once rounded — asserts both the failure and that the fixture does round to 85.00"
        status: pass
    human_judgment: false
  - id: D3
    description: "A report with an empty denominator fails rather than producing NaN"
    requirement: QG-03
    verification:
      - kind: unit
        ref: "coverage-gate.test.ts#fails when total is 0 rather than producing NaN"
        status: pass
    human_judgment: false
  - id: D4
    description: "Lowering the recorded threshold is a failing check with no margin, and the introducing-commit case passes cleanly"
    requirement: QG-03
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/coverage-ratchet.test.ts — 5 cases including a 1e-12 decrease"
        status: pass
      - kind: integration
        ref: "node scripts/coverage-ratchet.mjs HEAD — delta 0 exit 0 unmodified; delta -0.020000000000000018 exit 1 with lines lowered; exit 0 after restore"
        status: pass
    human_judgment: false
  - id: D5
    description: "The gate runs against the real report and reports the real shortfall"
    verification:
      - kind: integration
        ref: "node scripts/coverage-gate.mjs — 3418/4260, actual 0.8023474178403756, threshold 0.8125751072961374, exit 1"
        status: pass
    human_judgment: true
    rationale: "The gate is RED and that is the intended state until 08-16 lands. Whether the red is still the *expected* red rather than a new regression is a judgment a human should make when they next see it."

duration: 26 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 14: Coverage Gate and Ratchet Summary

**The threshold is now enforced with equality passing and no rounding anywhere in the comparison, and lowering it is a failing check with no margin — both proven by observation in both directions rather than assumed.**

## Performance

- **Duration:** 26 min
- **Started:** 2026-07-28T12:02:00Z
- **Completed:** 2026-07-28T12:28:00Z
- **Tasks:** 3
- **Files modified:** 7 (6 created, 1 modified)

## The gate, against the real report

```
coverage:gate — lines 3418/4260
  actual    0.8023474178403756
  threshold 0.8125751072961374
coverage:gate FAILED.
  short by 0.010227689455761801 (unrounded).
```

**This red is expected and must not be "fixed" by lowering the number.** 08-11 set the threshold a deliberate percentage point above the measurement, and 08-16's targeted tests on `packages/kms` and `packages/tenant-context` are what close the gap. `git diff coverage-baseline.json` is empty at the end of this plan.

The gate prints its numbers on the **pass** path too. A gate that is silent when green gives a reader no way to watch the margin narrow commit by commit.

## Two semantics that decide whether this is a gate or a decoration

- **Equality passes.** Failing on equality would make the recorded number unreachable by construction — you could never land exactly on your own threshold.
- **The comparison is unrounded.** 84996/100000 = 0.84996 displays as `85.00%` at two decimals and is strictly below 0.85. The unit case asserts both that this fails **and** that the fixture genuinely does round to the threshold — without that second assertion the fixture could drift into proving nothing.

A **zero denominator** is a failure with its own message rather than NaN. A report that measured nothing passing the gate is the coverage equivalent of a lint run that checked zero files — the hole `lint-file-floor.json` exists to close for ESLint.

## The ratchet, proven in both directions

| State | Base ref | Delta | Exit |
|---|---|---|:--:|
| unmodified | `HEAD` | `0` | 0 |
| `lines` lowered by 0.02 | `HEAD` | `-0.020000000000000018` | **1** |
| restored | `HEAD` | `0` | 0 |
| unmodified | `origin/master` | n/a — no baseline there yet | 0 |

A ratchet that has only ever been seen to pass is indistinguishable from one that always passes, so it was exercised against a lowered value rather than trusted.

**No margin, of any size.** A unit case drops the threshold by `1e-12` and asserts failure. Permitting a margin would be a smaller version of the loophole the check closes, and none is needed: `coverage-baseline.json` carries `measuredLines` and `measuredAt`, so a legitimate re-measurement is visible as exactly that.

**A base ref with no baseline file passes** — that is the state on the commit introducing the file, which is this branch against `origin/master` today. Any **other** git failure is an error, not a pass: a ratchet that goes quiet whenever git is unhappy stops ratcheting the first time CI is misconfigured. The two are distinguished by matching git's "does not exist" / "exists on disk" wording rather than by treating every non-zero exit alike.

## Task Commits

All three tasks landed in `05d5418`. Both RED states were observed first — each test file failed on the unresolved import before its script existed.

## Files Created/Modified

- `scripts/coverage-gate.mjs` + `.d.mts` — `checkCoverageGate(summary, baseline)` and the CLI
- `scripts/coverage-ratchet.mjs` + `.d.mts` — `checkRatchet(current, base)` and the CLI
- `packages/test-support/src/__tests__/coverage-gate.test.ts` — 6 cases
- `packages/test-support/src/__tests__/coverage-ratchet.test.ts` — 5 cases
- `package.json` — `coverage:gate`, `coverage:ratchet`

## Decisions Made

- **Pure functions take parsed objects, not paths.** That is what lets the unit tests drive them with in-memory fixtures and no temp files, and it keeps the CLI half a thin shell around a testable core — the same shape `scripts/check-lint-file-floor.mjs` established in 08-03.
- **The base ref is an argument with a default.** A branch targeting something other than `origin/master` can pass its own without editing the script.
- **Both scripts print on the pass path.** The numbers are the point; a silent green tells you nothing about how close you are.

## Deviations from Plan

### 1. [Rule 2 — Missing Critical] Both scripts needed `.d.mts` declarations

Not in the plan's `files_modified`, but required: the type-checked test files import the `.mjs` modules, and `npm run build --workspaces` — which **is** the typecheck (D-04) — fails with `TS7016` without them. The same requirement 08-06 discovered for `lint-migrations.mjs` and `check-lint-file-floor.mjs`, and their declaration files say so explicitly. Caught by running the typecheck rather than by the unit tests, which pass either way.

### 2. [Rule 1 — Bug, in own work] An acceptance grep tripped on my own comment

`grep -cE "tolerance|epsilon|0\.00[0-9]"` on the ratchet must return 0. My header comment explained that there deliberately **is** no such band — and named it to do so. Reworded to "permitting a margin would be a smaller version of the same loophole". Third time this class of thing has come up in this phase (08-07's async register, 08-12's two greps); the checks are prose-sensitive by design, and prose counts.

---

**Total deviations:** 1 missing-critical, 1 auto-fixed.
**Impact on plan:** No scope change. Two files beyond `files_modified`, both required by the repo's own typecheck.

## Issues Encountered

None. Both scripts behaved as specified on first implementation; the only corrections were the declaration files and the comment wording.

Worth noting for 08-18: **`coverage:gate` will fail CI until 08-16 lands.** If the CI wiring is added before 08-16, the blocking job goes red for a reason that is correct but not actionable by whoever sees it first. Sequencing the two matters more than usual here.

## User Setup Required

None. Both scripts use Node built-ins only and read files the repo already produces.

## Next Phase Readiness

- **08-16 is what turns the gate green.** It needs to add roughly one percentage point of line coverage; `packages/kms` (45/60) and `packages/tenant-context` (22/24) are the named targets, and they are the highest-consequence untested code in the repository — tenant key encryption and the RLS session boundary.
- **08-18** should wire `coverage:gate` into the blocking job and `coverage:ratchet` into the PR job, and should not do so before 08-16. The ratchet needs `origin/master` fetched to compare against; on a shallow CI clone `git show origin/master:coverage-baseline.json` will fail as an error rather than pass silently, which is the correct behaviour but needs a full-enough fetch.
- **QG-03 is not yet marked complete** — 08-11 also declares it, and both are now done, so it closes on the next requirements sweep.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
