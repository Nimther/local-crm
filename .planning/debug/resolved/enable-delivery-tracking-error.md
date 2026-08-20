---
status: resolved
trigger: "enable-delivery-tracking-error: For an already-connected (pre-Phase-5) workspace, attempting to enable delivery tracking from the onboarding checklist ('Включить отслеживание доставки') returns an error. UAT Test 3 of Phase 05 failed."
created: 2026-07-09T10:00:00Z
updated: 2026-07-09T10:45:00Z
---

## Current Focus

hypothesis: CONFIRMED — enable-tracking (POST /webhook-reconnect) runs end-to-end but SendGrid webhook provisioning fails on every attempt in this environment; the callback URL handed to SendGrid is http://localhost:4000/... (non-public), and the failure surfaces to the user as the error badge while the route returns 200 and the toast claims success. Same underlying defect as UAT Test 1, plus a Test-3-specific error-presentation defect.
test: DB state inspection (workspace_webhook_endpoints/workspace_sendgrid_keys), full code trace of reconnect path, live process env inspection, SendGrid API contract research
expecting: n/a — diagnosis complete (goal: find_root_cause_only)
next_action: Return ROOT CAUSE FOUND to orchestrator

reasoning_checkpoint:
  hypothesis: "provisionEventWebhook fails with a typed {error} on every enable-tracking attempt because the SendGrid create call is rejected — the callbackUrl is built from PUBLIC_APP_URL=http://localhost:4000 (non-publicly-reachable), with an unverifiable-webhook-scope key as the compounding/alternate candidate; the code then persists provision_status='error' silently and the user sees an error state"
  confirming_evidence:
    - "DB: workspace_webhook_endpoints row for workspace 8f518f6a — provision_status='error', sendgrid_webhook_id=NULL, public_key=NULL after >=2 handler executions (created 16:19:43, updated 16:20:17)"
    - "Live dev server process env (ps eww): PUBLIC_APP_URL=http://localhost:4000 — callbackUrl sent to SendGrid was http://localhost:4000/webhooks/sendgrid/<token>"
    - "Key itself is healthy: recheck at 16:19:54 decrypted the pre-Phase-5 key and live-validated it (status='active') — so requirePermission/KMS/RLS/network all work; only the webhook create fails"
  falsification_test: "If SendGrid dashboard/API showed the webhook WAS created (sendgrid_webhook_id non-NULL or webhook visible in list), or if provision succeeded with a public URL and the error persisted, the URL/scope hypothesis would be wrong"
  fix_rationale: "n/a — diagnose-only mode; fix direction documented in Resolution"
  blind_spots: "Cannot discriminate WHICH SendGrid rejection occurred (400 invalid-url vs 401/403 missing-scope vs cap_reached vs A3 path 404/405) because sendgrid-webhook-provision.ts discards the non-ok response status/body and even the typed error is not persisted — this observability gap is itself part of the diagnosis"

## Symptoms

expected: For a workspace whose SendGrid key was connected before Phase 5, the onboarding checklist shows an 'Включить отслеживание доставки' item linking to SendGrid settings; enabling/reconnecting tracking succeeds and the checklist item flips to done.
actual: "при попытке включения отслеживания возвращается ошибка" — attempting to enable tracking returns an error.
errors: An error is returned/displayed when triggering the enable-tracking action; exact message not captured.
reproduction: Test 3 in .planning/phases/05-webhook-processing-delivery-tracking/05-UAT.md — pre-Phase-5 connected workspace → onboarding checklist → enable delivery tracking.
started: Discovered during UAT on 2026-07-09, after Phase 05 execution and gap-closure work (recent commits touched SendGrid webhook workspace-scoping). Note: UAT Test 1 also failed (webhook never provisioned on fresh connect) — may be same or related defect.

## Eliminated

- hypothesis: Migration 0021 (workspace_webhook_endpoints) not applied to UAT DB, so reconnect 500s on 'relation does not exist'
  evidence: Local dev DB (mega_crm on localhost:5432, non-docker Postgres) has the table; drizzle migrations through 0024 applied; a webhook endpoint row was actually written during UAT
  timestamp: 2026-07-09T10:20:00Z

