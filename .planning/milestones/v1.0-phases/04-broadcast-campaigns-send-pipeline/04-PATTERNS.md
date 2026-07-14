# Phase 4: Broadcast Campaigns & Send Pipeline - Pattern Map

**Mapped:** 2026-07-06
**Files analyzed:** 19 (per RESEARCH.md's Recommended Project Structure)
**Analogs found:** 17 / 19

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `packages/db/src/schema/campaigns.ts` | model | CRUD | `packages/db/src/schema/segments.ts` | exact |
| `packages/db/src/schema/campaign-recipients.ts` | model | batch | `packages/db/src/schema/suppressions.ts` (unique constraint shape) + Pattern 1 in RESEARCH.md | role-match |
| `packages/db/src/schema/sends.ts` | model | event-driven/CRUD | `packages/db/src/schema/suppressions.ts` | role-match |
| `packages/db/src/schema/workspace-send-settings.ts` | model | CRUD | `packages/db/src/schema/segments.ts` (simple workspace-scoped settings row) | role-match |
| `packages/shared-schemas/src/campaign.ts` | config (zod schemas) | request-response | `packages/shared-schemas/src/segment.ts` | exact |
| `packages/shared-schemas/src/queues.ts` (extend) | config | event-driven | itself, existing `eventsIngestJobSchema`/`importsCsvJobSchema` | exact |
| `apps/api/src/modules/campaigns/campaign.repository.ts` | service | CRUD | `apps/api/src/modules/segments/segment.repository.ts` | exact |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` | controller/route | request-response | `apps/api/src/modules/segments/segments.routes.ts` | exact |
| `apps/api/src/modules/campaigns/recipient-snapshot.ts` | service | batch | `apps/worker/src/queues/imports-csv.worker.ts` (cursor-batch loop) | role-match |
| `apps/api/src/modules/delivery/send-ledger.repository.ts` | service | CRUD | `apps/api/src/modules/segments/segment.repository.ts` (query shape) + `apps/worker/src/queues/imports-csv.worker.ts` (row-lock idempotency) | role-match |
| `apps/api/src/modules/delivery/unsubscribe-token.ts` | utility | transform | none (new HMAC crypto pattern; `node:crypto` only) | no analog |
| `apps/api/src/modules/delivery/unsubscribe.routes.ts` | route (public) | request-response | `apps/api/src/modules/tenancy/sendgrid-key.ts` (enumeration-oracle-safe GET route: any failure → same generic response) | role-match |
| `apps/api/src/modules/tenancy/sendgrid-client.ts` (extend: templates list + mail/send) | service | request-response | itself, `validateTenantSendGridKey` | exact |
| `apps/worker/src/queues/email-broadcast.worker.ts` | worker | event-driven | `apps/worker/src/queues/events-ingest.worker.ts` | exact |
| `apps/worker/src/queues/email-triggered.worker.ts` | worker | event-driven | `apps/worker/src/queues/events-ingest.worker.ts` | exact |
| `apps/worker/src/queues/campaign-scheduler.worker.ts` | worker | batch/event-driven | `apps/worker/src/queues/imports-csv.worker.ts` (self-healing scan/resume loop) | role-match |
| `apps/worker/src/queues/send-dispatch.ts` | service (shared) | event-driven | `apps/worker/src/queues/imports-csv.worker.ts` (row-level `FOR UPDATE` idempotency guard) | role-match |
| `apps/worker/src/queues/rate-limiter.ts` | utility | transform | none in codebase (new dependency `rate-limiter-flexible`); use RESEARCH.md Code Examples verbatim | no analog |
| `apps/web/src/features/campaigns/api.ts` | service (frontend) | request-response | `apps/web/src/features/segments/api.ts` | exact |

## Pattern Assignments

### `packages/db/src/schema/campaigns.ts` (model, CRUD)

**Analog:** `packages/db/src/schema/segments.ts`

**Full pattern** (lines 1-26):
```typescript
import { pgTable, text, timestamp, uuid, jsonb, integer } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

export const segments = pgTable("segments", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  definition: jsonb("definition").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  memberCount: integer("member_count"),
  memberCountAt: timestamp("member_count_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
```
Copy this shape for `campaigns`: `workspaceId` FK to `organization.id` with `onDelete: "cascade"`, `status` as `text` (draft/scheduled/sending/sent/canceled), `segmentId` FK to `segments.id` (RESTRICT, not cascade — D-14 delete-blocking), `templateId`, `fromSenderId`/`fromEmail`, `scheduledAt` (timestamptz), `sentCount`/`failedCount`/`totalCount` counters for D-10's progress. Every new table (`campaigns`, `campaign_recipients`, `sends`, `workspace_send_settings`) needs its own migration with `ENABLE + FORCE ROW LEVEL SECURITY` + `workspace_isolation` policy — check `packages/db/migrations/` for the exact Phase 1-3 RLS migration boilerplate to copy verbatim (grep `FORCE ROW LEVEL SECURITY` in that directory).

**Unique-constraint pattern for `campaign_recipients`/`sends`** — copy from `packages/db/src/schema/suppressions.ts` lines 11-23 (the `unique(...).on(t.workspaceId, t.email)` shape), replacing with `unique(...).on(t.campaignId, t.contactId)` for `campaign_recipients` and `sends`.

---

### `packages/shared-schemas/src/campaign.ts` (config, request-response)

**Analog:** `packages/shared-schemas/src/segment.ts` (not read in full this pass, but its consumption pattern is fully visible via `segments.routes.ts` imports: `createSegmentSchema`, `updateSegmentSchema`, `segmentListQuerySchema`, `segmentMembersQuerySchema`, `previewCountSchema` — all plain `z.object({...})` exports, each with an inferred `type X = z.infer<typeof xSchema>` alongside it). Mirror this exactly for `createCampaignSchema`, `updateCampaignSchema`, `campaignListQuerySchema`, `launchCampaignSchema`, `scheduleCampaignSchema`, `testSendCampaignSchema`.

**Queue job schema pattern** (analog: `packages/shared-schemas/src/queues.ts` lines 27-55):
```typescript
export const eventsIngestJobSchema = z.object({
  workspaceId: z.string().uuid(),
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  name: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  externalId: z.string().optional(),
  email: z.string().optional(),
});
export type EventsIngestJob = z.infer<typeof eventsIngestJobSchema>;
```
Copy this Pattern-2 discipline exactly for `emailBroadcastJobSchema`/`emailTriggeredJobSchema`: **always** include `workspaceId` (re-derived inside the worker, never ambient state — this is the single most load-bearing convention in the codebase for worker jobs) plus `campaignId`, `contactId`, and a `kind: "campaign" | "test"` discriminator (Pitfall 1 in RESEARCH.md — test sends still go through the queue, tagged `kind`). Queue name constants: dash-separated, not colon (`EMAIL_BROADCAST_QUEUE = "email-broadcast"`, `EMAIL_TRIGGERED_QUEUE = "email-triggered"`) — BullMQ rejects `:` in queue/job names, confirmed against `bullmq@5.79.1` in the existing comment at queues.ts lines 10-13.

---

### `apps/api/src/modules/campaigns/campaign.repository.ts` (service, CRUD)

**Analog:** `apps/api/src/modules/segments/segment.repository.ts`

**Imports pattern** (lines 1-3):
```typescript
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import { CONTACT_COLUMNS, type ContactRow } from "@mega-crm/contacts-core";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
```

**Core CRUD + column-alias pattern** (lines 17-28, 159-193):
```typescript
const SEGMENT_COLUMNS = `
  id,
  workspace_id as "workspaceId",
  name,
  definition,
  created_by_user_id as "createdByUserId",
  member_count as "memberCount",
  member_count_at as "memberCountAt",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export async function createSegment(input: CreateSegmentInput, opts?: { statementTimeoutMs?: number }): Promise<SegmentRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    // ... INSERT ... RETURNING ${SEGMENT_COLUMNS}
  });
}
```
Copy this exact `withTenantTransaction(async (client) => { const workspaceId = getWorkspaceId(); ... })` wrapper for every repository function — `getWorkspaceId()` is always called from inside the transaction callback, never passed as a parameter. Row-lock-before-mutate pattern for state transitions (analog: `updateSegment` lines 253-257 `SELECT ... FOR UPDATE` before computing the next state) — use this exact shape for the campaign state machine's `launchCampaign`/`cancelCampaign`/`scheduleCampaign` transitions to avoid races (D-08's "no in-place edit of scheduled" needs a locked read-check-write).

**Conflict-error class pattern** (lines 35-43):
```typescript
export class SegmentConflictError extends Error {
  constructor(message: string, public readonly code: "referenced_by_campaign" | "referenced_by_flow") {
    super(message);
    this.name = "SegmentConflictError";
  }
}
```
This is the EXACT reserved hook for D-14's "block segment delete when referenced by a campaign" — the class already exists with `"referenced_by_campaign"` as a valid code; the segment repository's `deleteSegment` (lines 290-299) needs a new pre-check query (`SELECT 1 FROM campaigns WHERE segment_id = $1 AND status != 'canceled'`) that throws this error instead of unconditionally deleting.

---

### `apps/api/src/modules/campaigns/campaigns.routes.ts` (controller, request-response)

**Analog:** `apps/api/src/modules/segments/segments.routes.ts`

**Imports + workspace-resolution pattern** (lines 1-25, 97-116):
```typescript
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auth } from "../auth/auth.js";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";

async function resolveWorkspaceMember(request: FastifyRequest, reply: FastifyReply, slug: string): Promise<ActiveWorkspace | null> {
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
Reuse `resolveWorkspaceMember` as-is for ordinary campaign CRUD (create/edit draft is ordinary-member level, matching segments/contacts). For launch/schedule/cancel — **role-gated** actions per D-19 — use `requirePermission("campaign", "launch")` from `role-guard.ts` as a Fastify `preHandler`, NOT `resolveWorkspaceMember` alone (see Shared Patterns below).

**Route registration + Zod validation pattern** (lines 143-172):
```typescript
fastify.post("/api/workspaces/:slug/segments", async (request, reply) => {
  const { slug } = request.params as { slug: string };
  const parsed = createSegmentSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }
  const workspace = await resolveWorkspaceMember(request, reply, slug);
  if (!workspace) return;
  const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
  if (!session) return reply.code(401).send({ error: "Not authenticated" });
  try {
    const created = await withTenant(workspace.id, () => createSegment({ ... }, { statementTimeoutMs: SAVE_EVAL_STATEMENT_TIMEOUT_MS }));
    return reply.code(201).send(toSegmentResponse(created));
  } catch (err) {
    if (isQueryCanceledError(err)) {
      return reply.code(400).send({ error: "..." });
    }
    throw err;
  }
});
```
Copy this exact validate → resolve workspace → session → `withTenant(workspace.id, () => repositoryCall())` → map-to-response → typed-error-catch sequence for every campaign route (create, update, launch, schedule, cancel, duplicate, test-send, progress, audience-breakdown).

**`isQueryCanceledError` guard** (lines 43-54) — reuse verbatim (postgres error code `57014`) for the recipient-snapshot materialization's `statement_timeout` (Pattern 1 in RESEARCH.md, 60s budget) and the audience-breakdown query, since both reuse `compileSegmentDefinition` and inherit the same DoS-timeout risk segments already guard against.

---

### `apps/worker/src/queues/email-broadcast.worker.ts` / `email-triggered.worker.ts` (worker, event-driven)

**Analog:** `apps/worker/src/queues/events-ingest.worker.ts`

**Full pattern** (lines 1-70):
```typescript
import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { EVENTS_INGEST_QUEUE, eventsIngestJobSchema, type EventsIngestJob } from "@mega-crm/shared-schemas";

export async function processEventIngestJob(data: EventsIngestJob): Promise<void> {
  const { workspaceId, eventId, occurredAt, name, properties, externalId, email } = eventsIngestJobSchema.parse(data);
  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      // ... upsert + insert with ON CONFLICT DO NOTHING
    })
  );
}

