---
phase: 16-live-sendgrid-verification
plan: 02
subsystem: testing
tags: [sendgrid, uat, tenant-context, rls, scripted-assert, flows, campaigns]

# Dependency graph
requires:
  - phase: 16-live-sendgrid-verification
    provides: "16-01's scripts/uat-verify.mjs dispatch table/exit-code contract, docs/runbooks/uat-live-sendgrid.md as the single operator document, the live UAT workspace (171285c6-a489-46be-9ee9-ba4ed6964356), the delivered leg of UAT-02 already closed"
  - phase: 11-delivery-correctness
    provides: sends schema (campaign_id, flow_run_id, node_id), EVENT_FLAGS webhook provisioning
  - phase: 06-flows-triggered-chains (archived under .planning/milestones/v1.0-phases)
    provides: event-triggered flow model, POST /v1/events ingestion endpoint
provides:
  - "scripts/uat-verify.mjs event-coverage subcommand -- reads send_events JOIN sends, asserts all four live event types observed and attributed to a campaign send and a flow-step send (non-null node_id), exit 0/1/2"
  - "docs/runbooks/uat-live-sendgrid.md sections 9-11: UAT flow definition, bounce-target selection rule (D-05), ordered UAT-02 procedure"
  - "UAT-02 closed live: delivered/opened/clicked/bounced all observed in the UAT workspace, attributed to both a campaign send and a flow-step send"
affects: [16-04-dedup, 16-05-fixture-capture, 16-06-uat05-state, 16-07-uat-report]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Expected-event-type spelling sourced from the storage write site, not assumed: send_events.event_type stores SendGrid's raw event.event field verbatim (apps/worker/src/queues/webhook-events.worker.ts's extractEventRow) -- 'delivered'/'open'/'click'/'bounce', never the human labels 'opened'/'clicked'/'bounced'. Cross-checked against sendgrid-webhook-provision.ts's EVENT_FLAGS, the provisioning superset."
    - "Flow-step attribution reads sends.node_id, not flow_run_id -- a flow send can carry a non-null flow_run_id with a null node_id (an attribution gap the plan explicitly required this subcommand to catch, not silently pass)."
    - "A live bounce induced for UAT purposes must go through the platform's own send path (a campaign to a throwaway UAT contact), never directly via SendGrid or a mail client -- event-coverage's query requires a resolved send_id; an out-of-band bounce would silently report as 'missing: bounce' with no diagnostic pointing at the real cause."

