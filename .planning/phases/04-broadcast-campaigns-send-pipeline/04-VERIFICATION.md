---
phase: 04-broadcast-campaigns-send-pipeline
verified: 2026-07-06T10:36:20Z
status: gaps_found
score: 1/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
gaps:
  - truth: "A user can create a campaign and send a test email to their own address with sample dynamic data"
    status: failed
    reason: "The campaign builder UI only ever sets fromSenderId (never fromEmail: apps/web/src/features/campaigns/CampaignBuilderPage.tsx sets/reads only `fromSenderId`, TemplateSenderPickers.tsx has no fromEmail input). The worker's shared dispatch processor unconditionally requires campaign.fromEmail to be non-null before it will send ANYTHING, for both kind='campaign' AND kind='test' (the check happens before the campaign/test branch splits). No code anywhere resolves from_sender_id to a verified-sender email at create, launch, kickoff, or dispatch time (confirmed by exhaustive grep across apps/api, apps/worker, packages/delivery-core)."
    artifacts:
      - path: "apps/worker/src/queues/send-dispatch.ts"
        issue: "Line 155: `if (!campaign || !campaign.templateId || !campaign.fromEmail) throw ...` — throws for every UI-created campaign/test-send, regardless of kind"
      - path: "apps/api/src/modules/campaigns/campaign.repository.ts"
        issue: "Line 217: launch-readiness check accepts `fromEmail OR fromSenderId` as complete, but nothing downstream ever converts fromSenderId into fromEmail"
      - path: "apps/web/src/features/campaigns/CampaignBuilderPage.tsx"
        issue: "SenderPicker only ever writes fromSenderId; there is no UI path that sets fromEmail"
    missing:
      - "Resolve the verified sender's email from fromSenderId at launch time (or add a dispatch-time fallback lookup) and persist/use the resolved from_email before any SendGrid call"
      - "An integration test that launches/test-sends a campaign configured only via the real UI contract (fromSenderId, no fromEmail) and asserts a send actually occurs — existing tests only pass because fixtures insert from_email directly (apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts:103,136,196,216; apps/worker/src/queues/__tests__/*.test.ts insert from_email directly)"
  - truth: "Campaign state machine (draft → scheduled → sending → sent) works end-to-end and a draft cannot be sent by accident"
    status: failed
    reason: "The draft-cannot-be-sent-by-accident guard is real (illegal_transition errors verified in campaign-state-machine.test.ts), but the sending → sent transition is unreachable for any campaign with a non-empty audience. The ONLY code path that ever writes status='sent' is the kickoff worker's sendableTotal===0 branch (campaign-kickoff.worker.ts:134-151). Grep across apps/worker, apps/api, and packages/delivery-core finds no other status='sent' write. The kickoff worker's own smoke test documents this: `expect(snapshot.status).toBe(\"sending\"); // never transitioned to sent by kickoff itself` (campaign-kickoff.worker.smoke.test.ts:125)."
    artifacts:
      - path: "apps/worker/src/queues/campaign-kickoff.worker.ts"
        issue: "Lines 153-163: after a non-empty fan-out, only sendable_total/excluded_total/fan_out_complete are set — status stays 'sending' forever"
    missing:
      - "A completion check (in recordSendResult or a post-dispatch step) that transitions status 'sending' -> 'sent' with terminal_at=now() once (sent_count + failed_count) >= sendable_total AND fan_out_complete, guarded by WHERE status='sending'"
  - truth: "During sending the user sees live progress (sent / total)"
    status: failed
    reason: "campaigns.sent_count and campaigns.failed_count are never incremented anywhere in the codebase after their DEFAULT 0 (grep across apps/api, apps/worker, packages/db/migrations for sent_count/failed_count finds only column declarations and read sites). recordSendResult (send-ledger.ts) updates only the sends table, never the campaigns row. CampaignProgress.tsx and CampaignDetailPage.tsx both render campaign.sentCount/failedCount, which is therefore permanently 0 for every campaign regardless of how many emails actually go out."
    artifacts:
      - path: "packages/delivery-core/src/send-ledger.ts"
        issue: "recordSendResult only writes to the sends table; no counter increment on campaigns"
      - path: "apps/web/src/features/campaigns/CampaignProgress.tsx"
        issue: "Renders sentCount/failedCount from the campaign row, which never changes from 0"
    missing:
      - "Atomic UPDATE campaigns SET sent_count = sent_count + 1 (or failed_count += 1) alongside every terminal recordSendResult write, or derive progress from a live aggregate over the sends ledger (getCampaignProgress already computes this aggregate but the UI does not use it)"
  - truth: "No duplicate emails on job retries, and no contact bypasses a failed/rejected SendGrid call as 'sent'"
    status: failed
    reason: "Two independently confirmed defects: (1) send-dispatch.ts's processSendJob wraps the dispatchSendGate INSERT, the external SendGrid HTTP call, AND recordSendResult inside a single withTenantTransaction (lines 133-273). A crash/connection-drop after SendGrid accepts the mail but before COMMIT rolls back the 'dispatching' marker along with everything else; the redelivered job finds no sends row and calls SendGrid again -- a genuine duplicate send, defeating SEND-06. (2) The response-handling in the same function has exactly two branches: 429/5xx -> rate_limited, everything else (including SendGrid 400/401/403/413) -> recordSendResult(..., {status:'sent'}) (lines 261-271). recordSendResult is never called anywhere with status:'failed'. A revoked API key, unverified sender, or bad template id is recorded and rendered as a successfully delivered email."
    artifacts:
      - path: "apps/worker/src/queues/send-dispatch.ts"
        issue: "Lines 133-273 (single transaction spans the external call); lines 261-271 (only 2xx should be 'sent', 4xx should be 'failed', but 4xx falls through to 'sent')"
    missing:
      - "Split dispatch into 3 units: commit the 'dispatching' claim row in its own transaction, call SendGrid outside any transaction, record the terminal result in a second transaction"
      - "A `response.status >= 400` branch that records status:'failed' (currently dead code path — failed status and campaigns.failed_count are unreachable)"
  - truth: "Sends are throttled per tenant's RPS, ride a queue with a reserved triggered-priority lane, and survive SendGrid 429/5xx with backoff retries"
    status: verified
    evidence: "Per-tenant token bucket confirmed keyed by workspaceId (apps/worker/src/queues/rate-limiter.ts: consumeTenantToken(redisClient, workspaceId, rps) via RateLimiterRedis, called from send-dispatch.ts before every SendGrid call regardless of source). Two independent BullMQ queues (email-broadcast.worker.ts concurrency:5, email-triggered.worker.ts concurrency:20) share the same processSendJob so gating/throttling never drifts. 429/5xx correctly returns {outcome:'rate_limited', rateLimitMs} computed from Retry-After/X-RateLimit-Reset headers, consumed by Worker.rateLimit()+RateLimitError() without consuming a retry attempt. NOTE (see Warnings): worker.rateLimit() pauses the ENTIRE worker (all tenants), not just the exhausted tenant's jobs, when the per-tenant bucket denies a token (WR-04 in 04-REVIEW.md) — this is a real cross-tenant fairness defect but does not itself violate the letter of this criterion (each tenant's own ceiling is still enforced; it's other tenants' emails that get delayed). Recorded as a warning, not a blocking gap."
