---
phase: 14-deployment-database-durability
fixed_at: 2026-08-13T07:40:28Z
review_path: .planning/phases/14-deployment-database-durability/14-REVIEW.md
iteration: 1
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 14: Code Review Fix Report

**Fixed at:** 2026-08-13T07:40:28Z
**Source review:** .planning/phases/14-deployment-database-durability/14-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 8 (CR-01, WR-01 through WR-07; IN-01 excluded, out of `critical_warning` scope)
- Fixed: 8
- Skipped: 0

All fixes were applied in an isolated git worktree (`gsd-reviewfix/14-85885`, branched from `gsd/phase-14-deployment-database-durability`), committed one finding per commit, then fast-forwarded onto the phase branch.

## Fixed Issues

### CR-01: `web` container runs as non-root with no ownership grant on its persistent ACME storage

**Files modified:** `docker/Dockerfile.web`
**Commit:** `64e81ac`
**Applied fix:** Added `RUN mkdir -p /data /config && chown -R caddyweb:caddyweb /data /config` immediately before `USER caddyweb` in the runtime stage, so the volumes `docker-compose.prod.yml` mounts onto `/data`/`/config` are writable by the non-root `caddyweb` user instead of inheriting root ownership from the `caddy:2` base image.
**Verification:** Tier 1 (re-read) only. No Docker daemon is available in this sandbox, so the chown was never exercised against an actual image build + volume attach. **Recommend real-host verification**: build the `web` image, bring it up against the compose volumes, and confirm `/data/caddy` (ACME storage) is writable by uid 1000 and survives a container restart.

## Warnings Fixed

### WR-01: `db` healthcheck can report healthy during Postgres's own first-boot bootstrap window

**Files modified:** `docker/docker-compose.prod.yml`
**Commit:** `2036a19`
**Applied fix:** Changed the `db` healthcheck test from `pg_isready -U ${POSTGRES_USER:-postgres}` to `pg_isready -h 127.0.0.1 -U ${POSTGRES_USER:-postgres}`, forcing a TCP probe of the real Postgres listener instead of the Unix socket (which can resolve to the temporary bootstrap server during `docker-entrypoint-initdb.d/*`).
**Verification:** Tier 1 (re-read) plus `docker compose config` validation — the only decoding error present (`worker.stop_grace_period`) is pre-existing and unrelated to the `db` service (caused by an unset env var in this sandbox, not by this edit).

### WR-02: Blank-password guard in `init-prod-roles.sql` does not fire in its most realistic failure mode

**Files modified:** `docker/postgres/init-prod-roles.sql`
**Commit:** `07b4867`
**Applied fix:** Extended each of the three password guards (`MEGA_CRM_APP_PASSWORD`, `MEGA_CRM_SCAN_PASSWORD`, `MEGA_CRM_AUTH_PASSWORD`) to also catch the set-but-empty case: when `\if :{?var}` confirms the variable is defined, a `SELECT (:'var' = '') AS is_blank \gset` now checks for emptiness before proceeding; either an unset or an empty value raises the same `RAISE EXCEPTION`.
**Verification:** Tier 2 — ran the actual file against a local Postgres 17 instance for all three cases: (1) all vars unset (guard fires, exit 3), (2) `MEGA_CRM_APP_PASSWORD=""` set-but-empty — the exact scenario the reviewer flagged (guard fires, exit 3), (3) all vars set to real values (roles created, database owner/grants applied, exit 0, on a disposable scratch database that was dropped afterward with no changes to pre-existing project databases).

### WR-03: Partition-drop DDL interpolates catalog-sourced identifiers without the allowlist discipline used elsewhere in the same phase

