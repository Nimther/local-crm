---
phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
plan: 05
subsystem: infra
tags: [docker, postgres, pgbackrest, ghcr, alloy, loki, grafana, restore-drill, deploy]

requires:
  - phase: 17-address-tech-debt-wr-06-medium-security-follow-ups
    provides: "plan 17-03's CI-built/GHCR-published megacrm-postgres image and immutable-tag gate; plan 17-04's self-recording restore-drill.sh instrumentation and GHCR-image launch"
provides:
  - "Live evidence closing D-07: production db/pgbackrest run the CI-built, GHCR-pulled, SHA-tagged postgres image (POSTGRES_IMAGE_TAG=1e061016dbf63016ab9aaeff9a3b995f8a55294f), observed live -- Postgres healthy, RLS enabled+forced on all 28 tenant-scoped tables, WAL archiving resuming"
  - "D-11 amended and closed: Grafana Alloy established live on production for the first time (never durably deployed before this plan), with two RestartCount observations bracketing the entire session and all seven continuously-running service labels confirmed in Loki"
  - "A real PITR restore drill (D-08/T-14-73) against the real off-host repository using the CI-built image, self-recorded duration=119s and disk high-water=170520KB, plus a cross-version proof (pgBackRest 2.59.1 restoring backups written by 2.59.0)"
  - "Two orchestrator-side defects discovered live by this plan's own checkpoints and fixed/merged before the cutover could complete: the charts/canvas-vendor chunk-cycle crash (PR #16) and deploy.sh's implicit db/redis leg-isolation hazard (PR #17)"
  - "docs/runbooks/restore-drill.md and docs/runbooks/backups.md updated with the real figures, the pgBackRest 2.59.1 ratification, the -u postgres fix, and the legacy-Docker manifest-inspect caveat"
affects: ["17-06 (register annotations for T-14-58/T-14-73/T-14-88 cite this SUMMARY's pasted evidence)"]

tech-stack:
  added: []
  patterns:
    - "Three-change bundled live cutover (alloy establish -> app deploy -> db cutover), each with its own independent verify-and-stop point and its own rollback, ordered by actual dependency (migrate needs a stable db; Loki needs to be live before the log-generating changes to make the eight-label check satisfiable) rather than by a flat task list"
    - "Digest-pinned emergency rollback via local docker tag override (never a checkout revert) so a single change's rollback never touches sibling changes' already-applied state in the same session"

key-files:
  created: []
  modified:
    - docs/runbooks/restore-drill.md
    - docs/runbooks/backups.md

key-decisions:
  - "Ratified: pgBackRest 2.59.1 (vs. the runbook's documented 2.59.0) is accepted, not rebuilt pinned -- T-14-58/T-14-88 are provenance/tag-immutability threats, never apt-level build-reproducibility ones, and the plan's own acceptance text already carried the escape hatch ('unless a base-image change was intended'). Proven, not merely asserted: the restore drill (Task 2) restored and verified a repository whose backups were written by 2.59.0 using the 2.59.1 binary."
  - "Ratified: the WAL-archiving acceptance criterion (plan text and must_haves truth #2's literal 'failed_count is 0 in both reads') is corrected to 'archived_count strictly increases; failed_count unchanged from baseline; last_failed_time/wal unmoved' -- pg_stat_archiver's failed_count is cumulative since stats_reset (2026-08-14 stanza bring-up), so the literal criterion could never pass on this host regardless of whether the cutover succeeded. The corrected form is a strictly better detector of the threat (T-17-28: archiving silently not resuming) it exists to guard."
  - "Ratified: D-11 amended from verify-still-running to establish-then-verify -- alloy was never durably deployed to production before this plan (deploy.sh's compose surface never includes it; no runbook/script ever issues the full up -d that would create it; the prior 15-UAT test 5 was a bare, unevidenced pass). This plan's checkpoint is the first time alloy has actually run on this VPS."
  - "Three-way bundled cutover reordered from the coordinator's enumeration (app, alloy, db) to (checkout, alloy, app, db, alloy re-observe) -- alloy first because it's the lowest-risk, independently-rollbackable change; alloy MUST be live before the app deploy's one-shot migrate container and before the db recreate, or the eight-label Loki check is structurally unsatisfiable (migrate's log lines vanish when its container is removed on exit; db/pgbackrest 'freshly recreated' lines don't exist if alloy starts after the recreate)."
  - "Two production attempts were rolled back before the third stayed in place -- each rollback was triggered by a defect in the STAGED checkpoint text (an over-strict WAL criterion, a root-vs-postgres pgbackrest invocation bug, a pre-existing app-bundle crash, and a missing --no-deps on deploy.sh), never by a defect in the CI-built postgres image itself. All three attempts' evidence is preserved below for full auditability of how the checkpoint text converged."

