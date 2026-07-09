---
status: diagnosed
trigger: "Connecting a live tenant SendGrid API key does NOT create the workspace-scoped Event Webhook in the tenant's SendGrid account. UAT Test 1 of Phase 05 failed."
created: 2026-07-09T00:00:00Z
updated: 2026-07-09T12:00:00Z
---

## Current Focus

hypothesis: CONFIRMED — provisioning runs but every SendGrid webhook API call returns non-ok; the typed error is swallowed at three layers (frontend ignores webhookWarning, provisioning module discards SendGrid status/body without logging, DB stores only provision_status='error' with no reason). Most probable proximate cause: restricted tenant key lacking Event Webhook management scopes (403 -> "missing_scope"); secondary: SendGrid 400-rejecting a localhost callbackUrl (no tunnel documented for UAT).
test: complete — code trace + live DB evidence + official OpenAPI spec cross-check
expecting: n/a
next_action: Return ROOT CAUSE FOUND to orchestrator (goal: find_root_cause_only)

## Symptoms

expected: After connecting a real SendGrid API key, a signed Event Webhook named 'Mega CRM Delivery Tracking (<workspace-prefix>)' appears in SendGrid -> Settings -> Mail Settings -> Event Webhook (created via documented CREATE path or the `.../settings/all` fallback — see Open Question A3 in phase docs), with signed verification enabled and other webhook entries untouched.
actual: User reported (verbatim, Russian): "Вебхука в списке нет" — the webhook does not appear in the SendGrid webhook list after connecting a live key.
errors: None reported (no visible error in UI during key connect).
reproduction: Test 1 in .planning/phases/05-webhook-processing-delivery-tracking/05-UAT.md — connect a real tenant SendGrid API key, then check the SendGrid dashboard webhook list.
started: Discovered during UAT on 2026-07-09, after Phase 05 execution and gap-closure work (recent commits touched SendGrid webhook workspace-scoping).

## Eliminated

<!-- APPEND only -->

- hypothesis: Provisioning is never invoked on key connect (missing call/feature gate)
  evidence: sendgrid-key.ts POST connect and recheck both call provisionWebhookBestEffort inside withTenant; DB row workspace_webhook_endpoints exists with UAT-day timestamps proving execution
  timestamp: 2026-07-09

- hypothesis: Stale sendgridWebhookId in DB causes PATCH-404 with no create fallback
  evidence: DB row has sendgrid_webhook_id = NULL at all times (never populated), so provisionEventWebhook took the createWebhook path, not the PATCH path
  timestamp: 2026-07-09

- hypothesis: Wrong SendGrid CREATE endpoint/method (Open Question A3 wrong)
  evidence: Official OpenAPI spec (twilio/sendgrid-oai main) confirms POST /v3/user/webhooks/event/settings = CreateEventWebhook, exactly what the code calls first; all other endpoints (list all, PATCH {id}, PATCH signed/{id}) also match
  timestamp: 2026-07-09

- hypothesis: Payload validation failure from missing event flags (processed/deferred/group_resubscribe omitted)
  evidence: Spec's EventWebhookRequest marks only `url` as required; all event booleans optional
  timestamp: 2026-07-09

- hypothesis: Create succeeded but enableSignedVerification failed (webhook exists unsigned)
  evidence: User confirmed the webhook does NOT appear in the SendGrid dashboard list at all; a successful create with failed signing would still be visible. Also sendgrid_webhook_id would still be NULL in DB only because the error path discards result.id — but dashboard absence rules the create-succeeded branch out
  timestamp: 2026-07-09

- hypothesis: Network failure / SendGrid unreachable from UAT machine
  evidence: The same session's key recheck (GET /v3/scopes + /v3/verified_senders) succeeded at 16:19:54 (status stayed 'active', last_checked_at updated)
  timestamp: 2026-07-09

## Evidence

- timestamp: 2026-07-09
  checked: .planning/debug/knowledge-base.md
  found: Does not exist — no known-pattern candidates
  implication: Proceed with fresh investigation

