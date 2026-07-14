# Phase 5: Webhook Processing & Delivery Tracking - Pattern Map

**Mapped:** 2026-07-08
**Files analyzed:** 15
**Analogs found:** 15 / 15

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|---------------|
| `apps/api/src/modules/webhooks/webhooks.routes.ts` | route | request-response (raw-body, unauthenticated) | `apps/api/src/modules/delivery/unsubscribe.routes.ts` | exact |
| `apps/api/src/modules/webhooks/signature-verify.ts` | utility | transform | `packages/delivery-core/src/unsubscribe-token.ts` (HMAC verify, same "pure verify function" shape) | role-match |
| `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts` | model/repository | CRUD | `apps/api/src/modules/tenancy/sendgrid-key.repository.ts` (not read directly but same repo family as `sendgrid-key.ts`/`getKey`/`upsertKey`) | role-match |
| `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` | service | request-response (outbound REST) | `apps/api/src/modules/tenancy/sendgrid-client.ts` | exact |
| `apps/api/src/modules/tenancy/sendgrid-key.ts` (extended: trigger provisioning on connect) | route/service | request-response | itself (existing file, extend in place) | exact |
| `packages/db/src/schema/send-events.ts` | model (type-inference only) | streaming/batch | `packages/db/src/schema/events.ts` | exact |
| `packages/db/src/schema/webhook-endpoints.ts` | model | CRUD | `packages/db/src/schema/suppressions.ts` (small tenant-scoped config table) | role-match |
| `packages/db/src/schema/sends.ts` (extend: delivery fact columns) | model | CRUD | itself (existing file, extend in place) | exact |
| `packages/db/migrations/NNNN_send_events_partitioned.sql` | migration | batch | `packages/db/migrations/0007_events_partitioned.sql` + `0010_events_workspace_scoped_pk.sql` | exact |
| `packages/db/migrations/NNNN_webhook_endpoints.sql` | migration | CRUD | `packages/db/migrations/0007_events_partitioned.sql` (RLS section only) | role-match |
| `packages/db/migrations/NNNN_sends_delivery_columns.sql` | migration | CRUD | same RLS/ALTER TABLE precedent as above | role-match |
| `apps/worker/src/queues/webhook-events.worker.ts` | worker/controller | event-driven, batch | `apps/worker/src/queues/events-ingest.worker.ts` | exact |
| `packages/delivery-core/src/send-status.ts` | utility | transform | `packages/delivery-core/src/send-mail.ts` (pure builder function style) | partial |
| `packages/delivery-core/src/suppression-rules.ts` | utility | transform | `packages/delivery-core/src/send-mail.ts` (pure builder/lookup function style) | partial |
| `packages/delivery-core/src/send-mail.ts` (extend: custom_args.test + tracking_settings.open/click) | service | request-response | itself (existing file, extend in place) | exact |

## Pattern Assignments

### `apps/api/src/modules/webhooks/webhooks.routes.ts` (route, request-response, no session)

**Analog:** `apps/api/src/modules/delivery/unsubscribe.routes.ts`

**Imports pattern** (lines 1-3):
```typescript
import type { FastifyInstance } from "fastify";
import { verifyUnsubscribeToken } from "@mega-crm/delivery-core";
import { withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";
```
For the webhook route, swap `verifyUnsubscribeToken` for `@sendgrid/eventwebhook`'s `EventWebhook`, and add the repository lookup import (`findWebhookEndpointByToken`).

**Raw-body content-type parser override — scoped to this route module only** (lines 131-154, `unsubscribe.routes.ts`):
```typescript
export async function registerUnsubscribeRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer", bodyLimit: 1024 },
    (_request, _payload, done) => {
      done(null, undefined);
    }
  );
  // ... routes registered on the same fastify instance below
}
```
Copy this exact `addContentTypeParser` placement (inside a plain `async function`, NOT `fastify-plugin`) — Fastify's plugin encapsulation scopes the override to only this route's prefix. For the webhook route, override `application/json` with `{ parseAs: "buffer" }` and pass the raw `Buffer` straight through via `done(null, body)` (per RESEARCH.md Code Examples "Raw-body signature verification route").

