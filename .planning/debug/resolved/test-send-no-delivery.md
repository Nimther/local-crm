---
status: resolved
trigger: "Campaign test-send (kind='test') never arrives in the inbox, and the auto-filled sample dynamic_template_data contains a different email than the recipient typed into the test-send input."
created: 2026-07-07T00:00:00Z
updated: 2026-07-07T00:30:00Z
symptoms_prefilled: true
goal: find_root_cause_only
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — test-send jobs fail in the worker because UNSUBSCRIBE_TOKEN_SECRET is not set in dev .env (undocumented + unvalidated env var); sample-email mismatch is working-as-designed (D-18/D-19)
test: Direct inspection of live dev Redis BullMQ failed set (bull:email-broadcast:failed) — failedReason + stacktrace read from actual failed jobs
expecting: n/a — diagnosis complete
next_action: Return ROOT CAUSE FOUND (goal: find_root_cause_only, no fix applied)

reasoning_checkpoint:
  hypothesis: "Test-send jobs throw 'UNSUBSCRIBE_TOKEN_SECRET is not set' in processSendJob's kind='test' branch (send-dispatch.ts:364 -> unsubscribe-token.ts:25), exhaust all 5 BullMQ attempts, and land permanently in the failed set — while the API already returned 202 'queued' to the UI"
  confirming_evidence:
    - "4 failed jobs in live Redis bull:email-broadcast:failed, each failedReason='UNSUBSCRIBE_TOKEN_SECRET is not set', atm=5, stacktrace pointing to signUnsubscribeToken called from send-dispatch.ts:364 (kind='test' branch)"
    - ".env.example at HEAD contains no UNSUBSCRIBE_TOKEN_SECRET and no PUBLIC_APP_URL; scripts/check-env.mjs and apps/api/src/env.ts validate neither — nothing ever forced the user to set them"
    - "Job data in Redis shows the send made it through enqueue with correct payload (testTo=ekaweidl@gmail.com, kind='test'), ruling out enqueue/queue-name/schema failures"
  falsification_test: "If UNSUBSCRIBE_TOKEN_SECRET were set in the worker env, the jobs would have progressed past line 364 and either sent or failed with a different reason — the observed failedReason directly falsifies every alternative"
  fix_rationale: "Adding UNSUBSCRIBE_TOKEN_SECRET (and PUBLIC_APP_URL) to .env + .env.example + check-env.mjs + env validation addresses the root cause: the send pipeline's only unvalidated runtime env dependency"
  blind_spots: "PUBLIC_APP_URL presence unverified (secret error throws first — likely missing too since equally undocumented); whether SendGrid would accept the send after env fix (sender verification, template validity) is unobserved"

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: On a draft campaign, the test-send panel auto-fills sample dynamic_template_data JSON from a real contact in the selected segment (editable), the user enters their own address as recipient, sends, and the email arrives rendered via the tenant's SendGrid Dynamic Template.
actual: "dynamic_template_data содержит не тот же имейл, который указан в инпуте выше блока с тестовым письмом. Тестовое письмо показывается, что отправляется, но не доходит до входящих." Sample JSON's email field differs from the recipient input; test email reported by UI as sent but never reaches the inbox.
errors: None reported in UI. Console errors unknown.
reproduction: UAT Test 4 (.planning/phases/04-broadcast-campaigns-send-pipeline/04-UAT.md). Dev stack npm run dev (api, web, worker), workspace slug "localrent", tenant SendGrid key connected (SendGrid list APIs succeed with this key).
started: Discovered during UAT 2026-07-06, right after Phase 4 send pipeline implementation (plans 04-01..04-15). Related: UAT Test 5 broadcast launch also delivers nothing (0 sent) — shared worker-dispatch root cause plausible. UAT Test 8 (scheduler transitions scheduled->sending within 60s) PASSED, so the worker process itself runs and Redis is connected.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: Worker not consuming email-broadcast queue (unregistered worker / queue-name mismatch)
  evidence: All 6 workers registered in apps/worker/src/server.ts; producer and consumer share EMAIL_BROADCAST_QUEUE constant from @mega-crm/shared-schemas; Redis shows jobs WERE consumed (atm=5, stacktraces recorded by the worker process)
  timestamp: 2026-07-07T00:20:00Z

- hypothesis: SendGrid sandbox_mode silently accepting-but-not-delivering
  evidence: grep across delivery-core and worker found no sandbox anywhere; buildMailSendRequest payload contains no mail_settings; moreover SendGrid was never reached (job threw before the fetch)
  timestamp: 2026-07-07T00:20:00Z

