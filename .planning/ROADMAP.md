# Roadmap: Mega CRM — B2C Marketing Automation Platform

## Overview

Mega CRM is a Klaviyo-class, multi-tenant email marketing automation platform delivered on SendGrid (BYO key per tenant). The journey builds outward from an isolated, secure workspace: first a marketer gets an account, team, and connected sending account (Phase 1); then a living contact base fed by UI, CSV, and a server-side event API (Phase 2); then dynamic profile-and-behavior segments powered by one shared evaluation engine (Phase 3). With an audience in place, the platform delivers its first complete send loop — reliable, throttled, idempotent, suppression-aware broadcast campaigns through SendGrid (Phase 4) — and then closes that loop with deduplicated delivery tracking and automatic suppression from webhooks (Phase 5). On the proven send pipeline, the signature canvas flow builder layers automated triggered chains with versioning, quiet hours, and frequency capping (Phase 6). Finally, end-to-end analytics make the platform's reliability visible: campaign, flow-step, contact-timeline, dashboard, and per-message observability (Phase 7).

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Workspace Foundation & Team Access** - Multi-tenant workspaces, team invites, roles, and a validated encrypted SendGrid key (completed 2026-07-03)
- [x] **Phase 2: Contacts & Event Ingestion** - Contact base via UI/CSV/API plus an async server-side event stream that upserts contacts (completed 2026-07-04)
- [x] **Phase 3: Segmentation Engine** - Dynamic profile + behavioral segments with live preview, on one shared evaluation engine (completed 2026-07-06)
- [x] **Phase 4: Broadcast Campaigns & Send Pipeline** - First complete send loop: throttled, idempotent, suppression-aware broadcasts via SendGrid (verification: gaps found 2026-07-06) (completed 2026-07-06)
- [x] **Phase 5: Webhook Processing & Delivery Tracking** - Verified, deduplicated delivery events that update message status and auto-suppress contacts (verification: gaps found 2026-07-08) (completed 2026-07-08)
- [ ] **Phase 6: Flows (Triggered Chains)** - Visual canvas builder and versioned execution engine for automated triggered chains
- [ ] **Phase 7: Analytics, Dashboard & Send Log** - End-to-end observability: campaign, flow-step, contact-timeline, dashboard, and per-message metrics

## Phase Details

### Phase 1: Workspace Foundation & Team Access

**Goal**: As a marketer, I want to create a workspace, bring my team in with the right permissions, and connect my SendGrid account, so that my company's email marketing runs on data fully isolated from every other workspace from day one.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: TENANT-01, TENANT-02, TENANT-03, TENANT-04, TENANT-05
**Success Criteria** (what must be TRUE):

  1. A new user can register and create a workspace, becoming its Owner.
  2. An Owner/Admin can invite a colleague by email who then joins the workspace with an assigned role (Owner/Admin/Member).
  3. A Member is blocked from changing the SendGrid key and from launching campaigns/flows, while Owner/Admin can do both.
  4. A user can paste a SendGrid API key and see it validated on connect (accepted if valid, rejected with a clear error if not); the stored key is encrypted at rest.
  5. A user in one workspace cannot see or access any contact, event, campaign, or statistic belonging to another workspace.

**Plans**: 7/7 plans complete
**UI hint**: yes

Plans:
**Wave 1**

- [x] 01-01-PLAN.md — Walking-skeleton backend: monorepo scaffold + Drizzle/RLS schema + better-auth org backbone + tenant context + register→create-workspace→Owner API + migration (TENANT-01, TENANT-05)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 01-02-PLAN.md — Walking-skeleton UI: register/login, create-workspace onboarding, app shell + workspace switcher + home + onboarding checklist, wired to the API (TENANT-01, TENANT-05)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 01-03-PLAN.md — Platform system email + password reset + soft email verification + profile (TENANT-01, TENANT-04)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 01-04-PLAN.md — Team invites by email + membership/role management UI + delete workspace (TENANT-02, TENANT-03)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 01-05-PLAN.md — SendGrid key connect: validate + KMS envelope encryption + masked status UI + role/verify gates + onboarding checklist finalize (TENANT-03, TENANT-04)

