---
phase: 12-worker-reliability-tenant-fairness
verified: 2026-08-11T05:24:47Z
status: human_needed
score: 15/16 must-haves verified
behavior_unverified: 1
overrides_applied: 0
re_verification:
  previous_status: passed
  previous_score: 12/12
  gaps_closed:
    - "G-12-1: five repeatable-tick workers (campaign-scheduler, analytics-reconciliation, flow-reconciliation, partition-maintenance, send-reconciler) forwarded an undefined `autorun` key that clobbered BullMQ's own `autorun: true` default, silently disabling their run loops. All five now use a conditional-spread idiom that omits the key unless a caller supplies it, matching `flow-segment-sweep.worker.ts`'s unaffected shape. Verified in code (all five files read) and by a new regression suite (`worker-autorun-default.test.ts`, 8/8 passing) that constructs each factory with the exact one-argument production call shape and asserts the run loop starts and a queued job reaches 'active'."
    - "G-12-2: ARCHITECTURE.md's forward-looking Phase 12 entry no longer claims queue retention is unshipped (it was shipped in plan 12-09); it now points at SPECIFICATION.md §5.3 and names only the memory-ceiling item as open. SPECIFICATION.md §5.1/§5.2 now document the autorun mechanism as-built, state that registration and consumption are separate facts, and attribute the sixteen-workers-operational claim to the regression test plus the G-12-1 runtime diagnosis rather than the boot log. Verified by reading both files' actual diffs against the plan's own verify commands, all of which pass."
  gaps_remaining:
    - "12-12's own D5 human-check (booting the worker process against the real development Redis instance that held the originally-reported backlog and observing live drain) was never performed — both 12-12 and 12-13 executors ran in isolated worktrees with no access to that environment. SPECIFICATION.md itself now explicitly records this as a separate, not-yet-performed step rather than presenting it as done."
    - "The 12-12 burst-absorption test's 'without duplicated side effects' assertion is vacuous: the ephemeral test database has no campaign rows, so the kickoff queue reads all-zero regardless of whether the deterministic-jobId dedup logic works. Confirmed independently by re-reading the test and its own header comment (lines 296-301), and corroborated by the fresh 12-REVIEW.md's WR-03 finding. The 'drains to zero without failures' half of this truth IS genuinely proven by the same test; only the duplication-specific claim is unproven."
  regressions: []
gaps: []
behavior_unverified_items:
  - truth: "A stack of identical tick jobs accumulated while a worker was not consuming drains to zero without failures AND without duplicated side effects (12-12 must-have D4)"
    test: "Seed one past-due `scheduled` campaign before stacking the 20-job burst on campaign-scheduler's tick queue, then drain with a production-shape worker and assert the kickoff producer queue's `completed` count is exactly 1 (not 0) despite 20+ ticks scanning it -- this is WR-03's fix (a) from the fresh 12-REVIEW.md."
    expected: "Exactly one kickoff job reaches the producer queue despite the accumulated burst re-scanning the same due campaign on every tick, proving the deterministic `jobId: campaignId` + `transitionToSending`'s re-check-before-transition pattern actually prevents double-kickoff -- not just that an empty database produces empty counts."
    why_human: "The current automated test's assertion is vacuous by its own admission (no campaign rows exist in the harness), so no existing automated evidence proves the no-duplication claim; a human/planner decision is needed on whether to close this now or accept the underlying mechanism (deterministic BullMQ jobId collision + FOR UPDATE SKIP LOCKED re-check, both independently established patterns elsewhere in this codebase) as sufficient without a dedicated test."
human_verification:
  - test: "Boot the worker process against the real development Redis instance that held the originally-reported backlog (partition-maintenance: 107 waiting, and siblings) and watch it for a few minutes."
    expected: "The five tick queues' waiting counts fall toward zero, `active` events appear on each of the five, nothing lands in the failed set, and partition-horizon/campaign-scan behavior is unaffected."
    why_human: "Requires the actual development Redis instance holding the reported backlog; both gap-closure executors ran in isolated worktrees with no access to it. This is plan 12-12's own unresolved `<human-check>` item (D5), and SPECIFICATION.md itself now says so explicitly rather than presenting it as done."
  - test: "Seed a past-due `scheduled` campaign and re-run (or extend) the burst-absorption test to assert exactly one kickoff job reaches the producer queue across the 20+-tick burst."
    expected: "Kickoff producer queue shows `completed: 1`, not `completed: 0`, proving dedup rather than an empty-database vacuous pass."
    why_human: "This is a test-design gap, not a runtime uncertainty -- flagged here per protocol because no automated evidence currently exists for the specific 'no duplicated side effect' sub-claim; a maintainer decision is needed on priority/timing of the fix (WR-03 in the fresh 12-REVIEW.md already proposes the exact fix)."
