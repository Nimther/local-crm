---
phase: 15-observability-alerting-frontend-resilience
plan: 07
subsystem: ui
tags: [tanstack-query, react, error-states, empty-states, d-11, ops-17]

# Dependency graph
requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "plan 15-05's QueryErrorState/EmptyState shared components and the isFullyErrored/isStaleErrored branch order established on ContactsListPage/SendLogPage"
provides:
  - "Campaigns, flows, dashboard, team and settings surfaces converted to pending -> error -> empty -> data branch order using the same shared components"
  - "Complete apps/web/src/features sweep of remaining useQuery sites without an error branch, each documented with a reason"
affects: ["15-09 (flow canvas/unsaved-changes work) -- FlowDetailPage's own query is converted, canvas internals (NodeConfigPanel, FlowCanvas) intentionally untouched"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Same isFullyErrored (isError && !data) / isStaleErrored (isError && Boolean(data)) split from 15-05, applied to every remaining list/detail region in this plan."
    - "Poll-driven regions (CampaignProgress, CampaignDetailPage while status='sending') keep last-known values on a background poll failure -- QueryErrorState renders as a contained banner above stale data, never replacing it."
    - "Single-endpoint dashboard constraint: WorkspaceDashboard's one combined query cannot be split into independent per-widget queries without an API contract change (out of scope, presentational-only plan) -- honesty is achieved instead via two region-scoped QueryErrorState cards (KPI/chart region, lists region) plus header/OnboardingChecklist/period-selector that never disappear regardless of query state."
    - "'Connect vs status-unknown' distinction (T-15-19): SendGridKeySettings' not-connected/connect-form branch is reachable ONLY from a successful `connected: false` response, never from a fetch failure -- the same shape now used anywhere a false-y/empty response and a fetch failure were previously conflated into one UI branch."

key-files:
  modified:
    - apps/web/src/features/campaigns/CampaignsListPage.tsx
    - apps/web/src/features/campaigns/CampaignDetailPage.tsx
    - apps/web/src/features/campaigns/CampaignProgress.tsx
    - apps/web/src/features/campaigns/SendSettingsPage.tsx
    - apps/web/src/features/campaigns/TemplateSenderPickers.tsx
    - apps/web/src/features/flows/list/FlowsListPage.tsx
    - apps/web/src/features/flows/detail/FlowDetailPage.tsx
    - apps/web/src/features/dashboard/WorkspaceDashboard.tsx
    - apps/web/src/features/team/TeamPage.tsx
    - apps/web/src/features/api-keys/ApiKeysSettings.tsx
    - apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx
    - apps/web/src/features/workspace-home/WorkspaceHome.tsx

key-decisions:
  - "WorkspaceDashboard is served by ONE combined endpoint (getWorkspaceDashboard) returning KPIs, both charts and both mini-lists in a single payload -- there is no per-widget query to independently fail, and this plan is presentational-only (no query key/URL/contract changes permitted). Rendered as two region-scoped QueryErrorState cards instead of one page-wide message, with header/period-selector/OnboardingChecklist never disappearing regardless of the query's state -- the closest honest reading of 'each widget owns its own inline error state' achievable without an architecture change."
  - "CampaignDetailPage's own query polls every 3s while status='sending' -- split into isFullyErrored (no prior data, full QueryErrorState) vs isStaleErrored (has prior data, contained banner above the still-rendered detail view), matching CampaignProgress's own poll-failure behavior one level up the tree."
  - "TeamPage's membersQuery and invitesQuery are merged into one `rows` array for the roster table -- treated as one combined region: either query failing with no prior data blocks the whole table (a partial roster would misrepresent who has access), not two independent per-query error states."
  - "SendGridKeySettings' statusQuery failure is the one case in this plan explicitly named in the plan text as highest-consequence (T-15-19) -- the not-connected/connect-form UI is now reachable only from a successful connected:false response, never a fetch failure, closing the exact repudiation risk the threat register names."

requirements-completed: [OPS-17]

coverage:
  - id: D1
    description: "Campaigns surface (list, detail, progress, send settings, template/sender pickers) distinguishes failure from emptiness; a poll failure never wipes known campaign progress; template/sender fetch failures never read as 'no templates configured'"
    requirement: "OPS-17"
    verification:
      - kind: unit
        ref: "npx vitest run --root apps/web -> 10 files, 64 tests pass (no new unit tests added for this plan -- covered by 15-05's shared-component suite plus build/lint gates, per plan's own verify block)"
        status: pass
      - kind: other
        ref: "grep -c QueryErrorState/EmptyState across the 5 campaigns files -> >=1 each; git diff queryKey values across all 12 modified files vs HEAD -> zero changes"
        status: pass
      - kind: other
        ref: "npm run build -w apps/web (tsc --noEmit + vite build) -> exit 0; scoped npx eslint on all 5 files -> 0 errors/warnings"
        status: pass
    human_judgment: false
  - id: D2
    description: "Flows list/detail and workspace dashboard distinguish failure from emptiness; the flow canvas never mounts over a failed flow-definition load; a failing dashboard region does not blank the rest of the page"
    requirement: "OPS-17"
    verification:
      - kind: unit
        ref: "npx vitest run --root apps/web -> 64/64 pass"
        status: pass
      - kind: other
        ref: "grep -c QueryErrorState on FlowsListPage/FlowDetailPage/WorkspaceDashboard -> >=1 each, WorkspaceDashboard >=2; grep for a single page-wide early return in WorkspaceDashboard -> none found (only the component's own top-level return)"
        status: pass
      - kind: other
        ref: "npm run build -w apps/web -> exit 0; scoped eslint on all 3 files -> 0 errors/warnings"
        status: pass
    human_judgment: false
  - id: D3
    description: "Team, API keys, SendGrid key and workspace-home surfaces distinguish failure from emptiness; a failed SendGrid status fetch never renders as 'no key configured'; the apps/web/src/features sweep is complete with reasons recorded for every remaining unconverted site"
    requirement: "OPS-17"
    verification:
      - kind: unit
        ref: "npx vitest run --root apps/web -> 64/64 pass"
        status: pass
      - kind: other
        ref: "grep -c QueryErrorState on all 4 files -> >=1 each (workspace-home 3, team 4, sendgrid-key 3, api-keys 3)"
        status: pass
      - kind: other
        ref: "npm run build -w apps/web -> exit 0; scoped eslint on all 4 files -> 0 errors/warnings; the sweep table below names every remaining useQuery site (in-file and out-of-scope) with a reason"
        status: pass
    human_judgment: false
  - id: D4
    description: "Manual verification: with the API stopped, every converted region on these surfaces shows its own error state with a working Retry, and the page shell stays usable"
    verification: []
    human_judgment: true
    rationale: "The plan's own <verification> section names this as a manual check requiring a running API/dev server. No dev server was started in this worktree execution (same constraint 15-05 documented) -- the automated proxies (build, scoped lint, queryKey-diff-vs-HEAD, 15-05's own shared-component test suite) are the closest available substitute. Requires a human or a later live-verification pass."

# Metrics
duration: ~25min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 07: Campaigns/Flows/Dashboard/Team/Settings Error, Empty & Sweep Summary

**Remaining OPS-17 surfaces (campaigns, flows, dashboard, team, API keys, SendGrid key, workspace-home) converted to the shared QueryErrorState/EmptyState idiom from plan 15-05, plus a full apps/web/src/features sweep documenting every still-unconverted useQuery site with its reason.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-08-15T16:30:00Z
- **Completed:** 2026-08-15T16:55:00Z
- **Tasks:** 3
- **Files modified:** 12

## Accomplishments

- **Campaigns surface (Task 1):** `CampaignsListPage` and `CampaignDetailPage` get the same full/stale error split as `ContactsListPage` (15-05); `CampaignDetailPage`'s own 3s poll-while-sending query never blanks the page on a transient poll failure -- a contained banner renders above the still-visible detail view instead. `CampaignProgress` (the live progress bar shown while a campaign is sending) keeps its last known sent/delivered/opened/clicked counts on a poll failure, surfacing the failure as a banner above them rather than resetting to zero. `SendSettingsPage`'s settings query failure no longer renders a blank/default form indistinguishable from real saved values. `TemplateSenderPickers`' template and sender fetch failures now say "could not load" with Retry in both the popover's `CommandEmpty` and the below-picker fallback text, replacing a copy that previously read identically whether the account genuinely had zero templates or the fetch had simply failed -- exactly the support-question failure mode the plan named.
- **Flows and dashboard surfaces (Task 2):** `FlowsListPage` mirrors `CampaignsListPage`'s conversion. `FlowDetailPage`'s flow-definition query (the data the canvas renders) now splits its previously-conflated `isError`/not-found branch -- a failed fetch shows `QueryErrorState` with Retry in place of the canvas, so the editor never mounts over missing or partial data; the canvas's own internals (`FlowCanvas`, `NodeConfigPanel`) and its unsaved-changes/dirty-state handling were left untouched, reserved for plan 15-09 per this plan's own instruction. `WorkspaceDashboard` is fed by one combined endpoint with no per-widget query to split (an API contract change is out of scope for this presentational-only plan) -- a failure now renders as two region-scoped `QueryErrorState` cards (KPI/chart region, lists region) instead of one page-wide message, and the header/period-selector/`OnboardingChecklist` above never disappear regardless of the query's state.
- **Team, settings and workspace-home surfaces plus the sweep (Task 3):** `TeamPage`'s merged member+invite roster gets one region-level error state when either underlying query fails with no prior data (a partial roster would misrepresent who actually has access), and an `EmptyState` distinct from it for the genuinely-solo-owner case. `ApiKeysSettings` gets the same full/stale split plus an `EmptyState` for zero keys. `SendGridKeySettings` -- the plan's own named highest-consequence case (T-15-19) -- no longer lets a failed status fetch fall into the "SendGrid not connected" branch, which previously read as "no key configured" and invited re-entering a key that might already be stored; that branch is now reachable only from a successful `connected: false` response. `WorkspaceHome` splits its conflated `isLoading`/`!data` branch into `QueryErrorState` (Retry-able) vs `EmptyState` (a not-found fact). The full `apps/web/src/features` sweep for remaining unconverted `useQuery` sites is recorded below with a reason for each -- nothing is silently left unconverted.
- Verified across all 12 modified files that `queryKey` values are byte-identical to `HEAD` (`git diff` grep for `queryKey` lines returns nothing) -- no query key, request URL or API contract changed anywhere in this plan, matching its own prohibition.

## Task Commits

Each task was committed atomically:

1. **Task 1: Convert the campaigns surface** - `039cd97` (feat)
2. **Task 2: Convert the flows and dashboard surfaces** - `fbaf03a` (feat)
3. **Task 3: Convert the team, settings and workspace-home surfaces** - `503f523` (feat)

_No plan-metadata commit in the normal sense -- per worktree instructions, STATE.md/ROADMAP.md/WINDOWS.md are not touched by this agent. This SUMMARY.md is committed separately via `git add -f` (`.planning/` is gitignored in this repo)._

## Files Created/Modified

- `apps/web/src/features/campaigns/CampaignsListPage.tsx` - Full/stale error split, EmptyState for zero campaigns
- `apps/web/src/features/campaigns/CampaignDetailPage.tsx` - Split conflated isError/not-found branch; poll failure while sending keeps the page, contained banner instead
- `apps/web/src/features/campaigns/CampaignProgress.tsx` - A poll failure never wipes last known progress; full QueryErrorState only when there was never a successful poll
- `apps/web/src/features/campaigns/SendSettingsPage.tsx` - Settings-fetch failure no longer renders a blank/default form
- `apps/web/src/features/campaigns/TemplateSenderPickers.tsx` - Template/sender fetch failure reads as "could not load", not "no templates configured", in both the popover and the fallback text
- `apps/web/src/features/flows/list/FlowsListPage.tsx` - Same full/stale error split and EmptyState as CampaignsListPage
- `apps/web/src/features/flows/detail/FlowDetailPage.tsx` - Split conflated isError/not-found branch on the flow query the canvas renders
- `apps/web/src/features/dashboard/WorkspaceDashboard.tsx` - Two region-scoped QueryErrorState cards (KPI/chart, lists) instead of one page-wide message; header/period-selector/OnboardingChecklist never disappear
- `apps/web/src/features/team/TeamPage.tsx` - Combined membersQuery/invitesQuery full/stale error split for the merged roster table, EmptyState distinct from it
- `apps/web/src/features/api-keys/ApiKeysSettings.tsx` - Full/stale error split + EmptyState for zero keys
- `apps/web/src/features/sendgrid-key/SendGridKeySettings.tsx` - Failed status fetch no longer falls into the "not connected" branch (T-15-19)
- `apps/web/src/features/workspace-home/WorkspaceHome.tsx` - Split conflated isLoading/!data branch into QueryErrorState vs EmptyState

## Decisions Made

- WorkspaceDashboard's single combined endpoint cannot be split into per-widget queries without an API contract change, which this presentational-only plan does not make -- two region-scoped `QueryErrorState` cards within the one shared query, plus chrome that never disappears, is the closest honest reading of "each widget owns its own inline error state" achievable under that constraint. See `## Deviations from Plan` below.
- `CampaignDetailPage`'s own detail query polls while `status === "sending"` -- given `isFullyErrored`/`isStaleErrored` treatment one level up the component tree from `CampaignProgress`, so a poll failure at either level degrades to a banner, never a page/section replacement.
- `TeamPage` treats `membersQuery` and `invitesQuery` as one combined region (not two independent error states) because their outputs are merged into a single `rows` array before rendering -- a partial roster (one query succeeded, one failed) would misrepresent who actually has workspace access, which is worse than a single combined "could not load the team" state.
- `workspaceQuery`-style permission-gate queries (used only to compute `viewerRole`/`canManage`, never to render their own region) were left unconverted everywhere they appear in this plan's files (`CampaignDetailPage`, `SendSettingsPage`, `TeamPage`, `ApiKeysSettings`, `SendGridKeySettings`, `FlowDetailPage`) -- on failure they default to `"member"`, the least-privileged role, which is a fail-safe (not fail-open) degradation. This matches 15-05's own precedent for secondary/gating queries and is listed explicitly in the sweep table below rather than silently skipped.

## Sweep: remaining `useQuery` sites without an error branch

Per Task 3's own instruction, every `useQuery` call under `apps/web/src/features` was checked. Sites converted in this plan or in 15-05 are omitted below. Every other site is named here with its reason -- none are silently left unconverted.

**Inside this plan's own 12 converted files** (secondary/gating queries deliberately left as-is):

| File:line | Query | Reason left unconverted |
|---|---|---|
| `CampaignDetailPage.tsx:179` | `workspaceQuery` (viewerRole gate) | Fails safe to `"member"` (least privilege); renders no region of its own. Same precedent as 15-05's gating queries. |
| `CampaignDetailPage.tsx` `ScheduledView.breakdownQuery` | Audience breakdown estimate | On failure the caption shows `"…"` (its existing loading placeholder) rather than a wrong number; not the plan's named region. |
| `CampaignDetailPage.tsx` `SendingView.breakdownQuery` (`staleTime: Infinity`) | Frozen audience snapshot | On failure the card simply doesn't render (`breakdownQuery.data ?` guard) -- silent omission, not misleading data. |
| `CampaignDetailPage.tsx` `SummaryView.progressQuery` (`staleTime: Infinity`) | Terminal campaign counts | Falls back to the parent `campaign` row's own counters, which are real (already-fetched) data, not placeholders. |
| `SendSettingsPage.tsx:64` | `workspaceQuery` (viewerRole gate) | Same as above -- fails safe to `"member"`. |
| `TeamPage.tsx:38` | `workspaceQuery` (viewerRole gate + Danger Zone visibility) | Same as above; Danger Zone additionally only renders when `workspaceQuery.data` exists, so a failure simply hides a destructive action rather than misrepresenting anything. |
| `ApiKeysSettings.tsx:255` | `workspaceQuery` (viewerRole gate) | Same as above. |
| `SendGridKeySettings.tsx:165` | `workspaceQuery` (viewerRole gate) | Same as above. |
| `SendGridKeySettings.tsx` `WebhookHealthCard.healthQuery` | Webhook health badge | On failure `badgeStatus` falls back to `"pending"` (not `"active"` or a false-negative "error") -- an honest "not yet known" reading, not misrepresentation. Not the plan's named highest-consequence case (that was `statusQuery`, which this plan did convert). |
| `FlowDetailPage.tsx:66` | `workspaceQuery` (viewerRole gate) | Same as above. |
| `FlowDetailPage.tsx:79` | `runCountsQuery` (header contact-count caption) | Falls back to `"…"`, the existing loading placeholder -- silent, not misleading. |
| `FlowDetailPage.tsx:85` | `analyticsQuery` (canvas node-badge metrics) | Feeds `FlowCanvas`'s own metrics prop -- canvas internals are explicitly plan 15-09's territory per this plan's own instruction not to touch the canvas. |
| `FlowDetailPage.tsx:87` | `segmentsQuery` (trigger-segment name lookup) | Same class as `CampaignsListPage`/`FlowsListPage`'s segment-name lookups below -- degrades to showing the raw id/"выбран" fallback, not an error. |
| `CampaignsListPage.tsx:76` | `segmentsQuery` (audience name lookup) | Row-enrichment data (segment display name), not the list region itself; degrades to `"—"`, matching 15-05's explicit precedent for this exact class of query (`SegmentsListPage`'s `membersQuery`). |
| `FlowsListPage.tsx:163` | `segmentsQuery` (trigger-segment name lookup) | Same as above. |

