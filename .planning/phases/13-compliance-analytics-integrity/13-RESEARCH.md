# Phase 13: Compliance & Analytics Integrity - Research

**Researched:** 2026-08-11
**Domain:** Postgres partitioned-table integrity (unique constraints, timezone-correct date truncation), envelope-encryption reuse for HMAC suppression hashing, GDPR/ICO erasure-vs-evidence patterns, webhook-ingress durability (journal/backfill), per-tenant alerting on keyed state
**Confidence:** HIGH (architecture reuses proven in-repo patterns end-to-end); MEDIUM on exact migration mechanics for the partitioned unique-constraint swap (verified against PostgreSQL docs, not yet run against this schema)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Phase Boundary (locked at ROADMAP level — do not re-litigate)

What the platform claims about consent and delivery matches what actually happened — an unsubscribe is honored everywhere at once, and a daily number means exactly one thing. Covers CMP-01…CMP-09: atomic unsubscribe (status + consent history + originating send in one transaction), fixed UTC day semantics for daily metrics, late-event counting on the occurrence day, lawful contact erasure with retained evidence, `occurred_at` bounding with separate server `received_at` authority, metrics reconciliation as a recurring job, dedup resilient to unstable `sg_event_id`, webhook-downtime backfill, and per-tenant sender-reputation alerts.

- **CMP-05/CMP-07 (Pitfall 14):** `occurred_at` is bounded to a sane window BEFORE it routes the partition or feeds dedup; server-side `received_at` stays the separate authority; dedup is re-based on server-controlled fields (the current `(workspace_id, sg_event_id, occurred_at)` key is bypassable by varying only the timestamp). Rejected events go to an explicit quarantine path — one malformed event must never fail the whole webhook batch (enqueued as one job).
- **CMP-07 rests on a verified fact:** `sg_event_id` is NOT reliably stable across SendGrid webhook retries (first-party SendGrid issue, despite docs implying otherwise). A compound-key fallback is required.
- **CMP-04:** resolves via anonymisation-with-retained-evidence (ICO guidance on erasure vs. suppression), per the decision already recorded in PROJECT.md.
- **CMP-01:** must NOT fan out into separate writes — subscription status, consent history and the send row change in one transaction, verified by a crash test from Phase 8's harness.
- **Cross-phase note (Phase 9/14):** bounding `occurred_at` (CMP-05) is what protects the partition-attach machinery from stray timestamps routing rows far outside the current-month window.

### Locked Decisions

**Contact erasure shape (CMP-04)**
- **D-01:** Anonymize in place. Deleting a contact keeps the row: email/name/phone/attributes scrubbed to NULL, `anonymized_at` marker set. FKs from `sends`, `subscription_status_history`, `events` stay intact. Replaces today's hard `DELETE` in `deleteContact` (`apps/api/src/modules/contacts/contact.repository.ts`).
- **D-02:** Suppression evidence = hash + last-seen metadata. `workspace_suppressions` stores an HMAC/SHA-256 of the normalized email plus minimal context instead of today's plaintext email; the pre-send suppression check hashes the outgoing address and compares. No plaintext PII survives erasure.
- **D-03:** JSONB PII scrubbed on erasure in linked rows: `send_events.payload` and `events.properties` rewritten to strip email/PII, keeping event type + timestamps as delivery evidence. Bounded, batched UPDATEs per the Phase 12 sweep conventions.
- **D-04:** Erasure executes as instant anonymization + async scrub with completion tracking. DELETE anonymizes synchronously (mail stops immediately), then enqueues a background scrub job over sends/events partitions with an erasure record tracking completion.

**Webhook-downtime backfill (CMP-08)**
- **D-05:** Durable ingress journal + provider retries — no paid API dependency. Raw webhook batches persisted to Postgres at ingress (after signature verification, before enqueueing). True unreachability covered by SendGrid's ~24h retry window; longer outages resolve to honest `unknown` via the Phase 11 reconciler. Email Activity API rejected as baseline (paid add-on, rate-limited).
- **D-06:** Replay = automatic sweep + manual range replay. A scheduled tick (`upsertJobScheduler` pattern) finds journal rows with no ingestion-complete mark past an age threshold and re-enqueues them; dedup makes double-replay harmless. Plus an operator CLI for explicit time-range replay.
- **D-07:** Journal retention: days, pruned (~7 days, versioned constant). Outlives any realistic ingestion outage plus reconciler windows. CMP-04 erasure scrub does not need to cover the journal beyond this horizon (documented interaction).
- **D-08:** Ingestion-health visibility this phase = existing watchdog + `OPERATOR_ALERT_EMAIL` (`claimAlertSlot` dedup): alert when the replay sweep finds stuck journal rows, or active sends see zero incoming events past a threshold. Phase 15 (OPS-13) re-plumbs into real alerting.

**Reputation alerts (CMP-09)**
- **D-09:** Both operator and tenant are alerted. Operator via `OPERATOR_ALERT_EMAIL`; tenant's workspace members via platform email (platform-mail machinery, not the tenant's BYO key).
- **D-10:** Complaint rate = rolling window with two tiers. `spam_reports / delivered` over ~7 days (versioned constant), warn ~0.1%, critical ~0.3% (Gmail/Yahoo bulk-sender lines). Computed by a scheduled job from existing fact columns; minimum-volume floor guards low-volume noise. Exact values planner-tunable versioned constants citing Gmail/Yahoo guidance.
- **D-11:** Alert only this phase — no automatic enforcement. Auto-pausing sending is deferred (product-policy capability, own UX).
- **D-12:** Track complaints AND hard-bounce rate. Same job, same fact columns, one more ratio (bounce rate >~2% is the other line providers penalize). Both ratios alert through the same two-tier machinery.

**Daily metric semantics (CMP-02/CMP-03)**
- **D-13:** `sent_at` (SendGrid acceptance) defines the day of a send for `sent_count` — current reconciler behavior made explicit, with all `::date` casts fixed to explicit UTC semantics (`AT TIME ZONE 'UTC'`), never session-TZ-dependent. All event-derived counters key off provider `occurred_at` UTC day.
- **D-14:** Late events covered by dirty-day marking. When an event lands on a (workspace, day) outside the standing 2-day reconciliation window, that day is marked dirty; the reconciliation tick sweeps dirty days in addition to today/yesterday. Every retroactive increment gets verified — no blanket widening, no unverified band. Extends `analytics-reconciliation.worker.ts`.
- **D-15:** CMP-05 acceptance window ≈ 7 days past, minutes of future skew. Covers SendGrid's ~24h webhook retries + 72h deferral cycle with margin; a few minutes' future tolerance for clock skew. Out-of-range events are quarantined (`received_at` preserved for forensics), never counted, never routed to partitions by a stray timestamp. Exact values are versioned constants with rationale comments.
- **D-16:** `unknown` sends get an explicit count in campaign stats (deferred to this phase by Phase 11 D-13): campaign cards and send-log stats show `unknown` as its own small count/label next to sent/failed. Daily rollups continue to EXCLUDE `unknown` from sent/failed counts (Phase 11 D-13 stands; document it).

### Claude's Discretion

- **CMP-07 fallback dedup key composition** — must satisfy "re-base dedup on server-controlled fields" and be researched against the verified unstable-`sg_event_id` fact; exact key shape, migration path for the existing unique constraint, and its interaction with the partition key are researcher/planner territory. **→ Researched below (Architecture Patterns, Pattern 1).**
- **CMP-01 transaction shape** — how the route and webhook paths converge on one atomic implementation (shared helper vs parallel code) is planner discretion; the crash test on Phase 8's harness is mandatory. **→ Researched below (Architecture Patterns, Pattern 2).**
- Quarantine mechanism shape (dedicated table vs journal-row flag), its retention, and whether quarantined events are operator-visible beyond SQL. **→ Researched below.**
- Journal schema/granularity (per-batch vs per-event rows), ingestion-complete marking, and where the journal write sits relative to signature verification. **→ Researched below.**
- Anonymization details: normalized-email form feeding the hash, HMAC key handling (KMS-backed vs static secret), erasure-record schema, scrub batch sizes, `contacts` unique-constraint handling for anonymized rows. **→ Researched below.**
- Reputation job cadence, alert re-fire/cooldown policy (reuse `claimAlertSlot`), minimum-volume floor value, exact rolling-window mechanics. **→ Researched below.**
- Dirty-day marking mechanism (table vs column on rollup row) and sweep bounds. **→ Researched below.**
- Where the CMP-02 day-semantics contract is documented (`ARCHITECTURE.md` vs `SPECIFICATION.md` §4 — likely both).

### Deferred Ideas (OUT OF SCOPE)

