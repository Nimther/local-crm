---
phase: 14-deployment-database-durability
plan: 10
subsystem: infra
tags: [pgbackrest, postgres, backups, wal-archiving, s3, cloudflare-r2, docker, cron]

requires:
  - phase: 14-deployment-database-durability
    provides: docker-compose.prod.yml `db` service (image, TLS entrypoint, volumes, memory limit, oom_score_adj), scripts/validate-prod-compose.mjs invariant-gate structure, MEGA_CRM_ENV_FILE convention (plan 14-08)
provides:
  - docker/postgres/Dockerfile — custom Postgres 17 image adding pgBackRest 2.59.0, cron, and CA trust store
  - docker/pgbackrest/pgbackrest.conf — one `mega_crm` stanza, S3-type off-host repository, aes-256-cbc repository cipher, count-based retention (2 full backups)
  - docker/pgbackrest/crontab + backup-entrypoint.sh — full/differential/incremental schedule plus daily verification, loud non-zero-exit failures
  - scripts/validate-prod-compose.mjs invariants for the `pgbackrest` service and credential-free config
  - docs/runbooks/backups.md — cadence/retention rationale, verification command and its limits, failed-backup procedure, escrow requirement, Phase 15 alerting deferral
  - Real off-host backup + WAL evidence: a full backup listed by `pgbackrest info` as encrypted, real WAL segments in the Cloudflare R2 bucket, an unattended scheduled backup, a non-public bucket, and an escrowed cipher passphrase — confirmed by operator on the production VPS
affects: [phase-14-plan-11-restore-drill, phase-14-plan-12-retention, phase-14-plan-13-specification]

tech-stack:
  added: [pgbackrest@2.59.0]
  patterns:
    - "One Dockerfile, two entrypoints: the `db` service and the `pgbackrest` sidecar both build from the same custom Postgres image, sharing an identical pgBackRest binary, OS user (uid 999) and filesystem layout — required because archive_command runs inside the `db` container's own Postgres process, so a sidecar-only install cannot archive WAL"
    - "Config-file-says-WHAT / comment-next-to-schedule-says-WHY: pgbackrest.conf's retention setting and crontab's cadence each carry their own rationale, cross-referenced rather than duplicated"
    - "Real off-host bucket evidence is required at a blocking checkpoint (gate=blocking) — no S3 credential exists in CI, and mocking the object store would prove nothing about the claim (backups leave the host, decrypt, restore)"

key-files:
  created:
    - docker/postgres/Dockerfile
    - docker/pgbackrest/pgbackrest.conf
    - docker/pgbackrest/backup-entrypoint.sh
    - docker/pgbackrest/crontab
    - docs/runbooks/backups.md
  modified:
    - docker/docker-compose.prod.yml
    - docker/prod.env.example
    - scripts/validate-prod-compose.mjs
    - scripts/__tests__/validate-prod-compose.test.mjs

key-decisions:
  - "Stanza name: `mega_crm` (single stanza — one database, per plan scope)"
  - "Retention: 2 full backups, count-based (repo1-retention-full=2) — roughly two weeks of restorable history, the actual recovery horizon plan 14-12's partition-drop retention tick depends on"
  - "Cadence: full Sunday 02:00 UTC, differential Mon-Sat 02:00 UTC, incremental at 06/10/14/18/22:00 UTC, check daily 03:30 UTC — RPO bounded by continuous WAL archiving (seconds), RTO bounded by full+diff+incrementals replay (first-principles estimate, under an hour for current data volume; plan 14-11's restore drill supplies a real measurement)"
  - "Off-host repository provider: Cloudflare R2 (S3-compatible) — confirmed by the post-checkpoint CA trust store fix (20edff7), not named explicitly in the plan"
  - "Post-checkpoint real-host iteration: R2's TLS certificate could not be verified from the slim Postgres image without an explicit CA bundle; ca-certificates added to docker/postgres/Dockerfile and merged via PR #10 (20edff7 'fix(backups): install CA trust store for R2') before the checkpoint could be approved"

requirements-completed: [DB-09]

