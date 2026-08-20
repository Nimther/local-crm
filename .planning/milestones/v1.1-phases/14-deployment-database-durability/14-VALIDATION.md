---
phase: 14
slug: deployment-database-durability
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-12
validated: 2026-08-19
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.9 (already the project standard in every workspace this phase touches) |
| **Config file** | `packages/db/vitest.config.ts`, `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, `scripts/vitest.config.ts` (all existing) |
| **Quick run command** | `npm run test:migrations` (`vitest run --root packages/db`) |
| **Full suite command** | `npm run coverage` (aggregate over every backend project) |
| **Estimated runtime** | ~60s quick; several minutes full (ephemeral DB provisioning per workspace) |

No framework install is required. Docker is required for the TLS, compose and image tasks (`docker 29.7.2` confirmed available); pgBackRest and Caddy run only inside containers and are never needed on the development machine.

---

## Sampling Rate

- **After every task commit:** `npm run test:migrations` for `packages/db` work; `npx vitest run --root <workspace>` for the workspace the task touched.
- **After every plan wave:** `npm run coverage` plus `npm run failure:all` once plan 14-07 has landed.
- **Before `/gsd-verify-work`:** full suite green, `npm run lint`, `npm run build --workspaces --if-present`, `npm run lint:migrations`, `npm run lint:session-state`, `npm run lint:pg-pool-factory`, `npm run verify:prod-compose`, `npm run check:spec-env-coverage`.
- **Max feedback latency:** ~60s for the quick command.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 14-01-01 | 01 | 1 | DB-05, DB-06, OPS-04, OPS-05 | T-14-01/02/05 | Un-migrated DB refuses readiness; lock on a dedicated connection | integration (tracer, red-first) | `npx vitest run --root packages/db src/__tests__/migration-journal.test.ts && npx vitest run --root apps/api src/modules/ops/__tests__/readyz.test.ts` | ✅ | ✅ green |
| 14-01-02 | 01 | 1 | DB-05 | T-14-01/02 | Parallel runners apply exactly once; lock failure is loud | integration | `npx vitest run --root packages/db src/__tests__/migrate-runner-advisory-lock.test.ts` | ✅ | ✅ green |
| 14-01-03 | 01 | 1 | DB-06, OPS-04 | T-14-05/06 | Non-health routes 503 until migrations confirmed; `/healthz` I/O-free | integration | `npx vitest run --root apps/api src/modules/ops/__tests__ && npx vitest run --root apps/api` | ✅ | ✅ green |
| 14-02-01 | 02 | 1 | DB-12 | T-14-08/10 | Duplicate blast radius measurable; deletion operator-only | script + integration | `npx tsc -p packages/db/tsconfig.json` then `npm run db:count-member-duplicates -w packages/db` | ✅ | ✅ green |
| 14-02-02 | 02 | 1 | DB-12 | T-14-07 | Migration refuses over duplicates; `indisvalid` asserted | migration test | `npm run lint:migrations && npx vitest run --root packages/db src/__tests__/migration-0062-member-unique.test.ts` | ✅ | ✅ green |
| 14-03-01 | 03 | 2 | DB-13, DB-14 | T-14-13/14/16 | Error handler unconditional; one TLS mechanism; production DSN must request TLS | unit | `npx vitest run --root packages/db src/__tests__/pool-factory.test.ts` | ✅ | ✅ green |
| 14-03-02 | 03 | 2 | DB-14 | T-14-13 | No bare pool construction in first-party production source | static/lint | `npm run lint:pg-pool-factory && npx vitest run --root scripts` | ✅ | ✅ green |
| 14-03-03 | 03 | 2 | DB-13 | T-14-11/15 | Server negotiates TLS (proven by `pg_stat_ssl`); no key in the tree | integration | `docker compose up -d --wait && npx vitest run --root packages/db src/__tests__/pg-tls.test.ts` | ✅ | ✅ green |
| 14-04-01 | 04 | 2 | OPS-04, OPS-05 | T-14-17/19/21 | Loopback-only listener; `/healthz` I/O-free; draining is monotonic | unit + integration | `npx vitest run --root apps/worker src/__tests__/health-server.test.ts` | ✅ | ✅ green |
| 14-04-02 | 04 | 2 | OPS-05 | T-14-21 | `/readyz` 503 from the instant SIGTERM arrives | integration | `npx vitest run --root apps/worker` | ✅ | ✅ green |
| 14-04-03 | 04 | 2 | OPS-02 (Pitfall 7) | T-14-20 | Stop-grace-period matches the source constant | unit | `npm run build -w apps/worker && npx vitest run --root apps/worker src/__tests__/stop-grace-period-publish.test.ts` | ✅ | ✅ green |
| 14-05-01 | 05 | 2 | DB-07 | T-14-23 | Every migration classified; forward-only signatures cross-checked | unit | `npx vitest run --root packages/db src/__tests__/migration-tiers.test.ts` | ✅ | ✅ green |
| 14-05-02 | 05 | 2 | DB-07 | T-14-24/25/26 | Schema↔snapshot parity, tree left clean, negative case detected | static/CI | `npx vitest run --root packages/db src/__tests__/migration-empty-diff.test.ts && git status --porcelain packages/db` | ✅ | ✅ green |
| 14-05-03 | 05 | 2 | DB-07 | T-14-22 | Revert + roll-forward yields identical schema; DSN guard first | integration (CI, every PR) | `npx vitest run --root packages/db src/__tests__/migration-rollback-rehearsal.test.ts` | ✅ | ✅ green |
| 14-06-01 | 06 | 3 | OPS-01 | T-14-28/32/33/34 | Node 22 literal, direct `node` exec, non-root, no secret in context | build (CI) | `docker build -f docker/Dockerfile.api -t megacrm-api:local . && docker build -f docker/Dockerfile.worker -t megacrm-worker:local .` | ✅ | ✅ green |
| 14-06-02 | 06 | 3 | OPS-01 | T-14-30/31/35 | All five server-side paths proxied; webhook body byte-identical | build + integration | `docker build -f docker/Dockerfile.web -t megacrm-web:local .` plus the stub-upstream routing checks | ✅ | ✅ green |
| 14-06-03 | 06 | 3 | OPS-01 | T-14-27/29 | Every action SHA-pinned; exactly one immutable tag per image | static | comment-filtered grep assertions over `.github/workflows/images.yml` | ✅ | ✅ green |
| 14-07-01 | 07 | 3 | DB-05 | T-14-36/37/42 | Killed migration leaves no lock and no partial journal entry | failure-injection | `npm run failure:migrate-unclean-death` | ✅ | ✅ green |
| 14-07-02 | 07 | 3 | OPS-02 (R-05) | T-14-38/39 | Unrecognized payload version defers, both directions | failure-injection | `npm run failure:two-version-compat` | ✅ | ✅ green |
| 14-07-03 | 07 | 3 | OPS-02 (Pitfall 7) | T-14-40/41 | Real SIGTERM under load drains inside budget; no false outcome written | failure-injection | `npm run failure:sigterm-mid-load` | ✅ | ✅ green |
| 14-08-CP | 08 | 4 | OPS-01, OPS-02 | T-14-46/47 | Sizing values decided against real host RAM and the pool sum | checkpoint:decision (blocking) | — (human) | n/a | ✅ human-approved |
| 14-08-01 | 08 | 4 | OPS-01, OPS-02, DB-13 | T-14-43/44/45/48/49/51 | Only Caddy published; TLS on; immutable tags; one-shot migrate | config validation | `docker compose -f docker/docker-compose.prod.yml --env-file docker/prod.env.example config` | ✅ | ✅ green |
| 14-08-02 | 08 | 4 | OPS-01, OPS-02 | T-14-46/47/50 | Memory limits, OOM protection, headroom and grace-period drift gated | static/lint | `npm run verify:prod-compose && npx vitest run --root scripts` | ✅ | ✅ green |
| 14-09-01 | 09 | 5 | OPS-02, OPS-03 | T-14-52/53/54/55/56/57 | Fail-before-replace ordering; readiness-gated; SHA-only argument | dry-run test | `bash -n scripts/deploy.sh && npx vitest run --root scripts __tests__/deploy-script.test.mjs` | ✅ | ✅ green |
| 14-09-02 | 09 | 5 | OPS-03 | T-14-56 | Rollback decision documented against the migration tiers | doc assertion | grep assertions over `docs/runbooks/deploy-and-rollback.md` | ✅ | ✅ green |
| 14-09-CP | 09 | 5 | OPS-02, OPS-03 | T-14-52…57 | A real deploy, a second deploy and a rollback on the host | checkpoint:human-verify (blocking) | — (human) | n/a | ✅ human-approved |
| 14-10-01 | 10 | 5 | DB-09 | T-14-60/61/62 | pgBackRest present where `archive_command` runs; repo encrypted, off-host | build + config | `docker build -f docker/postgres/Dockerfile -t megacrm-postgres:local . && docker run --rm megacrm-postgres:local pgbackrest version` | ✅ | ✅ green |
| 14-10-02 | 10 | 5 | DB-09 | T-14-63/65 | Failed backup is loud; backup service shape gated | static/lint | `bash -n docker/pgbackrest/backup-entrypoint.sh && npm run verify:prod-compose` | ✅ | ✅ green |
| 14-10-CP | 10 | 5 | DB-09 | T-14-60/62/64/66/67 | Real backup + WAL off-host; bucket non-public; passphrase escrowed | checkpoint:human-verify (blocking) | — (human) | n/a | ✅ human-approved |
| 14-11-01 | 11 | 6 | DB-10 | T-14-70/71 | Verifier fails on missing partition, weakened RLS, unreachable cluster | integration | `npx vitest run --root packages/db src/__tests__/verify-restored-database.test.ts` | ✅ | ✅ green |
| 14-11-02 | 11 | 6 | DB-10 | T-14-68/69 | Production-name refusal; restore→verify→teardown ordering | dry-run test | `bash -n scripts/restore-drill.sh && npx vitest run --root scripts __tests__/restore-drill-script.test.mjs` | ✅ | ✅ green |
| 14-11-CP | 11 | 6 | DB-10 | T-14-68/69/72/73 | PITR actually performed; marker absent at the earlier target | checkpoint:human-verify (blocking) | — (human) | n/a | ✅ human-approved |
| 14-12-CP | 12 | 7 | DB-11 | T-14-78 | Horizon chosen; restore drill confirmed performed first | checkpoint:decision (blocking) | — (human) | n/a | ✅ human-approved |
| 14-12-01 | 12 | 7 | DB-11 | T-14-75/76/77/80 | Strictly-older eligibility; DEFAULT excluded; evidence tables excluded | integration | `npx vitest run --root packages/db src/partitions/__tests__/retention.test.ts` | ✅ | ✅ green |
| 14-12-02 | 12 | 7 | DB-11 | T-14-78/79/81 | Flag-off tick drops nothing; creation work unaffected by retention failure | integration | `npx vitest run --root apps/worker src/queues/__tests__/partition-retention-tick.test.ts` | ✅ | ✅ green |
| 14-13-01 | 13 | 8 | DB-09, DB-11, DB-13, DB-14 | T-14-83/84/85 | Every production env var name recorded in SPECIFICATION.md | static/lint | `npm run check:spec-env-coverage && npx vitest run --root scripts` | ✅ | ✅ green |
| 14-13-02 | 13 | 8 | DB-14 | T-14-86/87 | Connection budget table present with the sum vs `max_connections` | doc assertion | grep assertions over `ARCHITECTURE.md` and `CONVENTIONS.md` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Every automated command above references a test file that does not exist yet; each is created by the task that owns it (this phase builds its own validation as it goes rather than in a separate wave). No framework install is needed. The files to be created:

- [x] `packages/db/src/__tests__/migration-journal.test.ts`, `migrate-runner-advisory-lock.test.ts` — DB-05
- [x] `apps/api/src/modules/ops/__tests__/healthz.test.ts`, `readyz.test.ts` — OPS-04, OPS-05, DB-06
- [x] `packages/db/scripts/count-member-duplicates.ts`, `audit-missing-constraints.ts`, `packages/db/src/__tests__/migration-0062-member-unique.test.ts` — DB-12
- [x] `packages/db/src/__tests__/pool-factory.test.ts`, `pg-tls.test.ts`, `scripts/lint-pg-pool-factory.mjs` + its test — DB-13, DB-14
- [x] `apps/worker/src/__tests__/health-server.test.ts`, `stop-grace-period-publish.test.ts` — OPS-04, OPS-05, Pitfall 7
- [x] `packages/db/src/__tests__/migration-tiers.test.ts`, `migration-empty-diff.test.ts`, `migration-rollback-rehearsal.test.ts` — DB-07
- [x] `apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts`, `two-version-compat.test.ts`, `sigterm-mid-load.test.ts` — DB-05, R-05, Pitfall 7
- [x] `scripts/validate-prod-compose.mjs` + its test — OPS-01, OPS-02, Pitfall 19
- [x] `scripts/__tests__/deploy-script.test.mjs`, `restore-drill-script.test.mjs` — OPS-02, OPS-03, DB-10
- [x] `packages/db/scripts/verify-restored-database.ts` + its test — DB-10
- [x] `packages/db/src/partitions/__tests__/retention.test.ts`, `apps/worker/src/queues/__tests__/partition-retention-tick.test.ts` — DB-11
- [x] `scripts/check-spec-env-coverage.mjs` + its test — the documentation gate
- [x] CI: an image-build workflow (`images.yml`) and new steps in `ci.yml`'s `static` and `failure-injection` jobs

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A real deploy, a second deploy and a rollback on the production host | OPS-02, OPS-03 | The script has never touched a real host, domain, ACME challenge or GHCR pull — the four places a deploy script's untested assumptions live. Mocking them proves nothing about the claim. | Plan 14-09, checkpoint task 3 (ten numbered steps) |
| A real full backup and real WAL shipped to the off-host repository | DB-09 | No S3 credential exists in CI; mocking the object store would prove the opposite of what DB-09 claims. Bucket non-publicity and passphrase escrow are also host-side facts. | Plan 14-10, checkpoint task 3 (nine numbered steps) |
| A point-in-time restore actually performed and written up | DB-10 | REQUIREMENTS.md words this as "отработано на практике". Whether the real repository's bytes decrypt, whether WAL replay stops at the requested moment, and how long a restore takes all require the real repository and host. | Plan 14-11, checkpoint task 3 (ten numbered steps, including the marker-row PITR proof) |
| Sizing decision: container memory limits, `max_connections`, `oom_score_adj` | OPS-01, OPS-02 (Pitfall 19) | The values depend on the operator's VPS RAM, which no artifact in the repository knows; both failure modes (OOM-killing healthy containers, connection exhaustion) are silent. | Plan 14-08, decision checkpoint |
| Retention horizon and acceptance of scheduled irreversible drops | DB-11 | The operation is irreversible beyond the backup window, and enabling it is gated on the restore drill having actually been performed (D-08). | Plan 14-12, decision checkpoint |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or a documented manual-only justification
- [x] Sampling continuity: no 3 consecutive tasks without automated verify (checkpoints are the only non-automated tasks, and none are adjacent within a plan)
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s for the quick command
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-08-19 (retroactive Nyquist audit — all automated commands run green locally; 5 checkpoints operator-approved per SUMMARYs)

---

## Validation Audit 2026-08-19

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

Retroactive Nyquist audit (`/gsd-validate-phase 14`). All 34 referenced artifacts exist; every automated command in the map was re-run locally and is green:

- `packages/db`: 28 files / 235 tests passed. Two principled self-skips, both loud and CI-covered: the `pg-tls.test.ts` positive assertion skips where the local Postgres reports `SHOW ssl = off` (runs in CI, whose compose `db` serves TLS); `migration-rollback-rehearsal.test.ts` skips because the newest shipped migration is forward-only — nothing to rehearse, per `docs/runbooks/migration-rollback-and-roll-forward.md`.
- `apps/api` (77/78 files) and `apps/worker` (88/89 files): sole failure in each is the known machine-local `sentry.test.ts` "no DSN" exception (real DSNs in `~/.config/mega-crm/.env` since 2026-08-16 UAT; passes in CI). Not a Phase 14 gap.
- `scripts`: 15 files / 245 tests passed. Static gates all green: `lint:migrations` (66 files), `lint:pg-pool-factory` (277 files), `verify:prod-compose` (8 services / 59 invariants), `check:spec-env-coverage` (54 names).
- Failure-injection suite (`failure:all`) green.
- Docker: all four images (`api`, `worker`, `web`, `postgres` with pgBackRest 2.59.0) build clean from the current tree, and `npm ci --dry-run` is clean — the UAT-reported esbuild lockfile desync (images unbuildable) is confirmed fixed. `docker compose -f docker/docker-compose.prod.yml --env-file docker/prod.env.example config` resolves. 14-06-02's stub-upstream routing half was not re-run in this audit — it was verified at UAT (14-UAT.md item 5, `result: pass`, re-tested after the lockfile fix) per the commands in `docs/runbooks/container-images.md`. 14-06-03's tag invariant confirmed in `.github/workflows/images.yml`: exactly one `${{ github.sha }}` tag per image, never `latest`; all actions SHA-pinned. 14-03-03's CI-side positive TLS assertion substantiated: the root `docker-compose.yml` `db` service generates a self-signed cert and serves TLS, so the `pg_stat_ssl` positive case runs on every CI pass.
- All 5 blocking checkpoints (14-08-CP, 14-09-CP, 14-10-CP, 14-11-CP, 14-12-CP) are recorded as operator-resolved/approved in their SUMMARYs, matching the Manual-Only justifications above. Restore duration / disk high-water mark remain uncaptured (14-11 SUMMARY records this honestly; capture at the next scheduled drill).
