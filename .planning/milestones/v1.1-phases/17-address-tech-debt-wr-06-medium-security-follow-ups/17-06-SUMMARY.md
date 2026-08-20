---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
plan: 06
subsystem: infra
tags: [documentation, spec, security-register, milestone-audit, postgres, timezone]

requires:
  - phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
    provides: "plan 17-01/17-02's TimeZone pin + read-site UTC anchor; plan 17-03's CI-built GHCR postgres image; plan 17-04's self-recording restore drill; plan 17-05's live cutover, alloy establishment, and restore-drill evidence"
provides:
  - "SPECIFICATION.md brought into line with Phase 17's as-built state at every anchor the phase's changes touch, with a new §8.6 divergence subsection and two §9 review-summary entries"
  - "14-SECURITY.md's three open medium rows (T-14-58, T-14-73, T-14-88) carry cited, checkable Phase 17 evidence; T-14-49's narrowed-evidence note updated; a dated pending-auditor note recorded; status column byte-identical (D-12 honored)"
  - "v1.1-MILESTONE-AUDIT.md's WR-06, three-medium-security-items, and alloy/Loki carried items annotated with what addressed them (6/6 occurrences), plus a corrected false compose-env-vars citation discovered during this pass"
affects: ["/gsd-secure-phase against the Phase 14 register (named next action, D-12)"]

tech-stack:
  added: []
  patterns:
    - "Annotate-don't-rewrite for audit/register documents: dated, in-place additions preserve what was true at audit time while still surfacing new evidence"

key-files:
  created: []
  modified:
    - SPECIFICATION.md
    - .planning/phases/14-deployment-database-durability/14-SECURITY.md
    - .planning/v1.1-MILESTONE-AUDIT.md

key-decisions:
  - "Register status column left byte-identical (verified: 3 == 3 open-status-string occurrences before/after) — D-12 reserves the verdict flip for a gsd-security-auditor re-run; this plan supplies evidence, not the verdict."
  - "v1.1-MILESTONE-AUDIT.md's three medium security items annotated as evidenced-but-NOT-closed (matching 14-SECURITY.md's own D-12 constraint) — only WR-06 (a code warning, not a register row) was annotated CLOSED, per the plan's explicit instruction that WR-06 may be closed here while the register items may not."
  - "Fixed a provably false pre-existing citation at v1.1-MILESTONE-AUDIT.md's Phase-14->15 alloy integration seam ('env vars at lines 487-496') while already editing this file for its carried alloy/Loki item — Rule 1 (auto-fix bug), not part of the plan's named action list but flagged by phase_evidence_context and in-scope since the file was already open."

patterns-established: []

requirements-completed: []

coverage:
  - id: D1
    description: "SPECIFICATION.md describes the system as actually built after Phase 17: the pool-level TimeZone pin, the CI-built GHCR postgres image, the changed POSTGRES_IMAGE_TAG semantics, RESTORE_DRILL_METRICS_FILE, and the growth query's UTC anchor — with a new §8.6 divergence subsection and two §9 review-summary entries, and the stale 'no real VPS run' / pgBackRest 2.59.0 statements corrected at the anchors this plan touched."
    verification:
      - kind: other
        ref: "grep -c for build-and-push-postgres(3)/RESTORE_DRILL_METRICS_FILE(2)/'-c TimeZone=UTC'(2)/pg-timezone.test.ts(3)/GROWTH_BY_DAY_SQL(2)/dashboard-timezone.test.ts(2)/3265(1) all >=1; grep -c 'ЛОКАЛЬНО собранного' == 0; grep -c '^### 8.6 ' == 1; npm run check:spec-env-coverage exits 0 (54/54 names present)"
        status: pass
    human_judgment: false
  - id: D2
    description: "14-SECURITY.md's three open medium rows (T-14-58/T-14-73/T-14-88) carry cited, checkable Phase 17 closure evidence without any status-column change; a dated pending-auditor note names /gsd-secure-phase as the required next action."
    verification:
      - kind: other
        ref: "bash verify command: open-status-string count identical before/after (3==3); grep -c 'gsd-secure-phase' 14-SECURITY.md == 2 (>=1); grep -n T-14-58/T-14-73/T-14-88 all cite 17-05-SUMMARY.md or a named Phase 17 artifact; T-14-49 status still 'closed'"
        status: pass
    human_judgment: false
  - id: D3
    description: "v1.1-MILESTONE-AUDIT.md annotates all six occurrences (WR-06, 3-medium-items, alloy/Loki, each in both the carried-items YAML list and the prose summary); the three medium items are explicitly NOT described as closed; no original finding text deleted."
    verification:
      - kind: other
        ref: "grep -c 'Phase 17' v1.1-MILESTONE-AUDIT.md == 7 (>=6); git diff shows only in-place appended annotations, zero removed finding lines (confirmed by reading the full diff, 8 hunks, all additions-only)"
        status: pass
    human_judgment: false

