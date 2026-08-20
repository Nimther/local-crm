# Phase 11 — External API Coverage Matrix

**External API in scope:** SendGrid (Twilio) — v3 REST API and the Event Webhook.

The `api-coverage` detector fired on this phase (signal: `api` / `webhook` in the phase scope). This phase touches two SendGrid surfaces: the `mail/send` transactional endpoint (adding an abort timeout) and the Event Webhook subscription configuration (adding the `processed` event type). The matrix below starts every capability at `INTEGRATE` and records every subtraction with a reason.

Scope note: "already integrated" below means the capability was integrated in an earlier phase and is unchanged here; it is still `INTEGRATE`, not an opt-out.

Layout note: this is a **single** table, grouped in row order as Mail Send → Event Webhook → other SendGrid API surfaces. The three groups were separate tables until 2026-08-09; `api-coverage.cjs` skips a `| capability | decision | reason |` header row only once (`!sawHeader`), so a second or third table's header parsed as a data row with decision `"decision"` and failed the seal gate. Keep this as one table.

## Coverage matrix

| capability | decision | reason |
|---|---|---|
| `POST /v3/mail/send` (transactional send) | INTEGRATE | Core send path; this phase adds `AbortSignal.timeout()` and ambiguity classification (11-05, 11-06) |
| `mail/send` — Dynamic Templates (`template_id`, `dynamic_template_data`) | INTEGRATE | Already integrated; content lives in the tenant's SendGrid account by project constraint |
| `mail/send` — `custom_args` (`send_id`, `workspace_id`, `campaign_id`, `test`) | INTEGRATE | The correlation contract this phase makes deterministic (11-04) |
| `mail/send` — `tracking_settings` (open/click/subscription) | INTEGRATE | Already integrated (Phase 5 D-04/D-15) |
| `mail/send` — `headers` (`List-Unsubscribe`, `List-Unsubscribe-Post`) | INTEGRATE | Already integrated (Phase 5) |
| `mail/send` — `send_at` (SendGrid-side scheduling) | OPT-OUT | Scheduling is owned by the platform's own campaign scheduler and BullMQ; delegating it to SendGrid would put campaign timing outside the platform's control and cancel path |
| `mail/send` — `batch_id` (batched sends) | OPT-OUT | Not needed — the platform's unit of idempotency is the per-recipient `sends` row, not a provider-side batch |
| `POST /v3/mail/batch` (create batch id) | OPT-OUT | Only useful together with `send_at`/`batch_id`, both opted out above |
| `POST /v3/user/scheduled_sends` (pause/cancel scheduled sends) | OPT-OUT | Only useful together with `send_at`, opted out above |
| `POST /v3/mail/send` — attachments | OPT-OUT | Not needed — out of scope for the product's B2C marketing email model |
| Event Webhook — subscription provisioning (create) | INTEGRATE | Already integrated (Phase 5); extended here with a new event flag (11-07) |
| Event Webhook — subscription provisioning (patch/reconnect) | INTEGRATE | Already integrated; carries the same flag set as create (11-07 asserts parity) |
| Event Webhook — signed-verification enablement (ECDSA public key) | INTEGRATE | Already integrated (Phase 5) |
| Event type `processed` | INTEGRATE | Added by this phase (D-06) — primary acceptance evidence for the reconciler |
| Event type `delivered` | INTEGRATE | Already integrated |
| Event type `bounce` | INTEGRATE | Already integrated |
| Event type `dropped` | INTEGRATE | Already integrated |
| Event type `open` | INTEGRATE | Already integrated |
| Event type `click` | INTEGRATE | Already integrated |
| Event type `unsubscribe` | INTEGRATE | Already integrated |
| Event type `group_unsubscribe` | INTEGRATE | Already integrated |
| Event type `spam_report` | INTEGRATE | Already integrated |
| Event type `deferred` | OPT-OUT | Excluded by D-06 — fires repeatedly per message, multiplying `send_events` volume for evidence `processed` plus delivered/bounce already give. Revisit only if that set proves insufficient |
| Event type `group_resubscribe` | OPT-OUT | Not needed — the platform's `contacts.subscription_status` is the single source of truth for subscription state; SendGrid-side unsubscribe groups are deliberately not used |
| Event Webhook — OAuth-secured callback | OPT-OUT | Not needed — the callback is authenticated by ECDSA signature verification over the raw body plus a per-workspace path token, already integrated in Phase 5 |
| Email Activity API (`/v3/messages`) | OPT-OUT | Explicitly rejected by D-05 — a paid per-account add-on the platform cannot assume under BYO keys, and heavily rate-limited. The reconciler resolves from webhook evidence only |
| Suppression APIs (bounces, blocks, invalid, spam, global unsubscribes) | OPT-OUT | Not needed — the platform maintains its own `suppressions` table as the pre-send gate's source of truth (project constraint: own suppression before every send) |
| Marketing Campaigns API (contacts, lists, segments, single sends) | OPT-OUT | Explicitly out of scope — the platform owns contacts, segments and campaigns; only transactional `mail/send` is used |
| Templates API (create/update Dynamic Templates) | OPT-OUT | Explicitly out of scope — templates are authored by the tenant inside their own SendGrid account by project constraint; the platform only references `template_id` |
| Stats API (`/v3/stats`, category/subuser stats) | OPT-OUT | Not needed — delivery analytics are derived from the platform's own `sends` fact columns and `workspace_daily_rollup`, which stay correct under BYO keys shared across workspaces |
| API Keys API (create/scope tenant keys) | OPT-OUT | Not needed — keys are supplied by the tenant (BYO) and stored under KMS envelope encryption; the platform never mints them |
| Sender Identity / Domain Authentication APIs | OPT-OUT | Not needed yet — sender verification is the tenant's own responsibility in their SendGrid account; revisit if onboarding automation is ever brought in-product |
| Subusers API | OPT-OUT | Not needed — the BYO-key model means each tenant already has their own SendGrid account boundary |
| Inbound Parse API | OPT-OUT | Not needed — the product sends outbound marketing email only; there is no inbound-mail feature |