- hypothesis: KMS decryption failure in worker (missing KMS_LOCAL_KEK in worker process)
  evidence: failedReason is 'UNSUBSCRIBE_TOKEN_SECRET is not set', thrown at send-dispatch.ts:364 — BEFORE readSendPrereqs/decryptTenantSecret is ever reached in the test branch (line 387). Both api and worker load the same ../../.env via tsx --env-file, and the api decrypts the key fine (template/sender pickers work)
  timestamp: 2026-07-07T00:20:00Z

- hypothesis: Enqueue failure or job-schema rejection (test-send never reaches the queue)
  evidence: Redis holds the 4 test jobs with fully-parsed correct payloads; emailBroadcastJobSchema includes testTo/testData; API route returns 202 only after successful queue.add
  timestamp: 2026-07-07T00:20:00Z

- hypothesis: Sample dynamic_template_data email mismatch is a code defect (wrong contact substituted)
  evidence: test-sample route (campaigns.routes.ts:504-534) deliberately returns buildContactTemplateData(firstMemberOfSegment) per D-18/D-19; UAT Test 4's own expected text says 'auto-filled from a real contact in the selected segment'. The recipient input only controls delivery address by design. Working-as-designed; at most a UX-copy gap
  timestamp: 2026-07-07T00:20:00Z

- hypothesis: Same root cause as UAT Test 5 (broadcast stuck at 0 sent)
  evidence: "Distinct causes. bull:campaign-kickoff:failed jobs show failedReason='column \"fan_out_complete\" does not exist' — migration packages/db/migrations/0017_campaigns_fan_out_complete.sql exists in repo but is not applied to the live dev DB. Test-send bypasses kickoff entirely. HOWEVER the missing UNSUBSCRIBE_TOKEN_SECRET will ALSO block campaign sends (claimCampaignSend signs the same token at send-dispatch.ts:230-237) once the migration issue is fixed — so the env fix is a prerequisite for Test 5 too"
  timestamp: 2026-07-07T00:20:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-07-07T00:00:00Z
  checked: 04-UAT.md Test 8 result
  found: Scheduler worker picks up scheduled campaigns and transitions them to sending within ~60s — PASSED live
  implication: apps/worker process is running and connected to Redis in the user's dev stack; a totally dead worker process is ruled out. The break is downstream (kickoff/email-broadcast consumption or the send job itself).

- timestamp: 2026-07-07T00:05:00Z
  checked: apps/worker/src/server.ts worker registrations
  found: All 6 workers registered (events-ingest, imports-csv, email-broadcast, email-triggered, campaign-kickoff, campaign-scheduler); queue names from shared constants in both producer and consumer
  implication: "worker not registered" hypothesis weakened; queue name mismatch unlikely (same shared constant)

- timestamp: 2026-07-07T00:05:00Z
  checked: packages/delivery-core/src/send-mail.ts + grep for sandbox
  found: No sandbox_mode anywhere in the payload; raw fetch to api.sendgrid.com/v3/mail/send with Bearer key
  implication: SendGrid sandbox-mode hypothesis ELIMINATED

- timestamp: 2026-07-07T00:05:00Z
  checked: root/worker/api package.json dev scripts + packages/kms env
  found: Both apps/api and apps/worker run "tsx watch --env-file=../../.env src/server.ts" -- same .env file. API process decrypts the tenant key successfully (template/sender list pickers work in UAT), so KMS_LOCAL_KEK is present and correct in .env
  implication: Worker gets the same KMS env; missing-KEK-in-worker hypothesis weakened (not fully eliminated -- decryption in worker still unobserved)

- timestamp: 2026-07-07T00:05:00Z
  checked: apps/worker/src/queues/send-dispatch.ts processSendJob kind='test' branch (lines 353-411)
  found: "For kind='test', a SendGrid 4xx response other than 429 (400/401/403/413) falls through to {outcome:'sent'} -- line 406 only checks status===429 or >=500, and line 410 returns 'sent' for everything else including 4xx. The kind='campaign' branch DOES handle 4xx as failed (line 333)."
  implication: If SendGrid rejects the test send with a 4xx (e.g. unverified from address, bad template), the worker swallows it silently as 'sent' -- matches "UI says sent but nothing arrives". Candidate contributing cause; need to know what SendGrid actually returns

