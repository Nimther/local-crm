---
phase: 04-broadcast-campaigns-send-pipeline
reviewed: 2026-07-06T10:30:09Z
depth: standard
files_reviewed: 84
files_reviewed_list:
  - apps/api/package.json
  - apps/api/src/kms/client.ts
  - apps/api/src/kms/local-provider.ts
  - apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts
  - apps/api/src/modules/campaigns/campaign-queues.ts
  - apps/api/src/modules/campaigns/campaign.repository.ts
  - apps/api/src/modules/campaigns/campaigns.routes.ts
  - apps/api/src/modules/campaigns/send-settings.routes.ts
  - apps/api/src/modules/delivery/__tests__/unsubscribe.test.ts
  - apps/api/src/modules/delivery/unsubscribe.routes.ts
  - apps/api/src/modules/segments/segment.repository.ts
  - apps/api/src/modules/segments/segments.routes.ts
  - apps/api/src/modules/tenancy/sendgrid-client.ts
  - apps/api/src/modules/tenancy/sendgrid-key.ts
  - apps/api/src/server.ts
  - apps/api/vitest.config.ts
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
  - apps/web/src/lib/api.ts
  - apps/worker/package.json
  - apps/worker/src/queues/__tests__/backoff.test.ts
  - apps/worker/src/queues/__tests__/campaign-kickoff.worker.smoke.test.ts
  - apps/worker/src/queues/__tests__/rate-limiter.test.ts
  - apps/worker/src/queues/__tests__/recipient-snapshot.test.ts
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
  - packages/delivery-core/src/__tests__/unsubscribe-token.test.ts
  - packages/delivery-core/src/contact-template-data.ts
  - packages/delivery-core/src/index.ts
  - packages/delivery-core/src/pre-send-gate.ts
  - packages/delivery-core/src/send-ledger.ts
  - packages/delivery-core/src/send-mail.ts
  - packages/delivery-core/src/send-settings.ts
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
  - packages/shared-schemas/src/campaign.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
findings:
  critical: 7
  warning: 11
  info: 8
  total: 26
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-07-06T10:30:09Z
**Depth:** standard
**Files Reviewed:** 84
**Status:** issues_found

## Summary

Reviewed the full broadcast-campaigns send pipeline: campaign CRUD/state machine (API), recipient snapshot + kickoff/scheduler/dispatch workers, the shared delivery-core gate/ledger/mail modules, KMS extraction, the public unsubscribe surface, migrations, and the campaign UI.

The multi-tenancy discipline (RLS + `withTenant`, admin-scan policy with NULLIF guard), the KMS envelope-encryption extraction, and the unsubscribe-token HMAC design are solid. However, the send pipeline itself has several provable end-to-end correctness failures: **a campaign configured through the UI can never actually send a single email** (CR-02), **hard SendGrid failures are recorded as successful sends** (CR-03), **no campaign with a non-empty audience ever reaches `sent` status and progress counters never move** (CR-05), and **canceling a sending campaign does not stop any remaining emails** (CR-06). There is also a reflected XSS on the public unauthenticated unsubscribe page (CR-01) and two ledger-integrity defects that break the phase's own exactly-once/never-resend guarantees (CR-04, CR-07). The existing tests pass because they exercise components in isolation (fixtures insert `from_email` directly; no test drives launch → kickoff → dispatch → completion end-to-end).

## Critical Issues

### CR-01: Reflected XSS on the public unsubscribe confirm page

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:26-45,82-86`
**Issue:** `renderConfirmPage(token)` interpolates the raw `:token` path parameter into the HTML (`<form method="POST" action="/unsubscribe/${token}">`) with no escaping and no validation. Fastify/find-my-way URL-decodes path params, so `GET /unsubscribe/%22%3E%3Cscript%3Ealert(document.cookie)%3C%2Fscript%3E` reflects `"><script>…</script>` into the page. This route is public, unauthenticated, and `maxParamLength` was deliberately raised to 1024 (server.ts:35), giving ample payload room. `apps/api/src/server.ts` registers no `@fastify/helmet`/CSP (despite the dependency in package.json), so nothing mitigates the injection. A phishing link to the platform's legitimate unsubscribe domain executes attacker script.
**Fix:** Validate the token's charset before rendering and HTML-escape on output. A genuine token is strictly base64url + one dot:

