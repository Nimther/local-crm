---
phase: 04-broadcast-campaigns-send-pipeline
verified: 2026-07-07T08:10:00Z
status: gaps_found
score: 8/10 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 9/9
  gaps_closed:
    - "Fail-fast boot validation of UNSUBSCRIBE_TOKEN_SECRET/PUBLIC_APP_URL across scripts/check-env.mjs, apps/api/src/env.ts, apps/worker/src/server.ts (04-16) — confirmed by direct execution: check-env.mjs currently exits 1 with a named error listing exactly the two missing vars"
    - "predev migration bootstrap (scripts/migrate-dev.mjs) wired into root predev ahead of the stack boot (04-16) — confirmed by code read + node --check"
    - "A test send rejected by SendGrid with a 4xx now resolves outcome 'failed', not a false 'sent' (04-17) — confirmed by re-running the worker suite (new regression test passing) and direct code read"
    - "TestSendPanel now labels the auto-filled dynamic_template_data JSON as sample data from a segment contact (04-17) — confirmed present in rendered copy"
    - "Segment editor's D-03 warning now re-checks at save time via a fresh refetch + explicit confirm gate, sharing a pure helper with the mount-time banner, with 8 passing unit tests (04-18) — confirmed by direct code read of the async handleSave and by re-running the new apps/web vitest lane"
  gaps_remaining:
    - "Live UAT re-run of Tests 4/5/6/7/12/13 (env-dependent send/delivery confirmation) — never happened; the required UNSUBSCRIBE_TOKEN_SECRET/PUBLIC_APP_URL are still absent from this repo's .env as of this verification pass (node scripts/check-env.mjs exits 1 right now), so the dev stack cannot currently boot the worker at all. 04-UAT.md's gaps section for these three tests is still status: failed/issue, not updated to closed."
  regressions: []
gaps:
  - truth: "Every email the platform sends — including a marketer's own test send — carries a List-Unsubscribe one-click link that actually works when redeemed, without crashing the public unsubscribe endpoint (SUBS-04, CAMP-04)"
    status: failed
    reason: "NEW critical defect, confirmed by direct code read, unaddressed by gap-closure plans 04-16/04-17/04-18 (none touched this code path). apps/worker/src/queues/send-dispatch.ts's kind='test' branch signs the List-Unsubscribe token with `contactId: contactId ?? \"test-send\"` (line 366). apps/api/src/modules/campaigns/campaigns.routes.ts's test-send route (lines 446-499) never sets a contactId on the enqueued job, so every test send's unsubscribe token is signed with the literal string \"test-send\" — not a UUID. contacts.id is a uuid-typed Postgres column (packages/db/src/schema/contacts.ts:27). When that link is redeemed (a marketer previewing their own test email clicking it, or — per RFC 8058 — Gmail/Yahoo automatically firing the List-Unsubscribe-Post one-click POST), apps/api/src/modules/delivery/unsubscribe.routes.ts's POST handler runs `UPDATE contacts SET subscription_status = 'unsubscribed' ... WHERE id = $1` with payload.contactId = \"test-send\" (line 169). Postgres rejects a non-UUID literal against a uuid column with error 22P02; there is no try/catch around this query and no custom Fastify error handler registered for this route, so the request throws through to Fastify's default handler and 500s. This also breaks the route's own documented invariant (unsubscribe.routes.ts's threat-model comment) that every token disposition — including an unknown/malformed contact — produces a byte-identical response; a structurally-invalid-but-signature-valid contactId instead produces a distinct 500. Flagged as CR-01 (Critical) in 04-REVIEW.md, dated after all three gap-closure plans (files_reviewed includes 04-16/17/18's touched files); independently re-confirmed in this pass by reading send-dispatch.ts:362-370, campaigns.routes.ts's test-send handler (confirmed no contactId is ever set), unsubscribe.routes.ts:155-174, and contacts.ts:27, plus grepping apps/api/src/modules/delivery/__tests__/ for any test covering this path (zero matches — the defect has no regression coverage)."
    artifacts:
      - path: "apps/worker/src/queues/send-dispatch.ts"
        issue: "kind='test' branch (line 362-370) signs an unsubscribe token with contactId literal \"test-send\" whenever the job carries no real contactId — which is every test send, since campaigns.routes.ts's test-send route never sets one"
      - path: "apps/api/src/modules/delivery/unsubscribe.routes.ts"
        issue: "POST handler (line 155-174) passes payload.contactId straight into a parameterized UPDATE against a uuid-typed column with no format validation and no try/catch, so a non-UUID contactId throws an uncaught Postgres error surfaced as a 500 instead of the documented uniform response"
    missing:
      - "Sign the test-send unsubscribe token with a real random UUID (e.g. randomUUID()) instead of the literal string \"test-send\" when contactId is absent, so a redeemed link always finds either a real contact or an unknown-but-valid-UUID (0 rows updated, still 2xx)"
      - "Defense-in-depth: guard unsubscribe.routes.ts's POST handler against a non-UUID contactId, treating it exactly like an unknown contact (no mutation, same 2xx/HTML response) rather than letting it reach the UPDATE unguarded"
      - "A regression test exercising POST /unsubscribe/:token with a test-send-shaped token to pin the fix and prevent recurrence"
