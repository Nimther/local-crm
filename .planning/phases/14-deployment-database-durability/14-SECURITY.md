---
phase: 14
slug: deployment-database-durability
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-13
updated: 2026-08-14
---

# Phase 14 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

**Scope note:** all 14 plans carry plan-time `<threat_model>` blocks and all 14 are now executed (SUMMARY present; UAT 42/42 passed; 14-09/14-10/14-11 real-host checkpoints approved by the operator 2026-08-14). The register entries previously deferred for plans **14-09 (deploy.sh), 14-10 (pgBackRest backups), 14-11 (restore drill)** were audited 2026-08-14 by gsd-security-auditor against the current implementation, including the two post-audit commits `20edff7` (CA trust store for R2 — verified to strengthen posture; zero TLS-verify-disable hits repo-wide) and `8d31abe` (restore-drill local-mode verification — `NODE_ENV=test` confined to the scratch verifier child process, scope pinned by test; production TLS guard byte-unchanged).

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| deploy operator → database (migrate step) | Privileged process applies arbitrary DDL; concurrency/abort behavior is the risk surface | Schema DDL, advisory locks |
| internet/Caddy → `/healthz`, `/readyz` | Deliberately unauthenticated endpoints; responses are public | Check outcomes, pending migration tags only |
| container start → database | A container may start against a schema predating the image | Migration currency state |
| migration runner → `member` (Better Auth boundary) | DDL against a table reached in production via a different role | Membership/permission rows |
| application container → Postgres over Docker network | Credentials and tenant data cross a shared network segment | DSNs, tenant data (TLS-encrypted) |
| repository → TLS key material | A committed private key is permanently disclosed | TLS private keys (generated in-volume, never in tree) |
| container network → worker health port | New listener in a previously HTTP-free process | Check names, pending migration tags only |
| orchestrator signal → worker shutdown | SIGTERM begins a drain with a derived budget | In-flight send outcomes |
| build context → image | Anything in context can enter a layer permanently | Env files (excluded via .dockerignore) |
| third-party GitHub Action → CI token + tree | Actions run with `packages: write` and repo read | CI tokens, GHCR credentials |
| internet → Caddy | Single public entry point | All proxied traffic incl. webhook bodies |
| registry tag → deployed artifact | Mutable tags break "deploy SHA X = what ran" | Immutable SHA-tagged images |
| kernel OOM killer → container set | Which process dies under memory pressure is configured | Memory limits, oom_score_adj |
| scheduled tick → irreversible data deletion | The only automatic destructive operation | Partition drops (12-month horizon) |
| retention scope → evidence tables | Compliance proof lives one table from deleted data | 5 excluded evidence-table groups |
| enable flag → deletion becoming live | One env value separates "defined" from "deleting" | PARTITION_RETENTION_ENABLED (off) |
| SPECIFICATION.md → external security reviewer | Doc inaccuracy = unreviewed surface | Names/sources only, never secret values |
| npm registry → build toolchain | Third-party tarballs enter lockfile and image builds | Integrity-hashed lockfile entries |
| fork pull_request → Images workflow | Untrusted tree built by workflow with `packages: write` file-grant | PR job restricted to `contents: read` |
| operator shell → production host (14-09) | Deploy runs with full system control | SHA-tagged images, env-file path only (no values) |
| VPS → S3 object storage (14-10) | Entire database leaves the host | pgBackRest repo, aes-256-cbc cipher, WAL segments |
| drill script → production data volume (14-11) | Could destroy production data | Read-only vs production; writes only to name-guarded scratch |

---

## Threat Register