duration: ~45min
completed: 2026-08-20
status: complete
---

# Phase 17 Plan 06: Documentation closure — SPECIFICATION.md as-built + security register/audit annotations (D-10, D-12) Summary

**SPECIFICATION.md now describes Phase 17's as-built system (UTC-pinned pools, CI-built/GHCR-published postgres image, self-recording restore drill, UTC-anchored growth query); the Phase 14 security register's three open medium rows carry cited live evidence with their status deliberately unchanged pending a `gsd-security-auditor` re-run; and the milestone audit's three carried tech-debt items are annotated with what addressed them.**

## Performance

- **Duration:** ~45 min
- **Tasks:** 2 (both `type="auto"`)
- **Files modified:** 3

## Accomplishments

- `SPECIFICATION.md` updated at every anchor Phase 17's plans touch: §3.8's `POSTGRES_IMAGE_TAG` entry extended with the human-gated-cutover rationale and live 2026-08-19 cutover evidence; `RESTORE_DRILL_METRICS_FILE` added to the test-only-overrides list with an explicit "this one is NOT test-only" callout; §5.17's pool-factory paragraph extended with the `TimeZone=UTC` startup-parameter pin, the `node-postgres#3265` race citation, and the write-path-closes-WR-06 consequence; §8.4's PgBouncer deferral note gained the pin's revisit trigger; §1.3/§2.6 updated to describe the postgres image as CI-built/GHCR-published rather than host-built, with pgBackRest corrected from the stale 2.59.0 to the ratified, cross-version-proven 2.59.1; §4's `AT TIME ZONE` note extended with the growth query's double-hop UTC anchor; a new §8.6 divergence subsection and two §9 review-summary entries added.
- The false "ЛОКАЛЬНО собранного" (locally-built) claim about the postgres image — already corrected by plan 17-03 before this plan started — remains at zero occurrences, confirmed by grep.
- `14-SECURITY.md`'s three open medium rows (T-14-58, T-14-73, T-14-88) each gained a dated "Phase 17 evidence" clause naming files, commands, gates, and the exact `17-05-SUMMARY.md` section holding pasted live output — checkable by an auditor from the register alone. T-14-49's narrowed-evidence note now points at T-14-88's Phase 17 evidence. A new audit-history table row plus a dated prose note record that Phase 17 supplied evidence, that the status is deliberately unchanged, and that `/gsd-secure-phase` is the required next action — an executor is explicitly stated as not permitted to award the verdict (D-12). The Approval paragraph's "Open medium follow-ups" sentence now points at this new note.
- **D-12 verified honored:** the open-status string (`open (below block threshold)`) count is byte-identical before and after this plan's edits (3 == 3, both via direct grep and via `git show HEAD~1:...` comparison).
- `v1.1-MILESTONE-AUDIT.md`'s three carried tech-debt items are annotated in both their YAML carried-items-list occurrence and their prose-summary occurrence (6/6): WR-06 is annotated **CLOSED** (plans 17-01/17-02, citing the two test files); the three medium security items are annotated **evidenced-but-NOT-closed** (same D-12 constraint as the register); the alloy/Loki operator item is annotated **CONFIRMED** from plan 17-05's live cutover session (citing the two `RestartCount` observations and the seven-service Loki label set). All original finding text preserved — every edit is an in-place, dated appendix, never a deletion or rewrite (confirmed by reading the full diff: 8 hunks, all additions).
- **Deviation (Rule 1, auto-fixed):** while already editing `v1.1-MILESTONE-AUDIT.md` for its alloy/Loki carried item, corrected a separate, pre-existing, provably false citation at the Phase 14→15 integration-seam table (row 5): the original text claimed "env vars at lines 487–496 match the config's `env()` calls," but those lines are actually the read-only Docker-socket/config-file volume mounts and the `command:` array — there is no `environment:` block on the `alloy` service at all. `config.alloy`'s `env()` calls are satisfied via the `env_file: [{ path: ${MEGA_CRM_ENV_FILE}, required: false }]` entry at lines 479–481. This was flagged specifically for this plan's documentation pass and the file was already open for the alloy/Loki annotation, so it was fixed in place rather than deferred.