deferred: []
human_verification:
  - test: "Add UNSUBSCRIBE_TOKEN_SECRET (openssl rand -base64 32) and PUBLIC_APP_URL (http://localhost:4000) to .env and .env.example (per 04-16's user_setup — the harness cannot write .env* paths), then run `npm run dev` and re-run UAT Tests 4, 5, 6, 7, 12, and 13 end-to-end against a live SendGrid send."
    expected: "The stack boots cleanly (no UNSUBSCRIBE_TOKEN_SECRET error from the worker; predev applies any pending migrations). A test send reaches a real inbox rendered via the SendGrid Dynamic Template (Test 4). Launching a broadcast advances sent_count past 0 and recipients receive the email (Test 5), with live progress updates visible (Test 6) and the email present in the inbox with a working List-Unsubscribe header (Test 7). Editing a segment referenced by a scheduled campaign shows the D-03 confirm gate at save time (Test 12). After unsubscribing, a second broadcast to the same segment excludes that contact (Test 13)."
    why_human: "Requires a live SendGrid send and a real inbox; also requires the developer to populate two secrets the harness is denied from writing to .env*. This is exactly the live confirmation 04-16/04-17/04-18 themselves deferred as human_judgment:true / status:unknown — it has not happened yet. Running `node scripts/check-env.mjs` in this verification pass confirms the two vars are still absent right now, so the dev stack cannot currently boot the worker at all."
---

# Phase 4: Broadcast Campaigns & Send Pipeline Verification Report

**Phase Goal:** As a marketer, I want to send a real broadcast to a segment through a throttled, idempotent, suppression-aware queue, so that emails reliably reach inboxes via SendGrid Dynamic Templates.
**Verified:** 2026-07-07T08:10:00Z
**Status:** gaps_found
**Re-verification:** Yes — after gap-closure round 4 (plans 04-16, 04-17, 04-18), following UAT session 2 which found 3 new issues (Tests 4, 5, 12) beyond the previously-closed pageSize/400 blocker.

## Goal Achievement

