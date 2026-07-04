---
phase: 02-contacts-event-ingestion
reviewed: 2026-07-04T11:16:34Z
depth: standard
files_reviewed: 92
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
  critical: 4
  warning: 10
  info: 9
  total: 23
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-07-04T11:16:34Z
**Depth:** standard
**Files Reviewed:** 92
**Status:** issues_found

## Summary

Reviewed the full Phase 2 surface: contact CRUD + identity upsert (contacts-core), API-key auth, event ingestion (route → BullMQ → worker → partitioned `events` table), CSV import pipeline (upload/dry-run/apply/worker), RLS migrations, shared schemas, and the React frontend.

The multi-tenancy fundamentals are solid: RLS is applied consistently (ENABLE + FORCE + `workspace_isolation` on every new tenant table), `SET LOCAL` via `set_config(..., true)` is used correctly, API-key verification uses `timingSafeEqual` with a uniform 401 body, and reserved property keys are stripped before JSONB merges.

However, the async ingestion pipeline has correctness gaps that the "202 = validated and queued" contract makes dangerous: the idempotency key for events is a **client-supplied UUID that is global across tenants** (both in BullMQ jobId space and the `events` primary key), the partitioned `events` table only covers two months while `occurredAt` is accepted unbounded, no job has retry configuration, and the documented unique-violation retry in `upsertContactByIdentity` cannot work because it runs inside an already-aborted transaction. On the frontend, property deletion and field clearing silently never persist due to a merge-vs-replace mismatch with the PATCH endpoint.

## Critical Issues

### CR-01: Client-supplied `eventId` is a globally-scoped idempotency key — cross-tenant event suppression / silent data loss

**File:** `apps/api/src/modules/events/events-api.routes.ts:77-92`, `packages/db/migrations/0007_events_partitioned.sql:27`, `apps/worker/src/queues/events-ingest.worker.ts:38-41`
**Issue:** The optional client-supplied `eventId` is used directly as the BullMQ `jobId` (`{ jobId: eventId }`) and as the `events` table primary key component (`PRIMARY KEY (id, occurred_at)` + `ON CONFLICT (id, occurred_at) DO NOTHING`). Neither is scoped by `workspace_id`:
1. **Queue level:** BullMQ jobIds are global per queue. If tenant B submits an `eventId` that tenant A's job already occupies (waiting/delayed/completed-and-retained), `queue.add` is a silent no-op — tenant B's event is dropped while the API still returns `{status: "accepted"}`.
2. **DB level:** a colliding `(id, occurred_at)` insert from a different workspace hits `DO NOTHING` and the event vanishes.

`eventId` is validated as UUID but attacker-controlled: any tenant with a valid API key can squat UUIDs. Tenants using deterministic ID schemes (e.g., UUIDv5 of order IDs) make accidental and deliberate cross-tenant collisions realistic. This violates the "workspace is the boundary of all data" constraint for the platform's highest-volume write path.
**Fix:**
```ts
// events-api.routes.ts — scope the queue idempotency key per tenant:
await eventsIngestQueue.add("ingest-event", { ... }, { jobId: `${workspaceId}:${eventId}` });
```
And scope the DB dedupe key per tenant (new migration):
```sql
ALTER TABLE events DROP CONSTRAINT events_pkey;
ALTER TABLE events ADD PRIMARY KEY (workspace_id, id, occurred_at);
-- worker: ON CONFLICT (workspace_id, id, occurred_at) DO NOTHING
```

### CR-02: Unique-violation retry in `upsertContactByIdentity` runs inside an aborted transaction — the race defense can never succeed

**File:** `packages/contacts-core/src/contact-repository.ts:256-262`
**Issue:** Branch E catches a `23505` from the INSERT and recursively retries "against whichever row won". But the INSERT ran inside the caller's open `withTenantTransaction` transaction: after any error, Postgres aborts the transaction and every subsequent statement fails with `25P02: current transaction is aborted, commands ignored until end of transaction block`. The retry's first `SELECT ... FOR UPDATE` therefore always throws. The documented defense-in-depth is dead code; the actual behavior under a concurrent-insert race is a failed request (500 on `/v1/contacts`, cryptic `error` row status in the CSV worker, failed job in events:ingest). All three ingestion paths call this function.
**Fix:** wrap the INSERT in a savepoint so the transaction survives the conflict:
```ts
try {
  await client.query("SAVEPOINT upsert_insert");
  const { rows } = await client.query(`INSERT INTO contacts ...`);
  ...
} catch (err) {
  if (!_isRetry && isUniqueViolation(err)) {
    await client.query("ROLLBACK TO SAVEPOINT upsert_insert");
    return upsertContactByIdentity(client, workspaceId, input, true);
  }
  throw err;
}
```