---

# Phase 12: Worker Reliability & Tenant Fairness Verification Report

**Phase Goal:** One tenant's limits, one oversized segment, or a restart cannot degrade the rest of the platform; background work is bounded, resumable and observable.
**Verified:** 2026-08-11T05:24:47Z
**Status:** human_needed
**Re-verification:** Yes — after gap closure (plans 12-12/12-13, closing UAT gaps G-12-1/G-12-2)

## Context

This is a re-verification. The previous `12-VERIFICATION.md` (2026-08-10T17:49:52Z) passed all 5 roadmap success criteria and 12/12 requirement-mapped truths, but a subsequent UAT session (`12-UAT.md`) found the phase's own cold-start smoke test broken: five repeatable-tick workers registered their BullMQ job schedulers correctly and then never consumed a single job (G-12-1, blocker), and both ARCHITECTURE.md and SPECIFICATION.md described a runtime that didn't match (G-12-2, major). Gap-closure plans 12-12 and 12-13 were executed to close both gaps. This report re-verifies the 11 previously-verified plans by regression (full `apps/worker` suite run once, 404/404 passing; `tsc --noEmit` clean) and gives full three-level scrutiny to the two gap-closure plans' own must-haves.

## Goal Achievement

### Observable Truths — Regression Check on Previously-Verified Plans (12-01 through 12-11)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1-5 | The 5 roadmap success criteria verified in the prior report (tenant RPS isolation, per-tenant concurrency cap, bounded/resumable segment sweep, graceful SIGTERM drain + shared listeners, bounded failed-job retention + observable dead-letter path) | ✓ VERIFIED (regression) | Full `apps/worker` suite (61 files, 404 tests) passes in one run at current HEAD; `npx tsc -p apps/worker/tsconfig.json --noEmit` exits 0. No file underlying these truths was touched by the gap-closure plans except the five factories' `autorun` line (verified separately below) — spot-checked `send-dispatch.ts`, `tenant-lane-semaphore.ts`, `flow-segment-sweep-flow.worker.ts`, `queue-registry.ts`, `dead-letter-writer.ts` are untouched since the prior verification (`git log` shows no commits to these paths after `323051a`). |

### Observable Truths — Gap-Closure Plan 12-12 (G-12-1)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| D1 | Each of the five repeatable-tick workers, constructed exactly the way `server.ts` constructs it (single argument), actually starts its processing loop | ✓ VERIFIED | All five factories read directly: `campaign-scheduler.worker.ts:213`, `analytics-reconciliation.worker.ts:202`, `flows/flow-reconciliation.worker.ts:185`, `partition-maintenance.worker.ts:227`, `send-reconciler.worker.ts:423` all use `{ connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) }`. Cross-checked against BullMQ's own default-merge semantics by the fresh code review (`12-REVIEW.md`), which confirms via `node_modules/bullmq/dist/cjs/classes/worker.js` that an own `undefined` property previously clobbered the `true` default and that omitting the key is the correct fix. `worker-autorun-default.test.ts`'s production-shape case (5 fixtures) passes: `npx vitest run --root apps/worker src/queues/__tests__/worker-autorun-default.test.ts` → 8/8 pass (re-run live during this verification). |
| D2 | A job waiting on one of those tick queues is picked up and reaches the active state on a worker built with the production call shape | ✓ VERIFIED | The dedicated pickup case (`campaign-scheduler: a job sitting on its tick queue is picked up and reaches 'active'...`) passed in this verification's own live run, and again inside the full 404/404 suite run. The fresh code review flagged this specific case as flaky once in 3 full-suite runs (WR-02) — noted as a warning below, not disqualifying, since it passed in this verification's own full-suite run and the isRunning() assertion (an independent signal of the same fix) is stable across all 5 fixtures. |
| D3 | The test-only suppression of the run loop (`autorun: false`) still works when passed explicitly, so existing registration tests keep their meaning | ✓ VERIFIED | `worker-autorun-default.test.ts`'s explicit-suppression case passes; `scheduler-registration.test.ts` (20/20) and `partition-maintenance.worker.test.ts` (7/7) both pass unchanged — re-run live in this verification (27/27 combined). |
| D4 | A stack of identical tick jobs accumulated while a worker was not consuming drains to zero without failures **and** without duplicated side effects | ⚠️ PRESENT_BEHAVIOR_UNVERIFIED (split truth) | "Drains to zero waiting/active/failed" half: genuinely proven — the burst case stacks 20 real jobs on a suppressed worker's queue, then drains with a production-shape worker and asserts `vi.waitFor` reaches `{waiting:0, active:0, failed:0}` (passed live in this verification). "Without duplicated side effects" half: **not actually proven**. The test's own header comment (lines 296-301) states the ephemeral test database has zero campaign rows, so `findDueCampaignCandidates()` returns `[]` on every tick and the kickoff queue reads all-zero counts *regardless of whether the dedup logic works at all*. The fresh `12-REVIEW.md` (WR-03) independently reaches the identical conclusion and proposes the fix (seed one past-due campaign, assert `completed === 1` across the burst). See `behavior_unverified_items` and `human_verification`. |

