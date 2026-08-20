---
phase: 08-quality-gates-failure-injection-foundation
verified: 2026-08-06T08:24:08Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "A pull request carrying a failing test, a type error, a lint violation, or a coverage drop below the recorded baseline cannot be merged"
  gaps_remaining: []
  regressions: []
---

# Phase 08: Quality Gates & Failure-Injection Foundation — Verification Report

**Phase Goal:** Any change to the send pipeline can be proven safe before it ships — CI blocks broken code, tests cannot touch the dev database, and every failure mode the audit names can be reproduced on demand.
**Verified:** 2026-08-06T07:41:05Z (initial) / 2026-08-06T08:24:08Z (re-verification after SC1 remediation)
**Status:** passed
**Re-verification:** Yes — after gap closure (SC1 merge-enforcement gap remediated same day)

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | A PR carrying a failing test, type error, lint violation, or coverage drop below baseline cannot be merged | ✓ VERIFIED | Detection: `.github/workflows/ci.yml` defines `static` (typecheck via `npm run build --workspaces`, `eslint . --max-warnings=0`, lint file-count floor, migration linter, root hygiene), `test` (aggregate coverage run + `coverage:gate` + `coverage:ratchet`), `failure-injection` (five separate scenario steps). Latest run 30910876645 on current HEAD 8a44c8d: static/test/failure-injection all `success`. Enforcement (re-verified 2026-08-06T08:24Z): repo `Nimther/local-crm` is PUBLIC (`gh repo view --json visibility`); `GET /branches/master/protection` reads back `strict: true`, `contexts: [static, test, failure-injection]`, `enforce_admins: true`, PR reviews required with `required_approving_review_count: 0`, `restrictions: null`, force pushes and deletions denied. With the repo public the rule is enforced — a red required check blocks the merge. |
| 2 | An E2E run without a provisioned ephemeral database aborts with a hard error instead of falling back to the dev database, and CI asserts which connection string was used | ✓ VERIFIED | `packages/test-support/src/guard.ts:32` `assertTestDatabaseUrl` throws FATAL on unset TEST_DATABASE_URL, on names not prefixed `mega_crm_test`, and on host+port+database equality with the dev DSN. `db-fixture.ts` states and honors "deliberately no `??` fallback to DATABASE_URL" (line 51). `apps/web/e2e/provision-database.ts` provisions at playwright.config module scope (before webServer boot) and prints the `[e2e:database]` marker; `apps/web/e2e/database-isolation.spec.ts:36` asserts the DSN contains `mega_crm_test_e2e_`. Behavioral proof: in run 30910876645 the e2e specs flaked (documented SEGM-04) but the step "Assert the run used an ephemeral database" ran under `if: always()` and **passed** — the ephemeral-DSN grep held on a real CI run. |
| 3 | Each named failure mode — SendGrid timeout, 429, connection reset, SIGKILL mid-dispatch, Redis restart mid-queue — is reproducible by a single command and produces an asserted outcome | ✓ VERIFIED | Five root scripts (`failure:429`, `failure:timeout`, `failure:reset`, `failure:sigkill`, `failure:redis-restart`) each target one test file in `apps/worker/src/queues/__tests__/failure-injection/` (103–149 lines each, all with concrete assertions: outcome values, `sends` status `dispatching`, row-count 1, zero re-send calls; sigkill asserts `exit.signal === "SIGKILL"` on a real forked process killed via IPC marker inside the claim window). `docs/failure-injection-scenarios.md` maps all five to commands, test files, and asserted outcomes. CI runs the five as **separate steps** in the `failure-injection` job; all green on current HEAD. |
| 4 | Redis refuses writes instead of silently evicting at its memory ceiling, and queued jobs survive a Redis container restart | ✓ VERIFIED | `docker/redis.conf` sets `maxmemory 512mb` + `maxmemory-policy noeviction` + `appendonly yes` + `appendfsync everysec`; docker-compose mounts it read-only and boots via explicit `command:`. `scripts/verify-redis-config.mjs` asserts all four directives against a live server (unreachable Redis = failure, never a skip) and runs in the CI `test` job. `redis-restart.test.ts` enqueues 5 BullMQ jobs, SIGTERM-restarts a real redis-server booted from that exact conf, asserts equal waiting count and full processing after restart — plus a discrimination test proving a stock (no-AOF) server loses all jobs. Green in CI. |
| 5 | Migrations verified from empty and on top of current schema; expand/contract is a written, enforced rule; `.env`/`dump.rdb` out of the working root; `ARCHITECTURE.md`/`CONVENTIONS.md` exist with a binding update rule in `CLAUDE.md` | ✓ VERIFIED | `packages/db/src/__tests__/migrate-from-empty.test.ts` (RLS enabled+forced, core tables, partition parents) and `migrate-incremental.test.ts` (seeded-data preservation, NOT-NULL-without-DEFAULT rejection) run in the CI aggregate. `scripts/lint-migrations.mjs` (270 lines, comment-masked splitter after CR-01/WR-01 fix) enforces the destructive-DDL marker and enum-in-separate-file rules — ran now: "38 file(s) checked, no violations", exit 0. Root scan: no `.env`/`dump.rdb` (only allowed `.env.example`); `scripts/check-root-hygiene.mjs` wired into the static job. `ARCHITECTURE.md` (95 lines) and `CONVENTIONS.md` (95 lines, § Expand/contract) exist; `.claude/CLAUDE.md` carries three binding "дописать в том же изменении" rules for SPECIFICATION/ARCHITECTURE/CONVENTIONS (QG-10). |

