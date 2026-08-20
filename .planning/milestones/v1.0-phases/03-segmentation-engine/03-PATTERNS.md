# Phase 3: Segmentation Engine - Pattern Map

**Mapped:** 2026-07-05
**Files analyzed:** 15
**Analogs found:** 15 / 15

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `packages/segments-core/src/types.ts` | model/utility | transform | `packages/contacts-core/src/contact-repository.ts` (types) | role-match |
| `packages/segments-core/src/compile.ts` | utility (SQL compiler) | transform | `apps/api/src/modules/contacts/contact.repository.ts` (`listContacts` dynamic WHERE builder) | role-match |
| `packages/segments-core/src/operators.ts` | utility (allow-list) | transform | `apps/api/src/modules/contacts/contact.repository.ts` (`listContacts` filter clauses) | partial-match |
| `packages/segments-core/src/index.ts` | utility (barrel) | — | `packages/contacts-core/src/index.ts` | exact |
| `packages/segments-core/package.json` | config | — | `packages/contacts-core/package.json` | exact |
| `packages/shared-schemas/src/segment.ts` | model (Zod schema) | request-response | `packages/shared-schemas/src/contact.ts` | exact |
| `packages/db/src/schema/segments.ts` | model (Drizzle shape) | CRUD | `packages/db/src/schema/contacts.ts` | exact |
| `packages/db/migrations/00NN_segments.sql` | migration | CRUD | `packages/db/migrations/0004_contacts_rls_policies.sql` + `0009_csv_imports_rls_policies.sql` | exact |
| `packages/db/migrations/00NN_segments_indexes.sql` | migration | CRUD | `packages/db/migrations/0007_events_partitioned.sql` (index sections) | role-match |
| `apps/api/src/modules/segments/segments.routes.ts` | route/controller | request-response | `apps/api/src/modules/contacts/contacts.routes.ts` | exact |
| `apps/api/src/modules/segments/segment.repository.ts` | service/repository | CRUD + streaming(query) | `apps/api/src/modules/contacts/contact.repository.ts` | exact |
| `apps/api/src/modules/segments/event-names.repository.ts` | service/repository | request-response | `apps/api/src/modules/contacts/property-registry.ts` | role-match |
| `apps/web/src/features/segments/SegmentsListPage.tsx` | component | request-response | `apps/web/src/features/contacts/ContactsListPage.tsx` | exact |
| `apps/web/src/features/segments/SegmentBuilder.tsx` | component | request-response (debounced) | `apps/web/src/features/contacts/CustomPropertyEditor.tsx` + `ContactsListPage.tsx` (debounce hook) | role-match |
| `apps/web/src/features/segments/SegmentDetailPage.tsx` | component | request-response | `apps/web/src/features/contacts/ContactDetailPage.tsx` + `ContactsListPage.tsx` (member table) | exact |
| `apps/web/src/features/app-shell/AppShell.tsx` (modify) | component (nav) | — | itself (existing file, add one `Link`) | exact |
| `apps/api/src/modules/segments/__tests__/*.test.ts` | test | — | `apps/api/src/modules/contacts/__tests__/*` | exact |

## Pattern Assignments

### `packages/segments-core/src/*` (utility, transform)

**Analog:** `packages/contacts-core/src/contact-repository.ts`, `packages/contacts-core/src/index.ts`, `packages/contacts-core/package.json`

**Package shape** (`packages/contacts-core/package.json`, full file):
```json
{
  "name": "@mega-crm/contacts-core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": { "pg": "8.22.0", "pino": "10.3.1" },
  "devDependencies": { "@types/pg": "^8.15.6", "typescript": "^5.9.3" }
}
```
Copy this verbatim for `packages/segments-core/package.json`, renaming `name` to `@mega-crm/segments-core`. `segments-core` is pure (no DB I/O — compiler only), so it may not even need the `pg`/`pino` deps; only include what's actually imported (likely none — RESEARCH.md's `compile.ts` is a pure function with no `pg` import, only used by API consumers).

**Barrel export pattern** — mirror `packages/contacts-core/src/index.ts`: re-export every public type/function from `types.ts`, `compile.ts`, `operators.ts` through a single `index.ts` so `apps/api` imports as `from "@mega-crm/segments-core"`.