**No-session, no-auth public surface — top-level registration comment convention** (lines 116-130):
```typescript
/**
 * Public RFC 8058 one-click unsubscribe surface (SUBS-04, D-15). Registered
 * top-level (no session, no workspace `:slug` prefix, no auth preHandler) --
 * ...
 * Threat model (...):
 * - GET never verifies the token and never mutates ...
 * - POST verifies the HMAC signature + expiry; ANY failure ... fall through
 *   the exact same code path with no branching ...
 */
```
Mirror this doc-comment style for the webhook route: document the threat model (unknown pathToken → generic 404 before signature check; invalid signature → 400, no enqueue).

**Tenant-scoped mutation pattern** (lines 189-197):
```typescript
await withTenant(payload.workspaceId, () =>
  withTenantTransaction(async (client) => {
    await client.query(
      `UPDATE contacts SET subscription_status = 'unsubscribed', updated_at = now() WHERE id = $1`,
      [payload.contactId]
    );
  })
);
```
Not used directly in the route (verification-only + enqueue, per RESEARCH.md Pattern 2 "ack-fast") — but this is the shape the **worker** will reuse for the actual DB writes (see below). The route itself does no `withTenant`/DB write; it only does the pathToken lookup (`findWebhookEndpointByToken`, a narrow SELECT-only path with no tenant context — same rationale as Phase 2's `workspace_api_keys` runtime lookup) + signature verify + `queue.add()`.

---

### `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` (service, request-response outbound)

**Analog:** `apps/api/src/modules/tenancy/sendgrid-client.ts`

**Imports / module doc-comment pattern** (lines 1-11):
```typescript
/**
 * Tenant SendGrid client (D-21, RESEARCH.md "SendGrid key validation at
 * connect time"): validates a tenant's BYO key by reading a
 * per-request-decrypted key argument. Structurally separate from
 * `platform-mail/client.ts` (RESEARCH.md Pitfall 4 -- two-key discipline):
 * this module never imports platform-mail, reads no env var directly (the
 * key is always passed in, already decrypted by the caller) ...
 */
```
Copy this two-key-discipline doc-comment convention verbatim for the new provisioning module — it must state explicitly that it never imports `platform-mail` and always receives an already-decrypted `apiKey` argument.

**Raw-fetch-with-Bearer-key core pattern** (lines 43-68, `validateTenantSendGridKey`):
```typescript
export async function validateTenantSendGridKey(apiKey: string): Promise<ValidateTenantSendGridKeyResult> {
  const scopesRes = await fetch("https://api.sendgrid.com/v3/scopes", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!scopesRes.ok) {
    return { valid: false, reason: "invalid" };
  }
  const { scopes } = (await scopesRes.json()) as SendGridScopesResponse;
  if (!scopes.includes("mail.send")) {
    return { valid: false, reason: "missing_scope" };
  }
  // ...
}
```
Copy this exact `fetch` + `Authorization: Bearer` + typed-response-interface shape for `createWebhook`/`enableSignedVerification`/`patchWebhook` — see RESEARCH.md Code Examples "SendGrid webhook auto-provisioning" for the exact target function bodies to write against this pattern.

**Second reusable function shape** (lines 80-96, `listTenantSendGridTemplates`): same raw-fetch convention, `?generations=dynamic&page_size=200` query-string style — reuse for `GET /v3/user/webhooks/event/settings/all` (list existing, needed for Pitfall #4's "don't re-POST" reconnect guard).

---

### `apps/api/src/modules/tenancy/sendgrid-key.ts` (extend: trigger provisioning on connect/recheck)

**Analog:** itself (existing file — extend the `POST .../sendgrid-key` and `POST .../sendgrid-key/recheck` handlers)

**Imports pattern** (lines 1-11):
```typescript
import type { FastifyInstance } from "fastify";
import { connectSendgridKeySchema } from "@mega-crm/shared-schemas";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { requireVerifiedEmail } from "../auth/verification-gate.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { encryptTenantSecret, decryptTenantSecret } from "@mega-crm/kms";
import { validateTenantSendGridKey } from "./sendgrid-client.js";
import { getKey, upsertKey, updateKeyStatus } from "./sendgrid-key.repository.js";
import { findActiveWorkspaceBySlug } from "./workspace-lookup.js";
import { getCallerRoles } from "./member-roles.js";
```
Add `provisionEventWebhook` from the new `sendgrid-webhook-provision.ts` to this import block.

**Role-gate + verified-email-gate + live-validate + encrypt + store pipeline** (lines 70-112, POST connect handler):
```typescript
fastify.post(
  "/api/workspaces/:slug/sendgrid-key",
  { preHandler: [requirePermission("sendgridKey", "update"), requireVerifiedEmail] },
  async (request, reply) => {
    // ... validate parsed body, look up workspace, validateTenantSendGridKey ...
    const encrypted = await encryptTenantSecret(workspace.id, parsed.data.apiKey);
    const keyMask = maskKey(parsed.data.apiKey);
    await withTenant(workspace.id, () => upsertKey({ ... }));
    return reply.send({ connected: true, keyMask, status: "active", verifiedSenders: validation.verifiedSenders });
  }
);
```
D-01/D-02: after the existing `upsertKey` call succeeds, add a **best-effort, non-blocking** call to `provisionEventWebhook(parsed.data.apiKey, callbackUrl, existingWebhookId)` inside the same `withTenant` block, writing the returned `{ id, publicKey }` + generated `pathToken` into the new `webhook_endpoints` repository — mirror the graceful-error convention already used for `errorCopyFor(reason)` (lines 12-19) for the "insufficient scope" / "plan cap reached" failure messages (Pitfall #4).

---

### `packages/db/src/schema/send-events.ts` (model, type-inference only, batch/streaming)

**Analog:** `packages/db/src/schema/events.ts`

**Full file is the template** (lines 1-37):
```typescript
import { pgTable, text, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { contacts } from "./contacts.js";

/**
 * Logical/type-inference shape ONLY (...). Drizzle's `pgTable` cannot
 * express `PARTITION BY RANGE (occurred_at)` or a composite primary key
 * that includes the partition key column ... the physical partitioned
 * table, its monthly partitions, indexes, and RLS policy are created by
 * HAND-WRITTEN migrations (...), NOT by `drizzle-kit generate` against this
 * file. This file exists purely so application code ... gets typed query
 * results via Drizzle's schema inference.
 */
export const events = pgTable("events", {
  id: uuid("id").notNull(),
  workspaceId: uuid("workspace_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  properties: jsonb("properties").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});
```
For `send_events`, copy this exact doc-comment ("logical/type-inference shape ONLY... hand-written migrations own the DDL") and add columns: `sgEventId: text("sg_event_id").notNull()`, `sendId: uuid("send_id").references(() => sends.id, { onDelete: "cascade" })` (nullable per D-15 orphan case), `eventType: text("event_type").notNull()`, `reason: text("reason")`, `occurredAt`, `payload: jsonb("payload")`, `isTest: boolean("is_test").notNull().default(false)`.

---

### `packages/db/migrations/NNNN_send_events_partitioned.sql` (migration, batch)

**Analog:** `packages/db/migrations/0007_events_partitioned.sql` + `0010_events_workspace_scoped_pk.sql`

**Full DDL shape to copy** (0007, lines 19-56):
```sql
CREATE TABLE events (
  id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE events_2026_07 PARTITION OF events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE events_2026_08 PARTITION OF events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE INDEX idx_events_workspace_contact_time ON events (workspace_id, contact_id, occurred_at);
CREATE INDEX idx_events_workspace_name_time ON events (workspace_id, name, occurred_at);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON events
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
```
For `send_events`: use `PRIMARY KEY (workspace_id, id, occurred_at)` **from the start** (skip 0007's mistake fixed in 0010 — go straight to the workspace-scoped composite PK per CR-01's lesson), add a `UNIQUE (workspace_id, sg_event_id)` constraint (this is WBHK-03's actual dedup mechanism, distinct from the PK), and include a `CREATE TABLE send_events_default PARTITION OF send_events DEFAULT;` catch-all from day one (CR-03's lesson from 0010 — don't wait for a second migration to add it).

**0010's DEFAULT partition addendum** (lines 26-36) — apply immediately in the first migration rather than as a follow-up:
```sql
CREATE TABLE events_default PARTITION OF events DEFAULT;
```

---

### `apps/worker/src/queues/webhook-events.worker.ts` (worker, event-driven batch)

**Analog:** `apps/worker/src/queues/events-ingest.worker.ts`

**Full processor + Worker-construction shape** (lines 1-70, entire file):
```typescript
import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { upsertContactByIdentity } from "@mega-crm/contacts-core";
import { EVENTS_INGEST_QUEUE, eventsIngestJobSchema, type EventsIngestJob } from "@mega-crm/shared-schemas";

export async function processEventIngestJob(data: EventsIngestJob): Promise<void> {
  const { workspaceId, eventId, occurredAt, name, properties, externalId, email } =
    eventsIngestJobSchema.parse(data);

  await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { contactId } = await upsertContactByIdentity(client, workspaceId, { externalId, email, properties });
      await client.query(
        `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (workspace_id, id, occurred_at) DO NOTHING`,
        [eventId, workspaceId, contactId, name, properties, occurredAt]
      );
    })
  );
}

export function createEventsIngestWorker(connection: ConnectionOptions): Worker<EventsIngestJob> {
  return new Worker<EventsIngestJob>(
    EVENTS_INGEST_QUEUE,
    async (job: Job<EventsIngestJob>) => { await processEventIngestJob(job.data); },
    { connection }
  );
}
```
For `webhook-events.worker.ts`: same shape, but the INSERT becomes a **multi-row batch INSERT with `ON CONFLICT (workspace_id, sg_event_id) DO NOTHING RETURNING *`** (per RESEARCH.md Pattern 3), and after the insert, iterate only the `RETURNING`-ed rows to apply fact-column updates (`sends` table) + suppression writes (`contacts` + `workspace_suppressions`), all inside the SAME `withTenantTransaction`. Export `processWebhookEventBatch` standalone (not only inside the Worker callback) exactly as `processEventIngestJob` is exported standalone — so `webhook-events-idempotency.test.ts` can call it directly without a live Redis round-trip (this doc-comment rationale, lines 24-27, should be copied verbatim).

**BullMQ Worker connection-options convention** (`connection.ts`, full file lines 1-28): reuse `buildRedisConnectionOptions`/`createRedisConnection` as-is — no new connection-handling code needed for the new queue.

---

### `packages/delivery-core/src/send-mail.ts` (extend: force tracking + test marker)

**Analog:** itself (existing file)

**Current shape to extend** (lines 7-64):
```typescript
export interface SendGridMailSendRequest {
  personalizations: Array<{
    to: [{ email: string }];
    dynamic_template_data: Record<string, unknown>;
    custom_args: { send_id: string; workspace_id: string; campaign_id: string };
  }>;
  from: { email: string };
  template_id: string;
  headers: { "List-Unsubscribe": string; "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"; };
  tracking_settings: {
    subscription_tracking: { enable: false };
  };
}

export function buildMailSendRequest(params: BuildMailSendRequestParams): SendGridMailSendRequest {
  return {
    personalizations: [{
      to: [{ email: params.to }],
      dynamic_template_data: params.dynamicTemplateData,
      custom_args: { send_id: params.sendId, workspace_id: params.workspaceId, campaign_id: params.campaignId },
    }],
    from: { email: params.fromEmail },
    template_id: params.templateId,
    headers: { "List-Unsubscribe": `<${params.listUnsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    tracking_settings: { subscription_tracking: { enable: false } },
  };
}
```
**D-04 fix (Pitfall #3):** add `open_tracking: { enable: true }` and `click_tracking: { enable: true }` to `tracking_settings` unconditionally.
**D-15/Pitfall #2 fix:** add optional `isTest?: boolean` to `BuildMailSendRequestParams`, and when true, add a 4th string-valued custom_arg: `custom_args: { ..., test: "true" }` (widen the `custom_args` type to `Record<string, string>` or an explicit optional `test?: "true"` field). Both call sites in `send-dispatch.ts` (`kind === "campaign"` branch line ~312, `kind === "test"` branch line ~401) need the corresponding `isTest` flag passed through — the test branch (line 353 onward) is the one that must set it `true`.

---

### `packages/delivery-core/src/suppression-rules.ts` / `send-status.ts` (new pure utility modules)

**Analog:** `packages/delivery-core/src/send-mail.ts` (pure-function-plus-interface module style — no analog for a lookup-table module exists yet in this codebase, so RESEARCH.md's own Code Examples are the primary source, not a codebase file)

**Style to copy:** small, fully-typed exported interfaces + a single pure function per concern (`buildMailSendRequest` pattern) — no classes, no side effects, unit-testable without DB/network. Use RESEARCH.md's `normalizeEventType`/`resolveSuppression` code blocks directly (Code Examples section, "Event type normalization" and "Suppression rule table") as the literal starting implementation — these were already written against this project's conventions in the research phase.

---

## Shared Patterns

### Tenant context in worker (mandatory)
**Source:** `packages/tenant-context/src/index.ts` (`withTenant`, `withTenantTransaction`, lines 37-95) + `apps/worker/src/queues/events-ingest.worker.ts` (lines 32-47)
**Apply to:** `webhook-events.worker.ts`'s entire processing function — every DB write must be inside `withTenant(workspaceId, () => withTenantTransaction(async (client) => { ... }))`, re-deriving `workspaceId` from `job.data`, never ambient state (PITFALLS #5).
```typescript
await withTenant(workspaceId, () =>
  withTenantTransaction(async (client) => {
    // batch insert + fact-column updates + suppression writes, ALL in one transaction
  })
);
```

### RLS migration triplet
**Source:** `packages/db/migrations/0007_events_partitioned.sql` (lines 44-56)
**Apply to:** every new table migration (`send_events`, `webhook_endpoints`, and the `sends` ALTER doesn't need this since it's an existing RLS'd table)
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON <table>
  USING (workspace_id = current_setting('app.current_workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.current_workspace_id', true)::uuid);
```

### Raw-body content-type parser override, scoped per-route-module
**Source:** `apps/api/src/modules/delivery/unsubscribe.routes.ts` (lines 131-154)
**Apply to:** `webhooks.routes.ts` — register `addContentTypeParser` for `application/json` with `{ parseAs: "buffer" }` inside the plain async `registerWebhookRoutes` function (never `fastify-plugin`, never in `server.ts` globally).

### Idempotent dedup insert with RETURNING gating side effects
**Source:** `apps/worker/src/queues/events-ingest.worker.ts` (lines 40-45) — `ON CONFLICT (workspace_id, id, occurred_at) DO NOTHING`
**Apply to:** `webhook-events.worker.ts`'s batch insert into `send_events`, extended to also `RETURNING *` and iterate only returned rows (research Pattern 3) — this codebase's existing precedent uses plain `DO NOTHING` without `RETURNING` since there are no side effects beyond the insert itself for events-ingest; the webhook worker is the first case needing the `RETURNING`-gated side-effect pattern, so follow RESEARCH.md's Code Examples/Pattern 3 exactly.

### Fastify plugin registration / role-gate + verified-email-gate ordering
**Source:** `apps/api/src/modules/tenancy/sendgrid-key.ts` (lines 71-74, `preHandler: [requirePermission(...), requireVerifiedEmail]`)
**Apply to:** any NEW authenticated route this phase adds (e.g., "reconnect webhook" button endpoint, webhook health-status GET) — reuse `requirePermission`/`requireVerifiedEmail` preHandler ordering and the `findActiveWorkspaceBySlug` + `getCallerRoles` try/catch-to-404 anti-enumeration pattern (lines 44-56).

### Envelope encryption is for secrets only — do NOT apply to the public verification key
**Source:** `apps/api/src/modules/tenancy/sendgrid-key.ts` (`encryptTenantSecret`/`decryptTenantSecret` from `@mega-crm/kms`, lines 6, 91, 130-136)
**Apply to:** `webhook_endpoints.publicKey` column — store as plain `text`, NOT via `encryptTenantSecret` (RESEARCH.md Pattern 1 / Assumption A1). Only the SendGrid API key itself (already encrypted, unaffected by this phase) uses the KMS envelope pattern.

## No Analog Found

None — every new file in this phase has at least a role-match analog already present in the codebase (Phase 2 events/partitioning precedent, Phase 4 sends/send-dispatch precedent, Phase 4 unsubscribe public-route precedent, Phase 1/4 sendgrid-client precedent).

## Metadata

**Analog search scope:** `apps/api/src/modules/{tenancy,delivery}`, `apps/worker/src/queues`, `packages/db/src/schema`, `packages/db/migrations`, `packages/delivery-core/src`, `packages/tenant-context/src`
**Files scanned:** 15 read in full + 2 migrations + line-count survey of 11 candidate files
**Pattern extraction date:** 2026-07-08
