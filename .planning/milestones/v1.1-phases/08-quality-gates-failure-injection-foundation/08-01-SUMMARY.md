---
phase: 08-quality-gates-failure-injection-foundation
plan: 01
subsystem: testing
tags: [github-actions, vitest, ci, postgres, dsn-guard, branch-protection, tdd]

# Dependency graph
requires:
  - phase: 07
    provides: shipped v1.0 codebase — the 24-file apps/worker suite this tracer runs green
provides:
  - "@mega-crm/test-support workspace — the package every later Phase 8 plan extends"
  - "assertTestDatabaseUrl: fail-closed DSN guard with no bypass surface"
  - "vitest globalSetup wiring — the single point the guard runs before test collection"
  - ".github/workflows/ci.yml — job `test` on push and pull_request→master"
  - "Branch protection on master: `test` required, enforce_admins=true"
affects: [08-02, 08-03, 08-04, 08-05, 08-06, 08-09, 08-10, 08-11, 08-12, 08-13, 08-18]

# Tech tracking
tech-stack:
  added: ["@vitest/coverage-v8 (not yet — 08-11)", "execa 10.0.0 (declared, unused)", "ioredis 5.11.0 (declared, unused)", "pg 8.22.0", "GitHub Actions"]
  patterns:
    - "Fail-closed guard with deliberately no opt-out parameter and no env read"
    - "Actions pinned to full 40-char commit SHAs, tag in a trailing comment"
    - "npm run build --workspaces --if-present IS the typecheck (D-04) — no separate tsc pass"

key-files:
  created:
    - packages/test-support/package.json
    - packages/test-support/tsconfig.json
    - packages/test-support/vitest.config.ts
    - packages/test-support/src/guard.ts
    - packages/test-support/src/index.ts
    - packages/test-support/src/global-setup.ts
    - packages/test-support/src/__tests__/guard.test.ts
    - .github/workflows/ci.yml
    - .nvmrc
  modified:
    - apps/worker/vitest.config.ts
    - SPECIFICATION.md

key-decisions:
  - "D-03 amended: CI keeps `docker compose up -d --wait`; local verification targets native Homebrew Postgres/Redis, because Docker is not installed on the developer machine"
  - "Kept actions/setup-node at v4 as the plan specified despite a Node 20 deprecation annotation — flagged for 08-18 rather than deviating unilaterally"
  - "Throwaway PR forked from phase-08-quality-gates, not master, because a pull_request check runs the workflow from the PR head and master has no ci.yml yet"

patterns-established:
  - "RED-first: test committed separately and observed failing before implementation"
  - "Guard has no bypass surface — asserted by a source grep, not just by convention"

requirements-completed: [QG-01, QG-04]

coverage:
  - id: D1
    description: "Fail-closed DSN guard rejects unset, empty, identical, loopback-aliased and wrong-prefix test DSNs, and accepts a correctly provisioned one"
    requirement: QG-04
    verification:
      - kind: unit
        ref: "packages/test-support/src/__tests__/guard.test.ts (6 assertions)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Guard aborts a real vitest run before any test is collected when the test DSN is unusable"
    requirement: QG-04
    verification:
      - kind: integration
        ref: "TEST_DATABASE_URL=<dev dsn> npm run test -w apps/worker → exit 1, zero test-result lines"
        status: pass
      - kind: integration
        ref: "TEST_DATABASE_URL= npm run test -w apps/worker → exit 1, zero test-result lines"
        status: pass
    human_judgment: false
  - id: D3
    description: "Guard has no bypass surface — no opt-out parameter, no environment read"
    requirement: QG-04
    verification:
      - kind: other
        ref: "grep -E 'process\\.env\\.[A-Z_]+' packages/test-support/src/guard.ts | grep -v '^\\s*//' | wc -l → 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "CI job `test` runs on a real runner: live Postgres+Redis via docker compose, ephemeral DB, monorepo typecheck, worker suite"
    requirement: QG-01
    verification:
      - kind: e2e
        ref: "GitHub Actions run 30332518444 — all steps green, 24/24 files, 109/109 tests"
        status: pass
    human_judgment: false
  - id: D5
    description: "Branch protection actually blocks a red PR from merging and stops blocking when green"
    requirement: QG-01
    verification:
      - kind: manual_procedural
        ref: "PR #3: mergeStateStatus BLOCKED on test=FAILURE, CLEAN on test=SUCCESS; enforce_admins=true"
        status: pass
    human_judgment: true
    rationale: "Branch protection is a GitHub repository setting outside the repo tree — no in-repo test can assert it (08-VALIDATION.md § Manual-Only Verifications). Verified by a throwaway PR exercise and confirmed by the user-approved checkpoint."

# Metrics
duration: 22 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 01: Quality-Gate Tracer Summary

**One CI job proven end-to-end on a real runner — live Postgres/Redis, a fail-closed DSN guard that aborts before test collection, monorepo typecheck, the 109-test worker suite — plus branch protection demonstrated to block a red PR (`BLOCKED`) and release a green one (`CLEAN`).**

## Performance

- **Duration:** 22 min
- **Started:** 2026-07-28T05:31:00Z
- **Completed:** 2026-07-28T05:53:15Z
- **Tasks:** 3
- **Files modified:** 12

## Accomplishments

