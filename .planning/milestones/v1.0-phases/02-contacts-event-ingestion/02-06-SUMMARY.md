---
phase: 02-contacts-event-ingestion
plan: 06
subsystem: api
tags: [bullmq, ioredis, postgres, partitioning, rls, fastify, zod, event-ingestion]

# Dependency graph
requires:
  - phase: 02-contacts-event-ingestion (02-03)
    provides: workspace_api_keys, apiKeyAuth onRequest hook, api-key management routes
  - phase: 02-contacts-event-ingestion (02-04)
    provides: upsertContactByIdentity (external_id/email upsert), RESERVED_CONTACT_PROPERTY_KEYS
  - phase: 02-contacts-event-ingestion (02-05)
    provides: apps/worker scaffold, @mega-crm/tenant-context extraction, BullMQ/ioredis infra, docker-compose redis service
provides:
  - Partitioned `events` table (PARTITION BY RANGE(occurred_at), current+next month partitions, RLS on parent)
  - "@mega-crm/contacts-core: extracted shared package (upsertContactByIdentity + property registry + reserved-key denylist), importable by both apps/api and apps/worker"
  - "POST /v1/events (EVNT-01/EVNT-03): API-key-authed, fast-2xx, per-item accepted/rejected batch ingestion (D-24)"
  - events:ingest BullMQ producer (apps/api) + idempotent consumer Worker (apps/worker), upserting the contact and writing the event row exactly once per (id, occurred_at)
