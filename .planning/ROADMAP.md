# Roadmap: mega-crm

## Overview

Five phases take mega-crm from an empty repo to the anchor use case running for real: settle the remaining scope questions and stand up the person/entity data model (Phase 1); build declarative campaigns whose nightly scan writes idempotent, occurrence-keyed reservations (Phase 2); turn due reservations into SendGrid sends only after fire-time revalidation and every safety rail (Phase 3); close the loop with verified webhook ingestion that records outcomes and auto-feeds suppression (Phase 4); then pass the deliverability/compliance launch gate and run one real campaign end-to-end — scheduled, safety-checked, sent, and its delivery outcome recorded (Phase 5, the milestone success metric).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Scope Decisions & Data Foundations** - Resolve Q3–Q9 and stand up the people/owned-entity data model with upsert dedup and date validation
- [ ] **Phase 2: Campaigns, Triggers & Nightly Scan** - Declarative campaigns whose daily look-ahead scan writes idempotent, occurrence-keyed reservations
- [ ] **Phase 3: Safety-Gated Dispatch** - Due reservations become SendGrid sends only after fire-time revalidation, suppression checks, and volume rails
- [ ] **Phase 4: Delivery Feedback & Suppression** - Verified webhook ingestion records every outcome on the ledger and auto-feeds suppression; erasure workflow
- [ ] **Phase 5: Compliance Gate & First Real Campaign** - Deliverability/compliance launch gate, seed-segment cycle, and the anchor use case end-to-end

## Phase Details

### Phase 1: Scope Decisions & Data Foundations
**Goal**: Remaining scope is settled and the data model exists — people and their dated entities can be loaded, deduplicated, and validated in PostgreSQL
**Depends on**: Nothing (first phase)
**Requirements**: SCOPE-01, DATA-01, DATA-02, DATA-03, DATA-04
**Success Criteria** (what must be TRUE):
  1. All open scope questions (Q3–Q9) are answered and recorded in docs/decisions/mvp-scope-decisions.md
  2. People and their dated entities can be imported into Postgres; re-importing the same email/external key updates the existing row instead of creating a duplicate
  3. A person with several dated entities (e.g., three policies) is stored as one person row and three entity rows, each independently trackable
  4. Malformed or null dates are rejected or flagged at import time, never silently stored
  5. Each person carries a consent status with timestamp and source
**Plans**: TBD

### Phase 2: Campaigns, Triggers & Nightly Scan
**Goal**: An operator can define a date-trigger campaign, activate it with an explicit volume confirmation, and the nightly scan writes correct, idempotent reservations — verifiable without sending a single email
**Depends on**: Phase 1
**Requirements**: TRIG-01, TRIG-02, TRIG-03, CAMP-01, CAMP-02, SCAN-01, SCAN-02, SCAN-03, SCAN-04, SCAN-05, LEDG-01, LEDG-02
**Success Criteria** (what must be TRUE):
  1. Operator can create a campaign whose trigger ("N days before <entity date field>", send hour, once) and audience filter are stored as data, not code
  2. A campaign moves through draft → active → paused → stopped with defined drain behavior; activation shows "this will send to N recipients" and applies the explicit backfill rule — nothing is silently backfilled
  3. After the nightly scan (pinned evaluation timezone, indexed date-range query), each eligible entity has exactly one reservation per occurrence; crashing and rerunning the scan creates no duplicates
  4. Changing an entity's date reschedules it: the stale reservation will not fire and the new date produces a new occurrence, never a duplicate send
  5. Operator can confirm last night's run happened and see how many entities were eligible
**Plans**: TBD

### Phase 3: Safety-Gated Dispatch
**Goal**: Due reservations become real SendGrid sends only after passing every safety check, and a runaway send can always be stopped mid-run
**Depends on**: Phase 2
**Requirements**: LEDG-03, CAMP-03, DISP-01, DISP-02, DISP-03, SUPP-01, SUPP-02, SAFE-01, SAFE-02, SAFE-03, SAFE-04
**Success Criteria** (what must be TRUE):
  1. Dry-run of an active campaign lists exactly who would receive email without sending, and doubles as the pre-launch volume check
  2. Operator can test-send a campaign's email to internal addresses, and non-production environments can never reach real recipients (sandbox mode, per-environment API keys)
  3. Every due reservation is revalidated at fire time — date unchanged, still eligible, campaign active, not in the platform suppression table — before any SendGrid call; suppressed addresses never receive mail
  4. Dispatch goes through SendGrid v3 Mail Send with dynamic templates, batches of ≤1,000 personalizations, and correlation IDs in custom_args
  5. Flipping campaign pause or the global kill switch halts sending mid-run; a run exceeding the volume ceiling (or anomalous vs the trailing average) aborts and alerts, and the per-entity backstop cap blocks repeat sends inside the cap window
**Plans**: TBD

### Phase 4: Delivery Feedback & Suppression
**Goal**: Every send's delivery outcome is recorded durably on the platform's own ledger, and bounces, complaints, and unsubscribes automatically suppress future sends
**Depends on**: Phase 3
**Requirements**: EVNT-01, EVNT-02, EVNT-03, EVNT-04, EVNT-05, SUPP-03
**Success Criteria** (what must be TRUE):
  1. Webhook posts with invalid ECDSA signatures (verified on raw body bytes) are rejected; valid posts get a fast 2xx and are processed asynchronously
  2. Delivery outcomes land on the correct send-ledger row via correlation IDs, and remain correct when events arrive duplicated or out of order
  3. A hard bounce, spam complaint, or unsubscribe automatically creates a suppression entry, and the next dispatch run skips that address
  4. An erasure request purges profile and send-log detail (aggregates kept) and leaves a hashed suppression entry
**Plans**: TBD

### Phase 5: Compliance Gate & First Real Campaign
**Goal**: The deliverability/compliance launch gate is passed and the anchor use case completes for one real campaign — the milestone success metric
**Depends on**: Phase 4
**Requirements**: COMP-01, COMP-02, COMP-03, COMP-04, SAFE-05
**Success Criteria** (what must be TRUE):
  1. SPF, DKIM, and DMARC are verified on the dedicated sending subdomain before any real send goes out
  2. Every outbound email carries RFC 8058 one-click unsubscribe headers, a working unsubscribe honored within 2 days, sender identification, and a physical postal address in the footer
  3. The first production activation runs one full cycle against an internal seed segment before touching the real audience
  4. Complaint/spam rate is monitored against the <0.1% target
  5. One real campaign completes the anchor loop: a date-countdown reminder is scheduled, safety-checked, sent via SendGrid, and its delivery outcome is recorded on the ledger
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Scope Decisions & Data Foundations | 0/TBD | Not started | - |
| 2. Campaigns, Triggers & Nightly Scan | 0/TBD | Not started | - |
| 3. Safety-Gated Dispatch | 0/TBD | Not started | - |
| 4. Delivery Feedback & Suppression | 0/TBD | Not started | - |
| 5. Compliance Gate & First Real Campaign | 0/TBD | Not started | - |

---
*Roadmap created: 2026-07-02 (from ingest of docs/research/crm-platform-research.md)*
*Coverage: 39/39 v1 requirements mapped, 0 orphans*