**Core compiler pattern** — RESEARCH.md's `compile.ts`/`operators.ts` code examples (already vetted against this codebase's conventions) are the ground truth; the *style* to match (parameterized `$N` positional args pushed into a shared `params: unknown[]` array, dynamic `conditions.push(...)`/`.join(" AND ")`) is directly lifted from `contact.repository.ts`'s `listContacts`:

```typescript
// apps/api/src/modules/contacts/contact.repository.ts lines ~109-119
const conditions: string[] = ["workspace_id = $1"];
const params: unknown[] = [workspaceId];

if (query.search) {
  params.push(`%${query.search}%`);
  const idx = params.length;
  conditions.push(
    `(email ILIKE $${idx} OR first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR external_id ILIKE $${idx})`
  );
}
```
This exact "push value, capture `params.length` as the placeholder index, append a SQL fragment string" idiom is what `compileCondition`/`compileAttributeCondition`/`compileBehavioralCondition` in RESEARCH.md's Code Examples already follow — no deviation needed, just extend it to the two-tier AND/OR/group structure and the EXISTS/NOT EXISTS behavioral fragment.

**Tag containment convention to fix:** the existing `contact.repository.ts` code uses `$N = ANY(tags)` for its tag filter (line ~121: `` `$${params.length} = ANY(tags)` ``) — RESEARCH.md's Anti-Patterns section explicitly flags `= ANY(tags)` as NOT using the GIN index efficiently vs `tags @> ARRAY[$N]`. Do **not** copy that specific fragment as-is for the new tag `has_tag`/`not_has_tag` operators in `operators.ts`; use `@>`/`NOT (tags @> ARRAY[$N])` instead, per RESEARCH.md Pitfall/Anti-Pattern guidance, even though it diverges from `contact.repository.ts`'s existing (less optimal) tag filter.

---

### `packages/shared-schemas/src/segment.ts` (model, request-response)

**Analog:** `packages/shared-schemas/src/contact.ts`

**Imports pattern** (full file starts):
```typescript
import { z } from "zod";
```

**Discriminated-union / typed schema pattern** — mirror `contact.ts`'s `subscriptionStatusSchema`/`createContactSchema` style: named exported `z.object`/`z.enum`/`z.discriminatedUnion` schemas with a JSDoc comment referencing the originating requirement/decision ID, immediately followed by `export type X = z.infer<typeof xSchema>`:

```typescript
// packages/shared-schemas/src/contact.ts lines 3-5
/** 3-state subscription status (SUBS-01) -- see packages/db/src/schema/contacts.ts's subscriptionStatusEnum. */
export const subscriptionStatusSchema = z.enum(["subscribed", "unsubscribed", "suppressed"]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
```

**List/query-param schema pattern** (for a future segment list query, if paginated the same way as contacts):
```typescript
// packages/shared-schemas/src/contact.ts lines 58-65
export const contactListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: subscriptionStatusSchema.optional(),
  tag: z.string().trim().optional(),
  sort: z.enum(["createdAt", "-createdAt", "email", "-email"]).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;
```
Reuse the exact `page`/`pageSize` coercion pair for the segment member-list query and segment-list query schemas.

RESEARCH.md's Code Examples section already contains a fully-formed `SegmentDefinition`/`segmentConditionSchema`/`segmentGroupSchema` draft that follows this exact file's conventions (discriminated union on `type`, `z.infer` type export) — use it as the literal starting content for `segment.ts`, just add the response schemas following `contactResponseSchema`'s shape (plain object mirroring the DB row, ISO date strings for timestamps).

---

### `packages/db/src/schema/segments.ts` (model, CRUD)

**Analog:** `packages/db/src/schema/contacts.ts`

