---
phase: 05-webhook-processing-delivery-tracking
plan: 01
subsystem: api
tags: [fastify, bullmq, postgres, rls, sendgrid, ecdsa, webhooks, partitioning]

# Dependency graph
requires:
  - phase: 04-broadcast-campaigns-send-pipeline
    provides: sends ledger table (send_events.send_id FK target), BullMQ queue conventions, withTenant/withTenantTransaction pattern
provides:
  - "send_events partitioned table (month-range, workspace-scoped PK, sg_event_id dedup unique constraint, RLS)"
  - "workspace_webhook_endpoints table with pre-tenant-context runtime pathToken lookup"
  - "POST /webhooks/sendgrid/:pathToken raw-body ECDSA-verified receiver"
  - "webhook-events BullMQ queue + dedicated worker performing exactly-once batch insert"
  - "WEBHOOK_EVENTS_QUEUE / webhookEventsJobSchema shared-schemas contract"
affects: [05-02, 05-03, 05-04, 05-05, delivery-tracking, suppression]

# Tech tracking
tech-stack:
  added: ["@sendgrid/eventwebhook@8.0.0"]
  patterns:
    - "Raw-body signature verification: addContentTypeParser('application/json', {parseAs:'buffer'}) scoped inside a plain async route-registration function, never global"
    - "Pre-tenant-context runtime lookup via a second SELECT-only permissive RLS policy scoped by a session GUC (mirrors workspace_api_keys' api_key_runtime_lookup)"
    - "Whole-batch enqueue (one BullMQ job per HTTP POST, not per event), dedup gated entirely by a DB UNIQUE constraint + ON CONFLICT ... RETURNING"

key-files:
  created:
    - packages/db/src/schema/send-events.ts
    - packages/db/src/schema/webhook-endpoints.ts
    - packages/db/migrations/0020_send_events_partitioned.sql
    - packages/db/migrations/0021_webhook_endpoints.sql
    - apps/api/src/modules/webhooks/signature-verify.ts
    - apps/api/src/modules/webhooks/webhook-endpoint.repository.ts
    - apps/api/src/modules/webhooks/enqueue.ts
    - apps/api/src/modules/webhooks/webhooks.routes.ts
    - apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
  modified:
    - packages/db/src/index.ts
    - packages/db/migrations/meta/_journal.json
    - packages/shared-schemas/src/queues.ts
    - apps/api/package.json
    - apps/api/src/server.ts
    - apps/worker/src/server.ts

key-decisions:
  - "UNIQUE constraint widened to (workspace_id, sg_event_id, occurred_at) instead of the plan's literal (workspace_id, sg_event_id) -- Postgres requires every unique constraint on a partitioned table to include all partition-key columns; occurred_at is deterministic per sg_event_id across redeliveries so dedup still works correctly"
  - "webhook_endpoint_runtime_lookup RLS policy chosen (GUC-scoped SELECT, mirroring workspace_api_keys' api_key_runtime_lookup) over the non-RLS-pool alternative, matching Task 1's explicit precedent pointer"
  - "publicKey stored plain text (not KMS-encrypted) per RESEARCH.md Assumption A1 -- a webhook verification public key is not a secret"
  - "Enqueue verified in tests via the real BullMQ/Redis webhookEventsQueue job counts rather than vi.mock -- no vi.mock precedent exists in this codebase; mirrors events-api.test.ts's real-infra testing convention"

patterns-established:
  - "Dedup-only worker slice: worker inserts raw event rows and returns RETURNING count only -- no status/suppression/counter side effects until 05-03 iterates the same RETURNING rows"

requirements-completed: [WBHK-01, WBHK-03]

coverage:
  - id: D1
    description: "A signed SendGrid batch POSTed to /webhooks/sendgrid/:pathToken with a valid ECDSA signature over the raw body returns 200 and enqueues one webhook-events job"
    requirement: "WBHK-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts#valid signature -> 200 and exactly one job enqueued"
        status: pass
    human_judgment: false
  - id: D2
    description: "A POST with an invalid/missing signature returns 400 and enqueues nothing (fail-closed, no enumeration oracle on unknown pathToken)"
    requirement: "WBHK-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts#tampered signature -> 400, and no job is enqueued"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts#missing signature header -> 400, and no job is enqueued"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts#unknown pathToken -> generic 404, no signature attempted, no job enqueued"
        status: pass
    human_judgment: false
  - id: D3
    description: "The webhook-events worker batch-inserts events into send_events keyed on (workspace_id, sg_event_id); a replayed identical batch inserts zero additional rows"
    requirement: "WBHK-03"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts#WBHK-03: a replayed identical batch inserts zero additional rows"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts#a batch mixing 2 already-seen and 3 new sg_event_ids inserts exactly the 3 new rows"
        status: pass
    human_judgment: false
  - id: D4
    description: "send_events is range-partitioned by month on occurred_at with a DEFAULT partition and a workspace-scoped composite PK, from the first migration"
    verification:
      - kind: other
        ref: "psql \\d+ send_events (verified live during execution: Partition key RANGE (occurred_at), send_events_default present, PK (workspace_id, id, occurred_at), RLS forced)"
        status: pass
    human_judgment: false