- Email Activity API opt-in backfill for tenants whose SendGrid plan includes it — rejected as baseline this phase; could layer on top of the journal later.
- Automatic send-pausing at the critical complaint threshold (enforcement, banners, override/unblock flow) — later phase; this phase alerts only (D-11).
- Scheduled purge of anonymized contact rows after a retention horizon (the "hybrid" erasure variant) — anonymize-in-place suffices for CMP-04, purge machinery deferred.
- Tenant-facing reputation dashboard UI — Phase 15's frontend/observability work; this phase ships email alerts.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CMP-01 | Отписка создаёт единое событие, атомарно обновляющее статус подписки, consent history и связанную отправку | Architecture Pattern 2 (shared `applyUnsubscribeWithSendFact` helper); crash-test grounding in Runtime/Validation sections |
| CMP-02 | Дневные метрики используют единую UTC-семантику; поле, определяющее день отправки, зафиксировано | Confirmed `sends.*_at` columns are `timestamptz` (verified via `packages/db/src/schema/sends.ts`) — `AT TIME ZONE 'UTC'` is the correct fix direction, not `::date` alone. See Pitfall 1 and Code Example 1 |
| CMP-03 | Задержанные provider-события корректно учитываются в дневных метриках | Dirty-day marking design (Architecture Pattern 4) extending `analytics-reconciliation.worker.ts` |
| CMP-04 | Удаление контакта обезличивает персональные данные, сохраняя минимальное compliance evidence | Anonymize-in-place + HMAC suppression hash design reusing `packages/kms`; batched JSONB scrub reusing Phase 12 sweep/checkpoint pattern |
| CMP-05 | Provider `occurred_at` ограничен допустимым диапазоном; время получения на сервере хранится отдельно | Bounding window design (Pitfall 2); `received_at` already exists and is untouched |
| CMP-06 | Metrics reconciliation работает как регулярная job, а не разовое исправление | Already exists (`analytics-reconciliation.worker.ts`, `upsertJobScheduler`) — this phase extends coverage, doesn't build new machinery |
| CMP-07 | Дедупликация webhook-событий устойчива к нестабильному `sg_event_id` | Architecture Pattern 1 — compound key `(workspace_id, send_id, event_type, occurred_at)`, PostgreSQL-docs-verified migration path (Code Example 2) |
| CMP-08 | События, пропущенные при недоступности webhook-эндпоинта, восстанавливаются backfill'ом | Journal design (Architecture Pattern 3), fail-closed write policy, retention/erasure interaction |
| CMP-09 | Репутация отправителя отслеживается по тенанту с алертом при приближении к порогу жалоб | Keyed alert-state table design (Architecture Pattern 5) — explicitly NOT the singleton `dead_letter_alert_state` shape |
</phase_requirements>

## Summary

This phase has almost no "pick a library" surface — every decision was already locked in `13-CONTEXT.md` down to the mechanism. The research value here is verifying the **exact mechanics** behind five discretion areas the planner must turn into tasks: (1) the CMP-07 dedup key redesign and its migration path on a partitioned table, (2) the CMP-01 shared atomic-unsubscribe helper, (3) the ingress journal/quarantine schema, (4) the anonymization + HMAC suppression-hash design reusing the existing KMS envelope-encryption plumbing, and (5) per-workspace reputation alerting, which cannot reuse the existing singleton `claimAlertSlot` row shape as-is.

Three load-bearing facts were confirmed against the live codebase and PostgreSQL documentation during this research: **all `sends.*_at` fact columns are `timestamptz`** (not naive `timestamp`), which means the D-13 fix (`AT TIME ZONE 'UTC'` before `::date`) is the *correct* direction — a bare `::date` cast on a `timestamptz` column silently truncates using the session's `TimeZone` GUC, not UTC. **`CREATE INDEX CONCURRENTLY` cannot run directly on a partitioned parent table** — the constraint migration for CMP-07 must build each partition's index concurrently, then attach it to an `ONLY`-created parent index, mirroring the `attachPartitionCheckFirst` precedent already established in Phase 9. And **historical duplicate rows already exist** under the current `(workspace_id, sg_event_id, occurred_at)` key — they are the exact rows CMP-07 is fixing, and they will violate a new `(workspace_id, send_id, event_type, occurred_at)` unique index at build time unless pre-deduped first.

**Primary recommendation:** Treat this phase as five independent, additive infrastructure changes layered onto proven in-repo patterns (watchdog/`claimAlertSlot`, KMS envelope encryption, Phase 12's checkpointed sweep, `dead_letter_jobs`' journal-adjacent shape, `upsertJobScheduler`) rather than as new architecture. The one place needing genuinely new design is the CMP-07 constraint swap, which is also this phase's highest migration risk (partitioned unique index + pre-existing duplicate data) and should be sequenced as its own task with a dry-run duplicate count before the destructive step.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Atomic unsubscribe (status+history+send fact) | API / Backend (`unsubscribe.routes.ts`) + Backend worker (`webhook-events.worker.ts`) | Database (transaction boundary) | Both entry points mutate the same three rows; the transaction itself is the correctness unit, owned at the DB tier via a single `withTenantTransaction` call from a shared helper |
| Daily metric UTC semantics | Database (query/cast semantics) | Backend worker (reconciler) | The bug and the fix are both purely SQL-level (`::date` vs `AT TIME ZONE 'UTC'`); no app-tier state is involved |
| Late-event / dirty-day counting | Backend worker (`analytics-reconciliation.worker.ts`) | Database (dirty marker storage) | The webhook worker marks dirty at write time; the reconciler tick is the only consumer that clears it |
| Contact erasure (anonymize + scrub) | API / Backend (synchronous anonymize) | Backend worker (async scrub job) | Compliance requires mail to stop immediately (API-tier, request-scoped); the scrub of historical JSONB is inherently a long-running batch job (worker-tier) |
| Suppression-hash pre-send check | API / Backend (write path: contact delete) + Backend worker (read path: send-dispatch pre-send gate) | KMS package (`packages/kms`) | Both the CRM's contact deletion and the send pipeline's suppression gate must agree on the same hash — the KMS-backed key material is the shared secret both tiers read |
| `occurred_at` bounding + dedup re-base | Backend worker (`webhook-events.worker.ts` — `extractEventRow`) | Database (constraint) | The bound is applied before either partition routing or the INSERT; the constraint is the DB-level backstop that makes the bound authoritative, not merely advisory |
| Webhook-downtime journal + backfill | API / Backend (journal write, in the request path after signature verify) | Backend worker (replay sweep, operator CLI) | The journal write must happen synchronously in the same request that verifies the signature (nothing else has the verified raw bytes); replay is inherently asynchronous |
| Per-tenant reputation alerting | Backend worker or API watchdog (scheduled job) | Database (keyed alert-state table) | Mirrors the existing watchdog family (all API-tier `setInterval` checkers reading Postgres); the alert-state table is new because the existing ones are singletons |

## Standard Stack

### Core

