# Phase 13: Compliance & Analytics Integrity - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-11
**Phase:** 13-compliance-analytics-integrity
**Areas discussed:** Contact erasure shape (CMP-04), Webhook-downtime backfill (CMP-08), Reputation alerts (CMP-09), Daily metric semantics (CMP-02/03)

---

## Contact erasure shape (CMP-04)

### Q1: What should "deleting a contact" do to the contact row?

| Option | Description | Selected |
|--------|-------------|----------|
| Anonymize in place (Recommended) | Keep the row, scrub email/name/phone/attributes to NULL + mark `anonymized_at`; FKs stay intact so delivery evidence stays linked | ✓ |
| Hard delete + evidence tombstone | Keep today's DELETE, write a separate minimal evidence record | |
| Hybrid: anonymize now, purge later | Anonymize + scheduled purge after retention horizon | |

### Q2: Suppression evidence storage post-erasure

| Option | Description | Selected |
|--------|-------------|----------|
| Hashed email (Recommended) | HMAC/SHA-256 of normalized email; pre-send check compares hashes | |
| Keep plaintext | ICO permits suppression records as legitimate interest; simplest | |
| Hash + last-seen metadata | Hashed email plus reason/date/source as compliance evidence | ✓ |

### Q3: JSONB payloads holding erased contact's PII

| Option | Description | Selected |
|--------|-------------|----------|
| Scrub linked rows (Recommended) | Rewrite send_events.payload / events.properties linked to the contact; keep event type + timestamps | ✓ |
| Leave to partition aging | Document that payloads age out with partition drops | |
| Scrub send_events only | Platform-controlled payloads scrubbed; tenant events stay tenant's responsibility | |

### Q4: Erasure execution shape

| Option | Description | Selected |
|--------|-------------|----------|
| Async job + status (Recommended) | Instant row anonymization, background scrub job, erasure record tracks completion | ✓ |
| Fully synchronous | One request/transaction; statement-timeout risk on large histories | |
| Sync core + fire-and-forget scrub | No completion tracking; weaker compliance story | |

---

## Webhook-downtime backfill (CMP-08)

### Q1: Recovery mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Journal + provider retries (Recommended) | Durable Postgres ingress journal for post-receipt loss; SendGrid ~24h retries cover unreachability; longer outages resolve to honest `unknown` | ✓ |
| Email Activity API pull | Paid add-on under BYO keys, rate-limited — opt-in, partial | |
| Both: journal + opt-in API pull | Most coverage, most machinery | |

### Q2: Replay trigger

| Option | Description | Selected |
|--------|-------------|----------|
| Automatic sweep (Recommended) | Scheduled tick re-enqueues stuck journal rows | |
| Operator-triggered replay | CLI replay on demand, driven by alert | |
| Auto sweep + manual range replay | Automatic self-healing plus operator script for surgical re-runs | ✓ |

### Q3: Journal retention

| Option | Description | Selected |
|--------|-------------|----------|
| Days, pruned (Recommended) | ~7 days versioned constant + pruning job; outlives outage + reconciler windows; small PII surface | ✓ |
| Align with send_events partitions | Monthly partitions; second large PII store the erasure scrub must cover | |
| Until ingestion confirmed | Delete on ingestion; loses manual range-replay capability | |

### Q4: Missing-events detection

| Option | Description | Selected |
|--------|-------------|----------|
| Watchdog alert (Recommended) | Extend existing watchdog + OPERATOR_ALERT_EMAIL for stuck journal rows / silent ingestion | ✓ |
| Journal metrics only | SQL-queryable outcomes, no alert until Phase 15 | |
| You decide | Claude picks during planning | |

---

## Reputation alerts (CMP-09)

### Q1: Alert audience

| Option | Description | Selected |
|--------|-------------|----------|
| Operator + tenant (Recommended) | Operator watchdog email + tenant workspace members via platform email | ✓ |
| Operator only this phase | Tenant-facing notification deferred to Phase 15 | |
| Tenant only | No operator noise; platform-wide patterns go unnoticed | |

### Q2: Metric computation

| Option | Description | Selected |
|--------|-------------|----------|
| Rolling window, 2 tiers (Recommended) | spam_reports/delivered over ~7-day rolling window; warn ~0.1%, critical ~0.3% (Gmail/Yahoo lines) | ✓ |
| Daily rate from rollups | Cheapest but noisy on low volume | |
| You decide | Claude picks computation shape | |

### Q3: Consequence at critical threshold

| Option | Description | Selected |
|--------|-------------|----------|
| Alert only this phase (Recommended) | No automatic enforcement; auto-pause deferred as product-policy capability | ✓ |
| Critical tier pauses sending | Auto-pause broadcast dispatch until operator clears | |
| Critical pauses everything | Full send stop including triggered flows | |

### Q4: Tracked signals

| Option | Description | Selected |
|--------|-------------|----------|
| Complaints + hard bounces (Recommended) | Same job, one more ratio; bounce >2% is the other provider penalty line | ✓ |
| Complaints only | Strictly CMP-09's letter | |
| You decide | Based on implementation cost | |

---

## Daily metric semantics (CMP-02/03)

### Q1: Field defining "day of send" for sent_count

| Option | Description | Selected |
|--------|-------------|----------|
| sent_at — acceptance (Recommended) | Day SendGrid accepted; current reconciler behavior made explicit + UTC-cast | ✓ |
| dispatched_at — attempt | Day the platform made the API call | |
| You decide | Claude picks and documents | |

### Q2: Late-event reconciliation coverage

| Option | Description | Selected |
|--------|-------------|----------|
| Dirty-day marking (Recommended) | Events outside the 2-day window mark (workspace, day) dirty; tick sweeps dirty days too | ✓ |
| Widen window to CMP-05 bound | One constant, but every tick rescans 7 days × all workspaces | |
| Keep 2 days, trust increments | Documented unverified band | |

### Q3: CMP-05 occurred_at acceptance window

| Option | Description | Selected |
|--------|-------------|----------|
| ~7 days past, minutes future (Recommended) | Covers SendGrid retries + deferral cycle with margin; rest quarantined | ✓ |
| ~30 days past | Forgiving but lets old timestamps shift month-old numbers | |
| You decide | Tight-but-safe bounds citing SendGrid docs | |

### Q4: `unknown` sends in campaign stats (deferred from Phase 11 D-13)

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit unknown count (Recommended) | Own count/label next to sent/failed on campaign cards and send log | ✓ |
| Footnote only | Tooltip explanation, softer visual | |
| Keep excluded + docs | No UI change until Phase 15 | |

---

## Claude's Discretion

- CMP-07 fallback dedup key composition and unique-constraint migration path
- CMP-01 transaction shape (route vs webhook path convergence); crash test mandatory
- Quarantine mechanism shape, retention, operator visibility
- Journal schema/granularity; ingestion-complete marking; write placement after signature verification
- Anonymization details: hash input normalization, HMAC key handling, erasure-record schema, scrub batch sizes, unique-constraint handling
- Reputation job cadence, alert cooldown, minimum-volume floor, window mechanics
- Dirty-day marking mechanism and sweep bounds
- Where the CMP-02 day-semantics contract is documented

## Deferred Ideas

- Email Activity API opt-in backfill for tenants whose plan includes it
- Automatic send-pausing enforcement at critical complaint threshold (banners, override/unblock flow)
- Scheduled purge of anonymized contact rows after a retention horizon
- Tenant-facing reputation dashboard UI (Phase 15)