affects: [02-07-csv-import, phase-3-segmentation, phase-4-send-pipeline, phase-7-analytics-timeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Shared cross-app business logic (contact upsert) lives in a dedicated package (@mega-crm/contacts-core), not inside apps/api -- mirrors the @mega-crm/tenant-context extraction precedent from 02-05"
    - "BullMQ Queue/Worker connection option MUST be a plain ConnectionOptions object (parsed from REDIS_URL), never a constructed ioredis client instance -- BullMQ bundles its own internal ioredis at a pinned version distinct from the workspace's own ioredis dependency"
    - "BullMQ queue names must not contain ':' -- use '-' separators (events-ingest, imports-csv)"
    - "Deterministic eventId (BullMQ jobId + events PK component) and once-resolved occurredAt threaded from the synchronous route through job.data into the worker's ON CONFLICT (id, occurred_at) DO NOTHING insert -- the idempotency contract for at-least-once delivery"
    - "Per-item envelope validation (not a single whole-batch Zod parse) so one malformed item in a batch does not reject the rest -- each item independently resolves to accepted/rejected"

key-files:
  created:
    - packages/contacts-core/src/contact-repository.ts
    - packages/contacts-core/src/property-registry.ts
    - packages/contacts-core/src/logger.ts
    - packages/contacts-core/src/index.ts
    - packages/db/src/schema/events.ts
    - packages/db/migrations/0007_events_partitioned.sql
    - packages/shared-schemas/src/event.ts
    - apps/api/src/modules/events/events-queue.ts
    - apps/api/src/modules/events/events-api.routes.ts
    - apps/api/src/modules/events/__tests__/events-api.test.ts
    - apps/worker/src/queues/events-ingest.worker.ts
    - apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts
    - apps/worker/src/test/db-fixture.ts
  modified:
    - apps/api/src/modules/contacts/contact.repository.ts
    - apps/api/src/modules/contacts/property-registry.ts
    - apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts
    - apps/api/package.json
    - apps/worker/package.json
    - apps/api/src/server.ts
    - apps/worker/src/server.ts
    - packages/db/src/index.ts
    - packages/db/migrations/meta/_journal.json
    - packages/shared-schemas/src/queues.ts
    - packages/shared-schemas/src/index.ts

key-decisions:
  - "Extracted upsertContactByIdentity + property-registry write helper + reserved-key denylist to a new @mega-crm/contacts-core package (Rule 3 blocking-issue fix, not in the plan's original files_modified list) -- apps/worker has no dependency path to apps/api's source, so the plan's own key_link (worker calls upsertContactByIdentity) was otherwise unsatisfiable without either a monorepo path reach-across or duplicating D-01..D-08 identity logic (Pitfall-8-style drift risk)"
  - "BullMQ queue name constants renamed events:ingest/imports:csv -> events-ingest/imports-csv (Rule 1 bug fix) -- BullMQ 5.79.1 rejects colons in queue names; 02-05's placeholder constants were never actually instantiated as real Queue names until this plan"
  - "Both the producer (apps/api) and consumer (apps/worker) pass a plain ConnectionOptions object to BullMQ, not a constructed ioredis client instance (Rule 1 bug fix) -- BullMQ bundles its own ioredis@5.10.1 internally, distinct from this workspace's ioredis@5.11.0, causing a TypeScript nominal-type mismatch when a live client instance crosses that boundary"
  - "Event properties ARE forwarded into upsertContactByIdentity's properties input (not identity-only externalId/email) -- matches 02-RESEARCH.md's Pattern 2 code example and the threat model's own framing of T-02-06-03 (reserved-key stripping only matters if event properties actually reach the contact properties merge)"
  - "Per-item envelope validation at the route (not a single Zod parse over the whole array) so a batch with one malformed item still returns 202 with per-item accepted/rejected statuses, rather than rejecting the entire batch"

requirements-completed: [EVNT-01, EVNT-02, EVNT-03]

coverage:
  - id: D1
    description: "POST /v1/events is API-key-authed: missing or invalid Authorization header returns 401"
    requirement: "EVNT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#missing Authorization header -> 401"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#invalid API key -> 401"
        status: pass
    human_judgment: false
  - id: D2
    description: "A single event returns an immediate 202 with a per-item accepted status, and the contact/event are not written synchronously"
    requirement: "EVNT-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#valid key: single event -> 202 with a per-item accepted status, and the contact/event are NOT written synchronously"
        status: pass
    human_judgment: false
  - id: D3
    description: "A batch of events returns 202 with one result per item; a batch over 1000 is rejected (D-24)"
    requirement: "EVNT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#valid key: batch of events -> 202 with one result per item"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#D-24: a batch of more than 1000 events is rejected"
        status: pass
    human_judgment: false
  - id: D4
    description: "Envelope-only validation: missing/blank name and non-object properties are rejected per-item without failing the whole batch; arbitrary nested properties are accepted (freeform)"
    requirement: "EVNT-01"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#envelope validation: missing/blank name is rejected per-item, without failing the whole batch"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#envelope validation: non-object properties is rejected"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/events/__tests__/events-api.test.ts#freeform: arbitrary nested properties are accepted without schema enforcement"
        status: pass
    human_judgment: false
  - id: D5
    description: "An event for an unknown identity creates the contact via upsertContactByIdentity and writes exactly one events row"
    requirement: "EVNT-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts#EVNT-02: creates the contact for an unknown identity and writes exactly one events row"
        status: pass
    human_judgment: false
  - id: D6
    description: "Pitfall 1: redelivering the same job (same eventId + occurredAt) writes no duplicate events row"
    requirement: "EVNT-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts#Pitfall 1: redelivering the same job (same eventId + occurredAt) writes NO duplicate events row"
        status: pass
    human_judgment: false
  - id: D7
    description: "A later event changing the contact's email resolves to the same contact"
    requirement: "EVNT-02"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts#EVNT-02: a later event changing the contact's email resolves to the same contact"
        status: pass
    human_judgment: false
  - id: D8
    description: "Pitfall 4: a subscription_status property on an event cannot flip the contact's real subscription state"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts#Pitfall 4: a subscription_status property on the event cannot flip the contact's real subscription state"
        status: pass
    human_judgment: false
  - id: D9
    description: "events table is partitioned by month on occurred_at with RLS on the parent, current+next partitions created, and the two indexes present"
    verification:
      - kind: other
        ref: "npm run db:migrate (packages/db/migrations/0007_events_partitioned.sql) + pg_class/pg_policy inspection confirming events_2026_07/events_2026_08 partitions, propagated indexes, and workspace_isolation policy"
        status: pass
    human_judgment: false

# Metrics
duration: 30min
completed: 2026-07-04
status: complete
---

# Phase 2 Plan 6: Event Ingestion (Queue + Worker + Partitioned Schema) Summary

**API-key-authed POST /v1/events with fast-2xx per-item batch acceptance (D-24), a partitioned `events` table (RANGE on occurred_at, RLS on the parent), and an idempotent BullMQ events:ingest worker that upserts contacts via the shared `@mega-crm/contacts-core` package and writes events with `ON CONFLICT (id, occurred_at) DO NOTHING`.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-04T09:23:00Z (context load)
- **Completed:** 2026-07-04T09:49:00Z
- **Tasks:** 3 (RED, BLOCKING schema/migration, GREEN route+worker) + 1 pre-task deviation fix
- **Files modified:** 24 (13 new, 11 modified)

## Accomplishments
- `packages/contacts-core`: new shared package extracting `upsertContactByIdentity`, the reserved-property-key denylist, and the property-registry write helper out of `apps/api` so `apps/worker` (a separate process with no dependency path to `apps/api`'s source) can reuse the exact same D-01..D-08 contact-identity rules
- `events` table: hand-written migration, `PARTITION BY RANGE (occurred_at)`, `PRIMARY KEY (id, occurred_at)`, current+next month partitions, two indexes, `ENABLE + FORCE ROW LEVEL SECURITY` + `workspace_isolation` on the parent (propagated to partitions automatically)
- `POST /v1/events` (EVNT-01/EVNT-03): API-key-authed, rate-limited, per-item accepted/rejected batch ingestion (D-24) that only authenticates + shape-validates + enqueues -- never performs the upsert/insert inline
- `apps/worker`'s `events:ingest` BullMQ Worker: re-derives `workspaceId` from `job.data`, upserts the contact (EVNT-02), and writes the event row idempotently keyed on `(id, occurred_at)` (Pitfall 1)
- Fixed two pre-existing infrastructure bugs discovered while wiring the first real BullMQ Queue/Worker instances: colon-containing queue names (rejected by BullMQ) and a cross-package `ioredis` version mismatch that made passing a live client instance a TypeScript error

## Task Commits

Each task was committed atomically:

1. **Deviation fix: extract contact upsert logic to @mega-crm/contacts-core** - `27b0911` (refactor)
2. **Task 1: RED — failing tests for /v1/events fast-2xx contract + worker idempotency** - `3803b00` (test)
3. **Task 2: [BLOCKING] partitioned events schema + migration + event/job Zod schemas** - `5432e0e` (feat)
4. **Task 3: GREEN — /v1/events route + BullMQ producer + idempotent event worker** - `7ad7d94` (feat)

**Plan metadata:** (this commit) `docs(02-06): complete plan`

## Files Created/Modified
- `packages/contacts-core/src/contact-repository.ts` - `upsertContactByIdentity` + reserved-key denylist + helpers, extracted from apps/api
- `packages/contacts-core/src/property-registry.ts` - `registerObservedProperty`/`registerObservedProperties` write helper
- `packages/contacts-core/src/logger.ts` - dependency-light pino logger for D-05 structured conflict logging
- `packages/contacts-core/src/index.ts` - package barrel export
- `apps/api/src/modules/contacts/contact.repository.ts` - now a thin re-export shim + the CRUD functions that stay API-only
- `apps/api/src/modules/contacts/property-registry.ts` - re-exports the write helper, keeps `listPropertyRegistry` (needs tenant-context)
- `apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts` - logger-spy import updated to `@mega-crm/contacts-core`
- `apps/api/package.json`, `apps/worker/package.json` - added `@mega-crm/contacts-core` dependency
- `packages/db/src/schema/events.ts` - logical Drizzle pgTable shape for type inference (NOT the physical DDL)
- `packages/db/migrations/0007_events_partitioned.sql` - hand-written partitioned `events` table + partitions + indexes + RLS
- `packages/db/migrations/meta/_journal.json` - journal entry for the hand-written migration (no snapshot, same pattern as 0004/0006)
- `packages/db/src/index.ts` - registers/re-exports the events schema
- `packages/shared-schemas/src/event.ts` - `eventEnvelopeSchema` (D-02 at-least-one-identifier refine) + `MAX_EVENT_BATCH_SIZE`
- `packages/shared-schemas/src/queues.ts` - finalized `eventsIngestJobSchema`; renamed queue name constants (colon -> hyphen)
- `packages/shared-schemas/src/index.ts` - re-exports `event.ts`
- `apps/api/src/modules/events/events-queue.ts` - producer-side BullMQ Queue
- `apps/api/src/modules/events/events-api.routes.ts` - `registerEventsApiRoutes`, `POST /v1/events`
- `apps/api/src/modules/events/__tests__/events-api.test.ts` - fast-2xx/batch/envelope/auth coverage
- `apps/api/src/server.ts` - registers the events routes
- `apps/worker/src/queues/events-ingest.worker.ts` - `processEventIngestJob` (standalone-testable handler) + `createEventsIngestWorker`
- `apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts` - upsert-from-event + idempotency + email-change + Pitfall-4 coverage
- `apps/worker/src/test/db-fixture.ts` - test-DB migration fixture, mirrors apps/api's
- `apps/worker/src/server.ts` - registers the events:ingest Worker in `buildWorker()`
- `.gitignore` - added `*.rdb` (local Redis dump artifact from test-environment setup)

## Decisions Made
- `@mega-crm/contacts-core` extraction was necessary (not optional) architecture, not scope creep: the plan's own `key_links` require the worker to call `upsertContactByIdentity`, which physically could not happen without either this extraction or duplicating the two-key-upsert logic across apps (the exact drift risk the project's own RESEARCH.md flags for tenant-scoping, generalized here).
- BullMQ queue name constants changed from colon-separated (`events:ingest`) to hyphen-separated (`events-ingest`) -- a real BullMQ 5.79.1 constraint, not a style preference; every reference goes through the shared constant so no other code needed updating.
- Producer and consumer both pass plain `ConnectionOptions` (parsed from `REDIS_URL`) to BullMQ rather than a constructed `ioredis` client instance, sidestepping a cross-package `ioredis` version mismatch (workspace `5.11.0` vs BullMQ's bundled `5.10.1`).
- Event properties are merged into the contact's properties via `upsertContactByIdentity` (not identity-only `externalId`/`email`) -- this is what makes the reserved-key stripping mitigation for T-02-06-03 meaningful, and matches D-10's "custom properties auto-discovered from events too."

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extracted contact-upsert logic to a new shared package**
- **Found during:** Pre-Task-1 context loading (discovered before writing any code)
- **Issue:** The plan's `key_links` require `apps/worker/src/queues/events-ingest.worker.ts` to call `upsertContactByIdentity`, but that function lived only in `apps/api/src/modules/contacts/contact.repository.ts` -- `apps/worker`'s `package.json` has no dependency on `@mega-crm/api` (it isn't even a valid workspace import target: no `exports`/deep-import surface, and importing across app `src/` boundaries would violate each app's own `tsconfig` `rootDir`). Without a fix, Task 3 could not compile.
- **Fix:** Created `@mega-crm/contacts-core` (new workspace package) containing `upsertContactByIdentity`, `RESERVED_CONTACT_PROPERTY_KEYS`, `registerObservedProperty`/`registerObservedProperties`, and a dependency-light pino logger. `apps/api`'s `contact.repository.ts`/`property-registry.ts` became thin re-export shims so every existing importer kept resolving unchanged; both `apps/api` and `apps/worker` now depend on the new package.
- **Files modified:** `packages/contacts-core/*` (new), `apps/api/src/modules/contacts/contact.repository.ts`, `apps/api/src/modules/contacts/property-registry.ts`, `apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts`, `apps/api/package.json`, `apps/worker/package.json`
- **Verification:** all 7 pre-existing `upsert-priority.test.ts` cases still pass; `packages/contacts-core` and `apps/api` both build clean
- **Committed in:** `27b0911`

**2. [Rule 1 - Bug] Fixed BullMQ colon-rejection in queue names**
- **Found during:** Task 3 (first real `new Queue(...)` instantiation)
- **Issue:** `EVENTS_INGEST_QUEUE = "events:ingest"` (a 02-05 placeholder, never previously instantiated as a real BullMQ Queue) threw `Error: Queue name cannot contain :` at runtime -- confirmed as a real `bullmq@5.79.1` `QueueBase` validation, not a typo.
- **Fix:** Renamed the constants to `"events-ingest"`/`"imports-csv"` in `packages/shared-schemas/src/queues.ts`; every reference already went through the shared constant.
- **Files modified:** `packages/shared-schemas/src/queues.ts`
- **Verification:** `events-api.test.ts` and `events-ingest-idempotency.test.ts` both green after the fix
- **Committed in:** `7ad7d94`

**3. [Rule 1 - Bug] Fixed cross-package ioredis version mismatch**
- **Found during:** Task 3 (`npm run build` for both apps/api and apps/worker)
- **Issue:** BullMQ bundles its own `ioredis@5.10.1` internally, distinct from this workspace's `ioredis@5.11.0` -- passing a constructed `Redis` client instance as a `Queue`/`Worker` `connection` option was a TypeScript nominal-type error (`Redis` from one `ioredis` copy is not assignable to `Redis` from the other, due to protected members).
- **Fix:** Both the producer (`events-queue.ts`) and consumer (`events-ingest.worker.ts`/`server.ts`) now build and pass a plain `ConnectionOptions` object parsed from `REDIS_URL`, never a live client instance -- BullMQ constructs its own internal client from the options, sidestepping the version conflict entirely.
- **Files modified:** `apps/api/src/modules/events/events-queue.ts`, `apps/worker/src/queues/events-ingest.worker.ts`, `apps/worker/src/server.ts`
- **Verification:** `npm run build -w apps/api` and `npm run build -w apps/worker` both clean
- **Committed in:** `7ad7d94`

---

**Total deviations:** 3 auto-fixed (1 blocking architectural extraction, 2 bug fixes)
**Impact on plan:** All three were required for the plan's own tasks to compile/run correctly; no scope creep beyond what Task 3's stated goal (a working, idempotent events:ingest worker reusing `upsertContactByIdentity`) already required.

## Issues Encountered
- The test environment had no live Redis reachable (Docker unavailable in this sandbox); installed `redis` via Homebrew and started `redis-server --daemonize yes` locally so the real BullMQ Queue/Worker round-trip could be exercised by the test suite. This is a test-environment setup action, not a project dependency change -- `docker-compose.yml`'s `redis:7` service remains the documented way to run Redis for local dev.
- `contacts`/`events` tables carry `ENABLE + FORCE ROW LEVEL SECURITY`; the worker's idempotency test initially read verification rows via a bare `pool.query` (no `app.current_workspace_id` GUC set), which RLS silently filtered to zero rows with no error. Fixed by wrapping all `contacts`/`events` reads in the test with `withTenant`/`withTenantTransaction`.

## User Setup Required

None for this plan specifically. Carried forward from 02-05: `REDIS_URL=redis://localhost:6379` must be added to `.env`/`.env.example` manually before `npm run dev` boots `apps/api`+`apps/worker` (the executor's `Read`/`Write` tools are hard-denied on `.env*` paths). A real Redis instance (via `docker compose up redis` or a local `redis-server`) must be running for `apps/worker` to start and for `/v1/events` to actually enqueue jobs.

## Next Phase Readiness
- `events` table, `POST /v1/events`, and the `events:ingest` worker are all live and tested -- ready for Phase 3's behavioral segmentation (SEGM-02) and Phase 7's contact-timeline read (ANLT-03) to query the same partitioned table.
- 02-07 (CSV import) can follow the identical `imports:csv` queue-name/connection-options pattern established here, and reuses the same `upsertContactByIdentity` from `@mega-crm/contacts-core` without any further extraction work.
- The `apps/worker` process now has a real, working BullMQ Worker registered in `buildWorker()` -- 02-07 only needs to push its own `Worker` into the same `workers` array.
- Monthly partition creation beyond `events_2026_07`/`events_2026_08` is NOT automated (Assumption A5) -- a scheduled maintenance job (or `pg_partman` if available) is an operational follow-up, not blocking this phase's completion.

---
*Phase: 02-contacts-event-ingestion*
*Completed: 2026-07-04*

## Self-Check: PASSED

All created/modified files exist on disk; commits `27b0911`, `3803b00`, `5432e0e`, `7ad7d94` all found in git history.
