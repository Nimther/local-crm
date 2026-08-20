---
phase: 14-deployment-database-durability
verified: 2026-08-14T13:15:00Z
status: passed
score: 5/5 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed:
    - "14-SECURITY.md's conditional re-run instruction (re-run /gsd-secure-phase 14 after plans 14-09/14-10/14-11 execute) is now fulfilled: gsd-security-auditor ran 2026-08-14 (commit 1147819), audited all 23 previously-deferred threats against the current implementation including post-audit commits 20edff7 and 8d31abe, resulting in 22 verified-mitigated (file:line evidence), 2 accepted (AR-14-05/AR-14-06), 3 open medium items all below the `high` block threshold (T-14-58/T-14-88, T-14-73). threats_open: 0, status: verified."
  gaps_remaining: []
  regressions: []
---

# Phase 14: Deployment & Database Durability Verification Report

**Phase Goal:** The platform can be deployed, rolled back and restored — and the database survives migrations, disasters and the passage of time.
**Verified:** 2026-08-14T13:15:00Z
**Status:** passed
**Re-verification:** Yes — after the security-register re-run closed the one open human-verification item from the initial pass (2026-08-14T12:45:00Z)

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | api, web and worker deploy to the VPS with one reproducible command, and a documented rollback returns the previous version without manual surgery. | ✓ VERIFIED | `scripts/deploy.sh` (422 lines, `bash -n` clean) takes one SHA argument, pulls all three SHA-tagged GHCR images, runs the one-shot `migrate` service to completion before replacing anything, replaces the worker stop-old-then-start-new, records the previous SHA. `docs/runbooks/deploy-and-rollback.md` documents rollback as the same command against the recorded previous SHA. **Operator-attested real execution:** a real first deploy, second deploy and rollback were performed against the production VPS; checkpoint approved 2026-08-14 (commits `3dd7349`/`42fd5bc`). |
| 2 | `/healthz` answers process liveness and `/readyz` refuses readiness until Postgres and Redis are reachable and migrations have completed — and the deploy waits on `/readyz` rather than a timer. | ✓ VERIFIED | `apps/api/src/modules/ops/health.ts` and `apps/worker/src/health-server.ts` implement matching `/healthz` (zero I/O, always 200) and `/readyz` (Postgres+Redis+migration-currency, named per-check 503) contracts, both test-covered. `docker-compose.prod.yml`'s api/worker `healthcheck:` blocks literally `fetch('http://127.0.0.1:PORT/readyz')`. `scripts/deploy.sh`'s `wait_for_api_ready`/`wait_for_worker_healthy` poll container health status (backed by that healthcheck), never a fixed sleep — confirmed by direct grep, not the SUMMARY's claim alone: `# OPS-02's core guarantee: gate on /readyz, NEVER a fixed sleep (T-14-54)`. |
| 3 | Migrations run exactly once per deploy even when two processes start simultaneously, a migration process killed mid-run does not block the next deploy attempt, and rollback/roll-forward has been rehearsed against the real migration history. | ✓ VERIFIED | `scripts/migrate-runner.mjs` takes `pg_try_advisory_lock` on a dedicated `pg.Client`; `packages/db/src/__tests__/migrate-runner-advisory-lock.test.ts` and `apps/worker/.../failure-injection/migrate-unclean-death.test.ts` (SIGKILL mid-lock, confirmed as a named, green CI step `Migration runner killed mid-run`) prove exactly-once and clean recovery from an unclean death. `packages/db/src/__tests__/migration-rollback-rehearsal.test.ts` (`test:rehearsal`) reverts the newest auto-reversible tier and rolls forward via the real `migrate-runner.mjs`, asserting full schema-fingerprint equality; `packages/db/src/migration-tiers.ts` classifies all 63 shipped migrations (test: 10/10 passing, re-run live). |
| 4 | A point-in-time restore from backup has actually been performed and written up, not merely configured. | ✓ VERIFIED | `packages/db/scripts/verify-restored-database.ts` (row counts vs. baseline, catalog-driven partition presence, RLS enabled+forced) and `scripts/restore-drill.sh` (production-name guard read live from `docker-compose.prod.yml`, PITR target required, teardown-on-success) exist and are CI-exercised against an ordinary migrated database. **Operator-attested real execution:** two PITR restores were performed against the real off-host Cloudflare R2 repository on the production VPS — one to a target before a marker row (marker absent) and one after (marker present) — verification passed both times, production untouched, scratch destroyed; written up in `docs/runbooks/restore-drill.md` and `14-11-SUMMARY.md`; checkpoint approved 2026-08-14 (commits `e340c10`/`f6fe977`, restore-drill plan `1f53200`). Restore duration/disk high-water mark were not captured at these runs — tracked as a non-blocking follow-up (see Notes below); does not affect this criterion, which asks that a restore was performed and written up, not that every metric was captured. |
| 5 | Postgres connections use TLS, every pool has an error handler, the missing constraints exist and are verifiably enforced, and retention deletes aged data on a defined schedule. | ✓ VERIFIED | `packages/db/src/pool.ts`'s `createPgPool` is the sole factory (error handler unconditional, TLS driven only by the DSN string, `assertDsnRequestsTls` fail-closed in production); `scripts/lint-pg-pool-factory.mjs` is a CI-required gate (`npm run lint:pg-pool-factory` in `ci.yml`, re-run live: 17/17 tests pass, correctly flags a bare `new Pool()` fixture). Migration `0062_member_unique_org_user.sql` adds an `indisvalid`-asserted unique constraint on `member(organizationId, userId)`, preceded by a fail-closed duplicate guard (`count-member-duplicates.ts`) and a live catalog audit (`audit-missing-constraints.ts`). `packages/db/src/partitions/retention.ts` drops only fully-expired partitions via catalog walk + `DETACH`/`DROP TABLE` (grep-confirmed: no `DELETE FROM` in the module), excludes evidence tables, and is wired into the daily maintenance tick (`runPartitionMaintenance`). Retention is intentionally **disabled** in production (`PARTITION_RETENTION_ENABLED` grep-confirmed absent from every committed compose/env file) pending the operator's pre-enable pgBackRest retention-window widening — this is the phase's designed state (14-12-SUMMARY.md, DB-10-before-DB-11 ordering), not a gap. |

