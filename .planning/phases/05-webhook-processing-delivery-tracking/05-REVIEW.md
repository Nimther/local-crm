---
phase: 05-webhook-processing-delivery-tracking
reviewed: 2026-07-09T06:43:37Z
depth: standard
files_reviewed: 52
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/modules/campaigns/__tests__/campaign-delivery-counters.test.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts
  - apps/api/src/modules/tenancy/sendgrid-key.ts
  - apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts
  - apps/api/src/modules/webhooks/enqueue.ts
  - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
  - apps/api/src/modules/webhooks/signature-verify.ts
  - apps/api/src/modules/webhooks/webhook-endpoint.repository.ts
  - apps/api/src/modules/webhooks/webhook-settings.routes.ts
  - apps/api/src/modules/webhooks/webhooks.routes.ts
  - apps/api/src/server.ts
  - apps/web/src/features/campaigns/CampaignDetailPage.tsx
  - apps/web/src/features/campaigns/CampaignProgress.tsx
  - apps/web/src/features/campaigns/api.ts
  - apps/web/src/features/onboarding/OnboardingChecklist.tsx
  - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx
  - apps/web/src/features/webhooks/webhook-health.api.ts
  - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-status.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/server.ts
  - packages/db/migrations/0020_send_events_partitioned.sql
  - packages/db/migrations/0021_webhook_endpoints.sql
  - packages/db/migrations/0022_sends_delivery_columns.sql
  - packages/db/migrations/0023_contacts_soft_bounce_streak.sql
  - packages/db/migrations/0024_campaigns_delivery_counters.sql
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/index.ts
  - packages/db/src/schema/campaigns.ts
  - packages/db/src/schema/contacts.ts
  - packages/db/src/schema/send-events.ts
  - packages/db/src/schema/sends.ts
  - packages/db/src/schema/webhook-endpoints.ts
  - packages/delivery-core/src/__tests__/event-normalize.test.ts
  - packages/delivery-core/src/__tests__/send-mail.test.ts
  - packages/delivery-core/src/__tests__/send-status.test.ts
  - packages/delivery-core/src/__tests__/suppression-rules.test.ts
  - packages/delivery-core/src/event-normalize.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/send-mail.ts
  - packages/delivery-core/src/send-status.ts
  - packages/delivery-core/src/suppression-rules.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
  - packages/shared-schemas/src/webhook.ts
findings:
  critical: 0
  warning: 4
  info: 5
  total: 9
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-07-09T06:43:37Z
**Depth:** standard
**Files Reviewed:** 52
**Status:** issues_found

## Summary

Fresh post-gap-closure review of the full Phase 5 scope (webhook processing + delivery tracking). All three prior findings are verified fixed in source and covered by tests:

- **Prior CR-01 (cross-workspace webhook adoption): FIXED.** `sendgrid-webhook-provision.ts` now scopes `friendly_name` per workspace (`webhookFriendlyName`, lines 25-27), and the reuse-by-name path PATCHes a stale URL back to the caller's `callbackUrl` before returning active (lines 152-160). Both behaviors are asserted in `webhook-provisioning.test.ts` ("reuse-by-name with a stale url", "a different workspace does not adopt a sibling's webhook").
- **Prior WR-01 (wall-clock `occurred_at` fallback defeating dedup): FIXED.** `extractEventRow` now skips events with a missing/non-numeric `timestamp` (webhook-events.worker.ts:61-67), asserted by the "redelivered event with a missing/invalid timestamp does not double-insert or double-count" test.
- **Prior WR-02 (out-of-range timestamp crashing the batch): FIXED.** Bounds check against `MAX_DATE_TIME_VALUE_MS` (webhook-events.worker.ts:29, 61-64), asserted by the "out-of-range numeric timestamp ... does not fail the rest of the batch" test.

The core pipeline is sound: raw-body capture before ECDSA verification (no JSON parser touches the webhook route), fail-closed 400 on bad signatures, whole-batch enqueue, `ON CONFLICT ... DO NOTHING RETURNING` dedup with first-write-wins fact columns and exactly-once counters, and all side effects in one tenant-scoped transaction. RLS coverage (including the `webhook_endpoint_runtime_lookup` SELECT-only policy and the NULLIF guard on the dual-policy table) is correct. Concurrent-worker safety of `setFactColumnOnce` holds under READ COMMITTED (a blocked UPDATE re-evaluates `WHERE <col> IS NULL` after the winner commits).

Four warnings remain, all in the provisioning/settings periphery rather than the event-processing core: an unrecoverable stale-webhook-id wedge in reconnect, a non-atomic per-workspace endpoint upsert with no DB uniqueness backstop, server-crafted `webhookWarning` copy silently dropped by the web UI, and no rate limiting on the unauthenticated public receiver.

## Structural Findings (fallow)

_No structural pre-pass was provided for this review._

## Narrative Findings (AI reviewer)