## Task Commits

Each task was committed atomically:

1. **Task 1: Bring SPECIFICATION.md into line with what this phase built** - `9584918` (docs)
2. **Task 2: Attach citable closure evidence to the register and the milestone audit — without flipping any status** - `896b89e` (docs)

**Plan metadata:** committed alongside this SUMMARY (this same commit, worktree mode — `git add -f`).

## Files Created/Modified

- `SPECIFICATION.md` — 8 scoped edits (POSTGRES_IMAGE_TAG, RESTORE_DRILL_METRICS_FILE, pool factory, PgBouncer deferral, §1.3 image/images.yml description, §2.6 pgBackRest version + Dockerfile row, §4 growth-query anchor, new §8.6 + two §9 entries)
- `.planning/phases/14-deployment-database-durability/14-SECURITY.md` — 3 row-level evidence clauses (T-14-58/T-14-73/T-14-88), 1 hand-off note extension (T-14-49), 1 new audit-history row + prose note, 1 Approval-paragraph pointer
- `.planning/v1.1-MILESTONE-AUDIT.md` — 7 annotations (WR-06 ×2, 3-medium-items ×2, alloy/Loki ×2, plus 1 unplanned false-citation fix)

## SPECIFICATION.md Anchors Edited (with the grep used to locate each)

