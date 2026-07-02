# Requirements Intel

No PRDs in the ingest set. The entries below are requirement CANDIDATES derived from
the MVP module table (§5) of a research-only DOC. Acceptance criteria are drawn from
the source's stated mechanics and safety invariants; they are candidates, not committed
criteria. DOC precedence — any future PRD supersedes without conflict.

Anchor use case (all requirements trace to it): "When a tracked entity approaches a
known future date, send an email reminder before that date."

---

## REQ-profile-entity-store (M1)

- source: docs/research/crm-platform-research.md (§5 M1, §8)
- description: People (immutable ID, unique email, external ID, consent state,
  optional timezone) and tracked entities (person ref, type label, date field, unique
  external key) in the existing SQL DB.
- acceptance candidates:
  - Upsert-by-email/external-key dedup on all import paths (two rows for one human
    means two reminders)
  - Date attributes validated for format and null (bad format = trigger silently
    never fires)
  - Consent recorded with timestamp + source

## REQ-trigger-definition (M2)

- source: docs/research/crm-platform-research.md (§5 M2, §9, §10)
- description: A stored, declarative trigger: date field × offset (N days before) ×
  send time-of-day × recurrence (once; yearly later), modeled as one variant of the
  five-way trigger union (event | segment-entry | date | API | schedule).
- acceptance candidates:
  - Trigger stored as data, not hard-coded per campaign (risk R7, the cron-script trap)
  - "N days before date" expressed natively (no user-composed window arithmetic)
  - Audience filter is a stored, reusable declarative predicate on the campaign

## REQ-eligibility-evaluator (M3)

- source: docs/research/crm-platform-research.md (§5 M3, §10, §13)
- description: Daily look-ahead scan finding entities whose (date − offset) falls in
  the next window, applying the audience filter, writing reservations; plus a
  re-evaluation hook on date change.
- acceptance candidates:
  - Runs day-ahead against a pinned evaluation timezone
  - Index on the date column (the one must-have scalability item)
  - Observable: did last night's run happen; how many were eligible
  - Activation backfill behavior explicitly chosen (open question Q5)

## REQ-send-ledger (M4)

- source: docs/research/crm-platform-research.md (§5 M4, §10, §14)
- description: Per-recipient reservation rows with a uniqueness guarantee on
  (campaign, entity, occurrence key = target date), claimed transactionally before
  dispatch, revalidated at fire time.
- acceptance candidates:
  - Crash-and-rerun cannot double-send
  - A moved date creates a new occurrence, never a duplicate
  - Fire-time revalidation: date unchanged, still eligible, campaign active,
    not suppressed

## REQ-dispatcher (M5)

- source: docs/research/crm-platform-research.md (§5 M5, §11)
- description: Loop over due reservations → SendGrid v3 Mail Send with dynamic
  templates, batched personalizations (≤1,000/request), correlation IDs in custom_args.
- acceptance candidates:
  - Checks pause flag, suppression, and volume circuit breaker per run
  - Dispatch is rate-limited enough that the kill switch is usable mid-run
  - Sandbox mode / per-environment API keys in non-prod

## REQ-delivery-event-ingestion (M6)

- source: docs/research/crm-platform-research.md (§5 M6, §12)
- description: SendGrid Event Webhook endpoint feeding the send ledger and the
  suppression table.
- acceptance candidates:
  - ECDSA signature verified on raw body bytes; unverified posts rejected
  - Replies 2xx fast; processes asynchronously
  - Dedups on sg_event_id with a secondary key on (message ID, event type, timestamp)
  - Status updates order-insensitive (monotonic ranking or event-append, never
    blind overwrite)
  - Bounce/complaint/unsubscribe auto-feed suppression

## REQ-suppression-consent (M7)

- source: docs/research/crm-platform-research.md (§5 M7, §15)
- description: One platform-owned suppression table: address (or person ref), reason
  (unsubscribe, hard bounce, complaint, erasure), timestamp, source.
- acceptance candidates:
  - Checked at dispatch time, independent of targeting
  - Erasure requests convert to hashed suppression entries; profile and send-log
    detail purged (aggregates kept); honored within one month
  - Platform copy is authoritative (provider suppression is not portable)

## REQ-campaign-lifecycle (M8)

- source: docs/research/crm-platform-research.md (§5 M8, §10)
- description: Campaign state machine draft → active → (paused/stopping) → stopped,
  with defined drain semantics for in-flight reservations.
- acceptance candidates:
  - Activation gated by "this will send to N people" confirmation
  - Pause flag and global sending-enabled flag checked immediately before each dispatch
  - Drain semantics for in-flight reservations explicitly defined

## REQ-safety-rails (M9)

- source: docs/research/crm-platform-research.md (§5 M9, §14, §16)
- description: Dry-run, test-send to internal addresses, per-run volume ceiling with
  abort-and-alert, per-entity backstop cap, sandbox mode + per-environment keys.
- acceptance candidates:
  - Dry-run produces "would send to N: list" and doubles as pre-launch volume check
  - Circuit breaker: hard per-run ceiling plus anomaly check vs. trailing average
  - Per-entity-per-campaign backstop cap (e.g., max one send per 30 days)
  - First production activation gated to an internal seed segment for one cycle

## REQ-compliance-deliverability (M10)

- source: docs/research/crm-platform-research.md (§5 M10, §11, §15)
- description: SPF/DKIM/DMARC on a sending subdomain, RFC 8058 one-click unsubscribe,
  physical address in footer, unsubscribe honored ≤2 days, spam-rate monitoring.
- acceptance candidates:
  - All items in place before the first real send (launch gate)
  - Full commercial CAN-SPAM bar met regardless of transactional/marketing
    classification (safe posture pending open question Q2)
  - Complaint rate monitored, target <0.1%
