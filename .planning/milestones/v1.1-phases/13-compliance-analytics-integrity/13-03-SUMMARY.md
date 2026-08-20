---
phase: 13-compliance-analytics-integrity
plan: 03
subsystem: analytics
tags: [campaigns, send-log, delivery-core, tanstack-query, react-router, vitest]

# Dependency graph
requires:
  - phase: 11-delivery-correctness
    provides: SEND_STATUSES six-value vocabulary (packages/delivery-core), reconciling/unknown send statuses in the DB enum, send-log's SEND_LOG_STATUS_VALUES already including reconciling/unknown (11-10)
provides:
  - CampaignProgress.ledger (apps/api) widened to Record<SendStatus, number> over all six statuses, built from the shared vocabulary instead of a hard-coded allow-list
  - CampaignProgress.ledger (apps/web, committed copy) mirroring the six-key shape
  - CampaignProgress.tsx renders a combined "Исход неизвестен: N" stat for reconciling+unknown sends, distinct from sent/failed, hidden when both are zero
  - send-log status vocabulary drift test strengthened from Set-membership to array-equality (order-sensitive)
affects: [13-compliance-analytics-integrity later plans touching campaign progress or send-log status rendering]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure server-side JSX render for component tests: react-dom/server's renderToStaticMarkup + a seeded TanStack Query cache + react-router's MemoryRouter, run under vitest's existing environment:\"node\" lane -- no jsdom/@testing-library/react needed for presentational assertions on rendered text."

key-files:
  created:
    - apps/api/src/modules/campaigns/__tests__/campaign-progress-ambiguous.test.ts
    - apps/web/src/features/campaigns/__tests__/campaign-progress-ambiguous.test.tsx
  modified:
    - apps/api/src/modules/campaigns/campaign.repository.ts
    - apps/web/src/features/campaigns/api.ts
    - apps/web/src/features/campaigns/CampaignProgress.tsx
    - apps/web/src/features/send-log/__tests__/send-log-status-vocabulary.test.ts

key-decisions:
  - "CampaignProgress.ledger's four-key allow-list initializer replaced with Record<SendStatus, number> built from packages/delivery-core's SEND_STATUSES, so a future seventh status becomes a compile-time error instead of a silent zero (T-13-03-01)."
  - "reconciling and unknown are reported as ONE combined 'Исход неизвестен: N' stat in the UI (not two separate rows), matching the plan action text's 'render them as their own small stat' (singular) and the hide-when-both-zero condition."
  - "No new test dependencies added (@testing-library/react, jsdom) per the plan's threat model (T-13-03-SC, zero new dependencies). CampaignProgress.tsx's four rendering behaviors are proven via react-dom/server's renderToStaticMarkup against a TanStack-Query-seeded cache, wrapped in react-router's MemoryRouter (needed because the nested CampaignMetricsSummary renders a <Link>) -- all three are pre-existing apps/web dependencies."
  - "Send-log half of D-16 (CONTEXT's 'campaign cards and send-log stats') is confirmation, not construction: reconciling/unknown have been in the closed status vocabulary and filterable since Phase 11 plan 11-10. Task 3 only strengthens the drift test (Set membership -> array equality, so a reordered committed copy now fails) -- no new UI or filter logic was built."

patterns-established:
  - "Pattern: 'Record<Vocabulary, number> built from a shared const array' for any future ledger/aggregate initializer that must not silently drop a new enum value -- replaces the earlier per-field allow-list pattern in campaign.repository.ts."

requirements-completed: [CMP-02]

coverage:
  - id: D1
    description: "getCampaignProgress ledger reports reconciling and unknown as their own named counts; the six ledger values always sum to the campaign's total sends rows."
    requirement: "CMP-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-progress-ambiguous.test.ts#reports reconciling and unknown as their own named counts, summing to the total sends"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-progress-ambiguous.test.ts#returns reconciling: 0 and unknown: 0 rather than omitting the keys when there are no ambiguous sends"
        status: pass
    human_judgment: false
  - id: D2
    description: "CampaignProgress.tsx renders a distinct 'Исход неизвестен: N' stat for ambiguous sends, never confusable with the failed stat, hidden when zero."
    requirement: "CMP-02"
    verification:
      - kind: unit
        ref: "apps/web/src/features/campaigns/__tests__/campaign-progress-ambiguous.test.tsx#renders the unknown count under a label distinct from sent and failed"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/campaigns/__tests__/campaign-progress-ambiguous.test.tsx#renders the reconciling count under the same ambiguous label"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/campaigns/__tests__/campaign-progress-ambiguous.test.tsx#renders no ambiguous stat row when both counts are zero"
        status: pass
      - kind: unit
        ref: "apps/web/src/features/campaigns/__tests__/campaign-progress-ambiguous.test.tsx#renders identical sent and failed stats with and without ambiguous counts present"
        status: pass
    human_judgment: true
    rationale: "The plan's Task 2 <verify> block includes an explicit <human-check>: opening a live campaign detail page for a campaign with an unknown-status send and visually confirming the label reads as 'outcome unknown', distinct from both sent and failed, with no color implying success or failure. This is a visual/UX judgment the automated string assertions above cannot fully substitute for."
  - id: D3
    description: "send-log status vocabulary drift test asserts order as well as membership; filtering by status=unknown against seeded data returns only unknown rows (pre-existing coverage from Phase 11 plan 11-10, confirmed still passing)."
    requirement: "CMP-02"
    verification:
      - kind: unit
        ref: "apps/web/src/features/send-log/__tests__/send-log-status-vocabulary.test.ts#the web vocabulary has exactly the same order as the API's SEND_LOG_STATUSES"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/send-log/__tests__/send-log-filters.test.ts#11-10 (DLV-02/DLV-07): renders and filters reconciling/unknown"
        status: pass
    human_judgment: false

