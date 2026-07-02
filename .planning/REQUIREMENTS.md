# Requirements: mega-crm

**Defined:** 2026-07-02
**Core Value:** A reminder tied to a real future date goes out on time, exactly once, only to eligible non-suppressed recipients — and an accidental mass send is structurally impossible.

Provenance: derived from `.planning/intel/requirements.md` (MVP modules M1–M10 of `docs/research/crm-platform-research.md`) plus owner answers to Q1/Q2 on 2026-07-02. Module map: M1→DATA, M2→TRIG, M3→SCAN, M4→LEDG, M5→DISP, M6→EVNT, M7→SUPP, M8→CAMP, M9→SAFE, M10→COMP.

## v1 Requirements

Requirements for the first milestone. Each maps to exactly one roadmap phase.

### Scope

- [ ] **SCOPE-01**: Open scope questions Q3–Q9 are resolved and recorded in `docs/decisions/mvp-scope-decisions.md` before deep design of the affected modules

### Data Model (M1)

- [ ] **DATA-01**: Person records have an immutable internal ID, a unique (mutable) email, an optional external ID, consent status with timestamp and source, and an optional timezone
- [ ] **DATA-02**: Tracked entities live in their own table (person reference, type label, display name, date field, unique external key); one person can own many entities
- [ ] **DATA-03**: Every import path upserts by email/external key so one human never becomes two rows (two rows means two reminders)
- [ ] **DATA-04**: Date attributes are validated for format and null at write time; bad dates are rejected or flagged, never silently stored

### Triggers (M2)

- [ ] **TRIG-01**: Triggers are stored as declarative data — date field × offset (N days before) × send time-of-day × recurrence (once) — never hard-coded per campaign
- [ ] **TRIG-02**: "N days before date" is expressible natively in the trigger model (no user-composed window arithmetic)
- [ ] **TRIG-03**: The campaign audience filter is a stored, reusable declarative predicate

### Campaign Lifecycle (M8)

- [ ] **CAMP-01**: Campaigns follow the state machine draft → active → (paused/stopping) → stopped, with defined drain semantics for in-flight reservations
- [ ] **CAMP-02**: Activation is gated by a "this will send to N recipients" confirmation
- [ ] **CAMP-03**: The pause flag and the global sending-enabled flag are checked immediately before each dispatch

### Eligibility Scan (M3)

- [ ] **SCAN-01**: A daily look-ahead scan finds entities whose (date − offset) falls in the coming window, via an indexed date-range query evaluated in a pinned timezone
- [ ] **SCAN-02**: The scan applies the campaign's audience filter and writes reservations for eligible entities
- [ ] **SCAN-03**: A date-change re-evaluation hook cancels/reschedules pending reservations when an entity's date changes
- [ ] **SCAN-04**: Activation backfill behavior is an explicit, enforced rule (per Q5 decision); dates already inside the window at go-live are never silently backfilled
- [ ] **SCAN-05**: The scan is observable: the operator can confirm last night's run happened and how many entities were eligible

### Send Ledger (M4)

- [ ] **LEDG-01**: Reservation rows are unique on (campaign, entity, occurrence key = target date); crash-and-rerun cannot double-send
- [ ] **LEDG-02**: A moved date creates a new occurrence, never a duplicate of the old one
- [ ] **LEDG-03**: Every reservation is revalidated at fire time — date unchanged, still eligible, campaign active, not suppressed — before dispatch

### Dispatcher (M5)

- [ ] **DISP-01**: Due reservations are dispatched via SendGrid v3 Mail Send with dynamic templates, batched personalizations (≤1,000/request), and correlation IDs in `custom_args`
- [ ] **DISP-02**: The dispatcher checks the pause flag, suppression, and the volume circuit breaker every run, and is rate-limited enough that the kill switch is usable mid-run
- [ ] **DISP-03**: Non-production environments use sandbox mode and per-environment API keys; keys come from environment/secret storage, never source

### Delivery Events (M6)

- [ ] **EVNT-01**: The webhook endpoint verifies the ECDSA signature over the raw body bytes and rejects unverified posts
- [ ] **EVNT-02**: The endpoint replies 2xx fast and processes event batches asynchronously
- [ ] **EVNT-03**: Events are deduped on sg_event_id with a secondary key on (message ID, event type, timestamp); status updates are order-insensitive (monotonic ranking or event-append, never blind overwrite)
- [ ] **EVNT-04**: Delivery outcomes are recorded durably on the platform send ledger — the system of record (SendGrid retention is ≤30 days)
- [ ] **EVNT-05**: Bounce, complaint, and unsubscribe events automatically feed the suppression table

### Suppression & Consent (M7)

- [ ] **SUPP-01**: A platform-owned, authoritative suppression table exists: address (or person ref), reason (unsubscribe, hard bounce, complaint, erasure), timestamp, source
- [ ] **SUPP-02**: Suppression is checked at dispatch time, independent of audience targeting
- [ ] **SUPP-03**: Erasure requests purge profile and send-log detail (aggregates kept), convert to hashed suppression entries, and are honored within one month

### Safety Rails (M9)

- [ ] **SAFE-01**: Dry-run produces "would send to N: [list]" without sending, and doubles as the pre-launch volume check
- [ ] **SAFE-02**: The operator can test-send any campaign's email to internal addresses
- [ ] **SAFE-03**: A volume circuit breaker enforces a hard per-run ceiling plus an anomaly check against the trailing average, aborting and alerting on breach
- [ ] **SAFE-04**: A per-entity-per-campaign backstop cap (e.g., max one send per 30 days) blocks runaway repeats
- [ ] **SAFE-05**: The first production activation is gated to an internal seed segment for one full cycle

