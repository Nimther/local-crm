---
phase: 13-compliance-analytics-integrity
plan: 01
subsystem: database
tags: [postgres, rls, bullmq, fastify, drizzle, webhooks, zod, tracer]

requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: fail-closed bare-cast workspace_isolation policy form (0044), mega_crm_scan role + GRANT/policy pattern (0042), withCrossWorkspaceScan
  - phase: 12-worker-reliability-tenant-fairness
    provides: dead-letter-writer.ts insert-only swallow-and-log precedent, packages/queue-core @mega-crm/redaction dependency edge, versioned-job-payload house style
provides:
  - ingress_journal table (durable pre-enqueue webhook batch record, RLS + scan-role read)
  - send_event_quarantine table (rejected-event record, RLS, no scan-role read)
  - writeIngressJournal / markIngestionComplete / findStuckIngressJournalRows / pruneIngressJournal / purgeExpiredIngressJournalPayloads (packages/db/src/webhooks/ingress-journal.ts)
  - writeQuarantinedEvent (packages/db/src/webhooks/quarantine.ts, no caller wired yet)
  - webhookEventsJobSchema schemaVersion/journalId fields + buildWebhookEventsJobPayload (packages/shared-schemas)
  - webhooks.routes.ts journal-before-enqueue with fail-closed 500 on journal-write failure
affects: [13-04-quarantine-wiring, 13-06-replay-sweep-and-retention-tick, 13-11-ingestion-health-watchdog, 13-14-dependency-audit]

tech-stack:
  added: []
  patterns:
    - "PoolClient-first packages/db webhook helper module, mirrors reconciler-run.ts/maintenance-run.ts: caller must already be inside withTenant/withTenantTransaction"
    - "safeParse + issue-path-based defer branch for a versioned job schema with a legacy (no-schemaVersion) shape, distinct from sendReconcilerTickJobSchema's simpler always-versioned form"
    - "split prune (delete completed) / purge (null payload of incomplete, retain row as tombstone) retention pair, replacing the single-DELETE pattern used elsewhere in this codebase"

key-files:
  created:
    - packages/db/migrations/0055_webhook_ingress_durability.sql
    - packages/db/src/schema/ingress-journal.ts
    - packages/db/src/schema/send-event-quarantine.ts
    - packages/db/src/webhooks/ingress-journal.ts
    - packages/db/src/webhooks/quarantine.ts
    - apps/worker/src/queues/__tests__/webhook-events-journal.test.ts
    - apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts
    - packages/db/src/__tests__/ingress-journal-queries.test.ts
  modified:
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/index.ts
    - packages/db/package.json
    - packages/shared-schemas/src/queues.ts
    - apps/api/src/modules/webhooks/enqueue.ts
    - apps/api/src/modules/webhooks/webhooks.routes.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - SPECIFICATION.md

key-decisions:
  - "A journal-write failure returns reply.code(500).send() from webhooks.routes.ts and never calls enqueueWebhookBatch -- no fallback enqueue-without-journal path exists; SendGrid's ~24h retry window is the sole recovery path."
  - "enqueueWebhookBatch is called strictly AFTER the journal's withTenantTransaction has committed, not from inside its callback -- avoids a race where a fast worker could process the job before COMMIT, and avoids enqueuing before a possible rollback."
  - "Both zero-row early returns in processWebhookEventBatch (no extractable events, sibling-only batch) now call markJournalCompleteIfPresent via their own withTenant/withTenantTransaction; the normal insert path marks completion inside its existing transaction's tail on the same client -- two call sites, not one shared helper wrapping the whole function, since the two paths never share a transaction."
  - "packages/db gained exactly one new dependency edge: @mega-crm/redaction (workspace-internal, zero runtime deps of its own) -- no external npm package added. Flagged for plan 13-14's dependency audit."
  - "The ingress_journal_scan policy predicate is exactly `ingestion_completed_at IS NULL` (0055), matching 0042's flow_runs_scan/flows_scan narrowed form -- a purged tombstone still satisfies this predicate and stays visible to the scan role."

requirements-completed: [CMP-08]

