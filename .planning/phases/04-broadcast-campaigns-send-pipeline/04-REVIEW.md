---
phase: 04-broadcast-campaigns-send-pipeline
reviewed: 2026-07-07T00:00:00Z
depth: standard
files_reviewed: 103
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/env.ts
  - apps/api/src/kms/client.ts
  - apps/api/src/kms/local-provider.ts
  - apps/api/src/modules/auth/plugin.ts
  - apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts
  - apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts
  - apps/api/src/modules/campaigns/campaign-queues.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - apps/api/src/modules/campaigns/send-settings.routes.ts
  - apps/api/src/modules/campaigns/sender-resolver.ts
  - apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts
  - apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts
  - apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts
  - apps/api/src/modules/delivery/unsubscribe.routes.ts
  - apps/api/src/modules/segments/segment.repository.ts
  - apps/api/src/modules/segments/segments.routes.ts
  - apps/api/src/modules/tenancy/sendgrid-client.ts
  - apps/api/src/modules/tenancy/sendgrid-key.ts
  - apps/api/src/server.ts
  - apps/api/vitest.config.ts
  - apps/web/package.json
  - apps/web/src/App.tsx
  - apps/web/src/features/app-shell/AppShell.tsx
  - apps/web/src/features/campaigns/AudienceBreakdown.tsx
  - apps/web/src/features/campaigns/CampaignBuilderPage.tsx
  - apps/web/src/features/campaigns/CampaignDetailPage.tsx
  - apps/web/src/features/campaigns/CampaignProgress.tsx
  - apps/web/src/features/campaigns/CampaignStatusBadge.tsx
  - apps/web/src/features/campaigns/CampaignsListPage.tsx
  - apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx
  - apps/web/src/features/campaigns/SendSettingsPage.tsx
  - apps/web/src/features/campaigns/TemplateSenderPickers.tsx
  - apps/web/src/features/campaigns/TestSendPanel.tsx
  - apps/web/src/features/campaigns/api.ts
  - apps/web/src/features/segments/SegmentDetailPage.tsx
  - apps/web/src/features/segments/__tests__/segmentSaveGate.test.ts
  - apps/web/src/features/segments/segmentSaveGate.ts
  - apps/web/src/lib/api.ts
  - apps/web/vitest.config.ts
  - apps/worker/package.json
  - apps/worker/src/queues/__tests__/backoff.test.ts
  - apps/worker/src/queues/__tests__/campaign-completion.test.ts
  - apps/worker/src/queues/__tests__/campaign-kickoff.worker.smoke.test.ts
  - apps/worker/src/queues/__tests__/rate-limiter.test.ts
  - apps/worker/src/queues/__tests__/recipient-snapshot.test.ts
  - apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts
  - apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts
  - apps/worker/src/queues/campaign-broadcast-producer.ts
  - apps/worker/src/queues/campaign-kickoff.worker.ts
  - apps/worker/src/queues/campaign-scheduler.worker.ts
  - apps/worker/src/queues/email-broadcast.worker.ts
  - apps/worker/src/queues/email-triggered.worker.ts
  - apps/worker/src/queues/rate-limiter.ts
  - apps/worker/src/queues/recipient-snapshot.ts
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/server.ts
  - apps/worker/vitest.config.ts
  - packages/db/migrations/0013_campaigns.sql
  - packages/db/migrations/0014_campaign_recipients.sql
  - packages/db/migrations/0015_sends.sql
  - packages/db/migrations/0016_workspace_send_settings.sql
  - packages/db/migrations/0017_campaigns_fan_out_complete.sql
  - packages/db/migrations/0018_campaigns_scheduler_scan_policy.sql
  - packages/db/migrations/0019_campaigns_workspace_isolation_nullif_guard.sql
  - packages/db/migrations/meta/0016_snapshot.json
  - packages/db/migrations/meta/0017_snapshot.json
  - packages/db/migrations/meta/_journal.json
  - packages/db/src/index.ts
  - packages/db/src/schema/campaign-recipients.ts
  - packages/db/src/schema/campaigns.ts
  - packages/db/src/schema/sends.ts
  - packages/db/src/schema/workspace-send-settings.ts
  - packages/delivery-core/package.json
  - packages/delivery-core/src/__tests__/pre-send-gate.test.ts
  - packages/delivery-core/src/__tests__/send-ledger-integrity.test.ts
  - packages/delivery-core/src/__tests__/unsubscribe-token.test.ts
  - packages/delivery-core/src/contact-template-data.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/pre-send-gate.ts
  - packages/delivery-core/src/send-ledger.ts
  - packages/delivery-core/src/send-mail.ts
  - packages/delivery-core/src/send-settings.ts
  - packages/delivery-core/src/test/db-fixture.ts
  - packages/delivery-core/src/unsubscribe-token.ts
  - packages/delivery-core/tsconfig.json
  - packages/delivery-core/vitest.config.ts
  - packages/kms/package.json
  - packages/kms/src/aws-provider.ts
  - packages/kms/src/client.ts
  - packages/kms/src/env.ts
  - packages/kms/src/index.ts
  - packages/kms/src/local-provider.ts
  - packages/kms/tsconfig.json
  - packages/shared-schemas/src/__tests__/pagination.test.ts
  - packages/shared-schemas/src/campaign.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/pagination.ts
  - packages/shared-schemas/src/queues.ts
  - packages/shared-schemas/src/segment.ts
  - scripts/check-env.mjs
  - scripts/migrate-dev.mjs