```ts
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

fastify.get("/unsubscribe/:token", async (request, reply) => {
  const { token } = request.params as { token: string };
  const safeToken = TOKEN_SHAPE.test(token) ? token : "";
  reply.type("text/html");
  return renderConfirmPage(safeToken); // still renders the same static page shape
});
```
Additionally register `@fastify/helmet` in `buildServer()` as defense-in-depth.

### CR-02: Campaigns created through the UI can never dispatch a single email (fromSenderId is never resolved to an email)

**File:** `apps/worker/src/queues/send-dispatch.ts:149-159` (also `apps/api/src/modules/campaigns/campaign.repository.ts:217`, `apps/web/src/features/campaigns/CampaignBuilderPage.tsx:120-128`)
**Issue:** `launchCampaign` accepts `fromEmail OR fromSenderId` as launch-complete (repository.ts:217). The campaign builder UI only ever sets `fromSenderId` (SenderPicker stores `String(sender.id)`; there is no `fromEmail` input anywhere in the builder). But the dispatch worker hard-requires `from_email`:

```ts
if (!campaign || !campaign.templateId || !campaign.fromEmail) {
  throw new Error(`Campaign ${campaignId} is missing a templateId/fromEmail for dispatch`);
}
```

A grep across apps/api, apps/worker, and delivery-core confirms nothing resolves `from_sender_id` → verified-sender email at launch, kickoff, or dispatch time. Every UI-configured campaign launches into `sending`, then every per-recipient job (and every test-send) throws, retries 5x, and lands in the failed queue. Zero emails are delivered and the campaign is stuck in `sending` forever. The worker tests pass only because their fixtures insert `from_email` directly.
**Fix:** Resolve the verified sender's email at launch time (call `validateTenantSendGridKey`/verified-senders with the tenant key, match `fromSenderId`, persist the resolved address into `from_email` inside `launchCampaign`'s transaction), or have the dispatch worker fall back to resolving `from_sender_id`. Add an integration test that launches a campaign with only `fromSenderId` set and asserts a send occurs.

### CR-03: SendGrid 4xx failures are recorded as successful sends; `failed` status is unreachable

**File:** `apps/worker/src/queues/send-dispatch.ts:261-272`
**Issue:** The response handling has exactly two branches:

```ts
if (response.status === 429 || response.status >= 500) {
  return { outcome: "rate_limited", ... };
}
// everything else:
await recordSendResult(client, sendId, { status: "sent", ... });
```

SendGrid returns 400 (bad template id / malformed payload), 401 (revoked key), 403 (unverified sender), 413 — all of which fall into the "everything else" branch and are recorded as `status='sent'` with `sent_at=now()`, counted against the contact's frequency cap, and reported as delivered in the UI. `recordSendResult(..., { status: "failed" })` is never called anywhere in the codebase — the `failed` send status and `campaigns.failed_count` (D-10 "never hide partial failures") are dead. A tenant whose key gets revoked mid-campaign sees every remaining message marked "sent".
**Fix:** Treat only 2xx as success; classify non-retryable 4xx as terminal failure:

```ts
if (response.status === 429 || response.status >= 500) {
  return { outcome: "rate_limited", rateLimitMs: parseRetryAfter(response.headers) };
}
if (response.status >= 400) {
  if (kind === "campaign") {
    await recordSendResult(client, sendId, { status: "failed" });
  }
  return { outcome: "failed", status: response.status };
}
if (kind === "campaign") {
  await recordSendResult(client, sendId, { status: "sent", providerMessageId: response.messageId });
}
```