# Metrics
duration: 20min
completed: 2026-08-11
status: complete
---

# Phase 13 Plan 03: Ambiguous Send Counts in Campaign Progress Summary

**Widened `getCampaignProgress`'s ledger from a four-key allow-list to a six-key `Record<SendStatus, number>` sourced from the shared vocabulary, rendered `reconciling`/`unknown` as a distinct "Исход неизвестен: N" stat in the campaign progress UI, and confirmed the send-log's pre-existing `unknown` filter/vocabulary is still order-consistent between apps/api and apps/web.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-08-11T22:50:00+05:00 (approx.)
- **Completed:** 2026-08-11T23:06:05+05:00
- **Tasks:** 3 completed
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `CampaignProgress.ledger` (apps/api) can no longer silently drop a send status: the four-key allow-list (`sent`/`failed`/`excluded`/`dispatching`) is replaced with a `Record<SendStatus, number>` initialized from `packages/delivery-core`'s six-value `SEND_STATUSES`, so `reconciling`/`unknown` sends get their own count and the ledger provably sums to the campaign's total `sends` rows.
- `CampaignProgress.tsx` renders `reconciling + unknown` as a single "Исход неизвестен: N" line, positioned next to the existing `N отправлено`/`N ошибок` lines, worded to convey "outcome not yet known" rather than a failure, and hidden entirely when both counts are zero.
- Closed D-16 (deferred by Phase 11 D-13) for the campaign-card half of CMP-02, while confirming `workspace_daily_rollup`'s exclusion of `reconciling`/`unknown` (Phase 11 D-13) is untouched — no rollup write path was modified.
- Confirmed the send-log half of D-16 was already shipped in Phase 11 plan 11-10 (closed status vocabulary including `reconciling`/`unknown`, working `status=unknown` filter) and strengthened its drift guard from Set-membership to array-equality so a future reordering of the committed API-vocabulary copy fails the test.

## Task Commits

Each task was committed atomically (RED/GREEN pairs for the two `tdd="true"` tasks):

1. **Task 1: Surface ambiguous send counts in the campaign progress payload**
   - `a521f28` (test) — failing tests for the six-key ledger and the sums-to-total assertion
   - `94be5fc` (feat) — `Record<SendStatus, number>` ledger built from `SEND_STATUSES`
2. **Task 2: Render the ambiguous count in campaign progress UI**
   - `66caff8` (test) — failing tests rendering `CampaignProgress` via `renderToStaticMarkup` + seeded `QueryClient` + `MemoryRouter`
   - `514d454` (feat) — widened client-side `CampaignProgress.ledger` type + the "Исход неизвестен: N" stat row
3. **Task 3: Re-assert the send-log status vocabulary drift guard**
   - `5a56c0c` (test) — order assertion added to the drift test; confirmed the existing `status=unknown` filter test (11-10) already covers the required behavioral assertion

**Plan metadata:** this commit (SUMMARY.md, committed in worktree mode per the parallel-execution instructions; STATE.md/ROADMAP.md updates deferred to the orchestrator).

## Files Created/Modified

- `apps/api/src/modules/campaigns/campaign.repository.ts` — `CampaignProgress.ledger` widened to `Record<SendStatus, number>`; `getCampaignProgress`'s ledger-building loop now accepts against a `Set` built from `SEND_STATUSES` instead of restating the four literals.
- `apps/api/src/modules/campaigns/__tests__/campaign-progress-ambiguous.test.ts` — new: seeds a campaign with sent/failed/reconciling/unknown sends and asserts the exact six-key ledger plus the sums-to-total invariant.
- `apps/web/src/features/campaigns/api.ts` — client-side `CampaignProgress.ledger` type widened to mirror the API's six-key shape (committed copy, no package dependency between apps/web and apps/api).
- `apps/web/src/features/campaigns/CampaignProgress.tsx` — reads `ledger.reconciling`/`ledger.unknown`, renders their sum as "Исход неизвестен: N", hidden when zero.
- `apps/web/src/features/campaigns/__tests__/campaign-progress-ambiguous.test.tsx` — new: renders the real component via `react-dom/server`'s `renderToStaticMarkup` against a seeded `QueryClient` cache (wrapped in `MemoryRouter`) and asserts on the rendered HTML string for all four plan behaviors.
- `apps/web/src/features/send-log/__tests__/send-log-status-vocabulary.test.ts` — added an order-sensitive array-equality assertion alongside the existing Set-membership check.