**Score:** 5/5 truths verified (0 present-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `.github/workflows/ci.yml` | Four jobs: static, test, failure-injection, e2e | ✓ VERIFIED | 247 lines; all third-party actions SHA-pinned; e2e is `continue-on-error` by documented decision |
| `package.json` (root) | All scripts CI invokes exist | ✓ VERIFIED | lint, lint:floor, lint:migrations, verify:redis-config, coverage, coverage:gate, coverage:ratchet, check:root-hygiene, failure:* — all present and resolving |
| `apps/worker/src/queues/__tests__/failure-injection/*.test.ts` | Five substantive scenario tests | ✓ VERIFIED | 613 lines total across 5 files; real assertions, no stubs |
| `apps/worker/src/test/harness/sigkill-entrypoint.ts` | Real-process kill harness | ✓ VERIFIED | Exists; imported by sigkill.test.ts via `SIGKILL_HARNESS_READY` and spawned with `--import tsx` |
| `packages/test-support/src/guard.ts`, `db-fixture.ts`, `global-setup.ts` | Fail-closed DSN guard, no dev fallback | ✓ VERIFIED | Guard throws FATAL; wired into globalSetup of all 9 workspace vitest configs |
| `packages/test-support/src/harness/temp-redis.ts` | Throwaway redis-server from docker/redis.conf | ✓ VERIFIED | Used by redis-restart test and verify-redis-config local path |
| `docker/redis.conf` | maxmemory + noeviction + AOF | ✓ VERIFIED | All four directives present; mounted read-only in compose with explicit command |
| `scripts/verify-redis-config.mjs` | Live CONFIG GET assertion, no skip path | ✓ VERIFIED | Node-builtins-only RESP client; asserts all four directives together |
| `scripts/lint-migrations.mjs` | Expand/contract + destructive-DDL enforcement | ✓ VERIFIED | Ran: 38 files, no violations; fail-first fixtures in `tools/migration-fixtures/` (4 bad, 2 good) |
| `scripts/coverage-gate.mjs`, `coverage-ratchet.mjs`, `coverage-baseline.json` | Unrounded threshold + ratchet | ✓ VERIFIED | Gate ran now: actual 0.81937 ≥ threshold 0.81258, OK. Baseline documents measured value, scope, and anti-lowering note |
| `scripts/check-root-hygiene.mjs` | Working-root blacklist | ✓ VERIFIED | Ran now: exits 1 on a local `.DS_Store` (macOS litter) — fail-closed behavior demonstrated live; see Anti-Patterns note |
| `scripts/check-lint-file-floor.mjs`, `lint-file-floor.json` | Lint file-count floor (minFiles 390) | ✓ VERIFIED | Floor derived from measured 396, documented rounding rule |
| `eslint.config.js` | Flat config, zero-warning lint | ✓ VERIFIED | 207 lines; vitest/import-x/no-only-tests plugins; fail-first fixtures in `tools/lint-fixtures/` |
| `vitest.config.ts` (root) | Aggregated coverage run, one denominator | ✓ VERIFIED | Projects list covers every backend workspace; apps/web excluded by decision D-16 |
| `apps/web/e2e/provision-database.ts`, `database-isolation.spec.ts`, `global-teardown.ts` | Module-scope E2E provisioning + isolation spec | ✓ VERIFIED | globalSetup deleted (ran too late); DSN passed to webServer explicitly |
| `packages/db/src/__tests__/migrate-{from-empty,incremental}.test.ts` | Both migration-chain runs | ✓ VERIFIED | Substantive assertions incl. RLS FORCE and row preservation |
| `ARCHITECTURE.md`, `CONVENTIONS.md`, `.claude/CLAUDE.md` rules | Docs + binding update rule | ✓ VERIFIED | All present; CLAUDE.md has per-document triggers and the "в том же изменении" obligation |
| `docs/failure-injection-scenarios.md` | Five-scenario checklist mapped to test names | ✓ VERIFIED | Table maps scenario → command → test file → asserted outcome |
| GitHub branch protection on master | static/test/failure-injection required, enforce_admins, no bypass | ✓ VERIFIED (re-verified 2026-08-06T08:24Z) | Initially found deleted (404 "Branch not protected", empty rulesets), not merely dormant. Remediated same day: repo made PUBLIC and the rule re-created via PUT with the exact 08-18 configuration. Independent API read-back confirms `contexts: [static, test, failure-injection]`, `strict: true`, `enforce_admins: true`, PR required at 0 approvals, no restrictions, force pushes and deletions denied — enforced now that the repo is public |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| ci.yml static job | eslint / floor / migrations / hygiene scripts | npm run lint, lint:floor, lint:migrations, check:root-hygiene | ✓ WIRED | All four scripts exist and run |
| ci.yml test job | coverage gate + ratchet | npm run coverage → coverage:gate → coverage:ratchet, fetch-depth 0 for origin/master baseline read | ✓ WIRED | Gate re-run locally: OK |
| ci.yml failure-injection job | five scenario tests | five separate `npm run failure:*` steps | ✓ WIRED | Deliberately not the aggregate `failure:all` |
| ci.yml e2e job | ephemeral-DB assertion | `tee e2e-output.txt` (with `shell: bash` for pipefail) + `[e2e:database]` grep under `if: always()` | ✓ WIRED | Assertion passed on run 30910876645 even while a spec flaked |
| playwright.config.ts | provision-database.ts | module-scope import, DSN passed to webServer env explicitly | ✓ WIRED | globalSetup path deleted |
| All 9 vitest workspace configs | test-support globalSetup / DSN guard | globalSetup wiring | ✓ WIRED | grep confirms every workspace config references globalSetup |
| redis-restart test + verify-redis-config | docker/redis.conf | TempRedis `configFile` + compose read-only mount | ✓ WIRED | Same file both paths, one verifier script |
| ci.yml | branch protection required checks | GitHub repository settings | ✓ WIRED (re-verified 2026-08-06T08:24Z) | Protection rule re-created and enforced on the now-public repo; API read-back matches the 08-18 configuration exactly |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Migration linter passes on real corpus | `npm run lint:migrations` | 38 files checked, no violations, exit 0 | ✓ PASS |
| Coverage gate enforces unrounded threshold | `npm run coverage:gate` (against committed coverage-summary) | actual 0.8193729 ≥ threshold 0.8125751, exit 0 | ✓ PASS |
| Root hygiene fails closed | `npm run check:root-hygiene` | exit 1 on local `.DS_Store` with reason printed — enforcement is real, not vacuous | ✓ PASS (fail-closed demonstrated) |
| Full CI on current HEAD (8a44c8d) | GitHub run 30910876645 | static ✓, test ✓, failure-injection ✓ (all five scenarios), e2e specs flaked but DB assertion ✓ | ✓ PASS |
| Branch protection enforced now | `gh repo view --json visibility` + `gh api .../branches/master/protection` (re-verified 2026-08-06T08:24Z) | visibility PUBLIC; strict=true, contexts [static, test, failure-injection], enforce_admins=true, PR reviews object at 0 approvals, restrictions null, force pushes/deletions denied | ✓ PASS |

No probe scripts (`scripts/*/tests/probe-*.sh`) are declared by this phase — probe execution N/A. Failure-injection suites were not re-run locally (they require live Postgres/Redis); their behavioral evidence is the green CI run on the exact current HEAD, two days old.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| ----------- | ------------ | ----------- | ------ | -------- |
| QG-01 | 08-01, 08-18 | CI runs tests/typecheck/build on every push+PR; red run blocks merge | ✓ SATISFIED | CI runs and is red-capable (fail-first proofs in 08-18 SUMMARY); merge-blocking re-verified enforced 2026-08-06T08:24Z after remediation (public repo + re-created protection rule) |
| QG-02 | 08-03, 08-07 | Lint configured, violations block CI | ✓ SATISFIED | `eslint . --max-warnings=0` in required static job + file-count floor against vacuous-green |
| QG-03 | 08-11, 08-14, 08-16 | Coverage measured; drop below threshold blocks CI | ✓ SATISFIED | Aggregate run, unrounded gate, ratchet vs origin/master baseline, baseline 0.8126 currently exceeded |
| QG-04 | 08-02, 08-06, 08-10, 08-18 | Playwright E2E on ephemeral isolated DB, technically cannot reach dev DB | ✓ SATISFIED | Module-scope provisioning, hard DSN guard, no fallback, CI grep assertion passed on real run |
| QG-05 | 08-09 | Migrations tested from scratch and on top of existing schema | ✓ SATISFIED | migrate-from-empty + migrate-incremental in CI aggregate |
| QG-06 | 08-08, 08-12, 08-13 | Failure-injection harness: SendGrid timeout, 429, connection reset, process death | ✓ SATISFIED | Four scenarios + redis-restart, each single-command, asserted outcomes, checklist doc |
| QG-07 | 08-15 | `.env`/`dump.rdb` out of working root; secrets not in repo dir | ✓ SATISFIED | Only `.env.example` present; MEGA_CRM_ENV_FILE resolver (`scripts/env-path.mjs`); blacklist check in static job |
| QG-08 | 08-17 | `ARCHITECTURE.md` describes the actual architecture | ✓ SATISFIED | 95-line document at repo root |
| QG-09 | 08-17 | `CONVENTIONS.md` fixes code and architecture conventions | ✓ SATISFIED | 95-line document incl. § Expand/contract |
| QG-10 | 08-17 | Update rule for the three docs bound in `CLAUDE.md` | ✓ SATISFIED | Three binding "в том же изменении" rules with per-document triggers |
| WRK-12 | 08-04, 08-13 | Redis `maxmemory-policy=noeviction` with persistence | ✓ SATISFIED | redis.conf + live CONFIG GET verifier in CI + behavioral restart-survival test with no-AOF discrimination proof |
| DB-08 | 08-05, 08-17 | Expand/contract mandatory for migrations | ✓ SATISFIED | CONVENTIONS.md rule + `lint-migrations.mjs` enforcement (destructive marker, enum-in-own-file) in required static job |

No orphaned requirements: REQUIREMENTS.md maps exactly QG-01…QG-10, WRK-12, DB-08 to Phase 8, all claimed by plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `<working root>/.DS_Store` | — | Blacklisted file in working root | ℹ️ Info | macOS Finder litter created after the phase; makes local `check:root-hygiene` exit 1 (correctly). Delete the file to restore local green. Not present on CI runners. |
| `.planning/ROADMAP.md` (Phase 8 section) | — | Bookkeeping drift: shows "17/18 plans executed" and 08-18 unchecked, though 08-18-SUMMARY.md exists and CI is fully wired | ⚠️ Warning | STATE.md says phase complete; ROADMAP checkbox for 08-18 was never flipped. Cosmetic, but will confuse `roadmap.analyze`. |

No TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER markers in any phase-modified script, workflow, guard, or test file. Code review (08-REVIEW.md) had 4 findings; 2 fixed in commits 0711acd and d47fdd3, 1 skipped as documented scope decision (IN-01), consistent with 08-REVIEW-FIX.md.

### Human Verification Required

None. All behavior-dependent truths carry behavioral evidence: the five failure scenarios, migration chains, coverage gates, and the E2E DSN assertion all executed green in real CI on the current HEAD (run 30910876645, 2026-08-04); the two fast gates (`lint:migrations`, `coverage:gate`) and the fail-closed hygiene check were additionally re-run locally during this verification.

### Gaps Summary

None remaining. The single gap from the initial verification pass was remediated the same day and re-verified.

**SC1 gap — remediated 2026-08-06.** The initial pass (07:41Z) found that merge enforcement did not hold: the repo was private on GitHub Free and the protection API returned 403. The initial report assumed the 08-18 rule was stored but dormant; remediation investigation corrected that — the rule had been **deleted outright** (404 "Branch not protected", empty rulesets), not merely unenforced. Remediation option 1 was taken: the repository `Nimther/local-crm` was made **public**, and branch protection on `master` was re-created via `PUT /branches/master/protection` with the exact 08-18 configuration. This verifier's own independent read-back at 08:24Z confirms: visibility PUBLIC; `required_status_checks.strict: true` with `contexts: [static, test, failure-injection]`; `enforce_admins: true`; `required_pull_request_reviews` present as an object with `required_approving_review_count: 0` (not null — null would drop the PR requirement entirely); `restrictions: null`; `allow_force_pushes: false`; `allow_deletions: false`. With the repo public, the rule is enforced: a PR with a red required check cannot be merged. SC1 is now VERIFIED and the phase scores 5/5.

Everything else the phase goal promises is observably true in the codebase and was exercised in a real CI run on the exact current commit: tests cannot touch the dev database (hard-failing guard, no fallback, CI-asserted ephemeral DSN), and every audit-named failure mode is reproducible by a single command with asserted outcomes — including a real SIGKILL inside the claim window and a real Redis restart with a discrimination proof that the durability config, not luck, is what preserves the jobs.

---

_Verified: 2026-08-06T07:41:05Z (initial), 2026-08-06T08:24:08Z (re-verification — SC1 gap closed)_
_Verifier: Claude (gsd-verifier)_
