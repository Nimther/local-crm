---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
plan: 03
subsystem: infra
tags: [github-actions, docker-compose, ci-cd, postgres, pgbackrest, ghcr]

requires:
  - phase: 14-deployment-database-durability
    provides: "docker-compose.prod.yml topology, images.yml's build-and-push/build-only matrix pattern, scripts/validate-prod-compose.mjs's invariant gate, scripts/deploy.sh's pull/up sequencing"
provides:
  - "Two new CI jobs (build-and-push-postgres, build-only-postgres) publishing the custom megacrm-postgres image to GHCR on the same git SHA as api/worker/web"
  - "docker/docker-compose.prod.yml's db/pgbackrest pull a registry image only -- no build: section, no mutable default"
  - "scripts/validate-prod-compose.mjs's FIRST_PARTY_IMAGE_SERVICES gate now covers db/pgbackrest; MUTABLE_TAG_NAMES rejects 'local' by name"
  - "docs/runbooks/backups.md and SPECIFICATION.md updated to describe the CI-built, pull-only model"
affects: ["17-04 (restore-drill's own POSTGRES_IMAGE_TAG reference)", "17-05 (live CI evidence for these two new jobs)"]

tech-stack:
  added: []
  patterns:
    - "Standalone CI job pair (push-only build-and-push, pull_request-only build-only with no login step) for an image whose Dockerfile/context pair doesn't fit an existing matrix -- mirrors the app-image jobs' own privilege-boundary shape without adding a fourth matrix entry"
    - "Compose image reference with no `:-default` fallback, paired with a deliberately-invalid SHA-shaped placeholder in the *.env.example file, so a forgotten operator variable fails loudly at `compose pull` instead of resolving silently"

key-files:
  created:
    - scripts/__fixtures__/prod-compose/db-mutable-image-tag.yml
  modified:
    - .github/workflows/images.yml
    - docker/docker-compose.prod.yml
    - docker/prod.env.example
    - scripts/validate-prod-compose.mjs
    - scripts/__tests__/validate-prod-compose.test.mjs
    - scripts/__fixtures__/prod-compose/pgbackrest-missing-data-volume.yml
    - scripts/__fixtures__/prod-compose/pgbackrest-missing-mem-limit.yml
    - scripts/__fixtures__/prod-compose/pgbackrest-publishes-port.yml
    - docs/runbooks/backups.md
    - SPECIFICATION.md

key-decisions:
  - "Two standalone CI jobs, not a fourth matrix entry -- docker/postgres/Dockerfile's build context (docker/) and file path don't fit the matrix's hard-coded docker/Dockerfile.<app>-at-repo-root convention"
  - "scripts/deploy.sh is NOT modified (diverges from CONTEXT.md's 'gains the postgres image in its pull set' wording, per RESEARCH.md Pitfall 4) -- db/pgbackrest cutover stays a separate, human-gated event, never part of the routine app-container flip"
  - "'local' (the removed compose fallback's exact value) added to MUTABLE_TAG_NAMES so the original footgun can't be silently reintroduced via an operator env file"

requirements-completed: []

coverage:
  - id: D1
    description: "Two new CI jobs (build-and-push-postgres, build-only-postgres) build and, on push only, publish the custom postgres image on the same github.sha as api/worker/web, reusing the four pinned action SHAs verbatim"
    verification:
      - kind: other
        ref: "grep -c '^  build-and-push-postgres:'/'^  build-only-postgres:' .github/workflows/images.yml (both 1); grep -o 'uses: [^ ]*' sorted-diff against git show HEAD (identical set)"
        status: pass
    human_judgment: false
  - id: D2
    description: "docker/docker-compose.prod.yml's db/pgbackrest reference ${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG} with no build: section and no mutable default; prod.env.example's placeholder is SHA-shaped"
    verification:
      - kind: unit
        ref: "npm run verify:prod-compose (exit 0, 8 services / 61 invariants)"
        status: pass
      - kind: integration
        ref: "npx vitest run scripts/__tests__/deploy-script.test.mjs (19/19 pass, deploy.sh git-clean)"
        status: pass
    human_judgment: false
  - id: D3
    description: "db/pgbackrest inside FIRST_PARTY_IMAGE_SERVICES immutable-tag gate, proven by db-mutable-image-tag.yml fixture (observed RED before the set change, GREEN after); local rejected by isMutableTag"
    verification:
      - kind: unit
        ref: "scripts/__tests__/validate-prod-compose.test.mjs > each fixture trips exactly the invariant it targets > db-mutable-image-tag.yml trips \"mutable-image-tag\" (34/34 total pass)"
        status: pass
    human_judgment: false
  - id: D4
    description: "docs/runbooks/backups.md's forward-flag bullet and SPECIFICATION.md's POSTGRES_IMAGE_TAG entry describe the new CI-built, pull-only, human-gated-cutover model; old text marked superseded, not deleted"
    verification: []
    human_judgment: true
    rationale: "Documentation-quality/accuracy judgment -- no automated check asserts prose content beyond the grep-count acceptance criteria already covered under D1-D3"