### CR-04: Duplicate-email window — dispatch marker, SendGrid call, and result share one transaction

**File:** `apps/worker/src/queues/send-dispatch.ts:133-273` (contract claimed in `packages/delivery-core/src/send-ledger.ts:9-12`)
**Issue:** `processSendJob` wraps everything in a single `withTenantTransaction`: the `dispatchSendGate` INSERT of the `dispatching` row, the external SendGrid HTTP call, and `recordSendResult` all commit together. `dispatchSendGate`'s doc comment claims "a worker crash between 'SendGrid accepted' and 'we recorded that' must never cause the retried job to send again" — but if the process crashes (or the DB connection drops, or `recordSendResult` errors) after SendGrid accepted the mail and before COMMIT, the entire transaction including the `dispatching` marker **rolls back**. The redelivered job finds no `sends` row, re-inserts, and calls SendGrid again → duplicate email. The SEND-06 idempotency ledger only works if the `dispatching` claim is durable *before* the external call. (Secondary effect: a pooled RLS connection is held open across an external HTTP round-trip for every send.)
**Fix:** Split into three units: (1) commit the `dispatching` row in its own transaction; (2) perform the SendGrid call outside any transaction; (3) record the terminal result in a second transaction. On redelivery, a `dispatching` row whose SendGrid outcome is unknown is the explicitly-accepted at-least-once residue — which is the trade-off the current design claims but does not implement.

### CR-05: Campaigns with a non-empty audience never complete, and progress counters never move

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:134-163`, `packages/delivery-core/src/send-ledger.ts:48-66`
**Issue:** Two coupled gaps:
1. The only code path that sets `campaigns.status='sent'` is the kickoff worker's empty-audience branch (`sendableTotal === 0`). For any real campaign, nothing ever transitions `sending → sent` when all fan-out jobs finish — confirmed by grep: no other `status = 'sent'` write exists. The campaign stays `sending` forever; the UI polls `/progress` every 3s indefinitely; the D-10 summary view is unreachable.
2. `campaigns.sent_count` / `failed_count` are never incremented by anything (`recordSendResult` updates only `sends`; no trigger exists in migrations 0013–0019). `getCampaignProgress` returns the raw row counters, and both `CampaignProgress.tsx` and `SummaryView` render `sentCount` — permanently `0 из N отправлено` even while the ledger fills with `sent` rows. The repository comment "kept fresh by the 04-06 kickoff/dispatch worker" describes code that does not exist.
**Fix:** In `recordSendResult` (or the dispatch worker after commit), increment the campaign counter atomically (`UPDATE campaigns SET sent_count = sent_count + 1 ...`), and after each terminal ledger write check for completion: when `(sent + failed) >= sendable_total AND fan_out_complete`, transition `status='sending' → 'sent'` with `terminal_at=now()` guarded by `WHERE status = 'sending'`. Alternatively derive progress entirely from the ledger aggregate (which `getCampaignProgress` already computes but the UI ignores).

### CR-06: Canceling a sending campaign does not stop remaining emails

**File:** `apps/worker/src/queues/send-dispatch.ts:149-159`, `apps/worker/src/queues/campaign-kickoff.worker.ts:74-132`
**Issue:** `cancelCampaign` (sending → canceled) only flips the row status. Nothing consults it afterwards:
- `processSendJob` reads only `template_id`/`from_email` from the campaign — it never checks `status`, so every already-enqueued `email-broadcast` job for a canceled campaign still calls SendGrid and delivers.
- The kickoff worker checks status once at entry; if the campaign is canceled mid-fan-out (fan-out over 100k+ recipients takes minutes), the loop keeps enqueuing sends for the remaining pages.

The UI explicitly promises the opposite: "Оставшиеся письма отправлены не будут" (LaunchScheduleDialogs.tsx:249). For the target scale (hundreds of thousands of sends), cancel is the emergency brake for a mistaken blast — currently it is cosmetic.
**Fix:** In `processSendJob` (kind='campaign'), include `status` in the campaign SELECT and return `{ outcome: "skipped" }` (or record `excluded` with reason `canceled`) when status is `canceled`. In the kickoff worker, re-check campaign status at the top of each page iteration and abort the walk if canceled.

### CR-07: `recordExcluded` clobbers already-`sent` ledger rows on kickoff redelivery

**File:** `packages/delivery-core/src/send-ledger.ts:72-85`, `apps/worker/src/queues/campaign-kickoff.worker.ts:109-119`
**Issue:** `recordExcluded` does:

```sql
ON CONFLICT (workspace_id, campaign_id, contact_id) DO UPDATE SET
  status = 'excluded', exclusion_reason = EXCLUDED.exclusion_reason