**Wave 6** *(gap closure — verification blocker + same-surface warnings)*

- [x] 01-06-PLAN.md — Close CR-01 (unauthenticated GET sendgrid-key cross-tenant disclosure), WR-02 (Member invite-token leak), CR-02 (invite-email HTML injection), CR-03 (missing pg Pool error handler) (TENANT-05, TENANT-04)

**Wave 7** *(gap closure — UAT Test 2 blocker: cold-start env drift)*

- [x] 01-07-PLAN.md — Fix cold-start env drift (missing PLATFORM_SENDGRID_API_KEY / PLATFORM_MAIL_FROM / KMS_LOCAL_KEK crashing the API before listen → registration ECONNREFUSED): complete .env/.env.example, human-readable boot error in env.ts, loud pre-dev env check (TENANT-01, TENANT-04, TENANT-05)

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

**Plans**: 14/14 plans complete
**UI hint**: yes

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Contact model + suppression + property registry schema + session-authed CRUD API (CONT-01, CONT-05, SUBS-01)

**Wave 2** *(parallel)*

- [x] 02-03-PLAN.md — Workspace API keys: schema, crypto, Owner/Admin management routes/UI + runtime apiKeyAuth hook (CONT-03, EVNT-01)
- [x] 02-05-PLAN.md — Queue foundation: Redis + BullMQ, tenant-context extraction to a shared package, apps/worker scaffold (EVNT-03) — includes blocking package-legitimacy checkpoint

**Wave 3** *(parallel)*

- [x] 02-02-PLAN.md — Contact CRUD UI: list (search/filter/sort/pagination), form + custom-property editor, tabbed detail (CONT-01, CONT-05, SUBS-01)
- [x] 02-04-PLAN.md — Contacts integration API + prioritized two-key upsert (external_id→email, attach/conflict) (CONT-03, CONT-04, EVNT-02)

**Wave 4**

- [x] 02-06-PLAN.md — Event ingestion: partitioned events schema, fast-2xx /v1/events, idempotent async worker upsert-from-event (EVNT-01, EVNT-02, EVNT-03)

**Wave 5**

- [x] 02-07-PLAN.md — CSV import backend: staging, streamed upload, dry-run, background apply worker, error report (CONT-02)

**Wave 6**

- [x] 02-08-PLAN.md — CSV import wizard UI + history + live contact event feed (CONT-02, EVNT-01/D-14)

**Wave 7** *(gap closure — verification gaps_found, 3/5)*

- [x] 02-09-PLAN.md — Contact edit: property deletion + standard-field clearing (CR-04) (CONT-01, CONT-05)
- [x] 02-10-PLAN.md — Event ingestion: workspace-scoped idempotency PK/jobId + DEFAULT partition + queue retries (CR-01, CR-03, WR-01) (EVNT-01, EVNT-03)
- [x] 02-11-PLAN.md — Shared upsert robustness: SAVEPOINT race retry + status-on-update + dead-connection release (CR-02, WR-06, WR-09)
- [x] 02-12-PLAN.md — CSV import robustness: validated status mapping + failed-upload path + no silent stuck-applying (WR-05, WR-04, WR-03)

**Wave 8** *(gap closure — re-verification: UAT Test 2 + WR-09 follow-up; parallel)*

- [x] 02-13-PLAN.md — Contact list search focus fix: keepPreviousData + toolbar-always-mounted + results-scoped skeleton + Playwright regression (UAT Test 2, CONT-01/D-13 hardening)
- [x] 02-14-PLAN.md — WR-09 fault-injection test: terminate a pooled connection mid-transaction, assert withTenantTransaction destroys it and the pool recovers (UAT Test 11 follow-up, EVNT-03/CONT-04 hardening)

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

**Plans**: 8/8 plans complete
**UI hint**: yes

Plans:
**Wave 1**

