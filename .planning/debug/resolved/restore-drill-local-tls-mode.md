---
status: resolved
trigger: "The real Phase 14 scratch restore reaches readiness but db:verify-restored rejects its loopback DSN because production NODE_ENV is inherited"
created: 2026-08-14T15:54:00+05:00
updated: 2026-08-14T16:12:00+05:00
symptoms_prefilled: true
goal: find_and_fix
---

## Current Focus

hypothesis: "restore-drill.sh sources production.env, inherits NODE_ENV=production, and invokes the verifier against a loopback-only scratch Postgres DSN without TLS; createPgPool therefore correctly applies the production remote-DSN TLS guard to a deliberately local isolated connection"
test: "Run the shell-script regression suite with an assertion that the verifier command explicitly sets NODE_ENV=test, then repeat the real scratch restore"
expecting: "The verifier connects only to 127.0.0.1:55611 in local/test mode, while every real production pool continues to require sslmode=require/verify-*"
next_action: "resolved"

## Symptoms

expected: "scripts/restore-drill.sh restores to an isolated scratch container, verifies schema/RLS/partitions, then deletes scratch resources."
actual: "The scratch database restores and becomes ready, but verifier startup fails before its first SQL query."
errors: "refusing to build a production Postgres pool from a DSN that does not request TLS (sslmode=(absent))"
reproduction: "On the Droplet, run MEGA_CRM_ENV_FILE=/etc/mega-crm/production.env ./scripts/restore-drill.sh '2026-08-14 10:52:13+00'."
started: "First real-host Phase 14 restore checkpoint on 2026-08-14."

## Evidence

- timestamp: 2026-08-14T15:54:00+05:00
  checked: "real restore-drill output"
  found: "pgBackRest restore completed and pg_isready passed; failure begins only when db:verify-restored constructs its pool."
  implication: "Backup bytes, decryption, WAL replay and scratch Postgres startup are already working."

- timestamp: 2026-08-14T15:54:00+05:00
  checked: "scripts/restore-drill.sh and packages/db/src/pool.ts"
  found: "The script sources production.env and does not override NODE_ENV for its loopback verifier; createPgPool intentionally requires a TLS-requesting sslmode whenever NODE_ENV=production."
  implication: "The verifier must declare its isolated local execution mode explicitly; weakening the shared pool guard would be wrong."

## Resolution

root_cause: "restore-drill.sh sourced production.env and inherited NODE_ENV=production into db:verify-restored even though that one verifier DSN targets only a loopback-published disposable Postgres container without the production TLS certificate volume."
fix: "Explicitly set NODE_ENV=test only for the loopback scratch verifier subprocess, retained the shared production pool TLS guard unchanged, documented the boundary, and added a production-shaped regression fixture."
verification: "TDD regression failed before and passed after; 19/19 restore-drill script tests, ESLint, diff check and full GitHub CI/Images passed. Real pre-marker restore passed with verification count 0 vs baseline 2; real post-marker restore passed with count 1 vs baseline 2; both checked 12+12 partitions and RLS on 28 tables, then destroyed scratch resources. Production remained ready and temporary markers were deleted."
files_changed:
  - scripts/restore-drill.sh
  - scripts/__tests__/restore-drill-script.test.mjs
  - docs/runbooks/restore-drill.md
