---
phase: 19-unsubscribe-secret-graceful-rotation
verified: 2026-08-21T00:40:00Z
status: human_needed
score: 4/4 roadmap success criteria verified (25/25 plan-level truths verified)
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Perform (or have a second reviewer perform) the live-environment walkthrough of docs/runbooks/unsubscribe-secret-rotation.md as a first-time operator: run Step 1 on both api and worker, restart, run Step 2 (promote), restart, then execute Step 3's both-eras canary smoke against the standing canary workspace (fe8fbbc6-6b25-490b-b3f5-7c739e325c9a) — capture a pre-rotation link before Step 2, redeem it after Step 2 alongside a freshly-signed post-rotation link."
    expected: "Both redemptions succeed (canary contacts move to unsubscribed); no process crash-loops at any restart; the operator never has a window where a link cannot be verified by some running process."
    why_human: "This is an operator procedure against a real deployment (docker-compose services, real env file, real SendGrid-delivered links) — nothing in the repository can execute it. The plan's own Flagged Assumptions section states D-09's canary smoke 'is written as an operator procedure, not executed here — no rotation has occurred in any live environment.' The <human-check> block in 19-05-PLAN.md Task 2 defers exactly this walkthrough to end-of-phase per the project's human_verify_mode=end-of-phase convention; the executor's own self-performed walkthrough (recorded in 19-05-SUMMARY.md) is a documented cross-check, not independent human confirmation, and does not substitute for an actual rotation rehearsal."
---

# Phase 19: Unsubscribe Secret Graceful Rotation Verification Report

**Phase Goal:** The operator can put a new unsubscribe signing secret into service without breaking a single link that has already been mailed out.
**Verified:** 2026-08-21T00:40:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Post-Execution Context Factored In

- **19-REVIEW.md** (committed, `19-REVIEW.md`): found 1 Critical (CR-01, runbook Step 2 crash-loop) and 2 Warnings (WR-01 never-throws regression, WR-02 D-05 log timing asymmetry). CR-01 fixed in `6facaf9`, WR-01 fixed in `c2a4f3b`, WR-02 documented as an accepted risk in `da72a60` (no code behavior change — fix options were rejected because they would break the D-05 tests that pin the tested 0-vs-1 call-count behavior). All three commits verified present in `git log` and their diffs inspected directly (see below) — this report verifies the **current, post-fix** state of the code, not the pre-review state.
- WR-02 is treated as a deliberate, documented decision (not a gap) per instruction — see "Accepted Risk" note below.
- Known environmental test failures on this machine (sentry.test.ts, advisory-lock/flow-run-advance/webhooks-signature flakes, temp-redis port -1) were out of scope for this phase and not triggered — all test runs below were scoped to phase-relevant suites only, run once each.

## Goal Achievement

### Observable Truths — ROADMAP Success Criteria (the contract)

| # | Truth (ROADMAP SC) | Status | Evidence |
|---|---|---|---|
| SC1 | After the operator introduces a new primary secret, newly sent mail is signed with it, and an unsubscribe link from mail sent before the rotation still unsubscribes the contact. | ✓ VERIFIED | `apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts` Tests 1–2 (pre-rotation and post-rotation redemption through the real `POST /unsubscribe/:token` route). Ran independently: `npm run test -w apps/api -- unsubscribe` → 25/25 pass. |
| SC2 | Old and new links verify identically on both redemption paths — the GET link in the email and the RFC 8058 one-click urlencoded POST. | ✓ VERIFIED | Same test file, Tests 4 (confirm-form POST), 5–6 (GET path, non-mutating, identical after token-placeholder substitution across previous/primary/forged). Ran independently, all pass. |
| SC3 | A forged or expired-secret token produces a byte-identical response to a valid one (no-token-oracle invariant survives rotation), with a timing-safe comparison performed per candidate secret. | ✓ VERIFIED | Route-level: Tests 3, 7, 8 (four-way byte-identical POST comparison + expired-previous-secret parity). Loop-level: `packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts` HMAC-invocation-count gate proves the loop is exhaustive (no early break) via a real, non-vacuous mock — confirmed by direct code read of `unsubscribe-token.ts:112-127` (loop never `break`s; `matchedIndex` assigned only once). Ran independently: `npm run test -w packages/delivery-core -- unsubscribe-token` → 19/19 pass. |
| SC4 | The retention window for previous secrets is an explicit, documented decision tied to the real lifetime of already-sent links (5-year token TTL) — not an unstated default, and not an unbounded list. | ✓ VERIFIED | `SPECIFICATION.md:464` states "хранится до истечения 5 лет с момента, когда он в последний раз был primary" (no softening) and that code enforces only `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5`. Code bound confirmed at all three sites (`apps/api/src/env.ts`, `apps/worker/src/server.ts`, `scripts/check-env.mjs`) with an executable parity test (`scripts/__tests__/check-env-unsubscribe-previous.test.mjs` Block B, part of the 16/16 pass run below). |