```

— unconditionally, including over rows already `sent` or `dispatching`. Concrete trigger: kickoff crashes mid-fan-out (before `fan_out_complete` is set) after some enqueued jobs have already dispatched. The redelivered kickoff re-walks **all** of `campaign_recipients` from the top (the breakdown walk's cursor is a local variable, not persisted). For a contact who was already sent this campaign's email, `evaluatePreSendGate`'s frequency-cap query now counts that very send (it counts all `sent` rows in the window, including this campaign's), so the gate can return `frequency_cap` → `recordExcluded` overwrites the contact's `sent` row to `excluded`. Result: a genuinely delivered email is erased from the ledger, sent/excluded totals diverge from reality, and the "durable, frozen" D-04 breakdown is corrupted. This defeats the file's own claim that every kickoff write is "independently idempotent."
**Fix:** Make the overwrite conditional so a terminal `sent`/`dispatching` row is never demoted:

```sql
ON CONFLICT (workspace_id, campaign_id, contact_id) DO UPDATE
  SET status = 'excluded', exclusion_reason = EXCLUDED.exclusion_reason
  WHERE sends.status = 'excluded'
```
and/or exclude the current campaign's own sends from the frequency-cap count during a re-walk.

## Warnings

### WR-01: Kickoff's empty-audience branch can overwrite `canceled` with `sent`

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:134-151`
**Issue:** The `sendableTotal === 0` branch runs `UPDATE campaigns SET status = 'sent', ... WHERE id = $1` with no status guard. If the campaign was canceled while the snapshot/walk was in flight (status checked only once at entry), a terminal `canceled` campaign is resurrected to `sent` — an illegal transition the repository layer carefully forbids.
**Fix:** Add `AND status = 'sending'` to both terminal UPDATEs in this worker and skip when 0 rows are affected.

### WR-02: Kickoff proceeds for campaigns not in `sending` status

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:61-65`
**Issue:** The guard only halts on `sent`/`canceled`/`fanOutComplete`. A stale or manually re-enqueued kickoff job for a `draft` or `scheduled` campaign (e.g., scheduled → canceled-back-to-draft after a job was somehow enqueued) would snapshot, fan out, and send a campaign that is not launched.
**Fix:** Invert the check: proceed only `if (state.status === "sending" && !state.fanOutComplete)`.

### WR-03: Launch commits `sending` before enqueuing the kickoff job — Redis failure strands the campaign

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:307-315`
**Issue:** `launchCampaign` commits status='sending', then `campaignKickoffQueue.add(...)` runs. If the Redis add fails (connection down, timeout), the route 500s with the campaign stuck in `sending` — no kickoff job exists, and the scheduler only scans `status='scheduled'`, so nothing ever recovers it. Retrying launch fails with `illegal_transition` (not draft).
**Fix:** Either enqueue before/with a compensating rollback on failure, or extend the scheduler scan to also rescue `sending` campaigns with `fan_out_complete = false` and no snapshot progress after a timeout (re-enqueue kickoff with the same `jobId: campaignId` — idempotent by design).

### WR-04: One tenant's RPS exhaustion pauses the entire worker for all tenants