### CR-03: Events accepted with a 202 are permanently lost when `occurredAt` falls outside the two pre-created partitions

**File:** `apps/api/src/modules/events/events-api.routes.ts:78`, `packages/db/migrations/0007_events_partitioned.sql:36-39`, `apps/worker/src/queues/events-ingest.worker.ts:37-42`
**Issue:** `eventEnvelopeSchema` accepts any ISO datetime for `occurredAt` (arbitrarily far past or future). Only `events_2026_07` and `events_2026_08` partitions exist, there is no `DEFAULT` partition, and no partition-maintenance job (the migration comment acknowledges this as "operational follow-up"). The insert for any out-of-range `occurredAt` fails with `no partition of relation "events" found for row`. Because neither the producer nor the worker configures retries (WR-01), the job moves to `failed` permanently — after the client already received `{status: "accepted"}`. Concretely: any historical backfill (`occurredAt < 2026-07-01`) fails **today**, and **all** event ingestion breaks after 2026-09-01 unless the maintenance job ships first. This is silent, unrecoverable-from-the-client's-view data loss inside a normal input range.
**Fix (layered):**
1. Reject or clamp `occurredAt` outside a supported window at validation time (e.g., `occurredAt` must be within the covered partition range; return per-item `rejected` otherwise).
2. Add a `DEFAULT` partition as a catch-all so no valid job can fail on partition routing:
```sql
CREATE TABLE events_default PARTITION OF events DEFAULT;
```
3. Ship the partition pre-creation job before the 2026-09 boundary.

### CR-04: Property deletion and field clearing silently never persist — PATCH merge semantics vs UI replace semantics, with false success feedback

**File:** `apps/api/src/modules/contacts/contact.repository.ts:286`, `apps/web/src/features/contacts/CustomPropertyEditor.tsx:61-63`, `apps/web/src/features/contacts/ContactDetailPage.tsx:97-107`, `apps/web/src/features/contacts/ContactForm.tsx:192-202`
**Issue:** `updateContact` merges properties: `patch.properties ? { ...existing.properties, ...patch.properties } : existing.properties`. The Свойства tab's `CustomPropertyEditor` has an explicit remove button and sends the full remaining properties object expecting replacement — the server merge re-adds every removed key, so deletion is a no-op while the UI shows "Контакт обновлён" and (after refetch) the key reappears. The same class of bug affects standard fields: `cleanPayload` in `ContactForm` drops emptied fields from the payload entirely, and `updateContact` keeps the existing value for any absent field — a user can never clear phone/city/first name/etc. A user-facing edit surface that cannot delete or clear values, with success toasts, is shipping-blocking incorrect behavior.
**Fix:** choose one semantic per surface and make them agree. Simplest: treat `properties` in PATCH as full replacement (the UI already sends the complete object): `const nextProperties = patch.properties ?? existing.properties;` and accept explicit `null`/empty-string to clear standard fields (schema: `.nullable()`, repository: distinguish `undefined` (keep) from `null` (clear), UI: send `null` for cleared fields).

## Warnings

### WR-01: No retry configuration on either queue — any transient failure permanently drops an accepted job

**File:** `apps/api/src/modules/events/events-queue.ts:38-40`, `apps/api/src/modules/contacts/imports-csv-queue.ts:35-37`, `apps/worker/src/queues/events-ingest.worker.ts:59-67`, `apps/worker/src/queues/imports-csv.worker.ts:161-169`
**Issue:** `Queue.add` is called without `attempts`/`backoff` and neither Queue nor Worker sets `defaultJobOptions`. BullMQ's default is 1 attempt: a momentary DB restart, pool exhaustion, or deadlock moves the job straight to `failed` with no redelivery — contradicting the "at-least-once redelivery" premise all the idempotency machinery (ON CONFLICT, row-status guards) was built for. For events this means accepted-then-lost data; for CSV it means an import stuck in `applying`.
**Fix:** `new Queue(..., { defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { age: 86400 }, removeOnFail: false } })` on both producers.

