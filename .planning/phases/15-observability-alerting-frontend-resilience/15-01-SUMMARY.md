---
phase: 15-observability-alerting-frontend-resilience
plan: 01
subsystem: infra
tags: [sentry, bull-board, pino, fastify, npm-workspaces, package-lockfile, observability]

# Dependency graph
requires:
  - phase: 14-deployment-database-durability
    provides: "npm-10-compatible package-lock.json guard (scripts/check-lockfile-npm10.mjs) and the node:22-slim Docker image pins this plan's lockfile regeneration relies on"
provides:
  - "apps/api, apps/worker, apps/web, packages/redaction all carry the Sentry/Bull Board/pino dependencies later Phase 15 plans need, at human-verified exact versions"
  - "apps/worker's fastify promoted from devDependency to dependency, unblocking plan 15-10's Bull Board HTTP listener"
  - "package-lock.json mutated exactly once for the whole phase, npm-10-clean"
affects: [15-04, 15-05, 15-06, 15-10]

# Tech tracking
tech-stack:
  added:
    - "@sentry/node 10.70.0 (apps/api, apps/worker dependencies; packages/redaction devDependency for type-only beforeSend signature)"
    - "@sentry/react 10.70.0 (apps/web dependency)"
    - "@bull-board/api 8.6.1 (apps/worker dependency)"
    - "@bull-board/fastify 8.6.1 (apps/worker dependency)"
    - "pino 10.3.1 (apps/worker dependency, matches apps/api's existing pin)"
  patterns:
    - "All phase-wide npm installs consolidated into one wave-1 plan to avoid concurrent-install lockfile corruption (Phase 8 precedent)"
    - "package-lock.json regenerated under npm 10 via `npx --yes npm@10 install --package-lock-only --ignore-scripts` after a dev-npm-11 install, per scripts/check-lockfile-npm10.mjs's own remediation"

key-files:
  created: []
  modified:
    - apps/worker/package.json
    - apps/api/package.json
    - apps/web/package.json
    - packages/redaction/package.json
    - package-lock.json
    - SPECIFICATION.md
    - docker/redis.conf

key-decisions:
  - "Human legitimacy checkpoint (Task 1) approved all four SUS-verdict packages plus the ASSUMED-fallback pino/fastify pair, versions re-read live against the registry rather than copied from RESEARCH.md"
  - "packages/redaction gains @sentry/node as devDependency ONLY (type-only ErrorEvent/EventHint import) to preserve its no-runtime-dependency design principle"
  - "docker/redis.conf's maxmemory-sizing-to-production comment corrected to point at the SCALE milestone item (alongside deferred PgBouncer D-09/DB-14/SCALE-02), not Phase 15 -- no OPS-06..19 requirement covers VPS sizing"
  - "Migration 0058's reputation-dashboard-deferred-to-Phase-15 comment cannot be edited (applied migration); correction recorded instead in SPECIFICATION.md section 8 as an unscheduled item"

patterns-established:
  - "SPECIFICATION.md section 2 gets a per-phase dependency-landing subsection (2.6 for Phase 14, 2.7 for Phase 15) summarizing what a phase's install wave added, in addition to updating each workspace's own table rows"

requirements-completed: [OPS-06, OPS-08, OPS-14]