No new runtime dependencies. This phase is implemented entirely with packages already present in the repo and Node's built-in `crypto` module.

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:crypto` | built-in (Node 22.x LTS) | HMAC-SHA256 suppression-email hashing (D-02) | Already the established pattern in this codebase — `packages/kms/src/client.ts` uses `createCipheriv`/`createDecipheriv` from `node:crypto` for envelope encryption, and CLAUDE.md's decision log records a prior human decision to prefer `node:crypto` over adding a package (hand-rolled UUIDv5, Phase 11) for exactly this class of primitive |
| `bullmq` | 5.79.x (already installed) | Replay-sweep queue, erasure-scrub queue, reputation-tick queue | Same queue library already used for every other repeatable job in this codebase; new queues MUST go through `@mega-crm/queue-core` (Phase 12 D-10) |
| `pg` | 8.22.x (already installed) | All new SQL (journal, quarantine, alert-state tables) | Existing driver, existing `withTenant`/`withTenantTransaction`/`withCrossWorkspaceScan` seams |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@mega-crm/kms` (in-repo package) | n/a (workspace package) | Envelope-encrypt/decrypt the per-workspace HMAC key used for suppression hashing | Reuse `encryptTenantSecret`/`decryptTenantSecret` exactly as used for tenant SendGrid keys today — generate a random 32-byte key once per workspace, store as an `EncryptedSecret`, decrypt at suppression-check time |
| `@mega-crm/queue-core` (in-repo package) | n/a (workspace package) | `buildJobOptions`, `buildRedisConnectionOptions`, `STANDARD_JOB_RETENTION`, dead-letter writer, error listeners | Every new queue this phase introduces (replay sweep, erasure scrub, reputation tick) must be built through this factory per the Phase 12 single-definition rule |
| `@mega-crm/redaction` | n/a (workspace package) | Field-pattern vocabulary (`REDACTION_RULES`) reused to identify PII keys when scrubbing `send_events.payload`/`events.properties` JSONB (D-03) | The `valueRules` (email/phone regex) and `keyRules` (email/phone key names) in `packages/redaction/src/rules.ts` are already tuned against this exact payload shape — reuse them for the erasure scrub's field-matching logic rather than writing new PII-detection regex |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| KMS-backed per-workspace HMAC key (envelope-encrypted, decrypt-on-use) | A single static platform-wide secret (env var, `BETTER_AUTH_SECRET`-style) | Simpler — one secret, no per-workspace row, no KMS round-trip on the pre-send hot path. Tradeoff: a single leaked secret lets an attacker build a rainbow table against any tenant's suppression list (low-severity since it's a one-way hash of an already-not-very-secret value — an email address — but still a cross-tenant blast radius a per-workspace key avoids). Recommend evaluating hot-path latency under the AWS KMS provider before committing to per-workspace keys; if unacceptable, an in-process LRU cache of unwrapped HMAC keys (never persisted, keyed by workspace_id, short TTL) resolves it without falling back to a shared secret. |
| Dedicated `quarantined_send_events` table | A `quarantined boolean` + `quarantine_reason text` column added directly to `send_events` | A dedicated table avoids widening the hot partitioned table's row with columns that are `NULL` for 99.9%+ of rows, and lets quarantine retention (D-07-adjacent) be pruned independently of the send_events retention policy. Recommended: dedicated table, not a column. |
| Per-batch journal row (raw batch JSON + signature headers) | Per-event journal rows (one row per event inside the batch) | Per-batch matches how the route already receives and enqueues the data (`enqueueWebhookBatch` takes the whole batch) — no re-shaping needed at journal-write time, and replay re-enqueues the exact same job shape the worker already consumes. Per-event would require re-batching on replay and duplicates work `webhook-events.worker.ts` already does. Recommended: per-batch. |

**Installation:**
```bash
# No new packages. Everything below is already present in package.json workspaces.
```

**Version verification:** Not applicable — no new package versions to verify. Confirmed via `npm view` is unnecessary since zero new dependencies are introduced; existing versions (`bullmq@5.79.x`, `pg@8.22.x`, Node 22.x LTS providing `node:crypto`) are already pinned in the root and per-workspace `package.json` files and unchanged by this phase.

## Package Legitimacy Audit

**No new packages are introduced by this phase.** This phase is implemented entirely with `node:crypto` (Node built-in) and existing in-repo workspace packages (`@mega-crm/kms`, `@mega-crm/queue-core`, `@mega-crm/redaction`, `@mega-crm/contacts-core`, `@mega-crm/delivery-core`, `@mega-crm/tenant-context`). The Package Legitimacy Gate protocol (`gsd-tools query package-legitimacy check`) was not run because there is nothing to check — confirmed by grepping root and per-workspace `package.json` dependency lists during this research; no `npm view`/registry lookups are needed.

**Packages removed due to SLOP verdict:** none (none proposed).
**Packages flagged as suspicious SUS:** none (none proposed).

## Architecture Patterns

### System Architecture Diagram

```
                         SendGrid Event Webhook (signed batch POST)
                                        │
                                        ▼
                         ┌──────────────────────────────┐
                         │ apps/api webhooks.routes.ts   │
                         │  1. verify ECDSA signature    │
                         │  2. verify header timestamp   │
                         │  3. JOURNAL WRITE (NEW, D-05) │──► ingress_journal (Postgres)
                         │     -- raw batch, post-verify │      workspace_id, RLS, ~7d retention
                         │  4. enqueue whole batch (1 job)│
                         └──────────────┬───────────────┘
                                        │ BullMQ: webhook-events queue
                                        ▼
                         ┌──────────────────────────────┐
                         │ apps/worker webhook-events    │
                         │ .worker.ts                    │
                         │  extractEventRow:              │
                         │   - BOUND occurred_at (CMP-05) │──► out-of-range → quarantine table (NEW)
                         │   - normalize event type       │      (never counted, never partitioned)
                         │  dedup INSERT ON CONFLICT       │
                         │   (workspace_id, send_id,       │◄── CMP-07: sg_event_id DROPPED from key,
                         │    event_type, occurred_at)     │     replaced by send_id+event_type+occurred_at
                         │  side effects (fact cols,       │
                         │   counters, rollup increment,   │
                         │   suppression, UNSUBSCRIBE via  │
                         │   shared applyUnsubscribeWith-  │
                         │   SendFact helper — CMP-01)     │
                         └──────────────┬───────────────┘
                                        │ writes workspace_daily_rollup (incremental)
                                        │ marks (workspace_id, day) DIRTY if outside 2-day window (CMP-03/D-14)
                                        ▼
                         ┌──────────────────────────────┐
                         │ analytics-reconciliation      │
                         │ .worker.ts (existing, CMP-06)  │
                         │  sweeps today/yesterday        │
                         │  + all DIRTY (workspace,day)   │◄── NEW: dirty-day sweep (CMP-03)
                         │  UTC-correct casts (CMP-02)    │◄── AT TIME ZONE 'UTC' fix
                         └──────────────────────────────┘

Public unsubscribe route (RFC 8058)          SendGrid unsubscribe webhook event
        │                                              │
        └──────────────┬───────────────────────────────┘
                        ▼
         applyUnsubscribeWithSendFact(client, {contactId, sendId, workspaceId})
              -- ONE shared helper, ONE transaction (CMP-01):
              -- contacts.subscription_status
              -- subscription_status_history
              -- sends.unsubscribed_at (setFactColumnOnce -- idempotent)
              -- campaign counter + rollup increment (gated on justSet)

Contact DELETE request
        │
        ▼
apps/api contact.repository.ts deleteContact (CMP-04)
   SYNC: anonymize contacts row (email/name/phone → NULL, anonymized_at set)
         + hash-based workspace_suppressions row (HMAC via @mega-crm/kms)
         + erasure_record row (status='pending')
   ASYNC (enqueue): erasure-scrub job
         └──► apps/worker erasure-scrub.worker.ts
                bounded keyset pages over send_events.payload / events.properties
                strips PII fields (reusing @mega-crm/redaction's field vocabulary)
                erasure_record.status='complete' on finish (Phase 12 checkpoint pattern)

Reputation job (scheduled tick, CMP-09)
   reads spam_reported_at / bounced_at / delivered_at per workspace
   computes complaint_rate, hard_bounce_rate over rolling window
   claims a PER-WORKSPACE-PER-METRIC alert slot (NEW keyed table --
   NOT the dead_letter_alert_state singleton shape)
   sends operator email (existing channel) + tenant email (platform-mail)
```

### Recommended Project Structure

No new top-level directories. New files land inside existing module boundaries:

```
apps/api/src/modules/
├── webhooks/
│   ├── webhooks.routes.ts          # add: journal write after signature verify
│   ├── ingress-journal.ts          # NEW: journal insert + replay-sweep query helpers
│   └── quarantine.ts               # NEW: quarantine insert (called from worker, but the
│                                    #      table/query helpers can live in a shared package
│                                    #      if apps/worker needs the same read path)
├── contacts/
│   └── contact.repository.ts       # deleteContact rewritten: anonymize-in-place (D-01/D-02)
├── delivery/
│   └── unsubscribe.routes.ts       # route calls the shared applyUnsubscribeWithSendFact helper
└── ops/
    ├── reputation-watchdog.ts      # NEW: sibling to partition-watchdog.ts / dead-letter-watchdog.ts
    └── ingestion-health-watchdog.ts # NEW: D-08's "stuck journal row" + "zero events" check

packages/delivery-core/src/
└── unsubscribe-apply.ts            # NEW: applyUnsubscribeWithSendFact (shared by route + worker) --
                                     #      lives here (not contacts-core) because it writes to
                                     #      BOTH contacts AND sends, and delivery-core already owns
                                     #      the send-side vocabulary (suppression-rules.ts,
                                     #      event-normalize.ts)

packages/kms/src/
└── (unchanged API) — encryptTenantSecret/decryptTenantSecret reused for the HMAC key

apps/worker/src/queues/
├── webhook-events.worker.ts        # extractEventRow: add occurred_at bounding + quarantine routing;
│                                    # dedup INSERT: new ON CONFLICT target
├── webhook-replay-sweep.worker.ts  # NEW: D-06 automatic sweep, mirrors flow-segment-sweep's checkpoint shape
├── erasure-scrub.worker.ts         # NEW: D-04's async PII scrub, Phase 12 checkpoint pattern
├── reputation-tick.worker.ts       # NEW: D-09..D-12 scheduled computation, upsertJobScheduler pattern
└── analytics-reconciliation.worker.ts  # extend: UTC-correct casts (D-13), dirty-day sweep (D-14)

packages/db/migrations/
├── 0055_ingress_journal.sql        # journal table + RLS + index
├── 0056_send_events_quarantine.sql # quarantine table + RLS + index
├── 0057_send_events_dedup_rebase.sql   # HIGH-RISK migration -- see Pitfall 3
├── 0058_contact_erasure.sql        # anonymized_at column, erasure_records table, suppression hash columns
├── 0059_workspace_daily_rollup_dirty.sql  # dirtied_at column
└── 0060_reputation_alert_state.sql # keyed (workspace_id, metric) alert-state table
```

### Pattern 1: CMP-07 Dedup Re-Base — Compound Key on Server-Observed Fields

**What:** Replace the `(workspace_id, sg_event_id, occurred_at)` unique constraint on `send_events` with `(workspace_id, send_id, event_type, occurred_at)`. `sg_event_id` remains a stored (not-null) column for forensic/log correlation, but is **removed from the constraint**.

**Why this is the right compound key:** The verified fact (CONTEXT.md, first-party SendGrid GitHub issue) is that `sg_event_id` can differ across redeliveries of the *same* underlying event. `send_id` (from `custom_args`), `event_type` (raw SendGrid `event` field — always present, never null), and `occurred_at` (the event's own `timestamp` field, which — unlike `sg_event_id` — describes *when the thing actually happened* and should be stable across retries of the same occurrence) together identify "this specific occurrence" without relying on the unstable field. `occurred_at` **must stay in the key** regardless of this fix — Postgres requires every unique constraint on a partitioned table to include all partition-key columns (`send_events` is partitioned by `occurred_at`), so a fully "server-controlled" key that excludes `occurred_at` entirely is not possible on this schema. This is a structural constraint, not a design choice to revisit later.

**When to use:** Applied unconditionally to all future inserts once CMP-05's bounding is also in place (the two fixes compose: bounding closes the "vary the timestamp" bypass of the partition/dedup key; re-basing closes the "vary sg_event_id" bypass of the dedup key specifically).

**Known tradeoffs to document, not silently accept:**
- `send_id` is nullable (orphan/test events with no resolvable send). Postgres treats NULL as distinct in unique constraints, so two orphan events with identical `(workspace_id, NULL, event_type, occurred_at)` do **not** dedupe against each other under the new key — each redelivery of an untracked event inserts a new row. This is acceptable: orphan events already drive zero counters/side-effects (D-15 precedent), so the only cost is modest storage growth on repeated redelivery of webhook noise the platform can't attribute anyway.
- Two *genuine* distinct events that happen to land in the same UTC second, on the same send, with the same `event_type` (e.g., two rapid-fire opens) will now dedupe to one row where they previously might have had different `sg_event_id`-based rows. This is the correct behavior for the "unique-send" counters (`opened_count`, `first_opened_at`) — `open_count`/`click_count` repeat counters already increment independently of the dedup insert's `justSet` result, so genuinely-repeated engagement is not lost, only the redundant row-level event record collapses. Confirm this against the existing `open_count`/`click_count` code path (`webhook-events.worker.ts`'s `applyEventSideEffects`) during planning — it already increments `open_count`/`click_count` unconditionally on every genuinely-new row, so this tradeoff is inherited from the existing table shape, not newly introduced.

**Example (migration shape):**
```sql
-- Source: PostgreSQL docs (CREATE INDEX, Table Partitioning) — verified 2026-08-11
-- via official docs; see Sources. Concurrent index builds are not supported
-- directly on a partitioned parent table.

-- Step 0 (pre-check, MANDATORY before Step 1): count rows that would violate
-- the new constraint. These are exactly the historical duplicates CMP-07 is
-- fixing -- they exist because sg_event_id varied across retries of the
-- same occurrence under the OLD key.
SELECT workspace_id, send_id, event_type, occurred_at, count(*)
FROM send_events
GROUP BY workspace_id, send_id, event_type, occurred_at
HAVING count(*) > 1;

-- Step 1: resolve duplicates found above (e.g. keep the row with the
-- earliest received_at, delete the rest) -- expand/contract discipline,
-- bounded/batched per Phase 12 sweep conventions, NOT a single unbounded
-- DELETE on a large partitioned table.

-- Step 2: build the new index CONCURRENTLY per partition, then attach.
CREATE INDEX send_events_dedup_v2_idx ON ONLY send_events
  (workspace_id, send_id, event_type, occurred_at);

-- Repeat per existing monthly partition (Phase 9's ensurePartitions already
-- enumerates them):
CREATE INDEX CONCURRENTLY send_events_dedup_v2_2026_08_idx
  ON send_events_2026_08 (workspace_id, send_id, event_type, occurred_at);
ALTER INDEX send_events_dedup_v2_idx
  ATTACH PARTITION send_events_dedup_v2_2026_08_idx;
-- ... repeat for every attached partition; once ALL partitions are attached,
-- the parent index is automatically marked valid.

-- Step 3: promote to a UNIQUE constraint and drop the old one, in the same
-- expand/contract migration discipline already established in this repo.
ALTER TABLE send_events
  ADD CONSTRAINT send_events_dedup_v2_unique
  UNIQUE USING INDEX send_events_dedup_v2_idx;
ALTER TABLE send_events
  DROP CONSTRAINT send_events_workspace_sg_event_id_occurred_at_key; -- old name, confirm exact name in 0020
```

### Pattern 2: CMP-01 Shared Atomic Unsubscribe Helper

**What:** Extract a single exported function — recommended name `applyUnsubscribeWithSendFact` in `packages/delivery-core/src/unsubscribe-apply.ts` — that both `unsubscribe.routes.ts` (route path) and `webhook-events.worker.ts` (webhook path) call inside their own already-open `withTenantTransaction`.

**Why a shared helper, not parallel code:** The webhook path's existing `applyUnsubscribe` (local to `webhook-events.worker.ts`) already writes `contacts.subscription_status` + `subscription_status_history` correctly-idempotently. The route path (`unsubscribe.routes.ts`) duplicates that same status+history logic but has never touched the originating send — even though the token already carries `sendId` (HMAC-bound, confirmed in `unsubscribe.routes.ts`'s existing token-verification code). The fix is not "add a send-fact write to the route" as a one-off — it's collapsing both call sites onto one function so the two paths cannot drift again. The shared function's contract:
1. Read prior `contacts.subscription_status` (for accurate history old→new).
2. `UPDATE contacts SET subscription_status = 'unsubscribed', ...`.
3. `recordSubscriptionStatusChange` (gated on actual value change — existing no-op rule preserved).
4. `setFactColumnOnce(client, sendId, 'unsubscribed_at', occurredAt)` — **this is what makes the two paths idempotently convergent by construction**: if the webhook event arrives first and sets `unsubscribed_at`, a later route-path unsubscribe on the same send is a no-op on this column (the `WHERE unsubscribed_at IS NULL` gate), and vice versa. Neither ordering double-counts.
5. If `justSet` from step 4: increment campaign counter + rollup, exactly mirroring the existing webhook-side `unsubscribe`/`group_unsubscribe` case.

