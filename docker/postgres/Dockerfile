# syntax=docker/dockerfile:1
#
# Phase 14 plan 10 (DB-09, D-05, D-06, T-14-62). Extends the official
# `postgres:17` image with pgBackRest (and `cron`, for the scheduled-backup
# sidecar -- docker/pgbackrest/backup-entrypoint.sh) so the `archive_command`
# Postgres itself executes has a binary to run. This is NOT an optimisation:
# `archive_command` is invoked by the Postgres server process, inside ITS
# OWN container, so a sidecar-only pgBackRest install (no binary in the `db`
# container) produces a configuration that LOOKS complete while zero WAL
# ever ships -- the gap is invisible until the first restore is attempted
# (T-14-62). Both `db` (docker-compose.prod.yml, running
# docker/postgres/prod-tls-entrypoint.sh) and the `pgbackrest` sidecar
# service (running docker/pgbackrest/backup-entrypoint.sh) are built from
# this SAME image -- one Dockerfile, two entrypoints, so both containers
# have an identical pgBackRest binary, an identical Postgres OS user (uid
# 999, fixed by the upstream image's own `useradd --uid=999`), and an
# identical filesystem layout, which is exactly what lets the sidecar read
# the shared PGDATA volume and connect over the shared Unix-socket volume
# without any UID-mapping tricks.
#
# `postgres:17` currently resolves to Debian trixie (confirmed by real arm64
# and amd64 builds on 2026-08-14). pgBackRest, cron, and the system CA bundle
# below are installed from the official image's configured Debian/PostgreSQL
# apt repositories (already this image's trust boundary), never an added
# third-party source or a
# manually-downloaded binary. The CA bundle is explicit because
# `--no-install-recommends` otherwise leaves this slim image unable to verify
# the HTTPS certificate of an S3-compatible backup repository such as
# Cloudflare R2; disabling pgBackRest TLS verification is never an acceptable
# substitute.
#
# Installed pgBackRest version: 2.59.0, verified in real arm64 and amd64
# builds on 2026-08-14. Every pgbackrest.conf key this plan uses
# (repo1-type/repo1-s3-*/repo1-cipher-*/repo1-retention-*/process-max/
# pg1-path/pg1-user/pg1-socket-path) and every command
# (stanza-create/archive-push/check/backup/info) was verified directly
# against a REAL pgBackRest binary (Homebrew 2.59.0) against a real Postgres
# 17 cluster and a real
# filesystem-type repository: stanza-create, archive_mode=on +
# archive_command producing real archived WAL (confirmed via
# `pg_stat_archiver`), `check`, a real `--type=full backup`, and `info`
# reporting the repository as `cipher: aes-256-cbc` all passed end-to-end.
# A real `docker build` + `pgbackrest version` remains the authoritative
# check after any future base-tag rebuild because `postgres:17` is mutable.
FROM postgres:17

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest cron ca-certificates \
 && rm -rf /var/lib/apt/lists/*
