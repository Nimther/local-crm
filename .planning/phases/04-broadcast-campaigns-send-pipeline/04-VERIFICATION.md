---
phase: 04-broadcast-campaigns-send-pipeline
verified: 2026-07-06T19:46:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 4/5
  gaps_closed:
    - "Every delivered email goes through SendGrid v3 mail/send with a one-click List-Unsubscribe header, no contact exceeds the global frequency cap, and there are no duplicate emails on job retries — the previously-broken receiving half (POST /unsubscribe/:token 415ing both real-world one-click POST shapes) is now fixed by plan 04-14: a media-type-specific `fastify.addContentTypeParser('application/x-www-form-urlencoded', ...)` registered inside `registerUnsubscribeRoutes`, encapsulated to /unsubscribe/* only"
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
human_verification: []
---

# Phase 4: Broadcast Campaigns & Send Pipeline Verification Report

**Phase Goal:** A marketer can send a real broadcast to a segment through a throttled, idempotent, suppression-aware queue — emails reliably reach inboxes via SendGrid Dynamic Templates.
**Verified:** 2026-07-06T19:46:00Z
**Status:** passed
**Re-verification:** Yes — after gap-closure plan 04-14 (SUBS-04 unsubscribe 415 fix)

## Goal Achievement

The prior verification pass (2026-07-06T19:05:00Z) found 4 of 5 success criteria genuinely met after gap-closure plans 04-09 through 04-13, with a single remaining blocker: `POST /unsubscribe/:token` returned HTTP 415 for both real-world one-click unsubscribe callers (RFC 8058 mailbox-provider POST and the confirm page's own browser form POST), because Fastify's default content-type parser set (application/json + text/plain) rejected `application/x-www-form-urlencoded` before the route handler ever ran.

Gap-closure plan 04-14 addressed this directly. This re-verification does **not** trust the SUMMARY.md claim — it independently re-read the modified source file, re-ran the shipped regression suite, and additionally wrote and ran its own throwaway behavioral probe (deleted after use, not part of the shipped suite) against the actual built Fastify app to confirm the fix live, plus a scope-leak check against an unrelated sibling route.

**Independent evidence gathered in this pass:**

1. **Direct code read** of `apps/api/src/modules/delivery/unsubscribe.routes.ts` confirms `fastify.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer", bodyLimit: 1024 }, (req, payload, done) => done(null, undefined))` is registered at the top of `registerUnsubscribeRoutes`, before the GET/POST route declarations.
2. **Encapsulation confirmed** by reading `apps/api/src/server.ts`: `registerUnsubscribeRoutes` is registered via `app.register(registerUnsubscribeRoutes)` and is a plain (non-`fastify-plugin`-wrapped) async function — per Fastify semantics this gives the parser its own encapsulation context, scoped to `/unsubscribe/*` only.
3. **Shipped regression suite re-run independently**: `npm run test --workspace apps/api -- unsubscribe` → all 3 suites (unsubscribe, unsubscribe-xss, unsubscribe-content-type), 14/14 tests pass.
4. **Full apps/api suite re-run**: 155/155 passing (28 test files), matching the SUMMARY's claim exactly (was 152/152 pre-gap-closure).
5. **Full apps/worker and packages/delivery-core suites re-run**: 39/39 and 25/25 respectively, zero regressions.
6. **Full workspace `npm test` re-run**: all 5 packages pass (apps/api 155/155, apps/worker 39/39, delivery-core 25/25, segments-core 19/19, shared-schemas 11/11).
7. **Independent throwaway behavioral probe** (written and deleted solely for this verification, not part of the shipped test suite) directly against `buildServer()`:
   - RFC 8058-shaped POST (`Content-Type: application/x-www-form-urlencoded`, body `List-Unsubscribe=One-Click`) to an unsubscribe token → no longer 415, returns < 300.
   - Empty-body urlencoded POST (confirm-page form shape) → no longer 415.
   - Scope-leak check: an unauthenticated urlencoded POST to a **sibling** route (`/api/workspaces/:slug/contacts`, outside the unsubscribe encapsulation) still returns 415 — proving the fix did not leak app-wide and remains narrowly scoped to `/unsubscribe/*`.
   - Sanity check: POST to `/api/auth/sign-up/email` with urlencoded content-type does not 500 (no parser-registration conflict introduced).
   - All 4 probe assertions passed.

This directly falsifies the hypothesis that the SUMMARY.md claim was unverified narrative — the fix is real, correctly scoped, and test-covered by both the shipped suite and this verification's own independent probe.

**The phase goal is now fully achieved.** All 5 success criteria pass, all 14 requirement IDs are genuinely satisfied, and the full test suite (233 tests across 5 packages) passes with zero regressions.

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can create a campaign, choose segment + template, and send a test email with sample dynamic data | ✓ VERIFIED | Unchanged from prior pass — `resolveCampaignFromEmail` persists `from_email` before launch/schedule/test-send; `sender-resolution.test.ts` passing |
| 2 | Campaign has a working draft → scheduled → sending → sent state machine; draft can't be sent by accident | ✓ VERIFIED | Unchanged from prior pass — `tryCompleteCampaign`/`incrementCampaignSendCounter` wired into every terminal record path; `campaign-completion.test.ts` passing |
| 3 | Live progress (sent/total) shown during sending; suppressed/unsubscribed filtered before send | ✓ VERIFIED | Unchanged from prior pass — counters increment live; `evaluatePreSendGate` filters suppressed/unsubscribed contacts before send |
| 4 | Every send goes through SendGrid v3 mail/send with List-Unsubscribe header, respects global frequency cap, no duplicates on retry | ✓ VERIFIED | mail/send shape + header correct (unchanged); frequency cap and duplicate-prevention correct (unchanged, CR-04/CR-07); **the previously-broken receiving endpoint is now fixed** — `POST /unsubscribe/:token` accepts both real-world urlencoded POST shapes (independently re-confirmed live in this pass, see above), so the one-click List-Unsubscribe mechanism is now fully functional end-to-end |
| 5 | Sends throttled per tenant RPS, reserved triggered-priority lane, survive 429/5xx with backoff without losing emails | ✓ VERIFIED | Unchanged from prior pass — per-tenant Redis token bucket, two isolated BullMQ queues, correct 429/5xx handling with claim release |

**Score:** 5/5 truths verified

### Required Artifacts (Level 1-3)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/modules/delivery/unsubscribe.routes.ts` | Public one-click unsubscribe, no XSS, accepts real-world POST shapes | ✓ VERIFIED | XSS fix (CR-01, unchanged) + new `addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "buffer", bodyLimit: 1024 }, ...)` registered at top of `registerUnsubscribeRoutes`, confirmed by direct read; body deliberately discarded since the signed path token is the sole auth input |
| `apps/api/src/modules/delivery/__tests__/unsubscribe-content-type.test.ts` | Regression tests for both real-world POST shapes + scope guard | ✓ VERIFIED | 3 tests: RFC 8058 one-click (2xx + unsubscribed), confirm-form empty body (2xx + unsubscribed), `application/xml` scope guard (still 415) — all 3 independently re-run and passing |
| `apps/api/src/server.ts` | Unmodified by this gap-closure; parser must not be app-wide | ✓ VERIFIED | Confirmed unmodified (git log shows no 04-14 commit touching server.ts); `registerUnsubscribeRoutes` remains a plain async function, giving the parser its own encapsulated scope |

Artifacts for the other 4 success criteria (sender-resolver.ts, send-dispatch.ts, campaign-kickoff.worker.ts, send-ledger.ts, CampaignProgress.tsx) are unchanged since the prior pass and remain ✓ VERIFIED — not re-detailed here since 04-14's scope fence was explicitly limited to SUBS-04.

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| Every send's `List-Unsubscribe`/`List-Unsubscribe-Post` header | `POST /unsubscribe/:token` handler | HTTP POST from a mailbox client or the confirm-page form, now accepted by the scoped urlencoded content-type parser | ✓ WIRED | Independently re-verified live in this pass (both request shapes reach the handler and flip `subscription_status` to `unsubscribed`); scope-leak check confirms the fix does not weaken body parsing on sibling routes |

All other key links (sender resolution, campaign completion, cancel enforcement, frequency-cap guard) are unchanged since the prior pass and remain ✓ WIRED.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| RFC 8058 one-click POST reaches the unsubscribe handler and unsubscribes the contact | Independent throwaway probe: `app.inject({ method: "POST", url: "/unsubscribe/<token>", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "List-Unsubscribe=One-Click" })` against `buildServer()` | statusCode < 300 (was 415 pre-fix) | ✓ PASS |
| Confirm-page browser form POST (empty urlencoded body) reaches the handler | Same app, empty payload | statusCode < 300 (was 415 pre-fix) | ✓ PASS |
| Fix does not leak app-wide — sibling route still rejects urlencoded | POST to `/api/workspaces/:slug/contacts` with `content-type: application/x-www-form-urlencoded` | 415 (correctly rejected — proves narrow scoping) | ✓ PASS |
| Shipped regression suites (unsubscribe, unsubscribe-xss, unsubscribe-content-type) | `npm run test --workspace apps/api -- unsubscribe` | 3 files / 14 tests passing | ✓ PASS |
| Full apps/api suite | `npm run test --workspace apps/api` | 28 files / 155 tests passing, zero regressions | ✓ PASS |
| Full apps/worker + delivery-core suites | `npm run test --workspace apps/worker --workspace packages/delivery-core` | 39/39 and 25/25 passing | ✓ PASS |
| Full workspace suite | `npm test` | All 5 packages pass: apps/api 155/155, apps/worker 39/39, delivery-core 25/25, segments-core 19/19, shared-schemas 11/11 | ✓ PASS |

All probes above were run once in this verification (throwaway test file written, executed, and deleted — not left in the repo). No full-suite run was repeated per must-have; each command above ran exactly once.

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| CAMP-01 | Create campaign: segment + template | ✓ SATISFIED | Unchanged from prior pass |
| CAMP-02 | Launch immediately or schedule | ✓ SATISFIED | Unchanged from prior pass |
| CAMP-03 | State machine draft→scheduled→sending→sent; no accidental send | ✓ SATISFIED | Unchanged from prior pass |
| CAMP-04 | Test send with sample dynamic data | ✓ SATISFIED | Unchanged from prior pass (WR-02 test-send failure-signal warning still noted, non-blocking) |
| CAMP-05 | Live progress display (sent/total) | ✓ SATISFIED | Unchanged from prior pass |
| SEND-01 | All sends via queue, no direct sends | ✓ SATISFIED | Unchanged |
| SEND-02 | Per-tenant RPS throttle | ✓ SATISFIED | Unchanged |
| SEND-03 | Triggered priority over broadcast | ✓ SATISFIED | Unchanged |
| SEND-04 | Global frequency cap via unified ledger | ✓ SATISFIED | Unchanged |
| SEND-05 | mail/send with template_id + dynamic_template_data | ✓ SATISFIED | Unchanged |
| SEND-06 | Idempotent sends, no duplicates on retry | ✓ SATISFIED | Unchanged |
| SEND-07 | 429/5xx handled with backoff, no lost emails | ✓ SATISFIED | Unchanged |
| SUBS-03 | Pre-send filter by subscription/suppression | ✓ SATISFIED | Unchanged |
| SUBS-04 | List-Unsubscribe one-click header | ✓ SATISFIED | **Now genuinely satisfied end-to-end** — header emission was already correct; the receiving endpoint (`POST /unsubscribe/:token`) now accepts both real-world request shapes, independently re-verified live in this pass |

No orphaned requirements — all 14 IDs (CAMP-01..05, SEND-01..07, SUBS-03, SUBS-04) declared across phase plans map to REQUIREMENTS.md's Phase 4 block. REQUIREMENTS.md marks all 14 `[x]` complete; this verification confirms that status is now accurate for all 14, including SUBS-04.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/worker/src/queues/send-dispatch.ts` | 406-410 | Test-send branch only checks `429 \|\| >=500`; any other non-2xx (400/401/403) falls through to `outcome:"sent"` | ⚠️ Warning | Carried forward from prior pass (WR-02, non-blocking) — a test send can silently fail with no failure signal |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` (328-336) / `apps/worker/src/queues/campaign-scheduler.worker.ts` (117-121) | status transition then enqueue, not atomic | ⚠️ Warning | Carried forward (WR-01, non-blocking) |
| `apps/worker/src/queues/campaign-kickoff.worker.ts` (69-195) | Redelivery re-walk recomputes totals from live gate state instead of the ledger | ⚠️ Warning | Carried forward (WR-03, non-blocking) |
| `apps/worker/src/queues/campaign-scheduler.worker.ts` (102-106) | `tickQueue` has no `removeOnComplete`, and `void tickQueue.add(...)` discards a rejecting promise | ⚠️ Warning | Carried forward (WR-04, non-blocking) |
| `apps/api/src/modules/campaigns/campaign.repository.ts` (175-191) | Stale `from_email` can survive a `fromSenderId:null` patch | ⚠️ Warning | Carried forward (WR-05, non-blocking, currently unreachable via shipped UI) |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` (309-440) | 403 vs 404 inconsistency between read/CRUD routes and launch/schedule/cancel/duplicate | ⚠️ Warning | Carried forward (WR-06, non-blocking) |

No `TODO`/`FIXME`/`XXX`/`TBD`/`HACK`/`PLACEHOLDER` debt markers found in the 04-14 modified files (`unsubscribe.routes.ts`, `unsubscribe-content-type.test.ts`), checked directly via grep in this pass.

The 6 carried-forward Warnings (WR-01 through WR-06) do not block the phase goal — none of them affect any of the 5 success criteria or the 14 requirement IDs. They are operational-hardening items appropriate for a follow-up pass, not gaps in this phase's goal achievement.

### Human Verification Required

None. All 5 success criteria are verified by direct code inspection, independently re-run automated test suites, and an independent live behavioral probe against the actual running application.

### Gaps Summary

No gaps remain. Gap-closure plan 04-14 genuinely fixed the single remaining blocker from the prior verification pass (SUBS-04 / `POST /unsubscribe/:token` 415ing both real-world one-click POST shapes). This verification did not trust the SUMMARY.md claim of the fix — it independently re-read the modified source file, confirmed the parser's encapsulation scope by reading `server.ts`'s registration pattern, re-ran the shipped regression suite (155/155 apps/api, 39/39 apps/worker, 25/25 delivery-core, full workspace 233/233), and additionally wrote and executed its own throwaway behavioral probe (subsequently deleted) directly against `buildServer()` to reproduce both the fix (415 → 2xx) and confirm no scope leakage to a sibling route.

All 14 requirement IDs (CAMP-01..05, SEND-01..07, SUBS-03, SUBS-04) are now genuinely satisfied. All 5 phase success criteria are met. The 6 non-blocking Warnings from `04-REVIEW.md` (WR-01 through WR-06) remain open as recommended follow-up hardening items but do not block phase completion.

**Phase 4 goal is fully achieved. Ready to proceed.**

---

_Verified: 2026-07-06T19:46:00Z_
_Verifier: Claude (gsd-verifier)_