- **`@mega-crm/test-support` workspace** created as the skeleton every later Phase 8 plan extends — resolves as a workspace symlink, typechecks with the other 11 workspaces.
- **`assertTestDatabaseUrl`** implemented test-first: two independent conditions (`mega_crm_test` prefix, normalized host+port+database inequality) with loopback aliases collapsed and credentials/query params ignored. It takes no opt-out parameter and reads no environment variable — the absence of a bypass surface is asserted by a source grep, not left to convention.
- **Guard wired into `apps/worker` vitest `globalSetup`** — a DSN equal to the dev database or an empty one aborts with exit 1 and **zero tests collected**, verified for both cases.
- **`.github/workflows/ci.yml`** — job `test` on both `push` and `pull_request→master` (either alone silently defeats the gate), `docker compose up -d --wait` with no `sleep`, `npm run build --workspaces --if-present` as the typecheck, both actions pinned to full commit SHAs. **Run 30332518444 green.**
- **Branch protection verified for real**, not assumed: `enforce_admins=true`, required check `test`.

## Task Commits

1. **Task 1 (RED): failing guard test** — `2e2528b` (test)
2. **Task 1 (GREEN): guard + CI workflow** — `7f110ee` (feat)
3. **Task 2: SPECIFICATION.md** — `f1721f6` (docs)
4. **Task 3: branch-protection checkpoint** — no repo commit; GitHub settings change + throwaway PR #3 (closed, branch deleted)

## Files Created/Modified

- `packages/test-support/src/guard.ts` — `normalizeDsn` + `assertTestDatabaseUrl`, no bypass surface
- `packages/test-support/src/global-setup.ts` — vitest globalSetup; lets the error propagate so the run aborts
- `packages/test-support/src/__tests__/guard.test.ts` — the six SPEC R4 acceptance rows
- `packages/test-support/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}` — workspace scaffold
- `apps/worker/vitest.config.ts` — one `globalSetup` entry; `fileParallelism: false` and the `env` block untouched
- `.github/workflows/ci.yml` — the tracer CI job
- `.nvmrc` — `26`
- `SPECIFICATION.md` — §1.2, §1.3, §2.5, §8.2

## Decisions Made

- **D-03 amended to "same services and DSNs, different startup mechanism."** See Deviations.
- **`actions/setup-node` left at v4** despite a Node 20 deprecation annotation. The plan named v4 explicitly; 08-18 rewrites this workflow into four jobs and is the right place to bump to v5.
- **Throwaway PR forked from `phase-08-quality-gates`, not `master`.** A `pull_request` check runs the workflow from the PR head, and `master` has no `ci.yml` yet — a branch off `master` would have shown no checks at all and proved nothing.

## Deviations from Plan

### 1. [Rule 4 — Architectural, user-approved] D-03's local-execution premise does not hold on this machine

- **Found during:** Task 1 precondition check, before any file was written.
- **Issue:** D-03 locks `docker compose up -d --wait` as "the same command a developer runs locally, with no CI-only branch." Docker is **not installed** on this machine — no binary, no Docker.app, no OrbStack/colima/podman. The services run natively via Homebrew: **Postgres 17.10** and **Redis 8.8.0** (not `redis:7`), holding the real `mega_crm` dev database and the `mega_crm_app` role. There is also no `postgres` role locally, so the CI step's `psql -U postgres` has no local equivalent.
- **Resolution:** Stopped before editing and escalated per Rule 4. User approved amending D-03 to **"same services and DSNs, different startup mechanism."** CI keeps `docker compose` (verified working on `ubuntu-latest`); local verification targets the native services on the same ports and DSNs. The ephemeral `mega_crm_test_worker` database was created locally with `psql -U <local superuser>`.
- **Verification:** Worker suite green locally (24/24 files, 109/109) against the native Postgres, and green in CI against the compose services — both paths exercised.
- **Recorded in:** `SPECIFICATION.md` §1.3 under "Расхождение окружения (08-01)".
- **Carries forward:** **08-04 (WRK-12)** mounts `docker/redis.conf` into the compose `redis` service — a mount cannot affect Homebrew Redis, and local Redis is v8 not v7. **08-13** restarts the Redis *container*. Both need a local strategy decided when reached.

**Total deviations:** 1 architectural (escalated and user-approved; zero auto-fixed).
**Impact on plan:** No scope change. All plan artifacts were produced as written; only the *local* verification mechanism differs, and that difference is now recorded in SPECIFICATION.md.

## Issues Encountered

**Untested branch in the guard (carried to 08-02).** All three "throws" cases in `guard.test.ts` (identical DSN, loopback alias, wrong prefix) trip the **prefix** condition first, because `mega_crm` never starts with `mega_crm_test`. The **equality** condition is therefore never reached by any current test, despite being real and reachable — it fires when `DATABASE_URL` itself points at a `mega_crm_test*` database. Left at six tests here to honor this plan's acceptance criterion ("6 passing assertions"); **08-02 explicitly rewrites this file into a full `it.each` table over every SPEC R4 row and must add a case that reaches the equality branch.**

**Non-blocking CI annotation.** `actions/setup-node@v4` targets Node 20, which GitHub has deprecated and force-runs on Node 24. Not a failure. Bump to v5 in 08-18.

## User Setup Required

None — no external service configuration required. Branch protection was configured during Task 3 with the user's explicit approval.

## Next Phase Readiness

**Ready for 08-02.** The `packages/test-support` workspace, the guard, and the `globalSetup` hook all exist and are green; 08-02 extends the guard to the full four-row SPEC table and replaces the hand-named `mega_crm_test_worker` with per-run ephemeral provisioning.

**Carry-forward for the executor of 08-02:** add a test that reaches the equality branch (see Issues Encountered).

**Open risk for 08-04 and 08-13:** the Docker-dependent Redis work has no local execution path on this machine. Decide the approach when those plans are reached.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
