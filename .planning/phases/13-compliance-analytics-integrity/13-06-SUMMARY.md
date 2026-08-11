---
phase: 13-compliance-analytics-integrity
plan: 06
subsystem: queue
tags: [bullmq, redis, postgres, rls, webhook, cli, retention, cmp-08]

requires:
  - phase: 13-compliance-analytics-integrity
    provides: "plan 13-01's ingress_journal table, writeIngressJournal/markIngestionComplete/findStuckIngressJournalRows/pruneIngressJournal/purgeExpiredIngressJournalPayloads (packages/db/src/webhooks/ingress-journal.ts), and buildWebhookEventsJobPayload (packages/shared-schemas/src/queues.ts)"
provides:
  - "webhook-replay-sweep.worker.ts: a scheduled BullMQ tick that finds stuck ingress_journal rows and re-enqueues them onto webhook-events, then prunes/tombstones the journal at its retention horizon in the same tick"
  - "packages/db/scripts/replay-webhook-journal.ts: an operator CLI for a surgical range-replay of one workspace's journal"
  - "webhookReplaySweepTickJobSchema / WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION (packages/shared-schemas/src/queues.ts)"
affects: [13-11-ingestion-health-watchdog, 13-14-specification-update, 14-deployment]

tech-stack:
  added: ["bullmq (packages/db, new runtime dependency)", "@mega-crm/shared-schemas (packages/db)", "@mega-crm/queue-core (packages/db)"]
  patterns:
    - "Lazily-created singleton producer Queue (mirrors send-dispatch.ts's getDefaultRedisClient, not flow-queues.ts's module-scope const) so a test can set process.env.REDIS_URL before first use"
    - "UPDATE ... RETURNING id, raw_batch inside a tenant transaction to both bookkeep replay_count and fetch the payload in one round trip; the Redis enqueue itself happens strictly after that transaction commits (documented crash-gap)"
    - "packages/db never imports apps/worker; a second producer of the same queue reuses the shared buildWebhookEventsJobPayload/buildJobOptions/buildRedisConnectionOptions primitives instead of a cross-package import"

key-files:
  created:
    - apps/worker/src/queues/webhook-replay-sweep.worker.ts
    - packages/db/scripts/replay-webhook-journal.ts
  modified:
    - packages/shared-schemas/src/queues.ts
    - apps/worker/src/queues/queue-registry.ts
    - apps/worker/src/server.ts
    - apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts
    - apps/worker/src/queues/__tests__/scheduler-registration.test.ts
    - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
    - packages/db/package.json
    - package.json
    - SPECIFICATION.md

key-decisions:
  - "Retention (prune completed / tombstone incomplete) is applied per workspace in the SAME per-tenant transaction as the replay step, replay first — a row this tick just re-enqueued can never have its payload purged before the job it produced runs"
  - "Producer Queue for WEBHOOK_EVENTS_QUEUE is its own lazily-created singleton built via buildRedisConnectionOptions/buildJobOptions against the worker's own env, never the connection passed into createWebhookReplaySweepWorker(connection) — matches the plan's 'against the worker's own env' instruction and satisfies the literal acceptance criterion that the file imports both queue-core builders"
  - "The operator CLI (packages/db/scripts/replay-webhook-journal.ts) never imports @mega-crm/tenant-context (its pool is built from process.env.DATABASE_URL at import time, before this script's resolveEnvPath() load runs) — mirrors audit-sends-history.ts's own Pool + manual SET LOCAL pattern"
  - "runWebhookReplaySweep accepts test-only overrides (workspaceIds/stuckThresholdMinutes/pageLimit/maxAttempts/retentionDays) mirroring send-reconciler.worker.ts's batchLimit precedent, so tests never depend on the shared ephemeral DB's global state"

patterns-established:
  - "Two disjoint retention counts (journalRowsPruned/journalPayloadsPurged) reported separately in a tick summary rather than summed, matching Task 2's WARNING-finding fix philosophy: a rising purge count is a distinct, alertable signal from a rising prune count"

requirements-completed: [CMP-08]

