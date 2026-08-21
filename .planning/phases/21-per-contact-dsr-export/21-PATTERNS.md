# Phase 21: Per-Contact DSR Export - Pattern Map

**Mapped:** 2026-08-21
**Files analyzed:** 10 (new/modified)
**Analogs found:** 10 / 10

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|---------------|
| `apps/api/src/modules/contacts/dsr-export.routes.ts` (new) | route/controller | request-response (file download) | `apps/api/src/modules/contacts/csv-import.routes.ts` (`GET .../errors` Content-Disposition route) | role-match (download route), also draws on `contacts.routes.ts` for guard chain shape |
| `apps/api/src/modules/contacts/dsr-export.repository.ts` (new) | service/data-access | CRUD + batch (multi-table keyset read, one transaction) | `apps/worker/src/queues/erasure-scrub.worker.ts` (`scrubEventsPage`/`scrubSendEventsPage`/`walkTableToExhaustion`) | exact (same tables, same pagination shape, read instead of write) |
| `packages/delivery-core/src/send-event-payload-allowlist.ts` (new, relocated) | utility (shared allowlist) | transform (build-up JSONB reconstruction) | `apps/worker/src/queues/erasure-scrub.worker.ts` (`SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST` + `buildScrubbedSendEventPayload`) | exact (pure relocation + superset extension) |
| `apps/worker/src/queues/erasure-scrub.worker.ts` (modified: thin re-export) | service (worker) | event-driven | itself (pre-relocation version) | exact — mechanical edit only |
| `packages/tenant-context/src/index.ts` (modified: new isolation-level transaction helper) | utility (DB transaction wrapper) | request-response (read-only, snapshot-consistent) | `withTenantTransaction`/`withPreTenantLookup` (same file, existing sibling helpers) | exact (same BEGIN/COMMIT/ROLLBACK/release discipline, new isolation clause) |
| `apps/api/src/modules/auth/access-control.ts` (modified: new `contact: ["export"]` resource) | config (access-control statement) | n/a | itself — `campaign: ["launch"]` / `flow: ["publish"]` precedent in the same file | exact |
| `packages/db/migrations/00XX_dsr_export_indexes.sql` (new, if Pitfall 2 addressed) | migration | batch (DDL) | existing index migrations, e.g. `0036_analytics_status_history_counts.sql` | role-match |
| `apps/web/src/features/contacts/ContactDetailPage.tsx` (modified: Export button + states) | component | request-response (fetch + blob download) | `DeleteContactDialog` in the same file (mutation + typed error pattern); `LaunchScheduleActions`'s `computeIncompleteReason` (disabled-button-with-inline-copy) in `LaunchScheduleDialogs.tsx` | exact (both patterns already live in the analog set) |
| `apps/api/src/modules/contacts/__tests__/dsr-export.test.ts` (new) | test | integration | `apps/api/src/modules/tenancy/__tests__/role-guard.test.ts` (`addMemberWithRole` harness) | role-match |
| `packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts` (new) | test | unit | `apps/worker/src/queues/__tests__/erasure-scrub.test.ts` (pure-function describe blocks being relocated) | exact |

## Pattern Assignments

### `apps/api/src/modules/contacts/dsr-export.routes.ts` (route, request-response/download)

**Analogs:** `apps/api/src/modules/contacts/csv-import.routes.ts` (Content-Disposition download route) + `apps/api/src/modules/contacts/contacts.routes.ts` (guard chain shape)

**Imports pattern** (from `contacts.routes.ts` lines 1-18, adapt names):
```typescript
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTenant } from "../../middleware/tenant-context.js";
import { requirePermission } from "../../middleware/role-guard.js";
import { resolveWorkspaceMember } from "../tenancy/resolve-workspace-member.js";
import { getDsrExportDocument, ContactErasedError } from "./dsr-export.repository.js";
```

**Guard chain pattern** (`contacts.routes.ts` lines 106-117, `csv-import.routes.ts` lines 278-293 for id validation before it reaches a header):
```typescript
fastify.get(
  "/api/workspaces/:slug/contacts/:id/dsr-export",
  { preHandler: requirePermission("contact", "export") }, // DSR-04, D-16
  async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };

    // WR-06 precedent (csv-import.routes.ts lines 284-293): validate an
    // attacker-controlled id BEFORE it reaches a query or a header, but
    // AFTER resolveWorkspaceMember so the anti-enumeration invariant holds.
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) {
      return reply.code(400).send({ error: "Invalid contact id" });
    }

    try {
      const doc = await withTenant(workspace.id, () => getDsrExportDocument(workspace.id, parsedId.data));
      if (!doc) {
        // Anti-enumeration 404 -- byte-identical to NOT_FOUND_BODY (Pattern 3 below)
        return reply.code(404).send({ error: "Workspace not found" });
      }
      const filename = `dsr-export-${parsedId.data}-${new Date().toISOString().slice(0, 10)}.json`; // D-08
      reply.header("Content-Type", "application/json");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      return reply.send(doc);
    } catch (err) {
      if (err instanceof ContactErasedError) {
        // D-13: typed 410, not a file
        return reply.code(410).send({
          code: "contact_erased",
          erasedAt: err.erasedAt,
          erasureRecordId: err.erasureRecordId,
        });
      }
      throw err;
    }
  }
);
```

