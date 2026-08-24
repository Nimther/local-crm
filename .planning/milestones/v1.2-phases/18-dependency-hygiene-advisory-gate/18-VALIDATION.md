---
phase: 18
slug: dependency-hygiene-advisory-gate
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-20
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.9 |
| **Config file** | `scripts/vitest.config.ts` (via `--root scripts`) |
| **Quick run command** | `npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs __tests__/advisory-scan-workflow.test.mjs` |
| **Full suite command** | `npm run test` |
| **Estimated runtime** | ~1 second (quick pair, 91 tests); full suite minutes |

---

## Sampling Rate

- **After every task commit:** Run the quick run command above
- **After every plan wave:** Run `npm run test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~1 second (quick pair)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 18-01-01 | 01 | 1 | DEP-01, DEP-02 | T-18-01/02/04/05 | gate fails RED on uncovered HIGH/CRITICAL; bare non-conditional CI step | tracer + unit | `npx vitest run --root scripts __tests__/check-dependency-advisories.test.mjs` | ✅ | ✅ green |
| 18-01-02 | 01 | 1 | DEP-02 | T-18-03/05 | fail-closed retry on registry failure; `auditReportVersion === 2` rejection | unit (TDD) | same as 18-01-01 | ✅ | ✅ green |
| 18-02-01 | 02 | 2 | DEP-03 | T-18-06/07/08 | mandatory five-field entries, 90-day expiry cap, email-shaped owner rejected with named field | unit (TDD, RED fixtures) | same as 18-01-01 | ✅ | ✅ green |
| 18-02-02 | 02 | 2 | DEP-03 | T-18-09/10 | exact advisoryId+package match both mismatch directions; UTC-day expiry at boundary | unit (TDD, GREEN) | same as 18-01-01 | ✅ | ✅ green |
| 18-03-01 | 03 | 3 | DEP-01 | T-18-SC/11/13/14 | zero new packages; no `--force`; drizzle-kit 0.31.10 unchanged; green reached only via upgrades | CI gate command | `npm run check:dependency-advisories` (exit 0) + raw `npm audit` high/critical = 0 + `npm run check:lockfile-npm10` | ✅ | ✅ green |
| 18-03-02 | 03 | 3 | DEP-01 | T-18-12 | full build/lint/test/chunk-boundary re-verified post-upgrade | suite re-run + docs | `npm run test` + `npm run check:web-chunks` | ✅ | ✅ green |
| 18-04-01 | 04 | 4 | DEP-02 | T-18-15/16/20 | two-key `permissions:` count, full-SHA `uses:` pins, byte-identical gate invocation | unit (drift test, RED) | `npx vitest run --root scripts __tests__/advisory-scan-workflow.test.mjs` | ✅ | ✅ green |
| 18-04-02 | 04 | 4 | DEP-02 | T-18-17/18/19 | label-scoped dedup, advisory-only issue body, no swallowed API errors | unit (drift test, GREEN) + live check | same as 18-04-01; live dedup behavior in 18-UAT.md item 2 | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Verified 2026-08-20: quick pair = 2 files, 91 tests, all passing; `check:dependency-advisories` exits 0; raw `npm audit` reports high: 0, critical: 0.

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. (vitest + `scripts/__tests__/` convention pre-dated the phase; both phase test files were created inside their own TDD tasks, not as Wave 0 stubs.)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `dependency-advisory` label exists in the GitHub repo | DEP-02 | live GitHub repo mutation | 18-UAT.md item 1 |
| Live `workflow_dispatch` of advisory-scan opens exactly one issue; second run comments instead of duplicating | DEP-02 | requires live GitHub Actions + Issues API | 18-UAT.md item 2 |
| SC3 backstop — cron surfaces a newly-published advisory | DEP-02 | observational; depends on a real future advisory | 18-UAT.md item 3 |
| CR-01 fix ratification | DEP-02 | human judgment requested by 18-REVIEW-FIX.md | 18-UAT.md item 4 |
| Two interpretive assumptions (Russian REQUIREMENTS.md, English-keyed classifier) | DEP-01/02 | human ratification of interpretation | 18-UAT.md item 5 |
| Four judgment-tier prohibitions | DEP-01/02/03 | human ratification; evidence already gathered | 18-UAT.md item 6 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none — existing infra)
- [x] No watch-mode flags
- [x] Feedback latency < 5s (quick pair ~1s)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-08-20

---

## Validation Audit 2026-08-20

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

All three phase requirements (DEP-01, DEP-02, DEP-03) verified COVERED: 91 automated tests green across `check-dependency-advisories.test.mjs` and `advisory-scan-workflow.test.mjs`, plus live gate exit 0 and raw `npm audit` high/critical = 0. Six live-environment/human-ratification items remain tracked in 18-UAT.md (not automatable locally). No test generation required; auditor not spawned.
