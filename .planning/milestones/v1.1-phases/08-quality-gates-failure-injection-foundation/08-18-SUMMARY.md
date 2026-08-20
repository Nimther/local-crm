---
phase: 08-quality-gates-failure-injection-foundation
plan: 18
subsystem: ci
tags: [ci, github-actions, branch-protection, coverage-gate, e2e-isolation, playwright]

requires:
  - phase: 08-03
    provides: the lint gate and the file-count floor the static job runs
  - phase: 08-07
    provides: a lint-clean tree, without which the static job could never be green
  - phase: 08-09
    provides: the migration-chain tests the aggregate runs
  - phase: 08-10
    provides: the E2E provisioning this plan had to repair before it could be wired in
  - phase: 08-12
    provides: the SIGKILL scenario the failure-injection job runs
  - phase: 08-13
    provides: the redis-restart scenario, and the redis-server dependency the jobs install
  - phase: 08-14
    provides: the coverage gate and ratchet the test job enforces
  - phase: 08-15
    provides: the root-hygiene check the static job runs
  - phase: 08-16
    provides: a green coverage gate, without which the test job could not pass
provides:
  - Four CI jobs — static, test, failure-injection, e2e — running on every push and pull request
  - Required-status-check set on master, with administrator bypass disabled
  - The branch-per-phase model with the pull request as the merge point
  - A repaired E2E lane whose server genuinely runs against the ephemeral database
affects: [phase-09-partitions, phase-10-rls-unification, phase-11-delivery-state-machine, phase-14-deployment]

tech-stack:
  added: []
  patterns:
    - "A gate is not proven until it has run in the environment that will enforce it"
    - "A DSN the server must use is passed to it by name, never left to be inherited"

key-files:
  created:
    - apps/web/e2e/provision-database.ts
    - apps/web/e2e/database-isolation.spec.ts
  modified:
    - .github/workflows/ci.yml
    - .planning/config.json
    - SPECIFICATION.md
    - apps/api/vitest.config.ts
    - apps/web/playwright.config.ts
    - apps/web/e2e/global-teardown.ts
    - scripts/check-lint-file-floor.mjs
    - package.json
  deleted:
    - apps/web/e2e/global-setup.ts

key-decisions:
  - "Four jobs rather than one, split on whether a live service is needed — lint and typecheck report in about ninety seconds instead of behind the Postgres corpus"
  - "Five separate failure steps, not the aggregate script, so a failure names its scenario and none can pass on a sibling's side effects"
  - "e2e excluded from the required set and carrying continue-on-error; its machine-checkable value is the connection-string assertion, which still runs"
  - "redis-server installed BEFORE docker compose in both service jobs — the package's own service binds 6379, which compose then cannot"
  - "E2E provisioning moved from globalSetup to playwright.config.ts module scope, because globalSetup runs after the webServer starts"
  - "required_pull_request_reviews set to an object with zero approvals rather than null — null removes the pull-request requirement entirely, leaving direct pushes to master possible"

patterns-established:
  - "A gate wired into CI is re-proven in CI, in both directions, before the plan is called done"

requirements-completed: [QG-01, QG-02, QG-03, QG-04, QG-05, QG-06, QG-07, DB-08]

