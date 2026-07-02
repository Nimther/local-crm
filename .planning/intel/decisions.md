# Decisions Intel

No ADRs in the ingest set. The entries below are PROPOSED decision candidates extracted
from a research-only DOC. None are locked. Per the source's own framing ("No code, no
schemas, no final architecture decisions"), every entry here is a candidate for a formal
ADR, not a binding decision. DOC is the lowest precedence tier — any future ADR, SPEC,
or PRD supersedes these without conflict.

---

## D-01: SendGrid is the sole email provider in v1

- status: PROPOSED (carries an inline `[Decision]` tag in the source, but the source
  is research-only and classified `locked: false` — treated as proposed)
- source: docs/research/crm-platform-research.md (§11)
- scope: email delivery provider
- decision: SendGrid v3 Mail Send is the only provider built, configured, or planned
  into the running v1 system. API key read from environment/secret storage at runtime;
  never hardcoded or committed.
- companion boundary: a single narrow "send this email" seam so a second provider later
  means one more adapter, not a rewrite. Explicitly NOT built: provider registry,
  cross-provider routing, webhook normalization, config-driven provider switching.

## D-02: Daily look-ahead batch scan is the trigger architecture (Pattern A)

- status: PROPOSED
- source: docs/research/crm-platform-research.md (§2, §10, §13)
- scope: trigger evaluation mechanism
- decision: date-countdown sends are implemented as a daily indexed date-range query
  over SQL (the Klaviyo pattern: scan a day ahead, plus a re-evaluation hook on date
  change). No real-time pipeline, no event stream, no queue infrastructure, no
  segmentation engine.

## D-03: Trigger enrolls the tracked entity, not the person

- status: PROPOSED
- source: docs/research/crm-platform-research.md (§4, §8)
- scope: data model — tracked entity
- decision: one thin entity table (person ref, type label, display name, date field,
  unique external key). The trigger enrolls the entity; dedup and frequency caps key
  on entity ID, not person ID. A generic user-defined object system is deferred.
- dependency: gated by open question Q1 (what is the tracked entity, concretely).

## D-04: Platform owns scheduling and the send log (SendGrid cannot)

- status: PROPOSED (forced by confirmed provider limits — see constraints.md C-01, C-02)
- source: docs/research/crm-platform-research.md (§1, §11)
- scope: system-of-record boundaries
- decision: SendGrid `send_at` caps at 72 hours and Email Activity retention is ≤30
  days, so the platform must own both the scheduler and the durable send log.

## D-05: Occurrence-keyed idempotent send ledger, revalidated at fire time

- status: PROPOSED
- source: docs/research/crm-platform-research.md (§5 M4, §10, §14)
- scope: send safety / correctness
- decision: per-recipient reservation rows unique on (campaign, entity, occurrence key
  = target date), claimed transactionally before dispatch, revalidated at fire time
  (date unchanged, still eligible, campaign active, not suppressed). This row is
  deliberately the future journey-instance.

## D-06: Identity shape — immutable internal ID + mutable external identifiers

- status: PROPOSED
- source: docs/research/crm-platform-research.md (§4, §8)
- scope: profile model
- decision: immutable internal ID; email as mutable uniqueness-enforced identifier;
  optional external ID; consent status with timestamp + source; optional timezone.
  Upsert-by-email/external-key dedup on every import path. No anonymous IDs, no
  merge graphs.

## D-07: MVP module boundary (M1–M10 in; §6 defer table out)

- status: PROPOSED
- source: docs/research/crm-platform-research.md (§5, §6)
- scope: v1 scope
- decision: ten MVP modules (see requirements.md); explicitly deferred with build-when
  conditions: event pipeline, segment engine, journey builder, broadcasts, identity
  resolution, multi-channel, reverse-ETL, configurable frequency caps, per-recipient
  timezone sending, RBAC, analytics/A-B testing, outbound webhooks, preference center,
  dedicated IP, multi-provider delivery.

## D-08: Single fixed send hour in business timezone; dates stored as dates

- status: PROPOSED
- source: docs/research/crm-platform-research.md (§6, §14)
- scope: send timing
- decision: fixed sane send hour in the business timezone (HubSpot simplification);
  per-recipient timezone sending deferred. Non-deferrable: pinned evaluation timezone,
  dates stored as dates (not midnight timestamps), day-ahead evaluation.
