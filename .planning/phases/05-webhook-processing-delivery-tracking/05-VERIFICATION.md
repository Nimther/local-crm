---
phase: 05-webhook-processing-delivery-tracking
verified: 2026-07-08T20:20:00Z
status: gaps_found
score: 4/4 truths present and passing tests; 2 truths carry an unresolved, codebase-confirmed correctness defect (see gaps)
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics"
    status: partial
    reason: "The dedup key (workspace_id, sg_event_id, occurred_at) requires occurred_at to be deterministic per event. extractEventRow falls back to `new Date().toISOString()` (wall-clock, non-deterministic) whenever event.timestamp is missing or not a number, so a BullMQ/SendGrid redelivery of such an event produces a different occurred_at, ON CONFLICT never fires, and the event is re-inserted with duplicate counter increments and duplicate suppression side effects — the exact WBHK-03/D-09 exactly-once invariant this phase exists to guarantee. Separately, a numeric-but-out-of-range timestamp (e.g. 1e20) makes `new Date(ts*1000).toISOString()` throw RangeError inside `.map(extractEventRow)` with no guard, crashing the whole job; BullMQ retries 5 times then permanently drops the ENTIRE acked batch (including well-formed events), contradicting the function's own doc-comment ('one malformed event must not crash the whole batch'). Both defects were identified by the phase's own 05-REVIEW.md (WR-01, WR-02) and confirmed still present in the current tree by direct code inspection; no fix commit exists after the review was recorded (6d92446). No test exercises either condition — all passing tests seed a well-formed numeric timestamp."
    artifacts:
      - path: "apps/worker/src/queues/webhook-events.worker.ts"
        issue: "Lines 49-52: occurredAt falls back to `new Date().toISOString()` for a missing/non-numeric timestamp instead of skipping the event (same treatment as a missing sg_event_id); no bounds check before `new Date(ts*1000)`"
    missing:
      - "extractEventRow must return null (skip, no row) for an event whose timestamp is not a finite number within the Date-representable range, instead of substituting wall-clock time"
      - "A regression test asserting a redelivered event with a missing/invalid timestamp does not double-insert or double-count, and a test asserting an out-of-range timestamp in one event does not fail the rest of the batch"
  - truth: "SendGrid events arrive on the workspace's per-tenant webhook URL and update each message's status in the send log"
    status: partial
    reason: "provisionEventWebhook's createWebhook path, when it finds an existing SendGrid webhook whose friendly_name matches 'Mega CRM Delivery Tracking', returns that webhook's id immediately WITHOUT patching its url to the caller's callbackUrl (sendgrid-webhook-provision.ts lines 123-148, createWebhook). Two real trigger conditions: (1) the documented DB-row-lost recovery scenario this branch's own comment claims to handle — the reused webhook keeps pointing at the OLD pathToken URL, which now 404s, so tracking silently stops while the health card reports provisionStatus:'active'; (2) the same SendGrid key connected to two different workspaces (an explicitly plausible agency/multi-brand case, 'nothing prevents this' per 05-REVIEW.md CR-01) — the second workspace's connect adopts the first workspace's webhook id, and a later 'Переподключить' on either workspace silently repoints the SHARED webhook, killing the other workspace's tracking while it still shows connected. This directly breaks this phase's exact goal wording ('accurate ... delivery outcomes') for the affected workspace, with a false-positive health status masking the failure. Identified as CR-01 (the review's sole Critical finding) in 05-REVIEW.md; confirmed still present in the current tree by direct code inspection; no fix commit exists after the review was recorded."
    artifacts:
      - path: "apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts"
        issue: "createWebhook (lines 123-148): `if (existing) { return { id: existing.id }; }` never verifies/repairs existing.url against callbackUrl before reuse"
    missing:
      - "When an existing webhook is matched by friendly_name, PATCH its url to the caller's callbackUrl before returning (or reject reuse) so a reused webhook always points at the requesting workspace's endpoint"
      - "Workspace-scope the friendly_name (or use a custom identifying field) so two workspaces sharing one SendGrid key cannot adopt/repoint each other's webhook"
      - "A test asserting an existing-webhook-by-name with a stale/different url gets repatched to the new callbackUrl before being returned as active"
