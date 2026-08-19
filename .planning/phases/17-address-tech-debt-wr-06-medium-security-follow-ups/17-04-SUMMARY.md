---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
plan: 04
subsystem: infra
tags: [bash, restore-drill, pgbackrest, ghcr, docker, ndjson]

requires:
  - phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
    provides: "plan 17-03's CI-built, GHCR-published megacrm-postgres image and the exact ${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG} reference docker/docker-compose.prod.yml now pulls"
provides:
  - "scripts/restore-drill.sh self-records restore-to-ready duration and scratch-PGDATA disk high-water mark on every run (success AND readiness-timeout paths), printed inline and appended as NDJSON to RESTORE_DRILL_METRICS_FILE"
  - "The drill launches the same CI-built GHCR postgres image production runs (no :-local fallback), with :?-guarded GHCR_IMAGE_BASE/POSTGRES_IMAGE_TAG"
  - "docs/runbooks/restore-drill.md describes the self-recorded figures and the new GHCR-image prerequisite instead of asking the operator to observe/remember them"
affects: ["17-05 (live restore drill checkpoint fills the metrics placeholder this plan removed and exercises the new GHCR-image guard live)"]

tech-stack:
  added: []
  patterns:
    - "Script-level (non-local) accumulator variable for cross-function state that must survive a helper function returning, guarded assignment (`x=\"$(...)\" || true`, not `local x=\"$(...)\"`) so a sampling command's failure under `set -Eeuo pipefail` can never abort the caller"
    - "In-container `docker exec ... du -sk` sampling instead of host-side `docker volume inspect` mountpoint access, mirroring the existing `docker exec ... pg_isready` precedent for the same host-permission reason"

key-files:
  created: []
  modified:
    - scripts/restore-drill.sh
    - scripts/__tests__/restore-drill-script.test.mjs
    - docs/runbooks/restore-drill.md

key-decisions:
  - "record_disk_sample() samples before the readiness check inside wait_for_scratch_ready's existing loop, plus once more at each of the function's two return points (success and timeout) -- guarantees at least one sample even on a single-iteration happy path, without a second polling loop or inlining the timeout-failure branch"
  - "write_drill_metrics() is called from exactly two sites in run_real_drill: the readiness-timeout branch (before its existing message/cleanup/exit 1) and the success branch (before teardown) -- never from the initial docker-run-failed or verification-failed branches, matching the plan's exact scope"
  - "outcome field uses \"verified\" (success) and \"readiness_timeout\" (timeout) as the two recorded labels"
  - "GHCR_IMAGE_BASE/POSTGRES_IMAGE_TAG guards placed immediately after the existing POSTGRES_PASSWORD guard, i.e. AFTER MEGA_CRM_ENV_FILE is sourced, so an operator env file is a legitimate place to define them"

requirements-completed: []

coverage:
  - id: D1
    description: "restore-drill.sh records duration and disk high-water on both the success and readiness-timeout paths, printed inline and appended as one NDJSON line per run to RESTORE_DRILL_METRICS_FILE"
    verification:
      - kind: unit
        ref: "scripts/__tests__/restore-drill-script.test.mjs > real invocation: self-recorded duration and disk high-water metrics (T-17-18) (5/5 pass: success record, inline print, high-water-is-max, timeout still records, sampler-failure non-fatal)"
        status: pass
    human_judgment: false
  - id: D2
    description: "wait_for_scratch_ready keeps its existing return-0/return-1 contract; the timeout branch's message text, cleanup command and exit code are unchanged"
    verification:
      - kind: other
        ref: "grep -c '^wait_for_scratch_ready() {' scripts/restore-drill.sh (1); message/cleanup-command text diffed byte-identical against the pre-plan file at commit 383bc29"
        status: pass
    human_judgment: false
  - id: D3
    description: "The drill launches ${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG} (no :-local fallback), matching docker/docker-compose.prod.yml exactly, with fail-loud :?-guarded variables and no apostrophe in either guard message"
    verification:
      - kind: unit
        ref: "scripts/__tests__/restore-drill-script.test.mjs > real invocation: required environment is enforced before touching anything > missing-GHCR_IMAGE_BASE / missing-POSTGRES_IMAGE_TAG cases (2/2 pass, no docker run in call log)"
        status: pass
      - kind: other
        ref: "grep -o 'postgres:\\${POSTGRES_IMAGE_TAG[^\"}]*}' scripts/restore-drill.sh docker/docker-compose.prod.yml -- both print postgres:${POSTGRES_IMAGE_TAG}"
        status: pass
    human_judgment: false
  - id: D4
    description: "docs/runbooks/restore-drill.md's prerequisites, step 8, cadence paragraph and 'what was NOT verified locally' list describe the self-recorded metrics and the GHCR-image prerequisite instead of asking the operator to observe/remember figures"
    verification: []
    human_judgment: true
    rationale: "Documentation-quality/accuracy judgment -- no automated check asserts prose content beyond the grep-count acceptance criteria already covered under D1/D3 (grep -c 'Record the wall-clock duration' returns 0; RESTORE_DRILL_METRICS_FILE/restore-drill-history.ndjson both present)"

