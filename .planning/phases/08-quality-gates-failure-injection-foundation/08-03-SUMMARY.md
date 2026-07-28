---
phase: 08-quality-gates-failure-injection-foundation
plan: 03
subsystem: infra
tags: [eslint, typescript-eslint, lint, flat-config, vitest, react-hooks]

requires:
  - phase: 08-01
    provides: "@mega-crm/test-support workspace hosting the lint-gate assertions"
provides:
  - "eslint.config.js — ESLint 10 flat config, 8 blocks, type-aware tier"
  - "Root scripts: lint (--max-warnings=0), lint:floor"
  - "lint-file-floor.json + scripts/check-lint-file-floor.mjs"
  - "tools/lint-fixtures/ — two deliberate violations as tracked evidence"
affects: [08-07, 08-18]

tech-stack:
  added:
    - "eslint ^10.8.0"
    - "typescript-eslint ^8.65.0"
    - "@vitest/eslint-plugin ^1.6.24"
    - "eslint-plugin-react-hooks ^7.1.1"
    - "eslint-plugin-no-only-tests ^3.4.0"
    - "eslint-plugin-import-x ^4.17.1 (fork — see Deviations)"
  patterns:
    - "Type-aware tier scoped to */src/** because every tsconfig declares include:['src']"
    - "Deliberate fixtures ignored tree-wide but checked with --no-ignore"

key-files:
  created:
    - eslint.config.js
    - lint-file-floor.json
    - scripts/check-lint-file-floor.mjs
    - tools/lint-fixtures/floating-promise.ts
    - tools/lint-fixtures/focused-test.test.ts
    - packages/test-support/src/__tests__/lint-gate.test.ts
  modified:
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "eslint-plugin-import-x replaces eslint-plugin-import — the latter has no ESLint 10 release (user-approved)"
  - "Playwright specs added to the non-type-aware block; without it they fail fatally on the first type annotation"
  - "Block 2b gives fixtures the type-aware tier via projectService.allowDefaultProject"
  - "Floor set to 390 = measured 396 rounded down to the nearest 10"

patterns-established:
  - "Prove a gate fails before it is ever seen to pass"

requirements-completed: [QG-02]

coverage:
  - id: D1
    description: "A single violation of an enabled type-aware rule makes eslint exit 1"
    requirement: QG-02
    verification:
      - kind: integration
        ref: "lint-gate.test.ts — floating-promise fixture → exit 1, @typescript-eslint/no-floating-promises"
        status: pass
    human_judgment: false
  - id: D2
    description: "A forgotten .only is a lint error and cannot be auto-erased by --fix"
    requirement: QG-02
    verification:
      - kind: integration
        ref: "lint-gate.test.ts — focused-test fixture → exit 1; byte-identical after --fix"
        status: pass
    human_judgment: false
  - id: D3
    description: "An ignores-glob typo that collapses the checked-file count fails the gate"
    requirement: QG-02
    verification:
      - kind: unit
        ref: "lint-gate.test.ts — checkLintFileFloor: equal/above/one-below/empty"
        status: pass
      - kind: other
        ref: "node scripts/check-lint-file-floor.mjs with an empty report → exit 1"
        status: pass
    human_judgment: false
  - id: D4
    description: "No source file hides behind an unnamed blanket eslint-disable"
    requirement: QG-02
    verification:
      - kind: unit
        ref: "lint-gate.test.ts — scan of every tracked .ts/.tsx/.mjs/.js file, zero matches"
        status: pass
    human_judgment: false
  - id: D5
    description: "Type-aware rules are active across the monorepo without parser errors"
    requirement: QG-02
    verification:
      - kind: other
        ref: "eslint --format json . → 398 files, 0 fatal, 536 violations incl. 16 no-floating-promises / 35 no-misused-promises / 36 require-await"
        status: pass
    human_judgment: false

duration: 14 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 03: Lint Gate Summary

**An ESLint 10 flat config whose type-aware tier surfaces exactly the async bug class the audit found — 16 floating promises, 35 misused promises, 36 needless `async` — proven to fail on a single violation, proven not to auto-erase a forgotten `.only`, and floored so an ignores typo can't make it pass vacuously.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-07-28T06:16:00Z
- **Completed:** 2026-07-28T06:30:00Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments

- **Type-aware tier live across 398 files with zero parser errors.** The Pitfall 2 trap is real and was hit: scoping matters because every `tsconfig.json` here declares `include: ["src"]`.
- **536 violations surfaced** (522 error / 14 warning) — *not* fixed here; that is 08-07's job by design.
- **The gate is proven to fail first.** Two fixtures, each exiting 1 on a different enabled rule.
- **`.only` cannot be silently erased.** `vitest/no-focused-tests` is non-fixable; `eslint --fix` leaves the file byte-identical, asserted with a real byte comparison on a temp copy.
- **The "checked 0 files, exited 0" hole is closed** by a version-controlled floor carrying its own provenance.
- **No blanket suppressions anywhere** — a scan of every tracked source file finds zero unnamed `/* eslint-disable */`.

## Task Commits

1. **Task 1: flat config + tooling** — `2013926` (feat)
2. **Tasks 2 & 3: fixtures, floor, assertions** — `88e4f9e` (feat)

## Measured baseline (for 08-07)

| Metric | Value |
|---|---|
| Files checked | 398 |
| Total violations | 536 |
| Errors / warnings | 522 / 14 |
| Top rule | `no-unsafe-member-access` (165) |
| Next | `no-unnecessary-type-assertion` (152), `no-unsafe-assignment` (49), `require-await` (36), `no-misused-promises` (35) |

## Deviations from Plan

### 1. [Rule 3 — Blocker, user-approved] `eslint-plugin-import` has no ESLint 10 release

- **Found during:** Task 1, at install.
- **Issue:** `eslint-plugin-import@2.32.0` is the latest release and declares `peerDependencies.eslint: "^2 || … || ^9"`. It cannot install alongside ESLint 10; `npm install` aborted with ERESOLVE.
- **Resolution:** Escalated with three alternatives (fork / downgrade ESLint to 9 / drop the plugin). User approved **`eslint-plugin-import-x@4.17.1`** — the maintained fork (5.7M downloads/week, MIT, `un-ts`, peers `^8.57 || ^9 || ^10`), providing the same rule as `import-x/no-extraneous-dependencies`. The plan enables exactly one rule from this plugin, so the surface swapped is minimal.
- **Recorded in:** `SPECIFICATION.md` §2.1 and §8.2, and inline in `eslint.config.js` Block 7.

### 2. [Rule 3 — Blocker] Playwright specs failed fatally under the default parser

- **Found during:** Task 1's first full run.
- **Issue:** `apps/web/e2e/*.spec.ts` matched no block that sets the TS parser, so ESLint parsed them as plain JS and emitted 2 **fatal** parser errors (`Unexpected token Page`) — which the acceptance criteria forbid. They sit outside every tsconfig `include: ["src"]`, so the type-aware tier cannot take them either.
- **Fix:** Added `apps/web/e2e/**/*.spec.ts` to the non-type-aware Block 3.
- **Verification:** 0 fatal messages in the JSON report.

### 3. [Rule 1 — Bug] The floating-promise fixture initially proved nothing

- **Found during:** Task 2.
- **Issue:** `eslint --no-ignore tools/lint-fixtures/floating-promise.ts` exited **0**. The fixture sat outside Block 2's `*/src/**` globs, so no type-aware rule applied — a fail-first fixture that does not fail.
- **Fix:** Added Block 2b scoping the type-aware tier to `tools/lint-fixtures/**/*.ts` with `projectService.allowDefaultProject`, typescript-eslint's documented escape hatch for stray files (the plan's own "add a dedicated block for it" option).
- **Verification:** now exits 1 with `@typescript-eslint/no-floating-promises`, while the tree-wide run still reports zero fixture files.

**Total deviations:** 3 (2 blockers, 1 bug). One escalated to the user; two auto-fixed within plan scope.

## Issues Encountered

**Two acceptance criteria matched my own comments rather than config** — `projectService` (2 hits) and `import/order|jsx-a11y` (1 hit) both came from explanatory prose, not enabled rules. I reworded the comments to preserve the meaning without the literal tokens, so the checks measure configuration rather than prose and stay trustworthy for whoever runs them next.

**Removed an unrequested import.** My first draft pulled in `@eslint/js`, which is not a direct dependency and broke config loading. The plan's block structure never called for it; dropped.

**Noisy Node warning.** `MODULE_TYPELESS_PACKAGE_JSON` fires on every run because `eslint.config.js` is ESM while root `package.json` has no `"type": "module"`. Cosmetic and perf-only. Renaming to `.mjs` would fix it but the plan names `eslint.config.js` and the acceptance criteria grep that path; left alone deliberately.

## User Setup Required

None.

## Next Phase Readiness

**08-07 is unblocked and has its target: 536 violations → 0.** The baseline table above is the burn-down list. 08-18 wires `lint`, `lint:floor` and `lint:migrations` into CI's `static` job.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
