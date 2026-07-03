# Roadmap: Mega CRM — B2C Marketing Automation Platform

## Overview

Mega CRM is a Klaviyo-class, multi-tenant email marketing automation platform delivered on SendGrid (BYO key per tenant). The journey builds outward from an isolated, secure workspace: first a marketer gets an account, team, and connected sending account (Phase 1); then a living contact base fed by UI, CSV, and a server-side event API (Phase 2); then dynamic profile-and-behavior segments powered by one shared evaluation engine (Phase 3). With an audience in place, the platform delivers its first complete send loop — reliable, throttled, idempotent, suppression-aware broadcast campaigns through SendGrid (Phase 4) — and then closes that loop with deduplicated delivery tracking and automatic suppression from webhooks (Phase 5). On the proven send pipeline, the signature canvas flow builder layers automated triggered chains with versioning, quiet hours, and frequency capping (Phase 6). Finally, end-to-end analytics make the platform's reliability visible: campaign, flow-step, contact-timeline, dashboard, and per-message observability (Phase 7).

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Workspace Foundation & Team Access** - Multi-tenant workspaces, team invites, roles, and a validated encrypted SendGrid key
- [ ] **Phase 2: Contacts & Event Ingestion** - Contact base via UI/CSV/API plus an async server-side event stream that upserts contacts
- [ ] **Phase 3: Segmentation Engine** - Dynamic profile + behavioral segments with live preview, on one shared evaluation engine
- [ ] **Phase 4: Broadcast Campaigns & Send Pipeline** - First complete send loop: throttled, idempotent, suppression-aware broadcasts via SendGrid
- [ ] **Phase 5: Webhook Processing & Delivery Tracking** - Verified, deduplicated delivery events that update message status and auto-suppress contacts
- [ ] **Phase 6: Flows (Triggered Chains)** - Visual canvas builder and versioned execution engine for automated triggered chains
- [ ] **Phase 7: Analytics, Dashboard & Send Log** - End-to-end observability: campaign, flow-step, contact-timeline, dashboard, and per-message metrics

## Phase Details

### Phase 1: Workspace Foundation & Team Access

**Goal**: A marketer can create a workspace, bring their team in with the right permissions, and connect their SendGrid account — with every workspace's data fully isolated from day one.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: TENANT-01, TENANT-02, TENANT-03, TENANT-04, TENANT-05
**Success Criteria** (what must be TRUE):

  1. A new user can register and create a workspace, becoming its Owner.
  2. An Owner/Admin can invite a colleague by email who then joins the workspace with an assigned role (Owner/Admin/Member).
  3. A Member is blocked from changing the SendGrid key and from launching campaigns/flows, while Owner/Admin can do both.
  4. A user can paste a SendGrid API key and see it validated on connect (accepted if valid, rejected with a clear error if not); the stored key is encrypted at rest.
  5. A user in one workspace cannot see or access any contact, event, campaign, or statistic belonging to another workspace.

**Plans**: 2/5 plans executed
**UI hint**: yes

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Walking-skeleton backend: monorepo scaffold + Drizzle/RLS schema + better-auth org backbone + tenant context + register→create-workspace→Owner API + migration (TENANT-01, TENANT-05)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Walking-skeleton UI: register/login, create-workspace onboarding, app shell + workspace switcher + home + onboarding checklist, wired to the API (TENANT-01, TENANT-05)

**Wave 3** *(blocked on Wave 2 completion)*

- [ ] 01-03-PLAN.md — Platform system email + password reset + soft email verification + profile (TENANT-01, TENANT-04)

**Wave 4** *(blocked on Wave 3 completion)*

- [ ] 01-04-PLAN.md — Team invites by email + membership/role management UI + delete workspace (TENANT-02, TENANT-03)

**Wave 5** *(blocked on Wave 4 completion)*

- [ ] 01-05-PLAN.md — SendGrid key connect: validate + KMS envelope encryption + masked status UI + role/verify gates + onboarding checklist finalize (TENANT-03, TENANT-04)

### Phase 2: Contacts & Event Ingestion

