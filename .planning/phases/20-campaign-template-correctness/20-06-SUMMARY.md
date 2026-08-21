---
phase: 20-campaign-template-correctness
plan: 06
subsystem: web
tags: [react, tanstack-query, playwright, optimistic-locking, conflict-recovery]

# Dependency graph
requires:
  - phase: 20-campaign-template-correctness
    provides: "campaigns.version column (20-01), expectedVersion + typed 409 version_conflict/illegal_transition codes on launch/schedule/test-send (20-02, 20-03), test-send template/sender snapshot (20-03/20-04), unsaved-changes banner blocking all three send actions (20-05)"
provides:
  - "campaignSendConflict.ts: classifySendError(err) -> SendConflictKind | null, VERSION_CONFLICT_COPY, illegalTransitionCopy(status), CONFLICT_REFRESH_NOTICE"
  - "CAMPAIGN_STATUS_LABELS exported from CampaignStatusBadge.tsx as the single status-label source shared by the badge and the conflict copy"
  - "LaunchConfirmDialog/ScheduleDialog/TestSendPanel: on a recoverable 409 the dialog stays open, shows typed copy, refetches, never re-invokes the mutation"
  - "CampaignDetailPage owns confirmOpen/scheduleOpen and mounts the two dialogs unconditionally (survives a status-changing refetch) -- D-09 fix"
  - "apps/web/e2e/campaign-template-correctness.spec.ts: 3 Playwright tests (SC1 unsaved-blocking, SC3 version conflict, D-09 illegal-transition survives refetch)"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [typed-code conflict classification never message-text matching, render-time copy composition from a live prop rather than error-time captured state, dialogs mounted unconditionally at the page level so their own conflict-refetch cannot unmount them]

key-files:
  created:
    - apps/web/src/features/campaigns/campaignSendConflict.ts
    - apps/web/src/features/campaigns/__tests__/campaignSendConflict.test.ts
    - apps/web/e2e/campaign-template-correctness.spec.ts
  modified:
    - apps/web/src/features/campaigns/CampaignStatusBadge.tsx
    - apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx
    - apps/web/src/features/campaigns/TestSendPanel.tsx
    - apps/web/src/features/campaigns/CampaignDetailPage.tsx
    - apps/web/src/features/campaigns/__tests__/campaign-dirty-blocking.test.tsx

key-decisions:
  - "Conflict branch selected purely by the typed `code` string in the 409 body, never by matching `err.message` -- copy changes on the server can never silently break the recovery path (RESEARCH Pitfall #2)"
  - "Illegal-transition copy is composed at RENDER time from the live `campaign.status` prop (already refreshed by the conflict's own invalidateQueries), not from a value captured when the error arrived -- the named state is always the fresh one with no second request"
  - "D-09 fix: CampaignDetailPage now owns confirmOpen/scheduleOpen and mounts LaunchConfirmDialog/ScheduleDialog unconditionally as siblings of the status-branched content, instead of LaunchScheduleActions owning them and only being rendered while status === draft -- an open dialog now survives the very refetch its own conflict handling triggers"
  - "test-send's onError falls through illegal_transition to the existing generic failure copy rather than inventing copy for a transition test-send cannot itself trigger (it performs no status transition)"

requirements-completed: [TMPL-01, TMPL-02]

coverage:
  - id: D1
    description: "classifySendError classifies exactly the two recoverable 409 codes and returns null for everything else (unrecognised code, no code, 422/500, non-ApiError, non-JSON body)"
    requirement: "TMPL-02"
    verification:
      - kind: unit
        ref: "apps/web/src/features/campaigns/__tests__/campaignSendConflict.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "Both dialog mutations and test-send call classifySendError in onError, none closes its dialog on a conflict, none declares a retry option"
    requirement: "TMPL-02"
    verification:
      - kind: unit
        ref: "code review of the three onError bodies, quoted below"
        status: pass
    human_judgment: false
  - id: D3
    description: "SC1 (unsaved blocks all three actions) and SC3 (version conflict stays open, dispatches nothing) proven by clicking the real app"
    requirement: "TMPL-01"
    verification:
      - kind: e2e
        ref: "apps/web/e2e/campaign-template-correctness.spec.ts (could not execute locally this session -- ports 4000/5173 held by the running dev stack; typechecks and lints clean; runs in CI)"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-09: an illegal-transition conflict names the campaign's real current state and the dialog survives the status-changing refetch that reveals it"
    requirement: "TMPL-02"
    verification:
      - kind: human
        ref: "Task 3 checkpoint, re-verification round after the fix"
        status: pass
    human_judgment: true
  - id: D5
    description: "Full marketer flow (SC1, SC2/TMPL-03 test-send template fidelity, SC3/D-08 conflict recovery, D-09 concurrent-state naming) against a real SendGrid template and Dynamic Template"
    requirement: "TMPL-01, TMPL-02"
    verification:
      - kind: human
        ref: "Task 3 checkpoint -- approved"
        status: pass
    human_judgment: true