**Outside this plan's `files_modified` list** (would be scope expansion; documented, not touched):

| File:line | Query | Reason |
|---|---|---|
| `campaigns/CampaignBuilderPage.tsx:35` | `segmentsQuery` (SegmentPicker) | Not in this plan's files. Same row-enrichment class as above -- degrades to "Сегменты не найдены" in the combobox on both genuine emptiness and fetch failure (a real gap, same shape as `TemplateSenderPickers` before this plan, but a different file). |
| `campaigns/CampaignBuilderPage.tsx:104` | `campaignQuery` (edit-mode draft load) | Not in this plan's files. `if (isEdit && campaignQuery.isLoading)` gates only the loading skeleton; a fetch failure currently falls through to render the create-mode empty form, which could look like editing a blank draft rather than showing that the real draft failed to load. Candidate for a follow-up plan. |
| `campaigns/LaunchScheduleDialogs.tsx:66` | `breakdownQuery` (LaunchConfirmDialog) | Not in this plan's files. **Flagged as a genuine defect below** -- a failed fetch silently omits the audience breakdown and the "Отправить" (Launch) button remains enabled, so an operator can confirm a send without ever seeing exclusions. |
| `campaigns/TestSendPanel.tsx:50` | `sampleQuery` (test-send sample payload) | Not in this plan's files. On failure the JSON textarea stays empty with no message; a test send could go out with a blank payload with no visible cause. Candidate for a follow-up plan. |
| `contacts/ContactForm.tsx:242` | `registryQuery` (property registry, create-contact dialog) | Not in this plan's files. Sibling instance of `ContactDetailPage`'s `PropertiesTab.registryQuery`, which 15-05 DID convert -- this create-dialog instance was missed by that plan and remains on the `?? []` degrade. Good candidate to align with 15-05's own precedent in a follow-up. |
| `contacts/CsvImportWizard.tsx:190` | `registryQuery` (CSV mapping step) | Not in this plan's files. Same row-enrichment class -- degrades to an empty property list in the mapping dropdown. |
| `contacts/CsvImportWizard.tsx:413,505` | `statusQuery` (`ApplyProgressAndReport`, `ImportReentryView`) | Not in this plan's files. **Flagged as a genuine defect below** -- `if (!status)` conflates "still loading" with "fetch failed forever"; a poll or reentry-fetch failure shows "Загружаем статус импорта…" (loading text) permanently, with no error state and no Retry. |
| `flows/canvas/NodeConfigPanel.tsx:89,163` | `eventNamesQuery`, `segmentsQuery` | Flow canvas internals -- explicitly plan 15-09's territory per this plan's own instruction not to touch the canvas. |
| `flows/detail/FlowLifecycleSettings.tsx:32` | `segmentsQuery` (exit-condition segment picker) | Not in this plan's files. Same row-enrichment class as above. |
| `flows/detail/QuietHoursCard.tsx:46` | `settingsQuery` (workspace-default quiet-hours preview) | Not in this plan's files. Read-only preview line; degrades to showing nothing rather than a wrong window. |
| `segments/SegmentBuilder.tsx:521,526` | `registryQuery`, `eventNamesQuery` | Not in this plan's files (Segments already received its OPS-17 treatment for list/detail in 15-05; the builder is a distinct sub-surface). Same row-enrichment class. |
| `segments/SegmentBuilder.tsx:541` | `previewQuery` (live segment-size count) | Not in this plan's files. Already has its own domain-specific `{degraded: true}` response for statement-timeout (D-08) -- a different, pre-existing honesty mechanism. A genuine network/`isError` failure on this query (distinct from the `degraded` flag) is not separately surfaced; out of this plan's scope. |
| `send-log/CampaignFlowFilter.tsx:34,39` | `campaignsQuery`, `flowsQuery` (filter combobox lookups) | Not in this plan's files. Embedded inside `SendLogPage` (converted in 15-05) but this sub-component's own two exhaustive-lookup queries were not; same row-enrichment class, degrades to an empty filter list. |
| `workspace-switcher/WorkspaceSwitcher.tsx:28` | `{ data: workspaces = [] }` | Global nav chrome, not in any phase-15 plan's files_modified found. Degrades to an empty switcher menu on failure. |
| `onboarding/OnboardingChecklist.tsx:71,77,83,92` | `sendgridQuery`, `membersQuery`, `contactsQuery`, `webhookHealthQuery` | Rendered on both `WorkspaceDashboard` and `WorkspaceHome` (both converted in this plan) but the checklist component itself is not in this plan's files. Each done-flag defaults to `false` on failure (fail-safe: an unmet checklist item, never a falsely-claimed "done"). |