export function createEventsIngestWorker(connection: ConnectionOptions): Worker<EventsIngestJob> {
  return new Worker<EventsIngestJob>(
    EVENTS_INGEST_QUEUE,
    async (job: Job<EventsIngestJob>) => {
      await processEventIngestJob(job.data);
    },
    { connection }
  );
}
```
Copy this exact shape: (1) export the processor function standalone (not only inline in the Worker) so `send-dispatch-idempotency.test.ts` can invoke it directly without a live Redis round-trip — this is a hard testing-architecture convention in this codebase (see RESEARCH.md's Wave 0 Gaps test file list); (2) `.parse(data)` the job schema first thing inside the processor, never trust the raw `job.data` shape; (3) `withTenant(workspaceId, () => withTenantTransaction(...))` wrapping — `workspaceId` always re-derived from `job.data`, never ambient (Pitfall #5 in PITFALLS.md, called out explicitly in CONTEXT.md); (4) `createXWorker(connection: ConnectionOptions)` takes plain connection options, never a constructed `Redis` instance (nominal-type mismatch between BullMQ's bundled ioredis copy and the workspace's own — documented at lines 56-61 of the analog).

**Rate-limit + backoff wiring** — apply RESEARCH.md's Pattern 3 code example verbatim inside this Worker's processor (before the SendGrid call, consume the tenant token bucket; after a 429/5xx response, `await worker.rateLimit(ms); throw Worker.RateLimitError()`).

---

### `apps/worker/src/queues/campaign-scheduler.worker.ts` / `recipient-snapshot.ts` (worker/service, batch)

**Analog:** `apps/worker/src/queues/imports-csv.worker.ts`

**Cursor-batch loop pattern** (lines 63-135):
```typescript
let cursor = 0;
while (true) {
  const pendingRows = await withTenantTransaction(async (client) => {
    const { rows } = await client.query<StagedRow>(
      `SELECT id, row_number as "rowNumber", raw FROM csv_import_rows
       WHERE csv_import_id = $1 AND status = 'pending' AND row_number > $2
       ORDER BY row_number ASC LIMIT $3`,
      [csvImportId, cursor, PAGE_SIZE]
    );
    return rows;
  });
  if (pendingRows.length === 0) break;
  for (const row of pendingRows) {
    cursor = row.rowNumber;
    try {
      await withTenantTransaction(async (client) => {
        const { rows: lockedRows } = await client.query<{ status: string }>(
          `SELECT status FROM csv_import_rows WHERE id = $1 FOR UPDATE`, [row.id]
        );
        if (lockedRows[0]?.status !== "pending") return; // idempotency guard
        // ... process row
      });
    } catch (err) {
      // mark row error, never abort whole batch
    }
  }
}
```
This is the exact structural analog for RESEARCH.md's Pattern 1 (recipient snapshot materialization): replace `PAGE_SIZE`/`row_number` cursor with `SNAPSHOT_BATCH_SIZE`/`contacts.id` cursor, and the `FOR UPDATE` per-row idempotency check with the `ON CONFLICT (campaign_id, contact_id) DO NOTHING` batched insert RESEARCH.md's own Pattern 1 example already specifies. Also copy the "never let the job resolve while rows remain unresolved — throw so BullMQ retries the whole job" discipline (lines 163-174) for the scheduler's own due-campaign scan loop.

---

### `apps/api/src/modules/tenancy/sendgrid-client.ts` (extend: templates + mail/send)

**Analog:** itself (this exact file, extend in place)

**Existing raw-fetch convention** (lines 32-57):
```typescript
export async function validateTenantSendGridKey(apiKey: string): Promise<ValidateTenantSendGridKeyResult> {
  const scopesRes = await fetch("https://api.sendgrid.com/v3/scopes", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!scopesRes.ok) return { valid: false, reason: "invalid" };
  // ...
}
```
Add `listTenantSendGridTemplates(apiKey)` (GET `/v3/templates?generations=dynamic`, D-16 "refresh list" button, no caching per Don't-Hand-Roll table) and `sendTenantMailV3(apiKey, payload)` (POST `/v3/mail/send`, RESEARCH.md's Code Examples section has the exact request/response shape) in this SAME file, using this SAME raw-`fetch`-with-`Authorization: Bearer ${apiKey}` convention — **never** import `@sendgrid/mail`'s module-level `sgMail` singleton here (see Shared Patterns / Anti-pattern below).

---

### `apps/web/src/features/campaigns/api.ts` (frontend service, request-response)

**Analog:** `apps/web/src/features/segments/api.ts`

**Full pattern** (lines 1-58):
```typescript
import type { ContactListResponse, CreateSegmentInput, SegmentDefinition, SegmentListResponse, SegmentResponse, UpdateSegmentInput } from "@mega-crm/shared-schemas";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