**When to use:** Both the route (which has `sendId` available in the verified token payload) and the webhook worker's `unsubscribe`/`group_unsubscribe`/dropped-with-unsubscribe-outcome cases call this one function instead of each maintaining separate logic.

**Crash-test grounding:** Per Phase 8's failure-injection harness shape (confirmed via `segment-sweep-kill-resume.test.ts`), the correct test here is **state-based, not a real kill harness** — arrange the transaction to fail after step 2 but before step 4 commits (or simply assert on partial-vs-full commit atomicity directly against Postgres, since the whole point is "a crash partway through leaves no partial state anywhere" and a single transaction makes partial-commit structurally impossible to observe). Add this as a new `npm run failure:unsubscribe-atomic`-style script following the existing naming convention in `package.json`.

### Pattern 3: CMP-08 Ingress Journal

**What:** A new `ingress_journal` table, written synchronously inside the webhook route handler, immediately after `verifyWebhookSignature`/`isWebhookTimestampFresh` both pass and immediately before `enqueueWebhookBatch` — never before verification (this ordering is the explicit CLAUDE.md rule already governing this route: "never parse/journal an unverified payload").

**Schema shape (recommended):**
```sql
CREATE TABLE ingress_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  raw_batch jsonb NOT NULL,           -- the parsed events array, post-verification
  received_at timestamptz NOT NULL DEFAULT now(),
  ingestion_completed_at timestamptz, -- set by the worker once processWebhookEventBatch succeeds
  replay_count integer NOT NULL DEFAULT 0
);
-- RLS: ENABLE + FORCE, workspace_isolation policy (this table carries tenant
-- PII -- raw SendGrid event payloads include recipient emails -- unlike
-- dead_letter_jobs, which deliberately has NO workspace_id/RLS because it
-- carries only platform-ops metadata. Do not copy dead_letter_jobs' "no RLS"
-- shape here; that precedent does not apply.)
```

**Journal write failure policy:** Fail closed. If the journal INSERT fails (e.g. a transient Postgres error), the route must return a 5xx, **not** proceed to enqueue. SendGrid's own ~24h retry window (already the backbone of D-05's "no paid API dependency" argument) is what recovers from this — the journal is the platform's own replay authority, so writing to it must be a precondition for accepting the delivery, not a best-effort side channel that could silently diverge from what actually got enqueued.

**Ingestion-complete marking:** The worker (`processWebhookEventBatch`) marks `ingestion_completed_at` after a successful run. The replay sweep (D-06) queries `WHERE ingestion_completed_at IS NULL AND received_at < now() - interval '<threshold>'`.

**schemaVersion note (ROADMAP R-05):** If the journal write needs to correlate to a specific enqueued job (e.g. to mark it complete by journal row id rather than by re-deriving batch identity), the `WebhookEventsJob` payload gains a `journalId` field. Per the project's existing `schemaVersion` convention on BullMQ job payloads (ROADMAP R-05 — workers defer unrecognized versions), this is a payload shape change and **must bump `schemaVersion`** on `webhookEventsJobSchema`, exactly like every other payload-shape change in this codebase's history. State this explicitly as a task, not an implicit side effect.

### Pattern 4: CMP-03 Dirty-Day Marking

**What:** Add a `dirtied_at timestamptz` column (nullable) to `workspace_daily_rollup` — **not a boolean flag**. When the webhook worker's incremental-increment path writes an event whose `occurred_at` UTC day falls outside the reconciler's standing 2-day window, it sets `dirtied_at = now()` on that `(workspace_id, day)` row (`ON CONFLICT ... DO UPDATE SET dirtied_at = EXCLUDED.dirtied_at` only when NULL or older, so a burst of late events doesn't repeatedly bump the timestamp forward and starve the sweep).

**Why a timestamp, not a boolean:** A boolean flag creates a clear/mark race — the reconciliation tick reads `dirty = true`, does its work, then `UPDATE ... SET dirty = false`, but if a new late event marks the row dirty again between the tick's read and its clear-write, that new dirty signal is lost (the tick's unconditional `SET dirty = false` clobbers it even though it never saw that particular late event). A timestamp lets the sweep clear conditionally: `UPDATE workspace_daily_rollup SET dirtied_at = NULL WHERE dirtied_at IS NOT NULL AND dirtied_at <= $sweepStartTime`. Any dirty-mark that arrived *during* the sweep (timestamp newer than `$sweepStartTime`) survives the clear and is picked up by the next tick — no lost late-event tracking, no race window.

