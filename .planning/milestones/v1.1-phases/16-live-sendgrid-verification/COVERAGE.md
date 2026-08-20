# API Coverage — SendGrid (Transactional v3 + Event Webhook)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.
> Baseline re-decided for this phase, not inherited from Phases 5/10/13.

| capability | decision | reason |
|---|---|---|
| mail/send v3 (POST /v3/mail/send) | INTEGRATE | |
| Dynamic Templates (template_id + dynamic_template_data) | INTEGRATE | |
| custom_args attribution (send_id, workspace_id, campaign_id) | INTEGRATE | |
| tracking_settings (open + click tracking) | INTEGRATE | |
| mail/send 429 + Retry-After handling | INTEGRATE | |
| mail/send transient/timeout (ambiguous outcome) handling | INTEGRATE | |
| Event Webhook delivery (delivered, opened, clicked, bounced) | INTEGRATE | |
| Event Webhook secondary events (processed, dropped, deferred, spamreport, unsubscribe, group_unsubscribe) | INTEGRATE | |
| Event Webhook ECDSA signature verification | INTEGRATE | |
| Event Webhook timestamp freshness window | INTEGRATE | |
| Event Webhook provisioning API (user/webhooks/event/settings) | INTEGRATE | |
| API key scope/validity check (BYO key entry) | INTEGRATE | |
| Suppression API (bounces, blocks, spam_reports, global unsubscribes) | OPT-OUT | Platform owns its own subscription status and suppression before every send — a project constraint; SendGrid-side suppression is not the source of truth. |
| Marketing Campaigns API (Single Sends, Automations) | OPT-OUT | Platform builds campaigns and flows itself; only the transactional mail/send surface is used. |
| Contacts / Lists / Segments API | OPT-OUT | Contact data is tenant data in Postgres; syncing it into SendGrid would duplicate the record of truth. |
| Sender identity + domain authentication API | OPT-OUT | BYO-key model: sender verification and domain reputation live in the tenant's own SendGrid account, configured there. |
| Stats / Email Activity API | OPT-OUT | Delivery metrics are derived from webhook events already ingested into send_events and daily rollups. |
| Scheduled sends + batch API (send_at, batch_id, cancel) | OPT-OUT | Scheduling is the platform's own queue and flow-wait responsibility; delegating it would split the schedule across two systems. |
| Sandbox mode (mail_settings.sandbox_mode) | OPT-OUT | Suppresses real delivery, which defeats this phase's purpose; failure paths are exercised by the fault proxy instead. |
| IP pools / subusers / IP management | OPT-OUT | Not needed yet — single shared account in v1.1; revisit if dedicated-IP tenants appear. |
| Inbound Parse webhook | OPT-OUT | Product sends outbound marketing mail only; no inbound mail processing is in scope. |
| Templates management API (create/update templates via API) | OPT-OUT | Explicitly out of scope — template content is authored in the SendGrid UI by the tenant; the platform only references template_id. |
| Validation (email address validation) API | OPT-OUT | Not needed yet — paid add-on; contact hygiene is handled by bounce/suppression handling. |
