---
status: partial
phase: 04-broadcast-campaigns-send-pipeline
source: [04-01-SUMMARY.md, 04-02-SUMMARY.md, 04-03-SUMMARY.md, 04-04-SUMMARY.md, 04-05-SUMMARY.md, 04-06-SUMMARY.md, 04-07-SUMMARY.md, 04-08-SUMMARY.md, 04-09-SUMMARY.md, 04-10-SUMMARY.md, 04-11-SUMMARY.md, 04-12-SUMMARY.md, 04-13-SUMMARY.md, 04-14-SUMMARY.md]
started: 2026-07-06T14:53:14Z
updated: 2026-07-06T17:47:51Z
---

## Current Test

[testing halted — user-flow step 3 failed (MVP mode: technical checks not run)]

## Tests

### 1. Cold Start Smoke Test
expected: Kill any running dev processes and clear ephemeral state. Start the stack from scratch (`npm run dev` — api, web, worker). All three services boot without errors, migrations complete, and the web app loads at the workspace with live data (no blank screens, no console errors on boot).
result: pass

### 2. Открыть раздел Кампании
expected: In the left nav, click «Кампании». It routes to /w/:slug/campaigns and the nav item shows the active-state accent. The list page renders: existing campaigns with name + status badge (Russian labels, correct colors), or a clean empty state if none exist.
result: pass
note: no campaigns existed yet — empty-state branch confirmed; list-with-badges rendering re-checked in test 3

### 3. Создать draft-кампанию
expected: Click create campaign. In the builder, set a name, pick a segment audience, pick a SendGrid Dynamic Template, and pick a sender. Save. The campaign persists as a draft (visible in the list with «Черновик» badge after reload).
result: issue
reported: "Не могу выбрать сегмент аудитории — сегменты не отображаются. В консоли ошибка http://localhost:5173/api/workspaces/localrent/segments?page=1&pageSize=200 400 (Bad Request)"
severity: blocker

### 4. Тестовое письмо себе
expected: On the draft campaign, open the test-send panel. Sample dynamic_template_data JSON is auto-filled from a real contact in the selected segment and is editable. Send the test to your own address. The email arrives rendered via the SendGrid Dynamic Template.
result: [pending]

### 5. Запуск кампании (immediate launch)
expected: Click launch on the draft. A confirm dialog shows the sendable count plus an exclusion breakdown (suppressed/unsubscribed excluded) BEFORE committing. Confirm. The campaign transitions to «Отправляется» (sending).
result: [pending]

### 6. Живой прогресс отправки
expected: During sending, the campaign detail shows a determinate progress bar (sent / total) that updates via ~3s polling, plus a failed-count line. When done, status becomes «Отправлена» (sent).
result: [pending]

### 7. Письмо дошло до инбокса (outcome)
expected: The broadcast email arrives in a real inbox, rendered from the SendGrid Dynamic Template with your contact's dynamic data. The message carries a one-click List-Unsubscribe header (visible in raw headers), and the unsubscribe link/POST actually unsubscribes the contact.
result: [pending]

### 8. Планирование + scheduler worker
expected: Schedule a second campaign via the datetime-local picker (labelled with your resolved local timezone). It stores UTC and shows status «Запланирована». Within ~60s after the scheduled time, the scheduler worker picks it up and it transitions to sending without manual action.
result: [pending]

### 9. State machine защищает от случайной отправки
expected: A draft with missing template/sender/audience has launch and schedule disabled with inline error copy explaining what is missing. Only draft/canceled campaigns offer delete in the row dropdown; the dropdown also offers duplicate. A sent/sending campaign cannot be deleted or re-launched.
result: [pending]

### 10. Ролевой доступ (Member)
expected: Logged in as a Member (not Owner/Admin): launch/schedule affordances render disabled with a tooltip explaining Owner/Admin is required. The send-settings page shows controls disabled with the same tooltip treatment.
result: [pending]

### 11. Настройки отправки (Owner/Admin)
expected: As Owner/Admin, the send-settings page allows editing the global frequency cap and the optional per-tenant RPS limit; values persist after save and reload.
result: [pending]

