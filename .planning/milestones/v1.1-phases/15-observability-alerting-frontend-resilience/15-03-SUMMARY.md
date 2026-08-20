---
phase: 15-observability-alerting-frontend-resilience
plan: 03
subsystem: ui
tags: [react-router, vite, rolldown, code-splitting, xyflow, recharts, lazy-loading]

# Dependency graph
requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "plan 15-01's package legitimacy checkpoint (no new installs needed by this plan)"
provides:
  - "Data-router App.tsx (createBrowserRouter/createRoutesFromElements/RouterProvider) -- the hard prerequisite plan 15-09's useBlocker needs"
  - "Every feature/route page lazily loaded (React.lazy) behind a shared Suspense fallback"
  - "@xyflow/react and recharts pinned into their own named vendor chunks, CI-checked against the real build manifest"
affects: ["15-09 (useBlocker/unsaved-changes guard)", "15-11 (route error boundary)"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Data-router migration: createRoutesFromElements wrapping the exact prior <Route> JSX tree, passed to createBrowserRouter, rendered via RouterProvider -- zero route path/nesting change"
    - "Uniform React.lazy() for every feature/route page, wrapped via a withSuspense() helper using a single shared RouteSuspenseFallback (Card/Skeleton idiom)"
    - "Rolldown-native output.advancedChunks.groups (not Rollup's manualChunks object form) with includeDependenciesRecursively: false to pin a vendor chunk without dragging in shared transitive deps (react, react-dom)"

key-files:
  created:
    - apps/web/src/components/RouteSuspenseFallback.tsx
    - scripts/check-web-chunks.mjs
  modified:
    - apps/web/src/App.tsx
    - apps/web/vite.config.ts
    - package.json

key-decisions:
  - "Used Rolldown's advancedChunks (not the newer codeSplitting alias) to match this plan's own acceptance criteria wording; both are the same type in the installed rolldown@1.1.4 (codeSplitting is the current name, advancedChunks a documented-but-functional deprecated alias) -- the build emits one harmless deprecation warning as a result."
  - "Set includeDependenciesRecursively: false on the vendor chunk groups. Rolldown's default (true) pulls each matched module's OWN transitive dependencies into the same named chunk; since @xyflow/react and recharts both transitively depend on react/react-dom, the default made canvas-vendor/charts-vendor a STATIC import of literally every chunk in the app, including the entry -- confirmed empirically against the build manifest before the fix, and reverted after setting the flag to false."

requirements-completed: [OPS-16]

coverage:
  - id: D1
    description: "App.tsx migrated to a data router (createBrowserRouter/createRoutesFromElements/RouterProvider), route path/nesting/shape provably unchanged from HEAD"
    requirement: "OPS-16"
    verification:
      - kind: unit
        ref: "npx vitest run --root apps/web (9 files, 58 tests)"
        status: pass
      - kind: other
        ref: "diff of sorted path= values between HEAD and new App.tsx -- PATHS IDENTICAL"
        status: pass
    human_judgment: false
  - id: D2
    description: "All 25 feature/route pages lazily loaded via React.lazy, wrapped in a shared Suspense fallback (RouteSuspenseFallback)"
    requirement: "OPS-16"
    verification:
      - kind: other
        ref: "grep -c 'React.lazy\\|lazy(' apps/web/src/App.tsx -> 25 (>= 18 required)"
        status: pass
      - kind: unit
        ref: "npm run build -w apps/web (tsc --noEmit + vite build) exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "@xyflow/react (canvas) and recharts (dashboard charts) each pinned into their own vendor chunk, absent from the entry HTML's initial script/modulepreload tags"
    requirement: "OPS-16"
    verification:
      - kind: other
        ref: "node scripts/check-web-chunks.mjs against a real build manifest -- both boundaries OK"
        status: pass
      - kind: other
        ref: "manual manifest inspection: entry's `imports` array contains neither vendor chunk key; dist/index.html has no canvas-vendor/charts-vendor script or modulepreload tag"
        status: pass
    human_judgment: false
  - id: D4
    description: "check:web-chunks fails closed: exits non-zero with no build present, and exits non-zero when the vendor group config is removed (then restored)"
    requirement: "OPS-16"
    verification:
      - kind: other
        ref: "node scripts/check-web-chunks.mjs with dist/ removed -> exit 1, explicit 'run npm run build -w apps/web first' message"
        status: pass
      - kind: other
        ref: "advancedChunks groups temporarily removed from vite.config.ts, rebuilt, node scripts/check-web-chunks.mjs -> exit 1 naming both missing boundaries; config restored and re-verified green"
        status: pass
    human_judgment: false
  - id: D5
    description: "A chunk that fails to load (network error during a lazy import) surfaces as an error rather than a blank route (backstop truth)"
    requirement: "OPS-16"
    verification: []
    human_judgment: true
    rationale: "This plan's own must_haves.truths marks this a `backstop` verification -- actually closed by plan 15-11's route error boundary, not by this plan's Suspense-only wiring. No route error boundary exists yet in this plan's scope to catch a rejected dynamic import."

# Metrics
duration: 55min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 03: Route Code Splitting & Data Router Migration Summary

**Data-router App.tsx (createBrowserRouter) with all 25 feature routes behind React.lazy + shared Suspense fallback, and @xyflow/react/recharts pinned into CI-checked vendor chunks via Rolldown's advancedChunks.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-08-15T10:41:00Z
- **Completed:** 2026-08-15T10:43:30Z
- **Tasks:** 2
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments
- Migrated `apps/web/src/App.tsx` from `<BrowserRouter><Routes>` to `createBrowserRouter(createRoutesFromElements(...))` + `<RouterProvider>` -- the exact route tree, paths, and nesting are unchanged (verified via a diff of every `path=` value against `git show HEAD:apps/web/src/App.tsx`). This is the hard prerequisite plan 15-09's `useBlocker` needs (RESEARCH.md Pitfall 1) and D-14's own OPS-16 splitting requirement.
- All 25 feature/route page imports converted to `React.lazy()`, uniformly (no per-route eager/lazy judgement calls, per D-14), each wrapped in a shared `<Suspense fallback={<RouteSuspenseFallback />}>` boundary. `RootRedirect`, `AppShell`, and the `queryClient`/`useSession`/`apiGet` imports stay eager (shell, not feature code).
- New `apps/web/src/components/RouteSuspenseFallback.tsx`: a presentational Card/Skeleton composition (matching the idiom already used by `ContactsListPage`'s own loading state) so an in-flight route looks like the page it is becoming, not a blank screen.
- `apps/web/vite.config.ts` gained a `build` block: `manifest: true` (machine-readable chunk graph) plus Rolldown-native `output.advancedChunks.groups` pinning `@xyflow/react` into a `canvas-vendor` chunk and `recharts` into a `charts-vendor` chunk, both with `includeDependenciesRecursively: false`.
- New `scripts/check-web-chunks.mjs` (root `check:web-chunks` script): reads the real build manifest, asserts each vendor chunk exists as a distinct, non-entry chunk containing a content marker unique to its package, and asserts neither vendor chunk is in the entry chunk's own initial `imports` set. Fails loudly (explicit remediation message) if the manifest is absent rather than passing vacuously.

## Task Commits

Each task was committed atomically:

1. **Task 1: Migrate App.tsx to a data router with lazily-loaded feature routes** - `da3715e` (feat)
2. **Task 2: Pin the heavy vendor chunks and assert the boundary in CI** - `0b69590` (feat)

_No TDD tasks in this plan; no separate plan-metadata commit (per worktree instructions, STATE.md/ROADMAP.md are not touched by this agent)._

## Files Created/Modified
- `apps/web/src/App.tsx` - Data-router migration + 25 `React.lazy()` route imports, `withSuspense()` helper wrapping each lazy element
- `apps/web/src/components/RouteSuspenseFallback.tsx` (new) - Shared Card/Skeleton Suspense fallback for in-flight routes
- `apps/web/vite.config.ts` - `build.manifest: true` + Rolldown `advancedChunks.groups` pinning `@xyflow/react`/`recharts`
- `scripts/check-web-chunks.mjs` (new) - CI gate asserting the vendor chunk boundary against the real build manifest
- `package.json` - New root `check:web-chunks` script

## Decisions Made
- **Used `advancedChunks` (not `codeSplitting`) despite the deprecation warning.** The installed `rolldown@1.1.4` documents `codeSplitting` as the current name and `advancedChunks` as a functionally-identical deprecated alias (`AdvancedChunksOptions = CodeSplittingOptions`). This plan's own acceptance criteria text explicitly names `advancedChunks`, so that form was kept, with a code comment explaining the one harmless build-time deprecation warning this produces. A future plan can rename to `codeSplitting` with no behavior change.
- **`includeDependenciesRecursively: false` was required, not optional.** RESEARCH.md's Pattern 5 example did not set this flag. Rolldown's default (`true`) pulls each matched module's *own transitive dependencies* into the same named vendor chunk. Since `@xyflow/react` and `recharts` both depend on `react`/`react-dom` (used by literally every route), the default made `canvas-vendor`/`charts-vendor` a **static** dependency of every single chunk in the app -- including the entry chunk itself, which is the exact failure this plan's own must-have truth ("neither is referenced by the entry HTML's initial script tags") forbids. This was caught empirically by inspecting the build manifest's `imports` graph (every chunk, including `index.html`'s entry record, listed `canvas-vendor` as a static import) before the fix, and confirmed absent after setting the flag to `false` and re-inspecting both the manifest and `dist/index.html`'s actual `<script>`/`<link rel="modulepreload">` tags.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `includeDependenciesRecursively` defaulting to `true` made the vendor chunks eager, not lazy**
- **Found during:** Task 2, verifying the "neither is referenced by the entry HTML's initial script tags" must-have truth
- **Issue:** RESEARCH.md's Pattern 5 example (`output.advancedChunks.groups` with only `name`/`test`) does not set `includeDependenciesRecursively`. Rolldown's default (`true`) recursively pulls each matched module's transitive dependencies into the same chunk group. Because `@xyflow/react`/`recharts` both transitively import `react`, and `react` is used by every route, the resulting `canvas-vendor`/`charts-vendor` chunks became a static dependency of every other chunk -- including the entry itself (confirmed: `dist/index.html`'s initial `<script>`/`modulepreload` tags included the vendor chunk before the fix).
- **Fix:** Added `includeDependenciesRecursively: false` to the `advancedChunks` config, restricting each group to only the modules whose id directly matches the `test` regex.
- **Files modified:** `apps/web/vite.config.ts`
- **Verification:** Rebuilt; `dist/index.html` no longer references `canvas-vendor`/`charts-vendor`; manifest's entry `imports` array no longer lists either vendor chunk key; `node scripts/check-web-chunks.mjs` passes; `WorkspaceDashboard`/`FlowDetailPage` chunks are the sole `imports` consumers of their respective vendor chunks.
- **Committed in:** `0b69590` (part of Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug in the research's own worked example, corrected before it could ship as a silent eager-load regression)
**Impact on plan:** The fix is essential to the plan's own stated must-have truth (vendor chunks absent from the entry's initial script tags). No scope creep -- confined to the same `advancedChunks` config block Task 2 already owns.