- hypothesis: KMS decryptTenantSecret throws for pre-Phase-5 encrypted keys (AAD/format mismatch) causing 500
  evidence: workspace_sendgrid_keys.last_checked_at=2026-07-09 16:19:54 with status='active' — recheck decrypted the 2026-07-04 key and live-validated it successfully during the same UAT session
  timestamp: 2026-07-09T10:20:00Z

- hypothesis: Reconnect route not registered (404) so button click errors
  evidence: server.ts:88 registers registerWebhookSettingsRoutes; endpoint row was created/updated by the reconnect handler at 16:19:43/16:20:17 — the route executed
  timestamp: 2026-07-09T10:20:00Z

## Evidence

- timestamp: 2026-07-09T10:05:00Z
  checked: Frontend flow — OnboardingChecklist.tsx → links to /w/{slug}/settings/sendgrid → WebhookHealthCard in SendGridKeySettings.tsx → reconnectWebhook() → POST /api/workspaces/:slug/webhook-reconnect
  found: reconnectMutation.onError only fires on non-2xx (ApiError from apiFetch). A SendGrid provisioning failure returns HTTP 200 with provisionStatus:'error' → frontend shows SUCCESS toast but KeyStatusBadge flips to 'error' (badgeStatus = provisionStatus==='error' ? 'error' : ...)
  implication: 'возвращается ошибка' is most plausibly the error badge/state after clicking enable — OR a non-2xx; needed DB evidence to distinguish

- timestamp: 2026-07-09T10:20:00Z
  checked: Live local dev DB (mega_crm) — workspace_webhook_endpoints + workspace_sendgrid_keys rows
  found: |
    workspace 8f518f6a-dbeb-4a25-b0cc-1b0ee713923f:
    - sendgrid key created 2026-07-04 (pre-Phase-5), status='active', last_checked_at=2026-07-09 16:19:54 (recheck succeeded during UAT)
    - webhook endpoint row: created 2026-07-09 16:19:43, updated 16:20:17, provision_status='error', sendgrid_webhook_id=NULL, public_key=NULL
  implication: The reconnect route ran end-to-end (no 500, row persisted) but provisionEventWebhook returned a typed {error} on EVERY attempt (>=2 attempts over 34s). The failure is in the SendGrid API call layer (create/patch never succeeded — webhook id never stored). Same underlying failure explains Test 1 (webhook absent in SendGrid dashboard).

- timestamp: 2026-07-09T10:30:00Z
  checked: Reconnect route error semantics (webhook-settings.routes.ts lines 96-119) vs frontend (SendGridKeySettings.tsx lines 79-97)
  found: On provisioning failure the route returns HTTP 200 {connected:false, provisionStatus:'error'}; reconnectMutation.onSuccess unconditionally shows toast.success('Отслеживание доставки переподключено') AND invalidates the health query, whose refetch flips KeyStatusBadge to 'error' (badgeStatus derivation line 97). The typed ProvisionEventWebhookError (missing_scope/cap_reached/failed) is DISCARDED by the reconnect handler — unlike connect/recheck which at least map it to webhookWarning strings (which the web UI in turn never renders; zero references to webhookWarning in apps/web, and KeyMutationResponse omits the field).
  implication: The user-visible 'ошибка' in Test 3 = the error badge/never-completing state after clicking enable; the success toast simultaneously lies. 05-04-PLAN Task 2 explicitly required 'a graceful, non-fatal message' and 05-RESEARCH (lines 39/53) required 'понятная ошибка с объяснением' for scope failures — neither reaches the user. Implementation gap vs plan intent.

- timestamp: 2026-07-09T10:35:00Z
  checked: sendgrid-webhook-provision.ts observability
  found: errorForStatus() collapses every non-ok SendGrid response to a typed string; response status and body are never logged (only genuinely-thrown exceptions hit console.error). upsertWebhookEndpoint persists only provision_status='error', discarding even the typed discriminator.
  implication: The exact SendGrid rejection (400 invalid url vs 401/403 scope vs cap vs A3 path 404/405) is unrecoverable from this UAT run. Observability gap — all four candidate failure modes are indistinguishable after the fact.

