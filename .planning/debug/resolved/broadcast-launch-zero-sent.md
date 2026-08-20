---
status: resolved
trigger: "Launching a broadcast campaign transitions it to «Отправляется» but hangs at «0 отправленных» and no recipient ever receives an email. BLOCKER (UAT test 5). Test-send (test 4) also never arrives — same pipeline."
created: 2026-07-07T00:00:00Z
updated: 2026-07-07T00:40:00Z
---

## Current Focus
<!-- OVERWRITE on each update - reflects NOW -->

hypothesis: CONFIRMED — two independent root causes, both proven by live failed-job state in Redis + live DB schema inspection.
test: n/a — diagnosis complete (goal: find_root_cause_only)
next_action: Return ROOT CAUSE FOUND to orchestrator

reasoning_checkpoint:
  hypothesis: "(1) Kickoff worker crashes on its first query because the live dev DB is missing campaigns.fan_out_complete — migrations 0017–0019 exist in the repo/journal but were never applied (last db:migrate run predates them; `npm run dev` has no migrate step). (2) Every send job (test AND campaign) crashes at signUnsubscribeToken because UNSUBSCRIBE_TOKEN_SECRET is absent from the worker's runtime env — it is only injected in vitest configs and is not in .env.example nor validated at boot."
  confirming_evidence:
    - "bull:campaign-kickoff:failed contains both launched campaigns' jobs, failedReason='column \"fan_out_complete\" does not exist', 5/5 attempts exhausted, stacktrace at campaign-kickoff.worker.ts:53 (the entry SELECT)."
    - "psql information_schema on live mega_crm DB: campaigns has 19 columns, no fan_out_complete; drizzle.__drizzle_migrations has 17 rows whose created_at values map 1:1 to journal entries 0000–0016; journal entries 0017–0019 (when=.287/.288/.289) absent from DB."
    - "bull:email-broadcast:failed contains 4 test-send jobs, failedReason='UNSUBSCRIBE_TOKEN_SECRET is not set', stacktrace at unsubscribe-token.ts:25 via send-dispatch.ts:364."
    - "signUnsubscribeToken is also called at send-dispatch.ts:231 inside the campaign claim path — campaign sends would fail identically after fix 1."
  falsification_test: "If fan_out_complete existed in the live DB or kickoff jobs were in wait/active instead of failed, hypothesis 1 would be wrong. If UNSUBSCRIBE_TOKEN_SECRET were present in the worker process env, jobs would have failed elsewhere. Both observations went the confirming way."
  fix_rationale: "n/a — diagnose-only mode; fix direction handed to planner."
  blind_spots: "Cannot read the developer's actual .env (sandbox denies env-file access) — but the runtime error in the worker process IS direct proof the variable was absent at job time. Did not verify SendGrid dispatch succeeds after both fixes (KMS decrypt, sender identity) — no send has ever reached the SendGrid call yet."

## Symptoms
<!-- Written during gathering, then IMMUTABLE -->

expected: Confirming launch enqueues campaign-kickoff job; kickoff worker snapshots segment membership into campaign_recipients, runs pre-send gate, persists exclusion breakdown, fans out per-contact jobs to email-broadcast queue with deterministic jobIds; send worker decrypts tenant SendGrid key and dispatches; sent_count advances live (~3s polling); campaign transitions to «Отправлена».
actual: "Диалог открывается, кампания показывает, что отправляется, но несколько минут висит «0 отправленных». Во входящих у получателей тоже ничего нет." Confirm dialog worked (sendable count + exclusion breakdown shown), status transition to sending worked, but sent_count stays 0 and nothing delivered.
errors: None in UI. Worker logs unknown at report time (now recovered from Redis failed-job stacktraces).
reproduction: UAT test 5 (.planning/phases/04-broadcast-campaigns-send-pipeline/04-UAT.md). Dev stack npm run dev (api, web, worker), workspace slug "localrent", tenant SendGrid key connected. Small local test segment. Test-send (kind='test') also never arrives (test 4).
started: Discovered during UAT 2026-07-06. Phase 4 (04-01..04-15) just implemented the whole pipeline.

## Eliminated
<!-- APPEND only - prevents re-investigating -->

- hypothesis: Queue-name mismatch between producer and consumer
  evidence: Both sides import CAMPAIGN_KICKOFF_QUEUE/EMAIL_BROADCAST_QUEUE from @mega-crm/shared-schemas ("campaign-kickoff"/"email-broadcast"); Redis shows jobs were consumed and FAILED inside the worker — proof of consumption.
  timestamp: 2026-07-07T00:15:00Z
