---
phase: 05-webhook-processing-delivery-tracking
verified: 2026-07-09T22:55:00Z
status: passed
score: 5/5 truths verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "5/5 truths verified"
  gaps_closed:

    - "Round-5 UAT gap (Test 4, major): campaign delivered/opened counters stayed at zero despite a real delivered+opened email — closed by plan 05-13 (commits d5f47b2 test, 3570314 fix, e4a74fd test). Root cause: SendGrid's Event Webhook flattens mail/send custom args (send_id, workspace_id, campaign_id, test) onto the event JSON's TOP LEVEL — there is no nested custom_args wrapper in real payloads. extractEventRow previously read only event.custom_args?.send_id (always undefined for real events), so every event stored send_id = NULL and the side-effect loop's `if (row.sendId === null) continue` silently skipped fact-column writes and counter increments, while debounceWebhookHealth still fired per batch (exactly the reported split: last-event timestamp updates, metrics stay zero). Fix verified by direct code read of webhook-events.worker.ts (extractEventRow now reads event.send_id / event.test at the top level first, with the nested custom_args read demoted to a defensive fallback; UUID_RE validation and D-15 orphan-nulling preserved unchanged) and by independently re-running the full worker webhook suite: 4 files / 27 tests pass (webhook-events-attribution.test.ts is new, 3 tests; status/idempotency/suppression migrated off the fictional nested fixture shape, all still passing). apps/worker build is clean. Full monorepo suite independently re-run this round: 6 workspaces / 62 files / 378 tests, all green (+3 tests vs. the prior round's 375, matching the one new attribution file)."
  gaps_remaining: []
  regressions: []
deferred: []
human_verification:

  - test: "Live re-run of docs/webhook-live-uat.md Test 4 (send a fresh test campaign over the https tunnel, deliver + open the email) now that the flattened-payload attribution fix (05-13) is in the codebase."
    expected: "The campaign's delivered_count and opened_count increment (no longer zero) after the email is delivered and opened; the send row's delivered_at/first_opened_at are set; send_events.send_id for the new events is non-null."
    why_human: "Requires a live SendGrid send + real inbox interaction (delivery + open) over an https tunnel — cannot be proven by a unit/integration test alone. The code fix + the new webhook-events-attribution.test.ts integration suite (which replays a verbatim flattened payload end-to-end through processWebhookEventBatch) guarantee the attribution path this live send would exercise, but no live confirmation has been recorded since 05-13 landed — 05-UAT.md's most recent entry (round 5, Test 4) is the failure this plan fixes, and no round 6 live UAT session exists yet."

  - test: "Re-run docs/webhook-live-uat.md Test 2 (scope-limited key warns immediately at connect time) with a key that GENUINELY lacks the Event Webhook management scope."
    expected: "Connect succeeds (key is valid for mail.send) but an amber inline warning renders immediately ('нет прав на управление вебхуками...') with no doomed SendGrid API call attempted."
    why_human: "Carried forward, unresolved by any code change: round 5's UAT recorded this test as 'blocked' (blocked_by: third-party) because no genuinely scope-limited SendGrid key was available to the tester ('В сендгриде отсутствует вебхук-менеджмент. Проверить этот момент не удастся'). This is an environment/access limitation, not a code gap — the deterministic short-circuit remains unit-tested (sendgrid-key-webhook-provisioning.test.ts) and unrelated to this round's fix — but the live UI copy has still never been observed with a genuinely scope-limited key."
---

# Phase 5: Webhook Processing & Delivery Tracking Verification Report