### WR-02: BullMQ Workers have no `error`/`failed` event listeners

**File:** `apps/worker/src/server.ts:37-55`
**Issue:** Neither worker attaches `worker.on("error", ...)` or `worker.on("failed", ...)`. BullMQ's Worker is an EventEmitter; an `error` event with no listener throws an uncaught exception at the process level (Redis hiccups, internal errors), and job failures are completely invisible operationally (no log line anywhere).
**Fix:** in `buildWorker()`, attach for each worker: `w.on("error", (err) => console.error("worker error", err)); w.on("failed", (job, err) => console.error({ jobId: job?.id }, "job failed", err));`

### WR-03: CSV apply can finish leaving the import stuck in `applying` forever with no re-run

**File:** `apps/worker/src/queues/imports-csv.worker.ts:114-124, 144-149`
**Issue:** When a row's processing throws and the follow-up "mark row error" UPDATE also fails, the error is swallowed (`.catch(() => undefined)`) and the row remains `pending`, but the outer cursor has advanced past it. The final recount sees `stillPending > 0` and leaves status `applying` — yet the BullMQ job completes **successfully**, so nothing ever re-runs it. The UI (`ApplyProgressAndReport`) polls `applying` at 1.5s intervals indefinitely.
**Fix:** after the recount, if `stillPending > 0`, throw (so BullMQ marks the job failed and — with WR-01 fixed — retries), or loop back to reprocess remaining pending rows; and don't advance `cursor` past a row whose error-marking failed.

### WR-04: CSV upload route: no failure path, and truncated uploads are silently accepted

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:144-197`
**Issue:** Two problems: (1) a malformed CSV that makes `csv-parse` throw mid-stream produces a 500, stranding the `csv_imports` row in `uploaded` with orphaned staged rows — the `failed` status exists in the schema but is never set anywhere. (2) `@fastify/multipart`'s `limits.fileSize` truncates the stream at 50MB and sets `data.file.truncated = true`; the route never checks it, so an oversized file is silently imported partially and reported as a successful upload with a plausible `totalRows`.
**Fix:** wrap the streaming loop in try/catch that sets `status='failed'` (and clears staged rows), and after the loop: `if (data.file.truncated) { /* mark failed, return 413 */ }`.

### WR-05: `subscriptionStatus` from CSV mapping is applied unvalidated — dry-run/apply drift and a bypass of the "cannot set suppressed" rule

**File:** `packages/contacts-core/src/csv-mapping.ts:59-63`
**Issue:** `applyCsvRowMapping` writes the raw CSV cell into the typed `subscriptionStatus` field via an untyped cast. Consequences: (1) an invalid value (`"yes"`, `"SUBSCRIBED"`) passes dry-run as a valid row (counted in `willCreate`/`willUpdate`), then fails at apply time with a raw Postgres enum error as the row's `reason` — the dry-run summary drifts from apply results, exactly what the shared interpreter was built to prevent; (2) a CSV can set `subscriptionStatus=suppressed` directly on create, bypassing the D-12/T-02-01-02 guard the session update path enforces.
**Fix:** validate in the mapper: if the target is `subscriptionStatus` and the value isn't `subscribed|unsubscribed` (normalize case), return `{ input, error: "Invalid subscription status" }` so dry-run and apply agree.

### WR-06: `upsertContactByIdentity` silently ignores `subscriptionStatus` for existing contacts although the API schema accepts it

**File:** `packages/contacts-core/src/contact-repository.ts:297-323`, `packages/shared-schemas/src/contact.ts:120`
**Issue:** `upsertContactApiSchema` accepts `subscriptionStatus` on every item, but the update branch's SQL never touches `subscription_status` — it only applies on the brand-new-contact branch. An integrator calling `POST /v1/contacts` with `subscriptionStatus: "unsubscribed"` for an existing contact gets a 200 and no state change, with no indication in the response. Either the field should be applied on update (with the D-12 suppressed-transition guards) or rejected/documented as create-only.
**Fix:** apply valid transitions on the update branch (mirroring `updateContact`'s D-12 rules), or strip `subscriptionStatus` from the API schema and document create-only semantics.

### WR-07: No status guards on dry-run/apply — concurrent dry-run corrupts a running apply; apply is re-enqueueable; failure between status update and enqueue strands the import

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:222-262`
**Issue:** (1) `POST .../apply` doesn't check `existing.status` — it can be re-posted while `applying` or after `done`, enqueueing duplicate jobs (per-row idempotency protects rows, but the final recount/status writes race). (2) `POST .../dry-run` also doesn't check status: running it while the worker is applying resets already-scheduled rows back to `pending` and swaps `mapping` mid-flight — the worker read `mapping` once at start, so re-pended rows get processed under a policy/mapping mix. (3) If `importsCsvQueue.add` throws after `markCsvImportApplying`, the import is stuck `applying` with no job.
**Fix:** guard both routes on allowed statuses (`dry-run`: only `uploaded|ready`; `apply`: only `ready`), and enqueue **before** (or transactionally with compensating rollback of) the status flip.

