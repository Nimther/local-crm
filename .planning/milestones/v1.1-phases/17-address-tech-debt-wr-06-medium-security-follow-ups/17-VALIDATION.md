---
phase: 17
slug: address-tech-debt-wr-06-medium-security-follow-ups
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-19
validated: 2026-08-20
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Retroactively completed 2026-08-20 by `/gsd-validate-phase 17` (the plan-time seed was never
> filled during execution). All statuses below reflect evidence: 17-VERIFICATION.md
> (status: passed, 32/32) ran the DB-backed suites green on 2026-08-19; the gsd-security-auditor
> re-ran the script suites green on 2026-08-20; the cheap one-liner verifies were re-executed
> green by this audit on 2026-08-20.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.9 (monorepo: root `vitest.config.ts` + per-workspace `--root` runs) |
| **Config file** | `vitest.config.ts` (root), per-package configs under `apps/*`/`packages/*` |
| **Quick run command** | `npx vitest run --root <workspace> <test-file>` (per-task commands in the map below) |
| **Full suite command** | `npm test` (`npm run test --workspaces --if-present`) |
| **Estimated runtime** | quick: 5–30 s per file · full suite: minutes (DB-backed suites need the dev Postgres; see notes) |

**Environment notes (from project memory, still true):** `pg-timezone.test.ts` and `dashboard-timezone.test.ts` require a live Postgres (ephemeral DB provisioning); advisory-lock/flow-run-advance tests flake under full-suite load on this machine; `sentry.test.ts` "no DSN" tests fail locally (real DSNs in `~/.config/mega-crm/.env`) but pass in CI. Prefer per-file runs locally, full suite in CI.

---

## Sampling Rate