### Observable Truths — Gap-Closure Plan 12-13 (G-12-2)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| D1 | The forward-looking section names only work that genuinely has not shipped — retention/dead-letter no longer listed there | ✓ VERIFIED | `ARCHITECTURE.md:229`: "Queue retention is no longer open either — plan 12-09 bounded `removeOnFail` to a 7-day age... What genuinely remains open is the queue's behaviour when its backing store reaches its memory ceiling." Plan's own verify command re-run live: `grep -q '^- \*\*Phase 12 — worker reliability.*memory ceiling' ARCHITECTURE.md && test "$(grep '^- \*\*Phase 12 — worker reliability' ARCHITECTURE.md | grep -c 'remain open')" -eq 0` exits 0. |
| D2 | The two documents agree with each other about failed-job retention and the dead-letter path | ✓ VERIFIED | ARCHITECTURE.md now cross-references `SPECIFICATION.md §5.3` instead of contradicting it; no remaining "remain open"/"unshipped" retention language found in either file's changed passages. |
| D3 | The worker-scheduling sections describe consumption as an observed fact backed by a named test, not an inference from a registration log line | ✓ VERIFIED | `SPECIFICATION.md` lines 625-641 read directly: names `worker-autorun-default.test.ts` explicitly, states "Регистрация scheduler'а и потребление джоб — два разных факта; чистый boot-лог доказывает только первый," and attributes the sixteen-workers claim to that test plus the G-12-1 runtime BZPOPMIN diagnosis rather than the boot log. Plan's verify command re-run live: `grep -q 'autorun' SPECIFICATION.md && grep -q 'worker-autorun-default.test.ts' SPECIFICATION.md && grep -q '12-12' SPECIFICATION.md` exits 0. |
| D4 | The as-built mechanism that makes the run loop start under the production call shape is written down where the next factory editor will read it | ✓ VERIFIED | `SPECIFICATION.md:625` documents the conditional-spread mechanism, names all five affected files, and names the two phases the pattern originated in and spread from. `git diff --stat 830ab19 HEAD -- ARCHITECTURE.md SPECIFICATION.md` → `ARCHITECTURE.md 2 +-`, `SPECIFICATION.md 9 +++++++++` — bounded, scoped edits confirmed live, matching both SUMMARYs' claims exactly. |