**Full pattern to copy** (imports + table definition shape):
```typescript
// packages/db/src/schema/contacts.ts lines 1-2, 24-44
import { pgTable, text, timestamp, uuid, jsonb, pgEnum, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // ...fields...
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("contacts_workspace_external_id_unique").on(t.workspaceId, t.externalId), /* ... */]
);
```
For `segments`: `id uuid pk default random()`, `workspaceId` FK to `organization.id` with `onDelete: "cascade"` (identical), `name text not null`, `definition jsonb not null` (the versioned `SegmentDefinition` JSON), `createdBy` (FK to user/member — check `contacts.ts` sibling files for the exact user-reference pattern used elsewhere, e.g. csv_imports' `createdBy`), `createdAt`/`updatedAt` timestamps identical to contacts. This file is **shape-only** — DDL/RLS/indexes go in hand-written SQL migrations, per project convention (Drizzle is never used to generate migrations directly in this repo; confirmed by the existence of separate `packages/db/migrations/*.sql` files).

---

### `packages/db/migrations/00NN_segments.sql` (migration, CRUD)

**Analog:** `packages/db/migrations/0004_contacts_rls_policies.sql`, `packages/db/migrations/0009_csv_imports_rls_policies.sql`

**Full RLS pattern to copy** (entire relevant excerpt from `0004_contacts_rls_policies.sql`):
```sql
-- Row-Level Security for the three new tenant-scoped tables introduced in
-- Phase 2 Plan 1 (contacts, workspace_suppressions,
-- workspace_property_registry). Same pattern as 0001_rls_policies.sql --
-- ENABLE + FORCE (required: the app role owns its own tables, and Postgres
-- exempts the table owner from RLS by default) + workspace_isolation policy
-- gated on the `app.current_workspace_id` GUC set per-transaction by
-- withTenantTransaction (see apps/api/src/middleware/tenant-context.ts).

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON contacts
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
```
Copy this exact `ENABLE` + `FORCE` + `CREATE POLICY workspace_isolation ... USING (...) WITH CHECK (...)` triplet for the new `segments` table, substituting the table name. This is non-negotiable per RESEARCH.md's Security Domain and CLAUDE.md's "What NOT to Use" (app-only tenant filtering without RLS).

---

### `packages/db/migrations/00NN_segments_indexes.sql` (migration, CRUD)

**Analog:** existing `events`/`contacts` index-bearing migrations (e.g. `0007_events_partitioned.sql`, `0010_events_workspace_scoped_pk.sql`) for the general "separate migration file per index-set" convention seen in this repo's migration list.

No GIN index is needed on the new `segments` table itself (its `definition` JSONB is read whole, not queried by key) — the GIN/btree indexing decisions in RESEARCH.md concern `contacts.properties`/`contacts.tags`, which **already have indexes from Phase 2** (verify via `\d contacts` or existing migration files before adding duplicates). If Phase 2's indexes don't yet cover `jsonb_path_ops` per Open Question 2, add here; otherwise this migration file may be a no-op / merged into `00NN_segments.sql`.

---

### `apps/api/src/modules/segments/segments.routes.ts` (route/controller, request-response)

**Analog:** `apps/api/src/modules/contacts/contacts.routes.ts`

**Imports pattern** (lines 1-17):
```typescript
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createContactSchema, updateContactSchema, contactListQuerySchema } from "@mega-crm/shared-schemas";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import {
  ContactConflictError,
  createContact,
  deleteContact,
  getContact,
  listContacts,
  listContactEvents,
  updateContact,
  type ContactEventRow,
  type ContactRow,
} from "./contact.repository.js";
import { listPropertyRegistry } from "./property-registry.js";
```
Mirror exactly for segments: import segment Zod schemas from `@mega-crm/shared-schemas`, `withTenant` from tenant-context, `resolveWorkspaceMember`-equivalent auth helper, and repository functions from `./segment.repository.js`.

**Auth/workspace-resolution pattern** (lines 46-68, copy verbatim, rename nothing but comments):
```typescript
async function resolveWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string
): Promise<ActiveWorkspace | null> {
  const workspace = await findActiveWorkspaceBySlug(slug);
  if (!workspace) {
    await reply.code(404).send({ error: "Workspace not found" });
    return null;
  }
  try {
    await getCallerRoles(toFetchHeaders(request), slug);
  } catch {
    await reply.code(404).send({ error: "Workspace not found" });
    return null;
  }
  return workspace;
}
```
This is a cross-cutting shared pattern — see Shared Patterns below. Segments routes need the exact same 404-not-409-on-auth-failure behavior (avoids workspace-enumeration oracle, per CONTEXT/RESEARCH V4 Access Control note that segment management is ordinary-member-level, matching contacts).

**Core CRUD route pattern** (lines 82-113, GET list + POST create):
```typescript
export async function registerContactsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/contacts", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = contactListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;
    const result = await withTenant(workspace.id, () => listContacts(parsed.data));
    return reply.send({
      items: result.items.map(toContactResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  fastify.post("/api/workspaces/:slug/contacts", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = createContactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;
    try {
      const created = await withTenant(workspace.id, () => createContact(parsed.data));
      return reply.code(201).send(toContactResponse(created));
    } catch (err) {
      if (err instanceof ContactConflictError) {
        return reply.code(409).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });
```
This is the template for `GET/POST/PATCH/DELETE /api/workspaces/:slug/segments`, plus two new route shapes with no direct analog in `contacts.routes.ts`:
- `GET /api/workspaces/:slug/segments/preview-count` — same `safeParse` → `resolveWorkspaceMember` → `withTenant(... => countSegmentMembers(def))` → `reply.send({ count })` shape, just no persisted resource.
- `GET /api/workspaces/:slug/segments/:id/members` — same pagination response shape as the list route above, reusing `toContactResponse` (contacts are still contacts).

**Response-mapper pattern** (lines 29-45, `toContactResponse`) — mirror for `toSegmentResponse(row: SegmentRow)`, plain object mapping DB row → ISO-string timestamps.

---

### `apps/api/src/modules/segments/segment.repository.ts` (service/repository, CRUD)

**Analog:** `apps/api/src/modules/contacts/contact.repository.ts`

**Imports pattern** (lines 1-12):
```typescript
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import {
  CONTACT_COLUMNS,
  isEmailSuppressed,
  isEmailTaken,
  registerObservedProperties,
  upsertContactByIdentity,
  type ContactRow,
  // ...
} from "@mega-crm/contacts-core";
```
Mirror for `segment.repository.ts`: import `getWorkspaceId`/`withTenantTransaction` from the same tenant-context module, and `compileSegmentDefinition` + types from `@mega-crm/segments-core`.

**withTenantTransaction wrapper pattern** (lines 74-89, `listContactEvents`, full function):
```typescript
export async function listContactEvents(
  contactId: string,
  options: { page: number } = { page: 1 }
): Promise<ContactEventRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const page = Math.max(1, options.page);
    const { rows } = await client.query<ContactEventRow>(
      `SELECT id, name, properties, occurred_at as "occurredAt", received_at as "receivedAt"
       FROM events
       WHERE workspace_id = $1 AND contact_id = $2
       ORDER BY occurred_at DESC
       LIMIT $3 OFFSET $4`,
      [workspaceId, contactId, CONTACT_EVENTS_PAGE_SIZE, (page - 1) * CONTACT_EVENTS_PAGE_SIZE]
    );
    return rows;
  });
}
```
This exact "single `withTenantTransaction` block, `getWorkspaceId()` first line, parameterized query, typed row" shape is the template for `countSegmentMembers`/`listSegmentMembers`/`isContactInSegment` — RESEARCH.md's own Pattern 2 code example already follows this shape verbatim; use it directly as the file content, adjusted only for the `compileSegmentDefinition` call.

**Error class pattern** (lines 97-104, `ContactConflictError`, full class):
```typescript
export class ContactConflictError extends Error {
  constructor(
    message: string,
    public readonly code: "email_taken" | "invalid_status_transition" | "cannot_set_suppressed"
  ) {
    super(message);
    this.name = "ContactConflictError";
  }
}
```
Use the same pattern if a `SegmentConflictError` becomes necessary (e.g., D-14's future "restrict delete when referenced" — not needed THIS phase since nothing references segments yet, but the class shape is ready to extend).

**Dynamic WHERE-builder pattern (existing, must extend not duplicate)** (lines 109-145, `listContacts`) — already excerpted above under segments-core; the same idiom is reused here at the repository layer for the *count* query wrapping the compiled `whereSql`.

---

### `apps/api/src/modules/segments/event-names.repository.ts` (service/repository, request-response)

**Analog:** `apps/api/src/modules/contacts/property-registry.ts` (full file, 32 lines)

```typescript
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

export interface PropertyRegistryRow {
  key: string;
  observedType: "string" | "number" | "bool" | "date";
}

export async function listPropertyRegistry(): Promise<PropertyRegistryRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<PropertyRegistryRow>(
      `SELECT key, observed_type as "observedType" FROM workspace_property_registry
       WHERE workspace_id = $1 ORDER BY key ASC`,
      [workspaceId]
    );
    return rows;
  });
}
```
Copy this exact shape for `listObservedEventNames()`, but replace the query body with RESEARCH.md's Pattern 3 loose-index-scan recursive CTE (5.6s → 3ms benchmark) — do NOT use a naive `SELECT DISTINCT name FROM events WHERE workspace_id = $1` even though it looks like the closest one-line adaptation of this analog; RESEARCH.md's Pitfall 2 is specifically a warning against copying that naive shape.

---

### `apps/web/src/features/segments/SegmentsListPage.tsx` (component, request-response)

**Analog:** `apps/web/src/features/contacts/ContactsListPage.tsx`

**Imports pattern** (lines 1-29, full import block):
```typescript
import { useEffect, useMemo, useState } from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter } from "lucide-react";

import type { ContactListResponse, ContactResponse, SubscriptionStatus } from "@mega-crm/shared-schemas";
import { apiGet } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { /* dropdown-menu parts */ } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateContactDialog } from "@/features/contacts/ContactForm";
import { SubscriptionStatusBadge } from "@/features/contacts/SubscriptionStatusBadge";
import { cn } from "@/lib/utils";
```

**Debounce hook** (lines 37-44, full, reuse verbatim — copy into `apps/web/src/features/segments/` or promote to a shared `@/lib` hook if the planner prefers DRY over the existing per-feature-copy convention):
```typescript
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
```
Note the existing code comment: "no debounce utility exists in the codebase yet, keep local to this component" — this is the established convention (duplicate locally), not a shared util; follow it for `SegmentBuilder.tsx`'s live-count debounce too, matching A1's 300ms assumption from RESEARCH.md.

**Table + query pattern** (lines ~57-90, `useQuery` with `keepPreviousData`, page/search/status state, `useEffect` reset-to-page-1-on-filter-change) — this is the exact shape for `SegmentsListPage.tsx`'s list view (name, member count, created/updated, author columns per D-11) and for `SegmentDetailPage.tsx`'s paginated member list (D-12), reusing `apiGet`/`keepPreviousData`/react-table's `createColumnHelper`.

---

### `apps/web/src/features/segments/SegmentBuilder.tsx` (component, request-response/debounced)

**Analog:** `apps/web/src/features/contacts/CustomPropertyEditor.tsx` (key/value custom property editing UI — closest existing analog for a dynamic, typed, add/remove-row condition editor) + `ContactsListPage.tsx`'s debounce/query-key pattern for the live count.

**Live-count query-key pattern to establish** (new, following RESEARCH.md Pitfall 6's recommendation and the existing `queryKey`-encodes-all-filter-state convention already visible in `ContactsListPage.tsx`'s `queryParams`/`useQuery` pairing): encode the full debounced `SegmentDefinition` JSON into the TanStack Query `queryKey` so cache/response-ordering is handled automatically (no manual `AbortController` needed) — matches this codebase's existing convention of putting all query-affecting state into the key rather than manual cancellation.

---

### `apps/web/src/features/segments/SegmentDetailPage.tsx` (component, request-response)

**Analog:** `apps/web/src/features/contacts/ContactDetailPage.tsx` (definition/detail header) + `ContactsListPage.tsx` (paginated member table, reused per D-12 explicitly).

No direct excerpt needed beyond what's already extracted above for `ContactsListPage.tsx` — D-12 explicitly calls for reusing that exact table pattern for the member list; `ContactDetailPage.tsx`'s general "header + editable definition panel" layout convention applies for the top section.

---

### `apps/web/src/features/app-shell/AppShell.tsx` (modify, component/nav)

**Analog:** itself — add one `Link` following the existing pattern exactly (lines 17-22, full block to copy/adapt):
```tsx
<Link
  to={`/w/${slug}/contacts`}
  className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
>
  Контакты
</Link>
```
Insert a new `<Link to={`/w/${slug}/segments`} ...>Сегменты</Link>` immediately after (or before) the Contacts link, per D-10 ("Сегменты" as a section next to "Контакты").

---

### `apps/api/src/modules/segments/__tests__/*.test.ts` (test)

**Analog:** `apps/api/src/modules/contacts/__tests__/*` (exact test structure/naming convention — inspect files there for the Vitest describe/it shape and fixture/seed helpers used for tenant-scoped integration tests; not read in full here since RESEARCH.md's Wave 0 gap list already specifies exact file names/coverage per requirement).

## Shared Patterns

### Tenant Context / RLS Enforcement
**Source:** `apps/api/src/middleware/tenant-context.ts` (re-export shim) → `@mega-crm/tenant-context`
**Apply to:** Every function in `segment.repository.ts` and `event-names.repository.ts` — no exceptions, no direct `pool.query` calls.
```typescript
export { withTenant, withTenantTransaction, getWorkspaceId } from "@mega-crm/tenant-context";
```
Every read/write must be wrapped: `withTenantTransaction(async (client) => { const workspaceId = getWorkspaceId(); ... })`. This is Pitfall 5 in RESEARCH.md — the single highest-risk omission.

### Workspace-Member Auth Resolution (404-not-409 on auth failure)
**Source:** `apps/api/src/modules/contacts/contacts.routes.ts` lines 46-68 (`resolveWorkspaceMember`)
**Apply to:** All new segment routes (`segments.routes.ts`) — copy the helper function itself (or extract/import if the planner wants a shared module; currently duplicated per-route-file in this codebase, so duplicating again matches existing convention).

### Dynamic Parameterized WHERE-Clause Construction
**Source:** `apps/api/src/modules/contacts/contact.repository.ts` lines 109-145 (`listContacts`)
**Apply to:** `packages/segments-core/src/compile.ts`'s `compileSegmentDefinition`/`compileAttributeCondition`/`compileBehavioralCondition`, and `segment.repository.ts`'s count/list/point-check tails. The idiom: `params: unknown[]`, push value then read `params.length` as the placeholder index, never string-interpolate a value.

### RLS Migration Pattern (ENABLE + FORCE + workspace_isolation policy)
**Source:** `packages/db/migrations/0004_contacts_rls_policies.sql` (full file excerpted above)
**Apply to:** `packages/db/migrations/00NN_segments.sql` — mandatory for the new `segments` table, per CLAUDE.md's explicit "What NOT to Use: application-only tenant filtering without RLS."

### Zod Schema-First Validation (route-level)
**Source:** `packages/shared-schemas/src/contact.ts` + `contacts.routes.ts`'s `parsed.success`/`reply.code(400).send({ error: parsed.error.flatten() })` idiom (lines 84-87)
**Apply to:** Every new segments route — `segmentDefinitionSchema.safeParse`, `createSegmentSchema.safeParse`, etc., identical 400-response shape on failure.

### Debounced Live-Query with Query-Key Cache Correctness
**Source:** `apps/web/src/features/contacts/ContactsListPage.tsx` lines 37-44 (`useDebouncedValue`) + its `queryParams`-in-`queryKey` convention
**Apply to:** `SegmentBuilder.tsx`'s live-count preview (SEGM-04) — debounce the definition edits locally (component-scoped hook, not shared util, per existing convention), encode the full definition into the TanStack Query key so stale/out-of-order responses are handled by cache identity rather than manual `AbortController` (addresses RESEARCH.md Pitfall 6).

## No Analog Found

None — every file in the phase's scope has at least a role-match analog in the existing codebase (contacts/events modules cover controller, repository, schema, migration, and frontend list/detail/table patterns comprehensively). The segment condition *compiler* (`compile.ts`/`operators.ts`) is the most novel piece with no exact prior analog, but RESEARCH.md's Code Examples section already provides vetted, codebase-convention-matching reference implementations to use directly as a starting point (documented above under `packages/segments-core/src/*`).

## Metadata

**Analog search scope:** `apps/api/src/modules/{contacts,events}`, `apps/web/src/features/{contacts,app-shell}`, `packages/{contacts-core,db,shared-schemas}`
**Files scanned:** contact.repository.ts, contacts.routes.ts, property-registry.ts, contacts-core/{index.ts,contact-repository.ts,package.json}, db/schema/contacts.ts, db/migrations/{0004,0009}_*.sql, shared-schemas/contact.ts, web/features/contacts/{ContactsListPage,ContactDetailPage,CustomPropertyEditor}.tsx, web/features/app-shell/AppShell.tsx
**Pattern extraction date:** 2026-07-05