duration: unknown (continuation session; original session start not recorded)
completed: 2026-08-21
status: complete
---

# Phase 20 Plan 06: Conflict Recovery Copy and Click-Through Proof Summary

**Typed 409 classification (`version_conflict` / `illegal_transition`) replaces generic failure copy in both send dialogs and test-send, with dialogs kept open, refetched, and never auto-resent; a D-09 checkpoint failure (dialog unmounted by its own conflict refetch) was root-caused and fixed by mounting dialogs unconditionally at the page level.**

## Performance

- **Duration:** not reliably measurable — this SUMMARY is written by a continuation agent picking up after an approved human checkpoint; the original executor's start time was not carried into this session's context.
- **Tasks:** 3 (Task 1 auto/tdd, Task 2 auto, Task 3 checkpoint:human-verify)
- **Commits:** 4 (702e760, e3120f0, 2658d32, 093ab12)

## Accomplishments

- `apps/web/src/features/campaigns/campaignSendConflict.ts`: pure, framework-free module exporting `SendConflictKind`, `classifySendError(err)`, `VERSION_CONFLICT_COPY`, `illegalTransitionCopy(status)`, `CONFLICT_REFRESH_NOTICE`. Classification is entirely on the typed `code` field of the parsed 409 body — never on `err.message` — and reads the body defensively (string/undefined bodies return `null`, never throw).
- `CampaignStatusBadge.tsx` now exports `CAMPAIGN_STATUS_LABELS`, the same status→Russian-label map the badge itself renders, so the illegal-transition copy and the badge can never name the same state differently.
- `LaunchConfirmDialog` and `ScheduleDialog` (`LaunchScheduleDialogs.tsx`) both add `conflict: SendConflictKind | null` state alongside the existing `serverError`. On a recoverable 409, `onError` clears `serverError`, sets `conflict`, invalidates `campaignsQueryKey(slug)`, shows the D-10 refresh notice via `toast()` (informational, not an error toast), and returns without closing the dialog and without re-invoking the mutation. On a non-recoverable error, behavior is unchanged (`GENERIC_ERROR`). Neither mutation declares a `retry` option. The rendered message is composed at render time from the live `campaign` prop (`illegalTransitionCopy(campaign.status)` for `illegal_transition`, `VERSION_CONFLICT_COPY` for `version_conflict`), which the invalidation has already refreshed by render time.
- `TestSendPanel.tsx`'s `testSendMutation.onError` applies the same classification: `version_conflict` shows the same copy, invalidates the campaigns key prefix, and emits the same refresh notice; `illegal_transition` (not reachable for test-send, which performs no status transition) and every other error fall through to the existing generic `TEST_SEND_FAILURE` copy. No retry option added.
- `apps/web/e2e/campaign-template-correctness.spec.ts`: three Playwright tests — SC1 (unsaved changes disable launch-now, schedule, and test-send; saving re-enables all three), SC3 (a version conflict from a second mutation keeps the dialog open, shows the version-conflict copy, makes exactly one launch request, and leaves the campaign a draft), and a third test added for the D-09 fix (schedules the campaign from outside the open dialog — a real status change, not just a version bump — and asserts the dialog survives the refetch and names the real state, e.g. «Кампания уже в статусе «Запланирована»…»).
- **D-09 checkpoint fix**: `CampaignDetailPage.tsx` previously rendered `LaunchScheduleActions` (which owned `confirmOpen`/`scheduleOpen` and mounted the dialogs itself) only while `campaign.status === "draft"`. A conflict's own `invalidateQueries` refetch — the exact mechanism that refreshes the state the copy needs to name — flipped `campaign.status` away from `"draft"`, unmounting `LaunchScheduleActions` and the open dialog with it before the marketer ever saw the conflict copy. Fixed by moving `confirmOpen`/`scheduleOpen` state up to `CampaignDetailPage` and mounting `LaunchConfirmDialog`/`ScheduleDialog` unconditionally as siblings of the status-branched content, so an open dialog now survives its own conflict-triggered refetch. `LaunchScheduleActions` no longer owns that state; it takes `onOpenConfirm`/`onOpenSchedule` callbacks and keeps only its trigger row and `mode` state.

## Task Commits

