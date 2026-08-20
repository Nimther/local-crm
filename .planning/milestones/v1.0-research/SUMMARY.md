# Project Research Summary

**Project:** Mega CRM — Multi-tenant B2C email marketing automation SaaS (Klaviyo-class: flows + broadcast campaigns, SendGrid delivery)
**Domain:** Email marketing automation
**Researched:** 2026-07-03
**Confidence:** MEDIUM-HIGH (stack/architecture/features well-established in category; execution pitfalls extensively documented; specific implementation choices validated against official vendor docs)

## Executive Summary

This is a **multi-tenant email marketing automation platform** targeting SMB/mid-market ecommerce users who expect Klaviyo-class features (triggered flows with conditional branching, segment-based campaigns, event-driven automation) delivered on SendGrid as the sending provider. The research converges on a **Fastify + Postgres + BullMQ** architecture with **shared-schema multi-tenancy**, **per-tenant rate limiting**, and a **versioned flow engine that maintains active-run durability** even under deployment failures.

The core challenge — and the source of most documented pitfalls — is **not** building the individual features (contact CRUD, segmentation, flow canvas). Rather, it's building these features to **scale safely at the stated volume (100k–1M contacts, hundreds of thousands of emails/day)** while preventing the specific failure modes that plague DIY and early-stage automation platforms. The recommended approach treats **Postgres as the single source of truth**, uses **Redis/BullMQ as signaling only** (not state), separates **triggered-send priority lanes** from broadcast to prevent starvation, and **materializes segment membership** rather than recomputing at send time.

**Key risks and mitigation:** The top five pitfalls (duplicate sends, webhook body-parsing breaking signature verification, broadcast starving triggered, segmentation query performance, multi-tenant data leaks under connection pooling) can all be **architected away in Phase 1-2**, not retrofitted later. The research strongly recommends treating multi-tenancy and send-queue isolation as foundational constraints, not optimizations to defer.

## Key Findings

### Recommended Stack

Build on **Fastify 5.9.x** with **schema-first validation (Zod 4.4.x)**, **PostgreSQL 16+ with Drizzle ORM 0.45.x**, and **BullMQ 5.79.x on Redis 7.x** for the backend. Frontend is **React 19.2.x + Vite 8.1.x** with **@xyflow/react 12.11.x** for the flow canvas builder (verified: this is the actively maintained continuation of `reactflow`; the npm `reactflow` package itself is 2-year stale).

**Why this stack over alternatives:**
- **Fastify > Express/NestJS for MVP velocity:** Schema-first validation is built into the request lifecycle (critical when this platform handles hundreds of thousands of event-ingestion requests/day), and the plugin architecture maps cleanly onto domain boundaries (auth, contacts, flows, webhooks) without the ceremony of NestJS's DI/module structure early on.
- **Drizzle > Prisma for multi-tenancy:** The Postgres driver layer and RLS-aware queries without query-engine abstraction make it easier to implement `SET LOCAL app.tenant_id` per transaction. (Prisma is a legitimate alternative if the team prefers abstraction over control.)
- **BullMQ with application-level per-tenant rate limiting (not BullMQ Pro):** BullMQ removed group-key rate limiting from the OSS package in v3; this project achieves per-tenant SendGrid key throttling by wrapping a `rate-limiter-flexible` token-bucket call inside the job processor, avoiding a paid license for v1.
- **@xyflow/react for flow canvas:** Purpose-built for node/edge editors, actively maintained (June 2026), and the project context already calls it out as the reason TS/React was chosen.

