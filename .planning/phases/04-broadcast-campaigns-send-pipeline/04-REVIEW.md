---
phase: 04-broadcast-campaigns-send-pipeline
reviewed: 2026-07-06T13:53:22Z
depth: standard
files_reviewed: 95
files_reviewed_list:
  - apps/api/package.json
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
  - apps/api/src/modules/delivery/__tests__/unsubscribe-xss.test.ts
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
  - packages/shared-schemas/src/campaign.ts
  - packages/shared-schemas/src/index.ts
  - packages/shared-schemas/src/queues.ts
findings:
  critical: 1
  warning: 6
  info: 10
  total: 17
status: issues_found
---

# Phase 4: Code Review Report (post-fix re-review)

**Reviewed:** 2026-07-06T13:53:22Z
**Depth:** standard
**Files Reviewed:** 95
**Status:** issues_found

## Summary

This is the post-gap-closure re-review of the broadcast-campaigns send pipeline. The seven original findings (CR-01..CR-07) are verifiably fixed and pinned by regression tests: the unsubscribe page format-guards and escapes the reflected token with an app-wide script-blocking CSP; sender resolution persists `from_email` before any transition/enqueue; the send ledger's `recordExcluded` can no longer demote terminal/in-flight rows; the dispatch transaction is split into claim → SendGrid → record with an `interrupted` backstop; SendGrid 4xx is recorded as `failed` on the campaign path; and completion/counters/cancel enforcement all hold under the tests provided. The state machine, RLS discipline (including the 0018 admin-scan policy and the 0019 NULLIF retrofit), KMS envelope encryption, and per-tenant rate limiting are all sound.

However, the re-review surfaced one new Critical defect the previous review and its tests missed: the public `POST /unsubscribe/:token` endpoint rejects the two request shapes real callers actually send. Fastify only parses `application/json` and `text/plain` by default and returns 415 for any other content type before the route handler runs (verified against the installed Fastify 5.9 source, `lib/handle-request.js` + `lib/content-type-parser.js`). RFC 8058 one-click POSTs from mailbox providers are required to use `application/x-www-form-urlencoded`, and the confirm page's own `<form method="POST">` also submits urlencoded — both get a 415 and the contact is never unsubscribed. The existing tests pass only because `app.inject` POSTs carry no `Content-Type` header. Six Warnings cover durability and consistency gaps (non-atomic transition+enqueue, test-send 4xx misclassification, kickoff re-walk total drift that can strand a campaign in `sending`, scheduler tick-job accumulation, stale `from_email` resurrection, and a 403/404 enumeration inconsistency).

## Critical Issues

### CR-01: RFC 8058 one-click unsubscribe POSTs (and the confirm form's own POST) are rejected with 415 — contacts are never unsubscribed

**File:** `apps/api/src/modules/delivery/unsubscribe.routes.ts:121` (route), `apps/api/src/server.ts:28-87` (no urlencoded parser registered)
**Issue:** `POST /unsubscribe/:token` has no content-type parser for `application/x-www-form-urlencoded`. Fastify's defaults handle only `application/json` and `text/plain`; for any other `Content-Type` on a body-carrying method it replies `415 FST_ERR_CTP_INVALID_MEDIA_TYPE` **before the route handler runs** (`node_modules/fastify/lib/handle-request.js:36-66` → `content-type-parser.js:197-208`; the catch-all `"*"` parser in `auth/plugin.ts:37` is encapsulated to `/api/auth/*` only). Two real-world callers are broken:
1. **RFC 8058 one-click POST** — mailbox providers (Gmail, Yahoo) MUST send `Content-Type: application/x-www-form-urlencoded` with body `List-Unsubscribe=One-Click` (RFC 8058 §3.2). The `List-Unsubscribe-Post` header this platform emits on every send promises exactly this flow.
2. **The confirm page's `<form method="POST">`** — browsers submit forms as `application/x-www-form-urlencoded` (with the header present even when the form has no fields).
Both receive 415; `subscription_status` is never updated. This silently defeats SUBS-04/D-15 and is a CAN-SPAM/GDPR compliance failure, and it also damages tenant sender reputation (providers that see broken one-click unsubscribe escalate to spam-marking). The test suites (`unsubscribe.test.ts`, `unsubscribe-xss.test.ts`) pass only because `app.inject({ method: "POST", url })` sends no `Content-Type` header at all, which takes Fastify's empty-body fast path.
**Fix:**
```ts
// inside registerUnsubscribeRoutes (encapsulated -- applies to these routes only):
fastify.addContentTypeParser(
  "application/x-www-form-urlencoded",
  { parseAs: "buffer" },
  (_request, _body, done) => done(null, undefined) // body content is irrelevant; the token is in the path
);
```
Add regression tests that POST with `headers: { "content-type": "application/x-www-form-urlencoded" }` and `payload: "List-Unsubscribe=One-Click"` (one-click shape) and with an empty urlencoded body (browser-form shape), asserting 2xx + the contact flips to `unsubscribed`.

