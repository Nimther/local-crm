# Backups Runbook

Implements requirement **DB-09** and decisions **D-05**, **D-06**, **D-08**
(`.planning/phases/14-deployment-database-durability/14-CONTEXT.md`). This is
the reference for `docker/pgbackrest/pgbackrest.conf`,
`docker/pgbackrest/crontab`, and `docker/pgbackrest/backup-entrypoint.sh` —
what pgBackRest is doing, the cadence/retention and why, how to verify it's
healthy, and what to do when a scheduled backup fails.

**This file does not describe restoring a backup.** DB-10 ("backups actually
work") is a separate requirement from DB-09 ("backups happen automatically")
for exactly the reason `pgbackrest check`'s own limits below explain — the
restore drill lives in plan 14-11's own runbook, cross-referenced from the
"What a passing check does NOT prove" section below.

## What pgBackRest is doing

Two things run continuously, not one:

1. **WAL archiving** — `docker/postgres/prod-tls-entrypoint.sh` sets
   `archive_mode=on` and `archive_command='pgbackrest ... archive-push %p'`
   on the `db` service itself. Postgres invokes this command on its OWN
   process, for every WAL segment, the moment it's ready to be archived —
   this is what makes point-in-time recovery possible to any moment inside
   the retention window, independent of how often a full/differential/
   incremental backup runs.
2. **Scheduled backups** — the `pgbackrest` sidecar service
   (`docker-compose.prod.yml`) runs `cron`, loaded with
   `docker/pgbackrest/crontab`'s full/differential/incremental schedule plus
   a daily verification check. It shares `db`'s own data volume (read-only)
   and a Unix-socket volume with `db` so it can read PGDATA and run
   pgBackRest's backup-start/backup-stop control connection without a
   second database credential — see `pgbackrest.conf`'s own comment for the
   full reasoning.

Both containers run the SAME custom image (`docker/postgres/Dockerfile`,
`postgres:17` plus the `pgbackrest`/`cron`/`ca-certificates` packages) — one
Dockerfile, two entrypoints. `archive_command` executes INSIDE the `db` container's own
process, so a sidecar-only pgBackRest install (no binary in `db` itself)
would look configured while archiving nothing — the single most consequential
fact this plan's own objective names.

`ca-certificates` is explicit rather than left to a recommendation chain:
both the database's WAL archiver and the backup sidecar must verify the HTTPS
certificate of the S3-compatible repository. A missing trust store is a loud
configuration failure; certificate verification must never be disabled to
work around it.

**Installed pgBackRest version**: **2.59.1** as of the phase 17 CI-built
image production actually runs (`ghcr.io/nimther/local-crm/postgres`,
digest `sha256:5697782e12c2df655f7798c51eb26851f37b8cfa82d576b64890ffacda6ae519`,
confirmed live on the VPS 2026-08-19) — a patch-level drift up from the
**2.59.0** confirmed by the original real arm64/amd64 builds on 2026-08-14
after the mutable `postgres:17` base moved to Debian trixie. Every
configuration key and command this plan uses was also verified directly
against a real pgBackRest 2.59.0 (Homebrew) against a real Postgres 17
cluster and a real filesystem-type repository. A real `docker build -f
docker/postgres/Dockerfile -t megacrm-postgres:local .` followed by `docker
run --rm megacrm-postgres:local pgbackrest version` is the authoritative
check after any future base-image rebuild.

**This drift is expected and ratified, not a defect to chase out:**
`docker/postgres/Dockerfile` installs pgBackRest via unpinned
`apt-get install -y --no-install-recommends pgbackrest` against the pgdg
repository — there is no version pin, so each image rebuild can legitimately
pick up whatever patch release pgdg currently ships. T-14-58/T-14-88 (the
threat rows this image's CI-built/GHCR-pulled/immutable-tag properties
close) are about **image provenance and tag immutability**, never about
apt-level build reproducibility, so this drift does not reopen either row.
The 2.59.1-vs-2.59.0 gap was explicitly ratified during phase 17's live
cutover checkpoint (`17-05-SUMMARY.md`) on the strength of a concrete
cross-version proof, not an assumption: the same checkpoint's restore drill
(see `docs/runbooks/restore-drill.md`'s "Recorded drill runs") restored and
verified a repository whose backups were **written by 2.59.0** using the
**2.59.1** binary, which is exactly the compatibility property that matters
for a repository accumulating backups across image rebuilds.

**Checking whether the GHCR image resolves, on THIS VPS specifically:**
`docker manifest inspect "$GHCR_IMAGE_BASE/postgres:<sha>"` **false-negatives
on this host** (`no such manifest`, even for an image that genuinely
exists) — the VPS runs legacy Docker 20.10.21, whose `manifest inspect`
client cannot read manifests published in the newer OCI index format CI
publishes. This was discovered during phase 17's live cutover checkpoint
when the command failed against an image independently confirmed present
via the GHCR Registry API. **Use `docker buildx imagetools inspect
"$GHCR_IMAGE_BASE/postgres:<sha>"` instead** — it exits 0 and prints the
per-architecture digests correctly on this host; the GHCR Registry API
(`GET /v2/<owner>/<repo>/postgres/manifests/<sha>`) is the fallback if
`buildx` itself is ever unavailable.

## Cadence and retention

`docker/pgbackrest/crontab`'s own header carries the full rationale next to
each schedule line — summarized here for the operator:

| Job | Schedule (UTC) | Why |
|---|---|---|
| Full | Sunday 02:00 | The anchor a diff/incr chain restores from. Weekly keeps that chain from growing unboundedly between fulls — a longer chain means a slower restore. |
| Differential | Mon–Sat 02:00 | Everything since the last full. Costs more per backup than an incremental, but a restore only ever needs the full plus the single latest differential — never a chain of increments. |
| Incremental | 06:00, 10:00, 14:00, 18:00, 22:00 | Tightens the point a diff-only schedule could restore *the bulk backup* to between the once-daily diffs. WAL archiving already gives PITR continuous coverage regardless — these bulk backups bound RESTORE TIME, not recovery POINT. |
| Check | 03:30 (after the heaviest nightly job) | pgBackRest's own configuration/repository verification — see "Verifying backup health" below. |

**Retention**: `docker/pgbackrest/pgbackrest.conf` sets
`repo1-retention-full=2` (count-based) — 2 full backups kept online at any
time, with every differential/incremental chained off each. That's roughly
**two weeks** of restorable history before the oldest full (and everything
chained off it) expires.

**Recovery-point / recovery-time expectations**:

- **RPO (recovery point)**: bounded by continuous WAL archiving, not by the
  backup schedule above — seconds, not hours, as long as archiving is
  keeping up (see "Confirming WAL archiving is keeping up" below).
- **RTO (recovery time)**: bounded by restoring the most recent full plus (at
  most) one day's differential plus a few hours of incrementals. For this
  platform's current data volume that is expected to be well under an hour —
  this is a first-principles estimate, not a measurement; plan 14-11's
  restore drill is what turns it into a real number.

**D-08 / plan 14-12**: the retention window above is the ACTUAL recovery
horizon for anything the partition-drop retention tick removes. A dropped
partition is recoverable only from a backup, and only until that backup
expires — retention is one-way, and this is the number that bounds it.

## Where the repository lives, and its encryption

The repository is **off-host S3-compatible object storage** — never the VPS
itself (D-06: "a backup living only on the VPS is explicitly not
acceptable"). Every S3 endpoint/bucket/region/key/key-secret value, plus
pgBackRest's own repository cipher passphrase, is read from the environment
via pgBackRest's OWN `PGBACKREST_<OPTION>` override convention — never a
literal in `docker/pgbackrest/pgbackrest.conf`, delivered via
`${MEGA_CRM_ENV_FILE}` to both the `db` and `pgbackrest` services (same six
names in both, since `archive_command` needs repository access too).

The repository is encrypted with `repo1-cipher-type=aes-256-cbc`, using
`PGBACKREST_REPO1_CIPHER_PASS`. **This is a requirement, not advice: the
cipher passphrase must be escrowed somewhere that survives the loss of the
VPS** (the operator's own password manager or equivalent) — pgBackRest
cannot decrypt the repository without it, and a backup that cannot be
decrypted is indistinguishable from no backup at all. `docker/prod.env.example`
repeats this same requirement next to the variable's own name.

Two independent controls protect repository contents: pgBackRest's own
cipher (above) and the bucket's own public-access-disabled setting (this
plan's own `user_setup`/checkpoint). Neither alone is sufficient —
verified independently in the checkpoint below.

## Verifying backup health

**`pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=mega_crm
check`** — run inside either the `db` or `pgbackrest` container
(`docker compose exec -T -u postgres pgbackrest pgbackrest --stanza=mega_crm
check`). **`-u postgres` is required**: the `pgbackrest` container's
interactive `docker exec` default user is root, and pgBackRest refuses to
run as root (error `[031]`) — found running (and failing) as root during
phase 17's live cutover checkpoint (2026-08-19), fixed here in the same
change. Validates the archive configuration and confirms the repository is
reachable. This is also what runs automatically every day at 03:30 UTC
(`docker/pgbackrest/crontab`) — the scheduled path never hit this defect
because `backup-entrypoint.sh` already runs every real pgBackRest command
via `gosu postgres` internally (see "What to do when a scheduled backup
fails" below); the defect only ever affected an operator running the
command interactively by hand.

**What a passing `check` does NOT prove**: it means the configuration is
coherent and the repository is reachable. It does **not** prove a restore
actually works — only plan 14-11's actually-performed restore drill proves
that. DB-09 (this plan) and DB-10 (plan 14-11) are separate requirements for
exactly this reason; do not treat a green `check` as "backups are proven,"
and see plan 14-11's own runbook for the restore procedure once it exists.

**`pgbackrest --stanza=mega_crm info`** — lists every backup on record: type,
timestamp, size, and whether the repository reports itself encrypted
(`cipher: aes-256-cbc`). Run this after any manual backup, and periodically
to eyeball the schedule is actually producing backups.

### Confirming WAL archiving is keeping up

```
docker compose exec db psql -U postgres -c "SELECT * FROM pg_stat_archiver;"
```

`archived_count` should be increasing over time; `failed_count` should
**not increase from its previously observed value** (record a baseline
reading, then compare against it -- see below). Do **not** treat "stay at
zero" as the bar: `failed_count` is cumulative since the cluster's own
`stats_reset`, not since this check, and on this host it has held steady at
**67** since the 2026-08-14 pgBackRest stanza bring-up (ratified in Phase 17
plan 05, `17-05-SUMMARY.md`) -- a nonzero `failed_count` alone is not, by
itself, an incident signal here. What matters is whether the number moves:
take a baseline read, do the work below, then confirm `failed_count` is
unchanged and `last_failed_time`/`last_failed_wal` did not advance. To force
a fresh data point: write some data, then `SELECT pg_switch_wal();`, then
re-run the query above and confirm `last_archived_wal`/`last_archived_time`
advanced while `failed_count` held steady.

## What to do when a scheduled backup fails

`docker/pgbackrest/backup-entrypoint.sh`'s scheduled-job mode never swallows
a non-zero pgBackRest exit: it logs a line of the exact shape
`[<UTC timestamp>] pgbackrest-run: FAILURE stanza=mega_crm type=<full|diff|incr|check> exit_code=<n>`
to `/var/log/pgbackrest/cron.log` (mirrored live to `docker compose logs
pgbackrest`) and exits with that same non-zero code — a silently failing
nightly backup is worse than no backup, because it is believed.

1. `docker compose logs pgbackrest | grep FAILURE` (or read
   `/var/log/pgbackrest/cron.log` inside the container) to find the failure
   line and its `exit_code`.
2. Run the same command by hand
   (`docker compose exec -T -u postgres pgbackrest pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=mega_crm --type=<type> backup`,
   or `... check`) to see pgBackRest's own error output directly — the cron
   log line only names the stanza/type/exit code, not pgBackRest's own error
   text. `-u postgres` matters here too: run as the container's default
   root user this fails with pgBackRest error `[031]` before you even reach
   the error you were trying to diagnose.
3. Common causes: the bucket became unreachable (network/DNS/credential
   rotation), the repository ran out of space, or the cipher passphrase in
   `MEGA_CRM_ENV_FILE` doesn't match what the stanza was created with.
4. Once fixed, re-run the failed job type manually
   (`docker compose exec pgbackrest /usr/local/bin/backup-entrypoint.sh <type>`
   — no `-u postgres` needed here: unlike the two hand-run commands above,
   this invokes the entrypoint script itself, which already `gosu postgres`s
   internally before running any real pgBackRest command, the same as its
   own scheduled-cron invocation)
   rather than waiting for the next scheduled run, so the gap in coverage is
   as short as possible.

**Real alerting on this failure is explicitly deferred to Phase 15.** This
plan delivers the check *command* and documents running it by hand;
14-CONTEXT.md's Deferred Ideas assign real backup-failure alerting to Phase
15 (OPS-06…OPS-15), through the existing `OPERATOR_ALERT_EMAIL` /
tick-plus-watchdog pattern this project's partition-maintenance worker
already established. Phase 15 should treat `pgbackrest-run: FAILURE` lines
(and a non-zero `check` exit) as a named alert source, not build a second
alerting mechanism from scratch.

## Cipher passphrase escrow

Stated once more, explicitly, because losing this value is equivalent to
having no backups while appearing to have all of them: `PGBACKREST_REPO1_CIPHER_PASS`
must be escrowed somewhere that survives the loss of the VPS — the operator's
password manager or equivalent, never a location that would be lost together
with the VPS itself. This is a checkpoint gate for this plan's own Task 3,
not merely a recommendation.

## Verification record

The original planning sandbox had no Docker daemon, production VPS, or S3
bucket, so the real-host cases were deferred to this plan's checkpoint. On
2026-08-14 the image was built on real arm64 and amd64 Docker hosts: both
installed pgBackRest 2.59.0, and the image-level CA-bundle regression check
passed. The remaining pre-checkpoint evidence was verified directly, not
merely reasoned through:

- **A real pgBackRest binary (Homebrew 2.59.0) against a real Postgres 17
  cluster and a real filesystem-type (`repo1-type=posix`) repository**:
  `stanza-create` succeeded; `archive_mode=on` +
  `archive_command='pgbackrest ... archive-push %p'` produced a REAL
  archived WAL segment, confirmed via `pg_stat_archiver`
  (`archived_count: 1`, `failed_count: 0`); `check` passed; a real
  `--type=full backup` completed (`full backup size = 22.5MB`) and a
  subsequent `--type=incr backup` also completed; `info` reported the
  repository as `cipher: aes-256-cbc`. This proves every config key this
  plan's `pgbackrest.conf` uses (`repo1-type`, `repo1-cipher-type`,
  `repo1-cipher-pass`, `repo1-retention-full(-type)`, `process-max`,
  `pg1-path`, `pg1-user`, `pg1-socket-path`) and every command
  (`stanza-create`/`archive-push`/`check`/`backup`/`info`) is accepted and
  functions correctly. The later real image builds closed the original
  installed-version gap.
- **`docker/pgbackrest/backup-entrypoint.sh`'s `run_job` failure/success
  logic**, run directly (not just read): a real `incr` backup against the
  same local repository produced the exact `OK` log line this runbook's
  "What to do when a scheduled backup fails" section describes; pointing
  the same logic at a nonexistent stanza produced the exact `FAILURE` log
  line naming the stanza/type/exit-code and propagated pgBackRest's own
  non-zero exit code.
- **`bash -n` on `backup-entrypoint.sh`** — syntax-clean.
- **A real `docker compose config`** (this sandbox installed a standalone
  `docker-compose` v5.4.0 binary via Homebrew, which the `docker` CLI
  auto-discovers as its own `compose` subcommand — no daemon required for
  `config`, which only resolves/interpolates, never touches the Docker
  Engine) — `docker/docker-compose.prod.yml` resolves cleanly against
  `docker/prod.env.example` with the `db`/`pgbackrest` services included, and
  `npm run verify:prod-compose` now runs against that REAL resolution
  (34 invariants, 7 services, zero violations) rather than only the
  YAML-parsing fallback every prior plan in this phase was limited to.
  **This surfaced and fixed two genuine, previously-unexercised bugs** in
  code this plan's own files touch (documented in full in the relevant
  file's own header comment, not repeated here):
  1. Every relative bind-mount `source:` in `docker-compose.prod.yml`
     resolved to a doubled `docker/docker/...` path when `docker compose`
     is invoked exactly as `scripts/deploy.sh` invokes it (from the repo
     root, with `-f docker/docker-compose.prod.yml`) — Compose's own
     documented default project-directory rule is "the path of the first
     specified Compose file," not the repo root. Fixed by removing the
     redundant leading `docker/` segment from every relative path in the
     file.
  2. `scripts/validate-prod-compose.mjs`'s `resolveViaDockerCompose` never
     activated the `migrate` service's `manual` profile, so a real
     `docker compose config` (which excludes profiled-out services by
     default) always reported `migrate` as a missing service — fixed by
     setting `COMPOSE_PROFILES=*` on the shelled-out call. Its
     `parseDurationToSeconds` also only recognized the raw `"<n>s"` text
     form, not the Go-style duration string (`"1m0s"`, `"2m5s"`) a real
     `docker compose config --format json` actually returns for
     `stop_grace_period` — fixed to parse both forms.
- **What was NOT verified locally, and remains this plan's checkpoint
  task**: a real `docker build -f docker/postgres/Dockerfile`, the EXACT
  pgBackRest version that build installs, an S3-type repository (any kind),
  a real backup landing in an actual bucket, WAL shipping to that bucket,
  the bucket's public-access-disabled setting, and a scheduled backup
  running unattended on a real host.

## Accepted risk (T-14-66)

An attacker with host access to the VPS could delete backups from the
repository if they also have the S3 credentials (which live on that same
host, in `MEGA_CRM_ENV_FILE`). This is accepted, with a recorded mitigation
attempt: this plan's checkpoint asks the operator to enable object
versioning or immutability on the bucket where the provider supports it, and
the access key is scoped to that one bucket only (T-14-67). Full write-once
storage and a separate deletion credential are beyond this plan's scope —
a follow-up for a future phase if the risk profile changes.

## Forward flags for later plans

- **SUPERSEDED by Phase 17 plan 03 (D-05, D-06, closing T-14-58/T-14-88).**
  The bullet below described the model from Phase 14 plan 10 through Phase
  16; it no longer applies and is kept only as a decision-trail record, not
  as current operator guidance:
  > ~~`docker/postgres/Dockerfile`/`docker/pgbackrest/pgbackrest.conf` are
  > NOT built by `.github/workflows/images.yml`~~ — `db`/`pgbackrest` build
  > the custom `megacrm-postgres` image locally (`docker compose build db
  > pgbackrest`), not from a GHCR-published, SHA-tagged image the way
  > `api`/`worker`/`web` are. This was a deliberate choice (the image
  > changes rarely — an OS package layer, not application code — and
  > extending the CI matrix plus `scripts/validate-prod-compose.mjs`'s
  > `FIRST_PARTY_IMAGE_SERVICES` immutable-tag check was judged out of that
  > plan's own declared file scope), not an oversight.

  As of Phase 17 plan 03, the image **is** built and pushed by
  `.github/workflows/images.yml`'s `build-and-push-postgres` job on every
  push to master, tagged with the same git SHA as the application images
  (`api`/`worker`/`web`). `docker/docker-compose.prod.yml`'s `db` and
  `pgbackrest` services now reference
  `${GHCR_IMAGE_BASE}/postgres:${POSTGRES_IMAGE_TAG}` with no `build:`
  section and no mutable-tag fallback; production pulls the image and never
  builds it. `db` and `pgbackrest` are inside
  `scripts/validate-prod-compose.mjs`'s `FIRST_PARTY_IMAGE_SERVICES`
  immutable-tag gate (proven by the `db-mutable-image-tag.yml` fixture).
  Operator consequence: after a `docker/postgres/Dockerfile` change, merge
  to master, wait for CI's `build-and-push-postgres` job to publish the new
  image, then set `POSTGRES_IMAGE_TAG` to that commit's SHA and run the
  `db`/`pgbackrest` cutover sequence — a deliberate, human-gated event, NOT
  part of `scripts/deploy.sh`'s routine `pull api worker web` / `up -d web
  api` / `up -d worker` sequence, which is unchanged by this plan.
- **Plan 14-11 (DB-10)** owns the restore drill and its own runbook —
  cross-reference from here once it exists, do not duplicate.
- **Plan 14-12** consumes the retention window recorded above as the
  recovery horizon for its own partition-drop retention tick.
- **Plan 14-13 (SPECIFICATION.md filing)** needs: the installed pgBackRest
  version (from a real `docker build`, not this document — see "What this
  plan verified locally"), the Postgres base tag (unchanged, `postgres:17`),
  the six `PGBACKREST_*` env var names (§3), and the `cron`/`pgbackrest` OS
  packages added to `docker/postgres/Dockerfile` (§2, noting they are
  container/OS-level tools with no npm entry, per this repo's own
  CLAUDE.md convention for that case).
