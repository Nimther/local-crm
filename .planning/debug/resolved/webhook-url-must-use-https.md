---
status: resolved
trigger: "UAT round 4 (Phase 05) tests 1-2: webhook provisioning fails — SendGrid 400 'webhook url must use https'; webhook silently absent from SendGrid dashboard with no UI warning"
created: 2026-07-09T14:30:00Z
updated: 2026-07-09T14:50:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — see Resolution.root_cause
test: complete
expecting: —
next_action: "Return diagnosis to orchestrator (goal: find_root_cause_only); plan-phase --gaps owns the fix"

reasoning_checkpoint:
  hypothesis: "PUBLIC_APP_URL in the live-run environment was an http:// URL (dev default http://localhost:4000 — .env not updated to the tunnel URL, or npm run dev not restarted, since the value is read once at boot). The code has NO https-scheme guard anywhere (env.ts accepts any url; check-env.mjs warns only on localhost, and only about reachability; provisionWebhookBestEffort builds callbackUrl and calls SendGrid unconditionally), so the doomed create POST was made, SendGrid rejected it 400 'webhook url must use https', errorForStatus(400) collapsed it into the untyped 'failed' bucket, and the only user-visible signal was the generic non-actionable 'Попробуйте переподключить ключ позже' copy (a transient toast + component-state inline text) that never mentions the URL/scheme problem — while the primary 'SendGrid подключён' success toast fired first."
  confirming_evidence:
    - "SendGrid's own 400 response body ('webhook url must use https') directly proves the callbackUrl sent had a non-https scheme — and callbackUrl is `${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}` (sendgrid-key.ts:63, webhook-settings.routes.ts:113), so env.PUBLIC_APP_URL was http:// at runtime"
    - "env.ts:31 validates PUBLIC_APP_URL as z.string().url() only (http passes); check-env.mjs:94-99 warns non-fatally on localhost/127.0.0.1 only — no scheme check exists anywhere; sendgrid-webhook-provision.ts has zero URL validation before the POST"
    - "errorForStatus (sendgrid-webhook-provision.ts:80-82) maps only 401/403 → missing_scope; a 400 → generic 'failed' → WEBHOOK_PROVISION_FAILED_WARNING ('не удалось автоматически настроить вебхук... Попробуйте переподключить ключ позже') — rendered as toast.warning + inline amber (SendGridKeySettings.tsx:195-199, 318) but generic and non-actionable"
  falsification_test: "If PUBLIC_APP_URL had been the https tunnel URL at the time of the create call, SendGrid could not have returned 'webhook url must use https' — the 400 body is dispositive. If a scheme guard existed, no create call would have been logged at all."
  fix_rationale: "N/A — diagnose-only mode; fix direction handed to plan-phase --gaps"
  blind_spots: "Cannot read .env (tool-denied on .env* paths) to confirm the exact http value (localhost default vs. an http:// tunnel URL vs. stale value pre-restart) — but the specific value doesn't change the root cause. Also cannot confirm whether the user visually noticed the amber toast for test 1; the code provably emits it, but it's transient and generic."

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: |
  Test 1: Connecting a live SendGrid key provisions a signed 'Mega CRM Delivery Tracking (<workspace-prefix>)' Event Webhook visible in the SendGrid dashboard, other webhooks untouched, no warning in UI.
  Test 2: Webhook provisioning succeeds at connect time (and for a scope-limited key, an amber 'missing_scope' warning renders with no doomed SendGrid API call).
actual: |
  Test 1 (major): "вебхук отсутствует в сендгриде" — webhook absent in SendGrid, NO visible error/warning in the UI.
  Test 2 (blocker): "Вебхуки не подключаются. в консоли npm ошибка [api] provisionEventWebhook [create] non-ok response: 400 {\"errors\":[{\"field\":null,\"message\":\"webhook url must use https\"}]}"
errors: '[api] provisionEventWebhook [create] non-ok response: 400 {"errors":[{"field":null,"message":"webhook url must use https"}]}'
reproduction: "Tests 1-2 in 05-UAT.md — connect a real SendGrid API key during live UAT (docs/webhook-live-uat.md instructs running behind a public https tunnel with PUBLIC_APP_URL set)"
started: "Discovered UAT round 4 (2026-07-09), after gap-closure rounds 2-3 (plans 05-08..05-11) fixed prior webhook issues"

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: "The frontend swallows the webhookWarning entirely (create failure surfaces NO warning anywhere)"
  evidence: "SendGridKeySettings.tsx:189-199 connect onSuccess calls webhookNoticeForKeyResponse(data) and fires toast.warning(warning) + sets inline amber state (line 318); webhook-settings.routes.ts:32-37 maps stored provisionError through webhookWarningFor for the persistent health card; reconnectToastForHealth shows toast.error. A warning IS emitted — the real gap is that the 400 collapses into the generic non-actionable 'failed' copy, and the primary 'SendGrid подключён' success toast fires first."
  timestamp: 2026-07-09T14:45:00Z

