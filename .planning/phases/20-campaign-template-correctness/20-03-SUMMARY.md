---
phase: 20-campaign-template-correctness
plan: 03
subsystem: api
tags: [optimistic-locking, fastify, zod, postgres, bullmq, tanstack-query]

# Dependency graph
requires:
  - phase: 20-campaign-template-correctness
    provides: "launchCampaign's locked expectedVersion precondition shape, CampaignStateError.version_conflict, resolveCampaignSenderEmail (read-only sender resolution), toCampaignResponse's version field (plan 20-02)"
provides:
  - "scheduleCampaign(id, { scheduledAt, expectedVersion, resolvedFromEmail }) -- version compared and bumped inside the same locked transaction as the status flip and from_email persist, mirroring launchCampaign"
  - "cancelCampaign bumps campaigns.version in both branches (scheduled->draft, sending->canceled); takes no expectedVersion (D-06 does not list cancel)"
  - "prepareCampaignTestSend(id, { expectedVersion, resolvedFromEmail }) -- the locked version check for test-send: not_found -> version_conflict -> incomplete, no status check (test-send is not a state transition)"
  - "emailBroadcastJobSchema gains optional templateId/fromEmail (additive, no schemaVersion bump) -- populated only for kind='test', captured from the version-checked row at enqueue time"
  - "sender-resolver.ts exports exactly CampaignSenderError, CampaignSenderInput, resolveCampaignSenderEmail -- the persisting resolveCampaignFromEmail is retired"
  - "apps/web: scheduleCampaign/testSendCampaign both echo expectedVersion: campaign.version; TestSendPanel invalidates the campaign detail query on a successful test-send"
