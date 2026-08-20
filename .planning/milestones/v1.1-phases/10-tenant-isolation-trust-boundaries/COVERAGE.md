# API Coverage — SendGrid (Web API v3 + Event Webhook)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Phase 10 scope: the platform's SendGrid surface as hardened by tenant-isolation work —
> inbound Event Webhook trust boundary (signature, freshness, per-event workspace ownership)
> plus the outbound per-tenant BYO-key API calls that already exist in the codebase.

| capability | decision | reason |
|---|---|---|
| `mail/send` (transactional send, dynamic template data) | INTEGRATE | Core delivery path — `packages/delivery-core/src/send-mail.ts`, dispatched by `apps/worker/src/queues/send-dispatch.ts` |
| `templates.list` (GET /v3/templates?generations=dynamic) | INTEGRATE | Tenant template picker reads dynamic templates — `apps/api/src/modules/tenancy/sendgrid-client.ts` |
| `scopes.read` (GET /v3/scopes — API key validation) | INTEGRATE | BYO-key onboarding validates tenant key capability before storing — `sendgrid-client.ts` |
| `verified_senders.list` (GET /v3/verified_senders) | INTEGRATE | Sender resolution for campaigns/flows uses tenant's verified senders — `sendgrid-client.ts`, `sender-resolver.ts` |
| `event_webhook.settings` (CRUD /v3/user/webhooks/event/settings) | INTEGRATE | Platform provisions the tenant's event webhook endpoint — `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` |
| `event_webhook.signed` (signed/{id} — enable signing, fetch ECDSA public key) | INTEGRATE | Signed webhook enforced per tenant; public key stored for verification — `sendgrid-webhook-provision.ts` |
| `event_webhook.consume` (inbound delivery events, all types) | INTEGRATE | All event types (processed/delivered/open/click/bounce/dropped/spamreport/unsubscribe) — `webhooks.routes.ts` → `webhook-events.worker.ts`; per-event workspace ownership drop (phase 10) |
| `event_webhook.signature_verification` (ECDSA over raw body) | INTEGRATE | Raw-body verification before parsing — `signature-verify.ts` (phase 10 trust anchor) |
| `event_webhook.timestamp_freshness` (replay window) | INTEGRATE | ±600s timestamp bound, byte-identical 400 on all rejects — phase 10 plan 10-11 |
| `mail/send.sandbox_mode` | OPT-OUT | Test isolation uses ephemeral DBs and fixture transports, not SendGrid sandbox; not needed |
| `mail/send.send_at` / batch scheduling (batch_id, cancel) | OPT-OUT | Scheduling owned by platform BullMQ queues (campaign-scheduler); SendGrid-side deferral would bypass per-tenant RPS throttling |
| `suppression.*` (bounces, blocks, spam_reports, unsubscribes sync) | OPT-OUT | Platform maintains its own suppression state from consumed webhook events and checks it before every send; no list sync needed yet |
| `templates.write` (create/edit/version templates) | OPT-OUT | Product constraint: content authored in tenant's SendGrid account (Dynamic Templates); platform is read-only on templates |
| `marketing.*` (Marketing Campaigns API: contacts, lists, segments, single sends) | OPT-OUT | Platform owns contacts/segments/campaigns in Postgres; SendGrid used for transactional delivery only |
| `stats.*` (GET /v3/stats, category/subuser stats) | OPT-OUT | Metrics derived from own `send_events`/analytics tables fed by the webhook; aggregate stats API adds nothing tenant-scoped |
| `inbound_parse.*` (Inbound Parse webhook) | OPT-OUT | No inbound email processing in product scope |
| `sender_auth.*` (domain authentication, link branding, reverse DNS) | OPT-OUT | BYO-key model: domain/sender auth lives in the tenant's own SendGrid account and reputation |
| `ips.*` (IP pools, warmup, assignment) | OPT-OUT | BYO-key model: IP management is the tenant account's concern, not the platform's |
| `subusers.*` (subuser management) | OPT-OUT | One BYO key per workspace; no subuser hierarchy in the tenancy model |
| `api_keys.write` (create/rotate tenant SendGrid keys via API) | OPT-OUT | Tenants mint and paste their own keys; platform never creates keys in the tenant account (least privilege) |
| `mail_settings.*` / `tracking_settings.*` (account-level toggles) | OPT-OUT | Account-level settings belong to the tenant's SendGrid account; platform only reads what sends need |
| `email_validation.*` (Email Address Validation API) | OPT-OUT | Paid add-on outside MVP scope; CSV import validates shape locally |
| `event_webhook.test` (POST settings/test) | OPT-OUT | Webhook path exercised end-to-end by own integration suites with signed fixtures; SendGrid test-fire not needed |