**File:** `apps/worker/src/queues/email-broadcast.worker.ts:22-29`, `apps/worker/src/queues/email-triggered.worker.ts:20-27`
**Issue:** When `processSendJob` returns `rate_limited` because *tenant A's* token bucket is empty, the wrapper calls `worker.rateLimit(ms)` — BullMQ's worker-level pause, which stops draining the **whole queue** for `rateLimitMs`, starving every other tenant's jobs. A single tenant with rpsLimit=1 and a large campaign will repeatedly pause the shared broadcast worker (and the same pattern will throttle the triggered lane in Phase 6, defeating its "always-on" purpose). CLAUDE.md's architecture note explicitly warns that per-tenant throttling must not become a global limiter.
**Fix:** For token-bucket denials (as opposed to real SendGrid 429s, which plausibly indicate provider-wide pressure), use `job.moveToDelayed(Date.now() + msBeforeNext)` / delayed re-enqueue for that job only, instead of `worker.rateLimit()`.

### WR-05: Test-send unsubscribe token carries non-UUID contactId — one-click unsubscribe from a test email 500s

**File:** `apps/worker/src/queues/send-dispatch.ts:219` (breaks at `apps/api/src/modules/delivery/unsubscribe.routes.ts:110-116`)
**Issue:** `contactId: contactId ?? "test-send"` signs a syntactically valid token whose `contactId` is not a UUID. When the recipient of a test email clicks unsubscribe (POST), the route runs `UPDATE contacts ... WHERE id = $1` with `'test-send'` → Postgres `invalid input syntax for type uuid` → unhandled → 500. This both breaks RFC 8058 one-click for test mails and violates the endpoint's uniform-response invariant (T-04-03-02): this token class is distinguishable from all others by its 500.
**Fix:** Use a real random UUID (`randomUUID()`) for test tokens, or validate `payload.contactId` with a UUID regex in the route and treat non-UUIDs as the silent no-op path.

### WR-06: Launch-confirm "audience breakdown" numbers are wrong before launch

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:500-533`, `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx:66-95`
**Issue:** `sendableCount` is `countSegmentMembers(...)` — the **raw** segment member count, which includes unsubscribed, suppressed, and no-email contacts (the pre-send gate is not applied). The `breakdown` comes from the `sends` ledger, which is empty until the kickoff worker runs. So the D-04 launch-confirm dialog always shows total members as "получателей" with zero exclusions — overstating recipients, exactly the situation D-04 exists to prevent ("why did only 28 of 600 get it?" is answered only after the fact).
**Fix:** For the pre-launch dialog, compute the breakdown live: count segment members intersected with each gate condition (`subscription_status`, `email IS NULL`, frequency-cap subquery), or at minimum label the number as the raw segment size, not "получателей".

### WR-07: createCampaign/updateCampaign don't validate segmentId — raw FK 500 and cross-workspace reference

**File:** `apps/api/src/modules/campaigns/campaign.repository.ts:78-97,160-195`
**Issue:** `segmentId` is only constrained by the `campaigns_segment_id_segments_id_fk` FK, which is **not** workspace-paired. (1) A nonexistent segment id surfaces as an unhandled 23503 → 500 instead of a 4xx. (2) A segment UUID from a *different* workspace satisfies the FK; RLS then hides the segment from every later read, so kickoff's `loadSnapshotState` throws forever ("campaign or its segment not found"), stranding the campaign in `sending`, and the success/failure difference is a cross-tenant segment-UUID existence oracle for anyone who can guess/knows a foreign UUID.
**Fix:** In `createCampaign`/`updateCampaign`, verify the segment exists within the tenant transaction (`SELECT 1 FROM segments WHERE workspace_id = $1 AND id = $2`) and throw `CampaignStateError("not_found" | "incomplete")`; map 23503 to a 422 as a backstop.

### WR-08: Unsubscribe downgrades `suppressed` contacts to `unsubscribed`

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:110-116`
**Issue:** The UPDATE sets `subscription_status='unsubscribed'` unconditionally. A contact in the suppression state (bounce/complaint — a stronger, deliverability-protecting state) who clicks an old unsubscribe link gets flipped to `unsubscribed`, erasing the suppression signal. The pre-send gate checks the two statuses separately, so this materially changes future exclusion accounting (and any future "remove from suppression requires review" logic).
**Fix:** `... SET subscription_status = 'unsubscribed' WHERE id = $1 AND subscription_status != 'suppressed'` (suppressed already implies no sends; the unsubscribe is a no-op for them).