**Sweep bounds:** `analytics-reconciliation.worker.ts`'s existing per-tick loop (currently `recentDays(RECONCILE_WINDOW_DAYS)`) gains a second query: `SELECT workspace_id, day FROM workspace_daily_rollup WHERE dirtied_at IS NOT NULL` (bounded by the fact that dirty rows are rare — only late events trigger them — so no pagination is needed for a correctness-scale workload; add one if operational experience shows otherwise).

### Pattern 5: CMP-09 Per-Workspace Keyed Alert State

**What:** A new table, explicitly **not** shaped like `dead_letter_alert_state`'s `id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)` singleton:
```sql
CREATE TABLE reputation_alert_state (
  workspace_id uuid NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  metric text NOT NULL,               -- 'complaint_rate' | 'hard_bounce_rate'
  tier text NOT NULL,                 -- 'warn' | 'critical' -- last tier alerted
  last_alert_sent_at timestamptz,
  last_observed_rate numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, metric)
);
-- No RLS needed if this is read/written exclusively by the platform-side
-- reputation job via withCrossWorkspaceScan (mirrors organization's own
-- "role identity is the boundary" precedent) -- confirm this against
-- Phase 10's scan-role grant list at planning time; if any tenant-facing
-- surface ever reads this table directly, it needs RLS added then.
```

**Why this must NOT copy the singleton shape:** `dead_letter_jobs`/`partition_maintenance_runs`/`send_reconciler_runs` are all platform-wide, single-instance concerns — one alert state total. CMP-09 is inherently per-workspace (a tenant's own complaint rate), so the atomic claim must be `WHERE workspace_id = $1 AND metric = $2 AND (last_alert_sent_at IS NULL OR ...)` — the same single-statement `UPDATE ... RETURNING` pattern `claimAlertSlot`/`claimDeadLetterAlertSlot`/`claimReconcilerAlertSlot` already use for cross-replica dedup, just keyed by `(workspace_id, metric)` instead of a hardcoded `id = 1`.

**Tier re-fire policy:** Recommend alerting once per tier-crossing per cooldown window (reuse the same `dedupHours` parameter shape as the existing watchdogs), and re-alerting immediately if the tier *escalates* (warn → critical) even inside the cooldown window — a tenant crossing from 0.15% to 0.35% complaint rate mid-cooldown is a materially different situation than staying flat at 0.15%, and the existing watchdogs' single-tier dedup logic doesn't have this escalation case since they have no tiers. This is new logic, not a copy-paste of an existing watchdog — flag it for the planner explicitly.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Suppression-email hashing key management | A brand-new secret-storage scheme, KMS integration, or key-rotation mechanism | `@mega-crm/kms`'s existing `encryptTenantSecret`/`decryptTenantSecret` (already handles AWS KMS vs local-provider dispatch, DEK zeroing, provider abstraction) | This exact envelope-encryption machinery already exists and is already proven in production for the SendGrid-key use case; the only new work is generating a random HMAC key once per workspace and storing it as an `EncryptedSecret` row — not re-deriving the KMS integration |
| PII field detection inside freeform JSONB (`send_events.payload`, `events.properties`) | New regex/heuristics for "does this key or value look like PII" | `packages/redaction/src/rules.ts`'s `REDACTION_RULES` (`keyRules`/`valueRules`) | Already tuned against exactly this payload shape (SendGrid webhook payloads, tenant event properties) with documented false-positive fixes (e.g. the UUID/phone-number collision fix); re-deriving this logic for the erasure scrub risks reintroducing the same false positives this file's own history already fixed |
| Bounded/resumable batch scrub over partitioned tables | A new checkpoint/pagination scheme for the erasure scrub job | Phase 12's sweep pattern (`flow-segment-sweep-checkpoint.ts`'s keyset-pagination + checkpoint-in-same-transaction shape) | Directly analogous problem (bounded walk over a large table, resumable after a crash, deterministic jobId) already solved and crash-tested in this codebase |
| Cross-replica alert deduplication | A new in-memory or Redis-based "have I already alerted" flag | The `claimAlertSlot`/`claimDeadLetterAlertSlot` single-statement `UPDATE ... RETURNING` pattern | Three prior watchdogs already solved the exact multi-replica race this needs to avoid; the only new work is keying the claim by `(workspace_id, metric)` instead of a singleton row |
| Repeatable scheduled jobs (replay sweep, erasure scrub trigger, reputation tick) | A new cron-like scheduling mechanism | `queue.upsertJobScheduler(stableId, {every}, ...)` | Every recurring job in this codebase (`partition-maintenance`, `send-reconciler`, `analytics-reconcile`, `flow-segment-sweep`) already uses this exact pattern, including the WRK-13 fix for the `autorun` key |

**Key insight:** This phase's biggest hand-roll risk is not "should I use a library" — it's **re-deriving a solved problem inside this same codebase** because the five new concerns (journal, quarantine, erasure scrub, per-tenant alert, dedup constraint) each superficially look novel but each has a structurally identical sibling already built and crash-tested in Phases 9–12. The planner's job is pattern-matching to the right sibling, not designing from scratch.

## Runtime State Inventory