**Core technologies:**
- **Fastify 5.9.x:** HTTP API server with schema-first validation (JSON Schema/Zod) built into request lifecycle
- **TypeScript 6.0.x:** Language for type safety across backend and frontend
- **Node.js 22.x LTS:** Runtime with native fetch, modern test runner, best BullMQ/Drizzle compatibility
- **Zod 4.4.x:** Runtime validation + type inference, shared between backend routes and frontend forms
- **PostgreSQL 16/17:** Primary datastore with declarative partitioning (events table by month, on created_at)
- **Drizzle ORM 0.45.x:** SQL-first API with RLS support, ~7kb runtime footprint vs Prisma's ~180kb
- **PgBouncer:** Transaction-mode connection pooling at scale (hundreds of thousands sends/day)
- **BullMQ 5.79.x + Redis 7.x:** Job queue with delayed jobs, retries, priorities, repeatable jobs
- **rate-limiter-flexible 11.2.x:** Per-tenant RPS throttling via Redis-backed token bucket
- **React 19.2.x + Vite 8.1.x:** Standard 2026 SPA tooling (not a metaframework — this is a dashboard behind auth)
- **@xyflow/react 12.11.x:** Canvas flow builder (actively maintained, verified as reactflow successor)
- **TanStack Query 5.101.x + Zustand:** Server state (API data) + client/UI state (canvas editor state)
- **AWS KMS:** Root key for envelope encryption (per-tenant DEK, KMS-held KEK)

### Expected Features

**Table stakes (launch blockers if missing):**

Users expect every Klaviyo-class platform to ship with:
- Contact profile + timeline (activity history, not just sends)
- CSV import with column mapping + preview + error/duplicate reporting
- Event ingestion API (server-side, freeform schema — browser tracking deferred)
- Segmentation: profile-attribute AND behavioral/event-based, backed by **one shared segment-evaluation engine** used identically by flows, exit conditions, and campaigns (critical architectural gap-fill)
- Canvas flow builder with trigger, delay/wait, conditional branch, action(send), and explicit exit/end nodes per branch — **must ship complete, not partial**
- Flow rules: exit conditions, re-entry control (once-ever / once-per-N-days / every-time), quiet hours, global cross-flow/campaign frequency capping
- Broadcast campaigns: segment audience selection, send-now or scheduled send, **draft→scheduled/live state machine**
- Delivery tracking (delivered/opened/clicked/bounced/unsubscribed)
- Workspace-level dashboard + per-message send log with filters
- Multi-tenant workspaces + team invites + roles

