---
phase: 14-deployment-database-durability
plan: 09
subsystem: infra
tags: [deploy, docker-compose, bash, readyz, rollback, tdd, runbook]

requires:
  - phase: 14-deployment-database-durability
    provides: docker-compose.prod.yml with the migrate one-shot profile and service names, /readyz on api and worker (plans 14-08, 14-01, 14-04)
provides:
  - scripts/deploy.sh — one-command, readiness-gated, fail-before-replace deploy taking a full-SHA argument plus --dry-run and --rollback-to
  - docs/runbooks/deploy-and-rollback.md — deploy/rollback operator runbook
  - A real first deploy, second deploy and rollback performed against the production VPS
affects: [phase-16-uat]

tech-stack:
  added: []
  patterns:
    - "Deploy ordering asserted by a dry-run test (one command per line, no side effects) rather than trusted by inspection — same class as scripts/print-stop-grace-period.mjs's machine-readable output"
    - "PATH-injected compose stub for exit-code-dependent test assertions, no test-only branch in the script itself"

key-files:
  created:
    - scripts/deploy.sh
    - scripts/__tests__/deploy-script.test.mjs
    - docs/runbooks/deploy-and-rollback.md
  modified:
    - package.json

key-decisions:
  - "Worker replaced stop-old-then-start-new (R-05) with an explicit gone-check between; readiness observed via container health status (loopback-only health port per 14-04), not an HTTP call from the host"
  - "Rollback reuses the same deploy sequence against an older SHA, printing a migration-tier warning rather than deciding the tier itself — the runbook, not the script, is where that judgement is made"

requirements-completed: [OPS-02, OPS-03]

coverage:
  - id: D1
    description: "scripts/deploy.sh — readiness-gated, fail-before-replace deploy with dry-run, argument validation, previous-SHA record, and stop-old-then-start-new worker replacement"
    requirement: "OPS-02"
    verification:
      - kind: unit
        ref: "scripts/__tests__/deploy-script.test.mjs (ordering, argument-validation, migrate-abort, readiness-timeout assertions)"
        status: pass
      - kind: other
        ref: "bash -n scripts/deploy.sh"
        status: pass
    human_judgment: false
  - id: D2
    description: "docs/runbooks/deploy-and-rollback.md — deploy/rollback decision procedure with per-stage failure handling"
    requirement: "OPS-03"
    verification:
      - kind: other
        ref: "test -f docs/runbooks/deploy-and-rollback.md && grep -q 'migration-tiers|migration-rollback' && grep -q 'dry-run' && grep -qi 'rollback'"
        status: pass
    human_judgment: false
  - id: D3
    description: "First real deploy, a second deploy, and a rollback performed on the production VPS — the four things automation cannot establish (real host, real domain, real ACME cert, real GHCR pull)"
    requirement: "OPS-02"
    verification: []
    human_judgment: true
    rationale: "Blocking checkpoint (Task 3) — requires a real production host, DNS and GHCR credentials the executor sandbox does not have. Operator performed steps 1-10 of the checkpoint's how-to-verify and reported 'approved' with no runbook defects."

duration: —
completed: 2026-08-14
status: complete
---

# Phase 14 Plan 09: Deploy Script and Runbook Summary

**One-command readiness-gated deploy (`scripts/deploy.sh`) with fail-before-replace migrate ordering, stop-old-then-start-new worker replacement, and a documented rollback — verified end-to-end with a real first deploy, second deploy and rollback on the production VPS.**

## Performance

- **Tasks:** 3 (Task 1 TDD, Task 2 docs, Task 3 blocking checkpoint)
- **Files modified:** 4 (scripts/deploy.sh, scripts/__tests__/deploy-script.test.mjs, package.json, docs/runbooks/deploy-and-rollback.md)

## Accomplishments