- [x] 03-01-PLAN.md — Pure SQL condition compiler (@mega-crm/segments-core) + shared Zod SegmentDefinition contract (SEGM-01, SEGM-02, SEGM-03)

**Wave 2** *(blocked on Wave 1)*

- [x] 03-02-PLAN.md — segments table + RLS/GIN migrations + evaluation engine (count/list/isMember) + CRUD + preview-count API + event-name picker (SEGM-01, SEGM-02, SEGM-03, SEGM-04)

**Wave 3** *(blocked on Wave 2)*

- [x] 03-03-PLAN.md — Segment builder UI (attribute + behavioral conditions) + live count + create/save + Segments nav & list (SEGM-01, SEGM-02, SEGM-04)

**Wave 4** *(blocked on Wave 3)*

- [x] 03-04-PLAN.md — Segment detail (edit + paginated member list) + delete + list enrichment (count/freshness/author) (SEGM-01, SEGM-03)

**Wave 5** *(gap closure — blocked on Wave 4)*

- [x] 03-05-PLAN.md — Contract + engine hardening: Zod standard-field allow-list (CR-01/WR-01 root cause) + prototype-safe fail-closed compiler + LIKE-wildcard escaping (WR-04) (SEGM-01, SEGM-03)

**Wave 6** *(gap closure — blocked on Wave 5)*

- [x] 03-06-PLAN.md — API hardening: statement_timeout on create/update/members (WR-03) + 57014→4xx mapping + HTTP tests (400 on unknown field, tags round-trip) (SEGM-01, SEGM-04)
- [x] 03-07-PLAN.md — Web builder: reachable tags condition + CR-01 client validation/error UI + list pagination (WR-05) + detail not-found (WR-06) (SEGM-01)

**Wave 7** *(gap closure — blocked on Wave 6)*

- [x] 03-08-PLAN.md — E2E behavior coverage: tags slice + CR-01 regression + SEGM-02 behavioral inputs + SEGM-04 degraded state (SEGM-01, SEGM-02, SEGM-04)

### Phase 4: Broadcast Campaigns & Send Pipeline

**Goal**: As a marketer, I want to send a real broadcast to a segment through a throttled, idempotent, suppression-aware queue, so that emails reliably reach inboxes via SendGrid Dynamic Templates.
**Mode:** mvp
**Depends on**: Phase 3
**Requirements**: CAMP-01, CAMP-02, CAMP-03, CAMP-04, CAMP-05, SEND-01, SEND-02, SEND-03, SEND-04, SEND-05, SEND-06, SEND-07, SUBS-03, SUBS-04
**Success Criteria** (what must be TRUE):

  1. A user can create a campaign by choosing a segment audience and a SendGrid Dynamic Template, then send a test email to their own address with sample dynamic data.
  2. A user can launch a campaign immediately or schedule it for a date/time, and a draft cannot be sent by accident (draft → scheduled → sending → sent state machine).
  3. During sending the user sees live progress (sent / total), and suppressed/unsubscribed contacts are filtered out before send.
  4. Every delivered email goes through SendGrid v3 mail/send with a one-click List-Unsubscribe header, no contact exceeds the global frequency cap, and there are no duplicate emails on job retries.
  5. Sends are throttled per that tenant's RPS, ride a queue with a reserved triggered-priority lane, and survive SendGrid 429/5xx with backoff retries without losing emails.

**Plans**: 19/19 plans complete
**UI hint**: yes

Plans:

**Wave 1**

- [x] 04-01-PLAN.md — Campaign data model: 4 RLS tables (campaigns/campaign_recipients/sends/workspace_send_settings) + migrations + BLOCKING push + shared Zod/queue schemas (CAMP-01, CAMP-03, SEND-04, SEND-06)
- [x] 04-02-PLAN.md — Shared @mega-crm/kms package extraction + SendGrid tenant dynamic-template listing (CAMP-01, SEND-05)

**Wave 2** *(blocked on Wave 1)*

