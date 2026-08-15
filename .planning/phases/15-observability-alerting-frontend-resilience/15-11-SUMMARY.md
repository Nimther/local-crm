---
phase: 15-observability-alerting-frontend-resilience
plan: 11
subsystem: observability
tags: [sentry, error-boundary, react, vite, docker, frontend]

requires:
  - phase: 15-06
    provides: sentryBeforeSend (packages/redaction) as a blocking CI-gated redaction hook, safe to point a live DSN at
  - phase: 15-10
    provides: the proceed-live-dsn checkpoint decision (governs this plan too, no re-ask) and the apps/api|worker/src/sentry.ts shape this plan mirrors
  - phase: 15-03
    provides: apps/web's data-router App.tsx with lazy routes and RouteSuspenseFallback, extended here with withSuspense wrapping each route in RouteErrorBoundary
provides:
  - apps/web/src/lib/sentry.ts -- Sentry SDK init for the web SPA, DSN-optional (build-time VITE_SENTRY_DSN), tracing/replay structurally absent, route/workspace-slug tagging via a global event processor
  - apps/web/src/components/RouteErrorBoundary.tsx -- wraps @sentry/react's own ErrorBoundary with a contained, QueryErrorState-sibling fallback panel; wraps every lazy route (App.tsx's withSuspense), never the /w/:slug shell itself
  - docker/Dockerfile.web's ARG VITE_SENTRY_DSN build-time pipeline + .github/workflows/images.yml's web-only build-arg wiring
  - @mega-crm/redaction as a new apps/web runtime dependency
affects: []

tech-stack:
  added: []
  patterns:
    - "Frontend Sentry correlation tags read the CURRENT window.location.pathname at capture time via Sentry.addEventProcessor (attachRouteTags), not a synced React-state variable -- there is no per-request AsyncLocalStorage in the browser, so the URL itself (parsed for /w/:slug via a pure tagsForPath function) is the one thing that is always current without threading state through components."
    - "Reset-on-navigation for a Sentry.ErrorBoundary that has no resetKeys support in the installed SDK version: key={location.pathname} on the boundary component, forcing an unmount/remount of the crashed instance on route change -- verified against @sentry/react@10.70.0's own shipped source before relying on it."
    - "Vite build-time secrets/non-secrets that must reach a static bundle with no server runtime: a Dockerfile ARG (declared INSIDE the build stage, after its own FROM -- not before, which would be Dockerfile global scope) exposed via ENV to the npm run build step, which Vite's default envPrefix picks up from process.env with no .env file needed."

key-files:
  created:
    - apps/web/src/lib/sentry.ts
    - apps/web/src/lib/__tests__/sentry.test.ts
    - apps/web/src/components/RouteErrorBoundary.tsx
  modified:
    - apps/web/src/main.tsx
    - apps/web/src/App.tsx
    - apps/web/package.json
    - package-lock.json
    - docker/Dockerfile.web
    - .github/workflows/images.yml
    - SPECIFICATION.md

key-decisions:
  - "Correlation tags on the frontend use window.location.pathname read at Sentry capture time (attachRouteTags/tagsForPath), not a React Router hook threaded into sentry.ts -- the event processor runs outside any component's render, with no router context to read from; the URL is the one value that is always current everywhere."
  - "Reset-on-navigation uses key={location.pathname} on the underlying Sentry.ErrorBoundary rather than the SDK's own resetKeys/resetOnPropsChange mechanism -- verified against the actual installed @sentry/react@10.70.0 source that neither prop exists in this version; a changed React key is the standard substitute (unmount the crashed instance, mount a fresh one)."
  - "buildSentryOptions is exported as a pure function separate from initSentry specifically so tests can assert on the built options object directly (source-independent), per the plan's own acceptance criteria wording."
  - "GitHub Actions build-arg for VITE_SENTRY_DSN is read from vars (repository variable), not secrets -- a Sentry DSN authorizes sending events, not reading them, so it does not belong in the same handling class as secrets.GITHUB_TOKEN."