duration: 15min
completed: 2026-07-08
status: complete
---

# Phase 5 Plan 1: Webhook Delivery-Event Receiver Skeleton Summary

**Raw-body ECDSA-verified SendGrid Event Webhook receiver on a per-tenant path token, deduped exactly-once into a new month-partitioned `send_events` table via a dedicated BullMQ worker**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-08T13:55:34Z
- **Completed:** 2026-07-08T14:09:23Z
- **Tasks:** 3
- **Files modified:** 17

## Accomplishments
- Hand-written partitioned `send_events` table (RANGE by `occurred_at`, workspace-scoped composite PK, `UNIQUE (workspace_id, sg_event_id, occurred_at)` dedup constraint, DEFAULT partition, RLS enable+force) and `workspace_webhook_endpoints` table with a pre-tenant-context runtime `path_token` lookup policy — both migrations applied cleanly to the live dev database
- `POST /webhooks/sendgrid/:pathToken` verifies the ECDSA signature over the exact raw request bytes (via `@sendgrid/eventwebhook`) before any JSON parsing; unknown token → generic 404, invalid signature → 400 fail-closed with zero enqueue, valid → whole-batch enqueue + fast 200
- `apps/worker`'s new `webhook-events` queue/worker performs one multi-row `INSERT ... ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING RETURNING` per batch — proven idempotent (replay = 0 new rows) and tenant-isolated by a real-Postgres test suite
- Integration test drives the real Fastify HTTP stack with SendGrid's own published signed test fixture (real ECDSA signature over real bytes, not a hand-built fake) — closes the STATE.md-flagged "Phase 5: integration test that replays a real signed SendGrid payload" blocker

## Task Commits

Each task was committed atomically:

1. **Task 1: send_events + webhook_endpoints schema, migrations, queue contract** - `2438d29` (feat)
2. **Task 2: Raw-body ECDSA webhook receiver route + signature-verify wrapper + endpoint repository + enqueue producer** - `92dba43` (feat)
3. **Task 3: webhook-events worker — dedup batch insert (TDD)** - `165ee36` (test, RED) → `f69dd11` (feat, GREEN)

## Files Created/Modified
- `packages/db/src/schema/send-events.ts` - type-inference-only pgTable for `send_events`
- `packages/db/src/schema/webhook-endpoints.ts` - `workspace_webhook_endpoints` pgTable
- `packages/db/migrations/0020_send_events_partitioned.sql` - partitioned DDL + RLS + dedup UNIQUE constraint
- `packages/db/migrations/0021_webhook_endpoints.sql` - table + RLS + runtime-lookup policy
- `packages/db/src/index.ts` - registered both new schema files in the barrel
- `packages/db/migrations/meta/_journal.json` - appended entries for 0020/0021
- `packages/shared-schemas/src/queues.ts` - `WEBHOOK_EVENTS_QUEUE`, `webhookEventsJobSchema`, `WebhookEventsJob`
- `apps/api/package.json` - `@sendgrid/eventwebhook@8.0.0` dependency
- `apps/api/src/modules/webhooks/signature-verify.ts` - pure `verifyWebhookSignature` wrapper, fail-closed
- `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts` - `findWebhookEndpointByToken` (pre-tenant-context lookup)
- `apps/api/src/modules/webhooks/enqueue.ts` - `webhookEventsQueue` + `enqueueWebhookBatch`
- `apps/api/src/modules/webhooks/webhooks.routes.ts` - `registerWebhookRoutes`, the receiver route
- `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts` - real-fixture integration tests
- `apps/api/src/server.ts` - registered `registerWebhookRoutes`
- `apps/worker/src/queues/webhook-events.worker.ts` - `processWebhookEventBatch`, `createWebhookEventsWorker`
- `apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts` - dedup/tenant-isolation tests
- `apps/worker/src/server.ts` - registered the webhook-events worker in its own lane