### Compliance & Deliverability (M10)

- [ ] **COMP-01**: SPF, DKIM, and DMARC are configured and verified on a dedicated sending subdomain before the first real send (launch gate)
- [ ] **COMP-02**: Every email carries RFC 8058 one-click unsubscribe headers and a working unsubscribe honored within 2 days
- [ ] **COMP-03**: Every email meets the full CAN-SPAM commercial bar — truthful headers and subject, sender identification, physical postal address in the footer — regardless of transactional classification (safe posture per Q2)
- [ ] **COMP-04**: Complaint/spam rate is monitored against the <0.1% target (<0.3% hard limit)

## v2 Requirements

Deferred with explicit build-when conditions (source §6). Not in the current roadmap.

### Triggers & Recurrence

- **RECUR-01**: Yearly recurrence with month-end clamping — pending Q4; may be pulled into v1 by the Phase 1 scope decisions (roadmap update required if so)
- **EVTP-01**: Event pipeline / behavioral triggers — build when the first behavioral trigger is demanded

### Audience & Journeys

- **SEGM-01**: Segment engine — build when reusable audiences span campaigns
- **JOUR-01**: Journey builder — build when a validated multi-step branching need exists (the reservation row is deliberately the future journey-instance)
- **BCAST-01**: Broadcasts (one-to-many announcements) — build when required

### Sending & Operations

- **TZ-01**: Per-recipient timezone sending — build when the audience is meaningfully multi-timezone
- **FREQ-01**: Configurable frequency-cap engine — build when multiple competing campaign types exist
- **PREF-01**: Preference center — build when a second message category exists
- **PROV-01**: Second delivery-provider adapter — build when a concrete second provider is actually required
- **RBAC-01**: Role-based access control — build when non-builder operators exist
- **ANLT-01**: Analytics / A-B testing — build when optimization becomes the bottleneck
- **WHOOK-01**: Outbound webhooks — build when external consumers exist
- **DIP-01**: Dedicated IP + warm-up — at ~50k emails/month sustained

## Out of Scope

Explicitly excluded. Documented to prevent scope creep (risk R8).

| Feature | Reason |
|---------|--------|
| CDP / syncing whole CRM objects into the pipeline | Data minimization — the send path needs only email, date, timezone, consent state |
| Event stream / queue infrastructure in v1 | Daily indexed date-range scan suffices (D-02); no behavioral triggers in v1 |
| Segment engine in v1 | Audience filter is a stored per-campaign predicate; no cross-campaign reuse yet |
| Journey canvas in v1 | One-step reminders only |
| Speculative events table | An events table without a consumer is dead weight (§7) |
| Identity resolution / anonymous IDs / merge graphs | No anonymous tracking in the product (D-06) |
| Person-level scalar date attributes | Break at cardinality > 1; Q1 answer is the owned-entity table (D-03) |
| Provider registry / cross-provider routing / webhook normalization | D-01 companion boundary — one narrow send seam is enough |

## Traceability

Which phases cover which requirements. Updated during roadmap creation (2026-07-02).

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCOPE-01 | Phase 1 | Pending |
| DATA-01 | Phase 1 | Pending |
| DATA-02 | Phase 1 | Pending |
| DATA-03 | Phase 1 | Pending |
| DATA-04 | Phase 1 | Pending |
| TRIG-01 | Phase 2 | Pending |
| TRIG-02 | Phase 2 | Pending |
| TRIG-03 | Phase 2 | Pending |
| CAMP-01 | Phase 2 | Pending |
| CAMP-02 | Phase 2 | Pending |
| SCAN-01 | Phase 2 | Pending |
| SCAN-02 | Phase 2 | Pending |
| SCAN-03 | Phase 2 | Pending |
| SCAN-04 | Phase 2 | Pending |
| SCAN-05 | Phase 2 | Pending |
| LEDG-01 | Phase 2 | Pending |
| LEDG-02 | Phase 2 | Pending |
| LEDG-03 | Phase 3 | Pending |
| CAMP-03 | Phase 3 | Pending |
| DISP-01 | Phase 3 | Pending |
| DISP-02 | Phase 3 | Pending |
| DISP-03 | Phase 3 | Pending |
| SUPP-01 | Phase 3 | Pending |
| SUPP-02 | Phase 3 | Pending |
| SAFE-01 | Phase 3 | Pending |
| SAFE-02 | Phase 3 | Pending |
| SAFE-03 | Phase 3 | Pending |
| SAFE-04 | Phase 3 | Pending |
| EVNT-01 | Phase 4 | Pending |
| EVNT-02 | Phase 4 | Pending |
| EVNT-03 | Phase 4 | Pending |
| EVNT-04 | Phase 4 | Pending |
| EVNT-05 | Phase 4 | Pending |
| SUPP-03 | Phase 4 | Pending |
| COMP-01 | Phase 5 | Pending |
| COMP-02 | Phase 5 | Pending |
| COMP-03 | Phase 5 | Pending |
| COMP-04 | Phase 5 | Pending |
| SAFE-05 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 39 total
- Mapped to phases: 39
- Unmapped: 0 ✓

---
*Requirements defined: 2026-07-02*
*Last updated: 2026-07-02 after roadmap creation*
