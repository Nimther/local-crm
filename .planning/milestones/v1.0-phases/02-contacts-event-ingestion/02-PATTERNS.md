# Phase 2: Contacts & Event Ingestion - Pattern Map

**Mapped:** 2026-07-04
**Files analyzed:** 27
**Analogs found:** 24 / 27

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `packages/db/src/schema/contacts.ts` | model | CRUD | `packages/db/src/schema/sendgrid-keys.ts` | role-match |
| `packages/db/src/schema/events.ts` | model | streaming/batch (partitioned) | `packages/db/src/schema/sendgrid-keys.ts` | partial (no partitioned table precedent — see No Analog) |
| `packages/db/src/schema/api-keys.ts` | model | CRUD | `packages/db/src/schema/sendgrid-keys.ts` | exact (masked-secret shape) |
| `packages/db/src/schema/csv-imports.ts` | model | CRUD/batch | `packages/db/src/schema/sendgrid-keys.ts` | role-match |
| `packages/db/migrations/000X_contacts_events_apikeys_imports.sql` (RLS) | migration | CRUD | `packages/db/migrations/0001_rls_policies.sql` | exact |
| `packages/db/src/rls.ts` (extend if needed) | config | - | `packages/db/src/rls.ts` | exact |
| `packages/tenant-context/src/index.ts` (NEW package, extraction) | utility | request-response/event-driven | `apps/api/src/middleware/tenant-context.ts` | exact (relocate, not rewrite) |
| `apps/api/src/modules/contacts/contact.repository.ts` | service (repository) | CRUD | `apps/api/src/modules/tenancy/sendgrid-key.repository.ts` | role-match (upsert shape is novel — see Pattern 1 in RESEARCH.md) |
| `apps/api/src/modules/contacts/property-registry.ts` | service (utility) | CRUD | `apps/api/src/modules/tenancy/sendgrid-key.repository.ts` | partial |
| `apps/api/src/modules/contacts/contacts.routes.ts` (session-authed UI CRUD) | route/controller | request-response | `apps/api/src/modules/tenancy/sendgrid-key.ts` | exact |
| `apps/api/src/modules/contacts/contacts-api.routes.ts` (API-key CRUD) | route/controller | request-response | `apps/api/src/modules/tenancy/sendgrid-key.ts` (auth wiring differs — see api-key-auth.ts) | role-match |
| `apps/api/src/modules/contacts/csv-import.routes.ts` | route/controller | file-I/O + batch | `apps/api/src/modules/tenancy/invites.ts` (closest existing multi-step/background-ish flow) | partial |
| `apps/api/src/modules/events/events-api.routes.ts` | route/controller | event-driven | `apps/api/src/modules/tenancy/sendgrid-key.ts` (route registration shape) | partial (new: API-key auth, queue producer) |
| `apps/api/src/modules/api-keys/api-keys.routes.ts` | route/controller | CRUD | `apps/api/src/modules/tenancy/sendgrid-key.ts` | exact (role-gated CRUD shape) |
| `apps/api/src/modules/api-keys/api-key-auth.ts` | middleware | request-response | `apps/api/src/middleware/role-guard.ts` | role-match (new auth *mechanism*, same "decorate request" shape) |
| `apps/worker/src/server.ts` | config/bootstrap | event-driven | `apps/api/src/server.ts` | role-match (no HTTP listen; queue workers instead) |
| `apps/worker/src/queues/events-ingest.worker.ts` | service (worker) | event-driven | none in codebase | no analog — first queue worker |
| `apps/worker/src/queues/imports-csv.worker.ts` | service (worker) | batch/file-I/O | none in codebase | no analog — first queue worker |
| `packages/shared-schemas/src/contact.ts` | utility (Zod schema) | CRUD | `packages/shared-schemas/src/sendgrid-key.ts` | exact |
| `packages/shared-schemas/src/event.ts` | utility (Zod schema) | event-driven | `packages/shared-schemas/src/sendgrid-key.ts` | role-match |
| `packages/shared-schemas/src/api-key.ts` | utility (Zod schema) | CRUD | `packages/shared-schemas/src/sendgrid-key.ts` | exact |
| `packages/shared-schemas/src/csv-import.ts` | utility (Zod schema) | batch | `packages/shared-schemas/src/sendgrid-key.ts` | role-match |
| `apps/web/src/features/contacts/ContactsListPage.tsx` | component | CRUD | `apps/web/src/features/team/TeamPage.tsx` | exact (table + query pattern) |
| `apps/web/src/features/contacts/ContactDetailPage.tsx` (incl. event feed) | component | CRUD/read | `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` | role-match |
| `apps/web/src/features/contacts/ContactForm.tsx` | component | CRUD | `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` (RHF+Zod form section) | exact |
| `apps/web/src/features/contacts/CsvImportWizard.tsx` (upload/mapping/preview/progress/report) | component | file-I/O + batch, polling | `apps/web/src/features/team/TeamPage.tsx` (list/query/mutation shape only) | partial — new: multi-step wizard, progress polling |
| `apps/web/src/features/api-keys/ApiKeysSettings.tsx` | component | CRUD | `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` | exact (masked-secret display pattern, `KeyStatusBadge`) |
| `apps/api/src/server.ts` (register new route modules) | config | - | `apps/api/src/server.ts` (self, extend) | exact |
| `docker-compose.yml` (add `redis` service) | config | - | `docker-compose.yml` (`db` service block) | exact |

