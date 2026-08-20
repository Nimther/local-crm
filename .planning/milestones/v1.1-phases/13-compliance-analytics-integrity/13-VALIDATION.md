---
phase: 13
slug: compliance-analytics-integrity
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-11
validated: 2026-08-19
---

# Phase 13 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Retroactively audited and completed by /gsd-validate-phase on 2026-08-19 (phase executed 2026-08-11..12, verification passed 5/5).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.x, per-workspace configs |
| **Config file** | root `vitest.config.ts` + `apps/{api,web,worker}/vitest.config.ts`, `packages/*/vitest.config.ts`, `scripts/vitest.config.ts` |
| **Quick run command** | `npx vitest run --root <workspace> <test-file>` (per-task commands in map below) |
| **Full suite command** | `npm test` (all workspaces) + `npm run failure:all` + `npm run coverage:gate` |
| **Estimated runtime** | single file ~20s; full phase gate ~1451 tests + 13 failure-injection scenarios (13-14-03 measured green) |

> Machine-local caveat: advisory-lock / flow-run-advance tests flake under full-suite load on this dev machine, and `sentry.test.ts` "no DSN" cases fail locally (real DSNs in `~/.config/mega-crm/.env`); both pass in CI. Prefer single-file runs locally.

---

## Sampling Rate

