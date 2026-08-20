# Architecture Research

**Domain:** Multi-tenant B2C email marketing automation (Klaviyo-style flows + broadcast campaigns, SendGrid delivery)
**Researched:** 2026-07-03
**Confidence:** MEDIUM-HIGH (component decomposition and data model: HIGH — standard, well-established patterns cross-checked across multiple independent sources; specific library recommendations (BullMQ mechanics): HIGH, sourced from official docs; SendGrid webhook signature/idempotency: HIGH, sourced from official Twilio/SendGrid docs; flow-engine-as-DB-state-machine vs dedicated workflow engine: MEDIUM, architectural judgment call for this scale)

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          EDGE / API LAYER                                 │
├──────────────────────────────────────────────────────────────────────────┤
│  ┌───────────────┐ ┌───────────────┐ ┌──────────────┐ ┌────────────────┐ │
│  │ App API       │ │ Event Ingest  │ │ Contacts API │ │ SendGrid Webhook│ │
│  │ (auth, UI CRUD│ │ API (server-  │ │ (CRUD +      │ │ Receiver        │ │
│  │  flows,       │ │ side, API key)│ │  CSV import) │ │ (per-tenant URL)│ │
│  │  campaigns)   │ │               │ │              │ │                 │ │
│  └───────┬───────┘ └───────┬───────┘ └──────┬───────┘ └────────┬────────┘ │
├──────────┴─────────────────┴────────────────┴──────────────────┴─────────┤
│                        DOMAIN / SERVICE LAYER                             │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌───────────┐ ┌────────────┐ ┌────────────┐ ┌───────────┐ ┌────────────┐ │
│ │Contact &   │ │Segmentation│ │Flow Trigger│ │Flow       │ │Campaign    │ │
│ │Subscription│ │Engine      │ │Evaluator   │ │Execution  │ │Orchestrator│ │
│ │Service     │ │(static+beh)│ │            │ │Engine     │ │(broadcast) │ │
│ └───────────┘ └────────────┘ └────────────┘ └───────────┘ └────────────┘ │
│ ┌────────────────────┐ ┌──────────────────┐ ┌───────────────────────┐    │
│ │ Send Orchestrator   │ │ SendGrid Dispatch │ │ Webhook Event         │    │
│ │ (priority + RPS     │ │ Worker (mail/send │ │ Processor (verify,    │    │
│ │  throttle per tenant│ │  + Dynamic Tmpl)  │ │  dedupe, status write)│    │
│ └────────────────────┘ └──────────────────┘ └───────────────────────┘    │
│ ┌───────────────────────────────────────────────────────────────────┐    │
│ │ Analytics Aggregator (rollups: campaign stats, flow-step stats,   │    │
│ │ contact timeline read model)                                      │    │
│ └───────────────────────────────────────────────────────────────────┘    │
├──────────────────────────────────────────────────────────────────────────┤
│                        QUEUE / ASYNC LAYER (Redis + BullMQ)               │
│  events-to-evaluate │ flow-timers-due │ send:triggered │ send:broadcast   │
│  webhook-events-in  │ segment-recompute │ analytics-rollup                │
├──────────────────────────────────────────────────────────────────────────┤
│                          STORAGE LAYER (Postgres)                          │
│  ┌───────────┐ ┌──────────┐ ┌───────────┐ ┌───────────┐ ┌──────────────┐ │
│  │ contacts  │ │ events   │ │ flows /   │ │ campaigns │ │ sends /      │ │
│  │           │ │(append-  │ │ flow_runs │ │           │ │ email_events │ │
│  │           │ │ only)    │ │           │ │           │ │              │ │
│  └───────────┘ └──────────┘ └───────────┘ └───────────┘ └──────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

Postgres is the **source of truth** for every domain object and every piece of state (contact, flow-run position, send status). Redis/BullMQ is a **signaling and scheduling layer only** — it tells workers "something is ready," it never holds state that isn't recoverable by re-reading Postgres. This distinction matters a lot at this scale: it means a Redis flush or queue restart is an availability incident, not a data-loss incident, as long as workers reconcile against Postgres on boot (see Anti-Patterns).

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|-------------------------|
| Event Ingestion API | Authenticate tenant via API key, validate minimal shape (name + properties), upsert contact (external_id → fallback email), write append-only event row, enqueue evaluation job | Fastify/Express route, returns 202 fast, writes are the only synchronous work |
| Contact & Subscription Service | CRUD, CSV import w/ column mapping, subscription status source of truth, suppression checks before every send | Service layer over `contacts` table; suppression check is a single indexed lookup called by Send Orchestrator |
| Segmentation Engine | Evaluate static (property) and dynamic (behavioral/event-based) segment definitions; maintain materialized membership | Property segments: SQL filter over `contacts.properties` (JSONB + expression indexes). Behavioral segments: incremental recompute triggered off the event queue, not full rescans |
| Flow Trigger Evaluator | Consume ingestion events, match against active flow trigger definitions per tenant, check entry/reentry rules (once-ever, once-per-N-days, every-time), quiet hours, create `flow_runs` row | Stateless worker consuming `events-to-evaluate` queue; all decisions read/write Postgres |
| Flow Execution Engine | Own the state machine per contact-in-flow: current node, wait/delay timers, branching, exit conditions, global frequency cap | `flow_runs` table is the state; a scheduler polls due timers + BullMQ delayed jobs act as a wake-up nudge (belt-and-suspenders, see Patterns) |
| Campaign Orchestrator | Broadcast lifecycle: draft → scheduled → sending → sent; resolves segment to a contact list snapshot at send time, enqueues sends in batches | Batches large sends (10k-100k contacts) into chunks to avoid single giant transactions |
| Send Orchestrator | Merges triggered + broadcast demand into a single dispatch path with per-tenant RPS throttling and priority; broadcast must never starve triggered | BullMQ priority + per-tenant rate limiter (token bucket); see Patterns |
| SendGrid Dispatch Worker | Calls `mail/send` v3 with `template_id` + `dynamic_template_data`, handles 429/5xx backoff, records provider message id | Pulls tenant's SendGrid key at dispatch time (decrypt on read), never at enqueue time |
| SendGrid Webhook Receiver | Per-tenant HTTPS endpoint, verifies ECDSA signature using that tenant's webhook verification key, acks fast (<10s), pushes raw payload to queue | Route path encodes `workspace_id` so the correct verification key is looked up *before* trusting payload contents |
| Webhook Event Processor | Dedupe by `sg_event_id`, update `sends`/`email_events`, flip subscription status on bounce/unsubscribe, feed flow re-entry signals (e.g. "if opened" branches) | Async worker off `webhook-events-in` queue; idempotent upsert keyed on `sg_event_id` |
| Analytics Aggregator | Rollup campaign/flow-step stats, power contact timeline and workspace dashboard | Incremental rollups on webhook processing + periodic reconciliation job, not full table scans per page view |

## Recommended Project Structure

```
src/
├── modules/
│   ├── tenancy/            # workspaces, membership, roles, sendgrid credential storage
│   ├── contacts/           # contact CRUD, CSV import, upsert-from-event logic
│   ├── events/             # ingestion API, event store, event→segment/flow fan-out
│   ├── segments/           # segment definitions, membership materialization
│   ├── flows/              # flow definitions + versions, trigger evaluator, execution engine
│   ├── campaigns/          # broadcast lifecycle
│   ├── delivery/           # send orchestrator, priority/rate-limit logic, SendGrid client
│   ├── webhooks/           # per-tenant webhook receiver, signature verification, event processor
│   └── analytics/          # rollups, dashboard/read-model queries
├── queue/                  # BullMQ queue + worker definitions, shared job schemas
├── db/                     # migrations, schema, repositories
├── api/                    # HTTP layer: routers wiring modules to Fastify/Express
└── workers/                # standalone worker entrypoints (deployed separately from API)
```

### Structure Rationale

- **modules/ by domain, not by technical layer:** flows, campaigns, and delivery are separate modules because they have different lifecycles and different teams-of-one will touch them at different roadmap phases — this maps directly to phase boundaries in the roadmap.
- **delivery/ is deliberately separate from flows/ and campaigns/:** both triggered and broadcast sends must converge on one throttled dispatch path. If send logic lived inside `flows/` or `campaigns/`, the "broadcast must not starve triggered" constraint would be impossible to enforce centrally.
- **workers/ deployed separately from api/:** ingestion API must stay low-latency; flow evaluation, dispatch, and webhook processing are all background workers that should scale independently and never share a process with the public HTTP API.

## Architectural Patterns

### Pattern 1: Postgres-as-truth, queue-as-doorbell

**What:** Every durable fact (contact state, flow-run position, send status) lives in Postgres. BullMQ jobs only ever say "go look at row X, something changed." Workers are idempotent: on receiving a job, they re-read current state from Postgres and decide what to do — they never trust the job payload as the sole source of truth.
**When to use:** Any workflow/timer/queue system where losing an in-memory or Redis-only job would silently corrupt business state (email sends, billing, flow progression all qualify).
**Trade-offs:** Slightly more DB round-trips per job than a "smart payload" approach; in exchange you get free recovery from Redis restarts, easy debugging (state is always a SQL query away), and safe replay of jobs.

**Example:**
```typescript
// Worker never trusts job.data as truth — re-reads from Postgres
async function processFlowTimer(job: Job<{ flowRunId: string }>) {
  const run = await db.flowRuns.findById(job.data.flowRunId);
  if (!run || run.status !== "waiting" || run.nextWakeAt > new Date()) {
    return; // stale job, state already moved on — safe no-op
  }
  await advanceFlowRun(run);
}
```

### Pattern 2: Dual-queue priority with per-tenant token bucket (not a single global rate limiter)

**What:** Two logical lanes feed the same SendGrid dispatch pool — `send:triggered` (high priority) and `send:broadcast` (low priority) — using BullMQ job priority. Each tenant additionally gets its own rate limiter (token bucket, tuned to that tenant's SendGrid plan/reputation), enforced at dequeue time, so one tenant's broadcast blast can't consume the shared worker pool.
**When to use:** Any system where multiple send sources compete for a rate-limited external API and different sources have different latency sensitivity (triggered flow emails are time-sensitive — "abandoned cart 1 hour later" — broadcast sends are not).
**Trade-offs:** Requires per-tenant limiter state (Redis-backed), a bit more operational surface than one global limiter, but it's the only design that satisfies "broadcast must not starve triggered" *and* isolates noisy tenants from each other — both are explicit constraints for this project.

**Example:**
```typescript
// Weighted dequeue: always drain triggered first, then top up with broadcast
// up to the tenant's remaining per-second budget.
const budget = await tenantRateLimiter.remaining(tenantId); // token bucket
const triggeredJobs = await sendQueue.getJobs(["waiting"], { priority: HIGH, tenantId }, budget);
const remaining = budget - triggeredJobs.length;
if (remaining > 0) {
  const broadcastJobs = await sendQueue.getJobs(["waiting"], { priority: LOW, tenantId }, remaining);
}
```

### Pattern 3: Flow definitions are versioned, flow runs pin to a version

**What:** Editing a live flow in the canvas editor creates a new `flow_version` row; in-flight `flow_runs` keep executing against the version they entered on. New entrants use the latest published version.
**When to use:** Any workflow engine with a visual editor that can be modified while instances are executing (this is universal in marketing automation — Klaviyo, HubSpot, ActiveCampaign all version flows).
**Trade-offs:** Slightly more storage (flow definition snapshots), but prevents the class of bug where a marketer edits a flow mid-campaign and active contacts jump to nodes that no longer make sense for their history — a correctness requirement, not a nice-to-have.

## Data Flow

### Event Ingestion → Flow Trigger

```
POST /events (tenant API key)
    ↓
Validate + authenticate → resolve workspace
    ↓
Upsert contact (external_id, fallback email) ─┐
    ↓                                          │
Write events row (append-only)                 │ same transaction
    ↓                                          │
Enqueue "evaluate-event" job ──────────────────┘
    ↓ (async, separate worker)
Flow Trigger Evaluator: match event → active flow triggers for tenant
    ↓
Check entry rules (segment membership, reentry policy, quiet hours, freq cap)
    ↓
Create flow_runs row (status=active, current_node=entry, next_wake_at=now)
    ↓
Enqueue "advance-flow-run" job
```

### Flow Execution (delay/branch nodes)

```
advance-flow-run job
    ↓
Load flow_runs row + pinned flow_version definition
    ↓
Execute current node:
  - Send node   → enqueue send job (priority=triggered), advance to next node
  - Delay node  → set next_wake_at = now + delay, status=waiting, enqueue BullMQ
                  delayed job for next_wake_at as a wake-up nudge
  - Branch node → evaluate condition against contact/segment state, pick edge
  - Exit node   → status=completed
    ↓
Persist new state to flow_runs (audit row appended to flow_run_steps)
```

A scheduled reconciliation job periodically scans `flow_runs where status='waiting' and next_wake_at <= now()` — this is the safety net if a BullMQ delayed job is ever lost (Redis eviction, deploy race). It's cheap (indexed range scan) and makes the whole engine self-healing.

### Send → Dispatch → Webhook → Analytics

```
[Flow Execution]  ─┐
                    ├─→ send:triggered queue ─┐
[Campaign            │                         ├─→ Send Orchestrator (priority +
 Orchestrator]  ─────┴─→ send:broadcast queue ─┘    per-tenant RPS throttle)
                                                      ↓
                                          SendGrid Dispatch Worker
                                          (decrypt tenant key, mail/send v3,
                                           template_id + dynamic_template_data,
                                           custom_args: {send_id, workspace_id})
                                                      ↓
                                          sends row: status=sent, provider_message_id
                                                      ↓
                                    ── SendGrid delivers, tracks, later posts events ──
                                                      ↓
                          Per-tenant Webhook URL (/webhooks/sendgrid/:workspaceId/:token)
                                                      ↓
                       Verify ECDSA signature using *that workspace's* verification key
                                                      ↓
                              202 ack immediately → enqueue raw payload
                                                      ↓
                          Webhook Event Processor: dedupe by sg_event_id,
                          upsert email_events, update sends.status,
                          flip contacts.subscription_status on bounce/unsubscribe
                                                      ↓
                          Analytics Aggregator: incremental rollup into
                          campaign_stats / flow_step_stats / contact timeline
```

**Key correlation detail:** because every tenant uses their *own* SendGrid account (BYO key), the webhook payload alone cannot tell you which workspace it belongs to — `custom_args` can carry `workspace_id`/`send_id`, but you cannot trust unverified payload data to choose *which signing key to verify against*. The workspace must be identifiable from the **URL path** (a per-tenant, secret-bearing webhook URL configured in that tenant's own SendGrid account settings), and the tenant's Event Webhook verification public key must be stored at connection time and looked up by that same path segment before signature verification runs. Get this wrong and you either can't verify signatures at all, or you verify against the wrong tenant's key.

## Storage Model (core tables)

| Table | Key columns | Notes |
|-------|-------------|-------|
| `workspaces` | id, name, sendgrid_api_key_encrypted, webhook_verification_key | BYO key + per-tenant webhook secret live here |
| `contacts` | id, workspace_id, external_id, email, properties (jsonb), subscription_status, created_at | `unique(workspace_id, external_id)`, `unique(workspace_id, email)`; GIN index on `properties` for property segments |
| `events` | id, workspace_id, contact_id, name, properties (jsonb), occurred_at, received_at | Append-only; index on `(workspace_id, contact_id, occurred_at)` and `(workspace_id, name, occurred_at)`; candidate for time-range partitioning once volume warrants (see Scaling) |
| `segments` | id, workspace_id, kind (static/dynamic), definition (jsonb) | Dynamic segment definitions reference event/property predicates |
| `segment_memberships` | segment_id, contact_id, computed_at | Materialized; incrementally maintained off the event queue for behavioral segments, recomputed on a schedule for property segments |
| `flows` | id, workspace_id, status (draft/live/archived) | Parent record; canvas definition lives in `flow_versions` |
| `flow_versions` | id, flow_id, definition (jsonb: nodes/edges), published_at | Immutable once published |
| `flow_runs` | id, flow_id, flow_version_id, contact_id, status, current_node_id, state (jsonb), next_wake_at, entered_at | The state machine; one row per contact-in-flow |
| `flow_run_steps` | flow_run_id, node_id, executed_at, result | Audit trail, powers per-contact timeline |
| `campaigns` | id, workspace_id, segment_id, template_id, status, scheduled_at | Broadcast lifecycle |
| `sends` | id, workspace_id, contact_id, campaign_id (nullable), flow_run_id (nullable), node_id (nullable), priority, provider_message_id, status, queued_at, sent_at | The single table both triggered and broadcast paths write to — this is what makes cross-cutting rate limiting possible |
| `email_events` | id, send_id, sg_event_id (unique), event_type, occurred_at, raw_payload | `sg_event_id` unique constraint *is* the idempotency mechanism |
| `campaign_stats` / `flow_step_stats` | aggregated counts by type | Rollup/read-model tables, rebuilt incrementally from `email_events` |

Multi-tenant isolation: every table above carries `workspace_id` (directly or via a parent FK). Given the target scale (100k–1M contacts, hundreds of thousands of emails/day across all tenants — not per tenant), a **shared-tables-with-`workspace_id`** model is the right default; Postgres Row-Level Security is worth adding as a defense-in-depth layer once the app-layer tenant scoping is proven, but is not required to ship v1. Schema-per-tenant is not warranted at this scale and adds migration/ops overhead disproportionate to the benefit.

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Pilot tenants, <10k contacts each | Single Postgres instance, single Redis instance, no partitioning needed. Shared-table + `workspace_id` index is sufficient. |
| 100k–1M contacts total, 10s–100s of thousands emails/day | Composite indexes on `(workspace_id, contact_id, occurred_at)` for `events`; materialized `segment_memberships` (not live joins) for dashboard/segment-count queries; batch broadcast sends into chunks (e.g. 5-10k contacts per enqueue batch) rather than one job per contact synchronously; per-tenant token-bucket rate limiter sized to each tenant's actual SendGrid plan. |
| Growth beyond this (multi-million events/month, very large single broadcasts) | Time-range partition the `events` and `email_events` tables (monthly); consider read replicas for analytics/dashboard queries so rollups don't contend with the write-heavy ingestion path; consider moving `segment_memberships` recompute to a dedicated worker pool separate from flow evaluation workers. |

### Scaling Priorities

1. **First bottleneck:** the `events` table's write and read pattern (ingestion writes + behavioral segment recompute reads). Mitigate early with the right composite indexes; don't reach for partitioning until row counts or index bloat actually show it (avoid premature optimization — the target scale in this project's first year does not require it, but the schema should be partition-friendly from day one, e.g. include `occurred_at` in the primary access pattern).
2. **Second bottleneck:** broadcast sends to large segments overwhelming the send queue and starving triggered sends. Mitigate with the dual-queue-priority + per-tenant-rate-limit pattern from day one — this is called out explicitly as a hard constraint, not an optimization to defer.

## Anti-Patterns

### Anti-Pattern 1: In-process timers for flow delays

**What people do:** Use `setTimeout`/`setInterval` in a Node process to implement "wait 3 days" flow nodes.
**Why it's wrong:** State is lost on every deploy, crash, or restart — a contact "waiting" in memory silently vanishes from the flow with no record it ever happened. This is the single most common cause of "flows randomly stop working" bug reports in DIY automation systems.
**Do this instead:** Persist `next_wake_at` on the `flow_runs` row (Postgres is the timer), use BullMQ delayed jobs purely as a low-latency wake-up nudge, and run a periodic reconciliation scan as the durability backstop (Pattern 1 / Pattern in Data Flow section).

### Anti-Pattern 2: Synchronous webhook processing before acking

**What people do:** Verify signature, then do all downstream work (update stats, flip subscription status, trigger flow re-entry) inline in the webhook HTTP handler before returning 200.
**Why it's wrong:** SendGrid delivers events in batches and expects a fast response (documented guidance: respond within ~10 seconds); slow handlers cause SendGrid to retry, which combined with non-idempotent processing produces duplicate state changes. Under load (broadcast campaign to 500k contacts generates a spike of webhook events) synchronous processing becomes the throughput ceiling for the whole delivery pipeline.
**Do this instead:** Verify signature → ack 202 immediately → push raw payload to a queue → process asynchronously, deduping on `sg_event_id`.

### Anti-Pattern 3: One global rate limiter across all tenants

**What people do:** A single BullMQ rate limiter on the send queue, sized to "what SendGrid allows."
**Why it's wrong:** With BYO keys per tenant, each tenant has their *own* SendGrid rate limits and sending reputation. A single global limiter either throttles small tenants unnecessarily or lets one tenant's large broadcast consume the entire worker pool's throughput, starving every other tenant's triggered sends — directly violating the "broadcast must not starve triggered" requirement, but now across tenants too.
**Do this instead:** Per-tenant token-bucket rate limiter plus the triggered/broadcast priority split (Pattern 2).

### Anti-Pattern 4: Recomputing full segment membership on every event

**What people do:** On every incoming event, re-run every dynamic segment's full query across all contacts to check membership changes.
**Why it's wrong:** O(segments × contacts) per event does not survive even moderate event volume (hundreds of thousands/day × dozens of segments per tenant).
**Do this instead:** Incrementally evaluate only the segments whose predicates reference the incoming event's `name`/properties, scoped to the single contact that generated the event; keep membership materialized in `segment_memberships` so both flow-trigger checks and campaign-audience-selection are cheap indexed lookups, not live computation.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| SendGrid mail/send v3 | Dispatch worker calls per-send, per-tenant decrypted API key, `template_id` + `dynamic_template_data`, `custom_args` for correlation | Handle 429 with exponential backoff + requeue; never hold a decrypted key in memory longer than the single call |
| SendGrid Event Webhook | Inbound, per-tenant URL, ECDSA signature verification (raw body, not parsed JSON, must be hashed) | Store each tenant's Event Webhook verification key at connection time; must ack fast and process async; `sg_event_id` is the idempotency key |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Event Ingestion ↔ Segmentation/Flow Trigger | Async via queue, both read/write Postgres as truth | Ingestion API must never block on segmentation or flow evaluation — that coupling is the #1 risk to ingestion latency |
| Flow Execution ↔ Send Orchestrator | Async via `send:triggered` queue | Flow engine only ever enqueues; it does not know about SendGrid, rate limits, or dispatch retries — that's a hard module boundary |
| Campaign Orchestrator ↔ Send Orchestrator | Async via `send:broadcast` queue, batched | Same dispatch path as flows — this shared boundary is what makes the priority/throttle constraint enforceable in one place |
| Webhook Event Processor ↔ Flow Execution | Async, webhook processor writes `email_events`/`contacts.subscription_status`; flow evaluator picks up "opened/clicked" as ordinary ingested-style signals for branch conditions | Keep this as an event, not a direct function call, so flow branching on engagement doesn't create a synchronous dependency on webhook processing latency |

## Sources

- [BullMQ: Prioritized jobs](https://docs.bullmq.io/guide/jobs/prioritized) — HIGH confidence, official docs
- [BullMQ: Rate limiting](https://docs.bullmq.io/guide/rate-limiting) — HIGH confidence, official docs
- [BullMQ: Prioritized intra-groups (BullMQ Pro)](https://docs.bullmq.io/bullmq-pro/groups/prioritized) — HIGH confidence, official docs; per-group concurrency/rate-limit pattern maps directly to per-tenant isolation
- [Twilio/SendGrid: Event Webhook Security Features](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features) — HIGH confidence, official docs
- [sendgrid-nodejs: event-webhook.md](https://github.com/sendgrid/sendgrid-nodejs/blob/main/docs/use-cases/event-webhook.md) — HIGH confidence, official SDK docs
- [Hookdeck: Guide to SendGrid Webhooks](https://hookdeck.com/webhooks/platforms/guide-to-sendgrid-webhooks-features-and-best-practices) — MEDIUM confidence, third-party but consistent with official docs (idempotency via `sg_event_id`, async processing)
- [AWS: Multi-tenant data isolation with PostgreSQL Row Level Security](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/) — HIGH confidence, official vendor guidance
- [PlanetScale: Approaches to tenancy in Postgres](https://planetscale.com/blog/approaches-to-tenancy-in-postgres) — MEDIUM confidence, vendor blog, cross-checked against AWS guidance
- [Hatchet: Use Postgres for your events table](https://hatchet.run/blog/postgres-events-table) — MEDIUM confidence, vendor blog on event-table/partitioning design, consistent with general Postgres partitioning guidance
- [RudderStack: Lessons from scaling PostgreSQL queues to 100K events](https://www.rudderstack.com/blog/scaling-postgres-queue/) — MEDIUM confidence, practitioner case study
- Architecture decomposition (event ingestion → segmentation → flow trigger → flow execution → send queue → dispatch → webhook → analytics) synthesized from established patterns in Klaviyo/ActiveCampaign/HubSpot-style automation platforms — MEDIUM-HIGH confidence, based on general marketing-automation domain knowledge cross-referenced with workflow-engine literature (state-machine + durable-timer pattern) found via web search

---
*Architecture research for: multi-tenant B2C email marketing automation SaaS*
*Researched: 2026-07-03*
