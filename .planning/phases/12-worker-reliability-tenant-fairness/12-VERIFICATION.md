---
phase: 12-worker-reliability-tenant-fairness
verified: 2026-08-10T17:49:52Z
status: passed
score: 12/12 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 12: Worker Reliability & Tenant Fairness Verification Report

**Phase Goal:** One tenant's limits, one oversized segment, or a restart cannot degrade the rest of the platform; background work is bounded, resumable and observable.
**Verified:** 2026-08-10T17:49:52Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria + PLAN must-haves)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Under load, tenant A over its rate limit does not measurably affect tenant B's throughput; the configured per-tenant RPS is backed by a load test or documented provider guidance | ✓ VERIFIED | `apps/worker/src/queues/__tests__/failure-injection/tenant-fairness.test.ts` (CI-resident, 3/3 pass) measures tenant B's contended throughput against its own solo baseline (ratio ≥ `TENANT_FAIRNESS_MIN_BASELINE_RATIO = 0.9`). `loadtest:tenant-rps` (on-demand, ran live: 1/1 pass, 17.2s) sustains `DEFAULT_TENANT_RPS` without queue depth growth. `rate-limiter.ts`'s `DEFAULT_TENANT_RPS = 10` doc comment cites SendGrid's Web API v3 docs (retrieved 2026-08-10) plus the BYO-key plan-tier caveat, and the sustained run as the platform-side proof. |
| 2 | A single tenant cannot occupy more than its configured share of worker slots while other tenants have queued work | ✓ VERIFIED | `apps/worker/src/queues/tenant-lane-semaphore.ts` (TTL-leased sorted-set semaphore, keyed tenant+lane), wired into all three dispatch paths in `send-dispatch.ts` (`acquireTenantLaneSlot`/`releaseTenantLaneSlot` in `finally`, 3 call sites, 3 `finally` releases). `tenant-lane-semaphore.test.ts` (17/17 pass) and `tenant-concurrency-cap.test.ts` (12/12 pass) prove boundary, lease-expiry, tenant/lane isolation and release-on-every-exit-path. |
| 3 | A segment sweep completes in bounded pages with short transactions and resumes from checkpoint after a kill without reprocessing everything | ✓ VERIFIED | `flow-segment-sweep-flow.worker.ts` keyset-paginates on `contacts.id` (`c.id > $cursor ORDER BY c.id ASC LIMIT 500`), per-page `statement_timeout` (15s), checkpoint advance on the same transaction/client as enrollment writes (`packages/db/migrations/0053_flow_segment_sweep_checkpoint.sql`, RLS-protected tenant table). `failure:segment-sweep-resume` (1/1 pass, live run) proves resume-without-reprocessing across a simulated kill. Cursor resets to `null` on completing a full walk (`resetSweepCheckpoint`). Deterministic per-flow `jobId` prevents double-enqueue; stale-snapshot cleanup batches at 1000 rows. Discovery still uses the scan role; per-flow walk re-enters `withTenant`. |
| 4 | SIGTERM drains in-flight jobs and closes every Queue handle; every worker (including repeatable ticks) reports through one shared listener; multi-instance assumptions are written down | ✓ VERIFIED | `apps/worker/src/server.ts`'s `closeWorkerRuntime` closes all 16 registered `Worker`s first, then `closeTrackedQueues()` (queue-registry.ts), then disconnects the shared connection — ordering asserted by `graceful-shutdown.test.ts` (part of the 96/96 passing suite run). `attachSharedListeners(workers)` wires `attachSharedErrorListeners` (error+failed) over the full worker array including every repeatable-tick worker; `shared-error-listener.test.ts` and `scheduler-registration.test.ts` pass (part of same 96/96 run). `ARCHITECTURE.md` §10 states multi-instance execution-exclusivity is NOT provided by `upsertJobScheduler` and names single-instance deployment as an explicit v1.1 constraint. |
| 5 | Failed jobs age out under a per-queue retention policy; terminal failures land in an observable dead-letter path; Redis connection options/`defaultJobOptions`/TTL values have exactly one definition | ✓ VERIFIED | `packages/queue-core/src/queue-options.ts`: `FAILED_JOB_RETENTION_SECONDS = 7 days` (bounded, outlives the 72h reconciliation window with margin), `STANDARD_JOB_RETENTION` vs. `FLOW_RUN_ADVANCE_RETENTION` preserved as two distinct, per-queue-selected shapes via `buildJobOptions(retention)`. Every Queue-constructing module in both `apps/api` and `apps/worker` (12 guarded modules) imports `buildRedisConnectionOptions`/`buildJobOptions` from `@mega-crm/queue-core` — enforced by `queue-core-single-definition.test.ts` (12/12 modules pass: import present, no local connection builder, no local job-option literal), which also asserts cross-process identical output. Dead-letter path: `dead_letter_jobs` table (migration 0054, no RLS, no scan-role grant — platform-ops scoped) + `writeDeadLetterOnTerminalFailure` (redacted via `@mega-crm/redaction`'s `scrub`) wired through `attachSharedErrorListeners`'s `onTerminalFailure` hook; `dead-letter-watchdog.ts` (apps/api) alerts on unacknowledged rows with dedup, wired at boot in `apps/api/src/server.ts`. `dead-letter-writer.test.ts` (worker), `error-listeners.test.ts`/`queue-options.test.ts` (queue-core), `failed-job-retention.test.ts`, `dead-letter-watchdog.test.ts` (api) all pass. |

**Score:** 5/5 roadmap success criteria verified; 12/12 requirement-mapped truths across all 11 plans verified. 0 present-but-behavior-unverified.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/worker/src/queues/tenant-deferral.ts` | `deferForTenantBucket` shared deferral primitive | ✓ VERIFIED | Exports match plan; used by both lane workers |
| `apps/worker/src/queues/email-broadcast.worker.ts` / `email-triggered.worker.ts` | Both call `deferForTenantBucket` for `tenant_bucket` cause only | ✓ VERIFIED | Both files import and call it identically; `provider_backoff` still throws (bounded attempt) |
| `packages/queue-core/*` | Single Redis connection + queue-options + error-listener + dead-letter-writer definitions | ✓ VERIFIED | All exports present (`buildRedisConnectionOptions`, `createRedisConnection`, `buildJobOptions`, `STANDARD_JOB_RETENTION`, `FLOW_RUN_ADVANCE_RETENTION`, `attachSharedErrorListeners`, `writeDeadLetterOnTerminalFailure`) |
| `apps/worker/src/queues/tenant-lane-semaphore.ts` | Per-tenant-per-lane TTL-leased semaphore | ✓ VERIFIED | Atomic Lua ACQUIRE_SCRIPT, per-holder lease expiry, fail-closed on Redis error (no swallow) |
| `apps/worker/src/queues/send-dispatch.ts` | Semaphore + deferral wired into all 3 dispatch paths | ✓ VERIFIED | `acquireTenantLaneSlot`/`releaseTenantLaneSlot` at campaign, test-send, and flow branches, each with its own `finally` |
| `apps/worker/src/test/fairness-constants.ts` | Versioned fairness threshold + scenario volumes | ✓ VERIFIED | `TENANT_FAIRNESS_MIN_BASELINE_RATIO`, `FAIRNESS_SCENARIO_VOLUMES`, `LOADTEST_TENANT_RPS_DURATION_MS` all present with rationale comments |
| `packages/db/migrations/0053_flow_segment_sweep_checkpoint.sql` | Per-flow resume cursor, RLS-protected | ✓ VERIFIED | Bare-cast fail-closed policy, no scan-role grant, unique per (workspace, flow) |
| `apps/worker/src/queues/flows/flow-segment-sweep-flow.worker.ts` | Bounded per-flow walk worker | ✓ VERIFIED | `sweepOneFlowPage`, `runFlowSegmentSweepFlowJob`, `createFlowSegmentSweepFlowWorker` all exported and match plan contract |
| `packages/db/migrations/0054_dead_letter_jobs.sql` | Durable terminal-failure record, no tenant RLS | ✓ VERIFIED | `dead_letter_jobs` + `dead_letter_alert_state`, explicit no-RLS/no-scan-grant comment, dead-man's-switch seed row |
| `apps/worker/src/queues/dead-letter/dead-letter-writer.ts` | Terminal-failure gate + redacted insert | ✓ VERIFIED (delegating shim) | Re-exports `isTerminalJobFailure`/wraps `writeDeadLetterOnTerminalFailureShared` from `@mega-crm/queue-core` (relocated in plan 12-10, documented deviation) with the app's own dedicated pool — not a second implementation |
| `packages/queue-core/src/error-listeners.ts` | Shared worker error/failed listener | ✓ VERIFIED | `attachSharedErrorListeners`, injected `onTerminalFailure` hook, queue-core never imports from an app |
| `apps/worker/src/queues/queue-registry.ts` | Process-wide closeable queue registry | ✓ VERIFIED | `registerTrackedQueue`, `closeTrackedQueues`, `trackedQueueCount` |
| `apps/worker/src/shutdown-budget.ts` | Derived drain budget + container grace period | ✓ VERIFIED | `WORKER_DRAIN_BUDGET_MS`, `WORKER_DRAIN_SAFETY_MARGIN_MS`, `WORKER_STOP_GRACE_PERIOD_SECONDS`, derived (not hand-typed) from `SENDGRID_TIMEOUT_MS` + both tx margins |
| `apps/api/src/modules/ops/dead-letter-watchdog.ts` | Third operator watchdog | ✓ VERIFIED | `checkDeadLetterHealthAndAlert`, `startDeadLetterWatchdog`, `claimDeadLetterAlertSlot` all exported and wired at boot |
| `apps/worker/src/queues/__tests__/queue-core-single-definition.test.ts` | Cross-app single-definition invariant | ✓ VERIFIED | 12 guarded modules (6 worker + 5 api + 1 straggler migrated in 12-09), positive cross-process-identity assertions |
| `ARCHITECTURE.md` | Multi-instance safety documentation | ✓ VERIFIED | §10 "Worker reliability: tenant fairness, drain budget, and multi-instance safety" states idempotent-registration-≠-execution-exclusivity precisely |

### Key Link Verification

| From | To | Via | Status |
|------|-----|-----|--------|
| `email-broadcast.worker.ts` / `email-triggered.worker.ts` | `tenant-deferral.ts` | `deferForTenantBucket` call for `tenant_bucket` cause | ✓ WIRED |
| `send-dispatch.ts` | `tenant-lane-semaphore.ts` | `acquireTenantLaneSlot` before dispatch, `releaseTenantLaneSlot` in `finally` (×3 paths) | ✓ WIRED |
| `send-dispatch.ts` | `tenant-deferral.ts` | over-cap acquisition returns `tenant_bucket` cause, deferred by the worker wrappers | ✓ WIRED |
| `apps/worker/src/server.ts` | `packages/queue-core` | imports connection builder/factory | ✓ WIRED |
| `apps/api/*-queue(s).ts` | `packages/queue-core` | imports connection builder + job-options factory | ✓ WIRED |
| `.github/workflows/ci.yml` | `tenant-fairness.test.ts` | named `failure:tenant-fairness` step in `failure-injection` job | ✓ WIRED |
| `.github/workflows/ci.yml` | `segment-sweep-kill-resume.test.ts` | named `failure:segment-sweep-resume` step | ✓ WIRED |
| `flow-segment-sweep.worker.ts` | `flow-queues.ts` | discovery enqueues one per-flow walk job, deterministic jobId | ✓ WIRED |
| `flow-segment-sweep-flow.worker.ts` | `flow-segment-sweep-checkpoint.ts` | cursor advance on same client as page's writes | ✓ WIRED |
| `packages/queue-core/error-listeners.ts` | `dead-letter-writer.ts` (worker shim) | injected `onTerminalFailure` hook | ✓ WIRED |
| `apps/worker/src/server.ts` | `queue-registry.ts` | shutdown awaits `closeTrackedQueues` after workers close | ✓ WIRED |
| `apps/api/src/server.ts` | `dead-letter-watchdog.ts` | `startDeadLetterWatchdog` called at boot beside two existing watchdogs | ✓ WIRED |

### Behavioral Spot-Checks / Named-Test Runs

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Tenant-scoped deferral (WRK-01) | `vitest run tenant-deferral.test.ts` | 9/9 pass | ✓ PASS |
| Tenant/lane concurrency cap (WRK-02) | `vitest run tenant-lane-semaphore.test.ts` | 17/17 pass | ✓ PASS |
| Cap wired into dispatch (WRK-02) | `vitest run tenant-concurrency-cap.test.ts` | 12/12 pass | ✓ PASS |
| Two-tenant fairness proof (WRK-03) | `npm run failure:tenant-fairness` | 3/3 pass, 9.3s | ✓ PASS |
| `DEFAULT_TENANT_RPS` sustained (WRK-04) | `npm run loadtest:tenant-rps` | 1/1 pass, 17.2s, no queue-depth growth | ✓ PASS |
| Segment sweep resumable kill (WRK-05/06) | `npm run failure:segment-sweep-resume` | 1/1 pass, 3.4s | ✓ PASS |
| Graceful shutdown / shared listeners / scheduler / retention / single-definition | `vitest run` (6 files) | 96/96 pass | ✓ PASS |
| Dead-letter writer + error listeners + queue-options + dead-letter watchdog | `vitest run` (4 files across queue-core/api) | 31/31 pass | ✓ PASS |
| Rate-limit-429 (touched by 12-01) | `npm run failure:429` | 5/5 pass | ✓ PASS |
| Lint (whole workspace) | `npm run lint` | 0 errors, 0 warnings | ✓ PASS |

All named tests were run individually (never the full aggregate suite filtered post-hoc); the full-suite/lint/build pass at HEAD claim in the task prompt is corroborated, not merely trusted.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| WRK-01 | 12-01 | Tenant-scoped deferral doesn't stop the worker | ✓ SATISFIED | `deferForTenantBucket`, both lanes, `tenant-deferral.test.ts` |
| WRK-02 | 12-03, 12-04 | Per-tenant concurrency cap | ✓ SATISFIED | `tenant-lane-semaphore.ts` wired into 3 dispatch paths |
| WRK-03 | 12-05 | Load test proves A/B isolation | ✓ SATISFIED | `tenant-fairness.test.ts`, CI-wired |
| WRK-04 | 12-05 | `DEFAULT_TENANT_RPS` justified | ✓ SATISFIED | doc comment + `tenant-rps-sustained.test.ts` |
| WRK-05 | 12-06 | Bounded, checkpointed sweep | ✓ SATISFIED | keyset pagination, per-page timeout, same-tx checkpoint |
| WRK-06 | 12-06 | Resumable after partial failure | ✓ SATISFIED | `failure:segment-sweep-resume` live pass |
| WRK-07 | 12-08 | Graceful SIGTERM drain | ✓ SATISFIED | `closeWorkerRuntime` ordering + test |
| WRK-08 | 12-07, 12-08 | Unified error listeners | ✓ SATISFIED | `attachSharedErrorListeners` over full worker array |
| WRK-09 | 12-09 | Bounded failed-job retention | ✓ SATISFIED | `FAILED_JOB_RETENTION_SECONDS` (7d), differentiated policy preserved |
| WRK-10 | 12-07, 12-10 | Observable dead-letter mechanism | ✓ SATISFIED | `dead_letter_jobs` table + watchdog with alert/dedup |
| WRK-11 | 12-02, 12-11 | Single-source connection/job-option definitions | ✓ SATISFIED | `queue-core-single-definition.test.ts`, 12 guarded modules |
| WRK-12 | Phase 8 (not this phase) | Redis noeviction+persistence | N/A here | Already marked Complete in REQUIREMENTS.md |
| WRK-13 | 12-08 | Centralized repeatable-job error handling + documented multi-instance constraint | ✓ SATISFIED | `upsertJobScheduler` + `attachSharedListeners`; `ARCHITECTURE.md` §10 |

No orphaned requirements: all 12 IDs mapped to Phase 12 in `.planning/REQUIREMENTS.md` (WRK-01 through WRK-11, WRK-13) are claimed by at least one of the 11 plans, and every plan's declared `requirements` field is one of these IDs. `REQUIREMENTS.md` checkboxes for WRK-01..11/13 remain unticked (`[ ]`) — consistent with `ROADMAP.md` still listing Phase 12 as "In Progress" with no completion date; this is ship-time bookkeeping, not a code-substance gap, and is expected to be closed when the phase is marked complete.

### Anti-Patterns Found

None. Scanned every file named in all 11 plans' `files_modified` lists for `TBD`/`FIXME`/`XXX` (0 hits), `TODO`/`HACK`/`PLACEHOLDER`/"not yet implemented" (0 hits), and stub-shaped empty returns — none found. All modules are substantive, non-stub implementations.

### Code Review Warnings (from 12-REVIEW.md, disposition below)

None of these three warnings falsifies a must-have truth — no gap is opened by any of them — but they are real and worth carrying forward as follow-up work:

- **WR-01** (`dead-letter-watchdog.ts`): `dead_letter_alert_state.last_seen_failed_at` is populated with the OLDEST unacknowledged failure's timestamp instead of the newest, contradicting its own name/doc comment. Structurally excluded from the alert-dedup arbiter itself (`claimDeadLetterAlertSlot`'s `WHERE` clause never reads this column) — the 12-10 truth "one operator alert naming queues/count/oldest timestamp" still holds; only a secondary diagnostic column is wrong. Warning, not a phase-goal gap.
- **WR-02** (`dead-letter-watchdog.ts`): the interval-check catch logs via raw `console.error` instead of `scrubbedConsole`, bypassing this phase's own redaction convention. This is a new file extending a pre-existing pattern already present in two sibling watchdogs (`partition-watchdog.ts`, `send-reconciler-watchdog.ts`) — a real gap, but pre-existing and now tripled rather than introduced fresh by this phase.
- **WR-03** (`packages/queue-core/src/connection.ts`): `buildRedisConnectionOptions` does not percent-decode the URL's username/password, so a Redis password containing a reserved character (`@`, `:`, `%`, space) fails AUTH at boot. **This matters more than an ordinary warning because WRK-11's own consolidation is what made this the SOLE connection-options builder for both `apps/api` and `apps/worker`** — the must-have truth ("exactly one defining module... every module obtains its connection options exclusively by import from the shared package") is still TRUE and is exactly why this latent defect's blast radius is now total-pipeline rather than single-queue. It fails loudly (boot-time AUTH error), not silently, so it is not a data-loss/data-corruption risk — but it should be fixed before a real secret containing such a character is ever used in `REDIS_URL`.

### Human Verification Required

None. Every must-have truth is either directly, mechanically verifiable (file/wiring/grep-level) or was confirmed via a live, named, single-test run (never the aggregate suite) — including the two truths that specifically demand measured runtime behavior (WRK-01/02 fairness proof, WRK-05/06 kill-resume).

### Gaps Summary

No gaps. All 5 ROADMAP success criteria and all 12 requirement-mapped must-have truths across the 11 executed plans are verified against the actual codebase — not just SUMMARY.md claims. Artifacts exist, are substantive, are wired end to end, and the behavior-dependent truths (fairness ratio, sustained RPS, kill-and-resume) were confirmed by running the actual named tests live rather than trusting presence alone. The three code-review warnings are dispositioned above as legitimate follow-up work, none of which reopens a phase-goal truth.

---

_Verified: 2026-08-10T17:49:52Z_
_Verifier: Claude (gsd-verifier)_
