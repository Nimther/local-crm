---
status: diagnosed
trigger: "campaign-metrics-zero-despite-events — Webhook events arrive (health card 'Последнее событие получено' updates) but test campaign per-campaign metrics (delivered/opened) remain zero even though the email was delivered and opened."
created: 2026-07-09T00:00:00Z
updated: 2026-07-09T00:00:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — SendGrid Event Webhook flattens mail/send custom_args into TOP-LEVEL event fields; the worker reads a nested `event.custom_args.send_id` which never exists, so every event stores send_id=NULL and the attribution/counter side-effect loop is skipped.
test: Queried live-UAT payloads stored in send_events.payload (dev DB mega_crm) and cross-checked against sends/campaigns rows.
expecting: n/a — diagnosis complete
next_action: Return ROOT CAUSE FOUND (goal: find_root_cause_only — no fix in this session)

reasoning_checkpoint:
  hypothesis: "extractEventRow in webhook-events.worker.ts reads event.custom_args?.send_id, but SendGrid delivers custom args merged into the event JSON root (send_id/workspace_id/campaign_id as top-level keys, no custom_args wrapper) — so sendId is always null, side effects never run, counters stay 0, while the batch still commits and debounceWebhookHealth still updates the health timestamp."
  confirming_evidence:
    - "Real stored payload (send_events, received 2026-07-09 20:23:04+05, event=delivered, email=primero@nimther.com): top-level keys send_id=e5630c1e-0948-48fb-8f87-00b50c918772, campaign_id=20b1cfbd-81ad-4976-abe7-9e5a0ccce817, workspace_id=8f518f6a-...; NO custom_args key anywhere in the JSON."
    - "All 46 send_events rows have send_id column NULL (count(send_id)=0) and is_test=false."
    - "sends row e5630c1e-... exists: kind=campaign, status=sent, campaign_id=20b1cfbd-..., delivered_at/first_opened_at/first_clicked_at all NULL despite the delivered+click events above."
    - "campaigns row 20b1cfbd-... ('12121'): sent_count=1, delivered/opened/clicked/bounced/unsubscribed counts all 0."
  falsification_test: "If a stored real payload had contained a nested custom_args object, or if send_events rows had non-null send_id, the hypothesis would be wrong. Neither is the case."
  fix_rationale: "Read the custom-arg markers from the event object's top level (send_id, workspace_id, campaign_id, test) in extractEventRow — that is the shape SendGrid actually posts; the mail/send REQUEST correctly nests them under personalizations[].custom_args, but the Event Webhook flattens them on delivery."
  blind_spots: "Did not re-run the pipeline with a corrected extractor (diagnosis-only constraints); confidence rests on direct payload evidence which is unambiguous."

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Webhook events delivered to the platform are attributed to the test campaign — campaign metrics (delivered/opened) increment when the email is delivered and opened. (UAT Test 4, Phase 05 webhook-processing-delivery-tracking)
actual: "последнее событие обновляется, но в тестовой кампании события по нулям, хотя письмо дошло и было открыто." — last-event-received timestamp updates (signed webhook events ARE received and processed far enough to touch the health record), but the campaign's event counters stay at zero.
errors: None reported
reproduction: Test 4 in .planning/phases/05-webhook-processing-delivery-tracking/05-UAT.md — live SendGrid key over https tunnel, webhook provisioned (UAT Tests 1 and 3 passed), test broadcast campaign sent, email delivered and opened in a real inbox.
started: Discovered during UAT round 5 (2026-07-09), after gap-closure round 4 (plan 05-12) fixed the https PUBLIC_APP_URL provisioning issue. First round where events actually flow end-to-end.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: Send pipeline fails to attach custom_args (send_id/campaign_id) at mail/send time
  evidence: packages/delivery-core/src/send-mail.ts buildMailSendRequest correctly sets personalizations[0].custom_args = { send_id, workspace_id, campaign_id } — and the stored real webhook payloads for primero@nimther.com contain those exact values (as top-level fields), proving they were attached and round-tripped through SendGrid.
  timestamp: 2026-07-09

- hypothesis: is_test flag wrongly set on the campaign send, so side effects were skipped by the D-15 test gate
  evidence: All 46 send_events rows have is_test=false; sends row e5630c1e-... has kind='campaign'.
  timestamp: 2026-07-09

- hypothesis: delivered/open event types not enabled on the provisioned webhook
  evidence: sendgrid-webhook-provision.ts EVENT_FLAGS enables delivered/bounce/dropped/open/click/unsubscribe/group_unsubscribe/spam_report; delivered, open, and click events are all present in send_events.
  timestamp: 2026-07-09

- hypothesis: normalizeEventType drops delivered/open events
  evidence: packages/delivery-core/src/event-normalize.ts maps "delivered"→delivered and "open"→open directly.
  timestamp: 2026-07-09

- hypothesis: workspace/RLS scoping hides the sends row from the worker's live-send resolution query
  evidence: Never reached — sendId is already null at extraction time, before the `SELECT id FROM sends ... = ANY(...)` resolution runs. The sends row exists in the same workspace (8f518f6a-...) referenced by the payload.
  timestamp: 2026-07-09

