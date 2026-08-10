---
phase: 12
slug: worker-reliability-tenant-fairness
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-10
validated: 2026-08-10
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Filled at plan time from the eleven plans; sign-off remains with `/gsd-validate-phase`.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.9 (per-workspace configs) |
| **Config file** | `apps/worker/vitest.config.ts`, `apps/api/vitest.config.ts`, `packages/queue-core/vitest.config.ts` (created by 12-02) |
| **Quick run command** | `vitest run --root apps/worker <changed test file>` |
| **Full suite command** | `npm test --workspace=apps/worker && npm test --workspace=apps/api && npm test --workspace=packages/queue-core && npm run failure:all` |
| **Estimated runtime** | quick ~5-30s per file; `failure:all` grows by two scenarios this phase (fairness, sweep resume) |

---

## Sampling Rate

- **After every task commit:** Run the task's own `<automated>` command
- **After every plan wave:** Run `npm test --workspace=apps/worker` plus the workspace suite the wave touched
- **Before `/gsd-verify-work`:** full suites green in all three workspaces, plus `npm run failure:all`
- **Max feedback latency:** 60 seconds for a task-level command

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 12-01-01 | 01 | 1 | WRK-01 | T-12-01-01 | One tenant's ceiling cannot stall the lane for other tenants | unit | `vitest run --root apps/worker src/queues/__tests__/tenant-deferral.test.ts` | ✅ | ✅ green |
| 12-01-02 | 01 | 1 | WRK-01 | T-12-01-01 | Deferral proven at the worker-wrapper layer | failure-injection | `npm run failure:429` | ✅ | ✅ green |
| 12-03-01 | 03 | 1 | WRK-02 | T-12-03-01 | Fail-closed cap; lease reclaims a crashed holder's slot | unit (RED) | `vitest run --root apps/worker src/queues/__tests__/tenant-lane-semaphore.test.ts` | ✅ | ✅ green |
| 12-03-02 | 03 | 1 | WRK-02 | T-12-03-01/02/03/04 | Per-holder lease expiry; malformed override cannot widen the cap | unit (GREEN) | `vitest run --root apps/worker src/queues/__tests__/tenant-lane-semaphore.test.ts` | ✅ | ✅ green |
| 12-06-01 | 06 | 1 | WRK-05, WRK-06 | T-12-06-04 | Checkpoint rows fail closed across tenants | migration | `npm run test:migrations` (see audit note on `db:migrate` CLI) | ✅ | ✅ green |
| 12-06-02 | 06 | 1 | WRK-05, WRK-06 | T-12-06-01/02/03 | Scan role unchanged; pages bounded; payload versions validated | unit | `npm test --workspace=apps/worker` | ✅ | ✅ green |
| 12-06-03 | 06 | 1 | WRK-06 | T-12-06-05 | Resume without full re-scan; cursor reset prevents a skipped contact | failure-injection | `npm run failure:segment-sweep-resume` | ✅ | ✅ green |
| 12-02-01 | 02 | 2 | WRK-11 | T-12-02-01 | Retention stays a required per-queue parameter | unit | `npm test --workspace=packages/queue-core` | ✅ | ✅ green |
| 12-02-02 | 02 | 2 | WRK-11 | T-12-02-03 | No second import path to the moved definitions | typecheck+unit | `npx tsc -p apps/worker/tsconfig.json --noEmit && npm test --workspace=apps/worker` | ✅ | ✅ green |
| 12-02-03 | 02 | 2 | WRK-11 | T-12-02-01 | Differentiated retention preserved at its call site | typecheck+unit | `npx tsc -p apps/worker/tsconfig.json --noEmit && npm test --workspace=apps/worker` | ✅ | ✅ green |
| 12-04-01 | 04 | 3 | WRK-02 | T-12-04-01/02/03 | Slot released on every exit; claim released before deferral | typecheck+unit | `npx tsc -p apps/worker/tsconfig.json --noEmit && npm test --workspace=apps/worker` | ✅ | ✅ green |
| 12-04-02 | 04 | 3 | WRK-02 | T-12-04-01/02 | Cap defers rather than fails; cross-tenant isolation | integration | `vitest run --root apps/worker src/queues/__tests__/tenant-concurrency-cap.test.ts` | ✅ | ✅ green |
| 12-11-01 | 11 | 3 | WRK-11 | T-12-11-01/02 | Divergent non-BullMQ client left intact | typecheck+unit | `npx tsc -p apps/api/tsconfig.json --noEmit && npm test --workspace=apps/api` | ✅ | ✅ green |
| 12-11-02 | 11 | 3 | WRK-11 | T-12-11-01 | Duplicate definition cannot return unnoticed | unit | `vitest run --root apps/worker src/queues/__tests__/queue-core-single-definition.test.ts` | ✅ | ✅ green |
| 12-05-01 | 05 | 4 | WRK-03 | T-12-05-01/02 | No live provider traffic; no vacuous fairness pass | failure-injection | `vitest run --root apps/worker src/queues/__tests__/failure-injection/tenant-fairness.test.ts` | ✅ | ✅ green |
| 12-05-02 | 05 | 4 | WRK-04 | T-12-05-01/03 | Sustained rate without backlog growth; sourced rationale | load test | `npm run loadtest:tenant-rps` | ✅ | ✅ green |
| 12-05-03 | 05 | 4 | WRK-03 | T-12-05-02 | Fairness regression caught on every pull request | CI wiring | `npm run failure:all` | ✅ | ✅ green |
| 12-07-01 | 07 | 4 | WRK-10 | T-12-07-03 | Platform-scoped tables; scan role granted nothing | migration | `npm run test:migrations && npm run lint:migrations` (see audit note on `db:migrate` CLI) | ✅ | ✅ green |
| 12-07-02 | 07 | 4 | WRK-10 | T-12-07-01/02/04 | Redacted payload; idempotent terminal record | integration | `vitest run --root apps/worker src/queues/__tests__/dead-letter-writer.test.ts` | ✅ | ✅ green |
| 12-07-03 | 07 | 4 | WRK-08 | T-12-07-02 | A rejecting hook cannot kill the worker process | unit | `npm test --workspace=packages/queue-core` | ✅ | ✅ green |
| 12-08-01 | 08 | 5 | WRK-13 | T-12-08-02/04 | Registration failure logged, never fatal; no duplicate schedule | integration | `vitest run --root apps/worker src/queues/__tests__/scheduler-registration.test.ts` | ✅ | ✅ green |
| 12-08-02 | 08 | 5 | WRK-07 | T-12-08-01/05 | Every handle closed; in-flight job not dropped | integration | `vitest run --root apps/worker src/__tests__/graceful-shutdown.test.ts` | ✅ | ✅ green |
| 12-08-03 | 08 | 5 | WRK-08, WRK-07 | T-12-08-03 | Exhaustive listener coverage; drain budget documented | integration | `vitest run --root apps/worker src/queues/__tests__/shared-error-listener.test.ts` | ✅ | ✅ green |
| 12-10-01 | 10 | 6 | WRK-10 | T-12-10-01/02 | Alert carries no job payload; window not consumed by a failed send | integration | `vitest run --root apps/api src/modules/ops/__tests__/dead-letter-watchdog.test.ts` | ✅ | ✅ green |
| 12-10-02 | 10 | 6 | WRK-10 | T-12-10-03 | End-to-end: exhausted job reaches an operator | integration | `vitest run --root apps/api src/modules/ops/__tests__/dead-letter-watchdog.test.ts` | ✅ | ✅ green |
| 12-09-01 | 09 | 7 | WRK-09 | T-12-09-01/02/03 | Bound outlives the reconciliation window; differentiated policy intact | unit | `npm test --workspace=packages/queue-core` | ✅ | ✅ green |
| 12-09-02 | 09 | 7 | WRK-09 | T-12-09-02/03 | No queue keeps failed jobs indefinitely | unit | `vitest run --root apps/worker src/queues/__tests__/failed-job-retention.test.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Every gap below is created by the plan that first needs it — there is no separate Wave 0 plan, because each test file is authored inside the task whose behavior it verifies (and, for 12-03, before it).

- [x] `apps/worker/src/queues/__tests__/tenant-deferral.test.ts` — WRK-01 (created by 12-01)
- [x] `apps/worker/src/queues/__tests__/tenant-lane-semaphore.test.ts` — WRK-02 (created by 12-03, RED gate)
- [x] `apps/worker/src/queues/__tests__/tenant-concurrency-cap.test.ts` — WRK-02 (created by 12-04)
- [x] `apps/worker/src/queues/__tests__/failure-injection/tenant-fairness.test.ts` + `apps/worker/src/queues/__tests__/loadtest/tenant-rps-sustained.test.ts` — WRK-03/04 (created by 12-05)
- [x] `apps/worker/src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts` — WRK-05/06 (created by 12-06)
- [x] `apps/worker/src/queues/__tests__/dead-letter-writer.test.ts` + `packages/queue-core/src/__tests__/error-listeners.test.ts` — WRK-08/10 (created by 12-07)
- [x] `apps/worker/src/__tests__/graceful-shutdown.test.ts`, `apps/worker/src/queues/__tests__/shared-error-listener.test.ts`, `apps/worker/src/queues/__tests__/scheduler-registration.test.ts` — WRK-07/08/13 (created by 12-08)
- [x] `apps/worker/src/queues/__tests__/failed-job-retention.test.ts` — WRK-09 (created by 12-09)
- [x] `apps/api/src/modules/ops/__tests__/dead-letter-watchdog.test.ts` — WRK-10 (created by 12-10)
- [x] `apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts` — WRK-11 (created by 12-11)
- [x] `packages/queue-core/vitest.config.ts` + `packages/queue-core/src/__tests__/queue-options.test.ts` — new workspace test lane (created by 12-02)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| The container stop-grace period is actually applied to the deployed worker | WRK-07 | The value is derived and documented here; the container runtime that consumes it is configured in the deployment phase, so nothing in this repository can assert the deployed setting | Confirm the deployment phase reads `WORKER_STOP_GRACE_PERIOD_SECONDS` from `apps/worker/src/shutdown-budget.ts` and sets the runtime's stop timeout to at least that value; verify by observing a deploy where an in-flight send completes rather than landing in the ambiguous state |
| Multi-instance execution exclusivity | WRK-13 | Out of scope for this milestone by explicit decision; the phase documents the single-instance constraint rather than asserting safety (flagged assumption A-1) | Not verified. Any future multi-instance move must first add an execution-exclusivity mechanism and its own test |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved — /gsd-validate-phase, 2026-08-10

---

## Validation Audit 2026-08-10

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

All 16 Wave 0 test files exist on disk and every mapped command runs green, verified in this audit run:

- `npm test --workspace=apps/worker` — 60 files, 396/396 tests
- `npm test --workspace=apps/api` — 62 files, 397/397 tests
- `npm test --workspace=packages/queue-core` — 2 files, 22/22 tests
- `npm run failure:all` — all 10 scenarios green (incl. the two added this phase: `failure:segment-sweep-resume`, `failure:tenant-fairness`)
- `npm run loadtest:tenant-rps` — 1/1
- `npm run test:migrations` — 10 files, 56/56; `npm run lint:migrations` — 55 files, no violations
- `npx tsc --noEmit` for `apps/worker` and `apps/api` — both exit 0

**Command substitution (recorded, not silent):** rows 12-06-01 and 12-07-01 originally listed `npm run db:migrate && …`. The drizzle-kit CLI hangs in this sandbox (Node v26 vs drizzle-kit's Node 22 target — documented independently in the 12-06 and 12-07 SUMMARYs as a pre-existing environment issue, not a migration defect). Migrations are proven through the programmatic path instead: `test:migrations` applies the full chain from empty and incrementally via `@mega-crm/test-support`, and every `apps/worker` test that provisions an ephemeral database applies it again. The map rows now reference the programmatic command.

The two Manual-Only rows are plan-time exclusions for out-of-repo behavior (deploy-time stop-grace consumption, multi-instance exclusivity), not escalations from this audit; WRK-07 and WRK-13 each retain green automated coverage (12-08-01/02/03). Phase is Nyquist-compliant.