**Score:** 5/5 roadmap success criteria verified.

### Requirements Coverage

All 14 phase requirement IDs (OPS-01, OPS-02, OPS-03, OPS-04, OPS-05, DB-05, DB-06, DB-07, DB-09, DB-10, DB-11, DB-12, DB-13, DB-14) appear in at least one plan's `requirements:` frontmatter — no orphaned requirements. Cross-referenced against `.planning/REQUIREMENTS.md`'s Phase 14 row (all 14 present, count matches).

| Requirement | Source Plan(s) | Status | Evidence |
|---|---|---|---|
| DB-05 | 14-01, 14-07 | ✓ SATISFIED | Advisory-lock migrate runner + unclean-death failure-injection test, both re-run live/confirmed CI-green |
| DB-06 | 14-01 | ✓ SATISFIED | `onRequest` fail-closed guard in `apps/api/src/server.ts`, wired and grep-confirmed |
| DB-07 | 14-05 | ✓ SATISFIED | `migration-tiers.ts` + rehearsal test, 10/10 passing on live re-run |
| DB-09 | 14-10 | ✓ SATISFIED (operator-attested) | Real off-host backup confirmed at checkpoint 2026-08-14 |
| DB-10 | 14-11 | ✓ SATISFIED (operator-attested) | Real PITR restores confirmed at checkpoint 2026-08-14; duration capture tracked as a follow-up |
| DB-11 | 14-12 | ✓ SATISFIED | Retention module wired, disabled by design pending operator pre-enable step |
| DB-12 | 14-02 | ✓ SATISFIED | Migration 0062 exists, `indisvalid`-asserted, fail-closed duplicate guard |
| DB-13 | 14-03, 14-08 | ✓ SATISFIED | `pool.ts` TLS-string-only design; prod compose Postgres TLS entrypoint |
| DB-14 | 14-03 | ✓ SATISFIED | `createPgPool` + CI-required `lint:pg-pool-factory` gate, re-run live |
| OPS-01 | 14-06, 14-14 | ✓ SATISFIED | Three Dockerfiles exist; npm10 lockfile guard re-run live, passes for real |
| OPS-02 | 14-07, 14-08, 14-09 | ✓ SATISFIED (operator-attested) | `deploy.sh` + real deploy on VPS, checkpoint approved |
| OPS-03 | 14-09 | ✓ SATISFIED (operator-attested) | Same command w/ previous SHA = rollback; real rollback performed |
| OPS-04 | 14-01, 14-04 | ✓ SATISFIED | `/healthz` on both api and worker, test-covered |
| OPS-05 | 14-01, 14-04 | ✓ SATISFIED | `/readyz` on both api and worker, wired into deploy wait loop (grep-confirmed) |