coverage:
  - id: D1
    description: "Custom Postgres 17 image with pgBackRest 2.59.0 installed, so archive_command executes inside the same container as the Postgres server process"
    requirement: "DB-09"
    verification:
      - kind: other
        ref: "docker build -f docker/postgres/Dockerfile && docker run --rm megacrm-postgres:local pgbackrest version"
        status: pass
    human_judgment: false
  - id: D2
    description: "pgbackrest.conf: off-host S3-type repository, aes-256-cbc repository cipher, count-based retention, no literal credential — all six PGBACKREST_* values read from environment"
    requirement: "DB-09"
    verification:
      - kind: other
        ref: "grep -v '^\\s*#' docker/pgbackrest/pgbackrest.conf | grep -riE \"(secret|key|pass)[[:space:]]*=[[:space:]]*[^$[:space:]]\" (no output)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Scheduled full/differential/incremental backups plus daily verification, loud non-zero-exit on failure; compose invariants for the pgbackrest service and credential-free config"
    requirement: "DB-09"
    verification:
      - kind: unit
        ref: "scripts/__tests__/validate-prod-compose.test.mjs (pgbackrest service present/memory-limit/no-port/shared-volume fixtures, literal-credential fixture)"
        status: pass
      - kind: other
        ref: "bash -n docker/pgbackrest/backup-entrypoint.sh && npm run verify:prod-compose"
        status: pass
    human_judgment: false
  - id: D4
    description: "First real backup, real WAL shipment, an unattended scheduled backup, a non-public off-host bucket, and an escrowed cipher passphrase, all confirmed against the real Cloudflare R2 repository on the production VPS"
    requirement: "DB-09"
    verification: []
    human_judgment: true
    rationale: "Blocking checkpoint (Task 3) — no S3 credential exists in the executor sandbox and mocking the object store would prove nothing about the claim being made (backups actually leave the host, encrypt, and are reachable). Operator performed the nine how-to-verify steps on the real production VPS and reported 'approved' on 2026-08-14."

duration: —
completed: 2026-08-14
status: complete
---

# Phase 14 Plan 10: pgBackRest Backups Summary

**pgBackRest 2.59.0 baked into a custom Postgres 17 image so `archive_command` can run in-container, shipping continuous WAL and scheduled full/differential/incremental backups to an encrypted, off-host Cloudflare R2 repository — verified with a real backup, real WAL segments and an unattended scheduled run on the production VPS.**

## Performance

- **Tasks:** 3 (Task 1 auto, Task 2 TDD, Task 3 blocking checkpoint)
- **Files modified:** 9 (docker/postgres/Dockerfile, docker/pgbackrest/pgbackrest.conf, docker/pgbackrest/backup-entrypoint.sh, docker/pgbackrest/crontab, docker/docker-compose.prod.yml, docker/prod.env.example, scripts/validate-prod-compose.mjs, scripts/__tests__/validate-prod-compose.test.mjs, docs/runbooks/backups.md)

## Accomplishments