findings:
  critical: 1
  warning: 7
  info: 9
  total: 17
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-07-07T00:00:00Z
**Depth:** standard
**Files Reviewed:** 103
**Status:** issues_found

## Summary

Full-scope review of the Phase 04 broadcast-campaigns send pipeline: campaign CRUD/state machine + routes (apps/api), kickoff/scheduler/dispatch workers (apps/worker), the shared delivery-core ledger/gate/token package, the extracted @mega-crm/kms package, DB migrations 0013-0019 with RLS policies, shared-schemas additions, and the web campaign UI.

Overall quality is high: the state machine uses locked read-check-write transactions, RLS is enabled+forced on every new table with a NULLIF-guarded policy on campaigns, the send ledger is genuinely idempotent (claim/interrupted/release semantics are correct and well-tested), the per-tenant rate limiter is properly Redis-backed and keyed by workspace, the unsubscribe endpoint verifies HMAC with a timing-safe compare and never branches its response on failure class, and tenant SendGrid keys are envelope-encrypted with workspace-bound AAD/EncryptionContext and redacted from error paths.

The review still found one Critical defect (a guaranteed 500 on the public unsubscribe endpoint for every test-send email's token) and seven Warnings, mostly clustered around lifecycle edges the happy-path tests don't reach: an incomplete campaign can be scheduled server-side and wedges at due time, launch's status commit and kickoff enqueue are not atomic with no reconciliation, the recipient-snapshot's cursor/termination logic silently truncates under BullMQ stalled-job double-execution, kickoff redelivery mis-accounts totals, the sender resolver mutates terminal campaigns, and test-send failures are structurally invisible to the user.

## Critical Issues

### CR-01: Public unsubscribe POST returns 500 for every test-send email's token (non-UUID contactId)

**File:** `apps/worker/src/queues/send-dispatch.ts:366` and `apps/api/src/modules/delivery/unsubscribe.routes.ts:166-173`
**Issue:** The `kind === "test"` dispatch path signs the List-Unsubscribe token with `contactId: contactId ?? "test-send"` (send-dispatch.ts:366). The campaigns test-send route never sets `contactId`, so every test email carries a validly-signed token whose `contactId` is the literal string `"test-send"`. When that link/button is used (the marketer previewing their own template is exactly who clicks it, and Gmail/Yahoo issue native RFC 8058 one-click POSTs from the `List-Unsubscribe-Post` header), the POST handler passes signature+expiry checks and runs `UPDATE contacts ... WHERE id = $1` with `'test-send'` — Postgres throws `22P02 invalid input syntax for type uuid`, which propagates to Fastify's default 500. This both crashes a public endpoint on a platform-issued token class and breaks the route's own documented invariant that all token dispositions produce a byte-identical response (unsubscribe.routes.ts threat-model comment).
**Fix:** Two defense layers; either alone closes the 500, both together restore the contract:
```ts
// send-dispatch.ts (test branch): never emit a non-UUID contactId
const sendId = randomUUID();
const unsubscribeUrl = buildListUnsubscribeUrl(
  signUnsubscribeToken({
    sendId,
    contactId: contactId ?? randomUUID(), // unknown-contact UUID: POST updates 0 rows, stays 200
    workspaceId,
    exp: ...,
  })
);
```
```ts
// unsubscribe.routes.ts: treat a structurally invalid contactId like an unknown contact
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isValid = payload !== null && payload.exp >= nowSeconds && UUID_RE.test(payload.contactId);
```

## Warnings

### WR-01: `scheduleCampaign` does not enforce launch completeness — an incomplete campaign schedules successfully and wedges in 'sending' at due time

**File:** `apps/api/src/modules/campaigns/campaign.repository.ts:239-262` (and route `campaigns.routes.ts:354-393`)
**Issue:** `launchCampaign` rejects a draft missing `templateId`/sender as `incomplete`, but `scheduleCampaign` only checks `status === 'draft'`. The schedule route also skips sender resolution entirely when neither `fromSenderId` nor `fromEmail` is set (`if (preSchedule && (fromSenderId || fromEmail))`). Any direct API caller (or future UI drift — the only guard today is the client-side disabled button in `LaunchScheduleActions`) can schedule a template-less/sender-less campaign. At due time the scheduler transitions it to `sending` and the kickoff worker fans out; every dispatch job then throws in `readSendPrereqs` ("missing a templateId/fromEmail"), burns 5 retries into the failed set, and the campaign sits in `sending` forever (counters never advance, `tryCompleteCampaign` never fires). Cancel is the only escape.
**Fix:** Apply the same completeness check launch uses inside `scheduleCampaign`'s locked transaction:
```ts
if (!existing.templateId || !(existing.fromEmail || existing.fromSenderId) || !existing.segmentId) {
  throw new CampaignStateError(
    "Campaign is missing a required field (template, sender, or segment) before scheduling",
    "incomplete"
  );
}
```
and mirror launch's `incomplete` -> 422 + `launchIncompleteFields` handling in the schedule route.

### WR-02: Launch status commit and kickoff enqueue are not atomic; no reconciliation path for a 'sending' campaign with no kickoff job

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:328-336`
**Issue:** `launchCampaign` commits `status='sending'` in its own transaction; `campaignKickoffQueue.add` runs afterwards. If Redis is unavailable (or the add throws for any reason), the route 500s but the campaign is already `sending` with no kickoff job — and nothing ever repairs it: the scheduler scans only `status='scheduled'`, and re-launch is an `illegal_transition`. The same terminal-wedge occurs if a kickoff job exhausts its 5 attempts (it stays in the failed set; `removeOnFail: false` keeps it for manual retry, but no operator surface exists yet). The kickoff design is already fully idempotent (`jobId: campaignId`, `fan_out_complete` guard), so re-enqueueing is safe — the missing piece is anything that does it.
**Fix:** Extend the scheduler tick (campaign-scheduler.worker.ts) to also scan `status='sending' AND fan_out_complete = false AND sending_started_at < now() - interval '5 minutes'` and (re-)enqueue `{jobId: campaignId}` kickoff jobs — a no-op when the job already exists, self-healing when it doesn't. (Requires widening the 0018 admin-scan policy or a second scoped policy for that predicate.)

### WR-03: `materializeBatch` cursor/termination logic can silently truncate the recipient snapshot under concurrent execution

**File:** `apps/worker/src/queues/recipient-snapshot.ts:56-75, 125-131`
**Issue:** The batch cursor is derived from `INSERT ... ON CONFLICT DO NOTHING RETURNING` (`rows.at(-1)?.id`), which excludes conflicted rows, and the outer loop terminates on `inserted === 0`. If any rows in the selected page already exist, `lastContactId` regresses to the last *inserted* id, and a page whose rows *all* conflict terminates the loop even though contacts remain beyond it — silently dropping the rest of the audience (recipients never snapshotted, never sent, never counted). Mid-range pre-existing rows cannot occur in a single serial run, but they can under BullMQ's documented stalled-job semantics: a stalled kickoff job is reclaimed and re-run while the original "zombie" worker invocation is still executing — two concurrent `materializeCampaignSnapshot` runs for the same campaign, each inserting rows the other then conflicts on. The doc comment's idempotency claim assumes strictly serial redelivery, which BullMQ does not guarantee.
**Fix:** Decouple the cursor from insertion results: SELECT the page of matching contact ids first (`ORDER BY c.id ASC LIMIT n`), set `lastContactId` = last *selected* id, terminate when the SELECT returns 0 rows, and use the `INSERT ... ON CONFLICT DO NOTHING` purely as the write. Same transaction, same idempotency, immune to conflicted pages.

### WR-04: Kickoff redelivery re-walk corrupts `sendable_total`/`excluded_total` — already-sent recipients are re-gated against a frequency window that now contains their own send

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:111-147`
**Issue:** If the worker crashes mid-fan-out (before `fan_out_complete` commits), the redelivered kickoff re-walks the full snapshot from the top. Recipients whose sends already completed now have a `status='sent'` row from *this campaign* inside the frequency window, so `evaluatePreSendGate` can return `frequency_cap` for them (guaranteed when `frequencyCap = 1`, which the settings schema allows). `recordExcluded`'s CR-07 guard correctly refuses to demote the `sent` ledger row, but the in-memory accounting still does `excludedTotal += 1` and skips `sendableTotal += 1` — so the finally-persisted totals under-count sendable and over-count excluded. Result: `sent_count > sendable_total` ("5 из 0 отправлено" in the UI, progress >100% clamped), and a distorted D-04 breakdown.
**Fix:** During the re-walk, classify against the ledger first: if a `sends` row for `(campaignId, contactId)` already exists with status `sent`/`failed`/`dispatching`, count it as sendable (it *was* dispatched) and skip the gate; only gate contacts with no row or an `excluded` row. A single `SELECT contact_id, status FROM sends WHERE campaign_id = $1 AND contact_id = ANY($2)` per page keeps it one query.

### WR-05: `resolveCampaignFromEmail` persists `from_email` on campaigns in any status — terminal campaigns' historical sender is rewritten

**File:** `apps/api/src/modules/campaigns/sender-resolver.ts:92-97` (call sites `campaigns.routes.ts:323-326, 378-381, 469-475`)
**Issue:** The resolver's `UPDATE campaigns SET from_email = ...` has no status guard, and all three call sites run it *before* the state machine validates the transition. `POST /launch` or `/schedule` on a `sent`/`canceled` campaign resolves and overwrites `from_email` first, then 409s — mutating the historical record of which sender address the campaign actually used (Phase 7 history / audit concern). `test-send` is allowed on any status by design, so previewing an old sent campaign also rewrites it. Separately, the resolver's UPDATE commits in its own transaction before `launchCampaign`'s `FOR UPDATE` transaction begins, so a concurrent draft edit changing `fromSenderId` between the two leaves a launched campaign whose `from_email` belongs to the previously-selected sender.
**Fix:** Guard the persist: `UPDATE campaigns SET from_email = $3 ... WHERE id = $1 AND workspace_id = $2 AND status IN ('draft','scheduled')` (still return `matched.fromEmail` for the test-send payload), or move resolution inside the launch/schedule transaction after the `FOR UPDATE` status check.

### WR-06: Test-send failures are invisible: no template validation at enqueue, worker outcome discarded, and the UI toasts success on queue-accept

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:446-499`, `apps/web/src/features/campaigns/TestSendPanel.tsx:52-55`
**Issue:** Three compounding gaps. (1) The test-send route validates the sender but not `templateId`; a template-less campaign enqueues a job that throws in `readSendPrereqs`, retries 5 times, and lands in the failed set. (2) A SendGrid 4xx yields `{outcome: "failed"}` which the broadcast worker resolves as a *completed* job — the result is stored as the BullMQ return value and read by nothing. (3) The panel toasts «Тестовое письмо отправлено на X» the moment the API returns 202 `{queued: true}` — the user is told the mail was sent when it was only queued, so both failure modes above present as success with no email arriving (the exact UAT Test 4/5 confusion this phase's gap-closure rounds chased).
**Fix:** Minimum: return 422 from the test-send route when `campaign.templateId` is null (mirror the sender check), and change the toast copy to «Тестовое письмо поставлено в очередь на X». Better: persist test-send outcomes (a lightweight `kind='test'` sends row or a short-TTL Redis key keyed by jobId) and poll it from the panel.

### WR-07: Scheduler's repeatable-job registration is fire-and-forget — a rejected `add` is an unhandled rejection and scheduled campaigns silently never send

**File:** `apps/worker/src/queues/campaign-scheduler.worker.ts:106`
**Issue:** `void tickQueue.add("scan-due-campaigns", {}, { repeat: ... })` discards the promise. If registration fails (Redis briefly unreachable at boot, ACL error, BullMQ version drift in repeat/jobId handling), the rejection is unhandled — under Node's default `--unhandled-rejections=throw` the whole worker process dies with a non-obvious stack; if the mode is ever relaxed, the failure is swallowed and the scheduler simply never ticks, meaning every scheduled campaign silently never sends. `createCampaignSchedulerWorker` is called from async `buildWorker()`, so awaiting is trivial.
**Fix:** Make registration part of startup: either make `createCampaignSchedulerWorker` async and `await tickQueue.add(...)` (failing worker boot loudly, matching the UNSUBSCRIBE_TOKEN_SECRET fail-fast precedent in `apps/worker/src/server.ts`), or attach `.catch()` that logs and retries with backoff.

## Info

### IN-01: Deleted-contact exclusions are recorded with the wrong reason (`no_email`)

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:113-121`
**Issue:** A contact deleted between snapshot and fan-out is excluded with reason `"no_email"`, so the D-04 breakdown labels deleted contacts «без email».
**Fix:** Add a distinct `"contact_deleted"` reason (the `exclusion_reason` column is free text; add the label to `AudienceBreakdown.tsx`'s `REASON_LABELS`).

### IN-02: Rate-limiter instance cache ignores the Redis client identity

**File:** `apps/worker/src/queues/rate-limiter.ts:19-39`
**Issue:** `limitersByRps` is keyed only by `rps`; the `RateLimiterRedis` created first pins its `storeClient` forever. A different `redisClient` passed later (tests do; a future reconnect-with-new-client would) is silently ignored, sending Lua calls to the original — possibly closed — client.
**Fix:** Key the cache by client too (e.g., a `WeakMap<Redis, Map<number, RateLimiterRedis>>`).

### IN-03: `validateTenantSendGridKey` trusts SendGrid response shapes and reads only the first page of verified senders

**File:** `apps/api/src/modules/tenancy/sendgrid-client.ts:43-68`
**Issue:** `scopes.includes(...)` throws a TypeError (→ 500) if a 200 response lacks `scopes`; `results.map` likewise. `/v3/verified_senders` is read without pagination, so a tenant with more senders than one page can select a sender in the UI that later fails resolution with `sender_not_found`.
**Fix:** Guard with `Array.isArray(scopes)` / `Array.isArray(body.results)` returning `{valid:false}` on malformed payloads; follow pagination (or pass `limit`) on verified_senders.

### IN-04: NULLIF('') GUC guard applied only to the campaigns RLS policy

**File:** `packages/db/migrations/0014_campaign_recipients.sql:18-20`, `0015_sends.sql:35-37`, `0016_workspace_send_settings.sql:16-18`
**Issue:** Migration 0019 documents that a reused pooled connection can leave `app.current_workspace_id` as `''` (not NULL), making a bare `::uuid` cast abort the whole query — then fixes only `campaigns`. The three sibling tables created in this same phase keep the bare cast. Safe under today's strictly-`withTenantTransaction` usage, but the phase itself just demonstrated how a second policy/access path breaks that assumption.
**Fix:** Add a follow-up migration applying the same `NULLIF(current_setting(...), '')::uuid` form to `campaign_recipients`, `sends`, and `workspace_send_settings` policies.

### IN-05: Web dialogs discard the API's structured 422 error copy

**File:** `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx:80, 147`
**Issue:** The launch/schedule routes were specifically built (CR-02) to return `{error, fields: {sender: "Выберите отправителя"}}` on 422 (revoked key, sender no longer verified), but `onError` renders only the generic «Что-то пошло не так…» — the user gets no hint that the sender is the problem. `ApiError` already carries `status` and `body`.
**Fix:** In `onError(err)`, when `err instanceof ApiError && err.status === 422`, surface `err.body.fields`/`err.message` instead of the generic string.

### IN-06: SendSettingsPage sends `frequencyCap: 0` when the input is cleared

**File:** `apps/web/src/features/campaigns/SendSettingsPage.tsx:117`
**Issue:** `Number("")` is `0`; clearing the field and saving hits the schema's `min(1)` → 400 → generic error with no field-level message.
**Fix:** Keep the raw string in state and validate before mutate (`const n = parseInt(v, 10); if (!Number.isInteger(n) || n < 1) setFieldError(...)`).

### IN-07: `sendableCount` in audience-breakdown is a live segment evaluation, shown as the audience of an in-flight/scheduled send

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:566-575`, `apps/web/src/features/campaigns/CampaignDetailPage.tsx:61-77`
**Issue:** `SendingView`'s docstring calls the breakdown "frozen", but `sendableCount` comes from `countSegmentMembers(segment.definition)` — a live count that drifts from the frozen `campaign_recipients` snapshot as contacts churn mid-send, so it can contradict the ledger-derived exclusion counts beside it.
**Fix:** For campaigns past kickoff, read `campaigns.sendable_total` (or `count(*) FROM campaign_recipients`) instead of re-evaluating the segment; keep live evaluation only for draft/scheduled previews.

### IN-08: Interrupted-claim recovery records `failed` even when the prior SendGrid call succeeded

**File:** `apps/worker/src/queues/send-dispatch.ts:217-226`, `packages/delivery-core/src/send-ledger.ts:12-25`
**Issue:** A crash between the SendGrid 202 and the record transaction leaves a `dispatching` claim; redelivery records it `failed` although the email was delivered. This is the deliberate at-most-once tradeoff (correctly documented), but note the ledger and `failed_count` permanently under-report delivered mail for those rows — Phase 5's webhook events (`delivered` for a `failed` sendId) will surface the discrepancy.
**Fix:** No change required now; when Phase 5 lands, let a `delivered` webhook event promote a `failed` row whose `provider_message_id` is null but whose `custom_args.send_id` matches.

### IN-09: Worker boots with unvalidated KMS configuration — misconfiguration fails per-job instead of at startup

**File:** `apps/worker/src/server.ts:41-66`, `packages/kms/src/env.ts:17-22`
**Issue:** `buildWorker()` fail-fasts on `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` but not KMS: `@mega-crm/kms` defaults `KMS_PROVIDER` to `local`, so a production worker missing `KMS_PROVIDER=aws` boots fine and then every dispatch job throws at decrypt time (local-provider's NODE_ENV guard), exhausting BullMQ retries into the failed set — the exact failure mode the boot guard was added to prevent for the unsubscribe secret.
**Fix:** Mirror the existing checks: at worker boot, require `KMS_PROVIDER=aws` + `KMS_KEK_ID` when `NODE_ENV=production`, and `KMS_LOCAL_KEK` (32-byte base64) when provider is local.

---

_Reviewed: 2026-07-07T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