**Score:** 4/4 ROADMAP success criteria verified, 0 present-but-behavior-unverified.

### Observable Truths — Plan-Level Detail (must_haves.truths across 19-01…19-05)

All 25 plan-declared truths were checked individually. Every one resolved VERIFIED; none required an override.

| Plan | Truth (abridged) | Status | Evidence |
|---|---|---|---|
| 19-01 | Pre-rotation link still unsubscribes via real POST route | ✓ VERIFIED | Test 1, `unsubscribe-rotation.test.ts` |
| 19-01 | Post-rotation link (new primary) also unsubscribes | ✓ VERIFIED | Test 2, same file |
| 19-01 | Loop tries primary then each previous in order, timing-safe compare per candidate | ✓ VERIFIED | Direct code read: `unsubscribe-token.ts:104-127` |
| 19-01 | `verifyUnsubscribeToken` never throws for any failure shape; route needs no code change | ✓ VERIFIED (behaviorally re-proven) | I wrote and ran a standalone test deleting `UNSUBSCRIBE_TOKEN_SECRET` and asserting `verifyUnsubscribeToken()` returns `null` rather than throwing — passed (1/1), then removed the temp file (`git status` confirms clean). This directly confirms the WR-01 fix (`c2a4f3b`) rather than relying on the SUMMARY/REVIEW's own claim. `unsubscribe.routes.ts` has zero diff since 2026-08-12 (pre-dates this phase). |
| 19-01 | Non-primary match emits one log line with position, no secret material | ✓ VERIFIED | `unsubscribe-token-rotation.test.ts` D-05 suite (5 tests) |
| 19-01 | Token wire format unchanged (2 dot-separated base64url parts) | ✓ VERIFIED | Pre-existing round-trip/`buildListUnsubscribeUrl` tests pass unmodified; exported symbol surface unchanged (`export` grep: exactly `UnsubscribeTokenPayload`, `signUnsubscribeToken`, `verifyUnsubscribeToken`, `buildListUnsubscribeUrl`); `npm run build -w packages/delivery-core` exits 0. |
| 19-02 | List longer than max rejected at all 3 sites | ✓ VERIFIED | `env-schema.test.ts` (30/30), `unsubscribe-secret-boot-check.test.ts` (14/14), `check-env-unsubscribe-previous.test.mjs` Block A (11/11) |
| 19-02 | Short/empty/dup-primary/dup-entry rejected | ✓ VERIFIED | Same suites |
| 19-02 | Comma/whitespace rejected on both variables, all sites | ✓ VERIFIED | Same suites; `grep` confirms identical rule text at all 3 code sites |
| 19-02 | Absent variable validates everywhere (no regression) | ✓ VERIFIED | Explicit test case in all 3 suites |
| 19-02 | Three sites agree on the same max constant via executable parity assertion | ✓ VERIFIED | `check-env-unsubscribe-previous.test.mjs` Block B (5/5); `grep -n MAX_UNSUBSCRIBE_PREVIOUS_SECRETS` confirms `= 5` in `apps/api/src/env.ts`, `apps/worker/src/server.ts`, `scripts/check-env.mjs` |
| 19-03 | Both compiled redaction forms (Pino field-path + scrub) redact the previous-secrets field | ✓ VERIFIED | `packages/redaction/src/rules.ts:73` entry; full redaction suite 31/31 pass |
| 19-03 | Primary secret's field name equally protected | ✓ VERIFIED | `rules.ts:78` entry |
| 19-03 | Rule added once, single table, no duplicate literal elsewhere | ✓ VERIFIED | `grep -rn UNSUBSCRIBE_TOKEN_SECRET packages/redaction/src/` returns only `rules.ts` hits |
| 19-04 | Previous-secret link verifies on both redemption paths (GET + both POST shapes) | ✓ VERIFIED | Tests 4–6 |
| 19-04 | Forged/unretained/expired/valid all byte-identical | ✓ VERIFIED | Tests 3, 7, 8 |
| 19-04 | GET page renders identically across token classes, non-mutating | ✓ VERIFIED | Tests 5–6 |
| 19-04 | Loop evaluates every candidate even on first match (position-independent work) | ✓ VERIFIED | HMAC invocation-count gate, `unsubscribe-token-rotation.test.ts`; REVIEW.md/SUMMARY.md record a deliberate-regression proof (temporary `break` added, count assertion failed 1 vs 3, reverted) — I independently confirmed the reverted state has no `break` in the loop by direct code read. |
| 19-04 | Log line fires once at correct position for previous-secret match, zero for primary | ✓ VERIFIED | D-05 suite, 5 tests |
| 19-04 | Absent previous-secrets var ⇒ identical to pre-rotation behavior | ✓ VERIFIED | Rotation-semantics describe block, 5 tests |
| 19-05 | Retention window explicit, tied to 5-year TTL | ✓ VERIFIED | `SPECIFICATION.md:464` |
| 19-05 | Recording/enforcement split documented (dates in docs, code enforces max-length only) | ✓ VERIFIED | Same paragraph; code confirmed to have no date-tracking logic anywhere in the three validation sites |
| 19-05 | Two-step (verify-everywhere, then promote) runbook procedure | ✓ VERIFIED | `docs/runbooks/unsubscribe-secret-rotation.md` Steps 1–2, read in full; Step 2's post-CR-01-fix instructions independently re-tested (see below) |
| 19-05 | Runbook ends with both-eras canary smoke | ✓ VERIFIED (document exists; live execution is the harvested human-verification item below) | Step 3 present and complete in the runbook text |
| 19-05 | New var in deployment template + README, all names doc'd in SPECIFICATION.md | ✓ VERIFIED | `grep` confirms `docker/prod.env.example`, `README.md`, `SPECIFICATION.md` all reference the variable; `npm run check:spec-env-coverage` → 55/55 names checked, all present |

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/delivery-core/src/unsubscribe-token.ts` | Multi-secret candidate loop, unchanged public surface | ✓ VERIFIED | Read in full; loop exhaustive, WR-01 try/catch present, 4 exports unchanged, build clean |
| `packages/delivery-core/src/logger.ts` | Package-local pino logger | ✓ VERIFIED | Exists, mirrors `contacts-core` precedent, imports only `pino` |
| `apps/api/src/modules/delivery/__tests__/unsubscribe-rotation.test.ts` | 8-test route-level rotation suite | ✓ VERIFIED | Exists, 18KB, all tests pass as part of 25/25 `unsubscribe` suite run |
| `packages/delivery-core/src/__tests__/unsubscribe-token-rotation.test.ts` | Unit gates for loop exhaustiveness + D-05 shape | ✓ VERIFIED | Exists, 19 tests pass |
| `apps/worker/src/__tests__/unsubscribe-secret-boot-check.test.ts` | 14-test worker boot-assertion suite | ✓ VERIFIED | Exists, 14/14 pass |
| `scripts/__tests__/check-env-unsubscribe-previous.test.mjs` | 16-test predev-script + parity suite | ✓ VERIFIED | Exists, 16/16 pass |
| `packages/redaction/src/rules.ts` | Two new key rules | ✓ VERIFIED | Both keys present, exact env-var spelling (not camelCase) |
| `docker/prod.env.example` | Uncommented `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS=` slot | ✓ VERIFIED | Present, line 220 |
| `README.md` | New table row | ✓ VERIFIED | Present, line 115 |
| `SPECIFICATION.md` | §2.5 pino dependency, §3.2 env var, §3.7 retention decision | ✓ VERIFIED | All three sections confirmed present and accurate |
| `docs/runbooks/unsubscribe-secret-rotation.md` | Two-step runbook, canary smoke, rotation log, rollback | ✓ VERIFIED | Read in full, all required sections present, CR-01 fix confirmed in text (explicit "remove the new secret" instruction + crash-loop warning) |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `unsubscribe-token.ts` | `process.env.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS` | lazy read per verify call (`getPreviousSecrets()`) | ✓ WIRED | Confirmed by code read; no module-load-time caching |
| `apps/api/src/modules/delivery/unsubscribe.routes.ts` | `verifyUnsubscribeToken` | null-or-payload contract, unedited | ✓ WIRED, UNCHANGED | `git log -1` shows last touch 2026-08-12, predates this phase; route consumes the (now-extended) function with zero diff |
| `packages/redaction/src/rules.ts` | `pino-redact.ts` + `scrub.ts` | single-table compilation | ✓ WIRED | Both consumer files have zero diff (`git status --porcelain` on both is empty); parity test passes |
| `apps/api/src/env.ts` / `apps/worker/src/server.ts` / `scripts/check-env.mjs` | `MAX_UNSUBSCRIBE_PREVIOUS_SECRETS` | independently hard-coded, proven equal by executable parity regex | ✓ WIRED | Block B test passes; `grep` confirms all three declare `= 5` |
| `docker/prod.env.example` | `SPECIFICATION.md` | `check:spec-env-coverage` (one-directional) | ✓ WIRED | Gate passes, 55/55 |

### Behavioral Spot-Checks (run independently, not from SUMMARY claims)

| Behavior | Command | Result | Status |
|---|---|---|---|
| `verifyUnsubscribeToken` never throws on unset primary (WR-01) | Temp test: delete `UNSUBSCRIBE_TOKEN_SECRET`, call `verifyUnsubscribeToken()`, assert no throw + returns `null` | 1/1 pass, then temp file removed | ✓ PASS |
| CR-01 crash-loop scenario is now caught at boot with a clear message | `node scripts/check-env.mjs` against a fixture reproducing the pre-fix Step 2 (`UNSUBSCRIBE_TOKEN_SECRET=B`, `..._PREVIOUS=B,A`) | Exit 1, "entry 1 duplicates the primary secret or another entry" — matches REVIEW.md's own reproduction | ✓ PASS |
| `packages/delivery-core -- unsubscribe-token` | `npm run test` | 19/19 pass | ✓ PASS |
| `apps/api -- unsubscribe` (all 5 suites) | `npm run test` | 25/25 pass | ✓ PASS |
| `apps/worker -- unsubscribe-secret-boot-check` | `npm run test` | 14/14 pass | ✓ PASS |
| `apps/api -- env-schema` | `npm run test` | 30/30 pass | ✓ PASS |
| `packages/redaction` (full suite) | `npm run test` | 31/31 pass | ✓ PASS |
| `scripts` rotation-var suite | `npx vitest run --root scripts __tests__/check-env-unsubscribe-previous.test.mjs` | 16/16 pass | ✓ PASS |
| `check:spec-env-coverage` | `npm run check:spec-env-coverage` | 55 names, all present | ✓ PASS |
| `check:runbook-coverage` | `npm run check:runbook-coverage` | 4 alerts, unaffected | ✓ PASS |
| `check:lockfile-npm10` | `npm run check:lockfile-npm10` | npm 10.9.9 accepts lockfile | ✓ PASS |
| `build -w packages/delivery-core` | `npm run build` | tsc exits 0 | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description (RU, abridged) | Status | Evidence |
|---|---|---|---|---|
| ROT-01 | 19-01, 19-02, 19-03, 19-05 | Operator can introduce a new primary secret; new mail signs with it; no invalidation of prior links | ✓ SATISFIED | SC1 + all supporting truths verified above |
| ROT-02 | 19-01, 19-04, 19-05 | Previous secrets keep verifying old links on both paths, timing-safe, byte-identical responses | ✓ SATISFIED | SC2/SC3 + all supporting truths verified above |

No orphaned requirements: `REQUIREMENTS.md` maps only ROT-01 and ROT-02 to Phase 19 (lines 91–92), and both are claimed by at least one plan's frontmatter.

### Anti-Patterns Found

None. Scanned all phase-touched files (`unsubscribe-token.ts`, `logger.ts`, `env.ts`, `server.ts`, `check-env.mjs`, `rules.ts`, the runbook, `SPECIFICATION.md`, `docker/prod.env.example`, `README.md`) for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` — zero hits.