### 12. Предупреждение в редакторе сегмента
expected: Open a segment that is referenced by a scheduled campaign and edit it. The editor warns that a scheduled campaign references this segment (D-03) before you save changes.
result: [pending]

### 13. Coverage: suppression-aware queue
expected: Goal-backward check of the user story's capability clause. After the unsubscribe in test 7, launch another broadcast to the same segment: the exclusion breakdown counts the unsubscribed contact, and no email is delivered to it.
result: [pending]

### 14. [04-01] campaigns table supports draft/scheduled/sending/sent/canceled status and references a segment by id with ON DELETE RESTRICT (D-14)
expected: campaigns table supports draft/scheduled/sending/sent/canceled status and references a segment by id with ON DELETE RESTRICT (D-14)
result: pass
source: automated
coverage_id: D1

### 15. [04-01] sends table enforces one (workspace_id, campaign_id, contact_id) attempt via a UNIQUE constraint, preventing duplicate sends on job retry
expected: sends table enforces one (workspace_id, campaign_id, contact_id) attempt via a UNIQUE constraint, preventing duplicate sends on job retry
result: pass
source: automated
coverage_id: D2

### 16. [04-01] Frequency-cap lookup on sends by (workspace_id, contact_id, sent_at) is index-backed, not a sequential scan
expected: Frequency-cap lookup on sends by (workspace_id, contact_id, sent_at) is index-backed, not a sequential scan
result: pass
source: automated
coverage_id: D3

### 17. [04-01] All four new tables enforce workspace isolation via ENABLE + FORCE ROW LEVEL SECURITY + workspace_isolation policy
expected: All four new tables enforce workspace isolation via ENABLE + FORCE ROW LEVEL SECURITY + workspace_isolation policy
result: pass
source: automated
coverage_id: D4

### 18. [04-01] packages/db and packages/shared-schemas both typecheck clean; queue constants are dash-separated with job schemas carrying workspaceId
expected: packages/db and packages/shared-schemas both typecheck clean; queue constants are dash-separated with job schemas carrying workspaceId
result: pass
source: automated
coverage_id: D5

### 19. [04-02] @mega-crm/kms package exports encryptTenantSecret/decryptTenantSecret/EncryptedSecret, importable from both apps/api and (once 04-04 wires it) apps/worker; apps/api's existing SendGrid-key connect/recheck flow is unregressed
expected: @mega-crm/kms package exports encryptTenantSecret/decryptTenantSecret/EncryptedSecret, importable from both apps/api and (once 04-04 wires it) apps/worker; apps/api's existing SendGrid-key connect/recheck flow is unregressed
result: pass
source: automated
coverage_id: D1

### 20. [04-02] listTenantSendGridTemplates(apiKey) added to sendgrid-client.ts: GET /v3/templates?generations=dynamic&page_size=200 with the same raw-fetch Bearer-key convention, returns [] on non-ok, no local caching, does not import @sendgrid/mail's singleton
expected: listTenantSendGridTemplates(apiKey) added to sendgrid-client.ts: GET /v3/templates?generations=dynamic&page_size=200 with the same raw-fetch Bearer-key convention, returns [] on non-ok, no local caching, does not import @sendgrid/mail's singleton
result: pass
source: automated
coverage_id: D2

### 21. [04-03] HMAC-signed unsubscribe token binds sendId+contactId+workspaceId+exp; round-trips for a valid token and returns null for any tampered payload or signature (SUBS-04, T-04-03-01)
expected: HMAC-signed unsubscribe token binds sendId+contactId+workspaceId+exp; round-trips for a valid token and returns null for any tampered payload or signature (SUBS-04, T-04-03-01)
result: pass
source: automated
coverage_id: D1

### 22. [04-03] buildContactTemplateData produces exactly the documented D-18 snake_case key set (first_name/last_name/email/phone/city/country/tags/properties/unsubscribe_url), with no reserved column leaking
expected: buildContactTemplateData produces exactly the documented D-18 snake_case key set (first_name/last_name/email/phone/city/country/tags/properties/unsubscribe_url), with no reserved column leaking
result: pass
source: automated
coverage_id: D2

