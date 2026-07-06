---
phase: 04-broadcast-campaigns-send-pipeline
verified: 2026-07-06T19:05:00Z
status: gaps_found
score: 4/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 1/5
  gaps_closed:
    - "A user can create a campaign and send a test email to their own address with sample dynamic data (CR-02: fromSenderId now resolves to a persisted from_email before launch/schedule/test-send)"
    - "Campaign state machine (draft → scheduled → sending → sent) works end-to-end and a draft cannot be sent by accident (CR-05: incrementCampaignSendCounter + tryCompleteCampaign wired into every terminal recordSendResult and into kickoff fan-out completion)"
    - "During sending the user sees live progress (sent / total) (CR-05, same fix as above — sent_count/failed_count now increment live)"
    - "No duplicate emails on job retries, and no contact bypasses a failed/rejected SendGrid call as 'sent' (CR-03: 4xx now records 'failed'; CR-04: dispatch split into claim/send/record 3-unit transaction with an 'interrupted' backstop; CR-07: recordExcluded can no longer demote a terminal/in-flight sends row)"
  gaps_remaining:
    - "Every delivered email goes through SendGrid v3 mail/send with a one-click List-Unsubscribe header [header IS present and correct] BUT the receiving endpoint that RFC 8058/the confirm-page form POST to is broken: POST /unsubscribe/:token has no application/x-www-form-urlencoded content-type parser, so Fastify returns 415 before the route handler runs for both a mailbox provider's real one-click POST and the confirm page's own <form method=\"POST\"> submission — confirmed live against the built server (see Behavioral Spot-Checks)"
  regressions: []
gaps:
  - truth: "Every delivered email goes through SendGrid v3 mail/send with a one-click List-Unsubscribe header, no contact exceeds the global frequency cap, and there are no duplicate emails on job retries"
    status: failed
    reason: "mail/send request shape, the List-Unsubscribe header itself, the global frequency cap (CR-07 fixed), and duplicate-send prevention (CR-04 fixed) are all correct and test-covered. However the endpoint the List-Unsubscribe header POINTS TO — POST /unsubscribe/:token — rejects the exact two request shapes real callers send. Fastify only parses application/json and text/plain by default and returns 415 FST_ERR_CTP_INVALID_MEDIA_TYPE for any other Content-Type before the route handler runs. RFC 8058 one-click POSTs (mailbox providers, Content-Type: application/x-www-form-urlencoded, body List-Unsubscribe=One-Click) and the confirm page's own <form method=\"POST\"> (browsers always send urlencoded, even with an empty body) both get 415 and the contact is never unsubscribed. Live-verified against the actual running server with app.inject + an explicit Content-Type header (the existing test suite passes only because app.inject without a Content-Type header takes Fastify's empty-body fast path, never exercising the parser at all)."
    artifacts:
      - path: "apps/api/src/modules/delivery/unsubscribe.routes.ts"
        issue: "No fastify.addContentTypeParser for application/x-www-form-urlencoded is registered anywhere in registerUnsubscribeRoutes"
      - path: "apps/api/src/server.ts"
        issue: "No app-wide urlencoded content-type parser registered; the only non-default parser (auth/plugin.ts:37, catch-all \"*\") is encapsulated to /api/auth/* only and does not apply to the top-level /unsubscribe/:token route"
    missing:
      - "Register a application/x-www-form-urlencoded content-type parser scoped to registerUnsubscribeRoutes (parseAs: 'buffer', body content is irrelevant since the token lives in the path) so both real-world POST shapes reach the handler"
      - "Regression tests that POST with headers: { 'content-type': 'application/x-www-form-urlencoded' } and payload: 'List-Unsubscribe=One-Click' (mailbox-provider shape) and with an empty urlencoded body (confirm-page-form shape), asserting 2xx + the contact flips to 'unsubscribed' — the existing unsubscribe.test.ts/unsubscribe-xss.test.ts suites never send a Content-Type header and so do not catch this"
deferred: []
human_verification: []
---

# Phase 4: Broadcast Campaigns & Send Pipeline Verification Report

**Phase Goal:** A marketer can send a real broadcast to a segment through a throttled, idempotent, suppression-aware queue — emails reliably reach inboxes via SendGrid Dynamic Templates.
**Verified:** 2026-07-06T19:05:00Z
**Status:** gaps_found
**Re-verification:** Yes — after gap closure (04-09 through 04-13)

## Goal Achievement