- **After every task commit:** Run the task's `<automated>` command (per-task map below)
- **After every plan wave:** Run the affected workspace suites (`test:migrations`, `vitest run scripts/__tests__/…`, `--root apps/api`)
- **Before `/gsd-verify-work`:** Full suite green in CI (done — 17-VERIFICATION.md, 2026-08-19)
- **Max feedback latency:** ~30 s (per-file vitest run)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 17-01-01 | 01 | 1 | — (tech debt: WR-06 write path) | T-17-01/T-17-04 | UTC-pinned pool writes true-UTC naive timestamps vs a non-UTC DB; unpinned negative control proves the hazard | integration (live PG) | `npx vitest run --root packages/db src/__tests__/pg-timezone.test.ts` | ✅ | ✅ green (3/3, 17-VERIFICATION 2026-08-19) |
| 17-01-02 | 01 | 1 | — | T-17-02/T-17-03 | Pin literal survives DSN merge; removal fails the guard | unit | `npx vitest run --root packages/db src/__tests__/pool-factory.test.ts` | ✅ | ✅ green (24/24, auditor 2026-08-20) |
| 17-02-01 | 02 | 1 | — (WR-06 read path) | T-17-06…T-17-09 | Double-hop UTC anchor buckets correctly under a forced non-UTC session; single-hop comparator proven wrong | integration (live PG) | `npx vitest run --root apps/api src/modules/analytics/__tests__/dashboard-timezone.test.ts src/modules/analytics/__tests__/dashboard.test.ts` | ✅ | ✅ green (4/4, 17-VERIFICATION 2026-08-19) |
| 17-02-02 | 02 | 1 | — | T-17-06 (sweep) | No unanchored `::date` cast on a naive column survives outside tests/comments | static grep | D-03 sweep one-liner (plan 17-02 Task 2 `<automated>`) | ✅ | ✅ green (re-run 2026-08-20) |
| 17-03-01 | 03 | 1 | — | T-17-12/T-17-16 | `build-and-push-postgres` + `build-only-postgres` jobs exist; PR job is read-only, push: false | static (node script) | jobs-present one-liner (plan 17-03 Task 1 `<automated>`) | ✅ | ✅ green (re-run 2026-08-20) |
| 17-03-02 | 03 | 1 | — | T-17-11/T-17-13 | Prod compose pulls GHCR image, no `build:` key, unset tag fails loudly | static gate | `npm run verify:prod-compose` | ✅ | ✅ green (re-run 2026-08-20) |
| 17-03-03 | 03 | 1 | — | T-17-11/T-17-13 | Immutable-tag gate rejects a mutable `db` tag (fixture-proven) | unit | `npx vitest run scripts/__tests__/validate-prod-compose.test.mjs` | ✅ | ✅ green (34/34, auditor 2026-08-20) |
| 17-04-01 | 04 | 2 | — | T-17-18/T-17-20/T-17-21 | Drill self-records duration + disk high-water on success AND timeout paths; failing sampler cannot fail the drill | unit | `npx vitest run scripts/__tests__/restore-drill-script.test.mjs` | ✅ | ✅ green (47/47 incl. deploy-script, auditor 2026-08-20) |
| 17-04-02 | 04 | 2 | — | T-17-19 | Drill launches GHCR image fail-loud (`:?` guards), script parses | unit + syntax | `npx vitest run scripts/__tests__/restore-drill-script.test.mjs && bash -n scripts/restore-drill.sh` | ✅ | ✅ green (re-run 2026-08-20) |
| 17-05-01 | 05 | 3 | — | T-17-24…T-17-28/T-17-31 | Live cutover: GHCR image id observed, mounts unchanged, RLS 28/28, WAL advancing | checkpoint:human-verify (blocking) | — (see Manual-Only) | n/a | ✅ executed & approved (17-05-SUMMARY Attempt 3, 2026-08-19) |
| 17-05-02 | 05 | 3 | — | T-17-29/T-17-30 | Real PITR drill against GHCR image; figures captured (119 s / 170520 KB) | checkpoint:human-verify (blocking) | — (see Manual-Only) | n/a | ✅ executed & approved (17-05-SUMMARY Task 2, 2026-08-19) |
| 17-05-03 | 05 | 3 | — | T-17-29 | Real drill figures recorded in the runbook table | static grep | `grep -c 'Recorded drill runs' docs/runbooks/restore-drill.md` | ✅ | ✅ green (re-run 2026-08-20) |
| 17-06-01 | 06 | 4 | — | T-17-33/T-17-37 | SPECIFICATION.md describes the CI-built/GHCR model; env-var coverage gate green | static gate | `npm run check:spec-env-coverage` | ✅ | ✅ green (re-run 2026-08-20) |
| 17-06-02 | 06 | 4 | — | T-17-32 | Register status column unchanged by the executor (D-12) | static (git diff invariant) | status-count comparison one-liner (plan 17-06 Task 2 `<automated>`) | ✅ | ✅ green at execution (3==3); invariant now historical — the auditor flip (2026-08-20, `/gsd-secure-phase 17`) legitimately changed the count to 0 |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Post-phase additions (review fixes, covered):** WR-03's gap was filled in-phase — `scripts/__tests__/check-web-chunks.test.mjs` exists (commit `6fa6fb9`) covering the cycle-detection logic flagged by 17-REVIEW.md.

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. (No Wave 0 was needed — every test landed in pre-existing vitest workspaces; `wave_0_complete: true` reflects "nothing to install".)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Production `db`/`pgbackrest` cutover to the CI-built GHCR image (image id, mounts, RLS posture, WAL archiving) | 17-05 Task 1 (D-07, blocking checkpoint) | Live production container recreate against the running database — cannot and must not be automated; evidence is pasted operator output | Follow plan 17-05 Task 1 steps: pre-flight major-version check → record baseline image id → `pull`+`up -d` db/pgbackrest → compare mounts → RLS per-table flags → bracketed `pg_stat_archiver` reads. Evidence standard: pasted output in SUMMARY. **Executed & approved 2026-08-19 (Attempt 3).** |
| Real PITR restore drill against the real off-host repository using the GHCR image | 17-05 Task 2 (blocking checkpoint) | Requires production host, real backup repository, and operator-chosen drill window | Run `scripts/restore-drill.sh` per `docs/runbooks/restore-drill.md`; confirm metrics NDJSON line and runbook table entry match digit-for-digit. **Executed & approved 2026-08-19 (119 s / 170520 KB).** |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are blocking human-verify checkpoints (executed & approved)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none existed)
- [x] No watch-mode flags
- [x] Feedback latency < 30s (per-file vitest runs)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-08-20

---

## Validation Audit 2026-08-20

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

Audit notes: the plan-time seed template was never filled during execution; this audit reconstructed the
map from the six PLAN/SUMMARY pairs. All 12 automated verifies are green (5 re-executed by this audit
2026-08-20; 4 executed by the gsd-security-auditor 2026-08-20; DB-backed suites green per 17-VERIFICATION.md
2026-08-19 with RED/GREEN output pasted in 17-01/17-02 SUMMARYs). The two manual entries are
blocking human-verify checkpoints by design (live production operations), both executed and approved
with pasted evidence — not coverage gaps. No auditor spawn required (zero MISSING/PARTIAL).
