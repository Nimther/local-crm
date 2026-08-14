#!/usr/bin/env bash
set -euo pipefail

# Phase 14 plan 08 (D-01, D-09, D-10, DB-13, Pitfall 19). Production entrypoint
# wrapper for the official `postgres` image, serving TLS (the server half of
# DB-13) and applying this plan's parameterized sizing knobs
# (max_connections/shared_buffers) via `-c` overrides -- never a hand-typed
# number in this file.
#
# SEPARATE from docker/pg-tls-entrypoint.sh (the dev/CI entrypoint plan 14-03
# wrote), deliberately, rather than a shared script with an environment
# branch: this file also owns the max_connections/shared_buffers `-c` flags
# the checkpoint's "parameterize-with-minimum" decision requires, which have
# NOTHING to do with dev/CI's fixed-defaults posture (docker/redis.conf's own
# comment makes the same call for Redis -- "sizing it against the production
# VPS belongs to Phase 15... deliberately NOT parameterized"). Two small,
# independently-reviewable scripts -- one dev, one prod -- carry less drift
# risk here than one script with a runtime branch would, because the
# PRODUCTION posture (the one that matters for an incident) stays reviewable
# on its own, without reasoning through a dev-only branch to find it.
#
# Mirrors docker/pg-tls-entrypoint.sh's TLS mechanism exactly (self-signed
# cert generated once into a DEDICATED volume, never the data directory;
# runs as root -- before the image's own docker-entrypoint.sh drops
# privileges via `gosu postgres "$@"` -- because chown'ing the generated key
# requires it; does not forward "$@", since Compose supplies the image's
# default CMD (`postgres`) as this script's own positional arguments and
# forwarding them would duplicate the `postgres` argument added explicitly
# below). See that file's own header for the full TLS rationale; not
# repeated here.

CERT_DIR="/certs"
CERT_FILE="${CERT_DIR}/server.crt"
KEY_FILE="${CERT_DIR}/server.key"

mkdir -p "${CERT_DIR}"

if [ ! -f "${CERT_FILE}" ] || [ ! -f "${KEY_FILE}" ]; then
  if ! command -v openssl >/dev/null 2>&1; then
    echo "prod-tls-entrypoint: FATAL -- openssl is not available in this image; cannot generate a TLS certificate. Refusing to start Postgres without TLS (D-10)." >&2
    exit 1
  fi

  # D-10's recorded interim posture: self-signed, not a CA-issued cert.
  # docs/runbooks/production-topology.md records the `verify-full` revisit
  # trigger this defers.
  echo "prod-tls-entrypoint: generating a self-signed certificate at ${CERT_DIR} (first boot only -- restarts reuse it)"
  openssl req -new -x509 -days 3650 -nodes \
    -subj "/CN=mega-crm-prod-postgres" \
    -newkey rsa:2048 \
    -keyout "${KEY_FILE}" \
    -out "${CERT_FILE}"
fi

chown postgres:postgres "${CERT_FILE}" "${KEY_FILE}"
chmod 600 "${KEY_FILE}"
chmod 644 "${CERT_FILE}"

# Phase 14 plan 08 (D-09): PG_MAX_CONNECTIONS' floor is the summed
# application pool maxima from plan 14-03's PG_POOL_SIZES (84, one instance
# each of apps/api + apps/worker -- see docs/runbooks/production-topology.md
# for the full arithmetic and the deploy-time-doubling margin the default of
# 200 leaves). PG_SHARED_BUFFERS follows the general ~25%-of-container-RAM
# guideline against DB_MEM_LIMIT's own default. Both are environment
# variables with conservative defaults, per this plan's checkpoint decision
# (RESEARCH.md Open Question 3's "parameterize-with-minimum" option) -- a
# default that is never revisited becomes the production value by omission,
# which is why the runbook flags both as revisit triggers, not settle-and-
# forget numbers.
PG_MAX_CONNECTIONS="${PG_MAX_CONNECTIONS:-200}"
PG_SHARED_BUFFERS="${PG_SHARED_BUFFERS:-512MB}"

# Phase 14 plan 10 (DB-09, D-05, D-06, T-14-62). Rule 3 addition -- not in
# plan 14-08's own file list, but required for plan 14-10's own stated
# behavior to be possible at all: `archive_command` is a Postgres server
# setting, and this script is the ONLY place `-c` overrides reach the
# `postgres` process in this image (compose's own `command:` is never
# forwarded -- see this file's header). "Configured" and "archiving" are
# different states (this plan's own wording): a config-only assertion here
# would prove nothing about WAL actually shipping. `%p` is Postgres's own
# archive_command placeholder for the WAL file's full path -- pgBackRest's
# `archive-push` command takes it verbatim, unchanged from
# RESEARCH.md's own skeleton and confirmed against a real archive
# (`pg_stat_archiver`, this sandbox's local dry-run -- see
# docs/runbooks/backups.md).
PGBACKREST_STANZA="${PGBACKREST_STANZA:-mega_crm}"

exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file="${CERT_FILE}" \
  -c ssl_key_file="${KEY_FILE}" \
  -c max_connections="${PG_MAX_CONNECTIONS}" \
  -c shared_buffers="${PG_SHARED_BUFFERS}" \
  -c archive_mode=on \
  -c archive_command="pgbackrest --config=/etc/pgbackrest/pgbackrest.conf --stanza=${PGBACKREST_STANZA} archive-push %p"
