# Phase 13: Compliance & Analytics Integrity - Context

**Gathered:** 2026-08-11
**Status:** Ready for planning

<domain>
## Phase Boundary

What the platform claims about consent and delivery matches what actually happened — an unsubscribe is honored everywhere at once, and a daily number means exactly one thing. Covers CMP-01…CMP-09 (см. `.planning/REQUIREMENTS.md`): atomic unsubscribe (status + consent history + originating send in one transaction), fixed UTC day semantics for daily metrics, late-event counting on the occurrence day, lawful contact erasure with retained evidence, `occurred_at` bounding with separate server `received_at` authority, metrics reconciliation as a recurring job, dedup resilient to unstable `sg_event_id`, webhook-downtime backfill, and per-tenant sender-reputation alerts.

**Already locked at ROADMAP level (do not re-litigate):**
- **CMP-05/CMP-07 (Pitfall 14):** `occurred_at` is bounded to a sane window BEFORE it routes the partition or feeds dedup; server-side `received_at` stays the separate authority; dedup is re-based on server-controlled fields (the current `(workspace_id, sg_event_id, occurred_at)` key is bypassable by varying only the timestamp). Rejected events go to an explicit quarantine path — one malformed event must never fail the whole webhook batch (enqueued as one job).
- **CMP-07 rests on a verified fact:** `sg_event_id` is NOT reliably stable across SendGrid webhook retries (first-party SendGrid issue, despite docs implying otherwise). A compound-key fallback is required.
- **CMP-04:** resolves via anonymisation-with-retained-evidence (ICO guidance on erasure vs. suppression), per the decision already recorded in PROJECT.md.
- **CMP-01:** must NOT fan out into separate writes — subscription status, consent history and the send row change in one transaction, verified by a crash test from Phase 8's harness.
- **Cross-phase note (Phase 9/14):** bounding `occurred_at` (CMP-05) is what protects the partition-attach machinery from stray timestamps routing rows far outside the current-month window.

</domain>

<decisions>
## Implementation Decisions

### Contact erasure shape (CMP-04)

- **D-01:** **Anonymize in place.** "Deleting" a contact keeps the row: email/name/phone/attributes scrubbed to NULL, an `anonymized_at` marker set. FKs from `sends`, `subscription_status_history`, `events` stay intact, so delivery evidence remains queryable and provably linked. Replaces today's hard `DELETE` in `deleteContact` (`apps/api/src/modules/contacts/contact.repository.ts`). — **Reversibility:** costly — the API delete semantics, suppression check, and UI contact views all shift from row-absence to anonymized-row semantics; reverting means re-touching all of them plus the erasure evidence contract.
- **D-02:** **Suppression evidence = hash + last-seen metadata.** `workspace_suppressions` stores an HMAC/SHA-256 of the normalized email plus minimal context (suppression reason, date, source) instead of today's plaintext email; the pre-send suppression check hashes the outgoing address and compares. No plaintext PII survives erasure. — **Reversibility:** one-way — once plaintext emails are replaced by hashes, the original addresses are unrecoverable by design; the hash format becomes part of the pre-send check contract.
- **D-03:** **JSONB PII is scrubbed on erasure in linked rows:** `send_events.payload` (raw SendGrid event carries the recipient email) and `events.properties` (tenant-supplied) rows linked to the contact are rewritten to strip email/PII fields, keeping event type + timestamps as delivery evidence. Bounded, batched UPDATEs over the partitioned tables (keyset/LIMIT loop per the Phase 12 sweep conventions).
- **D-04:** **Erasure executes as instant anonymization + async scrub with completion tracking.** The DELETE request anonymizes the contact row synchronously (mail stops immediately — suppression + status resolved at request time), then enqueues a background scrub job over sends/events partitions. An erasure record tracks completion — auditable proof the scrub ran. Follows existing BullMQ worker patterns (bounded, resumable, deterministic jobId).

### Webhook-downtime backfill (CMP-08)