## Issues Encountered
- **`npm run lint` (repo-wide) fails with 19 pre-existing `@typescript-eslint` errors in `packages/queue-core/src/{dead-letter-writer.ts,error-listeners.ts,__tests__/error-listeners.test.ts}`**, dating to phase 12's `refactor(12-10)` commit (`e0dfcb7`), entirely unrelated to this plan's `apps/web`/`scripts` changes. Confirmed out of scope per the executor's scope-boundary rule: `npx eslint apps/web/src/App.tsx apps/web/src/components/RouteSuspenseFallback.tsx apps/web/vite.config.ts scripts/check-web-chunks.mjs` lints clean with zero errors/warnings. Not fixed (pre-existing, unrelated files) -- flagged here for the orchestrator's broken-windows ledger rather than fixed inline.
- **This worktree had no `node_modules` installed** (git worktrees don't share `node_modules`, and this repo's lockfile/install is large). Since `package-lock.json` was byte-identical between this worktree and the main checkout (both at the same base commit, main checkout clean), `node_modules` directories were symlinked in from the main checkout (root + `apps/{web,api,worker}` + `scripts`) purely to run `npm run build -w apps/web`, `vitest`, and `eslint` for verification -- all symlinks were removed before this commit, and `git status` was confirmed clean before writing this summary. No symlink or `node_modules` content was ever staged or committed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 15-09 (unsaved canvas changes / `useBlocker`) can now proceed -- the data-router migration it depends on is in place and verified (`RouterProvider` renders, all existing tests pass, route paths unchanged).
- Plan 15-11 (route error boundary) should wrap the lazy route elements (or a level above `RouterProvider`) to close the one `backstop` truth this plan leaves open: a failed dynamic `import()` (network error mid-chunk-fetch) currently has no error boundary and will surface as an unhandled promise rejection/blank route rather than a contained, retryable panel.
- The `packages/queue-core` lint failures (pre-existing, phase 12) remain open and unrelated to this phase's own verification gate; flagged for the orchestrator/broken-windows ledger, not fixed here.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
