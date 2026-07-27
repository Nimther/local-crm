# Pitfalls Research

**Domain:** Multi-tenant B2C email marketing automation SaaS (Klaviyo-style flows + broadcast campaigns, SendGrid delivery, BYO API key, 100k–1M contacts scale)
**Researched:** 2026-07-03
**Confidence:** MEDIUM (web-sourced; SendGrid docs and RLS/webhook findings cross-checked across multiple independent sources — see per-pitfall notes for LOW-confidence items)

## Critical Pitfalls

### Pitfall 1: Duplicate sends from non-idempotent flow execution

**What goes wrong:**
A contact receives the same flow step's email twice (or a broadcast email twice) because the job that executes a step was retried — by the queue worker after a crash, by an at-least-once delivery guarantee, or by a stuck job being re-picked after a visibility timeout — and the second execution has no way to know the first one already sent.

**Why it happens:**
Redis-backed queues (BullMQ, etc.) provide at-least-once delivery by default. Developers treat "enqueue the send job" as the unit of correctness and forget that the *execution* of a step (evaluate condition → render template → call SendGrid → advance contact's flow-state) must itself be idempotent, because the same job payload can run more than once (worker crash mid-step, job timeout + requeue, manual retry from a dashboard).

**How to avoid:**
- Every flow-step execution is keyed by a stable idempotency key: `(flow_version_id, flow_run_id, node_id, attempt_epoch)`. Before calling SendGrid, write/CAS a row into a `flow_step_executions` table with a unique constraint on that key and a status column (`pending` → `sent` → `failed`); only proceed to the SendGrid call if the insert succeeded (i.e., this is the first attempt).
- Use SendGrid's own idempotency where available (custom `X-Message-Id`/`custom_args` you generate deterministically) so even a duplicate outbound call against SendGrid is de-duplicated on their side as a fallback safety net — but do not rely on this as your primary defense.
- Advance the contact's position in the flow (`current_node_id`, `next_run_at`) in the **same transaction** as marking the step `sent`, so a crash between "sent the email" and "advanced state" cannot cause a second send.

**Warning signs:**
- Support tickets about "I got the same email twice."
- Any queue worker code where the SendGrid API call happens *before* a durable state write, or where retries are configured without an idempotency check first.

**Phase to address:**
Flow execution engine / send queue phase — this must be architected in from the first version of the worker, not retrofitted.

---

### Pitfall 2: SendGrid webhook signature verification breaks silently due to body parsing

**What goes wrong:**
Signature verification (ECDSA over the raw request body) fails intermittently or is quietly disabled because the framework's global JSON body parser middleware consumes and re-serializes the request body before the verification code sees it. Teams often "fix" this by disabling verification rather than fixing body handling, opening the webhook endpoint to spoofed events.

**Why it happens:**
Express/Node middleware ordering is easy to get wrong: `app.use(express.json())` applied globally parses the body for *all* routes, including the webhook route, before a signature-checking middleware can access the original bytes. Re-serialized JSON differs byte-for-byte from what SendGrid signed (whitespace, key order), so verification always fails even though the payload is legitimate.

**How to avoid:**
- Mount the SendGrid webhook route with `express.raw({ type: 'application/json' })` (or equivalent) and verify the signature against that raw `Buffer`, then `JSON.parse()` only after verification succeeds. Exclude this route from any global JSON body-parser.
- Add an integration test that replays a real (or SendGrid-provided test) signed payload through the actual HTTP stack, not just a unit test that calls the verification function directly with clean strings.

**Warning signs:**
- Signature verification passes in unit tests but fails against real webhook traffic.
- Any code comment or config flag that says "signature check disabled" or "verify=false."

**Phase to address:**
Webhook ingestion phase (event tracking: delivered/opened/clicked/bounced/unsubscribed).

*Confidence: MEDIUM — cross-checked against Twilio/SendGrid docs and community reports.*

---

### Pitfall 3: Webhook event duplication and out-of-order delivery corrupting status

**What goes wrong:**
SendGrid retries webhook POSTs for up to 24 hours if your endpoint doesn't return 2xx, and each POST can batch 5–50 individual events. If processing isn't idempotent per-event, a retried batch reprocesses events already applied (double-counting opens/clicks in analytics) or applies events out of order (e.g., a delayed `bounce` event arriving after a later `open` event overwrites the email's status back to "bounced").

**Why it happens:**
Developers dedupe by request-body hash (wrong — a retried batch is byte-identical, but two separate batches from the same "logical" event are not) or apply events by simple "last write wins" on message status without an event ordering key. Network jitter and their retry/backoff mean event arrival order is not guaranteed to match causal order.

**How to avoid:**
- Dedupe at the **individual event level** using SendGrid's `sg_event_id`, not the outer HTTP request. Store processed `sg_event_id`s (or a hash of event fields) with a unique constraint before applying side effects.
- Order-sensitive status transitions (delivered → opened → clicked → bounced/unsubscribed) should use the event's `timestamp` field for ordering, with a state machine that rejects/ignores events older than the current recorded status timestamp rather than blindly overwriting.
- Return 2xx as fast as possible (ack-then-process pattern: push raw events onto an internal queue immediately, process asynchronously) to avoid SendGrid's own retry storm if your processing is slow.

**Warning signs:**
- Analytics dashboards show open/click counts higher than plausible for the segment size.
- A contact's status flips backward (e.g., "delivered" after "bounced" was already recorded).

**Phase to address:**
Webhook ingestion / analytics phase.

*Confidence: MEDIUM.*

---

### Pitfall 4: Broadcast fan-out starves or delays triggered flow sends

**What goes wrong:**
A large broadcast campaign (e.g., 500k recipients) floods the same send queue/worker pool as triggered flow emails (welcome email, password reset-adjacent transactional-feeling flows). Triggered emails that should go out in seconds end up queued behind hours of broadcast volume, destroying the "immediate" feel that makes triggered flows valuable.

**Why it happens:**
It's simpler to build one queue and one worker pool first, and this works fine in testing with small contact lists. It only breaks at the exact scale (100k–1M contacts) this project targets, once real broadcast sizes exceed trivial.

**How to avoid:**
- Every commercial platform surveyed (Salesforce Marketing Cloud, Marketo, Bloomreach) solves this with **separate priority lanes/queues** for triggered vs. broadcast sends, sharing the underlying SendGrid rate-limit budget but with triggered sends always processed first (either separate BullMQ queues with priority, or separate worker concurrency pools, or a token-bucket that reserves a minimum RPS floor for the triggered lane at all times).
- Set an internal SLO: triggered-flow sends should be dispatched within seconds to low-single-digit minutes; alert if the triggered queue's oldest unprocessed job exceeds that threshold — that's already stated as a hard architectural constraint in this project.

**Warning signs:**
- Support complaints that welcome emails or password-adjacent flow emails arrive "hours late" right after a broadcast campaign was launched.
- Single shared queue depth spikes correlate with broadcast launches.

**Phase to address:**
Send queue / infrastructure phase — must be designed before broadcast campaigns ship, since retrofitting priority lanes into a single-queue system requires reworking job scheduling and can require redriving in-flight jobs.

*Confidence: MEDIUM.*

---

### Pitfall 5: Segmentation queries become unusably slow at real scale

**What goes wrong:**
Behavioral segments ("bought in last 30 days," "hasn't opened in 60 days") are implemented as live SQL joins across a growing `events` table at segment-evaluation or send time. This is fast with a demo dataset of a few thousand events, but at hundreds of thousands to millions of contacts with a full event history, a single segment query can take minutes — blocking flow entry-condition checks, broadcast audience calculation, and dashboard rendering.

**Why it happens:**
Ad-hoc query building against normalized event tables is the natural first implementation and looks correct in code review; the failure mode only appears under production data volume, often discovered when a customer's contact base crosses tens of thousands of profiles with rich event history.

**How to avoid:**
- Design the events table from day one with the query patterns in mind: index on `(contact_id, event_name, occurred_at)` at minimum, partition or use BRIN indexes for time-range scans at very large volumes.
- Precompute/materialize segment membership rather than recomputing full joins on every flow entry check — e.g., a `segment_members` table refreshed incrementally as events arrive (trigger-based or a periodic incremental job), so flow entry conditions and broadcast audience selection read from a small indexed table instead of scanning raw events.
- Cap how "live" a behavioral segment needs to be for entry-condition evaluation (e.g., re-evaluate every N minutes rather than on every event) — this is an acceptable and common tradeoff; document it as a decision rather than an accident.

**Warning signs:**
- Segment preview/count takes multiple seconds even at moderate test data volume.
- `EXPLAIN ANALYZE` on a segment query shows sequential scans over the events table.

**Phase to address:**
Segmentation phase — but the *events table schema and indexing strategy* must be decided in the event-ingestion phase before segmentation is built on top of it, since retrofitting indexes/partitioning under production write load is expensive.

*Confidence: LOW-MEDIUM — general Postgres scaling patterns; specific numbers not independently benchmarked for this exact workload.*

---

### Pitfall 6: Timezone/quiet-hours logic evaluated at the wrong time or only for one send type

**What goes wrong:**
Quiet hours and delays are computed once when a flow step is scheduled (using the platform's server timezone or the contact's timezone captured at that moment), rather than re-evaluated at actual send time. Or, quiet-hours/frequency-cap logic is implemented only for broadcast campaigns and forgotten for flow-triggered sends, so a purchase-confirmation-adjacent flow step still fires at 2 AM local time.

**Why it happens:**
Quiet hours feel like a "campaign scheduling" feature and get bolted onto the broadcast send path first; flows are built by a different code path (the execution engine) and the two don't share a single enforcement point unless deliberately unified.

**How to avoid:**
- Implement quiet-hours/frequency-cap/timezone checks as a single shared **pre-send gate** that every send path (flow step execution, broadcast dispatch) must pass through — not duplicated logic in two places.
- Evaluate the gate at actual dispatch time, not schedule time: if a step is due to send during quiet hours, defer (re-enqueue for the next allowed window) rather than drop or send anyway. This matches how mature platforms (Klaviyo) handle it — pause-and-resume within the flow rather than skipping the step.
- Store timezone per contact explicitly (don't infer only from IP at signup — allow it to be set/updated, and default sensibly when unknown) since B2C contacts' timezone can be wrong or missing at import time (CSV import is an explicit requirement here).

**Warning signs:**
- Complaints about receiving flow emails at odd local hours even though quiet hours are configured.
- Quiet-hours code exists only in the broadcast-sending module, not shared with the flow engine.

**Phase to address:**
Flow execution engine phase (rules: exit conditions, quiet hours, frequency cap) — quiet hours must be a property of the shared send pipeline, not the campaign feature.

*Confidence: MEDIUM.*

---

### Pitfall 7: Suppression/unsubscribe status not enforced as a single global gate

**What goes wrong:**
A contact unsubscribes (via SendGrid's unsubscribe link or webhook) but keeps receiving emails from a *different* flow or broadcast, because unsubscribe status is tracked per-list/per-campaign rather than globally, or because the platform's own suppression check happens only for broadcasts and not flow-triggered sends (or vice versa).

**Why it happens:**
This project's design explicitly keeps its own subscription status rather than relying solely on SendGrid's suppression — the risk is building two sources of truth (platform status + SendGrid suppression) that can drift, or checking only one of them at send time depending on which code path fires the send.

**How to avoid:**
- One authoritative `subscription_status` per contact (global, not per-list), updated from the SendGrid unsubscribe/spam-report webhook events, checked as a mandatory gate immediately before *every* SendGrid API call regardless of whether the send originates from a flow step or a broadcast — implement this as the same shared pre-send gate as quiet hours (Pitfall 6), not duplicated.
- Also reconcile against SendGrid's own suppression lists (bounces, spam reports, global unsubscribes) periodically, since SendGrid will drop sends to its own suppressed addresses silently (bounce-drop events) — don't assume your own status table is the only place suppression can happen.
- Ensure the unsubscribe link driven by SendGrid actually updates *your* database status (via the webhook), not just SendGrid's internal suppression, or a contact could still show as "subscribed" in your segmentation and analytics while SendGrid quietly drops their mail.
- CAN-SPAM requires unsubscribe honored within 10 business days and a visible link on every message including flow follow-up steps; GDPR requires unsubscribe to be at least as easy as signup and erasure requests honored within a month across all stores, including suppression records.

**Warning signs:**
- Two different tables/flags represent "is this contact allowed to receive email" and they can disagree.
- A support ticket says "I unsubscribed but still got emails from the other campaign."

**Phase to address:**
Subscription status / compliance phase — must exist before the first flow or broadcast ships, since this is explicitly called out as a day-one requirement in this project.

*Confidence: MEDIUM.*

---

### Pitfall 8: Multi-tenant data isolation fails under connection pooling, not just missing WHERE clauses

**What goes wrong:**
Even with tenant_id filtering (application-level or Postgres RLS), data leaks across tenants under load: a pooled DB connection retains a previous tenant's session-level context (RLS `current_setting`/GUC) after a crashed or aborted transaction fails to reset it, and the next request on that same pooled connection — for a *different* tenant — silently reads or writes the wrong tenant's rows. Shared caches (Redis) suffer the analogous bug if keys aren't tenant-prefixed.

**Why it happens:**
RLS-based isolation is usually implemented and tested against a single request/response cycle in development, where connection reuse edge cases don't surface. It's an infrastructure-level failure mode (pooler/proxy behavior under errors) rather than a query-logic bug, so it's invisible to code review of individual queries.

**How to avoid:**
- If using Postgres RLS with a connection pooler (pgBouncer, Prisma's pool, etc.), ensure `SET app.current_tenant` (or equivalent) is set at the *start of every request* inside the same transaction as the query, and use `RESET ALL`/`DISCARD ALL` enforced by the pooling layer on connection release — never assume a "clean" pooled connection.
- Never grant the application's DB role `BYPASSRLS` or superuser.
- Store tenant context in request-scoped storage (e.g., AsyncLocalStorage in Node), never in a module-level/global variable or singleton, to avoid leaking across concurrent requests sharing the same process.
- Prefix every Redis key with `tenant_id`, including queue job payloads and rate-limit counters — a job or cache key without a tenant prefix is a cross-tenant leak waiting to happen.
- Treat "every new table with a tenant_id column must have an RLS policy" as a mandatory code-review checklist item / CI check, not a one-time setup step.

**Warning signs:**
- Load or chaos testing (killing connections mid-transaction) reveals a request occasionally returning another tenant's rows.
- Any table with a `tenant_id` column that lacks a corresponding RLS policy.
- Queue jobs or cache keys constructed without an explicit tenant_id component.

**Phase to address:**
Multi-tenancy foundation phase — this is infrastructure that every later phase depends on; must be verified with pooling-failure test cases before other phases build on top of it.

*Confidence: MEDIUM — cross-checked across multiple independent write-ups on Postgres RLS + connection pooling failure modes.*

---

### Pitfall 9: Editing a live flow corrupts contacts already mid-flow

**What goes wrong:**
A marketer edits a published flow (adds/removes a node, changes a delay, changes branching logic) while thousands of contacts are actively mid-execution. Contacts already "at" a node that no longer exists get stuck or error out; contacts at a node whose downstream logic changed unexpectedly skip or repeat steps; timing changes mid-flight change delay semantics for contacts who already started waiting.

**Why it happens:**
The canvas editor naturally models "the flow" as one mutable document. Without an explicit versioning model, saving an edit is applied to the same definition that's actively driving execution state machines for in-progress contacts, with no plan for what happens to them.

**How to avoid:**
- Treat every published flow as an immutable version. Editing creates a new draft version; publishing creates version N+1. Each `flow_run` (a contact's execution instance) is stamped with the version id at entry time and continues executing against that exact version's node graph until it exits, regardless of later edits.
- Give the marketer an explicit choice when publishing a new version: "contacts currently in the flow stay on the old version until they exit" (default, safest) vs. an explicit (harder, v2+) "migrate in-flight contacts to the new version at their nearest equivalent node" — do not default to silently migrating.
- Store node graphs by content-addressed version so a step execution can always resolve "which exact node/edge definition applies to this run," even if the human-readable flow has since changed.

**Warning signs:**
- No `flow_version` concept in the data model — flows are a single mutable row/document referenced directly by in-progress runs.
- QA can't answer "what happens to a contact currently at node X if I delete node X and republish?"

**Phase to address:**
Flow builder / flow execution engine phase — the versioning model must exist before the canvas editor allows publishing edits to a flow with active contacts, since retrofitting immutable versioning after contacts are already running against a mutable definition requires a data migration and behavioral decision made under pressure.

*Confidence: LOW — general workflow-versioning pattern inferred from adjacent platforms (Salesforce Flow migration tooling, general workflow-engine literature); no single authoritative Klaviyo-specific source found.*

---

### Pitfall 10: BYO SendGrid key model hides sender-reputation and authentication problems from the platform

**What goes wrong:**
Because each tenant brings their own SendGrid API key, domain authentication (SPF/DKIM), and sending reputation live entirely in the tenant's own SendGrid account — invisible to the platform unless explicitly surfaced. A tenant's shared-IP reputation degrading (because SendGrid pools IP reputation across many unrelated senders on lower-tier plans), or DKIM silently breaking after a DNS change, causes deliverability to collapse with no visibility on the platform side, and support has no way to diagnose "why are my emails not arriving" without deep SendGrid account access per tenant.

**Why it happens:**
BYO key was chosen deliberately to avoid owning deliverability/reputation as a platform concern in v1 — but that decision means the platform has no data of its own about delivery health unless it actively pulls SendGrid's stats/webhook events per tenant and surfaces them.

**How to avoid:**
- Surface bounce rate, spam-report rate, and domain-authentication status (via SendGrid's webhook events plus periodic API checks) per-tenant in the platform UI/dashboard so degrading reputation is visible before it becomes a support fire — this is a natural extension of the analytics requirement already in scope.
- Validate the tenant's API key permissions and domain authentication status at connection time (when they paste their key in) and periodically thereafter, rather than only discovering a broken key/auth at send time.
- Document clearly that suppression lists live in the tenant's own SendGrid account; if the platform maintains its own subscription-status table (per Pitfall 7), reconcile rather than assume — a tenant's manual SendGrid-side changes (e.g., manually removing someone from SendGrid suppression) can desync from the platform's own status.

**Warning signs:**
- No dashboard surface for bounce/spam-complaint rate or domain auth status.
- Support has no way to answer "is this tenant's sending reputation healthy" without asking the tenant to log into their own SendGrid account.

**Phase to address:**
SendGrid connection phase (initial key setup) and analytics/dashboard phase — validation at connection time is cheap to add early; ongoing reputation visibility can be phased in once webhook ingestion exists.

*Confidence: MEDIUM.*

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|--------------------|-----------------|------------------|
| Single shared send queue for broadcast + triggered | Simpler worker code, faster MVP | Broadcasts starve triggered sends at real scale (Pitfall 4) | Never for this project — stated as a day-one architectural constraint |
| Recompute segment membership live at send time via SQL joins | No extra infra, simpler mental model | Query time grows unboundedly with events table size (Pitfall 5) | Acceptable only below a few thousand contacts / early internal testing |
| Dedupe webhook events by request hash instead of `sg_event_id` | Easier to implement | Misses duplication within/across batches; double-counts analytics (Pitfall 3) | Never |
| Mutable flow definition with no versioning | Simplest canvas editor + execution model | Breaks contacts mid-flow when a published flow is edited (Pitfall 9) | Only acceptable if editing a published flow with active contacts is explicitly disallowed (must archive/clone instead) — otherwise never |
| Tenant status flag as an app-level `WHERE tenant_id = ?` without RLS | Faster to ship initial CRUD | One missed WHERE clause anywhere in the codebase is a cross-tenant leak (Pitfall 8) | Acceptable short-term only if paired with mandatory RLS added before first paying tenant, and never for tables holding contact PII |
| Trust SendGrid suppression as sole source of truth (skip platform-side status) | Less to build in v1 | Contradicts project's stated compliance decision; also means segmentation/analytics can't reflect subscription state | Never — explicitly out of scope per project decisions |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| SendGrid Event Webhook | Verifying signature against parsed/re-serialized JSON body | Verify against raw request bytes before any body-parsing middleware runs; exclude webhook route from global JSON parser |
| SendGrid Event Webhook | Deduping by HTTP request instead of per-event `sg_event_id` | Store processed `sg_event_id`s with a unique constraint; ack (2xx) fast, process asynchronously |
| SendGrid mail/send | Assuming mail/send shares the general 600 req/min rate limit | mail/send itself is not rate-limited the same way, but has a 1000-recipient/call cap and account-level sending limits tied to plan; design batching around recipient caps, not just RPS |
| SendGrid BYO API key | Storing/using the tenant's raw API key in application code paths without validating scopes/permissions at connection time | Validate key permissions (mail.send, at minimum) and domain authentication status when the tenant connects, and periodically after |
| SendGrid subusers/suppression | Bulk-editing or deleting SendGrid suppression entries via API without a targeted, reviewed list | Treat suppression-list mutation endpoints as high-blast-radius; never pass unreviewed/bulk arrays to deletion endpoints |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| Ad-hoc joins across raw events table for segmentation | Segment preview/count takes seconds-to-minutes | Materialized/incrementally-updated segment membership table, proper composite indexes | Noticeable above ~100k events per tenant; painful at the project's stated 100k–1M contact scale |
| Single BullMQ queue for all sends | Triggered sends delayed during broadcast fan-out | Separate priority queues/lanes for triggered vs. broadcast, shared RPS budget with a reserved floor for triggered | Any broadcast exceeding low tens of thousands of recipients on a shared queue |
| Per-contact synchronous SendGrid API calls in a tight loop for broadcasts | Broadcast dispatch throughput bottlenecked by network round-trips, worker pool exhaustion | Batch via SendGrid's up-to-1000-recipient personalizations per call where suitable, or parallelize across a bounded worker pool with the token-bucket rate limiter | Broadcasts in the tens-of-thousands-plus range |
| Storing all contact events in one unpartitioned table indefinitely | Table bloat, slower scans, autovacuum pressure as history grows across all tenants | Partition by time (and/or tenant) once volume projections approach the stated 1M-contact scale; archive/roll up old raw events | Multi-tenant aggregate event volume in the tens of millions of rows |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Storing tenant SendGrid API keys in plaintext | Full account takeover of tenant's SendGrid (send-as-them, read suppression/stats) if the platform DB is breached | Encrypt at rest (e.g., envelope encryption with a KMS-managed key), never log the key, redact in error messages/telemetry |
| Global/module-level tenant context variable | Cross-tenant data leak under concurrent request handling in Node's event loop | Use request-scoped context (AsyncLocalStorage) exclusively for tenant identity |
| No RLS on newly added tables | Silent cross-tenant read/write once a new feature table is added without following the isolation pattern | Enforce via CI/lint check: any table with tenant_id must have a corresponding RLS policy before merge |
| Trusting webhook payload without signature verification (or with verification quietly disabled after a body-parsing bug) | Attacker forges delivery/bounce/unsubscribe events, corrupting suppression status or analytics, or forcing incorrect unsubscribes | Always verify SendGrid's ECDSA signature on raw bytes; fail closed (reject unverified payloads) rather than fail open |
| Unbounded suppression-list bulk mutation via API | A single bad API call (or bug, or hallucinated input if any AI-assisted admin tooling is used) can wipe thousands of suppression records, instantly tanking sender reputation | Require explicit, reviewed, size-bounded batches for any bulk suppression mutation; log and confirm destructive operations |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|--------------|-------------------|
| Marketer can publish an edit to a flow with active contacts with no warning | Contacts get stuck, skipped, or duplicated mid-flow (Pitfall 9); marketer has no idea until support tickets arrive | Warn explicitly at publish time ("N contacts are currently in this flow; they will continue on the previous version") and make versioning visible in the UI |
| No visibility into send-queue health or delivery lag for a broadcast | Marketer discovers hours later that a "sent" campaign is still trickling out due to rate limiting | Surface real-time send progress (queued/sent/delivered/failed counts) for broadcasts, not just a final summary |
| Canvas editor allows building a cycle with no exit condition | Contacts silently loop forever or hit a runtime error with no clear diagnostic | Static cycle-detection at save/publish time with a clear UI error pointing at the offending nodes, plus a runtime max-iteration safety guard as defense in depth |
| Segment preview count is stale/cached without indication | Marketer launches a broadcast believing audience size is X when it has since changed materially | Show a "last calculated at" timestamp on segment counts and recompute (or clearly flag staleness) before a broadcast send is confirmed |

## "Looks Done But Isn't" Checklist

- [ ] **Webhook signature verification:** Verify it's tested against the *raw* HTTP request, not a hand-constructed JSON string in a unit test — check the middleware ordering, not just the verification function.
- [ ] **Idempotent flow execution:** Verify a step can be safely re-run (simulate a worker crash mid-step and confirm no duplicate send occurs) — don't just verify the happy path sends once.
- [ ] **Quiet hours / frequency cap:** Verify it's enforced identically for flow-triggered sends and broadcasts, not only one of the two paths.
- [ ] **Suppression/unsubscribe:** Verify an unsubscribe recorded via webhook actually blocks sends from *every* flow and broadcast, not just the one the contact unsubscribed through — test with a contact enrolled in two concurrent flows.
- [ ] **Multi-tenant isolation:** Verify with an actual pooled-connection failure/crash test (kill a connection mid-transaction) that no cross-tenant data appears on the next request using that connection — don't rely solely on "the WHERE clause is correct in code review."
- [ ] **Broadcast vs. triggered priority:** Verify by launching a large test broadcast and confirming a simultaneously-triggered flow email still arrives within the target SLA, not just that both eventually arrive.
- [ ] **Flow versioning:** Verify by publishing an edit to a flow with contacts actively mid-execution and confirming those contacts complete on the version they started, without error.
- [ ] **Segment performance:** Verify segment count/preview response time against a realistic seeded dataset at the target scale (hundreds of thousands of contacts/events), not just a demo dataset of dozens of rows.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|-----------------|
| Duplicate sends discovered in production | MEDIUM | Add idempotency table retroactively; backfill dedup keys for recent runs from send logs; communicate/apologize to affected tenants if volume is significant |
| Webhook signature verification found disabled/broken | LOW–MEDIUM | Fix raw-body handling, add integration test with real signed payload, audit recent webhook-driven status changes for any that came from unverified (potentially spoofed) events |
| Cross-tenant data leak found via pooled connections | HIGH | Immediately audit connection-pool reset behavior, add `DISCARD ALL`/explicit reset enforcement, security-review all tables for missing RLS, notify affected tenants per data-breach obligations if PII was exposed |
| Segment queries too slow at scale | MEDIUM | Introduce materialized segment-membership table incrementally (backfill in batches to avoid locking), add composite indexes with `CREATE INDEX CONCURRENTLY` to avoid downtime |
| Flow edited while contacts mid-flow, contacts broke | MEDIUM–HIGH | Introduce versioning model, snapshot current flow definitions as "version 1" for all currently-running flow_runs, manually triage/repair contacts stuck at now-invalid nodes |
| Broadcast starved triggered sends in production | LOW–MEDIUM | Split queues retroactively (new queue for triggered, redirect broadcast jobs), backfill priority for any currently-queued triggered jobs so they jump ahead |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| Duplicate sends (non-idempotent execution) | Flow execution engine / send queue phase | Chaos test: kill worker mid-step execution, confirm no duplicate send |
| Webhook signature verification breaking on parsed body | Webhook ingestion phase | Integration test replaying a real signed payload through the full HTTP stack |
| Webhook event duplication / out-of-order processing | Webhook ingestion phase | Replay a duplicate batch and an out-of-order batch; confirm state converges correctly |
| Broadcast starving triggered sends | Send queue / infrastructure phase | Load test: large broadcast running concurrently with a triggered send; measure triggered-send latency |
| Segmentation query performance at scale | Event ingestion + segmentation phases (schema decided early, query strategy in segmentation phase) | Benchmark segment count/preview against seeded dataset at target scale |
| Quiet hours / timezone only partially enforced | Flow execution engine phase | Test a flow-triggered send scheduled to land during quiet hours; confirm deferral, not drop or ignore |
| Suppression/unsubscribe not globally enforced | Subscription status / compliance phase | Enroll a contact in two flows, unsubscribe via one, confirm the other stops sending too |
| Multi-tenant data leak via pooled connections | Multi-tenancy foundation phase | Pooled-connection crash/reset test across simulated concurrent tenants |
| Flow versioning breaking mid-flow contacts | Flow builder / execution engine phase | Publish an edit while contacts are active mid-flow; confirm no errors/duplicate/skip |
| BYO key reputation/auth invisibility | SendGrid connection phase + analytics/dashboard phase | Verify dashboard surfaces bounce/spam rate and domain-auth status per tenant |

## Sources

- [Getting Started with the Event Webhook Security Features | SendGrid Docs | Twilio](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
- [sendgrid-nodejs/docs/use-cases/event-webhook.md · sendgrid/sendgrid-nodejs](https://github.com/sendgrid/sendgrid-nodejs/blob/main/docs/use-cases/event-webhook.md)
- [Signed Webhook event verification fails when payload is a JSON String · Issue #722 · sendgrid/sendgrid-java](https://github.com/sendgrid/sendgrid-java/issues/722)
- [Rate Limits | SendGrid Docs | Twilio](https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/rate-limits)
- [SendGrid 429 Too Many Requests - Integration Diagnosis](https://drdroid.io/integration-diagnosis-knowledge/sendgrid-429-too-many-requests)
- [Queue priority between batch and triggered campaigns - Marketo Nation](https://nation.marketo.com/t5/product-discussions/queue-priority-between-batch-and-triggered-campaigns/td-p/344006)
- [Bloomreach Transactional Emails: API Integration and Email Fallback](https://documentation.bloomreach.com/engagement/docs/transactional-emails)
- [Triggered Emails in Email Studio - Salesforce Help](https://help.salesforce.com/s/articleView?id=sf.mc_es_triggered_emails.htm&language=en_US&type=5)
- [Multi-Tenant Leakage: When "Row-Level Security" Fails in SaaS | InstaTunnel](https://medium.com/@instatunnel/multi-tenant-leakage-when-row-level-security-fails-in-saas-da25f40c788c)
- [Multi-tenant data isolation with PostgreSQL Row Level Security | AWS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- [Postgres RLS Implementation Guide - Best Practices, and Common Pitfalls | Permit.io](https://www.permit.io/blog/postgres-rls-implementation-guide)
- [Understanding SMS and MMS quiet hours in flows | Klaviyo Help Center](https://help.klaviyo.com/hc/en-us/articles/4408737146651)
- [How Top Platforms Handle Notification Quiet Hours & Delivery Windows | Courier](https://www.courier.com/blog/quiet-hours-delivery-windows)
- [Email marketing compliance: CAN-SPAM, CASL, and GDPR - DailyStory](https://www.dailystory.com/blog/6-ways-to-comply-with-email-marketing-laws/)
- [What Are the Legal Requirements for Follow-Up Emails Under GDPR and CAN-SPAM?](https://instantly.ai/blog/what-are-the-legal-requirements-for-follow-up-emails/)
- [Email Deliverability: Shared IP Pools 101 - SendGrid Support](https://support.sendgrid.com/hc/en-us/articles/17326626295579-Email-Deliverability-Shared-IP-Pools-101)
- [Understanding Delayed Bounces - SendGrid Support](https://support.sendgrid.com/hc/en-us/articles/9624271234331-Understanding-Delayed-Bounces)
- [SendGrid Deliverability Problems: Common Issues & Fixes](https://www.sh.consulting/blog/sendgrid-deliverability-problems-common-issues-and-how-to-fix-them)
- [Edit an active Workflow - Zoho Campaigns Help](https://help.zoho.com/portal/en/kb/campaigns/user-guide/marketing-automation/workflows/articles/edit-an-active-workflow)
- [Idempotency Architecture for Lambda-Driven Systems on AWS - DEV Community](https://dev.to/aws-builders/idempotency-architecture-for-lambda-driven-systems-on-aws-3hp4)
- [How I Solved It: Interrupt the Dreaded "Infinite New-Case-Loop" - Salesforce Admins](https://admin.salesforce.com/blog/2023/how-i-solved-it-interrupt-the-dreaded-infinite-new-case-loop)

---
*Pitfalls research for: Multi-tenant B2C email marketing automation SaaS (Klaviyo-like flows + broadcasts, SendGrid delivery)*
*Researched: 2026-07-03*