The initial verification (2026-07-06T10:36:20Z) found 4 of 5 success criteria FAILED, driven by 7 Critical findings in `04-REVIEW.md`. Gap-closure plans 04-09 through 04-13 were executed and are independently re-confirmed here: CR-02 (sender resolution), CR-03 (4xx recorded as failed), CR-04 (crash-safe 3-unit dispatch), CR-05 (campaign completion + live counters), CR-06 (cancel enforcement), and CR-07 (send-ledger demotion guard) are all genuinely fixed, each backed by a passing integration test that was independently re-run against the actual codebase (not trusted from SUMMARY.md) as part of this verification.

However, the post-gap-closure code review (`04-REVIEW.md`) surfaced a **new** Critical finding (CR-01 in the new review, distinct from the old review's CR-01 XSS which is also fixed): the public `POST /unsubscribe/:token` endpoint returns HTTP 415 for both real-world callers of the one-click unsubscribe mechanism this phase's send pipeline advertises via the `List-Unsubscribe`/`List-Unsubscribe-Post` headers on every email. This verification independently reproduced the defect with a live behavioral probe against the actual running Fastify app (not by trusting the review's narrative) — see Behavioral Spot-Checks below. This is a genuine, unresolved gap: the phase's own success criterion #4 promises a working one-click List-Unsubscribe mechanism, and the mechanism does not work for its only real-world callers.

**The phase goal is NOT fully achieved.** 4 of 5 success criteria are now genuinely met; the 5th (delivery correctness) is met on the sending side but fails on the receiving (unsubscribe) side.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can create a campaign, choose segment + template, and send a test email with sample dynamic data | ✓ VERIFIED | `resolveCampaignFromEmail` (apps/api/src/modules/campaigns/sender-resolver.ts) resolves fromSenderId → verified sender email and persists to campaigns.from_email before launch/schedule/test-send enqueue; `sender-resolution.test.ts` (3 tests) passes against the actual code, independently re-run in this verification |
| 2 | Campaign has a working draft → scheduled → sending → sent state machine; draft can't be sent by accident | ✓ VERIFIED | `tryCompleteCampaign`/`incrementCampaignSendCounter` (packages/delivery-core/src/send-ledger.ts) wired into every terminal `recordSendResult` in send-dispatch.ts AND into campaign-kickoff.worker.ts's fan-out completion (covers both orderings); `campaign-completion.test.ts` (5 cases) independently re-run and passing |
| 3 | Live progress (sent/total) shown during sending; suppressed/unsubscribed filtered before send | ✓ VERIFIED | Same wiring as #2 — `sent_count`/`failed_count` now increment atomically alongside every terminal send record; `evaluatePreSendGate` (packages/delivery-core/src/pre-send-gate.ts) still correctly filters suppressed/unsubscribed contacts before every send (unchanged from initial verification, re-confirmed) |
| 4 | Every send goes through SendGrid v3 mail/send with List-Unsubscribe header, respects global frequency cap, no duplicates on retry | ✗ FAILED | mail/send request shape + header ARE correct (`packages/delivery-core/src/send-mail.ts`); frequency cap is correctly enforced and ledger-safe against kickoff redelivery (CR-07 fixed, `send-ledger-integrity.test.ts` 4/4 passing); duplicate-send window closed (CR-04 fixed, `send-dispatch-durability.test.ts` passing) — BUT the endpoint the List-Unsubscribe header points recipients/mail-clients to (`POST /unsubscribe/:token`) returns 415 for both real-world callers (live-verified below), so the "one-click List-Unsubscribe" promise is not actually functional |
| 5 | Sends throttled per tenant RPS, reserved triggered-priority lane, survive 429/5xx with backoff without losing emails | ✓ VERIFIED | Unchanged from initial verification (already ✓ VERIFIED there) — per-tenant Redis token bucket, two isolated BullMQ queues, correct 429/5xx → rate_limited signal, now additionally hardened by CR-04's claim-release-on-429/5xx (`releaseDispatchClaim`) so a stranded claim never blocks a legitimate retry |

**Score:** 4/5 truths verified

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| RFC 8058 one-click POST (`Content-Type: application/x-www-form-urlencoded`, body `List-Unsubscribe=One-Click`) reaches the unsubscribe handler | Built the real Fastify app via `buildServer()` and called `app.inject({ method: "POST", url: "/unsubscribe/garbage.token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" })` | `415 {"statusCode":415,"code":"FST_ERR_CTP_INVALID_MEDIA_TYPE","error":"Unsupported Media Type","message":"Unsupported Media Type"}` | ✗ FAIL |
| Confirm-page browser `<form method="POST">` shape (urlencoded, empty body) reaches the unsubscribe handler | Same app, `app.inject({ method: "POST", url: "/unsubscribe/garbage.token", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "" })` | `415 {"statusCode":415,"code":"FST_ERR_CTP_INVALID_MEDIA_TYPE", ...}` | ✗ FAIL |
| Gap-closure regression suites (sender-resolution, campaign-completion, send-dispatch-durability, send-dispatch-idempotency, backoff, campaign-kickoff smoke, send-ledger-integrity, unsubscribe, unsubscribe-xss) all pass | `npx vitest run` (targeted files) in apps/api, apps/worker, packages/delivery-core | All 25 targeted tests pass; full package suites (apps/api 152/152, apps/worker 39/39, packages/delivery-core 25/25) pass with zero regressions | ✓ PASS |

The two 415 probes were run against a temporary test file added and removed solely for this verification (not part of the shipped test suite) to directly exercise the code path the review's static analysis identified, confirming it is a live, reproducible defect and not merely a theoretical one.

### Required Artifacts (Level 1-3)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/campaigns/sender-resolver.ts` | Resolves fromSenderId → verified email, persists from_email | ✓ VERIFIED | New in 04-09; correct fail-closed behavior (throws `CampaignSenderError` mapped to 422) for unresolvable senders; wired into launch/schedule/test-send in campaigns.routes.ts |
| `apps/worker/src/queues/send-dispatch.ts` | Shared dispatch processor (gate, throttle, send, record) | ✓ VERIFIED | 3-unit dispatch (claim txn → SendGrid call outside txn → record txn) confirmed by direct read; 4xx→failed branch present (line 333-343); CR-06 cancel-gate present (`claimCampaignSend`'s `status !== "sending"` check) |
| `apps/worker/src/queues/campaign-kickoff.worker.ts` | Audience snapshot walk, fan-out, completion, cancel-awareness | ✓ VERIFIED | Per-page status re-read stops fan-out on cancel/sent (lines 76-98); `tryCompleteCampaign` called after fan-out completion (line 194); D-05 empty-audience branch now guarded `WHERE status='sending'` |
| `packages/delivery-core/src/send-ledger.ts` | Idempotent send ledger (dispatch gate, result, exclusion, counters) | ✓ VERIFIED | `recordExcluded`'s `ON CONFLICT` now guarded against demoting `sent`/`dispatching`/`failed` rows; `incrementCampaignSendCounter`/`tryCompleteCampaign` both guarded `WHERE status='sending'`; `dispatchSendGate` distinguishes `interrupted` (prior claim, redelivery) from `skipped` (terminal) |
| `apps/api/src/modules/delivery/unsubscribe.routes.ts` | Public one-click unsubscribe, no XSS | ⚠️ PARTIAL | Old CR-01 (reflected XSS) is genuinely fixed (format-guard + HTML-attribute escaping, `unsubscribe-xss.test.ts` 5/5 passing) — but the route has no `application/x-www-form-urlencoded` content-type parser, so it 415s both of its two real-world POST callers (new critical, live-verified) |
| `apps/api/src/server.ts` | App-wide security headers, route registration | ✓ VERIFIED | Single consolidated `@fastify/helmet` registration with explicit script-blocking CSP (old duplicate/permissive registration in `auth/plugin.ts` removed) |
| `apps/web/src/features/campaigns/CampaignProgress.tsx` / `CampaignDetailPage.tsx` | Live send progress display | ✓ VERIFIED | No UI change was needed (04-13) — already read `sentCount`/`failedCount`/`sendableTotal`; now backed by live-incrementing backend counters instead of frozen zeros |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `CampaignBuilderPage.tsx` (SenderPicker → `fromSenderId`) | `send-dispatch.ts` (`fromEmail` requirement) | `resolveCampaignFromEmail` at launch/schedule/test-send | ✓ WIRED | Resolution + persistence confirmed by direct code read + passing integration test |
| `send-dispatch.ts` terminal `recordSendResult` | `campaigns.sent_count`/`failed_count`/`status` | `incrementCampaignSendCounter` + `tryCompleteCampaign`, same transaction | ✓ WIRED | Confirmed at all 3 terminal-record call sites (sent, failed-4xx, failed-interrupted) |
| `campaign-kickoff.worker.ts` fan-out completion | `campaigns.status` → `sent` | `tryCompleteCampaign` after `fan_out_complete=true` | ✓ WIRED | Covers the ordering where fan-out finishes after all sends already landed |
| `campaigns.routes.ts` `cancelCampaign` | `send-dispatch.ts` / `campaign-kickoff.worker.ts` | live `status` re-read at claim time / per fan-out page | ✓ WIRED | `claimCampaignSend` checks `status !== "sending"` before claiming; kickoff re-reads status every page |
| `pre-send-gate.ts` frequency-cap query | `send-ledger.ts` `recordExcluded` | conflict-guarded `ON CONFLICT ... WHERE status NOT IN (...)` | ✓ WIRED | `send-ledger-integrity.test.ts` proves a `sent`/`dispatching` row survives a redelivered exclusion call |
| Every send's `List-Unsubscribe`/`List-Unsubscribe-Post` header | `POST /unsubscribe/:token` handler | HTTP POST from a mailbox client or the confirm-page form | ✗ NOT_WIRED | 415 rejected before the route handler runs for both real request shapes (no urlencoded content-type parser registered for this route) — live-verified |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| CAMP-01 | Create campaign: segment + template | ✓ SATISFIED | Unchanged, was already satisfied |
| CAMP-02 | Launch immediately or schedule | ✓ SATISFIED | Sender resolution (04-09) + completion/cancel wiring (04-13) close the prior blockers |
| CAMP-03 | State machine draft→scheduled→sending→sent; no accidental send | ✓ SATISFIED | `campaign-completion.test.ts` proves both the empty and non-empty audience paths reach `sent`; draft-guard unchanged and still verified |
| CAMP-04 | Test send with sample dynamic data | ✓ SATISFIED | Sender resolution applies equally to the test-send route; note WR-02 (below) means a 4xx on the *test-send* path is misreported as `outcome:"sent"` in the worker job result — the send is still attempted/enqueued correctly, but a failure (e.g. revoked key) gives no failure signal anywhere. Not blocking (the criterion is about the ability to send a test, not about failure-mode observability), flagged as a warning |
| CAMP-05 | Live progress display (sent/total) | ✓ SATISFIED | Counters now increment live, confirmed by integration test |
| SEND-01 | All sends via queue, no direct sends | ✓ SATISFIED | Unchanged |
| SEND-02 | Per-tenant RPS throttle | ✓ SATISFIED | Unchanged |
| SEND-03 | Triggered priority over broadcast | ✓ SATISFIED | Unchanged (two isolated queues/concurrency); WR-04 in 04-REVIEW.md notes an unrelated operational risk (scheduler tick-queue growth / unhandled promise rejection) that does not affect this guarantee |
| SEND-04 | Global frequency cap via unified ledger | ✓ SATISFIED | CR-07 fix (recordExcluded demotion guard) closes the prior corruption path; test-covered |
| SEND-05 | mail/send with template_id + dynamic_template_data | ✓ SATISFIED | Unchanged |
| SEND-06 | Idempotent sends, no duplicates on retry | ✓ SATISFIED | CR-04 fix (3-unit dispatch + interrupted-claim handling) closes the prior duplicate-send window; test-covered |
| SEND-07 | 429/5xx handled with backoff, no lost emails | ✓ SATISFIED | CR-03/CR-04 fixes; claim is released on 429/5xx so a retry re-attempts cleanly without consuming an attempt |
| SUBS-03 | Pre-send filter by subscription/suppression | ✓ SATISFIED | Unchanged, was already satisfied |
| SUBS-04 | List-Unsubscribe one-click header | ✗ BLOCKED | The header is correctly emitted, but the endpoint it points to 415s both of its real-world POST callers (RFC 8058 mailbox-client one-click POST and the confirm page's own browser form POST) — the one-click mechanism this requirement exists for does not function. Live-verified against the running server in this pass |

No orphaned requirements — all 14 IDs (CAMP-01..05, SEND-01..07, SUBS-03, SUBS-04) declared across phase plans map to REQUIREMENTS.md's Phase 4 block and were checked above. REQUIREMENTS.md currently marks all 14 `[x]` complete; this verification disputes that status for **SUBS-04** only (all other 13 are now genuinely satisfied, reversing 8 of the 13 prior disputes from the initial verification).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/api/src/modules/delivery/unsubscribe.routes.ts` / `apps/api/src/server.ts` | route registration / server.ts:28-87 | Missing `application/x-www-form-urlencoded` content-type parser for a public POST route that RFC 8058 and an in-repo `<form method="POST">` both target | 🛑 Blocker | One-click unsubscribe never fires for its two real callers — CAN-SPAM/GDPR-adjacent compliance gap and sender-reputation risk (mailbox providers escalate broken one-click to spam-marking) |
| `apps/worker/src/queues/send-dispatch.ts` | 406-410 | Test-send branch only checks `429 \|\| >=500`; any other non-2xx (400/401/403) falls through to `outcome:"sent"` | ⚠️ Warning | A test send can silently fail (bad template data, revoked key) with no failure signal anywhere in the pipeline (WR-02 in 04-REVIEW.md) |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` (328-336) / `apps/worker/src/queues/campaign-scheduler.worker.ts` (117-121) | status transition then enqueue, not atomic | ⚠️ Warning | An enqueue failure after the `sending` transition commits can strand a campaign permanently (WR-01 in 04-REVIEW.md); no repair path currently re-enqueues |
| `apps/worker/src/queues/campaign-kickoff.worker.ts` (69-195) | Redelivery re-walk recomputes totals from live gate state instead of the ledger | ⚠️ Warning | A crash mid-fan-out (before `fan_out_complete`) can desync `sendable_total`/progress from the ledger on redelivery, in rare cases permanently stranding a campaign in `sending` (WR-03) |
| `apps/worker/src/queues/campaign-scheduler.worker.ts` (102-106) | `tickQueue` has no `removeOnComplete`, and `void tickQueue.add(...)` discards a rejecting promise | ⚠️ Warning | Unbounded Redis key growth (~1,440/day) and a possible unhandled-rejection process crash on Redis hiccup (WR-04) |
| `apps/api/src/modules/campaigns/campaign.repository.ts` (175-191) | Stale `from_email` can survive a `fromSenderId:null` patch | ⚠️ Warning | Currently unreachable via the shipped UI (no clear-sender affordance); latent API-contract gap (WR-05) |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` (309-440) | 403 vs 404 inconsistency between read/CRUD routes and launch/schedule/cancel/duplicate | ⚠️ Warning | Authenticated non-members can use launch/cancel to confirm workspace-slug existence, contradicting the rest of the module's anti-enumeration design (WR-06) |

No `TODO`/`FIXME`/`XXX`/`TBD`/`HACK`/`PLACEHOLDER` debt markers found in the phase's modified files (checked directly, not merely quoted from the review).

### Human Verification Required

None — the remaining gap (415 on urlencoded POST) is confirmed by direct, reproducible behavioral evidence against the running application, not requiring runtime/visual/UX judgment.

### Gaps Summary

Gap-closure plans 04-09 through 04-13 genuinely close 6 of the 7 Critical findings from the original code review (CR-02 through CR-07), all independently re-verified in this pass by reading the actual current code and re-running the relevant test suites (152/152 apps/api, 39/39 apps/worker, 25/25 packages/delivery-core, zero regressions). The old CR-01 (reflected XSS on the unsubscribe confirm page) is also genuinely fixed and test-covered.

However, the fresh post-fix code review (`04-REVIEW.md`) surfaced a **new** Critical finding this verification independently reproduced with a live behavioral probe: `POST /unsubscribe/:token` has no content-type parser for `application/x-www-form-urlencoded`, so Fastify's default parser set (json + text/plain only) rejects it with 415 before the route handler ever runs. This breaks both of the endpoint's two real-world callers — the RFC 8058 one-click POST that mailbox providers (Gmail, Yahoo) are required to send, and the confirm page's own `<form method="POST">` that this same phase built. The existing test suites (`unsubscribe.test.ts`, `unsubscribe-xss.test.ts`) never catch this because `app.inject` without an explicit `Content-Type` header takes Fastify's empty-body fast path, bypassing the content-type parser entirely.

This is the single remaining blocker to the phase goal: every other piece of "emails reliably reach inboxes... with a one-click List-Unsubscribe header" now works, but the receiving half of that header's contract is non-functional. The fix is small and well-scoped (register one content-type parser inside `registerUnsubscribeRoutes`, add 2 regression tests that set an explicit `Content-Type` header) — recommend routing to `/gsd-plan-phase --gaps` for a single, narrow closure plan before considering Phase 4 complete.

The remaining 6 Warnings from `04-REVIEW.md` (WR-01 through WR-06) do not block the phase goal — each is either a rare-timing edge case (WR-01, WR-03), an operational/observability gap (WR-02, WR-04), or currently unreachable via the shipped UI (WR-05, WR-06) — but are recorded above for visibility and should be considered for a follow-up hardening pass.

---

_Verified: 2026-07-06T19:05:00Z_
_Verifier: Claude (gsd-verifier)_
