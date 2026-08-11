# Reprovision Webhook Event Types Runbook

Implements decision **D-06** (`.planning/phases/11-delivery-correctness/11-CONTEXT.md`)
and closes the gap 11-07 names explicitly: SendGrid's `processed` event is now
part of the event-type set the platform provisions into a tenant's own
Event Webhook subscription (`apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts`'s
`EVENT_FLAGS`), but **existing, already-connected tenants do not pick this
up automatically.** This runbook is the operator procedure for bringing one
forward.

## What this procedure is for

`provisionEventWebhook` is the single chokepoint all three tenant-facing
paths route through — initial connect (`sendgrid-key.ts`), the periodic
recheck, and the explicit reconnect button. Each one sends the platform's
current `EVENT_FLAGS` set to SendGrid (as a CREATE for a brand-new
subscription, or a PATCH in place for an existing one). Because of that,
**a code change to `EVENT_FLAGS` only reaches a given tenant's SendGrid
account the next time one of those three paths actually runs for that
tenant** — never retroactively, never in the background. A tenant who
connected their SendGrid key before this change shipped is, right now,
still subscribed to the pre-11-07 event set (no `processed`) until an
operator (or the tenant themselves, via the UI) triggers one of those three
paths again.

This is not a bug to be silently patched over — it is D-06's accepted
mechanism (see **What happens if you don't run this**, below), and this
runbook is the documented, deliberate way to close the gap when you want to.

## There is no automatic backfill

This is worth stating plainly, because it is easy to assume otherwise:
**nothing in this codebase walks every connected tenant and re-provisions
their webhook subscription automatically.** No migration, no scheduled job,
no boot-time reconciliation loop does this. The only way an existing
tenant's subscription picks up a new `EVENT_FLAGS` entry is one of the three
paths below actually executing for that specific tenant. If you want every
currently-connected tenant reprovisioned, you (or they) must trigger one of
these paths for each of them.

## How to reprovision one tenant

The tenant-facing "Переподключить" (reconnect) button is the operator-usable
entry point — it requires no direct database or SendGrid access and is safe
to run any number of times.

1. **As an operator, using the tenant's own session** (or ask the tenant to
   do this themselves — it requires the `sendgridKey:update` permission,
   i.e. workspace admin or owner):

   ```
   POST /api/workspaces/:slug/webhook-reconnect
   ```

   This is the exact same route `webhook-settings.routes.ts` registers for
   the UI's "Переподключить" action — there is no separate CLI or script for
   this procedure. It requires no request body; the route reads the
   tenant's already-stored, already-decrypted SendGrid key and its existing
   `pathToken`/`sendgridWebhookId` from `workspace_webhook_endpoints`.

   `POST /api/workspaces/:slug/sendgrid-key/recheck` (the "Проверить сейчас"
   / "check now" button, `sendgrid-key.ts`) reaches the same
   `provisionEventWebhook` chokepoint and reprovisions just as effectively —
   use whichever action is already visible to the tenant/operator; neither
   is preferred over the other.