## Pattern Assignments

### `packages/db/src/schema/contacts.ts`, `api-keys.ts`, `csv-imports.ts` (model, CRUD)

**Analog:** `packages/db/src/schema/sendgrid-keys.ts` (full file, 25 lines — read in one pass)

**Full pattern to copy:**
```typescript
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

export const workspaceSendgridKeys = pgTable("workspace_sendgrid_keys", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  // ...typed columns...
  status: text("status").notNull().default("active"), // "active" | "error"
  lastCheckedAt: timestamp("last_checked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```

- Every new tenant-scoped table references `organization.id` (from `./auth.js`) with `{ onDelete: "cascade" }` — copy this FK shape exactly for `contacts.workspace_id`, `workspace_api_keys.workspace_id`, `csv_imports.workspace_id`.
- Contacts needs `pgEnum` (not present in the analog) — see RESEARCH.md's Code Examples section (`subscriptionStatusEnum`) for the exact `pgEnum` import/usage; copy that block verbatim, it already follows this file's column-declaration style (`text`, `timestamp`, `uuid`, `jsonb`).
- Register new schema modules in `packages/db/src/index.ts` following the existing merge-and-reexport pattern:
```typescript
// packages/db/src/index.ts (lines 1-25, extend this exact shape)
import * as sendgridKeysSchema from "./schema/sendgrid-keys.js";
const schema = { ...authSchema, ...sendgridKeysSchema /* + contactsSchema, eventsSchema, apiKeysSchema, csvImportsSchema */ };
export * from "./schema/sendgrid-keys.js";
```

---

### `packages/db/migrations/000X_*.sql` (RLS for all new tables)

**Analog:** `packages/db/migrations/0001_rls_policies.sql` (full file, 34 lines)

**Exact pattern to copy per new table** (`contacts`, `events`, `workspace_suppressions`, `workspace_property_registry`, `workspace_api_keys`, `csv_imports`):
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;  -- REQUIRED, not optional — see comment in analog, lines 19-26

