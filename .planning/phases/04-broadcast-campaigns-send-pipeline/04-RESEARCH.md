# Phase 4: Broadcast Campaigns & Send Pipeline - Research

**Researched:** 2026-07-06
**Domain:** Multi-tenant throttled email send pipeline (BullMQ + SendGrid v3 mail/send), broadcast campaign state machine, recipient snapshotting at 100k+ scale, RFC 8058 one-click unsubscribe
**Confidence:** MEDIUM-HIGH (queue topology and tenant-isolation patterns are HIGH — directly extending code already proven in Phases 1-3; SendGrid API mechanics HIGH — official Twilio/SendGrid docs; RPS defaults and unsubscribe-token lifetime are explicitly flagged LOW/ASSUMED for user confirmation)

## Summary

This phase converges two send sources (this phase's broadcasts now, Phase 6's flows later) onto one throttled, idempotent SendGrid dispatch path, and ships the first real send. The codebase already has every low-level primitive this phase needs: `apps/worker`'s BullMQ Worker pattern (idempotent job handlers keyed by workspace, `withTenant`/`withTenantTransaction` for RLS), `segment.repository.ts`'s `compileSegmentDefinition` (the exact SQL WHERE fragment this phase reuses to materialize a recipient snapshot), `sendgrid-client.ts`'s raw-`fetch` pattern for tenant-key API calls (deliberately not the `@sendgrid/mail` package's global-singleton client), and the KMS envelope-encryption helpers for decrypting a tenant's SendGrid key at dispatch time. Nothing here requires a new architectural primitive — it requires wiring existing primitives into two new BullMQ queues, three new tables, and a per-tenant Redis-backed token bucket.

The two highest-leverage findings from this research: (1) **`@sendgrid/mail`'s module-level `sgMail.setApiKey()` singleton is unsafe for multi-tenant dispatch** — `apps/api/src/modules/platform-mail/client.ts` already uses it correctly for the platform's own single key, but the tenant dispatch worker must either instantiate `@sendgrid/mail`'s exported `MailService` class per call or (preferred, matching the codebase's existing `sendgrid-client.ts` convention) issue a raw authenticated `fetch` to `POST https://api.sendgrid.com/v3/mail/send` — never call the module-level `sgMail.send()` for a tenant key. (2) **BullMQ has an official mechanism for honoring SendGrid's `Retry-After`/`X-RateLimit-Reset` on 429 without burning a retry attempt**: `await worker.rateLimit(ms); throw Worker.RateLimitError()`. This is the correct backoff primitive for SEND-07, not a generic exponential-backoff job option.

**Primary recommendation:** Two BullMQ queues (`email-triggered`, `email-broadcast`, dash-separated per the project's established colon restriction), each with its own Worker; a `rate-limiter-flexible` `RateLimiterRedis` token bucket keyed by `workspace_id` gates the actual SendGrid call inside both workers' processors; recipient snapshot materializes via a single batched `INSERT ... SELECT` reusing `compileSegmentDefinition`'s compiled WHERE (cursor-paginated on `contacts.id` for resumability at 100k+ scale, mirroring the existing `imports-csv` worker's page-cursor loop); campaign scheduling uses a periodic BullMQ repeatable job scanning `campaigns WHERE status='scheduled' AND scheduled_at <= now()` with `FOR UPDATE SKIP LOCKED` (no delayed-job-plus-reconciliation hybrid needed — a 60-second scan cadence is acceptable for minute-granularity scheduling UX and is restart-safe by construction).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Campaign CRUD, state machine, scheduling | API / Backend | Database | Campaign lifecycle logic (draft→scheduled→sending→sent) is business logic gated by role permission (`campaign:launch`); persisted in Postgres as the source of truth |
| Recipient snapshot materialization | API / Backend (kickoff) + Worker (batch execution) | Database | Triggered by API when sending starts, but the batched `INSERT...SELECT` loop itself runs in `apps/worker` (long-running, must survive API request timeout) |
| Campaign scheduler (due-campaign scan) | Worker (BullMQ repeatable job) | Database | Same self-healing "queue as doorbell, Postgres as truth" pattern as Phase 3's flow-run reconciliation scan (ARCHITECTURE.md Pattern 1) |
| Send dispatch (SendGrid mail/send) | Worker | API / Backend (key decrypt read) | Must run in `apps/worker`, never inline in an HTTP request — a broadcast to 100k+ recipients cannot be a synchronous API call |
| Per-tenant RPS throttle | Worker (processor-level gate) | Database/Redis | `rate-limiter-flexible` token bucket, NOT BullMQ's `limiter` option (global-per-worker, not tenant-scoped — CLAUDE.md hard constraint) |
| Pre-send suppression/subscription/frequency-cap filter | Worker (processor-level gate, shared function) | Database | Must be a single shared gate callable from both `email-triggered` and `email-broadcast` processors (Pitfall 6/7: never duplicate this logic per send-source) |
| Send ledger (`sends` table) | Database | Worker (writer) | Single source of truth for SEND-04's cross-cutting frequency cap and Phase 5's webhook status updates |
| List-Unsubscribe endpoint | API / Backend | Database | Public, unauthenticated, token-verified HTTPS endpoint — a route module, not a worker job |
| Live progress UI | Browser / Client | API / Backend | TanStack Query polling against a `GET /campaigns/:id/progress` aggregate-count endpoint — no new transport infra needed at this phase's scale |
| Campaign audience preview / breakdown | API / Backend | Database | Reuses `segment.repository.ts`'s `countSegmentMembers`, `listSegmentMembers` with an added suppression/subscription-status join for the D-04 exclusion breakdown |

## User Constraints (from CONTEXT.md)

<user_constraints>

### Locked Decisions (D-01…D-19, user-confirmed D-01…D-05, auto-selected D-06…D-19 pending easy revisit)