missing_none: true
deferred: []
human_verification: []
---

# Phase 4: Broadcast Campaigns & Send Pipeline Verification Report

**Phase Goal:** A marketer can send a real broadcast to a segment through a throttled, idempotent, suppression-aware queue — emails reliably reach inboxes via SendGrid Dynamic Templates.
**Verified:** 2026-07-06T10:36:20Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

A code review (`04-REVIEW.md`) already identified 7 Critical findings. This verification independently re-derived and confirmed all 7 by reading the actual dispatch/kickoff/ledger/route code directly (not by trusting the review or SUMMARY.md). Every Critical is real and directly breaks one or more of the phase's numbered success criteria. **The phase goal is not achieved**: a campaign configured through the actual product UI cannot deliver a single email (test-send or real send), progress never updates, campaigns never reach a terminal `sent` state, cancel does not stop in-flight sends, and the pipeline can duplicate emails on worker crash.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can create a campaign, choose segment + template, and send a test email with sample dynamic data | ✗ FAILED | `fromEmail` is required by the dispatch worker for BOTH campaign and test sends; UI never sets it (only `fromSenderId`) — see CR-02 below |
| 2 | Campaign has a working draft → scheduled → sending → sent state machine; draft can't be sent by accident | ✗ FAILED | Draft-guard works, but `sending → sent` is unreachable for any non-empty audience — see CR-05 below |
| 3 | Live progress (sent/total) shown during sending; suppressed/unsubscribed filtered before send | ✗ FAILED | Pre-send gate correctly filters suppressed/unsubscribed (VERIFIED), but `sent_count`/`failed_count` never increment — progress permanently 0/N — see CR-05 below |
| 4 | Every send goes through SendGrid v3 mail/send with List-Unsubscribe header, respects global frequency cap, no duplicates on retry | ✗ FAILED | mail/send + List-Unsubscribe header ARE correctly implemented (VERIFIED, `packages/delivery-core/src/send-mail.ts`), but 4xx failures are recorded as `sent` (CR-03) and a crash-during-transaction window can duplicate a send (CR-04) |
| 5 | Sends throttled per tenant RPS, reserved triggered-priority lane, survive 429/5xx with backoff without losing emails | ✓ VERIFIED | Per-tenant Redis token bucket + two isolated BullMQ queues + correct backoff signal confirmed by direct code read; WR-04 cross-tenant fairness issue noted as a warning, not a blocker |

