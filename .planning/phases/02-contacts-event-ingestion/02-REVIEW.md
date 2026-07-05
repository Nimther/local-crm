---
phase: 02-contacts-event-ingestion
reviewed: 2026-07-05T05:12:30Z
depth: standard
files_reviewed: 93
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/db.ts
  - apps/api/src/env.ts
  - apps/api/src/middleware/tenant-context.ts
  - apps/api/src/modules/api-keys/__tests__/api-key-auth.test.ts
  - apps/api/src/modules/api-keys/__tests__/api-keys-management.test.ts
  - apps/api/src/modules/api-keys/api-key-auth.ts
  - apps/api/src/modules/api-keys/api-keys.repository.ts
  - apps/api/src/modules/api-keys/api-keys.routes.ts
  - apps/api/src/modules/auth/access-control.ts
  - apps/api/src/modules/contacts/__tests__/contact-crud.test.ts
  - apps/api/src/modules/contacts/__tests__/contact-events-read.test.ts
  - apps/api/src/modules/contacts/__tests__/contacts-api.test.ts
  - apps/api/src/modules/contacts/__tests__/csv-import.test.ts
  - apps/api/src/modules/contacts/__tests__/subscription-status.test.ts
  - apps/api/src/modules/contacts/__tests__/upsert-priority.test.ts
  - apps/api/src/modules/contacts/contact.repository.ts
  - apps/api/src/modules/contacts/contacts-api.routes.ts
  - apps/api/src/modules/contacts/contacts.routes.ts
  - apps/api/src/modules/contacts/csv-import.repository.ts
  - apps/api/src/modules/contacts/csv-import.routes.ts
  - apps/api/src/modules/contacts/imports-csv-queue.ts
  - apps/api/src/modules/contacts/property-registry.ts
  - apps/api/src/modules/events/__tests__/events-api.test.ts
  - apps/api/src/modules/events/events-api.routes.ts
  - apps/api/src/modules/events/events-queue.ts
  - apps/api/src/server.ts
  - apps/api/vitest.config.ts
  - apps/web/package.json
  - apps/web/src/App.tsx
  - apps/web/src/components/ui/collapsible.tsx
  - apps/web/src/components/ui/progress.tsx
  - apps/web/src/components/ui/radio-group.tsx
  - apps/web/src/components/ui/tabs.tsx
  - apps/web/src/components/ui/textarea.tsx
  - apps/web/src/features/api-keys/ApiKeysSettings.tsx
  - apps/web/src/features/app-shell/AppShell.tsx
  - apps/web/src/features/contacts/ContactDetailPage.tsx
  - apps/web/src/features/contacts/ContactEventFeed.tsx
  - apps/web/src/features/contacts/ContactForm.tsx
  - apps/web/src/features/contacts/ContactsListPage.tsx
  - apps/web/src/features/contacts/CsvImportHistory.tsx
  - apps/web/src/features/contacts/CsvImportWizard.tsx
  - apps/web/src/features/contacts/CustomPropertyEditor.tsx
  - apps/web/src/features/contacts/SubscriptionStatusBadge.tsx
  - apps/web/src/features/onboarding/OnboardingChecklist.tsx
  - apps/web/src/lib/api.ts
  - apps/worker/package.json
  - apps/worker/src/queues/__tests__/connection.test.ts
  - apps/worker/src/queues/__tests__/events-ingest-idempotency.test.ts
  - apps/worker/src/queues/__tests__/imports-csv-idempotency.test.ts
  - apps/worker/src/queues/connection.ts
  - apps/worker/src/queues/events-ingest.worker.ts
  - apps/worker/src/queues/imports-csv.worker.ts
  - apps/worker/src/server.ts
  - apps/worker/src/test/db-fixture.ts
  - apps/worker/tsconfig.json
  - apps/worker/vitest.config.ts
  - packages/contacts-core/src/contact-repository.ts
  - packages/contacts-core/src/csv-mapping.ts
  - packages/contacts-core/src/index.ts
  - packages/contacts-core/src/logger.ts
  - packages/contacts-core/src/property-registry.ts
  - packages/db/migrations/0003_eminent_meltdown.sql
  - packages/db/migrations/0004_contacts_rls_policies.sql
  - packages/db/migrations/0005_open_lord_hawal.sql
  - packages/db/migrations/0006_api_keys_rls_policies.sql
  - packages/db/migrations/0007_events_partitioned.sql
  - packages/db/migrations/0008_exotic_skullbuster.sql
  - packages/db/migrations/0009_csv_imports_rls_policies.sql
  - packages/db/migrations/0010_events_workspace_scoped_pk.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/package.json
  - packages/db/src/index.ts
  - packages/db/src/schema/api-keys.ts
  - packages/db/src/schema/contacts.ts
  - packages/db/src/schema/csv-imports.ts
  - packages/db/src/schema/events.ts
  - packages/db/src/schema/property-registry.ts
  - packages/db/src/schema/suppressions.ts
  - packages/db/tsconfig.json
  - packages/shared-schemas/package.json
  - packages/shared-schemas/src/api-key.ts
  - packages/shared-schemas/src/contact.ts
  - packages/shared-schemas/src/csv-import.ts
  - packages/shared-schemas/src/event.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
  - packages/shared-schemas/tsconfig.json
  - packages/tenant-context/package.json
  - packages/tenant-context/src/index.ts
  - packages/tenant-context/tsconfig.json
  - scripts/check-env.mjs