### WR-08: TOCTOU on email/external_id uniqueness in session create/update — race surfaces as an unhandled 500 instead of 409

**File:** `apps/api/src/modules/contacts/contact.repository.ts:193-233, 245-323`
**Issue:** `createContact`/`updateContact` check `isEmailTaken` then INSERT/UPDATE without catching `23505`. The DB unique constraints (`contacts_workspace_email_unique`, `contacts_workspace_external_id_unique`) correctly prevent the duplicate, but a concurrent request racing the check propagates a raw driver error → 500, instead of the `ContactConflictError` → 409 contract the routes and UI (`email_taken` copy) rely on.
**Fix:** catch `23505` in both functions and rethrow as `ContactConflictError("...", "email_taken")`.

### WR-09: Dead pooled connections are released back into the pool despite the comment claiming otherwise

**File:** `packages/tenant-context/src/index.ts:79-89`, `apps/api/src/modules/api-keys/api-keys.repository.ts:105-114`
**Issue:** The catch block's comment says "releasing below with `destroy=true` handles that case", but `finally { client.release(); }` never passes the destroy flag. When a connection dies mid-transaction (the exact scenario the ROLLBACK-swallow exists for), the broken client is returned to the pool and the next checkout fails. `lookupApiKeyById` has the identical pattern — and that one sits on the hot auth path.
**Fix:** track failure and release accordingly:
```ts
} catch (err) {
  try { await client.query("ROLLBACK"); } catch { client.release(err as Error); throw err; }
  client.release();
  throw err;
}
// success path: client.release();
```
(or `client.release(true)` whenever ROLLBACK itself failed).

### WR-10: Redis URL parsing (3 duplicated copies) drops TLS and mishandles non-numeric DB paths

**File:** `apps/api/src/modules/events/events-queue.ts:20-32`, `apps/api/src/modules/contacts/imports-csv-queue.ts:17-29`, `apps/worker/src/queues/connection.ts:11-23`
**Issue:** `buildRedisConnectionOptions` ignores the URL scheme: a `rediss://` URL (standard for managed Redis in staging/prod) silently produces a plaintext connection config with no `tls` option — the queue backend either fails opaquely or, worse, connects unencrypted where the server allows it. Also `Number(url.pathname.slice(1))` yields `NaN` for any non-numeric path, which ioredis passes through as an invalid `db`. Three duplicated copies mean the fix must land in all three (the stated "config parsing can't drift" rationale is already false the moment one copy is patched).
**Fix:** `...(url.protocol === "rediss:" ? { tls: {} } : {})`, and validate `Number.isInteger(db)` before including it. Consider extracting to `@mega-crm/shared-schemas` or a small shared util since it now exists in triplicate.

## Info

### IN-01: API-key list route gated by the `create` permission

**File:** `apps/api/src/modules/api-keys/api-keys.routes.ts:29`
**Issue:** `GET /api-keys` uses `requirePermission("apiKeys", "create")`. Works today (Owner/Admin both hold `create`), but a read gated by a write permission is misleading and will break if a read-only role is ever added.
**Fix:** add a `read`/`list` action to the `apiKeys` statement or comment the intentional coupling.