**Score:** 1/5 truths verified

### Critical Findings Independently Re-Verified (against `04-REVIEW.md`)

| Review ID | Finding | Independently confirmed? | Where verified |
|-----------|---------|---------------------------|-----------------|
| CR-01 | Reflected XSS on public unsubscribe confirm page | ✓ CONFIRMED | `apps/api/src/modules/delivery/unsubscribe.routes.ts:39` — raw `${token}` interpolated into `<form action="/unsubscribe/${token}">` with no escaping/validation; `maxParamLength: 1024` (server.ts:35) provides ample payload room; no `@fastify/helmet` registered anywhere in `server.ts` |
| CR-02 | UI-configured campaigns can never dispatch (fromSenderId never resolved to fromEmail) | ✓ CONFIRMED | `send-dispatch.ts:155` requires `campaign.fromEmail` unconditionally (both kinds); `CampaignBuilderPage.tsx` only ever sets `fromSenderId`; exhaustive grep for `from_sender_id`/`fromSenderId` across apps/api, apps/worker, packages/delivery-core shows zero resolution to an email address anywhere |
| CR-03 | SendGrid 4xx recorded as `sent`; `failed` status unreachable | ✓ CONFIRMED | `send-dispatch.ts:261-271` — only branches are `429/5xx → rate_limited` and `else → recordSendResult(status:'sent')`; grep confirms `recordSendResult(..., {status:'failed'})` is called nowhere in the codebase |
| CR-04 | Duplicate-send window: dispatch marker + SendGrid call + result share one transaction | ✓ CONFIRMED | `send-dispatch.ts:133-273` — `withTenantTransaction` wraps `dispatchSendGate`, the `sendMail` HTTP call, and `recordSendResult` together; a crash after SendGrid accepts but before COMMIT rolls back the `dispatching` marker, allowing redelivery to resend |
| CR-05 | Non-empty-audience campaigns never reach `sent`; progress counters never move | ✓ CONFIRMED | Only `status='sent'` write in the entire codebase is `campaign-kickoff.worker.ts:134-151`'s `sendableTotal===0` branch; `sent_count`/`failed_count` are written nowhere but their `DEFAULT 0`; the worker's OWN smoke test (`campaign-kickoff.worker.smoke.test.ts:125`) asserts status stays `"sending"` with the comment `// never transitioned to sent by kickoff itself` |
| CR-06 | Canceling a sending campaign does not stop remaining emails | ✓ CONFIRMED | `send-dispatch.ts`'s campaign SELECT (line 149-153) reads only `template_id`/`from_email`, never `status` — a canceled campaign's already-enqueued jobs still dispatch; kickoff's fan-out loop (lines 74-132) checks status once at entry only, not per page |
| CR-07 | `recordExcluded` clobbers already-`sent` ledger rows on kickoff redelivery | ✓ CONFIRMED | `send-ledger.ts:77-84` — `ON CONFLICT ... DO UPDATE SET status='excluded'` with no `WHERE` guard against demoting a `sent`/`dispatching` row; combined with `pre-send-gate.ts:47-56`'s frequency-cap query counting the contact's own prior `sent` rows for this same campaign, a kickoff re-walk can demote a genuinely-delivered send to `excluded` |