The prior VERIFICATION.md (2026-07-06T23:30:00Z) certified the phase `passed` 9/9 on the strength of the 04-15 pageSize fix. That pass explicitly noted it did **not** cover the separate manual UAT click-through beyond step 3. A subsequent UAT session (`04-UAT.md`, "UAT session 2") ran steps 4-66 and found three new genuine defects (Tests 4, 5, 12 — all previously listed `status: failed` in `04-UAT.md`'s `## Gaps` section), which spawned gap-closure round 4 (plans 04-16, 04-17, 04-18, all `gap_closure: true`).

**This verification does not trust any SUMMARY.md's claims for 04-16/17/18, nor the prior VERIFICATION.md's "passed" status.** It re-read every file each plan touched, re-ran the full workspace test suite once, independently executed `scripts/check-env.mjs` against the actual repo `.env` (not a fixture) to observe its real current behavior, traced the worker boot-guard ordering directly, and — critically — read the send-dispatch/unsubscribe code path end-to-end rather than accepting the gap-closure plans' framing that "the send pipeline can now dispatch." That direct trace surfaced a **new, unaddressed Critical defect (CR-01 in `04-REVIEW.md`)** that none of the three gap-closure plans touch: a test send's List-Unsubscribe token is signed with a non-UUID placeholder contact id, and redeeming that link 500s the public unsubscribe endpoint.

**Verdict: the phase goal is NOT yet fully achieved.** The three gap-closure plans (04-16/17/18) are each genuinely and correctly implemented at the code level — confirmed independently below — but (a) a new Critical defect exists in the send/unsubscribe path that no plan has fixed, and (b) the live, env-dependent confirmation that emails actually reach an inbox (the phase goal's own outcome clause) still has not happened: this repo's `.env` is, as of this verification, still missing the two vars 04-16 added fail-fast validation for, so `npm run dev` cannot currently boot the worker at all.

### Observable Truths

**Original 5 roadmap-level success criteria:**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can create a campaign, choose segment + template, and send a test email with sample dynamic data | ✓ VERIFIED (creation) / ⚠️ affected (test-send reliability) | Campaign creation/segment-picker/template-picker all still correct (unchanged since 04-15). Test-send delivery is currently blocked by the missing `.env` vars (see gap below) and its List-Unsubscribe link is broken by the new CR-01 defect (see Gaps) |
| 2 | Campaign has a working draft → scheduled → sending → sent state machine; draft can't be sent by accident | ✓ VERIFIED | Unchanged; `campaign-state-machine.test.ts` still passing (part of apps/api's 155/155) |
| 3 | Live progress (sent/total) shown during sending; suppressed/unsubscribed filtered before send | ✓ VERIFIED | Unchanged; counters and `evaluatePreSendGate` logic untouched by 04-16/17/18 |
| 4 | Every send goes through SendGrid v3 mail/send with List-Unsubscribe header, respects global frequency cap, no duplicates on retry | ✓ VERIFIED for `kind='campaign'` sends / ✗ FAILED for `kind='test'` sends | Broadcast-send unsubscribe tokens always carry a real contact UUID (contactId is required and validated for `kind='campaign'`, `send-dispatch.ts:280-282`) — that path is sound. Test-send tokens are signed with a literal non-UUID string — see Gaps (CR-01) |
| 5 | Sends throttled per tenant RPS, reserved triggered-priority lane, survive 429/5xx with backoff without losing emails | ✓ VERIFIED | Unchanged; rate-limiter and backoff logic untouched by 04-16/17/18 |

**Gap-closure round 4 must-haves (04-16, 04-17, 04-18 — this pass's primary focus):**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 6 | `npm run dev` / the worker / the API all fail fast with a named, actionable error when `UNSUBSCRIBE_TOKEN_SECRET` or `PUBLIC_APP_URL` is missing, instead of crashing per-send-job | ✓ VERIFIED | Directly executed `node scripts/check-env.mjs` against this repo's real `.env` — it exits 1 right now with `Env check failed: 2 required variable(s) missing... - UNSUBSCRIBE_TOKEN_SECRET - PUBLIC_APP_URL`, proving the check is live and correctly wired (not just present in a fixture test). `apps/worker/src/server.ts:54-65` guards run before any Redis connection or Worker is constructed (confirmed by direct read). `apps/api/src/env.ts:28-31` zod fields confirmed present (`.min(32,...)`, `.url()`) |
| 7 | `npm run dev` applies pending Drizzle migrations before boot (predev bootstrap) | ✓ VERIFIED | `package.json`'s `predev` = `"node scripts/check-env.mjs && node scripts/migrate-dev.mjs"` (confirmed by direct read); `scripts/migrate-dev.mjs` passes `node --check`; per 04-16's own execution log migrations 0017-0019 were applied against this repo's real DB during that session |
| 8 | A test send whose SendGrid call returns a non-retryable 4xx is reported `outcome: "failed"`, never a false `"sent"` | ✓ VERIFIED | `send-dispatch.ts:415-417` (`kind='test'` branch) now has the `response.status >= 400 → { outcome: "failed", sendId }` guard mirroring the campaign branch; worker suite re-run: 40/40 passing (up from 39), including the new `SEND-07: a test-send 4xx is reported failed, never sent` test |
| 9 | Test-send panel clarifies the auto-filled JSON is sample data from a segment contact | ✓ VERIFIED | `TestSendPanel.tsx:87` confirmed present: "Это пример данных реального контакта из сегмента кампании (включая его email) — письмо всё равно уйдёт на..." |
| 10 | Saving a segment referenced by a scheduled campaign re-fetches referencing campaigns AT SAVE TIME and requires explicit confirm before committing; a failed lookup is surfaced, not swallowed | ✓ VERIFIED | `SegmentDetailPage.tsx` confirmed: `handleSave` awaits `referencingCampaignsQuery.refetch()` (line 255) before consulting `findBlockingScheduledCampaign` (line 264, shared with the mount-time banner at line 175); `referencingCampaignsQuery.isError` rendered at line 311. `apps/web`'s new vitest lane: 8/8 passing (`segmentSaveGate.test.ts`) |

**New defect surfaced in this pass (not a pre-existing must-have, but directly blocks the phase goal's reliability clause):**

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 11 | Every email the platform sends — including a test send — carries a List-Unsubscribe link that works when redeemed, without crashing the public endpoint | ✗ FAILED | See Gaps section (CR-01) |

**Score:** 8/10 (truths 1 and 4 partially fail due to the new CR-01 defect scoped to test-send; truth 11 fails outright)

### Required Artifacts (04-16/17/18)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `scripts/check-env.mjs` | Requires `UNSUBSCRIBE_TOKEN_SECRET`/`PUBLIC_APP_URL` | ✓ VERIFIED | Lines 57-58; live-executed, currently correctly failing against the real `.env` |
| `apps/api/src/env.ts` | zod schema enforces both vars | ✓ VERIFIED | Lines 28-31 |
| `apps/worker/src/server.ts` | `buildWorker()` throws before any Worker is constructed | ✓ VERIFIED | Lines 54-65, confirmed ordering precedes `createRedisConnection`/Worker array (line 67+) |
| `scripts/migrate-dev.mjs` | Loads root `.env`, requires `DATABASE_URL`, runs `db:migrate` | ✓ VERIFIED | `node --check` passes; wired into `predev` |
| `apps/worker/src/queues/send-dispatch.ts` (`kind='test'` 4xx guard) | `response.status >= 400 → failed` | ✓ VERIFIED, wired | Lines 415-417; regression test passing |
| `apps/web/.../TestSendPanel.tsx` | Sample-data clarification copy | ✓ VERIFIED, wired | Line 87 |
| `apps/web/.../segmentSaveGate.ts` | Pure `findBlockingScheduledCampaign` helper | ✓ VERIFIED, wired | 8 unit tests passing, shared by both banner and save gate |
| `apps/web/.../SegmentDetailPage.tsx` (save-time gate) | `handleSave` refetches + gates before mutate | ✓ VERIFIED, wired | Lines 255, 264, 311 |
| `apps/web/vitest.config.ts` + `package.json` test script | New web unit-test lane | ✓ VERIFIED | `npm run test -w @mega-crm/web` → 1 file / 8 tests passing |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `scripts/check-env.mjs` | root `predev` | package.json script chaining | ✓ WIRED | `"predev": "node scripts/check-env.mjs && node scripts/migrate-dev.mjs"` |
| `apps/worker/src/server.ts` boot guards | `buildWorker()` | Guard placement before Redis/Worker construction | ✓ WIRED | Confirmed by direct read, lines 54-83 |
| `send-dispatch.ts` `kind='test'` 4xx guard | `SendJobResult` union | Existing `{outcome:"failed",sendId}` variant, no type change needed | ✓ WIRED | Lines 415-417 |
| `segmentSaveGate.ts`'s `findBlockingScheduledCampaign` | `SegmentDetailPage.tsx` mount-time banner AND save-time gate | Both call sites import the same helper | ✓ WIRED | Lines 175 and 264 — single source of truth confirmed |
| `SegmentDetailPage.tsx` `handleSave` | `referencingCampaignsQuery.refetch()` | `await` before computing `blocking` | ✓ WIRED | Line 255 precedes line 264 |
| **`send-dispatch.ts` `kind='test'` unsubscribe token** | **`unsubscribe.routes.ts` POST handler** | **Signed token → `verifyUnsubscribeToken` → UUID-typed `UPDATE ... WHERE id = $1`** | **✗ BROKEN** | **Non-UUID `contactId` ("test-send") flows unguarded into a uuid column; see Gaps (CR-01)** |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full workspace test suite, single run | `npm test` (all 6 workspaces) | apps/api 155/155, apps/web 8/8 (new lane), apps/worker 40/40 (up from 39 — new SEND-07 test-send regression), delivery-core 25/25, segments-core 19/19, shared-schemas 18/18 — 265 total, zero failures | ✓ PASS |
| `check-env.mjs` reflects the REAL current `.env` state (not a synthetic fixture) | `node scripts/check-env.mjs` | Exits 1: `Env check failed: 2 required variable(s) missing... UNSUBSCRIBE_TOKEN_SECRET, PUBLIC_APP_URL` | ✓ PASS (confirms the guard is live and currently, correctly, blocking dev boot) |
| `apps/api`, `apps/worker`, `apps/web` all typecheck/build clean | `npm run build -w @mega-crm/api / @mega-crm/worker / @mega-crm/web` | All three clean, zero errors | ✓ PASS |
| `migrate-dev.mjs` is valid JS and predev chains it | `node --check scripts/migrate-dev.mjs`; read `package.json` | Valid; `predev` = `check-env.mjs && migrate-dev.mjs` | ✓ PASS |
| CR-01 reproduction trace (no live DB call made — pure code trace, no state mutated) | Read `send-dispatch.ts:362-370`, `campaigns.routes.ts:446-499` (confirmed no `contactId` ever set for test-send), `unsubscribe.routes.ts:155-174`, `packages/db/src/schema/contacts.ts:27` (`id: uuid(...)`) | Confirms the non-UUID `"test-send"` literal reaches a uuid-typed `UPDATE ... WHERE id = $1` unguarded, with no try/catch and no matching regression test (`grep` for `test-send`/`contactId.*test` in `apps/api/.../delivery/__tests__/` → zero matches) | ✗ FAIL (defect confirmed real) |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| CAMP-01 | Create campaign: segment + template | ✓ SATISFIED | Unchanged since 04-15 |
| CAMP-02 | Launch immediately or schedule | ✓ SATISFIED | Unchanged |
| CAMP-03 | State machine draft→scheduled→sending→sent; no accidental send | ✓ SATISFIED | Unchanged |
| CAMP-04 | Test send with sample dynamic data | ⚠️ PARTIALLY SATISFIED | Test-send enqueue/UI/4xx-observability logic is correct (04-17), but (a) delivery is currently blocked by missing `.env` vars in this environment and (b) the test-send's List-Unsubscribe link 500s when redeemed (CR-01) |
| CAMP-05 | Live progress display (sent/total) | ✓ SATISFIED | Unchanged; 04-16's migration fix keeps `fan_out_complete`/counters queryable |
| SEND-01 | All sends via queue, no direct sends | ✓ SATISFIED | Unchanged |
| SEND-02 | Per-tenant RPS throttle | ✓ SATISFIED | Unchanged |
| SEND-03 | Triggered priority over broadcast | ✓ SATISFIED | Unchanged |
| SEND-04 | Global frequency cap via unified ledger | ✓ SATISFIED | Unchanged |
| SEND-05 | mail/send with template_id + dynamic_template_data | ✓ SATISFIED | Unchanged for the mail/send call shape itself |
| SEND-06 | Idempotent sends, no duplicates on retry | ✓ SATISFIED | Unchanged |
| SEND-07 | 429/5xx handled with backoff, no lost emails | ✓ SATISFIED | Unchanged; plus 04-17 closes the adjacent 4xx-observability gap in the test-send path |
| SUBS-03 | Pre-send filter by subscription/suppression | ✓ SATISFIED | Unchanged |
| SUBS-04 | List-Unsubscribe one-click header | ⚠️ PARTIALLY SATISFIED | Header is present and functionally correct for every real broadcast/triggered send (contactId always a validated UUID); **broken for test sends specifically** — CR-01 |

No orphaned requirements — all 14 IDs (CAMP-01..05, SEND-01..07, SUBS-03, SUBS-04) declared across phase plans map to `REQUIREMENTS.md`'s Phase 4 block, all currently marked `[x]`/`Complete`. **This verification finds that marking is not fully accurate**: CAMP-04 and SUBS-04 have a genuine, confirmed, unaddressed Critical defect scoped to the test-send path.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `apps/worker/src/queues/send-dispatch.ts:366` + `apps/api/.../unsubscribe.routes.ts:169` | — | Non-UUID `contactId` placeholder signed into a real unsubscribe token, unguarded uuid-column UPDATE | 🛑 **Blocker** | Confirmed real (CR-01) — see Gaps |
| `apps/api/.../campaign.repository.ts` `scheduleCampaign` | 239-262 | No completeness check (template/sender/segment) before scheduling, unlike `launchCampaign` | ⚠️ Warning | Non-blocking per 04-REVIEW.md (WR-01); a direct-API caller could wedge a campaign in `sending` at due time. Carried forward, not yet fixed |
| `apps/api/.../campaigns.routes.ts:328-336` | — | Launch's status commit and kickoff enqueue are not atomic; no reconciliation path | ⚠️ Warning | Carried forward (WR-02), non-blocking |
| `apps/worker/.../recipient-snapshot.ts:56-75,125-131` | — | Cursor/termination logic can silently truncate the snapshot under BullMQ concurrent stalled-job redelivery | ⚠️ Warning | Carried forward (WR-03), non-blocking per review (requires a specific BullMQ stalled-job race) |
| `apps/worker/.../campaign-kickoff.worker.ts:111-147` | — | Redelivery re-walk mis-accounts `sendable_total`/`excluded_total` against already-sent recipients | ⚠️ Warning | Carried forward (WR-04), non-blocking |
| `apps/api/.../sender-resolver.ts:92-97` | — | `resolveCampaignFromEmail` persists `from_email` on any-status campaigns, including terminal ones | ⚠️ Warning | Carried forward (WR-05), non-blocking |
| `apps/api/.../campaigns.routes.ts:446-499`, `apps/web/.../TestSendPanel.tsx:52-55` | — | Test-send route doesn't validate `templateId`; UI toasts success on queue-accept, not delivery | ⚠️ Warning | Carried forward (WR-06), non-blocking; adjacent to but distinct from CR-01 |
| `apps/worker/.../campaign-scheduler.worker.ts:106` | — | `void tickQueue.add(...)` discards a rejecting promise (fire-and-forget scheduler registration) | ⚠️ Warning | Carried forward (WR-07), non-blocking |
| Various (IN-01 through IN-09 in `04-REVIEW.md`) | — | Rate-limiter cache keying, verified-sender pagination, RLS NULLIF-guard gaps on sibling tables, discarded 422 field errors, `frequencyCap:0` edge case, live vs frozen sendable count, KMS unvalidated at boot, deleted-contact exclusion mislabeling | ℹ️ Info | Non-blocking hardening items, carried forward/newly noted by `04-REVIEW.md` |

No `TODO`/`FIXME`/`XXX`/`TBD`/`HACK`/`PLACEHOLDER` debt markers found in any of the 8 files 04-16/17/18 touched (checked directly via grep in this pass).

### Human Verification Required

1. **Populate `.env` and re-run the live UAT flow (Tests 4/5/6/7/12/13)**
   - **Test:** Add `UNSUBSCRIBE_TOKEN_SECRET` (`openssl rand -base64 32`) and `PUBLIC_APP_URL` (`http://localhost:4000`) to `.env` and `.env.example`, restart `npm run dev`, then click through UAT Tests 4, 5, 6, 7, 12, 13 against a real SendGrid send.
   - **Expected:** Stack boots cleanly; a test send reaches a real inbox; a launched broadcast advances `sent_count` past 0 and delivers; live progress updates; the D-03 confirm gate appears at save time for a segment referenced by a scheduled campaign; a second broadcast after unsubscribing excludes that contact.
   - **Why human:** Requires a live SendGrid send/real inbox and developer action on `.env` (harness-denied path). This is the exact confirmation 04-16/17/18 each deferred as `human_judgment: true`/`status: unknown` — it has not happened. `node scripts/check-env.mjs` in this pass confirms the two vars are still absent, so the dev stack cannot currently boot the worker.

### Gaps Summary

Gap-closure round 4 (plans 04-16, 04-17, 04-18) is **genuinely and correctly implemented** at the code level for everything each plan explicitly scoped: fail-fast env validation, predev migration bootstrap, test-send 4xx observability + sample-data copy, and the D-03 save-time gate. All are independently re-confirmed in this pass (265/265 tests passing across 6 workspaces, up from 256 at the prior verification; three clean builds; live execution of `check-env.mjs` and `node --check` on the new script).

However, two things prevent the phase goal from being fully achieved:

1. **A new, unaddressed Critical defect (CR-01)**, confirmed by direct code trace in this pass: a test send's List-Unsubscribe token is signed with a non-UUID placeholder `contactId`, and redeeming that link (a marketer's own click, or a mail client's automatic RFC 8058 one-click POST) causes an uncaught Postgres type error and a 500 on the public unsubscribe endpoint. This is scoped to `kind='test'` sends only — real broadcast/triggered sends always carry a validated real contact UUID and are unaffected — but it is squarely inside CAMP-04 (test send) and SUBS-04 (one-click unsubscribe reliability), both phase requirements marked `[x] Complete` in `REQUIREMENTS.md`. No plan has touched this code path; it has zero regression coverage.

2. **The live, env-dependent confirmation that emails actually reach an inbox has not happened.** This repo's `.env` is still missing the two vars 04-16 added fail-fast validation for — confirmed by directly running `node scripts/check-env.mjs`, which exits 1 right now. Until a human adds those secrets and re-runs the UAT click-through, the phase's own outcome clause ("so that emails reliably reach inboxes") remains unconfirmed live, even though every code path it depends on now checks out correctly on inspection.

**Recommended next step:** a small gap-closure plan for CR-01 (sign a real UUID for test-send tokens and/or guard the unsubscribe route against a non-UUID contactId, plus a regression test), followed by the human `.env` setup + live UAT re-run before the phase is re-verified.

---

_Verified: 2026-07-07T08:10:00Z_
_Verifier: Claude (gsd-verifier)_
