#!/usr/bin/env bash
#
# Phase 14 plan 10 (DB-09, D-05, D-06, D-08, T-14-63, T-14-65). Entrypoint
# for the `pgbackrest` sidecar service (docker-compose.prod.yml). Two modes,
# selected by whether an argument is given -- keeps every real command in
# ONE file, which is why docker/pgbackrest/crontab (this plan's own
# files_modified list) never needed a third script:
#
#   backup-entrypoint.sh <full|diff|incr|check>
#     A ONE-SHOT job -- run by cron (see docker/pgbackrest/crontab), sourced
#     into a shell that already has this container's runtime environment
#     (see the env-dump step below), and exits with pgBackRest's own exit
#     code. T-14-63: a failed backup/check MUST be loud -- this function
#     never swallows a non-zero exit, and always logs a line naming the
#     stanza and the job type before propagating it, so "the nightly backup
#     silently failed" cannot happen here.
#
#   backup-entrypoint.sh   (no argument)
#     The container's OWN PID 1 entrypoint -- installs the crontab, ensures
#     the stanza exists (idempotent, first-boot convenience), starts a
#     background `tail -F` of the job log to this container's own stdout
#     (so `docker compose logs pgbackrest` shows every scheduled run without
#     the well-known "cron jobs can't write to /proc/1/fd" Docker pitfall --
#     see the comment at that step), and execs `cron` in the foreground.
#
# Runs as root at PID 1 (Debian's `cron` package needs root to manage
# per-job user switches from /etc/cron.d) -- but every ACTUAL pgbackrest
# invocation (both the first-boot stanza-create below and every scheduled
# job, via docker/pgbackrest/crontab's own "postgres" user field) runs as
# the "postgres" OS user (uid 999, the SAME fixed uid docker/postgres/
# Dockerfile's base image defines) -- required so pgBackRest can read the
# shared, postgres-owned PGDATA volume, and so its own database control
# connection (docker/pgbackrest/pgbackrest.conf's `pg1-user=postgres`) is
# authenticated the same way `db`'s own local connections are.

set -uo pipefail

STANZA="${PGBACKREST_STANZA:-mega_crm}"
CONFIG="/etc/pgbackrest/pgbackrest.conf"
LOG_FILE="/var/log/pgbackrest/cron.log"

# --- One-shot job mode (invoked by cron) ------------------------------------
#
# Deliberately NOT `set -e` here: `pgbackrest`'s own exit code is captured
# explicitly ($?) so the FAILURE line below is guaranteed to be logged
# before this script exits with that same code -- `set -e` would abort the
# script at the failing command, before the log line runs.
run_job() {
  local type="$1"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [ "$type" = "check" ]; then
    pgbackrest --config="$CONFIG" --stanza="$STANZA" check
  else
    pgbackrest --config="$CONFIG" --stanza="$STANZA" --type="$type" backup
  fi
  local rc=$?

  if [ "$rc" -ne 0 ]; then
    echo "[$ts] pgbackrest-run: FAILURE stanza=${STANZA} type=${type} exit_code=${rc}"
    exit "$rc"
  fi
  echo "[$ts] pgbackrest-run: OK stanza=${STANZA} type=${type}"
  exit 0
}

if [ "$#" -eq 1 ]; then
  run_job "$1"
fi

if [ "$#" -gt 1 ]; then
  echo "backup-entrypoint: expected exactly zero or one argument (full|diff|incr|check), got: $*" >&2
  exit 1
fi

# --- Container entrypoint mode (no argument -- PID 1) -----------------------

set -e

mkdir -p /var/log/pgbackrest
touch "$LOG_FILE"
chown postgres:postgres /var/log/pgbackrest "$LOG_FILE"
chmod 750 /var/log/pgbackrest
chmod 640 "$LOG_FILE"

# `tail -F` is started as ROOT (this process's own inherited stdout, fd 1 --
# NOT /proc/1/fd/1) BEFORE any privilege is dropped for the scheduled jobs
# below. This is the actual fix for the standard "cron output vanishes in
# Docker" problem: a job cron runs as the "postgres" user cannot write to
# /proc/1/fd/1 (PID 1 here is owned by root; a different uid has no
# permission to open another process's /proc/<pid>/fd/* entries), but
# appending to a plain log FILE and having a separate, already-running
# child process (started here, before any privilege drop, so it inherits
# this shell's own stdout directly) `tail -F` that file works regardless of
# which uid wrote to it.
tail -F "$LOG_FILE" &

# cron jobs run with almost no inherited environment -- dump this
# container's ACTUAL runtime environment (the six PGBACKREST_REPO1_*
# values + PGBACKREST_STANZA, delivered via docker-compose.prod.yml's
# `environment:`, NEVER a literal here) to a file every scheduled job
# sources before it runs pgbackrest. `printf '%s=%q\n'` shell-quotes each
# value correctly (handles spaces/special characters in a passphrase)
# without relying on a fragile sed substitution.
: > /etc/pgbackrest-env
while IFS='=' read -r -d '' entry; do
  name="${entry%%=*}"
  value="${entry#*=}"
  printf 'export %s=%q\n' "$name" "$value" >> /etc/pgbackrest-env
done < <(env -0)
chown postgres:postgres /etc/pgbackrest-env
chmod 600 /etc/pgbackrest-env

# Debian's cron refuses a /etc/cron.d file that is group/world-writable or
# not root-owned -- install a fresh, correctly-permissioned copy rather than
# using the read-only bind mount directly.
install -o root -g root -m 0644 /etc/pgbackrest-crontab.d/crontab /etc/cron.d/pgbackrest

echo "backup-entrypoint: stanza=${STANZA}, ensuring the stanza exists (idempotent first-boot convenience -- a real backup/check still requires the operator's S3 credentials, this plan's own checkpoint task)"
gosu postgres pgbackrest --config="$CONFIG" --stanza="$STANZA" stanza-create || true

echo "backup-entrypoint: starting cron in the foreground -- schedule installed at /etc/cron.d/pgbackrest (docker/pgbackrest/crontab)"
exec cron -f