**Goal**: A marketer can build and maintain their contact base (UI, CSV, API) while their backend streams freeform behavioral events that create and enrich contacts in real time.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: CONT-01, CONT-02, CONT-03, CONT-04, CONT-05, EVNT-01, EVNT-02, EVNT-03, SUBS-01
**Success Criteria** (what must be TRUE):

  1. A user can create, view, edit, and delete a contact in the UI, including arbitrary custom profile properties.
  2. A user can upload a CSV, map columns to attributes, preview the result before applying, and receive a report of errors and duplicates.
  3. A tenant's backend can create/update contacts via the Contacts API and post freeform events (name + JSON) with an API key, getting an immediate 2xx while processing happens asynchronously through a queue.
  4. An event for an unknown contact automatically creates it via external_id/email upsert, and a later email change still resolves to the same contact.
  5. Every contact carries a 3-state subscription status (subscribed / unsubscribed / suppressed).

**Plans**: TBD
**UI hint**: yes

Plans:

- [ ] 02-01: Contact data model (external_id/email identity, custom properties) + CRUD UI
- [ ] 02-02: Contacts CRUD API with upsert semantics
- [ ] 02-03: CSV import — column mapping, preview, error/duplicate report
- [ ] 02-04: Event ingestion API (fast 2xx) + async queue processor + upsert-from-event
- [ ] 02-05: 3-state subscription status model + partition-ready events schema

### Phase 3: Segmentation Engine

**Goal**: A marketer can define dynamic audiences by profile attributes and behavior, seeing how many contacts match as they build — using one segment engine that flows and campaigns will both share.
**Mode:** mvp
**Depends on**: Phase 2
**Requirements**: SEGM-01, SEGM-02, SEGM-03, SEGM-04
**Success Criteria** (what must be TRUE):

  1. A user can build and save a segment from profile attributes (country, tags, custom properties).
  2. A user can add behavioral conditions over events ("ordered in last 30 days", "didn't open in 90 days") with count and timeframe.
  3. As the user edits segment conditions, a live count of matching contacts updates.
  4. The same saved segment definition resolves an identical membership set whether queried for a campaign audience or a flow trigger.

**Plans**: TBD
**UI hint**: yes

Plans:

- [ ] 03-01: Segment definition model + single unified evaluation engine
- [ ] 03-02: Profile-attribute conditions
- [ ] 03-03: Behavioral/event conditions (count/timeframe) + materialized membership at target scale
- [ ] 03-04: Live preview count in the segment builder

### Phase 4: Broadcast Campaigns & Send Pipeline

**Goal**: A marketer can send a real broadcast to a segment through a throttled, idempotent, suppression-aware queue — emails reliably reach inboxes via SendGrid Dynamic Templates.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: CAMP-01, CAMP-02, CAMP-03, CAMP-04, CAMP-05, SEND-01, SEND-02, SEND-03, SEND-04, SEND-05, SEND-06, SEND-07, SUBS-03, SUBS-04
**Success Criteria** (what must be TRUE):

  1. A user can create a campaign by choosing a segment audience and a SendGrid Dynamic Template, then send a test email to their own address with sample dynamic data.
  2. A user can launch a campaign immediately or schedule it for a date/time, and a draft cannot be sent by accident (draft → scheduled → sending → sent state machine).
  3. During sending the user sees live progress (sent / total), and suppressed/unsubscribed contacts are filtered out before send.
  4. Every delivered email goes through SendGrid v3 mail/send with a one-click List-Unsubscribe header, no contact exceeds the global frequency cap, and there are no duplicate emails on job retries.
  5. Sends are throttled per that tenant's RPS, ride a queue with a reserved triggered-priority lane, and survive SendGrid 429/5xx with backoff retries without losing emails.

**Plans**: TBD
**UI hint**: yes

Plans:

- [ ] 04-01: Send queue infrastructure — triggered vs broadcast priority lanes (triggered reserved floor)
- [ ] 04-02: Per-tenant RPS token-bucket throttle + 429/5xx backoff + idempotency keys
- [ ] 04-03: SendGrid dispatch worker (mail/send v3, template_id + dynamic_template_data, List-Unsubscribe)
- [ ] 04-04: Pre-send suppression/subscription filter + global frequency-cap ledger
- [ ] 04-05: Campaign model + state machine + segment audience snapshot at send time
- [ ] 04-06: Campaign UI — create, test send, schedule, live progress

### Phase 5: Webhook Processing & Delivery Tracking