coverage:
  - id: D1
    description: "Four jobs exist with the required ids, every invoked npm script exists, every action pinned to a full SHA, no sleep"
    requirement: QG-01
    verification:
      - kind: unit
        ref: "the plan's verify command — 8 actions pinned of 8, four jobs matched, thirteen scripts resolved"
        status: pass
    human_judgment: false
  - id: D2
    description: "All four jobs run green on a real push, with per-job durations recorded"
    requirement: QG-01
    verification:
      - kind: integration
        ref: "run 30370528082 — static 1m35s, test 2m22s, failure-injection 54s, e2e 1m44s, all success"
        status: pass
    human_judgment: false
  - id: D3
    description: "Branch protection requires exactly static, test and failure-injection with administrator enforcement on and no bypass"
    requirement: QG-01
    verification:
      - kind: manual_procedural
        ref: "protection API read-back — contexts [test, static, failure-injection], strict true, enforce_admins true, pr_required true with 0 approvals, bypass_allowances none, force_pushes false, deletions false"
        status: pass
    human_judgment: false
  - id: D4
    description: "A pull request carrying a failing test, a type error and a lint violation cannot be merged"
    requirement: QG-01
    verification:
      - kind: integration
        ref: "PR #4, run 30371388026 — static failed at Typecheck, test at Test with coverage, failure-injection at the 429 step; mergeStateStatus BLOCKED"
        status: pass
      - kind: integration
        ref: "same branch reverted, commit 40796fef — three required checks green, mergeStateStatus UNSTABLE (mergeable), not BLOCKED"
        status: pass
    human_judgment: false
  - id: D5
    description: "A coverage drop below the recorded threshold blocks the pull request"
    requirement: QG-03
    verification:
      - kind: integration
        ref: "run 30372310051 — coverage:gate 3494/4536 = 0.7702821869488536 vs threshold 0.8125751072961374, test job failed at the Coverage gate step, PR BLOCKED while static and failure-injection stayed green"
        status: pass
    human_judgment: false
  - id: D6
    description: "The e2e job runs without blocking the merge"
    requirement: QG-04
    verification:
      - kind: integration
        ref: "final PR state — static, test, failure-injection green, e2e FAILED, mergeStateStatus UNSTABLE and mergeable"
        status: pass
    human_judgment: false
  - id: D7
    description: "The E2E lane's server runs against the ephemeral database, not the developer's"
    requirement: QG-04
    verification:
      - kind: integration
        ref: "database-isolation.spec.ts — RED with the server pointed at the dev database (Expected \"1\", Received \"0\"); GREEN with the fix, 8 specs pass, dev user count identical before and after, ephemeral database dropped"
        status: pass
    human_judgment: false
  - id: D8
    description: ".planning/config.json is on the phase-branch model with no other key changed"
    requirement: QG-01
    verification:
      - kind: unit
        ref: "gsd-tools query init.execute-phase reports branching_strategy: phase; git diff is the single line"
        status: pass
    human_judgment: false

duration: 106 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 18: Four CI Jobs and the Required-Check Set Summary

**Every gate this phase built is now unavoidable — and wiring them in found that four of them had never actually run, including one that had been writing test data into the development database since the E2E suite was born.**

## Performance

- **Duration:** 106 min
- **Tasks:** 3 (two automated, one blocking operator checkpoint)
- **Files modified:** 11 (2 created, 8 modified, 1 deleted)

## The workflow

| Job | Duration | Required | What it runs |
|---|---:|---|---|
| `static` | 1m35s | ✅ | build (the typecheck), lint, lint floor, migration linter, root hygiene |
| `test` | 2m22s | ✅ | Redis config verification, the aggregated corpus with coverage, gate, ratchet |
| `failure-injection` | 54s | ✅ | the five audit-named scenarios, as five separate steps |
| `e2e` | 1m44s | ❌ | Playwright, then the `[e2e:database]` connection-string assertion |

Run `30370528082`, all four green. Eight action references, eight pinned to full commit SHAs. No `sleep` anywhere — service readiness comes from the compose healthchecks via `--wait`.

## The checkpoint, proven in four directions

Branch protection reads back as `contexts: [test, static, failure-injection]`, `strict: true`, `enforce_admins: true`, pull request required at zero approvals, **no bypass allowances**, force pushes and deletions denied.

| Demonstration | Evidence | `mergeStateStatus` |
|---|---|---|
| Three deliberate breaks | `static` red at Typecheck, `test` red at the corpus, `failure-injection` red at the 429 step | **BLOCKED** |
| Breaks reverted | three required checks green on `40796fef` | UNSTABLE — mergeable |
| Coverage below threshold | `coverage:gate` 3494/4536 = 0.77028 vs 0.81258; `static` and `failure-injection` stayed green | **BLOCKED** |
| `e2e` red, rest green | final state of the PR | UNSTABLE — mergeable |