findings:
  critical: 0
  warning: 7
  info: 11
  total: 18
status: issues_found
---

# Phase 02: Code Review Report (Re-Review After Gap Closure)

**Reviewed:** 2026-07-05T05:12:30Z
**Depth:** standard
**Files Reviewed:** 93
**Status:** issues_found

## Summary

Re-review of the full Phase 2 surface after gap-closure plans 02-09..02-12. **All four prior Critical findings are verified fixed in the current code**, each with a regression test that exercises the actual failure mode:

- **CR-01 (cross-tenant event suppression): FIXED.** BullMQ jobId is now workspace-scoped (`${workspaceId}-${eventId}`, `events-api.routes.ts:99`), the `events` PK is `(workspace_id, id, occurred_at)` (migration `0010_events_workspace_scoped_pk.sql:23-24`, journaled in `meta/_journal.json`), and the worker's `ON CONFLICT` target matches (`events-ingest.worker.ts:43`). Covered by tenant-collision tests at both the queue layer (`events-api.test.ts:203-235`) and the DB layer (`events-ingest-idempotency.test.ts:143-184`).
- **CR-02 (dead unique-violation retry): FIXED.** Branch E's INSERT is wrapped in `SAVEPOINT upsert_insert` with `ROLLBACK TO SAVEPOINT` before the single retry (`contact-repository.ts:242-277`), so the transaction is genuinely un-aborted. Proven by a real two-connection race test (`upsert-priority.test.ts:214-282`).
- **CR-03 (events lost outside partition window): FIXED.** `events_default` DEFAULT partition added (`0010:36`); an out-of-window `occurredAt` (2027-03-01) is stored, not dropped (`events-ingest-idempotency.test.ts:186-212`).
- **CR-04 (property deletion / field clearing never persists): FIXED.** `updateContact` treats `properties` as full replacement (`contact.repository.ts:289-294`), the update schema accepts explicit `null` to clear firstName/lastName/phone/city/country (`shared-schemas/contact.ts:44-51`), and `cleanPayload` sends `null` for emptied fields in edit mode (`ContactForm.tsx:202-218`). Covered by three targeted CRUD tests (`contact-crud.test.ts:247-355`).

Also verified fixed: **WR-01** (retry/backoff `defaultJobOptions` on both producer queues), **WR-03** (worker throws when rows remain `pending`, cursor semantics documented), **WR-04** (upload failure path sets `failed`, truncation returns 413), **WR-05** (CSV mapper validates/normalizes `subscriptionStatus`, blocks `suppressed`), **WR-06** (update branch applies valid transitions with D-12 guards), **WR-09** (`client.release(err)` destroys dead connections in both `withTenantTransaction` and `lookupApiKeyById`).

However, **the fixes are only half the prior findings list.** WR-02, WR-07, WR-08, WR-10 and all nine Info items were NOT in gap-closure scope and remain open in the current code — they are carried forward below with re-verified line numbers. Two NEW issues introduced or exposed by the fixes were found: the WR-03 throw-on-unresolved-rows fix has no terminal-failure handler, so an import whose job exhausts all 5 retry attempts is still stuck in `applying` forever (WR-N2); and CR-04's switch to full-replacement semantics introduces a lost-update window where a stale Свойства tab silently deletes properties added concurrently by event ingestion (WR-N6).