coverage:
  - id: D1
    description: "A verified webhook POST journals the batch before enqueue; the worker marks that journal row ingested on completion"
    requirement: "CMP-08"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts#a verified batch POST creates exactly one ingress_journal row before enqueue"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-journal.test.ts#Test 1: a journaled batch on the normal insert path marks ingestion_completed_at non-null"
        status: pass
    human_judgment: false
  - id: D2
    description: "Both zero-row terminal paths (sibling-only batch, no extractable events) mark the journal row complete instead of leaving it stuck"
    requirement: "CMP-08"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-journal.test.ts#Test 2: a journaled batch whose every event belongs to a sibling workspace marks ingestion_completed_at non-null and inserts zero send_events rows"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-journal.test.ts#Test 3: a journaled batch with no extractable events marks ingestion_completed_at non-null"
        status: pass
    human_judgment: false
  - id: D3
    description: "Legacy (pre-13-01) job payloads still process; an unrecognized schemaVersion defers instead of throwing"
    requirement: "CMP-08"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-journal.test.ts#Test 4: a legacy payload (no schemaVersion, no journalId) still processes to completion without throwing"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-journal.test.ts#Test 5: a payload with an unrecognized schemaVersion resolves without throwing and leaves the journal row unmarked"
        status: pass
    human_judgment: false
  - id: D4
    description: "A journal-write failure fails the request closed (5xx) and enqueues nothing; an invalid signature never journals"
    requirement: "CMP-08"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts#a simulated journal INSERT failure produces a 5xx response and zero enqueued jobs"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts#an invalid signature creates zero ingress_journal rows"
        status: pass
    human_judgment: false
  - id: D5
    description: "ingress_journal and send_event_quarantine are cross-tenant-unreadable via ordinary RLS, and ingress_journal is additionally readable by mega_crm_scan for the platform-wide health question"
    requirement: "CMP-08"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-journal.test.ts#Test 6: ingress_journal is unreadable from a tenant transaction scoped to a different workspace"
        status: pass
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/webhook-events-journal.test.ts#Test 7: ingress_journal is readable cross-workspace by the scan role for more than one workspace"
        status: pass
      - kind: integration
        ref: "apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts#a quarantine row is unreadable from a tenant transaction scoped to a different workspace"
        status: pass
    human_judgment: false
  - id: D6
    description: "Retention is split into two provably-separate operations: pruneIngressJournal (deletes only completed rows) and purgeExpiredIngressJournalPayloads (disposes of an incomplete row's payload while retaining it as a tombstone, idempotently)"
    requirement: "CMP-08"
    verification:
      - kind: integration
        ref: "packages/db/src/__tests__/ingress-journal-queries.test.ts#leaves an INCOMPLETE row aged 8 days present, and its returned count does not include that row"
        status: pass
      - kind: integration
        ref: "packages/db/src/__tests__/ingress-journal-queries.test.ts#is idempotent: a second call over an already-purged row changes nothing and returns 0"
        status: pass
    human_judgment: false
  - id: D7
    description: "Migration 0055 applies cleanly from zero and incrementally, and lint:migrations passes"
    verification:
      - kind: other
        ref: "npm run lint:migrations && npm run test:migrations"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-08-11
status: complete
---

# Phase 13 Plan 01: Webhook Ingress Durability Summary

**Verified SendGrid webhook batches are journaled to a new RLS-protected `ingress_journal` table strictly before BullMQ enqueue, the worker closes the loop with `markIngestionComplete` on every terminal path (including both zero-row early returns), and retention is split into a delete-completed / purge-incomplete-payload pair so an unrecovered ingestion loss stays visible as a non-PII tombstone instead of silently aging out.**

## Performance

- **Duration:** ~50 min
- **Tasks:** 3 (all completed)
- **Files modified/created:** 17 (8 created, 9 modified)

## Accomplishments

- Migration `0055_webhook_ingress_durability.sql`: `ingress_journal` (tenant-scoped RLS, fail-closed bare-cast predicate, `mega_crm_scan` GRANT + narrowed `ingress_journal_scan` policy, partial index for the stuck-row query, nullable `raw_batch` + `payload_purged_at` joined by a CHECK) and `send_event_quarantine` (tenant-scoped RLS, no scan-role access, `occurred_at_candidate` deliberately `text`).
- `packages/db/src/webhooks/ingress-journal.ts`: `writeIngressJournal`, `markIngestionComplete`, `findStuckIngressJournalRows`, `pruneIngressJournal`, `purgeExpiredIngressJournalPayloads` — all `PoolClient`-first, all documented as requiring an existing `withTenant`/`withTenantTransaction` (or `withCrossWorkspaceScan`) scope.
- `packages/db/src/webhooks/quarantine.ts`: `writeQuarantinedEvent`, insert-only, swallow-and-log via `scrubbedConsole`, mirroring `dead-letter-writer.ts`'s contract exactly. No caller wired yet — plan 13-04's job.
- `webhookEventsJobSchema` widened with optional `schemaVersion`/`journalId`, plus a shared `buildWebhookEventsJobPayload` constructor both this plan's producer and plan 13-06's future replay-sweep producer will use.
- `webhooks.routes.ts` now journals the verified batch (inside `withTenant`/`withTenantTransaction`) strictly after signature+timestamp verification and strictly before enqueue; a journal-write failure returns 500 with nothing enqueued.
- `webhook-events.worker.ts`'s `processWebhookEventBatch` now uses `safeParse` with a `schemaVersion`-only defer branch (logs and returns rather than throwing into BullMQ retries), and marks a supplied `journalId` complete on every terminal path, including the two zero-row early returns.
- Full retention/stuck-row query surface with 10 dedicated tests against a real ephemeral database (`packages/db/src/__tests__/ingress-journal-queries.test.ts`).
- `[BLOCKING]` gate cleared: `npm run lint:migrations` and `npm run test:migrations` both exit 0 — migration 0055 applies from zero and incrementally.