### 23. [04-03] evaluatePreSendGate returns each of suppressed/unsubscribed/no_email/frequency_cap for its condition and sendable:true on the happy path, using the index-backed rolling-window count query (SUBS-03/SEND-04/D-04/D-14)
expected: evaluatePreSendGate returns each of suppressed/unsubscribed/no_email/frequency_cap for its condition and sendable:true on the happy path, using the index-backed rolling-window count query (SUBS-03/SEND-04/D-04/D-14)
result: pass
source: automated
coverage_id: D3

### 24. [04-03] dispatchSendGate is idempotent -- returns the sendId to proceed on a fresh insert, and 'skipped' when a redelivered job finds the existing row already status='sent'
expected: dispatchSendGate is idempotent -- returns the sendId to proceed on a fresh insert, and 'skipped' when a redelivered job finds the existing row already status='sent'
result: pass
source: automated
coverage_id: D4

### 25. [04-03] getWorkspaceSendSettings returns 3/24/null defaults when no workspace_send_settings row exists (D-13)
expected: getWorkspaceSendSettings returns 3/24/null defaults when no workspace_send_settings row exists (D-13)
result: pass
source: automated
coverage_id: D5

### 26. [04-03] POST /unsubscribe/:token with a valid token flips subscription_status to unsubscribed and returns 200 with an empty body; repeated POSTs are a safe no-op
expected: POST /unsubscribe/:token with a valid token flips subscription_status to unsubscribed and returns 200 with an empty body; repeated POSTs are a safe no-op
result: pass
source: automated
coverage_id: D6

### 27. [04-03] GET /unsubscribe/:token renders an HTML confirm page and never mutates subscription_status
expected: GET /unsubscribe/:token renders an HTML confirm page and never mutates subscription_status
result: pass
source: automated
coverage_id: D7

### 28. [04-03] Enumeration-oracle safety: a forged token, an expired token, and a valid-but-unknown-contact token all produce byte-identical (POST) or shape-identical (GET) responses
expected: Enumeration-oracle safety: a forged token, an expired token, and a valid-but-unknown-contact token all produce byte-identical (POST) or shape-identical (GET) responses
result: pass
source: automated
coverage_id: D8

### 29. [04-04] A sendable contact's broadcast send job decrypts the tenant SendGrid key, passes the pre-send gate, calls SendGrid, and is recorded 'sent' -- carrying List-Unsubscribe + List-Unsubscribe-Post headers built from a per-message signed token (SEND-05, SUBS-03, SUBS-04)
expected: A sendable contact's broadcast send job decrypts the tenant SendGrid key, passes the pre-send gate, calls SendGrid, and is recorded 'sent' -- carrying List-Unsubscribe + List-Unsubscribe-Post headers built from a per-message signed token (SEND-05, SUBS-03, SUBS-04)
result: pass
source: automated
coverage_id: D1

### 30. [04-04] A redelivered job for an already-'sent' contact calls SendGrid 0 times and creates no second sends row (SEND-06)
expected: A redelivered job for an already-'sent' contact calls SendGrid 0 times and creates no second sends row (SEND-06)
result: pass
source: automated
coverage_id: D2

### 31. [04-04] An unsubscribed/suppressed/frequency-capped contact is recorded 'excluded' with its reason and SendGrid is never called (SUBS-03)
expected: An unsubscribed/suppressed/frequency-capped contact is recorded 'excluded' with its reason and SendGrid is never called (SUBS-03)
result: pass
source: automated
coverage_id: D3

### 32. [04-04] A test send (kind='test') rides the same queue but skips the pre-send gate and the ledger insert (D-12)
expected: A test send (kind='test') rides the same queue but skips the pre-send gate and the ledger insert (D-12)
result: pass
source: automated
coverage_id: D4

### 33. [04-04] A SendGrid 429/5xx response yields {outcome:'rate_limited'} without recording a terminal status, and a subsequent redelivery of the same job still succeeds and records exactly one sent row (SEND-07, no consumed retry attempt)
expected: A SendGrid 429/5xx response yields {outcome:'rate_limited'} without recording a terminal status, and a subsequent redelivery of the same job still succeeds and records exactly one sent row (SEND-07, no consumed retry attempt)
result: pass
source: automated
coverage_id: D5