**Goal**: A marketer's sent emails show accurate, deduplicated delivery outcomes, and bounces/unsubscribes/spam complaints automatically suppress contacts from future sends.
**Mode:** mvp
**Depends on**: Phase 4
**Requirements**: WBHK-01, WBHK-02, WBHK-03, WBHK-04, SUBS-02
**Success Criteria** (what must be TRUE):

  1. SendGrid events (delivered / opened / clicked / bounced / unsubscribed / spam report / dropped) arrive on the workspace's per-tenant webhook URL and update each message's status in the send log.
  2. A payload with an invalid ECDSA signature is rejected, while a valid one is verified against the raw request body before any parsing.
  3. Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics.
  4. A bounce, spam complaint, or unsubscribe automatically flips the contact's subscription status so subsequent sends skip that contact.

**Plans**: TBD

Plans:

- [ ] 05-01: Per-tenant webhook endpoint + raw-body ECDSA signature verification
- [ ] 05-02: Async webhook processor (ack fast) + dedupe by sg_event_id
- [ ] 05-03: Message status + contact subscription updates (suppress on bounce/spam/unsubscribe)

### Phase 6: Flows (Triggered Chains)

**Goal**: A marketer can visually build, publish, and run automated triggered chains that send the right email at the right time, reusing the proven send pipeline, suppression, and frequency cap.
**Mode:** mvp
**Depends on**: Phase 5
**Requirements**: FLOW-01, FLOW-02, FLOW-03, FLOW-04, FLOW-05, FLOW-06, FLOW-07
**Success Criteria** (what must be TRUE):

  1. A user can drag-and-drop a flow on the canvas with trigger, delay/wait, conditional branch, send-email, and explicit exit nodes per branch, then publish it (draft → live → paused).
  2. A contact entering via an event or by joining a segment moves through the flow — respecting delays and branch conditions — and leaves when an exit condition is met.
  3. Re-entry control (once ever / once per N days / every time) and quiet hours are honored: no email is sent inside the quiet window, and it is deferred until the window ends.
  4. Editing a live flow happens in a draft that only takes effect on publish; contacts already mid-flight continue on the version they entered, with no duplicate or skipped sends.

**Plans**: TBD
**UI hint**: yes

Plans:

- [ ] 06-01: Flow data model + immutable published versioning
- [ ] 06-02: Canvas builder UI (nodes, branches, connections, per-branch exit)
- [ ] 06-03: Flow trigger evaluator (event/segment entry) + re-entry control semantics
- [ ] 06-04: Flow execution engine — state machine, delays, branches, exit conditions, idempotent steps, reconciliation scan
- [ ] 06-05: Quiet hours (dispatch-time) + draft/live/paused lifecycle & publish

### Phase 7: Analytics, Dashboard & Send Log

**Goal**: A marketer can see end-to-end performance — per campaign, per flow step, per contact, and across the whole workspace — down to the status of every individual message.
**Mode:** mvp
**Depends on**: Phase 6
**Requirements**: ANLT-01, ANLT-02, ANLT-03, ANLT-04, ANLT-05
**Success Criteria** (what must be TRUE):

  1. A user can view campaign metrics — sent / delivered / opened / clicked / bounced / unsubscribed — as both counts and percentages.
  2. A user can see per-step metrics for a flow to identify which step underperforms.
  3. A contact's card shows a timeline of custom events, sent emails, opens, clicks, and subscription-status changes.
  4. A workspace dashboard shows send / deliver / open trends over a chosen period and contact-base growth.
  5. A user can browse a per-message send log filtered by contact, campaign/flow, status, and period.

**Plans**: TBD
**UI hint**: yes

Plans:

- [ ] 07-01: Analytics rollup tables + incremental aggregation (with periodic reconciliation)
- [ ] 07-02: Campaign metrics + per-flow-step metrics
- [ ] 07-03: Contact-card activity timeline
- [ ] 07-04: Workspace summary dashboard
- [ ] 07-05: Per-message send log with filters

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Workspace Foundation & Team Access | 2/5 | In Progress|  |
| 2. Contacts & Event Ingestion | 0/5 | Not started | - |
| 3. Segmentation Engine | 0/4 | Not started | - |
| 4. Broadcast Campaigns & Send Pipeline | 0/6 | Not started | - |
| 5. Webhook Processing & Delivery Tracking | 0/3 | Not started | - |
| 6. Flows (Triggered Chains) | 0/5 | Not started | - |
| 7. Analytics, Dashboard & Send Log | 0/5 | Not started | - |