## Warnings

### WR-01: Stale `sendgridWebhookId` permanently wedges provisioning — PATCH 404 never falls back to create

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:189-210, 246-248` (and callers `webhook-settings.routes.ts:89-104`, `sendgrid-key.ts:56-70`)
**Issue:** When a stored `sendgridWebhookId` exists, `provisionEventWebhook` goes straight to `patchWebhook`. If the tenant deleted the platform's webhook in the SendGrid UI (or the id is otherwise stale), the PATCH returns 404, which `errorForStatus` maps to `"failed"`. Both callers' error branches then re-persist the SAME stale id (`sendgridWebhookId: existing?.sendgridWebhookId ?? null`), so every subsequent connect/recheck/reconnect retries the identical dead PATCH forever. The "Переподключить" button — the designated D-02 recovery path — can never recover; delivery tracking stays `provisionStatus: 'error'` until someone manually clears the DB row. The list-and-reuse/create logic that would self-heal this exists in `createWebhook` but is unreachable once an id is stored.
**Fix:** In `provisionEventWebhook`, when `patchWebhook(existingWebhookId, ...)` fails specifically with a 404 (webhook no longer exists), fall back to `createWebhook(apiKey, callbackUrl, workspaceId)` instead of returning `{ error: "failed" }`:

```ts
// have patchWebhook expose the failing status:
const patched = await patchWebhookWithStatus(apiKey, existingWebhookId, callbackUrl, workspaceId);
const webhookResult =
  "error" in patched && patched.status === 404
    ? await createWebhook(apiKey, callbackUrl, workspaceId) // stale id: recreate/reuse-by-name
    : patched;
```

Alternatively, have the callers clear `sendgridWebhookId` (persist `null`) when provisioning fails so the next attempt takes the create/reuse-by-name path.

### WR-02: `upsertWebhookEndpoint` SELECT-then-branch race with no `UNIQUE(workspace_id)` backstop

**File:** `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts:98-129` (constraint gap in `packages/db/migrations/0021_webhook_endpoints.sql:6-17`)
**Issue:** The doc-comment asserts provisioning is "only ever triggered synchronously from a single connect/recheck HTTP request for a given workspace, never concurrently" — but nothing enforces that. `POST /sendgrid-key`, `POST /sendgrid-key/recheck`, and `POST /webhook-reconnect` are three independent routes; two Owner/Admin requests (two tabs, a double-click racing a recheck) can interleave the `SELECT id ...` / `INSERT` window and create two rows for one workspace (only `path_token` is unique, not `workspace_id`). Once duplicated: `getWebhookEndpointByWorkspace` returns an arbitrary row, and the next `UPDATE ... WHERE workspace_id = $1` attempts to set BOTH rows to the same `path_token`, violating `workspace_webhook_endpoints_path_token_unique` and failing every subsequent connect/recheck/reconnect for that workspace — a wedged state requiring manual DB repair.
**Fix:** Add a migration with `ALTER TABLE workspace_webhook_endpoints ADD CONSTRAINT workspace_webhook_endpoints_workspace_unique UNIQUE (workspace_id);` and replace the SELECT-then-branch with an atomic upsert:

```sql
INSERT INTO workspace_webhook_endpoints (workspace_id, path_token, sendgrid_webhook_id, public_key, provision_status)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (workspace_id) DO UPDATE
  SET path_token = EXCLUDED.path_token,
      sendgrid_webhook_id = EXCLUDED.sendgrid_webhook_id,
      public_key = EXCLUDED.public_key,
      provision_status = EXCLUDED.provision_status,
      updated_at = now()
```

### WR-03: Server-built `webhookWarning` is silently dropped by the web UI

**File:** `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx:27-32, 165-192` (source of the field: `apps/api/src/modules/tenancy/sendgrid-key.ts:23-28, 173-179, 226-232`)
**Issue:** The connect/recheck routes deliberately return a user-facing `webhookWarning` string ("ключ подключён, но у него нет прав на управление вебхуками...", cap-reached, generic-failure variants) so the marketer knows delivery tracking was NOT set up despite a successful key connect. The web client's `KeyMutationResponse` interface omits the field, and both mutations' `onSuccess` handlers show an unconditional success toast ("SendGrid подключён"). `grep webhookWarning apps/web` confirms zero consumers. Result: a tenant whose key lacks webhook scopes sees pure success, and the only clue is a passive "pending/error" badge elsewhere — the exact confusion the three warning strings were written to prevent.
**Fix:** Add `webhookWarning?: string` to `KeyMutationResponse` and surface it in both `onSuccess` handlers:

```ts
onSuccess: (data) => {
  // ...
  if (data.webhookWarning) {
    toast.warning(data.webhookWarning);
  } else {
    toast.success("SendGrid подключён");
  }
}
```

### WR-04: Public webhook receiver has no rate limiting despite doing per-request DB work

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:46-84` (limiter registered `global: false` in `apps/api/src/server.ts:47`)
**Issue:** `POST /webhooks/sendgrid/:pathToken` is unauthenticated and reachable by anyone. Every request — including one with a garbage token — performs a dedicated pool checkout plus four Postgres round-trips (`BEGIN`, `set_config`, `SELECT`, `COMMIT`) in `findWebhookEndpointByToken` before any rejection. `@fastify/rate-limit` is registered with `global: false` and this route never opts in, so an attacker can cheaply pressure the API's DB pool (starving authenticated routes sharing it) by hammering the endpoint. CLAUDE.md explicitly lists `@fastify/rate-limit` as the mitigation for ingestion-endpoint abuse.
**Fix:** Opt the route into a per-IP limit generous enough for genuine SendGrid burst delivery (SendGrid posts batches, not per-event):