### 34. [04-04] The per-tenant token bucket gates a send once the workspace's configured RPS is exhausted, scoped independently per workspaceId (SEND-02/SEND-03)
expected: The per-tenant token bucket gates a send once the workspace's configured RPS is exhausted, scoped independently per workspaceId (SEND-02/SEND-03)
result: pass
source: automated
coverage_id: D6

### 35. [04-04] email-broadcast and email-triggered are two separate BullMQ queues with independent workers/concurrency, registered in apps/worker/src/server.ts, with no BullMQ limiter option and no @sendgrid/mail singleton import (SEND-01/SEND-03)
expected: email-broadcast and email-triggered are two separate BullMQ queues with independent workers/concurrency, registered in apps/worker/src/server.ts, with no BullMQ limiter option and no @sendgrid/mail singleton import (SEND-01/SEND-03)
result: pass
source: automated
coverage_id: D7

### 36. [04-05] draft -> sending succeeds when template/sender/segment are all set (CAMP-01/CAMP-02), sending_started_at is stamped
expected: draft -> sending succeeds when template/sender/segment are all set (CAMP-01/CAMP-02), sending_started_at is stamped
result: pass
source: automated
coverage_id: D1

### 37. [04-05] launchCampaign rejects as CampaignStateError('incomplete') when template/sender is missing
expected: launchCampaign rejects as CampaignStateError('incomplete') when template/sender is missing
result: pass
source: automated
coverage_id: D2

### 38. [04-05] There is no repository code path from draft directly to a terminal state -- cancelCampaign rejects a plain draft as 'illegal_transition', and launchCampaign only ever produces 'sending' (CAMP-03/D-08)
expected: There is no repository code path from draft directly to a terminal state -- cancelCampaign rejects a plain draft as 'illegal_transition', and launchCampaign only ever produces 'sending' (CAMP-03/D-08)
result: pass
source: automated
coverage_id: D3

### 39. [04-05] updateCampaign on a scheduled campaign is rejected (D-08, no in-place edit of a scheduled campaign)
expected: updateCampaign on a scheduled campaign is rejected (D-08, no in-place edit of a scheduled campaign)
result: pass
source: automated
coverage_id: D4

### 40. [04-05] scheduled -> draft cancel clears scheduled_at (D-07); sending -> canceled stamps terminal_at and preserves counters (D-09)
expected: scheduled -> draft cancel clears scheduled_at (D-07); sending -> canceled stamps terminal_at and preserves counters (D-09)
result: pass
source: automated
coverage_id: D5

### 41. [04-05] duplicateCampaign creates a new draft copying segment/template/sender (D-11)
expected: duplicateCampaign creates a new draft copying segment/template/sender (D-11)
result: pass
source: automated
coverage_id: D6

### 42. [04-05] Role gates present on launch/schedule/cancel/duplicate and send-settings PUT (D-19); no direct SendGrid mail/send call in campaigns.routes.ts (test-send always enqueues kind='test')
expected: Role gates present on launch/schedule/cancel/duplicate and send-settings PUT (D-19); no direct SendGrid mail/send call in campaigns.routes.ts (test-send always enqueues kind='test')
result: pass
source: automated
coverage_id: D7

### 43. [04-05] Deleting a segment referenced by a non-canceled campaign is blocked with a 409 (D-03/Phase 3 D-14)
expected: Deleting a segment referenced by a non-canceled campaign is blocked with a 409 (D-03/Phase 3 D-14)
result: pass
source: automated
coverage_id: D8

### 44. [04-05] apps/api typechecks; full apps/api test suite (143 tests) passes after all three tasks
expected: apps/api typechecks; full apps/api test suite (143 tests) passes after all three tasks
result: pass
source: automated
coverage_id: D9