### Accepted Risk (not a gap, per explicit instruction)

**WR-02 — D-05 log timing asymmetry.** `verifyUnsubscribeToken` performs one extra synchronous Pino write only on a previous-secret match (`matchedIndex > 0`), which is a real, documented, and reviewed timing signal distinguishing "verified via previous secret" from "verified via primary or no match." Both fix options (defer the log call; equalize per-path work) were evaluated and rejected in `da72a60` because they would break the D-05 test suite's own pinned 0-vs-1 call-count assertions — the tests that gate this exact deliverable. Critically, this asymmetry does **not** create a valid-vs-invalid oracle: primary-valid and invalid tokens still take the identical, faster path as each other. This is documented in-code (`unsubscribe-token.ts:137-159`) and in `19-REVIEW.md`. Treated here as a deliberate, reviewed decision — not counted as a gap or a failed truth.

### Human Verification Required

1 item, harvested from `19-05-PLAN.md` Task 2's `<human-check>` block (deferred per `human_verify_mode=end-of-phase`) plus my own analysis of what remains unprovable from the repository alone:

#### 1. Live rotation rehearsal against a real deployment

**Test:** Perform (or have a second reviewer independently perform) the runbook walkthrough end-to-end against the standing canary workspace: Step 1 (append new secret to both services, restart both), Step 2 (promote — remove-from-previous / move-primary-to-previous / set-new-primary in one edit, restart both), then Step 3's both-eras canary smoke (capture a pre-rotation link before Step 2; after Step 2, redeem both a freshly-signed post-rotation link and the retained pre-rotation link).