## Task Commits

1. **Task 1: Journal a verified webhook batch end-to-end and mark it ingested** — `e479654` (feat, tracer)
2. **Task 2: Quarantine table and insert-only writer** — `0610ea5` (feat)
3. **Task 3: Journal retention constants, stuck-row query, split prune/purge queries, [BLOCKING] migration apply** — `ae327a5` (feat)

**Plan metadata:** committed together with this SUMMARY (see final commit below).

## Files Created/Modified

- `packages/db/migrations/0055_webhook_ingress_durability.sql` — both new tables, RLS, scan grant/policy, indexes
- `packages/db/migrations/meta/_journal.json` — entry idx 55
- `packages/db/src/schema/ingress-journal.ts`, `packages/db/src/schema/send-event-quarantine.ts` — type-inference-only Drizzle declarations
- `packages/db/src/index.ts` — registers both new schema modules (see Deviations)
- `packages/db/src/webhooks/ingress-journal.ts`, `packages/db/src/webhooks/quarantine.ts` — the query helper modules
- `packages/db/package.json` — adds `@mega-crm/redaction` dependency
- `packages/shared-schemas/src/queues.ts` — `WEBHOOK_EVENTS_SCHEMA_VERSION`, widened `webhookEventsJobSchema`, `buildWebhookEventsJobPayload`
- `apps/api/src/modules/webhooks/enqueue.ts` — `enqueueWebhookBatch` accepts/forwards `journalId`
- `apps/api/src/modules/webhooks/webhooks.routes.ts` — journal-before-enqueue, 500 on journal-write failure
- `apps/worker/src/queues/webhook-events.worker.ts` — `safeParse`/defer branch, journal completion on every terminal path
- `apps/worker/src/queues/__tests__/webhook-events-journal.test.ts` — worker-side journal behavior (8 tests)
- `apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts` — both modules' query behavior + HTTP-level journal behaviors (10 tests)
- `packages/db/src/__tests__/ingress-journal-queries.test.ts` — retention/stuck-row query behavior (10 tests)
- `SPECIFICATION.md` — sections 2.5, 4.2, 4.5, 4.6, 5.9a, 6.8 updated

## Decisions Made

See `key-decisions` in frontmatter. In particular:

- **5xx behavior for a journal-write failure:** `reply.code(500).send()`, no fallback enqueue path. SendGrid's own retry window recovers it.
- **Final `ingress_journal_scan` policy predicate:** `USING (ingestion_completed_at IS NULL)` — matches 0042's narrowed `flow_runs_scan`/`flows_scan` form; a purged tombstone still satisfies this and stays visible to the scan role.
- **Zero-row completion restructuring:** two call sites (the two early returns) each open their own small `withTenant`/`withTenantTransaction` via a shared `markJournalCompleteIfPresent` helper; the normal insert path marks completion inline at the tail of its own existing transaction on the same client. Not a single shared wrapper around the whole function, since the early-return paths and the main path never share a transaction scope.
- **`@mega-crm/redaction` is the only dependency change:** added to `packages/db/package.json` (workspace-internal package, zero runtime deps of its own) for `writeQuarantinedEvent`'s swallow-and-log contract. No other dependency file changed. Flagged here so plan 13-14 (which asserts "zero new dependencies") can qualify that claim to mean zero new *external* packages.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `packages/db/src/schema/index.ts` does not exist; registered new schema modules in `packages/db/src/index.ts` instead**
- **Found during:** Task 1
- **Issue:** The plan's action text says "Export it from `packages/db/src/schema/index.ts`." No such barrel file exists in this repo — the established convention (confirmed against every prior schema addition, e.g. `dead-letter-jobs.ts`) is a flat `import * as xSchema from "./schema/x.js"` + spread into the `schema` object directly inside `packages/db/src/index.ts`.
- **Fix:** Added `ingressJournalSchema`/`sendEventQuarantineSchema` imports and spread entries to `packages/db/src/index.ts`, matching every other schema module's registration.
- **Files modified:** `packages/db/src/index.ts`
- **Verification:** `tsc --noEmit` clean across `packages/db`; both schema exports resolve via `@mega-crm/db`.
- **Committed in:** `e479654` (ingress-journal registration), `0610ea5` (send-event-quarantine registration)

