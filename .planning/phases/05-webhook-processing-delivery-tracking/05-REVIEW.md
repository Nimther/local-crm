---
phase: 05-webhook-processing-delivery-tracking
reviewed: 2026-07-09T13:43:04Z
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
  critical: 0
  warning: 5
  info: 8
  total: 13
status: issues_found
---

# Phase 5: Code Review Report (Round 3)

**Reviewed:** 2026-07-09T13:43:04Z
**Depth:** standard
**Files Reviewed:** 59
**Status:** issues_found

## Summary

Third review round after gap-closure plan 05-11 (commits `27c52d5`, `fc7735c`) landed to close round-2's CR-01. The source diff since the round-2 review touches exactly two files: `sendgrid-webhook-provision.ts` and `webhook-provisioning.test.ts`.

**Round-2's CR-01 is genuinely closed.** Verified by tracing the code: `patchWebhook` now returns a widened `PatchWebhookResult` marking a 404 as `recoverable: true` (`sendgrid-webhook-provision.ts:219,240`), and `provisionEventWebhook`'s `existingWebhookId` branch falls through to `createWebhook`'s list/reuse-or-create path on that marker (`:282-289`). Traced end-to-end: a stale stored id on a rotated SendGrid account now recovers via LIST-by-workspace-scoped-friendly_name → reuse (with stale-URL re-PATCH) or POST create; the new id reaches persistence in every caller (`sendgrid-key.ts:75,85`, `webhook-settings.routes.ts:125,140` — success path persists `result.id`, signed-verification-failure path persists `result.webhookId`). Non-404 PATCH failures (401/403/5xx) correctly do NOT fall through — `recoverable` stays false and the typed error is normalized and returned. No infinite-retry loop is possible (the fall-through calls `createWebhook` exactly once). Both regression tests specified in the round-2 fix guidance exist (`webhook-provisioning.test.ts:304-356`) and the full 13-test suite passes.

No new Critical or Warning findings in the 05-11 diff. One new Info finding: the `recoverable` marker is not actually normalized away on every public-boundary path, contrary to the docstring's claim (IN-08).

