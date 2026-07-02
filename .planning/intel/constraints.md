# Constraints Intel

No SPECs in the ingest set. The entries below are hard external constraints (provider
limits, protocol behaviors, regulatory rules) extracted from a research-only DOC. The
source labels these [Confirmed] against vendor/regulator documentation. Unlike the
DOC's recommendations, these are facts about external systems, not proposals — but
provenance is still DOC-tier; verify anything load-bearing during design (see R9 note
in context.md for the two medium-confidence Customer.io claims).

---

## C-01: SendGrid scheduled send horizon is 72 hours

- type: api-contract
- source: docs/research/crm-platform-research.md (§11)
- content: "A send cannot be scheduled more than 72 hours in advance." SendGrid cannot
  be the scheduler for date-countdown sends. `send_at` + `batch_id` usable only as
  short-horizon smoothing/cancellation (cancel ≥10 min before send; max 10
  paused/cancelled batches).

## C-02: SendGrid Email Activity retention ≤30 days

- type: api-contract
- source: docs/research/crm-platform-research.md (§11)
- content: ~3–7 days default, 30 days max with paid add-on. SendGrid is not a system
  of record; the platform's own send log is mandatory.

## C-03: Mail Send batching and correlation limits

- type: api-contract
- source: docs/research/crm-platform-research.md (§11)
- content: up to 1,000 personalizations per Mail Send request; dynamic templates are
  `d-` prefixed Handlebars (documented helper subset only); `custom_args` ≤10 KB,
  echoed verbatim on webhook events (the correlation mechanism); categories ≤10 per
  message and explicitly not for tracking individual sends.

## C-04: Event Webhook delivery semantics

- type: protocol
- source: docs/research/crm-platform-research.md (§12)
- content: batched POSTs (~30s or 768 KB, per server — concurrent under load);
  non-2xx retried over a rolling 24 hours; at-least-once delivery (dedup on
  sg_event_id necessary but possibly insufficient — retries may carry different event
  IDs per community reports); no ordering guarantee (delivered may precede processed);
  signature is ECDSA over timestamp + raw body bytes (re-serialized JSON breaks
  verification).

## C-05: SendGrid suppression division of labor

- type: api-contract
- source: docs/research/crm-platform-research.md (§12)
- content: SendGrid auto-drops sends to bounced/spam-reporting/unsubscribed addresses
  (dropped events still consume plan credits); blocks are not ongoing suppressions;
  provider suppression state is not portable across ESPs.

## C-06: Gmail/Yahoo bulk-sender requirements

- type: nfr (deliverability/compliance)
- source: docs/research/crm-platform-research.md (§11, §15)
- content: senders of 5,000+/day to Gmail need SPF+DKIM+DMARC, RFC 8058 one-click
  unsubscribe, unsubscribes honored ≤2 days, complaint rate <0.3% (target <0.1%).
  Enforcement escalated to permanent rejection in late 2025. Implement from day one
  even below threshold.

## C-07: CAN-SPAM (US)

- type: nfr (legal)
- source: docs/research/crm-platform-research.md (§15)
- content: accurate headers, truthful subject, physical postal address in every
  commercial message, working opt-out honored ≤10 business days, opt-out link live
  ≥30 days post-send; penalties per email (~$53k). Reminder emails sit in an ambiguous
  transactional/commercial zone — safe posture is the full commercial bar.

## C-08: GDPR/PECR (if EU/UK recipients)

- type: nfr (legal)
- source: docs/research/crm-platform-research.md (§15)
- content: email marketing to individuals requires consent; legitimate interest is not
  a PECR substitute. Soft opt-in exception may cover customer-relationship reminders.
  Schema implication: per-profile consent status + timestamp + source (burden of proof
  on sender). Erasure: purge profile and send-log detail, keep aggregates, insert
  hashed address into suppression; honor within one month.

## C-09: CASL (if Canadian recipients)

- type: nfr (legal)
- source: docs/research/crm-platform-research.md (§15)
- content: express or implied consent (implied generally expires 2 years from
  purchase), sender identification + unsubscribe in every message, consent burden on
  sender.

## C-10: IP and volume posture

- type: nfr (deliverability)
- source: docs/research/crm-platform-research.md (§11)
- content: shared IP is correct below ~50k emails/month (SendGrid guidance); dedicated
  IP + warm-up deferred until sustained volume crosses that line; ramp gradually on a
  new sending subdomain.

## C-11: Scale envelope for the daily scan

- type: nfr (performance; [Inference]-labeled in source, moderate confidence)
- source: docs/research/crm-platform-research.md (§13)
- content: nightly indexed date-range query is a non-issue under 1M profiles; consider
  partitioning around 10M; scan is never the bottleneck before ~100M rows — dispatch
  throughput and safety checks bind first; nothing binds below ~100k sends/day.
  Must-have: index on the date column.