- **D-01:** Scheduled campaign resolves segment membership **at send-start time**, not at "Schedule" click. UI shows an estimated count while scheduled.
- **D-02:** Recipient composition **freezes into a snapshot** at send start. Contacts joining the segment mid-send are NOT added; progress denominator is stable; retries are deterministic.
- **D-03:** Editing a segment referenced by a scheduled campaign is **allowed with a warning** in the segment editor. Deleting a segment referenced by a campaign is **blocked** (Phase 3 D-14, enforced in this phase).
- **D-04:** Campaign audience = **sendable contacts + exception breakdown**: progress denominator is the actually-sendable count; campaign shows a breakdown ("500 excluded — 320 unsubscribed, 130 suppressed, 50 no-email" + frequency cap per D-14). Filter transparency = trust.
- **D-05:** An empty sendable audience (including at send-time resolution) → campaign completes to **`sent` with 0 sent and an explicit notice** ("Audience was empty: 200 excluded — all unsubscribed"). No separate failed state for empty audience; the interactive-launch confirm dialog already shows the sendable count before the click.
- **D-06 (auto):** Schedule date/time picker shows the **user's local timezone explicitly** ("09:00, Europe/Belgrade"), stored in UTC. No new workspace timezone setting; per-contact local send time deferred to v2.
- **D-07 (auto):** A scheduled campaign can be **canceled at any time before start** — returns to draft.
- **D-08 (auto):** In-place editing of a scheduled campaign is **not supported**: must "return to draft" (D-07) first, edit, then reschedule.
- **D-09 (auto):** Cancel **during sending** is supported: dispatching of remaining emails stops, campaign moves to terminal **`canceled`** status with actual counters (N of M sent). Already-sent emails cannot be recalled.
- **D-10 (auto):** Partial permanent failures do NOT create a separate status: terminal status is **`sent`, with a visible failed count** ("12,355 sent, 45 errors"). Per-message log is Phase 7.
- **D-11 (auto):** **Campaign duplication** ("create copy") is included: the copy becomes a new draft with all settings (segment, template, sender).
- **D-12 (auto):** Test send (CAMP-04) available from draft and scheduled states, does not affect the state machine, is **NOT counted** in the frequency cap / send ledger, and is **not filtered** by the sending marketer's own subscription status.
- **D-13 (auto):** Global frequency cap is a **workspace setting with a default value** (starting default: no more than 3 marketing emails per contact per rolling 24 hours). Enforced via the unified send ledger (SEND-04), which Phase 6 will also write to. Applies to broadcast + future triggered emails; platform system emails (Phase 1) are outside the cap.
- **D-14 (auto):** Contacts over the cap in a broadcast are **skipped, not deferred**; they appear in the exclusion breakdown as "frequency cap" (extends D-04). Deferred-send semantics are flow territory (Phase 6).
- **D-15 (auto):** One-click unsubscribe (SUBS-04) is the **platform's own HTTPS endpoint** per RFC 8058: `List-Unsubscribe` header (URL with a signed per-message token) + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; plus a minimal hosted confirmation page ("You are unsubscribed") for clicks from mail clients. A click immediately sets `subscription_status = unsubscribed` in the platform (source of truth is the platform, Phase 2 D-12); SendGrid subscription tracking is disabled for these sends to avoid two competing unsubscribe mechanisms.
- **D-16 (auto):** Dynamic Template selection is **from the tenant's SendGrid account template list** (via the saved key, Phase 1 D-21 pattern), with a "refresh list" button; manual `template_id` entry is the fallback.
- **D-17 (auto):** Campaign from-address is chosen from the tenant's **verified senders** (Phase 1 D-21, already fetchable).
- **D-18 (auto):** `dynamic_template_data` is a **standardized documented contact-profile shape**, sent automatically: standard fields (first_name, last_name, email, phone, city, country), tags, custom properties (`properties.*`), plus service fields (`unsubscribe_url` if the template needs it). No per-campaign variable-mapping UI in v1 — tenants design templates against the documented shape.
- **D-19 (auto):** Test email goes to the current user's address; sample `dynamic_template_data` **auto-fills from a real contact in the selected segment** (fallback: placeholders), editable as JSON before sending.

### Claude's Discretion (this research resolves these)

- Per-tenant RPS default and storage, token bucket parameters, 429/5xx backoff parameters, idempotent job key format — **resolved below** (see Send Queue Infrastructure / Rate Limiting sections). Queue topology is FIXED by stack research: two queues `email:triggered`/`email:broadcast` (this research renames to dash-separated `email-triggered`/`email-broadcast` per the established BullMQ colon restriction) with separate workers, throttling at processor level, NOT via BullMQ `limiter`, NOT queue-per-tenant.
- Recipient snapshot schema and batched materialization at 100k+ scale — **resolved below** (see Recipient Snapshot Materialization pattern).
- Scheduler mechanism (BullMQ delayed job vs periodic scan) — **resolved below**: periodic scan recommended.
- Send ledger schema — **resolved below** (see Storage Model), designed for Phase 5 (delivery-status columns) and Phase 6 (flow_run linkage) without building those consumers now.
- Live-progress transport (polling vs SSE), update interval — left to UI-SPEC per original discretion; this research recommends polling as the default (see Architecture Patterns).
- Signed unsubscribe token cryptography, lifetime, endpoint path/domain — **resolved below** (see Unsubscribe Endpoint section) — token lifetime is flagged `[ASSUMED]`, needs explicit user confirmation.
- Launch-readiness validation, error copy, empty states, Russian UI text — deferred to planning/UI-SPEC, out of scope for this research.
- RLS on new tables (campaigns, recipient snapshot, send ledger), worker tenant context — **resolved below**, directly extends the Phase 1-3 pattern; no open questions.

### Deferred Ideas (OUT OF SCOPE this phase)

- Per-contact-local-timezone send (Klaviyo-style staggered send) — v2.
- Workspace timezone setting — v1 uses picker-local-time-with-explicit-label (D-06).
- Pause/resume of an in-flight send — v1 has only cancel (D-09).
- In-place editing of a scheduled campaign — v1 requires "return to draft" (D-08).
- A/B testing, send-time optimization — v2.
- Per-campaign template variable-mapping UI — v2; v1 uses the documented profile shape (D-18).
- Deferred (not skipped) sending of frequency-capped contacts — Phase 6/v2 semantics (D-14).
- In-platform Dynamic Template preview rendering — content lives in SendGrid (PROJECT.md Out of Scope).

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CAMP-01 | Create broadcast campaign: segment audience + SendGrid Dynamic Template | `campaigns` table design, D-16/D-17 template/sender selection via existing SendGrid client extension |
| CAMP-02 | Launch immediately or schedule for date/time | Campaign state machine + periodic-scan scheduler (Architecture Patterns) |
| CAMP-03 | State machine draft → scheduled → sending → sent; no accidental send | State machine transition table (Architecture Patterns) |
| CAMP-04 | Test send to own address with sample dynamic data | Test-send reconciliation with SEND-01 (see Common Pitfalls) |
| CAMP-05 | Live progress during sending | `sends` status aggregate + TanStack Query polling pattern |
| SEND-01 | All sends (triggered + broadcast) go through the queue, no direct sends | Test-send-through-queue reconciliation; dual-queue topology |
| SEND-02 | Per-tenant RPS throttling | `rate-limiter-flexible` `RateLimiterRedis` token bucket, keyed `workspace_id` |
| SEND-03 | Triggered priority over broadcast; SLO minutes not hours | Two separate BullMQ queues + worker concurrency allocation (not BullMQ `priority` alone) |
| SEND-04 | Global frequency cap via unified send ledger | `sends` table + `workspace_send_settings`, pre-send gate query |
| SEND-05 | SendGrid v3 mail/send with template_id + dynamic_template_data | Code Examples: mail/send request shape |
| SEND-06 | Idempotent sends, no duplicates on retry | DB-level insert-then-status-check gate (Pitfall 1 pattern), deterministic BullMQ jobId |
| SEND-07 | 429/5xx backoff without losing emails | `worker.rateLimit()` + `Worker.RateLimitError()` pattern (BullMQ official docs) |
| SUBS-03 | Pre-send filter by subscription/suppression status | Shared pre-send gate function, called from both queues' processors |
| SUBS-04 | One-click List-Unsubscribe header on every email | RFC 8058 header pair + signed-token endpoint design |

</phase_requirements>

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| **bullmq** | 5.79.2 (installed: 5.79.1) | Job queue for both new send queues | Already the project's queue library (Phase 2); reused, not reintroduced |
| **ioredis** | 5.11.0 (installed) | Redis client underlying BullMQ + rate limiter | Already installed; `rate-limiter-flexible`'s `RateLimiterRedis` needs its own connected `ioredis` client instance (not BullMQ's internal `ConnectionOptions`-only pattern) |
| **rate-limiter-flexible** | 11.2.0 [VERIFIED: npm registry] | Per-tenant token-bucket RPS throttle | Locked by project's own STACK.md — BullMQ removed OSS group-rate-limiting in v3+; this is the standard app-layer substitute |
| **@sendgrid/mail** | 8.1.6 (installed) | SendGrid v3 API types + optional `MailService` class | Already installed for platform-mail; **do not reuse the module-level `sgMail` singleton for tenant sends** (see Common Pitfalls) |