- timestamp: 2026-07-09
  checked: apps/api/src/modules/tenancy/sendgrid-key.ts (POST connect route)
  found: Connect route DOES call provisionWebhookBestEffort(workspace.id, apiKey) inside withTenant, after upsertKey. Provisioning failure is best-effort by design (D-01) — returns webhookWarning string in the 200 response, never fails the connect.
  implication: Provisioning is invoked; failure must be inside provisionEventWebhook or swallowed downstream. UI may not render webhookWarning — explains "no visible error".

- timestamp: 2026-07-09
  checked: apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
  found: |
    Key observations:
    1. If existingWebhookId is passed (from webhook_endpoints row), provisionEventWebhook goes STRAIGHT to PATCH /v3/user/webhooks/event/settings/{id}. A 404 (stale/nonexistent id, e.g. from earlier mocked/dev provisioning) maps to error "failed" — NO fallback to create. Webhook never created.
    2. createWebhook has a 404/405 fallback (POST .../settings/all) and friendly_name reuse guard — but that path is only reached when existingWebhookId is absent.
    3. All non-ok responses collapse to typed errors; response bodies are never logged — silent failure.
    4. callbackUrl = `${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}` — if PUBLIC_APP_URL is localhost, SendGrid may reject the URL on create.
  implication: Two strong candidate mechanisms — stale-id PATCH 404, or create rejected (URL/scope). Need DB row + env value to discriminate.

- timestamp: 2026-07-09
  checked: apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx + grep for webhookWarning in apps/web
  found: connectMutation.onSuccess shows toast.success("SendGrid подключён") and ignores data.webhookWarning entirely. Zero frontend references to webhookWarning anywhere in apps/web.
  implication: CONFIRMED silent-failure surface — any provisioning failure on connect is invisible to the user. Explains "no visible error in UI".

- timestamp: 2026-07-09
  checked: live DB — mega_crm.workspace_webhook_endpoints (read-only psql)
  found: |
    Exactly 1 row: workspace 8f518f6a-dbeb-4a25-b0cc-1b0ee713923f,
    sendgrid_webhook_id = NULL, provision_status = 'error', public_key = NULL,
    created 2026-07-09 16:19:43, updated 2026-07-09 16:20:17 (two failed attempts ~34s apart — connect, then likely the Test-3 "enable tracking" retry).
  implication: |
    Provisioning WAS invoked and returned a typed { error } both times.
    Since sendgrid_webhook_id was NULL at first attempt, provisionEventWebhook took the createWebhook path (not stale-id PATCH).
    ELIMINATES hypothesis (a) stale-id PATCH-404.
    Remaining branches inside createWebhook: POST create rejected (400 payload/URL, 401/403 scope), or create succeeded but enableSignedVerification failed (would still show webhook in dashboard — user says list is empty, so create itself failed).

- timestamp: 2026-07-09
  checked: Official SendGrid OpenAPI spec (twilio/sendgrid-oai, spec/json/tsg_webhooks_v3.json, fetched from GitHub main)
  found: |
    POST /v3/user/webhooks/event/settings = CreateEventWebhook — the code's primary path is CORRECT per current spec (Open Question A3 resolves in favor of the implemented path; the .../settings/all fallback is a POST to a GET-only route and would never succeed, but is also never needed).
    EventWebhookRequest requires ONLY `url`; all event booleans optional. Code payload (enabled, url, friendly_name, 8 event flags) is spec-valid.
    PATCH .../signed/{id} response = { id, public_key } — matches code's parsing.
  implication: ELIMINATES wrong-endpoint and payload-shape hypotheses. Failure must be an HTTP-level rejection: 401/403 (scope) or 400 (server-side URL/value validation).

- timestamp: 2026-07-09
  checked: Cross-evidence from concurrent session .planning/debug/enable-delivery-tracking-error.md (read-only) + workspace_sendgrid_keys row
  found: |
    Tenant key created 2026-07-04 (pre-Phase-5), status='active', last_checked_at=2026-07-09 16:19:54 — the recheck DECRYPTED and LIVE-VALIDATED the key successfully during the same UAT session (GET /v3/scopes returned ok, mail.send present).
    Timeline: endpoint row created 16:19:43 (attempt 1, error), key rechecked ok 16:19:54, endpoint updated 16:20:17 (attempt 2+, error — likely the Test-3 reconnect click).
  implication: Outbound network to api.sendgrid.com works; the key is live and valid for mail.send. Only the webhook-settings API family fails. Strongly consistent with a restricted key lacking user.webhooks.event.settings.* scopes (403 on every webhook call, deterministic across all attempts).

