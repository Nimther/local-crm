# mega-crm

## What This Is

mega-crm is a thin, safety-hardened date-countdown email reminder platform: it watches dated entities owned by people (policy/subscription/contract-style — the entity has the date, not the person), and sends a reminder email N days before each entity's date via SendGrid, recording every delivery outcome durably in PostgreSQL. It is explicitly NOT a CDP, event pipeline, segment engine, or journey builder — it is a scheduler over Postgres plus a SendGrid webhook listener, built for a solo operator.

## Core Value

A reminder tied to a real future date goes out on time, exactly once, only to eligible non-suppressed recipients — and an accidental mass send is structurally impossible.

## Requirements

### Validated

(None yet — ship to validate)

### Active

Full checkable list with acceptance criteria: `.planning/REQUIREMENTS.md` (39 v1 requirements). Module-level view (maps 1:1 to source MVP modules M1–M10 plus the scope-decisions artifact):

- [ ] Scope decisions: remaining open questions Q3–Q9 resolved in `docs/decisions/mvp-scope-decisions.md` (SCOPE)
- [ ] Profile + tracked-entity store with upsert dedup and date validation (DATA, M1)
- [ ] Declarative date triggers: date field × offset × send hour × recurrence, stored as data (TRIG, M2)
- [ ] Daily look-ahead eligibility scan with date-change re-evaluation (SCAN, M3)
- [ ] Occurrence-keyed idempotent send ledger, revalidated at fire time (LEDG, M4)
- [ ] SendGrid dispatcher with batching, correlation IDs, and per-run safety checks (DISP, M5)
- [ ] Verified webhook ingestion of delivery events into the ledger (EVNT, M6)
- [ ] Platform-owned suppression + consent/erasure handling (SUPP, M7)
- [ ] Campaign lifecycle state machine with drain semantics (CAMP, M8)
- [ ] Safety rails: dry-run, test-send, circuit breaker, backstop cap, seed-segment gate (SAFE, M9)
- [ ] Compliance & deliverability launch gate: SPF/DKIM/DMARC, RFC 8058, CAN-SPAM bar (COMP, M10)

### Out of Scope

Per the source's Critic guidance and deferral table (§6) — every re-add must cite its build-when condition:

- CDP / syncing whole CRM objects into the pipeline — data minimization; the send path needs only email, date, timezone, consent
- Event pipeline / event stream / queue infrastructure — no behavioral triggers in v1; the daily indexed scan suffices (build when the first behavioral trigger is demanded)
- Segment engine — audience filter is a stored per-campaign predicate (build when reusable audiences span campaigns)
- Journey builder / canvas — one-step reminders only; the reservation row is deliberately the future journey-instance (build when validated multi-step branching need)
- Speculative events table — an events table without a consumer is dead weight (§7)
- Identity resolution / anonymous IDs / merge graphs — no anonymous tracking in the product
- Person-level scalar date attributes — break at cardinality > 1; Q1 answer is the entity table
- Broadcasts, multi-channel, reverse-ETL, configurable frequency caps, per-recipient timezone sending, RBAC, analytics/A-B, outbound webhooks, preference center, dedicated IP, multi-provider delivery — each deferred with an explicit build-when condition (see REQUIREMENTS.md v2)

## Context

- Source research: `docs/research/crm-platform-research.md` (study of 8 CRM/marketing-automation tools; ingested 2026-07-02, intel in `.planning/intel/`)
- **Three correctness invariants** (non-negotiable, from §10): (1) re-verify date, eligibility, suppression, and campaign state immediately before send — reservations are soft; (2) dedup on (campaign, entity, occurrence key = matched date); (3) no silent activation backfill — an explicit rule for dates already in the window at go-live
- **Top risks** (§16): R1 accidental mass send (HBO Max incident happened on SendGrid) → safety rails; R2 double-sends from date edits/reruns → occurrence-keyed ledger; R3 timezone/DST off-by-one → dates as dates, pinned evaluation timezone; R7 the cron-script trap → triggers stored as declarative data; R8 scope creep toward reference tools → deferral table discipline
- **R9 caveat:** two load-bearing Customer.io claims (late-attribute cutoff; monthly clamping) are medium-confidence search-snippet extracts — re-verify during design if they influence decisions
- **First milestone success metric (developer-facing, owner-stated):** the anchor use case end-to-end — a date-countdown reminder email is scheduled, safety-checked, sent via SendGrid, and its delivery outcome recorded, for one real campaign

## Constraints

