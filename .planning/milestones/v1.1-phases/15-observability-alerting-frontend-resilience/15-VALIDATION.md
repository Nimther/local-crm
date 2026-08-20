---
phase: 15
slug: observability-alerting-frontend-resilience
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-14
validated: 2026-08-19
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x (per-workspace `vitest.config.ts`), Playwright for apps/web e2e |
| **Config file** | root `vitest.config.ts` + per-workspace configs (apps/api, apps/web, apps/worker, packages/*, scripts) |
| **Quick run command** | `npx vitest run --root <workspace> <test-file>` |
| **Full suite command** | `npm test` (workspaces aggregate) — prefer per-package `npx vitest run --root <pkg>` on this machine (full-suite load flakes advisory-lock/flow-run-advance tests) |
| **Estimated runtime** | ~2–12 s per targeted workspace run; minutes for full aggregate |

---

## Sampling Rate

- **After every task commit:** Run the task's `<automated>` verify command (targeted vitest / gate script)
- **After every plan wave:** Run the affected workspace suite (`npx vitest run --root <workspace>`)
- **Before `/gsd-verify-work`:** Full suite must be green (CI); locally, per-package runs green
- **Max feedback latency:** ~60 s (largest targeted workspace run: apps/api ops suite ~12 s)

---

## Per-Task Verification Map

All 22 plans executed. This audit (2026-08-19) re-ran targeted test suites and repo gate scripts and verified all referenced test files exist; build/docker legs and one-time demonstrations are taken from execution records (see re-verification note below the table for exactly what ran).

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 15-01-01 | 01 | 1 | OPS-06/08/14 | — | Human package-legitimacy gate | checkpoint | — (blocking-human, approved with fresh registry reads) | n/a | ✅ green |
| 15-01-02 | 01 | 1 | OPS-06/08/14 | — | Pinned deps, lockfile guard | gate | `npm ls … && npm run check:lockfile-npm10 && npm run lint` | ✅ | ✅ green |
| 15-01-03 | 01 | 1 | OPS-06/08/14 | — | No migration drift | gate | `npm run lint:migrations` + no-migration diff guard | ✅ | ✅ green |
| 15-02-01 | 02 | 2 | OPS-11/12/06 | — | N/A | unit | `npx vitest run --root packages/tenant-context src/__tests__/correlation-context.test.ts` | ✅ | ✅ green |
| 15-02-02 | 02 | 2 | OPS-11/12/06 | — | N/A | integration | `npx vitest run --root packages/tenant-context src/__tests__/application-name-correlation.test.ts` | ✅ | ✅ green |
| 15-02-03 | 02 | 2 | OPS-11/12/06 | — | N/A | integration | `npx vitest run --root apps/worker src/__tests__/correlation-tracer.test.ts` | ✅ | ✅ green |
| 15-03-01 | 03 | 2 | OPS-16 | — | N/A | suite+build | `npm run build -w apps/web && npx vitest run --root apps/web` | ✅ | ✅ green |
| 15-03-02 | 03 | 2 | OPS-16 | — | Fail-closed chunk gate | gate | `npm run build -w apps/web && npm run check:web-chunks` | ✅ | ✅ green |
| 15-04-01 | 04 | 3 | OPS-07 | — | Redaction rules parity | unit | `npx vitest run --root packages/redaction src/__tests__/rules-parity.test.ts` | ✅ | ✅ green |
| 15-04-02 | 04 | 3 | OPS-07 | — | Uniform scrubbed loggers | unit | `npx vitest run --root packages/redaction src/__tests__/logger-uniformity.test.ts` | ✅ | ✅ green |
| 15-05-01 | 05 | 3 | OPS-17 | — | N/A | unit | `npx vitest run --root apps/web src/components/__tests__/QueryErrorState.test.tsx` | ✅ | ✅ green |
| 15-05-02 | 05 | 3 | OPS-17 | — | N/A | suite+build | `npx vitest run --root apps/web && npm run build -w apps/web` | ✅ | ✅ green |
| 15-05-03 | 05 | 3 | OPS-17 | — | N/A | suite+build | `npx vitest run --root apps/web && npm run build -w apps/web` | ✅ | ✅ green |
| 15-06-01 | 06 | 4 | OPS-09 | — | Sentry scrub hook typed vs real SDK | regression | `npx vitest run --root packages/redaction && npm run build -w packages/redaction` | ✅ | ✅ green |
| 15-06-02 | 06 | 4 | OPS-09 | — | PII never reaches Sentry | fixture | `npx vitest run --root packages/redaction src/__tests__/sentry-scrub-fixtures.test.ts` | ✅ | ✅ green |
| 15-06-03 | 06 | 4 | OPS-09 | — | CI gate on scrub fixtures | gate | `npm run check:sentry-redaction` + CI static-job wiring check | ✅ | ✅ green |
| 15-07-01 | 07 | 4 | OPS-17 | — | N/A | suite+build | `npx vitest run --root apps/web && npm run build -w apps/web` | ✅ | ✅ green |
| 15-07-02 | 07 | 4 | OPS-17 | — | N/A | suite+build | `npx vitest run --root apps/web && npm run build -w apps/web` | ✅ | ✅ green |
| 15-07-03 | 07 | 4 | OPS-17 | — | N/A | suite+build+lint | `npx vitest run --root apps/web && npm run build -w apps/web && npm run lint` | ✅ | ✅ green |
| 15-08-01 | 08 | 5 | OPS-06 | — | Wrapped processors, scrubbed errors | unit | `npx vitest run --root apps/worker src/__tests__/processor-wrapper.test.ts` | ✅ | ✅ green |
| 15-08-02 | 08 | 5 | OPS-06 | — | Coverage: every processor wrapped | coverage | `npx vitest run --root apps/worker src/__tests__/processor-wrapper-coverage.test.ts && npx vitest run --root apps/worker` | ✅ | ✅ green |
| 15-08-03 | 08 | 5 | OPS-06 | — | Zero raw console call sites | grep-gate | raw-console grep + full apps/worker suite | ✅ | ✅ green |
| 15-09-01 | 09 | 5 | OPS-19 | — | N/A | unit | `npx vitest run --root apps/web src/features/flows/canvas/__tests__` | ✅ | ✅ green |
| 15-09-02 | 09 | 5 | OPS-19 | — | N/A | suite+build+lint | `npx vitest run --root apps/web && npm run build -w apps/web && npm run lint` | ✅ | ✅ green |
| 15-09-03 | 09 | 5 | OPS-19 | — | N/A | e2e | `npm run test:e2e -w apps/web -- flow-unsaved-changes.spec.ts` | ✅ | ✅ green (4/4 at execution; re-confirmed against live DB in UAT 2026-08-16, test 2) |
| 15-10-00 | 10 | 6 | OPS-08 | — | Human live-DSN decision | checkpoint | — (blocking decision: `proceed-live-dsn`) | n/a | ✅ green |
| 15-10-01 | 10 | 6 | OPS-08 | — | DSN from env only, scrub before send | unit+suite | `npx vitest run --root apps/api src/__tests__/sentry.test.ts && npx vitest run --root apps/api` | ✅ | ✅ green in CI (local: 1 "no DSN" test fails — real DSNs in `~/.config/mega-crm/.env`, environment artifact) |
| 15-10-02 | 10 | 6 | OPS-08 | — | Worker Sentry scrubbed, tagged | unit+suite | `npx vitest run --root apps/worker src/__tests__/sentry.test.ts && npx vitest run --root apps/worker` | ✅ | ✅ green in CI (same local env artifact) |
| 15-10-03 | 10 | 6 | OPS-08 | — | Env names documented, compose invariants | gate | `npm run check:spec-env-coverage && npm run verify:prod-compose` | ✅ | ✅ green |
| 15-11-01 | 11 | 7 | OPS-08/17 | — | Web Sentry DSN build-arg only | unit+build | `npx vitest run --root apps/web src/lib/__tests__/sentry.test.ts && npm run build -w apps/web` | ✅ | ✅ green |
| 15-11-02 | 11 | 7 | OPS-17 | — | Route error boundaries contain failures | suite+build+gate | `npx vitest run --root apps/web && npm run build -w apps/web && npm run check:web-chunks` | ✅ | ✅ green |
| 15-11-03 | 11 | 7 | OPS-08 | — | DSN baked into image verifiably | docker-gate | `npm run check:spec-env-coverage && docker build -f docker/Dockerfile.web …` | ✅ | ✅ green (needs docker to re-run) |
| 15-12-01 | 12 | 8 | OPS-13 | — | Migration tier discipline | unit | `npm run lint:migrations && npm run test:migrations` | ✅ | ✅ green |
| 15-12-02 | 12 | 8 | OPS-13 | — | ops_alert_state no tenant data, concurrency-safe | unit | `npx vitest run --root packages/db src/__tests__/ops-alert-state.test.ts` | ✅ | ✅ green |
| 15-12-03 | 12 | 8 | OPS-18 | — | N/A | unit | rollup-watermark + send-events-dedup-rebase + analytics-reconciliation targeted runs | ✅ | ✅ green |
| 15-13-01 | 13 | 9 | OPS-13 | — | N/A | unit | `npx vitest run --root apps/api src/modules/ops/__tests__ && npm run lint` | ✅ | ✅ green |
| 15-13-02 | 13 | 9 | OPS-13 | — | N/A | unit | `npx vitest run --root apps/api src/modules/ops/__tests__/queue-depth-watchdog.test.ts` | ✅ | ✅ green |
| 15-13-03 | 13 | 9 | OPS-13 | — | Env allowlist extension audited | unit+suite | `npx vitest run --root apps/api src/modules/ops/__tests__/oldest-job-age-watchdog.test.ts && npx vitest run --root apps/api` | ✅ | ✅ green |
| 15-14-01 | 14 | 10 | OPS-13 | — | Migration 0065 human-approved (Rule 4) | unit | `npx vitest run --root apps/api src/modules/ops/__tests__/webhook-lag-watchdog.test.ts` | ✅ | ✅ green |
| 15-14-02 | 14 | 10 | OPS-13 | — | N/A | unit | `npx vitest run --root apps/api src/modules/ops/__tests__/failed-send-share-watchdog.test.ts` | ✅ | ✅ green |
| 15-14-03 | 14 | 10 | OPS-13 | — | All 9 watchdogs wired in server.ts | suite+gate | `npx vitest run --root apps/api && npm run lint && npm run check:spec-env-coverage` | ✅ | ✅ green |
| 15-15-01 | 15 | 10 | OPS-18 | — | N/A | unit | `npx vitest run --root apps/web src/components/__tests__/StaleDataBanner.test.tsx` | ✅ | ✅ green |
| 15-15-02 | 15 | 10 | OPS-18 | — | N/A | suite+build+lint | `npx vitest run --root apps/web && npm run build -w apps/web && npm run lint` | ✅ | ✅ green |
| 15-16-01 | 16 | 11 | OPS-14 | — | Health server contract preserved across migration | contract | `npx vitest run --root apps/worker src/__tests__/health-server-contract.test.ts` | ✅ | ✅ green |
| 15-16-02 | 16 | 11 | OPS-14 | — | Bull Board read-only, shutdown-registered | unit | `npx vitest run --root apps/worker src/__tests__/bull-board.test.ts` | ✅ | ✅ green |
| 15-16-03 | 16 | 11 | OPS-14 | — | N/A | suite+gate+build | `npx vitest run --root apps/worker && npm run verify:prod-compose && npm run build -w apps/worker` | ✅ | ✅ green |
| 15-17-01 | 17 | 12 | OPS-10 | — | Bounded container logging | gate | `npm run verify:prod-compose && docker compose … config --quiet` | ✅ | ✅ green |
| 15-17-02 | 17 | 12 | OPS-10 | — | Alloy service invariants fail-closed | unit+gate | `npm run verify:prod-compose && npx vitest run --root scripts && …` | ✅ | ✅ green |
| 15-17-03 | 17 | 12 | OPS-10 | — | N/A | gate+grep | `npm run check:spec-env-coverage && test -f docs/observability/grafana-cloud-alerts.md && …` | ✅ | ✅ green |
| 15-18-01 | 18 | 13 | OPS-15 | — | No credentials in runbooks | gate | five-runbook existence loop + credential grep | ✅ | ✅ green |
| 15-18-02 | 18 | 13 | OPS-15 | — | Fail-closed runbook coverage gate | gate | `npm run check:runbook-coverage` | ✅ | ✅ green |
| 15-18-03 | 18 | 13 | OPS-15 | — | N/A | gate+lint | `npm run check:spec-env-coverage && npm run check:runbook-coverage && npm run lint` | ✅ | ✅ green |
| 15-19-01 | 19 | 14 | OPS-11 | — | No PII in dispatch log lines (grep-gated) | unit+grep+tsc | correlation-tracer targeted run + 5 grep/node gates + `tsc --noEmit` | ✅ | ✅ green |
| 15-19-02 | 19 | 14 | OPS-11 | — | N/A | doc-gate | SPECIFICATION.md §7 placement node one-liners + `check:spec-env-coverage` | ✅ | ✅ green |
| 15-20-01 | 20 | 15 | OPS-11 | — | No PII in webhook worker log line | unit+grep+tsc | webhook-events-sendid-correlation + 4 sibling suites + grep gates | ✅ | ✅ green |
| 15-20-02 | 20 | 15 | OPS-11 | — | N/A | doc-gate | SPECIFICATION.md §7 placement checks + `check:spec-env-coverage` | ✅ | ✅ green |
| 15-21-01 | 21 | 16 | OPS-15 | — | N/A | doc-gate | ARCHITECTURE.md §18 / SPECIFICATION.md §7 stale-claim + citation node gates | ✅ | ✅ green |
| 15-21-02 | 21 | 16 | OPS-08 | — | No DSN-shaped literals in docs; env_file-only delivery | doc-gate | SPECIFICATION.md §3 row checks + compose env_file assertion + gates | ✅ | ✅ green |
| 15-22-01 | 22 | 17 | OPS-10 | — | Alloy config syntax fail-closed | unit | `npx vitest run --root scripts __tests__/validate-alloy-config.test.mjs` | ✅ | ✅ green |
| 15-22-02 | 22 | 17 | OPS-10 | — | Real `grafana/alloy fmt` exits 0 | unit+docker | targeted vitest + pinned-image `fmt` run | ✅ | ✅ green (docker leg needs docker to re-run) |
| 15-22-03 | 22 | 17 | OPS-10 | — | CI wiring locked by tests | gate+suite | `npm run verify:alloy-config && npx vitest run --root scripts … && npm run lint && npm run check:spec-env-coverage` | ✅ | ✅ green (2 pre-existing lint errors deferred to deferred-items.md at execution; lint clean as of this audit) |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Re-verified 2026-08-19 (this audit):** packages/redaction 29/29 · packages/tenant-context 16/16 · apps/web full suite 84/84 (13 files — the `playwright-package-source-import.test.ts` failure noted in 15-15-SUMMARY is gone) · apps/worker targeted 55/55 · apps/api ops+analytics 134/134 · packages/db targeted 47 passed / 1 by-design skip (rollback rehearsal: newest migration is forward-only, nothing to rehearse) · scripts 51/51 · `npm run lint` clean (the 2 errors 15-22 deferred to `deferred-items.md` have since been fixed) · `check:runbook-coverage` 4/4 · `check:spec-env-coverage` 54/54 · `check:sentry-redaction` 6/6. Not re-run here: web/worker builds, docker legs (docker not running locally), e2e (needs provisioned DB) — those statuses come from execution records and UAT.

**Known environment artifact:** `apps/api` and `apps/worker` `sentry.test.ts` "no DSN" tests fail deterministically on this development machine because `~/.config/mega-crm/.env` carries real DSNs (since 2026-08-16 UAT). They pass in CI. Not a coverage gap.

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. No Wave 0 stubs were needed — every plan shipped its tests inside its own waves.

---

## Manual-Only Verifications

These are inherently human verifications (blocking checkpoints, operator provisioning, visual judgment) — not automatable gaps.

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Package legitimacy of new npm deps (15-01-01) | OPS-06/08/14 | Registry trust is a human judgment; blocking-human checkpoint by design | `npm view <pkg> version` + registry page review; recorded approved at execution |
| Live-DSN decision (15-10-00) | OPS-08 | Business decision to point SDKs at live Sentry projects | Decision `proceed-live-dsn` recorded pre-session |
| Error-state click-throughs with API stopped (15-05, 15-07) | OPS-17 | apps/web vitest runs `environment: "node"` (no jsdom); full render/retry interaction needs a live browser | Stop API, open each converted surface, confirm error state + working Retry; page shell stays usable |
| Route error boundary click-through (15-11) | OPS-08/17 | Same jsdom constraint; SUMMARY D2 `status: unknown` | **Verified in UAT 2026-08-16 (test 1: pass).** Throw in a feature route; confirm contained panel with shell/nav usable; event tagged `route`/`workspace_slug` in mega-crm-web Sentry (EU) |
| Post-deploy Sentry events for API/worker (15-10) | OPS-08 | Requires deployed environment + live Sentry | **Verified in UAT 2026-08-16 (test 3: pass).** Trigger an exception path; confirm event with `workspace_id`/`request_id` tags in the EU-region project |
| Stale-data banner/label visual placement (15-15) | OPS-18 | "Reads as honest to a marketer" is a UI judgment call | Workspace with dirty day shows banner; quiet workspace with old data does not |
| bullmq 5.79.1→5.79.4 lockstep bump ratification (15-16 D8) | OPS-14 | Human must ratify patch-bump classification (not a new-package install) | Confirm classification accepted before ship |
| End-to-end Loki ingestion + Grafana Cloud alert rules firing (15-17, 15-22) | OPS-10 | Depends on operator provisioning outside the repo | **Verified in UAT 2026-08-16 (tests 4 & 5: pass, incl. prod redeploy with committed config.alloy).** LogQL by one `request_id` returns API + worker lines |
| Five end-of-phase operator checks (15-18 `<human-check>`) | OPS-15 | Live infrastructure (SSH tunnel, Sentry projects, dead-man's-switch, alert email) | Bull Board tunnel reachability; Loki correlation query; deliberate exceptions per app; backstop rules + dead-man's-switch; one in-app alert to `OPERATOR_ALERT_EMAIL` with runbook confirmation command |
| §18 byte-unchanged read-back (15-21) | OPS-15 | Doc-diff judgment recorded in SUMMARY | `git diff` read-back of untouched paragraphs; recorded at execution |
| Alloy container stays running at next prod deploy (15-22 `<human-check>`) | OPS-10 | Live deploy observation | Confirm `alloy` container not restarting; log lines keep `service`/`container`/`level` labels |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or are explicit human checkpoints (15-01-01, 15-10-00)
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (none — no Wave 0 needed)
- [x] No watch-mode flags
- [x] Feedback latency < 60s per targeted run
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-08-19

---

## Validation Audit 2026-08-19

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

Audit method: reconstructed the per-task map from all 22 PLAN/SUMMARY pairs (60 tasks), verified all 35 referenced test/gate files exist on disk, and re-ran targeted suites per workspace (all green; see re-verification note above). The two local `sentry.test.ts` "no DSN" failures are a documented machine-specific environment artifact (real DSNs in `~/.config/mega-crm/.env`), green in CI. The `migration-rollback-rehearsal` skip is by design (newest migration is forward-only). Manual-only items are inherently human (checkpoints, operator provisioning, visual judgment) and are catalogued above with instructions.
