---
phase: 20-campaign-template-correctness
plan: 05
subsystem: ui
tags: [react, tanstack-query, campaigns, dirty-state, shadcn]

# Dependency graph
requires:
  - phase: 20-campaign-template-correctness
    provides: plan 20-03's `expectedVersion` on launch/schedule/test-send and `campaign.version` echoed back into the client
provides:
  - "campaignDirtyState.ts: computeIsDirty/computeDirtyBlockReason pure comparison over name/segmentId/templateId/fromSenderId"
  - "CampaignDirtyStateContext.tsx: the single shared unsaved-state value (isDirty/blockReason/isSaving/save) for the draft view's three consumers"
  - "UnsavedChangesBanner.tsx: amber Card with a one-click save that reuses the builder's own save mutation"
  - "LaunchScheduleActions and TestSendPanel both fold isDirty into their existing disabled expression, with incomplete-reason precedence over the dirty reason"
affects: [20-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure decision module + React context, mirroring segmentSaveGate.ts: the comparison itself has zero React import and is exhaustively unit-tested in the node-only vitest lane; the context is the only place that reads it and republishes a derived value to more than one consumer."
    - "Publish-up-the-tree via a ref-held callback: the builder calls usePublishCampaignFormState with a save callback held in a ref inside the provider (not state), so a re-publish updates which save the banner will invoke without needing `save`'s own identity to change."

key-files:
  created:
    - apps/web/src/features/campaigns/campaignDirtyState.ts
    - apps/web/src/features/campaigns/CampaignDirtyStateContext.tsx
    - apps/web/src/features/campaigns/UnsavedChangesBanner.tsx
    - apps/web/src/features/campaigns/__tests__/campaignDirtyState.test.ts
    - apps/web/src/features/campaigns/__tests__/campaign-dirty-blocking.test.tsx
  modified:
    - apps/web/src/features/campaigns/CampaignBuilderPage.tsx
    - apps/web/src/features/campaigns/CampaignDetailPage.tsx
    - apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx
    - apps/web/src/features/campaigns/TestSendPanel.tsx

key-decisions:
  - "fromEmail is excluded from CampaignFormSnapshot entirely (not just skipped in the comparison) -- it's server-resolved, never marketer-edited, so including it would show a false unsaved state right after a resolution persists a new address."
  - "The provider wraps the embedded CampaignBuilderPage AND both sibling action components (not just the actions) -- the builder is the only publisher and must sit inside the same provider its consumers read from, or usePublishCampaignFormState would publish into the default inert context instead."
  - "Precedence when both an incomplete-field reason and the dirty reason apply: the incomplete reason wins and is the only line shown, reusing the exact same <p className=\"text-sm text-destructive\"> element -- never two stacked reasons."

patterns-established:
  - "Rendered-markup test precedent (campaign-progress-ambiguous.test.tsx) extended to context-consuming components: seed a hand-made CampaignDirtyStateContext.Provider value directly rather than the real provider, since renderToStaticMarkup never runs effects and the real provider's state is populated by an effect."

requirements-completed: [TMPL-01]

coverage:
  - id: D1
    description: "Pure dirty-state comparison (computeIsDirty/computeDirtyBlockReason) over name/segmentId/templateId/fromSenderId, with fromEmail exclusion, whitespace trimming, and null-transition coverage for templateId/fromSenderId"
    requirement: "TMPL-01"
    verification:
      - kind: unit
        ref: "apps/web/src/features/campaigns/__tests__/campaignDirtyState.test.ts (13 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "CampaignBuilderPage publishes its live field state (post server-sync, edit-draft only) to CampaignDirtyStateContext; CampaignDetailPage wraps the builder and both action components in one provider"
    requirement: "TMPL-01"
    verification: []
    human_judgment: true
    rationale: "The publish effect and the provider's derived-state wiring only run in a real DOM (renderToStaticMarkup used elsewhere in this plan never executes React effects), so the end-to-end 'edit a field, see the banner appear, save, see it disappear' loop is not exercised by this plan's automated tests. Deferred to the Playwright spec in plan 20-06 per the plan's own design note."
  - id: D3
    description: "UnsavedChangesBanner, LaunchScheduleActions, and TestSendPanel all react correctly to a hand-seeded dirty/clean context: banner renders/hides, both send actions disable with the block reason shown, incomplete-reason precedence holds, and /campaigns/new (no provider) renders unaffected"
    requirement: "TMPL-01"
    verification:
      - kind: unit
        ref: "apps/web/src/features/campaigns/__tests__/campaign-dirty-blocking.test.tsx (8 tests)"
        status: pass
    human_judgment: false

duration: 13min
completed: 2026-08-21
status: complete
---

# Phase 20 Plan 05: Campaign unsaved-changes dirty-state gating Summary

**Pure comparison + shared React context that makes an unsaved campaign-form edit visible as an amber banner and blocks launch/schedule/test-send until the marketer saves**

## Performance

- **Duration:** 13 min
- **Started:** 2026-08-21T09:46:00Z
- **Completed:** 2026-08-21T09:58:27Z
- **Tasks:** 3
- **Files modified:** 9 (5 created, 4 modified)

## Accomplishments
- `campaignDirtyState.ts` compares the campaign builder's four editable fields against the saved row and returns a single boolean + inline reason string; `fromEmail` is structurally excluded (it isn't even a field on `CampaignFormSnapshot`), and the whitespace/null-transition edge cases are exhaustively unit tested.
- `CampaignDirtyStateContext.tsx` gives the draft view's three consumers (banner, launch/schedule, test-send) one shared derived value, computed once above all three, with an inert default so `/campaigns/new` (no provider mounted) is byte-identical in behaviour.
- `UnsavedChangesBanner` (new amber `Card`, builder's exact classes) sits directly above `TestSendPanel`; its «Сохранить» button invokes the same save mutation the builder's own «Сохранить черновик» button calls -- one save path, not two.
- `LaunchScheduleActions` and `TestSendPanel` both fold `isDirty` into their existing `disabled` expression; when a campaign is both incomplete and dirty, only the incomplete-field reason renders (never both reasons stacked).
- No `beforeunload` listener or router-blocker was added anywhere (D-04) -- navigating away from an unsaved campaign stays unguarded; only the three send actions are blocked.

## Task Commits

Each task was committed atomically:

1. **Task 1: The pure unsaved-state comparison and the shared context that carries it** - `3717c1d` (feat)
2. **Task 2: The builder publishes its form state; the detail page provides it and shows the amber banner** - `5d3dcb5` (feat)
3. **Task 3: Launch, schedule and test-send are all blocked while unsaved, with inline reasons** - `bfe717c` (feat)

_Note: Tasks 1 and 3 are `tdd="true"`. Each task's test file and its corresponding implementation were committed together as a single atomic commit rather than as separate `test(...)`/`feat(...)` commits -- see "RED run evidence" below for the actual RED-then-GREEN terminal evidence, captured before either commit was made._

## RED run evidence

**Task 1** (`campaignDirtyState.test.ts`, before `campaignDirtyState.ts` existed):
```
FAIL  src/features/campaigns/__tests__/campaignDirtyState.test.ts
Error: Cannot find module '../campaignDirtyState' imported from .../campaignDirtyState.test.ts
Test Files  1 failed (1)
     Tests  no tests
```
After creating `campaignDirtyState.ts`: `Test Files 1 passed (1)` / `Tests 13 passed (13)`.

**Task 3** (`campaign-dirty-blocking.test.tsx`, before `LaunchScheduleDialogs.tsx`/`TestSendPanel.tsx` were changed):
```
Tests  4 failed | 4 passed (8)
 FAIL  ... disables the primary action and shows the dirty reason for a complete campaign while dirty
   AssertionError: expected '<div class="space-y-3">...' to contain 'Сохраните изменения...'
 FAIL  ... disables the send button and shows the dirty reason for a complete campaign while dirty
   AssertionError: expected '<div class="rounded-xl border...' to contain 'Сохраните изменения...'
```
(The other 2 "disabled" failures in that first RED run were a test-helper bug caught and fixed before the real RED run above -- see Issues Encountered.) After wiring `isDirty`/`blockReason` into both components: `Test Files 1 passed (1)` / `Tests 8 passed (8)`.

## Files Created/Modified
- `apps/web/src/features/campaigns/campaignDirtyState.ts` - Pure comparison: `CampaignFormSnapshot`, `computeIsDirty`, `computeDirtyBlockReason`, `DIRTY_BLOCK_REASON`
- `apps/web/src/features/campaigns/CampaignDirtyStateContext.tsx` - `CampaignDirtyStateContext`, `CampaignDirtyStateProvider`, `useCampaignDirtyState`, `usePublishCampaignFormState`
- `apps/web/src/features/campaigns/UnsavedChangesBanner.tsx` - The amber save-only notice
- `apps/web/src/features/campaigns/__tests__/campaignDirtyState.test.ts` - 13 field-by-field/whitespace/null-transition unit tests
- `apps/web/src/features/campaigns/__tests__/campaign-dirty-blocking.test.tsx` - 8 rendered-markup tests (banner, both action components, no-provider create page)
- `apps/web/src/features/campaigns/CampaignBuilderPage.tsx` - Added `hasSyncedFromServer` flag, `handleSave` wrapped in `useCallback`, calls `usePublishCampaignFormState`
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx` - Draft branch wraps builder + `TestSendPanel` + `LaunchScheduleActions` in `CampaignDirtyStateProvider`; renders `UnsavedChangesBanner` above `TestSendPanel`
- `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` - `LaunchScheduleActions` reads `useCampaignDirtyState()`, folds `isDirty` into `disabled`, incomplete-reason precedence
- `apps/web/src/features/campaigns/TestSendPanel.tsx` - Reads `useCampaignDirtyState()`, folds `isDirty` into the send button's `disabled`, renders block reason above the button

## Context value shape and the two disabled expressions (for plan 20-06)

```ts
interface CampaignDirtyStateContextValue {
  isDirty: boolean;
  blockReason: string | null;
  isSaving: boolean;
  save: () => void;
  publish: (snapshot: CampaignFormSnapshot | null, save: () => void, isSaving: boolean) => void;
}
```

- **LaunchScheduleActions:** `const disabled = !canLaunch || Boolean(incompleteReason) || isDirty;` -- reason line: `incompleteReason ?? dirtyBlockReason`.
- **TestSendPanel:** `disabled={testSendMutation.isPending || isDirty}` -- reason line (`dirtyBlockReason`) rendered as its own `<p>` directly above the button, alongside (not replacing) `serverError`.

## Exact copy

- Banner message: «Есть несохранённые изменения — сохраните черновик, чтобы отправить, запланировать или отправить тестовое письмо.»
- Banner save button: «Сохранить» / pending «Сохраняем…»
- Inline dirty-block reason (`DIRTY_BLOCK_REASON`): «Сохраните изменения, чтобы отправить, запланировать или отправить тестовое письмо»

## Decisions Made
- `fromEmail` excluded by omitting it from `CampaignFormSnapshot`'s type entirely, not by special-casing it inside the comparison -- a later phase adding a new builder field must consciously add it to the interface, which is documented as deliberate in the module's own doc comment.
- The provider (`CampaignDirtyStateProvider`) encloses `CampaignBuilderPage` itself, not just the two sibling action components -- required because the builder is the only publisher, and it must read from the same context instance its siblings read from.
- `handleSave`'s `useCallback` deps are `[name, segmentId]` (the fields the function itself reads for validation), not all four form fields -- verified safe against `templateId`/`fromSenderId` going stale because TanStack Query's `useMutation` keeps its `mutate` function and its underlying `MutationObserver` stable across renders and updates `mutationFn` via a `useEffect`-driven `setOptions` call, so `saveMutation.mutate()` always dispatches against the latest field values regardless of which render's `handleSave` closure is invoked (confirmed by reading `node_modules/@tanstack/react-query/src/useMutation.ts`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test helper collided with Tailwind's `disabled:` variant classes and picked the wrong button**
- **Found during:** Task 3, first RED run of `campaign-dirty-blocking.test.tsx`
- **Issue:** The initial `buttonOpenTagFor` helper used `html.indexOf(label)` to find `<button>Отправить сейчас</button>`, but the same text also appears earlier as a `<label>` for the radio group, so it grabbed the radio `<button role="radio">` instead of the primary submit button. Separately, `expect(tag).toContain("disabled")` matched the Button component's always-present Tailwind classes `disabled:pointer-events-none disabled:opacity-50`, so the "not disabled while clean" assertions failed even before any component code was touched.
- **Fix:** Changed to `html.lastIndexOf(label)` (the primary button's own text is always the last occurrence) and added an `isDisabled()` helper checking for the literal `disabled=""` attribute string, not a bare `"disabled"` substring.
- **Files modified:** `apps/web/src/features/campaigns/__tests__/campaign-dirty-blocking.test.tsx` (test-only, no source-code impact)
- **Verification:** Re-ran RED with the fixed helper -- exactly the 2 expected disabled-while-dirty cases failed (not the 4 the buggy helper produced), confirming the test infrastructure itself was correct before touching source files.
- **Committed in:** `bfe717c` (part of Task 3 commit; the helper never existed in a prior commit)

---

**Total deviations:** 1 auto-fixed (1 bug, test-only)
**Impact on plan:** No production code affected; the fix corrected the test's own assertion logic before it was ever used to gate a real code change.

## Issues Encountered
- **Worktree environment cannot complete `npm run build -w apps/web`** (pre-existing, not caused by this plan): `tsc --noEmit` fails with `TS2688: Cannot find type definition file for 'vite/client'` because this git worktree has no local `apps/web/node_modules`, and unlike most bare-specifier imports (which resolve via Node's ancestor-directory walk into the main checkout's hoisted root `node_modules`), the `vite` package itself lives only in the main checkout's `apps/web/node_modules/vite` -- a sibling path, not an ancestor of the worktree, so it is genuinely unreachable from here. **Confirmed pre-existing**: temporarily moved this plan's 3 new files out of the tree and reran the exact same build command -- identical failure, proving zero relationship to this plan's changes. As a substitute, `npx tsc --noEmit -p tsconfig.json --types node` (overriding the unresolvable `types` entry) was run after every task; it reports only the same 2 pre-existing unrelated errors (`src/lib/sentry.ts`'s `ImportMeta.env`, `vite.config.ts`'s own `vite`/`@vitejs/plugin-react` imports) both before and after this plan's changes, with zero errors in any file this plan touches.
- `npm run test -w apps/web` (full suite) has one pre-existing unrelated failure (`src/__tests__/playwright-package-source-import.test.ts`, a `MODULE_NOT_FOUND` for a subprocess-spawned script -- the same worktree/main-checkout node_modules split). Not touched by this plan; only the scoped test files named in the plan's verify steps (`campaignDirtyState`, `campaign-dirty-blocking`) plus the broader `campaign` test glob (29 tests, all passing) were run, per this session's test-scope rule.
- Per this worktree's task rules, `apps/web/node_modules/.vite*` cache directories left behind by each `vitest run` invocation were removed before every commit; confirmed empty via `find . -maxdepth 4 -name node_modules -not -path "*/node_modules/*"` before the final commit.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 20-06 can render inside the same `CampaignDirtyStateContext` (shape documented above) for its version-conflict/illegal-transition copy work on the same dialogs/panel.
- The end-to-end "edit a field → banner appears → save → banner disappears → actions re-enable" loop (D2 above) has no automated coverage in this plan by design (no jsdom); it is UAT/Playwright territory for plan 20-06 or a dedicated UAT pass.
- `npm run build -w apps/web` cannot be verified to exit 0 in this worktree due to the pre-existing environment gap described above -- the orchestrator (or a non-worktree re-run) should confirm a clean build once the wave's branches are merged into a checkout with full `apps/web/node_modules`.

---
*Phase: 20-campaign-template-correctness*
*Completed: 2026-08-21*