**Package Legitimacy note:** `rate-limiter-flexible` and `bullmq` both returned a `SUS`/"too-new" signal from the automated legitimacy check purely because their *latest patch* was published recently (2026-06-08 and 2026-06-27 respectively) — this is a false-positive shape for actively-maintained, high-download libraries, not a hallucination signal. `bullmq` is already a proven, in-production dependency of this codebase since Phase 2 (approved under the same "too-new" false-positive pattern per STATE.md's 02-05 decision log entry). `rate-limiter-flexible` is genuinely new to this phase's dependency tree. See Package Legitimacy Audit below for the formal disposition.

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:crypto` (built-in) | Node 22.x | HMAC-SHA256 signing for unsubscribe tokens | No new package needed — `createHmac('sha256', secret)` is sufficient for a signed, tamper-evident token; avoid pulling in a JWT library for a single-purpose token |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `rate-limiter-flexible` token bucket | BullMQ Pro group rate limiting | Cleaner native implementation, but paid license — CLAUDE.md explicitly defers this to a later scale trigger, not this phase |
| Periodic-scan scheduler | BullMQ delayed job per campaign + reconciliation listener | Delayed jobs give faster reaction than a 60s poll, but add a second failure mode (lost delayed job on Redis eviction) that the scan alone doesn't have; for minute-granularity campaign scheduling UX, the extra complexity isn't justified |
| Raw `fetch` to SendGrid mail/send (matching `sendgrid-client.ts`) | `@sendgrid/mail`'s `MailService` class, instantiated per call | Both are safe for multi-tenant concurrency (neither uses global state) — raw `fetch` is recommended only for *consistency* with the codebase's existing tenant-SendGrid-call convention, not because `MailService` is unsafe when instantiated per-call |
| HMAC-signed unsubscribe token | Store a random opaque token in a DB table (`unsubscribe_tokens`) | HMAC avoids an extra table/lookup and remains verifiable statelessly; DB-backed tokens would allow server-side revocation/expiry management, which is arguably a plus for compliance auditability — flagged as an open question below |

**Installation:**
```bash
npm install rate-limiter-flexible --workspace=apps/worker --workspace=apps/api
```
(No other new packages required — `@sendgrid/mail`, `bullmq`, `ioredis` are already present.)

**Version verification:** `rate-limiter-flexible@11.2.0` (published 2026-06-08) and `@sendgrid/mail@8.1.6` (published 2026-06-11) confirmed live via `npm view <pkg> version time.modified` during this research session.

## Package Legitimacy Audit

| Package | Registry | Age (latest publish) | Downloads/wk | Source Repo | Verdict | Disposition |
|---------|----------|----------------------|--------------|--------------|---------|-------------|
| rate-limiter-flexible | npm | 2026-06-08 (latest patch; package itself is a long-established library) | 2,462,153 | github.com/animir/node-rate-limiter-flexible | SUS ("too-new" on latest-publish timestamp only) | Flagged — planner adds a lightweight `checkpoint:human-verify` before this install, per protocol. High download count + long-standing repo + prior explicit recommendation in project's own STACK.md (HIGH-confidence, official-docs-cross-checked research) all argue this is a legitimate false positive, not a slopsquat risk. |
| bullmq | npm | 2026-06-27 (latest patch) | 6,374,063 | github.com/taskforcesh/bullmq | SUS ("too-new" on latest-publish timestamp only) | Already an approved, in-production dependency since Phase 2 (same false-positive pattern previously accepted per STATE.md 02-05). No new checkpoint needed — this phase only adds new queues/workers using the already-installed package, does not newly introduce it. |
| @sendgrid/mail | npm | 2025-09-19 | 3,844,491 | github.com/sendgrid/sendgrid-nodejs | OK | Approved — already installed and in production use (platform-mail module). |
| ioredis | npm | 2026-06-04 | 21,399,042 | github.com/luin/ioredis | OK | Approved — already installed and in production use. |

**Packages removed due to SLOP verdict:** none.
**Packages flagged as suspicious [SUS]:** `rate-limiter-flexible` — planner must add one `checkpoint:human-verify` task immediately before this package is first installed (its plan wave). `bullmq` requires no new checkpoint (already installed, previously verified).

## Architecture Patterns

### System Architecture Diagram

```
                         ┌─────────────────────────────────────────┐
                         │      Campaign API (apps/api)             │
                         │  create / launch / schedule / cancel /   │
                         │  test-send / progress read                │
                         └───────────────┬───────────────────────────┘
                                         │ writes campaigns row
                                         │ (draft→scheduled→sending→sent/canceled)
                                         ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │                     Postgres (source of truth)                      │
   │   campaigns │ campaign_recipients (snapshot) │ sends (ledger) │      │
   │   workspace_send_settings │ contacts │ workspace_suppressions       │
   └───────┬───────────────────────┬───────────────────────┬────────────┘
           │ read due campaigns    │ read for pre-send gate │ read for
           │ (every 60s scan)      │ (suppression/sub/cap)  │ audience count
           ▼                       ▼                        ▼
   ┌───────────────────┐   ┌─────────────────────────────────────────────┐
   │ Campaign Scheduler │   │        Pre-send Gate (shared function)      │
   │ (BullMQ repeatable │──▶│  suppression? subscribed? under cap?         │
   │  job, worker)       │   └───────────────┬───────────────────────────┘
   └────────┬───────────┘                    │ passes → enqueue send job
            │ on due: freeze snapshot,       ▼
            │ set status=sending    ┌──────────────────┐   ┌───────────────────┐
            └───────────────────────▶  email-broadcast │   │  email-triggered  │
                                     │  queue (worker)   │   │  queue (worker,    │
                                     │  lower concurrency│   │  Phase 6 sends;    │
                                     └────────┬──────────┘   │  reserved floor)   │
                                              │              └─────────┬─────────┘
                                              │  per-tenant token bucket (shared)
                                              ▼                        ▼
                                     ┌──────────────────────────────────────┐
                                     │  SendGrid Dispatch (both queues'      │
                                     │  processors call the SAME function)   │
                                     │  decrypt tenant key → mail/send v3 →   │
                                     │  List-Unsubscribe header → write      │
                                     │  `sends` row → advance progress       │
                                     └───────────────┬────────────────────────┘
                                                      │ 429/5xx
                                                      ▼
                                     worker.rateLimit(ms) + Worker.RateLimitError()
                                                      │ 2xx
                                                      ▼
                                          SendGrid delivers (Phase 5 webhook
                                          closes the loop on delivered/opened/
                                          clicked/bounced/unsubscribed)

   Public surface (no session):
   GET/POST /unsubscribe/:signedToken → verify HMAC → contacts.subscription_status = unsubscribed
```

### Recommended Project Structure

```
apps/api/src/modules/campaigns/
├── campaign.repository.ts       # CRUD, state transitions, audience breakdown
├── campaigns.routes.ts          # create/launch/schedule/cancel/duplicate/test-send/progress
├── recipient-snapshot.ts        # kickoff of batched INSERT...SELECT materialization
└── __tests__/

apps/api/src/modules/delivery/
├── send-ledger.repository.ts    # sends table read/write, frequency-cap query
├── unsubscribe-token.ts         # HMAC sign/verify
├── unsubscribe.routes.ts        # public GET/POST /unsubscribe/:token
└── __tests__/

apps/worker/src/queues/
├── email-broadcast.worker.ts    # campaign dispatch processor
├── email-triggered.worker.ts    # registered now (Phase 6 will be the first real producer)
├── campaign-scheduler.worker.ts # repeatable job: scan due campaigns
├── send-dispatch.ts             # SHARED: pre-send gate + SendGrid call + ledger write (both queues call this)
└── rate-limiter.ts              # RateLimiterRedis factory, keyed by workspace_id

packages/shared-schemas/src/
├── campaign.ts                  # campaign create/update/launch Zod schemas
└── queues.ts                    # + EMAIL_BROADCAST_QUEUE/EMAIL_TRIGGERED_QUEUE job schemas

packages/db/src/schema/
├── campaigns.ts
├── campaign-recipients.ts
├── sends.ts
└── workspace-send-settings.ts

packages/db/migrations/
├── 0013_campaigns.sql
├── 0014_campaign_recipients.sql
├── 0015_sends.sql
└── 0016_workspace_send_settings.sql
```

### Structure Rationale

- **`apps/worker/src/queues/send-dispatch.ts` is a single shared function** called by both `email-broadcast.worker.ts` and `email-triggered.worker.ts`'s processors — this is the concrete implementation of ARCHITECTURE.md's Pitfall 6/7 mandate: pre-send suppression/subscription/frequency-cap/rate-limit checks must never be duplicated per send-source, since Phase 6 will add the second real caller.
- **`campaigns/` (API) vs `delivery/` (API) split** mirrors the existing `ARCHITECTURE.md` module boundary: campaign lifecycle is a distinct concern from the throttled dispatch path, but both this phase's campaigns and Phase 6's flows converge on the same `delivery/` send ledger and gate.
- **`campaign-scheduler.worker.ts` is its own file**, not folded into `email-broadcast.worker.ts` — the scheduler's job is "find due campaigns and kick off materialization + sending," a different responsibility and failure mode than "dispatch one email," and this separation matches the existing one-worker-per-concern convention (`events-ingest.worker.ts` vs `imports-csv.worker.ts`).

### Pattern 1: Recipient Snapshot Materialization (batched, resumable INSERT...SELECT)

**What:** At send-start, freeze the segment's current membership into `campaign_recipients` via a single SQL statement per batch, reusing `compileSegmentDefinition`'s compiled WHERE fragment directly — not a paginated `SELECT` followed by N individual `INSERT`s.
**When to use:** Any time a dynamic segment's membership must be frozen into an immutable list at scale (this phase's D-02 requirement; the same pattern will apply to Phase 6's flow entry snapshots if flows ever need one).
**Why batched (not one giant statement):** The segments engine's own `SAVE_EVAL_STATEMENT_TIMEOUT_MS` precedent is 15s for an interactive save; a background worker job has more time budget, but at the stated 100k–1M-contact scale a single unbounded `INSERT...SELECT` risks a very long-held transaction (lock contention, replication lag, no resumability if the worker crashes mid-materialization). Batching on a `contacts.id` cursor — mirroring `imports-csv.worker.ts`'s existing `PAGE_SIZE` cursor loop — commits progress incrementally and is safe to resume from the last committed cursor stored on the campaign row.

**Example:**
```typescript
// apps/api/src/modules/campaigns/recipient-snapshot.ts — batch materialization.
// Reuses the SAME compileSegmentDefinition segment.repository.ts already uses,
// so "who is in the segment" can never drift between segment preview and
// campaign audience (SEGM-03's single-engine guarantee, extended here).
const SNAPSHOT_BATCH_SIZE = 10_000;
const SNAPSHOT_STATEMENT_TIMEOUT_MS = 60_000; // background job, not interactive — generous vs segments' 15s

async function materializeBatch(
  client: PoolClient,
  campaignId: string,
  workspaceId: string,
  def: SegmentDefinition,
  afterContactId: string | null
): Promise<{ inserted: number; lastContactId: string | null }> {
  await client.query(`SELECT set_config('statement_timeout', $1, true)`, [
    String(SNAPSHOT_STATEMENT_TIMEOUT_MS),
  ]);
  const { whereSql, params } = compileSegmentDefinition(def, workspaceId);
  const cursorParams = afterContactId
    ? [...params, afterContactId, SNAPSHOT_BATCH_SIZE]
    : [...params, SNAPSHOT_BATCH_SIZE];
  const cursorClause = afterContactId ? `AND c.id > $${params.length + 1}` : "";
  const limitIdx = cursorParams.length;

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO campaign_recipients (campaign_id, workspace_id, contact_id)
     SELECT $${limitIdx + 1}, c.workspace_id, c.id
     FROM contacts c
     WHERE ${whereSql} ${cursorClause}
     ORDER BY c.id ASC
     LIMIT $${limitIdx}
     ON CONFLICT (campaign_id, contact_id) DO NOTHING
     RETURNING contact_id as id`,
    [...cursorParams, campaignId]
  );
  return { inserted: rows.length, lastContactId: rows.at(-1)?.id ?? afterContactId };
}
// Worker loop: repeat materializeBatch, persisting lastContactId on the
// campaign row after each batch, until inserted === 0 — safe to resume
// after a crash by re-reading the persisted cursor (Pitfall 1 discipline).
```

### Pattern 2: Idempotent Send Dispatch (insert-gate + row lock, not BullMQ jobId alone)

**What:** Before calling SendGrid, insert a `sends` row with a unique constraint on `(workspace_id, campaign_id, contact_id)`; if the insert conflicts, the row already exists from a prior attempt — lock it `FOR UPDATE`, check its status, and only proceed to the SendGrid call if status is still `queued`/`dispatching` (never re-call SendGrid for a row already `sent`). Advance the row to `sent` in the same code path that receives the 2xx from SendGrid, immediately after the call.
**When to use:** Every send dispatch, broadcast or triggered — this is the codebase's existing Pitfall 1 mitigation pattern (`imports-csv.worker.ts`'s row-level `FOR UPDATE` guard + `events-ingest.worker.ts`'s `ON CONFLICT DO NOTHING`), applied to sends instead of contact upserts/event rows.
**Trade-offs:** An extra DB round-trip per send vs. trusting BullMQ's jobId dedup alone — but BullMQ jobId dedup only prevents a duplicate *job* from being enqueued/re-processed while active; it does not protect against a worker crash between "SendGrid accepted the call" and "we recorded that fact," which is exactly the gap that causes duplicate real-world sends. The DB-level gate is the correctness mechanism; BullMQ's deterministic jobId is defense-in-depth on top of it.

**Example:**
```typescript
// apps/worker/src/queues/send-dispatch.ts
// Deterministic BullMQ jobId, dash-separated (BullMQ rejects ':' in jobId,
// per this project's existing events-ingest convention: `${workspaceId}-${eventId}`).
const jobId = `${workspaceId}-${campaignId}-${contactId}`;

async function dispatchSend(client: PoolClient, params: SendParams): Promise<"sent" | "skipped"> {
  const { rows } = await client.query(
    `INSERT INTO sends (id, workspace_id, campaign_id, contact_id, status, queued_at)
     VALUES (gen_random_uuid(), $1, $2, $3, 'dispatching', now())
     ON CONFLICT (workspace_id, campaign_id, contact_id) DO NOTHING
     RETURNING id`,
    [params.workspaceId, params.campaignId, params.contactId]
  );

  let sendId = rows[0]?.id as string | undefined;
  if (!sendId) {
    const { rows: existing } = await client.query(
      `SELECT id, status FROM sends WHERE workspace_id=$1 AND campaign_id=$2 AND contact_id=$3 FOR UPDATE`,
      [params.workspaceId, params.campaignId, params.contactId]
    );
    if (existing[0]?.status === "sent") return "skipped"; // already sent — safe no-op on redelivery
    sendId = existing[0]?.id;
  }

  const response = await callSendGridMailSend(params); // raw fetch, see Code Examples
  await client.query(`UPDATE sends SET status='sent', provider_message_id=$2, sent_at=now() WHERE id=$1`, [
    sendId,
    response.messageId,
  ]);
  return "sent";
}
```

### Pattern 3: 429/5xx Backoff via BullMQ's Native Rate-Limit Signal

**What:** When SendGrid returns 429 (or a transient 5xx), the processor calls `await worker.rateLimit(ms)` — computing `ms` from SendGrid's response headers when present (prefer `Retry-After` if SendGrid sends it; SendGrid's own docs are ambiguous on this, so also check `X-RateLimit-Reset` as a Unix-timestamp fallback; if neither header is present, fall back to a fixed exponential backoff seed e.g. 2s) — then `throw Worker.RateLimitError()`. BullMQ moves the job back to `waiting` without consuming one of the job's `attempts`, and pauses the whole worker's draining for `ms`.
**When to use:** Every SendGrid 429/5xx response inside both send-dispatch workers (SEND-07). This is distinct from BullMQ's `limiter` option (which CLAUDE.md already rules out for per-tenant throttling) — this is the *reactive* backoff mechanism for provider-side rate limiting, while `rate-limiter-flexible` is the *proactive* per-tenant budget.
**Source:** [BullMQ rate limiting docs](https://docs.bullmq.io/guide/rate-limiting) — HIGH confidence, official docs, confirms `Worker.RateLimitError()` "is not considered a real error" and does not consume retry attempts.

```typescript
// Source: https://docs.bullmq.io/guide/rate-limiting (adapted for SendGrid)
const worker = new Worker(
  EMAIL_BROADCAST_QUEUE,
  async (job) => {
    const result = await tenantRateLimiter.consume(job.data.workspaceId).catch((rej) => rej);
    if (result instanceof RateLimiterRes && result.msBeforeNext > 0 && result.remainingPoints < 0) {
      await worker.rateLimit(result.msBeforeNext);
      throw Worker.RateLimitError();
    }
    const res = await callSendGridMailSend(job.data);
    if (res.status === 429 || res.status >= 500) {
      const retryAfterMs = parseRetryAfter(res.headers); // Retry-After (s) -> X-RateLimit-Reset (unix) -> 2000ms fallback
      await worker.rateLimit(retryAfterMs);
      throw Worker.RateLimitError();
    }
    // ... record sends row as sent
  },
  { connection }
);
```

### Anti-Patterns to Avoid

- **Calling `@sendgrid/mail`'s module-level `sgMail.send()` for a tenant's decrypted key:** `sgMail.setApiKey()` mutates shared module state; a second concurrent request/job for a different tenant would race and could send under the wrong tenant's key. Use a raw `fetch` POST (matching `sendgrid-client.ts`'s existing convention) or a per-call `new MailService()` instance instead.
- **Relying on BullMQ's job `priority` alone to protect triggered sends:** as already documented in this project's own STACK.md/ARCHITECTURE.md — priority only resolves contention *within* one queue's worker pool. Two separate queues with independent worker concurrency is the actual isolation mechanism.
- **Trusting BullMQ jobId dedup as the sole idempotency mechanism:** it prevents duplicate *enqueue*, not duplicate *processing effects* after a mid-job crash. Pattern 2's DB-level insert-gate is required.
- **A single unbatched `INSERT...SELECT` for the recipient snapshot at 1M-contact scale:** no resumability if the worker crashes mid-materialization, and risks holding a long transaction. Batch on a cursor (Pattern 1).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-tenant RPS throttling | Custom Redis `INCR`+`EXPIRE` sliding window | `rate-limiter-flexible`'s `RateLimiterRedis` | Already handles atomicity (Lua scripts), burst tolerance (token bucket semantics), and has a documented `insuranceLimiter` failover pattern for Redis unavailability |
| 429 backoff scheduling | Custom `setTimeout`-based retry queue | BullMQ's `worker.rateLimit(ms)` + `Worker.RateLimitError()` | Official, tested mechanism that doesn't consume retry attempts and correctly pauses only that worker's draining |
| Recipient audience "who's in this segment" logic | A second, campaign-specific segment evaluator | `compileSegmentDefinition` (already shared by preview/list/point-check per SEGM-03) | The single-engine guarantee (SEGM-03) is a hard requirement — a second implementation risks membership drift between segment preview and campaign audience |
| Unsubscribe token signing | A hand-rolled encoding scheme or a full JWT library | `node:crypto`'s `createHmac` | A single-purpose signed token doesn't need JWT's header/claims ceremony; HMAC-SHA256 over `${sendId}.${contactId}.${exp}` is sufficient and auditable |
| SendGrid template list caching/refresh | A custom polling cache layer | Direct `GET /v3/templates?generations=dynamic` on "refresh list" click (matching D-16, same on-demand pattern as `validateTenantSendGridKey`'s verified-senders fetch) | The existing `sendgrid-client.ts` module already establishes "call SendGrid live, no local cache" for this exact class of read (verified senders) — extend it, don't diverge |

**Key insight:** Every "don't hand-roll" item in this phase already has a proven analog somewhere in Phases 1-3's code. The discipline for this phase is *reuse*, not *invention* — the send pipeline's correctness depends on not accidentally building a second, subtly different implementation of a pattern (segment evaluation, tenant-key API calls, idempotent worker jobs) that already exists.

## Runtime State Inventory

Not applicable — this is a greenfield feature phase (new tables, new queues, new routes), not a rename/refactor/migration phase.

## Common Pitfalls

### Pitfall 1: Reconciling SEND-01 ("all sends via queue, no bypass") with D-12 (test sends unfiltered/unlogged)

**What goes wrong:** A plan implements CAMP-04's test send as a direct synchronous SendGrid API call from the API route (bypassing the queue entirely) because D-12 says test sends aren't subject to the frequency cap, subscription filter, or ledger — this looks like the simplest way to honor D-12, but it violates SEND-01's blanket "no direct sends" requirement and means test sends never exercise the actual dispatch path (defeating part of the point of a test send — proving the pipeline works).
**Why it happens:** D-12 and SEND-01 read as being in tension if SEND-01 is interpreted as "every send must be filtered/logged identically."
**How to avoid:** Test sends are still enqueued jobs on `email-broadcast` (satisfying SEND-01 literally — everything goes through the queue), tagged `kind: "test"` in the job payload. The shared `send-dispatch.ts` function branches on `kind`: for `kind: "test"`, it skips the pre-send suppression/subscription/frequency-cap gate and skips the `sends` ledger insert (D-12), but still passes through the per-tenant rate limiter (harmless — a single email) and still needs its own idempotency key (e.g. `${workspaceId}-test-${campaignId}-${nonce}`, since there's no `contactId` uniqueness to lean on for the marketer's own address).
**Warning signs:** A plan task that adds a SendGrid call directly inside `campaigns.routes.ts`'s test-send handler instead of enqueuing a job.

### Pitfall 2: `@sendgrid/mail`'s global `setApiKey()` singleton used for a tenant's decrypted key

**What goes wrong:** A plan reuses `platform-mail/client.ts`'s pattern (`sgMail.setApiKey(key); sgMail.send(...)`) for tenant dispatch. Because `setApiKey` mutates shared module state, two concurrent dispatch jobs for different tenants racing on the same Node process could send an email under the wrong tenant's SendGrid key and reputation — a serious cross-tenant correctness and security bug, distinct from (but adjacent to) Pitfall 4 in this project's own PITFALLS.md ("two-key-confusion").
**Why it happens:** The platform-mail module is the only existing example of calling SendGrid in this codebase, and its pattern looks reusable at a glance.
**How to avoid:** For tenant sends, either (a) issue a raw authenticated `fetch` to `https://api.sendgrid.com/v3/mail/send` with the decrypted key in that call's own `Authorization` header (matching `sendgrid-client.ts`'s existing convention — no shared package state at all), or (b) instantiate `new (await import("@sendgrid/mail")).MailService()` per call and call `.setApiKey()`/`.send()` on that instance, never the module default export. Recommend (a) for consistency with the codebase's existing tenant-SendGrid convention.
**Verification:** confirmed via direct inspection of `node_modules/@sendgrid/mail/src/classes/mail-service.js` — the package does export a `MailService` class usable standalone, this is not a hypothetical workaround.

### Pitfall 3: Materializing the recipient snapshot with `OFFSET`-based pagination

**What goes wrong:** A plan reuses `segment.repository.ts`'s `listSegmentMembers`'s `LIMIT/OFFSET` pattern (fine for a UI page-through of a few hundred pages) to page through and insert 100k-1M rows into `campaign_recipients`. `OFFSET` pagination degrades to O(n²) as the offset grows — each page re-scans and discards all prior rows — and is exactly the shape Pitfall 5 in this project's own PITFALLS.md warns about ("segmentation queries become unusably slow at real scale").
**How to avoid:** Use keyset (cursor) pagination on `contacts.id` (Pattern 1 above), matching `imports-csv.worker.ts`'s existing `WHERE row_number > $cursor ORDER BY row_number ASC LIMIT $pageSize` convention, not `OFFSET`.
**Warning signs:** Any `LIMIT $n OFFSET $m` in the snapshot materialization code where `$m` grows across iterations.

### Pitfall 4: Frequency cap query itself becoming the bottleneck at scale

**What goes wrong:** SEND-04's "no more than 3 emails per contact per rolling 24h" check, if implemented as `SELECT count(*) FROM sends WHERE contact_id = $1 AND sent_at > now() - interval '24 hours'` run once per contact inside the dispatch loop, adds one query per send at broadcast volume (hundreds of thousands of sends). Without the right index this becomes a full-table-adjacent scan under load.
**How to avoid:** Index `sends` on `(workspace_id, contact_id, sent_at)` (or `(contact_id, sent_at)` scoped by RLS) from the first migration — this is the same "decide the index at table-creation time" lesson PITFALLS.md's Pitfall 5 already documents for the `events` table. Consider batching the cap check into the pre-send gate query the campaign already runs against the audience (D-04's breakdown needs this exclusion count anyway) rather than a per-send point query at dispatch time.
**Warning signs:** `EXPLAIN ANALYZE` on the frequency-cap query shows a sequential scan.