- timestamp: 2026-07-07T00:15:00Z
  checked: apps/api/src/modules/campaigns/campaigns.routes.ts test-send route (lines 446-499) and test-sample route (lines 504-534)
  found: test-send enqueues kind='test' with testTo + user-edited testData onto email-broadcast and returns 202 {queued:true} immediately; test-sample returns buildContactTemplateData(listSegmentMembers(definition,1,1)[0]) — the segment's FIRST member — falling back to a placeholder when the segment is empty
  implication: The UI's 'sent' report only means 'queued'; sample data intentionally shows a real segment contact's data, independent of the recipient input (D-18/D-19)

- timestamp: 2026-07-07T00:15:00Z
  checked: packages/delivery-core/src/unsubscribe-token.ts + scripts/check-env.mjs + apps/api/src/env.ts + .env.example (via git show HEAD)
  found: signUnsubscribeToken -> getSecret() throws when process.env.UNSUBSCRIBE_TOKEN_SECRET unset (line 25); buildListUnsubscribeUrl throws when PUBLIC_APP_URL unset (line 101). NEITHER var appears in .env.example, scripts/check-env.mjs's required list, or apps/api/src/env.ts's zod schema. apps/worker has no env validation at all beyond REDIS_URL
  implication: Nothing in the boot path ever forced these vars to exist; automated tests set them in test setup (which is why 04-03/04-04 suites pass) while the real dev env never had them

- timestamp: 2026-07-07T00:20:00Z
  checked: Live dev Redis (localhost:6379) — bull:email-broadcast:failed and bull:campaign-kickoff:failed
  found: "4 failed test-send jobs (jobIds {workspaceId}-test-{campaignId}-{ts}), each atm=5 attempts, failedReason='UNSUBSCRIBE_TOKEN_SECRET is not set', stacktrace: getSecret (unsubscribe-token.ts:25) -> sign -> signUnsubscribeToken (unsubscribe-token.ts:41) -> send-dispatch.ts:364 (kind='test' branch) -> processSendJob -> email-broadcast.worker.ts:21. Job data intact: testTo=ekaweidl@gmail.com, testData carried real segment-contact properties ('Booking ID':'1952427'). Separately: 2 failed campaign-kickoff jobs with failedReason='column \"fan_out_complete\" does not exist'"
  implication: SMOKING GUN — direct observation of the exact failure, 5 consumed attempts, permanently failed, invisible to the UI which already got 202

- timestamp: 2026-07-07T00:25:00Z
  checked: apps/worker/src/queues/send-dispatch.ts kind='test' response handling (lines 406-410)
  found: Only status===429 || >=500 is treated as failure (rate_limited); ANY other status including 400/401/403/413 falls through to {outcome:'sent'}
  implication: Secondary latent defect — once the env vars are fixed, a SendGrid 4xx rejection of a test send would STILL be silently reported as sent. Not the active cause (SendGrid was never reached) but should be fixed for observability

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: |
  TWO findings, one per sub-symptom:

  (A) Non-delivery (the defect): UNSUBSCRIBE_TOKEN_SECRET is missing from the dev .env.
  It is read only inside packages/delivery-core/src/unsubscribe-token.ts (getSecret, line 23-28),
  is documented nowhere (.env.example lacks it), and is validated nowhere (scripts/check-env.mjs,
  apps/api/src/env.ts, apps/worker boot all silent). Every kind='test' job throws
  'UNSUBSCRIBE_TOKEN_SECRET is not set' at apps/worker/src/queues/send-dispatch.ts:364
  (signUnsubscribeToken for the List-Unsubscribe header), exhausts 5 BullMQ attempts, and lands
  permanently in bull:email-broadcast:failed — after the API already returned 202 'queued' to the UI.
  PUBLIC_APP_URL (unsubscribe-token.ts:99, called immediately after signing) is equally
  undocumented/unvalidated and is the next crash in line once the secret is set.
  The same signing call sits in the campaign path (claimCampaignSend, send-dispatch.ts:230-237),
  so this env gap also blocks broadcast sends (UAT Test 5) — though Test 5's FIRST blocker is a
  different one (unapplied migration 0017: 'column fan_out_complete does not exist' on kickoff).

  (B) Sample-email mismatch (working as designed): the test-sample endpoint
  (campaigns.routes.ts:504-534) intentionally returns buildContactTemplateData for the segment's
  first real member per D-18/D-19 — the JSON previews a real recipient's merge data; the recipient
  input only controls the delivery address. UX-copy gap at most, not a code defect.
fix: ""
verification: ""
files_changed: []

## Closure Note (milestone v1.0 close)

Resolved at v1.0 milestone close on 2026-07-14: diagnosis was handed to plan-phase --gaps; fix shipped via gap-closure plans (see phase 01/04/05/06 gap plans) or recorded as external-env tech debt in v1.0-MILESTONE-AUDIT.md.