**Expected:** Neither service crash-loops at any restart; both redemptions in Step 3 succeed (canary contacts move to `unsubscribed`); at no point does a running process fail to verify a link it should be able to verify.

**Why human:** This is a live-deployment operator procedure (real `docker compose` restarts, a real env file at `MEGA_CRM_ENV_FILE`, real SendGrid-delivered mail) that nothing in the repository can execute. The phase's own plan documents this explicitly: "D-09's canary smoke is written as an operator procedure, not executed here — no rotation has occurred in any live environment" (19-05-PLAN.md Flagged Assumptions). I independently re-verified every *static* claim the runbook makes (the CR-01 fix's ordering, the validation rules, the D-05 log field name, the absence of secret values, the retention paragraph's wording) against the current codebase and found all of them accurate — but the live rehearsal itself is outside what static/test verification can prove.

### Gaps Summary

No gaps. Every observable truth declared at the roadmap level (SC1–SC4) and at the plan level (25 truths across 5 plans) is VERIFIED against the current, post-code-review-fix state of the codebase, with test suites re-run independently (not taken on SUMMARY.md's word) and two of the review's fixes (WR-01, CR-01) independently re-proven behaviorally rather than by re-reading the review's own evidence. The single open item is an operational rehearsal that only a human/live-environment can perform, which routes this report to `human_needed` rather than `passed` — it does not indicate a defect in the implementation.

---
_Verified: 2026-08-21T00:40:00Z_
_Verifier: Claude (gsd-verifier)_