1. **Task 1: Typed conflict recovery in both dialogs and the test-send panel** - `702e760` (feat)
2. **Task 2: End-to-end proof — blocked while unsaved, and a conflict that dispatches nothing** - `e3120f0` (test)
3. **D-09 fix: keep conflict dialog open through status refetch** - `2658d32` (fix; found during Task 3's first human-verification round, step 4)
4. **D-09 fix verification: e2e proof the fix survives the status-changing refetch** - `093ab12` (test)
5. **Task 3: Human verification** - no commit (checkpoint; approved)

## The three `onError` bodies (quoted, per acceptance criteria)

**`LaunchConfirmDialog.launchMutation.onError`** (`LaunchScheduleDialogs.tsx`):
```ts
onError: async (err) => {
  const kind = classifySendError(err);
  if (kind) {
    setServerError(null);
    setConflict(kind);
    await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
    toast(CONFLICT_REFRESH_NOTICE);
    return;
  }
  setConflict(null);
  setServerError(GENERIC_ERROR);
},
```

**`ScheduleDialog.scheduleMutation.onError`** (`LaunchScheduleDialogs.tsx`) — same shape:
```ts
onError: async (err) => {
  const kind = classifySendError(err);
  if (kind) {
    setServerError(null);
    setConflict(kind);
    await queryClient.invalidateQueries({ queryKey: campaignsQueryKey(slug) });
    toast(CONFLICT_REFRESH_NOTICE);
    return;
  }
  setConflict(null);
  setServerError(GENERIC_ERROR);
},
```

**`TestSendPanel.testSendMutation.onError`**:
```ts
onError: async (err) => {
  const kind = classifySendError(err);
  if (kind === "version_conflict") {
    setServerError(VERSION_CONFLICT_COPY);
    await queryClient.invalidateQueries({ queryKey: ["workspace", slug, "campaigns"] });
    toast(CONFLICT_REFRESH_NOTICE);
    return;
  }
  setServerError(TEST_SEND_FAILURE);
},
```

None of the three declares a `retry` option on its mutation. All three return immediately after handling a recoverable conflict, without re-invoking the mutation — the marketer's next click is the only thing that resends (T-20-06-01).

## RED evidence for the conflict tests

This SUMMARY is written by a continuation agent picking up after an approved checkpoint; the original RED-phase terminal output (the failing `campaignSendConflict.test.ts` run before `campaignSendConflict.ts` existed) was not captured in this session's context and cannot be reconstructed from git — commit `702e760` contains the test file and the implementation together in one `feat` commit, per the plan's own Task 1 commit structure (tdd="true" governs the in-session RED/GREEN loop; the plan does not require separate `test:`/`feat:` commits for this task the way a plan-level `type: tdd` would). What is verifiable now: `npm run test -w apps/web -- campaignSendConflict` passes today (part of the green `apps/web` unit-lane run below), and the acceptance criteria list every case the RED file was required to cover (409/version_conflict, 409/illegal_transition, 409 no code, 409 unrecognised code, 422/incomplete, 500, non-ApiError, string/undefined body, per-status label composition, D-08 wording match) — all of which are present in the committed test file. The original executor's Task 1 acceptance criterion "The SUMMARY records the RED run before campaignSendConflict.ts existed" could not be honored verbatim by this continuation agent; this is recorded here as a limitation rather than fabricated.

## e2e local-execution limitation

`npm run test:e2e -w apps/web -- campaign-template-correctness` could not be executed in this session or the original implementation session: ports 4000 and 5173 are held by the already-running dev stack, and `playwright.config.ts`'s `reuseExistingServer: false` refuses to start against occupied ports (confirmed by `lsof`). This is the same environment limit recorded for all three tests in this spec (SC1, SC3, and the D-09 addition). The spec typechecks and lints clean and is committed unmodified — no `test.skip`, no weakened assertions — and is the sanctioned fallback: it runs in CI, where no dev stack is already bound to those ports.

## Checkpoint history (Task 3)

**First verification round:** steps 1 (SC1, unsaved-state blocking) and 2 (SC2/TMPL-03, test-send template fidelity including the in-flight snapshot check) passed. Step 3 (SC3/D-08, version conflict) passed. Step 4 (D-09, concurrent state — cancel/launch from a second tab, then click «Отправить» in the first) **failed**: the dialog did not stay open to show the state-naming copy.

**Root cause:** `CampaignDetailPage` rendered `LaunchScheduleActions` — which owned the dialog-open state and mounted the dialogs — only while `campaign.status === "draft"`. The conflict handler's own `invalidateQueries` call, which exists specifically to refresh the campaign to its real current status before the copy names it, refetched a non-draft status and thereby unmounted `LaunchScheduleActions` and the open dialog with it, before the marketer ever saw the illegal-transition copy.

**Fix (`2658d32`):** moved `confirmOpen`/`scheduleOpen` state to `CampaignDetailPage` and mounted `LaunchConfirmDialog`/`ScheduleDialog` unconditionally as siblings of the status-branched content, so an open dialog now survives the refetch its own conflict handling triggers. `LaunchScheduleActions` was reduced to the trigger row plus `mode` state, taking `onOpenConfirm`/`onOpenSchedule` callbacks from the parent. `campaign-dirty-blocking.test.tsx`'s three `LaunchScheduleActions` render calls were updated for the new required props (Rule 1 — the build was failing without this; existing assertions unchanged).

**Fix verification (`093ab12`):** a third Playwright test was added to `campaign-template-correctness.spec.ts` reproducing exactly the checkpoint's step-4 scenario (schedule the campaign — a real status change, not just a version bump — from outside the open dialog, then click «Отправить») and asserting the dialog stays visible showing the campaign's real state. Subject to the same local-execution limitation above (ports held by the running dev stack); typechecks and lints clean.

**Re-verification round:** step 3 (D-08 sanity re-check) and step 4 (D-09, with the fix) both passed. Combined with steps 1–2 from the first round, the full four-step checkpoint is **approved**.

## jsdom deviation

`apps/web`'s unit lane is `environment: "node"` with no jsdom and no Testing Library installed anywhere in the workspace (established precedent: `apps/web/src/features/segments/__tests__/segmentSaveGate.test.ts`). Proving that a real click disables a real button, or that a real dialog stays mounted through a real state-changing refetch, requires a DOM and component mounting/unmounting that the node lane cannot provide. Rather than adding jsdom/@testing-library as a new dependency — which this plan's own threat register (`T-20-06-SC`) commits to not needing, and which would require a package-legitimacy checkpoint under this project's deviation rules before any install — the composition proof for both SC1/SC3 and the D-09 fix lives entirely in the Playwright e2e lane, which is already installed and is the only lane that mounts/unmounts real components against a real status change. The node-only unit lane (`campaignSendConflict.test.ts`) covers only the pure classification and copy-composition logic, which needs no DOM.

## Phase gate (post-checkpoint, pre-verify-work)

Run sequentially in the foreground per this plan's `<verification>` section:

- `npm run test -w apps/api`: **2 failed | 601 passed** (80 files).
  - `src/__tests__/sentry.test.ts` ("with no DSN configured...") — known machine-specific failure; this machine's `~/.config/mega-crm/.env` carries real Sentry DSNs since 2026-08-16 UAT, so the "no DSN" assumption the test makes does not hold here. Passes in CI.
  - `src/modules/webhooks/__tests__/webhooks-signature.test.ts` ("tampered signature -> 400, and no job is enqueued") — **new failure signature, investigated and confirmed a load flake, not a regression**: the assertion is a queue job-count delta (`19891` expected, `19892` received) on a shared/persistent Redis queue (`webhookEventsQueue.getJobCounts("waiting")` returning ~19.9k already-waiting jobs is itself evidence this is not an ephemeral per-test queue) while the dev stack was running per this session's instructions (never stopped). Re-run in isolation (`npm run test -w apps/api -- webhooks-signature`): **15/15 passed**, confirming the fail-closed code path itself is correct — a real regression in "tampered signature enqueues nothing" would fail deterministically in isolation too, and did not. `git log origin/master..HEAD --oneline -- apps/api/src/modules/webhooks` returns empty: no commit in this branch touches the webhooks module, so this plan's changes cannot be the cause. Recorded here as a flake, following the same isolation-confirms-flake protocol this plan's resume instructions already prescribe for `flow-run-advance-integration`/`migrate-runner-advisory-lock`.
- `npm run test -w apps/worker`: **1 failed | 660 passed** (89 files) — the same known `sentry.test.ts` "no DSN" machine-specific failure. Passes in CI.
- `npm run test -w apps/web`: **121 passed, 0 failed** (16 files).
- `npm run test:migrations`: **246 passed | 1 skipped** (30 files) — the expected rehearsal-empty-run skip.

No failure outside the known machine-specific exception and the one investigated-and-confirmed load flake was observed.

## Files Created/Modified

- `apps/web/src/features/campaigns/campaignSendConflict.ts` — new pure conflict-classification module
- `apps/web/src/features/campaigns/__tests__/campaignSendConflict.test.ts` — new unit test (node lane)
- `apps/web/src/features/campaigns/CampaignStatusBadge.tsx` — exported `CAMPAIGN_STATUS_LABELS`
- `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` — conflict state + classification in both dialog mutations; D-09 fix moved dialog-open state out of `LaunchScheduleActions`
- `apps/web/src/features/campaigns/TestSendPanel.tsx` — conflict classification in `testSendMutation.onError`
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx` — D-09 fix: owns `confirmOpen`/`scheduleOpen`, mounts both dialogs unconditionally
- `apps/web/src/features/campaigns/__tests__/campaign-dirty-blocking.test.tsx` — updated three `LaunchScheduleActions` render calls for the new required callback props
- `apps/web/e2e/campaign-template-correctness.spec.ts` — new Playwright spec, 3 tests (SC1, SC3, D-09)

## Decisions Made

- Typed-code classification only, never `err.message` matching (RESEARCH Pitfall #2, D-08/D-09).
- Illegal-transition copy composed at render time from the live `campaign.status` prop, never from state captured when the error arrived.
- `illegal_transition` in `TestSendPanel` falls through to the existing generic copy rather than inventing copy for a transition test-send cannot itself cause.
- D-09 fix: dialogs mounted unconditionally at the page level rather than gated on `campaign.status === "draft"`, so a conflict's own refetch cannot unmount the dialog showing the conflict copy.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] D-09: conflict dialog unmounted by its own status-changing refetch**
- **Found during:** Task 3, first human-verification round, step 4
- **Issue:** `CampaignDetailPage` rendered the dialog-owning component only while `campaign.status === "draft"`; the conflict handler's own refetch (needed to refresh the state the copy names) flipped the status and unmounted the open dialog before the marketer saw the copy.
- **Fix:** Moved dialog-open state to `CampaignDetailPage`; both dialogs now mount unconditionally as siblings of the status-branched content.
- **Files modified:** `CampaignDetailPage.tsx`, `LaunchScheduleDialogs.tsx`, `campaign-dirty-blocking.test.tsx`
- **Commits:** `2658d32` (fix), `093ab12` (e2e proof)
- **Verification:** re-verification round of the same checkpoint step, approved.

**2. [Continuation limitation, not a code deviation] RED-phase transcript not reconstructable**
- **Found during:** writing this SUMMARY (fresh continuation agent, no access to the original session's terminal output)
- **Issue:** Task 1's acceptance criteria call for the SUMMARY to record the RED run before `campaignSendConflict.ts` existed; commit `702e760` bundles the test and implementation together (task-level `tdd="true"`, not plan-level `type: tdd`), so no separate RED commit exists to inspect.
- **Resolution:** documented as a limitation above rather than fabricated; the committed test file's coverage is verified against the acceptance criteria instead.

---

**Total deviations:** 1 auto-fixed (Rule 1, D-09 dialog-unmount bug found at the human checkpoint) + 1 continuation-session limitation (documented, not a code change).
**Impact on plan:** The D-09 fix was necessary for the phase's own concurrent-state guarantee to hold; without it, the illegal-transition copy this plan built would never have been visible to a real marketer in the one scenario it exists for. No scope creep beyond the plan's own stated goal.

## Issues Encountered

- `apps/api`'s `webhooks-signature.test.ts` flaked under full-suite load with the dev stack running (see Phase gate section above) — investigated and confirmed not a regression via isolation re-run and a clean `git log` diff against `origin/master` for the webhooks module.

## User Setup Required

None — no new external service configuration. The human checkpoint used an already-connected real SendGrid key and existing Dynamic Templates in the verifier's workspace.

## Next Phase Readiness

- Phase 20's send-conflict recovery surface (TMPL-01, TMPL-02) is complete and human-verified end to end, including the concurrent-state naming (D-09) fix.
- No blockers for closing the phase. The one flaked test (`webhooks-signature.test.ts`) is unrelated to this plan's files and was confirmed non-regressive; if it recurs, treat recurrence (not the single occurrence recorded here) as the signal to investigate further, per this project's CI-flake-signature convention.

## Self-Check: PASSED

Confirmed all four task commits exist in `git log` on `gsd/phase-20-campaign-template-correctness` (`702e760`, `e3120f0`, `2658d32`, `093ab12`). Confirmed all files listed under "Files Created/Modified" exist on disk. Confirmed `campaignSendConflict.ts` contains the literals `version_conflict` and `illegal_transition` and imports `ApiError` from `@/lib/api`. Confirmed all three `onError` bodies quoted above match the current file contents verbatim (read directly from source, not recalled). Confirmed the phase gate command sequence (`apps/api`, `apps/worker`, `apps/web`, `test:migrations`) ran to completion with results as recorded.

---
*Phase: 20-campaign-template-correctness*
*Completed: 2026-08-21*