coverage:
  - id: D1
    description: "All phase-15 third-party dependencies (Sentry x3, Bull Board x2, pino) installed at human-verified versions across the correct workspaces, with fastify promoted to a runtime dependency in apps/worker"
    requirement: "OPS-06"
    verification:
      - kind: other
        ref: "npm ls @sentry/node @sentry/react @bull-board/api @bull-board/fastify pino fastify --workspaces"
        status: pass
    human_judgment: false
  - id: D2
    description: "package-lock.json is valid under the npm major actually bundled by the production node:22-slim image (npm 10), not just under the dev npm 11 used to run the installs"
    requirement: "OPS-08"
    verification:
      - kind: other
        ref: "npm run check:lockfile-npm10"
        status: pass
    human_judgment: false
  - id: D3
    description: "SPECIFICATION.md section 2 documents every newly declared package with its exact package.json version, per CLAUDE.md's doc-obligation rule; no application source file changed (installs/manifest only)"
    requirement: "OPS-14"
    verification:
      - kind: other
        ref: "git diff --stat c07d202 HEAD -- . ':!.planning' (touches only package.json files, package-lock.json, SPECIFICATION.md, docker/redis.conf)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Human confirmed each SUS-verdict package's legitimacy against its public npm registry page before install (blocking, non-auto-approvable checkpoint)"
    verification: []
    human_judgment: true
    rationale: "Package-legitimacy verification is an explicit blocking-human gate by design (T-15-SC) -- automation cannot substitute for a human confirming a registry page. Recorded here as already satisfied: the checkpoint was approved before this continuation session began (see checkpoint_state in the executor prompt)."