### Pitfall 5: Unsubscribe endpoint reachable without the signed token being tied to the *specific send*

**What goes wrong:** If the unsubscribe token only encodes `contactId` (no `sendId`/expiry/HMAC binding to the specific email), a leaked or guessed token for one contact works forever and isn't auditable to "which email caused this unsubscribe" — weakening both security (token replay/brute-force surface) and the analytics requirement (ANLT-01/ANLT-05, Phase 7) to trace unsubscribes back to a specific send.
**How to avoid:** Token payload includes `sendId` (this specific email's ledger row id), `contactId`, `workspaceId`, and an expiry, all HMAC-signed with a platform-held secret (not a tenant-specific key — this is the platform's own compliance mechanism, independent of the tenant's SendGrid key). See Open Questions for the exact lifetime recommendation, flagged `[ASSUMED]`.
**Warning signs:** A token that is just a base64-encoded contact ID with no signature, or a signature that doesn't cover an expiry/send-scoping field.

## Code Examples

### SendGrid v3 mail/send request shape (template + List-Unsubscribe + custom_args)

```typescript
// Source: https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send
// (dynamic_template_data, custom_args, headers — official Twilio/SendGrid docs)
// Confirmed: `headers` may NOT override x-sg-id/x-sg-eid/received/dkim-signature/
// Content-Type/Content-Transfer-Encoding/To/From/Subject/Reply-To/CC/BCC —
// List-Unsubscribe and List-Unsubscribe-Post are NOT in that forbidden list.
interface SendGridMailSendRequest {
  personalizations: Array<{
    to: [{ email: string }];
    dynamic_template_data: Record<string, unknown>;
    custom_args: { send_id: string; workspace_id: string; campaign_id: string };
  }>;
  from: { email: string };
  template_id: string;
  headers: {
    "List-Unsubscribe": string; // `<https://api.example.com/unsubscribe/${signedToken}>`
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click";
  };
  tracking_settings: {
    // D-15: disable SendGrid's own unsubscribe tracking — platform status is
    // the single source of truth, avoiding two competing mechanisms.
    subscription_tracking: { enable: false };
  };
}