**Content-Disposition precedent** (`csv-import.routes.ts` lines 308-310, the ONLY existing precedent in the codebase):
```typescript
reply.header("Content-Type", "text/csv");
reply.header("Content-Disposition", `attachment; filename="import-${parsedId.data}-errors.csv"`);
return reply.send(lines.join("\n"));
```

---

### `apps/api/src/modules/contacts/dsr-export.repository.ts` (service, CRUD+batch, keyset-paginated read)

**Analog:** `apps/worker/src/queues/erasure-scrub.worker.ts`

**Fail-closed anonymizedAt gate inside the transaction** (D-15, mirrors `contact.repository.ts` line 338's `anonymized_at as "anonymizedAt"` SELECT shape and `contacts.routes.ts` lines 167-175's 404-mapping-on-anonymized precedent — but this route needs 410, not 404, per D-13):
```typescript
const { rows } = await client.query<{ anonymizedAt: string | null }>(
  `SELECT anonymized_at as "anonymizedAt" FROM contacts WHERE workspace_id = $1 AND id = $2`,
  [workspaceId, contactId]
);
if (rows.length === 0) return null; // → 404 in the route
if (rows[0].anonymizedAt !== null) {
  throw new ContactErasedError(rows[0].anonymizedAt, /* erasureRecordId lookup */);
}
```