The five warnings and seven info items from round 2 are all confirmed still present (none were in 05-11's scope) and are carried forward below with re-verified line numbers.

## Warnings

### WR-01: 401 (invalid/revoked key) is conflated with 403 into `missing_scope` — wrong remediation copy shown to the user

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:80-82`
**Issue:** `errorForStatus` maps both 401 and 403 to `"missing_scope"`. A 401 from SendGrid means the key is invalid/revoked, not that it lacks a scope. This is directly reachable via `POST /webhook-reconnect` (`webhook-settings.routes.ts:98-136`), which decrypts and uses the stored key **without** re-validating it first (unlike connect/recheck). A tenant whose key was revoked sees "у него нет прав на управление вебхуками... Создайте ключ с правами Webhooks Settings" — sending them to rebuild key scopes when the actual fix is reconnecting a live key. (Carried from round 2; unchanged.)
**Fix:** Map 401 to a distinct reason (e.g. `"invalid_key"` with copy pointing at reconnecting the key), or have the reconnect route run `validateTenantSendGridKey` first and surface the existing `INVALID_KEY_ERROR` copy on `{ valid: false }`. Keep 403 → `missing_scope`.

### WR-02: `upsertWebhookEndpoint` SELECT-then-branch race can create duplicate per-workspace rows; reads are then nondeterministic

**File:** `apps/api/src/modules/webhooks/webhook-endpoint.repository.ts:107-145` (and `packages/db/migrations/0021_webhook_endpoints.sql`)
**Issue:** The doc-comment claims provisioning is "never concurrent", but nothing enforces that: `POST /sendgrid-key`, `POST /sendgrid-key/recheck`, and `POST /webhook-reconnect` are three independent endpoints two admins (or one double-click before the button disables) can hit concurrently. On first provisioning (no row yet), both requests take the INSERT branch, producing two rows with different `pathToken`s. `getWebhookEndpointByWorkspace` (lines 87-98) has no `ORDER BY` and returns `rows[0]`, so subsequent health reads/re-provisions flip nondeterministically between the two rows, and the SendGrid webhook URL matches only one of them. (Carried from round 2; unchanged.)
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

A failure in `getWebhookEndpointByWorkspace`/`upsertWebhookEndpoint` (DB error, RLS misconfiguration, pool exhaustion) is swallowed with zero diagnostics — the exact "operator cannot see WHY it failed" gap the 05-08 plan closed for the SendGrid-response side (`logNonOkProvisionResponse`). It also persists nothing, so the health endpoint may keep reporting a stale `active`/`pending` state that contradicts the warning the user just saw. (Carried from round 2; unchanged.)
**Fix:** Keep the non-throwing contract but log the caught error (via the request/app logger; the decrypted key is not interpolated into repository errors, and `redactApiKey(err, apiKey)` can be applied for belt-and-braces) before returning the warning.

### WR-04: Unbounded multi-row INSERT can exceed Postgres's 65,535 bind-parameter limit — batch permanently fails after the receiver already acked 200

**File:** `apps/worker/src/queues/webhook-events.worker.ts:342-370`
**Issue:** The batch insert binds 9 parameters per extracted event with no chunking. The receiver caps the raw body at 1 MB (`webhooks.routes.ts:40`), which admits up to roughly 20k minimal events (~45 bytes each) → ~180k parameters, far past the protocol limit of 65,535 (~7,281 rows). Such a batch throws on every one of the job's 5 attempts and lands in the failed set — but the HTTP receiver already returned 200, so SendGrid never redelivers: those events are lost. Only signature-valid (i.e., SendGrid-originated) payloads reach this path and real SendGrid batches are far smaller, so likelihood is low — but the failure mode is silent event loss, which is exactly what the ack-fast/redeliver design exists to prevent. (Carried from round 2; unchanged.)
**Fix:** Chunk `resolvedRows` into slices of e.g. 1,000 rows per INSERT (still inside the one transaction), or split oversized batches at enqueue time.

### WR-05: Recheck can re-provision the webhook but never invalidates the webhook-health query — health card shows stale state

**File:** `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx:206-223` (vs. `webhookHealthQueryKey` at 65-67)
**Issue:** `recheckMutation.onSuccess` invalidates only `["workspace", slug, "sendgrid-key"]`, but the recheck route runs `provisionWebhookBestEffort` server-side and can flip `provisionStatus` (error → active or active → error). The already-mounted `WebhookHealthCard` keeps rendering its cached `webhook-health` data. Concretely, in the 05-09 remediation flow — user replaces a scope-limited key, hits "Проверить сейчас", provisioning now succeeds — the card continues to show the red error badge and stale reason until a window-refocus or full reload. Same for `connectMutation` (lines 186-204; lower impact: the card usually mounts fresh after first connect). Only `reconnectMutation` inside the card itself invalidates the health key (line 88). (Carried from round 2; re-verified unchanged — 05-11 did not touch this file.)
**Fix:** In both `connectMutation.onSuccess` and `recheckMutation.onSuccess`, also invalidate `webhookHealthQueryKey(slug)`.

## Info

### IN-01: Unused `lastEventAt` parameter in `webhookHealthDescription`

**File:** `apps/web/src/features/sendgrid-key/webhook-notice.ts:51-60`
**Issue:** The `lastEventAt` field of the parameter object is never read by the function body; callers are forced to thread it through for nothing. (Carried from round 2.)
**Fix:** Drop the field from the parameter type (adjust the call site in `SendGridKeySettings.tsx:110-114` and its tests).

### IN-02: `console.warn`/`console.error` in API-process code instead of the app's Pino logger

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:103,305`
**Issue:** The 05-08 diagnostics use raw `console.*` inside the Fastify API process, bypassing the structured Pino pipeline the stack mandates (no level control, no request correlation, unstructured output). Redaction itself is correct. (Carried from round 2; line 287 → 305 after the 05-11 edit.)
**Fix:** Accept a logger (or import the app logger) and emit `logger.warn({ context, status, body }, "provisionEventWebhook non-ok response")`.

### IN-03: `@sendgrid/eventwebhook` uses a caret range while all other runtime deps are pinned

**File:** `apps/api/package.json:26`
**Issue:** `"^8.0.0"` breaks the repo's exact-pin convention for runtime dependencies (`@sendgrid/mail` is pinned at `8.1.6` two lines below); a lockfile refresh could silently bump the crypto-adjacent verification library. (Carried from round 2.)
**Fix:** Pin to the exact tested version (e.g. `"8.0.0"`).

### IN-04: Third duplicated copy of `buildRedisConnectionOptions`

**File:** `apps/api/src/modules/webhooks/enqueue.ts:17-29`
**Issue:** Same URL-parsing helper now exists in three places (`events/events-queue.ts`, `worker/queues/connection.ts`, here). The comment acknowledges the duplication, but at three copies a `REDIS_URL` parsing fix (e.g. TLS `rediss://` support) must be applied thrice. (Carried from round 2.)
**Fix:** Extract into `@mega-crm/shared-schemas` or a small shared infra package.

### IN-05: Public webhook receiver has no route-level rate limit

**File:** `apps/api/src/modules/webhooks/webhooks.routes.ts:46` (with `apps/api/src/server.ts:47` `global: false`)
**Issue:** `@fastify/rate-limit` is registered `global: false` and this unauthenticated route does not opt in, so every bogus request costs a pooled-DB `path_token` lookup (plus an ECDSA verify when the token guesses right). The token is unguessable, so this is a resource-pressure concern, not an auth bypass. (Carried from round 2.)
**Fix:** Add a `config: { rateLimit: ... }` opt-in with a generous per-IP ceiling well above SendGrid's real delivery rate.

### IN-06: Health route trusts stored `provision_status`/`provision_error` without validation

**File:** `apps/api/src/modules/webhooks/webhook-settings.routes.ts:72,32-37`
**Issue:** `endpoint.provisionStatus as WebhookHealthResponse["provisionStatus"]` is an unvalidated cast (the columns are free `text`), and `provisionErrorMessage` returns `null` for an unrecognized stored `provision_error` — so a future/unknown stored value yields an `error`-status response with no reason, and the UI's `CardDescription` silently falls back to "События ещё не поступали" under a red badge. (Carried from round 2.)
**Fix:** Validate through `webhookHealthResponseSchema` before sending, and fall back to `WEBHOOK_PROVISION_FAILED_WARNING` for an unrecognized non-null `provision_error` in the error state.

### IN-07: Connect-time scope short-circuit downgrades a previously-active endpoint even though tracking may still work

**File:** `apps/api/src/modules/tenancy/sendgrid-key.ts:47-60`
**Issue:** When a workspace already has an `active`, functioning webhook (it lives on the SendGrid account independently of any API key) and the admin rotates to a narrower key without the webhook-management scope, the short-circuit overwrites `provisionStatus` to `error`/`missing_scope`. Signed events keep arriving and verifying against the retained `publicKey`, so the health card shows a red error while `lastEventAt` keeps advancing — a contradictory state. Behavior matches what the doomed PATCH would have produced, so this is a truthfulness nit, not a regression. (Carried from round 2.)
**Fix:** Consider skipping the downgrade when `existing?.provisionStatus === "active"` and the callback URL is unchanged (surface the scope warning without flipping the persisted status).

### IN-08: `recoverable` marker can escape `provisionEventWebhook`'s public boundary via `createWebhook`'s reuse-PATCH path — docstring invariant is not actually enforced (new, round 3)

**File:** `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts:180,219,282-294`
**Issue:** The 05-11 docstring (lines 213-218) frames `recoverable` as an internal marker consumed by the stored-id fall-through, and `provisionEventWebhook` does normalize it on the non-recoverable PATCH branch (`{ error: patchResult.error }`, line 288). But `createWebhook`'s reuse path returns `patchWebhook(...)` directly (line 180), and `PatchWebhookResult` is structurally assignable to `createWebhook`'s declared `{ error }` return — so if the reused webhook's re-PATCH itself 404s (e.g. deleted between the LIST and the PATCH), the runtime object `{ error: "failed", recoverable: true }` flows through `webhookResult` and out of the public `return webhookResult` (lines 293-294) with the marker attached. Same on the plain no-stored-id branch (line 291). Today's callers only read `.error`/`.webhookId`, so this is harmless at runtime — but the module's stated invariant ("normalized away before the public return boundary") is false on two of three paths, and a future caller branching on `recoverable` at the public boundary would get inconsistent semantics (present on some failure paths, absent on others).
**Fix:** Normalize at the single exit point instead of per-branch:

```ts
if ("error" in webhookResult) {
  return { error: webhookResult.error };
}
```

(or have `createWebhook` destructure the patch result to `{ id }` / `{ error }` before returning it).

---

## Resolved findings from prior rounds

### Round 2

- **CR-01 (round 2)** — PATCH of a stale `sendgridWebhookId` returned 404 with no CREATE fallback, permanently wedging provisioning (rotated SendGrid account, or webhook deleted in the dashboard) with "Переподключить" unable to self-heal: **closed by 05-11** (commits `27c52d5`, `fc7735c`). Verified:
  - `patchWebhook` returns `recoverable: res.status === 404` alongside the typed error (`sendgrid-webhook-provision.ts:240`); all other non-ok statuses stay non-recoverable.
  - `provisionEventWebhook`'s `existingWebhookId` branch falls through to `createWebhook`'s workspace-scoped list/reuse-or-create path exactly once on the recoverable marker (`:282-289`) — no retry loop, and the 401/403/5xx PATCH failures still return their typed error without falling through.
  - The recovered id is persisted on both the success path (`result.id`) and the signed-verification-failure path (`result.webhookId`) in all three call sites (`sendgrid-key.ts:75,85`; `webhook-settings.routes.ts:125,140`), so the stale id cannot be re-stored.
  - Both regression tests specified in the round-2 fix guidance exist and pass: stale id + PATCH 404 + CREATE ok → active with the NEW id (`webhook-provisioning.test.ts:304-331`), and stale id + PATCH 404 + CREATE ok + signed 403 → error carrying the NEW `webhookId`, not the stale one (`:333-356`). Full suite: 13/13 passing.

### Round 1

- **CR-01 (round 1)** — global `friendly_name` allowed cross-workspace webhook adoption: **closed by 05-07.** Verified: `webhookFriendlyName()` appends a workspace discriminator (`sendgrid-webhook-provision.ts:25-27`), reuse-by-name re-PATCHes a stale URL (`:179-181`), and both behaviors are covered by tests (`webhook-provisioning.test.ts:198-280`).
- **WR-01/WR-02 (round 1)** — wall-clock `occurred_at` fallback defeating dedup, and `new Date` RangeError on out-of-range timestamps: **closed by 05-06.** Verified: `extractEventRow` skips events without a finite, Date-representable numeric timestamp (`webhook-events.worker.ts:61-68`), covered by `webhook-events-idempotency.test.ts:222-252`.

---

_Reviewed: 2026-07-09T13:43:04Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
