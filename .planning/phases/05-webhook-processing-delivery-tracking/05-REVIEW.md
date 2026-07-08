---
phase: 05-webhook-processing-delivery-tracking
reviewed: 2026-07-08T15:14:05Z
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
  critical: 1
  warning: 6
  info: 8
  total: 15
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-07-08T15:14:05Z
**Depth:** standard
**Files Reviewed:** 52
**Status:** issues_found

## Summary

Reviewed the Phase 5 webhook-processing and delivery-tracking implementation: the public SendGrid Event Webhook receiver (raw-body signature verification), auto-provisioning via tenant BYO keys, the webhook-events BullMQ worker (dedup insert, fact columns, campaign counters, suppression state machine), supporting migrations/schemas, and the frontend health/progress surfaces.

The core security posture is solid: the raw-body content-type parser is correctly scoped to the webhook plugin (never parsed before ECDSA verification), `workspaceId` is resolved from the pathToken before the payload is trusted, RLS covers `send_events`/`workspace_webhook_endpoints` including a correctly-mirrored runtime-lookup policy, decrypted API keys are redacted from thrown errors, and the `ON CONFLICT ... RETURNING` dedup gate for exactly-once side effects is well built and well tested.

The most significant defect is in the provisioning recovery path: reusing an existing SendGrid webhook by `friendly_name` never updates its callback URL, which silently breaks delivery tracking (and can cross-wire two workspaces sharing one SendGrid account) while reporting `provisionStatus: 'active'`. Several robustness gaps in the worker's batch extraction and a dead-end reconnect path round out the findings.

## Critical Issues

### CR-01: friendly_name webhook reuse never updates the callback URL — tracking silently breaks while status reports "active"

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:127-136` (with `apps/api/src/modules/tenancy/sendgrid-key.ts:50-74`, `apps/api/src/modules/webhooks/webhook-settings.routes.ts:85-107`)
**Issue:** When `createWebhook` finds an existing webhook whose `friendly_name` matches `"Mega CRM Delivery Tracking"`, it returns `{ id: existing.id }` immediately — it never PATCHes that webhook's `url` to the caller's `callbackUrl`. The callers then persist `provisionStatus: 'active'` with a freshly-generated `pathToken`, while the actual SendGrid webhook still points at whatever URL it had before. Two concrete failure modes:

1. **Same SendGrid key connected in two workspaces** (agency/multi-brand accounts — nothing prevents this): workspace B's connect finds workspace A's webhook by friendly_name, adopts its id, stores B's fresh pathToken, and shows "active" — but all events keep flowing to A's URL; B records zero delivery data. Worse, if B later clicks "Переподключить", the reconnect path PATCHes the *shared* webhook to B's URL — silently killing workspace A's tracking while A still shows "active".
2. **DB endpoint row lost but SendGrid webhook alive** (the exact recovery scenario this branch's comment claims to handle): the reused webhook keeps the old pathToken URL; the new pathToken stored in the DB never receives events (the old URL now 404s), yet the UI shows connected.

Either way the platform's core value promise ("сквозное отслеживание статусов") fails silently with a false-positive health status.
**Fix:** After matching an existing webhook by `friendly_name`, verify/repair its URL before returning:
```typescript
if (existing) {
  if (existing.url !== callbackUrl) {
    // Repoint the reused webhook at THIS workspace's callback URL --
    // reuse-by-name without a URL patch leaves events flowing elsewhere.
    return patchWebhook(apiKey, existing.id, callbackUrl);
  }
  return { id: existing.id };
}
```
Additionally, to close the two-workspaces-one-account cross-wiring, make the friendly name (or a custom field) workspace-scoped, e.g. `Mega CRM Delivery Tracking (${workspaceId.slice(0, 8)})`, so each workspace provisions its own webhook instead of stealing a sibling's.

## Warnings

### WR-01: `occurredAt` fallback to `new Date()` defeats the dedup key — duplicate side effects on redelivery

**File:** `apps/worker/src/queues/webhook-events.worker.ts:49-52`
**Issue:** For an event whose `timestamp` is missing or not a `number`, `occurredAt` falls back to `new Date().toISOString()`. `occurred_at` is part of the `(workspace_id, sg_event_id, occurred_at)` UNIQUE dedup key. The fallback is re-computed on **every processing attempt**, so a BullMQ redelivery (the queue is configured with `attempts: 5`, and SendGrid itself re-POSTs unacked batches) of the same event produces a *different* `occurred_at`, `ON CONFLICT` never fires, and the event is inserted again — with **duplicate counter increments and duplicate suppression side effects**, breaking the WBHK-03/D-09 exactly-once invariant the whole pipeline is built on. The entire dedup design depends on `occurred_at` being deterministic; the fallback silently violates that for exactly the events it applies to.
**Fix:** Never use wall-clock time in the dedup key. Either skip events lacking a usable timestamp (return `null` from `extractEventRow`, same as a missing `sg_event_id`), or derive a deterministic stand-in (e.g. a fixed epoch sentinel) so replays collide:
```typescript
if (typeof event.timestamp !== "number") {
  return null; // no deterministic occurred_at -> cannot be safely deduped
}
```

### WR-02: `extractEventRow` throws (crashing the whole batch) on an out-of-range numeric timestamp

**File:** `apps/worker/src/queues/webhook-events.worker.ts:49-52`
**Issue:** `new Date(event.timestamp * 1000).toISOString()` throws `RangeError: Invalid time value` when `timestamp * 1000` exceeds the ECMAScript date range (±8.64e15 ms) — e.g. a JSON value like `1e20`. `extractEventRow` has no guard, so the `.map(extractEventRow)` at line 299 throws, the job fails, BullMQ retries 5 times, and the **entire already-acked batch** (including every well-formed event in it) is permanently dropped into the failed set. This directly contradicts the function's own contract: "one malformed event in a batch must not crash the whole batch."
**Fix:** Validate the timestamp is finite and in range before constructing the Date:
```typescript
const ts = event.timestamp;
const occurredAtDate =
  typeof ts === "number" && Number.isFinite(ts) && Math.abs(ts * 1000) <= 8.64e15
    ? new Date(ts * 1000)
    : null;