# Metrics
duration: ~35min (this continuation session; Task 1's human-verify checkpoint pause from the prior session is excluded)
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 01: Dependency Landing Summary

**Installed Sentry (node+react), Bull Board (api+fastify), and pino across apps/api, apps/worker, apps/web, and packages/redaction in one human-gated lockfile mutation, promoting apps/worker's fastify from dev to runtime dependency.**

## Performance

- **Duration:** ~35 min (continuation session only; the plan's Task 1 blocking-human checkpoint spanned a prior executor session and an out-of-band human approval)
- **Completed:** 2026-08-15T10:23:30Z
- **Tasks:** 3 (Task 1 satisfied by prior human approval; Task 2 and Task 3 executed and committed this session)
- **Files modified:** 7 (`apps/worker/package.json`, `apps/api/package.json`, `apps/web/package.json`, `packages/redaction/package.json`, `package-lock.json`, `SPECIFICATION.md`, `docker/redis.conf`)

## Accomplishments
- Landed every third-party dependency the rest of Phase 15 needs (`@sentry/node`, `@sentry/react`, `@bull-board/api`, `@bull-board/fastify`, `pino`) at the exact versions the human confirmed live against the npm registry in Task 1
- Promoted `apps/worker`'s `fastify` from `devDependencies` to `dependencies` (version unchanged, 5.9.0) to unblock plan 15-10's Bull Board HTTP listener
- Regenerated `package-lock.json` under npm 10 (the major bundled by `node:22-slim`, the production image pin) after installing under the dev environment's npm 11, so `npm run check:lockfile-npm10` passes — the exact guard Phase 14 built to catch this class of drift
- Documented every newly declared package in `SPECIFICATION.md` section 2 (new §2.7 subsection plus per-workspace table rows), satisfying `.claude/CLAUDE.md`'s binding doc-obligation rule in the same change
- Corrected two stale "Phase 15 owns this" pointers discovered in-repo (`docker/redis.conf`'s `maxmemory` comment, and migration `0058`'s reputation-dashboard comment) so they don't surface as gaps at phase verification

## Task Commits

Each task was committed atomically:

1. **Task 1: Package legitimacy verification (blocking, never auto-approvable)** — no commit (checkpoint; verification-only). Approved by the human in the prior executor session with the four freshly-read version numbers plus confirmation of `pino`/`fastify`'s existing pins.
2. **Task 2: Install the batch and promote fastify to a runtime dependency** — `38fb3e9` (feat)
3. **Task 3: Record the phase's out-of-scope scope notes** — `2a845d3` (docs)

**Plan metadata:** committed separately per `<planning_dir_git_rules>` — `git add -f .planning/phases/15-observability-alerting-frontend-resilience/15-01-SUMMARY.md && git commit` (this file's own commit, made immediately after this Write, per the sequential-execution and write-contract rules).

## Files Created/Modified
- `apps/worker/package.json` — added `pino@10.3.1`, `@sentry/node@10.70.0`, `@bull-board/api@8.6.1`, `@bull-board/fastify@8.6.1` as dependencies; moved `fastify@5.9.0` from `devDependencies` to `dependencies`
- `apps/api/package.json` — added `@sentry/node@10.70.0` as a dependency
- `apps/web/package.json` — added `@sentry/react@10.70.0` as a dependency
- `packages/redaction/package.json` — added `@sentry/node@10.70.0` as a devDependency only (type-only import; package stays runtime-dependency-light)
- `package-lock.json` — mutated once for the whole phase; regenerated under npm 10 for docker-image compatibility
- `SPECIFICATION.md` — section 2 rows for every new package plus new §2.7 phase-15 dependency-landing subsection; section 8 new §8.5 entry recording the unscheduled reputation dashboard
- `docker/redis.conf` — corrected `maxmemory` sizing-ownership comment to point at the SCALE milestone item instead of Phase 15 (value itself unchanged)

## Decisions Made
- Consolidated every Phase 15 dependency install into this single wave-1 plan (per the plan's own `key_links`), so no later plan in the phase performs any `npm install` — avoids concurrent-install lockfile corruption (the Phase 8 precedent the plan cites)
- Used `--save-exact` for every new package to match the project's existing convention of pinning exact versions for third-party dependencies (e.g. `fastify: "5.9.0"`, `pino: "10.3.1"`, no caret)
- Regenerated the lockfile a second time under npm 10 (`npx --yes npm@10 install --package-lock-only --ignore-scripts`) after the npm-11 installs, because `npm run check:lockfile-npm10` initially failed on missing optional `@esbuild/*` platform entries — this is the documented remediation the guard script itself prints, not a deviation from it
- Migration `0058` (applied) is never edited; the correction to its stale "deferred to Phase 15" comment about the reputation dashboard lives in `SPECIFICATION.md` section 8 instead, per the plan's explicit instruction

## Deviations from Plan

None — plan executed exactly as written, including the fix-attempt the lockfile guard itself documents as its own remediation path (not an unplanned deviation, but the expected outcome of installing under dev npm 11 then checking under prod npm 10).

## Issues Encountered

- `npm run check:lockfile-npm10` failed immediately after the npm-11 installs (missing several optional `@esbuild/*` platform-specific entries expected by an `npm@10 ci --dry-run`). Resolved by running the script's own printed remediation (`npx --yes npm@10 install --package-lock-only --ignore-scripts`), after which the check passed cleanly. This is the exact scenario `scripts/check-lockfile-npm10.mjs`'s own header comments describe as its reason for existing (Phase 14, G-14-4 gap closure) — not a new problem, the guard doing its job.

## User Setup Required

None — no external service configuration required by this plan. (Sentry DSNs and Grafana Cloud credentials listed in this plan's `user_setup` frontmatter are needed by later plans in Phase 15, explicitly not by this one, per the plan's own annotation: `"Needed before any DSN-bearing deploy, NOT before this plan"` / `"Needed by plan 15-17, not by this plan."`)

## Next Phase Readiness

- Every dependency later Phase 15 plans import (`@sentry/node`, `@sentry/react`, `@bull-board/api`, `@bull-board/fastify`, `pino` in `apps/worker`) is installed, resolvable via `npm ls`, and recorded in `SPECIFICATION.md`
- No Sentry SDK initialization call site, Bull Board module, or worker logger module was created — this plan is manifest/lockfile-only, as required (the plan's own prohibition), leaving plan 15-04's redaction fixture work and plan 15-06's SDK initialization fully unblocked but not pre-empted
- `package-lock.json` is mutated exactly once for the entire phase; no later plan needs to run `npm install`

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*

## Self-Check: PASSED

All 8 claimed files confirmed present on disk; all 3 claimed commit hashes (`38fb3e9`, `2a845d3`, `e3c8ae0`) confirmed present in `git log --oneline --all`.