- hypothesis: "05-09's missing_scope short-circuit regressed, causing the doomed call for the scope-limited key in test 2"
  evidence: "sendgrid-key.ts:47-60 still short-circuits when webhookScopePresent is false (persists 'missing_scope', no SendGrid call); sendgrid-client.ts:65 detects the scope via prefix 'user.webhooks.event.settings'. Moreover, a 400 body-validation rejection (not 401/403) proves the create request PASSED authorization — the key used in the observed run had the webhook scope. Test 2 as executed degenerated into the same https failure; the scope-limited scenario was never actually reached."
  timestamp: 2026-07-09T14:45:00Z

- hypothesis: "The webhook URL construction drops the scheme or points at the wrong path (indirection bug between writer and consumer)"
  evidence: "Both call sites build callbackUrl identically as `${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}` (sendgrid-key.ts:63, webhook-settings.routes.ts:113) — the scheme is passed through verbatim from PUBLIC_APP_URL; nothing strips https. The scheme in the request equals the scheme in the env var."
  timestamp: 2026-07-09T14:45:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-07-09T14:30:00Z
  checked: docs/webhook-live-uat.md
  found: "Runbook says webhook callback URL = ${PUBLIC_APP_URL}/webhooks/sendgrid/<pathToken> (apps/api/src/modules/tenancy/sendgrid-key.ts); default local dev value is http://localhost:4000; check-env.mjs warns (non-fatal) when PUBLIC_APP_URL points at localhost; both api and worker read PUBLIC_APP_URL at boot, not per-request"
  implication: "URL derives from PUBLIC_APP_URL env var; if unset or left at default, webhook URL is http:// and SendGrid rejects it"

- timestamp: 2026-07-09T14:35:00Z
  checked: apps/api/src/modules/tenancy/sendgrid-key.ts (lines 39-95, 170-190)
  found: "provisionWebhookBestEffort builds callbackUrl = `${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}` with NO scheme check; on provisioning {error} it persists provisionStatus:'error'/provisionError and returns webhookWarningFor(error); connect POST spreads `...(webhookWarning ? { webhookWarning } : {})` into the 200 response"
  implication: "Server-side, the 400 DOES produce a webhookWarning string on the connect response — if the user saw nothing, the gap is in the frontend rendering (or user connected before 05-09 wiring)"

- timestamp: 2026-07-09T14:35:00Z
  checked: apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts
  found: "errorForStatus maps ONLY 401/403 -> missing_scope, everything else (incl. 400 'webhook url must use https') -> generic 'failed'; no https/scheme validation of callbackUrl anywhere before the POST to SendGrid; the doomed create call is always attempted"
  implication: "The http URL is rejected by SendGrid at create time, mapped to untyped 'failed' -> generic 'попробуйте переподключить позже' copy that never tells the user the URL is http"

- timestamp: 2026-07-09T14:35:00Z
  checked: apps/api/src/env.ts line 31
  found: "PUBLIC_APP_URL: z.string().url() — accepts http:// URLs without complaint; the superRefine block only guards KMS_PROVIDER, nothing URL-scheme related"
  implication: "No boot-time guard forces https for PUBLIC_APP_URL"

- timestamp: 2026-07-09T14:40:00Z
  checked: apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx (connect/recheck mutations, WebhookHealthCard)
  found: "connect onSuccess fires toast.success('SendGrid подключён') FIRST, then toast.warning(webhookWarning) if present + inline amber <p> (line 318, component useState — lost on refresh/navigation); WebhookHealthCard shows KeyStatusBadge 'error' + webhookHealthDescription (the persistent mapped copy) when provisionStatus==='error'"
  implication: "A warning IS rendered on the current tip — but it's the generic WEBHOOK_PROVISION_FAILED_WARNING ('Попробуйте переподключить ключ позже'), which is non-actionable for an http URL (retrying can never succeed) and easily read as a soft/transient hiccup next to the success toast"