### Executed plans (implemented surface) — all closed

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-14-01 | DoS | migrate-runner.mjs advisory lock | high | mitigate | `pg_try_advisory_lock` bounded retry on dedicated client (verified in scripts/migrate-runner.mjs); pg_locks assertion in tests | closed |
| T-14-02 | Tampering | concurrent migration application | high | mitigate | Two-real-processes test: each tag lands once, loser exits non-zero (14-01 SUMMARY, UAT #10) | closed |
| T-14-03 | Info Disclosure | /readyz response body | medium | mitigate | Body names check outcomes + pending tags only (UAT #13) | closed |
| T-14-04 | Spoofing/EoP | unauthenticated /healthz, /readyz | low | accept | Accepted by design D-13/D-14 — see Accepted Risks Log | closed |
| T-14-05 | Tampering | container serving on stale schema | high | mitigate | onRequest fail-closed guard 503s non-health routes until currency confirmed (UAT #14) | closed |
| T-14-06 | DoS | /healthz coupled to backing services | medium | mitigate | Zero-I/O /healthz, closed-port tests (UAT #12) | closed |
| T-14-07 | Tampering | CREATE UNIQUE INDEX over duplicates | high | mitigate | Duplicate RAISE guard + `pg_index.indisvalid` assertion (UAT #17) | closed |
| T-14-08 | EoP | --resolve deleting higher-privileged dup | high | mitigate | Earliest-createdAt keeper, differing-role warning, operator-invoked only (UAT #16) | closed |
| T-14-09 | EoP | duplicate membership rows | medium | mitigate | member(organizationId, userId) unique constraint, migration 0062 applied (UAT #2, #17) | closed |
| T-14-10 | Info Disclosure | audit/count script output | low | mitigate | Reports emit ids/counts only, no invitee emails (UAT #15) | closed |
| T-14-11 | Info Disclosure | Postgres traffic on Docker network | high | mitigate | ssl=on + assertDsnRequestsTls fail-closed in production (packages/db/src/pool.ts); pg_stat_ssl proof (UAT #3) | closed |
| T-14-12 | Spoofing | co-located container impersonating Postgres | medium | accept | Accepted with revisit trigger D-10 — see Accepted Risks Log | closed |
| T-14-13 | DoS | pool without error handler | high | mitigate | Factory attaches listener unconditionally; `lint:pg-pool-factory` in CI (ci.yml:93) (UAT #18–19) | closed |
| T-14-14 | DoS | pool maxima exceeding max_connections | medium | mitigate | Named PG_POOL_SIZES + compose gate asserts max_connections above sum (UAT #35) | closed |
| T-14-15 | Info Disclosure | TLS key committed to git | high | mitigate | Key generated in named volume, .gitignore covered, git-status assertion (UAT #3) | closed |
| T-14-16 | Info Disclosure | pool error logs leaking credentials | medium | mitigate | Error listener routes through scrubbedConsole (pool.ts:229) | closed |
| T-14-17 | Info Disclosure | worker HTTP listener | high | mitigate | WORKER_HEALTH_HOST=127.0.0.1 literal (health-server.ts:50), never published; non-loopback connection test (UAT #23) | closed |
| T-14-18 | EoP | unauthenticated worker health endpoints | low | accept | Accepted by design D-14, loopback-unroutable — see Accepted Risks Log | closed |
| T-14-19 | DoS | worker /healthz coupled to Postgres/Redis | high | mitigate | Zero-I/O, asserted with both deps failing (UAT #20) | closed |
| T-14-20 | Tampering | stop-grace-period drift below drain budget | high | mitigate | print-stop-grace-period.mjs machine-read value + drift test (UAT #25) | closed |
| T-14-21 | Tampering | draining worker flickering back to ready | medium | mitigate | Monotonic draining flag, never cleared (UAT #22) | closed |
| T-14-22 | Tampering | rehearsal revert DDL vs real database | high | mitigate | Ephemeral-provisioner DSN guard runs first, fail-closed (UAT #28) | closed |
| T-14-23 | Tampering | forward-only migration misclassified | high | mitigate | Independent SQL scan cross-check, tierFor throws on unknown (UAT #26) | closed |
| T-14-24 | Repudiation | green empty-diff overclaim | high | mitigate | Overclaim documented in test + runbook three-proofs table (UAT #29) | closed |
| T-14-25 | DoS | empty-diff check leaving untracked files | medium | mitigate | --out to temp copy, git-status porcelain comparison (UAT #27) | closed |
| T-14-26 | Tampering | hand-edited drizzle snapshot | medium | mitigate | Snapshots drizzle-kit-output-only, prohibition stated (UAT #27) | closed |
| T-14-27 | Tampering | third-party Actions in images.yml | high | mitigate | All 7 `uses:` pinned to 40-char SHAs, zero `@vN` refs (grep-verified) | closed |
| T-14-28 | Info Disclosure | secrets entering an image layer | high | mitigate | .dockerignore excludes .env/.env.*/**/.env* + .git + .planning (verified) | closed |
| T-14-29 | Tampering | mutable image tags | high | mitigate | One SHA-derived tag per image; no :latest (grep: 0 in compose) (UAT #6) | closed |
| T-14-30 | Info Disclosure | Caddy serving SPA to webhook POST | high | mitigate | Explicit handle blocks for server-side paths, stub-upstream verified (UAT #5) | closed |
| T-14-31 | Tampering | proxy transforming webhook body | high | mitigate | Byte-identical passthrough asserted against stub upstream (UAT #5) | closed |
| T-14-32 | DoS | start command not receiving SIGTERM | high | mitigate | JSON exec-form CMD with node as PID 1 (Dockerfile verified) (UAT #4) | closed |
| T-14-33 | EoP | container processes running as root | medium | mitigate | `USER node` in runtime stages (Dockerfile.api:117), id -u asserted (UAT #4) | closed |
| T-14-34 | Tampering | Node version derived from .nvmrc | medium | mitigate | Literal `FROM node:22-slim` (Dockerfile.api:19,70) with reason commented | closed |
| T-14-35 | Info Disclosure | long-cached index.html surviving rollback | low | mitigate | Hashed assets long-cached; index.html not (UAT #5) | closed |
| T-14-36 | DoS | abandoned advisory lock after unclean death | high | mitigate | SIGKILL scenario asserts pg_locks empty (UAT #30) | closed |
| T-14-37 | Tampering | partial migration recorded as applied | high | mitigate | Journal-integrity assertion post-SIGKILL, clean re-run (UAT #30) | closed |
| T-14-38 | Tampering | worker processing unknown payload version | high | mitigate | Both overlap directions asserted: unrecognized defers, legacy processes (UAT #31) | closed |
| T-14-39 | DoS | one deferred payload stalling a queue | medium | mitigate | Interleaved recognized job completes; all-five-states count (UAT #31) | closed |
| T-14-40 | Repudiation | send row claiming unobserved outcome | high | mitigate | Post-drain ledger asserted with Phase 11 boundary classification (UAT #32) | closed |
| T-14-41 | DoS | drain never completing in grace period | high | mitigate | Deadline imported from constant; forced kill fails scenario (UAT #32) | closed |
| T-14-42 | Tampering | test-only pause hook in production | medium | mitigate | Hook inert without explicit env flag, asserted (UAT #33) | closed |
| T-14-43 | Info Disclosure | internal ports published to host | high | mitigate | Only web declares ports (80/443); compose gate asserts (UAT #7, #35) | closed |
| T-14-44 | Info Disclosure | Postgres traffic on compose network (prod) | high | mitigate | Prod TLS entrypoint ssl=on; DSN TLS enforced by factory (UAT #8) | closed |
| T-14-45 | Info Disclosure | secrets in compose/example env | high | mitigate | External env_file; prod.env.example names-only (UAT #35) | closed |
| T-14-46 | DoS | OOM event killing Postgres | high | mitigate | mem_limit on every service + negative oom_score_adj on db only (UAT #7, #35) | closed |
| T-14-47 | DoS | connection exhaustion during deploy | high | mitigate | max_connections above summed pool maxima, gate-asserted (UAT #35) | closed |
| T-14-48 | Tampering | migrate one-shot re-running during deploy | high | mitigate | Profile-excluded from default up; no completion depends_on (UAT #35) | closed |
| T-14-49 | Tampering | deploying an unreviewed local tree | high | mitigate | Application-image path pull-only on immutable SHA tags, gate-asserted (UAT #7). Evidence narrowed 2026-08-14: plan 14-10 added `build:` sections for the host-built `db`/`pgbackrest` image (no COPY of repository source — infra config only); residual surface tracked as T-14-88 | closed |
| T-14-50 | DoS | stop-grace-period drift (compose) | high | mitigate | Interpolated from publish script; gate fails mismatch (UAT #35) | closed |
| T-14-51 | EoP | prod DB roles diverging from dev set | medium | mitigate | init-prod-roles.sql same grant shape, idempotent, fail-loud \getenv (UAT #34) | closed |
| T-14-75 | Tampering | dropping partition with in-horizon rows | high | mitigate | Range must end strictly before UTC horizon, catalog-read bounds; straddle test (UAT #37) | closed |
| T-14-76 | Tampering | dropping the DEFAULT partition | high | mitigate | DEFAULT excluded explicitly and by test (UAT #37) | closed |
| T-14-77 | Tampering | retention removing compliance evidence | high | mitigate | RETENTION_EXCLUDED_TABLES names 5 groups; refused not skipped (UAT #38) | closed |
| T-14-78 | Tampering | retention enabled before proven restore | high | mitigate | Flag defaults off, unrecognized=off, no committed config enables (UAT #40) | closed |
| T-14-79 | Repudiation | no record of retention removals | medium | mitigate | partition_retention_drops records name/range/horizon per drop (UAT #39) | closed |
| T-14-80 | Tampering | name-parsed eligibility mismatch | high | mitigate | Bounds from pg_get_expr, never names; both mismatch cases tested (UAT #37) | closed |
| T-14-81 | DoS | retention failure blocking partition creation | medium | mitigate | Creation runs first; retention failure logged, not swallowed (UAT #39) | closed |
| T-14-82 | DoS | narrowed horizon mass-dropping | medium | mitigate | Runbook documents next-tick effect + recovery arithmetic (UAT #9) | closed |
| T-14-83 | Info Disclosure | secret values in documentation | high | mitigate | Names/sources/purposes only; gate compares names never values (UAT #41) | closed |
| T-14-84 | Repudiation | as-built doc omitting deployed secret | high | mitigate | check:spec-env-coverage in static job with reported count (UAT #41) | closed |
| T-14-85 | Repudiation | assumed version recorded as shipped | medium | mitigate | Versions from SUMMARYs only; range patterns grep-asserted absent (UAT #41) | closed |
| T-14-86 | Repudiation | PgBouncer absence as oversight | medium | mitigate | §8 records D-09/D-10 deferrals with owner + revisit trigger (UAT #36) | closed |
| T-14-87 | Repudiation | documenting absent capability | high | mitigate | Undetermined facts recorded as «не определено» per repo idiom (UAT #41) | closed |
| T-14-14-01 | Tampering | package-lock.json regeneration | high | mitigate | Additive-only gate: 27 esbuild-family entries, all integrity-hashed, registry.npmjs.org resolved (14-14 SUMMARY, UAT #4) | closed |
| T-14-14-02 | Tampering | npx npm@10 in static CI job | medium | mitigate | Official npm CLI major-10 constrained; job holds no deploy secret; version printed (ci.yml:115-116) | closed |
| T-14-14-03 | EoP | Images workflow on pull_request path | high | mitigate | Job-level `permissions: contents: read`, no login step, `push: false`; push job guarded on event (images.yml verified) (UAT #6) | closed |
| T-14-14-04 | Info Disclosure | fork PR build logs | low | accept | Dependency names/paths only; GitHub withholds secrets from fork PRs — see Accepted Risks Log | closed |
| T-14-14-05 | Tampering | pinned actions in images.yml | medium | mitigate | Reuses existing commit SHAs; zero floating @vN (grep-verified) | closed |
| T-14-SC (×11 plans) | Tampering | npm/pip/cargo installs | high | mitigate | Zero new npm packages across all executed plans (per-plan Package Legitimacy Audits); 14-14's lockfile additions are integrity-hashed materializations of an already-declared optional peer | closed |

### Real-host plans (14-09/14-10/14-11) — deferred register verified 2026-08-14

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-14-52 | Tampering | deploying a mutable reference | high | mitigate | `SHA_REGEX='^[0-9a-f]{40}$'` (deploy.sh:53); branch/`latest` rejected by name (:155-158); test deploy-script.test.mjs:169-173 | closed |
| T-14-53 | Tampering | containers replaced after failed migration | high | mitigate | `set -Eeuo pipefail` + explicit migrate exit-code check (deploy.sh:357-361); PATH-stub test asserts no api/worker/web start after migrate failure (test:268-289) | closed |
| T-14-54 | DoS | deploy gated on timer instead of readiness | high | mitigate | Bounded `/readyz` poll with non-zero exit on timeout (deploy.sh:209-236, 367-378); test asserts no sleep-as-wait (test:238) | closed |
| T-14-55 | Tampering | old and new worker running concurrently | high | mitigate | stop → `wait_for_worker_gone` fail-closed → `up -d worker` (deploy.sh:382-390); ordering test :240-244 | closed |
| T-14-56 | Repudiation | no record of pre-deploy version | medium | mitigate | Prev-SHA written before any replacement (deploy.sh:335); rollback command printed on all failure and success paths | closed |
| T-14-57 | DoS | partially pulled deploy mid-flight | medium | mitigate | All three images pulled before any replacement (deploy.sh:349); pull failure aborts pre-migrate (test:388-398) | closed |
| T-14-58 | EoP | host-built image bypassing review | medium | mitigate | Partially present: deploy.sh never builds and app images stay pull-only under the immutable-tag gate, but 14-10 added `build:` sections for `db`/`pgbackrest` (mutable `POSTGRES_IMAGE_TAG`, excluded from FIRST_PARTY_IMAGE_SERVICES) — documented forward flag (backups.md:270-280); tracked with T-14-88 | open (below block threshold) |
| T-14-59 | Info Disclosure | secret values in deploy output | medium | mitigate | No `set -x`/env dumps; `check_required_env` prints env-file path only (deploy.sh:312-314); dry run leaves `$PREV_SHA` unexpanded | closed |
| T-14-60 | Info Disclosure | backup contents in object storage | high | mitigate | `repo1-cipher-type=aes-256-cbc` (pgbackrest.conf:31); operator attested repo reported encrypted + unauthenticated fetch denied (14-10 SUMMARY Task 3) | closed |
| T-14-61 | Info Disclosure | credentials/passphrase in repo or image | high | mitigate | Zero literal credentials in pgbackrest.conf (all via `PGBACKREST_*`); `checkPgbackrestConfigHasNoCredential` gate (validate-prod-compose.mjs:588-606) + fixtures; prod.env.example names-only | closed |
| T-14-62 | DoS | WAL not actually archived | high | mitigate | pgBackRest in db image (postgres/Dockerfile:45-49); `archive_mode=on` + `archive_command` (prod-tls-entrypoint.sh:94-95); shared-volume invariant; operator attested real WAL in R2 after forced switch | closed |
| T-14-63 | Repudiation | silently failing scheduled backup | high | mitigate | `run_job` logs stanza+type and propagates non-zero exit (backup-entrypoint.sh:48-66); daily `check` in crontab:71; manual-check + failure procedure in backups.md; Phase 15 alerting deferral named | closed |
| T-14-64 | DoS | lost cipher passphrase | high | mitigate | Escrow required in prod.env.example:138-147 + backups.md + SPECIFICATION.md:429; operator attested escrow performed (location deliberately not recorded in project artifacts — see 14-10 SUMMARY) | closed |
| T-14-65 | DoS | backup process starving Postgres | medium | mitigate | `mem_limit` on sidecar (default 256m); only `db` carries negative `oom_score_adj` (compose:119), gate-asserted with `pgbackrest` in EXPECTED_SERVICES | closed |
| T-14-66 | Tampering | object-store-side backup deletion | medium | accept | AR-14-05 — versioning/immutability ask + bucket-scoped access key documented (backups.md:263-268) | closed (accepted) |
| T-14-67 | Info Disclosure | over-broad object-store credential | medium | mitigate | Bucket-scoped access key required (prod.env.example:134-136, backups.md:265-267, SPECIFICATION.md:427) | closed |
| T-14-68 | Tampering | drill restoring over production | high | mitigate | Production names parsed live from compose (restore-drill.sh:113-149), fail-closed on empty parse (:156-159), scratch names asserted distinct (:188-195) before first write; tests + operator attestation production untouched | closed |
| T-14-69 | Info Disclosure | decrypted database copy left on host | high | mitigate | Destroy on success (restore-drill.sh:389-391); preserve-with-printed-cleanup on failure (documented asymmetry, restore-drill.md:200-209); operator attested destruction | closed |
| T-14-70 | Repudiation | verification passing without checking | high | mitigate | `verifyRestoredDatabase` returns ok:false on connect/query failure, CLI exit 1 (verify-restored-database.ts:341-356, :465); four CI-run cases incl. cannot-connect | closed |
| T-14-71 | Tampering | restored cluster RLS enabled-not-forced | high | mitigate | Reads both `relrowsecurity` and `relforcerowsecurity`, names offenders (:243-266); single documented exemption mirrors Phase-13 accepted risk; enabled-but-not-forced test | closed |
| T-14-72 | Repudiation | claiming PITR while unpacking latest | high | mitigate | Explicit PITR target mandatory, format-enforced, no `latest` default (restore-drill.sh:101-106, :180-183); operator attested marker absent-before/present-after | closed |
| T-14-73 | DoS | drill exhausting host disk | medium | mitigate | Free-disk prerequisite (`df -h`) + teardown reclaim present; observed figure still runbook placeholder — capture at next scheduled drill (tracked in 14-11 SUMMARY and STATE.md) | open (below block threshold) |
| T-14-74 | DoS | drill competing with production | medium | accept | AR-14-06 — D-07 deliberately places the drill on the production VPS; no contention mitigation is present in code or runbook. Accepted for the baseline drill | closed (accepted) |
| T-14-SC (14-09/10/11) | Tampering | npm/pip/cargo installs | high | mitigate | Zero npm package/lockfile changes across all six task commits; pgBackRest 2.59.0 installed from base image's own Debian/PostgreSQL apt repos, no third-party source, no curl\|sh | closed |
| T-14-88 | Tampering | host-built `db`/`pgbackrest` image (mutable `POSTGRES_IMAGE_TAG`, outside immutability gate) | medium | mitigate | Registered 2026-08-14 (successor to T-14-49's narrowed evidence). No COPY of repository source (infra config only) keeps this below high. Recommended: extend FIRST_PARTY_IMAGE_SERVICES or add a distinct `POSTGRES_IMAGE_TAG` immutability check | open (below block threshold) |

*Status: open · closed — only open threats at or above workflow.security_block_on (high) count toward threats_open; the three open rows above are medium and non-blocking*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-14-01 | T-14-04 | Unauthenticated /healthz + /readyz accepted by design (D-13/D-14): infrastructure probes, no tenant data, GET-only, side-effect free; latch set only by successful check | plan 14-01 threat model (plan-time decision) | 2026-08-13 |
| AR-14-02 | T-14-12 | sslmode=require encrypts but does not authenticate the server; verify-full + CA management deferred until Postgres has a real network path. Revisit trigger recorded with D-10 in SPECIFICATION.md §8 | plan 14-03 threat model (D-10) | 2026-08-13 |
| AR-14-03 | T-14-18 | Unauthenticated worker health endpoints accepted by design (D-14); materially narrower than API's — loopback-bound, unroutable from outside the container, side-effect free | plan 14-04 threat model (D-14) | 2026-08-13 |
| AR-14-04 | T-14-14-04 | Fork-PR build logs expose dependency names and repo paths only; GitHub withholds secrets from fork pull_request runs and the PR job mounts none | plan 14-14 threat model | 2026-08-13 |
| AR-14-05 | T-14-66 | Object-store-side deletion/tampering of backups: mitigated to the extent the platform controls — bucket versioning/immutability requested of the operator and the access key is bucket-scoped (backups.md:263-268); provider-side controls are outside the codebase | plan 14-10 threat model (plan-time accept disposition) | 2026-08-14 |
| AR-14-06 | T-14-74 | Drill contention with production: D-07 deliberately places the baseline drill on the production VPS; no contention mitigation is present in code or runbook (plan-cited low-traffic-window note and scratch-container limits do not exist — recorded accurately per 2026-08-14 audit). Accepted for the baseline drill; fresh-VPS rehearsal is the recorded stretch variant | plan 14-11 threat model (plan-time accept disposition; rationale corrected at audit) | 2026-08-14 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-13 | 96 (73 implemented-surface, 23 deferred to plans 14-09/10/11) | 73 (69 mitigated + 4 accepted) | 0 (23 deferred, non-blocking — no implementation exists) | secure-phase orchestrator (L1 short-circuit: register authored at plan time, threats_open 0, ASVS 1) |
| 2026-08-14 | 97 (73 previously closed; 23 deferred entries audited itemized as 24 rows incl. per-plan T-14-SC; +1 new T-14-88) | 94 (22 newly verified-mitigated + 2 newly accepted AR-14-05/06 + 70 prior) | 3 medium, all below `high` block threshold (T-14-58, T-14-73, T-14-88) — threats_open: 0 | gsd-security-auditor (deferred-register verification incl. post-audit commits 20edff7, 8d31abe — both preserve/strengthen mitigations) |

**Evidence base:** per-plan SUMMARY self-checks (all PASSED), phase code review (14-REVIEW.md + 14-REVIEW-FIX.md), UAT 42/42 passed (2026-08-13) including 33 automated coverage verifications mapping directly to register mitigations, plus direct grep/file verification of: migrate-runner advisory lock, pool factory TLS assertion + scrubbedConsole routing, `lint:pg-pool-factory` and `check:lockfile-npm10` steps in the required `static` CI job, worker health loopback literal, Dockerfile USER/FROM/exec-CMD, .dockerignore env-file excludes, images.yml SHA pins (7/7, zero @vN) and PR-job permission narrowing, prod compose zero `:latest`, retention flag not enabled in any committed config.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed (full register: three medium open items remain, all below the `high` block threshold, each tracked with a follow-up)
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-14 — deferred register for plans 14-09/14-10/14-11 audited post-execution; the 2026-08-13 conditional re-run instruction is fulfilled. Open medium follow-ups: T-14-58/T-14-88 (host-built db/pgbackrest image immutability — candidate for a future hardening pass), T-14-73 (record drill duration + disk high-water at the next scheduled restore drill).