```ts
fastify.post(
  "/webhooks/sendgrid/:pathToken",
  { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
  async (request, reply) => { /* ... */ }
);
```

Consider additionally caching negative token lookups (or an in-memory LRU of known tokens) so repeated unknown-token probes skip the transaction entirely.

## Info

### IN-01: `deriveCurrentStatus` is exported and tested but has no consumer

**File:** `packages/delivery-core/src/send-status.ts:30-38` (export: `packages/delivery-core/src/index.ts:56`)
**Issue:** `grep` across `apps/` and `packages/` finds no caller outside the module and its own test — the D-06 read-time helper ships as dead code this phase (presumably awaiting the per-send log UI). Unused exports rot: the priority rule can drift from what the eventual consumer needs without any integration signal.
**Fix:** Either wire it into the first read surface that renders a per-send status, or annotate the export with the concrete planned consumer so the next phase picks it up deliberately.

### IN-02: Dynamic SQL identifiers in `setFactColumnOnce`/`incrementCampaignCounter`

**File:** `apps/worker/src/queues/webhook-events.worker.ts:108-128`
**Issue:** `column` / `reasonColumn` / counter `column` are interpolated directly into SQL text. Today every call site passes a hardcoded literal (`"delivered_at"`, `"bounced_count"`, etc.), so this is not injectable — but the pattern is a classic footgun if a future caller ever derives the column name from event data.
**Fix:** Constrain the parameters to a union of literal types, e.g. `column: "delivered_at" | "first_opened_at" | "first_clicked_at" | "bounced_at" | "dropped_at" | "spam_reported_at" | "unsubscribed_at"`, so the compiler rejects any non-literal identifier.

### IN-03: No timestamp-freshness check on webhook signature verification (indefinite replay window)

**File:** `apps/api/src/modules/webhooks/signature-verify.ts:15-35`, `apps/api/src/modules/webhooks/webhooks.routes.ts:58-65`
**Issue:** The ECDSA signature covers `timestamp + body`, but the route never checks that the timestamp is recent, so a captured (signature, timestamp, body) triple verifies forever. Impact is well-contained — `sg_event_id` dedup makes replayed events side-effect-free — but each replay still enqueues a job, runs a batch transaction, and refreshes `last_event_at` via `debounceWebhookHealth`, letting a replayer keep a dead webhook's health indicator artificially "live".
**Fix:** Reject requests whose `x-twilio-email-event-webhook-timestamp` is outside a tolerance window (e.g. ±10 minutes) before signature verification.

### IN-04: Multi-row `send_events` INSERT has no chunking against Postgres's 65,535 bind-parameter limit

**File:** `apps/worker/src/queues/webhook-events.worker.ts:342-370`
**Issue:** At 9 parameters per row, a batch of more than ~7,281 extractable events would exceed the wire protocol's bind-parameter limit, failing the whole job (5 retries, then the failed set — with the HTTP batch already 200-acked). The route's 1MB `bodyLimit` makes this practically unreachable for genuine SendGrid events (each is well over 137 bytes), so this is a theoretical bound, not a live bug.
**Fix:** Chunk `resolvedRows` into slices of e.g. 1,000 rows per INSERT inside the same transaction.

### IN-05: Soft-bounce streak counts per event, not per send

**File:** `apps/worker/src/queues/webhook-events.worker.ts:222-243`
**Issue:** `consecutive_soft_bounces` increments on every genuinely-new `bounce`/`type:"blocked"` event. If SendGrid ever emits multiple distinct blocked events for the SAME send (distinct `sg_event_id`s across delivery attempts), a single message could contribute 2-3 streak increments and suppress a contact off one send. This matches D-10's literal wording ("each genuinely-new soft bounce event") and blocked events are typically once-per-message, so this is a semantics note rather than a defect.
**Fix:** If per-send semantics are intended, gate the streak increment on per-send state (e.g. only increment when this send has not previously contributed a soft bounce, tracked via a `sends` marker column).

---

_Reviewed: 2026-07-09T06:43:37Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