## Narrative Findings (AI reviewer)

## Critical Issues

None. All four prior Criticals (CR-01..CR-04) are verified closed with regression coverage.

## Warnings

### WR-01 (carried from prior WR-02): BullMQ Workers and the shared ioredis connection have no `error`/`failed` listeners — a Redis hiccup crashes the worker process

**File:** `apps/worker/src/server.ts:43-47`, `apps/worker/src/queues/events-ingest.worker.ts:62-70`, `apps/worker/src/queues/imports-csv.worker.ts:184-192`, `apps/worker/src/queues/connection.ts:26-28`
**Issue:** Unchanged since the prior review. Neither Worker attaches `on("error")` or `on("failed")`; BullMQ's own docs state an unlistened `error` event throws an uncaught exception at process level. Additionally, `buildWorker()` holds a shared `Redis` instance (`createRedisConnection`) with no `error` listener at all — ioredis emits `error` events on connection loss, and an unlistened EventEmitter `error` crashes Node. A transient Redis restart therefore kills the whole worker process (both queues), and job failures produce zero log output. This gap is now load-bearing: the WR-03 fix relies on failed-and-retried jobs, none of which are observable.
**Fix:** In `buildWorker()` (or the factories):
```ts
connection.on("error", (err) => console.error("shared redis connection error", err));
for (const w of workers) {
  w.on("error", (err) => console.error("worker error", err));
  w.on("failed", (job, err) => console.error({ jobId: job?.id, attemptsMade: job?.attemptsMade }, "job failed", err));
}
```

### WR-02 (new — residual gap in the WR-03 fix): a CSV import whose apply job exhausts all retry attempts is stuck in `applying` forever, with the UI polling indefinitely

**File:** `apps/worker/src/queues/imports-csv.worker.ts:163-173`, `apps/api/src/modules/contacts/imports-csv-queue.ts:41-46`, `apps/web/src/features/contacts/CsvImportWizard.tsx:393-397`
**Issue:** The WR-03 fix correctly throws when `stillPending > 0` so BullMQ retries (5 attempts, exponential backoff). But when the failure is systemic (DB partition full, RLS misconfig, poisoned row), the 5th attempt fails, the job lands in `failed` (`removeOnFail: false`) — and nothing ever transitions `csv_imports.status` out of `applying`. The `failed` status exists and is reachable from the upload path (WR-04 fix), but no code sets it from the apply path. `ApplyProgressAndReport` polls every 1.5s while `status === "applying"` — forever. The user's only accidental recovery is that the apply route lacks a status guard (WR-03 below) and can be re-POSTed manually.
**Fix:** attach a `failed` listener on the imports:csv Worker (dovetails with WR-01) that flips the import to `failed` on final attempt:
```ts
worker.on("failed", async (job, err) => {
  if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const { workspaceId, csvImportId } = job.data;
  await withTenant(workspaceId, () =>
    withTenantTransaction((c) =>
      c.query(`UPDATE csv_imports SET status = 'failed', updated_at = now() WHERE id = $1`, [csvImportId])
    )
  ).catch(() => undefined);
});
```