- **Task 1:** `scripts/deploy.sh` — takes a full-length hex git SHA as its required argument plus `--dry-run` and `--rollback-to`. Strict shell error handling (unset-variable, pipeline-failure detection). Argument validated against a full-SHA pattern; branch names and `latest` rejected by name. Stage ordering: read/record previous SHA -> pull all three SHA-tagged images -> resolve worker stop-grace-period via `print-stop-grace-period.mjs` -> `docker compose run --rm migrate` with an explicit exit-code check (never a `depends_on` completion condition, per RESEARCH.md Pitfall C) -> bring up `web`/`api` -> poll `/readyz` with a bounded timeout, no fixed sleep -> stop the old worker, confirm it is gone, start the new one, wait on its container health status (the health port is loopback-only per plan 14-04, so the container's own healthcheck is the observation channel, not an HTTP call from the host). Previous-SHA record file written before any replacement; rollback command printed on both success and failure paths. `--rollback-to` runs the same sequence against an older SHA and prints an unmissable migration-tier warning before starting, without attempting to decide the tier itself. `scripts/__tests__/deploy-script.test.mjs` drives the dry run and asserts every ordering property plus argument-validation rejections; the migrate-failure-aborts-before-replacement property is asserted with a PATH-injected compose stub, no test-only branch in the script. `test:deploy-script` registered in root `package.json`.
- **Task 2:** `docs/runbooks/deploy-and-rollback.md` — how to deploy (exact command, dry-run form, D-04's operator-triggered-by-decision philosophy, CI-auto-deploy rejected-for-now with its revisit trigger), per-stage failure handling (pull/migrate/readiness/worker-replace, each naming system state and next action — migrate failure calls out the dead-session check against the migration advisory lock before assuming it's stuck), how to roll back (consult `packages/db/src/migration-tiers.ts` first; auto-reversible-only means the rollback is a redeploy, any forward-only migration sends the operator to the restore-drill runbook instead — a judgement the operator makes with both documents open, not something the script decides), the pre-deploy checklist and post-deploy verification steps, and the previous-SHA record file's location.
- **Task 3 (blocking checkpoint — human-verify):** Operator confirmed on 2026-08-14, via the checkpoint prompt, that all ten how-to-verify steps were performed successfully on the real production VPS:
  1. Dry-run read matched the runbook's documented sequence.
  2. Real deploy (`./scripts/deploy.sh <sha>`) exited 0.
  3. Public HTTPS served the SPA with a real (non-self-signed) certificate.
  4. `/healthz` and `/readyz` both returned 200 on the public hostname, with all three `/readyz` checks passing.
  5. `docker compose -f docker/docker-compose.prod.yml ps` showed every container healthy, including the worker.
  6. The migrate service was not present as a long-lived container.
  7. The previous-SHA record file existed and held the correct pre-deploy SHA.
  8. A second, newer SHA was deployed with the API staying available throughout except for the expected worker pause.
  9. `./scripts/deploy.sh --rollback-to <first-sha>` served the earlier build with no rebuild step.
  10. No manual step outside the runbook was required — no runbook defect reported.

## Task Commits

Each task was committed atomically:

1. **Task 1: deploy script with readiness-gated, fail-before-replace ordering (TDD)** - `90d33c6` (feat)
2. **Task 2: deploy and rollback runbook** - `e6d339b` (docs)
3. **Task 3: first real deploy, second deploy and rollback on the production host** - checkpoint approved by operator 2026-08-14, no code change (recorded in this SUMMARY)

Also relevant post-review hardening on this plan's artifacts, landed on the branch before this checkpoint resolved:
- `121cd59` — WR-05: fail loud on TARGET_SHA tree mismatch
- `7ebf3d7` — WR-07: web healthcheck + deploy-time readiness gate

**Plan metadata:** committed together with this SUMMARY.md (see below).

## Files Created/Modified

- `scripts/deploy.sh` - Readiness-gated, fail-before-replace deploy script (SHA argument, `--dry-run`, `--rollback-to`)
- `scripts/__tests__/deploy-script.test.mjs` - Ordering, argument-validation and migrate-abort assertions against the dry-run output
- `package.json` - `test:deploy-script` script registered
- `docs/runbooks/deploy-and-rollback.md` - Deploy/rollback operator runbook

## Decisions Made

- Worker replaced stop-old-then-start-new (R-05) with an explicit "confirmed gone" step between stop and start — a short queue pause is safe, two workers running incompatible dispatch code is not.
- Worker readiness observed through the container's own health status rather than an HTTP call from the host, because plan 14-04 recorded the worker's health port as loopback-only and deliberately unpublished.
- `--rollback-to` reuses the exact same deploy sequence against an older SHA and prints a migration-tier warning rather than deciding the tier itself; the runbook — not the script — is where the redeploy-vs-restore judgement is made, consulting `packages/db/src/migration-tiers.ts`.

## Deviations from Plan

None - plan executed exactly as written, including its TDD gate for Task 1 and the blocking human-verify checkpoint for Task 3.

## Issues Encountered

None. The operator reported no runbook defects during the real-host verification (checkpoint step 10 explicitly asks for this).

## User Setup Required

None beyond what plan 14-08's `user_setup` already established (SSH access, Docker Compose v2, domain resolution, populated `MEGA_CRM_ENV_FILE`, `docker login ghcr.io`) — all confirmed present and used during the real deploy.

## Next Phase Readiness

- OPS-02 and OPS-03 are closed: deploy is a single reproducible command gated on `/readyz`, verified against a real host; rollback is the same command with the previous SHA, verified with an actual rollback that served the earlier build with no rebuild step.
- The deploy-and-rollback runbook is proven against real operator use, not just reviewed in the abstract — no defects surfaced.
- The other two pending real-host checkpoints (14-10 backups, 14-11 restore drill) remain open per STATE.md's Pending Checkpoints section; 14-09's bullet is removed by this SUMMARY's tracking-update commit.

## Self-Check: PASSED

- FOUND: `scripts/deploy.sh`
- FOUND: `scripts/__tests__/deploy-script.test.mjs`
- FOUND: `docs/runbooks/deploy-and-rollback.md`
- FOUND: commit `90d33c6` (Task 1)
- FOUND: commit `e6d339b` (Task 2)
- Task 3 has no commit of its own (checkpoint approval, no code) — recorded here per the plan's blocking-checkpoint convention.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-14*
