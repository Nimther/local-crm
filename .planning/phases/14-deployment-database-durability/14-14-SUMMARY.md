---
phase: 14-deployment-database-durability
plan: 14
subsystem: infra
tags: [npm, docker, ci, lockfile, esbuild, vite, github-actions, gap-closure]

requires:
  - phase: 14-deployment-database-durability
    provides: docker/Dockerfile.{api,worker,web} pinning node:22-slim (plan 14-06)
provides:
  - Additive-only package-lock.json regeneration accepted by both npm 10 and npm 11
  - scripts/check-lockfile-npm10.mjs recurrence guard, required-CI-blocking
  - images.yml pull_request build-only job (end-to-end evidence, non-blocking)
affects: [gsd-verify-work, phase-16-uat]

tech-stack:
  added: []
  patterns:
    - "Docker base-image tag read from source (not hand-typed) via a single documented NODE_TO_NPM_MAJOR table with fail-loud default, same class as scripts/print-stop-grace-period.mjs"
    - "Gate scripts (Node built-ins only, exported pure helpers + CLI subprocess exit-code tests, __fixtures__ hermetic fixtures) -- same class as lint-pg-pool-factory.mjs / lint-session-state.mjs"

key-files:
  created:
    - scripts/check-lockfile-npm10.mjs
    - scripts/__tests__/check-lockfile-npm10.test.mjs
    - scripts/__fixtures__/lockfile-npm10/clean/
    - scripts/__fixtures__/lockfile-npm10/desynced/
    - scripts/__fixtures__/lockfile-npm10/tag-mismatch/
  modified:
    - package-lock.json
    - package.json
    - .github/workflows/ci.yml
    - .github/workflows/images.yml
    - SPECIFICATION.md

key-decisions:
  - "Desynced/clean fixtures use a fully-specified left-pad lockfile entry (real resolved+integrity from the public registry) rather than a genuinely-missing top-level dependency, because npm ci --dry-run hits the network to resolve a dependency with zero prior lockfile representation -- violating the plan's hermetic-test requirement. A dependency already present in packages[\"\"].dependencies but absent from the node_modules/<pkg> entry reproduces the exact 'Missing: X from lock file' EUSAGE class purely from local reads, matching the real esbuild bug's shape."
  - "resolveNodeMajorFromDockerfiles returns { tag, major } (not a bare major) so plan-printing mode can report both the tag and the derived npm major without a second Dockerfile read."

requirements-completed: [OPS-01]

coverage:
  - id: D1
    description: "package-lock.json regenerated under npm 10, additive-only (27 esbuild-family entries), accepted by both npm 10 and npm 11"
    requirement: "OPS-01"
    verification:
      - kind: other
        ref: "npx --yes npm@10 ci --dry-run (exit 0) + npm ci --dry-run under npm 11.12.1 (exit 0) + Task 1's additive-only assertion script"
        status: pass
    human_judgment: false
  - id: D2
    description: "scripts/check-lockfile-npm10.mjs recurrence guard, wired into the required static CI job"
    requirement: "OPS-01"
    verification:
      - kind: unit
        ref: "scripts/__tests__/check-lockfile-npm10.test.mjs (11 tests, all pass)"
        status: pass
      - kind: other
        ref: "npm run check:lockfile-npm10 against the real repo root"
        status: pass
    human_judgment: false
  - id: D3
    description: "images.yml builds all three images on pull_request without pushing (build-only job, no GHCR auth)"
    verification:
      - kind: other
        ref: "grep-based structural verify (pull_request trigger, push: false, event-name guard, job-level permissions, SHA-pinned actions) -- all pass"
        status: pass
    human_judgment: true
    rationale: "The end-to-end acceptance half of G-14-4 requires a real Docker daemon, which this executor sandbox does not have. Deferred to end-of-phase human verification per the plan's own <human-check> -- see 'Human Acceptance Evidence' section below."

duration: 40min
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 14: G-14-4 Gap Closure Summary

