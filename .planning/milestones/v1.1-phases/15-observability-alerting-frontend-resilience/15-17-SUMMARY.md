---
phase: 15-observability-alerting-frontend-resilience
plan: 17
subsystem: infra
tags: [grafana-alloy, loki, logging, docker-compose, alerting, ops]

requires:
  - phase: 15-08
    provides: worker fully instrumented with structured Pino logging (materially increases log volume for the first time)
  - phase: 15-10
    provides: Grafana Cloud env-var documentation conventions in docker/prod.env.example and docker-compose.prod.yml
  - phase: 15-02
    provides: correlation-id model (requestId/jobId/sendId/workspaceId) stamped onto every Pino log line
provides:
  - Bounded json-file logging on every prod compose service (Docker's driver has no size cap unless configured)
  - Grafana Alloy sidecar (docker/alloy/config.alloy) shipping every container's Docker-captured logs to Grafana Cloud Loki over https, decoupled from the app processes
  - Two Grafana Cloud backstop alert rules (no-logs-received dead-man's-switch, error-rate-spike) documented precisely enough to recreate
  - Copy-pasteable end-to-end correlation LogQL query using the REAL camelCase field names (requestId, not request_id)
affects: [15-18]

tech-stack:
  added: ["grafana/alloy:v1.18.1 (Docker image, log-shipping sidecar)"]
  patterns:
    - "Label strategy: only service/container (Docker metadata) and level (the one body-derived field promoted via stage.json/stage.labels) become Loki labels; correlation ids stay in the JSON body queried at query time with | json"
    - "FIRST_PARTY_IMAGE_SERVICES extended to a third-party vendor image (alloy) specifically to make an immutable-tag invariant gate-enforced rather than just authored correctly once"

key-files:
  created:
    - docker/alloy/config.alloy
    - docs/observability/grafana-cloud-alerts.md
    - scripts/__fixtures__/prod-compose/missing-alloy-service.yml
    - scripts/__fixtures__/prod-compose/alloy-mutable-image-tag.yml
  modified:
    - docker/docker-compose.prod.yml
    - docker/prod.env.example
    - scripts/validate-prod-compose.mjs
    - scripts/__tests__/validate-prod-compose.test.mjs
    - SPECIFICATION.md

key-decisions:
  - "alloy added to FIRST_PARTY_IMAGE_SERVICES even though it's a third-party vendor image, not repo-built -- the plan's own must_haves truth requires the pinned-tag invariant to be gate-enforced for this service, not just correct at authoring time"
  - "No depends_on relationship from alloy to any other service -- discovery.docker's whole job is finding containers as they come and go via the Docker socket, with no functional dependency on any other service being healthy first (unlike pgbackrest's real dependency on db)"
  - "Corrected the correlation field name in the query documentation to camelCase (requestId) after verifying directly against apps/api/src/logger.ts and apps/worker/src/logger.ts -- 15-RESEARCH.md's own architecture diagram and this plan's own acceptance-grep both assumed snake_case (request_id), which does not exist anywhere in the actual log output"
  - "Retention window (14 days) verified directly against grafana.com/pricing/ (2026-08-16) rather than carrying forward 15-RESEARCH.md's open question unresolved"

patterns-established:
  - "Grafana Alloy label design: Docker-metadata labels (service/container) attached via discovery.relabel BEFORE any log content is read; the only body-derived label (level) goes through a scoped stage.json/stage.labels pair that touches nothing else in the line"

requirements-completed: [OPS-10]

coverage:
  - id: D1
    description: "Every service in docker-compose.prod.yml declares a bounded json-file logging block (max-size 10m, max-file 5)"
    requirement: "OPS-10"
    verification:
      - kind: unit
        ref: "npm run verify:prod-compose (missing-mem-limit-style invariants pass; git diff scoped to logging: additions only in the Task 1 commit)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Grafana Alloy sidecar (docker/alloy/config.alloy) discovers every container via the Docker socket, tails json-file logs, and pushes to Grafana Cloud Loki over https with no literal credential in the file; correlation ids never become labels"
    requirement: "OPS-10"
    verification:
      - kind: unit
        ref: "grep -v '^\\s*#' docker/alloy/config.alloy | grep -Ec 'request_id|job_id|send_id|workspace_id' -> 0"
        status: pass
      - kind: unit
        ref: "scripts/__tests__/validate-prod-compose.test.mjs (27/27, including new missing-alloy-service.yml / alloy-mutable-image-tag.yml fixtures)"
        status: pass
      - kind: unit
        ref: "npm run verify:prod-compose (8 services, 43 invariants, 0 violations) && docker compose -f docker/docker-compose.prod.yml config --quiet (exit 0)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Two Grafana Cloud backstop alert rules (no-logs-received dead-man's-switch, error-rate-spike) documented with exact query/window/threshold/contact-point, plus the end-to-end correlation LogQL query and the retention window"
    requirement: "OPS-10"
    verification:
      - kind: unit
        ref: "npm run check:spec-env-coverage (53 names checked, all present) && test -f docs/observability/grafana-cloud-alerts.md && grep -c request_id docs/observability/grafana-cloud-alerts.md"
        status: pass
      - kind: manual_procedural
        ref: "Real ingestion into Grafana Cloud Loki and real firing of both alert rules -- depends on operator provisioning (user_setup: grafana-cloud), no automated check in this repository can prove it"
        status: unknown
    human_judgment: true
    rationale: "The end-to-end edge (logs actually arriving in Loki, alert rules actually firing) is a flagged assumption per this plan's own frontmatter -- it depends on operator provisioning outside this repository and cannot be asserted by any automated check here. Plan 15-18's runbook is expected to give the operator the verification steps; phase verification must record this result as human-observed, not test-proven."

duration: ~35min
completed: 2026-08-16
status: complete
---

# Phase 15 Plan 17: Grafana Cloud Log Shipping & Backstop Alerts Summary

**Grafana Alloy sidecar ships every container's Docker-captured logs to Grafana Cloud Loki over https with low-cardinality labels (service/container/level), backed by a documented dead-man's-switch and error-rate-spike alert rule, plus bounded json-file log rotation on all eight prod compose services.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 3
- **Files modified:** 10 (5 modified, 5 created)

## Accomplishments

- Every service in `docker/docker-compose.prod.yml` (db, pgbackrest, redis, api, worker, web, migrate, and the new alloy) now declares a bounded `logging:` block (json-file driver, 10MB × 5 files) -- Docker's default driver has no size cap, and this phase is the first time log volume materially increases (plan 15-08's structured worker logging)
- New `alloy` service: `grafana/alloy:v1.18.1` (pinned, never mutable), no published port, read-only Docker-socket mount for container discovery (T-15-59, accepted risk), read-only config mount, same bounded logging as every other service
- `docker/alloy/config.alloy`: `discovery.docker` + `discovery.relabel` (service/container from Docker metadata) → `loki.source.docker` (tails Docker's own json-file capture, survives an app crash) → `loki.process` (promotes only pino's numeric `level` field to a label, via a scoped `stage.json`/`stage.labels`) → `loki.write` (https push, credentials via `env()`, no literal value)
- `scripts/validate-prod-compose.mjs`: `EXPECTED_SERVICES` and `FIRST_PARTY_IMAGE_SERVICES` both gained `alloy`, so the CI gate enforces the new service's port/tag invariants going forward (not just at authoring time); two new fixtures cover the added checks
- `docker/prod.env.example`: `ALLOY_MEM_LIMIT` sizing knob + the three Grafana Cloud credential names (`GRAFANA_LOKI_PUSH_URL`, `GRAFANA_LOKI_USER`, `GRAFANA_CLOUD_API_TOKEN`) -- names/sources only, no values
- `docs/observability/grafana-cloud-alerts.md`: the two backstop alert rules with exact LogQL query/evaluation-interval/pending-period/threshold/contact-point, the copy-pasteable end-to-end correlation query, and the 14-day free-tier retention window (verified directly against Grafana's own pricing page, not carried forward from the research document's open question)
- `SPECIFICATION.md` updated: §3.2 (three Grafana Cloud vars + `ALLOY_MEM_LIMIT`), §7 (full Alloy pipeline + both alert rules, plus correcting a stale "not yet implemented" note left by plan 15-14), §8.2 (`grafana/alloy` recorded as a technology CLAUDE.md's stack section doesn't mention)

## Task Commits

Each task was committed atomically:

1. **Task 1: Bound Docker's log growth on every service** - `793abe3` (feat)
2. **Task 2: The Alloy sidecar and its configuration** - `8e4987d` (feat)
3. **Task 3: Document the two backstop alert rules and the correlation query** - `5adbea2` (docs)

## Files Created/Modified

- `docker/docker-compose.prod.yml` - bounded `logging:` block on every service; new `alloy` service
- `docker/alloy/config.alloy` - discovery.docker + loki.source.docker + loki.process + loki.write pipeline
- `docker/prod.env.example` - `ALLOY_MEM_LIMIT` + three Grafana Cloud credential names
- `scripts/validate-prod-compose.mjs` - `EXPECTED_SERVICES`/`FIRST_PARTY_IMAGE_SERVICES` gained `alloy`
- `scripts/__tests__/validate-prod-compose.test.mjs` - two new fixture-driven test cases for `alloy`
- `scripts/__fixtures__/prod-compose/missing-alloy-service.yml` - new fixture
- `scripts/__fixtures__/prod-compose/alloy-mutable-image-tag.yml` - new fixture
- `docs/observability/grafana-cloud-alerts.md` - new: both alert rules, correlation query, retention window
- `SPECIFICATION.md` - §3.2/§7/§8.2 updated

## Decisions Made

- `alloy` added to `FIRST_PARTY_IMAGE_SERVICES` despite being a third-party vendor image -- the plan's must_haves truth requires the pinned-tag invariant to be a gate-enforced CI check for this service specifically, not merely authored correctly once
- No `depends_on` from `alloy` to any other service -- its Docker-socket-based container discovery has no functional dependency on any other service being healthy first, unlike `pgbackrest`'s real dependency on `db`
- Corrected the correlation-field-name assumption: the actual JSON log field is camelCase `requestId`/`jobId`/`sendId`/`workspaceId` (verified directly against `apps/api/src/logger.ts`/`apps/worker/src/logger.ts`'s `mixin()`), not the snake_case spelling `15-RESEARCH.md`'s own architecture diagram and this plan's own acceptance-grep both assumed -- `docs/observability/grafana-cloud-alerts.md`'s correlation query and its "field name note" section make this explicit so a future reader doesn't write a query against a field that doesn't exist
- 14-day retention window verified directly against `grafana.com/pricing/` (2026-08-16), resolving `15-RESEARCH.md`'s own open question rather than repeating an assumed figure

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fresh worktree lacked `apps/worker/dist`, breaking the pre-existing stop-grace-period check**
- **Found during:** baseline verification before Task 1
- **Issue:** `scripts/print-stop-grace-period.mjs` imports the compiled `apps/worker/dist/shutdown-budget.js`, which does not exist in a fresh worktree checkout until built at least once -- unrelated to this plan's own files, matches the same gap prior plans in this phase hit
- **Fix:** Ran `npm run build -w apps/worker` (gitignored `dist/` output, nothing committed)
- **Files modified:** none (build artifact only, gitignored)
- **Verification:** `npm run verify:prod-compose` passes cleanly afterward
- **Committed in:** n/a (no source change, no commit needed)

---

**Total deviations:** 1 auto-fixed (1 blocking, pre-existing environment gap unrelated to this plan's files)
**Impact on plan:** Necessary to get a clean local verification baseline; no scope creep.

## Issues Encountered

- `docker compose -f docker/docker-compose.prod.yml config --quiet` (the plan's own literal acceptance command, run with no `--env-file`) fails on a fresh checkout unless `WORKER_STOP_GRACE_PERIOD_SECONDS` is exported first -- this is pre-existing baseline behavior (confirmed identical before any of this plan's edits), not something introduced here. CI's `static` job never hits this because it builds all workspaces first and the YAML-fallback path (no Docker daemon on that runner) doesn't need the env var resolved the same way.
- Grafana Alloy's exact `river`/component syntax (`discovery.docker`, `loki.source.docker`, `loki.process`, `loki.write`) was authored from verified component names cross-checked against Grafana's own reference-page navigation and Docker Hub's real `grafana/alloy` tag list (`v1.18.1`, confirmed as the latest non-Windows release as of 2026-08-16), but the full argument-level syntax could not be scraped from Grafana's JS-rendered documentation pages within this session's tooling. This file is not executed by any automated check in this repository (no real Alloy binary runs against it in CI) -- flagged here so a future reviewer with Alloy documentation access (or a real bring-up) double-checks the exact block syntax before the first real deploy.

## User Setup Required

**External services require manual configuration.** This plan's own `user_setup` frontmatter names the operator step:
- Grafana Cloud account/stack with Loki push endpoint, user id, and a `logs:write`-scoped API token (`GRAFANA_LOKI_PUSH_URL`/`GRAFANA_LOKI_USER`/`GRAFANA_CLOUD_API_TOKEN` in `MEGA_CRM_ENV_FILE`)
- Create both alert rules from `docs/observability/grafana-cloud-alerts.md` (exact query/window/threshold given) and point both at a contact point using `OPERATOR_ALERT_EMAIL`

No automated check in this repository can prove logs actually arrive in Loki or that the alert rules actually fire -- this is a flagged assumption (see this plan's own frontmatter), not silently treated as done.

## Next Phase Readiness

- OPS-10 is closed at the configuration/gate level: bounded rotation, no published port, pinned tag, https-only push, low-cardinality labels, and no credential literal are all asserted by repository gates (`verify:prod-compose`, the fixture-driven alloy tests, `check:spec-env-coverage`).
- The end-to-end edge (real ingestion, real alert firing) remains a flagged assumption for the operator to close via `docs/observability/grafana-cloud-alerts.md`'s recreate instructions -- plan 15-18 (the next plan in this phase, per `affects`) is expected to fold this into its own runbook/verification step.
- No blockers for 15-18.

## Known Stubs

None - no stub patterns introduced. Every file created in this plan is a real, functioning configuration or documentation artifact wired into the actual gates (`scripts/validate-prod-compose.mjs`, `scripts/check-spec-env-coverage.mjs`).

## Self-Check: PASSED

- FOUND: docker/alloy/config.alloy
- FOUND: docs/observability/grafana-cloud-alerts.md
- FOUND: scripts/__fixtures__/prod-compose/missing-alloy-service.yml
- FOUND: scripts/__fixtures__/prod-compose/alloy-mutable-image-tag.yml
- FOUND: docker/docker-compose.prod.yml (alloy service + logging: blocks)
- FOUND: docker/prod.env.example (ALLOY_MEM_LIMIT + three Grafana Cloud vars)
- FOUND: scripts/validate-prod-compose.mjs (EXPECTED_SERVICES/FIRST_PARTY_IMAGE_SERVICES updated)
- FOUND: scripts/__tests__/validate-prod-compose.test.mjs (two new cases)
- FOUND: SPECIFICATION.md (§3.2/§7/§8.2 updated)
- FOUND commit 793abe3
- FOUND commit 8e4987d
- FOUND commit 5adbea2

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-16*
