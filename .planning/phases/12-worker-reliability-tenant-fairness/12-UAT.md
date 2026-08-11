---
status: diagnosed
phase: 12-worker-reliability-tenant-fairness
source: 12-01-SUMMARY.md, 12-02-SUMMARY.md, 12-03-SUMMARY.md, 12-04-SUMMARY.md, 12-05-SUMMARY.md, 12-06-SUMMARY.md, 12-07-SUMMARY.md, 12-08-SUMMARY.md, 12-09-SUMMARY.md, 12-10-SUMMARY.md, 12-11-SUMMARY.md, 12-12-SUMMARY.md, 12-13-SUMMARY.md, 12-VERIFICATION.md
started: 2026-08-11T02:49:33Z
updated: 2026-08-11T07:05:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running worker/api processes. Clear ephemeral state (temp DBs, caches, lock files). Start the application from scratch. Both apps boot without errors, migrations 0053/0054 apply cleanly, repeatable schedulers register via upsertJobScheduler, and a primary check (health endpoint or basic API call) returns live data.
result: pass
reported: "Claude-run live re-test after G-12-1 fix (2026-08-11, real dev Redis preserved — no flush/deletion). Evidence in two parts. (1) Retrospective backlog-drain proof: the originally-reported backlog drained when the fixed worker booted at 08:08:17 (epoch 1786423280) — partition-maintenance completed set holds 108/108 boot-* jobs, oldest added Aug 6 (1786035081711), ALL finished within ~1s of each other at 1786423279650–1786423280651; wait=0 across all five tick queues, failed=0 from the drain. (2) Fresh cold start: killed the dev stack (verified 0 orphan processes, 0 blocked BZPOPMIN clients), waited 2 min so both 60s ticks came due while nothing ran, booted apps/worker alone. Within 20s: 16/16 blocked BZPOPMIN connections (original failure signature was 11/16), all due ticks consumed. 5-min watch: campaign-scheduler +6 completed (60s cadence, one snapshot caught active=1 live), flow-reconciliation +6, analytics-reconcile +2 (180s), send-reconciler +1 recurring (300s), partition-maintenance +1 boot-* job (daily tick not due until 1786503600000 — expected). Post-boot event streams: active+completed events on all five queues, failed events = 0 on all five. Failed sets unchanged: campaign-scheduler frozen at exactly 1 — a stale July 7 job (old repeat:7a59… format, 'invalid input syntax for type uuid: \"\"', predates Phase 12; left in place). Worker boot log: 16 workers registered, zero error lines; partition-maintenance boot run complete (bufferMonthsRemaining: 3, partitionsCreated: [], default-partition counts 0) — monthly partitions exist 2026_07→2027_06 on both events and send_events, well past the now+3-month horizon. Campaign-scan: scan-due-campaigns ticks completed cleanly; DB has zero due 'scheduled' campaigns so no kickoff was owed (the single 'sending' row is a July 6 legacy test artifact, untouched). Dev stack restarted afterwards: 16 workers, API :4000 → 200, web :5173 → 200."
retest_of: G-12-1 (plan 12-12 human-check D5)

### 2. Documentation Accuracy — Worker Reliability Sections
expected: ARCHITECTURE.md has a section covering the tenant-fairness mechanism, the drain-budget derivation, and multi-instance safety stated precisely (registration idempotency is NOT execution exclusivity; single-instance deployment is an explicit v1.1 constraint). SPECIFICATION.md's worker-scheduling table, shutdown description and observability section record the same facts as-built. The prose must not overclaim multi-instance safety.
result: pass
reported: "User accepted after G-12-2 doc fix (plan 12-13). Original issue: SPECIFICATION.md §5.1/§5.2 presented all scheduled workers as operational while five never consumed (G-12-1); ARCHITECTURE.md forward-looking entry claimed retention still open. Fixed by 12-13 and line-verified in 12-VERIFICATION.md; user re-read and passed 2026-08-11."
coverage_id: D5 (12-08)
retest_of: G-12-2 (plan 12-13 acceptance re-read)

### 3. Tenant-scoped rate_limited deferral (12-01 D1)
expected: A tenant-scoped rate_limited rejection defers only the offending job via job.moveToDelayed/DelayedError, never worker.rateLimit() — verified for both send lanes, including a two-workspace race proving the deferred tenant does not stall the other tenant's job.
result: pass
source: automated
coverage_id: D1 (12-01)