**Score:** 15/16 must-haves verified (11 regression-checked roadmap truths carried forward as a group + 4/4 of 12-12's D1-D4 with D4 split, counted as 3 full + 1 unverified + 4/4 of 12-13's D1-D4). 1 present-but-behavior-unverified (12-12 D4's duplication half).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/worker/src/queues/campaign-scheduler.worker.ts` | Conditional-spread `autorun`, corrected doc comment | ✓ VERIFIED | Line 213, doc comment lines 144-151 correctly state the omission mechanism |
| `apps/worker/src/queues/analytics-reconciliation.worker.ts` | Same fix | ✓ VERIFIED | Line 202 |
| `apps/worker/src/queues/flows/flow-reconciliation.worker.ts` | Same fix | ✓ VERIFIED | Line 185 |
| `apps/worker/src/queues/partition-maintenance.worker.ts` | Same fix | ✓ VERIFIED | Line 227 |
| `apps/worker/src/queues/send-reconciler.worker.ts` | Same fix + new registration-settled waiter | ✓ VERIFIED | Line 423; `waitForSendReconcilerRegistration`/`registrationSettled` WeakMap present (lines 372-384), registration captured into a named promise (line 435) rather than a bare `void` expression |
| `apps/worker/src/queues/__tests__/worker-autorun-default.test.ts` | Regression proof: production-shape case (5 fixtures) + pickup case + suppression case + burst case | ✓ VERIFIED (exists, substantive, wired) — ⚠️ one assertion within it is vacuous (see D4 above) | File exists, 8 tests, all pass live; imports and exercises all five factories with the exact production call shape |
| `ARCHITECTURE.md` | Forward-looking Phase 12 entry reduced to memory-ceiling item only | ✓ VERIFIED | Line 229, `git diff --stat` shows 1-line change |
| `SPECIFICATION.md` | §5.1/§5.2 re-verified against observed consumption | ✓ VERIFIED | Lines 625-641, 1095; `git diff --stat` shows 9-line addition |

### Key Link Verification

| From | To | Via | Status |
|------|-----|-----|--------|
| `apps/worker/src/server.ts` (composition root) | all five tick-worker factories | single-argument call shape | ✓ WIRED — confirmed both factories' signatures accept the shape and the regression test reproduces it literally |
| `worker-autorun-default.test.ts` | all five factories + their registration waiters | direct import and construction | ✓ WIRED |
| `SPECIFICATION.md` §5.1/§5.2 | `worker-autorun-default.test.ts` | cited by filename as the consumption evidence | ✓ WIRED |
| `ARCHITECTURE.md` forward-looking Phase 12 bullet | `SPECIFICATION.md` §5.3 | cross-reference for the shipped retention policy | ✓ WIRED |

### Behavioral Spot-Checks / Named-Test Runs (this verification session)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| G-12-1 fix, all 5 factories + pickup + suppression + burst | `vitest run --root apps/worker src/queues/__tests__/worker-autorun-default.test.ts` | 8/8 pass | ✓ PASS |
| Existing registration suites unaffected | `vitest run --root apps/worker src/queues/__tests__/scheduler-registration.test.ts src/queues/__tests__/partition-maintenance.worker.test.ts` | 27/27 pass | ✓ PASS |
| Full regression, whole `apps/worker` package (run once, per protocol) | `npm test --workspace=apps/worker` | 404/404 pass, 61 files | ✓ PASS |
| Type check | `npx tsc -p apps/worker/tsconfig.json --noEmit` | exit 0 | ✓ PASS |
| ARCHITECTURE.md forward-looking bullet check | plan's own verify grep | exit 0 | ✓ PASS |
| SPECIFICATION.md re-verification check | plan's own verify grep | exit 0 | ✓ PASS |
| Debt-marker scan on all 6 gap-closure files | `grep -nE "TBD\|FIXME\|XXX\|TODO\|HACK\|PLACEHOLDER"` + placeholder/coming-soon scan | no matches (exit 1) | ✓ PASS (clean) |
| Debt-marker scan on changed doc lines | `git diff` filtered for same markers | no matches | ✓ PASS (clean) |

Per protocol, the full suite and the on-demand load/failure-injection tests already proven live in the prior verification were **not** re-run in full here (one full-suite run budget already used above); their regression is covered by full-suite membership and by confirming no file underlying them was touched since the prior verification's commit.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| WRK-01 through WRK-11, WRK-13 | 12-01 through 12-11 (regression-checked), 12-12/12-13 (gap closure) | See prior verification for WRK-01–11 detail; unchanged and regression-confirmed here | ✓ SATISFIED | `.planning/REQUIREMENTS.md` lines 80-92 show all checked `[x]`, lines 219-231 show all "Complete." All 12 IDs required by this phase (WRK-01–11, WRK-13) accounted for — no orphans. |
| WRK-13 | 12-08, **12-12** | Centralized repeatable-job error handling + documented multi-instance constraint + (now) the run loop actually starting under production call shape | ✓ SATISFIED (with the D4 duplication caveat noted above as a test-coverage gap, not a requirement failure) | `upsertJobScheduler` + `attachSharedListeners` (prior verification) + `worker-autorun-default.test.ts` (this verification) |
| WRK-09 | 12-09, **12-13** (doc re-verification) | Bounded failed-job retention, now also documented consistently across both docs | ✓ SATISFIED | `ARCHITECTURE.md`/`SPECIFICATION.md` no longer contradict each other |

No orphaned requirements.

### Anti-Patterns Found

None. Debt-marker scan (`TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER`, plus "placeholder"/"coming soon"/"not yet implemented"/"not available") over all six gap-closure-touched source/test files and the changed lines in both documentation files returned zero matches.

### Code Review Warnings (from the fresh 12-REVIEW.md scoped to plans 12-12/12-13, disposition below)

The code review that ran at the end of this gap-closure wave (`12-REVIEW.md`, `status: issues_found`, 0 critical / 3 warning / 2 info) independently confirms the production fix is correct, and its three warnings are all about the new regression test's own quality — not the production code:

- **WR-01** (test leak): the `describe.each` case and the dedicated pickup case both leak `campaign-scheduler`'s long-lived kickoff producer queue (only the burst case closes it correctly). A plausible contributor to an observed full-suite flake. Real, confirmed leak; does not affect production-code correctness. This verification's own full-suite run passed cleanly (404/404), so the leak did not manifest here, but it is a latent CI-reliability risk worth fixing.
- **WR-02** (flaky pickup assertion): the one test proving actual job pickup (not just `isRunning()`) timed out once in 3 full-suite runs during the reviewer's testing. Passed in this verification's own live run and full-suite run. Likely related to WR-01's leak. Not disqualifying on its own since the underlying `isRunning()` signal for all 5 fixtures is stable, but flagged as a follow-up.
- **WR-03** (vacuous duplication assertion): already elevated above to a `behavior_unverified_items` entry rather than left as a mere warning, since it directly concerns one of the plan's own stated must-haves (D4's "without duplicated side effects" clause).

