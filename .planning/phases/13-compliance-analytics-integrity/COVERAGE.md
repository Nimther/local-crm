# Phase 13 — External API Coverage Matrix

**Produced:** 2026-08-11 (plan time)
**External API in scope:** Twilio SendGrid — Event Webhook (inbound capability surface) and Mail Send v3 / Email Activity API (outbound capability surface).

This phase changes how the platform ingests, bounds, dedupes, journals and replays the SendGrid Event Webhook, so the webhook's **event-type surface** is the capability list that matters. Baseline is full coverage; every opted-out row below carries a reason.

## Event Webhook — event types

| capability | decision | reason |
|---|---|---|
| `processed` | OPT-OUT | Out of WBHK-02 normalization scope; carried as evidence-only per Phase 11 D-06 (`EVENT_FLAGS.processed:true` provisioning). No counter or status derives from it. |
| `deferred` | OPT-OUT | Transient provider-side retry signal, not a terminal delivery fact; the Phase 11 reconciler's 72h re-scan is the platform's authority for a send stuck in deferral. |
| `delivered` | INTEGRATE | `setFactColumnOnce(delivered_at)` + `delivered_count` rollup. |
| `open` | INTEGRATE | `first_opened_at` (unique) + `open_count` (repeat) + `opened_count` rollup. |
| `click` | INTEGRATE | `first_clicked_at` (unique) + `click_count` (repeat) + `clicked_count` rollup. |
| `bounce` (`type` absent / `"bounce"`) → hard bounce | INTEGRATE | `bounced_at` + suppression + `bounced_count`; also feeds CMP-09's hard-bounce-rate ratio (D-12). |
| `bounce` (`type: "blocked"`) → soft bounce | INTEGRATE | Soft-bounce streak against `SOFT_BOUNCE_SUPPRESS_THRESHOLD`. |
| `dropped` | INTEGRATE | `dropped_at` + reason-driven suppression decision table (`suppression-rules.ts`). |
| `spamreport` | INTEGRATE | `spam_reported_at` + suppression; the numerator of CMP-09's complaint rate (D-10). |
| `unsubscribe` | INTEGRATE | CMP-01's atomic path: status + consent history + `sends.unsubscribed_at` in one transaction. |
| `group_unsubscribe` | INTEGRATE | Same atomic path as `unsubscribe`. |
| `group_resubscribe` | OPT-OUT | Not needed — the platform's own subscription status is authoritative and is only ever re-subscribed through platform-side contact edit / re-import, never by a provider-side group event. |
| `account_status_change` | OPT-OUT | Account-level SendGrid notice about the tenant's own account; not a per-send delivery fact and out of this platform's data model. |

## Event Webhook — transport-level capabilities

| capability | decision | reason |
|---|---|---|
| ECDSA signed-event verification (`X-Twilio-Email-Event-Webhook-Signature`) | INTEGRATE | Already integrated (Phase 5); this phase adds the post-verification journal write behind it. |
| Signature timestamp freshness (`...-Timestamp` header) | INTEGRATE | Already integrated (Phase 10, `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`). |
| Per-event `timestamp` field bounding | INTEGRATE | This phase's CMP-05 — bounded before partition routing and before dedup. |
| Batch POST (multi-event body) | INTEGRATE | Whole verified batch journaled and enqueued as one job. |
| Provider retry window (~24h) | INTEGRATE | Relied on as the recovery path for true endpoint unreachability (D-05); no code integration needed beyond fail-closed 5xx on journal-write failure so SendGrid actually retries. |
| `custom_args` correlation (`send_id`, `test`) | INTEGRATE | `send_id` becomes part of the CMP-07 dedup identity; `test` gates side effects. Note the retention nuance, which is not a coverage change: the capability is fully consumed at ingest, but custom args are a tenant-defined key space and so are NOT on plan 13-13's post-erasure evidence allowlist — after a contact is erased, that contact's stored payload copies keep the provider's own ids rather than the tenant's custom args. Ingest-time integration and post-erasure retention are separate decisions. |

## Other SendGrid API surfaces

| capability | decision | reason |
|---|---|---|
| Mail Send v3 (`mail/send`) — tenant BYO key | INTEGRATE | Already integrated (Phases 4–6); untouched by this phase except that the pre-send suppression gate now compares hashes. |
| Mail Send v3 — platform key (operator + tenant alert email) | INTEGRATE | CMP-09's tenant alert and the operator watchdog channel both send through platform-mail machinery, never the tenant's BYO key (D-09). |
| Email Activity API (event search/backfill) | OPT-OUT | Explicitly rejected as a baseline dependency by D-05 — paid per-account add-on under BYO keys and heavily rate-limited; the ingress journal plus the provider retry window is the platform's own replay authority. Listed as a deferred idea (opt-in layer for tenants whose plan includes it). |
| Suppression Groups / Global Suppressions API | OPT-OUT | Not needed — the platform maintains its own `workspace_suppressions` authority and checks it before every send; mirroring state into SendGrid's own suppression store is out of this phase's scope and adds a second source of truth. |
| Subusers / Domain Authentication APIs | OPT-OUT | Explicitly out of scope — the tenant owns and administers its own SendGrid account and sending domain under the BYO-key model. |
| Stats / Categories API | OPT-OUT | Not needed — every metric this phase reports is computed from the platform's own `sends` fact columns and `workspace_daily_rollup`, which is precisely the CMP-02 "a daily number means exactly one thing" guarantee. |