**Keyset pagination pattern** (erasure-scrub.worker.ts lines 226-269, `scrubSendEventsPage`, adapted to READ):
```typescript
// Source: erasure-scrub.worker.ts's scrubSendEventsPage -- adapt SELECT-only,
// no UPDATE, no checkpoint (single in-transaction while loop, not resumable
// across HTTP requests per D-10's note: "no checkpoint table is needed here").
const afterClause = cursor ? `AND (se.occurred_at, se.id) > ($3::timestamptz, $4::uuid)` : "";
const { rows } = await client.query(
  `SELECT se.id, se.occurred_at::text as "occurredAt", se.payload
   FROM send_events se
   JOIN sends s ON s.id = se.send_id
   WHERE se.workspace_id = $1 AND s.contact_id = $2 ${afterClause}
   ORDER BY se.occurred_at ASC, se.id ASC
   LIMIT $${limitIdx}`,
  params
);
```
Loop shape (in-memory `while`, no BullMQ job, no checkpoint — see erasure-scrub.worker.ts's own doc comment on line 227 distinguishing the export's single-transaction walk from the worker's resumable multi-job walk):
```typescript
const PAGE_LIMIT = 500; // D-10, mirrors ERASURE_SCRUB_PAGE_LIMIT
let cursor: { occurredAt: string; id: string } | null = null;
const allRows = [];
for (;;) {
  const page = await selectSendEventsPage(client, workspaceId, contactId, cursor, PAGE_LIMIT);
  if (page.length === 0) break;
  allRows.push(...page);
  const last = page[page.length - 1];
  cursor = { occurredAt: last.occurredAt, id: last.id };
}
```

**JSONB allowlist application at read time** (D-02, use the relocated `buildExportSendEventPayload` from `@mega-crm/delivery-core`):
```typescript
import { buildExportSendEventPayload } from "@mega-crm/delivery-core";
// ...
const sanitizedPayload = buildExportSendEventPayload(row.payload);
```

**events.properties exclusion** (D-01 — do NOT call any allowlist function on `events.properties`; simply never SELECT the column):
```typescript
// Mirrors erasure-scrub.worker.ts's own ruling (buildScrubbedEventProperties
// returns {} unconditionally) -- the export goes one step further and never
// even reads the column.
const { rows } = await client.query(
  `SELECT id, name, occurred_at::text as "occurredAt", received_at::text as "receivedAt" FROM events
   WHERE workspace_id = $1 AND contact_id = $2 ${afterClause}
   ORDER BY occurred_at ASC, id ASC
   LIMIT $${limitIdx}`,
  params
);
```

---

### `packages/tenant-context/src/index.ts` (new isolation-level helper)

**Analog:** the file's own `withTenantTransaction` (lines 216-257) and `withPreTenantLookup` (lines 303-326) — copy the exact BEGIN/COMMIT/ROLLBACK/release(err) discipline, only changing the literal `"BEGIN"` string.

```typescript
// New sibling helper (or an options param on withTenantTransaction) --
// combines BEGIN and the isolation clause in ONE statement, since Postgres
// forbids SET TRANSACTION ISOLATION LEVEL after the first query in a
// transaction (verified, sql-set-transaction.html).
export async function withTenantTransactionRepeatableRead<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const ctx = tenantContext.getStore();
  if (!ctx || ctx.workspaceId === undefined) {
    throw new Error("No tenant context set for this request");
  }
  const client = await pool.connect();
  let releaseWithError: Error | undefined;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); // <-- the only line that differs
    await client.query(
      "SELECT set_config('app.current_workspace_id', $1, true), set_config('application_name', $2, true)",
      [ctx.workspaceId, composeApplicationName(ctx)]
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      releaseWithError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(releaseWithError);
  }
}
```
**Anti-pattern to avoid** (from RESEARCH.md Pitfall 1): do NOT call plain `withTenantTransaction` for this route and try to raise isolation level inside the callback — its first statement is already `SELECT set_config(...)`, so the isolation-level `SET` would run too late and Postgres would reject it.

---

### `packages/delivery-core/src/send-event-payload-allowlist.ts` (relocated + extended allowlist)

**Analog:** `apps/worker/src/queues/erasure-scrub.worker.ts` lines 92-135 (verbatim relocation) + D-02's superset extension.

```typescript
// Relocated verbatim from erasure-scrub.worker.ts:
export const SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST = [
  "event", "type", "timestamp", "sg_event_id", "sg_message_id",
  "smtp-id", "status", "attempt", "asm_group_id", "bounce_classification",
] as const;

export function buildScrubbedSendEventPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const input = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST) {
    if (key in input) result[key] = input[key];
  }
  return result;
}

// New (D-02): export ⊇ evidence, strict superset, same build-up shape.
export const SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST = [
  ...SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST,
  "ip", "useragent", "url", "reason",
] as const;

export function buildExportSendEventPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  const input = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST) {
    if (key in input) result[key] = input[key];
  }
  return result;
}

// events.properties: still no allowlist, relocated verbatim.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function buildScrubbedEventProperties(properties: unknown): Record<string, unknown> {
  return {};
}

export const ERASURE_SCRUB_PAGE_LIMIT = 500;
```

**Re-export shim in `erasure-scrub.worker.ts`** (Pitfall 3 — the worker's own test imports these names from `"../erasure-scrub.worker.js"`, so this file must re-export, not just delete):
```typescript
export {
  SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST,
  buildScrubbedSendEventPayload,
  buildScrubbedEventProperties,
  ERASURE_SCRUB_PAGE_LIMIT,
} from "@mega-crm/delivery-core";
```

**Superset assertion test** (D-02, new):
```typescript
it("export allowlist is a strict superset of the evidence allowlist", () => {
  expect(SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST.every((k) => SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST.includes(k))).toBe(true);
});
```

---

### `apps/api/src/modules/auth/access-control.ts` (config, permission statement)

**Analog:** the file's own `campaign: ["launch"]` / `flow: ["publish"]` resources (lines 21-79) — the exact 4-line, 3-role pattern to copy for `contact: ["export"]`.

```typescript
export const statement = {
  // ...existing resources...
  contact: ["export"], // NEW -- DSR-04
} as const;

export const member = ac.newRole({
  // ...existing...
  contact: [], // Member has no export permission
});

export const admin = ac.newRole({
  // ...existing...
  contact: ["export"],
});

export const owner = ac.newRole({
  // ...existing...
  contact: ["export"],
});
```

---

### `apps/web/src/features/contacts/ContactDetailPage.tsx` (component, fetch+blob download with states)

**Analogs:** `DeleteContactDialog` in the same file (mutation + typed-error pattern, lines 32-85) + `LaunchScheduleActions`'s `computeIncompleteReason` (`LaunchScheduleDialogs.tsx` lines 346-351, 373-435, disabled-with-inline-copy pattern).

**Mutation + typed error pattern** (`DeleteContactDialog` lines 39-49, adapted — D-12 says reuse `apiGet` since the response IS JSON, per RESEARCH.md Pitfall 4, no raw-fetch/blob bypass needed):
```typescript
import { apiGet } from "@/lib/api";
import { ApiError } from "@/lib/api";

const exportMutation = useMutation({
  mutationFn: () => apiGet<DsrExportDocument>(`/api/workspaces/${slug}/contacts/${contact.id}/dsr-export`),
  onSuccess: (doc) => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dsr-export-${contact.id}-${new Date().toISOString().slice(0, 10)}.json`; // D-08
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Экспорт готов");
  },
  onError: (err) => {
    if (err instanceof ApiError && err.status === 410) {
      setServerError("Контакт обезличен — персональные данные удалены"); // D-13/D-14 backstop
      return;
    }
    if (err instanceof ApiError && err.status === 403) {
      setServerError("Только Owner или Admin может экспортировать данные контакта");
      return;
    }
    setServerError(GENERIC_ERROR);
  },
});
```

**Disabled-with-inline-copy pattern** (`LaunchScheduleDialogs.tsx` `computeIncompleteReason` lines 346-351 + `LaunchScheduleActions` lines 394-396, 415, 421-430 — D-14 extends this shape for the erased-contact button state):
```typescript
function computeExportDisabledReason(contact: ContactResponse): string | null {
  if (contact.anonymizedAt) return "Контакт обезличен — персональные данные удалены";
  return null;
}
// ...
const disabledReason = computeExportDisabledReason(contact);
<Button type="button" disabled={Boolean(disabledReason) || exportMutation.isPending} onClick={() => exportMutation.mutate()}>
  {exportMutation.isPending ? "Экспортируем…" : "Экспорт DSR"}