deferred: []
human_verification:
  - test: "Connect a real tenant SendGrid API key and confirm in the SendGrid dashboard that a signed 'Mega CRM Delivery Tracking' Event Webhook is created (or PATCHed), the tenant's own pre-existing webhooks are untouched, and the implemented CREATE path (documented vs `.../settings/all` fallback, Open Question A3) matches what the live account actually requires."
    expected: "A new (or updated) Event Webhook named 'Mega CRM Delivery Tracking' appears in SendGrid → Settings → Mail Settings → Event Webhook, signed verification is enabled, and no other webhook entries are modified or removed."
    why_human: "Requires a live tenant SendGrid API key with webhook-management scope; not available in an automated verification run. Deferred per the plan's own `human_verify_mode: end-of-phase` (05-04-PLAN.md)."
  - test: "After a live SendGrid key connect and a real signed event delivery, check the SendGrid settings page's webhook-health card."
    expected: "The card shows a connected/active indicator, a non-null 'Последнее событие получено' relative time once a real event lands, and clicking Reconnect refreshes the card without error."
    why_human: "Requires a live signed webhook event to observe the UI update in a browser; deferred per 05-05-PLAN.md's own `<human-check>`."
  - test: "For an already-connected (pre-Phase-5) workspace, view the onboarding checklist."
    expected: "An 'Включить отслеживание доставки' item appears, links to SendGrid settings when incomplete, and flips to done after enabling/reconnecting tracking."
    why_human: "Requires a live reconnect flow observed in the browser; deferred per 05-05-PLAN.md's own `<human-check>`."
---

# Phase 5: Webhook Processing & Delivery Tracking Verification Report

**Phase Goal:** A marketer's sent emails show accurate, deduplicated delivery outcomes, and bounces/unsubscribes/spam complaints automatically suppress contacts from future sends.
**Verified:** 2026-07-08T20:20:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

Truths merged from ROADMAP.md Phase 5 Success Criteria (the roadmap contract) — no PLAN frontmatter `must_haves.truths` diverge from or narrow this set; the five plans' own must_haves are consistent subsets/refinements of these four.

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SendGrid events (delivered/opened/clicked/bounced/unsubscribed/spam report/dropped) arrive on the workspace's per-tenant webhook URL and update each message's status in the send log | ⚠️ Partial (see gap) | Route wired (`POST /webhooks/sendgrid/:pathToken`), signature-verified, enqueued, worker applies fact columns idempotently — all proven by 22 passing integration tests against real Postgres (`webhook-events-status.test.ts`, `webhook-events-suppression.test.ts`, `webhook-events-idempotency.test.ts`). BUT the auto-provisioning webhook-reuse path (CR-01) can silently point the wrong workspace at a stale/shared URL while reporting "active" — confirmed present, unresolved, in `sendgrid-webhook-provision.ts` |
| 2 | A payload with an invalid ECDSA signature is rejected, while a valid one is verified against the raw request body before any parsing | ✓ VERIFIED | `webhooks.routes.ts` scopes `addContentTypeParser("application/json",{parseAs:"buffer"})` inside `registerWebhookRoutes` only (`grep -c addContentTypeParser apps/api/src/server.ts` = 0 globally); `signature-verify.ts` calls `verifySignature` before any `JSON.parse`; `webhooks-signature.test.ts` (real SendGrid published fixture, real ECDSA bytes) proves valid→200+1 enqueue, invalid/missing→400+0 enqueue+no parse, unknown pathToken→404 before signature attempt. All pass. |
| 3 | Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics | ⚠️ Partial (see gap) | `send_events` has `UNIQUE(workspace_id, sg_event_id, occurred_at)` (verified live via `psql \d+ send_events`); `ON CONFLICT ... DO NOTHING RETURNING` gates every side effect; replay tests prove 0 additional rows/unchanged counters for well-formed events with numeric timestamps. BUT `occurredAt` falls back to non-deterministic wall-clock time for a missing/non-numeric `timestamp` field, defeating the dedup key for exactly the events it applies to (WR-01, confirmed present, unresolved) |
| 4 | A bounce, spam complaint, or unsubscribe automatically flips the contact's subscription status so subsequent sends skip that contact | ✓ VERIFIED | `webhook-events-suppression.test.ts`: hard bounce → suppressed(hard_bounce) + 1 `workspace_suppressions` row; 3rd consecutive soft bounce → suppressed(soft_bounce_streak), reset by a delivered event; spam_report → suppressed(spam_report); unsubscribe/group_unsubscribe → unsubscribed with zero suppression rows; dropped-by-reason → suppressed/unsubscribed/no-change per D-12. All 10 suppression-state-machine tests pass against real Postgres. |

