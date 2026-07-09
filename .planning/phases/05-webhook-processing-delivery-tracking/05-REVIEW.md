---
phase: 05-webhook-processing-delivery-tracking
reviewed: 2026-07-09T12:58:26Z
depth: standard
files_reviewed: 59
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/modules/campaigns/__tests__/campaign-delivery-counters.test.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - apps/api/src/modules/tenancy/__tests__/sendgrid-key-webhook-provisioning.test.ts
  - apps/api/src/modules/tenancy/sendgrid-client.ts
  - apps/api/src/modules/tenancy/sendgrid-key.ts
  - apps/api/src/modules/webhooks/__tests__/webhook-provisioning.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhook-settings-routes.test.ts
  - apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts
  - apps/api/src/modules/webhooks/enqueue.ts
  - apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
  - apps/api/src/modules/webhooks/signature-verify.ts
  - apps/api/src/modules/webhooks/webhook-endpoint.repository.ts
  - apps/api/src/modules/webhooks/webhook-settings.routes.ts
  - apps/api/src/modules/webhooks/webhook-warning-copy.ts
  - apps/api/src/modules/webhooks/webhooks.routes.ts
  - apps/api/src/server.ts
  - apps/web/src/features/campaigns/CampaignDetailPage.tsx
  - apps/web/src/features/campaigns/CampaignProgress.tsx
  - apps/web/src/features/campaigns/api.ts
  - apps/web/src/features/onboarding/OnboardingChecklist.tsx
  - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx
  - apps/web/src/features/sendgrid-key/__tests__/webhook-notice.test.ts
  - apps/web/src/features/sendgrid-key/webhook-notice.ts
  - apps/web/src/features/webhooks/webhook-health.api.ts
  - apps/worker/src/queues/__tests__/webhook-events-idempotency.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-status.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-suppression.test.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/server.ts
  - docs/webhook-live-uat.md
  - packages/db/migrations/0020_send_events_partitioned.sql
  - packages/db/migrations/0021_webhook_endpoints.sql
  - packages/db/migrations/0022_sends_delivery_columns.sql
  - packages/db/migrations/0023_contacts_soft_bounce_streak.sql
  - packages/db/migrations/0024_campaigns_delivery_counters.sql
  - packages/db/migrations/0025_webhook_provision_error.sql
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
  - scripts/check-env.mjs
findings:
  critical: 1
  warning: 5
  info: 7
  total: 13
status: issues_found
---

# Phase 5: Code Review Report (Round 2)

**Reviewed:** 2026-07-09T12:58:26Z
**Depth:** standard
**Files Reviewed:** 59
**Status:** issues_found

## Summary

Second review round for the webhook-processing/delivery-tracking phase, covering the full diff since `0445177^` with particular attention to the 05-08/05-09/05-10 gap-closure slices (provisioning failure logging + redaction, `provision_error` persistence, connect-time scope detection, typed reason threading, and the web notice slice).

The previous round's findings are confirmed closed: the friendly_name is now workspace-scoped with a stale-URL re-PATCH path (old CR-01, verified in `sendgrid-webhook-provision.ts:25-27,179-181` plus tests), and the worker now skips events with missing/out-of-range timestamps deterministically instead of falling back to wall-clock time (old WR-01/WR-02, verified in `webhook-events.worker.ts:61-68` plus tests).

The core pipeline is in strong shape: the raw-body-before-signature discipline is correctly scoped via plugin encapsulation, the receiver fails closed on every path, the `ON CONFLICT ... RETURNING` dedup gate plus `WHERE <col> IS NULL` first-write fact columns give genuinely exactly-once side effects (verified by tracing replay/out-of-order paths against the tests), RLS policies carry the NULLIF guard where a second permissive policy exists, and the API key never reaches logs unredacted on the paths exercised.

One Critical issue remains: the PATCH-by-stored-webhook-id path has no fallback when SendGrid answers 404, which permanently wedges provisioning for tenants who switch SendGrid accounts or delete the platform webhook — and the "Переподключить" button, the designated remediation, can never recover from it. Five warnings cover error-reason conflation (401 vs 403), an upsert race, a silent catch, a theoretical batch-size overflow, and a stale health-card cache.