**Phase Goal:** A marketer's sent emails show accurate, deduplicated delivery outcomes, and bounces/unsubscribes/spam complaints automatically suppress contacts from future sends.
**Verified:** 2026-07-09T22:55:00Z
**Status:** human_needed
**Re-verification:** Yes — after gap-closure round 5 (plan 05-13, fixing the flattened-webhook-custom-arg attribution bug found in round-5 live UAT)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1a | SendGrid events arrive on the workspace's per-tenant webhook URL and update each message's status in the send log — including correct attribution to the originating send (round-5 gap) | ✓ VERIFIED | **Round-5 gap closed.** Direct code read of `apps/worker/src/queues/webhook-events.worker.ts`'s `extractEventRow` confirms `rawSendId`/`isTest` now read `event.send_id` / `event.test` at the TOP LEVEL first (the shape SendGrid's Event Webhook actually posts), with the nested `event.custom_args` read kept only as a defensive fallback; `UUID_RE` validation and D-15 orphan-nulling are unchanged. Independently re-run this round: `npm run test -w apps/worker -- webhook-events-attribution webhook-events-status webhook-events-idempotency webhook-events-suppression` → 4 files, 27 tests pass (new `webhook-events-attribution.test.ts` proves a verbatim flattened delivered event sets `sends.delivered_at` + increments `campaigns.delivered_count`, a flattened open event sets `first_opened_at` + increments `opened_count`, and the stored `send_events.send_id` resolves non-null). Grep confirms zero remaining nested `custom_args:` fixtures across the three migrated suites. `npm run build -w apps/worker` is clean. |
| 1b | Provisioning is diagnosable and self-explanatory when it fails, including for a non-https callback URL | ✓ VERIFIED | Unchanged since round 4 (05-12); not touched by 05-13. Re-confirmed present by direct code read this round (`sendgrid-webhook-provision.ts` pre-flight `insecure_url` guard; `webhook-warning-copy.ts`; `webhook-settings.routes.ts`'s `PROVISION_ERROR_REASONS`). |
| 1c | Reconnect can always self-heal a workspace's webhook provisioning, including when the SendGrid-side webhook was deleted or the key was rotated | ✓ VERIFIED | Unchanged since round 3 (CR-01, 05-11); not touched by 05-13. Live-confirmed in round-5 UAT (Test 3: pass). |
| 2 | A payload with an invalid ECDSA signature is rejected, while a valid one is verified against the raw request body before any parsing | ✓ VERIFIED | Confirmed by direct code read of `webhooks.routes.ts` (raw-body content-type parser override scoped to this route, ECDSA verify via `signature-verify.ts` BEFORE any `JSON.parse`, fail-closed 400 on invalid/missing signature or throw) and `signature-verify.ts` (thin wrapper around `@sendgrid/eventwebhook`, fail-closed `false` on any thrown error). Independently re-run this round: `npm run test -w apps/api -- webhooks-signature` → 1 file, 5 tests pass. |
| 3 | Duplicate webhook deliveries (same sg_event_id) do not double-count or corrupt delivery statistics | ✓ VERIFIED | Confirmed by direct code read: dedup insert uses `ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING` (`webhook-events.worker.ts` line 378), and all downstream fact-column writes are `setFactColumnOnce`'s `WHERE <column> IS NULL` gate (first-write-wins) plus counter increments only fire when that gate's `RETURNING` proves THIS call set it. Independently re-run this round as part of the 27-test worker webhook suite (`webhook-events-idempotency.test.ts` unchanged, still green with migrated flattened fixtures). |
| 4 | A bounce, spam complaint, or unsubscribe automatically flips the contact's subscription status so subsequent sends skip that contact | ✓ VERIFIED | Confirmed by direct code read: `applySuppression` (hard bounce, soft-bounce-streak threshold, spam report, suppressing `dropped` outcomes) sets `contacts.subscription_status = 'suppressed'` AND dual-writes a `workspace_suppressions` row; `applyUnsubscribe` (unsubscribe/group_unsubscribe, unsubscribing `dropped` outcomes) sets `'unsubscribed'`. Independently re-run this round as part of the worker suite (`webhook-events-suppression.test.ts`, migrated to the real flattened payload shape, still green — 9 tests). |

**Score:** 5/5 distinct truths verified (truth 1 remains split into 1a/1b/1c per the established convention across rounds; 1a now reflects the round-5 attribution fix).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/worker/src/queues/webhook-events.worker.ts` | `extractEventRow` reads `send_id`/`test` from the event's top level first, nested `custom_args` kept as defensive fallback; UUID validation + D-15 orphan-nulling preserved | ✓ VERIFIED | Confirmed by direct code read: `rawSendId` prefers `event.send_id` (string), falls back to `customArgs?.send_id`; `isTest` prefers `event.test === "true"`, falls back to `customArgs?.test === "true"`; `UUID_RE.test(rawSendId)` gate unchanged. |
| `apps/worker/src/queues/__tests__/webhook-events-attribution.test.ts` (new file) | Integration test replaying a verbatim flattened payload through `processWebhookEventBatch`, asserting attribution + counters + non-null `send_events.send_id` | ✓ VERIFIED | File exists (197 lines), 3 `it(...)` cases matching the plan's Tests A/B/C, zero `custom_args` occurrences (grep confirmed), all 3 pass. |
| `webhook-events-{status,idempotency,suppression}.test.ts` | Every fixture migrated to top-level markers; no nested `custom_args` remains | ✓ VERIFIED | Grep for `custom_args` across all 4 worker webhook test files returns zero matches. All pre-existing assertions still pass (27/27 across the 4 files). |
| Carried-forward artifacts (`sendgrid-webhook-provision.ts`, `webhook-warning-copy.ts`, `webhook-settings.routes.ts`, `env.ts`, `check-env.mjs`, `signature-verify.ts`, `webhooks.routes.ts`, `webhook-endpoint.repository.ts`) | Unchanged from prior rounds | ✓ VERIFIED | Not modified by 05-13; spot-read this round for truths 1b/1c/2, no regressions found. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `event.send_id` (top-level, flattened) | `extractEventRow`'s `rawSendId` | `typeof event.send_id === "string" ? event.send_id : customArgs?.send_id` | ✓ WIRED | Confirmed by direct code read; the new attribution test's Test C directly asserts the resolved `send_events.send_id` column is non-null and matches the fixture send id. |
| `extractEventRow`'s resolved `sendId` | batch send-resolution SELECT (`WHERE workspace_id = job workspace AND id = ANY(...)`) | `applyEventSideEffects` only invoked when `row.sendId !== null` | ✓ WIRED | Confirmed unchanged (the resolution SELECT and the `if (row.sendId === null) continue` skip were not touched by 05-13 — only the upstream extraction now supplies a non-null id for real payloads). |
| `applyEventSideEffects`'s `setFactColumnOnce` "just set" gate | `incrementCampaignCounter` | called only when the fact-column UPDATE's `RETURNING` proves this call set it | ✓ WIRED | Confirmed by direct code read (delivered/open/click/bounce/dropped/spam/unsubscribe branches all gate the counter increment on `justSet`); exercised end-to-end by the new attribution test's Tests A/B. |

### Behavioral Spot-Checks / Test Execution

| Suite | Command | Result | Status |
|-------|---------|--------|--------|
| Targeted round-5 gap-closure tests (independently re-run this round) | `npm run test -w apps/worker -- webhook-events-attribution webhook-events-status webhook-events-idempotency webhook-events-suppression` | 4 files, 27 tests passed | ✓ PASS |
| Signature verification (independently re-run this round) | `npm run test -w apps/api -- webhooks-signature` | 1 file, 5 tests passed | ✓ PASS |
| apps/worker build (independently re-run this round) | `npm run build -w apps/worker` | tsc exits 0, no type errors | ✓ PASS |
| Full monorepo test suite (independently re-run this round) | `npm run test --workspaces --if-present` | 6 workspaces, 62 files, 378 tests, all green (apps/api 36 files/201, apps/web 2/18, apps/worker 14/68, delivery-core 7/54, segments-core 1/19, shared-schemas 2/18) | ✓ PASS (0 regressions from 05-13; +3 tests vs. the prior round's 375, matching the one new attribution file's 3 tests) |
| Task commit provenance | `git show --stat d5f47b2 3570314 e4a74fd` | All 3 commits present; file/line-delta counts match SUMMARY's claims (attribution test file +197 lines; worker fix +14/-3; three fixture files migrated, +28/-9 combined) | ✓ CONFIRMS CLOSURE |
| Working tree cleanliness | `git status --short` | empty | ✓ CLEAN |
| Fixture PII scan | Grep of the new attribution test for real recipient patterns | Only synthetic `*@fixture.test`-style / generated UUIDs found | ✓ PASS |

No probe scripts (`scripts/*/tests/probe-*.sh`) exist or are declared for this phase — Step 7c is not applicable.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|--------------|--------|----------|
| WBHK-01 | 05-01, 05-04, 05-07, 05-08, 05-09, 05-10, 05-11, 05-12 | Per-tenant webhook URL + ECDSA signature verification + auto-provisioning, workspace-scoped, diagnosable failures, self-healing reconnect | ✓ SATISFIED | Unchanged this round; re-confirmed by direct code read and passing `webhooks-signature` tests. |
| WBHK-02 | 05-02, 05-03, 05-13 | delivered/opened/clicked/bounced/unsubscribed/spam/dropped event handling, including correct attribution of the send-side custom-arg markers round-tripping back through the webhook | ✓ SATISFIED | Round-5 fix confirmed: the flattened markers the send path attaches (`packages/delivery-core/src/send-mail.ts`'s `custom_args: { send_id, workspace_id, campaign_id, test }`) are now correctly read back at the event's top level by `extractEventRow`. |
| WBHK-03 | 05-01, 05-06 | Dedup by sg_event_id, no double-counting on replay | ✓ SATISFIED | Unchanged; not touched by 05-13; re-confirmed via `ON CONFLICT` code read + passing idempotency suite. |
| WBHK-04 | 05-03, 05-05, 05-07, 05-08, 05-09, 05-12, 05-13 | Webhook events update message status + are surfaced to the marketer, including correct per-campaign delivery counter attribution for real (flattened) payloads | ✓ SATISFIED | Round-5 fix directly closes this: `campaigns.delivered_count`/`opened_count` now increment for a real flattened event, proven by the new attribution test. |
| SUBS-02 | 05-02, 05-03, 05-13 | Unsubscribe/bounce/spam auto-updates contact status | ✓ SATISFIED | Round-5 fix confirmed to share the same corrected send_id-resolution path; suppression suite migrated to the real payload shape, still green (9/9 tests). |

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps exactly WBHK-01, WBHK-02, WBHK-03, WBHK-04, SUBS-02 to Phase 5, all marked `[x]` complete. All five appear in at least one plan's `requirements:` frontmatter field across all 13 plans (05-01 through 05-13; 05-13 declares `[WBHK-04, SUBS-02, WBHK-02]`). No orphans.

### Anti-Patterns Found

No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any of the 5 files touched by the 05-13 commits (confirmed by direct grep this round across `webhook-events.worker.ts` and the four `__tests__` files it modified/added).

**Independent code review (05-REVIEW.md, re-read after round 5, 68 files reviewed):** Status `issues_found` — 0 Critical, 10 Warnings, 11 Info. The round-5 change itself is confirmed correctly implemented (flattened `send_id` read, UUID-shape validation prevents a batch-abort, non-live ids nulled before the FK insert, all three attribution tests genuinely exercise the real payload shape). Findings worth surfacing prominently rather than silently carrying forward:

- **WR-01 (new this round, most significant):** the worker now *reads* the flattened `send_id` but still *ignores* the flattened `workspace_id` — when one BYO SendGrid key backs multiple workspaces (an explicitly supported scenario per the CR-01 sibling-workspace design), every workspace's Event Webhook receives every other workspace's raw events. Side effects don't cross-attribute (the resolution SELECT is workspace-scoped, so this does not corrupt the *correct* workspace's delivery outcomes — truths 1/3/4 above hold), but workspace A's raw event `payload` jsonb (recipient emails, bounce reasons, message ids) is permanently persisted into workspace B's `send_events` rows, and B's health-timestamp signal is refreshed by A's traffic. This is a genuine cross-tenant data-isolation gap in the edge case of a shared SendGrid key, not a break of this phase's four literal success criteria for the single-key-per-workspace case. Classified Warning (not Critical) by the reviewer's own severity taxonomy. Flagged here as a real, unresolved finding warranting a dedicated follow-up fix (drop events whose flattened `workspace_id` doesn't match the receiving endpoint's workspace) — not treated as a phase-blocking gap against this round's narrowly-scoped attribution fix.
- **WR-06 (new this round):** `applyUnsubscribe` unconditionally downgrades a `suppressed` contact to `unsubscribed` on a later/out-of-order unsubscribe event. The `workspace_suppressions` row survives (confirmed present in `applySuppression`'s dual-write and read by the pre-send suppression gate elsewhere in the codebase), so subsequent sends to that email likely still get blocked — truth 4's literal wording ("subsequent sends skip that contact") is not falsified — but the `contacts.subscription_status` field itself misrepresents the contact's true (harder) suppression state, which could matter for a future resubscribe flow. Classified Warning, not Critical.
- Eight further Warnings (WR-02 through WR-05, WR-07 through WR-10) are carried forward from prior rounds or are new-but-orthogonal hardening items (missing rate limit on the public receiver, RLS-only tenant guard on worker UPDATEs, case-sensitive scheme checks, trailing-slash callback URL, etc.) — none classified Critical, none newly introduced by 05-13, all pre-existing residual risk consistent with prior rounds' treatment.

Carried-forward, tracked separately (STATE.md line 283, unaffected by 05-13): an integration test replaying a REAL SIGNED SendGrid payload through the full HTTP stack (raw-body ECDSA verification layer) does not yet exist — 05-13's new attribution test exercises the worker/`processWebhookEventBatch` layer where the round-5 defect lived, not the HTTP-signature layer. This is a pre-existing, explicitly tracked backlog item, not a regression or new gap.

### Human Verification Required

See frontmatter `human_verification`. Two items:

1. **Live re-run of UAT Test 4** (fresh test-campaign send, deliver + open over the https tunnel) — the direct, honest confirmation that the round-5 attribution fix resolves the actual live failure it was built for. No round-6 live UAT session has been recorded since 05-13 landed.
2. **Live re-run of UAT Test 2** (scope-limited key) — carried forward, unresolved by any code change; blocked purely by tester access to a genuinely scope-limited SendGrid key (environment/access limitation, not a code gap), unrelated to this round's fix.

### Gaps Summary

No code-level gaps remain for the round-5 UAT failure (Test 4: campaign metrics stuck at zero despite real delivery/open events). The root cause — `extractEventRow` reading a fictional nested `custom_args` wrapper instead of the flattened top-level fields SendGrid's Event Webhook actually posts — is closed:

- **Extraction fixed:** `send_id`/`test` now read from the event's top level first, nested read kept only as a defensive fallback; UUID validation and D-15 orphan-nulling preserved — confirmed by direct code read.
- **Proven end-to-end:** a new integration test replays the verbatim flattened shape through the real `processWebhookEventBatch` entrypoint and proves fact-column writes + counter increments + non-null `send_events.send_id` — 3/3 passing.
- **Suite hardened against recurrence:** every existing webhook fixture (status/idempotency/suppression) migrated off the fictional nested shape onto the real flattened shape — the suite can no longer pass against a payload SendGrid never sends.
- **No regressions:** full monorepo suite (62 files / 378 tests, +3 vs. the prior round) is green; `apps/worker` build is clean; working tree is clean.

The phase's overall status remains `human_needed`: all five must-have truths — including the round-5 fix itself — are verified by direct code read, passing test, and independent review, but the live SendGrid environment confirmation (does a real send now show non-zero delivered/opened counters?) has not yet been re-run since the fix landed. This round's independent code review also surfaced one new Warning-level finding worth real attention going forward (WR-01: cross-tenant raw-payload storage when one SendGrid key backs multiple workspaces) — it does not falsify any of this phase's four literal success criteria for the primary case, but is flagged here for a dedicated follow-up rather than silently absorbed into a clean pass.

---

_Verified: 2026-07-09T22:55:00Z_
_Verifier: Claude (gsd-verifier)_