export function listSegments(slug: string, params: { page?: number; pageSize?: number } = {}): Promise<SegmentListResponse> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return apiGet<SegmentListResponse>(`/api/workspaces/${slug}/segments${qs ? `?${qs}` : ""}`);
}

export function createSegment(slug: string, body: CreateSegmentInput): Promise<SegmentResponse> {
  return apiPost<SegmentResponse>(`/api/workspaces/${slug}/segments`, body);
}
```
Copy this exact per-endpoint thin-wrapper shape (`apiGet`/`apiPost`/`apiPatch`/`apiDelete` from `@/lib/api`, one exported function per route, query-string building via `URLSearchParams` when paginated) for `listCampaigns`, `createCampaign`, `getCampaign`, `launchCampaign`, `scheduleCampaign`, `cancelCampaign`, `duplicateCampaign`, `testSendCampaign`, `getCampaignProgress` (polling target — TanStack Query `refetchInterval` consumes this, per RESEARCH.md A4).

## Shared Patterns

### Tenant Context in Workers (CRITICAL — PITFALLS.md #5)
**Source:** `apps/worker/src/queues/events-ingest.worker.ts` lines 32-47, `apps/worker/src/queues/imports-csv.worker.ts` lines 47-48
**Apply to:** `email-broadcast.worker.ts`, `email-triggered.worker.ts`, `campaign-scheduler.worker.ts`, `send-dispatch.ts`
```typescript
await withTenant(workspaceId, () =>
  withTenantTransaction(async (client) => {
    // all queries here run with RLS's SET LOCAL app.tenant_id already applied
  })
);
```
`workspaceId` must always come from `job.data` (re-parsed via the job's Zod schema), never from any ambient/ ошибка cached value — every worker job in this codebase re-derives it fresh since the worker process never shares request-scoped state with the API process that enqueued the job.

### Role-Gated Routes (Owner/Admin-only actions)
**Source:** `apps/api/src/middleware/role-guard.ts` (full file, 64 lines) + `apps/api/src/modules/auth/access-control.ts` lines 21-31, 60-68
**Apply to:** `campaigns.routes.ts`'s launch/schedule/cancel/duplicate routes (D-19: Owner/Admin can launch, Member is draft-only)
```typescript
import { requirePermission } from "../../middleware/role-guard.js";
// ...
fastify.post(
  "/api/workspaces/:slug/campaigns/:id/launch",
  { preHandler: requirePermission("campaign", "launch") },
  async (request, reply) => { /* ... */ }
);
```
The `campaign: ["launch"]` permission already exists in `statement` (access-control.ts line 26) and is already granted to both `admin` and `owner` roles (lines 65-66, 76-77) and denied to `member` (line 45) — no access-control changes needed, only wiring the existing `requirePermission("campaign", "launch")` guard onto the new routes.

### Multi-Tenant SendGrid Dispatch — Never the Global Singleton
**Source:** `apps/api/src/modules/platform-mail/client.ts` lines 1-27 (what NOT to copy) vs. `apps/api/src/modules/tenancy/sendgrid-client.ts` lines 32-57 (what TO copy)
**Apply to:** `send-dispatch.ts`, `sendgrid-client.ts` extensions
```typescript
// WRONG (platform-mail's pattern — module-level singleton, single platform key only):
sgMail.setApiKey(env.PLATFORM_SENDGRID_API_KEY); // module scope, mutates shared state
await sgMail.send({ to, from, subject, html });