## Decisions Made

- **Single combined ambiguous stat, not two separate rows.** The plan's action text says "render them as their own small stat" (singular) and conditions visibility on "both counts are zero" — implemented as one `reconciling + unknown` sum under one label, matching both the wording and the four listed behaviors (each of which is satisfiable by a summed value when the other count is 0).
- **Chosen UI copy: "Исход неизвестен: N"** ("outcome unknown: N"). Chosen over failure-adjacent phrasing (`ошибка`, `не доставлено`) or success-adjacent phrasing (`отправлено`, `доставлено`) specifically because the plan calls out the exact misreading risk: an ambiguous send has not failed, and a marketer reading it as a failure is the defect this plan closes. Verified in code review that neither `SEND_STATUS_LABELS` (send-log) nor this new UI string uses failure/success-implying words for `reconciling`/`unknown`, consistent with the existing DLV-07 honesty assertion in `send-log-status-vocabulary.test.ts`.
- **No new test dependencies.** The plan's threat model (T-13-03-SC) commits to zero new dependencies, and this repo has no `@testing-library/react`/jsdom harness for any `.tsx` component today (the one existing web-feature test extracts a pure function and tests it directly, per `campaign-metrics.test.ts`). Rather than either (a) adding a new dependency, which would trip the package-install checkpoint gate, or (b) under-testing by only testing an extracted pure function (which would not satisfy "Rendering `CampaignProgress` with `ledger.unknown = 3` displays the value 3" literally), Task 2's test renders the actual component via `react-dom/server`'s `renderToStaticMarkup` against a `TanStack Query` cache pre-seeded with `queryClient.setQueryData(...)`, wrapped in `react-router`'s `MemoryRouter` (required because the nested `CampaignMetricsSummary` renders a `<Link>`). All three packages are pre-existing `apps/web` dependencies; nothing was installed. TanStack Query returns cache-seeded data synchronously on first render (the same mechanism underlying its SSR/hydration support), so no `act()` wrapper or network mock was needed. This pattern is new to this repo's test suite; recorded under `patterns-established` above for future presentational-component tests to reuse instead of reaching for jsdom.
- **Task 3 treated as confirmation, not construction**, per the plan's own framing: `reconciling`/`unknown` have been part of `SEND_LOG_STATUS_VALUES` and filterable since Phase 11 plan 11-10 (`send-log-filters.test.ts`'s existing "11-10 (DLV-02/DLV-07)" test already asserts `status=unknown` returns only `unknown` rows — verified still passing, no new assertion added for that behavior). The only new work was strengthening the drift test's comparison from `Set` (membership-only) to array `toEqual` (membership + order).

## Deviations from Plan

None (Rule 1-3 auto-fixes) — plan executed as written for all three tasks' `<action>` content. One environment-setup step outside the plan's own scope is recorded under Issues Encountered below (worktree had no installed `node_modules`, resolved with `npm install --prefer-offline`, no lockfile changes resulted).

## Issues Encountered

- **Worktree had no installed `node_modules` at session start.** `apps/api`'s tsc build succeeded via ancestor-directory module resolution (the worktree is nested under the main checkout, so root-level hoisted packages resolved), but `apps/web`'s `tsc --noEmit` failed with `Cannot find type definition file for 'vite/client'` because `apps/web`'s own `node_modules` (containing `vite`) lives only in the main checkout's `apps/web/node_modules`, a sibling directory not reachable via ancestor lookup from the worktree. Resolved with `npm install --prefer-offline` in the worktree root (10s, used the local npm cache, no network fetch needed) — same fix and rationale as Phase 12 plans 12-01/12-03/12-10. Confirmed no `package-lock.json` churn (`git status --short` showed no lockfile diff after install).
- No other issues. All three tasks' RED tests were confirmed to genuinely fail against the pre-task code before the corresponding GREEN commit (verified by temporarily restoring each file to its `HEAD` version, running the new test, observing the expected failure, then re-applying the implementation edit).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CMP-02's D-16 half (campaign-card ambiguous counts) is closed for both apps/api and apps/web; the daily-rollup exclusion from Phase 11 D-13 is unchanged and untouched by this plan.
- The `react-dom/server` + seeded `TanStack Query` cache + `MemoryRouter` test pattern established in `campaign-progress-ambiguous.test.tsx` is available for any future apps/web component test needing to assert on rendered output without adding `@testing-library/react`/jsdom.
- Manual/visual verification of the "Исход неизвестен" label on a live campaign detail page (Task 2's `<human-check>`) has not been performed in this session (worktree executor has no browser access) — flagged as `human_judgment: true` (D2) in this SUMMARY's coverage block for the verifier/UAT pass to pick up.
- No blockers for later Phase 13 plans.

---
*Phase: 13-compliance-analytics-integrity*
*Completed: 2026-08-11*