### WR-03 (carried from prior WR-07): no status guards on dry-run/apply — concurrent dry-run corrupts a running apply; apply is re-enqueueable; failure between status flip and enqueue strands the import

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:245-285`
**Issue:** Unchanged since the prior review. (1) `POST .../apply` checks only `existing.mapping`, not `existing.status` — re-POSTing during `applying` or after `done` enqueues duplicate jobs (no `jobId` on `importsCsvQueue.add`, line 282), whose final recount/status writes race each other. (2) `POST .../dry-run` has no status check either: running it mid-apply resets rows the worker already scheduled back to `pending`, flips status to `ready` via `saveDryRunResult` while the worker later overwrites it, and swaps `mapping` under a worker that read it once at start. A side effect visible in the UI: `ApplyProgressAndReport` stops polling the moment status is not `applying` (line 396), so a `ready` flip mid-apply freezes the progress screen. (3) If `importsCsvQueue.add` throws after `markCsvImportApplying` (line 281-282), the import is `applying` with no job.
**Fix:** guard both routes on allowed statuses (`dry-run`: `uploaded|ready`; `apply`: `ready` only), pass a deterministic `jobId` (e.g. the `csvImportId`), and enqueue before — or compensate on failure after — the status flip.

### WR-04 (carried from prior WR-08): TOCTOU on email uniqueness in session create/update — a race surfaces as an unhandled 500 instead of 409

**File:** `apps/api/src/modules/contacts/contact.repository.ts:196-236, 248-331`
**Issue:** Unchanged since the prior review. `createContact`/`updateContact` check `isEmailTaken` then INSERT/UPDATE without catching `23505`. The unique constraints (`contacts_workspace_email_unique`, `contacts_workspace_external_id_unique`) prevent the duplicate, but a concurrent request racing the check propagates a raw driver error → 500, instead of the `ContactConflictError` → 409 contract the routes and UI copy (`email_taken`) rely on. Note the fix pattern now has an in-repo precedent: the CR-02 SAVEPOINT handling in `contacts-core`.
**Fix:** catch `23505` in both functions and rethrow as `ContactConflictError("...", "email_taken")`.

### WR-05 (carried from prior WR-10): Redis URL parsing (3 duplicated copies) drops TLS for `rediss://` and mishandles non-numeric DB paths

**File:** `apps/worker/src/queues/connection.ts:11-23`, `apps/api/src/modules/events/events-queue.ts:20-32`, `apps/api/src/modules/contacts/imports-csv-queue.ts:17-29`
**Issue:** Unchanged since the prior review — and now in a third copy (`imports-csv-queue.ts`). All three ignore the URL scheme: a `rediss://` URL (standard for managed Redis) produces a plaintext connection config with no `tls` option, so the queue backend fails opaquely or connects unencrypted. `Number(url.pathname.slice(1))` yields `NaN` for a non-numeric path, passed through as an invalid `db`. The stated "config parsing can't drift" duplication rationale is disproven by having to patch three files in lockstep.
**Fix:** in each copy (or one shared util): `...(url.protocol === "rediss:" ? { tls: {} } : {})`, and only include `db` when `Number.isInteger(db)`.

### WR-06 (new — introduced by the CR-04 semantics change): full-replacement `properties` PATCH from a stale Свойства tab silently deletes properties added concurrently by other writers

**File:** `apps/web/src/features/contacts/ContactDetailPage.tsx:86-119`, `apps/web/src/features/contacts/CustomPropertyEditor.tsx:45`, `apps/api/src/modules/contacts/contact.repository.ts:289-294`
**Issue:** CR-04's fix makes the PATCH `properties` payload authoritative (full replacement — correct for deletion). But `PropertiesTab` seeds its editable state once, from the contact snapshot at tab mount (`useState(contact.properties)`, line 88), and `CustomPropertyEditor` likewise initializes rows once (line 45); neither re-syncs when the query refetches. Event ingestion continuously merges new custom properties onto contacts in the background (`upsertContactByIdentity` property merge — the same contact being viewed). A marketer who opens the Свойства tab, waits, and clicks «Сохранить изменения» replaces the server object with the stale snapshot — silently deleting every property an event/API/CSV write added since mount, with a success toast. Under the old merge semantics this data survived; the replacement semantics made the stale-state window destructive.
**Fix:** minimal: re-seed editor state from fresh data (key `PropertiesTab` by `contact.updatedAt`, or sync state in an effect when `contact.properties` changes and the form is not dirty). Robust: optimistic concurrency — send the loaded `updatedAt` with the PATCH and have the server reject with 409 when the row changed since.

### WR-07 (new): a mid-batch enqueue failure in POST /v1/events returns a whole-request 500 after some items were already enqueued — client retry duplicates the enqueued prefix for server-minted eventIds

**File:** `apps/api/src/modules/events/events-api.routes.ts:57-106`
**Issue:** Per-item results are built with `Promise.all` over `eventsIngestQueue.add` calls. If Redis fails partway through a batch, `Promise.all` rejects and the route 500s — but items enqueued before the failure are already accepted into the pipeline, with no per-item result telling the client which ones. For items where the client supplied `eventId`, a retry dedupes via the workspace-scoped jobId. For items without one, `randomUUID()` mints a NEW id on the retry (line 77), so the already-enqueued originals are duplicated — duplicate events in a pipeline whose entire design goal is idempotency. This contradicts the D-24 per-item acceptance contract (one bad item must not damage the rest).
**Fix:** catch enqueue failures per item and return `{status: "rejected", error: "enqueue failed, retry"}` for the failed tail instead of rejecting the whole request:
```ts
try {
  await eventsIngestQueue.add("ingest-event", {...}, { jobId: `${workspaceId}-${eventId}` });
  return { eventId, status: "accepted" };
} catch {
  return { eventId, status: "rejected", error: "Temporarily unable to accept this event — retry" };
}
```