The last row is the cleanest possible evidence for the design decision, and it arrived unprompted: on commit `40796fef` the **same** `e2e` job failed in the push run and passed in the pull-request run. A flaky browser lane demonstrated both that it is genuinely flaky and that excluding it from the required set is what keeps that flakiness out of the merge path.

PR #4 was closed without merging (`mergedAt: null`), the branch deleted, `master` untouched at `3cbc913`.

## Four gates that had never run

This plan is the first to execute these commands in the environment that enforces them, and that is the whole reason they were wired in.

**`npm run lint:floor` was not a runnable command.** 08-03 defined it as a bare `node scripts/check-lint-file-floor.mjs` and every verification since fed it a report path explicitly. Invoked the way CI invokes it, it read empty stdin and died on `JSON.parse`. It now pipes ESLint itself — one command, identical locally and in CI — and an unparseable report says so instead of printing a stack trace, because "ESLint produced no output" **is** the vacuous success this gate exists to catch.

**`apps/api`'s test lane never supplied three boot-required variables.** `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` and `WEB_URL` came from the developer's own configuration file. The tracer CI job ran `-w apps/worker` only, so the API suite had simply never run anywhere but a machine that happened to have them.

**`redis-server` collided with the Redis container over port 6379.** Installing the package starts a system service on the port compose publishes. Fixed by installing first, disabling the service, then bringing compose up.

**`tee` without `pipefail`.** The default runner shell is `bash -e` without `pipefail`, so a failing Playwright run piped into `tee` would have reported tee's exit code and passed green on a completely red suite. `shell: bash` turns it on — visible in the run log as `bash --noprofile --norc -e -o pipefail`.

## The E2E lane was never isolated

The first CI run failed with `relation "user" does not exist`, and the cause was not CI.

Playwright builds its startup tasks in this order (`playwright/lib/runner/index.js`):

```js
createGlobalSetupTasks(config) {
  return [
    createRemoveOutputDirsTask(),
    ...createPluginSetupTasks(config),   // the webServer starts HERE
    ...config.globalTeardowns...,
    ...config.globalSetups.map(...)      // globalSetup only NOW
  ];
}
```

**`globalSetup` runs after the servers it was meant to redirect.** 08-10 provisioned a database, guarded it, migrated it, printed it — and the API had already read `DATABASE_URL` and connected elsewhere. On a developer machine "elsewhere" is the dev database, which has the schema, so all specs passed and the isolation looked real. In CI the dev DSN names an empty database, and the first query failed.

The evidence, gathered before changing anything: **79 of the 88 rows in the development `user` table** were `owner-<timestamp>@example.com` fixtures, the newest written by the run that verified 08-10 that same morning.

Provisioning moved to `e2e/provision-database.ts`, imported and awaited at `playwright.config.ts` module scope — evaluated before every startup task — and the DSN is now passed to the server **by name** rather than inherited, so no ordering assumption survives. A re-entry guard stops worker processes re-loading the config from each provisioning a database of their own.

`database-isolation.spec.ts` is the assertion whose absence let this live: it registers through the real UI, then opens its own connection to the ephemeral database and requires the row to be there. Everything 08-10 checked was on the provisioning side; **where the server wrote was checked by nothing**.

Proven both ways. RED, with the server pointed at the dev database: `Expected "1", Received "0"`. GREEN: 8 specs pass, the dev user count is identical before and after the run, and the ephemeral database is dropped.

## Task Commits

1. **Task 1: the workflow** — `e25bdc9`
2. **Task 2: branching model + as-built CI surface** — `8a813c5`
3. **CI-found fixes** — `fc274c7` (api env + redis-server), `c2483ed` (E2E isolation), `deceb79` (spec)

## Decisions Made