All 7 Criticals are real, independently reproduced by direct code inspection (not by trusting `04-REVIEW.md`'s own narrative). They map directly onto 4 of the 5 phase success criteria as detailed in the Observable Truths table above.

### Required Artifacts (Level 1-3)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/db/migrations/0013-0019_*.sql` | Campaign/recipient/sends/settings schema + RLS | ✓ VERIFIED | Present, reviewed in `04-REVIEW.md`'s file list; not independently re-derived line-by-line here (schema correctness not in dispute) |
| `apps/api/src/modules/campaigns/campaign.repository.ts` | Campaign CRUD + state machine | ⚠️ PARTIAL | CRUD/create/update/cancel/duplicate exist and are wired; launch-readiness check incorrectly treats `fromSenderId` as launch-complete (CR-02) |
| `apps/worker/src/queues/send-dispatch.ts` | Shared dispatch processor (gate, throttle, send, record) | ✗ STUB-LIKE (functionally) | Exists, is wired into both queues, but is functionally broken for every UI-created campaign (CR-02), miscords 4xx (CR-03), and has a duplicate-send window (CR-04) |
| `apps/worker/src/queues/campaign-kickoff.worker.ts` | Audience snapshot walk, fan-out, completion | ⚠️ PARTIAL | Snapshot/fan-out/exclusion-breakdown work; completion (`sending→sent`) and cancel-awareness are missing (CR-05, CR-06) |
| `packages/delivery-core/src/send-ledger.ts` | Idempotent send ledger (dispatch gate, result, exclusion) | ⚠️ PARTIAL | `dispatchSendGate` idempotency design is sound in isolation but undermined by the transaction scope in CR-04; `recordExcluded` has the demotion bug (CR-07) |
| `packages/delivery-core/src/send-mail.ts` | SendGrid v3 mail/send + List-Unsubscribe header | ✓ VERIFIED | Correct request shape, header present (`send-mail.ts:57-58`), correct endpoint (`v3/mail/send`) |
| `apps/worker/src/queues/rate-limiter.ts` | Per-tenant RPS token bucket | ✓ VERIFIED | `RateLimiterRedis` keyed by `workspaceId`, correct points/duration semantics |
| `apps/worker/src/queues/email-broadcast.worker.ts` / `email-triggered.worker.ts` | Two isolated queues, shared processor, backoff | ✓ VERIFIED | Both wired to `processSendJob`; concurrency-isolated (5 vs 20); correct `rateLimit()`/`RateLimitError()` backoff pattern |
| `apps/api/src/modules/delivery/unsubscribe.routes.ts` | Public one-click unsubscribe | ⚠️ VULNERABLE | Functionally correct (SUBS-04, token verify/mutate logic) but has the CR-01 XSS |
| `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` | Campaign create/edit UI | ⚠️ PARTIAL | Never sets `fromEmail`, only `fromSenderId` — the UI-side root cause of CR-02 |
| `apps/web/src/features/campaigns/CampaignProgress.tsx` / `CampaignDetailPage.tsx` | Live send progress display | ✗ HOLLOW | Wired to `sentCount`/`failedCount` fields that are never populated (CR-05) — displays 0/N forever |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `CampaignBuilderPage.tsx` (SenderPicker) | `send-dispatch.ts` (fromEmail requirement) | `fromSenderId` field | ✗ NOT_WIRED | No conversion step anywhere; confirmed by exhaustive grep |
| `campaign-kickoff.worker.ts` fan-out | `campaigns.status` transition to `sent` | completion check after dispatch | ✗ NOT_WIRED | No completion-check code path exists outside the empty-audience branch |
| `send-ledger.ts` `recordSendResult` | `campaigns.sent_count`/`failed_count` | counter increment | ✗ NOT_WIRED | `recordSendResult` only touches `sends` table |
| `campaigns.routes.ts` `cancelCampaign` | `send-dispatch.ts` / `campaign-kickoff.worker.ts` | status check before dispatch/fan-out continuation | ✗ NOT_WIRED | Neither reads `campaigns.status` after entry |
| `send-dispatch.ts` dispatch gate → SendGrid call → result record | atomicity/durability of the idempotency claim | single `withTenantTransaction` | ✗ MISWIRED | All three steps share one transaction, defeating the documented crash-safety contract |
| `pre-send-gate.ts` frequency-cap query | `send-ledger.ts` `recordExcluded` | ledger consistency during kickoff redelivery | ✗ MISWIRED | Unconditional `ON CONFLICT DO UPDATE` can demote a `sent` row when frequency-cap counts the same campaign's own prior sends |
| `rate-limiter.ts` `consumeTenantToken` | `email-broadcast.worker.ts`/`email-triggered.worker.ts` `worker.rateLimit()` | per-tenant denial signal → worker-level pause | ⚠️ PARTIAL | Correctly wired for backoff, but the pause is worker-global, not tenant-scoped (WR-04, warning not blocker) |
| `unsubscribe.routes.ts` GET handler | HTML output | raw token interpolation | ✗ MISWIRED | No escaping/validation before interpolation (CR-01) |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| CAMP-01 | Create campaign: segment + template | ✓ SATISFIED | Campaign CRUD works, segment/template selection functional |
| CAMP-02 | Launch immediately or schedule | ⚠️ PARTIAL | Launch/schedule mechanism exists, but for any real (non-empty) audience the campaign never actually completes sending (CR-05) and never dispatches at all for UI-created campaigns (CR-02) |
| CAMP-03 | State machine draft→scheduled→sending→sent; no accidental send | ✗ BLOCKED | Draft-guard works; `sending→sent` unreachable (CR-05) |
| CAMP-04 | Test send with sample dynamic data | ✗ BLOCKED | Blocked by the same `fromEmail` requirement as real sends (CR-02) — test-send route never validates/resolves sender before enqueueing |
| CAMP-05 | Live progress display (sent/total) | ✗ BLOCKED | Counters never increment (CR-05) |
| SEND-01 | All sends via queue, no direct sends | ✓ SATISFIED | Confirmed — both campaign and test sends are enqueued, never called directly |
| SEND-02 | Per-tenant RPS throttle | ✓ SATISFIED | Token bucket keyed by workspaceId, verified |
| SEND-03 | Triggered priority over broadcast | ⚠️ PARTIAL | Structurally satisfied (two isolated queues/concurrency), but WR-04's worker-global pause on rate-limit denial is a latent risk to this guarantee under a large broadcast + throttled tenant |
| SEND-04 | Global frequency cap via unified ledger | ⚠️ PARTIAL | Cap check itself correct, but CR-07 can corrupt the ledger's accounting of what was actually sent during kickoff redelivery |
| SEND-05 | mail/send with template_id + dynamic_template_data | ✓ SATISFIED | Verified in `send-mail.ts` |
| SEND-06 | Idempotent sends, no duplicates on retry | ✗ BLOCKED | CR-04's transaction-scope defect directly breaks this guarantee |
| SEND-07 | 429/5xx handled with backoff, no lost emails | ⚠️ PARTIAL | Backoff mechanism correct; but CR-03 means non-retryable 4xx failures are recorded as delivered rather than failed (not "lost" but silently misreported) |
| SUBS-03 | Pre-send filter by subscription/suppression | ✓ SATISFIED | `evaluatePreSendGate` correctly checks suppressed/unsubscribed before every send |
| SUBS-04 | List-Unsubscribe one-click header | ✓ SATISFIED | Verified in `send-mail.ts`; also functionally present on the receiving end (`unsubscribe.routes.ts`), though that endpoint has the CR-01 XSS |

No orphaned requirements — all 14 IDs (CAMP-01..05, SEND-01..07, SUBS-03, SUBS-04) declared in REQUIREMENTS.md as Phase 4 map to phase plans and were checked above. REQUIREMENTS.md marks all 14 `[x]` complete — this verification disputes that status for CAMP-02, CAMP-03, CAMP-04, CAMP-05, SEND-03, SEND-04, SEND-06, SEND-07 pending the gap closures below.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/api/src/modules/delivery/unsubscribe.routes.ts` | 39 | Unescaped user input interpolated into HTML | 🛑 Blocker | Reflected XSS (CR-01) |
| `apps/worker/src/queues/send-dispatch.ts` | 133-273 | Overlong transaction spanning an external HTTP call | 🛑 Blocker | Duplicate-send window (CR-04) |
| `apps/worker/src/queues/send-dispatch.ts` | 261-271 | Missing 4xx branch (only 2 of 3 needed outcomes handled) | 🛑 Blocker | Failures recorded as successes (CR-03) |
| `apps/worker/src/queues/campaign-kickoff.worker.ts` | 153-163 | Missing completion/transition logic | 🛑 Blocker | Campaigns never reach `sent`; progress frozen (CR-05) |
| `packages/delivery-core/src/send-ledger.ts` | 77-84 | Unconditional `ON CONFLICT DO UPDATE` with no status guard | 🛑 Blocker | Ledger demotion of sent rows (CR-07) |
| `apps/worker/src/queues/send-dispatch.ts` / `campaign-kickoff.worker.ts` | throughout | No `status` check against `canceled` | 🛑 Blocker | Cancel does not stop in-flight sends (CR-06) |
| `apps/worker/src/queues/email-broadcast.worker.ts` / `email-triggered.worker.ts` | 27, 24 | `worker.rateLimit()` pauses whole worker on a per-tenant denial | ⚠️ Warning | Cross-tenant fairness under load (WR-04) |
| `apps/api/src/server.ts` | 27-63 | `@fastify/helmet`/CORS in package.json but never registered | ⚠️ Warning | No CSP/security headers anywhere, compounds CR-01 |

No `TODO`/`FIXME`/`XXX`/`TBD`/`HACK`/`PLACEHOLDER` debt markers found in phase-modified files.

### Human Verification Required

None — all findings above are confirmed by direct code inspection (grep + read), not requiring runtime/visual/UX judgment.

### Gaps Summary

The phase's own SUMMARY.md files and REQUIREMENTS.md mark all 14 requirement IDs complete, but the phase goal — "a marketer can send a real broadcast ... emails reliably reach inboxes" — is not achieved. The single most severe defect (CR-02) means **zero emails can be delivered through any campaign configured via the actual product UI**, because the builder only ever sets `fromSenderId` while the dispatch worker hard-requires `fromEmail`, and nothing anywhere resolves one to the other. Even if that were fixed, campaigns would still never reach a terminal `sent` state or show real progress (CR-05), cancel would not stop in-flight sends (CR-06), a crash mid-dispatch could send a duplicate email (CR-04), hard SendGrid failures would be silently recorded as delivered (CR-03), and a kickoff redelivery could erase evidence of an already-sent email from the ledger (CR-07). There is also an unrelated but serious reflected XSS on the public, unauthenticated unsubscribe page (CR-01). All 7 Critical findings from `04-REVIEW.md` were independently reproduced against the live code in this verification pass; none were refuted. The existing automated test suite passes only because its fixtures bypass the exact defects above (inserting `from_email` directly, and the kickoff smoke test explicitly documents — rather than catches — the missing `sent` transition).

These gaps require a closure plan before the phase can be considered to have achieved its goal. Recommend routing to `/gsd-plan-phase --gaps` grouped as: (A) sender-email resolution (CR-02) — blocks everything else; (B) dispatch transaction/response-handling correctness (CR-03, CR-04); (C) campaign lifecycle completion + cancel enforcement (CR-05, CR-06); (D) ledger integrity under kickoff redelivery (CR-07); (E) public unsubscribe XSS (CR-01, independent of the send pipeline, should not block on it).

---

_Verified: 2026-07-06T10:36:20Z_
_Verifier: Claude (gsd-verifier)_