duration: ~25min
completed: 2026-08-19
status: complete
---

# Phase 17 Plan 04: Restore-drill self-recorded metrics + CI-built GHCR image (D-09, T-17-19) Summary

**`scripts/restore-drill.sh` now records its own restore-to-ready duration and scratch-PGDATA disk high-water mark on every run (success and readiness-timeout paths alike) and launches the same CI-built GHCR postgres image production runs, refusing to start on a missing tag instead of falling back to a stale local image.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2 (Task 1 was TDD: 5 new tests written and observed failing before instrumenting the script, then GREEN)
- **Files modified:** 3

## Accomplishments

- `record_disk_sample()` samples the scratch container's PGDATA disk usage **in-container** (`docker exec ... du -sk`), never via the volume's host-side mountpoint, guarded so a sampling failure can never abort the drill under `set -Eeuo pipefail`
- `write_drill_metrics()` appends one NDJSON line per run to `RESTORE_DRILL_METRICS_FILE` (same `XDG_STATE_HOME`-under-`$HOME` convention `RESTORE_DRILL_BASELINE_FILE` already uses) and prints the duration + disk high-water figures inline, satisfying the runbook's own pre-existing (previously false) step-8 claim
- Both figures are recorded on the readiness-timeout failure path too -- `wait_for_scratch_ready` keeps its existing function shape and return-0/return-1 contract unchanged; its timeout branch's message text, cleanup command and exit code are byte-identical to before
- The recorded disk high-water is a true maximum across all polled samples, not the last sample (proven by Test 3's strictly-decreasing stubbed sequence)
- The drill now launches `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` -- the exact reference plan 17-03 put into `docker/docker-compose.prod.yml` -- with the `:-local` fallback deleted entirely and two `:?`-guarded variables that fail loudly (no apostrophe, per this file's own documented bash 3.2 pitfall) before any scratch container is created
- `docs/runbooks/restore-drill.md` updated: prerequisites gain a third item (GHCR image variables + published-SHA requirement), step 8 and the cadence paragraph describe the self-recorded history file instead of instructing the operator to observe/remember figures, and "what was NOT verified locally" no longer claims duration/disk-high-water require a human to notice them

## Task Commits

Each task was committed atomically:

1. **Task 1: Self-recorded duration and disk high-water, on both the success and the timeout path** - `115ec34` (feat, TDD RED->GREEN in one commit)
2. **Task 2: Drill launches the CI-built GHCR image, fail-loud; runbook stops asking the operator to observe the figures** - `cebc79e` (feat)

_Note: this plan runs in a worktree -- the plan-metadata commit (SUMMARY.md) is committed separately by this same agent; STATE.md/ROADMAP.md are updated centrally by the orchestrator after merge, not here._

## Files Created/Modified

- `scripts/restore-drill.sh` - `METRICS_FILE`, `DRILL_DISK_HIGH_WATER_KB` (script-level accumulator), `record_disk_sample`, `write_drill_metrics`; `wait_for_scratch_ready` samples before each readiness check and once more at each return point; `run_real_drill` captures a start epoch before `docker run` and calls `write_drill_metrics` on the readiness-timeout and success branches; `print_dry_run` enumerates the two new commands; the real `docker run`'s image argument is now `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` guarded by two `:?` checks placed after the existing `POSTGRES_PASSWORD` guard
- `scripts/__tests__/restore-drill-script.test.mjs` - `docker` stub gains a `du -sk` branch (driven by `DRILL_TEST_DISK_KB_SEQUENCE`, repeats the last value once exhausted, emits nothing on a scripted failure) and a `pg_isready` branch honoring `DRILL_TEST_READY_FAIL_COUNT`; `makeScratch()`/`baseRealEnv()` gain a `metricsFile` + `readMetricsLines()` helper and a SHA-shaped `GHCR_IMAGE_BASE`/`POSTGRES_IMAGE_TAG` pair in the scratch env file; 7 new tests (5 for the metrics record, 2 for the missing-GHCR-variable guards)
- `docs/runbooks/restore-drill.md` - Prerequisites item 3, "How to run it"'s environment paragraph, step 8, the cadence/record-keeping paragraph, and "what was NOT verified locally" all updated to describe the self-recorded metrics file and the GHCR-image requirement

## Decisions Made

- `record_disk_sample` is called from inside `wait_for_scratch_ready`'s existing loop **before** the readiness check (guaranteeing at least one sample even on a single-poll happy path) and once more at each of the function's two `return` statements -- no second polling loop, no inlining of the timeout branch (RESEARCH.md's own sketch explicitly warned inlining drops that branch)
- `DRILL_DISK_HIGH_WATER_KB` is declared at script top level, not `local`, specifically so its value survives `wait_for_scratch_ready` returning back into `run_real_drill`
- The disk-sample assignment uses the `sample_kb="$(...)" || true` form (guard on the *statement*, not merely inside the substitution) -- `local sample_kb="$(...)"` combined declaration+assignment is a documented bash gotcha where `set -e` can still fire through the substitution's own failure
- `write_drill_metrics` is invoked from exactly the two branches the plan named (readiness-timeout, success) -- not from the "docker run failed to start" or "verification failed" branches, since those aren't in scope and the plan's own acceptance criteria don't test them
- `GHCR_IMAGE_BASE`/`POSTGRES_IMAGE_TAG` guards sit immediately after the existing `POSTGRES_PASSWORD` guard (i.e. after `MEGA_CRM_ENV_FILE` is sourced) so an operator's env file is a legitimate place to define them, matching the plan's explicit placement instruction

## Deviations from Plan

None - plan executed exactly as written. All six behavioral tests from Task 1's `<behavior>` block and both new guard tests from Task 2 were added; no architectural changes were needed.

## Issues Encountered

- `npm run verify:prod-compose` initially failed in this worktree with `stop-grace-period-undeterminable` because `apps/worker/dist/shutdown-budget.js` didn't exist (worker not yet built in this fresh worktree) -- the same pre-existing environment gap plan 17-03's SUMMARY documented. Ran `npm run build -w apps/worker` (build artifact only, not committed; gitignored) and `verify:prod-compose` then passed cleanly (8 services, 61 invariants, 0 violations).
- Needed `node_modules` to run `npx vitest`; symlinked it from the main checkout for the duration of this plan's work and removed the symlink before returning (per worktree hygiene rules).

## Real metrics NDJSON example (produced by a standalone script-level invocation against the PATH-injected stubs, not the automated test suite)

```json
{"target":"2026-08-13 04:27:54+00","outcome":"verified","durationSeconds":1,"diskHighWaterKb":245760,"recordedAt":"2026-08-19T12:01:54Z"}
```

Corresponding inline stdout line from the same run:

```
restore-drill.sh: recorded drill metrics -- duration: 1s, disk high-water (scratch PGDATA): 245760KB (target=2026-08-13 04:27:54+00, outcome=verified, history=<scratch-dir>/metrics.ndjson).
```

## Image reference match confirmation

`grep -o 'postgres:\${POSTGRES_IMAGE_TAG[^"}]*}' scripts/restore-drill.sh docker/docker-compose.prod.yml` prints `postgres:${POSTGRES_IMAGE_TAG}` for every match in both files -- the drill and production compose reference the identical `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` form, with no divergence.

## Readiness-timeout branch byte-identity confirmation

Diffed against `scripts/restore-drill.sh` at commit `383bc29` (this plan's own base):
- `echo "restore-drill.sh: READINESS TIMEOUT after ${READY_TIMEOUT_SECONDS}s -- scratch resources left in place for inspection." >&2` -- identical text, unchanged.
- `print_cleanup_command`'s echoed cleanup command -- identical text, unchanged.
- Exit-code count (`exit 1` occurrences) -- unchanged (13 in both versions); the timeout branch still calls `exit 1` at the same relative position, now preceded only by the new `write_drill_metrics` call.

## User Setup Required

None - no external service configuration required. Operationally: this plan does not itself run a live drill (plan 17-05's human-gated checkpoint does); once that checkpoint runs, the operator's `MEGA_CRM_ENV_FILE` must already carry `GHCR_IMAGE_BASE`/`POSTGRES_IMAGE_TAG` (it should, per plan 17-03/17-05's own operational sequencing) or the drill will now refuse to start rather than silently using a stale local image.

## Next Phase Readiness

- Plan 17-05's live restore drill checkpoint can now exercise both new behaviors for real: it will produce a genuine metrics NDJSON entry (filling T-14-73's long-open placeholder with a real figure instead of "TO BE RECORDED"), and it will prove the fail-loud GHCR-image guard against the operator's actual env file.
- No blockers. `bash -n scripts/restore-drill.sh` exits 0; `npx vitest run scripts/__tests__/restore-drill-script.test.mjs` passes 26/26; `npm run verify:prod-compose` passes 61/61 invariants; `git status --porcelain` shows no drill artifact written into the repository tree after the suite runs.

---
*Phase: 17-address-tech-debt-wr-06-medium-security-follow-ups*
*Completed: 2026-08-19*
