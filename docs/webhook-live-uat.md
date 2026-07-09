# Live Webhook UAT Runbook (Phase 5)

This runbook documents the environmental preconditions required to run the
Phase 5 (`webhook-processing-delivery-tracking`) live UAT — Tests 1, 2, and 3
in `.planning/phases/05-webhook-processing-delivery-tracking/05-UAT.md` — with
a real tenant SendGrid account. Skipping either precondition below (public
`PUBLIC_APP_URL` or a correctly-scoped SendGrid key) makes it **impossible**
for the live UAT to pass, regardless of application code correctness — this
is exactly what happened during the first live UAT attempt (see
`.planning/debug/sendgrid-webhook-not-provisioned.md` and
`.planning/debug/enable-delivery-tracking-error.md`).

## Why `localhost` fails

When a tenant connects (or reconnects) their SendGrid API key, the platform
asks SendGrid to create/PATCH an Event Webhook whose callback URL is:

```
${PUBLIC_APP_URL}/webhooks/sendgrid/<pathToken>
```

(see `apps/api/src/modules/tenancy/sendgrid-key.ts`). SendGrid's servers call
this URL directly from the public internet to deliver `processed` /
`delivered` / `open` / `click` / `bounce` / etc. events. If `PUBLIC_APP_URL`
is `http://localhost:4000` (the default for local dev), SendGrid cannot reach
it:

- The create/PATCH call may be rejected outright (SendGrid validates the URL
  is a well-formed, reachable-looking address).
- Even if the webhook is created, no live event can ever be delivered to a
  URL that only resolves inside your own machine — so Test 2 (a live signed
  event landing) can never pass.

**A public tunnel is a hard precondition for this UAT, not an optional
convenience.**

## Step 1 — Start a public tunnel

Pick one:

```bash
ngrok http 4000
```

or

```bash
cloudflared tunnel --url http://localhost:4000
```

Both print an `https://...` forwarding URL that proxies to your local API
server (port 4000). Copy that URL.

## Step 2 — Point `PUBLIC_APP_URL` at the tunnel

Set `PUBLIC_APP_URL` in `.env` to the tunnel's `https://` URL (no trailing
slash), for example:

```
PUBLIC_APP_URL=https://a1b2c3d4.ngrok-free.app
```

Then restart `npm run dev` so both the API and worker processes pick up the
new value — both read `PUBLIC_APP_URL` at boot, not per-request.

> The tunnel URL changes every time you restart a free-tier `ngrok`/
> `cloudflared` session. If you restart the tunnel, update `PUBLIC_APP_URL`
> and restart `npm run dev` again, then reconnect/re-provision the webhook
> (Step 3.1) so SendGrid is pointed at the new URL.

`scripts/check-env.mjs` (the `predev` env checker) will print a non-fatal
warning if it detects `PUBLIC_APP_URL` still points at `localhost` or
`127.0.0.1` — see that file for the exact check. The warning does not block
`npm run dev`, since localhost is perfectly fine for every other feature;
it only breaks live webhook delivery.

## Step 3 — Use a SendGrid key with the correct scopes

The tenant's BYO SendGrid API key MUST have **both**:

- **Mail Send** — required to send email at all.
- **Event Webhook** management scope (SendGrid calls this **Mail Settings ->
  Event Webhook** access when creating a Restricted Access key) — required
  to create/read/PATCH the Event Webhook configuration.

A key restricted to Mail Send only will connect successfully (mail sending
works, `validateTenantSendGridKey` only checks `mail.send`) but webhook
provisioning will fail with a `missing_scope` error — surfaced in the UI as
a warning after connect/reconnect (added in 05-08/05-09).

### Creating a correctly-scoped key

1. SendGrid Dashboard -> **Settings -> API Keys -> Create API Key**.
2. Choose **Restricted Access**.
3. Enable:
   - **Mail Send** — Full Access.
   - **Mail Settings** -> **Event Webhook** (sometimes labeled "Event
     Notification" depending on SendGrid's current UI) — Full Access.
4. Create the key and paste it into the workspace's SendGrid settings page
   in the app (Settings -> SendGrid).

## Step 3.1 — (Re)provisioning after a config change

Any time you change `PUBLIC_APP_URL` or the connected key, provisioning must
run again so the webhook's `url` field points at the current tunnel:

- **Fresh connect:** paste the key in Settings -> SendGrid — provisioning
  runs automatically.
- **Already connected:** use the **Reconnect** action on the webhook-health
  card, or the onboarding checklist's "Включить отслеживание доставки" item.

## Test procedure (maps to 05-UAT.md Tests 1-3)

### Test 1 — Live key connect provisions the workspace-scoped Event Webhook

1. With the tunnel running and `PUBLIC_APP_URL` set to the tunnel URL,
   connect a correctly-scoped tenant SendGrid key (Step 3) in Settings ->
   SendGrid.
2. In the SendGrid dashboard, go to **Settings -> Mail Settings -> Event
   Webhook** and confirm a webhook named `Mega CRM Delivery Tracking
   (<workspace-prefix>)` exists, is enabled, and has **Signed Event Webhook
   Requests** turned on.
3. Confirm any pre-existing webhook entries on the tenant's account are
   untouched.

### Test 2 — Webhook-health card reflects a live signed event

1. From the app, trigger a real send (e.g. a test send from a campaign, or
   any flow/broadcast email) to an address you control.
2. Open/refresh the SendGrid settings page and watch the webhook-health
   card: once SendGrid delivers a real signed event to the tunnel, "Последнее
   событие получено" should populate with a non-null relative time.
3. Click **Reconnect** — the card should refresh without error.

### Test 3 — Onboarding checklist enables delivery tracking

1. On an already-connected (pre-Phase-5) workspace, open the onboarding
   checklist and confirm the "Включить отслеживание доставки" item is
   present and links to SendGrid settings when incomplete.
2. Trigger enable/reconnect for that workspace's key (Step 3.1).
3. Confirm the checklist item flips to done once `connected &&
   provisionStatus === 'active'`.

## If provisioning still fails

As of 05-08/05-09, a failed provisioning attempt surfaces its typed reason
(`missing_scope`, `cap_reached`, or `failed`) in the UI instead of failing
silently. If you still see an error after following this runbook:

1. Check the reported reason in the UI first.
2. Check the API process logs — 05-08 added logging of the redacted SendGrid
   response status + body for every non-ok provisioning call, which should
   pinpoint the exact rejection (e.g. a 403 scope error vs a 400 URL
   validation error).
3. Re-verify `PUBLIC_APP_URL` is the *current* tunnel URL (tunnels rotate
   URLs on restart — see the note in Step 2) and that the key's scopes
   still include Event Webhook management.

## Security note

- The tunnel makes your local webhook receiver reachable from the public
  internet for the duration of the UAT. This is expected and required for a
  *live* webhook test — but every inbound event is ECDSA-signature-verified
  against the raw request body before any processing occurs. **Do not
  disable signed-event verification** to "make it easier" to test; doing so
  removes the only authentication the receiver has for inbound requests.
- **Never paste a real tenant SendGrid API key into this file, a commit, an
  issue, or any other committed artifact.** Treat it exactly like a
  production credential. Use a scratch/test SendGrid account for UAT if at
  all possible, and revoke/rotate the key afterward if it was ever typed
  into a shared terminal or screen-share.