| Anchor | Grep used | What changed |
|---|---|---|
| §3.8 `POSTGRES_IMAGE_TAG` | `grep -n "POSTGRES_IMAGE_TAG" SPECIFICATION.md` | Added human-gated-cutover rationale + live 2026-08-19 cutover evidence citation |
| §3.8 test-only overrides | `grep -n "RESTORE_DRILL_" SPECIFICATION.md` | Added `RESTORE_DRILL_METRICS_FILE`, explicitly marked non-test-only, with the real recorded NDJSON line |
| §5.17 pool factory | `grep -n "Единая фабрика Postgres-пулов" SPECIFICATION.md` | Added the `TimeZone=UTC` startup-parameter pin, `node-postgres#3265` citation, behavioral/regression test names, write-path WR-06 closure statement |
| §1.3 Phase 14 paragraph | `grep -n "docker/postgres/Dockerfile" SPECIFICATION.md` | Marked "no real VPS run" sentence superseded (plan 17-05); updated images.yml job inventory to name the two new postgres jobs |
| §2.6 base-image-tag table | `grep -n "docker/postgres/Dockerfile" SPECIFICATION.md` | Row extended: image is now CI-built/GHCR-published, not host-built |
| §2.6 OS-level packages table (pgBackRest row) | (same anchor read, adjacent row) | Version corrected 2.59.0 → ratified 2.59.1, with the cross-version restore proof citation |
| §8.4 PgBouncer deferral | `grep -n "^### 8\." SPECIFICATION.md` (located §8.4, then its D-09 paragraph) | Added the TimeZone-pin's PgBouncer revisit trigger |
| §4 `AT TIME ZONE` note | `grep -n "AT TIME ZONE" SPECIFICATION.md` | Added the growth query's double-hop UTC anchor, the naive-vs-timestamptz opposite-direction rationale, and the locking test citation |
| §8.6 (new) | `grep -n "^### 8\." SPECIFICATION.md` (inserted after §8.5) | New divergence subsection listing all 4 Phase 17 as-built changes + the pending-auditor statement |
| §9 (new entries 23, 24) | `grep -n "Закрыто планом" SPECIFICATION.md` (located §9's closure convention) | Two new review-summary entries: WR-06 closure, register-evidence-pending-auditor note |

## 14-SECURITY.md — Three Per-Row Evidence Citations (verbatim additions)

**T-14-58:** "Phase 17 evidence (2026-08-19, pending auditor re-run — see note below): `build:` sections removed from `docker/docker-compose.prod.yml`'s `db`/`pgbackrest` (plan 17-03); image reference is now `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` with no fallback; built and pushed by `.github/workflows/images.yml`'s `build-and-push-postgres` job on the same `github.sha` as the application images. Live cutover observed: `docker inspect`'s `Config.Image` reported the GHCR reference and the running image id changed (`sha256:de6a69e4...` → `sha256:e718495c...`) — see `17-05-SUMMARY.md`'s 'Task 1 — Attempt 3 (APPROVED...)' section."

**T-14-73:** "Phase 17 evidence (2026-08-19, pending auditor re-run — see note below): `scripts/restore-drill.sh` now self-records restore-to-ready duration and scratch-PGDATA disk high-water on every run, including the readiness-timeout path, to stdout and to an append-only `RESTORE_DRILL_METRICS_FILE` history file (plan 17-04). Real figures captured from a real PITR drill against the CI-built image on the production host: `durationSeconds=119`, `diskHighWaterKb=170520` — see `17-05-SUMMARY.md`'s 'Task 2 — restore drill (APPROVED)' section for the verbatim metrics NDJSON line, and `docs/runbooks/restore-drill.md`'s 'Recorded drill runs' table where the figures and the derived free-disk-headroom requirement live."

**T-14-88:** "Phase 17 evidence (2026-08-19, pending auditor re-run — see note below): `db` and `pgbackrest` added to `scripts/validate-prod-compose.mjs`'s `FIRST_PARTY_IMAGE_SERVICES`; `\"local\"` added to `MUTABLE_TAG_NAMES` (plan 17-03). Fixture `scripts/__fixtures__/prod-compose/db-mutable-image-tag.yml` plus its case in `scripts/__tests__/validate-prod-compose.test.mjs` prove the gate rejects a mutable tag on `db` (34/34 pass per plan 17-03's SUMMARY). `docker/prod.env.example`'s default is now the deliberately-invalid 40-zero placeholder. `scripts/restore-drill.sh` gained fail-loud `:?`-guarded `GHCR_IMAGE_BASE`/`POSTGRES_IMAGE_TAG` checks (plan 17-04)."

## Quoted Pending-Auditor Annotation Text

New audit-history table row: `| 2026-08-19/20 | same 97 (no new threats registered) | same 94 (no status change) | same 3 medium, all below high block threshold — threats_open: 0 | Phase 17, plan 17-06 (executor documentation pass, NOT a security audit — see note below) |`

Prose note beneath the table: "**Phase 17 supplied closure evidence for T-14-58/T-14-73/T-14-88 (2026-08-19/20); the three rows' status is deliberately UNCHANGED, pending a `gsd-security-auditor` re-run.** Plans 17-03/17-04 closed the implementation gaps this register's three open medium rows described [...]. **An executor is not permitted to award these verdicts** (D-12, `17-CONTEXT.md`) — the register reached `verified` originally through a `gsd-security-auditor` pass, and rows flip to `closed` the same way, never by executor edit. **Next action: run `/gsd-secure-phase` against this register** to re-verify T-14-58/T-14-73/T-14-88 against the Phase 17 evidence cited above and award (or withhold) the status flip."

## Confirmed-Resolving Citation List

Every repository path newly written into `SPECIFICATION.md` resolved with `test -e`: `SPECIFICATION.md`, `packages/db/src/__tests__/pg-timezone.test.ts`, `packages/db/src/__tests__/pool-factory.test.ts`, `apps/api/src/modules/analytics/__tests__/dashboard-timezone.test.ts`, `apps/api/src/modules/analytics/dashboard.repository.ts`, `scripts/restore-drill.sh`, `docs/runbooks/restore-drill.md`, `docker/postgres/Dockerfile`, `docker/docker-compose.prod.yml`, `.github/workflows/images.yml`, `packages/db/src/pool.ts`, `.planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-05-SUMMARY.md` — all 12 present (12/12 `test -e` checks passed).

Every SUMMARY section cited by a 14-SECURITY.md/v1.1-MILESTONE-AUDIT.md annotation was confirmed to exist with non-empty pasted content beneath its heading, by reading `17-05-SUMMARY.md` in full at the start of this plan: "Task 1 — Attempt 3 (APPROVED...)" (image inspect output, RLS/WAL figures), "Task 2 — restore drill (APPROVED)" (metrics NDJSON line, verification detail), and the B1/B2 `RestartCount`/Loki-label observations embedded in the Attempt 3 section.

## Decisions Made

See `key-decisions` in the frontmatter above. Summary: register status column left byte-identical (D-12); the milestone audit's three medium security items annotated evidenced-but-NOT-closed (matching the register's own constraint) while WR-06 — a code warning, not a register row — was annotated CLOSED per the plan's explicit permission; one unplanned false-citation fix applied in an already-open file (Rule 1).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected a false pre-existing citation in v1.1-MILESTONE-AUDIT.md's Phase 14→15 integration seam**
- **Found during:** Task 2, while annotating the alloy/Loki carried item in the same file
- **Issue:** Row 5 of the Cross-Phase Integration table claimed "env vars at lines 487–496 match the config's `env()` calls" for the `alloy` service in `docker/docker-compose.prod.yml`. Reading those lines showed they are the read-only Docker-socket/config-file volume mounts and the `command:` array — not environment-variable declarations. The `alloy` service has no `environment:` block; `config.alloy`'s `env()` calls are satisfied entirely via the `env_file: [{ path: ${MEGA_CRM_ENV_FILE}, required: false }]` entry at lines 479–481.
- **Fix:** Corrected the citation to name the actual mount line (489) and the actual `env_file` mechanism (479–481), with an explicit "Corrected 2026-08-20" note explaining the original claim was false and why.
- **Files modified:** `.planning/v1.1-MILESTONE-AUDIT.md`
- **Verification:** Read `docker/docker-compose.prod.yml` lines 456–500 directly; confirmed no `environment:` key exists on the `alloy` service and the cited line numbers are volume/command entries.
- **Committed in:** `896b89e` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1).
**Impact on plan:** The fix was scoped entirely within a file already in this plan's `files_modified` list and was explicitly flagged by the phase's evidence context as a target for this documentation pass. No scope creep — no other stale statements outside the plan's named anchors were touched (see Known Residuals below for what was found but deliberately left alone).