requirements-completed: []

coverage:
  - id: D1
    description: "Production db/pgbackrest cut over to the CI-built, GHCR-pulled, SHA-tagged postgres image (POSTGRES_IMAGE_TAG=1e061016dbf63016ab9aaeff9a3b995f8a55294f), observed live and left in place -- image identity, Postgres health, RLS posture, WAL archiving all confirmed post-cutover (D-07)"
    verification:
      - kind: manual_procedural
        ref: "Attempt 3 (approved): docker inspect Config.Image = ghcr.io/nimther/local-crm/postgres:1e061016...; image id de6a69e4 -> e718495c; pg_isready OK, PostgreSQL 17.11; RLS 28/28 tenant-scoped tables t/t (reputation_alert_state f/f documented exemption); pg_stat_archiver archived_count 131->133, failed_count 67 unchanged, last_failed unmoved -- see 'Attempt 3' evidence section below"
        status: pass
    human_judgment: true
    rationale: "Live production state change requiring operator execution and pasted command output on the real VPS -- not automatable or independently re-checkable by the executor."
  - id: D2
    description: "Grafana Alloy established live on production for the first time (amended D-11), staying running unperturbed across the app deploy and db cutover, with all seven continuously-running service labels confirmed in Loki"
    verification:
      - kind: manual_procedural
        ref: "B1 baseline RestartCount=0 @ 2026-08-19T14:51:16Z; B2 final read IDENTICAL (same StartedAt, 0 restarts) bracketing the full session; Loki {service=~\".+\"} over last 15min returned alloy/api/db/pgbackrest/redis/web/worker (migrate best-effort absent, container removed on exit) -- see 'Attempt 3' evidence section below"
        status: pass
    human_judgment: true
    rationale: "Live Grafana Cloud / production Docker observation requiring operator execution -- not automatable by the executor."
  - id: D3
    description: "A real PITR restore drill against the real off-host repository using the CI-built image, passing verification, with self-recorded duration/disk-high-water figures (D-08, T-14-73), including the pgBackRest 2.59.0-written/2.59.1-restored cross-version proof"
    verification:
      - kind: manual_procedural
        ref: "Task 2 (approved): target 2026-08-19 17:00:00+00; db:verify-restored PASSED (row counts vs. baseline with correct PITR deltas, 12/12 events + 12/12 send_events partitions attached, RLS 28 tenant-scoped tables checked); metrics NDJSON durationSeconds=119, diskHighWaterKb=170520 -- see 'Task 2' evidence section below"
        status: pass
    human_judgment: true
    rationale: "Live production-repository restore drill requiring operator execution on the real VPS -- not automatable by the executor."
  - id: D4
    description: "docs/runbooks/restore-drill.md and docs/runbooks/backups.md carry the real drill figures, the pgBackRest 2.59.1 ratification with its cross-version proof citation, the -u postgres fix on every affected hand-run pgbackrest invocation, and the legacy-Docker manifest-inspect caveat"
    verification:
      - kind: other
        ref: "grep -c 'Recorded drill runs' docs/runbooks/restore-drill.md == 1; grep -c 'the real disk high-water mark on the real VPS' docs/runbooks/restore-drill.md == 0; npm run check:runbook-coverage passes unchanged (4/4 alerts still covered)"
        status: pass
    human_judgment: false

duration: ~7h (spans live production checkpoints and reconciliation rounds across 2026-08-19)
completed: 2026-08-20
status: complete
---

# Phase 17 Plan 05: Live cutover, alloy establishment, and restore drill (D-07, D-08, D-11) Summary

**Production now runs the CI-built, GHCR-pulled, SHA-tagged postgres image with WAL archiving and RLS posture confirmed live; Grafana Alloy was established on production for the first time (it was never durably deployed before this plan); a real PITR restore drill against the real off-host repository passed with self-recorded duration=119s/disk-high-water=170520KB, proving pgBackRest 2.59.1 correctly restores backups written by 2.59.0.**