Two of the above are genuine, user-visible defects rather than benign degrades -- flagged in `## Deviations from Plan` / broken-windows below rather than silently noted only in this table.

## Deviations from Plan

### Auto-fixed Issues

None this plan required no Rule 1-3 auto-fixes -- the shared components and branch-order pattern from 15-05 dropped in cleanly to every named surface.

### Design divergence (not a Rule 1-4 fix, a scoping call within the plan's own constraints)

**1. WorkspaceDashboard: one combined query, not independent per-widget queries**
- **Found during:** Task 2, reading `WorkspaceDashboard.tsx`
- **Plan assumption:** The plan's `read_first` and action text describe "each widget's own query" and instruct converting the dashboard as if trend chart, counters and mini-lists each had an independent fetch.
- **Reality:** `WorkspaceDashboard` has exactly one `useQuery` (`getWorkspaceDashboard`) whose single response feeds every widget on the page. There is no per-widget query to split, and this plan's own prohibitions forbid changing any query key, request URL or API contract (presentational-only).
- **Resolution:** Within that constraint, a failure renders as two region-scoped `QueryErrorState` cards (KPI/chart region, lists region) sharing the one query's error state, instead of one page-wide message -- and the header/period-selector/`OnboardingChecklist` above never disappear regardless of the query's state, so no early return ever replaces the whole page. This satisfies the acceptance criteria (`>=2` `QueryErrorState` instances, no page-wide early return) while staying honest about what the single-endpoint architecture actually allows.
- **Verification:** `grep -c QueryErrorState WorkspaceDashboard.tsx` -> 5; `grep -n "^\s*return"` shows only the component's own single top-level return, no early-return branches; build + scoped lint clean.
- **Committed in:** `fbaf03a` (Task 2 commit)

