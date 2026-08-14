#!/usr/bin/env bash
set -euo pipefail

# Phase 14 plan 03 (DB-13, D-10): entrypoint wrapper for the official
# `postgres` image, so the dev/CI database serves TLS with the SAME
# `docker-compose.yml` used everywhere else -- the pg_stat_ssl assertion in
# packages/db/src/__tests__/pg-tls.test.ts then runs on every CI pass instead
# of being a claim about production only.
#
# This script REPLACES the image's own `ENTRYPOINT` (docker-compose.yml's
# `entrypoint:` override), so it runs as ROOT -- before the image's own
# `docker-entrypoint.sh` drops privileges via `gosu postgres "$@"` for the
# actual server process. That is deliberate and load-bearing: chown'ing the
# generated key to the `postgres` user below REQUIRES root, and there is no
# later point in the image's own startup sequence where this script could
# still do it.
#
# Deliberately does NOT forward "$@" into the exec line at the bottom --
# Compose still supplies the image's default CMD (`postgres`) as this
# script's own positional arguments, and forwarding them would duplicate the
# `postgres` argument `docker-entrypoint.sh` already receives explicitly
# below. This script's own arguments are intentionally ignored.
#
# Certificate/key live in $CERT_DIR, a directory backed by the DEDICATED
# `mega_crm_db_certs` named volume (docker-compose.yml) -- NOT the data
# directory (`$PGDATA`/`mega_crm_db_data`). Certificate lifetime is therefore
# independent of the database volume: `docker compose down -v` and a fresh
# `initdb` do not force a new certificate, and (by the same token) wiping
# just the certs volume never touches live data.

CERT_DIR="/certs"
CERT_FILE="${CERT_DIR}/server.crt"
KEY_FILE="${CERT_DIR}/server.key"

mkdir -p "${CERT_DIR}"

# Generated ONLY when absent -- a restart (`docker compose stop` then
# `docker compose up -d`) reuses the existing certificate rather than
# regenerating it, which is exactly what lets a long-running dev/CI
# container keep the same server identity across restarts.
if [ ! -f "${CERT_FILE}" ] || [ ! -f "${KEY_FILE}" ]; then
  # Confirmed present in the `postgres:17` (Debian-based) image at the time
  # this script was written, but verified here rather than assumed: a
  # missing `openssl` fails LOUDLY, not by silently falling back to a
  # plaintext connection.
  if ! command -v openssl >/dev/null 2>&1; then
    echo "pg-tls-entrypoint: FATAL -- openssl is not available in this image; cannot generate a TLS certificate. Refusing to start Postgres without TLS (D-10)." >&2
    exit 1
  fi

  echo "pg-tls-entrypoint: generating a self-signed certificate at ${CERT_DIR} (first boot only -- restarts reuse it)"
  openssl req -new -x509 -days 3650 -nodes \
    -subj "/CN=mega-crm-dev-postgres" \
    -newkey rsa:2048 \
    -keyout "${KEY_FILE}" \
    -out "${CERT_FILE}"
fi

# Postgres refuses to start if the key file is group- or world-readable --
# this is the image's OWN startup check, not something this script invents,
# so setting permissions explicitly here is what turns a would-be silent
# plaintext fallback into a loud startup error if it's ever wrong. `postgres`
# is the image's own service user/group (created by the base image, not by
# this script).
chown postgres:postgres "${CERT_FILE}" "${KEY_FILE}"
chmod 600 "${KEY_FILE}"
chmod 644 "${CERT_FILE}"

exec docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file="${CERT_FILE}" \
  -c ssl_key_file="${KEY_FILE}"