- [x] 04-03-PLAN.md — @mega-crm/delivery-core (HMAC unsubscribe token, mail/send builder, pre-send gate, send ledger, send-settings) + public RFC 8058 unsubscribe endpoint (SUBS-03, SUBS-04, SEND-04)

**Wave 3** *(parallel — worker vs API)*

- [x] 04-04-PLAN.md — Send dispatch engine: per-tenant token bucket + idempotent send-dispatch (mail/send + List-Unsubscribe + backoff) + broadcast/triggered workers + [SUS] package checkpoint (SEND-01, SEND-02, SEND-03, SEND-05, SEND-06, SEND-07, SUBS-04)
- [x] 04-05-PLAN.md — Campaign backend: repository + state machine + routes + test-send + send-settings routes + D-14 segment-delete block (CAMP-01, CAMP-02, CAMP-03, CAMP-04, CAMP-05, SUBS-03)

**Wave 4** *(parallel — worker kickoff vs UI list/builder)*

- [x] 04-06-PLAN.md — Send kickoff: batched recipient snapshot + campaign-kickoff fan-out + repeatable due-campaign scheduler (CAMP-02, CAMP-05, SEND-01)
- [x] 04-07-PLAN.md — Campaigns UI part 1: list + builder + api client + nav (CAMP-01)

**Wave 5** *(blocked on Wave 4)*

- [x] 04-08-PLAN.md — Campaigns UI part 2: launch/schedule/cancel/test-send dialogs + detail + live progress + send settings + segment warning (CAMP-02, CAMP-03, CAMP-04, CAMP-05)

**Gap closure** *(from 04-VERIFICATION.md — CR-01..CR-07)*

_Wave 1 (parallel):_

- [x] 04-09-PLAN.md — Sender-email resolution: resolve fromSenderId → verified from_email at launch/schedule/test-send (CR-02, CAMP-01/02/04)
- [x] 04-10-PLAN.md — Ledger integrity: guard recordExcluded from demoting sent/dispatching rows (CR-07, SEND-04/06)
- [x] 04-11-PLAN.md — Public unsubscribe XSS fix + @fastify/helmet CSP (CR-01, SUBS-04)

_Wave 2:_

- [x] 04-12-PLAN.md — Dispatch correctness: 3-unit transaction split (no duplicate on crash) + 4xx→failed (CR-03/CR-04, SEND-06/07)

_Wave 3:_

- [x] 04-13-PLAN.md — Campaign completion + live progress counters + cancel enforcement (CR-05/CR-06, CAMP-02/03/05)

**Gap closure round 2** *(from 04-VERIFICATION.md 2026-07-06 re-verify — SUBS-04 415 blocker)*

_Wave 1:_

- [x] 04-14-PLAN.md — Register application/x-www-form-urlencoded content-type parser scoped to registerUnsubscribeRoutes so RFC 8058 one-click + confirm-form POSTs reach the handler (no more 415) + explicit-Content-Type regression tests (SUBS-04)

**Gap closure round 3** *(from 04-UAT.md 2026-07-06 — Test 3 segment-picker 400 blocker)*

_Wave 1:_

- [x] 04-15-PLAN.md — Fix pageSize client/server contract mismatch: shared EXHAUSTIVE_LOOKUP_PAGE_SIZE constant caps both segment/campaign list schemas and drives all three exhaustive-lookup call sites (segment picker + campaign-list name lookup + D-03 warning); regression test pins the bound (CAMP-01, CAMP-02)

**Gap closure round 4** *(from 04-UAT.md 2026-07-06 — Tests 4/5 no delivery, Test 12 D-03 warning missing)*

_Wave 1 (parallel):_