### 4. Provider-backoff bounded attempts unchanged (12-01 D2)
expected: Provider-backoff (cause 'provider_backoff') keeps its existing bounded-attempts behavior unchanged, at both the processSendJob layer and the new worker-wrapper layer.
result: pass
source: automated
coverage_id: D2 (12-01)

### 5. Shared deferral helper across both lanes (12-01 D3)
expected: Both send lanes (broadcast, triggered) reach the deferral decision through the same shared helper — no drift between them.
result: pass
source: automated
coverage_id: D3 (12-01)

### 6. queue-core package holds shared queue config (12-02 D1)
expected: @mega-crm/queue-core workspace package holds the single connection-options builder and send-lane timing/retry constants.
result: pass
source: automated
coverage_id: D1 (12-02)

### 7. buildJobOptions retention-parameterised (12-02 D2)
expected: buildJobOptions(retention) is retention-parameterised: STANDARD_JOB_RETENTION and FLOW_RUN_ADVANCE_RETENTION both stay expressible; a missing argument and an ad-hoc third shape are compile errors.
result: pass
source: automated
coverage_id: D2 (12-02)

### 8. Worker modules import exclusively from queue-core (12-02 D3)
expected: Every module under apps/worker constructing a BullMQ queue or worker resolves connection options and retry/backoff/retention exclusively by import from @mega-crm/queue-core; connection.ts and queue-options.ts deleted with no re-export shim.
result: pass
source: automated
coverage_id: D3 (12-02)

### 9. flow-run-advance retention policy unchanged (12-02 D4)
expected: flow-run-advance's differentiated retention policy stays unchanged and expressible at its own call site.
result: pass
source: automated
coverage_id: D4 (12-02)

### 10. Tenant-lane TTL-leased semaphore (12-03 D1)
expected: Per-tenant-per-lane TTL-leased concurrency semaphore works: acquire/release, cap boundary, lease expiry, both isolation axes, env-override parsing, fail-closed on Redis error.
result: pass
source: automated
coverage_id: D1 (12-03)

### 11. Dispatch paths acquire/release concurrency slots (12-04 D1)
expected: Campaign, test and flow dispatch paths each acquire a tenant-lane concurrency slot before calling SendGrid and release it in a finally spanning every exit.
result: pass
source: automated
coverage_id: D1 (12-04)

### 12. Over-cap send defers via tenant_bucket path (12-04 D2)
expected: An over-cap send defers through the same tenant_bucket path an over-RPS send uses, releasing its dispatch claim first, and never strands a send row in 'dispatching'.
result: pass
source: automated
coverage_id: D2 (12-04)

### 13. SPECIFICATION.md documents concurrency cap (12-04 D3)
expected: SPECIFICATION.md documents the per-tenant-per-lane concurrency cap's key shape, per-lane defaults, environment overrides and lease TTL, distinguishing its key from the RPS ceiling's.
result: pass
source: automated
coverage_id: D3 (12-04)

### 14. Tenant B throughput ≥90% baseline under A's saturation (12-05 D1)
expected: Tenant B's throughput while tenant A saturates its own RPS ceiling stays at or above 90% of B's own solo baseline measured in the same run, with a guard against a vacuous pass.
result: pass
source: automated
coverage_id: D1 (12-05)

### 15. Broadcast saturation doesn't cost own triggered lane (12-05 D2)
expected: A tenant saturating its own broadcast lane does not cost that same tenant's triggered-lane throughput.
result: pass
source: automated
coverage_id: D2 (12-05)

### 16. Fairness scenario in CI on every PR (12-05 D3)
expected: The two-tenant fairness scenario runs on every pull request as a named step of the failure-injection CI job and is part of failure:all.
result: pass
source: automated
coverage_id: D3 (12-05)

### 17. DEFAULT_TENANT_RPS backed by sustained run + provider guidance (12-05 D4)
expected: DEFAULT_TENANT_RPS is backed by a sustained-throughput run and by cited provider guidance with the bring-your-own plan-tier caveat.
result: pass
source: automated
coverage_id: D4 (12-05)

### 18. No network calls to SendGrid in load tests (12-05 D5)
expected: Neither load-test variant issues a network call to SendGrid.
result: pass
source: automated
coverage_id: D5 (12-05)

### 19. Checkpointed keyset-paginated segment sweep (12-06 D1)
expected: Bounded, checkpointed keyset-paginated per-flow walk (never OFFSET), with the resume cursor committed in the same transaction as the page's enrollment work.
result: pass
source: automated
coverage_id: D1 (12-06)