### 45. [04-06] Batched, resumable recipient-snapshot materialization freezing segment membership into campaign_recipients via keyset pagination, reusing compileSegmentDefinition
expected: Batched, resumable recipient-snapshot materialization freezing segment membership into campaign_recipients via keyset pagination, reusing compileSegmentDefinition
result: pass
source: automated
coverage_id: D1

### 46. [04-06] Campaign-kickoff worker: snapshot -> per-recipient pre-send gate -> D-04 exclusion breakdown persisted -> fan-out to email-broadcast with deterministic jobId; empty audience completes to 'sent' with 0 sent (D-05); redelivered kickoff is a safe no-op once fan_out_complete is set
expected: Campaign-kickoff worker: snapshot -> per-recipient pre-send gate -> D-04 exclusion breakdown persisted -> fan-out to email-broadcast with deterministic jobId; empty audience completes to 'sent' with 0 sent (D-05); redelivered kickoff is a safe no-op once fan_out_complete is set
result: pass
source: automated
coverage_id: D2

### 47. [04-09] A campaign configured only with fromSenderId (no fromEmail) resolves to a concrete verified sender email, persisted to campaigns.from_email, before launch enqueues the kickoff job
expected: A campaign configured only with fromSenderId (no fromEmail) resolves to a concrete verified sender email, persisted to campaigns.from_email, before launch enqueues the kickoff job
result: pass
source: automated
coverage_id: D1

### 48. [04-09] A test send from a fromSenderId-only campaign resolves and persists the verified sender email before enqueuing
expected: A test send from a fromSenderId-only campaign resolves and persists the verified sender email before enqueuing
result: pass
source: automated
coverage_id: D2

### 49. [04-09] Launch/test-send of a campaign whose fromSenderId does not match any verified sender fails closed with 422 (never enqueues an undispatchable job)
expected: Launch/test-send of a campaign whose fromSenderId does not match any verified sender fails closed with 422 (never enqueues an undispatchable job)
result: pass
source: automated
coverage_id: D3

### 50. [04-10] recordExcluded never demotes an already-'sent' row when a kickoff re-walk redelivers the same (workspace, campaign, contact) exclusion call
expected: recordExcluded never demotes an already-'sent' row when a kickoff re-walk redelivers the same (workspace, campaign, contact) exclusion call
result: pass
source: automated
coverage_id: D1

### 51. [04-10] recordExcluded never demotes an in-flight 'dispatching' row (a send still being processed when the exclusion re-walk runs)
expected: recordExcluded never demotes an in-flight 'dispatching' row (a send still being processed when the exclusion re-walk runs)
result: pass
source: automated
coverage_id: D2

### 52. [04-10] Normal exclusion recording (fresh insert) and re-classification of an already-'excluded' row are unchanged by the guard
expected: Normal exclusion recording (fresh insert) and re-classification of an already-'excluded' row are unchanged by the guard
result: pass
source: automated
coverage_id: D3

### 53. [04-11] GET /unsubscribe/:token never reflects an attacker-controlled token unescaped into the form action; malformed tokens are not echoed at all
expected: GET /unsubscribe/:token never reflects an attacker-controlled token unescaped into the form action; malformed tokens are not echoed at all
result: pass
source: automated
coverage_id: D1

### 54. [04-11] Every response carries a script-blocking Content-Security-Policy header via @fastify/helmet
expected: Every response carries a script-blocking Content-Security-Policy header via @fastify/helmet
result: pass
source: automated
coverage_id: D2

### 55. [04-11] RFC 8058 one-click unsubscribe (SUBS-04) still works: a valid signed token unsubscribes the contact and returns 2xx
expected: RFC 8058 one-click unsubscribe (SUBS-04) still works: a valid signed token unsubscribes the contact and returns 2xx
result: pass
source: automated
coverage_id: D3

### 56. [04-12] A worker crash after the 'dispatching' claim commits but before a terminal status is recorded never causes a duplicate SendGrid call on redelivery
expected: A worker crash after the 'dispatching' claim commits but before a terminal status is recorded never causes a duplicate SendGrid call on redelivery
result: pass
source: automated
coverage_id: D1