## Info

### IN-01 (carried): API-key list route gated by the `create` permission

**File:** `apps/api/src/modules/api-keys/api-keys.routes.ts:29`
**Issue:** Unchanged. `GET /api-keys` uses `requirePermission("apiKeys", "create")` — a read gated by a write permission; breaks if a read-only role is ever added.
**Fix:** add a `read` action to the `apiKeys` statement (`access-control.ts:30`) or comment the intentional coupling.

### IN-02 (carried): CSV formula injection in the error-report download

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:72-77, 301-304`
**Issue:** Unchanged. `csvEscape` quotes but does not neutralize cells beginning with `=`, `+`, `-`, `@` — they execute as formulas when the error report opens in Excel.
**Fix:** prefix cells matching `/^[=+\-@]/` with `'`.

### IN-03 (carried): error-report route returns 200 with an empty CSV for a nonexistent import id

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:288-309`
**Issue:** Unchanged. No existence check — an unknown `:id` yields a header-only CSV with 200, unlike every sibling route's 404.
**Fix:** `getCsvImport(id)` first; 404 when null.

### IN-04 (carried): contact event feed shows only the newest 50 events with no paging and no live refresh

**File:** `apps/web/src/features/contacts/ContactEventFeed.tsx:62-67`
**Issue:** Unchanged. The server route paginates (`?page=`, `contacts.routes.ts:140-155`) but the feed never passes `page` and has no `refetchInterval` despite the "live feed" framing.
**Fix:** add a load-more button driving `?page=`; optional modest `refetchInterval` while visible.

### IN-05 (carried): ILIKE wildcards in contact search are not escaped

**File:** `apps/api/src/modules/contacts/contact.repository.ts:121-126`
**Issue:** Unchanged. Parameterized (no SQLi), but `%`/`_` are user-controllable pattern metacharacters — searching `%` matches every contact.
**Fix:** `` search.replace(/[\\%_]/g, (m) => `\\${m}`) `` with `ILIKE ... ESCAPE '\'`.

### IN-06 (carried, narrowed): `validating` import status is declared but never set by any code path

**File:** `packages/db/src/schema/csv-imports.ts:24`, `apps/api/src/modules/contacts/csv-import.repository.ts:9`
**Issue:** `failed` is now reachable (WR-04 fix — resolved half of the original IN-06), but `validating` remains declared in the schema comment, the repository type, and `csvImportStatusSchema` (`shared-schemas/csv-import.ts:57`) while no server code ever writes it.
**Fix:** set `validating` during dry-run, or drop it from the declared lifecycle.

### IN-07 (carried): stale migration filename in `lookupApiKeyById` doc comment

**File:** `apps/api/src/modules/api-keys/api-keys.repository.ts:85`
**Issue:** Unchanged. References `migrations/0005_api_keys.sql`; the `api_key_runtime_lookup` policy lives in `0006_api_keys_rls_policies.sql`.
**Fix:** update the comment.

### IN-08 (carried): apps/api vitest config comment claims tests never touch Redis, but two suites enqueue real jobs

**File:** `apps/api/vitest.config.ts:30-33`, `apps/api/src/modules/events/__tests__/events-api.test.ts:30-33`, `apps/api/src/modules/contacts/__tests__/csv-import.test.ts:297-324`
**Issue:** Unchanged (and now doubly wrong): both `events-api.test.ts` (queue add/getJob/obliterate) and `csv-import.test.ts` (apply-route enqueue) open real Redis connections to `redis://localhost:6379/1`. A missing local Redis fails the suite in a way the config comment says is impossible.
**Fix:** update the comment; document the live-Redis requirement for the API suite.

### IN-09 (carried): wizard fires `toast.success("Импорт завершён")` for a FAILED import