### 20. Cursor resets to NULL on completion (12-06 D2)
expected: Cursor resets to NULL on walk completion so a contact inserted behind the old cursor position is not permanently skipped.
result: pass
source: automated
coverage_id: D2 (12-06)

### 21. Discovery/walk split with deterministic jobId (12-06 D3)
expected: Discovery enqueues exactly one bounded walk job per live segment-triggered flow, deterministic jobId, no double-enqueue for a still-pending flow.
result: pass
source: automated
coverage_id: D3 (12-06)

### 22. Sweep tenant-context isolation preserved (12-06 D4)
expected: Discovery's cross-workspace scan role visibility unchanged — every per-flow read/write re-enters tenant-scoped context; cross-tenant enrollment proven independently per workspace.
result: pass
source: automated
coverage_id: D4 (12-06)

### 23. Checkpoint table fail-closed RLS (12-06 D5)
expected: flow_segment_sweep_checkpoint table is fail-closed RLS from birth, grants nothing to the scan role, and registers in the drizzle schema.
result: pass
source: automated
coverage_id: D5 (12-06)

### 24. Sweep scheduler migrated to upsertJobScheduler (12-06 D6)
expected: Scheduler registration migrated from tickQueue.add({repeat}) to upsertJobScheduler with try/catch/finally and a one-time legacy-repeatable-entry removal.
result: pass
source: automated
coverage_id: D6 (12-06)

### 25. Dead-letter tables migration 0054 (12-07 D1)
expected: dead_letter_jobs / dead_letter_alert_state tables: additive migration 0054, no RLS, no mega_crm_scan grant, singleton alert-state seeded unconditionally.
result: pass
source: automated
coverage_id: D1 (12-07)

### 26. Terminal-failure gate + dead-letter writer (12-07 D2)
expected: isTerminalJobFailure gate + writeDeadLetterOnTerminalFailure: terminal write, non-terminal no-op, redaction proof (email/provider-key/bearer-token), duplicate-write idempotency, swallowed DB error.
result: pass
source: automated
coverage_id: D2 (12-07)

### 27. Shared error listeners contract (12-07 D3)
expected: attachSharedErrorListeners: exactly one error + one failed listener, scrubbed logging, job-less failure tolerance, injected onTerminalFailure hook invoked once, rejecting hook caught, no double-registration.
result: pass
source: automated
coverage_id: D3 (12-07)

### 28. Three schedulers migrated to upsertJobScheduler (12-08 D1)
expected: campaign-scheduler, analytics-reconciliation and flow-reconciliation workers migrated to upsertJobScheduler with stable ids, non-rethrowing registration guard, finally-closed registration queue, and legacy repeatable-entry removal.
result: pass
source: automated
coverage_id: D1 (12-08)

### 29. Producer queues tracked + graceful shutdown ordering (12-08 D2)
expected: Every long-lived producer Queue singleton is tracked via queue-registry.ts; server.ts shutdown awaits every worker close, then closeTrackedQueues, then disconnects the shared connection, in that order; an in-flight job completes before shutdown resolves.
result: pass
source: automated
coverage_id: D2 (12-08)

### 30. Shared listeners attached over full worker array (12-08 D3)
expected: attachSharedListeners attaches the shared error/failed listener over the full worker array immediately after it is built, with onTerminalFailure composing the terminal gate and the dead-letter writer — every worker covered by one code path.
result: pass
source: automated
coverage_id: D3 (12-08)

### 31. Drain budget derived from constants (12-08 D4)
expected: shutdown-budget.ts derives WORKER_DRAIN_BUDGET_MS (60_000ms) and WORKER_STOP_GRACE_PERIOD_SECONDS (60s) from imported constants rather than a literal, documented for Phase 14 to consume as the container stop-grace-period.
result: pass
source: automated
coverage_id: D4 (12-08)

### 32. Failed-job retention age-bounded (12-09 D1)
expected: FAILED_JOB_RETENTION_SECONDS (7 days) added to queue-core; STANDARD_JOB_RETENTION's removeOnFail is age-bounded instead of `false`, strictly greater than the 72h reconciliation rescan horizon with a documented ~2.33x margin.
result: pass
source: automated
coverage_id: D1 (12-09)