**Regenerated package-lock.json under npm 10 (additive-only, 27 esbuild entries), added a fail-loud recurrence guard inside the required `static` CI job, and split `images.yml` into a push-only publish job plus a pull_request build-only job -- closing the root cause of G-14-4 (Docker `npm ci` EUSAGE) and making it unable to silently return.**

## Performance

- **Duration:** ~40 min
- **Tasks:** 3 (Task 2 is TDD: RED then GREEN)
- **Files modified:** 8 (package-lock.json, package.json, .github/workflows/ci.yml, .github/workflows/images.yml, SPECIFICATION.md, scripts/check-lockfile-npm10.mjs + its test + 3 fixture directories)

## Accomplishments

- **Task 1:** Regenerated `package-lock.json` via `npx --yes npm@10 install --package-lock-only --ignore-scripts` (resolved npm **10.9.9**). Diff is purely additive: **27 esbuild-family entries** -- `node_modules/vitest/node_modules/esbuild@0.28.2` plus its 26 `@esbuild/<platform>` siblings -- every one integrity-hashed from `registry.npmjs.org`. Zero removals, zero version changes to any existing package, no `package.json` touched in any of the 15 workspaces. `npx --yes npm@10 ci --dry-run` now exits **0** (was EUSAGE, 27 `Missing:` lines, all esbuild-family). `npm ci --dry-run` under this repo's own npm **11.12.1** (Node 26 per `.nvmrc`) still exits **0** -- confirmed again after `npm ci` actually installed `node_modules` from the regenerated lockfile with no errors.
- **Task 2 (TDD):** `scripts/check-lockfile-npm10.mjs` -- reads the `FROM node:<tag>` pin out of all three `docker/Dockerfile.{api,worker,web}`, requires them to agree (refuses to guess on disagreement, naming both conflicting tags), maps the resulting Node major to its bundled npm major through one documented `NODE_TO_NPM_MAJOR` table (fail-loud, instructive error for an unmapped major), then runs `ci --dry-run` under that npm major and propagates its exit code, printing the resolved npm version and a remediation line on failure. RED commit (`734e36a`) had 0 passing tests (module didn't exist); GREEN commit (`a12efb2`) has **11/11 tests passing**. Wired into `package.json` (`check:lockfile-npm10`) and into the `static` job of `.github/workflows/ci.yml` (a required status check) immediately after the pool-factory audit step.
- **Task 3:** `.github/workflows/images.yml` now triggers on `pull_request` (branches: master) in addition to `push`. Split into `build-and-push` (unchanged except `if: github.event_name == 'push'`) and a new `build-only` job (job-level `permissions: contents: read` overriding the workflow-level `packages: write`, no login step, `push: false`, GHA buildx cache both directions). Header comment amended to explain the split and that this workflow is deliberately not a required status check -- the blocking guarantee is Task 2's guard inside `static`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Regenerate package-lock.json under npm 10, additive-only** - `1b0374d` (fix)
2. **Task 2 RED: failing test for npm-10 lockfile guard** - `734e36a` (test)
2. **Task 2 GREEN: implement the guard, wire into static CI job** - `a12efb2` (feat)
3. **Task 3: build all three images on pull_request without pushing** - `56f1e89` (feat)

_No REFACTOR commit -- the GREEN-phase implementation needed no follow-up cleanup._

**Plan metadata:** committed together with this SUMMARY.md (see below).

## Files Created/Modified

- `package-lock.json` - Regenerated under npm 10.9.9; 27 additive esbuild-family entries
- `scripts/check-lockfile-npm10.mjs` - The recurrence guard (Node built-ins only)
- `scripts/__tests__/check-lockfile-npm10.test.mjs` - 11 tests: pure-helper edge cases + CLI subprocess exit-code behavior
- `scripts/__fixtures__/lockfile-npm10/clean/` - Dockerfiles agreeing on node:22-slim + a fully-specified matching lockfile
- `scripts/__fixtures__/lockfile-npm10/desynced/` - Same Dockerfiles + a lockfile missing the declared dependency's `node_modules/` entry
- `scripts/__fixtures__/lockfile-npm10/tag-mismatch/` - Dockerfiles disagreeing on node major (22-slim vs 20-slim)
- `package.json` - Added `check:lockfile-npm10` script
- `.github/workflows/ci.yml` - Added "npm-10 lockfile guard" step to the `static` job
- `.github/workflows/images.yml` - Added `pull_request` trigger + `build-only` job (build-without-push, GHA cache)
- `SPECIFICATION.md` - `static` CI-table row, dev/CI-only npm-script inventory, images.yml sentence (all three per CLAUDE.md's same-change filing rule)

## Decisions Made

- **Hermetic fixture shape for the "desynced" test case:** a genuinely-absent top-level dependency (declared in `package.json` but never seen anywhere in the lockfile) makes `npm ci --dry-run` hit the public registry to resolve it -- confirmed empirically (a 404 network call), which would violate the plan's "no network" hermeticity requirement for the fixture tests. Instead, both `clean` and `desynced` fixtures declare `left-pad@^1.3.0` in the lockfile's root `packages[""].dependencies` (so npm knows the exact expected version, `1.3.0`, without consulting the network); `clean` also carries a real `node_modules/left-pad` entry (resolved+integrity), `desynced` omits it. This reproduces the exact `EUSAGE: Missing: left-pad@1.3.0 from lock file` class the real esbuild bug produced, entirely from local reads -- verified offline before writing the fixtures into the plan.
- **`resolveNodeMajorFromDockerfiles` returns `{ tag, major }`** rather than a bare integer, so the `--plan` printing mode can report both values without a second Dockerfile read.

## Deviations from Plan

None - plan executed exactly as written, including its TDD gate for Task 2 (RED commit had zero passing tests; GREEN made all 11 pass).

## Issues Encountered

None.

## Human Acceptance Evidence (deferred, per Task 3's own `<human-check>`)

**A real `docker build` was NOT performed by this executor** -- the worktree sandbox has no Docker daemon, exactly as Task 3's `<human-check>` anticipated. This is not an in-plan checkpoint (the plan is `autonomous: true`); it is explicitly the end-of-phase evidence `/gsd-verify-work` reconciles G-14-4 against. All of this plan's automated evidence is in place and passing:

- `npx --yes npm@10 ci --dry-run` exits 0 (Task 1)
- `npm ci --dry-run` under this repo's own npm 11.12.1 exits 0, and `npm ci` (non-dry-run) actually installed `node_modules` cleanly from the regenerated lockfile (Task 1)
- `npm run check:lockfile-npm10` exits 0 against this tree (Task 2)
- `npx vitest run --root scripts __tests__/check-lockfile-npm10.test.mjs` -- 11/11 pass (Task 2)
- `npm run lint` and `npm run build --workspaces --if-present` both pass with the new script in the tree
- `images.yml`'s structural verify (pull_request trigger present, `push: false` present, `build-and-push` guarded to `github.event_name == 'push'`, two `contents: read` grants, all actions remain SHA-pinned with no floating `@vN` introduced) all pass

**Outstanding at end-of-phase, per the plan's own `<human-check>`:** at least one of the following must still happen before G-14-4 is fully closed:
1. Locally, from a clean checkout: `docker build -f docker/Dockerfile.api -t megacrm-api:local .` (then `.worker`, `.web`) all complete -- re-runs UAT test 4, unblocks UAT test 5.
2. On the pull request for this branch: the Images workflow's `build-only` jobs (api, web, worker) all finish green with no image pushed to GHCR.

Neither route was exercised by this executor; both remain available to the operator or to CI once this branch reaches a pull request.

## Next Phase Readiness

- G-14-4's diagnosed root cause is fixed and cannot silently regress: a future `npm install` under this repo's own npm 11 that drops the npm-10-required entries fails `check:lockfile-npm10` inside `static`, a required status check, before merge.
- Docker builds are unblocked from the lockfile side; the remaining Docker-daemon-dependent acceptance step (UAT test 4 re-run, UAT test 5 unblock) is ready for the operator or for the Images PR run once this branch opens a pull request.
- No Dockerfile `node:22-slim` pin and no `.nvmrc` value was touched, per the plan's explicit constraint.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