None of these three reopens the underlying autorun fix, which the reviewer independently verified correct by cross-checking BullMQ's own source.

### Human Verification Required

1. **Live backlog drain observation (12-12's own D5 human-check).** Boot the worker process against the real development Redis instance that held the originally-reported backlog (partition-maintenance: 107 waiting) and watch for a few minutes: the five tick queues' waiting counts should fall toward zero, `active` events should appear on all five, nothing should land in the failed set. Neither gap-closure executor nor this verification had access to that environment. `SPECIFICATION.md` itself now explicitly flags this as a separate, unperformed step.
2. **No-duplication proof for the burst-absorption test (12-12 D4).** The current burst test's "without duplicated side effects" assertion is vacuous (empty campaigns table). A maintainer should decide whether to land WR-03's proposed fix (seed one past-due campaign, assert `completed === 1` across the burst) before treating this specific sub-claim as proven, or accept the underlying mechanism (deterministic `jobId`, `FOR UPDATE SKIP LOCKED` re-check) as sufficient by design given it is an established, previously-verified pattern elsewhere in this codebase.

### Gaps Summary

No FAILED truths, no missing/stub/unwired artifacts, no debt markers. The phase's core defect (G-12-1, the autorun clobber) is genuinely fixed and independently corroborated three ways: direct code reading of all five factories, a fresh code reviewer's BullMQ-source cross-check, and a live re-run of the regression suite plus the full 404-test `apps/worker` package in this verification session. The documentation gap (G-12-2) is genuinely closed: both files were read directly and no longer contradict each other or describe unshipped work as shipped (or vice versa).

Two items keep this from a clean `passed`: one outstanding human observation the plan itself flagged as unperformed (D5, live Redis backlog drain), and one test-coverage gap freshly surfaced by the phase's own post-gap-closure code review (the burst test's duplication claim is vacuous, confirmed independently in this verification). Both are `human_needed` items, not blockers — the underlying production code is sound by direct reading and by the mechanisms it relies on (BullMQ job-scheduler default semantics, deterministic jobId collision, per-row exclusive re-check), but neither claim has been proven live/behaviorally in the way its own must-have specified.

---

_Verified: 2026-08-11T05:24:47Z_
_Verifier: Claude (gsd-verifier)_
