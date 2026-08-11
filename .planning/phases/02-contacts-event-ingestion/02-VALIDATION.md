---
phase: 2
slug: contacts-event-ingestion
status: audited
nyquist_compliant: false
wave_0_complete: true
created: 2026-07-04
audited: 2026-07-05
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Reconstructed retroactively by `/gsd-validate-phase 2` (phase executed before this file was filled).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.x (`apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`); Playwright for e2e (`apps/web/e2e/`) |
| **Config file** | `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts` |
| **Quick run command** | `npm run test -w apps/api -- --run <test-file>` |
| **Full suite command** | `npm test` (workspaces: apps/api + apps/worker; requires local Postgres + Redis) |
| **Estimated runtime** | ~8s (api, 109 tests) + ~1s (worker, 14 tests) |

---

## Sampling Rate

- **After every task commit:** Run the touched module's test file via quick run command
- **After every plan wave:** Run `npm test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~10 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01-01..03, 02-09-01..03 | 01, 09 | CONT-01 | T-02-01-01/02, T-02-09-01 | tenant-isolated CRUD; property deletion persists (CR-04) | integration | `npm run test -w apps/api -- --run src/modules/contacts/__tests__/contact-crud.test.ts` | ✅ | ✅ green |
| 02-07-01..03, 02-12-01..03 | 07, 12 | CONT-02 | T-02-07-01..05, T-02-12-01..03 | streamed upload bounded at 50MB; truncated upload → `failed` + 413 (WR-04); dry-run writes nothing | integration | `npm run test -w apps/api -- --run src/modules/contacts/__tests__/csv-import.test.ts` | ✅ | ✅ green |
| 02-12-* (worker apply) | 12 | CONT-02 | T-02-12-01..03 | idempotent apply, no double-apply (Pitfall-1), WR-03 stillPending→throw | integration | `npm run test -w apps/worker -- --run src/queues/__tests__/imports-csv-idempotency.test.ts` | ✅ | ✅ green |
| 02-03-01..03, 02-04-01..02 | 03, 04 | CONT-03 | T-02-03-01..05, T-02-04-03/04 | uniform 401 on missing/invalid API key | integration | `npm run test -w apps/api -- --run src/modules/contacts/__tests__/contacts-api.test.ts src/modules/api-keys/__tests__/api-key-auth.test.ts` | ✅ | ✅ green |
| 02-04-01..02, 02-11-01..02 | 04, 11 | CONT-04 | T-02-04-01/02, T-02-11-01 | race-safe two-key upsert (CR-02 concurrent-insert), reserved-key strip | integration | `npm run test -w apps/api -- --run src/modules/contacts/__tests__/upsert-priority.test.ts` | ✅ | ✅ green |
| 02-01-*, 02-09-* | 01, 09 | CONT-05 | T-02-04-01, T-02-09-01 | JSONB round-trip verbatim; registry auto-discovery | integration | `npm run test -w apps/api -- --run src/modules/contacts/__tests__/contact-crud.test.ts` | ✅ | ✅ green |
| 02-06-01..03, 02-10-01..03 | 06, 10 | EVNT-01 | T-02-06-01..05, T-02-10-01/02 | batch ≤1000 (D-24), envelope validation, cross-tenant jobId (CR-01) | integration | `npm run test -w apps/api -- --run src/modules/events/__tests__/events-api.test.ts src/modules/contacts/__tests__/contact-events-read.test.ts` | ✅ | ✅ green |
| 02-04-*, 02-06-* | 04, 06 | EVNT-02 | T-02-06-02/03/04 | unknown-contact auto-create, idempotent (Pitfall-1/4) | integration | `npm run test -w apps/worker -- --run src/queues/__tests__/events-ingest-idempotency.test.ts` | ✅ | ✅ green |
| 02-05-*, 02-06-*, 02-10-* | 05, 06, 10 | EVNT-03 | T-02-05-01/02, T-02-10-02 | 2xx fast-path writes nothing synchronously; out-of-window occurredAt → DEFAULT partition (CR-03) | integration | `npm run test -w apps/api -- --run src/modules/events/__tests__/events-api.test.ts` + worker idempotency test | ✅ | ✅ green |
| 02-01-*, 02-02-*, 02-11-* | 01, 02, 11 | SUBS-01 | T-02-01-02, T-02-11-02 | 3-state enum, D-08 suppression survives re-create, D-12 asymmetric transitions (WR-06) | integration | `npm run test -w apps/api -- --run src/modules/contacts/__tests__/subscription-status.test.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

Checkpoint tasks with `<human-check>` only (no automated command, by design): 02-02 Task 3 (contact UI human-verify), 02-05 Task 1 (package-legitimacy checkpoint), 02-08 Task 3 (CSV wizard + feed human-verify).

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No Wave 0 stubs needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Contact CRUD browser UI (list search/filter/sort/pagination, create/edit form, custom-property editor, suppressed lock, delete dialog) | CONT-01 | No Playwright spec covers Phase-2 UI; needs live stack (Postgres+Redis+api+worker+web) | 02-UAT.md items 1–5 |
| ContactForm null-emission on cleared fields (browser half of CR-04) | CONT-01/CONT-05 | `apps/web` has no unit-test runner configured; end-to-end clear-and-reload | 02-UAT.md item 3 |
| CSV import wizard UI (5-step flow, progress polling, navigate-away/resume, error-CSV download, history re-entry) | CONT-02 | Multi-step live browser interaction + file download | 02-UAT.md items 6–8 |
| Live event feed rendering on contact card (expandable JSON, D-14) | EVNT-01 | Visual confirmation of feed rendering | 02-UAT.md item 9 |
| UI-SPEC visual fidelity (spacing/typography/Russian copy) | all UI reqs | Design review, not grep-verifiable | 02-UAT.md item 10 |
| WR-09: dead pooled-connection destroy on failed ROLLBACK (`client.release(err)`) | hardening (02-11-03) | Requires fault-injection harness (backend-PID kill mid-ROLLBACK) that does not exist; currently proven by source assertion only | Build harness or accept source-assertion proof before Phase 4 |

Follow-up candidates (not blocking): `apps/web/e2e/contacts-crud.spec.ts`, `apps/web/e2e/csv-import-wizard.spec.ts`, `apps/web/e2e/contact-event-feed.spec.ts`; vitest+RTL setup for `apps/web`.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies (3 checkpoint tasks are `<human-check>` by design)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none needed)
- [x] No watch-mode flags (`--run` everywhere)
- [x] Feedback latency < 10s
- [ ] `nyquist_compliant: true` — **not set**: 6 manual-only verifications remain (web UI + WR-09 fault-injection)

**Approval:** audited 2026-07-05 (retroactive)

---

## Validation Audit 2026-07-05

| Metric | Count |
|--------|-------|
| Gaps found | 6 |
| Resolved | 1 |
| Escalated (manual-only) | 5 |

Resolved: WR-04 truncated/>50MB CSV upload branch — now exercised end-to-end with a real ~52MB synthetic payload asserting 413 + import status `failed`, plus a direct `markCsvImportFailed` repository test (`csv-import.test.ts`, +2 tests). Suites after audit: apps/api 109/109, apps/worker 14/14, all green.