**Files modified:** `packages/db/src/partitions/retention.ts`
**Commit:** `aeaf1fb`
**Applied fix:** Added a `SAFE_IDENTIFIER` regex (mirroring `verify-restored-database.ts`'s `SAFE_TABLE_NAME`) and an `assertSafeIdentifier` helper, called on both `partition.parentTable` and `partition.partitionName` immediately before they are interpolated into the `DETACH PARTITION`/`DROP TABLE` DDL in `dropExpiredPartitions`.
**Verification:** Tier 2 (partial) — `tsc --noEmit` produced no errors attributable to `partitions/retention.ts` itself (only pre-existing "Cannot find module" resolution errors uniform across the whole package, caused by the worktree not having its own `node_modules`/workspace links — unrelated to this edit). Tier 1 re-read confirms the fix is intact.

### WR-04: `validate-prod-compose.mjs`'s `oom_score_adj` invariant does not cover `pgbackrest`

**Files modified:** `scripts/validate-prod-compose.mjs`, `scripts/__tests__/validate-prod-compose.test.mjs`, `scripts/__fixtures__/prod-compose/pgbackrest-oom-score-adj-negative.yml` (new)
**Commit:** `6cd7c69`
**Applied fix:** Replaced the `if (db) / else if (api || worker)` polarity check with an explicit `NEVER_NEGATIVE_OOM_SERVICES` set derived from `EXPECTED_SERVICES` (everything except `db`), so `web`/`migrate`/`pgbackrest`/`redis` are covered by construction. Added a new fixture (`pgbackrest-oom-score-adj-negative.yml`) and a corresponding test case, matching the reviewer's explicit request for a fixture that trips it for `pgbackrest`.
**Verification:** Tier 2 — ran `scripts/__tests__/validate-prod-compose.test.mjs` via vitest: 23 of 25 tests pass, including the new `pgbackrest-oom-score-adj-negative.yml` case in isolation. The 2 failures are pre-existing and unrelated (the real compose file's `worker.stop_grace_period` check fails in this sandbox because `apps/worker` was never built — an environment limitation, not caused by this change).

### WR-05: `deploy.sh` derives the worker's stop-grace-period from the local working tree, not from the target SHA being deployed

**Files modified:** `scripts/deploy.sh`
**Commit:** `121cd59`
**Applied fix:** Adapted from the reviewer's suggested fix. Rather than mutating the working tree with an implicit `git checkout` (a side effect that could surprise an operator's own checkout state), `resolve_worker_stop_grace_period` now compares `git rev-parse HEAD` against `$TARGET_SHA` before building, and aborts loudly with an actionable message if they don't match — consistent with this script's own stated fail-loud convention (Pitfall 7).
**Verification:** Tier 2 — ran the full `deploy-script.test.mjs` suite (17 tests, all passing before this specific test file was later extended for WR-07). Tests never exercise this new check directly, by design: `baseRealEnv` always sets the `DEPLOY_SCRIPT_TEST_STOP_GRACE_PERIOD_SECONDS` escape hatch, which returns before this code path runs — the same escape hatch this fix's guard clause sits after.
**Operator-visible behavior change (flag for `docs/runbooks/deploy-and-rollback.md`, not edited — out of this fix's scope):** `scripts/deploy.sh --rollback-to <sha>` now REQUIRES the local checkout to already be at `<sha>` before running; it previously proceeded silently regardless. An operator rolling back must `git checkout <sha>` first. Residual gap not addressed (documented, not coded around): a *dirty* tree that happens to be at the right SHA still passes this check — it verifies commit identity, not working-tree cleanliness.

### WR-06: `restore-drill.sh` builds a connection URL by unencoded string interpolation of a password

**Files modified:** `scripts/restore-drill.sh`
**Commit:** `82ee691`
**Applied fix:** `POSTGRES_PASSWORD` is now percent-encoded via `node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))'` before being interpolated into `VERIFY_RESTORED_DATABASE_URL`, exactly as the reviewer suggested.
**Verification:** Tier 2 — ran the full `restore-drill-script.test.mjs` suite (18 tests, all passing, exercising the encoded-password code path via the PATH-injected `npm` stub in several cases). Additionally ran a standalone round-trip test: a password containing every flagged character class (`@`, `:`, `/`, `#`, `%`, whitespace) was encoded, embedded in a URL, parsed with Node's `URL`, and decoded back to the exact original string.

### WR-07: No healthcheck (and no deploy-time gate) exists for the `web` service at all

**Files modified:** `docker/docker-compose.prod.yml`, `scripts/deploy.sh`, `scripts/__tests__/deploy-script.test.mjs`
**Commit:** `7ebf3d7`
**Applied fix:** Added a `healthcheck:` to the `web` service in `docker-compose.prod.yml`, probing Caddy's own admin API (`wget --spider -q http://127.0.0.1:2019/config/`) rather than the public `{$SITE_ADDRESS}` site — this avoids any dependency on ACME certificate issuance or DNS/hostname resolution for the check itself. Added a matching `wait_for_web_ready` gate to `scripts/deploy.sh`, called right after the existing `wait_for_api_ready` wait and before the worker is replaced, plus corresponding entries in `print_dry_run`. Extended `deploy-script.test.mjs` with a dedicated web-readiness-timeout test and ordering assertions.
**Verification:** Tier 2 — ran the extended `deploy-script.test.mjs` suite (18 tests, all passing, including the new web-timeout test and updated ordering assertions). `docker compose config` validation shows no new decoding errors. **Recommend real-host verification**: no container was ever actually run, so the assumption that busybox `wget` exists in the `caddy:2` image and that Caddy's admin API answers on `127.0.0.1:2019` by default (both true per Caddy's documented defaults, but unverified against a live container here) should be confirmed on first real deploy.

## Skipped Issues

None — all 8 in-scope findings were fixed.

## Notes for the developer

Three of the eight fixes (CR-01, WR-07, and the `git checkout`-comparison branch of WR-05) touch code paths that could not be exercised against a real Docker daemon or a real deploy host in this sandbox (no `docker` daemon was available; `apps/worker` was never built). These are functionally sound based on static reasoning, empirical testing of everything that *could* be tested in-sandbox (vitest suites, `docker compose config`, local psql), and close mirroring of already-verified patterns elsewhere in the same phase (e.g. WR-07's healthcheck reuses the exact `api`/`worker` readiness-gate pattern). Per this phase's own existing convention of tracking "pending real-host checkpoints" in STATE, these three are flagged here as requiring confirmation on the next real deploy/build rather than being asserted as fully proven.

---

_Fixed: 2026-08-13T07:40:28Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