key-files:
  created:
    - none (all changes extend files 16-01 already created)
  modified:
    - scripts/uat-verify.mjs (added event-coverage subcommand: summariseEventCoverage, formatEventCoverageReport, runEventCoverage; extended parseArgs' boolean-flag handling)
    - scripts/__tests__/uat-verify.test.mjs (13 new tests)
    - docs/runbooks/uat-live-sendgrid.md (sections 9-11)
    - .planning/phases/16-live-sendgrid-verification/deferred-items.md (logged, then resolved, a mixed-wave lint collision -- see Deviations)

key-decisions:
  - "The bounce-test send must be dispatched through the platform (a one-recipient campaign to a dedicated UAT bounce contact), never directly via SendGrid or a mail client -- added as a runbook correction (Task 2 scope) after the advisor caught that event-coverage's JOIN sends requires a resolved send_id, which an out-of-band bounce would never produce."
  - "requireFlowStep checks sends.node_id specifically (not flow_run_id) -- matches the plan's own 'a flow send with a null step is an attribution gap that looks like a pass' requirement, confirmed by reading packages/db/src/schema/sends.ts directly rather than assuming which column is 'the step'."
  - "EXPECTED_EVENT_TYPES = ['delivered','open','click','bounce'] -- SendGrid wire spelling as stored, not UAT-02's human-language names -- confirmed empirically against the worker's extractEventRow (event.event stored verbatim) and EVENT_FLAGS, with a comment in the source recording both."

patterns-established:
  - "Boolean-flag additions to a shared parseArgs helper go into one named Set (BOOLEAN_FLAGS) checked once in the parsing loop, rather than special-casing each new flag string inline -- keeps plan 16-01's --json handling behaviorally unchanged while extending it."

requirements-completed: [UAT-02]

coverage:
  - id: D1
    description: "scripts/uat-verify.mjs event-coverage subcommand -- summariseEventCoverage/formatEventCoverageReport pure helpers plus the DB-access runEventCoverage, asserting all four live event types and campaign/flow-step attribution with 0/1/2 exit-code semantics"
    requirement: "UAT-02"
    verification:
      - kind: unit
        ref: "scripts/__tests__/uat-verify.test.mjs (25 tests total: 12 pre-existing from 16-01 + 13 new for this plan)"
        status: pass
      - kind: other
        ref: "node scripts/uat-verify.mjs (no args) lists event-coverage; node scripts/uat-verify.mjs event-coverage (no --workspace) exits 2"
        status: pass
    human_judgment: false
  - id: D2
    description: "docs/runbooks/uat-live-sendgrid.md sections 9-11: UAT flow definition (event-triggered flow, POST /v1/events request), bounce-target selection rule (D-05, no-catch-all precondition), ordered UAT-02 procedure including the platform-bounce correction"
    requirement: "UAT-02"
    verification:
      - kind: other
        ref: "npm run check:runbook-coverage"
        status: pass
      - kind: other
        ref: "npm run check:root-hygiene"
        status: pass
      - kind: other
        ref: "grep -nEi 'SG\\.[A-Za-z0-9_-]{10,}|BEGIN [A-Z ]*PRIVATE KEY' docs/runbooks/uat-live-sendgrid.md (no match)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Live UAT-02 pass: all four SendGrid event types (delivered, open, click, bounce) observed in the real UAT workspace via event-coverage --require-campaign --require-flow-step, exit 0, with a genuine hard bounce and a flow-step send carrying a non-null node_id"
    requirement: "UAT-02"
    verification:
      - kind: manual_procedural
        ref: "checkpoint:human-verify approval, Task 3 -- operator ran event-coverage against the live UAT workspace and reported delivered=3, open=4, click=1, bounce=1, processed=4 (13 resolved send_events rows), both --require-campaign and --require-flow-step passing, a genuine hard bounce, and the evidence values recorded below"
        status: pass
    human_judgment: true
    rationale: "The open and click events exist only because the operator's real mail client rendered a tracking pixel and followed a wrapped link; the bounce exists only because a real receiving MTA rejected a real message. No automated check in this repository can observe an inbox render an image or a real MTA reject a message -- two of this plan's own must_haves are explicitly flagged 'verification: backstop' for exactly this reason."

duration: ~50min (executor time; excludes operator's own live-send/mail-client wait time, which happened outside this executor's process)
completed: 2026-08-17
status: complete
---

# Phase 16 Plan 02: Live SendGrid Event Coverage (UAT-02) Summary

**`uat-verify event-coverage` scripted assert plus three new runbook sections, proven live: all four SendGrid event types (delivered, opened, clicked, hard-bounced) observed in the real UAT workspace, attributed to both a campaign send and a flow-step send with a non-null step identifier.**

## Performance

- **Duration:** ~50 min (executor time; excludes the operator's own live verification session between the checkpoint pause and its approval)
- **Tasks:** 3 (Task 1 TDD RED+GREEN, Task 2 + one advisor-caught correction, Task 3 blocking checkpoint)
- **Files created:** 0 (all changes extend files plan 16-01 already created)
- **Files modified:** 3 code/doc files, 1 phase-tracking file (`deferred-items.md`)

## Accomplishments

- Extended `scripts/uat-verify.mjs` with the `event-coverage` subcommand: `summariseEventCoverage` (pure, unit-tested) asserts all four expected event types are present and, when `--require-campaign`/`--require-flow-step` are set, that at least one observed event attributes to a send carrying a real campaign reference and at least one to a send carrying a real flow-step reference (`sends.node_id`, confirmed by reading the schema directly rather than assumed) -- reporting the exact missing types and unattributed send ids rather than a partial pass.
- Confirmed the expected event-type spelling empirically against the write site (`apps/worker/src/queues/webhook-events.worker.ts`'s `extractEventRow`, which stores SendGrid's raw `event.event` field verbatim) and the provisioning superset (`EVENT_FLAGS`) -- `delivered`/`open`/`click`/`bounce`, not the human-language `opened`/`clicked`/`bounced` UAT-02 uses in prose.
- Wrote the runbook's flow-definition, bounce-target-selection, and UAT-02-procedure sections (§9-§11), including a correction (caught before the checkpoint, not after) that the bounce-test send must go through the platform's own send path rather than directly via SendGrid, since `event-coverage`'s query requires a resolved `send_id`.
- Ran the phase's second live slice for real: fired an event-triggered flow's send, opened it in a real mailbox (producing `opened`), clicked its template link (producing `clicked`), and dispatched a platform campaign to a genuinely nonexistent address at a domain the operator controls (producing a real hard `bounce`) -- `event-coverage --require-campaign --require-flow-step` exited 0 against the live data.

## Live UAT-02 Evidence (checkpoint approved)

Recorded at checkpoint resolution (operator-provided):

- **UAT_WORKSPACE_ID:** `171285c6-a489-46be-9ee9-ba4ed6964356` (same workspace as 16-01, retained as the standing canary per D-15)
- **`event-coverage` result:** exit `0`; observed counts -- `delivered=3`, `open=4`, `click=1`, `bounce=1`, `processed=4` (the latter outside `EXPECTED_EVENT_TYPES` but reported, not dropped, per this plan's "never silently drop an unrecognised observed type" design); 13 resolved `send_events` rows total
- **`--require-campaign`:** passed (at least one observed event attributed to a send carrying a non-null `campaign_id`)
- **`--require-flow-step`:** passed (the flow-step send's `node_id` is non-null)
- **Flow ID:** `500c77d2-7b6d-4cb7-b262-5d9856618b9f` (the minimal one-trigger, one-immediate-email-step flow defined in runbook §9)
- **Bounce campaign ID:** `109811eb-49bb-4bf0-b519-ffbfb56fe7ca` (the platform-dispatched campaign that produced the genuine hard bounce, per the Task 2 correction below)
- **Bounce target:** `phase16-hard-bounce-20260817@nimther.com` -- a domain the operator controls, confirmed to have no catch-all before use (runbook §10); a genuine hard bounce was observed, not a soft bounce or deferral
- **Operator confirmation:** "approved -- UAT-02 passed." Both `opened` and `clicked` were produced by the operator's real mail client rendering the tracking pixel and following the wrapped link, not by any simulated/programmatic fetch (this plan's `backstop`-flagged must-haves).

This closes **UAT-02** in full (the `delivered` leg was already closed live by 16-01; this plan closes the remaining `opened`/`clicked`/`bounced` legs and both attribution requirements).

## Task Commits

1. **Task 1 (RED):** `test(16-02): add failing tests for uat-verify event-coverage helpers` - `95b5417` (test)
2. **Task 1 (GREEN):** `feat(16-02): implement uat-verify event-coverage subcommand` - `776f7f1` (feat)
3. **Task 2:** `docs(16-02): add UAT flow definition, bounce-target selection and UAT-02 procedure sections` - `abb5f56` (docs)
4. **Task 2 (correction):** `docs(16-02): require the bounce send to go through the platform, not directly via SendGrid` - `9c9c464` (docs)
5. **Task 3:** blocking `checkpoint:human-verify` -- no code changes; approved by the operator with the live evidence recorded above (no separate commit; this is the live verification itself)

**Plan metadata:** this SUMMARY's own commit (see below)

_Note: Task 1 is `tdd="true"` -- RED (`95b5417`, 13 new tests fail against helpers that do not yet exist; 12 pre-existing 16-01 tests still pass) then GREEN (`776f7f1`, all 25/25 pass) -- the mandatory TDD gate sequence for this plan._

## Files Created/Modified

- `scripts/uat-verify.mjs` - added `EXPECTED_EVENT_TYPES`, `summariseEventCoverage`, `formatEventCoverageReport` (pure, exported), `runEventCoverage` (DB access, non-exported), the `event-coverage` branch in `parseArgs`/`main`, and a `BOOLEAN_FLAGS` set generalizing the existing `--json`-only boolean handling to also cover `--require-campaign`/`--require-flow-step`
- `scripts/__tests__/uat-verify.test.mjs` - 13 new tests: 3 for `parseArgs`' `event-coverage` handling, 8 for `summariseEventCoverage` (the plan's full `<behavior>` list), 2 for `formatEventCoverageReport`
- `docs/runbooks/uat-live-sendgrid.md` - §9 UAT flow definition (event-triggered flow, exact `POST /v1/events` request), §10 bounce-target selection rule and fill-ins, §11 ordered UAT-02 procedure (corrected to require a platform-dispatched bounce)
- `.planning/phases/16-live-sendgrid-verification/deferred-items.md` - logged a mixed-wave lint collision (see Deviations) that has since resolved on its own

## Decisions Made

- `--require-flow-step` checks `sends.node_id`, not `flow_run_id` -- see key-decisions above.
- `EXPECTED_EVENT_TYPES` uses SendGrid's wire spelling as stored (`delivered`/`open`/`click`/`bounce`), not UAT-02's human-language names -- see key-decisions above.
- The bounce-test send is required to go through the platform's own send path -- see Deviations, item 1.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality, caught by advisor review before the checkpoint] Runbook's original bounce-induction step did not require a platform-dispatched send**
- **Found during:** Task 2 verification (advisor review, before Task 3's checkpoint was returned).
- **Issue:** §11 step 4's first draft said "using the same BYO-key campaign or a one-off send" -- ambiguous enough that an operator could induce the bounce directly via SendGrid or a mail client, outside the platform's own `sends` table. `event-coverage`'s query is `send_events JOIN sends ... WHERE send_id IS NOT NULL` -- a bounce with no resolved `send_id` would never appear in the report, and would fail as an unexplained "missing: bounce" with no diagnostic pointing at the real cause (a wasted human round trip at exactly the plan's one blocking checkpoint).
- **Fix:** Rewrote §11 step 4 to require dispatching a one-recipient campaign (to a dedicated UAT bounce contact) through the platform, same shape as §6's campaign setup, explicitly stating why (the JOIN's `send_id` requirement).
- **Files modified:** `docs/runbooks/uat-live-sendgrid.md`.
- **Verification:** `npm run check:runbook-coverage` and `npm run check:root-hygiene` still exit 0 after the edit; the operator's actual live evidence confirms a platform-dispatched campaign (`Bounce campaign ID: 109811eb-49bb-4bf0-b519-ffbfb56fe7ca`) produced the observed bounce with correct campaign attribution.
- **Committed in:** `9c9c464`.

**2. [Out of scope, environmental, self-resolved -- logged then confirmed resolved] Mixed-wave sibling-worktree lint collision, unrelated to this plan's own files**
- **Found during:** Task 1 verification (`npm run lint`, repo-wide).
- **Issue:** While plan 16-03's parallel executor's isolated worktree (`.claude/worktrees/agent-a4c11ea04669a2a92`) was still checked out inside this repo's own tree, ESLint's typescript-eslint parser reported "multiple candidate TSConfigRootDirs" parsing errors across the ENTIRE `scripts/` tree -- including files this plan never touched (`validate-alloy-config.mjs`, `validate-prod-compose.mjs`, `verify-redis-config.mjs`, `vitest.config.ts`), confirming the failure was environmental (the sibling worktree's own `tsconfig.json` set), not caused by this plan's changes.
- **Fix:** Not fixed by this plan -- logged to `deferred-items.md` for the wave to resolve. The parallel executor's worktree was subsequently merged and cleaned up (merge commit `5d15483`, visible in `git log` on this branch); re-running `npm run lint` repo-wide after the merge shows the collision is gone, leaving only the pre-existing, already-documented 16-01 `correlation-tracer.test.ts` `require-await` failure (unrelated to this plan; see `deferred-items.md`'s 16-01 entry).
- **Files modified:** `.planning/phases/16-live-sendgrid-verification/deferred-items.md` (logged only).
- **Verification:** `npm run lint` (repo-wide, post-merge) reports exactly one error -- `apps/worker/src/__tests__/correlation-tracer.test.ts:231:122` (`@typescript-eslint/require-await`), the same pre-existing item 16-01's own SUMMARY already documented. `npx eslint scripts/uat-verify.mjs scripts/__tests__/uat-verify.test.mjs` (isolated, both before and after the merge) exits 0 with zero errors/warnings throughout.
- **Committed in:** logged in `776f7f1`'s companion commit alongside `scripts/uat-verify.mjs`; resolution confirmed post-merge, not re-committed (no code change needed).

---

**Total deviations:** 1 auto-fixed (1 missing-critical-functionality, caught pre-checkpoint), 1 out-of-scope environmental item logged and since self-resolved.
**Impact on plan:** The bounce-through-platform correction was necessary to make the checkpoint's own verification command actually work as specified -- directly prevented a wasted human round trip. The lint collision never touched this plan's own deliverables and is now fully resolved; no lingering repo-wide lint debt from this plan.

## Issues Encountered

- `npm run lint` (repo-wide) reports one failure, `apps/worker/src/__tests__/correlation-tracer.test.ts:231:122` (`@typescript-eslint/require-await`) -- pre-existing, introduced by Phase 15 commit `b22e045`, already documented in `deferred-items.md`'s 16-01 entry and unrelated to this plan's files. Not fixed here (out of scope; SCOPE BOUNDARY rule).
- `npm test` (full aggregate) reports failures **only** in the pre-known, project-documented `apps/api`/`apps/worker` `sentry.test.ts` "no DSN configured" tests (this machine's `~/.config/mega-crm/.env` carries real Sentry DSNs since a prior UAT session -- these pass in CI). Confirmed as the sole failing test in each workspace: `apps/api` 76/77 test files passed (1 failing file, the sentry no-DSN test), `apps/worker` 88/89 test files passed (same); every `packages/*` workspace (12 workspaces) passed 100%. `apps/web` is not part of the root `npm test` aggregate (no entry in the log), so the Playwright-install failure the 16-03 executor noted did not surface here. Treated as a passing run per this project's own documented exception.

## User Setup Required

None beyond what the operator already performed live during Task 3's checkpoint (choosing and confirming a no-catch-all bounce-target domain, firing the flow trigger, opening/clicking the real mail, dispatching the bounce campaign) -- all captured in `docs/runbooks/uat-live-sendgrid.md` §9-§11 and the evidence values recorded above.

## Next Phase Readiness

- `scripts/uat-verify.mjs`'s dispatch table and shared query module remain shaped for 16-04 (`dedup`) and 16-06 (`uat05-state`) to add sibling subcommands without restructuring, exactly as 16-01 documented.
- `docs/runbooks/uat-live-sendgrid.md` now has 11 sections (§1-§8 from 16-01, §9-§11 from this plan); later plans continue appending to this same file, never a second UAT runbook.
- UAT-02 is fully closed, live, with both attribution requirements (campaign and flow-step) proven against real data. No blockers for 16-04 onward.
- The mixed-wave lint collision this plan flagged is confirmed resolved post-merge; no repo-wide lint follow-up is owed by this plan.

## Self-Check: PASSED

- `scripts/uat-verify.mjs` — FOUND
- `scripts/__tests__/uat-verify.test.mjs` — FOUND
- `docs/runbooks/uat-live-sendgrid.md` — FOUND
- `.planning/phases/16-live-sendgrid-verification/deferred-items.md` — FOUND
- Commit `95b5417` — FOUND in `git log --oneline --all`
- Commit `776f7f1` — FOUND in `git log --oneline --all`
- Commit `abb5f56` — FOUND in `git log --oneline --all`
- Commit `9c9c464` — FOUND in `git log --oneline --all`

---
*Phase: 16-live-sendgrid-verification*
*Completed: 2026-08-17*