### 33. FLOW_RUN_ADVANCE_RETENTION untouched and distinct (12-09 D2)
expected: FLOW_RUN_ADVANCE_RETENTION left byte-for-byte unchanged; both retention fields genuinely differ from STANDARD_JOB_RETENTION's, so per-queue parameterisation is observable rather than nominal.
result: pass
source: automated
coverage_id: D2 (12-09)

### 34. No queue keeps failed jobs forever (12-09 D3)
expected: failed-job-retention.test.ts proves at the value level that no queue keeps failed jobs forever and that every queue-constructing module in both applications builds its job options through buildJobOptions.
result: pass
source: automated
coverage_id: D3 (12-09)

### 35. Full regression after retention change (12-09 D4)
expected: apps/worker (396 tests), apps/api (396 tests), both tsc noEmit checks, and the complete failure-injection suite (10 scenarios) all pass after the retention change.
result: pass
source: automated
coverage_id: D4 (12-09)

### 36. Watchdog alerts once per dedup window (12-10 D1)
expected: Dead-letter watchdog alerts an operator exactly once per dedup window when unacknowledged dead-letter rows exist, naming affected queues/count/oldest failure.
result: pass
source: automated
coverage_id: D1 (12-10)

### 37. Alert slot released on send failure (12-10 D2)
expected: Alert slot claimed before send, released on send failure so a failed delivery does not consume the dedup window.
result: pass
source: automated
coverage_id: D2 (12-10)

### 38. Acknowledged rows excluded (12-10 D3)
expected: No unacknowledged rows → no mail; acknowledged rows excluded from count and decision.
result: pass
source: automated
coverage_id: D3 (12-10)

### 39. Dead-letter path proven end to end (12-10 D4)
expected: Whole dead-letter path (writer → durable row → watchdog → alert) proven end to end.
result: pass
source: automated
coverage_id: D4 (12-10)

### 40. Watchdog runs from apps/api boot (12-10 D5)
expected: Watchdog runs from apps/api boot beside the two existing watchdogs, dedups independently, alerts through the platform key.
result: pass
source: automated
coverage_id: D5 (12-10)

### 41. apps/api queue modules import from queue-core (12-11 D1)
expected: apps/api's five BullMQ queue modules (campaigns, CSV import, events, webhooks, flows) import their connection builder and job-options factory from @mega-crm/queue-core instead of declaring local copies.
result: pass
source: automated
coverage_id: D1 (12-11)

### 42. Cross-application single-definition invariant (12-11 D2)
expected: Cross-application invariant test proves all 11 guarded modules (6 worker + 5 api) resolve connection/job options from one shared module, and fails loudly if a local copy reappears.
result: pass
source: automated
coverage_id: D2 (12-11)

### 43. Burst-absorption dedup assertion is non-vacuous (12-12 D4)
expected: |
  Decision needed (test-design gap, not a runtime uncertainty — VERIFICATION.md
  behavior_unverified item + 12-REVIEW.md WR-03): the burst-absorption test's "without
  duplicated side effects" assertion currently passes vacuously because the ephemeral test
  DB has zero campaign rows. Either (a) seed one past-due `scheduled` campaign before
  stacking the 20-job burst and assert the kickoff producer queue shows completed === 1
  (not 0) across the burst, or (b) explicitly accept the underlying mechanism
  (deterministic BullMQ jobId collision + FOR UPDATE SKIP LOCKED re-check, both
  independently established elsewhere in this codebase) as sufficient without a dedicated
  test. The "drains to zero without failures" half of D4 IS genuinely proven.
result: issue
reported: "Test-design gap: seed exactly one past-due scheduled campaign before the 20-job burst, then assert that exactly one kickoff job is produced/processed and the campaign transitions only once. Also assert no duplicate kickoff remains in waiting/active/completed state. The current empty-database result is vacuous; separate jobId and row-lock tests do not replace this end-to-end burst assertion."
severity: major
coverage_id: D4 (12-12)

## Summary