**File:** `apps/web/src/features/contacts/CsvImportWizard.tsx:401-406`
**Issue:** Unchanged. The completion effect treats `done` and `failed` identically and always shows a success toast — directly contradicting the «Импорт завершился с ошибкой» card rendered below (line 447). More visible now that `failed` is actually reachable (WR-04 fix).
**Fix:** `status.status === "failed" ? toast.error("Импорт завершился с ошибкой") : toast.success("Импорт завершён")`.

### IN-10 (new): csv-import.test.ts leaks the imports:csv producer queue — jobs persist in test Redis and the ioredis connection is never closed

**File:** `apps/api/src/modules/contacts/__tests__/csv-import.test.ts:60-63, 297-324`
**Issue:** The apply test enqueues a real job via `importsCsvQueue`, but `afterAll` closes only the Fastify app and pg pool. Unlike `events-api.test.ts` (which obliterates and closes its queue, `events-api.test.ts:31-32`), the imports queue is neither obliterated nor closed: stale apply jobs accumulate in Redis DB 1 across runs (a worker ever pointed at that DB would replay them against long-gone imports), and the open ioredis connection can keep the vitest process from exiting cleanly.
**Fix:** mirror the events suite: `await importsCsvQueue.obliterate({ force: true }).catch(() => undefined); await importsCsvQueue.close();` in `afterAll`.

### IN-11 (new): CSV upload failure path returns the raw internal error message and leaves orphaned staged rows

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:198-212`
**Issue:** Two hygiene gaps in the (otherwise correct) WR-04 fix: (1) the 422 body echoes `err.message` verbatim — for a non-parser failure (e.g. `insertStagingRowsChunk` hitting a DB error) this leaks raw Postgres error text to the client instead of a stable message. (2) On both the parse-failure and truncation paths, rows already staged in `csv_import_rows` are kept forever under a `failed` import that can never be applied — dead weight in the fastest-growing staging table with no cleanup path.
**Fix:** return a generic message for non-`CsvError` failures (branch on `err` having a csv-parse `code`), and delete the import's staged rows when marking it `failed`.

---

## Gap-Closure Verification Matrix

| Prior finding | Plan | Status | Evidence |
|---|---|---|---|
| CR-01 cross-tenant eventId collision | 02-10 | FIXED | `events-api.routes.ts:99`; `0010:23-24`; `events-ingest.worker.ts:43`; tests in both apps |
| CR-02 dead 23505 retry | 02-11 | FIXED | `contact-repository.ts:242-277`; real race test `upsert-priority.test.ts:214-282` |
| CR-03 events lost outside partitions | 02-10 | FIXED | `events_default` in `0010:36`; test `events-ingest-idempotency.test.ts:186-212` |
| CR-04 merge-vs-replace / field clearing | 02-09 | FIXED | `contact.repository.ts:289-294`; nullable schema; `ContactForm.tsx:202-218`; 3 CRUD tests |
| WR-01 no queue retries | 02-10 | FIXED | `defaultJobOptions` on both queues; asserted in `events-api.test.ts:237-241` |
| WR-02 no worker error listeners | — | **OPEN** | carried as WR-01 above |
| WR-03 import stuck `applying` | 02-12 | FIXED (residual gap) | throw at `imports-csv.worker.ts:163-173`; residual carried as WR-02 above |
| WR-04 upload failure path | 02-12 | FIXED | try/catch + `markCsvImportFailed` + truncation 413; test `csv-import.test.ts:241-271` |
| WR-05 unvalidated CSV subscriptionStatus | 02-12 | FIXED | `csv-mapping.ts:30, 81-89`; tests `csv-import.test.ts:17-35, 209-239` |
| WR-06 subscriptionStatus ignored on update | 02-11 | FIXED | `contact-repository.ts:311-346`; tests B/C in `upsert-priority.test.ts` |
| WR-07 no dry-run/apply status guards | — | **OPEN** | carried as WR-03 above |
| WR-08 TOCTOU 23505 → 500 | — | **OPEN** | carried as WR-04 above |
| WR-09 dead connections released to pool | 02-11 | FIXED | `tenant-context/src/index.ts:80-94`; `api-keys.repository.ts:106-120` |
| WR-10 Redis URL TLS/db parsing | — | **OPEN** | carried as WR-05 above |
| IN-01..IN-09 | — | **OPEN** (IN-06 half-resolved) | carried above with re-verified line numbers |

---

_Reviewed: 2026-07-05T05:12:30Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