- timestamp: 2026-07-09T10:40:00Z
  checked: PUBLIC_APP_URL in the actual UAT environment — live dev server process env (ps eww on tsx src/server.ts pids, --env-file=../../.env) + phase-04 artifacts (04-REVIEW.md line 183, 04-16-SUMMARY.md line 127)
  found: PUBLIC_APP_URL=http://localhost:4000 in the running API/worker processes. callbackUrl passed to SendGrid create = http://localhost:4000/webhooks/sendgrid/<64-char-token>.
  implication: SendGrid was asked to create an Event Webhook pointing at a localhost URL. This is the leading candidate for the create rejection, and even if creation had succeeded, no signed event could ever reach localhost — the environment cannot pass Tests 1-3 as configured. Live UAT requires a public tunnel (ngrok etc.) + matching PUBLIC_APP_URL.

- timestamp: 2026-07-09T10:42:00Z
  checked: Connect-time scope validation (sendgrid-client.ts validateTenantSendGridKey) + 05-VERIFICATION.md why_human
  found: Key validation checks only that scopes include 'mail.send' — webhook-management scopes are never verified. 05-VERIFICATION itself notes the test 'Requires a live tenant SendGrid API key with webhook-management scope'. Research assumption A3 (exact CREATE path POST /v3/user/webhooks/event/settings, medium confidence, 'recommend live smoke test') was never live-verified; current Twilio docs do list 'Create an Event Webhook' at that path, so A3 is probably correct but remains unconfirmed against this account/plan.
  implication: A pre-Phase-5 key created only for mail sending would fail provisioning with 403→'missing_scope' — the alternate/compounding root-cause candidate. Cannot be discriminated from the URL rejection without logs (see observability gap) or a live retry.

- timestamp: 2026-07-09T10:43:00Z
  checked: Cross-reference with sibling debug session (.planning/debug/sendgrid-webhook-not-provisioned.md, Test 1)
  found: Sibling session independently reached the same DB evidence and eliminated the stale-id PATCH-404 branch (sendgrid_webhook_id was NULL at first attempt, so createWebhook path was taken). Only ONE workspace has a key — Tests 1 and 3 exercised the same workspace and the same failing provisioning call.
  implication: Test 3 shares Test 1's underlying defect (provisioning fails silently in this environment). Test 3 additionally exposes the distinct error-presentation defect (200-with-error + success toast + discarded typed reason).

## Resolution

root_cause: |
  SAME underlying defect as UAT Test 1, PLUS a distinct error-presentation defect specific to Test 3.

  (1) Underlying failure (shared with Test 1): every enable-tracking attempt executes
  provisionEventWebhook, whose SendGrid create call fails and returns a typed {error};
  the row is persisted as provision_status='error' with sendgrid_webhook_id=NULL and
  public_key=NULL (confirmed in live DB, >=2 attempts 16:19:43-16:20:17 on 2026-07-09).
  Leading cause: the callback URL handed to SendGrid is built from
  PUBLIC_APP_URL=http://localhost:4000 (confirmed in the running dev server env) — a
  non-publicly-reachable localhost URL; SendGrid either rejects it at create, or — even
  if accepted — could never deliver events to it, so the environment cannot pass this
  test as configured. Compounding/alternate candidate: the pre-Phase-5 tenant key was
  only ever validated for 'mail.send' (sendgrid-client.ts) — webhook-management scope
  is never checked, so a scope-lacking key fails with 403→'missing_scope'. The exact
  SendGrid rejection cannot be recovered because sendgrid-webhook-provision.ts logs
  nothing for non-ok responses and the typed error discriminator is not persisted.

  (2) Test-3-specific defect: webhook-settings.routes.ts returns HTTP 200 with
  provisionStatus:'error' when provisioning fails; the frontend reconnectMutation
  then shows toast.success('Отслеживание доставки переподключено') while the health
  badge flips to 'Ошибка' and the checklist item never completes. The typed error
  (missing_scope/cap_reached/failed) is discarded by the reconnect handler, and the
  webhookWarning strings produced by connect/recheck are never rendered anywhere in
  apps/web. 05-04-PLAN Task 2 and 05-RESEARCH (lines 39/53) explicitly required a
  clear user-facing message on provisioning failure — never implemented end-to-end.
fix: n/a — diagnose-only session (goal: find_root_cause_only)
verification: n/a
files_changed: []

## Closure Note (milestone v1.0 close)

Resolved at v1.0 milestone close on 2026-07-14: diagnosis was handed to plan-phase --gaps; fix shipped via gap-closure plans (see phase 01/04/05/06 gap plans) or recorded as external-env tech debt in v1.0-MILESTONE-AUDIT.md.