requirements-completed: [OPS-08, OPS-17]

coverage:
  - id: D1
    description: "apps/web initializes @sentry/react with the shared sentryBeforeSend, tracing and Session Replay structurally absent (not just sampled to 0), a missing build-time DSN never blocks the build or throws at runtime, and events are tagged with the current route/workspace slug"
    requirement: "OPS-08"
    verification:
      - kind: unit
        ref: "apps/web/src/lib/__tests__/sentry.test.ts#with no DSN configured, does not throw and leaves the SDK uninitialized"
        status: pass
      - kind: unit
        ref: "apps/web/src/lib/__tests__/sentry.test.ts#the built options object contains no integration whose name matches replay or browser tracing, with both tracing and replay sample rates at 0"
        status: pass
      - kind: unit
        ref: "apps/web/src/lib/__tests__/sentry.test.ts#wires beforeSend/beforeSendTransaction to the shared sentryBeforeSend and scrubs a captured exception"
        status: pass
      - kind: unit
        ref: "apps/web/src/lib/__tests__/sentry.test.ts#tagsForPath (route/workspace tagging, pure function) -- both cases"
        status: pass
      - kind: other
        ref: "npm run build -w apps/web"
        status: pass
    human_judgment: false
  - id: D2
    description: "A route-level error boundary (Sentry.ErrorBoundary, not a hand-rolled class) wraps every lazy route, encloses Suspense rather than being enclosed by it, resets on navigation, and never wraps the /w/:slug shell itself -- so one failing route shows a contained recoverable panel while nav/workspace-switcher keep working"
    requirement: "OPS-17"
    verification:
      - kind: other
        ref: "grep -c 'class .* extends .*Component' apps/web/src/components/RouteErrorBoundary.tsx (returns 0)"
        status: pass
      - kind: other
        ref: "npm run build -w apps/web && npm run check:web-chunks"
        status: pass
      - kind: manual_procedural
        ref: "throwing inside a feature route shows the contained panel with the shell still rendered"
        status: unknown
    human_judgment: true
    rationale: "The plan's own <verification> block lists this as a manual check; no jsdom/happy-dom is installed in this repo (vitest config for apps/web runs in environment: \"node\"), and installing one is outside this plan's declared file scope and would itself require a package-legitimacy checkpoint. The design (Sentry's own well-tested ErrorBoundary, wrapping verified by source-level grep/App.tsx inspection, boundary-outside-Suspense ordering verified by reading App.tsx) gives high confidence, but an actual click-through was not run."
  - id: D3
    description: "The frontend DSN reaches the built bundle only through a Dockerfile build-arg (never docker/prod.env.example/MEGA_CRM_ENV_FILE), a missing value never fails the build, and the workflow supplies it for the web matrix entry only"
    requirement: "OPS-08"
    verification:
      - kind: other
        ref: "grep -c VITE_SENTRY_DSN docker/prod.env.example (returns 0)"
        status: pass
      - kind: other
        ref: "npm run check:spec-env-coverage"
        status: pass
      - kind: integration
        ref: "docker build -f docker/Dockerfile.web -t mega-crm-web:planverify . (no --build-arg, succeeds)"
        status: pass
      - kind: integration
        ref: "docker build -f docker/Dockerfile.web --build-arg VITE_SENTRY_DSN=<placeholder> ... ; grep confirmed the value is baked into the built bundle verbatim"
        status: pass
    human_judgment: false

duration: ~1h
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 11: Frontend Sentry SDK and Route Error Boundary Summary

**@sentry/react wired for errors-only capture (Session Replay/browser tracing structurally absent, not just sampled to 0) plus a route-level Sentry.ErrorBoundary that contains a failing route's render error while the app shell keeps working, both fed by a Dockerfile build-arg DSN pipeline that never blocks a build.**

## Performance