total: 43
passed: 42
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-12-1
  truth: "Repeatable schedulers register via upsertJobScheduler AND their workers consume the scheduled tick jobs — scheduled campaigns kick off, analytics/flow/send reconciliation and partition maintenance actually run"
  status: resolved
  resolved_by: "12-12 (conditional-spread autorun in all five factories; worker-autorun-default.test.ts 8/8; verified 12-VERIFICATION.md 2026-08-11). Live backlog-drain re-test tracked as test 1."
  reason: "User reported: five repeatable-tick workers (campaign-scheduler, analytics-reconcile, flow-reconciliation, partition-maintenance, send-reconciler) register schedulers but never process jobs; jobs accumulate in wait indefinitely (partition-maintenance: 107 waiting), no 'active' event ever emitted"
  severity: blocker
  test: 1
  root_cause: "The five factories pass `autorun: options.autorun` to the BullMQ Worker constructor. In production `options` is omitted, so the opts object carries an explicit `autorun: undefined` key. BullMQ v5 merges defaults via Object.assign({ ...defaults, autorun: true }, opts) — an own-property `undefined` CLOBBERS the `true` default — and then gates the processing loop with `if (this.opts.autorun) { this.run() }` (node_modules/bullmq/dist/cjs/classes/worker.js:34,115). Undefined is falsy, so run() is never called: the worker constructs, registers listeners, appears in the boot log, but never consumes. Factories that do not pass the autorun key (e.g. flow-segment-sweep.worker.ts, 12-06) work correctly. Introduced with partition-maintenance.worker.ts in Phase 9 (3ac9d48), copied to send-reconciler in Phase 11, propagated to the three tick workers migrated by 12-08 (15632a7). Runtime confirmation: exactly 5 of 16 workers have no blocked BZPOPMIN connection; campaign-scheduler's event stream shows only added/waiting events since 12-08 first booted (1786378631963)."
  artifacts:
    - path: "apps/worker/src/queues/campaign-scheduler.worker.ts"
      issue: "passes `autorun: options.autorun` (undefined in production) to new Worker(), disabling the run loop"
    - path: "apps/worker/src/queues/analytics-reconciliation.worker.ts"
      issue: "same autorun-undefined clobber"
    - path: "apps/worker/src/queues/flows/flow-reconciliation.worker.ts"
      issue: "same autorun-undefined clobber"
    - path: "apps/worker/src/queues/partition-maintenance.worker.ts"
      issue: "same autorun-undefined clobber (origin of the pattern, Phase 9)"
    - path: "apps/worker/src/queues/send-reconciler.worker.ts"
      issue: "same autorun-undefined clobber (Phase 11)"
  missing:
    - "Only include the autorun key when explicitly provided (e.g. `...(options.autorun !== undefined ? { autorun: options.autorun } : {})`) or default it: `autorun: options.autorun ?? true` — in all five factories"
    - "A regression test that constructs each factory WITHOUT options against a real Redis and asserts a waiting job reaches 'active'/'completed' (the existing scheduler-registration tests pass autorun:false explicitly and so never exercise the production path)"
    - "Drain/triage the backlog once workers consume again: stale boot-* jobs and pending tick jobs in the five wait lists will all fire on first fixed boot (partition-maintenance: 107 waiting) — verify idempotency absorbs the burst or clean the wait lists as part of the fix"
  debug_session: ""

- gap_id: G-12-2
  truth: "ARCHITECTURE.md and SPECIFICATION.md record the worker-scheduling, retention and DLQ facts as-built, without contradicting each other or the runtime"
  status: resolved
  resolved_by: "12-13 (ARCHITECTURE.md forward-looking bullet reduced to memory-ceiling item; SPECIFICATION.md §5.1/§5.2 rewritten to observed-consumption facts naming worker-autorun-default.test.ts; all four doc truths line-verified in 12-VERIFICATION.md 2026-08-11). Acceptance re-read tracked as test 2."
  reason: "User reported: SPECIFICATION.md §5.1/§5.2 presents all scheduled workers as operational while five never consume jobs (see G-12-1); ARCHITECTURE.md's Forward-looking Phase 12 entry says failed-job retention remains open while SPECIFICATION.md §5.3 documents the implemented 7-day retention and durable Postgres DLQ. Tenant-fairness, drain-budget and single-instance wording is accurate."
  severity: major
  test: 2
  root_cause: "Two staleness defects. (1) ARCHITECTURE.md's 'Forward-looking — not yet true' list (line ~229) was not updated when 12-09 implemented FAILED_JOB_RETENTION_SECONDS (7-day removeOnFail) and 12-07/12-10 shipped the durable dead-letter path — it still claims retention 'remains open', directly contradicting SPECIFICATION.md §5.3. (2) SPECIFICATION.md §5.1/§5.2 describes all 16 registered workers as operational; once G-12-1 is fixed this becomes true, but the docs were written from the worker-registration log line rather than observed consumption. Fix order matters: G-12-1 first, then docs describe the (now truthful) runtime; the ARCHITECTURE.md forward-looking entry needs updating regardless."
  artifacts:
    - path: "ARCHITECTURE.md"
      issue: "'Forward-looking — not yet true' Phase 12 bullet (~line 229) still lists queue retention as open — stale after 12-09"
    - path: "SPECIFICATION.md"
      issue: "§5.1/§5.2 present all scheduled workers as operational — only true once G-12-1 is fixed"
  missing:
    - "Update ARCHITECTURE.md forward-looking Phase 12 bullet: retention is implemented (7-day removeOnFail, 12-09); leave only the genuinely-open memory-ceiling item"
    - "After G-12-1 is fixed, re-verify SPECIFICATION.md §5.1/§5.2 against observed runtime (consumption, not just registration)"
  debug_session: ""