- hypothesis: Worker not registered in apps/worker/src/server.ts dev entrypoint
  evidence: server.ts registers all six workers (events-ingest, imports-csv, email-broadcast, email-triggered, campaign-kickoff, campaign-scheduler); failed jobs carry stacktraces from the worker's own source files.
  timestamp: 2026-07-07T00:15:00Z
- hypothesis: Redis connection/db-index divergence between api and worker
  evidence: Single Redis at 127.0.0.1:6379 holds both the producer's enqueued jobs and the consumer's failure records for the same job ids; identical buildRedisConnectionOptions URL parsing in both apps.
  timestamp: 2026-07-07T00:15:00Z
- hypothesis: Kickoff job never enqueued by launch route
  evidence: bull:campaign-kickoff:failed contains jobs with jobId=campaignId for both launched campaigns (0b24f2f3…, 3365b11c…) with correct {workspaceId, campaignId} payloads.
  timestamp: 2026-07-07T00:18:00Z
- hypothesis: Per-tenant token bucket blocks forever (rps=null mishandled as 0)
  evidence: Jobs did not stall — they failed fast with explicit DB/env errors before ever reaching consumeTenantToken; queues show 0 wait/active/delayed.
  timestamp: 2026-07-07T00:20:00Z
- hypothesis: KMS decryption failing in dev env
  evidence: No failure mentions KMS; test-send failures occur at signUnsubscribeToken (send-dispatch.ts:364) which precedes any SendGrid dispatch; kickoff failures occur before any send-path code runs. (KMS path remains unexercised — flagged as blind spot, not as a cause of THIS symptom.)
  timestamp: 2026-07-07T00:25:00Z

## Evidence
<!-- APPEND only - facts discovered -->

- timestamp: 2026-07-07T00:10:00Z
  checked: apps/worker/src/server.ts + queue constants (packages/shared-schemas/src/queues.ts) + producers (apps/api/src/modules/campaigns/campaign-queues.ts, apps/worker/src/queues/campaign-broadcast-producer.ts)
  found: All six workers registered; queue names consistent ("campaign-kickoff", "email-broadcast", "email-triggered")
  implication: Wiring/topology is correct; failure must be inside job processing
- timestamp: 2026-07-07T00:15:00Z
  checked: Live Redis (127.0.0.1:6379) BullMQ state for send-pipeline queues
  found: campaign-kickoff — 0 wait/active/delayed, 2 FAILED; email-broadcast — 0 wait/active/delayed, 4 FAILED (all kind='test'); email-triggered empty
  implication: Jobs WERE enqueued and consumed; every single one failed and exhausted retries — the pipeline is dead, not stalled
- timestamp: 2026-07-07T00:18:00Z
  checked: HGETALL on both failed campaign-kickoff jobs
  found: failedReason='column "fan_out_complete" does not exist' on all 5 attempts of both jobs; stacktrace → campaign-kickoff.worker.ts:53 (entry SELECT status, fan_out_complete FROM campaigns); error from pg (Postgres server error, not a typo caught locally)
  implication: The live dev database schema is missing campaigns.fan_out_complete — the kickoff worker dies on its FIRST query, before snapshot/fan-out; sent_count can never advance