- **After every task commit:** Run the task's automated command (single-file vitest, ~20-60s)
- **After every plan wave:** Run the touched workspace's suite (`npx vitest run --root <workspace>`)
- **Before `/gsd-verify-work`:** Full gate green (`npm run lint && npm run build && npm run test:migrations && npm test && npm run failure:all && npm run coverage:gate`)
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 13-01-01 | 01 | 1 | CMP-08 | T-13-01-01..10 | RLS fail-closed on journal tables; journal-before-enqueue after signature verify | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-journal.test.ts` | ✅ | ✅ green |
| 13-01-02 | 01 | 1 | CMP-08 | T-13-01-SC | Ingress journals before ack; HTTP-level assertions | integration | `npx vitest run --root apps/api src/modules/webhooks/__tests__/ingress-journal.test.ts` | ✅ | ✅ green |
| 13-01-03 | 01 | 1 | CMP-08 | T-13-01-SC | Scan-role narrowed policy; prune/purge tombstone split | migration | `npm run lint:migrations && npm run test:migrations` | ✅ | ✅ green |
| 13-02-01 | 02 | 1 | CMP-02 | T-13-02-01..03 | Session-TZ GUC cannot shift reported days | unit+integration | `npx vitest run --root apps/worker src/queues/__tests__/reconcile-utc-day.test.ts` | ✅ | ✅ green |
| 13-02-02 | 02 | 1 | CMP-02 | T-13-02-SC | Day-authority doc contract (behavior pinned by 13-02-01 tests) | docs-only | `npm run lint && npm run build` | N/A (docs) | ✅ green |
| 13-02-03 | 02 | 1 | CMP-06 | T-13-02-SC | Single scheduler registration, RECONCILE_INTERVAL_MS pinned | integration | `npx vitest run --root apps/worker src/queues/__tests__/scheduler-registration.test.ts` | ✅ | ✅ green |
| 13-03-01 | 03 | 1 | CMP-02 | T-13-03-01..03 | No silent-zero send counts (API) | integration | `npx vitest run --root apps/api src/modules/campaigns/__tests__/campaign-progress-ambiguous.test.ts` | ✅ | ✅ green |
| 13-03-02 | 03 | 1 | CMP-02 | T-13-03-SC | Ambiguous-count rendering (web) | unit | `npx vitest run --root apps/web src/features/campaigns/__tests__/campaign-progress-ambiguous.test.tsx` | ✅ | ✅ green |
| 13-03-03 | 03 | 1 | CMP-02 | T-13-03-SC | Status vocabulary drift guard | unit+integration | `npx vitest run --root apps/web src/features/send-log/__tests__ && npx vitest run --root apps/api src/modules/send-log/__tests__` | ✅ | ✅ green |
| 13-04-01 | 04 | 2 | CMP-05 | T-13-04-01..05 | too_old/too_far_future/unusable timestamp verdicts | unit | `npx vitest run --root packages/delivery-core src/__tests__/occurred-at-bounds.test.ts` | ✅ | ✅ green |
| 13-04-02 | 04 | 2 | CMP-05 | T-13-04-SC | Untrusted timestamp cannot route a partition or enter dedup key | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-occurred-at-bounds.test.ts` | ✅ | ✅ green |
| 13-05-01 | 05 | 2 | CMP-03 | T-13-05-01..05 | Dirty-day marking, tenant isolation | integration | `npx vitest run --root apps/worker src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts` | ✅ | ✅ green |
| 13-05-02 | 05 | 2 | CMP-03 | T-13-05-SC | Race-free conditional clear (`dirtied_at <= sweepStartedAt`) | integration | `npx vitest run --root apps/worker src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts` | ✅ | ✅ green |
| 13-05-03 | 05 | 2 | CMP-03 | T-13-05-SC | Migration additivity (0056 dirtied_at) | migration | `npm run lint:migrations && npm run test:migrations` | ✅ | ✅ green |
| 13-06-01 | 06 | 2 | CMP-08 | T-13-06-01..07 | Replay sweep: replay_count/tombstone/attempt-cap; double-replay idempotent | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-replay-sweep.test.ts` | ✅ | ✅ green |
| 13-06-02 | 06 | 2 | CMP-08 | T-13-06-SC | Scheduler registration + SEC-16 cross-tenant negative | integration | `npx vitest run --root apps/worker src/queues/__tests__/scheduler-registration.test.ts src/queues/__tests__/webhook-replay-sweep.test.ts` | ✅ | ✅ green |
| 13-06-03 | 06 | 2 | CMP-08 | T-13-06-SC | Operator CLI blast-radius bounded to one workspace; dry-run writes nothing | integration | `npx vitest run --root packages/db src/__tests__/replay-webhook-journal-cli.test.ts` | ✅ (added 2026-08-19) | ✅ green (11/11) |
| 13-07-01 | 07 | 3 | CMP-07 | T-13-07-01..09 | Duplicate-count script fail-closed | integration | `npx vitest run --root packages/db src/__tests__/send-events-dedup-rebase.test.ts` | ✅ | ✅ green |
| 13-07-02 | 07 | 3 | CMP-07 | T-13-07-SC | Migration guard: `indisvalid`, no-CONCURRENTLY, two-partition proof | migration | `npm run lint:migrations && npm run test:migrations` | ✅ | ✅ green |
| 13-07-03 | 07 | 3 | CMP-07 | T-13-07-SC | Provider-controlled sg_event_id demoted out of dedup identity | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-dedup-rebase.test.ts` | ✅ | ✅ green |
| 13-08-01 | 08 | 4 | CMP-01 | T-13-08-01..05 | Three-write unsubscribe atomicity (helper unit) | unit | `npx vitest run --root packages/contacts-core src/__tests__/unsubscribe-apply.test.ts` | ✅ | ✅ green |
| 13-08-02 | 08 | 4 | CMP-01 | T-13-08-SC | Convergence both orderings; byte-identical response | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts` | ✅ | ✅ green |
| 13-08-03 | 08 | 4 | CMP-01 | T-13-08-SC | Crash at 3 boundaries leaves no partial state | failure-injection | `npm run failure:unsubscribe-atomic` | ✅ | ✅ green |
| 13-09-01 | 09 | 4 | CMP-09 | T-13-09-04 | Reputation rate tier boundaries pinned | unit | `npx vitest run --root packages/delivery-core src/__tests__/reputation-rates.test.ts` | ✅ | ✅ green |
| 13-09-02 | 09 | 4 | CMP-09 | T-13-09-01/03 | Alert-state table RLS, keyed (workspace_id, metric) PK | migration | `npm run lint:migrations && npm run test:migrations` | ✅ | ✅ green |
| 13-09-03 | 09 | 4 | CMP-09 | T-13-09-02/05/06 | Reputation tick: no send-pausing; SEC-16 negative | integration | `npx vitest run --root apps/worker src/queues/__tests__/reputation-tick.test.ts src/queues/__tests__/scheduler-registration.test.ts` | ✅ | ✅ green |
| 13-10-01 | 10 | 5 | CMP-04 | T-13-10-02/07 | Erasure migration 0059; RLS policy count | migration | `npm run lint:migrations && npm run test:migrations` | ✅ | ✅ green |
| 13-10-02 | 10 | 5 | CMP-04 | T-13-10-01/02/04/06/09 | Anonymize-in-place scrubs all PII columns; gate inverted | integration | `npx vitest run --root apps/api src/modules/contacts/__tests__/contact-erasure.test.ts` | ✅ | ✅ green |
| 13-10-03 | 10 | 5 | CMP-04 | T-13-10-03/05/08 | Anonymized contact excluded from upsert/segments/dashboard | integration | `npx vitest run --root packages/contacts-core && npx vitest run --root apps/api src/modules/contacts/__tests__` | ✅ | ✅ green |
| 13-11-01 | 11 | 5 | CMP-08 | T-13-11-02/05/08/09/10 | Ingestion-health watchdog; real cross-workspace scan grant proof | integration | `npx vitest run --root apps/api src/modules/ops/__tests__/ingestion-health-watchdog.test.ts` | ✅ | ✅ green |
| 13-11-02 | 11 | 5 | CMP-09 | T-13-11-01..04/07 | Escalation/de-escalation/cooldown independence | integration | `npx vitest run --root apps/api src/modules/ops/__tests__/reputation-watchdog.test.ts` | ✅ | ✅ green |
| 13-11-03 | 11 | 5 | CMP-08, CMP-09 | T-13-11-06 | OPERATOR_ALERT_EMAIL env schema (P3 allowlist) | integration | `npx vitest run --root apps/api src/modules/ops/__tests__ src/__tests__/env-schema.test.ts` | ✅ | ✅ green |
| 13-12-01 | 12 | 6 | CMP-04 | T-13-12-03/04/05/07 | HMAC key zeroing, TTL cache, cross-workspace divergence | unit | `npx vitest run --root packages/contacts-core src/__tests__/suppression-hash.test.ts` | ✅ | ✅ green |
| 13-12-02 | 12 | 6 | CMP-04 | T-13-12-02/06 | Hash lookups in suppression/unsubscribe paths (vacuous-JOIN fix) | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-events-suppression.test.ts` | ✅ | ✅ green |
| 13-12-03 | 12 | 6 | CMP-04 | T-13-12-01/02/08 | Expand→backfill→contract migration; fail-closed guard; collision-skip | migration | `npm run lint:migrations && npm run test:migrations` | ✅ | ✅ green |
| 13-13-01 | 13 | 7 | CMP-04 | T-13-13-01/03/06 | Scrub allowlist reconstruction (tenant-invented keys handled) | integration | `npx vitest run --root apps/worker src/queues/__tests__/erasure-scrub.test.ts` | ✅ | ✅ green |
| 13-13-02 | 13 | 7 | CMP-04 | T-13-13-02/04/05 | No scheduler for scrub; SEC-16 negative | integration | `npx vitest run --root apps/worker src/queues/__tests__/erasure-scrub.test.ts src/queues/__tests__/scheduler-registration.test.ts` | ✅ | ✅ green |
| 13-13-03 | 13 | 7 | CMP-04 | T-13-13-02/07 | Kill-resume at both interruption boundaries | failure-injection | `npm run failure:erasure-scrub-resume` | ✅ | ✅ green |
| 13-14-01 | 14 | 9 | CMP-01..09 | T-13-14-01/02 | SPECIFICATION.md migration tags 0055-0061 + object tokens | docs-gate | grep-gate loop (see 13-14-PLAN verify) | N/A (docs) | ✅ green |
| 13-14-02 | 14 | 9 | CMP-02/03/04/05/07/08 | T-13-14-03/04 | ARCHITECTURE.md day-authority + erasure sections | docs-gate | grep-gate (see 13-14-PLAN verify) | N/A (docs) | ✅ green |
| 13-14-03 | 14 | 9 | CMP-01..09 | gate | Full phase gate | full-gate | `npm run lint && npm run build && npm run test:migrations && npm test && npm run failure:all && npm run coverage:gate` | ✅ | ✅ green (1451 tests, 87.08% cov) |
| 13-15-01 | 15 | 8 | CMP-04 | T-13-15-01..03/05..08 | Reclaim lease boundaries; shared jobId derivation | integration | `npx vitest run --root apps/worker src/queues/__tests__/erasure-scrub-reclaim.test.ts` | ✅ | ✅ green |
| 13-15-02 | 15 | 8 | CMP-04 | T-13-15-01/04 | Commit-gap crash recovery end-to-end | failure-injection | `npm run failure:erasure-enqueue-crash` | ✅ | ✅ green |
| 13-16-01 | 16 | 10 | CMP-04 | T-13-16-01/02/04 | Quarantine retention keyed on server-set received_at only | integration | `npx vitest run --root packages/db src/__tests__/quarantine-retention.test.ts` | ✅ | ✅ green (10/10) |
| 13-16-02 | 16 | 10 | CMP-04 | T-13-16-03/05 | Prune wired into replay-sweep tick; independent horizons | integration | `npx vitest run --root apps/worker src/queues/__tests__/webhook-replay-sweep.test.ts` | ✅ | ✅ green (59/59) |
| 13-16-03 | 16 | 10 | CMP-04 | T-13-16-06 | Docs + migration-freeze gate | docs-gate | `npm run lint:migrations && npm run test:migrations && grep -q pruneSendEventQuarantine SPECIFICATION.md` | N/A (docs) | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Green evidence: 13-VERIFICATION.md re-verification pass (2026-08-12, 5/5 truths, tests re-run directly) + 13-14-03 full phase gate (1451 tests) + `replay-webhook-journal-cli.test.ts` run directly 2026-08-19 (11/11).

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