duration: ~20min
completed: 2026-08-19
status: complete
---

# Phase 17 Plan 03: Close the postgres image build/publish gap (D-05, D-06) Summary

**The custom megacrm-postgres image is now CI-built and GHCR-published on the same git SHA as api/worker/web; production compose only pulls it, and the compose immutable-tag gate now covers db/pgbackrest with a fixture that proves it.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 3 (Task 3 was TDD: RED fixture/case observed failing, then GREEN via set-membership change)
- **Files modified:** 10 (1 new fixture, 9 modified)

## Accomplishments

- Added `build-and-push-postgres` (push-only) and `build-only-postgres` (pull_request-only, no login step, job-level `contents: read`) to `.github/workflows/images.yml`, both building `docker/postgres/Dockerfile` with context `docker/` and reusing the four existing pinned action SHAs verbatim
- Removed the `build:` section from `db` and `pgbackrest` in `docker/docker-compose.prod.yml`; both now reference `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` with no `:-` default -- a forgotten tag now fails loudly at `compose pull`
- `docker/prod.env.example`'s `POSTGRES_IMAGE_TAG` placeholder changed from `local` to the same all-zero SHA-shaped placeholder `IMAGE_TAG` uses
- `db` and `pgbackrest` added to `scripts/validate-prod-compose.mjs`'s `FIRST_PARTY_IMAGE_SERVICES` immutable-tag gate; `"local"` added to `MUTABLE_TAG_NAMES` so the removed fallback's exact value can never be silently reintroduced
- New fixture `db-mutable-image-tag.yml` is the executable form of T-14-88 (proven RED before the set change, GREEN after)
- Reconciled the three pre-existing `pgbackrest-*` fixtures off the `local` tag onto a literal SHA-shaped placeholder so their own targeted violation isn't conflated with the new mutable-image-tag check
- `docs/runbooks/backups.md`'s forward-flag bullet marked superseded (decision trail preserved) and replaced with the CI-built/pull-only/human-gated-cutover description
- `SPECIFICATION.md`'s `POSTGRES_IMAGE_TAG` entry corrected to match the new mechanism (Rule 2: as-built docs must not describe a build model this plan removes)

## Task Commits

Each task was committed atomically:

1. **Task 1: Two standalone CI jobs that build and publish the postgres image on the same SHA** - `5fd697f` (feat)
2. **Task 2: Production compose pulls the postgres image; a missing tag fails loudly** - `feee754` (feat)
3. **Task 3: Bring db/pgbackrest inside the immutable-tag gate, with a fixture that proves it** - `596c6c6` (test, TDD RED->GREEN in one commit)

_Note: this plan runs in a worktree -- the plan-metadata commit (SUMMARY.md) is committed separately by this same agent; STATE.md/ROADMAP.md are updated centrally by the orchestrator after merge, not here._

## Files Created/Modified

- `.github/workflows/images.yml` - Adds `build-and-push-postgres` / `build-only-postgres` job pair
- `docker/docker-compose.prod.yml` - `db`/`pgbackrest` now pull `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}`, no `build:` section
- `docker/prod.env.example` - `POSTGRES_IMAGE_TAG` placeholder is now SHA-shaped, not `local`
- `scripts/validate-prod-compose.mjs` - `FIRST_PARTY_IMAGE_SERVICES` gains `db`/`pgbackrest`; `MUTABLE_TAG_NAMES` gains `local`; doc comment rewritten
- `scripts/__tests__/validate-prod-compose.test.mjs` - New `db-mutable-image-tag.yml` case added to the fixture table
- `scripts/__fixtures__/prod-compose/db-mutable-image-tag.yml` - New fixture (T-14-88's executable form)
- `scripts/__fixtures__/prod-compose/pgbackrest-missing-data-volume.yml`, `pgbackrest-missing-mem-limit.yml`, `pgbackrest-publishes-port.yml` - Image tag changed from `megacrm-postgres:local` to a literal SHA-shaped GHCR reference
- `docs/runbooks/backups.md` - Forward-flag bullet superseded with the CI-built/pull-only description
- `SPECIFICATION.md` - `POSTGRES_IMAGE_TAG`'s §3.8 entry corrected to the new mechanism

## Decisions Made

- Two standalone CI jobs rather than a fourth matrix entry -- `docker/postgres/Dockerfile`'s build context (`docker/`) and file path don't fit the matrix's hard-coded `docker/Dockerfile.<app>`-at-repo-root convention (RESEARCH.md Pitfall 2)
- `scripts/deploy.sh` is **not** modified -- this is a recorded divergence from CONTEXT.md's Integration Points wording ("deploy.sh pull-and-flip flow gains the postgres image in its pull set"). RESEARCH.md Pitfall 4's reasoning was followed instead: pre-pulling buys nothing (the D-07 cutover checkpoint pulls the image itself, once, as its first action), while every edit to `deploy.sh`'s service list is an opportunity for `db`/`pgbackrest` to drift into the routine restart path, which `deploy.sh`'s own header explicitly forbids. Verified: `git status --porcelain scripts/deploy.sh` is empty; `deploy-script.test.mjs` (19/19) passes unchanged.
- `"local"` added to `MUTABLE_TAG_NAMES` -- it was the exact tag value the removed `:-local` compose fallback used, so rejecting it by name closes the specific footgun an operator's stale env file could otherwise silently reintroduce

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Built apps/worker before running verify:prod-compose**
- **Found during:** Task 2 verification
- **Issue:** `npm run verify:prod-compose` failed with `stop-grace-period-undeterminable` because `scripts/print-stop-grace-period.mjs` imports `apps/worker/dist/shutdown-budget.js`, which didn't exist in this worktree (worker hadn't been built)
- **Fix:** Ran `npm run build -w apps/worker`
- **Files modified:** none (build artifact only, not committed)
- **Verification:** `npm run verify:prod-compose` then exits 0
- **Committed in:** n/a (no source change; build output is gitignored)