CREATE POLICY workspace_isolation ON <table>
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
```
Note: for the partitioned `events` table, RLS must be applied to the **parent** table (Postgres propagates RLS policies to partitions automatically) — apply once on `events`, not per-partition.

---

### `packages/tenant-context/` (NEW shared package — extraction)

**Analog:** `apps/api/src/middleware/tenant-context.ts` (full file, 67 lines — read in one pass)

This is a **relocation**, not a rewrite — RESEARCH.md's Structure Rationale flags this as the single most consequential structural decision this phase. Copy the file's contents verbatim into `packages/tenant-context/src/index.ts`, adjusting only the import path for `pool` (currently `../db.js` relative to `apps/api/src/middleware/`; the new package needs its own `Pool` construction or to accept an injected pool — decide in planning, but do NOT duplicate the `AsyncLocalStorage` + `SET LOCAL` logic).

Key exports to preserve exactly: `withTenant<T>(workspaceId, fn)`, `getWorkspaceId()`, `withTenantTransaction<T>(fn)`. The `SET LOCAL` (never plain `SET`) and `finally { client.release() }` details are load-bearing — see comments at lines 27-38 of the analog. `apps/api` and the new `apps/worker` both import from this package going forward; `apps/api/src/middleware/tenant-context.ts` becomes a re-export or is deleted in favor of the package import.

---

### `apps/api/src/modules/contacts/contact.repository.ts` (repository/service, CRUD)

**Analog:** `apps/api/src/modules/tenancy/sendgrid-key.repository.ts` (full file, 93 lines)

**Imports pattern** (lines 1):
```typescript
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
// (after extraction: from "@mega-crm/tenant-context")
```

**Core CRUD pattern** (lines 32-92): every repository function wraps its query in `withTenantTransaction(async (client) => { const workspaceId = getWorkspaceId(); await client.query(...) })` — parameterized queries only, never string-templated (this is explicitly called out in RESEARCH.md Pitfall 4 as the existing defense against SQL injection for freeform properties too). `getKey()` shows the `SELECT ... WHERE workspace_id = current_setting('app.current_workspace_id', true)::uuid` read pattern — reuse verbatim for any read that doesn't already have `workspaceId` in scope.

**Departure from analog:** the contact upsert itself is NOT a single `ON CONFLICT` statement like `upsertKey` (lines 32-51) — it requires the explicit `SELECT ... FOR UPDATE` + branch transaction from RESEARCH.md's **Pattern 1** (lines 260-343 of 02-RESEARCH.md, `upsertContactByIdentity`). Copy that function verbatim as the starting point; it is already written against this exact repository/transaction convention.

---

### `apps/api/src/modules/api-keys/api-keys.routes.ts` (route, CRUD, session-authed management)

**Analog:** `apps/api/src/modules/tenancy/sendgrid-key.ts` (full file, 159 lines)

**Imports pattern** (lines 1-11):
```typescript
import type { FastifyInstance } from "fastify";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { requireVerifiedEmail } from "../auth/verification-gate.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug } from "./workspace-lookup.js";
```

**Auth/role-gate pattern** (lines 71-74, 115-118):
```typescript
fastify.post(
  "/api/workspaces/:slug/api-keys",
  { preHandler: [requirePermission("apiKeys", "create")] }, // D-21: Owner/Admin only
  async (request, reply) => { /* ... */ }
);
```
This is the exact pattern for the api-keys management routes (create/list/revoke) — D-21 requires the same Owner/Admin gate `sendgrid-key.ts` uses for connect/recheck.

**404-as-non-enumeration pattern** (lines 40-55): any workspace-slug-not-found AND any permission-check-throw both map to the same 404 — reuse this exactly for api-keys routes to avoid workspace-enumeration via the keys list endpoint.

**Response-shaping / secret-mask-once pattern** (lines 70-112): the "generate → validate/hash → store only hash+mask → return full secret ONLY in this response" flow directly maps to D-22 (full secret shown once at creation, DB stores only hash). Use `generateApiKey()` from RESEARCH.md's Pattern 3 (lines 410-417 of 02-RESEARCH.md) for the crypto; wire it into this route file using `sendgrid-key.ts`'s POST-connect structure (validate → persist → shape response).

---

### `apps/api/src/modules/api-keys/api-key-auth.ts` (middleware, request-response, NEW auth mechanism)

**Analog:** `apps/api/src/middleware/role-guard.ts` (full file, 65 lines) — for the "hook shape that decorates `request`" convention, NOT for the auth logic itself (session vs API-key are different mechanisms).

**Structural pattern to copy** (lines 36-64 of role-guard.ts): a function returning/being a Fastify `preHandler`/`onRequest` async function taking `(request, reply)`, returning early with `reply.code(401/403).send({ error: ... })` on failure, otherwise falling through by decorating request state for the handler to read.

**Concrete implementation:** use RESEARCH.md's **Pattern 3** verbatim (lines 405-437 of 02-RESEARCH.md) — `generateApiKey()` and `apiKeyAuth()` functions, including the `crypto.timingSafeEqual` comparison and `Bearer mcrm_<id>.<secret>` header format. Register as `onRequest` (not `preHandler`) per Pitfall 3 (body-parsing-order) — this must run before Fastify's body parser touches the (potentially large, ~1000-event batch) request body.

---

### `apps/api/src/modules/events/events-api.routes.ts` (route, event-driven, API-key-authed)

**Analog (route registration shape):** `apps/api/src/modules/tenancy/sendgrid-key.ts` lines 35-44 (the `registerXRoutes(fastify: FastifyInstance)` export convention) — **for registration shape only**.

**Concrete implementation:** RESEARCH.md's **Pattern 2** (lines 352-375 of 02-RESEARCH.md) — the `POST /v1/events` handler with `{ onRequest: apiKeyAuth }`, `randomUUID()`-generated `eventId` as both BullMQ `jobId` and idempotency key, `reply.code(202).send({ results })` with per-item `{ eventId, status: "accepted" }`. Copy this verbatim; it is the load-bearing idempotency contract (D-24, Pitfall 1).

---

### `apps/worker/src/queues/events-ingest.worker.ts`, `imports-csv.worker.ts` (worker, event-driven/batch)

**No analog in codebase** — this is the project's first BullMQ worker process.

**Concrete implementation:** RESEARCH.md's **Pattern 2** worker half (lines 377-397 of 02-RESEARCH.md) — `new Worker("events:ingest", async (job) => { await withTenant(job.data.workspaceId, () => withTenantTransaction(async (client) => { ...upsertContactByIdentity...; INSERT ... ON CONFLICT (id) DO NOTHING; })) }, { connection: redisConnection })`. Critical rule from Pattern 2's description: **always re-derive `workspaceId` from `job.data`**, never trust any ambient/ALS state — the worker is a separate process from the one that enqueued the job.

`apps/worker/src/server.ts` bootstrap: mirror `apps/api/src/server.ts`'s `buildServer`/`main`/`isDirectRun` structure (lines 1-51) but with `new Worker(...)` instances instead of `Fastify()` + `.listen()` — no HTTP server, just process bootstrap + graceful shutdown hooks.

---

### `packages/shared-schemas/src/{contact,event,api-key,csv-import}.ts`

**Analog:** `packages/shared-schemas/src/sendgrid-key.ts` (full file, 30 lines)

**Pattern to copy:**
```typescript
import { z } from "zod";

