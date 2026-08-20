---
status: resolved
trigger: "First real Phase 14 backup cannot initialize the Cloudflare R2 repository because the pgBackRest container has no trusted CA bundle"
created: 2026-08-14T15:30:00+05:00
updated: 2026-08-14T15:50:02+05:00
symptoms_prefilled: true
goal: find_and_fix
---

## Current Focus

hypothesis: "The shared postgres/pgBackRest image installs pgbackrest and cron with --no-install-recommends but omits ca-certificates, so TLS verification against the R2 endpoint has no trust store"
test: "Assert the Dockerfile installs ca-certificates, rebuild the real image, and run stanza-create/check against R2 with TLS verification enabled"
expecting: "The rebuilt container contains /etc/ssl/certs/ca-certificates.crt and pgBackRest reaches the encrypted private R2 repository without disabling certificate checks"
next_action: "resolved"

## Symptoms

expected: "Starting the pgbackrest sidecar creates the mega_crm stanza in the configured encrypted Cloudflare R2 repository."
actual: "The sidecar starts cron but stanza-create aborts before repository initialization."
errors: "ERROR [095]: unable to verify certificate presented by local-crm.<account>.r2.cloudflarestorage.com:443: unable to get local issuer certificate"
reproduction: "On the real Droplet, start the production pgbackrest service with /etc/mega-crm/production.env and inspect its first-boot logs."
started: "First real-host Phase 14 backup checkpoint on 2026-08-14; this path had never been exercised against S3/R2 before."

## Eliminated

- hypothesis: "Cloudflare R2 endpoint, bucket, or credentials are missing"
  evidence: "pgBackRest resolved and connected to the configured bucket hostname; failure occurs specifically during peer certificate verification before authentication."
  timestamp: 2026-08-14T15:30:00+05:00

## Evidence

- timestamp: 2026-08-14T15:30:00+05:00
  checked: "docker-pgbackrest-1 filesystem and package database"
  found: "/etc/ssl/certs/ca-certificates.crt is absent and the ca-certificates package is not installed."
  implication: "The image has no system trust store for HTTPS object storage."

- timestamp: 2026-08-14T15:30:00+05:00
  checked: "docker/postgres/Dockerfile"
  found: "The --no-install-recommends apt install includes only pgbackrest and cron."
  implication: "The omission is deterministic and will recur on every clean rebuild."

## Resolution

root_cause: "The shared postgres/pgBackRest image installed pgBackRest with --no-install-recommends but omitted ca-certificates, so HTTPS to Cloudflare R2 had no trusted root store."
fix: "Installed ca-certificates in docker/postgres/Dockerfile, added a regression test, and updated the backup/specification documentation without weakening TLS verification."
verification: "PR #10 CI and Images workflows passed; the Droplet image contains /etc/ssl/certs/ca-certificates.crt; stanza-create and pgbackrest check succeeded against private R2; WAL 000000010000000000000003 archived; full encrypted backup 20260814-104803F completed (32.8MB database, 4.1MB repository set, AES-256-CBC)."
files_changed:
  - docker/postgres/Dockerfile
  - scripts/__tests__/postgres-dockerfile.test.mjs
  - docs/runbooks/backups.md
  - SPECIFICATION.md