### WR-09: Floating promise on scheduler repeatable-job registration

**File:** `apps/worker/src/queues/campaign-scheduler.worker.ts:106`
**Issue:** `void tickQueue.add("scan-due-campaigns", {}, { repeat: ... })` discards the promise. If Redis is unavailable at boot, the rejection becomes an unhandled promise rejection (process crash on modern Node), or — depending on retry buffering — the repeatable schedule is silently never registered and no scheduled campaign is ever picked up, with zero log evidence.
**Fix:** `await` the registration inside `buildWorker()` (make `createCampaignSchedulerWorker` async), or attach a `.catch` that logs fatally and exits.

### WR-10: `materializeBatch`'s cursor/termination contract breaks under concurrent execution

**File:** `apps/worker/src/queues/recipient-snapshot.ts:56-76,124-131`
**Issue:** Two related defects against the documented contract: (1) `lastContactId` is derived from `INSERT ... RETURNING`, which excludes `ON CONFLICT DO NOTHING` skips — the doc comment claims it is "the last contact id considered this batch (SELECTed, not just inserted)", which is false whenever any row conflicts; a partially-conflicting batch regresses the cursor below rows already scanned. (2) The outer loop terminates on `inserted === 0`, which conflates "no more matching contacts" with "this whole batch already existed". Single-runner these can't diverge (cursor+insert commit atomically), but BullMQ's stalled-job redelivery can run a second `processCampaignKickoffJob` concurrently with a still-alive first one; the second runner's batches all conflict → `inserted === 0` → it declares materialization complete against a partial snapshot, walks it, and can set `fan_out_complete = true` with wrong `sendable_total`/`excluded_total` while the first runner is still inserting.
**Fix:** Compute the true page boundary with a separate SELECT (or `RETURNING` from a CTE over the SELECT, not the INSERT), terminate on "SELECT page was empty", and take a per-campaign advisory lock (`pg_advisory_xact_lock(hashtext(campaignId))`) at kickoff entry so two runners can't interleave.