### IN-02: CSV formula injection in the error-report download

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:71-76, 278-286`
**Issue:** `csvEscape` handles quoting but not spreadsheet formula injection — cells beginning with `=`, `+`, `-`, `@` are re-exported verbatim and will execute as formulas when the error report is opened in Excel. Data originates from the tenant's own upload (low severity), but a marketer downloading a "fixed-up" file from a third-party-sourced CSV is a realistic vector.
**Fix:** prefix cells matching `/^[=+\-@]/` with `'`.

### IN-03: Error-report route returns 200 with an empty CSV for a nonexistent import id

**File:** `apps/api/src/modules/contacts/csv-import.routes.ts:265-286`
**Issue:** No existence check — an unknown `:id` yields a 200 with a header-only CSV instead of the 404 every sibling route returns.
**Fix:** `getCsvImport(id)` first; 404 when null.

### IN-04: Contact event feed shows only the newest 50 events with no way to page

**File:** `apps/web/src/features/contacts/ContactEventFeed.tsx:62-67`
**Issue:** The server route paginates (`CONTACT_EVENTS_PAGE_SIZE = 50`, `?page=`), but the feed never passes `page` and renders no "load more" — older events are unreachable from the UI. Also no `refetchInterval` despite being described as a "live" feed.
**Fix:** add a load-more button driving `?page=`, and optionally a modest `refetchInterval` while the tab is visible.

### IN-05: ILIKE wildcards in contact search are not escaped

**File:** `apps/api/src/modules/contacts/contact.repository.ts:118-124`
**Issue:** The search string is safely parameterized (no SQLi), but `%`/`_` are user-controllable pattern metacharacters: searching `%` matches every contact, `_` matches any single char — surprising filter semantics and a mild scan-cost amplifier.
**Fix:** escape before wrapping: `` search.replace(/[\\%_]/g, (m) => `\\${m}`) `` with `ILIKE ... ESCAPE '\'`.

### IN-06: `validating` and `failed` import statuses are declared but never set by any code path

**File:** `packages/db/src/schema/csv-imports.ts:24`, `apps/api/src/modules/contacts/csv-import.routes.ts`, `apps/worker/src/queues/imports-csv.worker.ts`
**Issue:** The documented lifecycle includes `validating` and `failed`, and the UI renders a `failed` branch (`CsvImportWizard`, `CsvImportHistory`), but no server code ever writes either status — the failure branch is currently unreachable, masking the WR-04 gap.
**Fix:** wire `failed` into the upload/apply error paths (see WR-04/WR-03); drop `validating` or set it during dry-run.

### IN-07: Stale migration filename in `lookupApiKeyById` doc comment

**File:** `apps/api/src/modules/api-keys/api-keys.repository.ts:84`
**Issue:** References `migrations/0005_api_keys.sql`; the `api_key_runtime_lookup` policy actually lives in `0006_api_keys_rls_policies.sql`.
**Fix:** update the comment.

### IN-08: apps/api vitest config comment claims tests never touch Redis, but events-api.test.ts enqueues real jobs

**File:** `apps/api/vitest.config.ts:31-33`, `apps/api/src/modules/events/__tests__/events-api.test.ts:30-31`
**Issue:** The comment ("tests never open a real Redis connection... a placeholder value just satisfies the Zod schema") is outdated — `events-api.test.ts` adds real jobs to `redis://localhost:6379/1` and obliterates the queue afterward. A missing local Redis now fails the suite in a way the config documentation says is impossible.
**Fix:** update the comment; document the live-Redis requirement for the API suite.

### IN-09: Wizard fires `toast.success("Импорт завершён")` for a FAILED import

**File:** `apps/web/src/features/contacts/CsvImportWizard.tsx:401-406`
**Issue:** The completion effect treats `done` and `failed` identically and always shows a success toast, contradicting the failure card rendered directly below it.
**Fix:** branch the toast: `status.status === "failed" ? toast.error("Импорт завершился с ошибкой") : toast.success("Импорт завершён")`.

---

_Reviewed: 2026-07-04T11:16:34Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