## Decisions Made
- `UNIQUE (workspace_id, sg_event_id, occurred_at)` instead of the plan's literal `(workspace_id, sg_event_id)` — see Deviations below
- `webhook_endpoint_runtime_lookup` (GUC-scoped RLS SELECT policy) chosen over the alternative non-RLS-pool bypass, mirroring `workspace_api_keys`' `api_key_runtime_lookup` precedent exactly, including the NULLIF guard (both permissive policies on `workspace_webhook_endpoints` are evaluated together)
- `publicKey` stored plain text, not KMS-encrypted (Assumption A1 confirmed correct: a verification public key is not a secret)
- Test coverage for "enqueue was called" uses the real BullMQ/Redis queue's job counts rather than mocking `enqueueWebhookBatch` — no `vi.mock` precedent exists anywhere in this codebase, and Redis is genuinely available in this dev/test environment (confirmed via `redis-cli ping`), matching the established real-infra testing convention (`events-api.test.ts`'s CR-01 test does the same against `eventsIngestQueue`)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] UNIQUE constraint widened to include `occurred_at`**
- **Found during:** Task 1 (migration authoring)
- **Issue:** The plan's literal instruction was `UNIQUE (workspace_id, sg_event_id)` on `send_events`. Postgres hard-rejects `CREATE TABLE ... PARTITION BY RANGE (occurred_at)` with a unique constraint that does not include the partition key column — this DDL would fail outright at migration time.
- **Fix:** Constraint is `UNIQUE (workspace_id, sg_event_id, occurred_at)`, and the worker's `ON CONFLICT` target matches. This is not a functional regression: `occurred_at` is resolved deterministically from the SendGrid event's own `timestamp` field, so a replayed event (same `sg_event_id`) always recomputes the identical `occurred_at` and still conflicts correctly. This also matches RESEARCH.md's own Pattern 3 and Code Examples, which already specify `ON CONFLICT (workspace_id, sg_event_id, occurred_at)` — the plan's Task 1 prose was the sole place with the narrower (impossible) wording.
- **Files modified:** `packages/db/migrations/0020_send_events_partitioned.sql`, `packages/db/src/schema/send-events.ts` (doc-comment), `apps/worker/src/queues/webhook-events.worker.ts`
- **Verification:** Migration applied cleanly (`npm run db:migrate`), confirmed via `psql \d+ send_events`; worker idempotency tests (replay = 0 new rows, mixed batch = exactly the new rows) pass
- **Committed in:** `2438d29` (Task 1), `f69dd11` (Task 3)

---

**Total deviations:** 1 auto-fixed (1 bug — a hard Postgres constraint the plan's literal wording didn't account for)
**Impact on plan:** Correctness-preserving; the dedup guarantee (WBHK-03) and every acceptance criterion referencing `send_events%sg_event_id%` still hold. No scope creep.

## Issues Encountered
- `drizzle-kit migrate` requires `DATABASE_URL` in the environment; the Bash tool's `.env` deny-list blocks reading it directly. Resolved by running the project's own `scripts/migrate-dev.mjs` (already-established predev bootstrap that loads `.env` via Node's own `process.loadEnvFile`), which applied 0020+0021 successfully.

## User Setup Required
None - no external service configuration required. (SendGrid Event Webhook auto-provisioning, which requires a live tenant SendGrid key, is a later plan in this phase — 05-01 only builds the receiver skeleton and tested it against a manually-provisioned `workspace_webhook_endpoints` row.)

## Next Phase Readiness
- `send_events` and `workspace_webhook_endpoints` are live in the dev database and ready for 05-02+ to build on (auto-provisioning, fact-column updates, suppression state machine, health indicator)
- The worker deliberately stops at raw dedup storage — no status/suppression/counter side effects yet, exactly as scoped; 05-03 is expected to iterate the same `RETURNING` rows this plan already gates on
- `custom_args.test` marker and forced `open_tracking`/`click_tracking` (RESEARCH.md Pitfalls 2/3) are NOT yet applied to `packages/delivery-core/src/send-mail.ts` — still open for whichever later plan in this phase covers it (not claimed as done here)

---
*Phase: 05-webhook-processing-delivery-tracking*
*Completed: 2026-07-08*

## Self-Check: PASSED

All 12 created/output files found on disk; all 5 commits (`2438d29`, `92dba43`, `165ee36`, `f69dd11`, `dac4a5a`) found in git history.
