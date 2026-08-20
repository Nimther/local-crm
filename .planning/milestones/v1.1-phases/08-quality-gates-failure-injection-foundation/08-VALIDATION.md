---
phase: 8
slug: quality-gates-failure-injection-foundation
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-07-28
validated: 2026-08-06
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.9 (11 workspace projects + root aggregator) + Playwright 1.61.1 (E2E only) |
| **Config file** | Root `vitest.config.ts` aggregator (D-16, backend scope) + per-workspace `vitest.config.ts` (9 workspaces with test-support globalSetup) |
| **Quick run command** | `npx vitest run <path/to/file.test.ts>` |
| **Full suite command** | `npm run test --workspaces --if-present` (native Postgres/Redis locally; docker compose in CI) |
| **Gate scripts** | `npm run lint` / `lint:floor` / `lint:migrations` / `check:root-hygiene` / `coverage` → `coverage:gate` → `coverage:ratchet` / `verify:redis-config` / `failure:*` |
| **CI** | `.github/workflows/ci.yml` — 4 jobs (static, test, failure-injection, e2e); static/test/failure-injection are required checks on `master` with `enforce_admins` |
| **Estimated runtime** | ~90 seconds full local suite (~102 files / 635+ tests); CI ~2.5 min per job |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run <path/to/file.test.ts>` for the file just touched
- **After every plan wave:** Run `npm run test --workspaces --if-present`
- **Before `/gsd-verify-work`:** Full suite green; `static` + `test` + `failure-injection` CI jobs green on the phase PR
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01.1 | 08-01 | 1 | QG-01, QG-04 | integration | `npx vitest run --root packages/test-support` + `npm run test -w apps/worker` | ✅ | ✅ green |
| 08-01.2 | 08-01 | 1 | QG-01 | unit | `grep -c "test-support" SPECIFICATION.md` | ✅ | ✅ green |
| 08-01.3 | 08-01 | 1 | QG-01 | manual | checkpoint: branch protection + throwaway red/green PR (PR #3 BLOCKED→CLEAN) | n/a | ✅ done |
| 08-02.1 | 08-02 | 2 | QG-04 | unit | `npx vitest run packages/test-support/src/__tests__/guard.test.ts` | ✅ | ✅ green |
| 08-02.2 | 08-02 | 2 | QG-04 | integration | `npx vitest run packages/test-support/src/__tests__/provision-db.test.ts` | ✅ | ✅ green |
| 08-02.3 | 08-02 | 2 | QG-04 | integration | `npm run test -w apps/worker` (globalSetup provisioning) | ✅ | ✅ green |
| 08-03.1 | 08-03 | 3 | QG-02 | unit | `npx eslint --format json .` — 0 fatal parser errors | ✅ | ✅ green |
| 08-03.2 | 08-03 | 3 | QG-02 | unit | `npx vitest run packages/test-support/src/__tests__/lint-gate.test.ts` | ✅ | ✅ green |
| 08-03.3 | 08-03 | 3 | QG-02 | unit | `node scripts/check-lint-file-floor.mjs` (floor 390) | ✅ | ✅ green |
| 08-04.1 | 08-04 | 6 | WRK-12 | integration | RED proof: assertion fails vs stock redis:7 | ✅ | ✅ green |
| 08-04.2 | 08-04 | 6 | WRK-12 | integration | `npx vitest run packages/test-support/src/__tests__/redis-config.test.ts` | ✅ | ✅ green |
| 08-04.3 | 08-04 | 6 | WRK-12 | unit | `grep -c "redis.conf" SPECIFICATION.md` | ✅ | ✅ green |
| 08-05.1 | 08-05 | 2 | DB-08 | unit | RED proof: `! npx vitest run .../migration-lint.test.ts` before implementation | ✅ | ✅ green |
| 08-05.2 | 08-05 | 2 | DB-08 | unit | `npx vitest run packages/test-support/src/__tests__/migration-lint.test.ts && node scripts/lint-migrations.mjs` (38 real files) | ✅ | ✅ green |
| 08-06.1 | 08-06 | 4 | QG-04 | unit | `npm run build -w packages/test-support && npx vitest run .../guard.test.ts` | ✅ | ✅ green |
| 08-06.2 | 08-06 | 4 | QG-04 | integration | worker + delivery-core suites via shims | ✅ | ✅ green |
| 08-06.3 | 08-06 | 4 | QG-04 | integration | `npx vitest run packages/test-support/src/__tests__/db-fixture-isolation.test.ts` | ✅ | ✅ green |
| 08-07.1 | 08-07 | 5 | QG-02 | unit | eslint JSON inventory by ruleId | n/a | ✅ done |
| 08-07.2 | 08-07 | 5 | QG-02 | unit+integration | `npx eslint "apps/api/**" "apps/worker/**" "packages/**" "scripts/**" --max-warnings=0` + full suite | ✅ | ✅ green |
| 08-07.3 | 08-07 | 5 | QG-02 | unit | `npm run lint` (exit 0, 403 files ≥ floor 390) | ✅ | ✅ green |
| 08-08.1 | 08-08 | 6 | QG-06 | integration | `npx vitest run --root apps/worker src/queues/__tests__/send-dispatch-durability.test.ts` | ✅ | ✅ green |
| 08-08.2 | 08-08 | 6 | QG-06 | integration | `npm run failure:429` | ✅ | ✅ green |
| 08-08.3 | 08-08 | 6 | QG-06 | integration | `npm run failure:timeout && npm run failure:reset` | ✅ | ✅ green |
| 08-09.1 | 08-09 | 9 | QG-05 | unit | `npx vitest run packages/test-support/src/__tests__/migration-runner.test.ts` | ✅ | ✅ green |
| 08-09.2 | 08-09 | 9 | QG-05 | integration | `npx vitest run --root packages/db src/__tests__/migrate-from-empty.test.ts` | ✅ | ✅ green |
| 08-09.3 | 08-09 | 9 | QG-05 | integration | `npx vitest run --root packages/db` (incl. migrate-incremental) | ✅ | ✅ green |
| 08-10.1 | 08-10 | 10 | QG-04 | integration | Playwright provisioning shares vitest path (typecheck + boot) | ✅ | ✅ green |
| 08-10.2 | 08-10 | 10 | QG-04 | e2e | `npm run test:e2e -w apps/web` (`reuseExistingServer:false`) | ✅ | ✅ green |
| 08-10.3 | 08-10 | 10 | QG-04 | unit | `grep -c "dev:e2e" SPECIFICATION.md` | ✅ | ✅ green |
| 08-11.1 | 08-11 | 7 | QG-03 | unit | per-workspace `npm run test -w packages/{segments-core,shared-schemas,flows-core}` | ✅ | ✅ green |
| 08-11.2 | 08-11 | 7 | QG-03 | integration | `npm run coverage` (root aggregator, one denominator) | ✅ | ✅ green |
| 08-11.3 | 08-11 | 7 | QG-03 | unit | baseline consistency check vs coverage-summary.json | ✅ | ✅ green |
| 08-12.1 | 08-12 | 12 | QG-06 | unit | `npx vitest run --root packages/test-support src/__tests__/spawn-and-kill.test.ts` | ✅ | ✅ green |
| 08-12.2 | 08-12 | 12 | QG-06 | unit | `npm run build -w apps/worker` (sigkill-entrypoint) | ✅ | ✅ green |
| 08-12.3 | 08-12 | 12 | QG-06 | integration | `npm run failure:sigkill` (real SIGKILL in claim window, 0 re-sends) | ✅ | ✅ green |
| 08-13.1 | 08-13 | 13 | QG-06 | integration | `npx vitest run --root packages/test-support src/__tests__/docker-restart.test.ts` (TempRedis.restart) | ✅ | ✅ green |
| 08-13.2 | 08-13 | 13 | QG-06, WRK-12 | integration | `npm run failure:redis-restart` (+ no-AOF discrimination proof) | ✅ | ✅ green |
| 08-13.3 | 08-13 | 13 | QG-06 | unit | checklist↔scripts↔paths consistency check on `docs/failure-injection-scenarios.md` | ✅ | ✅ green |
| 08-14.1 | 08-14 | 8 | QG-03 | unit | RED proof: `! npx vitest run .../coverage-gate.test.ts` before implementation | ✅ | ✅ green |
| 08-14.2 | 08-14 | 8 | QG-03 | unit | `npx vitest run packages/test-support/src/__tests__/coverage-gate.test.ts` | ✅ | ✅ green |
| 08-14.3 | 08-14 | 8 | QG-03 | unit | `npx vitest run .../coverage-ratchet.test.ts && node scripts/coverage-ratchet.mjs` | ✅ | ✅ green |
| 08-15.1 | 08-15 | 11 | QG-07 | unit | `node -e "import('./scripts/env-path.mjs')..."` resolver outside cwd | ✅ | ✅ green |
| 08-15.2 | 08-15 | 11 | QG-07 | unit | all 9 load points call `resolveEnvPath` (grep contract) | ✅ | ✅ green |
| 08-15.3 | 08-15 | 11 | QG-07 | unit | `npx vitest run packages/test-support/src/__tests__/root-hygiene.test.ts` + CLI fail-first/fail-clean | ✅ | ✅ green |
| 08-15.4 | 08-15 | 11 | QG-07 | manual | checkpoint: operator moved `.env` out of working root | n/a | ✅ done |
| 08-16.1 | 08-16 | 14 | QG-03 | unit | `npx vitest run --root packages/kms` (envelope tests) | ✅ | ✅ green |
| 08-16.2 | 08-16 | 14 | QG-03 | integration | `npx vitest run --root packages/tenant-context` | ✅ | ✅ green |
| 08-16.3 | 08-16 | 14 | QG-03 | integration | `npm run coverage && npm run coverage:gate && npm run coverage:ratchet` (0.8194 ≥ 0.8126) | ✅ | ✅ green |
| 08-17.1 | 08-17 | 14 | QG-08 | unit | ARCHITECTURE.md structure check (5 blocks, 1 mermaid, SPECIFICATION links) | ✅ | ✅ green |
| 08-17.2 | 08-17 | 14 | QG-09 | unit | CONVENTIONS.md check (expand/contract section, ≥8 cited paths resolve) | ✅ | ✅ green |
| 08-17.3 | 08-17 | 14 | QG-10 | unit | `.claude/CLAUDE.md` names all three docs, no placeholders | ✅ | ✅ green |
| 08-18.1 | 08-18 | 15 | QG-01, QG-03, QG-04, QG-06 | unit | ci.yml contract check (4 jobs, all scripts invoked, all actions SHA-pinned, no sleep) | ✅ | ✅ green |
| 08-18.2 | 08-18 | 15 | QG-01 | unit | `.planning/config.json` branching_strategy ≠ none | ✅ | ✅ green |
| 08-18.3 | 08-18 | 15 | QG-01, QG-03, QG-04 | manual | checkpoint: required checks on master + four-way block demo (PR #4 BLOCKED with 3 breaks, mergeable when reverted) | n/a | ✅ done |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Requirement → Test Map (as built)

| Req ID | Behavior | Test Type | Automated Command | File Exists | Status |
|--------|----------|-----------|-------------------|-------------|--------|
| QG-01 | Red PR blocked, green PR allowed | manual/CI-config | throwaway PR exercises (PR #3, PR #4) + `gh api .../branches/master/protection` read-back | n/a | ✅ COVERED (manual, re-verified 2026-08-06) |
| QG-02 | Lint fails on violation, exit 0 on clean tree | unit | `npx vitest run packages/test-support/src/__tests__/lint-gate.test.ts` + `npm run lint` + `lint:floor` | ✅ | ✅ COVERED |
| QG-03 | Coverage gate boundary/precision + ratchet | unit | `npx vitest run packages/test-support/src/__tests__/coverage-gate.test.ts` / `coverage-ratchet.test.ts`; `npm run coverage:gate` (0.8194 ≥ 0.8126) | ✅ | ✅ COVERED |
| QG-04 | DSN guard — 4 SPEC rows; ephemeral E2E DB, no dev fallback | unit + integration + e2e | `guard.test.ts` (14 tests), `provision-db.test.ts`, `db-fixture-isolation.test.ts`, `apps/web/e2e/database-isolation.spec.ts` + CI `[e2e:database]` grep | ✅ | ✅ COVERED |
| QG-05 | Migrations apply from empty + incrementally | integration | `npx vitest run --root packages/db` (`migrate-from-empty.test.ts`, `migrate-incremental.test.ts`) | ✅ | ✅ COVERED |
| QG-06 (×5) | Each failure scenario, asserted outcome | integration | `npm run failure:timeout` / `failure:429` / `failure:reset` / `failure:sigkill` / `failure:redis-restart` — five separate CI steps | ✅ | ✅ COVERED |
| QG-07 | Root blacklist fail-first; env file outside root | unit | `npx vitest run .../root-hygiene.test.ts` + `npm run check:root-hygiene` (fail-closed proven) | ✅ | ✅ COVERED |
| QG-08 / QG-09 / QG-10 | Docs exist, binding rule text present | unit + judgment | 08-17 structure checks automated; content accuracy manual | ✅ | ✅ COVERED (structure) / manual (content) |
| WRK-12 | Redis noeviction + AOF asserted; jobs survive restart | integration | `npx vitest run packages/test-support/src/__tests__/redis-config.test.ts` + `npm run verify:redis-config` + `failure:redis-restart` | ✅ | ✅ COVERED |
| DB-08 | Migration linter fail-first + passes on 38 real files | unit | `npx vitest run packages/test-support/src/__tests__/migration-lint.test.ts` + `npm run lint:migrations` | ✅ | ✅ COVERED |

> Path note vs the plan-time draft: the Redis config test landed at `packages/test-support/src/__tests__/redis-config.test.ts` (not `docker/__tests__/`), and the coverage/DSN/migration-lint tests all landed at their planned `packages/test-support` paths.

---

## Wave 0 Requirements

- [x] `packages/test-support/` workspace scaffold (D-13) — built in 08-01
- [x] `eslint.config.js` — built in 08-03 (flat config, ESLint 10, import-x)
- [x] `vitest.config.ts` (root aggregator) — built in 08-11
- [x] `coverage-baseline.json` — measured then ratcheted in 08-11/08-16 (threshold 0.8125751072961374, currently exceeded at 0.8194)
- [x] `docker/redis.conf` — built in 08-04 (maxmemory 512mb, noeviction, AOF everysec)
- [x] `.github/workflows/ci.yml` — built in 08-01, expanded to 4 jobs in 08-18
- [x] `ARCHITECTURE.md`, `CONVENTIONS.md` — built in 08-17

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions | Status |
|----------|-------------|------------|-------------------|--------|
| Branch protection actually blocks a red PR from merging | QG-01 | Branch-protection enforcement lives in GitHub repo settings, not in the repo tree | Throwaway PR with failing test → merge blocked; green → mergeable | ✅ Done — PR #3 (08-01) and PR #4 four-way block demo (08-18); protection deleted-then-restored gap caught by verifier and re-verified enforced 2026-08-06T08:24Z (repo public, `enforce_admins: true`, contexts static/test/failure-injection) |
| `ARCHITECTURE.md` / `CONVENTIONS.md` content accurate; `CLAUDE.md` update rule binding | QG-08, QG-09, QG-10 | Prose deliverables — correctness is a judgment call | Review each document against SPEC acceptance criteria | ✅ Done — reviewed in 08-17 self-check and gsd-verifier pass (5/5 must-haves) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 90s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-08-06 by /gsd-validate-phase (retroactive audit)

---

## Validation Audit 2026-08-06

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

**Audit context.** Phase 8 was executed on branch `phase-08-quality-gates` and merged to `master` via PR #5 (merge commit `e6f4fc0`); the local checkout was synced to that merge before auditing. All 12 requirements (QG-01…QG-10, WRK-12, DB-08) cross-referenced against the 18 PLAN/SUMMARY pairs and the as-built tree:

- **Local re-run (this audit):** `packages/test-support` 12 files / 103 tests green; `packages/db` 2 files / 9 tests green; `failure:429` green; `lint:migrations` 38 files clean; `coverage:gate` OK (0.8194 ≥ 0.8126); `check:root-hygiene` exit 0 after removing post-phase `.DS_Store` litter (fail-closed behavior confirmed live).
- **CI evidence:** runs 30910876645 (branch HEAD) and 31084961472 (merge) — `static`, `test`, `failure-injection` all SUCCESS. The non-required `e2e` job carries a known flake in `register-create-workspace.spec.ts` (tracked as SEGM-04 follow-up, branch `fix/segm-04-live-count-race`); the QG-04 ephemeral-DSN assertion inside that job passed under `if: always()`.
- **No new tests generated** — no MISSING or PARTIAL requirement remained; the two manual-only rows were completed via blocking human checkpoints during execution and independently re-verified by gsd-verifier.