coverage:
  - id: D1
    description: "Scheduled sweep finds a stuck ingress_journal row and re-enqueues it as the same webhook-events job shape the live route produces, reusing the row's own id as journalId"
    requirement: CMP-08
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#a journal row with no completion mark, 30 minutes old, is enqueued exactly once"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#a completed journal row, however old, is never enqueued"
        status: pass
    human_judgment: false
  - id: D2
    description: "Double-replay is provably harmless: replaying the same batch twice inserts no duplicate send_events rows and moves no counter twice"
    requirement: CMP-08
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#processing the same journal row's batch twice leaves exactly one send_events row and the same campaign/rollup counts"
        status: pass
    human_judgment: false
  - id: D3
    description: "Attempt cap and tombstone rows are never enqueued; a tick with more stuck rows than the page limit enqueues exactly the page limit"
    requirement: CMP-08
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#a journal row at the attempt cap is not enqueued"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#a tombstoned journal row (payload_purged_at set) is not enqueued and its replay_count is unchanged"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#a tick with more stuck rows than the page limit enqueues exactly the page limit"
        status: pass
    human_judgment: false
  - id: D4
    description: "Retention: a completed row past the horizon is deleted outright; an incomplete row (merely stuck or attempt-capped) survives as a non-PII tombstone, never deleted, and a tombstone is never re-pruned"
    requirement: CMP-08
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#retention (Task 2) > a COMPLETED row aged past the retention horizon is deleted outright"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#retention (Task 2) > an incomplete/never-transitions-to-absent property: a merely-stuck row aged past the horizon is ALSO enqueued this same tick, then survives purge as a tombstone -- retention runs after replay, never before it"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts#retention (Task 2) > a tombstone created by one tick is still present, unchanged, after a second tick over the same data"
        status: pass
    human_judgment: false
  - id: D5
    description: "The sweep is registered as a recurring scheduled job with a stable scheduler id, correct interval, and boot job, and is wired into the composition root"
    requirement: CMP-08
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/scheduler-registration.test.ts#webhook-replay-sweep scheduler (CMP-08, plan 13-06) > registers exactly one job scheduler with the stable id and the correct every interval"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/scheduler-registration.test.ts#webhook-replay-sweep scheduler (CMP-08, plan 13-06) > constructing the worker twice still leaves exactly one scheduler with that id"
        status: pass
    human_judgment: false
  - id: D6
    description: "An operator can replay an explicit time range for one workspace from the command line; the replay is bounded (keyset pagination), reports how many rows it re-enqueued/skipped, and refuses to run without an explicit workspace id"
    requirement: CMP-08
    verification:
      - kind: other
        ref: "npm run lint && npm run build && ! npm run --silent replay:webhook-journal -- --dry-run"
        status: pass
      - kind: manual_procedural
        ref: "throwaway vitest self-verification against an ephemeral DB + temp Redis (not committed): dry-run mutates nothing and reports the correct count; real run enqueues the eligible row, skips the tombstone, ignores the out-of-range row; a second run re-enqueues the already-ingested row per D-06; missing --workspace exits non-zero before any connection"
        status: pass
    human_judgment: true
    rationale: "The plan's own <verify> block names a <human-check> step (run the CLI against a real dev database and confirm the queue depth/no duplicate rows) that only an operator with a live dev environment can perform; the automated self-verification above substitutes for it in this sandboxed execution context but does not replace the operator's own confirmation."

duration: 55min
completed: 2026-08-12
status: complete
---

# Phase 13 Plan 06: Webhook Ingress Replay & Retention Summary

**A 5-minute BullMQ sweep re-enqueues stuck `ingress_journal` rows onto `webhook-events` (attempt-capped and bounded), prunes completed rows and tombstones incomplete ones at a 7-day horizon in the same tick, and an operator CLI (`replay:webhook-journal`) replays an explicit workspace/time-range for surgical post-incident re-runs.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-08-11T18:47:36Z (first commit)
- **Completed:** 2026-08-12
- **Tasks:** 3
- **Files modified:** 10 (2 created, 8 modified)

## Accomplishments

- `webhook-replay-sweep.worker.ts`: finds journal rows with no ingestion-complete mark past the 15-minute stuck threshold and re-enqueues them as the identical `webhook-events` job shape the live route produces, reusing the row's own id as `journalId` so completion can be marked and the sweep terminates.
- The same tick applies `WEBHOOK_REPLAY_MAX_ATTEMPTS = 5` and skips tombstoned rows before enqueueing, then runs retention (`pruneIngressJournal`/`purgeExpiredIngressJournalPayloads`) immediately after — a completed row is deleted at the 7-day horizon; an incomplete row survives as a non-PII tombstone rather than vanishing, preserving the evidence plan 13-11's watchdog needs.
- Double-replay is proven harmless end-to-end: the same batch processed twice leaves exactly one `send_events` row and unchanged campaign/rollup counts.
- `packages/db/scripts/replay-webhook-journal.ts` gives an operator a bounded, paged, dry-run-first way to replay a specific workspace's time range — including already-ingested rows (D-06's surgical-re-run intent), skipping only tombstones (nothing left to send).