- timestamp: 2026-07-07T00:20:00Z
  checked: HGET failedReason/stacktrace on failed email-broadcast test-send jobs
  found: failedReason='UNSUBSCRIBE_TOKEN_SECRET is not set'; stacktrace → packages/delivery-core/src/unsubscribe-token.ts:25 (getSecret) via apps/worker/src/queues/send-dispatch.ts:364 (test-send List-Unsubscribe token signing)
  implication: The worker process env lacks UNSUBSCRIBE_TOKEN_SECRET — every test send dies before the SendGrid call (explains UAT test 4's "never arrives")
- timestamp: 2026-07-07T00:25:00Z
  checked: Live Postgres (Homebrew PG17 at 127.0.0.1:5432, db mega_crm — NOT the docker container; role postgres does not exist there)
  found: campaigns table has 19 columns, NO fan_out_complete; campaign 0b24f2f3 stuck status='sending' sent_count=0 sendable_total=NULL; 3365b11c canceled by user
  implication: Direct confirmation of failed-job error; the stuck-«Отправляется» row matches the UAT symptom exactly
- timestamp: 2026-07-07T00:30:00Z
  checked: packages/db/migrations + meta/_journal.json vs drizzle.__drizzle_migrations in live DB
  found: Repo has migrations 0000–0019 incl. 0017_campaigns_fan_out_complete.sql (ALTER TABLE campaigns ADD COLUMN fan_out_complete); journal has 20 entries; DB has exactly 17 applied rows whose created_at values equal journal `when` for entries 0000–0016. Entries 0017–0019 never applied. Root package.json `dev` script runs api/web/worker via tsx only — no migrate step; migrations run only via manual `npm run db:migrate`. 0017 was committed 2026-07-06 14:26+05 (4f79f9c, plan 04-06), after the developer's last migrate run.
  implication: Root cause 1 is an unapplied-migrations gap, not a missing migration: `npm run db:migrate` was never re-run after plans 04-06+ added 0017–0019
- timestamp: 2026-07-07T00:35:00Z
  checked: UNSUBSCRIBE_TOKEN_SECRET plumbing — unsubscribe-token.ts getSecret(), apps/api/src/env.ts, both vitest.config.ts files, tracked .env.example (via git show)
  found: Secret is read lazily from process.env at sign time and throws if unset; apps/api env schema does NOT validate it (no fail-fast at boot); apps/{api,worker}/vitest.config.ts inject a test-only default ("test-only-unsubscribe-secret-at-least-32-bytes") so all 66 automated UAT checks pass; tracked .env.example has NO UNSUBSCRIBE_TOKEN_SECRET entry at all. Worker dev script loads --env-file=../../.env.
  implication: Root cause 2 is a dev-env/config gap introduced in 04-03: a new required runtime secret was never added to .env.example / the developer's .env / any boot-time validation — masked in CI by vitest env injection
- timestamp: 2026-07-07T00:38:00Z
  checked: signUnsubscribeToken call sites in send-dispatch.ts
  found: Called at line 231 (campaign claim path builds claim.unsubscribeUrl) AND line 364 (test path)
  implication: Fixing only the migration would NOT make broadcasts send — campaign sends would then fail on the same missing secret. Both causes must be fixed for tests 4/5/6/7/13
- timestamp: 2026-07-07T00:39:00Z
  checked: Recovery state of the stuck campaign
  found: Both kickoff jobs exhausted all 5 attempts (state=failed, removeOnFail:false); campaign 0b24f2f3 remains status='sending', fan-out never ran
  implication: After fixes, the stuck campaign will NOT self-heal — the failed kickoff job must be retried (BullMQ retry / re-add with same jobId after removal) or the campaign canceled and re-launched

## Resolution
<!-- OVERWRITE as understanding evolves -->

root_cause: |
  TWO independent root causes, each independently fatal to the send pipeline:

  (1) UNAPPLIED DB MIGRATIONS (kills kickoff → «0 отправленных» hang).
  The live dev database (mega_crm on local Postgres 17, 127.0.0.1:5432) is migrated only through
  0016_workspace_send_settings. Migrations 0017_campaigns_fan_out_complete.sql,
  0018_campaigns_scheduler_scan_policy.sql, 0019_campaigns_workspace_isolation_nullif_guard.sql
  (added by plans 04-06+) were never applied — `npm run dev` has no migrate step and
  `npm run db:migrate` was last run before they existed. The campaign-kickoff worker's first query
  selects fan_out_complete (campaign-kickoff.worker.ts:53-57) and throws
  `column "fan_out_complete" does not exist`; BullMQ exhausted 5 retries for both launched
  campaigns. The launch route had already flipped the campaign to 'sending', so it hangs at 0
  sent forever (campaign 0b24f2f3 still stuck).

  (2) MISSING UNSUBSCRIBE_TOKEN_SECRET IN WORKER RUNTIME ENV (kills every send, incl. test-sends —
  UAT test 4, and would kill campaign sends the moment fix 1 lands).
  packages/delivery-core/src/unsubscribe-token.ts:22-28 reads process.env.UNSUBSCRIBE_TOKEN_SECRET
  lazily and throws when unset. All 4 test-send jobs failed at send-dispatch.ts:364 before any
  SendGrid call; the campaign path signs the same token at send-dispatch.ts:231. The secret was
  introduced in 04-03 but: not added to .env.example, not validated in apps/api/src/env.ts or the
  worker boot path, and silently injected by both vitest.config.ts files — so all automated tests
  pass while every real dev-stack send crashes.
fix: ""
verification: ""
files_changed: []

## Closure Note (milestone v1.0 close)

Resolved at v1.0 milestone close on 2026-07-14: diagnosis was handed to plan-phase --gaps; fix shipped via gap-closure plans (see phase 01/04/05/06 gap plans) or recorded as external-env tech debt in v1.0-MILESTONE-AUDIT.md.