if (!occurredAtDate) return null; // pairs with WR-01's deterministic-key requirement
const occurredAt = occurredAtDate.toISOString();
```

### WR-03: reconnect cannot recover from a webhook deleted on the SendGrid side — permanent dead-end

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:151-171`, `apps/api/src/modules/webhooks/webhook-settings.routes.ts:89`
**Issue:** Once `sendgridWebhookId` is stored, every reconnect/recheck takes the `patchWebhook` path. If the tenant deleted the platform's webhook in the SendGrid dashboard (a realistic user action), the PATCH returns 404, `errorForStatus(404)` maps it to `"failed"`, `provisionStatus` is set to `'error'` — and nothing ever clears the stale `sendgridWebhookId`, so every subsequent "Переподключить" click PATCHes the same dead id and fails again. There is no recovery path short of manual DB surgery; the UI's only remediation button is permanently broken for this state.
**Fix:** In `provisionEventWebhook`, fall back to `createWebhook` when the PATCH of `existingWebhookId` returns 404:
```typescript
const webhookResult = existingWebhookId
  ? await patchWebhookWithCreateFallback(apiKey, existingWebhookId, callbackUrl)
  : await createWebhook(apiKey, callbackUrl);
```
where the fallback treats a 404 PATCH response (webhook gone) as "no existing webhook" and re-creates.

### WR-04: `upsertWebhookEndpoint` SELECT-then-branch race can create two endpoint rows per workspace

**File:** `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts:105-129`
**Issue:** There is no `UNIQUE(workspace_id)` constraint, and the upsert is a non-locked SELECT followed by INSERT/UPDATE in separate statements. The doc comment asserts provisioning is "never concurrent", but nothing enforces that: two Owner/Admin sessions clicking connect + reconnect simultaneously (or a double-submitted request) can both see zero rows and both INSERT, leaving two rows for one workspace with two different `pathToken`s. `getWebhookEndpointByWorkspace` then returns an arbitrary row (`rows[0]` with no ORDER BY), so health status, reconnect behavior, and which pathToken SendGrid actually points at can silently disagree — and both tokens remain live receivers.
**Fix:** Add `UNIQUE (workspace_id)` to `workspace_webhook_endpoints` in a migration and replace the SELECT-then-branch with a single atomic statement:
```sql
INSERT INTO workspace_webhook_endpoints (workspace_id, path_token, sendgrid_webhook_id, public_key, provision_status)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (workspace_id) DO UPDATE
  SET path_token = EXCLUDED.path_token, sendgrid_webhook_id = EXCLUDED.sendgrid_webhook_id,
      public_key = EXCLUDED.public_key, provision_status = EXCLUDED.provision_status, updated_at = now()
```

### WR-05: `webhookWarning` from connect/recheck is never rendered — degraded provisioning is invisible to the user

**File:** `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx:27-32, 165-192`
**Issue:** The API deliberately returns a `webhookWarning` string on connect/recheck when webhook provisioning degrades (missing scope, plan cap, generic failure — three carefully-written Russian copy strings in `sendgrid-key.ts:23-28`). The frontend's `KeyMutationResponse` interface omits the field and neither mutation's `onSuccess` reads it: the user sees only "SendGrid подключён" success toast while delivery tracking silently failed to provision. The entire D-01 graceful-degradation UX contract (server-side copy surfaced to the marketer) is dead on arrival; the only hint is the health card's badge, which requires the user to notice it unprompted.
**Fix:** Add `webhookWarning?: string` to `KeyMutationResponse` and surface it:
```typescript
onSuccess: (data) => {
  ...
  if (data.webhookWarning) {
    toast.warning(data.webhookWarning);
  } else {
    toast.success("SendGrid подключён");
  }
  void queryClient.invalidateQueries({ queryKey: webhookHealthQueryKey(slug) });
},
```