### WR-11: Launch/schedule/cancel/duplicate and send-settings PUT leak workspace existence (403 vs 404)

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:296-407`, `apps/api/src/modules/campaigns/send-settings.routes.ts:35-38`
**Issue:** Every read/CRUD campaign route deliberately funnels non-members through `resolveWorkspaceMember` → uniform 404 ("cannot be used as a workspace-enumeration oracle", per the in-file comment). But the Owner/Admin-gated routes use `requirePermission`, which returns **404 for an unknown slug and 403 for an existing workspace the caller isn't authorized in** — an existence oracle on exactly the routes the phase's own threat notes call out. Any authenticated user can enumerate valid workspace slugs by probing `/campaigns/x/launch`.
**Fix:** In `requirePermission`, when the permission check fails for a slug-scoped route, return the same 404 body used by `resolveWorkspaceMember` (or first verify membership and 404 non-members, reserving 403 for members lacking the role).

## Info

### IN-01: Deleted-contact exclusion branch is unreachable-by-design and would FK-violate if reached

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:98-107`
**Issue:** The `!contact` branch records the missing contact as excluded with reason `no_email` (mislabeled — the reason is deletion) via an INSERT into `sends` whose `contact_id` FK references `contacts` — for a deleted contact the INSERT itself violates the FK and throws, crash-looping the kickoff job. In practice `campaign_recipients.contact_id` is `ON DELETE CASCADE`, so the recipient row disappears with the contact and this branch only fires in the narrow TOCTOU window between the page SELECT and the contacts fetch.
**Fix:** Skip (don't insert) for missing contacts, or catch 23503 and continue; if recording is desired, add a distinct `contact_deleted` reason.

### IN-02: No `@fastify/helmet`/CORS registration despite dependencies

**File:** `apps/api/src/server.ts:27-63`
**Issue:** `@fastify/helmet` and `@fastify/cors` are in package.json but never registered — no CSP, X-Frame-Options, or nosniff headers on any route, including the public unsubscribe pages (compounds CR-01).
**Fix:** Register helmet in `buildServer()`; scope CORS as needed.

### IN-03: SendSettingsPage numeric inputs coerce empty string to 0

**File:** `apps/web/src/features/campaigns/SendSettingsPage.tsx:117`
**Issue:** `onChange={(e) => setFrequencyCap(Number(e.target.value))}` turns a cleared field into `0`, which the server schema (`min(1)`) rejects → generic "Что-то пошло не так" with no field-level hint.
**Fix:** Keep the raw string in state (or `null` when empty) and validate client-side with the shared zod schema before mutating.

### IN-04: TestSendPanel re-fills the "to" field while the user is clearing it

**File:** `apps/web/src/features/campaigns/TestSendPanel.tsx:43-47`
**Issue:** The effect `if (session?.user.email && !to) setTo(...)` runs on every `to` change; the moment the user clears the field to type a different address, it snaps back to their own email.
**Fix:** Use a one-shot ref/flag (prefill only while the field has never been touched).

### IN-05: Segment-name lookups capped at 200 rows

**File:** `apps/web/src/features/campaigns/CampaignsListPage.tsx:69-79`, `apps/web/src/features/segments/SegmentDetailPage.tsx:162-169`
**Issue:** Both the campaigns-list audience column and the "referenced by scheduled campaign" warning fetch only page 1 / pageSize 200. Workspace #201+ segments show "—", and a scheduled campaign beyond row 200 silently loses its D-03 warning.
**Fix:** Acceptable for MVP; note the ceiling or add a by-ids lookup endpoint later.

### IN-06: Unsubscribe POST has a timing side-channel

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:102-117`
**Issue:** Responses are byte-identical for valid/forged/expired tokens, but a valid token performs a DB transaction while an invalid one returns immediately — a measurable timing difference that partially undermines the "indistinguishable" goal. Low practical value to an attacker (the HMAC already prevents forgery), noted for completeness.
**Fix:** Optionally perform a dummy transaction on the invalid path.

### IN-07: Deep import into `@mega-crm/kms/src/...` without an `exports` map

**File:** `apps/api/src/kms/local-provider.ts:9`, `packages/kms/package.json`
**Issue:** `export * from "@mega-crm/kms/src/local-provider.js"` relies on file-path fallback resolution of a TS source file via a `.js` specifier. It works under the current tsx/vitest toolchain but is the only deep import in the repo and will break the moment `@mega-crm/kms` gains an `exports` field or a compiled build.
**Fix:** Re-export the local provider from the package index (it's already imported dynamically by client.ts), and point the shim at the package root.

### IN-08: Timestamp type inconsistency on new tables

**File:** `packages/db/src/schema/campaigns.ts:55-56`, `packages/db/src/schema/campaign-recipients.ts:27`, `packages/db/src/schema/workspace-send-settings.ts:19-20`
**Issue:** `created_at`/`updated_at` are `timestamp` (no timezone) while the same tables' domain timestamps (`scheduled_at`, `sending_started_at`, `terminal_at`, `queued_at`, `sent_at`) are `timestamptz`. Mixed semantics invite off-by-timezone bugs in future reporting queries.
**Fix:** Use `withTimezone: true` consistently for new tables (existing rows can be migrated with a simple `ALTER ... TYPE timestamptz`).

---

_Reviewed: 2026-07-06T10:30:09Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