- timestamp: 2026-07-09
  checked: apps/api/src/modules/tenancy/sendgrid-client.ts validateTenantSendGridKey + 05-VERIFICATION.md line 19 + .env.example (via git show) + phase docs grep for tunnel setup
  found: |
    1. validateTenantSendGridKey fetches the FULL scopes list (GET /v3/scopes) but checks ONLY "mail.send" — webhook-management scopes are never verified at connect time, even though they are a hard prerequisite for provisioning.
    2. 05-VERIFICATION.md explicitly states live verification "Requires a live tenant SendGrid API key with webhook-management scope; not available in an automated verification run" — the A3 live smoke test recommended by 05-RESEARCH.md was never performed; all provisioning tests use a fetch-mock harness.
    3. Tracked .env.example contains NO PUBLIC_APP_URL entry; env.ts requires it (z.string().url(), no default). No tunnel (ngrok/cloudflared) setup is documented anywhere in phase docs — a local UAT almost certainly used a localhost URL as the webhook callback, which at minimum guarantees Test 2 (live events arriving) could never pass, and may itself be rejected by SendGrid create (400).
    4. Platform's own connect-error copy instructs users to create a key "с доступом Mail Send" — nudging exactly toward a restricted Mail-Send-only key that lacks webhook scopes; the WEBHOOK_MISSING_SCOPE_WARNING copy shows this failure mode was anticipated but its surfacing was never wired to the UI.
  implication: Root cause chain complete. Primary proximate cause ranked: (1) key lacks webhook scopes -> 403 -> "missing_scope"; (2) localhost callbackUrl rejected -> 400 -> "failed". Both are indistinguishable today because the SendGrid response status/body is discarded unlogged and the typed error category is not persisted.



## Resolution

root_cause: |
  CONFIRMED MECHANISM: Webhook provisioning IS invoked on key connect/recheck/reconnect, but every
  SendGrid Event Webhook API call returned a non-ok response (>=3 attempts on 2026-07-09:
  16:19:43, ~16:19:54, 16:20:17 — DB: workspace_webhook_endpoints.provision_status='error',
  sendgrid_webhook_id=NULL, public_key=NULL), so the webhook was never created. The failure is
  invisible by design gaps at THREE layers:
    L1 (frontend): POST connect/recheck return HTTP 200 + `webhookWarning`, but apps/web has ZERO
        references to webhookWarning — SendGridKeySettings.tsx shows toast.success("SendGrid
        подключён") unconditionally. 05-04-PLAN.md required the graceful message to be surfaced;
        it was implemented server-side only.
    L2 (provisioning module): sendgrid-webhook-provision.ts maps every non-ok response to a typed
        error WITHOUT logging status or response body (only unexpected exceptions are logged) —
        no diagnostics exist anywhere.
    L3 (persistence): only provision_status='error' is stored; the typed error category
        (missing_scope / cap_reached / failed) is discarded.
  PROXIMATE CAUSE (ranked, needs one live repro with logging to pin the status code):
    (1) MOST PROBABLE: the tenant's BYO key (connected 2026-07-04, pre-Phase-5, under the
        platform's own "ключ с доступом Mail Send" guidance) is a restricted key WITHOUT the
        Event Webhook management scopes -> 401/403 on all /v3/user/webhooks/event/settings*
        calls -> "missing_scope". validateTenantSendGridKey already fetches the full scopes list
        but only checks "mail.send" — webhook scopes are never verified or communicated at
        connect time, and 05-VERIFICATION.md confirms live provisioning with a
        webhook-management-scoped key was never exercised (fetch-mock tests only; the A3 live
        smoke test recommended by 05-RESEARCH.md never happened).
    (2) SECONDARY: PUBLIC_APP_URL in the local UAT env is almost certainly a localhost URL
        (.env.example doesn't even define PUBLIC_APP_URL; no tunnel setup documented anywhere) —
        SendGrid may reject it at create (400 -> "failed"); even if accepted, live events
        (UAT Test 2) could never arrive at a non-public URL.
fix: ""
verification: ""
files_changed: []