- [x] 04-16-PLAN.md — Send-pipeline fail-fast: validate UNSUBSCRIBE_TOKEN_SECRET + PUBLIC_APP_URL in check-env/api-env/worker-boot + predev migration bootstrap (applies unapplied 0017–0019); user_setup handoff for the two .env values (SEND-05, SUBS-04, CAMP-05)
- [x] 04-17-PLAN.md — Test-send 4xx observability: kind='test' branch reports SendGrid 4xx as failed (mirrors campaign branch) + regression test; clarify test-send sample-data copy as as-designed (SEND-07, CAMP-04)
- [x] 04-18-PLAN.md — Segment editor save-time D-03 gate: pure save-gate helper + save-time refetch+confirm + isError surfacing + new web vitest unit lane (CAMP-05)

**Gap closure round 5** *(from 04-VERIFICATION.md 2026-07-07 — CR-01 test-send unsubscribe token 500)*

_Wave 1:_

- [x] 04-19-PLAN.md — CR-01 fix: sign a real random UUID for test-send unsubscribe tokens (worker root cause) + guard the public unsubscribe POST against a non-UUID contactId (uniform response, no 500) + worker & API regression coverage (CAMP-04, SUBS-04)

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

**Plans**: 13/13 plans complete
**UI hint**: yes

Plans:

**Wave 1** *(parallel)*

- [x] 05-01-PLAN.md — Webhook receiver walking skeleton: send_events (partitioned) + webhook_endpoints schema/migrations + raw-body ECDSA verify route + dedup-insert worker (WBHK-01, WBHK-03)
- [x] 05-02-PLAN.md — Send-side markers (force open/click tracking + test custom_arg) + pure delivery logic (event normalize, suppression rules, current-status priority) (WBHK-02, SUBS-02)

**Wave 2** *(parallel — blocked on Wave 1)*

- [x] 05-03-PLAN.md — Delivery-status + suppression processing: sends fact columns + campaign counters + contacts soft-bounce streak (migrations + BLOCKING push) + full worker side-effect pipeline (WBHK-02, WBHK-04, SUBS-02)
- [x] 05-04-PLAN.md — SendGrid auto-provisioning on key connect/recheck + PATCH-in-place reconnect guard + webhook health/reconnect routes (WBHK-01)

**Wave 3** *(blocked on Wave 2)*

- [x] 05-05-PLAN.md — UI: campaign delivery counters (delivered/opened/clicked/не доставлено/unsubscribed) + webhook health card + reconnect + onboarding "включить отслеживание доставки" item (WBHK-04)

**Gap closure** *(from 05-VERIFICATION.md 2026-07-08 — gaps_found; CR-01, WR-01/WR-02)*

_Wave 1 (parallel):_

- [x] 05-06-PLAN.md — Worker deterministic occurred_at: extractEventRow skips events with a non-finite/out-of-range timestamp (no wall-clock fallback) so redelivery dedups; + regression tests (WR-01/WR-02) (WBHK-03)
- [x] 05-07-PLAN.md — Provisioning reuse fix: workspace-scoped webhook friendly_name + PATCH reused webhook's url to the caller's callbackUrl before returning; + repoint/cross-workspace regression tests (CR-01) (WBHK-01, WBHK-04)

**Gap closure round 2** *(from 05-UAT.md 2026-07-09 — Test 1 major + Test 3 blocker: silent provisioning failure)*

_Wave 1 (parallel):_

- [x] 05-08-PLAN.md — Diagnosable provisioning: log redacted SendGrid status+body, preserve created webhook id on signed-verification failure, + provision_error column/migration/repo threading (WBHK-01, WBHK-04)
- [x] 05-10-PLAN.md — Live-UAT operational docs: webhook-live-uat.md runbook (tunnel + PUBLIC_APP_URL + SendGrid Event Webhook key scope) + check-env.mjs localhost warning (WBHK-01)

_Wave 2 (blocked on 05-08):_

- [x] 05-09-PLAN.md — Surface the reason end-to-end: connect-time webhook-scope detection + reconnect error propagation + provisionError on health contract + rendered UI (inline warning, reconnect error toast, health-card reason) (WBHK-01, WBHK-04)

**Gap closure round 3** *(from 05-VERIFICATION.md 2026-07-09 — gaps_found; CR-01 reconnect self-heal)*

_Wave 1:_