- **Task 1:** `docker/postgres/Dockerfile` extends `postgres:17` with pgBackRest 2.59.0, `cron`, and `ca-certificates` — all from the base image's own Debian/PostgreSQL apt repositories, no third-party source. The version and every pgbackrest.conf key/command used in this plan were verified against the real installed binary (stanza-create, archive_mode=on + archive_command producing real archived WAL confirmed via `pg_stat_archiver`, `check`, a real `--type=full backup`, and `info` reporting `cipher: aes-256-cbc`) rather than trusted from RESEARCH.md's flagged-assumed values. `docker/pgbackrest/pgbackrest.conf` defines one stanza (`mega_crm`), an S3-type repository, `repo1-cipher-type=aes-256-cbc`, and count-based retention (`repo1-retention-full=2`) — no credential value in the file (grep-asserted). The `db` service and a new `pgbackrest` sidecar service both build from this same image, sharing the Postgres data volume and a `/var/run/postgresql` socket volume; the sidecar carries a memory limit, no published port, and the same `oom_score_adj` treatment as other non-database services. `docker/prod.env.example` documents all six `PGBACKREST_*` names with no values, including the escrow note on the cipher passphrase.
- **Task 2 (TDD):** `docker/pgbackrest/crontab` + `backup-entrypoint.sh` run backups automatically with no operator action: full every Sunday 02:00 UTC, differential Mon-Sat 02:00 UTC, incremental five times daily, and pgBackRest's own verification daily at 03:30 UTC — each schedule line carries its rationale, and the cadence/retention comments state the resulting RPO (seconds, via continuous WAL archiving) and RTO (first-principles estimate, under an hour) explicitly. The entrypoint exits non-zero and logs the stanza and backup type on failure rather than swallowing it. `scripts/validate-prod-compose.mjs` gained invariants asserting the `pgbackrest` service exists, has a memory limit, publishes no port, shares the data volume, and that the pgBackRest config contains no literal credential — each with its own fixture in `scripts/__tests__/validate-prod-compose.test.mjs`, invariant count increased and reported. `docs/runbooks/backups.md` documents the cadence/retention rationale, what the verification command does and does not prove (coherent config and reachable repository, NOT a proven restore — that's DB-10/plan 14-11), the failed-backup procedure, the escrow requirement stated as a requirement, and the Phase 15 backup-failure-alerting deferral with its reason and channel.
- **Task 3 (blocking checkpoint — human-verify):** Operator confirmed on 2026-08-14, via the checkpoint prompt, that:
  1. A real full backup completed and is listed by `pgbackrest info`, with the repository reported encrypted.
  2. Real WAL segments are visible in the off-host Cloudflare R2 bucket after a forced WAL switch — WAL archiving is keeping up, not merely configured.
  3. A scheduled backup ran unattended, satisfying DB-09's "автоматически" wording.
  4. The bucket denies unauthenticated fetches — not publicly readable.
  5. The repository cipher passphrase is escrowed somewhere that survives the loss of the VPS. The operator confirmed the escrow was done but did not name the specific location in the "approved" reply; the requirement (escrow off the VPS) is satisfied, but the location itself is not recorded in project artifacts.

## Task Commits

Each task was committed atomically:

1. **Task 1: pgBackRest in the database image, WAL archiving, and the off-host encrypted repository** - `93d9c07` (feat)
2. **Task 2: scheduled backups, verification, and the compose invariants that protect them (TDD)** - `e394ff2` (feat)
3. **Task 3: first real backup and WAL shipment to the off-host repository** - checkpoint approved by operator 2026-08-14, no code change (recorded in this SUMMARY)

Real-host iteration discovered after the checkpoint was opened, landed on the branch before approval:
- `20edff7` — "fix(backups): install CA trust store for R2": the slim Postgres image could not verify Cloudflare R2's HTTPS certificate without an explicit CA bundle; `ca-certificates` added to `docker/postgres/Dockerfile` (merged via PR #10)

**Plan metadata:** committed together with this SUMMARY.md (see below).

## Files Created/Modified

- `docker/postgres/Dockerfile` - Custom Postgres 17 image: pgBackRest 2.59.0, cron, ca-certificates (added post-checkpoint for R2 TLS verification)
- `docker/pgbackrest/pgbackrest.conf` - `mega_crm` stanza, S3-type off-host repository, aes-256-cbc cipher, count-based retention
- `docker/pgbackrest/backup-entrypoint.sh` - Installs the crontab, runs backup/check commands, loud failure logging
- `docker/pgbackrest/crontab` - Full/differential/incremental schedule plus daily verification
- `docker/docker-compose.prod.yml` - `db` service switched to the custom image with archive settings; new `pgbackrest` sidecar service
- `docker/prod.env.example` - Six `PGBACKREST_*` names documented, no values, escrow note on the cipher passphrase
- `scripts/validate-prod-compose.mjs` - New invariants for the `pgbackrest` service shape and credential-free config
- `scripts/__tests__/validate-prod-compose.test.mjs` - Fixture per new invariant
- `docs/runbooks/backups.md` - Operator runbook: cadence/retention rationale, verification command and its limits, failed-backup procedure, escrow requirement, Phase 15 alerting deferral

## Decisions Made