## Performance

- **Duration:** ~7h wall-clock across the live checkpoint session (2026-08-19), plus Task 3's doc edits (2026-08-20)
- **Tasks:** 3 (Task 1 and Task 2 are `checkpoint:human-verify` — no executor code changes; Task 3 is `type="auto"`)
- **Files modified:** 2 (both runbooks)
- **Production attempts:** 3 (2 rolled back per protocol on staging defects, not image defects; the 3rd stayed in place and is what closes D-07/D-11)

## Accomplishments

- Production's `db`/`pgbackrest` containers are now running `ghcr.io/nimther/local-crm/postgres:1e061016dbf63016ab9aaeff9a3b995f8a55294f` (amd64 digest `sha256:5697782e12c2df655f7798c51eb26851f37b8cfa82d576b64890ffacda6ae519`), confirmed live — image identity, PostgreSQL 17.11 health, RLS enabled+forced on all 28 tenant-scoped tables, and WAL archiving resuming (ratified corrected criterion) all pasted as real command output.
- Grafana Alloy is running on production for the first time ever — established live during this plan's checkpoint (amended D-11), with two `RestartCount` observations (`0` at both ends) bracketing the entire session including the app deploy and db cutover, and all seven continuously-running service labels (`alloy, api, db, pgbackrest, redis, web, worker`) confirmed arriving in Grafana Cloud Loki.
- A real PITR restore drill ran against the real off-host repository using the CI-built image: target `2026-08-19 17:00:00+00`, `db:verify-restored` passed with correct PITR row-count deltas, and the drill's own self-recorded figures (`durationSeconds=119`, `diskHighWaterKb=170520`) are the real numbers T-14-73 has been waiting for since 2026-08-14 — no longer a runbook placeholder.
- The same drill proved a cross-version compatibility property that matters specifically because of the pgBackRest ratification below: backups written by **2.59.0** were restored and verified by the **2.59.1** binary.
- Two defects were discovered live by this plan's own checkpoints (not by any other phase's testing) and fixed/merged before the cutover could complete: (1) a static import-cycle in the `charts-vendor`/`canvas-vendor` Rolldown chunks that crashed the dashboard growth chart and the flow editor in every production build since 2026-08-15 (PR #16); (2) `scripts/deploy.sh`'s mutating compose calls implicitly recreating `db`/`redis` via dependency convergence, an ungated db cutover hidden inside the routine app-deploy path (PR #17, caught by the operator's own dry-run before it ever ran for real).
- `docs/runbooks/restore-drill.md` and `docs/runbooks/backups.md` updated with the real figures, the pgBackRest 2.59.1 ratification and its cross-version proof citation, the `-u postgres` fix on every affected hand-run `pgbackrest` invocation, and the legacy-Docker-client `manifest inspect` caveat discovered mid-cutover.

## Task Commits

Task 1 and Task 2 are `checkpoint:human-verify` tasks with no executor-authored code changes — all evidence below is pasted operator/orchestrator output from the live VPS and Grafana Cloud, not code this executor wrote.

1. **Task 1: BLOCKING — cut production's db/pgbackrest over to the CI-built GHCR image, and confirm alloy/Loki in the same session** — no commit (live production operation; approved by operator, see evidence below). Two of the code fixes it surfaced landed as separate commits on this same branch before Task 1 could be approved: `bd8a66c`/`2f77147` (chunk-cycle fix, PR #16) and `393a004`/`3de6771` (deploy.sh leg-isolation fix, PR #17).
2. **Task 2: BLOCKING — run a real PITR restore drill against the CI-built image and capture the recorded figures** — no commit (live production operation; approved by operator, see evidence below).
3. **Task 3: Write the real drill figures into the runbooks** — `5962471` (docs)

**Plan metadata:** (this commit — SUMMARY.md, force-added per this repo's `.planning/` gitignore exception)

## Files Created/Modified

- `docs/runbooks/restore-drill.md` — new "Recorded drill runs" table with the real 2026-08-19 figures, the cross-version restore-proof narrative, a derived free-disk-headroom rule tied to current PGDATA size, the `-u postgres` fix on prerequisite 1's `pgbackrest info` command, and an updated "what was NOT verified locally" list
- `docs/runbooks/backups.md` — pgBackRest version note updated to 2.59.1-as-observed with the unpinned-apt-install root cause and the ratification citation; `-u postgres` added to the two hand-run `pgbackrest` commands (check, manual backup) with a note on why the cron and `backup-entrypoint.sh`-rerun paths were never affected; new legacy-Docker `manifest inspect` false-negative caveat with `docker buildx imagetools inspect` as the documented check for this host

## Decisions Made

See `key-decisions` in the frontmatter above for the full rationale on each ratification. Summary:

- pgBackRest 2.59.1 ratified over rebuilding a pinned image (proven compatible via the drill's cross-version restore, not merely asserted).
- The WAL-archiving acceptance criterion corrected from "failed_count is 0 in both reads" to "failed_count unchanged from baseline, last_failed unmoved" — the literal plan text was unsatisfiable against this host's real archiver history and is a documented defect in the plan's own drafting, not a scope change.
- D-11 amended from verify-still-running to establish-then-verify after discovering alloy was never durably deployed to production at all.
- The three-way bundled cutover was reordered (alloy first, not last) so the Loki eight-label check is structurally satisfiable — this reordering is this executor's own derivation from the dependency constraints, confirmed sound by the successful Attempt 3 run.
- Emergency rollbacks (used in attempts 1 and 2, not needed in attempt 3) use a local `docker tag` override, never a checkout revert, so a single change's rollback never disturbs sibling changes already applied in the same session.

## Deviations from Plan

### Auto-fixed / Ratified Issues

**1. [Rule 1 - Bug] WAL-archiving acceptance criterion corrected**
- **Found during:** Task 1, attempt 2, step 6
- **Issue:** The plan's own acceptance text ("`pg_stat_archiver.archived_count` is strictly greater in the second read than the first, `failed_count` is 0 in both") and must_haves truth #2 ("WAL archiving has resumed with a failed_count of zero") are unsatisfiable on a production host with archiver history — `failed_count` is cumulative since `stats_reset`, and this host's 67 historical failures all date to the 2026-08-14 stanza bring-up, never during any cutover.
- **Fix:** Ratified corrected criterion: `archived_count` strictly increases; `failed_count` stays unchanged from the step's own baseline read; `last_failed_time`/`last_failed_wal` unmoved. Verified against T-14-58/T-14-88's actual scope (provenance/tag-immutability, not archiver-history erasure) before adopting.
- **Verification:** Attempt 2 step 6 passed under the corrected criterion (archived_count 123->126, failed_count 67 unchanged, last_failed unmoved); attempt 3 confirmed it again (131->133, 67 unchanged).
- **Committed in:** n/a (staging/evidence-only; no code changed by this fix)

**2. [Rule 1 - Bug] `pgbackrest` interactive invocations require `-u postgres`**
- **Found during:** Task 1, attempt 2, step 6 (`pgbackrest error [031]` running as root)
- **Issue:** The plan's staged step 6 and the pre-existing `docs/runbooks/backups.md`/`restore-drill.md` documented `pgbackrest` commands run via bare `docker compose exec pgbackrest pgbackrest ...`, which defaults to the container's root user; pgBackRest refuses to run as root. The scheduled cron path and `backup-entrypoint.sh <type>` were never affected because both already `gosu postgres` internally.
- **Fix:** `-u postgres` added everywhere an operator runs `pgbackrest` interactively: this plan's own staged Task 1/Task 2 commands, and (in Task 3) `docs/runbooks/backups.md`'s "check"/"backup" commands and `docs/runbooks/restore-drill.md`'s prerequisite-1 `info` command.
- **Files modified:** `docs/runbooks/backups.md`, `docs/runbooks/restore-drill.md`
- **Verification:** Attempt 2 step 6 and the Task 2 drill's prerequisite both succeeded with `-u postgres`.
- **Committed in:** `5962471` (Task 3 commit)

**3. [Rule 3 - Blocking] Legacy Docker client `manifest inspect` false-negative on the VPS**
- **Found during:** Task 1, attempt 2's re-run of step 0
- **Issue:** `docker manifest inspect "$GHCR_IMAGE_BASE/postgres:<sha>"` returned `no such manifest` on this VPS even for an image independently confirmed present via the GHCR Registry API — the host's Docker 20.10.21 client cannot read the OCI-index manifest format CI publishes.
- **Fix:** `docker buildx imagetools inspect` substituted as the documented pre-flight check for this host in every staging from attempt 1 onward, and recorded in `docs/runbooks/backups.md` as a permanent caveat for future operators.
- **Files modified:** `docs/runbooks/backups.md`
- **Verification:** `docker buildx imagetools inspect` succeeded in all three attempts, matching the expected digest each time.
- **Committed in:** `5962471` (Task 3 commit)

**4. [Rule 2 - Missing Critical] Production checkout was never staged as an explicit step**
- **Found during:** Task 1, attempt 1's re-run (operator had to improvise it, then reverse it during rollback)
- **Issue:** The plan's original how-to-verify text never named that the production checkout must be on a SHA whose `docker-compose.prod.yml` has the pull-only, no-`build:`-key db/pgbackrest block (present only from plan 17-03's merge forward) — the checkpoint text assumed this was already true.
- **Fix:** An explicit checkout-update step was added ahead of the db cutover in every subsequent staging, with its own rollback consideration (per-change rollback never reverts the checkout; only a full-attempt abandonment does).
- **Verification:** Attempts 2 and 3 both executed the explicit checkout-update step cleanly.
- **Committed in:** n/a (staging/evidence-only)

**5. [Rule 4 → escalated and resolved by the coordinator, not self-decided] Two production-affecting code defects discovered live**
- Found by this plan's own checkpoints (chart/flow-editor crash at Task 1 attempt-2 step 7; deploy.sh leg-isolation hazard caught by the operator's dry-run before attempt 3's Change A). Both are genuine architectural/code fixes outside this plan's `files_modified` and outside any auto-fix rule available to this executor — correctly escalated as Rule 4 material, fixed by the orchestrator as phase-17 side work (PR #16, PR #17), and merged into the SHA this plan's own cutover used. Recorded here, not authored by this plan.

---

**Total deviations:** 4 auto-fixed/ratified by this executor within its deviation authority (2 Rule 1, 1 Rule 3, 1 Rule 2) + 2 escalated-and-externally-resolved (Rule 4, via PR #16/#17).
**Impact on plan:** All ratifications were verified against T-14-58/T-14-88's actual threat-register scope and D-05/D-06/D-11's actual decision text before adoption — none silently expanded this plan's scope, and each is traceable to a specific piece of live evidence (the drill's cross-version restore, the archiver's historical-failure timestamps, the operator's own dry-run catch). No scope creep.

## Issues Encountered

- **Worktree removed mid-plan.** The spawn worktree (`agent-acfa129939a875621`) was force-removed by the orchestrator while this plan was paused at Task 1's precondition checkpoint. Zero commits existed in it at removal time, so nothing was lost; execution continued in the main checkout on `gsd/phase-17-address-tech-debt-wr-06-medium-security-follow-ups` in sequential mode for the remainder of the plan, per orchestrator instruction.
- **Two production attempts rolled back before the third stayed in place** — see the "Attempt 1" / "Attempt 2" evidence sections below for full detail. Neither rollback was caused by a defect in the CI-built postgres image; both were staging/runbook defects, corrected before the next attempt.
- **Local `master` ref was stale throughout this plan** (parked at the Phase 8 merge, 811 commits behind `origin/master`) — caused an initial, corrected misreading of "how far behind master the phase branch is" at the very first precondition check. Did not affect any live production action; resolved once the operator supplied the real merge SHAs.

## User Setup Required

None beyond what the operator already performed live during this plan's checkpoints (Grafana Loki credentials provisioned in `MEGA_CRM_ENV_FILE`; `POSTGRES_IMAGE_TAG=1e061016dbf63016ab9aaeff9a3b995f8a55294f` set in the same file). No further external service configuration required.

## Next Phase Readiness

- Plan 17-06 can proceed: T-14-58/T-14-73/T-14-88's register annotations have live, pasted evidence to cite from this SUMMARY.
- **Flagged for 17-06's documentation pass (not edited by this plan):**
  - `v1.1-MILESTONE-AUDIT.md` line 94's compose-env-vars claim is false — the named entries (lines 487-496) never existed as compose entries; Grafana/Loki credentials arrive only via `env_file`.
  - `STATE.md:371`'s "live redeploy of the committed config confirmed" (Phase 15, 2026-08-17) directly contradicts this plan's live finding that alloy was never durably deployed to production before 2026-08-19 — and `v1.1-MILESTONE-AUDIT.md` itself already called the live redeploy "outstanding," so the contradiction is between two prior planning artifacts, not something this plan introduced.
  - Stale pgBackRest `2.59.0` mentions remain in `docker/postgres/Dockerfile`'s own comment and in `SPECIFICATION.md` — both outside this plan's `files_modified`; `docs/runbooks/backups.md` (in scope) is already corrected.
- No blockers. Production is stable on the new artifacts (postgres image, alloy, and the `ca2031c7...`-tagged app images) as of this SUMMARY's writing.

---

## Full Evidence Trail

### Task 1 — Attempt 1 (rolled back; NOT approval evidence)

**Steps 0-5: PASSED.** Digest `sha256:65a18dc40c74028e1d54b23c5e6f6d0754cc49b5d7253dd76c8ac0ba0bd45398` (OCI index) / `sha256:5697782e12c2df655f7798c51eb26851f37b8cfa82d576b64890ffacda6ae519` (linux/amd64, matched expected); pull succeeded; PostgreSQL 17.11 (major matches production); pgBackRest 2.59.1 (did not match the runbook's documented 2.59.0 at this point — not yet ratified).

**Stopped before any production mutation, at step 0's acceptance check**, on the pgBackRest version mismatch (Finding 1) and a mount-name expectation-text mismatch (Finding 2, `docker_`-prefixed volume names vs. the plan's unprefixed staged text). No rollback needed — production was never touched. Both findings reconciled and ratified (see Deviations above and the pgBackRest ratification in `docs/runbooks/backups.md`) before attempt 2.

### Task 1 — Attempt 2 (rolled back; NOT approval evidence)

**Steps 0-5: PASSED.** Index digest `sha256:65a18dc4...`; PostgreSQL 17.11; pgBackRest 2.59.1 exactly (ratified); baseline image id `sha256:de6a69e44325fad31166b67df67658d6b135288296a316b180f82feae4493830`; 0 active non-probe DB sessions; checkout moved `4940cc6` → `1e061016dbf63016ab9aaeff9a3b995f8a55294f`; `compose config` resolved `db`+`pgbackrest` to the GHCR SHA with no `build:` key; new running image id `sha256:e718495c825dd0917a2a52250135eb2dc2c4e9ddecb29599a7d42c3fa48e0e07`; db healthy, `pg_isready` OK; mount set identical (`docker_mega_crm_db_certs_prod`, `docker_mega_crm_db_data_prod`, `docker_mega_crm_pg_socket_prod`); RLS: every non-exempt tenant-scoped table `t/t`, `reputation_alert_state` the documented `f/f` exemption.

**Step 6 — FAILED against the plan's literal criterion, PASSED under the ratified corrected one (after a mid-session fix).** First read: `archived_count=123`, `failed_count=67`, `last_archived_wal=...05F` @ `2026-08-19 13:26:03.569435+00`, `last_failed=...001` @ `2026-08-14`. `pgbackrest check` run as root failed with error `[031]`; corrected to `-u postgres`, which then succeeded and archived WAL `...063`. Second read: `archived_count=126` (+3), `failed_count=67` unchanged, `last_failed` unmoved. Rolled back at this point per the stop rule, because the correction happened mid-session and the attempt itself is not self-contained evidence.

**Step 7 — FAILED.** All services `Up`, `/readyz` → `ready=true`, but the real-workspace dashboard growth chart failed to render: contained route error "Не удалось отобразить страницу"; browser console `TypeError: P is not a function` at `charts-vendor-DUCIaUJK.js:4:2053`. **The same error persisted after rollback** — confirmed pre-existing in the currently-deployed web bundle, unrelated to the db cutover.

**Step 8 — BLOCKED, not attempted.** No `alloy` container existed on production at all; `MEGA_CRM_ENV_FILE` had none of `GRAFANA_LOKI_PUSH_URL`/`GRAFANA_LOKI_USER`/`GRAFANA_CLOUD_API_TOKEN`.

**Rollback:** checkout → `4940cc6`; `POSTGRES_IMAGE_TAG` → `local`; db image → `megacrm-postgres:local` (`sha256:de6a69e4...`); db healthy; mounts preserved; all services `Up`; `/readyz` → `ready=true`. Steps 7-8's failures triggered the two orchestrator-side fixes (PR #16 chunk-cycle; the alloy root-cause investigation that produced the D-11 amendment) that made attempt 3 possible.

### Task 1 — Attempt 3 (APPROVED — this is the evidence that closes D-07/D-11)

**Step 0 (checkout):** `4940cc6` → `0364515f72ea4483595ffd11e45634a11f578915` (chunk-cycle fix, PR #16) → `ca2031c741347e5af5bffe717a50ab745cfbd9f7` (also carries the deploy.sh leg-isolation fix, PR #17; Images workflow run `32275780526` success, all four `build-and-push` jobs green).

**Change B1 (alloy establish, first half of amended D-11):** Grafana credentials provisioned ("Mega CRM Loki writer" policy, `logs:write` scope; value never printed, temp copy deleted). `docker compose up -d --no-deps alloy` succeeded. Baseline observation: `RestartCount=0, running, StartedAt=2026-08-19T14:51:16.867549256Z`. Initial startup replayed ancient logs from historical containers and returned "timestamp too old" until the backlog drained — expected `discovery.docker`-on-first-start behavior, not a defect. Subsequent 60s observation: `RestartCount 0`, running, 0 recent errors.

**Change A (apps, `ca2031c741347e5af5bffe717a50ab745cfbd9f7`):** Dry-run confirmed `--no-deps` on `migrate`/`web+api`/`worker`, zero `db`/`redis` recreation (the exact defect the operator's own dry-run had caught before this attempt, now closed by PR #17). Deploy completed; rollback SHA printed by `deploy.sh`: `4940cc6eb0350554f8b3138adba14db08a60c4fe`. `/readyz` → `ready=true` (postgres, redis, migrations OK). Dashboard rendered both the delivery chart and the contact-growth chart; the Phase 16 standing-canary flow's editor opened and rendered its canvas — both previously-broken routes now clean.

**Change C (db/pgbackrest cutover, `POSTGRES_IMAGE_TAG=1e061016dbf63016ab9aaeff9a3b995f8a55294f`, unchanged from the twice-proven target):**
- Pre-flight: amd64 digest `sha256:5697782e12c2df655f7798c51eb26851f37b8cfa82d576b64890ffacda6ae519`; PostgreSQL 17.11; pgBackRest exactly 2.59.1.
- Baseline: image id `sha256:de6a69e4...`; disk 25G total / 18G used / 6.8G available.
- Cutover: `compose config` showed the pinned GHCR tag, no `build:` directive; new running image id `sha256:e718495c825dd0917a2a52250135eb2dc2c4e9ddecb29599a7d42c3fa48e0e07`; db healthy, `pg_isready` OK; mount set unchanged (`docker_mega_crm_db_data_prod`, `docker_mega_crm_db_certs_prod`, `docker_mega_crm_pg_socket_prod`).
- RLS: 28 workspace tables checked, all non-exempt `t/t`, `reputation_alert_state` `f/f` documented exemption, bad count 0.
- WAL (ratified corrected criterion): before `archived_count=131/failed_count=67`; `pgbackrest check` (as `postgres`) success, archived WAL `...06B`; after `archived_count=133/failed_count=67 unchanged`; `last_failed_wal`/`last_failed_time` unmoved.

**Step 7 (re-confirmation):** `/readyz` stayed green after the db recreate; dashboard growth chart rendered again; flow-editor canvas rendered again.

**Change B2 = Step 8 (second half of amended D-11):** Final `RestartCount` read **identical** to B1's baseline: `0 running 2026-08-19T14:51:16.867549256Z` — same `StartedAt`, zero restarts across the entire bracket (provisioning → pause for the deploy.sh dry-run/fix → app deploy → db cutover). Transient stale-container inspection messages during container replacement, non-fatal; 0 errors in the final five-minute window. Loki last-15-min service label set: `alloy, api, db, pgbackrest, redis, web, worker` — all seven hard labels present; `migrate` best-effort-absent as anticipated (container removed on exit by `deploy.sh`).

**No rollback used. Production remains on all three of these artifacts as of this SUMMARY.** Must-haves truth #1 ("Production's db and pgbackrest containers run the CI-built, GHCR-pulled, SHA-tagged postgres image — observed live") is now TRUE in the present tense.

### Task 2 — restore drill (APPROVED)

- **Pre-flight:** checkout `ca2031c741347e5af5bffe717a50ab745cfbd9f7`; disk 25G total / 18G used / 6.8G available; `pgbackrest info` (run as `postgres`) reported stanza `mega_crm` status `ok`, cipher `aes-256-cbc`, WAL min/max `000000010000000000000005` / `00000001000000000000006D`.
- **PITR target:** `2026-08-19 17:00:00+00` — chosen from the `info` output as falling between the successful backups at `2026-08-19 14:00:05–14:00:17 UTC` (WAL `...0066`) and `18:00:04–18:00:17 UTC` (WAL `...006D`).
- **Dry-run confirmed:** image `ghcr.io/nimther/local-crm/postgres:1e061016dbf63016ab9aaeff9a3b995f8a55294f` (not `local`); scratch container `megacrm-restore-drill-scratch`; scratch volume `megacrm_restore_drill_scratch_data`; production access limited to a read-only row-count baseline; `du -sk /var/lib/postgresql/data` sampled during readiness; metrics include `durationSeconds`/`diskHighWaterKb`; scratch resources removed after success.
- **Real drill:** scratch volume created → read-only production baseline captured → backup restored to target → scratch PostgreSQL ready → `db:verify-restored` **PASSED**.
- **Verification detail:** all table row counts validated against baseline/as-of target; expected PITR deltas: `ingress_journal` baseline=24600/restored=22513/delta=-2087, `send_events` baseline=29283/restored=26880/delta=-2403; all other reported tables delta=0; `events` partitions OK (12 attached); `send_events` partitions OK (12 attached); RLS posture: 28 tenant-scoped tables checked; final line: `"OK: restored database verification passed."`
- **Cross-version ratification proof point landed:** backups written by pgBackRest **2.59.0** were successfully restored and verified by the **2.59.1** binary — the concrete evidence behind the pgBackRest-drift ratification in `docs/runbooks/backups.md`.
- **Metrics NDJSON (verbatim, used unmodified in `docs/runbooks/restore-drill.md`):**
  ```json
  {"target":"2026-08-19 17:00:00+00","outcome":"verified","durationSeconds":119,"diskHighWaterKb":170520,"recordedAt":"2026-08-19T19:27:46Z"}
  ```
- **Cleanup:** no scratch container remains; no scratch volume remains.
- **Production after:** `alloy, api, db, pgbackrest, redis, web, worker` all `Up`; api/db/redis/web/worker healthy; `/readyz` → `{"ready":true,"checks":[postgres ok, redis ok, migrations ok]}`.

### Digit-for-digit comparison: metrics NDJSON vs. runbook table

| Field | Metrics NDJSON | `docs/runbooks/restore-drill.md` table row | Match |
|---|---|---|---|
| target | `2026-08-19 17:00:00+00` | `2026-08-19 17:00:00+00` | ✓ |
| durationSeconds | `119` | `119s` | ✓ |
| diskHighWaterKb | `170520` | `170520 KB (~166.5 MB)` | ✓ |
| image | `ghcr.io/nimther/local-crm/postgres:1e061016dbf63016ab9aaeff9a3b995f8a55294f` (per dry-run/real-run confirmation) | `ghcr.io/nimther/local-crm/postgres:1e061016dbf63016ab9aaeff9a3b995f8a55294f` | ✓ |
| outcome | `verified` | `verified` | ✓ |

## Self-Check: PASSED

- FOUND: `docs/runbooks/restore-drill.md`
- FOUND: `docs/runbooks/backups.md`
- FOUND: commit `5962471` (Task 3)
- FOUND: commit `393a004` (deploy.sh leg-isolation, RED, PR #17)
- FOUND: commit `3de6771` (deploy.sh leg-isolation, GREEN, PR #17)
- FOUND: commit `bd8a66c` (chunk-cycle gate, RED, PR #16)
- FOUND: commit `2f77147` (chunk-cycle fix, GREEN, PR #16)
- FOUND: commit `31c43cd` (CI portability fix, pre-existing on this branch)

---
*Phase: 17-address-tech-debt-wr-06-medium-security-follow-ups*
*Completed: 2026-08-20*