2. **What happens on the SendGrid side:** the route calls
   `provisionEventWebhook` with the tenant's `existingWebhookId`, which
   PATCHes the platform's own named webhook (`Mega CRM Delivery Tracking
   (<workspace prefix>)`) **in place** — it does not create a second
   webhook, and it does not touch any *other* webhook the tenant may have
   configured on their own account (the platform's webhook is
   workspace-scoped by `friendly_name`, see `sendgrid-webhook-provision.ts`'s
   own doc comments). The PATCH body carries the full, current
   `EVENT_FLAGS` set — `processed: true` alongside every event type that was
   already enabled (`delivered`, `bounce`, `dropped`, `open`, `click`,
   `unsubscribe`, `group_unsubscribe`, `spam_report`). `deferred` is not
   sent and was never enabled (D-06's explicit exclusion, unaffected by this
   procedure).

3. **Expected response:**

   ```json
   {
     "connected": true,
     "provisionStatus": "active",
     "lastEventAt": "<ISO timestamp or null>",
     "provisionError": null
   }
   ```

   A `provisionStatus: "error"` response with a non-null `provisionError`
   means the PATCH failed on SendGrid's side (missing scope, plan cap, or an
   unexpected response) — the tenant's *existing* webhook subscription is
   left exactly as it was before the call (a failed PATCH updates nothing);
   retry once the underlying cause (usually an API-key scope issue) is
   resolved.

## No data is lost or resent

This procedure only ever changes which event *types* SendGrid will push to
the platform going forward — it is purely forward-looking configuration.
Specifically:

- **No historical `send_events` rows are affected.** The PATCH changes
  SendGrid's own webhook subscription record; it has no interaction with
  anything already stored in this platform's database.
- **No message is resent, no email is redelivered.** This is webhook
  *subscription* configuration, not a mail-send operation — SendGrid's
  Event Webhook only ever describes what already happened to messages that
  were already sent.
- **The webhook's signing key, path token, and URL are all unchanged.**
  `provisionEventWebhook`'s PATCH reuses the existing `pathToken` and
  `callbackUrl` — reprovisioning does not rotate or invalidate anything a
  tenant would need to reconfigure elsewhere.

## How to confirm it worked

There is no dedicated API response field exposing the enabled event-type
set (`WebhookHealthResponse` intentionally does not surface it — see
`apps/api/src/modules/webhooks/webhook-settings.routes.ts`). Confirm either
of the following, in order of preference:

1. **Directly against SendGrid**, using the tenant's own API key (the
   platform never logs or exposes this key in plaintext, so this check must
   be run by someone with access to the tenant's SendGrid account or a
   securely-shared copy of the key):

   ```bash
   curl -s -H "Authorization: Bearer <tenant's SendGrid API key>" \
     https://api.sendgrid.com/v3/user/webhooks/event/settings/<sendgridWebhookId> \
     | jq '.processed, .deferred'
   ```

   Expect `true` then `null`/absent (`processed` enabled, `deferred` never
   sent). `sendgridWebhookId` is stored on `workspace_webhook_endpoints` for
   the workspace and is also returned in the reconnect response's
   underlying `provisionEventWebhook` result (not surfaced in the HTTP
   response body today, but visible in a direct DB read for an operator
   with access).

2. **Indirectly, by observing new evidence arrive.** After a genuinely new
   send for that tenant, check whether a `processed` row appears in
   `send_events` shortly after dispatch (within seconds, not the minutes to
   hours `delivered` can take):

   ```sql
   SELECT event_type, occurred_at
   FROM send_events
   WHERE send_id = '<a recently dispatched send id>'
   ORDER BY occurred_at;
   ```

   A `processed` row appearing here confirms the reprovisioning took effect
   for this tenant — SendGrid is now actually sending that event type.

## What happens if you don't run this

A tenant who is never reprovisioned is **degraded, not broken.** The
reconciler (`apps/worker/src/queues/send-reconciler.worker.ts`'s
`resolveOneSend`) does not look for `processed` specifically — it treats
**any** row correlated to the send in `send_events` as sufficient acceptance
evidence (`SELECT 1 FROM send_events WHERE send_id = $1 LIMIT 1`). A
not-yet-reprovisioned tenant's sends still resolve out of `reconciling` once
`delivered`, `bounce`, `open`, `click`, or any other already-subscribed
event type arrives for them — just on that event's own timescale (which can
be minutes to hours for `delivered`) instead of within seconds via
`processed`. No send is left permanently stuck in `reconciling` because a
tenant skipped this procedure; it only resolves more slowly. This is D-06's
own stated design, not an oversight this runbook is patching around.

## Concurrent/repeated invocations are safe

Running this procedure twice in a row, or for a tenant who was already
reprovisioned, is a no-op beyond an identical PATCH: `provisionEventWebhook`
sends the same event-flag set either way, and SendGrid's PATCH endpoint is
idempotent for identical input. There is no lock or advisory-lock concern
here (unlike `relocate-default-partition-rows.md`'s procedure) — this is a
single outbound HTTP call per invocation, not a multi-batch data migration.