- **`required_pull_request_reviews` is an object with zero approvals, not `null`.** The plan's payload used `null`, which removes the pull-request requirement altogether — status checks would still apply but a direct push to `master` would remain possible. Corrected by the operator before the payload was applied. This is the one place where following the plan literally would have left a hole in the thing the plan exists to close.
- **The `test` job also installs `redis-server`.** The aggregate includes the worker's redis-restart scenario. Excluding those tests from the aggregate was the alternative, and it would have changed the coverage denominator the baseline was measured against.
- **`fetch-depth: 0` on the `test` checkout**, because the ratchet resolves `git show origin/master:coverage-baseline.json` and correctly treats an unreadable ref as an error rather than a pass.
- **`verify:redis-config` stays in the `test` job** although the plan's step list omitted it. It is the only place the container path for `docker/redis.conf` — the `command:` override plus the read-only mount — is exercised at all.

## Deviations from Plan

### 1. [Rule 4 — Architectural, user-approved] The E2E isolation defect

Described above. Surfaced with the evidence rather than fixed silently, because it changes a completed plan's design. The user chose to fix it inside 08-18 rather than defer it to a gap-closure plan.

### 2. [Rule 1 — Bug, in prior work] Three gates that could not run as CI invokes them

`lint:floor`, the three missing `apps/api` variables, and the 6379 collision. Fixed in place; each is recorded in `SPECIFICATION.md` with why it survived.

### 3. [Rule 1 — Bug, in own work] The acceptance grep tripped on my own comment

A comment explaining why the aggregate script is *not* used contained its name, and the plan's own criterion is that the name not appear in the workflow. Reworded. This is the fifth time this phase that a prose-sensitive check has caught its own explanation.

### 4. [Rule 1 — Bug, in own work] The first coverage ballast was too small

One-line `if/else` pairs collapsed under v8: 26 lines of source counted as 27, moving the denominator 4264 → 4291 and leaving the gate green at 0.81426. Rewritten one statement per line, reaching 4536 and 0.77028.

### 5. [Rule 1 — Process, in own work] A count reported under RLS

The cascade scope for the dev-database cleanup was first counted as the `mega_crm_app` role with no tenant in scope, which returned zero contacts and zero segments. Those zeros were filtered by the very policies this project relies on. Re-counted as superuser: 22 contacts, 34 segments. Reported as a correction before acting on it — the same vacuous-zero class this phase exists to eliminate, arrived at from the other side.

---

**Total deviations:** 1 architectural (surfaced with evidence, decided by the user), 4 auto-fixed.
**Impact on plan:** `files_modified` expanded by six files, all of them required to make the plan's own acceptance criteria reachable.

## Issues Encountered

- **The `e2e` lane is genuinely flaky.** `segments-behavior.spec.ts:146` (SEGM-04) failed on one run of commit `40796fef` and passed on another run of the same commit, waiting on a live count still showing `—`. This is why the job is not a required check, and it is now demonstrated rather than assumed. Worth a timing fix on its own merits.
- **Playwright traces are not uploaded.** `trace: retain-on-failure` produces them inside the job and `actions/upload-artifact` is not wired, so a CI failure leaves nothing to inspect. Recorded in `SPECIFICATION.md` § 7.
- **Five accounts in the dev database were left alone** — `invitee-*`, `verify-e2e-*`, `verify-test-*`. They do not match the proven E2E artifact pattern and their origin has not been established. Deliberately not deleted.

## User Setup Required

None. Branch protection was applied during the checkpoint and reads back correctly.

## Next Phase Readiness

- **QG-01 through QG-07 and DB-08 are complete.** With 08-17's QG-08/09/10 and 08-04's WRK-12, all twelve of Phase 8's requirements are closed.
- **Work now happens on a branch per phase**, merged through a pull request where three checks must be green. Phase 9 is the first phase to run under that model from the start.
- **Phase 9, 10 and 11 each inherit a gate that will now block them** if they change pinned behaviour without meaning to — the migration-chain tests, the RLS baselines in `packages/tenant-context`, and the three terminal-outcome assertions listed in `docs/failure-injection-scenarios.md`.
- **Phase 14/15 should revisit** the `e2e` exclusion once the browser lane is stable, and add artifact upload before anyone has to debug a CI-only browser failure.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
