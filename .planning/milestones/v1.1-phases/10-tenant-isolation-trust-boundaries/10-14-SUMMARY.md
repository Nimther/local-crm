---
phase: 10-tenant-isolation-trust-boundaries
plan: 14
subsystem: testing
tags: [vitest, security, tenant-isolation, negative-testing, rls, bullmq, coverage-assertion]

# Dependency graph
requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: "the full Phase 10 stack this suite exercises: scan role (10-01/10-03), GUC retirement (10-06), fail-closed RLS on all 22 workspace_isolation policies + withPreTenantLookup (10-07), webhook sibling-drop (10-08), Better Auth grant boundary (10-09), API-key scopes (10-10), webhook timestamp freshness (10-11), distributed rate limiting (10-12), worker console redaction (10-13)"
provides:
  - "apps/api/src/__tests__/negative-cross-tenant.test.ts -- actively attempts a cross-tenant read/write through every session-authenticated route module and asserts denial, with row-level verification for every write, a workspace-bound API-key upsert proof, a tenant-context-bypass proof, a pre-tenant-lookup-sentinel narrow-grant proof, and a coverage assertion built from server.ts's own registration list"
  - "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts -- drives every background-job family's exported handler directly with a hostile payload and reads both workspaces' resulting state, plus a scan-role ungranted-table rejection proof and a coverage assertion built from buildWorker's own registration list"
  - "flow-trigger-evaluator.worker.ts now re-verifies a job payload's contactId belongs to its workspaceId before any flow entry (T-10-14-03 fix, found by this plan's own suite)"
  - ".planning/phases/10-tenant-isolation-trust-boundaries/10-VALIDATION.md completed -- every TBD replaced, Wave 0 fully resolved, manual-only table reflects the real post-role-bootstrap state, nyquist_compliant: true"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Negative cross-tenant suite: attempt the forbidden access (issue the request, run the handler) and assert denial + unchanged foreign-workspace state, never assert that a guard/policy exists -- outlives a mechanism refactor that an assertion-of-configuration test would not catch"
    - "Coverage-by-construction: parse the production registration list (server.ts's app.register(registerX) calls, buildWorker's create*Worker(...) calls) via a regex over the file's own source text, diff against a declared covered-set ∪ excluded-set with reasons, and fail if either side drifts"

key-files:
  created:
    - apps/api/src/__tests__/negative-cross-tenant.test.ts
    - apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
  modified:
    - apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts
    - apps/worker/src/queues/flows/flow-reconciliation.worker.ts
    - .planning/phases/10-tenant-isolation-trust-boundaries/10-VALIDATION.md

key-decisions:
  - "The API suite covers 11 of server.ts's registered route modules directly and documents 6 explicit exclusions with one-line reasons (registerProfileRoutes: no cross-tenant resource; registerSendgridKeyRoutes/registerSendSettingsRoutes/registerWebhookSettingsRoutes: workspace-level singletons already covered by the workspace-level test; registerUnsubscribeRoutes/registerWebhookRoutes: not session-authenticated at all)"
  - "The worker suite covers 11 of buildWorker's 14 job families with new dedicated hostile-payload tests in this file, references 2 more (campaign-scheduler, webhook-events) that already have a real attempted-access proof in their own existing test files rather than duplicating it, and excludes partition-maintenance (no workspace id anywhere in its payload -- no tenant boundary to cross)"
  - "email-broadcast and email-triggered are proven together via one processSendJob test (both queues call the identical shared function) -- duplicating the same hostile-payload assertion under two file names would prove nothing additional"
  - "flow-reconciliation.worker.ts's findDueFlowRunCandidates/transitionAndNudge exported (mirrors campaign-scheduler.worker.ts's existing precedent) so this suite can drive the scan-discovery-then-per-tenant-transition path directly, the same way campaign-scheduler-scan.test.ts already does for its sibling"

patterns-established:
  - "A negative-suite's coverage assertion reads its own production source file's registration list via regex at test-run time, rather than hand-maintaining a parallel list that can silently drift from what actually ships"

requirements-completed: [SEC-16]