This phase is not a rename/rebrand, but it is migration-heavy — several categories of runtime state either need a data migration alongside the code change, or need explicit "does not apply" confirmation.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `workspace_suppressions.email` currently stores **plaintext** emails for every existing suppressed/unsubscribed-then-deleted contact. D-02 changes new writes to store an HMAC hash instead. | **Data migration required**: existing plaintext rows must be re-hashed in place (same normalization the pre-send check will use) as part of the same change — a mixed plaintext/hash column is not a valid intermediate state for a column the send-pipeline compares against on every send. This is the single largest "existing data must move" item in this phase. |
| Stored data | `send_events` rows already contain duplicate `(send_id, event_type, occurred_at)` groups under the current key (the exact bug CMP-07 fixes) | **Data migration required** (pre-dedupe) before the new unique index can be built — see Pattern 1 / Pitfall 3. Not optional; the index build fails otherwise. |
| Stored data | Existing `contacts` rows deleted under the OLD hard-DELETE `deleteContact` are already gone — no anonymization backfill is possible for contacts deleted before this phase ships (the row no longer exists). | **None** — explicitly document this as a known limitation: CMP-04's evidence guarantee applies prospectively from this phase's ship date; contacts hard-deleted before then have no anonymized-evidence trail to retrofit. Confirm this is an acceptable gap with the operator (likely yes, since there is no data to migrate — it's already gone). |
| Live service config | None found — this phase touches no externally-configured service (no n8n-style UI-configured workflows, no Datadog/Tailscale/Cloudflare config). | None. |
| OS-registered state | None found — no Task Scheduler, launchd, pm2, or systemd registrations reference anything this phase renames or restructures. | None. |
| Secrets/env vars | New: an HMAC key per workspace (KMS-wrapped, stored in Postgres per Pattern 1's kms-reuse design) — this is new secret material, not a rename of existing secret material. | No existing env var/secret is renamed. Confirm `OPERATOR_ALERT_EMAIL` (existing) is reused unchanged for D-08/D-09's operator channel — no new env var needed there. |
| Build artifacts / installed packages | None — no package rename, no `package.json` name changes in this phase. | None. |
| In-flight jobs | Existing in-flight `webhook-events` queue jobs (enqueued before this phase's deploy) carry the OLD payload shape (no `journalId` if that field is added — see Pattern 3's schemaVersion note). | **Code handles this, not data migration**: per ROADMAP R-05's existing convention, the worker must defer/handle jobs at the old `schemaVersion` gracefully during the deploy window — this is the same backward-compatible-payload discipline already used for every prior payload-shape change in this codebase, not a new problem. |

**Operational caveat carried from STATE.md:** `npm run db:migrate` (drizzle-kit CLI) is known to hang in the current dev sandbox under Node v26 (noted after Phase 12: migrations 0053/0054 were proven via `test:migrations` but not applied to the dev DB via the CLI). This phase ships **at least six new migrations** (0055–0060, see Recommended Project Structure) — plan for migrations to be verified via `npm run test:migrations` (ephemeral DB, known-working per Phase 8's QG-05) rather than assuming `db:migrate` succeeds interactively in this sandbox; flag this explicitly as a known friction point for the executor, not a new discovery.

## Common Pitfalls

### Pitfall 1: Bare `::date` on a `timestamptz` column is session-timezone-dependent, not UTC

**What goes wrong:** `sent_at::date` (as currently written in `analytics-reconciliation.worker.ts`'s `reconcileWorkspaceDay`) implicitly converts the `timestamptz` value to the **session's** `TimeZone` setting before truncating to a date. If any connection in the pool has a non-UTC `TimeZone` GUC (default, session override, or a future connection-pooler misconfiguration), the "day" a send counts toward silently shifts.

**Why it happens:** Postgres's `timestamptz` is stored as UTC internally but *displayed and cast* relative to the session timezone — this is standard, documented behavior, not a bug in this codebase. `sends.sent_at`/`delivered_at`/`first_opened_at`/etc. are confirmed `timestamp with time zone` columns (verified directly against `packages/db/src/schema/sends.ts` during this research), so this pitfall applies to every fact-column cast in the reconciler, not a hypothetical.

**How to avoid:** `(sent_at AT TIME ZONE 'UTC')::date` forces the conversion to UTC regardless of session `TimeZone`, exactly as D-13 specifies. Apply this to every `::date` cast in `reconcileWorkspaceDay` and any new query this phase adds (dirty-day queries, reputation-rate queries if they bucket by day).

**Warning signs:** A reconciliation re-run producing different `sent_count`/`delivered_count` totals than an earlier run with no new sends in between, or counts that shift by exactly one day near midnight UTC — both are direct symptoms of session-TZ-dependent truncation.

### Pitfall 2: `CREATE INDEX CONCURRENTLY` does not work directly on a partitioned parent table

**What goes wrong:** Running `CREATE UNIQUE INDEX CONCURRENTLY ... ON send_events (...)` directly against the partitioned parent table errors immediately (`ERROR: cannot create index on partitioned table "send_events" concurrently`) — this is not a permissions or lock issue, it's an unsupported operation.

**Why it happens:** PostgreSQL's concurrent index build algorithm is not implemented for the recursive per-partition index creation a partitioned-table `CREATE INDEX` implies. [CITED: PostgreSQL docs — `CREATE INDEX`, `sql-createindex.html`]

**How to avoid:** Build the index `ON ONLY` the parent (metadata-only, instant), then build each partition's matching index with `CREATE INDEX CONCURRENTLY` individually and `ALTER INDEX ... ATTACH PARTITION` it to the parent — see Code Example 2 below. This is the same category of pitfall the project already names for Phase 14 (Pitfall 17, `CREATE UNIQUE INDEX CONCURRENTLY` leaving an `INVALID` index over existing duplicates) — the CMP-07 migration combines *both* pitfalls (partitioned-table concurrency limitation AND pre-existing duplicate data), so treat it as strictly higher-risk than a simple index-add.

**Warning signs:** A migration script that runs `CREATE INDEX CONCURRENTLY` against `send_events` directly and expects it to succeed — this will fail at migration-apply time, ideally caught in `test:migrations` before it ever reaches a real deploy.

### Pitfall 3: The new dedup constraint fails to build over pre-existing duplicate rows

**What goes wrong:** The historical redelivery duplicates that motivate CMP-07 in the first place — rows sharing `(workspace_id, send_id, event_type, occurred_at)` but differing only in `sg_event_id` — already exist in production `send_events` data. Attempting to build the new unique index over them fails with a duplicate-key violation, mid-migration, on a partitioned table with potentially large per-partition row counts.

**Why it happens:** The new constraint is *narrower* than the old one specifically to close the bypass — which necessarily means some existing rows that were "distinct" under the old key collapse to "duplicate" under the new key. This is inherent to the fix, not an implementation mistake.

**How to avoid:** Run the duplicate-count query (Code Example 2, Step 0) against a production-data copy *before* writing the destructive cleanup step, then resolve duplicates deterministically (recommend: keep the row with the earliest `received_at` — it was the first-observed occurrence — delete the rest) in a bounded/batched loop per Phase 12's sweep conventions, never a single unbounded `DELETE`. Verify `workspace_daily_rollup` totals are unchanged after cleanup for a sample workspace/day (mirrors the existing Pitfall 2 precedent from Phase 11's enum migration: "verify rollup totals are unchanged afterwards").

**Warning signs:** Migration fails at `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX` with a duplicate-key error after the index build otherwise appeared to succeed (the index build itself doesn't enforce uniqueness until the constraint is added — a subtlety worth calling out explicitly in the migration's own comments, mirroring the CHECK-constraint-first precedent from Phase 9).

### Pitfall 4: KMS unwrap-per-check on the suppression pre-send hot path

**What goes wrong:** If the HMAC key for suppression hashing is per-workspace and KMS-wrapped (Pattern 1's recommendation), and the pre-send suppression gate calls `decryptTenantSecret` on every single send dispatch, this adds a KMS round-trip (network call under the AWS provider) to the hottest path in the platform — send-dispatch, which this project's other phases have specifically optimized for throughput (Phase 12's per-tenant token-bucket RPS ceiling exists precisely because this path is volume-sensitive).

**Why it happens:** The envelope-encryption pattern was designed for "decrypt once at the moment you need the plaintext secret" (e.g. decrypt a SendGrid API key right before the `mail/send` call) — that's a per-send-dispatch KMS call too, but SendGrid's own key doesn't need to be looked up on every *suppression check*, only on every actual send attempt, and even there it's one KMS call per send regardless. Reusing the identical per-use-decrypt pattern for a value that's compared far more frequently (every candidate recipient, before dispatch is even attempted) multiplies the KMS call volume.

**How to avoid:** Cache the unwrapped HMAC key in-process (keyed by `workspace_id`, short TTL, never persisted to disk/Redis) rather than calling `decryptTenantSecret` fresh on every suppression check. This keeps the KMS-backed design (Pattern 1's recommendation) without paying its KMS-round-trip cost on the hot path. Benchmark this against the AWS KMS provider specifically before committing — if the cache doesn't sufficiently amortize the cost, fall back to the "single static platform-wide secret" alternative documented in Alternatives Considered.

**Warning signs:** Send-dispatch latency regression correlated with suppression-check volume after this phase ships; AWS KMS API throttling/cost alerts appearing for the first time.

### Pitfall 5: Copying `dead_letter_alert_state`'s singleton shape for a per-tenant alert

**What goes wrong:** `dead_letter_alert_state`, `partition_maintenance_runs`, and `send_reconciler_runs` are all singleton (`id = 1` or effectively-singleton) tables because their underlying concerns are platform-wide. If the reputation alert state is built by copying one of these files (a very natural planning shortcut, since they're the closest existing precedent), the resulting table can only track ONE workspace's alert state platform-wide — every tenant's reputation alerts collide on the same row.

**Why it happens:** All three existing watchdogs are the *only* precedent in this codebase for "atomic cross-replica alert claim," and all three happen to be singleton concerns — there's no existing per-tenant watchdog to copy from directly.

**How to avoid:** Key the new table by `(workspace_id, metric)` from the start (Pattern 5) — the *claim statement shape* (`UPDATE ... WHERE ... RETURNING`) is the reusable part, not the table's cardinality.

**Warning signs:** A migration for `reputation_alert_state` with an `id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1)` constraint, or a claim function whose `WHERE` clause has no `workspace_id` parameter.

## Code Examples

### Code Example 1: UTC-correct day-bucketing (CMP-02/D-13)

```sql
-- Source: PostgreSQL documented timestamptz-to-date cast behavior
-- (session TimeZone-dependent unless explicitly forced to UTC).
-- BEFORE (session-TZ-dependent -- the current reconciler code):
count(*) FILTER (WHERE sent_at IS NOT NULL AND sent_at::date = $2::date)

-- AFTER (D-13's fix -- always UTC regardless of session TimeZone GUC):
count(*) FILTER (
  WHERE sent_at IS NOT NULL
    AND (sent_at AT TIME ZONE 'UTC')::date = $2::date
)
```

### Code Example 2: Dedup-constraint migration duplicate check (CMP-07/Pitfall 3)

```sql
-- Run this against a production-data snapshot BEFORE writing the cleanup
-- migration -- the count tells you the blast radius of the fix.
SELECT count(*) AS duplicate_groups, sum(cnt - 1) AS rows_to_reconcile
FROM (
  SELECT workspace_id, send_id, event_type, occurred_at, count(*) AS cnt
  FROM send_events
  WHERE send_id IS NOT NULL  -- NULL send_id rows are exempt from this key's dedup guarantee (see Pattern 1)
  GROUP BY workspace_id, send_id, event_type, occurred_at
  HAVING count(*) > 1
) dupes;
```

### Code Example 3: Keyed alert-slot claim (CMP-09/Pattern 5)

```sql
-- Source: derived directly from claimDeadLetterAlertSlot's proven shape
-- (apps/api/src/modules/ops/dead-letter-watchdog.ts), re-keyed per-workspace.
UPDATE reputation_alert_state
   SET last_alert_sent_at = $3::timestamptz,
       tier = $4,
       last_observed_rate = $5,
       updated_at = now()
 WHERE workspace_id = $1
   AND metric = $2
   AND (
     last_alert_sent_at IS NULL
     OR last_alert_sent_at < $3::timestamptz - make_interval(hours => $6)
     OR $4 = 'critical' AND tier = 'warn'  -- escalation bypasses the cooldown
   )
RETURNING last_alert_sent_at;
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `send_events` dedup on `(workspace_id, sg_event_id, occurred_at)` | Dedup on `(workspace_id, send_id, event_type, occurred_at)`, `sg_event_id` stored but not in the constraint | This phase (CMP-07) | Closes the verified sg_event_id-instability bypass; requires a partitioned-index migration and a pre-existing-duplicate cleanup |
| `deleteContact` hard `DELETE FROM contacts` | Anonymize-in-place: scrub PII columns to NULL, set `anonymized_at`, keep the row and its FKs | This phase (CMP-04) | Preserves delivery/suppression evidence across erasure requests; changes API delete semantics from row-absence to anonymized-row presence everywhere that reads `contacts` |
| `workspace_suppressions.email` stores plaintext | Stores HMAC-SHA256 of normalized email | This phase (CMP-02) | Pre-send suppression check becomes a hash-compare, not an equality-compare on plaintext; requires migrating existing plaintext rows |
| Bare `sent_at::date` casts in the reconciler | `(sent_at AT TIME ZONE 'UTC')::date` | This phase (CMP-02/D-13) | Removes session-TimeZone dependency from every daily metric; the reconciler's output becomes deterministic regardless of connection-pool TZ configuration |
| No durable record of raw webhook deliveries pre-processing | `ingress_journal` table, written after signature verification, before enqueue | This phase (CMP-08) | Enables replay after a post-receipt loss (Redis flush, worker crash) without depending on SendGrid's paid Email Activity API |

**Deprecated/outdated:** none — this phase does not remove or replace any external library; all "old approach" rows above are in-repo behavior changes, not library deprecations.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Two genuinely-distinct engagement events (e.g. two rapid opens) landing on the exact same UTC second, same send, same event_type will now dedupe to one `send_events` row under the new CMP-07 key, but `open_count`/`click_count` repeat counters are unaffected since they increment independently of the dedup insert | Architecture Pattern 1 | If wrong (i.e. `open_count` logic is somehow gated on the dedup insert path in a way this research didn't trace fully), a schema change could silently under-count repeat engagement. Verify by re-reading `applyEventSideEffects`'s `open`/`click` cases at planning time before committing to this key shape. |
| A2 | A single in-process LRU cache of unwrapped per-workspace HMAC keys sufficiently amortizes the KMS round-trip cost on the suppression pre-send hot path | Pitfall 4, Alternatives Considered | If wrong, send-dispatch throughput could regress under the AWS KMS provider specifically (local-provider has no network round-trip and wouldn't surface this). Recommend a load-test comparison (mirroring Phase 12's own `loadtest:tenant-rps` script) before shipping to a production KMS provider. |
| A3 | No tenant-facing surface currently reads `workspace_suppressions.email` directly (e.g. a UI list of suppressed emails) that would break when the column becomes a hash | Architecture Pattern (Suppression hash), D-02 | If wrong, a UI surface showing "suppressed emails" would start showing hash strings instead of readable addresses. Grep `workspace_suppressions` read sites across `apps/web`/`apps/api` before finalizing the migration — this research did not exhaustively check for a suppression-list UI. |
| A4 | `ingress_journal` and the quarantine table should carry RLS (`workspace_id` + tenant isolation policy) rather than following `dead_letter_jobs`' no-RLS precedent | Architecture Pattern 3 | Low risk of being wrong in direction (both tables demonstrably carry tenant PII, unlike dead_letter_jobs), but the exact RLS policy shape (fail-closed bare-cast per Phase 10's Pitfall 11 lesson) should be confirmed against Phase 10's migration conventions at plan time, not re-derived from first principles. |

**If this table is empty:** N/A — see entries above. Every provider-facing fact this research relied on (sg_event_id instability, 24h/72h SendGrid retry/deferral windows, Gmail/Yahoo 0.1%/0.3% thresholds, ICO anonymization-vs-erasure guidance) is a decision already locked and cited in CONTEXT.md/ROADMAP.md — this research did not re-verify those independently and defers to that existing provenance rather than re-litigating it.

## Open Questions

1. **Does any UI surface display `workspace_suppressions.email` in plaintext today?**
   - What we know: The table is read by `isEmailSuppressed`/`isEmailTaken`-style equality checks in `contact.repository.ts` and the webhook worker's `applySuppression` — all comparison-only, no rendering found during this research's grep pass.
   - What's unclear: Whether `apps/web` has a settings/compliance page listing suppressed addresses for operator visibility, which this research did not exhaustively search.
   - Recommendation: Grep `apps/web/src` for `workspace_suppressions`/`suppress` references at planning time before finalizing the hash migration; if such a UI exists, its copy needs a "we no longer store the address, only proof of suppression" adjustment, not a broken hash-string render.

2. **Exact minimum-volume floor for CMP-09's complaint/bounce-rate alerting**
   - What we know: D-10/D-12 lock the two-tier thresholds (0.1%/0.3% complaint, ~2% bounce) and specify "a minimum-volume floor guards against low-volume noise" as a versioned constant, planner-tunable.
   - What's unclear: The exact floor value (e.g. minimum 100 delivered emails in the rolling window before a rate is even computed) is explicitly left to the planner, and this research found no in-repo precedent for a "minimum sample size before alerting" pattern to anchor a specific number against.
   - Recommendation: Pick a floor that avoids a 1-in-3 tenant with near-zero volume tripping "critical" off a single spam report (e.g. 3 complaints / 10 delivered = 30%), and document the reasoning inline as a versioned-constant comment per this project's established convention — a concrete number (e.g. 500 delivered in the rolling window) is a reasonable planning-time default but should be treated as provisional, not researched-and-verified.

3. **Where exactly does `applyUnsubscribeWithSendFact` live if the webhook worker's `dropped`-with-unsubscribe-outcome case also needs it?**
   - What we know: `webhook-events.worker.ts`'s `dropped` case calls `applyUnsubscribe` (not send-fact-aware) when `resolveSuppression` returns an `unsubscribed` outcome — this is a THIRD call site beyond the route and the direct `unsubscribe`/`group_unsubscribe` cases, and it already has a `send` object in scope (unlike the route, which only has `sendId` from the token).
   - What's unclear: Whether the shared helper's signature should take a full `ResolvedSend` (as the webhook worker has) or just `sendId` (as the route has, requiring an extra lookup) — this affects the helper's exact call-site ergonomics at all three sites, not just two.
   - Recommendation: Design the shared helper to accept `sendId` alone and look up `campaignId`/`contactId` itself inside the transaction if not already known by the caller — this makes all three call sites (route, direct unsubscribe event, dropped-with-unsubscribe-outcome) uniform, at the cost of one extra SELECT on the two call sites that already have the row in scope. Confirm this tradeoff explicitly at plan time rather than defaulting to whichever shape is easiest to retrofit into the existing webhook worker code.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL | All new tables/migrations, partitioned-index rebuild | ✓ (per project CLAUDE.md hard constraint) | 16 or 17 | — |
| Redis | New BullMQ queues (replay sweep, erasure scrub, reputation tick) | ✓ (per project CLAUDE.md hard constraint) | 7.x / Valkey 8.x | — |
| `npm run db:migrate` (drizzle-kit CLI) | Applying migrations 0055–0060 in the dev sandbox | ✗ known-hanging under Node v26 in this dev sandbox (per STATE.md operational note carried from Phase 12) | — | `npm run test:migrations` against an ephemeral test DB (proven working per QG-05); apply to a real dev/staging DB via a non-hanging path (direct `psql`/CI migration step) rather than the interactive CLI |
| AWS KMS (or local KMS provider) | HMAC key envelope-encryption (if per-workspace-key design is adopted) | Depends on `KMS_PROVIDER` env — local-provider always available in dev; AWS provider requires real credentials | — | `local-provider.ts`'s dev-only static KEK already refuses to boot under `NODE_ENV=production`, so this is a dev-time convenience only, not a production fallback — production must have real AWS KMS access provisioned already (this phase adds no new KMS provisioning requirement beyond what SendGrid-key encryption already needs) |

**Missing dependencies with no fallback:** none — every dependency this phase needs is already a hard project constraint (Postgres/Redis) or already provisioned (KMS).

**Missing dependencies with fallback:** `npm run db:migrate`'s dev-sandbox hang — use `test:migrations` for verification; confirm the real deploy path (Phase 14's territory) applies migrations without this CLI's specific hang.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x (already configured at `./vitest.config.ts` and `./scripts/vitest.config.ts`) |
| Config file | `vitest.config.ts` (root) — per-workspace test scripts (`apps/api`, `apps/worker`, `packages/db`) already exist |
| Quick run command | `npm run test --workspaces --if-present` (existing) or targeted: `vitest run --root apps/worker src/queues/__tests__/<file>.test.ts` |
| Full suite command | `npm run coverage` (existing, `vitest run --coverage --testTimeout=60000`) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|--------------------|-------------|
| CMP-01 | Unsubscribe atomicity — status+history+send-fact commit or none commit | failure-injection (state-based, per 11-11 shape) | `npm run failure:unsubscribe-atomic` (new script, mirrors existing `failure:*` naming) | ❌ Wave 0 |
| CMP-01 | Route and webhook paths converge idempotently (either order, no double-count) | unit/integration | `vitest run --root apps/worker src/queues/__tests__/webhook-events-unsubscribe-convergence.test.ts` (new) | ❌ Wave 0 |
| CMP-02 | UTC day-bucketing is session-TZ-independent | unit | `vitest run --root packages/db src/schema/__tests__/reconcile-utc-day.test.ts` (new, or extend existing reconciler test with a non-UTC session `TimeZone` set explicitly) | ❌ Wave 0 |
| CMP-03 | Late event outside 2-day window marks day dirty; next tick re-reconciles it | integration | `vitest run --root apps/worker src/queues/__tests__/analytics-reconciliation-dirty-day.test.ts` (new) | ❌ Wave 0 |
| CMP-04 | Delete anonymizes synchronously; suppression hash still blocks re-send; scrub job completes and is tracked | integration + failure-injection (scrub resumability, Phase 12 shape) | `vitest run --root apps/api src/modules/contacts/__tests__/contact-erasure.test.ts` (new) + `npm run failure:erasure-scrub-resume` (new) | ❌ Wave 0 |
| CMP-05 | Out-of-range `occurred_at` is quarantined, never counted, never inserted into send_events | unit | `vitest run --root apps/worker src/queues/__tests__/webhook-events-occurred-at-bounds.test.ts` (new) | ❌ Wave 0 |
| CMP-06 | Reconciliation runs as a recurring job (already proven) | existing | `analytics-reconciliation.worker.ts`'s existing scheduler-registration test | ✅ (existing, extend for dirty-day) |
| CMP-07 | Redelivered event with a DIFFERENT sg_event_id but same occurrence dedupes to one row | unit + migration test | `vitest run --root apps/worker src/queues/__tests__/webhook-events-dedup-rebase.test.ts` (new) + `npm run test:migrations` (constraint migration, existing command) | ❌ Wave 0 |
| CMP-08 | Journal replay recovers events missed during endpoint downtime; double-replay is harmless | failure-injection | `npm run failure:webhook-journal-replay` (new) | ❌ Wave 0 |
| CMP-09 | Complaint/bounce rate crossing warn/critical tier sends exactly one alert per window, escalation bypasses cooldown | unit | `vitest run --root apps/api src/modules/ops/__tests__/reputation-watchdog.test.ts` (new, mirrors `dead-letter-watchdog.test.ts`'s shape) | ❌ Wave 0 |

### Sampling Rate

- **Per task commit:** targeted `vitest run --root <workspace> <file>` for the file(s) touched.
- **Per wave merge:** `npm run test --workspaces --if-present` + `npm run test:migrations` (mandatory for this phase given six new migrations).
- **Phase gate:** `npm run coverage` full suite green, plus `npm run failure:all`-equivalent run including the new failure-injection scripts, before `/gsd-verify-work`.

### Wave 0 Gaps

- [ ] `webhook-events-dedup-rebase.test.ts` — covers CMP-07 (new constraint behavior, including the NULL-send_id non-dedup tradeoff from Pattern 1)
- [ ] `webhook-events-occurred-at-bounds.test.ts` — covers CMP-05 (quarantine routing)
- [ ] `webhook-events-unsubscribe-convergence.test.ts` — covers CMP-01 (both paths, both orderings)
- [ ] `reconcile-utc-day.test.ts` — covers CMP-02 (explicit non-UTC session TimeZone to prove the fix)
- [ ] `analytics-reconciliation-dirty-day.test.ts` — covers CMP-03
- [ ] `contact-erasure.test.ts` — covers CMP-04 (sync anonymize + hash suppression + async scrub tracking)
- [ ] `reputation-watchdog.test.ts` — covers CMP-09 (keyed claim, tier escalation)
- [ ] New failure-injection scripts: `failure:unsubscribe-atomic`, `failure:erasure-scrub-resume`, `failure:webhook-journal-replay` — registered in root `package.json` per the existing `failure:*` naming convention, and added to the `failure:all` aggregate script
- [ ] Migration test coverage for 0055–0060 via existing `test:migrations` harness — no new framework needed, just new migration files exercised by the existing apply-from-zero + apply-over-existing-schema tests (QG-05)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No | This phase adds no new authentication surface (unsubscribe route and webhook route both already exist with their own established threat models) |
| V3 Session Management | No | Not touched by this phase |
| V4 Access Control | Partial | The new `ingress_journal`/quarantine tables carry tenant PII and MUST get RLS (fail-closed, per Phase 10's established direction) — this is new access-control surface, unlike `dead_letter_jobs` which deliberately has none |
| V5 Input Validation | Yes | `occurred_at` bounding (CMP-05) is exactly an input-validation control on a provider-supplied field before it's trusted for partition routing or dedup — bound it against a fixed window (Postgres `Date`-representable range already bounds it defensively today; CMP-05 tightens this to a business-meaningful ~7-day-past/minutes-future window) |
| V6 Cryptography | Yes | HMAC-SHA256 via `node:crypto` only (never hand-rolled hashing); key material handled via the existing `@mega-crm/kms` envelope-encryption package, never a raw static string committed to code or a `.env` file checked into the repo |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Manipulated `occurred_at` bypassing dedup or misrouting a partition | Tampering | Bound the value against a sane window BEFORE either use (CMP-05, already locked); quarantine out-of-range events with `received_at` preserved for forensics rather than silently dropping or accepting them |
| Replay of a genuinely-signed-but-stale webhook batch via the new journal (journal itself becomes a replay source if compromised) | Repudiation / Tampering | The journal stores the batch AFTER signature+timestamp verification already passed — it is a record of a legitimately-received delivery, not a bypass of verification. Replay of a journal row re-enqueues the SAME job the worker already dedupes idempotently (`ON CONFLICT DO NOTHING`), so a compromised/malicious journal replay produces no additional side effects beyond what a legitimate SendGrid retry would already produce. |
| PII leakage via the ingress journal or quarantine table (raw payloads persisted, unlike the existing `dead_letter_jobs` which has none) | Information Disclosure | RLS (fail-closed, bare-cast direction per Pitfall 11's established lesson) on both new tables; ~7-day pruned retention (mirroring D-07); CMP-04's erasure scrub does NOT need to reach into these short-retention tables (document the interaction, don't silently assume it) |
| Cross-tenant reputation-alert leakage (workspace A's complaint rate visible to workspace B) | Information Disclosure | The keyed `(workspace_id, metric)` alert-state table (Pattern 5) is read/written exclusively by the platform-side reputation job via `withCrossWorkspaceScan` — never exposed through a tenant-facing API in this phase (dashboard UI is explicitly deferred to Phase 15); if a future phase adds a tenant-facing read of this table, it needs its own RLS policy scoped to that tenant's own `workspace_id` |
| Suppression-hash key exposure enabling a rainbow-table attack against the suppression list | Information Disclosure | Per-workspace KMS-wrapped key (Pattern 1) scopes the blast radius of a single leaked key to one workspace, rather than a platform-wide static secret exposing every tenant's suppression list to the same attack simultaneously (see Alternatives Considered) |

## Sources

### Primary (HIGH confidence)
- `packages/db/src/schema/sends.ts`, `send-events.ts`, `contacts.ts`, `suppressions.ts`, `workspace-daily-rollup.ts`, `dead-letter-jobs.ts` — direct codebase inspection confirming column types (`timestamptz`), existing constraints, and existing table shapes
- `apps/worker/src/queues/webhook-events.worker.ts`, `analytics-reconciliation.worker.ts` — direct codebase inspection of current dedup/side-effect/reconciliation logic
- `apps/api/src/modules/delivery/unsubscribe.routes.ts`, `apps/api/src/modules/contacts/contact.repository.ts`, `apps/api/src/modules/webhooks/webhooks.routes.ts`, `signature-verify.ts`, `enqueue.ts` — direct codebase inspection of the CMP-01/CMP-04/CMP-08 as-is state
- `apps/api/src/modules/ops/dead-letter-watchdog.ts`, `packages/kms/src/client.ts` — direct codebase inspection of the reusable claim-slot and envelope-encryption patterns
- [PostgreSQL 18 docs: CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html) — confirmed CONCURRENTLY limitation on partitioned tables and the ON ONLY + per-partition-CONCURRENTLY + ATTACH PARTITION workaround, verified 2026-08-11
- [PostgreSQL 18 docs: Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) — confirmed partitioned-table unique-constraint-must-include-partition-key rule (already known in-repo, cross-checked here)

### Secondary (MEDIUM confidence)
- `.planning/phases/13-compliance-analytics-integrity/13-CONTEXT.md`, `.planning/ROADMAP.md` § Phase 13, `.planning/research/PITFALLS.md` (Pitfall 14) — locked decisions and verified facts (sg_event_id instability, ICO anonymization guidance, Gmail/Yahoo thresholds) carried forward with their existing provenance, not re-verified independently in this research session
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md`, `apps/worker/src/queues/__tests__/failure-injection/segment-sweep-kill-resume.test.ts` — confirmed the state-based (not process-kill) shape for crash tests where boundaries are ledger-indistinguishable

### Tertiary (LOW confidence)
- None — no WebSearch-only, unverified claims are load-bearing in this research beyond the PostgreSQL docs citation above, which was corroborated by an official-docs summary in the search results.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies, entirely existing in-repo packages, directly verified
- Architecture (dedup re-base, journal, anonymization, alert-state): HIGH for the reused patterns (KMS, queue-core, watchdog claim-slot), MEDIUM for the exact migration mechanics of the CMP-07 constraint swap (verified against PostgreSQL docs, not yet executed against this specific dataset)
- Pitfalls: HIGH — all five pitfalls are either directly confirmed against live schema files (Pitfall 1, column types) or corroborated by official PostgreSQL documentation (Pitfalls 2–3) or first-principles reasoning about an already-locked design (Pitfalls 4–5)

**Research date:** 2026-08-11
**Valid until:** 30 days (stable domain — no external library versions to go stale; the PostgreSQL-mechanics facts are unlikely to change, but re-confirm against the actual production `send_events` duplicate count immediately before writing the CMP-07 migration, since that number is time-sensitive in a way this research's qualitative findings are not)