**2. [Rule 2 - Missing Critical] Corrected SPECIFICATION.md's now-false `POSTGRES_IMAGE_TAG` description**
- **Found during:** Task 3 (after the compose/gate changes landed)
- **Issue:** SPECIFICATION.md §3.8 still described `POSTGRES_IMAGE_TAG` as the tag of a locally-built image with default `local` -- an as-built security-review document (per CLAUDE.md's own stated purpose) now describing a build model this plan removed
- **Fix:** Rewrote the entry to describe the CI-built, GHCR-published, no-default mechanism and cross-reference the new gate/fixture and the runbook's superseded section
- **Files modified:** SPECIFICATION.md
- **Verification:** `npm run check:spec-env-coverage` still exits 0 (54 names checked)
- **Committed in:** `596c6c6` (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing-critical/documentation-accuracy)
**Impact on plan:** Neither changed the plan's own scope or files_modified list beyond adding SPECIFICATION.md; both were necessary for the plan's own verification/acceptance criteria to be checkable and accurate. No scope creep.

## Issues Encountered

- The full monorepo `npm test` run surfaced three failures, all pre-existing and unrelated to this plan's changes:
  - `apps/api/src/__tests__/sentry.test.ts` and `apps/worker/src/__tests__/sentry.test.ts` -- "with no DSN configured" fails deterministically on this machine because `~/.config/mega-crm/.env` carries real Sentry DSNs since the 2026-08-16 UAT session (documented machine quirk, passes in CI)
  - `apps/web/src/__tests__/playwright-package-source-import.test.ts` -- fails with `Cannot find module '.../node_modules/@playwright/test/cli.js'`; confirmed this is a genuine missing file in this worktree's `node_modules` (not a symlink -- `find . -maxdepth 4 -name node_modules -type l` found none), unrelated to any file this plan touches (no changes to `apps/web` or Playwright config)
  - Targeted runs of every file this plan actually touches (`validate-prod-compose.test.mjs`, `deploy-script.test.mjs`, `postgres-dockerfile.test.mjs`, `verify:prod-compose`, `check:spec-env-coverage`) all pass cleanly

## User Setup Required

None - no external service configuration required. Operationally: after this plan merges and CI publishes the first `<ghcr-base>/postgres:<sha>` image, an operator still needs to set `POSTGRES_IMAGE_TAG` on the VPS and run the `db`/`pgbackrest` cutover sequence at least once before the next `docker compose pull` on that host would otherwise fail closed (no image reference resolves without it) -- this is the live-evidence checkpoint plan 17-05 owns, not this plan.

## Next Phase Readiness

- Plan 17-04 (restore-drill's own `POSTGRES_IMAGE_TAG` reference) can proceed -- the variable's meaning and placeholder shape are now stable
- Plan 17-05 has real CI jobs to exercise for live evidence: `build-and-push-postgres` on the next push to master, `build-only-postgres` on the next PR
- No blockers. `scripts/deploy.sh` remains provably untouched (empty git diff, passing test suite) -- the routine deploy path's isolation from `db`/`pgbackrest` restarts is unchanged by this plan.

---
*Phase: 17-address-tech-debt-wr-06-medium-security-follow-ups*
*Completed: 2026-08-19*