- hypothesis: metrics UI/aggregation reads a different table than the webhook worker writes
  evidence: Both use campaigns.delivered_count/opened_count/... (incrementCampaignCounter writes campaigns columns; UI counter rows read the campaign response). The counters are genuinely 0 in the DB — not a display/query mismatch.
  timestamp: 2026-07-09

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-07-09
  checked: apps/worker/src/queues/webhook-events.worker.ts extractEventRow (lines 74–86)
  found: Reads `event.custom_args` object and `customArgs?.send_id` / `customArgs?.test` from it; if absent → sendId=null, isTest=false. Rows with sendId=null are inserted into send_events but skipped by the side-effect loop (`if (row.sendId === null) continue;` line 387). debounceWebhookHealth (last_event_at) runs unconditionally per committed batch.
  implication: A payload without a nested custom_args key still updates the health timestamp but can never increment campaign counters — exactly the reported symptom split.

- timestamp: 2026-07-09
  checked: packages/delivery-core/src/send-mail.ts buildMailSendRequest
  found: mail/send request correctly nests custom_args { send_id, workspace_id, campaign_id, test? } under personalizations[0] — correct per SendGrid v3 mail/send API.
  implication: Send side is fine; the mismatch is on the webhook-read side.

- timestamp: 2026-07-09
  checked: Dev DB mega_crm (localhost:5432) — send_events table, live UAT data from 2026-07-09
  found: 46 rows total; count(send_id)=0 — NOT ONE event row has a resolved send_id; 0 test rows. Event types include delivered, open, click.
  implication: Attribution failed for 100% of received events, including the platform's own.

- timestamp: 2026-07-09
  checked: Raw payload of the two events for primero@nimther.com (the test-campaign recipient)
  found: delivered (20:23:04+05) and click (20:25:10+05) events contain `"send_id": "e5630c1e-0948-48fb-8f87-00b50c918772"`, `"campaign_id": "20b1cfbd-81ad-4976-abe7-9e5a0ccce817"`, `"workspace_id": "8f518f6a-dbeb-4a25-b0cc-1b0ee713923f"` as TOP-LEVEL JSON keys. NO `custom_args` key exists in any stored payload.
  implication: SendGrid's Event Webhook merges mail/send custom_args into the event object root (documented SendGrid behavior — "unique arguments will be received in the event data as individual fields"). The worker's nested read can never match.

- timestamp: 2026-07-09
  checked: sends and campaigns rows for the test campaign
  found: sends e5630c1e-...: kind=campaign, status=sent, campaign_id set, delivered_at/first_opened_at/first_clicked_at all NULL. campaigns 20b1cfbd-... ('12121'): sent_count=1, all five event counters 0.
  implication: The delivered event that SHOULD have set delivered_at and incremented delivered_count arrived and was stored — but unattributed.

- timestamp: 2026-07-09
  checked: apps/worker/src/queues/__tests__/webhook-events-{status,idempotency,suppression}.test.ts fixtures
  found: Every test payload constructs events with a NESTED `custom_args: { send_id, workspace_id, campaign_id }` object — the same wrong shape assumption as the worker.
  implication: All automated tests pass against a payload shape SendGrid never sends; this is why the bug survived until live UAT. Matches the pre-existing STATE.md Phase-5 research flag: "integration test that replays a real signed SendGrid payload through the full HTTP stack".

- timestamp: 2026-07-09
  checked: Remaining 44 of 46 stored events
  found: They belong to unrelated production traffic on the same shared SendGrid account (localrent booking emails — recipients like b.bozovic1986@gmail.com, categories "[B2B] Booking Reserved", "[B2C] Booking Voucher"), carrying no platform markers at all.
  implication: Secondary observation (not the root cause): the account-level Event Webhook receives ALL account mail events; D-15 orphan handling stores them with send_id=null. Worth noting for data-volume/privacy hygiene, but by design.

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: SendGrid's Event Webhook delivers mail/send custom_args merged into the event JSON as individual TOP-LEVEL fields (send_id, workspace_id, campaign_id, test) — there is no nested custom_args object in webhook payloads. extractEventRow in apps/worker/src/queues/webhook-events.worker.ts reads event.custom_args?.send_id, which is always undefined for real SendGrid events, so every event is stored with send_id=NULL and the entire attribution side-effect chain (sends fact columns + campaigns counter increments) is skipped, while debounceWebhookHealth still updates the health timestamp — producing exactly "last event updates, campaign metrics zero". Test fixtures encode the same wrong nested shape, which is why 100% of automated tests pass.
fix: (diagnosis-only session — direction for plan-phase --gaps) In extractEventRow, read the markers from the event object's top level: send_id ← event.send_id (UUID-validated as today), isTest ← event.test === "true". Optionally keep the nested custom_args read as a defensive fallback. Update all webhook-events test fixtures to the real flattened payload shape, and add the long-flagged integration test replaying a REAL captured SendGrid payload (two verbatim samples now exist in send_events.payload). Optional one-time backfill: re-attribute stored send_events rows whose payload->>'send_id' resolves to a live send.
verification:
files_changed: []