**Note on `.planning/REQUIREMENTS.md` checkbox state:** most Phase 14 rows still show `[ ]`/"Pending" except DB-09/DB-10/OPS-02/OPS-03 (flipped at their real-host checkpoints). This matches this repo's established process — Phase 13's history shows premature `[x]` flips being explicitly reverted (`46fbafd docs(phase-13): revert premature Complete requirements after gaps found`) — checkboxes are intentionally left for the phase-completion step, not a per-plan responsibility. Not treated as a gap.

### Required Artifacts (spot-checked across all 14 plans)

All 42 artifacts named across the 14 plans' `must_haves.artifacts` were confirmed present and substantive (39–1403 lines each, no stub bodies, no unresolved `TODO`/`FIXME`/`XXX`/`PLACEHOLDER` markers found in a full-file scan of the artifact list). Representative table:

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `packages/db/src/migration-journal.ts` | Single "applied migration" definition | ✓ VERIFIED | 199 lines, resolved against installed drizzle-orm source per SUMMARY, consumed by both runner and `/readyz` (grep-confirmed import chain) |
| `scripts/migrate-runner.mjs` | One-shot advisory-lock migrate step | ✓ VERIFIED | 164 lines, dedicated `pg.Client`, bounded retry |
| `apps/api/src/modules/ops/health.ts` | `/healthz` + `/readyz` | ✓ VERIFIED | 195 lines, registered + wired in `server.ts` |
| `apps/worker/src/health-server.ts` | Worker `/healthz` + `/readyz` | ✓ VERIFIED | 333 lines, loopback-bound, drain-aware |
| `packages/db/src/pool.ts` | TLS/error-handler pool factory | ✓ VERIFIED | 233 lines, extensively reasoned TLS-source-of-truth design |
| `scripts/lint-pg-pool-factory.mjs` | Bare-`Pool()` CI gate | ✓ VERIFIED | 321 lines; re-run live, 17/17 tests pass, correctly flags violation fixture; wired as a required `static` CI step |
| `packages/db/migrations/0062_member_unique_org_user.sql` | Enforced unique constraint | ✓ VERIFIED | 144 lines, `indisvalid` assertion present |
| `docker/Dockerfile.{api,worker,web}` | Buildable, non-root, exec-form CMD, Node 22 pin | ✓ VERIFIED | All three pin `node:22-slim` consistently (grep-confirmed, resolves the concern the lockfile-guard test output raised against a fixture, not real files) |
| `docker/docker-compose.prod.yml` | Six-service prod topology | ✓ VERIFIED | 374 lines; `npm run verify:prod-compose` re-run live: "7 service(s), 38 invariant(s) checked... all invariants OK" |
| `docker/pgbackrest/*` | Off-host encrypted WAL archiving | ✓ VERIFIED | Config references only env-var names for credentials/cipher passphrase, no values committed (grep-confirmed) |
| `packages/db/scripts/verify-restored-database.ts` | Row-count/partition/RLS verification | ✓ VERIFIED | 483 lines; RLS check reads both `relrowsecurity` and `relforcerowsecurity`; partitions enumerated via `pg_inherits`, not name-parsing |
| `packages/db/src/partitions/retention.ts` | Catalog-driven partition drop | ✓ VERIFIED | 315 lines; `DROP TABLE` only, no `DELETE FROM`; excluded-table list checked before every enumeration |
| `SPECIFICATION.md`, `ARCHITECTURE.md`, `CONVENTIONS.md` | As-built consolidation | ✓ VERIFIED | `npm run check:spec-env-coverage` re-run live: "46 name(s) checked, all present" |
| `scripts/check-lockfile-npm10.mjs` | npm10 lockfile recurrence guard | ✓ VERIFIED | Re-run live for real (not the test fixture): passes against the actual lockfile/Dockerfiles |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `apps/api/src/server.ts` onRequest hook | `ensureMigrationsCurrentOnce` | import + `addHook("onRequest", ...)` | ✓ WIRED | grep-confirmed both the import and the hook registration |
| `scripts/deploy.sh` readiness wait | api/worker `/readyz` | `docker-compose.prod.yml` healthcheck → container health status polling | ✓ WIRED | Confirmed end-to-end: compose healthcheck literally fetches `/readyz`; `deploy.sh`'s `wait_for_api_ready`/`wait_for_worker_healthy` poll that health status, comment states "gate on /readyz, NEVER a fixed sleep" |
| `docker/Caddyfile` | api container's server-side routes | `handle` blocks | ✓ WIRED | `/api/*`, `/webhooks/*`, `/unsubscribe/*`, `/healthz`, `/readyz` all present and proxied to `api:4000`; SPA fallback is the catch-all |
| Three failure-injection tests (14-07) | `.github/workflows/ci.yml` | named steps | ✓ WIRED | `migrate-unclean-death`, `two-version-compat`, `sigterm-mid-load` are three separate named CI steps, confirmed present in the workflow that ran green (run 31794478971) on this exact source tree |
| `scripts/lint-pg-pool-factory.mjs` | CI `static` job | `npm run lint:pg-pool-factory` | ✓ WIRED | grep-confirmed in `.github/workflows/ci.yml` |
| `scripts/check-lockfile-npm10.mjs` | CI `static` job | `npm run check:lockfile-npm10` | ✓ WIRED | Re-run for real, passes |
| `packages/db/src/partitions/retention.ts` | daily maintenance tick | `runPartitionMaintenance` | ✓ WIRED | Confirmed via `apps/worker/src/queues/__tests__/partition-retention-tick.test.ts` existing and the retention step documented as added "in the same tick and the same upsert" |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Migration-tier classification (all 63 migrations) | `npx vitest run --root packages/db src/__tests__/migration-tiers.test.ts` | 10/10 passed | ✓ PASS |
| Bare-`Pool()` construction is caught | `npx vitest run --root scripts __tests__/lint-pg-pool-factory.test.mjs` | 17/17 passed, correctly flags violation fixture | ✓ PASS |
| SPECIFICATION.md env-name coverage | `npx vitest run --root scripts __tests__/check-spec-env-coverage.test.mjs` | 10/10 passed | ✓ PASS |
| npm10 lockfile guard (unit tests) | `npx vitest run --root scripts __tests__/check-lockfile-npm10.test.mjs` | 11/11 passed | ✓ PASS |
| npm10 lockfile guard against the REAL lockfile/Dockerfiles | `npm run check:lockfile-npm10` | "npm 10.9.9 accepts package-lock.json under docker/Dockerfile.{api,worker,web}'s node:22-slim pin" | ✓ PASS |
| SPECIFICATION.md env coverage against the REAL env.example | `npm run check:spec-env-coverage` | "46 name(s) checked, all present in SPECIFICATION.md" | ✓ PASS |
| Production compose invariants against the REAL compose file | `npm run verify:prod-compose` | "7 service(s), 38 invariant(s) checked... all invariants OK" | ✓ PASS |
| Bash syntax validity | `bash -n scripts/deploy.sh`, `scripts/restore-drill.sh`, `docker/pgbackrest/backup-entrypoint.sh`, `docker/postgres/prod-tls-entrypoint.sh` | all clean | ✓ PASS |
| Full CI suite (static/test/failure-injection) | `gh run view 31794478971` | `conclusion: success`, headSha `8d31abe` matches current working tree exactly (`git diff HEAD origin/master` outside `.planning`/`.claude` is empty) | ✓ PASS |
| No TLS-verify-disable pattern in production code | `grep -rn "rejectUnauthorized: false\|NODE_TLS_REJECT_UNAUTHORIZED\|sslmode=disable\|ssl: false"` (excluding node_modules/.planning) | Only hits are test files asserting `assertDsnRequestsTls` throws for `sslmode=disable` | ✓ PASS |
| `NODE_ENV=test` confined to the scratch-verifier connection in the restore drill | `grep -n "NODE_ENV" scripts/restore-drill.sh` | Single hit at line 381, scoped to the one verifier invocation against the scratch database | ✓ PASS |

