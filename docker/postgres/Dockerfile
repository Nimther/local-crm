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
# `postgres:17` is Debian bookworm-slim (confirmed via
# docker-library/postgres's own generated Dockerfile at
# github.com/docker-library/postgres/blob/master/17/bookworm/Dockerfile,
# `FROM debian:bookworm-slim`) -- pgBackRest and cron below are installed
# from Debian's OWN bookworm apt repository (already this image's trust
# boundary), never a third-party apt source or a manually-downloaded binary.
#
# Installed pgBackRest version: Debian bookworm ships 2.45-1 in `main`
# (confirmed via packages.debian.org/bookworm/pgbackrest at authoring time --
# RESEARCH.md's "2.5x [ASSUMED]" was explicitly NOT trusted, per this plan's
# own instruction). Every pgbackrest.conf key this plan uses
# (repo1-type/repo1-s3-*/repo1-cipher-*/repo1-retention-*/process-max/
# pg1-path/pg1-user/pg1-socket-path) and every command
# (stanza-create/archive-push/check/backup/info) was verified directly
# against a REAL pgBackRest binary (Homebrew 2.59.0, this sandbox has no
# Docker daemon -- see docs/runbooks/backups.md's "What this plan verified
# locally" section) against a real Postgres 17 cluster and a real
# filesystem-type repository: stanza-create, archive_mode=on +
# archive_command producing real archived WAL (confirmed via
# `pg_stat_archiver`), `check`, a real `--type=full backup`, and `info`
# reporting the repository as `cipher: aes-256-cbc` all passed end-to-end.
# 2.45 vs 2.59 is a version gap this sandbox could not close (no Docker
# daemon to install the EXACT Debian package) -- these option names have
# been stable across that range (unlike, say, S3 key-type auto-detection,
# which is newer); a real `docker build` + `pgbackrest version` (this plan's
# own <verify> block) re-confirms the exact shipped version and is the
# authoritative record for SPECIFICATION.md, not this comment.
FROM postgres:17

RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest cron \
 && rm -rf /var/lib/apt/lists/*
