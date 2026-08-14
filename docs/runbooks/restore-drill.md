# Restore Drill Runbook

Implements requirement **DB-10** and decision **D-07**
(`.planning/phases/14-deployment-database-durability/14-CONTEXT.md`): a
point-in-time restore, performed and written up, not merely configured.
`docs/runbooks/backups.md` (plan 14-10) documents backups being written
automatically (DB-09); this runbook documents `scripts/restore-drill.sh`
(plan 14-11) restoring one, which is a genuinely separate requirement for
exactly the reason that runbook's own header explains — a green
`pgbackrest check` means the configuration is coherent, never that a
restore actually works.

## What this drill proves, and what it does not

**Proves:** the real repository's bytes decrypt, the real backup plus WAL
replay reaches a chosen moment in time (not merely "the latest backup
unpacks"), the restored cluster's schema-correctness properties survive the
round trip (every expected monthly partition attached, row-level security
enabled **and forced** on every tenant-scoped table), and roughly how long a
restore of this cluster's current data volume takes.

**Does not prove:** that a *fresh* VPS can be provisioned and made fully
production-ready from nothing (D-07 names this the **full disaster-recovery
rehearsal**, an explicit stretch variant of this baseline drill — see
"What this is not" below); that the S3 bucket itself will always be
reachable during a real incident; that an operator unfamiliar with this
runbook could execute the recovery under pressure without having read it
first.

## Prerequisites

Confirm both of these **before** running the drill for real — the script
does not (cannot, from the host) verify either one itself:

1. **At least one full backup and a span of WAL exist in the repository:**
   ```bash
   docker compose -f docker/docker-compose.prod.yml exec -T pgbackrest \
     pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=mega_crm info
   ```
   Read `docs/runbooks/backups.md`'s "Cadence and retention" section for
   what "inside the retention window" means for choosing a target below —
   roughly two weeks behind the newest full backup (`repo1-retention-full=2`,
   count-based).
2. **Enough free disk on the VPS for a second copy of the cluster's current
   data volume**, for the duration of the drill:
   ```bash
   df -h /var/lib/docker   # or wherever the Docker data-root actually lives
   ```
   **Recorded figure (filled in at the checkpoint, not invented here):**
   `<TO BE RECORDED BY THE OPERATOR AT DRILL TIME>` — see this plan's own
   SUMMARY.md for the number actually observed during the drill that closed
   DB-10.

## How to run it

```bash
./scripts/restore-drill.sh --dry-run '2026-08-01 12:00:00+00'   # read this first
./scripts/restore-drill.sh '2026-08-01 12:00:00+00'             # the real thing
```

The target is **required** — there is no "latest" default. Defaulting to
the latest backup would let this drill degrade into "we unpacked a backup",
which is not what DB-10 claims and not what point-in-time recovery means.

**Target format:** `'YYYY-MM-DD HH:MM:SS+00'` — UTC, with the offset spelled
out explicitly. This is the exact format
`packages/db/src/partitions/ensure-partitions.ts`'s own `utcTimestampLiteral`
produces elsewhere in this codebase, and the exact format this plan's own
local rehearsal (see "What this plan verified locally" below) confirmed
round-trips correctly through pgBackRest's `--type=time --target=...
--target-action=promote`.

**Read the dry run first.** It prints the exact command sequence with no
side effects: creating the scratch volume, capturing a read-only row-count
baseline from production, restoring with WAL replay into the scratch
container, waiting for it to become ready, verifying it, and tearing it
down. Confirm before running for real that every container/volume name it
prints differs from `db`/`pgbackrest`/the six `mega_crm_*_prod` volumes —
the script asserts this itself at runtime (reading the names from
`docker/docker-compose.prod.yml`, never a hardcoded list), but reading the
dry run is the operator's own independent confirmation.

**Environment required for a real run:** `MEGA_CRM_ENV_FILE` (same file
`scripts/deploy.sh` uses — the operator's real secrets, including
`POSTGRES_PASSWORD`, which the restored cluster's own physical backup
already carries, and the six `PGBACKREST_*` repository credentials
`docs/runbooks/backups.md` documents). Nothing else needs to be exported by
hand.

## Choosing a PITR target, and confirming the restored cluster reflects it

Picking a target and confirming the restore reflects it (not merely "a
restore that starts") is the marker-row procedure this drill's own
checkpoint runs:

1. Note the current time, then write a recognisable marker row into a
   non-production-critical table through the application, and note that
   time too — two timestamps bracketing a known change.
2. Wait for or trigger a WAL switch (`SELECT pg_switch_wal();` against the
   live `db` service) so the marker is archived.
3. Run the drill with a target **before** the marker was written.
4. Confirm the restore completes and `db:verify-restored` passes (expected
   partitions attached, RLS enabled and forced, row counts consistent with
   the baseline).
5. **Confirm the marker row is ABSENT** from the restored cluster (connect
   to `127.0.0.1:${RESTORE_DRILL_SCRATCH_PORT:-55611}` with `psql`, same
   `POSTGRES_PASSWORD`). This is the step that actually proves point-in-time
   recovery rather than backup-unpacking — if the marker is present, WAL
   replay overshot the target.
6. Confirm the production database was untouched throughout: the marker row
   is still there, production is still serving.
7. Confirm the scratch container and volume were destroyed after the
   successful run (`docker ps -a`, `docker volume ls` should show neither).
8. Record the wall-clock duration (the script's own `docker run`-to-ready
   timing, printed inline) and the disk high-water mark observed during the
   restore.
9. Run the drill once more with a target **after** the marker and confirm
   the marker **IS** present — demonstrating both directions of target
   selection, not just one.

## Reading the verification output

`npm run db:verify-restored --workspace=packages/db -- --baseline=<file>
--as-of=<target>` (invoked by the drill script itself; see
`packages/db/scripts/verify-restored-database.ts` for the full mechanism)
prints, per table, the observed row count; per partitioned table, which
expected monthly partitions are attached and which (if any) are missing;
and, for every tenant-scoped table, whether row-level security is enabled
**and forced**. It exits non-zero — and never prints an "OK" line — when any
of those three checks fails, or when it could not connect or a query
failed. A baseline diff section (when `--baseline` was supplied, which the
drill always does) reports the delta against the row counts captured from
production immediately before the restore — a sanity check that the
restored cluster's data volume is in the right ballpark, not a pass/fail
gate on its own.

**Capturing a baseline by hand** (the drill does this automatically, but
this is the exact mechanism, useful for a manual check): production's `db`
service publishes no port (`docker/docker-compose.prod.yml`, T-14-43), so
this cannot be read from the host directly — it goes through
`docker compose exec`, read-only:

```bash
docker compose -f docker/docker-compose.prod.yml exec -T db \
  psql -U postgres -d mega_crm -tAc "
SELECT json_object_agg(t.relname, t.cnt)
FROM (
  SELECT c.relname,
         (xpath('/row/c/text()',
                query_to_xml(format('SELECT count(*) AS c FROM %I', c.relname), false, true, '')
               ))[1]::text::bigint AS cnt
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
) t;" > baseline.json
```

This produces the exact flat `{"<table>": <count>, ...}` shape
`verify-restored-database.ts`'s own `Baseline` type expects, using the SAME
catalog walk (`pg_class`/`pg_namespace`, excluding partitions) its
`checkRowCounts` uses — the two can never disagree about which tables
exist. Verified directly against a real local Postgres by this plan (this
exact query, run against this repository's own dev database, produced a
complete, correctly-shaped JSON object for all 38 real tables).

## What to do when the drill fails, at each stage

- **Baseline capture fails:** the script aborts before creating the scratch
  container. Production was not touched. Check that `db` is actually
  running and that the psql credentials in `MEGA_CRM_ENV_FILE` are current.
- **Restore fails to start** (`docker run` itself errors, or the restore
  inside the container fails before Postgres starts): the scratch
  container/volume are **left in place** for inspection — the script prints
  the exact cleanup command. Read `docker logs <scratch-container-name>`
  first; the most common cause is the target falling outside the retention
  window (`pgbackrest info` above), a network/credential problem reaching
  the S3 repository, or a wrong cipher passphrase.
- **Readiness times out:** same as above (scratch resources preserved) —
  the restored cluster started but never became ready within
  `RESTORE_DRILL_READY_TIMEOUT_SECONDS` (default 120s). Check
  `docker logs` for a recovery error (a bad/unreachable `restore_command`
  mid-replay is the usual cause).
- **Verification fails:** same disposition again — scratch resources
  preserved, so the restored cluster stays inspectable. Read
  `db:verify-restored`'s own printed report: it names exactly which
  partition is missing or which table's RLS posture fell short, so this is
  a diagnosis starting point, not a dead end.
- **Everything up to and including verification succeeds:** the scratch
  container and volume are destroyed automatically. Nothing to clean up.

## The teardown asymmetry, stated explicitly

**Success destroys; failure preserves.** A drill that leaves a second,
decrypted copy of the whole database sitting on the host after a
*successful* run is a disk-exhaustion incident waiting for the next drill
(T-14-69) — so a clean pass always tears down. A *failed* run leaves the
scratch container and volume in place on purpose, because the failure
itself is the thing worth inspecting; the script always prints the exact
`docker rm -f <container>; docker volume rm <volume>` command so cleanup is
never a guess once you are done looking.

## Recurrence cadence — an operator obligation, not a suggestion

**Run this drill monthly**, and again after any change to
`docker/postgres/Dockerfile`, `docker/pgbackrest/pgbackrest.conf`, or the
Postgres major version. A rehearsal performed once and never repeated
decays into documentation — the exact failure mode DB-10's wording
("отработано на практике", exercised in practice) exists to rule out. The
monthly cadence is deliberately more frequent than the two-week retention
window backs up (`docs/runbooks/backups.md`): a drill against a target near
the edge of that window is also an implicit check that the window itself
is wide enough to be useful. Record each run's outcome (pass/fail, restore
duration, disk high-water mark) somewhere durable — this plan's own
SUMMARY.md is the record for the run that closed DB-10; later runs belong
in an operational log, not a new planning document each time.

## What this is not: the fresh-VPS disaster rehearsal (D-07's stretch variant)

This baseline drill restores into a **scratch container on the same VPS**
that already runs production — it proves the backup and restore mechanism,
not that a brand-new host can be provisioned, have Docker and this
repository's tooling installed, and be made fully production-ready from
nothing but the S3 repository and this codebase. That full rehearsal is
D-07's explicitly-named stretch variant, deliberately out of this plan's own
scope. It would additionally prove: DNS/TLS re-issuance on a new host,
`docker/prod.env.example`'s completeness as an actual bootstrap checklist,
and the true wall-clock RTO if the VPS itself were lost, not merely the
database. Worth doing once production has been running long enough that a
host-loss scenario is a real (not theoretical) risk; not a precondition for
closing DB-10.

## Closing the loop: the forward-only migration tier's recovery path

`docs/runbooks/migration-rollback-and-roll-forward.md` (plan 14-05) records
that the forward-only migration tier's recovery path is "restore from
backup", and states explicitly that until this drill had been performed and
written up, that path was **documented but not rehearsed**. This runbook,
and the checkpoint whose outcome this plan's SUMMARY.md records, closes
that gap: the forward-only tier's recovery procedure is now this drill,
proven against the real repository, not merely a sentence in another
runbook.

## What this plan verified locally (real pgBackRest, real Postgres — no VPS in this sandbox)

No VPS, no Docker daemon, and no S3 bucket exist in the sandbox this plan
was authored in (the same constraint `docs/runbooks/backups.md` records for
plan 14-10). Everything genuinely requiring any of those three is deferred
to this plan's own checkpoint. What the PITR mechanism itself needed —
independent of Docker — was rehearsed directly against a real pgBackRest
2.59.0 (Homebrew) and a real, from-scratch Postgres 17 cluster with a real
`repo1-type=posix` filesystem repository:

- **A full backup, then a marker row bracketed by two UTC timestamps
  (`'YYYY-MM-DD HH:MM:SS+00'`), then a WAL switch, then two independent
  restores** — one with a target **before** the marker, one **after** —
  both via `pgbackrest --type=time --target='<ts>' --target-action=promote
  restore` into a separate data directory, each started as its own
  Postgres instance. The BEFORE-target restore's cluster genuinely lacked
  the marker row (and correctly promoted onto a **new timeline**, `selected
  new timeline ID: 2`); the AFTER-target restore's cluster genuinely had it.
  Both restores completed in well under half a second against this small
  test cluster — real evidence for a real number, not an estimate; this
  plan's own checkpoint records the equivalent figure against the actual
  production data volume, which will be larger.
- **A genuine, non-obvious PITR pitfall found empirically, not assumed**:
  `recovery_target_time` needs a WAL record carrying a timestamp **at or
  after** the target for PostgreSQL to conclude the target was reached. If
  archived WAL simply ends with no further transaction after the target
  moment (exactly what happens in a low-traffic rehearsal with no ambient
  write activity), recovery fails with `recovery ended before configured
  recovery target was reached` — **even though every byte of available WAL
  was correctly replayed**. In real production traffic this is a non-issue
  (there is always a later transaction), but a drill against a very
  recently-idle database should account for it: if an AFTER-target restore
  in this drill ever reports this exact error, it means "no write happened
  after the target yet", not "the restore is broken" — trigger one
  (harmless) write and retry, or choose a target with more headroom behind
  it.
- **The exact target string format was confirmed to round-trip**: a UTC
  timestamp with an explicit `+00` offset, matching this codebase's own
  `utcTimestampLiteral` convention, was accepted by `pgbackrest`'s
  `--target` option and correctly compared against WAL commit timestamps in
  both directions (before/after) without any timezone ambiguity.
- **The baseline-capture `query_to_xml` one-liner** (this runbook's own
  "Reading the verification output" section) was run directly against a
  real local Postgres database and produced a complete, correctly-shaped
  flat JSON object for every real table.
- **What was NOT verified locally, and remains this plan's own checkpoint
  task:** restoring against the REAL off-host S3 repository (rather than a
  local filesystem one), the `docker run`-based scratch-container mechanism
  `scripts/restore-drill.sh` itself uses (no Docker daemon in this
  sandbox), the exact restore duration against the real production data
  volume, and the real disk high-water mark on the real VPS.