**Score:** 4/4 truths have passing, real-database-backed test coverage on their primary path; 2 of the 4 (#1, #3) carry an unresolved, code-review-confirmed defect that breaks the same truth under a documented, realistic trigger condition not covered by any test.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/src/schema/send-events.ts` + `0020_send_events_partitioned.sql` | Partitioned, deduped, RLS'd `send_events` table | ✓ VERIFIED | Live `psql \d+ send_events`: RANGE(occurred_at), `send_events_default` present, PK `(workspace_id, id, occurred_at)`, UNIQUE `(workspace_id, sg_event_id, occurred_at)`, RLS forced |
| `packages/db/src/schema/webhook-endpoints.ts` + `0021_webhook_endpoints.sql` | `workspace_webhook_endpoints` with pre-tenant-context lookup | ✓ VERIFIED | Table live; `findWebhookEndpointByToken` used by the route before tenant context exists |
| `apps/api/src/modules/webhooks/webhooks.routes.ts` | Raw-body verify + enqueue receiver | ✓ VERIFIED | Reviewed in full; matches described threat-model doc-comment; wired in `server.ts` |
| `apps/worker/src/queues/webhook-events.worker.ts` | Full dedup + fact + counter + suppression pipeline | ✓ VERIFIED (with the WR-01/WR-02 defect noted above) | 412 lines; exports `processWebhookEventBatch`, `createWebhookEventsWorker`; registered in `apps/worker/src/server.ts`'s worker array |
| `packages/delivery-core/{event-normalize,suppression-rules,send-status}.ts` | Pure WBHK-02/SUBS-02/D-06 decision modules | ✓ VERIFIED | 0 DB imports (grep-verified); 54 delivery-core tests pass; consumed by the worker |
| `packages/db/migrations/0022-0024*.sql` | Delivery fact/streak/counter columns | ✓ VERIFIED | Live in DB (confirmed via information_schema during 05-03); columns present on `sends`/`contacts`/`campaigns` |
| `apps/api/src/modules/webhooks/sendgrid-webhook-provision.ts` | Create/PATCH/enable-signed via tenant key | ✓ VERIFIED, with CR-01 defect (see gap) | Never throws, redacts key, PATCH-in-place on reconnect proven by tests; the friendly_name-reuse branch is the defective path |
| `apps/api/src/modules/webhooks/webhook-settings.routes.ts` | GET health + POST reconnect | ✓ VERIFIED | Member-read/Owner-Admin-write role gates and anti-enumeration 404 proven by `webhook-settings-routes.test.ts` |
| `apps/web/src/features/webhooks/webhook-health.api.ts` + `SendGridKeySettings.tsx` card | Webhook health UI | ✓ VERIFIED (wiring); visual confirmation deferred to human-check | `getWebhookHealth`/`reconnectWebhook` used by `WebhookHealthCard`, gated on `connected` + `canManage`; `npm run build -w apps/web` clean |
| `OnboardingChecklist.tsx` item | "Включить отслеживание доставки" | ✓ VERIFIED (wiring) | done-state derives from `connected && provisionStatus==='active'`; links to SendGrid settings |
| Campaign progress/detail counters | delivered/opened/clicked/bounced/unsubscribed counts in API + UI | ✓ VERIFIED, data flowing | `campaign.repository.ts` SELECTs the real `*_count` columns (not hardcoded); `CampaignProgress.tsx`/`CampaignDetailPage.tsx` render them from the live API response; `campaign-delivery-counters.test.ts` passes |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `CampaignProgress.tsx` | `progress.deliveredCount` etc. | `GET .../campaigns/:id/progress` → `campaign.repository.ts` SELECT of `campaigns.delivered_count` (written exactly-once by the webhook worker) | Yes | ✓ FLOWING |
| `CampaignDetailPage.tsx` SummaryView | `campaign.deliveredCount` etc. | `GET .../campaigns/:id` → `toCampaignResponse` mapping the same columns | Yes | ✓ FLOWING |
| `SendGridKeySettings.tsx` WebhookHealthCard | `status.connected/provisionStatus/lastEventAt` | `GET .../webhook-health` → `getWebhookEndpointByWorkspace` reading the live `workspace_webhook_endpoints` row | Yes | ✓ FLOWING (subject to the CR-01 false-positive risk noted above) |
| `OnboardingChecklist.tsx` | `webhookHealthQuery.data.connected` | Same `GET .../webhook-health` endpoint | Yes | ✓ FLOWING |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `webhooks.routes.ts` | `findWebhookEndpointByToken` | pre-verification pathToken resolve | ✓ WIRED | Called before signature check, before any parse |
| `webhooks.routes.ts` | `enqueue.ts` (`WEBHOOK_EVENTS_QUEUE`) | `enqueueWebhookBatch` after valid signature | ✓ WIRED | Real BullMQ/Redis job-count assertions in tests, not mocked |
| `webhook-events.worker.ts` | `send_events` UNIQUE constraint | `ON CONFLICT ... DO NOTHING RETURNING` | ✓ WIRED (with WR-01 caveat) | Confirmed live constraint name matches worker's ON CONFLICT target |
| `webhook-events.worker.ts` | `@mega-crm/delivery-core` | imports `normalizeEventType`, `resolveSuppression`, `SOFT_BOUNCE_SUPPRESS_THRESHOLD` | ✓ WIRED | Confirmed via import statement at top of worker file |
| `sendgrid-key.ts` connect/recheck | `provisionEventWebhook` | best-effort call inside `withTenant` | ✓ WIRED (with CR-01 caveat) | `webhookWarning` additive field proven not to break the 200/connected:true contract |
| `campaign.repository.ts` | `campaigns` table counter columns | direct SELECT | ✓ WIRED | Not hardcoded; real column read confirmed |
| `webhook-health.api.ts` | `webhook-settings.routes.ts` | `GET/POST` fetch calls | ✓ WIRED | Confirmed matching route paths |

### Behavioral Spot-Checks / Test Execution

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| apps/worker webhook tests | `npm run test -w apps/worker -- webhook-events-status webhook-events-suppression webhook-events-idempotency` | 3 files, 22 tests passed | ✓ PASS |
| apps/api webhook/provisioning/campaign tests | `npm run test -w apps/api -- webhooks-signature webhook-provisioning sendgrid-key webhook-settings webhook-health campaign-delivery-counters` | 6 files, 33 tests passed | ✓ PASS |
| packages/delivery-core tests | `npm run test -w packages/delivery-core` | 7 files, 54 tests passed | ✓ PASS |
| apps/web build | `npm run build -w apps/web` | tsc + vite build clean | ✓ PASS |
| Full monorepo test suite | `npm run test --workspaces --if-present` | 34+1+13+7+1+2 = 58 files, 343 tests, all green | ✓ PASS (no regressions) |
| Live DB schema check | `psql "$DATABASE_URL" -c "\d+ send_events"` | Partitioned, UNIQUE constraint, RLS forced — all present | ✓ PASS |
| Migrations 0020-0024 present and applied | `ls packages/db/migrations/` + live psql query | All 5 files present, columns live in DB | ✓ PASS |

No probe scripts (`scripts/*/tests/probe-*.sh`) exist or are declared for this phase — Step 7c is not applicable (migration/tooling-probe pattern not used in this project; DB verification instead uses direct `psql` queries per the plan's own `<verify><automated>` blocks, which were re-run above).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| WBHK-01 | 05-01, 05-04 | Per-tenant webhook URL + ECDSA signature verification + auto-provisioning | ⚠️ Mostly satisfied | Receiver + provisioning both implemented and tested; CR-01 defect in the reuse-by-name recovery/shared-key path (see gap) |
| WBHK-02 | 05-02, 05-03 | delivered/opened/clicked/bounced/unsubscribed/spam/dropped event handling | ✓ SATISFIED | `normalizeEventType` covers every listed event; worker applies fact columns for each |
| WBHK-03 | 05-01 | Dedup by sg_event_id, no double-counting on replay | ⚠️ Mostly satisfied | Dedup constraint + RETURNING gate proven for well-formed events; non-deterministic fallback for missing/invalid timestamp defeats the guarantee for that subset (see gap, WR-01) |
| WBHK-04 | 05-03, 05-05 | Webhook events update message status + are surfaced to the marketer | ✓ SATISFIED | Fact columns + campaign counters written exactly-once and surfaced in campaign progress/detail UI, data confirmed flowing (not hardcoded) |
| SUBS-02 | 05-02, 05-03 | Unsubscribe/bounce/spam auto-updates contact status | ✓ SATISFIED | Full suppression state machine (hard bounce, spam, unsubscribe, dropped-by-reason, soft-bounce streak) proven by 10 passing integration tests |

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps exactly WBHK-01, WBHK-02, WBHK-03, WBHK-04, SUBS-02 to Phase 5. All five appear in at least one plan's `requirements:` frontmatter field (05-01: WBHK-01/03; 05-02: WBHK-02/SUBS-02; 05-03: WBHK-02/WBHK-04/SUBS-02; 05-04: WBHK-01; 05-05: WBHK-04). No orphans.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any of the 18 core phase-modified files scanned (webhook routes, worker, provisioning, delivery-core modules, campaign/onboarding/settings UI). No hardcoded-empty stub patterns found in the read files — all rendered counters and health fields trace to live API responses backed by real DB columns.

Two real, non-cosmetic correctness defects were found via direct code inspection (not anti-pattern grep, but confirmed present and unresolved) — see Gaps below. Both were independently identified by this phase's own `05-REVIEW.md` (dated after all 5 plans completed) and remain unfixed in the current tree (no commits after `6d92446 docs(05): add code review report`).

### Human Verification Required

See frontmatter `human_verification` — three items, all explicitly deferred by the plans themselves to end-of-phase human UAT (consistent with this project's established `human_verify_mode: end-of-phase` precedent from Phases 1-4): live SendGrid dashboard confirmation of the auto-provisioned webhook, live webhook-health card rendering after a real signed event, and the onboarding item's live done-state flip.

### Gaps Summary

Every roadmap Success Criterion has real, passing, real-Postgres-backed test coverage on its primary/happy path, and all 5 requirement IDs are accounted for with no orphans. However, this phase's own code review (`05-REVIEW.md`, completed after all 5 plans finished) surfaced one Critical and six Warning findings, and two of them — the review's sole **Critical** finding (CR-01: webhook reuse-by-name never repairs a stale/shared callback URL, producing a false-positive "active" health status while tracking silently breaks) and a **Warning** finding (WR-01/WR-02: the dedup key's `occurred_at` component falls back to non-deterministic wall-clock time for events with a missing/invalid timestamp, defeating the exactly-once dedup guarantee, and can crash-and-drop an entire acked batch on an out-of-range timestamp) — directly contradict this phase's precise goal wording: "accurate, deduplicated delivery outcomes." Both are confirmed present in the current source by direct inspection (not just cited from the review), and no commit since the review addresses either. Neither is covered by any existing test. These are genuine, verifiable gaps between the shipped code and the phase's own success criteria, not merely code-quality nitpicks — they represent conditions under which the platform would silently misreport delivery status or lose already-acknowledged events, which is precisely what this phase exists to prevent. The remaining five Warning/Info findings (WR-03 dead-end reconnect on a SendGrid-side-deleted webhook, WR-04 endpoint-row race, WR-05 webhookWarning never surfaced to the user, WR-06 unchunked-insert bind-limit cliff, IN-01 through IN-08) are lower-severity robustness/UX items not blocking the phase goal and are not elevated to gaps here, but should be tracked for follow-up.

---

_Verified: 2026-07-08T20:20:00Z_
_Verifier: Claude (gsd-verifier)_