**2. [Rule 4 - Architectural, resolved without a blocking checkpoint] Relocated three of Task 1's HTTP-level `<behavior>` assertions from `apps/worker` to `apps/api`**
- **Found during:** Task 1
- **Issue:** The plan names `apps/worker/src/queues/__tests__/webhook-events-journal.test.ts` as the file covering EVERY behavior in Task 1's list, including "a verified batch POST creates exactly one `ingress_journal` row," "an invalid signature creates zero rows," and "a simulated journal INSERT failure produces a 5xx response and zero enqueued jobs." All three require driving the real Fastify HTTP stack (`buildServer()` from `apps/api`). `apps/worker` declares `@mega-crm/api` as a devDependency (test-only imports are permitted and have precedent, e.g. `send-reconciler-health.test.ts` imports a watchdog function directly), but `apps/api`'s env schema requires `AUTH_DATABASE_URL`/`REDIS_URL`/`BETTER_AUTH_SECRET`/`PLATFORM_SENDGRID_API_KEY`/etc. that `apps/worker`'s vitest project never provisions — booting `buildServer()` from an `apps/worker` test file would need to duplicate `apps/api`'s entire test-env setup.
- **Resolution:** Not a structural code change — this is a test-placement decision, not new architecture. Moved the three HTTP-level assertions into `apps/api/src/modules/webhooks/__tests__/ingress-journal.test.ts` (already a Task 2 plan file, and apps/api's own test project already boots `buildServer()` successfully, per `webhooks-signature.test.ts`'s existing precedent). `apps/worker`'s `webhook-events-journal.test.ts` covers everything downstream of a journal row already existing (all the worker-side completion-marking, safeParse/defer, and RLS/scan behaviors) by seeding rows directly through `writeIngressJournal`.
- **Impact:** No behavior or acceptance criterion is uncovered — all Task 1 `<behavior>` items and `<acceptance_criteria>` are asserted, just split across two files instead of one. Documented in both test files' own header comments.
- **Committed in:** `e479654` (worker-side test), `0610ea5` (HTTP-level tests, alongside Task 2's own query-behavior tests)

**3. [Rule 2 - Missing Critical Functionality] SPECIFICATION.md updated per CLAUDE.md's hard-constraint rule**
- **Found during:** All three tasks
- **Issue:** CLAUDE.md requires every new dependency, table/migration/RLS-policy/index, job-payload/queue change, and HTTP-route change to be recorded in `SPECIFICATION.md` in the same change. The plan's own `<output>` section does not mention this file.
- **Fix:** Updated §2.5 (the `@mega-crm/redaction` dependency edge), §4.2 (both new tables, RLS, `ingress_journal`'s tombstone/scan-policy reasoning, `send_event_quarantine`), §4.5 (both new indexes), §4.6 (the `0055` journal entry, updated total counts), §5.9a (new subsection: the `webhook-events` job payload's versioning contract), and §6.8 (the journal-before-enqueue ordering and its 500 fail-closed behavior).
- **Files modified:** `SPECIFICATION.md`
- **Committed in:** all three task commits (incremental updates as each piece landed)

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 architectural-but-resolved-without-a-checkpoint, 1 missing-critical-functionality). **Impact on plan:** All three are documentation/placement fixes with zero effect on the delivered behavior — every `<behavior>`, `<acceptance_criteria>`, and `<must_haves>` truth in 13-01-PLAN.md is implemented and tested. No scope creep.

## Issues Encountered

- This worktree had no `node_modules` at session start (worktrees do not inherit the main checkout's install). Ran `npm install` once at the start of execution to get a working test/typecheck/lint environment; `packages/db/node_modules/@mega-crm/redaction` symlink confirmed to resolve correctly inside the worktree (not the main repo).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `ingress_journal`/`send_event_quarantine` schema, RLS, and query-helper surface is complete and tested; plan 13-04 can wire `writeQuarantinedEvent` into the worker's event-bounding logic without any further schema work.
- `buildWebhookEventsJobPayload` is ready for plan 13-06's replay sweep to reuse without risking payload-shape drift between the two producers.
- `findStuckIngressJournalRows`/`pruneIngressJournal`/`purgeExpiredIngressJournalPayloads` exist and are tested but are not wired to any tick yet — plan 13-06 owns connecting them to a scheduled job.
- Plan 13-11's ingestion-health watchdog can read `ingress_journal` via `withCrossWorkspaceScan` today; the `ingress_journal_scan` policy and its GRANT are already in migration 0055.
- Plan 13-14's dependency audit should record that `packages/db` gained exactly one new dependency edge (`@mega-crm/redaction`, workspace-internal) and no new external package.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-11*