## Known Residuals (found, deliberately NOT fixed — out of this plan's scope)

- **`docker/postgres/Dockerfile`'s own in-file comment still says pgBackRest 2.59.0.** This file is NOT in this plan's `files_modified` list (only `SPECIFICATION.md` is). `SPECIFICATION.md`'s own pgBackRest version entry has been corrected to 2.59.1-as-observed; the Dockerfile comment is a residual pointed out by the phase evidence context and left for a future plan/pass to touch, per the explicit instruction not to edit files outside this plan's scope.
- **`SPECIFICATION.md` §8.5's near-duplicate "не определено" paragraph** (the one stating all three of 14-09/14-10/14-11's real-host runs were undetermined "at the moment of this edit") was NOT touched — only the near-identical sentence at the §1.3 anchor this plan was already editing was marked superseded, per the plan's explicit instruction to avoid expanding into a general document audit. A future pass should reconcile §8.5's paragraph the same way if it is judged worth a dedicated edit.
- **STATE.md:371's "live redeploy of the committed config confirmed" (Phase 15) contradiction** flagged by the phase evidence context is recorded here for the orchestrator/verifier to reconcile centrally — STATE.md is a shared artifact this plan is explicitly forbidden from editing in worktree mode. Plan 17-05 has now established alloy live for the first time (2026-08-19), which resolves the underlying question in fact even though STATE.md's line itself has not been touched.

## Issues Encountered

None beyond the deviation documented above.

## User Setup Required

None — no external service configuration required. This plan touches only Markdown documentation.

## Next Phase Readiness

- **Required next action per D-12: run `/gsd-secure-phase` against the Phase 14 register** (`.planning/phases/14-deployment-database-durability/14-SECURITY.md`) to re-verify T-14-58/T-14-73/T-14-88 against the Phase 17 evidence cited in this plan's edits, and award (or withhold) the status flip to `closed`. This is the only remaining action blocking full closure of Phase 17's tech-debt follow-ups.
- No blockers. All verification commands from the plan's `<verification>` block pass: `npm run check:spec-env-coverage` exits 0; the open-status count is unchanged (3==3); `grep -c 'gsd-secure-phase'` returns 2 (≥1); `grep -c '^### 8.6 '` returns 1; `grep -c 'ЛОКАЛЬНО собранного'` returns 0; every newly-written repository path resolves.
- `npm test` was NOT run — this worktree has no `node_modules` and this is an explicitly doc-only plan (per this plan's `project_notes`: "no node_modules needed; do not symlink anything from the main checkout"). `check:spec-env-coverage` (the one relevant automated gate, Node-builtins-only) ran and passed cleanly without `node_modules`, confirming nothing incidental was broken by the Markdown-only edits.

---
*Phase: 17-address-tech-debt-wr-06-medium-security-follow-ups*
*Completed: 2026-08-20*

## Self-Check: PASSED

- FOUND: `SPECIFICATION.md`
- FOUND: `.planning/phases/14-deployment-database-durability/14-SECURITY.md`
- FOUND: `.planning/v1.1-MILESTONE-AUDIT.md`
- FOUND: `.planning/phases/17-address-tech-debt-wr-06-medium-security-follow-ups/17-06-SUMMARY.md`
- FOUND commit: `9584918` (docs — Task 1)
- FOUND commit: `896b89e` (docs — Task 2)