## Critical Issues

### CR-01: PATCH of a stale `sendgridWebhookId` returns 404 with no CREATE fallback — provisioning permanently wedged, Reconnect cannot self-heal

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:271-274` (and `213-235`)
**Issue:** When `existingWebhookId` is stored, `provisionEventWebhook` only ever PATCHes that id:

```ts
const webhookResult = existingWebhookId
  ? await patchWebhook(apiKey, existingWebhookId, callbackUrl, workspaceId)
  : await createWebhook(apiKey, callbackUrl, workspaceId);
```

If the webhook id no longer exists on the account the key belongs to, SendGrid returns 404, which `errorForStatus` maps to `"failed"`, and every caller (`sendgrid-key.ts:72-81`, `webhook-settings.routes.ts:122-136`) persists `provisionStatus: 'error'` while **keeping the stale `sendgridWebhookId`** (`result.webhookId ?? existing?.sendgridWebhookId`). Every subsequent connect/recheck/reconnect re-PATCHes the same dead id and fails again, forever. This is reachable through two ordinary, supported flows:
1. Tenant connects a key from a **different SendGrid account** (normal BYO-key rotation) — the stored id doesn't exist on the new account.
2. Tenant deletes the platform's webhook in the SendGrid dashboard and clicks "Переподключить" — the exact remediation the UI and `docs/webhook-live-uat.md` direct them to.

In both cases delivery tracking is dead for the workspace with no self-service recovery (only manual DB surgery clears the stale id), and the user-facing copy ("Попробуйте переподключить ключ позже") is a lie — retrying can never succeed. The `createWebhook` path already contains the correct recovery machinery (list by workspace-scoped friendly_name, reuse-or-create, re-PATCH stale URL); it is simply unreachable once an id is stored.

**Fix:** Treat a 404 on the PATCH-by-stored-id as "stored id is stale" and fall through to the create/reuse path:

```ts
// in provisionEventWebhook
if (existingWebhookId) {
  const patched = await patchWebhook(apiKey, existingWebhookId, callbackUrl, workspaceId);
  if (!("error" in patched) || patched.recoverable !== true) {
    webhookResult = patched;
  } else {
    // stored id no longer exists on this account -- recover via list/reuse/create
    webhookResult = await createWebhook(apiKey, callbackUrl, workspaceId);
  }
}
```

with `patchWebhook` signaling `{ error: "failed", recoverable: true }` (or similar) specifically when `res.status === 404`. Add a test: stored id + PATCH 404 + successful CREATE → result active with the new id persisted.

## Warnings

### WR-01: 401 (invalid/revoked key) is conflated with 403 into `missing_scope` — wrong remediation copy shown to the user

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:80-82`
**Issue:** `errorForStatus` maps both 401 and 403 to `"missing_scope"`. A 401 from SendGrid means the key is invalid/revoked, not that it lacks a scope. This is directly reachable via `POST /webhook-reconnect` (`webhook-settings.routes.ts:98-136`), which decrypts and uses the stored key **without** re-validating it first (unlike connect/recheck). A tenant whose key was revoked sees "у него нет прав на управление вебхуками... Создайте ключ с правами Webhooks Settings" — sending them to rebuild key scopes when the actual fix is reconnecting a live key.
**Fix:** Map 401 to a distinct reason (e.g. `"invalid_key"` with copy pointing at reconnecting the key), or have the reconnect route run `validateTenantSendGridKey` first and surface the existing `INVALID_KEY_ERROR` copy on `{ valid: false }`. Keep 403 → `missing_scope`.

### WR-02: `upsertWebhookEndpoint` SELECT-then-branch race can create duplicate per-workspace rows; reads are then nondeterministic

