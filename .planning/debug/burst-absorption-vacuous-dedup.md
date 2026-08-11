---
status: diagnosed
trigger: "G-12-3 (Phase 12, UAT test 43) — burst-absorption test's dedup assertion passes vacuously against an empty database"
created: 2026-08-11T07:30:00Z
updated: 2026-08-11T07:55:00Z
goal: find_root_cause_only
symptoms_prefilled: true
---

## Current Focus

hypothesis: CONFIRMED — see Resolution.root_cause
test: n/a (diagnosis complete)
expecting: n/a
next_action: "Return ROOT CAUSE FOUND to orchestrator; /gsd-plan-phase --gaps plans the fix"
bug_class: Bohrbug (deterministic test-design defect — assertion vacuity reproduces on every run by construction)

## Symptoms

expected: "The burst-absorption scenario proves scheduler-tick burst dedup end to end: with exactly one past-due `scheduled` campaign seeded, a 20-job tick burst produces exactly one kickoff job and one campaign state transition, with no duplicate kickoff in waiting/active/completed."
actual: "User reported: Test-design gap: seed exactly one past-due scheduled campaign before the 20-job burst, then assert that exactly one kickoff job is produced/processed and the campaign transitions only once. Also assert no duplicate kickoff remains in waiting/active/completed state. The current empty-database result is vacuous; separate jobId and row-lock tests do not replace this end-to-end burst assertion."
errors: "None — test-design gap (vacuous assertion), not a runtime failure."
reproduction: "Test 43 in .planning/phases/12-worker-reliability-tenant-fairness/12-UAT.md; burst-absorption case in apps/worker/src/queues/__tests__/worker-autorun-default.test.ts (plan 12-12, commit 2820e78; flagged by 12-REVIEW.md WR-03 and 12-VERIFICATION.md behavior_unverified)."
started: "Discovered during UAT (2026-08-11)."

## Eliminated

- hypothesis: "The burst test has no Postgres handle at all (Redis-only harness), so it structurally cannot observe kickoff side effects without adding DB infrastructure"
  evidence: "False. The file's beforeAll calls ensureTestDbMigrated() (worker-autorun-default.test.ts:163-169) which migrates a full ephemeral Postgres, and packages/test-support/src/global-setup.ts:104-115 publishes DATABASE_URL (tenant-context module-load pool, packages/tenant-context/src/index.ts:21), SCAN_DATABASE_URL (lazy scan pool, packages/tenant-context/src/scan.ts:22-40) and AUTH_DATABASE_URL into every test worker's env. Decisive proof the DB path is live: the burst test asserts failed === 0 on the tick queue (line 291) and passes today — every one of the 20+ tick jobs ran findDueCampaignCandidates() against the real ephemeral DB and succeeded. The database is reachable and migrated; it is merely EMPTY of campaign rows."
  timestamp: 2026-08-11T07:50:00Z

- hypothesis: "Environment/config defect — the harness cannot support seeding (RLS/roles block fixture inserts from this file)"
  evidence: "False. campaign-scheduler-scan.test.ts (same workspace, same harness, same global-setup) seeds workspaces via insertFixtureOrganization (mega_crm_auth pool, apps/worker/src/test/failure-fixtures.ts:121-128) and campaigns via withTenant/withTenantTransaction INSERTs (campaign-scheduler-scan.test.ts:32-56), then exercises findDueCampaignCandidates + transitionToSending successfully. All seams exist and are proven working in a sibling file."
  timestamp: 2026-08-11T07:50:00Z

## Evidence

- timestamp: 2026-08-11T07:30:00Z
  checked: .planning/debug/knowledge-base.md for matching patterns
  found: No match for vacuous-dedup/burst pattern. Note — aggregate-coverage-run-fails entry documents packages/test-support ephemeral-Postgres provisioning (global-setup.ts, db-fixture.ts, provision-db.ts, getTestDatabaseUrl) as the standard DB seam for tests.
  implication: Investigation proceeds fresh; test-support package is the likely seeding seam.