async function callSendGridMailSend(
  apiKey: string,
  payload: SendGridMailSendRequest
): Promise<{ status: number; headers: Headers; messageId: string | null }> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, headers: res.headers, messageId: res.headers.get("x-message-id") };
}
```

### RFC 8058 headers (verified against IETF RFC text + Twilio/Mailgun secondary sources)

```
List-Unsubscribe: <https://api.example.com/unsubscribe/eyJhbGciOi...>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```
Mail clients that support one-click (Gmail, Yahoo, Apple Mail) issue a silent `POST` to the URL when the user clicks their native "Unsubscribe" affordance — this must flip `subscription_status` immediately and return 2xx with no body. A GET to the same URL (a human clicking a rendered link, or an unsophisticated crawler/prefetcher) must NOT silently unsubscribe per RFC 8058's own rationale — render a confirmation page instead requiring one explicit click (a plain HTML form POSTing to the same endpoint), closing the prefetch-triggers-unsubscribe failure mode the RFC exists to prevent.

### rate-limiter-flexible per-tenant token bucket

```typescript
// apps/worker/src/queues/rate-limiter.ts
// Source: https://github.com/animir/node-rate-limiter-flexible/wiki/Redis
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import { Redis } from "ioredis";

const redisClient = new Redis(process.env.REDIS_URL!); // dedicated client, NOT BullMQ's internal connection

export function createTenantRateLimiter(rpsByWorkspace: (workspaceId: string) => Promise<number>) {
  // points/duration set PER CALL from the workspace's configured RPS
  // (workspace_send_settings.rps_limit) — rate-limiter-flexible supports a
  // dynamic points override on `.consume(key, pointsToConsume)`, but the
  // simplest correct approach is one RateLimiterRedis instance per distinct
  // configured RPS value, or re-instantiate with `points` read at startup +
  // reconciled on a config-change event. Default: 10 req/s per tenant
  // [ASSUMED — see Open Questions].
  return new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: "send-rl",
    points: 10, // default RPS [ASSUMED]
    duration: 1, // per second — token bucket refills every second
  });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| SendGrid's own List-Unsubscribe (legacy, non-RFC-8058 GET-only link) | RFC 8058 one-click with `List-Unsubscribe-Post` | Gmail/Yahoo bulk-sender requirements (effective Feb 2024) made one-click mandatory for high-volume senders | Every broadcast email must carry both headers, not just `List-Unsubscribe` alone, or risk deliverability penalties from major mailbox providers |
| BullMQ Pro-only group rate limiting used to be the only "real" tenant-scoped throttle | App-layer `rate-limiter-flexible` token bucket is now the documented OSS-compatible substitute | BullMQ v3+ removed OSS group rate limiting | Confirmed by this project's own STACK.md against BullMQ's official docs — no change needed this session, already correctly reflected |

**Deprecated/outdated:** None newly discovered this session beyond what STACK.md/PITFALLS.md/ARCHITECTURE.md already document.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Default per-tenant RPS = 10 requests/second, stored in a new `workspace_send_settings` table, editable by Owner/Admin | Standard Stack / Code Examples | If too low, large broadcasts take unnecessarily long to fully dispatch even on tenants with high-tier SendGrid plans; if too high, a tenant on a low-tier/shared-IP plan could trip SendGrid's own rate limiting or damage sender reputation. Needs explicit user confirmation — SendGrid plan tiers vary widely (40k-1.5M+ emails/day) and there's no universal safe default. |
| A2 | Default frequency cap = 3 marketing emails per contact per rolling 24 hours (D-13's own stated starting default, not independently re-derived by this research) | User Constraints (D-13) | Carried forward as-is from CONTEXT.md; flagged here only because CONTEXT.md itself says "researcher/planner may refine the default" — this research did not find an industry-standard number to refine it against, so 3/24h stands unless the user overrides it. |
| A3 | Unsubscribe token lifetime: recommend effectively long-lived (no functional expiry enforced on the unsubscribe *action* itself — an old email sitting in an inbox for months must still successfully unsubscribe when clicked), while still including an `exp` field in the signed payload for defense-in-depth against unbounded token reuse in unrelated contexts | Common Pitfalls #5 / Code Examples | If the token expires too aggressively (e.g. 24-72h, a typical auth-token pattern), a contact who opens an old marketing email months later and clicks unsubscribe would hit a broken/expired link — a CAN-SPAM/GDPR compliance risk (unsubscribe must remain honorable, not just "within 10 business days of being requested," implying the mechanism itself must still work when the request finally comes). This needs explicit user confirmation since it deviates from typical short-lived-token conventions used elsewhere in this codebase (e.g. verification/reset tokens). |
| A4 | Live progress transport = polling (TanStack Query `refetchInterval`), not SSE/WebSocket | Architecture Patterns | Low risk — explicitly left as UI-SPEC discretion in CONTEXT.md; polling is the lower-complexity default and matches existing codebase patterns (keepPreviousData). If UI-SPEC later wants near-real-time (sub-second) updates for very large broadcasts, SSE would need reconsideration, but nothing in this phase's requirements demands that granularity. |
| A5 | Recipient snapshot batch size = 10,000 rows per `INSERT...SELECT`, statement_timeout = 60s for the materialization job | Architecture Patterns (Pattern 1) | Not independently benchmarked this session (no live 100k+-row dataset available to test against) — carries forward the same LOW-MEDIUM confidence flag PITFALLS.md's own Pitfall 5 already attaches to segment-query performance at scale. If 60s proves insufficient for the segment's own WHERE clause complexity (many behavioral `EXISTS` subqueries) at 1M contacts, reduce batch size further before increasing the timeout. |

**If this table is empty:** N/A — assumptions listed above need user confirmation before being locked as plan decisions, particularly A1 (RPS default) and A3 (token lifetime), which have real compliance/deliverability consequences if wrong.

## Open Questions

1. **What is the tenant's actual SendGrid plan tier, and should `workspace_send_settings.rps_limit` be auto-derived from it rather than a flat default?**
   - What we know: SendGrid's own mail/send endpoint isn't subject to the general 600 req/min API limit (per this project's own PITFALLS.md Integration Gotchas), but account-level sending limits do vary by plan.
   - What's unclear: Whether the tenant's connected SendGrid account exposes a queryable "your plan's send rate" via any API endpoint this phase could call at connection time (Phase 1's `validateTenantSendGridKey` currently only checks scopes + verified senders).
   - Recommendation: Ship with the flat default (A1) and a workspace-level override input in this phase; investigate auto-detection as a fast-follow, not a blocker.

2. **Should the unsubscribe token be a stateless HMAC or a DB-backed opaque token?**
   - What we know: HMAC is simpler (no extra table, no lookup) and sufficient for tamper-evidence.
   - What's unclear: Whether the compliance/audit requirement (Phase 7's analytics, or a future support-tooling need) wants server-side revocation of an unsubscribe link independent of its natural expiry (e.g. "invalidate this specific email's unsubscribe link because it was sent to the wrong contact").
   - Recommendation: HMAC (stateless) for this phase — it satisfies SUBS-04 and RFC 8058 fully; revisit if a future phase surfaces a concrete need for server-side link revocation.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Redis | BullMQ queues + `rate-limiter-flexible` token bucket | Assumed ✓ (already required by Phase 2, `REDIS_URL` documented operational prerequisite in STATE.md) | 7.x per STACK.md | none — hard dependency, already in place |
| PostgreSQL | All new tables, RLS, `SET LOCAL` tenant context | ✓ | 16/17 per STACK.md | none — already in place |
| SendGrid live API (tenant's own account) | mail/send, templates list, verified senders | Not independently re-verified this session — same operational prerequisite already flagged in STATE.md ("a real SendGrid key + verified sender" needed for live-email UAT) | — | Automated tests can mock the SendGrid HTTP layer; live UAT still needs a real tenant key per Phase 1 precedent |

**Missing dependencies with no fallback:** none identified beyond the pre-existing Redis/Postgres requirements already satisfied by Phase 1-3.
**Missing dependencies with fallback:** SendGrid live-API human verification, same pattern as Phase 1's deferred-to-UAT precedent.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x (already configured per-package: `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`) |
| Config file | `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts` (existing) |
| Quick run command | `npm run test --workspace=apps/worker -- send-dispatch` (single-file scoped run) |
| Full suite command | `npm run test --workspace=apps/api && npm run test --workspace=apps/worker` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEND-06 | Redelivered send job does not duplicate a `sent` row | unit/integration | `npm run test --workspace=apps/worker -- send-dispatch-idempotency` | ❌ Wave 0 |
| SEND-02/SEND-03 | Broadcast worker never exceeds per-tenant token bucket; triggered queue processes independently of broadcast queue depth | integration | `npm run test --workspace=apps/worker -- rate-limiter` | ❌ Wave 0 |
| SEND-07 | 429 response triggers `worker.rateLimit()` + `RateLimitError`, not a consumed retry attempt | unit | `npm run test --workspace=apps/worker -- backoff` | ❌ Wave 0 |
| SUBS-03 | Suppressed/unsubscribed contact excluded from dispatch | unit | `npm run test --workspace=apps/worker -- pre-send-gate` | ❌ Wave 0 |
| SUBS-04 | List-Unsubscribe + List-Unsubscribe-Post headers present on every non-test send; POST to unsubscribe endpoint flips status | integration | `npm run test --workspace=apps/api -- unsubscribe` | ❌ Wave 0 |
| CAMP-03 | Draft cannot transition directly to sending/sent; scheduled cannot be edited in place | unit | `npm run test --workspace=apps/api -- campaign-state-machine` | ❌ Wave 0 |
| SEND-04 | Contact over frequency cap excluded, appears in exclusion breakdown | integration | `npm run test --workspace=apps/api -- frequency-cap` | ❌ Wave 0 |
| CAMP-05 | Progress aggregate reflects `sends` status counts accurately mid-send | integration | `npm run test --workspace=apps/api -- campaign-progress` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** scoped test file for the task's module.
- **Per wave merge:** full `apps/api` + `apps/worker` suites.
- **Phase gate:** Full suite green before `/gsd-verify-work`, plus a load-test checkpoint per STATE.md's carried-forward blocker ("load-test triggered-vs-broadcast priority under a large broadcast").

### Wave 0 Gaps
- [ ] `apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts` — covers SEND-06
- [ ] `apps/worker/src/queues/__tests__/rate-limiter.test.ts` — covers SEND-02/SEND-03
- [ ] `apps/worker/src/queues/__tests__/backoff.test.ts` — covers SEND-07
- [ ] `apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts` — covers SUBS-04
- [ ] `apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts` — covers CAMP-03
- [ ] Framework install: none — Vitest already configured in both packages.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | Unsubscribe endpoint is deliberately unauthenticated by design (public surface, token-verified instead) |
| V3 Session Management | No | N/A — no session on the unsubscribe surface; campaign routes reuse existing session/role-guard middleware |
| V4 Access Control | Yes | `requirePermission("campaign", "launch")` (already defined in `access-control.ts`'s statement) gates launch/schedule; Member role can create/edit drafts per D-17/D-19 (Phase 1) but not launch |
| V5 Input Validation | Yes | Zod schemas (`packages/shared-schemas/src/campaign.ts`) via `@fastify/type-provider-zod`, matching every existing route module |
| V6 Cryptography | Yes | HMAC-SHA256 (`node:crypto`) for unsubscribe tokens — never hand-roll signing; SendGrid key decryption reuses existing KMS envelope-encryption (`kms/client.ts`), never a new encryption scheme |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Unsubscribe-link token forgery/tampering (flip a different contact's subscription status) | Tampering / Elevation of Privilege | HMAC-signed token binding `contactId` + `workspaceId` + `sendId`, verified server-side before any status write; reject on signature mismatch |
| Unsubscribe endpoint used as a cross-tenant enumeration oracle (does contact X exist in workspace Y) | Information Disclosure | Uniform response regardless of token validity reason (invalid signature vs. unknown contact both return the same generic confirmation/error page) — mirrors this project's existing enumeration-oracle mitigation pattern (`sendgrid-key.ts`'s GET route: any failure maps to the same 404) |
| Cross-tenant leak of another tenant's decrypted SendGrid key or send data via pooled-connection reuse mid-dispatch | Information Disclosure | Same `withTenant`/`withTenantTransaction` (`SET LOCAL`, AsyncLocalStorage) discipline already proven in Phases 1-3; every new table (`campaigns`, `campaign_recipients`, `sends`, `workspace_send_settings`) gets `ENABLE + FORCE ROW LEVEL SECURITY` + `workspace_isolation` policy in its creation migration, no exceptions |
| Unbounded/DoS-shaped campaign audience recompute (a pathological segment definition forces a very expensive materialization) | Denial of Service | `statement_timeout` scoped to the materialization transaction (Pattern 1), same escape-hatch discipline as the segments engine's own preview/save timeouts |
| SendGrid API key leakage via logs/error messages during dispatch | Information Disclosure | Never log the decrypted key; the dispatch function's error handling must redact `Authorization` header contents on any thrown/logged fetch error (same discipline already required for the existing `sendgrid-key.ts`/`sendgrid-client.ts` modules) |

## Sources

### Primary (HIGH confidence)
- [BullMQ: Rate limiting](https://docs.bullmq.io/guide/rate-limiting) — official docs, `worker.rateLimit()` + `Worker.RateLimitError()` mechanism
- [SendGrid Mail Send API reference](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send) — official Twilio/SendGrid docs, `dynamic_template_data`, `custom_args`, forbidden-headers list
- [RFC 8058 — Signaling One-Click Functionality for List Email Headers](https://datatracker.ietf.org/doc/html/rfc8058) — IETF standard, `List-Unsubscribe-Post` header format
- `node_modules/@sendgrid/mail/src/classes/mail-service.js` — direct codebase inspection confirming `MailService` class export
- Direct codebase inspection: `apps/worker/src/queues/*.ts`, `apps/api/src/modules/segments/segment.repository.ts`, `apps/api/src/modules/tenancy/sendgrid-client.ts`, `packages/tenant-context/src/index.ts`, `packages/db/src/schema/*.ts`, `packages/db/migrations/*.sql` — established codebase patterns this research directly extends
- npm registry (`npm view <pkg> version time.modified`) — verified live for `rate-limiter-flexible`, `@sendgrid/mail`, `bullmq`

### Secondary (MEDIUM confidence)
- [rate-limiter-flexible Redis wiki](https://github.com/animir/node-rate-limiter-flexible/wiki/Redis) — practitioner docs, `RateLimiterRedis` usage pattern
- [SendGrid Rate Limits docs](https://www.twilio.com/docs/sendgrid/api-reference/how-to-use-the-sendgrid-v3-api/rate-limits) — official docs but ambiguous on `Retry-After` header presence, cross-checked against multiple secondary sources reaching the same "not consistently documented" conclusion
- Project's own `.planning/research/STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md` (2026-07-03) — carried forward as canonical, not re-derived

### Tertiary (LOW confidence)
- Per-tenant default RPS value (A1) and unsubscribe-token lifetime (A3) — no authoritative source found for a universal safe default; both explicitly flagged `[ASSUMED]` in the Assumptions Log for user confirmation

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every new package is either already installed and proven, or directly locked by the project's own prior STACK.md research
- Architecture: HIGH — this phase's architecture is a direct, mechanical extension of patterns already implemented and tested in Phases 1-3 (idempotent worker jobs, tenant-scoped RLS, shared compiled-segment WHERE)
- Pitfalls: MEDIUM-HIGH — the SendGrid-specific pitfalls (global-singleton client, 429 handling, RFC 8058 header pair) are newly verified this session against official docs/codebase; the scale-related pitfalls (snapshot batching, frequency-cap indexing) carry forward the same LOW-MEDIUM confidence PITFALLS.md already attaches to unbenchmarked scale claims

**Research date:** 2026-07-06
**Valid until:** 30 days (stable domain — SendGrid API and BullMQ mechanics change slowly; re-verify package versions if planning is delayed past early August 2026)