**Differentiators (post-MVP nice-to-haves):**
- A/B testing within flows (defer to v1.x — depends on stable flow engine + analytics first)
- Segment live-preview count while building (removes #1 segmentation frustration; cheap to add)
- Deep per-contact + per-flow-step delivery timeline (already partially committed; leaning into this as a UX differentiator)
- Canvas real-time validation (dead branches, missing exit, orphan nodes)

**Anti-features explicitly out of scope (correct calls):**
- In-app WYSIWYG template editor (templates live in SendGrid; building a second rendering surface defeats the BYO-key architecture)
- Omnichannel (SMS/push) (explicitly deferred; email-only depth > breadth)
- AI content generation (no in-app content surface; not needed for v1)
- Deals/sales pipeline (fundamentally different data model; dilutes focus)
- Platform-run shared SendGrid account (BYO key avoids reputation pooling risk)

### Architecture Approach

**Postgres as source of truth, Redis/BullMQ as signaling only.** Every durable fact (contact state, flow-run position, send status) lives in Postgres. BullMQ jobs only say "go check row X in Postgres." Workers are idempotent: on receiving a job, they re-read current state from Postgres and decide what to do. This means Redis restarts are availability incidents, not data-loss incidents.

**Two logical send queues with priority:** `email:triggered` (high priority, flow-driven sends) and `email:broadcast` (low priority, campaign sends) flow through the same SendGrid dispatch worker but with triggered always dequeued first. Each tenant additionally gets a per-tenant token-bucket rate limiter (keyed by `tenant_id`, sized to that tenant's SendGrid plan) invoked at dispatch time, so one tenant's broadcast blast can't monopolize the worker pool.

**Event → Segment → Flow/Campaign → Send → Webhook → Analytics pipeline:**

1. Event Ingestion API: 202 fast, write + enqueue evaluation job
2. Flow Trigger Evaluator: match event against flow triggers, check entry rules
3. Flow Execution Engine: state machine in Postgres (flow_runs table), delay nodes set next_wake_at, BullMQ delayed jobs as wake-up nudge
4. Campaign Orchestrator: broadcast lifecycle (draft → scheduled → sending → sent)
5. Send Orchestrator: merge triggered + broadcast with per-tenant RPS throttling
6. SendGrid Dispatch Worker: decrypt tenant key at dispatch time, handle 429/5xx backoff
7. SendGrid Webhook Receiver: per-tenant HTTPS URL, verify ECDSA against raw request bytes, ack fast
8. Webhook Event Processor: dedupe by `sg_event_id`, update delivery status
9. Analytics Aggregator: incremental rollups (not full table scans per request)

**Major components:**
1. **Tenancy Service** — workspaces, membership, roles, encrypted SendGrid key storage
2. **Contact & Subscription Service** — CRUD, CSV import, suppression checks
3. **Segmentation Engine** — static + dynamic segments, materialized membership (not live joins)
4. **Flow Trigger Evaluator** — match events to flow triggers, check entry/reentry rules
5. **Flow Execution Engine** — state machine: current node, wait timers, branching, exit conditions
6. **Campaign Orchestrator** — broadcast lifecycle, segment snapshot resolution
7. **Send Orchestrator** — priority + per-tenant rate limiting
8. **SendGrid Dispatch Worker** — per-send API call with 429 backoff
9. **Webhook Processor** — signature verification, dedup, status updates
10. **Analytics Aggregator** — rollup tables, dashboard read-model

### Critical Pitfalls

1. **Duplicate sends from non-idempotent flow execution** — A contact receives the same flow email twice because a job was retried with no idempotency check. **Prevention:** Idempotency key per step (flow_version_id, flow_run_id, node_id, attempt_epoch), CAS write to flow_step_executions table before SendGrid call, advance flow state in same transaction as "sent" status. *Must be architected in Phase 1 (Flow Execution Engine), not retrofitted.*

2. **SendGrid webhook signature verification breaks on parsed body** — Framework's global JSON body parser re-serializes the request body before verification code sees it, causing byte-for-byte mismatch. **Prevention:** Mount webhook route with `raw({ type: 'application/json' })`, verify ECDSA against the raw Buffer, parse JSON only after verification succeeds. Integration test replaying a real signed payload through the full HTTP stack. *Must be architected in Webhook Ingestion phase.*

3. **Broadcast fan-out starves triggered flow sends** — Large broadcast floods the same queue/worker pool as triggered sends, queuing time-sensitive flow emails behind hours of broadcast volume. **Prevention:** Separate priority lanes (BullMQ `send:triggered` vs `send:broadcast`) with triggered always dequeued first, share the per-tenant rate-limit budget but trigger gets reserved RPS floor. Internal SLO: triggered sends within seconds to low-single-digit minutes. *Must be in Phase 1 (Send Queue Infrastructure), not retrofit.*

4. **Behavioral segmentation queries become unusably slow at scale** — Live SQL joins across the events table at segment-evaluation time are fast with demo data but become minutes-long at hundreds of thousands to millions of contacts. **Prevention:** Materialize segment membership in a separate segment_members table (refreshed incrementally off the event queue), composite indexes on (contact_id, event_name, occurred_at). Schema decision in Event Ingestion phase, query strategy in Segmentation phase. *Benchmark early against seeded dataset at target scale.*

5. **Multi-tenant data isolation fails under connection pooling** — Pooled Postgres connection retains previous tenant's RLS context after a crashed transaction, next request on same connection silently reads/writes wrong tenant's data. **Prevention:** SET app.current_tenant at start of every request inside same transaction, RESET ALL/DISCARD ALL enforced by pooling layer on release, store tenant context in request-scoped storage (AsyncLocalStorage, not global), prefix all Redis keys with tenant_id. *Infrastructure test: kill connection mid-transaction, confirm no cross-tenant data appears next request.*

## Implications for Roadmap

Research suggests a **7-phase structure** with explicit architectural "gates" that unlock later phases:

### Phase 1: Multi-Tenancy Foundation & Workspace Setup
**Rationale:** Every later phase depends on correct multi-tenant isolation; must be proven before event ingestion scales.
**Delivers:** Workspace/team membership + roles, connection-pool error handling, request-scoped tenant context, Postgres RLS policies, SendGrid key encryption (KMS-backed), key validation at connection time.
**Addresses features:** Multi-tenant workspaces + team invites
**Avoids pitfalls:** Multi-tenant pooling failures, cross-tenant data leaks

### Phase 2: Core Data Model & Event Ingestion
**Rationale:** Everything builds on contacts + events; schema decisions affect segmentation, flow execution, analytics query performance.
**Delivers:** Contact CRUD (UI + API), CSV import with column mapping/preview, event ingestion API (202 fast, enqueue evaluation job), events table with partition-ready schema, subscription status 3-state model, SendGrid key decryption at dispatch time.
**Addresses features:** Contact CRUD, CSV import, event ingestion API, subscription status foundation
**Avoids pitfalls:** Slow segmentation queries, suppression not globally enforced
**Research flags:** **Benchmark segment queries against seeded dataset at target scale (100k–1M contacts, hundreds of thousands of events) before moving to Phase 3.** This is the single highest-risk scaling decision.

### Phase 3: Webhook Ingestion & Delivery Tracking
**Rationale:** Unlocks SendGrid event processing; required for suppression enforcement, analytics, and flow re-entry signals.
**Delivers:** Per-tenant webhook URL (workspace_id in path), ECDSA signature verification against raw request bytes, dedupe by sg_event_id, async processing (ack 202 fast, push to queue), status updates, subscription_status flips on bounce/unsubscribe.
**Addresses features:** Delivery tracking, suppression updates
**Avoids pitfalls:** Body-parsing breaking signature verification, webhook dedup/ordering, suppression not enforced

### Phase 4: Segmentation Engine & Segment Membership
**Rationale:** Blocks flow triggers and campaign audience selection; must be fast (materialized, not live-computed) by end of phase.
**Delivers:** Segment definitions (static + dynamic), **single unified segment-evaluation engine** used by flows, campaigns, exit conditions, materialized segment_memberships table, segment live-preview count, performance validated at target scale.
**Addresses features:** Profile + behavioral segmentation, segment membership, segment live preview
**Avoids pitfalls:** Slow segmentation queries, divergent segment definitions
**Research flags:** Benchmark segment count/preview response time at target scale before end of phase.

### Phase 5: Flow Canvas Builder & Flow Execution Engine
**Rationale:** The signature product feature; builds on segmentation (entry triggers), event ingestion (re-entry signals), and webhook processing (engagement-based branches). Requires flow versioning.
**Delivers:** Canvas editor (drag-drop nodes: trigger, delay/wait, conditional branch, action/send, exit/end), flow versioning (immutable versions per publish), flow_runs state machine, entry triggers (event or segment-based), exit conditions, re-entry control, quiet hours (evaluated at dispatch time), global cross-flow/campaign frequency cap, idempotent flow-step execution, BullMQ delayed jobs as wake-up nudge, periodic reconciliation scan as safety net.
**Addresses features:** Canvas builder, trigger nodes, delay nodes, conditional branching, exit conditions, re-entry control, quiet hours
**Avoids pitfalls:** Duplicate sends, mutable flows breaking mid-flight, quiet hours only partially enforced
**Research flags:** **Simulate late-stage flow edits while contacts are mid-execution; verify no errors/duplicates/skips in state snapshots.**

### Phase 6: Broadcast Campaigns & Unified Send Pipeline
**Rationale:** Completes the core loop. Requires separate priority lanes and per-tenant rate limiting architected in Phase 1.
**Delivers:** Campaign orchestrator (draft → scheduled → sending → sent), audience selection (segment snapshot at send time), send scheduling, draft→live state machine, send test email capability, Send Orchestrator (merge triggered + broadcast), two logical BullMQ queues (send:triggered, send:broadcast) with priority, per-tenant rate-limiter gate (token bucket), triggered always dequeued first, SendGrid Dispatch Worker (decrypt key, mail/send v3, 429 backoff), unified send-attempt ledger, suppression pre-send gate, quiet hours pre-send gate.
**Addresses features:** Broadcast campaigns, send scheduling, send test, frequency capping (unified), quiet hours (unified), suppression enforcement (unified)
**Avoids pitfalls:** Broadcast starving triggered, duplicate sends, suppression not globally enforced, quiet hours/timezone partial
**Research flags:** **Load test: launch large broadcast (100k+) concurrent with triggered sends, measure triggered-send latency (target <5 min SLA).** Verify per-tenant rate limiter doesn't leak state across tenants under pooling failures.

### Phase 7: Analytics, Dashboard & Send Log
**Rationale:** Makes the reliability/observability differentiation visible to users; completes v1 MVP.
**Delivers:** Analytics tables (campaign_stats, flow_step_stats), rollup strategy (incremental + periodic reconciliation), workspace dashboard, per-message send log with filters, contact timeline, send progress indicator for broadcasts, bounce/spam-complaint rate per tenant, domain-authentication status.
**Addresses features:** Analytics (campaign/flow-step/timeline/dashboard/send log), bounce/spam visibility
**Avoids pitfalls:** BYO key reputation invisibility

### Phase Ordering Rationale

1. **Phase 1 (Multi-Tenancy) → Phase 2 (Data Model):** Tenancy infrastructure must be proven before handling real contact/event data.
2. **Phase 2 → Phase 3 (Webhooks):** Event ingestion API exists; webhook ingestion is the only way to populate delivery status + suppression data.
3. **Phase 3 → Phase 4 (Segmentation):** Suppression status is a fact; segmentation can now query over events + profiles safely.
4. **Phase 4 → Phase 5 (Flows):** Segmentation unlocks entry triggers (segment-based or event-based).
5. **Phase 5 → Phase 6 (Campaigns):** Flow execution is proven; now add broadcast as a parallel send source.
6. **Phase 6 → Phase 7 (Analytics):** Send pipeline exists; analytics rolls up webhook events.

**Why this avoids pitfalls:**
- Multi-tenant isolation (Phase 1) is the foundation; every later phase inherits it.
- Segmentation performance (Phase 4) is validated early at target scale, preventing slow queries.
- Flow versioning (Phase 5) is architected before campaigns (Phase 6) add a second send source, preventing mutable flows breaking mid-flight.
- Separate send queues (Phase 6) use the priority/rate-limit infrastructure from Phase 1, preventing broadcast starvation.
- Idempotent execution (Phase 5) is non-negotiable; Phase 6 extends it to broadcast, preventing duplicate sends.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| **Stack** | HIGH | Framework choice (Fastify > Express > NestJS for this use case) verified against multiple independent sources + npm registry metadata verified directly (all versions confirmed in sync). Drizzle vs. Prisma debate live in 2025/2026, but RLS-native argument + cold-start numbers justify choice for multi-tenant isolation requirement. |
| **Features** | MEDIUM | Product-category knowledge (Klaviyo, Mailchimp, Customer.io) well-established and cross-checked against 3+ independent sources. Feature dependency graph is sound. One area of genuine uncertainty: exact quiet-hours timezone-handling edge cases and exact re-entry semantics (noted for phase-level research). |
| **Architecture** | MEDIUM-HIGH | Component decomposition + data flow (event ingestion → segmentation → flow trigger → execution → send → webhook → analytics) is established pattern across multiple marketing-automation platforms. BullMQ mechanics, Postgres multi-tenancy patterns: HIGH confidence (official docs, AWS guidance). Specific judgment calls (flow-engine-as-DB-state-machine vs. dedicated workflow engine): MEDIUM confidence. |
| **Pitfalls** | MEDIUM-HIGH | Critical pitfalls (webhook signature verification, duplicate sends, broadcast starvation, segmentation performance, multi-tenant pooling) are well-documented across multiple independent sources (GitHub issues, official docs, practitioner case studies). Some pitfalls (quiet-hours timezone logic, flow versioning correctness) inferred from general workflow-engine literature; less empirically verified for Klaviyo-specific edge cases. |

**Overall confidence:** MEDIUM-HIGH. Stack and architecture are well-grounded in established patterns; features are validated against a mature product category. Key uncertainties are domain-specific edge cases (timezone handling, re-entry semantics) and empirical scaling validation (segmentation queries at scale, broadcast/triggered queue priority under real load) that require Phase-level validation.

### Gaps to Address

1. **Quiet-hours timezone semantics:** Does quiet hours use contact's inferred timezone, workspace default, or explicitly configured contact timezone? Recommendation: explicit per-contact timezone field (don't infer only from IP), default sensibly when unknown, evaluate at dispatch time. Research during Phase 5.

2. **Re-entry control edge cases:** Once-per-N-days — is this "N days since last entry" or "N days since last exit"? Document explicit semantics during Phase 5 design.

3. **Segmentation query performance at target scale:** Phase 2 must include empirical benchmark of behavioral segment queries (100k–1M contacts, hundreds of thousands of events) to validate the materialized-membership approach before Phase 4 build.

4. **Broadcast/triggered priority under load:** Phase 6 must include load test (100k+ broadcast concurrent with triggered sends) to verify triggered-send latency SLA.

5. **Multi-tenant isolation under connection-pooling failures:** Phase 1 infrastructure testing should include explicit chaos test (kill connections mid-transaction, verify no cross-tenant data on next request).

6. **SendGrid BYO key validation/monitoring:** Phase 3 should validate key permissions at connection time; Phase 7 should surface bounce/spam-complaint rates per tenant.

## Sources

**Primary (HIGH confidence):**
- npm registry (`npm view <pkg>` metadata) — direct package metadata, verified 2026-07-03
- [BullMQ official docs: Rate limiting](https://docs.bullmq.io/guide/rate-limiting)
- [Twilio SendGrid: Event Webhook Security Features](https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features)
- [Klaviyo Help Center](https://help.klaviyo.com), [Mailchimp Help](https://mailchimp.com/help), [Twilio SendGrid Docs](https://www.twilio.com/docs/sendgrid)
- [AWS: Multi-tenant data isolation with PostgreSQL RLS](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)

**Secondary (MEDIUM confidence):**
- [NestJS vs Fastify vs Hono 2026 comparison](https://encore.dev/articles/nestjs-vs-fastify-vs-hono) — cross-checked against 3 other independent sources
- [Drizzle vs Prisma / Bytebase comparison](https://www.bytebase.com/blog/drizzle-vs-prisma/) — vendor/third-party ORM comparison
- [PlanetScale: Approaches to tenancy in Postgres](https://planetscale.com/blog/approaches-to-tenancy-in-postgres)
- [Oden: Customer.io vs Braze vs Iterable vs Klaviyo](https://getoden.com/blog/customerio-vs-braze-vs-iterable-vs-klaviyo) — cross-verified against multiple similar sources

**Tertiary (LOW-MEDIUM confidence, needs Phase-level validation):**
- General workflow-engine literature and adjacent platform patterns (Salesforce Flow, Marketo) — inferred from web search and domain knowledge, not specific to this use case

---

**Research completed:** 2026-07-03
**Ready for roadmap:** Yes

*Research synthesis for Mega CRM. Prepared for roadmap creation and phase planning.*