coverage:
  - id: D1
    description: "Every session-authenticated API route module has a cross-tenant read attempt (denied, same 404 shape as a missing resource) and, where it offers one, a cross-tenant write attempt (denied, target workspace's row verified unchanged at the row level)"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/api/src/__tests__/negative-cross-tenant.test.ts (24 tests, all pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A workspace-A API key presented against workspace-B-shaped data (externalId collision) writes only into workspace A, never workspace B"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/api/src/__tests__/negative-cross-tenant.test.ts#Test 3: API-key-authed write is workspace-bound regardless of payload content"
        status: pass
    human_judgment: false
  - id: D3
    description: "No code path reaches a tenant table without tenant context -- both the AsyncLocalStorage guard and the DB-level fail-closed RLS predicate throw rather than returning rows"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/api/src/__tests__/negative-cross-tenant.test.ts#Test 4: no code path reaches a tenant table without tenant context"
        status: pass
    human_judgment: false
  - id: D4
    description: "The pre-tenant-lookup sentinel reads zero rows from an ordinary tenant table it was never granted"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/api/src/__tests__/negative-cross-tenant.test.ts#Test 5"
        status: pass
    human_judgment: false
  - id: D5
    description: "The API coverage assertion fails if a route module is registered in server.ts without a corresponding covered/excluded entry in this suite"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/api/src/__tests__/negative-cross-tenant.test.ts#Test 6: coverage"
        status: pass
    human_judgment: false
  - id: D6
    description: "Every background-job family that takes a workspace id from its payload produces no cross-workspace effect when the payload names a foreign workspace or a foreign resource id"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts (14 tests, all pass)"
        status: pass
    human_judgment: false
  - id: D7
    description: "Scan-consumer families (flow-reconciliation, flow-segment-sweep, analytics-reconciliation) discover cross-workspace candidates via the scan role but each row's per-tenant follow-up work affects only that row's own workspace"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts (Test 2 describe blocks: flow-reconciliation, flow-segment-sweep, analytics-reconciliation)"
        status: pass
    human_judgment: false
  - id: D8
    description: "The scan pool refuses a read of an ungranted tenant table with permission denied, not an empty result"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts#Test 4"
        status: pass
    human_judgment: false
  - id: D9
    description: "The worker coverage assertion fails if a job family is registered in buildWorker without a corresponding covered/excluded entry in this suite"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts#Test 5: coverage"
        status: pass
    human_judgment: false
  - id: D10
    description: "processFlowTriggerCheck verifies a job payload's contactId belongs to the job's own workspaceId before any flow entry -- a hostile/misrouted payload naming a contact from a different workspace is now a no-op rather than creating a cross-workspace flow_runs row"
    requirement: "SEC-16"
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts#flow-trigger-evaluator (processFlowTriggerCheck)"
        status: pass
    human_judgment: false
  - id: D11
    description: "10-VALIDATION.md's per-task verification map, Wave 0 checklist, manual-only table, and sign-off checklist are complete with no remaining TBD entries"
    requirement: "SEC-16"
    verification:
      - kind: other
        ref: "grep -c TBD .planning/phases/10-tenant-isolation-trust-boundaries/10-VALIDATION.md == 0"
        status: pass
    human_judgment: false

duration: ~2h
completed: 2026-08-08
status: complete
---

# Phase 10 Plan 14: Negative Cross-Tenant Test Suites + Phase Validation Record Summary

**Two negative-testing suites (38 tests total) that actively attempt cross-tenant access through every API route module and every background-job family rather than asserting mechanisms exist, discovering and fixing one real cross-tenant bug (T-10-14-03) along the way; plus the completed phase validation record.**

## Performance

- **Duration:** ~2h
- **Tasks:** 3/3 completed
- **Files modified:** 5 (2 created, 3 modified — 2 source files, 1 `.planning/` artifact)

## Accomplishments

- `apps/api/src/__tests__/negative-cross-tenant.test.ts` (24 tests): a read-and-write cross-tenant attempt against every session-authenticated route module that has a cross-tenant-reachable resource (contacts, campaigns, flows, segments, send-log, csv imports, api keys, members, invites, flow analytics, contact timeline, workspace itself), with row-level verification for every denied write (not just a response-code check); a workspace-bound API-key upsert proof (an externalId collision against a sibling workspace's contact still writes only into the key's own workspace); a tenant-context-bypass proof at both the package's AsyncLocalStorage layer and the DB's fail-closed RLS layer; a pre-tenant-lookup-sentinel proof that it grants nothing on an ordinary tenant table; and a coverage assertion parsing `server.ts`'s own `app.register(registerX)` list, with 6 explicitly-reasoned exclusions.
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` (14 tests): drives 9 job families' exported handlers directly with hostile payloads (a workspace id that doesn't own the referenced rows, or a foreign resource id), reading both workspaces' resulting state afterward; proves the 3 scan-consumer families (flow-reconciliation, flow-segment-sweep, analytics-reconciliation) discover across workspaces but transition/reconcile only the correct row's own workspace; references 2 families (campaign-scheduler, webhook-events) that already have a real attempted-access proof in their own dedicated test files; excludes partition-maintenance (no workspace id in its payload at all); proves the scan role is refused on an ungranted table; and carries its own coverage assertion parsing `buildWorker`'s `create*Worker(...)` list.
- **Found and fixed a genuine cross-tenant bug** (T-10-14-03, high severity per this plan's own threat model): `processFlowTriggerCheck` never verified a job payload's `contactId` belonged to the job's own `workspaceId` before creating a `flow_runs` row. Since `flow_runs.contact_id`'s FK targets `contacts(id)` alone (not a composite `(workspace_id, id)` key), and neither `canEnterFlow` nor the INSERT itself re-read the contact row, a misrouted/hostile job payload naming a contact from a different workspace could create a `flow_runs` row in the wrong workspace referencing a foreign contact. Fixed with a re-verification query before any flow entry (event- or segment-triggered); followed strict RED→GREEN TDD (verified the failing assertion against unmodified code before applying the fix).
- `.planning/phases/10-tenant-isolation-trust-boundaries/10-VALIDATION.md` completed: every `TBD` in the per-task verification map replaced with the real plan/wave/threat-ref/command from the 13 prior plans' SUMMARYs (cross-checked against each plan's own `<threat_model>` for its actual `T-10-XX-*` IDs); Wave 0 checklist fully ticked with one-line notes on how each item was satisfied differently than predicted; the manual-only table rewritten from its single stale entry to 3 rows reflecting what genuinely still requires an operator after plan 10-01's role-bootstrap automation; `nyquist_compliant: true`, `wave_0_complete: true`, `status` left `draft` per the plan's own instruction.

## Task Commits

1. **Task 1: Negative cross-tenant suite for the API surface** - `a2b3053` (test)
2. **Task 2 (RED): Negative cross-tenant suite for the background-job families** - `1da9d37` (test) — exports `flow-reconciliation.worker.ts`'s `findDueFlowRunCandidates`/`transitionAndNudge` for direct testing; fails on the flow-trigger-evaluator case against unmodified production code
3. **Task 2 (GREEN): T-10-14-03 fix** - `ca2eba9` (fix) — `processFlowTriggerCheck` re-verifies contact ownership before any flow entry
4. **Task 3: Complete the phase validation record** - no commit (`.planning/` is gitignored in this repository; the completed `10-VALIDATION.md` lives in this worktree for the orchestrator to copy out, matching every prior plan in this phase)

**Plan metadata:** worktree mode — `.planning/` is gitignored in this repo; STATE.md/ROADMAP.md are the orchestrator's responsibility after this worktree merges.

_Note: Task 2 carries `tdd="true"`. The RED commit includes both the new test file AND the `flow-reconciliation.worker.ts` export-visibility change (test infrastructure, not a behavior change) — the GREEN commit is exactly the one-file production fix that turns the failing assertion green, verified by stashing/restoring the fix around a real test run rather than asserted from memory._

## Files Created/Modified

- `apps/api/src/__tests__/negative-cross-tenant.test.ts` - the API-surface negative suite (24 tests)
- `apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts` - the background-job negative suite (14 tests)
- `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts` - `processFlowTriggerCheck` now re-verifies `contactId` belongs to `workspaceId` before any flow entry (T-10-14-03 fix)
- `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` - `findDueFlowRunCandidates`/`transitionAndNudge` exported (test-only visibility change, mirrors `campaign-scheduler.worker.ts`'s existing precedent)
- `.planning/phases/10-tenant-isolation-trust-boundaries/10-VALIDATION.md` - completed per-task map, Wave 0 checklist, manual-only table, sign-off checklist

## Decisions Made

- API suite: 11 of `server.ts`'s registered route modules covered directly in the `ATTEMPT_CASES` matrix + 2 covered by dedicated tests (workspace-level, API-key Test 3) + 6 explicitly excluded with one-line reasons (profile: no cross-tenant resource; sendgrid-key/send-settings/webhook-settings: workspace-level singletons, no id param, already covered by the workspace-level test; unsubscribe/webhook receiver: not session-authenticated at all).
- Worker suite: 9 families get new dedicated hostile-payload tests in this file; 2 families (campaign-scheduler, webhook-events) are referenced rather than re-tested since `campaign-scheduler-scan.test.ts` and `webhook-events-sibling-drop.test.ts` already attempt real cross-tenant access against them; 1 family (partition-maintenance) is excluded outright — no workspace id exists anywhere in its job payload or query, so there is no tenant boundary for a hostile payload to cross.
- `email-broadcast`/`email-triggered` proven together via one `processSendJob` test each for the campaign-kind and flow-kind branches, since both queues' Workers call the identical shared function — testing the same function twice under two file names would add no coverage.
- Chose to export `flow-reconciliation.worker.ts`'s two previously-private discovery/transition functions rather than testing only through the higher-level `runFlowSegmentSweepTick`-style tick function (which doesn't exist for this file) — mirrors `campaign-scheduler.worker.ts`'s own precedent exactly, keeping the pattern consistent across the phase's scan consumers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `processFlowTriggerCheck` created a cross-workspace `flow_runs` row for a hostile/misrouted job payload**
- **Found during:** Task 2, first run of the new `negative-cross-tenant-jobs.test.ts` suite
- **Issue:** `flow_runs.contact_id`'s foreign key targets `contacts(id)` alone (not a composite `(workspace_id, id)` key). `processFlowTriggerCheck` never re-read the contact's own row to confirm it belonged to the job's `workspaceId` before `canEnterFlow`'s decision and the subsequent `flow_runs` INSERT — a job payload naming a contact id from a *different* workspace than `workspaceId` could create a flow_runs row in the wrong workspace, referencing a foreign contact. This is exactly what threat T-10-14-03 (in this plan's own threat model) names: "a hostile job payload naming another workspace."
- **Fix:** Added a `SELECT id FROM contacts WHERE id = $1 AND workspace_id = $2` re-verification at the top of `processFlowTriggerCheck`'s transaction, before either the event-triggered or segment-triggered branches run; a non-matching contact makes the whole check a no-op, mirroring the "denied by the tenant-scoped query" contract every other job family in this suite already has.
- **Files modified:** `apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts`
- **Verification:** Confirmed RED (the specific test failed, `crossRunCount` was `1` instead of `0`) against unmodified code by stashing the fix and re-running; confirmed GREEN after restoring it. Full `apps/worker` suite (145/145) and the existing `flow-trigger-evaluator.test.ts` regression suite (5/5) both pass after the fix.
- **Committed in:** `ca2eba9` (separate GREEN commit, per this task's `tdd="true"` frontmatter)

---

**Total deviations:** 1 auto-fixed (Rule 1, a genuine cross-tenant security bug this plan's own suite was designed to catch)
**Impact on plan:** This is precisely the outcome SEC-16/T-10-14-03 exist to produce — a negative test that attempts real access found a real gap the prior 13 plans' mechanism-focused tests could not have caught (none of them issue a hostile job payload against `flow-trigger-evaluator.worker.ts`). No scope creep: the fix is confined to the exact function the discovering test targets.

## Issues Encountered

- **Environment note (not a deviation):** this environment has a real local Postgres (native, not Docker) with `mega_crm_scan`/`mega_crm_auth`/`mega_crm_app` cluster roles already provisioned, and a running Redis — every test command in this plan (`npx vitest run --root apps/api`, `--root apps/worker`, both new files individually) was run for real against ephemeral test databases via `packages/test-support`'s existing provisioning, not merely written and assumed to pass.
- **Pre-existing, unrelated flakiness (reconfirmed, not touched):** `apps/api/src/modules/webhooks/__tests__/webhooks-signature.test.ts`'s two BullMQ queue-depth assertions failed only when the FULL `apps/api` suite ran (`npx vitest run --root apps/api`, 58+ files concurrently) but passed cleanly in isolation (`npx vitest run --root apps/api src/modules/webhooks/__tests__/webhooks-signature.test.ts`, 7/7). This is the same shared-BullMQ-queue-under-concurrency signature already documented in plan 10-13's SUMMARY ("Issues Encountered") and predates this plan; not fixed here per the Scope Boundary rule. This plan's own two new test files (24/24 and 14/14) pass reliably both standalone and as part of their respective full-workspace suites (`apps/api` 364/366 — the 2 pre-existing flaky tests aside — and `apps/worker` 145/145).

## Known Stubs

None.

## Threat Flags

None — this plan's own threat model (T-10-14-01 through T-10-14-06) is what the two suites were built to close; no new unregistered trust-boundary surface was introduced. The one bug found (T-10-14-03) was already a registered threat in this plan's own threat model, not a newly-discovered surface.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SEC-16 is closed: every session-authenticated API route module and every background-job family now has an active cross-tenant denial proof (attempted access, not asserted configuration), each suite's own coverage assertion protects against silent drift as new modules/families ship.
- Phase 10 (Tenant Isolation & Trust Boundaries) is functionally complete across all 14 plans — `.planning/phases/10-tenant-isolation-trust-boundaries/10-VALIDATION.md` is filled in and ready for `/gsd-validate-phase` to promote from `draft` to `validated`.
- No blockers for Phase 11 (Delivery Correctness).

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-08*

## Self-Check: PASSED

- FOUND: apps/api/src/__tests__/negative-cross-tenant.test.ts
- FOUND: apps/worker/src/queues/__tests__/negative-cross-tenant-jobs.test.ts
- FOUND: apps/worker/src/queues/flows/flow-trigger-evaluator.worker.ts (modified)
- FOUND: apps/worker/src/queues/flows/flow-reconciliation.worker.ts (modified)
- FOUND: .planning/phases/10-tenant-isolation-trust-boundaries/10-VALIDATION.md (0 remaining TBD)
- FOUND commit: a2b3053
- FOUND commit: 1da9d37
- FOUND commit: ca2eba9
