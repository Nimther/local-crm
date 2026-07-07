---
phase: 04-broadcast-campaigns-send-pipeline
reviewed: 2026-07-07T09:00:00Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/__tests__/send-dispatch-idempotency.test.ts
  - apps/api/src/modules/delivery/unsubscribe.routes.ts
  - apps/api/src/modules/delivery/__tests__/unsubscribe-test-send.test.ts
  - apps/worker/vitest.config.ts
findings:
  critical: 0
  warning: 8
  info: 11
  total: 19
status: issues_found
---

# Phase 04: Code Review Report (Incremental Round 2)

**Reviewed:** 2026-07-07T09:00:00Z
**Depth:** standard
**Files Reviewed:** 5 (incremental round — see Summary)
**Status:** issues_found

## Summary

**Incremental review round.** The prior report (2026-07-07T00:00:00Z) covered all 103 Phase 04 source files at standard depth and found 1 Critical, 7 Warnings, 9 Info. Since then exactly one gap-closure plan (04-19) executed, changing only 5 source files (commits `9443638`, `e5196c7`, `67b25ff`). This round reviewed those 5 files fresh at standard depth, re-verified the prior Critical against the fix, and carries the prior report's still-open Warning/Info findings forward verbatim (their files are unchanged).

**Result:** the prior Critical (CR-01, test-send unsubscribe token 500) is verified **resolved** — both defense layers were implemented correctly and are pinned by regression tests (see Resolved below). The fresh review of the 5 changed files found 1 new Warning (WR-08: `unsubscribe_url` silently dropped from test-send template data whenever `testData` is supplied — which the UI always does) and 2 new Info items (RLS-only tenant scoping on the unsubscribe UPDATE; the PUBLIC_APP_URL test-env fix applied to the worker but not to apps/api's identical config). No Critical issues remain open.

Open findings: 0 Critical, 8 Warnings (7 carried + 1 new), 11 Info (9 carried + 2 new).

## Resolved

### CR-01 (prior round): Public unsubscribe POST returned 500 for every test-send email's token (non-UUID contactId) — RESOLVED

**Fixed by:** commits `9443638` (worker), `e5196c7` (API guard + regression suite), `67b25ff` (test-env determinism follow-up), plan 04-19.
**Verification performed this round:**
- **Worker layer** (`apps/worker/src/queues/send-dispatch.ts:373`): the `kind === "test"` branch now signs `contactId: contactId ?? randomUUID()` instead of the literal `"test-send"`. `emailBroadcastJobSchema` types `contactId` as `z.string().uuid().optional()`, so every value reaching `signUnsubscribeToken` on this path is now a canonical UUID — a redeemed test-send link resolves to either a real contact or an unknown-but-valid UUID (0 rows updated, normal 2xx), never a Postgres 22P02. The regression test (`send-dispatch-idempotency.test.ts:239-262`) decodes the token from the *actually emitted* `List-Unsubscribe` header via `verifyUnsubscribeToken` and pins the canonical UUID shape.
- **API layer** (`apps/api/src/modules/delivery/unsubscribe.routes.ts:44-46, 176`): `isUuid()` gates the `UPDATE contacts` mutation on `isValid && isUuid(payload.contactId)`. The regex matches exactly the canonical form `crypto.randomUUID()`/`gen_random_uuid()` produce (case-insensitive), so it can never reject a genuine contact token; a signature-valid non-UUID token (any legacy pre-04-19 token still sitting in a mailbox) skips the UPDATE and falls through to the identical response block — the byte-identical-response invariant (T-04-03-02) is restored, verified by `unsubscribe-test-send.test.ts` (byte-identical POST vs unknown-UUID-contact token; no mutation of a real subscribed contact in the same workspace; GET 200 HTML, no crash).
- Cross-checked: `registerUnsubscribeRoutes` is mounted via `app.register(...)` (`apps/api/src/server.ts:82`), so the route-scoped content-type parser encapsulation claim holds; the `withTenant(payload.workspaceId, ...)` RLS scoping uses the HMAC-bound workspaceId, which the worker only ever signs consistently with the contact's own workspace.

The fix is sound and complete for the defect as reported. Removed from open-findings counts.

## Warnings

### WR-01: `scheduleCampaign` does not enforce launch completeness — an incomplete campaign schedules successfully and wedges in 'sending' at due time *(carried forward, file unchanged this round)*

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

### WR-02: Launch status commit and kickoff enqueue are not atomic; no reconciliation path for a 'sending' campaign with no kickoff job *(carried forward, file unchanged this round)*

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:328-336`
**Issue:** `launchCampaign` commits `status='sending'` in its own transaction; `campaignKickoffQueue.add` runs afterwards. If Redis is unavailable (or the add throws for any reason), the route 500s but the campaign is already `sending` with no kickoff job — and nothing ever repairs it: the scheduler scans only `status='scheduled'`, and re-launch is an `illegal_transition`. The same terminal-wedge occurs if a kickoff job exhausts its 5 attempts (it stays in the failed set; `removeOnFail: false` keeps it for manual retry, but no operator surface exists yet). The kickoff design is already fully idempotent (`jobId: campaignId`, `fan_out_complete` guard), so re-enqueueing is safe — the missing piece is anything that does it.
**Fix:** Extend the scheduler tick (campaign-scheduler.worker.ts) to also scan `status='sending' AND fan_out_complete = false AND sending_started_at < now() - interval '5 minutes'` and (re-)enqueue `{jobId: campaignId}` kickoff jobs — a no-op when the job already exists, self-healing when it doesn't. (Requires widening the 0018 admin-scan policy or a second scoped policy for that predicate.)

### WR-03: `materializeBatch` cursor/termination logic can silently truncate the recipient snapshot under concurrent execution *(carried forward, file unchanged this round)*

**File:** `apps/worker/src/queues/recipient-snapshot.ts:56-75, 125-131`
**Issue:** The batch cursor is derived from `INSERT ... ON CONFLICT DO NOTHING RETURNING` (`rows.at(-1)?.id`), which excludes conflicted rows, and the outer loop terminates on `inserted === 0`. If any rows in the selected page already exist, `lastContactId` regresses to the last *inserted* id, and a page whose rows *all* conflict terminates the loop even though contacts remain beyond it — silently dropping the rest of the audience (recipients never snapshotted, never sent, never counted). Mid-range pre-existing rows cannot occur in a single serial run, but they can under BullMQ's documented stalled-job semantics: a stalled kickoff job is reclaimed and re-run while the original "zombie" worker invocation is still executing — two concurrent `materializeCampaignSnapshot` runs for the same campaign, each inserting rows the other then conflicts on. The doc comment's idempotency claim assumes strictly serial redelivery, which BullMQ does not guarantee.
**Fix:** Decouple the cursor from insertion results: SELECT the page of matching contact ids first (`ORDER BY c.id ASC LIMIT n`), set `lastContactId` = last *selected* id, terminate when the SELECT returns 0 rows, and use the `INSERT ... ON CONFLICT DO NOTHING` purely as the write. Same transaction, same idempotency, immune to conflicted pages.

### WR-04: Kickoff redelivery re-walk corrupts `sendable_total`/`excluded_total` — already-sent recipients are re-gated against a frequency window that now contains their own send *(carried forward, file unchanged this round)*

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:111-147`
**Issue:** If the worker crashes mid-fan-out (before `fan_out_complete` commits), the redelivered kickoff re-walks the full snapshot from the top. Recipients whose sends already completed now have a `status='sent'` row from *this campaign* inside the frequency window, so `evaluatePreSendGate` can return `frequency_cap` for them (guaranteed when `frequencyCap = 1`, which the settings schema allows). `recordExcluded`'s CR-07 guard correctly refuses to demote the `sent` ledger row, but the in-memory accounting still does `excludedTotal += 1` and skips `sendableTotal += 1` — so the finally-persisted totals under-count sendable and over-count excluded. Result: `sent_count > sendable_total` ("5 из 0 отправлено" in the UI, progress >100% clamped), and a distorted D-04 breakdown.
**Fix:** During the re-walk, classify against the ledger first: if a `sends` row for `(campaignId, contactId)` already exists with status `sent`/`failed`/`dispatching`, count it as sendable (it *was* dispatched) and skip the gate; only gate contacts with no row or an `excluded` row. A single `SELECT contact_id, status FROM sends WHERE campaign_id = $1 AND contact_id = ANY($2)` per page keeps it one query.

### WR-05: `resolveCampaignFromEmail` persists `from_email` on campaigns in any status — terminal campaigns' historical sender is rewritten *(carried forward, file unchanged this round)*

**File:** `apps/api/src/modules/campaigns/sender-resolver.ts:92-97` (call sites `campaigns.routes.ts:323-326, 378-381, 469-475`)
**Issue:** The resolver's `UPDATE campaigns SET from_email = ...` has no status guard, and all three call sites run it *before* the state machine validates the transition. `POST /launch` or `/schedule` on a `sent`/`canceled` campaign resolves and overwrites `from_email` first, then 409s — mutating the historical record of which sender address the campaign actually used (Phase 7 history / audit concern). `test-send` is allowed on any status by design, so previewing an old sent campaign also rewrites it. Separately, the resolver's UPDATE commits in its own transaction before `launchCampaign`'s `FOR UPDATE` transaction begins, so a concurrent draft edit changing `fromSenderId` between the two leaves a launched campaign whose `from_email` belongs to the previously-selected sender.
**Fix:** Guard the persist: `UPDATE campaigns SET from_email = $3 ... WHERE id = $1 AND workspace_id = $2 AND status IN ('draft','scheduled')` (still return `matched.fromEmail` for the test-send payload), or move resolution inside the launch/schedule transaction after the `FOR UPDATE` status check.

### WR-06: Test-send failures are invisible: no template validation at enqueue, worker outcome discarded, and the UI toasts success on queue-accept *(carried forward, file unchanged this round)*

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:446-499`, `apps/web/src/features/campaigns/TestSendPanel.tsx:52-55`
**Issue:** Three compounding gaps. (1) The test-send route validates the sender but not `templateId`; a template-less campaign enqueues a job that throws in `readSendPrereqs`, retries 5 times, and lands in the failed set. (2) A SendGrid 4xx yields `{outcome: "failed"}` which the broadcast worker resolves as a *completed* job — the result is stored as the BullMQ return value and read by nothing. (3) The panel toasts «Тестовое письмо отправлено на X» the moment the API returns 202 `{queued: true}` — the user is told the mail was sent when it was only queued, so both failure modes above present as success with no email arriving (the exact UAT Test 4/5 confusion this phase's gap-closure rounds chased).
**Fix:** Minimum: return 422 from the test-send route when `campaign.templateId` is null (mirror the sender check), and change the toast copy to «Тестовое письмо поставлено в очередь на X». Better: persist test-send outcomes (a lightweight `kind='test'` sends row or a short-TTL Redis key keyed by jobId) and poll it from the panel.

### WR-07: Scheduler's repeatable-job registration is fire-and-forget — a rejected `add` is an unhandled rejection and scheduled campaigns silently never send *(carried forward, file unchanged this round)*

**File:** `apps/worker/src/queues/campaign-scheduler.worker.ts:106`
**Issue:** `void tickQueue.add("scan-due-campaigns", {}, { repeat: ... })` discards the promise. If registration fails (Redis briefly unreachable at boot, ACL error, BullMQ version drift in repeat/jobId handling), the rejection is unhandled — under Node's default `--unhandled-rejections=throw` the whole worker process dies with a non-obvious stack; if the mode is ever relaxed, the failure is swallowed and the scheduler simply never ticks, meaning every scheduled campaign silently never sends. `createCampaignSchedulerWorker` is called from async `buildWorker()`, so awaiting is trivial.
**Fix:** Make registration part of startup: either make `createCampaignSchedulerWorker` async and `await tickQueue.add(...)` (failing worker boot loudly, matching the UNSUBSCRIBE_TOKEN_SECRET fail-fast precedent in `apps/worker/src/server.ts`), or attach `.catch()` that logs and retries with backoff.

### WR-08: Test sends with `testData` (the UI's default path) drop `unsubscribe_url` from the template data — the body unsubscribe link renders broken in the exact preview meant to verify it *(NEW this round)*

**File:** `apps/worker/src/queues/send-dispatch.ts:378-392` (root cause), `apps/api/src/modules/campaigns/campaigns.routes.ts:527` (contributing), `apps/web/src/features/campaigns/TestSendPanel.tsx:38-41, 69` (trigger)
**Issue:** The `kind === "test"` branch computes `unsubscribeUrl` and correctly sets the `List-Unsubscribe`/`List-Unsubscribe-Post` headers, but the template data is `testData ?? buildContactTemplateData(..., { unsubscribeUrl })` — the `unsubscribe_url` service field (D-18) is injected **only** in the fallback branch. When `testData` is present it is used verbatim, with no `unsubscribe_url`. This is not an edge case: the test-sample endpoint builds its sample via `buildContactTemplateData(contact)` with *no* opts (so the sample itself lacks `unsubscribe_url`), `TestSendPanel` prefills the JSON textarea from that sample and always submits it as `dynamicTemplateData` — so effectively **every UI-initiated test send** reaches SendGrid with `dynamic_template_data` missing `unsubscribe_url`. A tenant template that renders `{{unsubscribe_url}}` in its body (the documented D-18 way to place a visible unsubscribe link, populated on every real campaign send) renders an empty href in the test preview. The marketer testing their template — the entire purpose of CAMP-04 — sees a broken unsubscribe link and cannot distinguish "my template is broken" from "test sends just work this way". The branch's own comment ("Still carries a List-Unsubscribe header") documents the header but is silent on the body merge variable, suggesting the divergence between the two `dynamicTemplateData` branches is unintentional.
**Fix:** In the worker's test branch, always inject the platform-owned service field last, regardless of which branch supplied the base data:
```ts
const base =
  testData ??
  (buildContactTemplateData({ firstName: null, /* ... */ }, {}) as unknown as Record<string, unknown>);
const dynamicTemplateData = { ...base, unsubscribe_url: unsubscribeUrl };
```
(Optionally also include `unsubscribe_url` in the `/test-sample` response so the editable JSON the marketer sees matches what a real send contains — with a placeholder value, since the real one is per-message.)

## Info

### IN-01: Deleted-contact exclusions are recorded with the wrong reason (`no_email`) *(carried forward)*

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:113-121`
**Issue:** A contact deleted between snapshot and fan-out is excluded with reason `"no_email"`, so the D-04 breakdown labels deleted contacts «без email».
**Fix:** Add a distinct `"contact_deleted"` reason (the `exclusion_reason` column is free text; add the label to `AudienceBreakdown.tsx`'s `REASON_LABELS`).

### IN-02: Rate-limiter instance cache ignores the Redis client identity *(carried forward)*

**File:** `apps/worker/src/queues/rate-limiter.ts:19-39`
**Issue:** `limitersByRps` is keyed only by `rps`; the `RateLimiterRedis` created first pins its `storeClient` forever. A different `redisClient` passed later (tests do; a future reconnect-with-new-client would) is silently ignored, sending Lua calls to the original — possibly closed — client.
**Fix:** Key the cache by client too (e.g., a `WeakMap<Redis, Map<number, RateLimiterRedis>>`).

### IN-03: `validateTenantSendGridKey` trusts SendGrid response shapes and reads only the first page of verified senders *(carried forward)*

**File:** `apps/api/src/modules/tenancy/sendgrid-client.ts:43-68`
**Issue:** `scopes.includes(...)` throws a TypeError (→ 500) if a 200 response lacks `scopes`; `results.map` likewise. `/v3/verified_senders` is read without pagination, so a tenant with more senders than one page can select a sender in the UI that later fails resolution with `sender_not_found`.
**Fix:** Guard with `Array.isArray(scopes)` / `Array.isArray(body.results)` returning `{valid:false}` on malformed payloads; follow pagination (or pass `limit`) on verified_senders.

### IN-04: NULLIF('') GUC guard applied only to the campaigns RLS policy *(carried forward)*

**File:** `packages/db/migrations/0014_campaign_recipients.sql:18-20`, `0015_sends.sql:35-37`, `0016_workspace_send_settings.sql:16-18`
**Issue:** Migration 0019 documents that a reused pooled connection can leave `app.current_workspace_id` as `''` (not NULL), making a bare `::uuid` cast abort the whole query — then fixes only `campaigns`. The three sibling tables created in this same phase keep the bare cast. Safe under today's strictly-`withTenantTransaction` usage, but the phase itself just demonstrated how a second policy/access path breaks that assumption.
**Fix:** Add a follow-up migration applying the same `NULLIF(current_setting(...), '')::uuid` form to `campaign_recipients`, `sends`, and `workspace_send_settings` policies.

### IN-05: Web dialogs discard the API's structured 422 error copy *(carried forward)*

**File:** `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx:80, 147`
**Issue:** The launch/schedule routes were specifically built (CR-02) to return `{error, fields: {sender: "Выберите отправителя"}}` on 422 (revoked key, sender no longer verified), but `onError` renders only the generic «Что-то пошло не так…» — the user gets no hint that the sender is the problem. `ApiError` already carries `status` and `body`.
**Fix:** In `onError(err)`, when `err instanceof ApiError && err.status === 422`, surface `err.body.fields`/`err.message` instead of the generic string.

### IN-06: SendSettingsPage sends `frequencyCap: 0` when the input is cleared *(carried forward)*

**File:** `apps/web/src/features/campaigns/SendSettingsPage.tsx:117`
**Issue:** `Number("")` is `0`; clearing the field and saving hits the schema's `min(1)` → 400 → generic error with no field-level message.
**Fix:** Keep the raw string in state and validate before mutate (`const n = parseInt(v, 10); if (!Number.isInteger(n) || n < 1) setFieldError(...)`).

### IN-07: `sendableCount` in audience-breakdown is a live segment evaluation, shown as the audience of an in-flight/scheduled send *(carried forward)*

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:566-575`, `apps/web/src/features/campaigns/CampaignDetailPage.tsx:61-77`
**Issue:** `SendingView`'s docstring calls the breakdown "frozen", but `sendableCount` comes from `countSegmentMembers(segment.definition)` — a live count that drifts from the frozen `campaign_recipients` snapshot as contacts churn mid-send, so it can contradict the ledger-derived exclusion counts beside it.
**Fix:** For campaigns past kickoff, read `campaigns.sendable_total` (or `count(*) FROM campaign_recipients`) instead of re-evaluating the segment; keep live evaluation only for draft/scheduled previews.

### IN-08: Interrupted-claim recovery records `failed` even when the prior SendGrid call succeeded *(carried forward)*

**File:** `apps/worker/src/queues/send-dispatch.ts:217-226`, `packages/delivery-core/src/send-ledger.ts:12-25`
**Issue:** A crash between the SendGrid 202 and the record transaction leaves a `dispatching` claim; redelivery records it `failed` although the email was delivered. This is the deliberate at-most-once tradeoff (correctly documented), but note the ledger and `failed_count` permanently under-report delivered mail for those rows — Phase 5's webhook events (`delivered` for a `failed` sendId) will surface the discrepancy.
**Fix:** No change required now; when Phase 5 lands, let a `delivered` webhook event promote a `failed` row whose `provider_message_id` is null but whose `custom_args.send_id` matches.

### IN-09: Worker boots with unvalidated KMS configuration — misconfiguration fails per-job instead of at startup *(carried forward)*

**File:** `apps/worker/src/server.ts:41-66`, `packages/kms/src/env.ts:17-22`
**Issue:** `buildWorker()` fail-fasts on `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` but not KMS: `@mega-crm/kms` defaults `KMS_PROVIDER` to `local`, so a production worker missing `KMS_PROVIDER=aws` boots fine and then every dispatch job throws at decrypt time (local-provider's NODE_ENV guard), exhausting BullMQ retries into the failed set — the exact failure mode the boot guard was added to prevent for the unsubscribe secret.
**Fix:** Mirror the existing checks: at worker boot, require `KMS_PROVIDER=aws` + `KMS_KEK_ID` when `NODE_ENV=production`, and `KMS_LOCAL_KEK` (32-byte base64) when provider is local.

### IN-10: Unsubscribe UPDATE relies on RLS alone — no application-level `workspace_id` filter *(NEW this round)*

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:191-194`
**Issue:** The mutation is `UPDATE contacts SET subscription_status = 'unsubscribed' ... WHERE id = $1` — tenant scoping comes entirely from the RLS policy activated by `withTenant(payload.workspaceId, ...)`. Project convention (CLAUDE.md, "What NOT to Use") mandates RLS *as defense-in-depth on top of, not instead of,* application-level filtering. Exploitability today is negligible — the HMAC binds `(contactId, workspaceId)` as a pair and the worker only ever signs consistent pairs — but this is the only mutation on a fully public, unauthenticated endpoint, exactly where a future RLS regression (e.g., a policy rewrite, a pooled-connection GUC bug like the one migration 0019 fixed) would be most damaging.
**Fix:** Add the belt to the braces:
```sql
UPDATE contacts SET subscription_status = 'unsubscribed', updated_at = now()
WHERE id = $1 AND workspace_id = $2
```
passing `payload.workspaceId` as `$2`.

### IN-11: PUBLIC_APP_URL test-env leak fixed in the worker vitest config but not in apps/api's — and the worker's "lockstep" comment is now stale *(NEW this round)*

**File:** `apps/worker/vitest.config.ts:36-49`, `apps/api/vitest.config.ts:51`
**Issue:** Commit `67b25ff` changed the worker config to `process.env.TEST_PUBLIC_APP_URL ?? "https://api.test.local"` precisely because the repo-root `.env`'s real `PUBLIC_APP_URL` leaked into unsubscribe-URL assertions and broke a test post-merge. `apps/api/vitest.config.ts:51` still uses the leaky `process.env.PUBLIC_APP_URL ?? ...` pattern, so any future api-side test that asserts on a `buildListUnsubscribeUrl`-derived value will hit the identical nondeterministic failure. Meanwhile the worker config's comment block still claims it mirrors "apps/api/vitest.config.ts's identical 04-03 defaults so both apps' test suites stay in lockstep" — no longer true for this variable.
**Fix:** Apply the same `TEST_PUBLIC_APP_URL` override to `apps/api/vitest.config.ts` (one-line change), restoring the lockstep the comment promises.

---

_Reviewed: 2026-07-07T09:00:00Z (incremental round over commits 9443638, e5196c7, 67b25ff; prior full-scope round: 2026-07-07T00:00:00Z, 103 files)_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