</Button>
{disabledReason ? <p className="text-sm text-destructive">{disabledReason}</p> : null}
```

---

## Shared Patterns

### Owner/Admin permission gate
**Source:** `apps/api/src/middleware/role-guard.ts` (`requirePermission`, lines 37-89)
**Apply to:** `dsr-export.routes.ts` — one-line `preHandler: requirePermission("contact", "export")` after the new resource is added to `access-control.ts`.
```typescript
export function requirePermission(resource: Resource, action: string) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // ...resolves workspace by :slug, calls auth.api.hasPermission, 404s on
    // unknown workspace or non-member (anti-enumeration), 403s on insufficient role...
  };
}
```

### Anti-enumeration 404
**Source:** `apps/api/src/modules/tenancy/resolve-workspace-member.ts` — `NOT_FOUND_BODY = { error: "Workspace not found" } as const;`
**Apply to:** `dsr-export.routes.ts`'s cross-tenant/nonexistent contact id branch — reuse the identical body/status, do not invent `{ error: "Contact not found" }` for this route alone (SC4).

### Build-up JSONB allowlist reconstruction
**Source:** `packages/delivery-core/src/send-event-payload-allowlist.ts` (relocated from `erasure-scrub.worker.ts`)
**Apply to:** `dsr-export.repository.ts`'s `send_events.payload` handling — always construct a new object copying only named keys forward; never delete/tear down from the input. `events.properties` gets NO allowlist call at all (D-01) — simply exclude the column from the SELECT.

### Keyset pagination in bounded pages
**Source:** `apps/worker/src/queues/erasure-scrub.worker.ts` (`scrubEventsPage`, `scrubSendEventsPage`)
**Apply to:** every multi-row section of `dsr-export.repository.ts` (`events`, `sends`+`send_events`, `flow_runs`+`flow_run_steps`, `campaign_recipients`) — order by `(timestamp, id)` (partition key must lead for partitioned tables), 500-row pages, loop until a page returns zero rows. No checkpoint table needed (single in-request transaction, not resumable across requests).

### REPEATABLE READ isolation for the whole read
**Source:** new helper in `packages/tenant-context/src/index.ts`, modeled on `withTenantTransaction`/`withPreTenantLookup`'s own BEGIN/COMMIT/ROLLBACK/release discipline
**Apply to:** `dsr-export.repository.ts`'s single transaction wrapping the `anonymizedAt` check and every subsequent section read — D-15's fail-closed guarantee requires this; `withTenantTransaction` unmodified cannot provide it (Pitfall 1).

### Fetch + typed-error + blob-download UI flow
**Source:** `DeleteContactDialog` (mutation/error state shape) + `apps/web/src/lib/api.ts`'s `ApiError`/`apiGet`
**Apply to:** `ContactDetailPage.tsx`'s Export button — reuse `apiGet` (already parses JSON and throws typed `ApiError` on non-2xx), convert the successful JSON response to a `Blob` + synthetic anchor click client-side; do not write a raw `fetch()`/blob bypass.

## No Analog Found

None — every file this phase touches has a direct, verified analog already in the repository (per RESEARCH.md's own "Key insight": only the isolation-level wrapper and the access-control resource are net-new code, and both are mechanical extensions of existing sibling patterns in the same files).

## Metadata

**Analog search scope:** `apps/api/src/modules/contacts/`, `apps/api/src/modules/tenancy/`, `apps/api/src/middleware/`, `apps/api/src/modules/auth/`, `apps/worker/src/queues/`, `packages/tenant-context/src/`, `packages/delivery-core/src/`, `apps/web/src/features/contacts/`, `apps/web/src/features/campaigns/`, `apps/web/src/lib/`
**Files scanned:** 10 read in full (all ≤ 638 lines, single-pass reads, no re-reads)
**Pattern extraction date:** 2026-08-21