- [x] 05-11-PLAN.md — Reconnect self-heal: provisionEventWebhook treats a 404 PATCH of a stale stored sendgridWebhookId as "stale id" and falls through to createWebhook's reuse-or-create path so the new id is persisted; + regression tests (stored-id 404 -> CREATE, and signed-failure-after-fallback id preservation) (CR-01) (WBHK-01)

**Gap closure round 4** *(from 05-UAT.md 2026-07-09 — Test 1 major + Test 2 blocker: non-https PUBLIC_APP_URL → SendGrid 400 "webhook url must use https", silent absence)*

_Wave 1:_

- [x] 05-12-PLAN.md — https enforcement: pre-flight insecure_url short-circuit in provisionEventWebhook (skips the doomed non-https create/patch on connect/recheck/reconnect) + actionable Russian copy pointing at PUBLIC_APP_URL/docs + health-card recognition + predev http:// warning + production boot https requirement; + tests (WBHK-01, WBHK-04)

**Gap closure round 5** *(from 05-UAT.md 2026-07-09 Test 4 major: delivered+opened email but campaign metrics zero — SendGrid flattens custom args to the event root, worker read nested custom_args)*

_Wave 1:_

- [x] 05-13-PLAN.md — Flattened custom-arg attribution: extractEventRow reads top-level event.send_id / event.test (nested custom_args kept as defensive fallback) so real events resolve send_id and increment counters; + real-payload attribution integration test (RED→GREEN) + migrate all webhook fixtures off the nested shape SendGrid never sends (WBHK-04, SUBS-02, WBHK-02)

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

**Plans**: 10/11 plans executed
**UI hint**: yes

Plans:
**Wave 1**

- [x] 06-01-PLAN.md — Flow data model (5 tables) + send/contact/settings extensions + RLS migrations + [BLOCKING] db:migrate
- [x] 06-02-PLAN.md — flows-core contracts (definition schema + publish validator) + flow DTOs + kind:'flow' job schema

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 06-03-PLAN.md — Send-pipeline flow extension: claimFlowSend + processSendJob kind:'flow' (idempotent, shared pipeline)
- [x] 06-04-PLAN.md — Flow API: draft CRUD, atomic validated publish + immutable versioning, pause/resume/duplicate, restrict-delete (D-24)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 06-05-PLAN.md — Execution engine core: run-advance state machine (send/exit) + exit conditions + reconciliation scan + pause-freeze
- [x] 06-10-PLAN.md — Canvas builder UI (@xyflow/react, 5 node types, palette, autosave) + [SUS] package-legitimacy checkpoint

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 06-06-PLAN.md — Event-trigger evaluator + re-entry control (once-ever/once-per-N/every-time) + one-active-run
- [x] 06-07-PLAN.md — Delays/wait-until + durable timers + dispatch-time quiet hours + timezone (contact/workspace) validation
- [x] 06-09-PLAN.md — Run visibility ('N in flow, M on old versions') + eject + D-22 delete guard

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 06-08-PLAN.md — Conditional branch node + segment-entry trigger (re-check + bounded sweep) + enroll-existing (D-04)

**Wave 6** *(blocked on Wave 5 completion)*

- [ ] 06-11-PLAN.md — Flow list/detail UI + publish/enroll dialogs + re-entry/quiet-hours/timezone forms + settings + nav

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
| 1. Workspace Foundation & Team Access | 7/7 | Complete    | 2026-07-03 |
| 2. Contacts & Event Ingestion | 14/14 | Complete    | 2026-07-05 |
| 3. Segmentation Engine | 8/8 | Complete    | 2026-07-06 |
| 4. Broadcast Campaigns & Send Pipeline | 19/19 | Complete    | 2026-07-06 |
| 5. Webhook Processing & Delivery Tracking | 13/13 | Complete    | 2026-07-09 |
| 6. Flows (Triggered Chains) | 10/11 | In Progress|  |
| 7. Analytics, Dashboard & Send Log | 0/5 | Not started | - |