**File:** `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts:107-145` (and `packages/db/migrations/0021_webhook_endpoints.sql`)
**Issue:** The doc-comment claims provisioning is "never concurrent", but nothing enforces that: `POST /sendgrid-key`, `POST /sendgrid-key/recheck`, and `POST /webhook-reconnect` are three independent endpoints two admins (or one double-click before the button disables) can hit concurrently. On first provisioning (no row yet), both requests take the INSERT branch, producing two rows with different `pathToken`s. `getWebhookEndpointByWorkspace` (lines 87-98) has no `ORDER BY` and returns `rows[0]`, so subsequent health reads/re-provisions flip nondeterministically between the two rows, and the SendGrid webhook URL matches only one of them.
**Fix:** Add `UNIQUE (workspace_id)` to `workspace_webhook_endpoints` (there is exactly one endpoint per workspace by design) and rewrite the upsert as a single `INSERT ... ON CONFLICT (workspace_id) DO UPDATE`.

### WR-03: `provisionWebhookBestEffort`'s outer catch swallows exceptions with no logging — reintroduces the silent-failure class 05-08 closed

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:91-94`
**Issue:**

```ts
} catch {
  // Defense-in-depth (D-01): provisioning must never fail the key connect.
  return WEBHOOK_PROVISION_FAILED_WARNING;
}
```

A failure in `getWebhookEndpointByWorkspace`/`upsertWebhookEndpoint` (DB error, RLS misconfiguration, pool exhaustion) is swallowed with zero diagnostics — the exact "operator cannot see WHY it failed" gap the 05-08 plan closed for the SendGrid-response side (`logNonOkProvisionResponse`). It also persists nothing, so the health endpoint may keep reporting a stale `active`/`pending` state that contradicts the warning the user just saw.
**Fix:** Keep the non-throwing contract but log the caught error (via the request/app logger; the decrypted key is not interpolated into repository errors, and `redactApiKey(err, apiKey)` can be applied for belt-and-braces) before returning the warning.

### WR-04: Unbounded multi-row INSERT can exceed Postgres's 65,535 bind-parameter limit — batch permanently fails after the receiver already acked 200

**File:** `apps/worker/src/queues/webhook-events.worker.ts:342-370`
**Issue:** The batch insert binds 9 parameters per extracted event with no chunking. The receiver caps the raw body at 1 MB (`webhooks.routes.ts:40`), which admits up to roughly 20k minimal events (~45 bytes each) → ~180k parameters, far past the protocol limit of 65,535 (~7,281 rows). Such a batch throws on every one of the job's 5 attempts and lands in the failed set — but the HTTP receiver already returned 200, so SendGrid never redelivers: those events are lost. Only signature-valid (i.e., SendGrid-originated) payloads reach this path and real SendGrid batches are far smaller, so likelihood is low — but the failure mode is silent event loss, which is exactly what the ack-fast/redeliver design exists to prevent.
**Fix:** Chunk `resolvedRows` into slices of e.g. 1,000 rows per INSERT (still inside the one transaction), or split oversized batches at enqueue time.

### WR-05: Recheck can re-provision the webhook but never invalidates the webhook-health query — health card shows stale state

**File:** `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx:206-223` (vs. `webhookHealthQueryKey` at 65-67)
**Issue:** `recheckMutation.onSuccess` invalidates only `["workspace", slug, "sendgrid-key"]`, but the recheck route runs `provisionWebhookBestEffort` server-side and can flip `provisionStatus` (error → active or active → error). The already-mounted `WebhookHealthCard` keeps rendering its cached `webhook-health` data. Concretely, in the 05-09 remediation flow — user replaces a scope-limited key, hits "Проверить сейчас", provisioning now succeeds — the card continues to show the red error badge and stale reason until a window-refocus or full reload. Same for `connectMutation` (lower impact: the card usually mounts fresh after first connect).
**Fix:** In both `connectMutation.onSuccess` and `recheckMutation.onSuccess`, also invalidate `webhookHealthQueryKey(slug)`.

## Info

### IN-01: Unused `lastEventAt` parameter in `webhookHealthDescription`

**File:** `apps/web/src/features/sendgrid-key/webhook-notice.ts:51-60`
**Issue:** The `lastEventAt` field of the parameter object is never read by the function body; callers are forced to thread it through for nothing.
**Fix:** Drop the field from the parameter type (adjust the call site in `SendGridKeySettings.tsx:110-114` and its tests).

### IN-02: `console.warn`/`console.error` in API-process code instead of the app's Pino logger

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:103,287`
**Issue:** The 05-08 diagnostics use raw `console.*` inside the Fastify API process, bypassing the structured Pino pipeline the stack mandates (no level control, no request correlation, unstructured output). Redaction itself is correct.
**Fix:** Accept a logger (or import the app logger) and emit `logger.warn({ context, status, body }, "provisionEventWebhook non-ok response")`.