### 57. [04-12] A non-retryable SendGrid 4xx (400/401/403/413) is recorded as status='failed' on the sends row, never as 'sent'
expected: A non-retryable SendGrid 4xx (400/401/403/413) is recorded as status='failed' on the sends row, never as 'sent'
result: pass
source: automated
coverage_id: D2

### 58. [04-12] A SendGrid 429/5xx releases the dispatch claim so a clean backoff retry re-attempts the send, without consuming a retry attempt
expected: A SendGrid 429/5xx releases the dispatch claim so a clean backoff retry re-attempts the send, without consuming a retry attempt
result: pass
source: automated
coverage_id: D3

### 59. [04-13] A non-empty-audience campaign advances sent_count live and transitions sending -> sent with terminal_at set once every sendable recipient has a terminal send
expected: A non-empty-audience campaign advances sent_count live and transitions sending -> sent with terminal_at set once every sendable recipient has a terminal send
result: pass
source: automated
coverage_id: D1

### 60. [04-13] A fully-failed campaign (every send 4xx) still terminates to 'sent' with a visible failed_count instead of staying stuck
expected: A fully-failed campaign (every send 4xx) still terminates to 'sent' with a visible failed_count instead of staying stuck
result: pass
source: automated
coverage_id: D2

### 61. [04-13] Canceling a sending campaign stops in-flight dispatch: a claimed send for a canceled campaign is skipped (0 SendGrid calls, no send row) and counters stay frozen
expected: Canceling a sending campaign stops in-flight dispatch: a claimed send for a canceled campaign is skipped (0 SendGrid calls, no send row) and counters stay frozen
result: pass
source: automated
coverage_id: D3

### 62. [04-13] Counter increments/completion never fire for a campaign that has already left 'sending' (e.g. an already-'sent' campaign)
expected: Counter increments/completion never fire for a campaign that has already left 'sending' (e.g. an already-'sent' campaign)
result: pass
source: automated
coverage_id: D4

### 63. [04-13] campaign-kickoff.worker.ts's fan-out loop re-reads status per page and stops enqueuing once the campaign is canceled/sent (no regression to existing empty/non-empty kickoff behavior)
expected: campaign-kickoff.worker.ts's fan-out loop re-reads status per page and stops enqueuing once the campaign is canceled/sent (no regression to existing empty/non-empty kickoff behavior)
result: pass
source: automated
coverage_id: D5

### 64. [04-14] Mailbox-provider RFC 8058 one-click POST (urlencoded, List-Unsubscribe=One-Click body) to /unsubscribe/:token returns 2xx and flips the contact to subscription_status=unsubscribed
expected: Mailbox-provider RFC 8058 one-click POST (urlencoded, List-Unsubscribe=One-Click body) to /unsubscribe/:token returns 2xx and flips the contact to subscription_status=unsubscribed
result: pass
source: automated
coverage_id: D1

### 65. [04-14] Confirm page's own <form method=POST> submission (urlencoded, empty body) to /unsubscribe/:token returns 2xx and flips the contact to subscription_status=unsubscribed
expected: Confirm page's own <form method=POST> submission (urlencoded, empty body) to /unsubscribe/:token returns 2xx and flips the contact to subscription_status=unsubscribed
result: pass
source: automated
coverage_id: D2

### 66. [04-14] The urlencoded parser is scoped to the unsubscribe routes only -- an unregistered content type (application/xml) on the same POST route still returns 415, proving the fix is narrow
expected: The urlencoded parser is scoped to the unsubscribe routes only -- an unregistered content type (application/xml) on the same POST route still returns 415, proving the fix is narrow
result: pass
source: automated
coverage_id: D3

## Summary

total: 66
passed: 55
issues: 1
pending: 10
skipped: 0
blocked: 0

## Gaps

- truth: "Campaign builder lets the user pick a segment audience: segments load and are selectable"
  status: failed
  reason: "User reported: Не могу выбрать сегмент аудитории — сегменты не отображаются. В консоли ошибка http://localhost:5173/api/workspaces/localrent/segments?page=1&pageSize=200 400 (Bad Request)"
  severity: blocker
  test: 3
  root_cause: ""
  artifacts: []
  missing: []
  debug_session: ""
