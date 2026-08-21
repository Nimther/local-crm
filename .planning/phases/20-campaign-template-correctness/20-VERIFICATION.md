---
phase: 20-campaign-template-correctness
verified: 2026-08-21T18:00:00Z
status: passed
score: 4/4 must-haves verified (roadmap success criteria); 0 behavior-unverified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 20: Campaign Template Correctness Verification Report

**Phase Goal:** What the marketer sees selected in a campaign is exactly what SendGrid receives — on launch, on schedule and on test-send — and an unsaved or conflicting change is refused loudly instead of sending the old template.
**Verified:** 2026-08-21
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Unsaved template change → explicit unsaved-changes state; launch, schedule, test-send all blocked until saved | ✓ VERIFIED | `campaignDirtyState.ts`'s `computeIsDirty`/`computeDirtyBlockReason` (name/segmentId/templateId/fromSenderId compared); `LaunchScheduleActions`'s `disabled = !canLaunch \|\| Boolean(incompleteReason) \|\| isDirty` (`LaunchScheduleDialogs.tsx:396`); `TestSendPanel`'s send button `disabled={testSendMutation.isPending \|\| isDirty}` (`TestSendPanel.tsx:158`); `UnsavedChangesBanner` reads the same context. 37 web unit tests pass (`campaignDirtyState`, `campaign-dirty-blocking`). Human checkpoint (20-06, Task 3, step 1) approved this exact flow live against a real workspace. |
| 2 | Test send delivers exactly the saved/confirmed template on all three send paths — never the previous one | ✓ VERIFIED | `prepareCampaignTestSend` (`campaign.repository.ts`) locks the row, checks version, and the test-send route snapshots `templateId`/`fromEmail` into the `kind='test'` job at enqueue time; `readSendPrereqs`'s override in `send-dispatch.ts` prefers the snapshot for `kind='test'` only. `apps/worker/src/queues/__tests__/test-send-template-snapshot.test.ts`: 6/6 passing, including the async-gap proof (row's template changes after enqueue, queued job still uses the original) and the campaign-path scoping pin (a `kind='campaign'` job's own `templateId` field is ignored, row wins). Human checkpoint step 2 confirmed a real email arriving with the newly-saved template, including an in-flight case. |
| 3 | Launch/schedule act only on the confirmed-saved campaign version; concurrent/stale change → typed conflict error, no mail dispatched | ✓ VERIFIED | `launchCampaign`/`scheduleCampaign`/`prepareCampaignTestSend` all compare `existing.version` against `expectedVersion` inside the same `SELECT ... FOR UPDATE` transaction that performs the write, throwing `CampaignStateError(code: "version_conflict", currentVersion)` before any enqueue. `apps/api` campaign test suite: 56/56 passing (7 files), including stale-version/missing-precondition/check-order cases for all three paths and the Pitfall #1 sender-resolution regression. Frontend: `classifySendError` typed-code branching (never `err.message`), dialogs stay open on conflict, no `retry` option (`campaignSendConflict.ts`, `LaunchScheduleDialogs.tsx`, `TestSendPanel.tsx`). Human checkpoint steps 3-4 (version conflict + D-09 concurrent-state naming) approved after the D-09 dialog-unmount bug was found and fixed (`2658d32`) and re-verified. |
| 4 | After save, all three send paths agree on the same template id; none can fall back to local client form state | ✓ VERIFIED | Launch/schedule read template/sender exclusively from the locked `campaigns` row (never from the request body — `launchCampaignSchema`/`scheduleCampaignSchema` carry only `expectedVersion`/`scheduledAt`); test-send snapshot is captured from the same locked row at the moment the precondition passes, never from client form state; the dispatch worker's `kind='campaign'` branch never consults an override. Confirmed by direct code read of `campaigns.routes.ts`'s three handlers (no field other than `expectedVersion`/`scheduledAt`/`to`/`dynamicTemplateData` is accepted) and `send-dispatch.ts`'s branch scoping test. |

**Score:** 4/4 roadmap success criteria verified. 0 present-but-behavior-unverified.

### Requirements Coverage (TMPL-01, TMPL-02, TMPL-03)

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| TMPL-01 | 20-05, 20-06 | Marketer cannot launch/schedule/test-send with an unsaved template selection; dirty state is visible and blocks | ✓ SATISFIED | `campaignDirtyState.ts` + context + banner + three consumers wired and unit-tested; human checkpoint step 1 approved. REQUIREMENTS.md already marks TMPL-01 `[x]` and traceability "Complete". |
| TMPL-02 | 20-01, 20-02, 20-03, 20-06 | Launch/schedule act only on a confirmed-saved version; concurrent/stale change → typed conflict, no dispatch | ✓ SATISFIED | `campaigns.version` column shipped/applied (confirmed live in dev DB catalog, see below); locked version check in `launchCampaign`/`scheduleCampaign`; typed 409 `version_conflict`/`illegal_transition` with `code` on every `CampaignStateError` response; frontend conflict recovery (`campaignSendConflict.ts`) wired into both dialogs. REQUIREMENTS.md still shows "Pending" — expected, updated by the orchestrator after verification, not a gap. |
| TMPL-03 | 20-03, 20-04 | Test-send delivers exactly the confirmed-saved template, proven across all three paths | ✓ SATISFIED | `prepareCampaignTestSend`'s snapshot + `send-dispatch.ts`'s override, proven by 6 worker tests covering all three paths at their respective layers (test-send: enqueue-time snapshot + async-gap; launch/schedule: row-derived campaign-path dispatch + snapshot-scoping pin). REQUIREMENTS.md still shows "Pending" — same expected-not-a-gap note as TMPL-02. |

No orphaned requirements: REQUIREMENTS.md's Phase 20 row lists exactly TMPL-01/02/03, matching the three plans' declared `requirements` frontmatter.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/db/migrations/0066_campaigns_version.sql` + snapshot/journal | `campaigns.version` column, classified, applied | ✓ VERIFIED | Migration exists with correct DDL + `COMMENT ON COLUMN`; journal entry `idx: 66`, `tag: "0066_campaigns_version"`; `migration-tiers.ts` classifies it `auto-reversible` with a hand-verified inverse in `migration-rollback-rehearsal.test.ts`. Live dev DB catalog read (`information_schema.columns`) confirms: `{"column_name":"version","data_type":"integer","is_nullable":"NO","column_default":"1"}` — applied, not just declared. |
| `apps/api/src/modules/campaigns/campaign.repository.ts` | `version_conflict` code + locked comparison in launch/schedule/test-send | ✓ VERIFIED | Read in full; all three functions compare version inside `FOR UPDATE`, in the order not_found → status → version → completeness, matching the plan's documented ordering. |
| `apps/api/src/modules/campaigns/sender-resolver.ts` | exactly one implementation, no campaign write | ✓ VERIFIED | Exports only `CampaignSenderError`, `CampaignSenderInput`, `resolveCampaignSenderEmail`; no `withTenantTransaction` call in the file (confirmed by grep and full read). |
| `apps/worker/src/queues/send-dispatch.ts` | snapshot override scoped to `kind='test'` only | ✓ VERIFIED | `readSendPrereqs`'s override parameter is passed only at the `kind === "test"` call site (line 672); `claimCampaignSend`/`kind === "campaign"` call it with no override. |
| `apps/web/src/features/campaigns/campaignDirtyState.ts` | pure dirty comparison | ✓ VERIFIED (with a tracked defect — see Anti-Patterns) | Exports `CampaignFormSnapshot`/`computeIsDirty`/`computeDirtyBlockReason`, no React import. |
| `apps/web/src/features/campaigns/campaignSendConflict.ts` | typed 409 classification | ✓ VERIFIED | `classifySendError` branches on `body.code` only, never `err.message`; defensive against string/undefined bodies. |
| `apps/web/e2e/campaign-template-correctness.spec.ts` | click-through proof of SC1/SC3/D-09 | ✓ PRESENT, not locally executed | 3 real tests (no `.skip`/`.only`), lint/typecheck clean per SUMMARY. Local execution blocked by dev-stack port occupation on ports 4000/5173 — independently re-confirmed via `lsof` during this verification (same conflict, not merely trusted from the SUMMARY). Treated as pending CI evidence, not proof; the same three scenarios are covered by the human checkpoint below. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `LaunchScheduleDialogs.tsx` launch/schedule mutations | `campaigns.routes.ts` launch/schedule handlers | POST body `{ expectedVersion }` | ✓ WIRED | `api.ts`'s `launchCampaign` posts `{ expectedVersion: campaign.version }`; route requires it via `launchCampaignSchema.safeParse`. |
| `campaigns.routes.ts` test-send handler | `emailBroadcastQueue.add` | `templateId`/`fromEmail` read from `prepareCampaignTestSend`'s returned row, never `request.body` | ✓ WIRED | Confirmed by reading the enqueue call site; snapshot fields come from the prepared row and the resolved sender email only. |
| `queues.ts`'s optional `templateId`/`fromEmail` | `send-dispatch.ts`'s `kind='test'` branch | override-first-then-row resolution | ✓ WIRED | `readSendPrereqs`'s override parameter resolves each field independently; absent fields fall back to the row (rolling-deploy safety), proven by the "neither field present" worker test case. |
| `apps/api`'s `mapCampaignStateError` `code` field | `apps/web`'s `classifySendError` | typed `code` string on the 409 body | ✓ WIRED | `mapCampaignStateError` includes `code` on every branch (404/409/422); `classifySendError` reads `body.code` defensively. |
| `CampaignDirtyStateContext` | `UnsavedChangesBanner`/`LaunchScheduleActions`/`TestSendPanel` | shared context computed once above all three consumers | ✓ WIRED | `CampaignDetailPage.tsx`'s draft branch wraps the embedded builder and both action components in one `CampaignDirtyStateProvider saved={campaign}`. |

### Behavioral Spot-Checks (single named test runs, not full suite)

| Behavior | Command | Result | Status |
|---|---|---|---|
| Dirty-state, conflict-classification, and dirty-blocking unit tests | `npm run test -w apps/web -- campaignDirtyState campaignSendConflict campaign-dirty-blocking` | 3 files, 37 tests passed | ✓ PASS |
| Campaign send-path preconditions (api) | `npm run test -w apps/api -- campaigns` | 7 files, 56 tests passed | ✓ PASS |
| Test-send template/sender snapshot + three-path map (worker) | `npm run test -w apps/worker -- test-send-template-snapshot` | 1 file, 6 tests passed | ✓ PASS |
| `campaigns.version` applied to dev database | Direct `information_schema.columns` read via `scripts/env-path.mjs` + `pg` | `{"column_name":"version","data_type":"integer","is_nullable":"NO","column_default":"1"}` | ✓ PASS |
| Migration chain / tier registries / rollback rehearsal | `npm run test:migrations` | 245 passed, 1 skipped (expected rehearsal-empty skip), 1 failed on first run | ✓ PASS on isolation re-run (see below) |
| Debt-marker scan across all 30 phase-modified files | `grep -n -E "TBD\|FIXME\|XXX"` over the 27-file review list + migration artifacts | no matches | ✓ PASS |

**Flake triage:** `migrate-runner-advisory-lock.test.ts` failed once under `npm run test:migrations`'s full run (a leaked advisory-lock row from concurrent-runner contention — the exact flake signature already on record in project memory for this suite under load). Re-run in isolation (`npx vitest run migrate-runner-advisory-lock --root packages/db`): 2/2 passed. Confirmed flake, not a regression — consistent with the documented "dev-stack test gate flakes" signature.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `apps/web/src/features/campaigns/campaignDirtyState.ts` | 52 | `form.name.trim() !== saved.name` trims only the form side (code review CR-01) | ⚠️ Warning (tracked, not a phase blocker) | For a campaign whose persisted `name` has leading/trailing whitespace (only reachable via a direct API write or `duplicateCampaign` of already-bad data — the builder's own `handleSave` trims before posting, and `createCampaignSchema`/`updateCampaignSchema` do not enforce trimming), the form reads as falsely dirty on load, blocking all three send actions until one extra, unnecessary save. This is a **false-positive over-block**, not an under-block: it can never cause a stale/unsaved template to be sent, so no roadmap success criterion or must-have truth is falsified. It fails in the direction the phase goal demands ("refused loudly" rather than "sends the old template"). Fix (per 20-REVIEW.md CR-01): trim both sides in the comparator and/or add `.trim()` to the shared-schema `name` fields, plus a regression test seeding an untrimmed saved name. Recommend a follow-up fix plan/quick-task rather than blocking phase closure. |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` | 341-349, 404-416, 513-521 | WR-01: SendGrid sender-resolution network call runs before the version pre-check on all three send routes | ℹ️ Info (tracked, non-blocking) | A stale-version retry spends a SendGrid API call before being rejected. No correctness impact — the authoritative check still happens under lock before any write. Cosmetic/quota-efficiency improvement only. |
| `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` | 115-123 | WR-02: server-row sync effect resets all four fields on any refetch of the shared query key, relying on the emergent property that every other mutation on the page is dirty-gated | ℹ️ Info (tracked, non-blocking) | No current reproduction path (every existing consumer of the same query key is itself gated by the dirty state this phase introduced), but not independently enforced by a test. Recorded as a design debt for a future phase touching this query key. |
| `apps/api/src/modules/campaigns/campaigns.routes.ts` / `apps/worker/.../send-dispatch.ts` | various | IN-01/IN-02: dead null-guard on test-send job payload; ambiguous error message for missing-campaign vs missing-fields in `readSendPrereqs` | ℹ️ Info | Cosmetic; no behavioral effect. |

No `TBD`/`FIXME`/`XXX` debt markers found in any of the 30 files this phase modified (all five plans' `files_modified` lists, verified by direct grep).

### PLAN Prohibitions (must_haves.prohibitions, judgment-tier)

| Plan | Prohibition | Disposition | Evidence |
|---|---|---|---|
| 20-03 | No send path may read template/sender/segment from the request body or client form state; test-send job carries only row-supplied values | kept, evidence found | `launchCampaignSchema`/`scheduleCampaignSchema`/`testSendCampaignSchema` accept only `expectedVersion` (+ `scheduledAt`/`to`/`dynamicTemplateData`), never template/sender fields; test-send enqueue reads `templateId`/`fromEmail` from `prepareCampaignTestSend`'s returned row and the resolved sender email, confirmed by direct code read of the enqueue call site. |
| 20-05 | No code path may auto-save/auto-submit/unblock a send on the marketer's behalf | kept, evidence found | `UnsavedChangesBanner`'s save button calls the context's save handle only on click; no effect or timer invokes it; `usePublishCampaignFormState` only publishes state, never triggers a save. |
| 20-06 | No code path may re-submit a send action after a conflict without a fresh human confirmation | kept, evidence found | All three `onError` bodies (quoted in 20-06-SUMMARY.md, verbatim-matched against current source in this verification) return after classifying a conflict without re-invoking the mutation; no `retry` option declared on any of the three mutations (confirmed by reading `LaunchScheduleDialogs.tsx`/`TestSendPanel.tsx` in full). |
| 20-06 | Local unsaved edits must never be discarded silently on a conflict refetch | kept, evidence found | `CONFLICT_REFRESH_NOTICE` is shown via `toast()` on every conflict-triggered `invalidateQueries` call in both dialogs and the test-send panel. |

All four judgment-tier prohibitions from PLAN frontmatter are marked `kept` by direct code evidence gathered above (not merely inherited from the SUMMARY's own `flagged-unverified` self-rating).

### Human Verification

**None required.** The phase's human-verification surface was fully discharged this session at the 20-06 Task 3 checkpoint: all four steps (SC1 unsaved-blocking, SC2/TMPL-03 test-send template fidelity, SC3/D-08 version conflict, D-09 concurrent-state naming) were run against a real workspace with a real SendGrid key and real Dynamic Templates. The first round found a real defect at step 4 (dialog unmounted by its own conflict-triggered refetch); it was root-caused, fixed in commit `2658d32`, and both the fix and the D-08 sanity re-check were re-verified and approved in the same session. No production code has changed since that approved re-verification round. This verification independently confirmed (via direct code read, not by trusting the SUMMARY) that the fix (`CampaignDetailPage.tsx` mounting both dialogs unconditionally as siblings of the status-branched content) is present in the current codebase.

### Gaps Summary

No blocking gaps. One tracked, non-blocking defect (CR-01, whitespace-name false-dirty) is recorded above with a recommended fix; it degrades in the safe direction (over-blocking a send, never under-blocking one) and does not falsify any roadmap success criterion. Three additional non-blocking review findings (WR-01, WR-02, IN-01/IN-02) are recorded for future attention. REQUIREMENTS.md's TMPL-02/TMPL-03 rows still show "Pending" — expected, since that file is updated by the orchestrator after verification passes, not evidence of incomplete work.

---

_Verified: 2026-08-21_
_Verifier: Claude (gsd-verifier)_