- **Duration:** ~1h
- **Completed:** 2026-08-15
- **Tasks:** 3/3 complete
- **Files modified:** 10 (3 created, 7 modified) across 3 commits

## Accomplishments

- `apps/web/src/lib/sentry.ts`: `initSentry()`/`buildSentryOptions()` mirror the backend SDKs' DSN-optional, `sentryBeforeSend`-wired shape, with the web-specific guarantee that Session Replay and browser performance tracing are structurally absent (never imported/added as integrations, plus both sample rates pinned to 0 as an independent second layer) rather than merely configured off (D-08, T-15-34) -- verified empirically against the real installed `@sentry/react@10.70.0` that neither "Replay" nor "BrowserTracing" appears in the SDK's own default integration set.
- Route/workspace correlation tags (`route`, `workspace_slug`) are attached via `Sentry.addEventProcessor` reading `window.location.pathname` at capture time (`attachRouteTags`/`tagsForPath`) -- no ALS equivalent exists in the browser, so the URL itself is the source of truth, parsed for the `/w/:slug/...` shape.
- `apps/web/src/components/RouteErrorBoundary.tsx`: wraps `@sentry/react`'s own `ErrorBoundary` (no hand-rolled `componentDidCatch` class) with a contained fallback panel styled as `QueryErrorState`'s sibling, offering Retry and a link back to the workspace home. Wired into `App.tsx`'s `withSuspense` helper so it encloses (not is enclosed by) the route's `Suspense` boundary -- a failed lazy chunk import surfaces in the panel instead of hanging on the skeleton. `AppShell`/the `/w/:slug` shell route stay unwrapped, so nav and the workspace switcher keep working when a child route fails.
- Discovered during Task 2: the pinned `@sentry/react@10.70.0` has no `resetKeys`/`resetOnPropsChange` support (verified against its own shipped source, not assumed from docs of a different version) -- used `key={location.pathname}` on the boundary component instead, the standard React substitute for forcing a crashed error-boundary instance to unmount/remount on navigation.
- `docker/Dockerfile.web`'s `build` stage declares `ARG VITE_SENTRY_DSN=""` (inside the stage, after its own `FROM`) and exposes it via `ENV` to the `npm run build -w apps/web` step; confirmed by a real `docker build --build-arg` run that the supplied value is baked verbatim into the built bundle, and by a real `docker build` with no `--build-arg` that a missing value still produces a working image.
- `.github/workflows/images.yml` passes `build-args: VITE_SENTRY_DSN=${{ vars.VITE_SENTRY_DSN }}` (a GitHub Actions repository *variable*, not a secret) for the `web` matrix entry only, in both `build-and-push` and `build-only`.
- Updated `SPECIFICATION.md` §2 (apps/web dependency table: `@sentry/react` now marked used; new `@mega-crm/redaction` runtime dependency), §3 (frontend DSN mechanism, now implemented) and §7 (frontend Sentry init + `RouteErrorBoundary` summary, replacing the forward-reference plan 15-10 left).

## Task Commits

Each task was committed atomically:

1. **Task 1: Initialize the web Sentry SDK — errors only** - `336da68` (feat)
2. **Task 2: Route-level error boundary with a contained fallback** - `7fefd9c` (feat)
3. **Task 3: Build-time DSN pipeline for the web image** - `558f8f2` (feat)

_No separate "plan metadata" commit -- `.planning/` is gitignored except `WINDOWS.md`; this SUMMARY.md is committed via `git add -f` per this run's explicit instructions._

## Files Created/Modified

