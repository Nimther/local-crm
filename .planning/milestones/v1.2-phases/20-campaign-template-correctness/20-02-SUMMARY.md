---
phase: 20-campaign-template-correctness
plan: 02
subsystem: api
tags: [optimistic-locking, fastify, zod, postgres, tanstack-query]

# Dependency graph
requires:
  - phase: 20-campaign-template-correctness
    provides: "campaigns.version integer NOT NULL DEFAULT 1 column (migration 0066, plan 20-01)"
provides:
  - "launchCampaignSchema requires expectedVersion (int >= 1); no more empty-body launch action"
  - "CampaignStateError.code union gains version_conflict, with a third constructor param currentVersion"
  - "campaign.repository.ts's launchCampaign(id, { expectedVersion, resolvedFromEmail }) -- version compared and bumped inside the same locked transaction as the status flip and from_email persist"
  - "sender-resolver.ts's resolveCampaignSenderEmail -- read-only sender resolution, no write, used only by the launch route"
  - "toCampaignResponse publishes version; every CampaignStateError/CampaignSenderError HTTP body carries code"
  - "apps/web launchCampaign(slug, id, { expectedVersion }); LaunchScheduleDialogs.tsx's launchMutation echoes campaign.version"
affects: ["20-03"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "optimistic-lock check-then-bump inside a single SELECT...FOR UPDATE transaction, never a route-level pre-check"
    - "split resolve-then-persist for sender resolution: a read-only resolver used ahead of a lock, a persisting wrapper still used by not-yet-migrated routes"

key-files:
  created: []
  modified:
    - packages/shared-schemas/src/campaign.ts
    - apps/api/src/modules/campaigns/campaign.repository.ts
    - apps/api/src/modules/campaigns/sender-resolver.ts
    - apps/api/src/modules/campaigns/campaigns.routes.ts
    - apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts
    - apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts
    - apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts
    - apps/web/src/features/campaigns/api.ts
    - apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx
    - SPECIFICATION.md

key-decisions:
  - "Check order inside launchCampaign's locked transaction: not_found -> status -> version -> incomplete (per plan; status first so a concurrent launch/cancel reports the real state, version before completeness so a stale view never produces a misleading per-field error)"
  - "Sender resolution split in two: resolveCampaignSenderEmail (read-only, used by launch) and resolveCampaignFromEmail (persisting, still used by schedule/test-send until plan 20-03) -- the persisting variant now delegates to the read-only one before its own UPDATE"
  - "Rule 3 test-infra fix: consolidated the new launch-precondition describe block's owner()/sign-up calls from 8 down to 1 shared owner+workspace+segment (via beforeAll), since 8 more sign-ups in campaigns-routes.test.ts tripped the pre-existing 20/min /api/auth/* rate limit"

requirements-completed: [TMPL-02]

coverage:
  - id: D1
    description: "Launch requires expectedVersion (int >= 1); missing/malformed values are refused with 400 before the campaign row is touched"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > launch version precondition (TMPL-02, D-06/D-07) > rejects a launch body with no expectedVersion / rejects a malformed expectedVersion (%s)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Launch with the confirmed version succeeds, bumps version by exactly one, and enqueues a kickoff job"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > launch version precondition (TMPL-02, D-06/D-07) > launch with the current version succeeds, bumps version by exactly one, and enqueues a kickoff job"
        status: pass
    human_judgment: false
  - id: D3
    description: "A stale version returns 409 version_conflict with currentVersion, leaves status/version untouched, and enqueues no kickoff job"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > launch version precondition (TMPL-02, D-06/D-07) > a stale version is refused with 409 version_conflict, leaves the row untouched, and enqueues nothing"
        status: pass
    human_judgment: false
  - id: D4
    description: "Status is checked before version -- relaunching an already-sending campaign reports illegal_transition, not version_conflict"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > launch version precondition (TMPL-02, D-06/D-07) > status beats version: launching an already-sending campaign is 409 illegal_transition, not version_conflict"
        status: pass
    human_judgment: false
  - id: D5
    description: "RESEARCH Pitfall #1 regression: a fromSenderId-only campaign launches on its first attempt with the version from its own GET, bumping version exactly once"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts > launch resolves a fromSenderId-only campaign to its verified sender email and persists it"
        status: pass
    human_judgment: false
  - id: D6
    description: "updateCampaign increments version by exactly 1 per call; launchCampaign rejects a stale expectedVersion with the row's real currentVersion"
    requirement: "TMPL-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts > updateCampaign increments version by exactly 1 per call / launchCampaign called with a stale expectedVersion rejects with version_conflict and the row's real version"
        status: pass
    human_judgment: false
  - id: D7
    description: "Web launch action sends { expectedVersion: campaign.version }; launchCampaign's client signature no longer posts an empty body"
    requirement: "TMPL-02"
    verification:
      - kind: unit
        ref: "npm run build -w apps/web (TypeScript build proves the required third parameter is satisfied at every call site)"
        status: pass
    human_judgment: false

duration: ~45min
completed: 2026-08-21
status: complete
---

# Phase 20 Plan 02: Launch Optimistic-Lock Precondition Summary

**Launch now requires and checks `expectedVersion` inside the same locked transaction that flips status and persists the resolved sender — a stale/absent version 409s/400s with zero mail dispatched, and a `fromSenderId`-based launch succeeds on its first attempt (RESEARCH Pitfall #1 closed).**

## Performance

- **Duration:** ~45 min
- **Started:** ~2026-08-21T08:20:00Z (approx, from context load)
- **Completed:** 2026-08-21T09:05:00Z
- **Tasks:** 2 (Task 1 tracer/TDD: RED + GREEN commits; Task 2: single commit)
- **Files modified:** 10

## Accomplishments

- `launchCampaignSchema` (`@mega-crm/shared-schemas`) now requires `expectedVersion: z.number().int().min(1)` — the launch body is no longer `z.object({})`.
- `CampaignRow`/`CAMPAIGN_COLUMNS` gained `version`; `CampaignStateError` gained the `version_conflict` code and a `currentVersion?: number` third constructor parameter.
- `updateCampaign` bumps `version` on every write (D-05's "any write bumps" invariant, applied to the most frequent write in this phase's scope).
- `launchCampaign(id, { expectedVersion, resolvedFromEmail })`: inside the existing `SELECT ... FOR UPDATE` transaction, checks status → version → completeness (in that order), throws `version_conflict` with the row's real version on mismatch, and persists `status`/`from_email`/`version` in one `UPDATE` — one marketer click, one version bump, even on the `fromSenderId` sender path.
- `sender-resolver.ts` split into a new read-only `resolveCampaignSenderEmail` (used by launch) and the existing persisting `resolveCampaignFromEmail` (still used by schedule/test-send, now delegating to the read-only function before its own `UPDATE`) — closing RESEARCH Pitfall #1: a `fromSenderId`-based launch no longer self-triggers a spurious `version_conflict` via a write that happened ahead of the locked check.
- `campaigns.routes.ts`'s launch handler: parses `expectedVersion` before the workspace lookup (400 on failure, mirroring the schedule handler's shape), resolves the sender without persisting, and passes `{ expectedVersion, resolvedFromEmail }` into `launchCampaign`. `toCampaignResponse` now publishes `version`; `mapCampaignStateError`/`mapCampaignSenderError`/the launch handler's `incomplete` branch all carry `code` in every response body (RESEARCH Pitfall #2).
- `apps/web`'s `CampaignResponse` gained `version`; `launchCampaign(slug, id, { expectedVersion })` replaces the empty-body post; `LaunchScheduleDialogs.tsx`'s `launchMutation` echoes `campaign.version`.
- `SPECIFICATION.md` §6.5.1 documents the new contract (required body field, check order, 409 shape, the Pitfall #1 fix) in the same change that shipped it; §6.5's now-stale `campaigns.routes.ts` line references for launch/schedule/cancel/duplicate were refreshed to match the current file.

## Task Commits

Each task was committed atomically (Task 1 followed the RED/GREEN TDD cycle with two commits):

1. **Task 1 (RED): add failing launch version-precondition tests** - `97df7a2` (test)
2. **Task 1 (GREEN): launch requires and checks a locked optimistic-lock version** - `3167a32` (feat)
3. **Task 2: web launch action echoes the campaign's version; document contract in SPECIFICATION.md** - `45b753b` (feat)

**Plan metadata:** this commit (made after this SUMMARY)

## Files Created/Modified

- `packages/shared-schemas/src/campaign.ts` - `launchCampaignSchema` requires `expectedVersion`
- `apps/api/src/modules/campaigns/campaign.repository.ts` - `version` field/column, `version_conflict` code + `currentVersion`, `updateCampaign`'s bump, `launchCampaign`'s new signature and locked check order
- `apps/api/src/modules/campaigns/sender-resolver.ts` - new read-only `resolveCampaignSenderEmail`; `resolveCampaignFromEmail` delegates to it
- `apps/api/src/modules/campaigns/campaigns.routes.ts` - launch handler body parsing + sender/version wiring; `toCampaignResponse`, `mapCampaignStateError`, `mapCampaignSenderError` updated
- `apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts` - new `launch version precondition (TMPL-02, D-06/D-07)` describe (7 cases, 1 shared owner)
- `apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts` - updated `launchCampaign` call sites to the new signature; added version-bump and stale-version cases
- `apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts` - Pitfall #1 regression assertions on the existing fromSenderId-only launch case
- `apps/web/src/features/campaigns/api.ts` - `CampaignResponse.version`; `launchCampaign`'s required body param
- `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` - `launchMutation` echoes `campaign.version`
- `SPECIFICATION.md` - new §6.5.1; refreshed §6.5 line references

## Decisions Made

- **Check order inside `launchCampaign`'s lock:** not_found → status → version → incomplete, exactly as the plan's resolved research question specifies (status first so a concurrent transition reports the real state; version before completeness so a stale view never produces a misleading per-field error).
- **Sender resolution split, not replaced:** `resolveCampaignFromEmail` stays live (unchanged behavior) for schedule/test-send until plan 20-03 migrates them — removing it now would strip `from_email` persistence from those two paths mid-phase.
- **Rule 3 (auto-fix blocking issue) — test-infra:** the new describe block's 8 independent `owner()` sign-ups pushed this one file's total `/api/auth/*` traffic over the pre-existing 20-per-minute rate limit (`apps/api/src/modules/auth/plugin.ts`), causing three tests to fail with 429 instead of the assertions under test. Consolidated to one shared owner/workspace/segment via `beforeAll`, with each case still creating its own fresh campaign via the existing `createCampaignViaRoute` helper. Verified: full `campaigns` test run passed 44/44 afterward.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Consolidated new test-block sign-ups to stay under the auth rate limit**
- **Found during:** Task 1, GREEN verification run (`npm run test -w apps/api -- campaigns`)
- **Issue:** The new `launch version precondition` describe block called `owner()` (one HTTP sign-up each) 8 times in one test file; combined with the file's pre-existing ~15 sign-ups, this exceeded the `/api/auth/*` route's `max: 20` per-minute rate limit (`auth/plugin.ts`), causing the last 3 of the 8 new cases to fail with 429 instead of exercising the version-precondition logic under test.
- **Fix:** Refactored the describe block to create one shared owner/workspace/segment via `beforeAll`, with each `it` case still creating its own fresh campaign (`createCampaignViaRoute`) so test independence for campaign state is preserved.
- **Files modified:** `apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts`
- **Verification:** `npm run test -w apps/api -- campaigns` — 44/44 passed (7 files), no rate-limit failures.
- **Committed in:** `3167a32` (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (Rule 3, test-infrastructure).
**Impact on plan:** No scope creep — the fix only reduced redundant sign-up calls in tests this plan itself added; no production behavior changed.

## Issues Encountered

- **Environment (not a code deviation):** this worktree has no local `node_modules` (per project rule 7); bare-specifier imports for `@mega-crm/shared-schemas` (edited by this plan) and for `vite`/`@vitejs` (needed by `apps/web`'s build/test, which are installed only under `apps/web/node_modules` in the main checkout, not hoisted to the workspace root) resolved to the MAIN checkout's stale copies. Used temporary worktree-local symlink shims (`node_modules/@mega-crm/shared-schemas`, `apps/web/node_modules/vite`, `apps/web/node_modules/@vitejs`, and `node_modules/@playwright` for one unrelated pre-existing test) for verification only — all removed before finishing, confirmed by a clean `git status --short`.
- **Unrelated pre-existing test:** `apps/web/src/__tests__/playwright-package-source-import.test.ts` hardcodes a relative path to `<repo-root>/node_modules/@playwright/test/cli.js`; in this node_modules-less worktree that path doesn't resolve until shimmed (as above). Not caused by this plan's changes and not in its `<files>` list — documented here per the SCOPE BOUNDARY rule, not fixed as a production change.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `launchCampaign`'s final signature (`id, { expectedVersion, resolvedFromEmail }`), `resolveCampaignSenderEmail`'s signature (`workspaceId, campaign) => Promise<string>`), the error-body shape (`{ error, code, currentVersion? }` on every `CampaignStateError`/`CampaignSenderError` response), and the fact that `resolveCampaignFromEmail` is still live (persisting) for schedule/test-send are all in place for plan 20-03 to consume when it extends `expectedVersion` to those two routes and migrates them off the persisting resolver.
- No blockers. The worktree `node_modules`/rate-limit findings above are environment/test-infra specific and do not affect shipped code.

## Self-Check: PASSED

- `packages/shared-schemas/src/campaign.ts` — FOUND, contains `expectedVersion: z.number().int().min(1)`.
- `apps/api/src/modules/campaigns/campaign.repository.ts` — FOUND, contains `version_conflict` and exactly one `UPDATE` in `launchCampaign`.
- `apps/api/src/modules/campaigns/sender-resolver.ts` — FOUND, exports both `resolveCampaignSenderEmail` and `resolveCampaignFromEmail`; the read-only function's body contains no `withTenantTransaction` call.
- `apps/web/src/features/campaigns/api.ts` — FOUND, `CampaignResponse.version` and `launchCampaign`'s required body param present.
- `SPECIFICATION.md` — FOUND, §6.5.1 present with the documented contract.
- Commits `97df7a2`, `3167a32`, `45b753b` — all present in `git log --oneline`.
- `git status --short` — clean (all verification-only shims removed).

---
*Phase: 20-campaign-template-correctness*
*Completed: 2026-08-21*