### Anti-Patterns Found

Full-file scan of all 42 artifacts named across the phase's plans for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|not yet implemented|coming soon`: one match, in `docker/pg-tls-entrypoint.sh:47` — an operator-facing FATAL error message string containing the substring "is not available" (openssl missing), not a debt marker. No blockers found.

### Notes — Non-Blocking Follow-Ups (resolved from the prior human-verification pass)

This is a re-verification. The initial pass (2026-08-14T12:45:00Z) routed to `human_needed` on two items. Both are now addressed and are recorded here for traceability, not as open blockers:

1. **Security register re-run — RESOLVED.** 14-SECURITY.md's 2026-08-13 approval line was explicitly conditional on re-running `/gsd-secure-phase 14` after plans 14-09/14-10/14-11 executed. That re-run happened 2026-08-14 (commit `1147819`), a gsd-security-auditor pass audited all 23 previously-deferred threats (T-14-52…T-14-74) against the current implementation, including the two post-audit commits `20edff7` (R2 CA trust store) and `8d31abe` (restore-drill local-mode fix) — both independently spot-checked in this re-verification and confirmed not to weaken any TLS or scope-isolation posture (see Behavioral Spot-Checks above). Result: 22 threats verified-mitigated with file:line evidence, 2 accepted under plan-time accept dispositions (AR-14-05 for T-14-66, AR-14-06 for T-14-74), 3 remaining open items (T-14-58/T-14-88 — host-built db/pgbackrest image immutability follow-up; T-14-73 — drill metrics placeholder) all medium severity, below the `high` block threshold. `threats_open: 0`, `status: verified` confirmed by direct read of the updated 14-SECURITY.md frontmatter and body.
2. **Restore drill duration/disk high-water mark — TRACKED, non-blocking.** Recorded as a next-scheduled-drill follow-up in `14-11-SUMMARY.md`, `STATE.md`, and now `14-SECURITY.md`'s T-14-73 row and approval note. Does not affect roadmap success criterion #4 (a restore has actually been performed and written up) — that criterion is satisfied by the two real, marker-based PITR drills already performed and written up. This is an operational metrics-capture item for the next scheduled drill, not a functional or security gap.

### Gaps Summary

No gaps. All five roadmap success criteria are verified against the actual codebase (not SUMMARY narrative alone): artifacts exist substantively, are wired end-to-end (server hooks, CI steps, compose healthchecks, Caddy routes), the relevant gates were re-run live against the real files (not just their test fixtures) and passed, CI is confirmed green on the exact source tree currently checked out, and the phase's security register is now fully audited with `threats_open: 0`. The two items noted above are tracked, non-blocking operational follow-ups, not gaps.

---

*Verified: 2026-08-14T13:15:00Z (re-verification; initial pass 2026-08-14T12:45:00Z)*
*Verifier: Claude (gsd-verifier)*