---

**Total deviations:** 0 Rule 1-3 auto-fixes; 1 documented scoping decision (dashboard's single-endpoint constraint), fully within the plan's own prohibitions.
**Impact on plan:** No scope creep. No query key, request URL or API contract changed in any of the 12 files (`git diff` vs HEAD for `queryKey` lines across all 12 files returns nothing).

## Issues Encountered

- **This worktree had no `node_modules` installed** (same situation `15-03-SUMMARY.md` and `15-05-SUMMARY.md` documented -- git worktrees don't share `node_modules`). `package-lock.json` was confirmed byte-identical between this worktree and the main checkout via `diff` before proceeding, so `node_modules` directories were symlinked in from the main checkout (root, `apps/{web,api,worker}`, `scripts`, and the `packages/*` needed to resolve types) purely to run `vitest`, `tsc`/`vite build`, and scoped `eslint`. All symlinks were removed and `git status --short` confirmed clean before each commit and before writing this SUMMARY.
- **Repo-wide `npm run lint` still fails** with the same pre-existing `@typescript-eslint` errors in `packages/queue-core/src/{dead-letter-writer.ts,error-listeners.ts,__tests__/error-listeners.test.ts}` and additional type-aware-rule noise in `apps/worker/src/{server.ts,test/harness/sigterm-load-entrypoint.ts}`, documented as pre-existing in `15-03-SUMMARY.md`/`15-05-SUMMARY.md` and entirely unrelated to this plan's `apps/web` changes (confirmed by matching file paths). Scoped `npx eslint` runs against every file this plan touched (all 12) are clean with zero errors/warnings. Not fixed (pre-existing, unrelated files, out of scope per the executor's scope-boundary rule) -- flagged here for the orchestrator's broken-windows ledger, same as 15-05.
- **Two genuinely misleading (not merely silent) gaps found during the Task 3 sweep, outside this plan's files_modified list:**
  - `LaunchScheduleDialogs.tsx`'s `LaunchConfirmDialog` (`breakdownQuery`): a failed audience-breakdown fetch silently omits the breakdown card, and the "Отправить" (Launch) button remains enabled -- an operator can confirm sending a campaign without ever seeing exclusions, with no visible indication anything failed to load.
  - `CsvImportWizard.tsx`'s `ApplyProgressAndReport`/`ImportReentryView` (`statusQuery`): `if (!status)` conflates "still loading" with "fetch failed" -- a failed poll or reentry fetch shows "Загружаем статус импорта…" permanently, with no error state and no Retry, indistinguishable from a slow-but-working request.
  - Neither file is in this plan's `files_modified`; both are recorded here and in the sweep table above rather than fixed, per scope discipline. Recommended as follow-up work items.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- OPS-17's inline (error/empty) half is now complete across every surface plan 15-05 and this plan named. The two genuinely-misleading gaps found during the sweep (`LaunchScheduleDialogs`, `CsvImportWizard`) are outside this plan's scope and are recommended follow-up items, not blockers.
- Plan 15-09 (flow canvas/unsaved-changes work) can proceed against `FlowDetailPage.tsx` without collision -- this plan touched only the flow-definition query's loading/error/not-found branches above the canvas, never the canvas's own internals (`FlowCanvas`, `NodeConfigPanel`) or its dirty-state/save handling.
- The manual live-verification item from this plan's own `<verification>` section (API stopped -> every converted region shows its error state with working Retry) was not performed in this worktree execution (no dev server/API running) -- flagged as `human_judgment: true` (D4), consistent with how this milestone has treated manual UI checks in prior phases (15-05's own D4).
- The `packages/queue-core`/`apps/worker` lint failures (pre-existing, unrelated to `apps/web`) remain open; flagged for the orchestrator/broken-windows ledger, not fixed here.

## Known Stubs

None. All converted regions are wired to real query data; no hardcoded empty values or placeholder copy was introduced.

## Threat Flags

None new. This plan closes T-15-19 (`SendGridKeySettings` rendering a failed status fetch as "no key configured" -- now mitigated via the isFullyErrored/isStaleErrored split, matching the plan's own threat register disposition), T-15-20 (`QueryErrorState` renders only fixed, curated titles/detail -- never a raw server error body, on every surface converted here) and T-15-21 (dashboard: per-region error states, no page-level early return). No new network endpoint, auth path, file-access pattern, or schema change at a trust boundary was introduced.

## Self-Check: PASSED

- All 12 modified files confirmed present on disk with the expected changes (verified via `git diff`/`grep` against each during execution).
- All 3 commit hashes (`039cd97`, `fbaf03a`, `503f523`) confirmed present in `git log --oneline`.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