- **D-05:** **Durable ingress journal + provider retries — no paid API dependency.** Raw webhook batches are persisted to Postgres at ingress (after signature verification, before enqueueing) so post-receipt loss (Redis flush, worker crash, bad deploy) is replayable. True endpoint unreachability is covered by SendGrid's ~24h retry window; outages longer than that resolve to honest `unknown` via the Phase 11 reconciler. SendGrid Email Activity API rejected as baseline (paid per-account add-on under BYO keys, heavily rate-limited — same grounds as Phase 11 D-05). — **Reversibility:** reversible — the journal is additive infrastructure; removing it restores today's behavior.
- **D-06:** **Replay = automatic sweep + manual range replay.** A scheduled tick (same `upsertJobScheduler` pattern as the reconcilers) finds journal rows with no ingestion-complete mark past an age threshold and re-enqueues them; dedup makes double-replay harmless. Plus an operator CLI/script that replays an explicit time range — for surgical re-runs after a bug fix misprocessed a window.
- **D-07:** **Journal retention: days, pruned.** Short horizon (~7 days, versioned constant) with a pruning job — outlives any realistic ingestion outage plus the reconciler windows (24h resolution / 72h re-scan), keeps the PII surface and storage small. The CMP-04 erasure scrub does not need to cover the journal beyond this horizon (document this interaction explicitly).
- **D-08:** **Ingestion-health visibility this phase = existing watchdog + `OPERATOR_ALERT_EMAIL`** (Phases 9/11/12 pattern, `claimAlertSlot` dedup): alert when the replay sweep finds stuck journal rows, or when active sends see zero incoming events past a threshold. Phase 15 (OPS-13) re-plumbs the same signal into real alerting.

### Reputation alerts (CMP-09)

- **D-09:** **Both operator and tenant are alerted.** Operator via the existing `OPERATOR_ALERT_EMAIL` watchdog channel; the tenant's workspace members via platform email (platform-mail machinery, not the tenant's own SendGrid key). The tenant owns the sending domain and must act — both parties see it early.
- **D-10:** **Complaint rate = rolling window with two tiers.** `spam_reports / delivered` over a rolling window (~7 days, versioned constant), warn tier ~0.1% and critical tier ~0.3%, mirroring the Gmail/Yahoo bulk-sender lines. Computed by a scheduled job from the existing fact columns (`spam_reported_at`, `delivered_at`); a minimum-volume floor guards against low-volume noise. Exact window/floor values planner-tunable versioned constants citing the Gmail/Yahoo guidance.
- **D-11:** **Alert only this phase — no automatic enforcement.** Crossing either tier alerts; auto-pausing a tenant's sending is a product-policy capability with its own UX (banners, override/unblock flow) and is explicitly deferred.
- **D-12:** **Track complaints AND hard-bounce rate.** Same job, same fact columns, one more ratio — bounce rate is the other line mailbox providers penalize (>~2%). Both ratios alert through the same two-tier machinery.

### Daily metric semantics (CMP-02/CMP-03)

