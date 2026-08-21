---
phase: 20
slug: campaign-template-correctness
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-21
validated: 2026-08-21
---

# Phase 20 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x (per-workspace: apps/api, apps/worker, apps/web node lane, packages/db) + Playwright (apps/web e2e via `run-e2e.ts`) |
| **Config file** | per-workspace `vitest.config.ts`; `apps/web/playwright.config.ts` |
| **Quick run command** | `npm run test -w <workspace> -- <filter>` (filtered vitest per touched workspace) |
| **Full suite command** | `npm run test -w apps/api && npm run test -w apps/worker && npm run test -w apps/web && npm run test:migrations` |
| **Estimated runtime** | ~60s quick / ~8 min full (plus ~20s e2e per spec) |

---

## Sampling Rate

- **After every task commit:** Run the task's filtered vitest command (see Per-Task Map)
- **After every plan wave:** Run the touched workspace's full `npm run test -w <workspace>`
- **Before `/gsd-verify-work`:** Full suite must be green (`test:migrations` included)
- **Max feedback latency:** ~120 seconds (filtered lanes)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 20-01-01 | 01 | 1 | TMPL-02 | T-20-01-01/02 | expand-only ADD COLUMN, empty diff vs 0066 snapshot | migration | `npm run lint:migrations && npm run db:check-empty-diff -w packages/db` | ✅ | ✅ green |
| 20-01-02 | 01 | 1 | TMPL-02 | T-20-01-03 | tier + hand-verified inverse registered; rehearsal green | integration | `npm run test:migrations` | ✅ | ✅ green (advisory-lock flake triaged, isolation re-run 2/2) |
| 20-01-03 | 01 | 1 | TMPL-02 | — | `campaigns.version` applied to dev DB | ops | `npm run migrate:prod` (+ `information_schema.columns` read) | ✅ | ✅ green |
| 20-02-01 | 02 | 2 | TMPL-02 | T-20-02-01/02/05 | launch version compared inside `SELECT … FOR UPDATE`; stale row untouched; 400/409 paths | integration | `npm run test -w apps/api -- campaigns` | ✅ | ✅ green (56 tests, 7 files) |
| 20-02-02 | 02 | 2 | TMPL-02 | T-20-02-04 | client echoes `campaign.version`; no empty-body launch compiles | build+unit | `npm run build -w apps/web && npm run test -w apps/web` | ✅ | ✅ green |
| 20-03-01 | 03 | 3 | TMPL-02 | T-20-03-01 | schedule takes locked precondition; cancel bumps version | integration | `npm run test -w apps/api -- campaigns` | ✅ | ✅ green |
| 20-03-02 | 03 | 3 | TMPL-02, TMPL-03 | T-20-03-02/03/06 | test-send locked precondition; snapshot captured into job payload at enqueue | integration | `npm run test -w apps/api -- campaigns` | ✅ | ✅ green |
| 20-04-01 | 04 | 4 | TMPL-03 | T-20-04-01 | dispatcher prefers test-send snapshot, falls back to row when absent | unit | `npm run test -w apps/worker -- test-send-template-snapshot` | ✅ | ✅ green (6 cases) |
| 20-04-02 | 04 | 4 | TMPL-03 | T-20-04-01 | `kind='campaign'`/`kind='flow'` paths ignore snapshot fields, re-derive from row | unit | `npm run test -w apps/worker -- test-send-template-snapshot` | ✅ | ✅ green |
| 20-05-01 | 05 | 4 | TMPL-01 | T-20-05-01 | pure dirty comparison over name/segmentId/templateId/fromSenderId | unit | `npm run test -w apps/web -- campaignDirtyState` | ✅ | ✅ green |
| 20-05-02 | 05 | 4 | TMPL-01 | T-20-05-03 | builder publishes form state; banner renders; no render loop | build+unit | `npm run build -w apps/web && npm run test -w apps/web` | ✅ | ✅ green |
| 20-05-03 | 05 | 4 | TMPL-01 | T-20-05-01/02 | launch/schedule/test-send all disabled while dirty, inline reasons | unit | `npm run test -w apps/web -- campaign-dirty-blocking` | ✅ | ✅ green (37 web tests across the 3 files) |
| 20-06-01 | 06 | 5 | TMPL-01, TMPL-02 | T-20-06-01/02/04 | typed 409 classification, no auto-retry, no `err.message` rendered | unit | `npm run test -w apps/web -- campaignSendConflict` | ✅ | ✅ green |
| 20-06-02 | 06 | 5 | TMPL-01, TMPL-02 | T-20-06-01 | e2e: SC1 unsaved-blocking, SC3 single-request conflict, D-09 dialog survives status refetch | e2e | `npm run test:e2e -w apps/web -- campaign-template-correctness` | ✅ | ✅ green (3/3 passed 2026-08-21, this audit — previously blocked by dev-stack ports 4000/5173) |
| 20-06-03 | 06 | 5 | TMPL-01, TMPL-02 | — | full marketer flow against a real SendGrid template | manual | — (checkpoint:human-verify, blocking gate — passed during execution) | — | ✅ manual |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements — vitest lanes and the Playwright e2e harness (`run-e2e.ts` with ephemeral database) predate this phase; no framework installs were needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full marketer flow against a real SendGrid account (two Dynamic Templates, real key) | TMPL-01, TMPL-02, TMPL-03 | Requires a live SendGrid tenant key and real Dynamic Templates; asserts the actual received email carries the selected template — outside any local/CI harness | `npm run dev`, open a draft campaign at `/w/{slug}/campaigns/{id}`; edit template without saving → all three send actions disabled with reason; save → re-enabled; trigger a version conflict from a second tab → dialog stays open with conflict copy, single request; test-send → received email uses the saved template (20-06-PLAN Task 3 checkpoint — passed during phase execution) |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (20-06-03 is a sanctioned blocking human checkpoint)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none — existing infra)
- [x] No watch-mode flags
- [x] Feedback latency < 120s (filtered lanes)
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-08-21

---

## Validation Audit 2026-08-21

| Metric | Count |
|--------|-------|
| Gaps found | 1 |
| Resolved | 1 |
| Escalated | 0 |

Gap detail: `apps/web/e2e/campaign-template-correctness.spec.ts` existed (3 real tests, lint/typecheck clean) but had never been executed — ports 4000/5173 were held by the running dev stack in the implementation and verification sessions (`reuseExistingServer: false`). Resolved in this audit: dev stack no longer occupying the ports, spec executed directly — **3/3 passed in 19.5s** against an ephemeral database (`mega_crm_test_e2e_b2aaa467`, dropped after the run). No new tests were generated; no auditor subagent was required.