- gap_id: G-12-3
  truth: "The burst-absorption scenario proves scheduler-tick burst dedup end to end: with exactly one past-due scheduled campaign seeded, a 20-job tick burst produces exactly one kickoff job and one campaign state transition, with no duplicate kickoff in waiting/active/completed"
  status: failed
  reason: "User reported: Test-design gap: seed exactly one past-due scheduled campaign before the 20-job burst, then assert that exactly one kickoff job is produced/processed and the campaign transitions only once. Also assert no duplicate kickoff remains in waiting/active/completed state. The current empty-database result is vacuous; separate jobId and row-lock tests do not replace this end-to-end burst assertion."
  severity: major
  test: 43
  root_cause: "Test-design defect in apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:255-320. The burst case's only dedup assertion (line 310) expects the kickoff queue to be all-zeros (waiting/active/delayed/completed/failed all 0). Because the test never seeds a campaign, findDueCampaignCandidates() (campaign-scheduler.worker.ts:59-67, WHERE status='scheduled' AND scheduled_at <= now()) returns [] on every one of the 20+ burst ticks, so the dedup-bearing loop (transitionToSending's FOR UPDATE SKIP LOCKED re-check at :83-101, the if-not-transitioned continue, and the deterministic jobId enqueue at :196-205) executes zero times — an all-zero kickoff queue is observed whether or not dedup works. Vacuous by construction (the test's own comment at :297-301 admits it). Postgres infrastructure is ALREADY live in this test: beforeAll calls ensureTestDbMigrated() and global-setup publishes DATABASE_URL/SCAN_DATABASE_URL, and the passing failed===0 assertion proves the real scan ran 20+ times against the migrated ephemeral DB. Missing piece is seeded data + exactly-one assertions, not plumbing. Note: 12-REVIEW.md WR-03's suggestion to assert kickoff completed===1 is wrong on one detail — nothing consumes CAMPAIGN_KICKOFF_QUEUE in this test, so the single job sits in waiting."
  artifacts:
    - path: "apps/worker/src/queues/__tests__/worker-autorun-default.test.ts"
      issue: "lines 255-320 (esp. 296-310): vacuous all-zeros kickoff assertion against a deliberately empty campaigns table; missing seed + missing exactly-one assertions"
    - path: "apps/worker/src/queues/campaign-scheduler.worker.ts"
      issue: "nothing wrong — :59-67 scan, :83-101 FOR UPDATE SKIP LOCKED transition, :196-205 deterministic-jobId enqueue are the mechanism the test must actually exercise"
    - path: "apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts"
      issue: "nothing wrong — :32-56 seedDueCampaign recipe (insertFixtureOrganization + withTenant INSERT of segment + past-due scheduled campaign) and :58-68 status readback are the proven helpers to reuse"
  missing:
    - "Seed one workspace (insertFixtureOrganization, failure-fixtures.ts:121-128) and one past-due scheduled campaign (seedDueCampaign recipe) in the burst case before stacking the 20-job burst"
    - "Replace line-310 all-zeros assertion with: total kickoff jobs across waiting+active+delayed+completed+failed === 1 (job sits in waiting — nothing consumes CAMPAIGN_KICKOFF_QUEUE here)"
    - "Assert drainKickoffQueue.getJob(campaignId) is non-null (deterministic jobId seam end to end)"
    - "Assert campaign readback via withTenant shows status === 'sending' (combined with kickoff-count 1 proves exactly one transition)"
    - "Enqueue one extra manual scan-due-campaigns job as a post-transition re-check tick (avoids waiting for 60s SCAN_INTERVAL_MS)"
    - "Optionally keep the empty-DB variant as an honestly-named control case (no due campaigns → no kickoff jobs)"
  debug_session: ".planning/debug/burst-absorption-vacuous-dedup.md"