// RIGHT (sendgrid-client.ts's pattern — per-call, tenant-scoped):
const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
  method: "POST",
  headers: { Authorization: `Bearer ${decryptedTenantApiKey}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```
This is the single highest-severity pitfall this phase's RESEARCH.md identifies (Pitfall 2): `@sendgrid/mail`'s `setApiKey()` is module-global — using it for a tenant's decrypted key would let concurrent dispatch jobs for different tenants race and send under the wrong tenant's reputation. `platform-mail/client.ts` is correct for its OWN narrow purpose (one platform key, module scope is fine) — it is explicitly NOT a template to copy for tenant dispatch.

### RLS on New Tables
**Source:** existing `packages/db/migrations/*.sql` (Phase 1-3 precedent, referenced but not individually re-read this pass — grep `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` in `packages/db/migrations/` for the exact boilerplate)
**Apply to:** `campaigns`, `campaign_recipients`, `sends`, `workspace_send_settings` migrations
Every new table gets `ALTER TABLE x ENABLE ROW LEVEL SECURITY; ALTER TABLE x FORCE ROW LEVEL SECURITY;` plus a `workspace_isolation` policy scoped on `workspace_id = current_setting('app.tenant_id')::uuid` (or equivalent), no exceptions — this is called out explicitly in RESEARCH.md's Security Domain section and CONTEXT.md's discretion list.

### Error-Shape Consistency (400 on validation, 404 on cross-tenant/not-found, enumeration-oracle-safe)
**Source:** `apps/api/src/modules/segments/segments.routes.ts` lines 97-116 (workspace resolution → uniform 404) + `apps/api/src/modules/tenancy/sendgrid-key.ts` (referenced in RESEARCH.md's threat-pattern table: "any failure maps to the same 404")
**Apply to:** `unsubscribe.routes.ts` (public surface — invalid signature vs. unknown contact must return the identical generic response, per RESEARCH.md's Information-Disclosure mitigation), and every campaign route's workspace/permission resolution.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `apps/api/src/modules/delivery/unsubscribe-token.ts` | utility | transform | No existing HMAC-signing code in the codebase; RESEARCH.md's Code Examples section (RFC 8058 / token payload: `sendId` + `contactId` + `workspaceId` + `exp`, HMAC-SHA256 via `node:crypto`'s `createHmac`) is the authoritative reference to implement directly — no codebase pattern to extend. |
| `apps/worker/src/queues/rate-limiter.ts` | utility | transform | `rate-limiter-flexible` is a brand-new dependency this phase (flagged `[SUS]`/needs `checkpoint:human-verify` per RESEARCH.md's Package Legitimacy Audit); RESEARCH.md's own Code Examples section (`RateLimiterRedis` factory, dedicated `ioredis` client separate from BullMQ's internal connection) is the reference implementation — no prior codebase usage to copy. |

## Metadata

**Analog search scope:** `apps/api/src/modules/{segments,tenancy,auth}`, `apps/api/src/middleware`, `apps/worker/src/queues`, `packages/db/src/schema`, `packages/shared-schemas/src`, `apps/web/src/features/segments`
**Files scanned:** 15 read in full + directory listings across `apps/api`, `apps/worker`, `packages/db`, `packages/shared-schemas`, `apps/web`
**Pattern extraction date:** 2026-07-06