### WR-06: unchunked multi-row INSERT can exceed Postgres's 65,535 bind-parameter limit for large batches

**File:** `apps/worker/src/queues/webhook-events.worker.ts:326-355`
**Issue:** The batch insert binds 9 parameters per event with no chunking. The route accepts bodies up to 1 MB; with compact events (~130-150 bytes each) a signature-valid batch can exceed ~7,281 events, at which point the single INSERT exceeds the wire-protocol parameter limit and fails with a bind error. Because the failure repeats identically on all 5 retry attempts, the entire acked batch is permanently lost — a silent data-loss cliff triggered purely by batch size.
**Fix:** Chunk the insert (e.g. 1,000 rows per statement) inside the same transaction:
```typescript
for (const chunk of chunks(resolvedRows, 1000)) {
  // build placeholders/values per chunk, accumulate RETURNING ids
}
```

## Info

### IN-01: dynamic column-name interpolation in `setFactColumnOnce`/`incrementCampaignCounter`

**File:** `apps/worker/src/queues/webhook-events.worker.ts:99-112`
**Issue:** Column names are string-interpolated into SQL. All current call sites pass hardcoded literals, so there is no injection today, but the signature (`column: string`) invites a future caller to pass tainted input.
**Fix:** Type the parameter as a union of allowed literals (`column: "delivered_at" | "first_opened_at" | ...`) or map through a const whitelist object.

### IN-02: `DeliveryFacts.unsubscribedAt` declared but never consulted by `deriveCurrentStatus`

**File:** `packages/delivery-core/src/send-status.ts:19, 30-38`
**Issue:** The interface exposes `unsubscribedAt` but the priority chain never inspects it — either dead field or an unimplemented status branch. A future caller passing it will silently get `delivered`/`opened` back.
**Fix:** Either remove the field or document explicitly that unsubscribe is intentionally not a delivery status.

### IN-03: caret version ranges break the exact-pin convention

**File:** `apps/api/package.json:26, 33`
**Issue:** `@sendgrid/eventwebhook": "^8.0.0"` and `fastify-plugin": "^5.0.1"` use caret ranges while every sibling runtime dependency is exact-pinned.
**Fix:** Pin both to exact versions for consistency.

### IN-04: `removeOnFail: false` accumulates failed webhook jobs in Redis unboundedly

**File:** `apps/api/src/modules/webhooks/enqueue.ts:47`
**Issue:** Failed jobs (after 5 attempts) are retained forever. Intentional for debuggability, but with no TTL or count cap this grows Redis without bound under a sustained failure (e.g. WR-02/WR-06 scenarios).
**Fix:** Use `removeOnFail: { age: 7 * 86400 }` (or a count cap) once a dead-letter review process exists.

### IN-05: no timestamp-freshness window on webhook signature verification

**File:** `apps/api/src/modules/webhooks/signature-verify.ts:15-35`
**Issue:** A captured signed request can be replayed indefinitely (the ECDSA check covers timestamp+body but nothing bounds the timestamp's age). Impact is low because the worker's dedup makes replays side-effect-free — but note this mitigation itself depends on WR-01 being fixed.
**Fix:** Optionally reject requests whose timestamp is older than e.g. 10 minutes.

### IN-06: `provisionStatus` cast from unconstrained text column to enum type without validation

**File:** `apps/api/src/modules/webhooks/webhook-settings.routes.ts:47`
**Issue:** `endpoint.provisionStatus as WebhookHealthResponse["provisionStatus"]` blindly casts a DB `text` value into the `"pending" | "active" | "error"` union; a bad write would flow to the client unvalidated (the zod schema is not used to serialize).
**Fix:** Validate with `webhookHealthResponseSchema.parse(body)` before sending, or add a CHECK constraint on the column.

### IN-07: recheck re-provisions the webhook but the client never invalidates the webhook-health query

**File:** `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx:180-192`
**Issue:** `recheckMutation.onSuccess` invalidates only the sendgrid-key status query. If the recheck's best-effort provisioning changed `provisionStatus` (error -> active or vice versa), the already-mounted WebhookHealthCard keeps showing the stale badge until an unrelated refetch.
**Fix:** Also `invalidateQueries({ queryKey: webhookHealthQueryKey(slug) })` in both connect and recheck `onSuccess`/`onError`.

### IN-08: third copy of `buildRedisConnectionOptions`

**File:** `apps/api/src/modules/webhooks/enqueue.ts:17-29`
**Issue:** Identical connection-parsing logic now exists in `events-queue.ts`, `apps/worker/src/queues/connection.ts`, and here (the comment acknowledges it). Three copies of URL parsing is past the point where "config, not business logic" justifies duplication — a future auth/TLS option will need three edits.
**Fix:** Move it into `@mega-crm/shared-schemas` or a small shared infra package.

---

_Reviewed: 2026-07-08T15:14:05Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
