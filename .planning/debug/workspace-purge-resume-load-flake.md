---
status: verifying
trigger: "PR #37 aggregate CI: workspace-purge double-resume remains purging"
created: 2026-08-28
updated: 2026-08-28
---

## Symptoms

- Expected: after the real-SIGKILL `before_tail` scenario, the next `processWorkspacePurge()` tick completes the record.
- Actual: aggregate coverage CI run 33177671540 job 98870409442 left the subject at `status='purging'`; the dedicated failure-injection job on the same commit passed.
- Deterministic evidence: `killAndAwaitExit()` proves the child process exited, but PostgreSQL may not yet have processed the dead socket and released its session advisory lock. `runWorkspacePurgeWalk()` deliberately treats a held lock as a successful skip, so the test's first resume call can resolve without doing work.
- Known history: Phase 22 deferred items recorded this test family as load-flaky; the exact lock-release race was not closed.

## Investigation

hypothesis: the test harness mistakes child-process exit for PostgreSQL advisory-lock release; aggregate load widens that cleanup window.
test: add a bounded PostgreSQL-native barrier after SIGKILL that blocks on the exact purge advisory lock, immediately unlocks it, and only then permits the resume tick.
expecting: the existing unchanged `status === 'complete'` assertion passes under aggregate CI; the dedicated 8-case real-SIGKILL suite remains green.
next_action: GREEN locally — the PostgreSQL-native advisory-lock barrier is implemented and the dedicated real-SIGKILL suite passes 8/8. Push to PR #37 and require the full aggregate CI rerun that produced the original failure; resolve only when that job is green.

## Resolution

root_cause: `killAndAwaitExit()` proves the child OS process is gone, but PostgreSQL releases a session advisory lock only after its backend processes the closed socket. Under aggregate coverage load, the immediate resume tick could win that race, observe `pg_try_advisory_lock=false`, and follow the production-correct skip path without throwing. The test then read the unchanged `purging` record. The dedicated failure-injection lane usually gave PostgreSQL enough time, which is why the same commit passed there.
fix: after every real SIGKILL, the harness opens a separate database session, applies a bounded 5-second server-side statement timeout, blocks on the exact `pg_advisory_lock(namespace, hashtext(workspaceId))`, immediately unlocks it, and only then returns to the resume scenario. This waits on the causal event rather than adding a timer or weakening the assertion.
verification:
  - original RED: PR #37 aggregate CI run 33177671540 job 98870409442, `status` received `purging` instead of `complete` at line 633.
  - local GREEN: `npm run failure:workspace-purge-resume` against a throwaway Redis DB1 — 1 file, 8/8 tests passed in 6.59s.
  - lint: touched test file passed ESLint.
  - pending: PR #37 aggregate CI `test` rerun.