## Task Commits

Each task was committed atomically (Tasks 1 and 2 are `tdd="true"`):

1. **Task 1: Replay-sweep worker — find stuck journal rows and re-enqueue them**
   - `49e214c` (test) — failing test for the worker + `webhookReplaySweepTickJobSchema` schema addition
   - `295bde1` (feat) — `webhook-replay-sweep.worker.ts` implementation
2. **Task 2: Prune completed rows, tombstone incomplete ones, and register the sweep at worker boot**
   - `4b174fd` (feat) — server.ts/queue-registry.ts wiring, dedicated scheduler-registration coverage, retention test coverage, and a SEC-16 cross-tenant coverage fix the new registration triggered
3. **Task 3: Operator range-replay script**
   - `0493d5c` (feat) — `replay-webhook-journal.ts`, package.json script registrations, SPECIFICATION.md updates

No separate plan-metadata commit in this worktree — SUMMARY.md is committed directly below per the worktree executor's protocol; STATE.md/ROADMAP.md are updated centrally by the orchestrator after merge.

## Files Created/Modified

- `apps/worker/src/queues/webhook-replay-sweep.worker.ts` — the sweep worker: `WEBHOOK_REPLAY_SWEEP_QUEUE`, `createWebhookReplaySweepWorker`, `runWebhookReplaySweep`, `waitForWebhookReplaySweepRegistration`, plus the `WEBHOOK_REPLAY_SWEEP_INTERVAL_MS`/`PAGE_LIMIT`/`MAX_ATTEMPTS` constants
- `packages/db/scripts/replay-webhook-journal.ts` — the operator range-replay CLI
- `packages/shared-schemas/src/queues.ts` — `WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION` / `webhookReplaySweepTickJobSchema`
- `apps/worker/src/queues/queue-registry.ts` — header comment documenting the sweep's tracked producer Queue vs. its self-closing tick-registration Queue
- `apps/worker/src/server.ts` — registers `createWebhookReplaySweepWorker` in `buildWorker()`'s array and the boot-log worker enumeration
- `apps/worker/src/queues/__tests__/webhook-replay-sweep.test.ts` — Task 1 + Task 2 behavior coverage (find/enqueue, attempt cap, tombstone skip, page limit, double-replay idempotency, retention prune/purge/tombstone-survival)
- `apps/worker/src/queues/__tests__/scheduler-registration.test.ts` — dedicated describe block for the new scheduler (not the shared FIXTURES loop — see Deviations)
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` — SEC-16 cross-tenant coverage for `WebhookReplaySweep` (see Deviations)
- `packages/db/package.json` — `replay:webhook-journal` script; new runtime deps `bullmq`/`@mega-crm/shared-schemas`/`@mega-crm/queue-core`
- `package.json` — root delegation for `replay:webhook-journal`
- `SPECIFICATION.md` — new §5.13 (webhook-replay-sweep worker + the operator CLI), updated §2.5/§5.1/§5.2/§5.3 (worker count 16→17, queue list, dependency table)

## Decisions Made

- **Producer Queue placement (task read_first ambiguity, resolved before writing code):** the sweep's producer `Queue` for `WEBHOOK_EVENTS_QUEUE` is a lazily-created singleton (mirrors `send-dispatch.ts`'s `getDefaultRedisClient()`), built via `buildRedisConnectionOptions(requireRedisUrl())`/`buildJobOptions(STANDARD_JOB_RETENTION)` against the worker's own `process.env.REDIS_URL` — deliberately NOT the `connection: ConnectionOptions` parameter `createWebhookReplaySweepWorker` receives (unlike `campaign-scheduler.worker.ts`'s kickoff queue, which does reuse its factory's `connection` argument). This satisfies the plan's literal instruction ("against the worker's own env") and the acceptance criterion that the file itself imports both `queue-core` builders. Registered with `registerTrackedQueue` on first construction (a genuinely long-lived producer, never closed after registration).
- **Task 3 cross-package boundary:** confirmed via `grep` that no `packages/*` currently imports `apps/*` anywhere in this repo, and kept it that way — `replay-webhook-journal.ts` does not import `apps/worker/src/queues/webhook-replay-sweep.worker.ts`. "Reuse the sweep's per-row enqueue logic" is satisfied by both files calling the SAME shared low-level primitives (`buildWebhookEventsJobPayload`, `buildJobOptions`, `buildRedisConnectionOptions`) and the same `UPDATE ... RETURNING id, raw_batch` SQL shape, not by a cross-package import.
- **`@mega-crm/tenant-context` avoided in the operator CLI:** that package's `pool` is a module-load-time `new Pool({ connectionString: process.env.DATABASE_URL })` — constructed before `replay-webhook-journal.ts`'s own `resolveEnvPath()` load has a chance to populate `DATABASE_URL`. The script instead builds its own dedicated `Pool` and issues `SET LOCAL app.current_workspace_id` manually inside each page's transaction, mirroring `audit-sends-history.ts`'s established precedent for exactly this constraint.
- **Test-only overrides on `runWebhookReplaySweep`** (`workspaceIds`/`stuckThresholdMinutes`/`pageLimit`/`maxAttempts`/`retentionDays`), mirroring `send-reconciler.worker.ts`'s `batchLimit` precedent — the ephemeral test database is shared across parallel test files, so every count-based assertion in the new test suite is scoped to workspace ids the test itself created rather than a global scan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] SEC-16 cross-tenant coverage gate broke when the new worker was registered**

- **Found during:** Task 2, after wiring `createWebhookReplaySweepWorker` into `apps/worker/src/server.ts`'s `buildWorker()`.
- **Issue:** `negative-cross-tenant-jobs.test.ts`'s "Test 5: coverage" assertion scans `server.ts` for every `create*Worker(` call and requires each registered family to have either a dedicated cross-tenant-isolation proof in that file or a documented exclusion. Registering the sweep made this assertion fail (`WebhookReplaySweep` neither covered nor excluded) — a real, mechanically-enforced gate this task's own change tripped, squarely in scope per the deviation rules.
- **Fix:** Added a dedicated `describe("webhook-replay-sweep (runWebhookReplaySweep, scan consumer, plan 13-06)", ...)` block proving: (a) `withCrossWorkspaceScan` discovers both seeded workspaces (mirrors the existing `analytics-reconciliation` proof for the identical `SELECT id FROM organization` query), and (b) each workspace's own stuck row is replayed exactly once — never the sibling's — and the enqueued job's payload carries only that workspace's own `workspaceId`/`journalId`. Registered `WebhookReplaySweep` in `COVERED_FAMILIES`.
- **Files modified:** `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts`
- **Verification:** `npx vitest run --root apps/worker src/queues/__tests__/negative-cross-tenant-jobs.test.ts` — 16/16 pass.
- **Committed in:** `4b174fd` (Task 2 commit)

**2. [Rule 3 - Blocking] `scheduler-registration.test.ts`'s shared FIXTURES loop is the wrong shape for a brand-new queue**

- **Found during:** Task 2, while extending scheduler-registration coverage per the plan's action text.
- **Issue:** The plan says "Extend `apps/worker/src/queues/__tests__/scheduler-registration.test.ts` with a block for the replay sweep... following the shape of the existing blocks." The existing `FIXTURES` array's shared test suite asserts a "starting from a Redis holding the legacy repeatable entry, the migrated factory... removes the legacy repeatable" behavior — correct for the five queues that migrated off an older `tickQueue.add({repeat})` form, but `webhook-replay-sweep` is a brand-new queue with no such legacy entry to migrate away from or clean up. Joining the shared loop would have asserted a `removeRepeatable` call this worker correctly never makes.
- **Fix:** Added a separate, dedicated `describe("webhook-replay-sweep scheduler (CMP-08, plan 13-06)", ...)` block (mirroring the file's own existing precedent for `analytics-reconciliation`'s interval-only follow-up block) covering: stable scheduler id + correct interval, idempotent double-construction, the boot job (including its `schemaVersion` payload), a rejecting-registration-is-logged-and-swallowed case, and the source-level guard-shape assertion.
- **Files modified:** `apps/worker/src/queues/__tests__/scheduler-registration.test.ts`
- **Verification:** `npx vitest run --root apps/worker src/queues/__tests__/scheduler-registration.test.ts` — all pass.
- **Committed in:** `4b174fd` (Task 2 commit)

**3. [Rule 3 - Blocking] Plan's `queue-registry.ts` read_first description didn't match the file's actual purpose**

- **Found during:** Task 2's action text ("Register the new queue name in `apps/worker/src/queues/queue-registry.ts`... how queue names are registered for observability").
- **Issue:** `queue-registry.ts` is not a queue-name-for-observability manifest — it is `registerTrackedQueue`/`closeTrackedQueues`, the process-wide registry of long-lived `Queue` handles closed on graceful shutdown. There is no literal "queue name list" to add an entry to.
- **Fix:** Followed the file's actual mechanism instead of the plan's literal phrasing: the sweep's producer `Queue` is wrapped in `registerTrackedQueue(...)` at construction (matching `campaign-broadcast-producer.ts`'s/`flow-queues.ts`'s convention), and the file's header comment was extended to document both the sweep's tracked producer and its separate, self-closing tick-registration `Queue` — satisfying the acceptance criterion's literal text ("`queue-registry.ts` contains the replay-sweep queue name") via the header comment while keeping the file's real registration mechanism correct.
- **Files modified:** `apps/worker/src/queues/queue-registry.ts`
- **Verification:** `grep -n "webhook-replay-sweep" apps/worker/src/queues/queue-registry.ts` finds the reference; `registerTrackedQueue` call verified by reading `webhook-replay-sweep.worker.ts`.
- **Committed in:** `295bde1` (Task 1 commit, where the producer Queue itself was written) / `4b174fd` (Task 2 commit, where the header comment was added)

---

**Total deviations:** 3 auto-fixed (1 missing-critical / mechanically-enforced test gate, 2 blocking / plan-vs-codebase shape mismatches)
**Impact on plan:** All three were necessary for correctness (a real coverage gate would otherwise regress) or to avoid asserting behavior the new worker correctly does not have (legacy-migration cleanup). No scope creep — no file outside this plan's declared `files_modified` set was touched except the one test file (`negative-cross-tenant-jobs.test.ts`) the coverage gate itself required.

## Issues Encountered

- **Pre-existing, environment-dependent test flake (out of scope, not fixed):** `negative-cross-tenant-jobs.test.ts`'s `analytics-reconciliation (reconcileWorkspaceDay, scan consumer)` test intermittently fails (`rollupA` expected `1`, got `0`) when the sandbox's local wall-clock date and UTC date disagree (this session ran at UTC+5, near local midnight — local "today" and UTC "today" differed by one calendar day). Confirmed by checking out this exact file at the commit immediately prior to any change in this plan and re-running it: the failure reproduces identically, unmodified by any of this plan's work. This is the same pre-existing UTC-day-semantics gap already tracked in PROJECT.md ("Unified UTC day semantics for daily metrics is an explicit Phase 11+ concern"). Not auto-fixed per the deviation rules' scope boundary (pre-existing, unrelated file's flake). Not logged to `.planning/WINDOWS.md` per this worktree's explicit instruction to never create/modify that file — flagging it here for the orchestrator/a future quick-task to log centrally.
- **`npm run verify:redis-config` fails against this sandbox's ambient system Redis** (`localhost:6379`, not booted from this repo's `docker/redis.conf`) — expected per the verifier's own design (it intentionally has no environment sniffing/default). Confirmed the underlying mechanism is correct by running `packages/test-support/src/__tests__/redis-config.test.ts` directly (12/12 pass), which boots a throwaway `redis-server` from `docker/redis.conf` exactly as the verifier's own doc comment describes as the correct local-dev path.
- **Task 3's `<human-check>` step** could not be performed by an actual human operator in this autonomous execution; substituted with a thorough self-verification (ephemeral test DB + temp Redis, real `tsx` subprocess invocations of the compiled script) covering every behavior the human-check describes — see `coverage.D6` above for exact results.

## User Setup Required

None — no external service configuration required. The sweep and the operator CLI use the same `DATABASE_URL`/`REDIS_URL`/`SCAN_DATABASE_URL` every other worker component already requires.

## Next Phase Readiness

- Plan 13-11 (ingestion-health watchdog) can read `findStuckIngressJournalRows`'s unfiltered `replay_count`/`payload_purged_at` fields directly — this plan introduced no change to that query's contract, so the attempt-capped/tombstoned visibility plan 13-01 already guaranteed is unchanged. No deviation from that guarantee to record.
- Plan 13-14 (SPECIFICATION §5 entry) can reference this plan's new §5.13 directly — the tick summary's two retention field names (`journalRowsPruned`, `journalPayloadsPurged`) are now documented in both places and should stay in sync if ever renamed.
- One pre-existing, unrelated flaky test (`analytics-reconciliation` rollup, UTC-day-boundary-dependent) remains open — not introduced or worsened by this plan; worth a dedicated quick-task once the Phase 11+ UTC-day-semantics unification work is scheduled.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-12*