affects: ["20-04", "20-05", "20-06"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "optimistic-lock check-then-bump inside a single SELECT...FOR UPDATE transaction, applied uniformly to launch/schedule/test-send"
    - "job-payload snapshot: values verified under a lock are captured into the enqueued job payload rather than re-read at dispatch time, closing an enqueue-to-dispatch TOCTOU gap"
    - "conditional persist (WHERE col IS DISTINCT FROM $n) so a no-op write never fires the any-write-bumps invariant"

key-files:
  created: []
  modified:
    - packages/shared-schemas/src/campaign.ts
    - packages/shared-schemas/src/queues.ts
    - apps/api/src/modules/campaigns/campaign.repository.ts
    - apps/api/src/modules/campaigns/sender-resolver.ts
    - apps/api/src/modules/campaigns/campaigns.routes.ts
    - apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts
    - apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts
    - apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts
    - apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx
    - apps/web/src/features/campaigns/TestSendPanel.tsx
    - SPECIFICATION.md

key-decisions:
  - "scheduleCampaign's check order: not_found -> status (illegal_transition) -> version (version_conflict), with NO completeness check -- scheduling an incomplete draft is existing, deliberate behaviour; the launch that eventually fires the scheduled campaign is what enforces completeness."
  - "prepareCampaignTestSend deliberately never checks or changes status -- a test send is not a state transition and is legal in any status today; this plan does not narrow that."
  - "prepareCampaignTestSend's from_email persist is CONDITIONAL (WHERE from_email IS DISTINCT FROM $3) so a no-op resolution never bumps the version and never invalidates the client's cache for nothing; kept at all (not dropped) for rolling-deploy fallback (an old worker reads campaigns.from_email directly) and for UI-semantics parity with launchIncompleteFields/computeIncompleteReason."
  - "emailBroadcastJobSchema's new templateId/fromEmail fields are optional/additive with no schemaVersion bump, following the requestId precedent (Phase 15) -- a schemaVersion bump would make an old worker DEFER an already-enqueued test send during a rolling deploy, which for a queued send means silently dropping it rather than safely retrying later."
  - "resolveCampaignFromEmail (the persisting sender-resolution variant) is deleted now that schedule and test-send are both migrated to the read-only resolveCampaignSenderEmail -- sender resolution has exactly one implementation and it performs no campaign write of its own."
  - "Rule 1 auto-fix: apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts's two pre-existing test-send assertions posted an empty body; testSendCampaignSchema now requires expectedVersion, so both were updated to payload: { expectedVersion: 1 } -- a bug directly caused by this task's schema change, not scope creep."

requirements-completed: [TMPL-02, TMPL-03]

coverage:
  - id: D1
    description: "Schedule with the current expectedVersion succeeds, bumps version by exactly one, and transitions draft -> scheduled"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > schedule version precondition (TMPL-02, D-06/D-07) > schedule with the current version succeeds and bumps version by exactly one"
        status: pass
    human_judgment: false
  - id: D2
    description: "A stale expectedVersion on schedule is refused with 409 version_conflict, leaves status draft and scheduledAt null, and enqueues nothing for a future send"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > schedule version precondition (TMPL-02, D-06/D-07) > a stale version is refused with 409 version_conflict, leaves the row draft/unscheduled, and enqueues nothing for a future send"
        status: pass
    human_judgment: false
  - id: D3
    description: "Schedule refuses a missing or malformed expectedVersion with 400; the pre-existing past-date 422 guard still fires ahead of a correctly-versioned request"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > schedule version precondition (TMPL-02, D-06/D-07) > rejects a schedule body with no expectedVersion / a malformed one / a past scheduledAt with a correct expectedVersion still returns 422"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cancel bumps campaigns.version by exactly one on the scheduled->draft transition, without requiring any client-supplied precondition"
    requirement: "TMPL-02"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > schedule version precondition (TMPL-02, D-06/D-07) > cancel bumps the version by exactly one and returns to draft"
        status: pass
    human_judgment: false
  - id: D5
    description: "scheduleCampaign rejects a stale expectedVersion at the repository layer with version_conflict and the row's real currentVersion"
    requirement: "TMPL-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts > scheduleCampaign called with a stale expectedVersion rejects with version_conflict and the row's real version"
        status: pass
    human_judgment: false
  - id: D6
    description: "A successful test-send snapshots the campaign's saved templateId/fromEmail into exactly one queued kind='test' job"
    requirement: "TMPL-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > test-send precondition and template snapshot (TMPL-03, D-11/D-12) > a successful test-send snapshots the campaign's saved template and sender into exactly one queued job"
        status: pass
    human_judgment: false
  - id: D7
    description: "A template change after test-send enqueue does not redirect the already-queued job -- the async-gap proof"
    requirement: "TMPL-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > test-send precondition and template snapshot (TMPL-03, D-11/D-12) > a template change after enqueue does not redirect the already-queued test send (TMPL-03 async-gap proof)"
        status: pass
    human_judgment: false
  - id: D8
    description: "A stale expectedVersion on test-send is refused with 409 version_conflict and enqueues nothing; a missing/malformed expectedVersion is refused with 400"
    requirement: "TMPL-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > test-send precondition and template snapshot (TMPL-03, D-11/D-12) > a stale expectedVersion is refused with 409 version_conflict and enqueues nothing / rejects a test-send body with no expectedVersion / a malformed one"
        status: pass
    human_judgment: false
  - id: D9
    description: "A test-send on a campaign with no template is refused with 422 code incomplete and a fields.templateId entry, enqueuing nothing"
    requirement: "TMPL-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > test-send precondition and template snapshot (TMPL-03, D-11/D-12) > refuses a test-send with 422 incomplete when the campaign has no template, and enqueues nothing"
        status: pass
    human_judgment: false
  - id: D10
    description: "The conditional from_email persist bumps the version at most once across two consecutive test sends resolving to the same address"
    requirement: "TMPL-03"
    verification:
      - kind: integration
        ref: "apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts > test-send precondition and template snapshot (TMPL-03, D-11/D-12) > an idempotent no-op sender persist bumps the version at most once across two consecutive test sends"
        status: pass
    human_judgment: false
  - id: D11
    description: "sender-resolver.ts exports exactly CampaignSenderError, CampaignSenderInput, resolveCampaignSenderEmail; apps/api build proves no caller of the removed resolveCampaignFromEmail remains"
    requirement: "TMPL-03"
    verification:
      - kind: unit
        ref: "npm run build -w apps/api (TypeScript build) + grep of sender-resolver.ts's export statements"
        status: pass
    human_judgment: false
  - id: D12
    description: "apps/web builds and its test suite passes with the widened ScheduleCampaignInput/TestSendCampaignInput call sites"
    requirement: "TMPL-02"
    verification:
      - kind: unit
        ref: "npm run build -w apps/web && npm run test -w apps/web"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-08-21
status: complete
---

# Phase 20 Plan 03: Schedule/Test-Send Optimistic-Lock Precondition + Template Snapshot Summary

**Schedule and test-send now share launch's locked `expectedVersion` contract (409 `version_conflict` before any status change or enqueue), cancel bumps `campaigns.version` unconditionally, and a `kind='test'` job carries the exact `templateId`/`fromEmail` the passing version check observed — so a save between enqueue and worker dispatch can never redirect an already-queued test send.**

## Performance

- **Duration:** ~35 min
- **Started:** ~2026-08-21T09:05:00Z (approx, following plan 20-02's completion)
- **Completed:** 2026-08-21T09:32:00Z
- **Tasks:** 2 (both TDD: RED + GREEN commits each)
- **Files modified:** 11

## Accomplishments

- `scheduleCampaignSchema` requires `expectedVersion: z.number().int().min(1)`; `scheduleCampaign(id, { scheduledAt, expectedVersion, resolvedFromEmail })` compares and bumps the version inside the same `SELECT ... FOR UPDATE` transaction as the `draft -> scheduled` flip and `from_email` persist, mirroring `launchCampaign`'s shape exactly (checked order: `not_found` -> status -> version, deliberately no completeness check).
- `cancelCampaign` bumps `version = version + 1` in both branches (`scheduled -> draft`, `sending -> canceled`) with no `expectedVersion` parameter -- D-06 enumerates only launch/schedule/test-send as requiring the precondition.
- New `prepareCampaignTestSend(id, { expectedVersion, resolvedFromEmail })` -- the locked version check for test-send: `not_found` -> `version_conflict` -> `incomplete` (naming the specific missing field), never checking or changing `status` (a test send is not a state transition). The `from_email` persist is conditional (`WHERE from_email IS DISTINCT FROM $3`) so a no-op resolution never bumps the version.
- `emailBroadcastJobSchema` gains optional, additive `templateId`/`fromEmail` fields (no `schemaVersion` bump, following the `requestId` precedent) -- populated only for `kind: 'test'`, read from the row `prepareCampaignTestSend` returned, never from `request.body`.
- `campaigns.routes.ts`'s schedule handler resolves the sender via the read-only `resolveCampaignSenderEmail` and passes `{ scheduledAt, expectedVersion, resolvedFromEmail }` into `scheduleCampaign`. The test-send handler calls `prepareCampaignTestSend` inside `withTenant`, maps `incomplete` to a 422 with `launchIncompleteFields`-shaped `fields`, and enqueues with `templateId`/`fromEmail` snapshotted from the returned row.
- `sender-resolver.ts`'s persisting `resolveCampaignFromEmail` is deleted; the module now exports exactly `CampaignSenderError`, `CampaignSenderInput`, `resolveCampaignSenderEmail` -- sender resolution has one implementation and it performs no campaign write of its own.
- `apps/web`: `ScheduleDialog`'s `scheduleMutation` echoes `campaign.version`; `TestSendPanel`'s `testSendMutation` echoes `campaign.version` and invalidates the campaign detail query key on success (so a version bump from the locked persist can never leave the browser holding a stale version that would 409 the next launch).
- `SPECIFICATION.md` §6.5.1 extended in place (schedule + cancel) and new §6.5.2 added (test-send contract + job-payload snapshot doc), rather than duplicating the launch subsection plan 20-02 wrote.

## Task Commits

Each task followed the RED/GREEN TDD cycle with two commits:

1. **Task 1 (RED): add failing schedule/cancel version-precondition tests** - `0cc58b8` (test)
2. **Task 1 (GREEN): schedule takes the locked version precondition; cancel bumps version** - `0236723` (feat)
3. **Task 2 (RED): add failing test-send precondition and template-snapshot tests** - `2a4d007` (test)
4. **Task 2 (GREEN): test-send takes the version precondition and snapshots template/sender into the job** - `59344f4` (feat)

**Plan metadata:** this commit (made after this SUMMARY)

## Files Created/Modified

- `packages/shared-schemas/src/campaign.ts` - `scheduleCampaignSchema`/`testSendCampaignSchema` require `expectedVersion`
- `packages/shared-schemas/src/queues.ts` - `emailBroadcastJobSchema` gains optional `templateId`/`fromEmail`
- `apps/api/src/modules/campaigns/campaign.repository.ts` - `scheduleCampaign`'s new signature and locked version check, `cancelCampaign`'s version bump in both branches, new `prepareCampaignTestSend`
- `apps/api/src/modules/campaigns/sender-resolver.ts` - `resolveCampaignFromEmail` removed; `resolveCampaignSenderEmail`'s doc comment generalized to all three callers
- `apps/api/src/modules/campaigns/campaigns.routes.ts` - schedule handler resolves read-only; test-send handler wired to `prepareCampaignTestSend` + job-payload snapshot
- `apps/api/src/modules/campaigns/__tests__/campaigns-routes.test.ts` - new `schedule version precondition` (5 cases) and `test-send precondition and template snapshot` (6 cases) describe blocks
- `apps/api/src/modules/campaigns/__tests__/campaign-state-machine.test.ts` - `scheduleCampaign` call sites updated to the new signature; new stale-version case
- `apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts` - two pre-existing test-send assertions updated to carry `expectedVersion` (Rule 1)
- `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` - `ScheduleDialog`'s `scheduleMutation` echoes `campaign.version`
- `apps/web/src/features/campaigns/TestSendPanel.tsx` - `testSendMutation` echoes `campaign.version`; `onSuccess` invalidates the campaign detail query
- `SPECIFICATION.md` - §6.5.1 extended (schedule/cancel), new §6.5.2 (test-send + job-payload snapshot)

## Decisions Made

- **`scheduleCampaign`'s check order:** `not_found` -> status -> version, deliberately NO completeness check -- scheduling an incomplete draft is existing, deliberate behaviour; the launch that eventually fires the scheduled campaign is what enforces completeness.
- **`prepareCampaignTestSend` never checks/changes `status`:** a test send is not a state transition and is legal in any status today; this plan does not narrow that.
- **Conditional `from_email` persist inside `prepareCampaignTestSend`:** guarded by `WHERE from_email IS DISTINCT FROM $3` so the any-write-bumps invariant never fires on a no-op test send. Kept at all for rolling-deploy fallback (an old worker reads `campaigns.from_email` directly) and to preserve `launchIncompleteFields`/`computeIncompleteReason`'s existing sender-configured semantics.
- **`emailBroadcastJobSchema`'s new fields are optional/additive, no `schemaVersion` bump** -- follows the `requestId` precedent; a version bump would make an old worker defer an already-enqueued test send during a rolling deploy, silently dropping a queued send rather than safely retrying.
- **`resolveCampaignFromEmail` deleted, not deprecated-in-place** -- both remaining callers (schedule, test-send) are migrated in this same plan, so sender resolution can drop to exactly one implementation now rather than carrying a dead persisting variant into a future plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated sender-resolution.test.ts's test-send assertions for the now-required expectedVersion**
- **Found during:** Task 2, GREEN verification run (`npm run test -w apps/api -- campaigns`)
- **Issue:** `apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts` (not in this plan's `<files>` list, but a pre-existing file exercising the test-send route) posted `payload: {}` in two cases. `testSendCampaignSchema` now requires `expectedVersion`, so both cases failed with 400 instead of exercising the sender-resolution behaviour under test -- a bug directly caused by this task's own schema change.
- **Fix:** Both `payload: {}` calls updated to `payload: { expectedVersion: 1 }` (the campaign's own first-read version, matching the pattern the launch cases in the same file already use).
- **Files modified:** `apps/api/src/modules/campaigns/__tests__/sender-resolution.test.ts`
- **Verification:** `npm run test -w apps/api -- campaigns` -- 56/56 passed.
- **Committed in:** `59344f4` (Task 2 GREEN commit)

---

**Total deviations:** 1 auto-fixed (Rule 1, test file broken by this plan's own schema change).
**Impact on plan:** No scope creep -- the fix only updates two pre-existing test bodies to satisfy the new required field this plan introduced; no production behavior changed beyond what the plan specifies.

## Issues Encountered

- **Environment (not a code deviation):** this worktree has no local `node_modules` (per project rule 7). Set up temporary worktree-local symlink shims (root `node_modules` mirroring the main checkout's third-party packages, `node_modules/@mega-crm/*` pointing at THIS worktree's own `packages/*`/`apps/*` so edits were tested against, not the main checkout's stale copies; plus `apps/api/node_modules` and `apps/web/node_modules` for their app-local deps) for verification only -- all removed before finishing, confirmed by `find . -maxdepth 4 -name node_modules -not -path "*/node_modules/*"` returning nothing and a clean `git status --short`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 20-04 (worker-side consumption) can rely on: `EmailBroadcastJob`'s optional `templateId`/`fromEmail` fields (present only for `kind: 'test'`, absent on pre-Phase-20 jobs and on `kind: 'campaign'` jobs); the worker must prefer these when present and fall back to reading `campaigns.template_id`/`campaigns.from_email` off the row when absent.
- All three send paths (launch, schedule, test-send) now share one contract: required `expectedVersion`, compared inside the same `FOR UPDATE` transaction that mutates the row, 409 `version_conflict` with `currentVersion` on mismatch, nothing dispatched on refusal.
- Sender resolution has exactly one implementation (`resolveCampaignSenderEmail`) with no persisting variant left anywhere in the codebase -- confirmed by `sender-resolver.ts`'s export list and a clean `apps/api` build.
- No blockers. The worktree `node_modules` finding above is environment/verification-only and does not affect shipped code.

## Self-Check: PASSED

- `packages/shared-schemas/src/campaign.ts` -- FOUND, `scheduleCampaignSchema`/`testSendCampaignSchema` both contain `expectedVersion: z.number().int().min(1)`.
- `packages/shared-schemas/src/queues.ts` -- FOUND, contains `templateId: z.string().optional()` and `fromEmail: z.string().email().optional()` on `emailBroadcastJobSchema`, no `schemaVersion` addition to that schema.
- `apps/api/src/modules/campaigns/campaign.repository.ts` -- FOUND, contains `prepareCampaignTestSend`, exactly one `SELECT ... FOR UPDATE` and one `UPDATE` in its body; `scheduleCampaign` performs exactly one `UPDATE`; both `cancelCampaign` branches contain `version = version + 1`.
- `apps/api/src/modules/campaigns/sender-resolver.ts` -- FOUND, exports exactly `CampaignSenderError`, `CampaignSenderInput`, `resolveCampaignSenderEmail`; no `resolveCampaignFromEmail` remains.
- `apps/web/src/features/campaigns/LaunchScheduleDialogs.tsx` / `TestSendPanel.tsx` -- FOUND, both echo `expectedVersion: campaign.version`.
- `SPECIFICATION.md` -- FOUND, §6.5.1 extended with schedule/cancel, §6.5.2 documents test-send + job-payload snapshot.
- Commits `0cc58b8`, `0236723`, `2a4d007`, `59344f4` -- all present in `git log --oneline`.
- `git status --short` -- clean (all verification-only `node_modules` shims removed).

---
*Phase: 20-campaign-template-correctness*
*Completed: 2026-08-21*