export const connectSendgridKeySchema = z.object({
  apiKey: z.string().trim().min(1, "Введите API-ключ SendGrid"),
});
export type ConnectSendgridKeyInput = z.infer<typeof connectSendgridKeySchema>;
```
Every request/response shape gets a `z.object(...)` schema + inferred `type X = z.infer<typeof xSchema>` exported alongside it, used identically on both the Fastify route (via `@fastify/type-provider-zod`) and the React form (`zodResolver`). Register new modules in `packages/shared-schemas/src/index.ts`:
```typescript
export * from "./sendgrid-key.js"; // existing line 4 — add ./contact.js, ./event.js, ./api-key.js, ./csv-import.js the same way
```
Per D-24 the event schema needs a batch wrapper (`z.array(eventSchema).max(1000)`) — no existing analog for batch arrays in this codebase; author fresh but keep the same single-object-schema-plus-inferred-type convention.

---

### `apps/web/src/features/contacts/ContactsListPage.tsx` (component, CRUD, list+search+filter+pagination)

**Analog:** `apps/web/src/features/team/TeamPage.tsx` (full file, 212 lines — read in one pass)

**Imports pattern** (lines 1-13): `useMutation/useQuery/useQueryClient` from `@tanstack/react-query`, `useParams` from `react-router`, `toast` from `sonner`, shared-schemas types, `apiDelete/apiGet/apiPost` from `@/lib/api`, UI primitives from `@/components/ui/*`.

**Query + loading-skeleton pattern** (lines 38-54, 110-117):
```typescript
const membersQuery = useQuery({
  queryKey: ["workspace", slug, "members"],
  queryFn: () => apiGet<MemberListItem[]>(`/api/workspaces/${slug}/members`),
  enabled: Boolean(slug),
});
// ...
if (workspaceQuery.isLoading || membersQuery.isLoading) {
  return <div className="space-y-4 p-8"><Skeleton className="h-8 w-64" /><Skeleton className="h-64 w-full" /></div>;
}
```

**Table rendering pattern** (lines 166-194): `<Card><CardContent className="p-0"><Table><TableHeader>...<TableBody>{rows.map(...)}</TableBody></Table></CardContent></Card>` with an empty-state `Card` shown conditionally (lines 153-164). For CONT-13's search/filter/sort/pagination, this file has no pagination precedent — add TanStack Table (per RESEARCH's Standard Stack reference to project STACK.md) on top of this query/skeleton/card shell.

**Mutation + toast + invalidate pattern** (lines 63-96): every mutation follows `useMutation({ mutationFn, onSuccess: () => { toast.success(...); void invalidateX(); }, onError: () => toast.error(...) })` — copy verbatim for contact create/update/delete mutations.

---

### `apps/web/src/features/contacts/ContactForm.tsx` (component, CRUD, RHF+Zod form)

**Analog:** `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` lines 68-160 (form section only, not the whole file — the rest is SendGrid-specific).

**Form pattern:**
```typescript
const form = useForm<ConnectSendgridKeyInput>({
  resolver: zodResolver(connectSendgridKeySchema),
  defaultValues: { apiKey: "" },
});
// ...
<Form {...form}>
  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
    <FormField control={form.control} name="apiKey" render={({ field }) => (
      <FormItem><FormLabel>...</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
    )} />
    {serverError ? <p className="text-sm font-medium text-destructive">{serverError}</p> : null}
    <Button type="submit" disabled={form.formState.isSubmitting || mutation.isPending}>...</Button>
  </form>
</Form>
```

**Server-error extraction pattern** (lines 33-41):
```typescript
function extractErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | undefined;
    if (typeof body?.error === "string") return body.error;
  }
  return GENERIC_ERROR;
}
```
Reuse verbatim — applies to any contact/CSV-import/api-key mutation error surface.

---

### `apps/web/src/features/api-keys/ApiKeysSettings.tsx` (component, CRUD, masked-secret display)

**Analog:** `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` (full file, 229 lines) + `apps/web/src/features/sendgrid-key/KeyStatusBadge.tsx`

**Masked-key display pattern** (lines 163-175): `<span className="font-mono text-sm">{status.keyMask}</span>` next to a `<KeyStatusBadge status={...} />` — directly reusable shape for the API-keys list (prefix + last-4 display, D-22). The connected/not-connected conditional card rendering (lines 130-224) maps to API-keys' empty-list vs populated-list states, though API keys are a list (multiple, D-21) rather than singleton — combine this display pattern with `TeamPage.tsx`'s table-of-rows pattern instead of the singleton-card shape.

---

## Shared Patterns

### Tenant Transaction Scoping (RLS enforcement)
**Source:** `apps/api/src/middleware/tenant-context.ts` (to be extracted to `packages/tenant-context`)
**Apply to:** All repository/service files touching `contacts`, `events`, `workspace_suppressions`, `workspace_property_registry`, `workspace_api_keys`, `csv_imports` — in BOTH `apps/api` (routes) and `apps/worker` (job processors).
```typescript
export async function withTenantTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const ctx = tenantContext.getStore();
  if (!ctx) throw new Error("No tenant context set for this request");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [ctx.workspaceId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    throw err;
  } finally {
    client.release();
  }
}
```
Critical: `SET LOCAL` via `set_config(..., true)`, never plain `SET` — see comment block lines 27-38 of the source file.

### Role-Gated Management Routes (Owner/Admin)
**Source:** `apps/api/src/middleware/role-guard.ts` (`requirePermission`)
**Apply to:** `api-keys.routes.ts` (D-21 create/revoke), any CSV-import trigger route, contact-delete route (if elevated permission required) — same `{ preHandler: [requirePermission(resource, action)] }` wiring as `sendgrid-key.ts`.

### Non-Enumeration 404 Pattern
**Source:** `apps/api/src/modules/tenancy/sendgrid-key.ts` lines 44-55
**Apply to:** Every session-authed route keyed by `:slug` — workspace-not-found and permission-denied must return the identical 404 shape so a route can't be used to enumerate workspace existence.

### Parameterized Queries Only (never string-templated JSON merge)
**Source:** `apps/api/src/modules/tenancy/sendgrid-key.repository.ts` (all queries use `$1, $2, ...` placeholders)
**Apply to:** `contact.repository.ts`'s `properties || $incoming` JSONB merge and any CSV-row insert — RESEARCH.md Pitfall 4 explicitly calls out that reserved-key stripping must happen in application code before the merge, since parameterization alone doesn't prevent a JSON key named `subscription_status` from reaching the wrong column semantically.

### TanStack Query + Mutation + Toast + Invalidate
**Source:** `apps/web/src/features/team/TeamPage.tsx`, `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx`
**Apply to:** All new `apps/web/src/features/contacts/*`, `apps/web/src/features/api-keys/*` components — `useQuery` keyed by `["workspace", slug, "<resource>"]`, `useMutation` with `onSuccess: toast.success + invalidateQueries`, `onError: toast.error` or inline `serverError` state via `extractErrorMessage`.

### API Response Envelope + Error Shape
**Source:** `apps/web/src/lib/api.ts` (`apiFetch`, `ApiError`)
**Apply to:** All new frontend API calls — `credentials: "include"` for session-authed routes; note the Event/Contacts *integration* API (server-to-server) does NOT use this cookie-based client at all — it's called by tenant backends directly with the `Authorization: Bearer` header (Pattern 3), so `apiFetch` is only relevant for the UI-facing contacts/api-keys/CSV-import routes, not the `/v1/*` integration surface.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/worker/src/queues/events-ingest.worker.ts` | service (worker) | event-driven | First BullMQ worker in the codebase — no queue infrastructure exists yet (RESEARCH.md confirms Redis/BullMQ absent pre-Phase-2). Use RESEARCH.md Pattern 2 code example directly. |
| `apps/worker/src/queues/imports-csv.worker.ts` | service (worker) | batch/file-I/O | Same as above; also no CSV-streaming precedent in the codebase — see RESEARCH.md's csv-parse + `@fastify/multipart` Code Examples and Don't-Hand-Roll table. |
| `packages/db/src/schema/events.ts` (partitioned table) | model | streaming/batch | No partitioned table precedent exists in `packages/db/src/schema/*` today — RESEARCH.md's Code Examples section (lines 534-556) has the concrete `PARTITION BY RANGE` SQL to follow (raw migration SQL, not expressible in `pgTable` alone — Drizzle's schema file should still declare the logical shape for type inference, but the actual `CREATE TABLE ... PARTITION BY` and monthly partition creation must live in a migration, not `drizzle-kit generate` output). |
| `apps/web/src/features/contacts/CsvImportWizard.tsx` (multi-step: upload → mapping → preview/dry-run → apply → progress → report) | component | file-I/O + batch, polling | No multi-step wizard or progress-polling UI exists in `apps/web/src/features/*` today; build fresh on top of the TanStack Query/mutation shared pattern, using `refetchInterval` for progress polling (standard TanStack Query option, not present elsewhere in this codebase yet but requires no new library). |

## Metadata

**Analog search scope:** `apps/api/src`, `apps/web/src`, `packages/db/src`, `packages/db/migrations`, `packages/shared-schemas/src`
**Files scanned:** ~55 (full directory listing) + 12 read in full for pattern extraction
**Pattern extraction date:** 2026-07-04
