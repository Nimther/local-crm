---
phase: 8
slug: quality-gates-failure-injection-foundation
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-07-28
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.9 (existing) + Playwright 1.61.1 (existing, E2E only) |
| **Config file** | Per-workspace `vitest.config.ts` (5 existing) + NEW root `vitest.config.ts` aggregator (D-16) — Wave 0 creates the root aggregator |
| **Quick run command** | `npx vitest run <path/to/file.test.ts>` (single file, fast feedback on the file just touched) |
| **Full suite command** | `npm run test --workspaces --if-present` against `docker compose up -d --wait` |
| **Estimated runtime** | ~90 seconds full suite (91 test files today, growing with this phase) |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run <path/to/file.test.ts>` for the file just touched
- **After every plan wave:** Run `npm run test --workspaces --if-present` against `docker compose up -d --wait`
- **Before `/gsd-verify-work`:** Full suite must be green; the `test` + `failure-injection` CI jobs must be green on the phase's own PR
- **Max feedback latency:** 90 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _pending — populated from PLAN.md task IDs after planning_ | — | — | — | — | — | — | — | — | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

### Requirement → Test Map (from RESEARCH.md § Validation Architecture)

| Req ID | Behavior | Test Type | Automated Command | File Exists |
|--------|----------|-----------|-------------------|-------------|
| QG-01 | Red PR blocked, green PR allowed | manual/CI-config | throwaway PR exercise (tracer slice) | ❌ N/A — not a repo test file |
| QG-02 | Lint fails on violation, exit 0 on clean tree | unit | `npx eslint <fixture-with-violation>` (exit 1), then clean tree (exit 0) | ❌ W0 — `eslint.config.js` |
| QG-03 | Coverage gate boundary/precision | unit | `npx vitest run packages/test-support/src/__tests__/coverage-gate.test.ts` | ❌ W0 |
| QG-04 | DSN guard — 4 SPEC rows | unit | `npx vitest run packages/test-support/src/__tests__/guard.test.ts` | ❌ W0 |
| QG-05 | Migrations apply from empty + incrementally | integration | `npx vitest run packages/db/src/__tests__/migrate-from-empty.test.ts` / `migrate-incremental.test.ts` | ❌ W0 |
| QG-06 (×5) | Each failure scenario, asserted outcome | integration | `npm run failure:timeout` / `failure:429` / `failure:reset` / `failure:sigkill` / `failure:redis-restart` | ❌ W0 (copy fixtures from `send-dispatch-durability.test.ts`) |
| QG-07 | Root blacklist fail-first | unit | `node scripts/check-root-hygiene.mjs` against fixture tree containing `.env` | ❌ W0 |
| QG-08 / QG-09 / QG-10 | Docs exist, binding rule text present | judgment | manual review against SPEC acceptance criteria | ❌ N/A — prose deliverables |
| WRK-12 | Redis config asserted, fail-first proof | integration | `npx vitest run docker/__tests__/redis-config.test.ts` (once before `docker/redis.conf`, once after) | ❌ W0 |
| DB-08 | Migration linter fail-first + passes on 38 real files | unit | `npx vitest run packages/test-support/src/__tests__/migration-lint.test.ts` | ❌ W0 |

---

## Wave 0 Requirements

- [ ] `packages/test-support/` workspace scaffold (`package.json`, `tsconfig.json`, vitest devDependency) — nothing exists yet (D-13)
- [ ] `eslint.config.js` — no ESLint config anywhere in the repo today
- [ ] `vitest.config.ts` (root aggregator) — does not exist; only per-workspace configs exist
- [ ] `coverage-baseline.json` — cannot be written until coverage is first measured; sequence as ordered tasks (install `@vitest/coverage-v8` → run once → record baseline → add gate), never parallel
- [ ] `docker/redis.conf` — does not exist; the `redis` service has no `command:` override today
- [ ] `.github/workflows/ci.yml` — `.github/` does not exist at all
- [ ] `ARCHITECTURE.md`, `CONVENTIONS.md` — neither file exists

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Branch protection actually blocks a red PR from merging | QG-01 | Branch-protection enforcement lives in GitHub repo settings, not in the repo tree — no in-repo test can assert it | Open a throwaway PR carrying a deliberately failing test; confirm the merge button is blocked by the required status check; then confirm a green PR is mergeable; close the PR |
| `ARCHITECTURE.md` / `CONVENTIONS.md` content is accurate and the `CLAUDE.md` update rule is binding | QG-08, QG-09, QG-10 | Prose deliverables — correctness is a judgment call, not an assertion | Review each document against its SPEC acceptance criteria; confirm the `CLAUDE.md` rule names the exact trigger conditions and the exact files to update |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