## Warnings

### WR-01: Status transition and kickoff enqueue are not atomic — an enqueue failure strands the campaign in `sending` forever

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:328-336`, `apps/worker/src/queues/campaign-scheduler.worker.ts:117-121`
**Issue:** Both launch paths first commit `status='sending'` (in `launchCampaign` / `transitionToSending`) and only then call `campaignKickoffQueue.add(...)`. If the add throws (Redis unavailable, connection blip), the campaign is permanently stuck: launch requires `draft` (409 on retry), the scheduler only scans `status='scheduled'`, and no repair path re-enqueues a kickoff for a `sending` campaign with `fan_out_complete=false`. The user's only recovery is cancel (terminal) + duplicate — losing the campaign row's identity silently.
**Fix:** Either enqueue first and transition inside the kickoff worker, or add a repair scan (the scheduler tick is a natural home) that re-enqueues `jobId: campaignId` for campaigns in `sending` with `fan_out_complete=false` and `sending_started_at` older than a threshold — the deterministic jobId makes this re-enqueue a safe no-op when the job already exists.

### WR-02: Test-send path reports a non-retryable SendGrid 4xx as `outcome: "sent"`

**File:** `apps/worker/src/queues/send-dispatch.ts:406-410`
**Issue:** The CR-03 fix (4xx → `failed`) was applied only to the `kind === "campaign"` branch. The `kind === "test"` branch checks `429 || >= 500` and otherwise returns `{ outcome: "sent", ... }` — so a 400 (bad template data), 401/403 (revoked key) test send completes the BullMQ job as a success with `providerMessageId: null`, nothing logged, nothing surfaced. The marketer waits for a test email that will never arrive with no failure signal anywhere (the route already replied 202 at enqueue time, so the worker outcome is the only record of truth).
**Fix:**
```ts
if (response.status >= 400) {
  return { outcome: "failed", sendId };
}
return { outcome: "sent", sendId, providerMessageId: response.messageId };
```
(Optionally have the Worker wrapper log failed test sends so they are visible in bull-board/removeOnFail inspection.)

### WR-03: Kickoff redelivery re-walk recomputes totals from live gate state — can permanently strand a campaign in `sending` and desyncs totals from the ledger

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:69-195`
**Issue:** If the kickoff worker crashes mid-fan-out (before `fan_out_complete` is set), the redelivered job re-walks the full snapshot and rebuilds `sendableTotal`/`excludedTotal` in memory from a **fresh** `evaluatePreSendGate` pass — but the ledger already contains committed rows from the first walk, and gate outcomes can differ between walks:
- **Excluded → sendable flip** (contact re-subscribes, or the frequency window rolls over): the re-walk counts the contact into `sendableTotal` and enqueues a job, but `dispatchSendGate` skips it (the `sends` row is terminal `excluded`, correctly protected by the CR-07 guard). Result: `sent_count + failed_count` can **never** reach the inflated `sendable_total`, `tryCompleteCampaign` never fires, and the campaign is stuck in `sending` with the UI polling forever.
- **Sendable → excluded flip** (the first walk's own sends push the contact over the frequency cap): `recordExcluded` is correctly a no-op (row is `sent`), but the in-memory `excludedTotal` still increments and `sendableTotal` doesn't — so the persisted denominators disagree with the ledger and progress can show `sent > sendable`.
**Fix:** After the walk, derive the persisted totals from the ledger instead of the in-memory tally, e.g. `SELECT count(*) FILTER (WHERE status = 'excluded') ... FROM sends WHERE campaign_id = $1` plus `count(*) FROM campaign_recipients` for the denominator — the ledger is already the idempotent source of truth the rest of the pipeline trusts. At minimum, only count an exclusion when `recordExcluded` actually affected a row (`rowCount > 0`) and count a contact as sendable when its ledger row is absent or non-excluded.

### WR-04: Scheduler tick queue accumulates a completed job every 60s forever; floating `tickQueue.add` promise can crash the process

**File:** `apps/worker/src/queues/campaign-scheduler.worker.ts:102-106`
**Issue:** `tickQueue` is constructed without `defaultJobOptions` (the file's `DEFAULT_JOB_OPTIONS` with `removeOnComplete: { age: 86400 }` is applied only to `kickoffQueue`), so every 60-second repeat tick leaves a completed job in Redis indefinitely — ~1,440 keys/day of unbounded growth on the queue backing the whole send pipeline. Separately, `void tickQueue.add(...)` discards the promise; if it rejects (Redis auth error at boot, config typo), Node's unhandled-rejection default terminates the worker process with no context.
**Fix:** Pass `removeOnComplete`/`removeOnFail` options for the repeatable tick (or use `defaultJobOptions` on `tickQueue`), and replace `void` with `.catch((err) => console.error("scheduler tick registration failed", err))`.

### WR-05: A stale persisted `from_email` can resurrect a cleared sender at launch

**File:** `apps/api/src/modules/campaigns/campaign.repository.ts:175-191`, `apps/api/src/modules/campaigns/campaigns.routes.ts:72,217`
**Issue:** `resolveCampaignFromEmail` persists `from_email` on test-send/launch/schedule. If the draft is later PATCHed with `fromSenderId: null` (sender cleared) and no `fromEmail` in the patch, `updateCampaign` preserves the previously resolved `from_email`. The launch completeness check (`!fromEmail && !fromSenderId`) then treats the campaign as having a sender, and the resolver's `fromSenderId`-unset path returns the stale `from_email` unchanged — the campaign launches from an address the marketer explicitly deselected. The current SenderPicker has no clear affordance so the UI can't trigger this today, but the API contract allows it and any future UI/import path will hit it silently.
**Fix:** In `updateCampaign`, clear `from_email` whenever the patch changes or nulls `fromSenderId` and does not itself supply a `fromEmail`:
```ts
const senderChanged = patch.fromSenderId !== undefined && patch.fromSenderId !== existing.fromSenderId;
const nextFromEmail = patch.fromEmail !== undefined ? patch.fromEmail : senderChanged ? null : existing.fromEmail;
```

### WR-06: 403 vs 404 inconsistency turns Owner/Admin campaign actions into a workspace-enumeration oracle

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:309-440`, `apps/api/src/modules/campaigns/send-settings.routes.ts:35-38`
**Issue:** Every read/CRUD campaign route deliberately maps non-membership to the same 404 an unknown slug returns (`resolveWorkspaceMember`, documented as the anti-enumeration rule mirroring T-01-06/T-01-07). But launch/schedule/cancel/duplicate and the send-settings PUT use `requirePermission(...)`, which replies **403** for an authenticated non-member on an existing workspace (`role-guard.ts:62-64`) and 404 only for a nonexistent slug. Any authenticated user can therefore confirm whether an arbitrary workspace slug exists by POSTing to `/campaigns/<uuid>/launch` and distinguishing 403 from 404 — the exact oracle the rest of this module's design closes.
**Fix:** In these preHandler-gated routes (or inside `requirePermission`), map the not-a-member case to the same generic 404 body other campaign routes return; keep 403 only for members who lack the role.

## Info

### IN-01: Deleted-contact exclusions are mislabeled `no_email`

**File:** `apps/worker/src/queues/campaign-kickoff.worker.ts:113-121`
**Issue:** A contact deleted after the snapshot froze is recorded via `recordExcluded(..., "no_email")`, so the D-04 breakdown shows it as «без email», which is untrue.
**Fix:** Use a distinct reason (e.g. `contact_deleted`) and add a label to `AudienceBreakdown.tsx`'s `REASON_LABELS` (unknown reasons already fall back to the raw key, so this is additive).

### IN-02: Sender resolution runs (SendGrid call + `from_email` write) before status validation, outside the launch lock

**File:** `apps/api/src/modules/campaigns/campaigns.routes.ts:323-328,378-383`
**Issue:** Launch/schedule call `resolveCampaignFromEmail` before the repository's status check, so hitting launch on a `sent`/`sending` campaign still decrypts the tenant key, calls SendGrid, and UPDATEs `from_email` on a locked/terminal row before failing 409. The resolve→transition gap is also outside `launchCampaign`'s `FOR UPDATE`, so a concurrent PATCH changing `fromSenderId` can leave `from_email` mismatched at transition time.
**Fix:** Short-circuit when the pre-fetched campaign isn't `draft`, or move resolution inside the launch transaction.

### IN-03: `emailTriggeredJobSchema` is dead code

**File:** `packages/shared-schemas/src/queues.ts:93-101`
**Issue:** The schema is exported but never used — `processSendJob` parses triggered jobs with `emailBroadcastJobSchema` (identical shape today, guaranteed to drift when Phase 6 makes triggered sends campaign-less).
**Fix:** Delete it, or derive one schema from the other and parse by queue.

### IN-04: New tables' RLS policies lack the NULLIF('') guard 0019 retrofitted onto `campaigns`

**File:** `packages/db/migrations/0014_campaign_recipients.sql:18-20`, `0015_sends.sql:35-37`, `0016_workspace_send_settings.sql:16-18`
**Issue:** These policies use the bare `current_setting(...)::uuid` cast. Safe today (single policy, all access through `withTenantTransaction`), but the exact failure 0019 documents recurs the moment any additional permissive/admin-scan policy is added to these tables on a pooled connection with a leftover `''` GUC.
**Fix:** Apply the same `NULLIF(current_setting('app.current_workspace_id', true), '')::uuid` form for consistency.

### IN-05: Rate-limiter cache keyed only by `rps` ignores the Redis client identity

**File:** `apps/worker/src/queues/rate-limiter.ts:19-39`
**Issue:** `createTenantRateLimiter(redisClient, rps)` returns the cached instance bound to whichever client was passed **first** for that rps — a later caller's `redisClient` argument is silently ignored. Harmless in production (one client per process) but surprising for tests and any future multi-client use.
**Fix:** Key the cache by client + rps (e.g. a `WeakMap<Redis, Map<number, RateLimiterRedis>>`).

### IN-06: TestSendPanel's recipient field cannot be cleared

**File:** `apps/web/src/features/campaigns/TestSendPanel.tsx:43-47`
**Issue:** The effect `if (session?.user.email && !to) setTo(...)` re-fires every time `to` becomes empty (it's in the dep array), so deleting the field's contents instantly restores the session email.
**Fix:** Track prefill with a one-shot ref (`const prefilled = useRef(false)`), not the live `to` value.

### IN-07: apps/api's module-level BullMQ Queues connect at import and are never closed

**File:** `apps/api/src/modules/campaigns/campaign-queues.ts:48-63`
**Issue:** `campaignKickoffQueue`/`emailBroadcastQueue` open Redis connections as an import side effect of `campaigns.routes.ts` and are not closed by `app.close()` — noticeable as lingering handles in tests and non-graceful API shutdown.
**Fix:** Register a Fastify `onClose` hook that awaits `queue.close()` for both, or construct them lazily inside the plugin.

### IN-08: `materializeBatch` cursor relies on unguaranteed `INSERT ... RETURNING` ordering

**File:** `apps/worker/src/queues/recipient-snapshot.ts:56-68`
**Issue:** `lastContactId = rows.at(-1)?.id` assumes RETURNING rows come back in the SELECT's `ORDER BY c.id ASC` order, which Postgres does not contractually guarantee for `INSERT ... SELECT`; and because RETURNING excludes `ON CONFLICT DO NOTHING` skips, any conflicted tail would both regress the cursor and (via the `inserted === 0` stop condition) truncate the walk early. The cursor-atomicity design makes conflicts unreachable today, so this is latent, not live.
**Fix:** Compute the cursor as `max(contact_id)` of the batch (e.g. aggregate over RETURNING in SQL) rather than positional `.at(-1)`.

### IN-09: Launch 422 field-level copy is never rendered by the UI

**File:** `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx:80,147`
**Issue:** The API's carefully built `422 { fields: { sender: ... } }` responses (CR-02 sender errors, incomplete-launch breakdown) are collapsed to the generic «Что-то пошло не так…» by `onError: () => setServerError(GENERIC_ERROR)`. The `ApiError.body` already carries the fields.
**Fix:** In `onError`, read `err.body.fields`/`err.body.error` (for `err instanceof ApiError && err.status === 422`) and show the per-field copy.

### IN-10: SendSettingsPage coerces a cleared numeric input to 0

**File:** `apps/web/src/features/campaigns/SendSettingsPage.tsx:117`
**Issue:** `Number(e.target.value)` on an emptied «Частотный лимит» field yields `0`, which the server rejects (`min(1)`) as a generic 400 — the user gets the unhelpful generic error with no inline hint.
**Fix:** Keep the raw string in state (mirroring the rpsLimit field's empty-string handling) and validate `>= 1` client-side before mutating.

---

_Reviewed: 2026-07-06T13:53:22Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