### IN-03: `@sendgrid/eventwebhook` uses a caret range while all other runtime deps are pinned

**File:** `apps/api/package.json:26`
**Issue:** `"^8.0.0"` breaks the repo's exact-pin convention for runtime dependencies (`@sendgrid/mail` is pinned at `8.1.6` two lines below); a lockfile refresh could silently bump the crypto-adjacent verification library.
**Fix:** Pin to the exact tested version (e.g. `"8.0.0"`).

### IN-04: Third duplicated copy of `buildRedisConnectionOptions`

**File:** `apps/api/src/modules/webhooks/enqueue.ts:17-29`
**Issue:** Same URL-parsing helper now exists in three places (`events/events-queue.ts`, `worker/queues/connection.ts`, here). The comment acknowledges the duplication, but at three copies a `REDIS_URL` parsing fix (e.g. TLS `rediss://` support) must be applied thrice.
**Fix:** Extract into `@mega-crm/shared-schemas` or a small shared infra package.

### IN-05: Public webhook receiver has no route-level rate limit

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:46` (with `apps/api/src/server.ts:47` `global: false`)
**Issue:** `@fastify/rate-limit` is registered `global: false` and this unauthenticated route does not opt in, so every bogus request costs a pooled-DB `path_token` lookup (plus an ECDSA verify when the token guesses right). The token is unguessable, so this is a resource-pressure concern, not an auth bypass.
**Fix:** Add a `config: { rateLimit: ... }` opt-in with a generous per-IP ceiling well above SendGrid's real delivery rate.

### IN-06: Health route trusts stored `provision_status`/`provision_error` without validation

**File:** `apps/api/src/modules/webhooks/webhook-settings.routes.ts:72,32-37`
**Issue:** `endpoint.provisionStatus as WebhookHealthResponse["provisionStatus"]` is an unvalidated cast (the columns are free `text`), and `provisionErrorMessage` returns `null` for an unrecognized stored `provision_error` — so a future/unknown stored value yields an `error`-status response with no reason, and the UI's `CardDescription` silently falls back to "События ещё не поступали" under a red badge.
**Fix:** Validate through `webhookHealthResponseSchema` before sending, and fall back to `WEBHOOK_PROVISION_FAILED_WARNING` for an unrecognized non-null `provision_error` in the error state.

### IN-07: Connect-time scope short-circuit downgrades a previously-active endpoint even though tracking may still work

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:47-60`
**Issue:** When a workspace already has an `active`, functioning webhook (it lives on the SendGrid account independently of any API key) and the admin rotates to a narrower key without the webhook-management scope, the short-circuit overwrites `provisionStatus` to `error`/`missing_scope`. Signed events keep arriving and verifying against the retained `publicKey`, so the health card shows a red error while `lastEventAt` keeps advancing — a contradictory state. Behavior matches what the doomed PATCH would have produced, so this is a truthfulness nit, not a regression.
**Fix:** Consider skipping the downgrade when `existing?.provisionStatus === "active"` and the callback URL is unchanged (surface the scope warning without flipping the persisted status).

---

## Closed findings from review round 1

- **CR-01 (round 1)** — global `friendly_name` allowed cross-workspace webhook adoption: **closed by 05-07.** Verified: `webhookFriendlyName()` appends a workspace discriminator (`sendgrid-webhook-provision.ts:25-27`), reuse-by-name re-PATCHes a stale URL (`:179-181`), and both behaviors are covered by tests (`webhook-provisioning.test.ts:198-280`).
- **WR-01/WR-02 (round 1)** — wall-clock `occurred_at` fallback defeating dedup, and `new Date` RangeError on out-of-range timestamps: **closed by 05-06.** Verified: `extractEventRow` skips events without a finite, Date-representable numeric timestamp (`webhook-events.worker.ts:61-68`), covered by `webhook-events-idempotency.test.ts:222-252`.

---

_Reviewed: 2026-07-09T12:58:26Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