- Stanza name `mega_crm` (single stanza, one database).
- Retention: 2 full backups, count-based — the actual recovery horizon plan 14-12's partition-drop retention tick depends on (D-08).
- Cadence: weekly full, daily differential, five-times-daily incremental, daily check — chosen deliberately per 14-CONTEXT.md's Claude's-Discretion note, with RPO/RTO stated in plain terms in both the crontab comment and the runbook.
- Repository provider is Cloudflare R2 (confirmed by the post-checkpoint CA fix, though the plan itself left the S3-compatible provider as an operator choice).
- Backup-failure alerting through the existing watchdog/`OPERATOR_ALERT_EMAIL` channel remains deferred to Phase 15 (OPS-06…OPS-15), as scoped by the plan; this plan delivers only the verification command and documents running it.
- Threat T-14-66 (an attacker with host access deleting backups) remains **accepted** per the plan's threat model: the checkpoint asked the operator to enable object versioning/immutability where the provider supports it and to scope the access key to the one bucket; full write-once storage and a separate deletion credential remain a follow-up, not built in this plan.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Installed CA trust store for R2 TLS verification**
- **Found during:** Task 3 (real-host checkpoint verification)
- **Issue:** The slim `postgres:17`-based image had no CA bundle, so pgBackRest could not verify Cloudflare R2's HTTPS certificate — the real S3 round trip that Task 1 explicitly deferred to Task 3 failed on first attempt during checkpoint verification.
- **Fix:** Added `ca-certificates` to the `apt-get install` line in `docker/postgres/Dockerfile`, alongside pgBackRest and cron, from the same trusted Debian/PostgreSQL apt repository — no third-party source, disabling TLS verification was never considered.
- **Files modified:** docker/postgres/Dockerfile
- **Verification:** Real backup and WAL shipment to R2 succeeded after the fix; confirmed by the operator's checkpoint approval.
- **Committed in:** `20edff7` (merged via PR #10, prior to this continuation)

---

**Total deviations:** 1 auto-fixed (1 blocking — missing CA trust store, discovered only once a real off-host TLS endpoint was involved, which Task 1 deliberately deferred to the checkpoint)
**Impact on plan:** Necessary for the off-host repository to be reachable at all over TLS; no scope creep — the fix is exactly the "install from the image's own trust boundary" pattern the Dockerfile's own header comment already established for pgBackRest and cron.

## Issues Encountered

None beyond the CA trust store gap recorded above, which is documented as a deviation rather than an issue since it was resolved via the standard Rule 3 auto-fix path before the checkpoint could be approved.

## User Setup Required

The six `PGBACKREST_*` values (endpoint, bucket, region, key, key secret, cipher passphrase) populated in the production `MEGA_CRM_ENV_FILE`, a bucket created with public access disabled, and the cipher passphrase escrowed off the VPS — all confirmed present and exercised during the real-host checkpoint. See `docs/runbooks/backups.md`.

## Next Phase Readiness

- DB-09 is closed: WAL archives continuously off-host, scheduled backups run unattended on a documented cadence, the repository is encrypted and non-public, and a real full backup plus real WAL segments are confirmed present in the off-host Cloudflare R2 repository.
- Plan 14-11 (restore drill, DB-10) can proceed: the repository, stanza (`mega_crm`) and retention window this plan established are exactly what a real restore drill needs, and the runbook explicitly defers "restore" documentation to that plan.
- Plan 14-12 (retention) has its actual recovery horizon recorded here: 2 full backups retained, roughly two weeks of restorable history.
- Plan 14-13 (SPECIFICATION.md) needs: pgBackRest 2.59.0, the `postgres:17` base tag, the `mega_crm` stanza name, the cadence/retention rationale, and the six `PGBACKREST_*` env var names — all recorded above for §2, §3 and §8.
- Backup-failure alerting remains an explicit, named Phase 15 consumer (OPS-06…OPS-15) of the proven tick-plus-watchdog pattern, not built here.
- The remaining pending real-host checkpoint (14-11 restore drill) stays open per STATE.md's Pending Checkpoints section; this plan's 14-10 bullet is removed by this SUMMARY's tracking-update commit.

## Self-Check: PASSED

- FOUND: `docker/postgres/Dockerfile`
- FOUND: `docker/pgbackrest/pgbackrest.conf`
- FOUND: `docker/pgbackrest/backup-entrypoint.sh`
- FOUND: `docker/pgbackrest/crontab`
- FOUND: `docs/runbooks/backups.md`
- FOUND: commit `93d9c07` (Task 1)
- FOUND: commit `e394ff2` (Task 2)
- FOUND: commit `20edff7` (post-checkpoint CA trust store fix, PR #10)
- Task 3 has no commit of its own (checkpoint approval, no code) — recorded here per the plan's blocking-checkpoint convention.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-14*