- timestamp: 2026-08-11T07:40:00Z
  checked: apps/worker/src/queues/__tests__/worker-autorun-default.test.ts (full read)
  found: |
    Burst case is lines 255-320 ("campaign-scheduler: a stacked burst of identical tick jobs drains
    to zero waiting/failed without duplicated kickoff work"). Structure: per-test throwaway Redis
    (beforeEach startTempRedis, lines 173-179); beforeAll ensureTestDbMigrated() (163-169, with a
    comment saying the burst case "needs `campaigns` to actually exist and succeed a real scan");
    a suppressed worker (autorun:false) registers the scheduler, 20 tick jobs stacked with jobIds
    burst-0..burst-19 (263-274); a production-shape drain worker consumes them (279); vi.waitFor
    asserts tick-queue waiting/active/failed all reach 0 (286-294); then the kickoff producer queue
    (via getCampaignSchedulerKickoffQueueForTest) is asserted to be ALL ZEROS:
    `expect(kickoffCounts).toMatchObject({ waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 })`
    (line 310). The in-file comment at 297-301 states outright: "this run's ephemeral test database
    has no campaign rows, so `findDueCampaignCandidates()` finds nothing due on any of the burst's
    ticks and the kickoff producer queue never receives a single job -- burst or no burst."
  implication: The "without duplicated kickoff work" claim is asserted as zero-kickoffs-observed against a dataset guaranteed to produce zero kickoffs. The observation is equally consistent with "dedup works" and "nothing happened" — vacuous by construction, and the file admits it.

- timestamp: 2026-08-11T07:43:00Z
  checked: apps/worker/src/queues/campaign-scheduler.worker.ts (full read) — the scan-due-campaigns processor
  found: |
    (1) findDueCampaignCandidates() (lines 59-67): withCrossWorkspaceScan (mega_crm_scan role) —
        `SELECT id, workspace_id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now()`.
    (2) transitionToSending(row) (lines 83-101): withTenant(workspaceId) → withTenantTransaction →
        `SELECT id FROM campaigns WHERE id=$1 AND status='scheduled' AND scheduled_at <= now()
         FOR UPDATE SKIP LOCKED` re-check; returns false when 0 rows; else
        `UPDATE campaigns SET status='sending', sending_started_at=now(), updated_at=now()`.
    (3) Processor body (lines 198-205): for each due row — transitionToSending; `if (!transitioned)
        continue;` (skip re-kickoff); else `kickoffQueue.add("kickoff", {workspaceId, campaignId},
        { jobId: row.id })` — deterministic jobId = campaignId on CAMPAIGN_KICKOFF_QUEUE (the same
        jobId the launch route uses, per docstring 153-163).
    (4) Kickoff producer queue is long-lived, tracked, exposed to tests via
        getCampaignSchedulerKickoffQueueForTest(worker) (lines 132-136).
    (5) Worker default concurrency (BullMQ default 1) — burst ticks run sequentially.
  implication: With one seeded past-due scheduled campaign, the first tick transitions the row and enqueues exactly one kickoff job (jobId=campaignId); every later tick either no longer sees the row in the scan (status now 'sending') or fails the FOR-UPDATE re-check and skips. The dedup-bearing loop body (200-204) is EXACTLY the code the current test never executes: with zero campaign rows it runs zero times across all 20+ ticks.

- timestamp: 2026-08-11T07:47:00Z
  checked: apps/worker/src/queues/__tests__/campaign-scheduler-scan.test.ts (full read) — the seeding recipe
  found: |
    seedDueCampaign(nameSeed) (lines 32-56): (a) workspaceId = await insertFixtureOrganization(nameSeed)
    (from ../../test/failure-fixtures.js — mega_crm_auth-backed INSERT into organization, lines 121-128
    of failure-fixtures.ts); (b) under withTenant/withTenantTransaction: INSERT INTO segments
    (workspace_id, name, definition, created_by_user_id) VALUES (..., '{"operator":"and","conditions":[]}',
    'test-user') RETURNING id; then INSERT INTO campaigns (workspace_id, name, status, segment_id,
    scheduled_at, created_by_user_id) VALUES ($1, ..., 'scheduled', $segmentId,
    now() - interval '1 minute', 'test-user') RETURNING id.
    campaignStatus(workspaceId, campaignId) readback helper (lines 58-68): withTenant →
    `SELECT status FROM campaigns WHERE id = $1`.
    Its beforeAll also re-assigns process.env.DATABASE_URL/SCAN_DATABASE_URL from the fixture getters
    (lines 21-26) — belt-and-braces; global-setup already publishes both.
  implication: A complete, proven seeding + readback recipe exists in a sibling file in the same workspace/harness. Nothing new needs building.

- timestamp: 2026-08-11T07:50:00Z
  checked: packages/test-support/src/db-fixture.ts, packages/test-support/src/global-setup.ts, packages/tenant-context/src/index.ts, packages/tenant-context/src/scan.ts, apps/worker/src/test/db-fixture.ts
  found: |
    global-setup.ts:104-115 publishes TEST_DATABASE_URL, DATABASE_URL (explicitly "because
    packages/tenant-context reads it" — index.ts:21 builds the tenant pool from it at module load),
    SCAN_DATABASE_URL and AUTH_DATABASE_URL (role-swapped via buildTestRoleDsn) into each vitest
    project's config.env + process.env. scan.ts:22-40 builds the scan pool lazily from
    SCAN_DATABASE_URL at first call, throwing if unset. apps/worker/src/test/db-fixture.ts is a thin
    shim re-exporting createTestPool/ensureTestDbMigrated/getTestDatabaseUrl from @mega-crm/test-support
    — the burst test's `ensureTestDbMigrated` import from @mega-crm/test-support is the same function.
  implication: The burst test ALREADY has full Postgres infrastructure wired (12-12-SUMMARY's "per-test throwaway Redis" is only the Redis half; Postgres is the shared per-project ephemeral DB). The only structural gap is data (no seeded campaign) and the assertion polarity (expects 0, must expect 1).

- timestamp: 2026-08-11T07:52:00Z
  checked: .planning/phases/12-worker-reliability-tenant-fairness/12-REVIEW.md WR-03
  found: WR-03 (lines 95-101) reaches the same diagnosis with the same line references, and notes the test's docstring (81-117) presents the "no duplicated downstream effect" claim as demonstrated when it is not. WR-03's suggested fix says "assert the kickoff queue's `completed` count is exactly 1" — that detail is WRONG for this harness: no worker consumes CAMPAIGN_KICKOFF_QUEUE in this test, so the single kickoff job never completes; it sits in `waiting`. The correct assertion is total-across-states === 1 (UAT's own formulation).
  implication: Independent corroboration of root cause; one correction to carry into the fix plan.

reasoning_checkpoint:
  hypothesis: "worker-autorun-default.test.ts's burst case asserts an all-zero kickoff queue (line 310) against an ephemeral database that contains zero campaign rows, so findDueCampaignCandidates() returns [] on every tick and the dedup mechanism (transitionToSending + jobId=campaignId enqueue, campaign-scheduler.worker.ts:200-204) executes zero times — the assertion cannot distinguish 'dedup worked' from 'no work existed'"
  confirming_evidence:
    - "Test's own comment (lines 297-301) states the DB has no campaign rows and the kickoff queue 'never receives a single job -- burst or no burst'"
    - "Assertion at line 310 expects {waiting:0, active:0, delayed:0, completed:0, failed:0} — the zero-work observation"
    - "Processor loop body containing ALL dedup logic (campaign-scheduler.worker.ts:200-204) is only reachable when the scan returns rows; scan is `WHERE status='scheduled' AND scheduled_at <= now()` over an empty campaigns table"
    - "12-REVIEW.md WR-03 independently reached the identical conclusion with the same line references"
  falsification_test: "If the burst test seeded a campaign or asserted a non-zero kickoff count anywhere, the hypothesis would be false — full-file read confirms neither exists; grep for INSERT/insertFixtureOrganization in worker-autorun-default.test.ts yields nothing"
  fix_rationale: "n/a — find_root_cause_only; fix direction recorded for the gap planner"
  blind_spots: "Not run: the test itself (static analysis only) — but its passing status is established by 12-VERIFICATION.md and UAT, and vacuity is proven by code structure, not runtime observation. Not verified: whether a seeded campaign makes the drain assertion's 15s timeout tight (transitionToSending adds 2 DB round trips to one tick; negligible)."
  candidate_causes:
    - "code/test-design: assertion polarity written for the empty-DB case (CONFIRMED root cause)"
    - "environment: test harness lacks a Postgres handle so side effects are unobservable (ELIMINATED — ensureTestDbMigrated + global-setup DSN publication + failed:0 across 20 scan-executing ticks prove the DB path is live)"
    - "config/data: RLS or role grants prevent seeding from this file (ELIMINATED — sibling file campaign-scheduler-scan.test.ts seeds successfully in the identical harness)"
  and_gate: "No — single root cause. The empty dataset and the all-zeros assertion are two facets of one deliberate test-design decision (the in-file comment documents it); no second independent condition is required for the vacuity to manifest."

## Resolution

root_cause: |
  Test-design defect (single cause, no AND-gate): the burst-absorption case in
  apps/worker/src/queues/__tests__/worker-autorun-default.test.ts:255-320 claims to prove
  "a stacked burst ... drains ... without duplicated kickoff work", but it never seeds a campaign,
  so the assertion that is supposed to detect duplicated kickoff work — line 310,
  `expect(kickoffCounts).toMatchObject({ waiting: 0, active: 0, delayed: 0, completed: 0, failed: 0 })`
  — expects ZERO kickoff jobs. With the ephemeral test database empty of campaign rows,
  findDueCampaignCandidates() (apps/worker/src/queues/campaign-scheduler.worker.ts:59-67,
  `WHERE status = 'scheduled' AND scheduled_at <= now()`) returns [] on every one of the 20+ burst
  ticks, so the processor's dedup-bearing loop body (campaign-scheduler.worker.ts:200-204 —
  transitionToSending's FOR UPDATE SKIP LOCKED re-check at lines 83-101, the
  `if (!transitioned) continue` guard, and the deterministic `jobId: row.id` kickoff enqueue) executes
  exactly zero times. An all-zero kickoff queue is therefore observed whether or not the dedup
  mechanism works — the assertion is vacuously true by construction, as the test's own comment at
  lines 297-301 admits. The infrastructure to make it non-vacuous is ALREADY present in the file
  (per-test throwaway Redis; migrated ephemeral Postgres via ensureTestDbMigrated() at line 168,
  reachable because packages/test-support/src/global-setup.ts:104-115 publishes DATABASE_URL /
  SCAN_DATABASE_URL / AUTH_DATABASE_URL to every test worker — proven live by the test's own
  `failed: 0` tick-queue assertion passing across 20 scan-executing jobs). What is missing is only
  (a) seeding one workspace + one past-due `scheduled` campaign (exact recipe exists at
  campaign-scheduler-scan.test.ts:32-56) and (b) flipping the assertion to expect exactly ONE kickoff
  job (jobId === campaignId) across waiting+active+delayed+completed+failed and exactly one
  scheduled→sending row transition.
fix: (out of scope — find_root_cause_only; direction below for /gsd-plan-phase --gaps)
fix_direction: |
  In the burst case of worker-autorun-default.test.ts, after the suppressed worker registers and
  before (or while) the 20-job burst is stacked:
  1. Seed: `const workspaceId = await insertFixtureOrganization("burst-dedup")` (import from
     ../../test/failure-fixtures.js), then under withTenant/withTenantTransaction INSERT one segments
     row and one campaigns row with status='scheduled', scheduled_at = now() - interval '1 minute' —
     copy seedDueCampaign from campaign-scheduler-scan.test.ts:32-56 (or extract it into
     failure-fixtures.ts for reuse). No env plumbing needed; global-setup already publishes the DSNs.
  2. Keep the existing tick-queue drain assertion (waiting/active/failed → 0, failed === 0 now also
     proves the scan+transition path succeeded 20+ times against real data).
  3. Replace the all-zeros kickoff assertion (line 310) with:
     - total kickoff jobs across waiting+active+delayed+completed+failed === 1 (the job sits in
       `waiting` — nothing consumes CAMPAIGN_KICKOFF_QUEUE in this test; NB 12-REVIEW WR-03's
       "completed === 1" suggestion is wrong on this detail);
     - `await drainKickoffQueue.getJob(campaignId)` is non-null (proves the deterministic
       jobId === campaignId seam end to end);
     - campaign row readback via withTenant (campaignStatus recipe,
       campaign-scheduler-scan.test.ts:58-68): status === 'sending' — combined with kickoff-count 1
       this proves exactly one transition (kickoff is only enqueued when transitionToSending actually
       transitioned the row, campaign-scheduler.worker.ts:202-203); optionally also read
       sending_started_at once drained and assert it equals a re-read after a further tick to pin
       "transitions only once" directly — for that further tick, do NOT wait for the scheduler's
       next 60s interval (SCAN_INTERVAL_MS): enqueue one extra manual `scan-due-campaigns` job
       (same shape as the burst jobs) and wait for it to drain.
  4. Optionally retain an empty-DB control case under an honest name ("no due campaigns → no kickoff
     jobs"), or drop the framing entirely — do NOT keep the "without duplicated kickoff work" name on
     a zero-expectation assertion.
  Oracle type: specified (exact counts from the UAT truth statement); boundary neighbor already
  covered by the existing zero-campaign behavior if kept as a control case.
verification: n/a (diagnosis only)
files_changed: []
specialist_hint: typescript