- **D-13:** **`sent_at` (SendGrid acceptance) defines the day of a send** for `sent_count` — the current reconciler behavior made explicit, with all `::date` casts fixed to explicit UTC semantics (`AT TIME ZONE 'UTC'`), never session-TZ-dependent. All event-derived counters key off provider `occurred_at` UTC day (existing behavior, now documented as the CMP-02 contract). — **Reversibility:** reversible — a documented semantics choice; changing the field later is a reconciler query change plus re-reconciliation.
- **D-14:** **Late events are covered by dirty-day marking.** When an event lands on a (workspace, day) outside the standing 2-day reconciliation window, that day is marked dirty; the reconciliation tick sweeps dirty days in addition to today/yesterday. Every retroactive increment gets verified — no blanket widening of the per-tick scan, no unverified band. Extends `analytics-reconciliation.worker.ts` (CMP-06's recurring job already exists; this phase completes it).
- **D-15:** **CMP-05 acceptance window ≈ 7 days past, minutes of future skew.** Covers SendGrid's ~24h webhook retries + 72h deferral cycle with margin; a few minutes' future tolerance for clock skew. Out-of-range events are quarantined (with `received_at` preserved for forensics), never counted in metrics and never routed to partitions by a stray timestamp. Exact values versioned constants with rationale comments.
- **D-16:** **`unknown` sends get an explicit count in campaign stats** (deferred to this phase by Phase 11 D-13): campaign cards and send-log stats show `unknown` as its own small count/label next to sent/failed. Daily rollups continue to EXCLUDE `unknown` from sent/failed counts (Phase 11 D-13 stands; document it).

### Claude's Discretion

- **CMP-07 fallback dedup key composition** (server-controlled fields: e.g. `send_id` + normalized event type + bounded time bucket) — must satisfy the ROADMAP lock ("re-base dedup on server-controlled fields") and be researched against the verified unstable-`sg_event_id` fact; exact key shape, migration path for the existing unique constraint, and its interaction with the partition key are researcher/planner territory.
- **CMP-01 transaction shape:** the unsubscribe route today updates contact + history but never touches the originating send (the token already carries `sendId`); the webhook unsubscribe path already writes send fact + status + counters in one transaction. How the two paths converge on one atomic implementation (shared helper vs parallel code) is planner discretion; the crash test on Phase 8's harness is mandatory.
- Quarantine mechanism shape (dedicated table vs journal-row flag), its retention, and whether quarantined events are operator-visible beyond SQL.
- Journal schema/granularity (per-batch vs per-event rows), ingestion-complete marking, and where the journal write sits relative to signature verification (must be after verification — never journal unverified payloads).
- Anonymization details: which normalized-email form feeds the hash, HMAC key handling (KMS-backed vs static secret), erasure-record schema, scrub batch sizes, `contacts` unique-constraint handling for anonymized rows (workspace+email unique index vs NULL email).
- Reputation job cadence, alert re-fire/cooldown policy (reuse `claimAlertSlot`), minimum-volume floor value, exact rolling-window mechanics (rollup-based vs fact-column scan).
- Dirty-day marking mechanism (table vs column on rollup row) and sweep bounds.
- Where the CMP-02 day-semantics contract is documented (`ARCHITECTURE.md` section vs `SPECIFICATION.md` §4 note — likely both).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and phase boundaries
- `.planning/ROADMAP.md` § Phase 13 — goal, 5 success criteria, sequencing/pitfall notes (Pitfall 14, unstable-`sg_event_id` verified fact, ICO anonymisation direction, CMP-01 single-transaction rule, quarantine path)
- `.planning/REQUIREMENTS.md` — CMP-01…CMP-09
- `.planning/AUDIT-2026-07-27-production-readiness.md` — v1.1 requirements source; compliance/analytics findings (CMP-06/08/09 are three of the nine audit gaps)
- `.planning/research/PITFALLS.md` — Pitfall 14 (`occurred_at` double duty: partition routing + dedup key)

### Existing compliance/analytics code (as-is state)
- `apps/api/src/modules/delivery/unsubscribe.routes.ts` — public RFC 8058 unsubscribe; updates contact + history atomically but NOT the originating send (token HMAC already binds `sendId`/`contactId`/`workspaceId`) — the CMP-01 gap
- `apps/worker/src/queues/webhook-events.worker.ts` — `extractEventRow` (timestamp bounds-check against Date range only — CMP-05 tightens this), `setFactColumnOnce` first-write gates, unsubscribe case (send fact + `applyUnsubscribe` + counters in one tx), dedup insert `ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING` — the CMP-07 target
- `packages/db/src/schema/send-events.ts` — partitioned-by-`occurred_at` physical table doc, dedup-key rationale (the assumption CMP-07 invalidates), `received_at` already exists (`defaultNow()`)
- `apps/worker/src/queues/analytics-rollup.ts` — `incrementWorkspaceDailyRollup` (UTC day via `occurredAt.slice(0,10)`, additive upsert)
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` — existing recurring reconcile job (3-min tick, 2-day window, absolute-overwrite semantics, sole writer of `sent_count`, bare `::date` casts — D-13/D-14 targets)
- `packages/db/src/schema/workspace-daily-rollup.ts` — the two-write-path contract (incremental vs reconciliation)
- `apps/api/src/modules/contacts/contact.repository.ts` — `deleteContact` (hard DELETE + plaintext email into `workspace_suppressions` — D-01/D-02 replace this)
- `packages/contacts-core/src/subscription-status-history.ts` — `recordSubscriptionStatusChange` (consent history writer, caller-gated no-op rule)
- `packages/contacts-core/src/contact-repository.ts` — `applyUnsubscribe` / suppression resolution used by the webhook path
- `packages/delivery-core/src/event-normalize.ts` — `normalizeEventType`, suppression thresholds (spam_report/bounce classification CMP-09 reads)
- `apps/api/src/modules/webhooks/webhooks.routes.ts` + `signature-verify.ts` — webhook ingress (raw-body ECDSA verification, batch enqueued as one job); D-05's journal write lands here after verification
- `packages/db/src/schema/contacts.ts` — PII columns (email/first/last/phone/attributes) + `contacts_workspace_email_unique` (anonymization must handle it)
- `packages/db/src/schema/events.ts` — tenant events `properties` JSONB (D-03 scrub target)

### Phase 8–12 infrastructure this phase builds on
- `.planning/phases/11-delivery-correctness/11-CONTEXT.md` — D-02 (`unknown` enum, one-way), D-04 (72h re-scan horizon), D-05 (Email Activity API rejection grounds), D-06 (`processed` event), D-07 (24h resolution window), D-13 (rollups exclude `unknown`; campaign-card treatment deferred HERE), D-14 (watchdog pattern)
- `.planning/phases/12-worker-reliability-tenant-fairness/12-CONTEXT.md` — D-07 (`dead_letter_jobs` Postgres DLQ — the journal/quarantine's architectural sibling), D-08 (watchdog extension precedent), D-09 (checkpoint-in-same-transaction sweep pattern for D-03's batched scrub), D-10 (`packages/queue-core` factory — all new queues MUST use it)
- `.planning/phases/10-tenant-isolation-trust-boundaries/10-CONTEXT.md` — `mega_crm_scan`/`withCrossWorkspaceScan` for any cross-tenant discovery (reputation job, dirty-day sweep discovery); `packages/redaction` for scrubbing payload snapshots
- `.planning/phases/08-quality-gates-failure-injection-foundation/08-CONTEXT.md` — failure-injection harness for the CMP-01 crash test; migration linter (constraint/enum migration discipline)
- Phase 9 convention — versioned constants with rationale comments (all windows, thresholds, retention horizons in this phase follow it)
- `schemaVersion` on any changed BullMQ job payloads (ROADMAP R-05); worker defers unrecognized versions

### Documents that MUST be updated in the same change
- `SPECIFICATION.md` — §4 (journal/quarantine/erasure-record tables, suppression-hash columns, dirty-day mechanism), §5 (scrub job, replay sweep, reputation job, reconciler changes), §6 (webhook ingress journal write, delete-contact semantics change), §7 (new watchdog checks) — per the binding rule in `.claude/CLAUDE.md`
- `ARCHITECTURE.md` — CMP-02 day-semantics contract, erasure/evidence model, backfill/replay flow
- `CONVENTIONS.md` — if the hash-based suppression check or journal-first ingress become conventions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **Watchdog stack** (`claimAlertSlot`, API-side checker, `OPERATOR_ALERT_EMAIL`, health rows) — D-08's ingestion alert and D-09/D-10's reputation alerts are the fourth and fifth consumers of a thrice-proven pattern (Phases 9/11/12).
- **`setFactColumnOnce` + counter gates** in the webhook worker — the dedup re-base (CMP-07) must preserve these exactly-once semantics; the fact columns are already idempotent and out-of-order-safe.
- **`analytics-reconciliation.worker.ts`** — CMP-06's recurring job already exists; D-14 extends its coverage rather than building new machinery.
- **Phase 12 sweep pattern** (bounded keyset pages, checkpoint row committed with the page's work, deterministic jobId) — the template for D-03's batched PII scrub and D-06's replay sweep.
- **`packages/queue-core` factory** (Phase 12 D-10) — any new queue (erasure scrub, replay sweep, reputation tick) goes through it, with per-queue retention.
- **`packages/redaction`** — field-pattern vocabulary reusable for identifying PII keys in JSONB scrub (D-03).
- **Phase 8 failure-injection harness** — CMP-01's crash test is a new scenario on the existing seam.
- **Unsubscribe token already carries `sendId`** (HMAC-bound) — CMP-01's route-side send linkage needs no token change.

### Established Patterns
- Versioned constants with rationale comments (windows, thresholds, retention horizons).
- Hand-written SQL migrations for partitioned tables/constraints; expand/contract discipline (the CMP-07 unique-constraint re-base and suppression-hash migration follow it).
- `upsertJobScheduler` with stable scheduler ids for all recurring ticks.
- Absolute-overwrite reconciliation vs additive increments — two write paths that must never be confused (documented in `workspace-daily-rollup.ts`); D-14 extends the overwrite side.
- One audited entry point per capability; cross-tenant discovery only through `withCrossWorkspaceScan`.

### Integration Points
- `apps/api/src/modules/webhooks/` — journal write after signature verification, before enqueue.
- `apps/worker/src/queues/webhook-events.worker.ts` — `occurred_at` bounding, quarantine routing, dedup re-base.
- `apps/worker/src/queues/analytics-reconciliation.worker.ts` — UTC casts, dirty-day sweep.
- `apps/api/src/modules/contacts/` + `packages/contacts-core` — anonymize-in-place delete, hashed suppression check (also used by the send pipeline's pre-send gate in `delivery-core`).
- `packages/db/migrations/` — journal/quarantine/erasure-record tables, suppression hash columns, dedup-constraint migration, dirty-day mechanism.
- `apps/web` — campaign-card/send-log `unknown` count (D-16), anonymized-contact rendering.
- API watchdog module — ingestion-health + reputation checks join the existing checker family.

</code_context>

<specifics>
## Specific Ideas

- **"Numbers mean exactly what they claim"** is the acceptance lens the user applied throughout: dirty-day marking was chosen over "trust the increments" specifically because an unverified band contradicts the phase goal; `unknown` gets an explicit visible count for the same reason.
- **Erasure must not weaken suppression:** the deleted person's address must remain unmailable (hash-compare in the pre-send check) even though no plaintext survives — evidence and suppression both outlive the PII.
- **No paid-API dependency for correctness:** backfill deliberately avoids the Email Activity API (consistent with Phase 11 D-05) — the platform's guarantees ride on its own journal plus SendGrid's documented retry behavior.
- **Mail stops immediately on delete:** the synchronous half of erasure (anonymize + suppress) is the compliance-critical part; the async scrub is evidence hygiene with tracked completion.

</specifics>

<deferred>
## Deferred Ideas

- **Email Activity API opt-in backfill** for tenants whose SendGrid plan includes it — rejected as baseline this phase; could layer on top of the journal later.
- **Automatic send-pausing at the critical complaint threshold** (enforcement, banners, override/unblock flow) — product-policy capability for a later phase; this phase alerts only (D-11).
- **Scheduled purge of anonymized contact rows after a retention horizon** — the "hybrid" erasure variant; anonymize-in-place suffices for CMP-04, purge machinery deferred.
- **Tenant-facing reputation dashboard UI** (complaint/bounce rate charts in the workspace) — Phase 15's frontend/observability work; this phase ships email alerts.

</deferred>

---

*Phase: 13-compliance-analytics-integrity*
*Context gathered: 2026-08-11*