These are live-environment UAT walkthroughs deferred per `human_verify_mode=end-of-phase`; each has a passing automated equivalent (they supplement, not replace, the map above). Full instructions in 13-VERIFICATION.md `human_verification` and 13-14-SUMMARY.md checklist.

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Unsubscribe atomicity on a real campaign send + webhook replay | CMP-01 | Needs live dev env, real campaign, real/replayed SendGrid webhook | 13-VERIFICATION.md human_verification #1 |
| Daily numbers stable under session timezones + 4-day-late event | CMP-02/03/06 | Needs running worker tick + direct DB session TZ control | 13-VERIFICATION.md human_verification #2 |
| Erasure end-to-end incl. quarantine row survive-then-expire | CMP-04 | Needs live scrub worker, re-import round trip, 7-day horizon (or backdate) | 13-VERIFICATION.md human_verification #3 |
| Out-of-range + unstable-sg_event_id events via live webhook | CMP-05/07 | Needs live webhook delivery against running API | 13-VERIFICATION.md human_verification #4 |
| Backfill after worker outage + complaint alerts to real inbox | CMP-08/09 | Needs live SendGrid webhook endpoint, real inbox, worker stop/restart | 13-VERIFICATION.md human_verification #5 |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none — existing infra)
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-08-19

---

## Validation Audit 2026-08-19

| Metric | Count |
|--------|-------|
| Gaps found | 1 |
| Resolved | 1 |
| Escalated | 0 |

Gap detail: 13-06-03 (CMP-08) — operator replay CLI behavior tests were run as throwaway self-verification during execution but never committed (13-06-SUMMARY deviation D6). Resolved by `packages/db/src/__tests__/replay-webhook-journal-cli.test.ts` (11 tests: fail-closed arg validation, dry-run makes no writes, tombstone skip, range bounds, keyset pagination, ingested-row re-enqueue intent).

---

## Validation Re-Audit 2026-08-19 (second pass)

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

Re-audit checks: all 28 mapped test files/dirs exist on disk; all 3 referenced failure-injection scripts (`failure:unsubscribe-atomic`, `failure:erasure-scrub-resume`, `failure:erasure-enqueue-crash`) defined in root `package.json`; task-ID diff against all 16 SUMMARYs found no unmapped tasks (8 near-misses were `T-13-XX-YY` threat refs); spot re-run of `replay-webhook-journal-cli.test.ts` green (11/11, 20.5s); prior gap-fill test committed (`cd6548f`, lint-fixed in `20683cb`). Map, statuses, and `nyquist_compliant: true` unchanged.