- `apps/web/src/lib/sentry.ts` - Sentry init, options builder, route/workspace tag event processor
- `apps/web/src/lib/__tests__/sentry.test.ts` - mechanism tests (no-DSN no-op, tracing/replay absence, tag+scrub proof, pure tagsForPath cases)
- `apps/web/src/main.tsx` - calls `initSentry()` before the root render
- `apps/web/src/components/RouteErrorBoundary.tsx` - contained fallback wrapping `@sentry/react`'s `ErrorBoundary`
- `apps/web/src/App.tsx` - `withSuspense` now wraps each lazy route in `RouteErrorBoundary` enclosing `Suspense`
- `apps/web/package.json` - adds `@mega-crm/redaction` as a runtime dependency
- `package-lock.json` - regenerated under npm 10 (node:22-slim pin) after the dependency add
- `docker/Dockerfile.web` - `ARG VITE_SENTRY_DSN=""` + `ENV` passthrough into the Vite build step
- `.github/workflows/images.yml` - web-only `build-args: VITE_SENTRY_DSN` from `vars`, in both jobs
- `SPECIFICATION.md` - §2/§3/§7 updated for the frontend Sentry surface

## Decisions Made

- Correlation tags read `window.location.pathname` directly at capture time rather than threading a router-derived value into `sentry.ts` -- the event processor has no component render context to read from, and the URL is always current.
- `key={location.pathname}` substitutes for the SDK's absent `resetKeys` support, verified against the actually-installed version's source rather than assumed from general Sentry docs.
- `buildSentryOptions` is a separate, pure, exported function specifically so tests assert on the options object directly (matching the plan's own acceptance-criteria wording), without needing to inspect a live client's resolved state for the properties that don't require one.
- GitHub Actions `vars`, not `secrets`, for the DSN build-arg -- consistent with the "not a secret" framing recorded in SPECIFICATION.md §3 by plan 15-10 and reaffirmed here.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking issue] Regenerated package-lock.json under npm 10 after adding @mega-crm/redaction to apps/web**
- **Found during:** Task 1
- **Issue:** Adding `@mega-crm/redaction` to `apps/web/package.json` and running `npm install` under this environment's npm 11 produced a lockfile that satisfied npm 11 but desynced from npm 10 (the major `node:22-slim` actually bundles) -- confirmed by running `scripts/check-lockfile-npm10.mjs`, which failed with `npm ci --dry-run` reporting missing esbuild platform entries.
- **Fix:** Ran `npx --yes npm@10 install --package-lock-only --ignore-scripts` per the guard script's own printed remediation instructions, reducing the lockfile diff to the single additive line the dependency actually needed.
- **Files modified:** `package-lock.json`
- **Verification:** `node scripts/check-lockfile-npm10.mjs` passes; `git diff --stat package-lock.json` shows one line changed.
- **Committed in:** `336da68` (Task 1 commit)

**2. [Rule 1 - Bug] Two ESLint errors in RouteErrorBoundary.tsx's fallback component**
- **Found during:** Task 2
- **Issue:** `react-router`'s `navigate()` returns a Promise under this version (View Transitions API support), triggering `@typescript-eslint/no-misused-promises` when passed directly as an `onClick` handler; separately, destructuring `resetError` out of the Sentry `FallbackRender` param and passing it as a prop value tripped `@typescript-eslint/unbound-method` (the type's method-shorthand signature is flagged when extracted from its object without an immediate call).
- **Fix:** Wrapped the navigate call in a block-body arrow with `void navigate(...)`; replaced the destructured `resetError` reference with `errorData.resetError()` called through the parameter object directly, never extracted as a standalone reference.
- **Files modified:** `apps/web/src/components/RouteErrorBoundary.tsx`
- **Verification:** `npx eslint apps/web/src/components/RouteErrorBoundary.tsx` exits clean; full `npm run lint` (after building every workspace, per the fresh-worktree lint note) exits 0.
- **Committed in:** `7fefd9c` (Task 2 commit)