- **Tech stack**: Node.js + TypeScript + PostgreSQL; SendGrid (existing account) for email — owner-confirmed 2026-07-02
- **Provider (C-01, C-02)**: SendGrid `send_at` caps at 72h and Email Activity retention ≤30 days — the platform MUST own the scheduler and the durable send log
- **API contract (C-03)**: ≤1,000 personalizations per Mail Send request; `custom_args` ≤10 KB is the correlation mechanism; categories are not per-send tracking
- **Protocol (C-04)**: Event Webhook is batched, at-least-once, unordered; ECDSA signature over timestamp + raw body bytes (re-serialized JSON breaks verification)
- **Suppression (C-05)**: provider suppression is not portable — the platform copy is authoritative
- **Compliance (C-06, C-07)**: Gmail/Yahoo bulk-sender rules implemented from day one (SPF/DKIM/DMARC, RFC 8058 one-click unsubscribe, unsubscribe honored ≤2 days, complaint <0.3% hard / <0.1% target); full CAN-SPAM commercial bar regardless of transactional classification
- **Compliance, conditional (C-08, C-09)**: GDPR/PECR and CASL obligations activate per audience geography — gated on open question Q3
- **Deliverability (C-10)**: shared IP below ~50k emails/month; ramp gradually on a new sending subdomain
- **Performance (C-11)**: index on the date column is the one must-have; nightly scan is a non-issue below 1M profiles

## Key Decisions

All locked 2026-07-02. Provenance: research-proposed (D-01–D-08 in `.planning/intel/decisions.md`), owner-confirmed in the 2026-07-02 initialization session (stack, Q1, Q2 answered directly by product owner).

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stack: Node.js + TypeScript + PostgreSQL + SendGrid (existing account) | Owner-confirmed; matches the source's SQL + transactional-SendGrid baseline | — Pending |
| SendGrid is the sole v1 email provider, behind one narrow "send this email" seam (D-01) | Second provider later = one adapter, not a rewrite; no provider registry/routing/normalization | — Pending |
| Daily look-ahead batch scan is the trigger architecture — Pattern A (D-02) | Klaviyo pattern degenerates to a daily indexed date-range query on SQL; no event stream, queue, or segment engine needed | — Pending |
| Tracked entity = OWNED ENTITY with its own date, in an entity table; the trigger enrolls the entity, not the person (D-03 + Q1 owner answer) | Person-level scalar dates break at cardinality > 1; a person with three policies gets three reminders; dedup and caps key on entity ID | — Pending |
| Platform owns scheduling and the durable send log (D-04) | Forced by C-01 (72h `send_at` ceiling) and C-02 (≤30-day activity retention) | — Pending |
| Occurrence-keyed idempotent send ledger, revalidated at fire time (D-05) | Unique on (campaign, entity, occurrence key = target date); crash-and-rerun safe; row is the future journey-instance | — Pending |
| Identity: immutable internal ID + mutable unique email + optional external ID; upsert-by-email/external-key on every import path (D-06) | Two rows for one human means two reminders; no anonymous IDs or merge graphs | — Pending |
| v1 scope = MVP modules M1–M10; §6 deferral table out (D-07) | Every scope addition must cite its build-when condition | — Pending |
| Single fixed send hour in business timezone; dates stored as dates; pinned evaluation timezone; day-ahead evaluation (D-08) | HubSpot simplification; kills the timezone/DST off-by-one-day risk class | — Pending |
| Consent posture: TRANSACTIONAL service/relationship reminders (Q2 owner answer) | No marketing opt-in gate required, BUT suppression for unsubscribes/bounces/complaints fully honored, RFC 8058 one-click unsubscribe headers per Gmail/Yahoo rules, and the full CAN-SPAM commercial bar met as safe posture | — Pending |

## Open Questions

Q1 and Q2 are resolved (see Key Decisions). Q3–Q9 remain open and are resolved by **Phase 1** in `docs/decisions/mvp-scope-decisions.md`:

- **Q3** — Audience geography: which of CAN-SPAM / GDPR+PECR / CASL are launch-blocking?
- **Q4** — Recurrence: one-shot only, or yearly (occurrence-key subtleties, month-end clamping)?
- **Q5** — Activation backfill rule: dates already inside the window at go-live — send next cycle (HubSpot) or skip (Klaviyo)?
- **Q6** — Who operates this: config UI depth; when RBAC stops being deferrable
- **Q7** — Single- vs multi-tenant
- **Q8** — Expected volume and timezone spread (shared-IP posture, Gmail 5k/day threshold)
- **Q9** — Where date changes come from (sizes the re-trigger guard and anomaly detector)

---
*Last updated: 2026-07-02 after project initialization from ingest (docs/research/crm-platform-research.md)*
