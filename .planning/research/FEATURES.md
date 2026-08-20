# Feature Research — Production Hardening Operational Capability Set

**Domain:** Operational/reliability capability set for a multi-tenant B2C marketing email platform (Klaviyo-class) sending hundreds of thousands of emails/day via BYO SendGrid keys — v1.1 Production Hardening milestone
**Researched:** 2026-07-27
**Confidence:** MEDIUM — WebSearch/WebFetch only (no MCP docs providers configured in this environment); every load-bearing claim below is cross-checked against 2+ independent sources or a first-party doc/GitHub issue. Provider-internal claims about how Klaviyo/Braze/Customer.io implement things internally could not be verified (they don't publish internals) — those platforms are used only as reference points for *what capability class exists*, not *how it's built*. Flagged LOW where a claim rests on a single source.

This is not a "what to build first" product-features document — v1.0 already shipped the product surface (see `.planning/research/` v1.0 FEATURES.md history / PROJECT.md Validated section). This document answers: **what operational capability separates a functionally-complete MVP from a platform a paying tenant can trust with production sending volume**, mapped onto the audit's 7 target areas.

---

## GAPS THE AUDIT MISSED (read this section first)

The audit (`.planning/AUDIT-2026-07-27-production-readiness.md`) is thorough and technically sound, but it is a code-review-driven audit, not an industry-practice audit. Cross-referencing its findings against how mature ESPs and queue-backed systems actually operate surfaces the following gaps — none contradict the audit, but each either weakens a fix the audit already scoped, or is a capability class the audit didn't mention at all. **These should be folded into the relevant phase's requirements, not treated as a separate phase.**

| # | Gap | Why it matters | Which audit item it affects | Confidence |
|---|-----|-----------------|------------------------------|------------|
| 1 | **`sg_event_id` is not reliably stable across SendGrid webhook retries.** SendGrid's own docs say it's safe for dedup; a confirmed GitHub issue against `sendgrid-nodejs` (#1435) reports duplicate webhook deliveries (same email/event/timestamp/message-id) arriving with *different* `sg_event_id` values on retry. | The audit's dedup approach (§ "SendGrid Event Webhook... дедупликация по sg_event_id") and finding 4.5 (replay protection) both implicitly trust `sg_event_id` as a stable dedup key. It isn't, on SendGrid's own admission via the issue thread. Dedup needs a fallback compound key (message send_id + event type + provider timestamp, or a DB unique constraint on a derived tuple), not `sg_event_id` alone. | 3.2 (state machine), 4.5 (webhook replay) | HIGH — first-party GitHub issue, verified via WebFetch |
| 2 | **Redis `maxmemory-policy` and persistence (AOF) are not mentioned anywhere in the audit.** BullMQ's own "Going to Production" doc calls `maxmemory-policy=noeviction` the *single setting that guarantees correct queue behavior* — any eviction policy that silently deletes keys under memory pressure corrupts BullMQ's internal state (jobs vanish without a trace, not even a failed-job record). | Directly undermines every worker-reliability fix in area 5/6 if Redis itself isn't configured correctly — a queue can be "fixed" in code and still lose jobs at the infra layer. | Not covered by any existing audit item — new | HIGH — first-party BullMQ docs |
| 3 | **SendGrid `mail/send` has no native idempotency-key support** (unlike Resend, which supports `Idempotency-Key` on `POST /emails`, or Stripe). The audit's fix for 3.2 says "add correlation ID" as if that alone buys safety. | A correlation ID only protects you if *something* — your own DB or the provider — uses it to dedupe. Since SendGrid won't dedupe for you, 100% of resend-safety must be enforced app-side: check local send state (or Activity API) for that correlation ID *before* ever calling SendGrid again, not just log it alongside the call. This is a materially different implementation than "log the ID." | 3.2 (delivery correctness) | HIGH — confirmed across SendGrid docs + Resend's own SendGrid-migration doc |
| 4 | **Idempotency key must be derived from send *intent*, not a random UUID per attempt.** A `crypto.randomUUID()` generated fresh on each retry doesn't dedupe anything — it must be a deterministic function of (campaign/flow-step id, contact id, send generation) so that retrying the *same logical send* reproduces the *same key*. | The audit's phrasing ("добавить correlation ID") doesn't specify this, and it's the detail that makes or breaks the fix. Cheap to get right, easy to build wrong. | 3.2 | MEDIUM |
| 5 | **Webhook-endpoint-downtime backfill is the inverse problem the audit didn't address.** The audit's 4.5 covers replay *attacks* (someone resending a captured payload) but not the routine case: SendGrid retries a failed webhook delivery for ~24–72h with backoff, then drops it permanently. Any deploy-window outage on the webhook route creates a silent, permanent gap in delivery status for events landing in that window. | Needs a scheduled reconciliation job (poll SendGrid's Email Activity API for sends with no terminal webhook event after N hours) as a standing capability, not a one-time gap-fill. | Adjacent to 3.2 and 4.5, not explicitly named | MEDIUM |
| 6 | **Per-tenant *concurrency fairness under backlog* is a different problem than per-tenant *RPS throttling*.** The audit's 3.1 correctly identifies and fixes the global `worker.rateLimit()` bug. But even with a correct per-tenant token bucket, BullMQ (OSS) processes a queue roughly FIFO — if tenant A enqueues 50k jobs, tenant B's much smaller batch can still sit behind A's backlog waiting for worker slots, because rate-limiting throttles *how fast* a job may be sent, not *which tenant's job gets pulled next*. | This is the actual "one tenant can't starve another" guarantee the milestone's Active requirements ask for — RPS throttling alone doesn't fully deliver it under backlog conditions. Needs either weighted job pulling or a bounded per-tenant in-flight cap. | 3.1, and the milestone's "Tenant isolation" Active requirement | MEDIUM — cross-checked against 3 independent noisy-neighbor/fair-queueing sources, none BullMQ-specific (BullMQ has no official fair-queue primitive; this is architecture guidance, not a library feature) |
| 7 | **Sender-reputation / deliverability monitoring (Gmail & Yahoo bulk-sender rules) is entirely absent from the audit.** Since Feb 2024, any domain sending ≥5,000 msgs/day to Gmail is permanently classified "bulk sender" and must stay under a 0.3% spam-complaint rate (Google's internal target is 0.1%) or risk being blocklisted; Yahoo enforces a similar 0.3% threshold. Both require SPF/DKIM/DMARC alignment and one-click unsubscribe (the platform already has the last one). | At "hundreds of thousands of emails/day" across many independently-configured BYO-key tenants, an under-informed tenant *will* cross this threshold eventually, and the platform currently has no way to notice before the tenant's own domain gets blocklisted and support tickets arrive as "emails aren't sending." The platform already ingests bounce/spam-complaint events via its own webhook — a per-tenant rolling complaint-rate metric with a threshold alert is a small addition on data already flowing in. | Not covered anywhere in the audit | HIGH — cross-checked across 5+ deliverability sources, consistent 0.1–0.3% figures |
| 8 | **"Metrics reconciliation" is named as a fix item (5.4/end of §5) but not specified as a *recurring scheduled job* with drift alerting** — the audit's phrasing reads as a one-time correction. Mature platforms treat rollup-vs-source-of-truth drift as an ongoing operational signal, not a launch-day fix. | Without a standing reconciliation job, the same class of bug (aggregation using a different timestamp field, a missed webhook, a timezone bug) can silently reintroduce drift after the initial fix ships. | 5.2/5.4 | MEDIUM |
| 9 | **Expand/contract is the concrete technique behind "migration pipeline with gate/rollback/roll-forward"** — the audit names the goal but not the industry-standard mechanism. Worth naming explicitly in the `ARCHITECTURE.md`/`CONVENTIONS.md` this milestone is already creating, since "the migration must work with both the old and new app version running simultaneously" is the actual rule that makes rolling/VPS-restart deploys safe without dropping in-flight sends. | Turns a vague "have migration tests" requirement into a checkable rule (does this migration break if the old binary is still serving requests against it?). | 7 (Database и миграции) | HIGH — consistent across all migration-safety sources |

---

## Table Stakes

Capabilities a paying, production email-sending SaaS cannot credibly operate without. Missing these isn't "less featured" — it's an outage or a compliance violation waiting to happen.

| Capability | Why non-negotiable | Complexity | Depends on |
|---|---|---|---|
| Delivery state machine with an explicit `unknown`/`reconciling` state (not just `sent`/`failed`) | An ambiguous provider outcome (accepted-then-crash) recorded as `failed` causes either lost mail (no retry) or duplicate mail (blind retry) — both are the two things an email platform must not do | MEDIUM | `send_events`/sends table schema, `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/flows/flow-send.ts` |
| Deterministic, intent-derived idempotency/correlation key on every send attempt | SendGrid has no native idempotency key — dedup is 100% app responsibility; a random key per attempt doesn't dedupe anything | LOW–MEDIUM | Same send pipeline files; needs to be derivable from (campaign/flow-step id, contact id, generation) |
| Reconciliation job resolving `unknown` sends via SendGrid Email Activity API / webhook cross-check within a bounded SLA, else escalate | Every "provider accepted but we don't know the outcome" case must terminate somewhere other than silence | MEDIUM–HIGH | BYO key decrypt path (`kms` package), webhook ingest pipeline (Phase 5 v1.0) |
| Explicit, documented at-least-once + idempotent-processing model ("effectively-once"), not a false "exactly-once" claim | Distributed sends over HTTP cannot be exactly-once; claiming otherwise sets an undeliverable expectation. Marketing-email bias should be toward *not losing* mail over *never duplicating* it (duplicate is annoying, lost mail is a support ticket and a trust break) | LOW (decision + doc) | None — pure architecture decision, feeds `ARCHITECTURE.md` |
| Outbound-call timeout + cancellation (`AbortController`) on every SendGrid call | An unbounded hung request silently consumes a worker slot indefinitely, degrading the whole tenant's (or all tenants', pre-fix) throughput | LOW | `packages/delivery-core/src/send-mail.ts` |
| Per-tenant rate limiting enforced by deferring/delaying the specific job, never pausing the shared worker | A worker-level pause (current bug per audit 3.1) makes one tenant's SendGrid 429 degrade every other tenant | MEDIUM | `rate-limiter-flexible` token bucket (already present), BullMQ `moveToDelayed` |
| Per-tenant bounded in-flight/concurrency ceiling, independent of rate limiting | Prevents one tenant's large backlog from occupying all worker concurrency slots even when correctly rate-limited (see Gap #6) | MEDIUM | Worker concurrency config, queue job data (tenant id) |
| Redis configured `maxmemory-policy=noeviction` + AOF persistence enabled | Any other eviction policy causes BullMQ to silently lose queued/delayed jobs under memory pressure — a queue-reliability fix in code is meaningless if the substrate underneath discards data | LOW | Redis infra config (not app code) — belongs in Database/infra lifecycle deploy checklist |
| Atomic unsubscribe: one event updates subscription status + consent history + the triggering send record together | Split-write (status updates, send record doesn't) produces analytics that lie about who was unsubscribed when — a compliance and trust problem, not just a cosmetic one | MEDIUM | `subscription_status_history`, send/delivery tables, unsubscribe endpoint (Phase 4/5 v1.0) |
| Suppression list / consent-history record durability independent of contact row deletion | Deleting a contact must not delete the *proof* the platform honored their unsubscribe — re-contacting them after "erasure" is itself a compliance failure, and losing consent evidence removes the platform's only defense in a dispute | MEDIUM | Fix the `subscription_status_history.contact_id` cascade-delete (audit 5.3); anonymize contact PII, retain minimal suppression identifier + consent timestamps under a legitimate-interest basis |
| Single canonical "send day" definition (one timestamp field, one timezone convention) used identically by every rollup and dashboard query | Two code paths using `sent_at` vs `created_at`, or mixing local/UTC, produce dashboards that disagree with each other — this is the single fastest way to lose a tenant's trust in the analytics | MEDIUM | Reconciliation queries, dashboard queries (Phase 7 v1.0), needs a data-migration pass on existing rows |
| `/healthz` (process alive) distinct from `/readyz` (DB + Redis reachable, migrations current) | Load balancer / orchestrator needs to know "restart me" vs "don't route to me yet" — conflating them causes either false-positive kills or false-positive traffic to a broken instance | LOW–MEDIUM | Fastify app bootstrap, DB/Redis clients |
| Queue-depth AND oldest-job-age alerts, both, not depth alone | Depth alone doesn't distinguish "busy but healthy" from "stuck" — a shallow queue with a 6-hour-old head job is a worse incident than a deep queue draining normally | LOW–MEDIUM | Bull Board / BullMQ queue introspection APIs |
| Webhook ingest lag alert (time since last processed provider event vs. now) | A silently-stalled webhook consumer looks identical to "quiet tenant" without this signal — and per Gap #5, provider-side retry-then-drop means a stall that isn't caught quickly is unrecoverable data loss | MEDIUM | Webhook processing pipeline |
| Send failure rate broken down by error class (timeout / 429 / 5xx / terminal 4xx), not one aggregate number | An aggregate failure-rate alert can't tell an on-call engineer whether to look at SendGrid's status page, a tenant's exhausted key, or a code bug — the class *is* the diagnosis | MEDIUM | Send pipeline error handling, needs consistent error taxonomy |
| Graceful worker shutdown: `worker.close()` semantics (stop pulling new jobs, wait for in-flight, bounded force-exit timeout), wired to SIGTERM | A deploy that kills workers mid-send either loses the outcome (see delivery state machine above) or double-processes on restart | LOW–MEDIUM | BullMQ has native support (`worker.close()`); needs SIGTERM handlers + timeout, applies to all worker processes uniformly (audit 6: "единые worker error listeners") |
| Expand/contract migrations as the default technique + migration gate (single-runner lock) before app boot | The only reliable way to deploy schema changes without breaking in-flight requests/sends against the currently-running binary | MEDIUM | drizzle-kit migration tooling, deploy pipeline |
| Failed-job retention policy (bounded, not `removeOnFail: false` forever) + a documented dead-letter re-drive runbook | Unbounded failed-job retention is unbounded Redis growth; no re-drive runbook means a stuck DLQ sits unactioned until someone notices by accident | LOW–MEDIUM | Shared BullMQ queue factory (audit calls for this already — `defaultJobOptions` dedup) |

## Differentiators

Not required to be considered production-ready, but meaningfully raise operational trust or reduce toil beyond the audit's baseline fixes. Worth scoping *if* the phase budget allows, but none should block the milestone's Definition of Done.

| Capability | Value | Complexity | Notes |
|---|---|---|---|
| Per-tenant rolling spam-complaint / bounce-rate dashboard with a threshold alert | Catches a tenant sliding toward Gmail/Yahoo blocklisting before it becomes a "why isn't email sending" support fire | MEDIUM | Data already flows in via existing bounce/spam webhook events (Phase 5 v1.0) — this is mostly a rollup + alert, not new ingestion |
| Documented analytics consistency SLA to tenants (e.g., "counts finalized by T+24h, live counts may lag") | Mature ESPs publish this; it turns an inherent eventual-consistency property into an explicit promise instead of a silent surprise | LOW | Pure documentation once the canonical send-day/reconciliation work (table stakes above) exists |
| SLO-based alert thresholds (e.g., DLQ arrivals >1% of main queue for 10 min, oldest job >5× target SLA) instead of naive "any failure pages" | Prevents alert fatigue / on-call burnout at this send volume, where transient single-job failures are normal and expected | LOW | Depends on the failure-rate-by-class signal above existing first |
| End-to-end correlation IDs (`request_id`/`tenant_id`/`job_id`/`send_id` + trace) surfaced in logs and Sentry | Turns "grep three log files by hand" into "click through one trace" during an incident — already scoped in the milestone's target features | MEDIUM | Pino structured logging (already in stack), consistent propagation through BullMQ job data |
| Weighted per-tenant priority tiers in the send queue | Real fairness upgrade over FIFO+cap, but requires a notion of tenant tier/plan | HIGH | Blocked on billing/tarification, which is explicitly out of scope for v1 per PROJECT.md — defer |
| Automated backup restore drill as a scheduled, not one-off, exercise | Proves the backup is actually restorable on an ongoing basis, not just at the moment someone last checked | MEDIUM | Depends on backup/PITR tooling already scoped in the milestone (area 6) |

## Anti-Features

Things a team at this stage plausibly reaches for that create cost without matching benefit, or that are actively harmful given this product's specific constraints (BYO SendGrid key, self-hosted single VPS, no billing tiers, small team).

| Feature | Why it looks appealing | Why it's a trap here | Do instead |
|---|---|---|---|
| Provider-guaranteed exactly-once delivery / 2PC across Postgres and SendGrid | Sounds like the "correct" fix for the ambiguous-outcome problem | Doesn't exist for HTTP APIs; SendGrid has no distributed-transaction protocol. Chasing it burns effort on an unreachable guarantee | At-least-once send + idempotent app-side dedup (effectively-once) — industry-standard, achievable, already scoped in table stakes |
| Queue-per-tenant BullMQ topology for fairness | Feels like the most direct way to isolate tenants | Doesn't scale past a few hundred tenants (Redis key/queue sprawl, harder global observability) — already flagged as an anti-pattern in `STACK.md`'s Alternatives table; reconfirmed here from the fairness angle too | Shared queues + per-tenant token bucket + per-tenant concurrency cap (table stakes above) |
| Buying BullMQ Pro for native per-group rate limiting right now | Would solve the fairness problem more elegantly | Premature spend before the OSS app-level approach has even been tried at production load; `STACK.md` already flags this as a "revisit at scale" decision, not a v1.1 one | Ship the app-level token bucket + concurrency cap fix; revisit only if it shows operational friction under real tenant counts |
| Full domain-reputation monitoring platform (Google Postmaster Tools API + Yahoo Sender Hub integration per tenant) | Directly addresses Gap #7 (deliverability blind spot) in the most complete way | Requires each tenant to grant the platform access to their own Postmaster Tools account — a BYO-key/BYO-domain model doesn't naturally have this access, and building it is a multi-week integration project, not a hardening-milestone item | Start with the cheap version: surface the bounce/spam-complaint data the platform *already receives* via its own webhook as a per-tenant trend + threshold alert (listed under Differentiators) |
| Real-time strict-consistency dashboards recomputed from raw event tables on every page load, at this volume | Feels more "correct" than precomputed rollups | Wasteful and slow at hundreds-of-thousands-of-sends/day scale, and doesn't actually solve the audit's real complaint (rollups disagree with each other due to inconsistent day-definition, not due to being precomputed) | Precomputed rollups + a canonical send-day definition + a scheduled reconciliation job that alerts on drift (table stakes above) |
| Kubernetes-grade rolling/canary/blue-green deployment infrastructure | Standard "production-grade" deploy story | The milestone's own Key Decisions already commit to a single self-hosted VPS with Docker for this team's size — building multi-instance rolling-deploy orchestration contradicts that decision and adds ops burden the team explicitly chose to avoid | Expand/contract migrations (table stakes) + documented manual rollback runbook + graceful worker drain on restart — sufficient for a single-VPS deploy target |
| Alerting on every individual failed job / every DLQ arrival | Feels like "not missing anything" | Alert fatigue at this send volume — transient single-job failures (a momentary SendGrid 5xx) are normal, not incidents | Threshold/rate-based alerts (Differentiators table) — alert on *patterns*, page on drift beyond SLO, not on every occurrence |
| Postmark-style separate message-stream/IP-pool architecture (transactional vs. broadcast reputation isolation) | This is exactly what mature ESPs do to protect deliverability | Not applicable here — Mega CRM has no platform-owned SendGrid IP pool or domain to protect; each tenant BYOs their own SendGrid account, so IP/domain reputation isolation is already the tenant's own SendGrid account's problem, not the platform's to solve | Confirms the existing BYO-key architectural choice is sound; no action needed here — just don't accidentally try to rebuild this internally |

---

## Capability Dependencies

```
Delivery state machine (unknown/reconciling)
    └──requires──> Deterministic idempotency/correlation key
                       └──requires──> Send-day-consistent schema fields already exist (sends/send_events)

Reconciliation job (unknown-state resolution)
    └──requires──> Delivery state machine
    └──requires──> BYO key decrypt path (existing, Phase 1 v1.0)
    └──enhances──> Webhook-downtime backfill (Gap #5) — same mechanism, two triggers

Per-tenant rate limiting (job-level defer)
    └──requires──> Existing rate-limiter-flexible token bucket (already built, Phase 4 v1.0)
    └──enhances──> Per-tenant concurrency cap (Gap #6) — separate mechanism, same goal

Redis noeviction + AOF
    └──enables──> Every worker-reliability fix in area 5/6 (queue durability substrate)

Atomic unsubscribe event
    └──requires──> Fix cascade-delete on subscription_status_history (audit 5.3)
    └──requires──> Single canonical send-day field (for consistent downstream analytics)

Consent-evidence-preserving erasure
    └──requires──> Atomic unsubscribe event (shares the same history table)
    └──conflicts with──> Naive "erasure = delete all rows" interpretation (Anti-Feature)

Canonical send-day definition
    └──requires──> Data migration pass on existing rows using old mixed definitions
    └──enables──> Scheduled reconciliation job (Gap #8) — reconciliation needs one ground truth to reconcile against

/readyz endpoint
    └──requires──> Migration gate (must reflect "migrations current" in readiness, not just DB reachability)

Queue-depth + oldest-job-age alerts
    └──enhances──> Send-failure-rate-by-class alerting — together these cover the two queue-health failure modes (backlog, error rate)

Expand/contract migrations
    └──enables──> Graceful worker shutdown being sufficient for zero-dropped-sends deploys (both are required together, neither alone is)
```

### Dependency Notes

- **The delivery state machine is the load-bearing dependency for almost everything in area 2.** Reconciliation, idempotency keys, and the webhook-downtime backfill job all assume a schema that can represent "we don't know yet" as a first-class state, not just `sent`/`failed`. Sequence this first within Phase 2 work.
- **Redis config is infrastructure, not app code, but every worker-reliability fix is void without it.** It should be a deploy-checklist / Docker-compose item in the Database/infra lifecycle area, cross-referenced from the worker-reliability area rather than owned twice.
- **Consent-evidence-preserving erasure and atomic unsubscribe share a table** (`subscription_status_history`) — fixing the cascade-delete bug and building the atomic-event pattern should land in the same plan, not sequentially, to avoid touching the same migration twice.
- **Canonical send-day must land before the scheduled reconciliation job** — reconciling against an inconsistently-defined "day" just reconciles two wrong answers against each other.

---

## MVP Definition (for this hardening milestone)

### Must land in v1.1 (blocks the milestone's own Definition of Done)

- [ ] Delivery state machine with `unknown`/`reconciling` — the audit already calls this High/blocking; every reconciliation and idempotency capability depends on it existing first
- [ ] Deterministic idempotency key (intent-derived, not random) — cheap, and the audit's fix is incomplete without this detail (Gap #4)
- [ ] Reconciliation job for `unknown` sends AND for webhook-downtime backfill — same mechanism serves both (Gap #5)
- [ ] `sg_event_id` dedup fallback to a compound key — corrects a false assumption the current implementation may be relying on (Gap #1)
- [ ] Job-level per-tenant deferral (fix the global `worker.rateLimit()` bug) — already audit 3.1, High/blocking
- [ ] Per-tenant concurrency cap — completes the fairness guarantee the milestone actually promises (Gap #6), audit's fix alone is necessary but not sufficient
- [ ] Redis `maxmemory-policy=noeviction` + AOF — cheap, infra-only, prevents silent job loss underneath every other worker fix (Gap #2)
- [ ] Atomic unsubscribe event + fixed cascade-delete — already audit 5.1/5.3, High
- [ ] Canonical UTC send-day field — already audit 5.2, Medium-High
- [ ] `/healthz` + `/readyz` with real readiness semantics — already scoped, cheap
- [ ] Queue-depth + oldest-job-age + webhook-ingest-lag + failure-rate-by-class alerts — already scoped generally; this document specifies the concrete signal set
- [ ] Graceful shutdown across all workers + expand/contract migration discipline — already scoped, both needed together for zero-dropped-sends deploys

### Should land in v1.1 if phase budget allows (Differentiators)

- [ ] Per-tenant bounce/spam-complaint rolling rate + threshold alert (Gap #7) — cheap given existing data, high leverage against a real blind spot
- [ ] Scheduled (not one-time) metrics-reconciliation job with drift alerting (Gap #8)
- [ ] SLO-based alert thresholds instead of naive per-failure paging

### Explicitly defer past v1.1

- [ ] Weighted per-tenant priority tiers — blocked on billing, out of scope per PROJECT.md
- [ ] Full Postmaster Tools / Sender Hub integration — multi-week scope, start with the cheap version above instead
- [ ] BullMQ Pro purchase — revisit only if the app-level fix shows friction at real tenant counts
- [ ] Multi-instance rolling/canary deploys — contradicts the milestone's own single-VPS decision

---

## Sources

Delivery correctness / idempotency:
- [Designing Idempotent Email Sending for AI Agents — Mails.ai](https://mails.ai/blog/idempotent-email-sending-for-ai-agents) — MEDIUM, single-source blog but internally consistent with Stripe/AWS idempotency guidance below
- [Designing robust and predictable APIs with idempotency — Stripe](https://stripe.com/blog/idempotency) — HIGH, first-party
- [REL04-BP04 Make mutating operations idempotent — AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_prevent_interaction_failure_idempotent.html) — HIGH, first-party
- [At‑least‑once vs at‑most‑once vs exactly‑once — DesignGurus](https://www.designgurus.io/answers/detail/atleastonce-vs-atmostonce-vs-exactlyonce-where-to-use-each) — MEDIUM
- [You Cannot Have Exactly-Once Delivery — Brave New Geek](https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/) — MEDIUM, widely-cited foundational argument, cross-checked against Confluent's own delivery-semantics docs
- [sg_event_id changes on retries — sendgrid-nodejs #1435](https://github.com/sendgrid/sendgrid-nodejs/issues/1435) — HIGH, first-party GitHub issue, verified via WebFetch
- [Event Webhook Reference — SendGrid Docs / Twilio](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event) — HIGH, first-party
- [Migrating from SendGrid to Resend](https://resend.com/migrate/sendgrid) — MEDIUM, vendor comparison but factually checkable (idempotency-key support claim)
- [Mail Send — SendGrid API Reference / Twilio](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send) — HIGH, first-party

Multi-tenant fairness:
- [Fixing noisy neighbor problems in multi-tenant queueing systems — Inngest](https://www.inngest.com/blog/fixing-multi-tenant-queueing-concurrency-problems) — MEDIUM
- [The Noisy Neighbor Problem in Multitenant Architectures — Neon](https://neon.com/blog/noisy-neighbor-multitenant) — MEDIUM
- [Building resilient multi-tenant systems with Amazon SQS fair queues — AWS](https://aws.amazon.com/blogs/compute/building-resilient-multi-tenant-systems-with-amazon-sqs-fair-queues/) — HIGH, first-party (SQS-specific, used as architecture pattern reference, not a BullMQ feature claim)
- [Going to production — BullMQ official docs](https://docs.bullmq.io/guide/going-to-production) — HIGH, first-party, verified via WebFetch (Redis noeviction/AOF, retry/backoff, retention guidance)
- [Graceful shutdown — BullMQ official docs](https://docs.bullmq.io/guide/workers/graceful-shutdown) — HIGH, first-party

Compliance:
- [Right to erasure — ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/) — HIGH, first-party regulator guidance
- [Right to object — ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-object/) — HIGH, first-party regulator guidance (suppression-list-after-objection endorsement)
- [When can we rely on legitimate interests? — ICO](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/lawful-basis/legitimate-interests/when-can-we-rely-on-legitimate-interests/) — HIGH, first-party
- [Is there a legal requirement to keep unsubscribed email addresses under CAN-SPAM? — Suped](https://www.suped.com/learn/email-deliverability/is-there-a-legal-requirement-to-keep-unsubscribed-email-addresses-for-four-years-under-can-spam) — MEDIUM
- [CASL Compliance: The Complete Guide — Sendcheckit](https://sendcheckit.com/blog/casl-compliance-guide) — MEDIUM, cross-checked against Mailchimp's CASL guide

Analytics / deliverability:
- [Gmail Bulk Sender Guidelines 2026 — GMass](https://www.gmass.co/blog/gmail-bulk-sender-guidelines/) — MEDIUM
- [Email sender guidelines FAQ — Google/Gmail Help](https://support.google.com/a/answer/14229414?hl=en) — HIGH, first-party
- [Yahoogle: New Bulk Sender Requirements — Mailgun](https://www.mailgun.com/state-of-email-deliverability/chapter/yahoogle-bulk-senders/) — MEDIUM, cross-checked, consistent 0.3% figure across 5+ independent deliverability-vendor sources
- [What types of messages are a good fit for Postmark? — Postmark Support](https://postmarkapp.com/support/article/1082-what-types-of-messages-are-a-good-fit-for-postmark) — HIGH, first-party (message-stream/reputation-isolation reference, used only to confirm the anti-feature framing)

Operational surface / release safety:
- [DLQ Operations: Metrics, Alerting, and Triage SLOs — SystemOverflow](https://www.systemoverflow.com/learn/message-queues/dead-letter-queues/dlq-operations-metrics-alerting-and-triage-slos) — MEDIUM
- [Database Migrations. The Expand-Contract Pattern — Enol Casielles](https://www.enolcasielles.com/en/blog/database-migrations-strategy) — MEDIUM, cross-checked against 5+ independent expand/contract sources with consistent phase definitions
- [What is a webhook signature? — Svix](https://www.svix.com/resources/glossary/webhook-signature/) — MEDIUM, cross-checked against Stripe's own webhook docs (both converge on 300s/5min tolerance)
- [Receive Stripe events in your webhook endpoint — Stripe Docs](https://docs.stripe.com/webhooks) — HIGH, first-party (5-minute replay-tolerance standard, confirms the audit's own 4.5 recommendation is industry-aligned)

---
*Feature research for: production hardening / operational reliability, Mega CRM v1.1*
*Researched: 2026-07-27*