**3. [Rule 3 - Blocking issue] TypeScript errors reading browser-only Sentry options from a generically-typed client**
- **Found during:** Task 1 (test file, discovered by `npm run build -w apps/web`'s `tsc --noEmit` step)
- **Issue:** `Sentry.getClient()?.getOptions()` is typed over the generic `ClientOptions<BaseTransportOptions>`, which does not carry `replaysSessionSampleRate`/`replaysOnErrorSampleRate` (browser-specific fields); separately, `options.integrations` is typed as a union (`Integration[] | (fn)`), so `.map` on it does not type-check unmodified.
- **Fix:** Cast the retrieved options to `Sentry.BrowserOptions | undefined` for the replay-field assertions (a real client genuinely carries these fields at runtime); added an `Array.isArray` guard before mapping `integrations` to names.
- **Files modified:** `apps/web/src/lib/__tests__/sentry.test.ts`
- **Verification:** `npm run build -w apps/web` (`tsc --noEmit && vite build`) exits 0; test still asserts the real runtime values.
- **Committed in:** `336da68` (Task 1 commit)

---

**Total deviations:** 3 auto-fixed (1 Rule 1, 2 Rule 3)
**Impact on plan:** All within the plan's own declared file scope; no scope creep. The lockfile regeneration is the same recurrence this repo's own guard script exists to catch and remediate mechanically.

## Known Stubs

None -- both `apps/web/src/lib/sentry.ts` and `apps/web/src/components/RouteErrorBoundary.tsx` are fully wired: `initSentry()` is called from `main.tsx`, `RouteErrorBoundary` wraps every lazy route in `App.tsx`, and no placeholder/mock data path was introduced.

## Threat Flags

None beyond what the plan's own `<threat_model>` already registers (T-15-34/T-15-35/T-15-36/T-15-37/T-15-SC, all already dispositioned `mitigate`/`accept` in the plan itself) -- no new endpoint, auth path, or trust boundary was introduced by this plan's files.

## Issues Encountered

None blocking. The manual UAT item ("throwing inside a feature route shows the contained panel with the shell still rendered") was not run interactively -- see coverage entry D2's `rationale` above; the mechanism is verified at the source level (grep for the absence of a hand-rolled class, `App.tsx`'s wrapping order, a passing full build) but not click-tested in a real browser, since no DOM test environment (jsdom/happy-dom) is installed in this repo and installing one is outside this plan's declared scope.

## User Setup Required

**External service configuration remains the operator's responsibility, already flagged by plan 15-10.** Per the `proceed-live-dsn` checkpoint decision (made at plan 15-10, explicitly governs this plan too):

1. Create a third Sentry project in the **EU region**: `mega-crm-web`.
2. From its **Client Keys (DSN)** settings page, copy the DSN value.
3. Supply it as a GitHub Actions **repository variable** (`vars.VITE_SENTRY_DSN`, NOT a secret, NOT `MEGA_CRM_ENV_FILE`) — Settings → Secrets and variables → Actions → Variables.
4. On the next image build, `.github/workflows/images.yml` passes it as `docker/Dockerfile.web`'s `VITE_SENTRY_DSN` build-arg for the `web` matrix entry, baking it into the static bundle.
5. Verify: after the next `apps/web` deploy, trigger a render error in any feature route (or wait for a real one) and confirm an event tagged with `route`/`workspace_slug` appears in the `mega-crm-web` Sentry project (EU region), and that the route's own contained error panel rendered with the shell/nav still usable.

Until this variable is set, the web build succeeds normally with error tracking disabled (`initSentry()` logs the absence once via `console.info` and returns `false`) — the same no-op contract as both backend SDKs.

## Next Phase Readiness

- OPS-08's frontend half and OPS-17/D-11's boundary half are both functionally complete and tested: the web SDK captures exceptions with tracing/replay structurally absent, and one failing route no longer blanks the whole app.
- All three of D-06's Sentry projects (api/worker/web) now have their SDK initialization implemented; only operator DSN provisioning (a per-project, one-time manual step) remains before real events flow in each.
- The one open item is the manual click-through UAT for the error boundary's visual behavior (coverage D2) -- flagged with `human_judgment: true` rather than silently marked complete, since no DOM test environment exists in this repo to automate it.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