- timestamp: 2026-07-09T14:42:00Z
  checked: apps/api/src/modules/webhooks/webhook-settings.routes.ts (health GET + reconnect POST)
  found: "provisionErrorMessage maps stored typed provisionError through webhookWarningFor before returning; reconnect also builds callbackUrl from env.PUBLIC_APP_URL identically (line 113) — so Reconnect retries hit the SAME http URL and fail the same way"
  implication: "The runbook's recovery advice (click Reconnect after fixing PUBLIC_APP_URL) only works after a process restart — env is read once at boot; without restart every reconnect re-sends the stale http URL"

- timestamp: 2026-07-09T14:43:00Z
  checked: apps/api/src/modules/tenancy/sendgrid-client.ts (validateTenantSendGridKey)
  found: "webhookScopePresent = scopes.some(startsWith('user.webhooks.event.settings')); the 05-09 short-circuit for scope-limited keys is intact in sendgrid-key.ts:47-60"
  implication: "The observed create 400 (a body-validation error, not 401/403) means the run's key HAD the webhook scope — test 2's scope-limited scenario was never actually exercised; both test failures share the single https root cause"

- timestamp: 2026-07-09T14:44:00Z
  checked: scripts/check-env.mjs lines 60-99
  found: "PUBLIC_APP_URL is presence-checked only; the localhost/127.0.0.1 regex warning is non-fatal and about REACHABILITY — a non-localhost http:// URL (e.g. a mistyped tunnel URL) would trigger no warning at all; scheme is never checked"
  implication: "No layer of the system (boot schema, predev check, pre-flight) enforces or even mentions the https requirement SendGrid imposes on webhook URLs"

- timestamp: 2026-07-09T14:45:00Z
  checked: ".env / .env.example (attempted)"
  found: "Tool access to .env* paths is hard-denied in this environment (per STATE.md operational note + observed Bash permission denial)"
  implication: "The exact runtime value of PUBLIC_APP_URL is unverifiable directly, but SendGrid's 400 'webhook url must use https' response proves it was http:// — most plausibly the dev default http://localhost:4000 (never updated to the tunnel URL, or updated without restarting npm run dev, since both API and worker read it once at boot)"

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: |
  Single root cause behind both UAT gaps (tests 1-2), with two compounding code gaps:

  (a) WHY THE URL WAS HTTP: The webhook callback URL is built verbatim as
  `${env.PUBLIC_APP_URL}/webhooks/sendgrid/${pathToken}` (apps/api/src/modules/tenancy/sendgrid-key.ts:63
  and apps/api/src/modules/webhooks/webhook-settings.routes.ts:113). During the live UAT run,
  PUBLIC_APP_URL was an http:// URL — SendGrid's 400 response body ("webhook url must use https") is
  direct proof. Most plausibly it was still the dev default http://localhost:4000: either .env was never
  updated to the tunnel's https URL, or it was updated without restarting `npm run dev` (env is read once
  at boot, per docs/webhook-live-uat.md). The exact value is unverifiable (.env* tool-denied) but
  immaterial: no layer enforces https — env.ts:31 accepts any z.string().url(), and check-env.mjs's
  non-fatal warning (lines 94-99) fires only on localhost/127.0.0.1 and speaks of reachability, never the
  https requirement.

  (b) WHY NO ACTIONABLE WARNING SURFACED: There is no pre-flight https/scheme validation before the
  SendGrid call — provisionWebhookBestEffort makes the doomed POST unconditionally. errorForStatus
  (sendgrid-webhook-provision.ts:80-82) maps only 401/403 to a typed reason; the 400 collapses into the
  generic "failed" bucket, so the user-facing copy is WEBHOOK_PROVISION_FAILED_WARNING ("не удалось
  автоматически настроить вебхук... Попробуйте переподключить ключ позже") — which never mentions the
  URL/scheme problem and advises a retry that can never succeed while PUBLIC_APP_URL stays http. It IS
  rendered (toast.warning + inline amber + persistent health-card error state), but it arrives right after
  the louder "SendGrid подключён" success toast, the inline copy is component state (lost on
  refresh/navigation), and its content gives the operator zero pointer to the real cause — hence the
  perceived "webhook silently absent" of test 1. Test 2's scope-limited scenario was never actually
  reached: the 400 (a body-validation rejection, not 401/403) proves the key used had the webhook scope;
  both reported gaps are this one https root cause.
fix: "N/A — diagnose-only session (goal: find_root_cause_only); fix owned by plan-phase --gaps"
verification: "N/A — no fix applied in this session"
files_changed: []

## Closure Note (milestone v1.0 close)

Resolved at v1.0 milestone close on 2026-07-14: diagnosis was handed to plan-phase --gaps; fix shipped via gap-closure plans (see phase 01/04/05/06 gap plans) or recorded as external-env tech debt in v1.0-MILESTONE-AUDIT.md.
