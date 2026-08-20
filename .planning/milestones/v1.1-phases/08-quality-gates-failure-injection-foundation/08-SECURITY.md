---
phase: 8
slug: quality-gates-failure-injection-foundation
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-06
---

# Phase 8 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

**Implementation note:** Phase 8 was executed on the `phase-08-quality-gates` branch (74 commits, three code-review fix rounds). All mitigation evidence below was verified against that branch via `git show`/`git grep`; live GitHub state (branch protection) was verified via the API.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| GitHub Actions runner → third-party action code | Floating action tags can be re-pointed at attacker code with access to the job env and checkout | CI env, repo contents |
| Test/CI process → developer's dev Postgres | A misresolved DSN lets a test run write to (or drop) real dev data | Dev database rows |
| Provisioning script (admin role) → any database on the host | Only component holding CREATE/DROP DATABASE privilege | DDL against arbitrary databases |
| Test process (app role) → tenant data under RLS | Superuser DSN in tests would silently disable every RLS assertion | Tenant-scoped rows |
| Failure scenarios / harness → the real SendGrid API | Reaching the hardcoded endpoint would send real mail on a tenant's reputation | Tenant mail, API key use |
| Developer diff → gate strength (lint floor, coverage ratchet, disable directives) | Gates that can be quietly weakened in the same commit that breaks them protect nothing | Gate thresholds, ignore globs |
| Redis container lifecycle → enqueued job state | Eviction or restart without AOF silently loses queued work | BullMQ job payloads |
| Migration author → production schema and data | Untested chains and unmarked destructive DDL fail or destroy at deploy time | Production DDL/rows |
| Repository working root → anything reading the checkout | A real secrets file in the root is readable by every tool and agent | Platform secrets |
| Pull request → `master` | The only place the phase's gates become unavoidable; admin bypass makes them decorative | Merge decisions |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-08-01-01 | Tampering | CI third-party action refs | high | mitigate | All 8 `uses:` in `.github/workflows/ci.yml` pinned to 40-char SHAs (`actions/checkout@fbc6f399…`, `actions/setup-node@49933ea5…`); only `actions/*` used | closed |
| T-08-01-02 | Tampering | Test run resolving to dev DB | high | mitigate | `assertTestDatabaseUrl` called in `packages/test-support/src/global-setup.ts:34` before collection | closed |
| T-08-01-03 | Elevation of Privilege | Guard bypass surface | high | mitigate | `guard.ts` contains zero `process.env` reads and no opt-out parameter | closed |
| T-08-01-04 | Information Disclosure | CI env exposing DB credentials | low | accept | See Accepted Risks AR-1 | closed |
| T-08-01-SC | Tampering | npm install (`execa`) | high | mitigate | `execa@10.0.0` exact-pinned; approved in 08-RESEARCH.md Package Legitimacy Audit | closed |
| T-08-02-01 | Tampering | `dropEphemeralDatabase` | critical | mitigate | `assertDroppableName` is the function's first statement (`provision-db.ts:124`, comment-marked); `SAFE_IDENTIFIER = /^[a-z0-9_]+$/` | closed |
| T-08-02-02 | Elevation of Privilege | DSN returned to tests | high | mitigate | `CREATE DATABASE … OWNER mega_crm_app` (`provision-db.ts:156`); returned DSN uses app role, admin DSN never leaves module | closed |
| T-08-02-03 | Tampering | SQL identifier interpolation in DDL | high | mitigate | Local `quoteIdentifier` (`provision-db.ts:41`) plus allow-list rejecting quotes | closed |
| T-08-02-04 | Denial of Service | Leaked ephemeral databases | low | mitigate | `DROP DATABASE IF EXISTS` before create (`provision-db.ts:134`); globalSetup returns teardown | closed |
| T-08-02-SC | Tampering | npm installs | high | mitigate | No new package (`pg` pre-declared in 08-01) | closed |
| T-08-03-01 | Tampering | ESLint `ignores` globs | high | mitigate | `lint-file-floor.json` + `scripts/check-lint-file-floor.mjs` compare checked-file count against recorded floor | closed |
| T-08-03-02 | Tampering | File-level blanket eslint-disable | medium | mitigate | `lint-gate.test.ts:91` scans `git ls-files` output for `/* eslint-disable */` and asserts zero | closed |
| T-08-03-03 | Tampering | Auto-fix erasing `.only` markers | medium | mitigate | `"vitest/no-focused-tests": ["error", { fixable: false }]` (`eslint.config.js:121`, comment cites D-07) | closed |
| T-08-03-04 | Information Disclosure | Type-aware linting reading sources | low | accept | See Accepted Risks AR-2 | closed |
| T-08-03-SC | Tampering | npm installs (6 ESLint packages) | high | mitigate | All from official scopes, approved in 08-RESEARCH.md; verified in branch package.json diff | closed |
| T-08-04-01 | Denial of Service | Redis eviction of job state | high | mitigate | `docker/redis.conf`: `maxmemory 512mb` + `maxmemory-policy noeviction`; explicit `command:` override in compose; asserted by `redis-config.test.ts` | closed |
| T-08-04-02 | Repudiation | Vacuous WRK-12 check | high | mitigate | All four values asserted together; "unverifiable server is a failure, never a skip" describe block (`redis-config.test.ts:103`) | closed |
| T-08-04-03 | Denial of Service | Job loss across container restart | medium | mitigate | `appendonly yes` + `appendfsync everysec` in `docker/redis.conf`; restart survival asserted by 08-13 scenario | closed |
| T-08-04-04 | Elevation of Privilege | Dev Redis without `requirepass` | medium | accept | See Accepted Risks AR-3 | closed |
| T-08-04-05 | Tampering | Container rewriting its own config | low | mitigate | Bind mount is read-only: `./docker/redis.conf:…:ro` (`docker-compose.yml:32`) | closed |
| T-08-04-SC | Tampering | npm installs | high | mitigate | No package installed (`ioredis` pre-declared) | closed |
| T-08-05-01 | Denial of Service | Enum add+use in one migration file | high | mitigate | `checkEnumAddValueSameFile` (`lint-migrations.mjs:48`); fixture `tools/migration-fixtures/bad-enum-same-file.sql` | closed |
| T-08-05-02 | Tampering | Unmarked destructive DDL | high | mitigate | `checkDestructiveDdl` (`lint-migrations.mjs:164`); multiline detection hardened by review fix WR-02 (f3e9fe8) | closed |
| T-08-05-03 | Tampering | Blanket file-header suppression | medium | mitigate | `DESTRUCTIVE_MARKER` requires reason (`/^--\s*destructive:\s*\S/`) on the immediately preceding line only | closed |
| T-08-05-04 | Input Validation | Linter parsing arbitrary SQL | low | accept | See Accepted Risks AR-4 | closed |
| T-08-05-SC | Tampering | npm installs | high | mitigate | Linter uses only `node:` builtins | closed |
| T-08-06-01 | Tampering | `?? DATABASE_URL` fallback in fixtures | high | mitigate | `git grep` on branch finds zero `??`/`\|\|` fallbacks to `process.env.DATABASE_URL` in test scaffolding | closed |
| T-08-06-02 | Tampering | Direct invocation bypassing globalSetup | high | mitigate | Consolidated fixture calls `assertTestDatabaseUrl` itself (`db-fixture.ts:69`) — D-14 layer b | closed |
| T-08-06-03 | Tampering | Cross-workspace ephemeral-DB interference | medium | mitigate | Per-workspace naming; collision hardened by review fix WR-06 (content-hash tail, ff99119); `db-fixture-isolation.test.ts` | closed |
| T-08-06-04 | Elevation of Privilege | Test scaffolding reachable from prod code | medium | mitigate | `@mega-crm/test-support` appears only in `devDependencies` of consumers; no `packages/*` → `apps/*` dependency | closed |
| T-08-06-05 | Denial of Service | Migration race on shared physical DB | medium | mitigate | Advisory-lock key `8_472_991` (same value) + `_test_migrations_applied` preserved (`db-fixture.ts:42,90`); unlock-failure client leak fixed in review (cd20312) | closed |
| T-08-06-SC | Tampering | npm installs | high | mitigate | Only internal workspace links added | closed |
| T-08-07-01 | Tampering | Reaching lint-zero by shrinking checked set | high | mitigate | `check-lint-file-floor.mjs` re-run; floor recorded in `lint-file-floor.json`; enforced in CI `static` job | closed |
| T-08-07-02 | Tampering | Disabling type-aware async rules | high | mitigate | `docs/lint-rule-exceptions.md` contains none of the four async rule names (grep-verified) | closed |
| T-08-07-03 | Tampering | Unnamed/unjustified suppressions | medium | mitigate | `lint-gate.test.ts` scans all tracked files for nameless file-level directives | closed |
| T-08-07-04 | Denial of Service | Behavior regression from added awaits | high | mitigate | Full workspace suite run after cleanup (08-07 summary); suite is CI-blocking via `test` job | closed |
| T-08-07-05 | Repudiation | Focused marker hiding a spec file | medium | mitigate | Focused markers are errors in vitest and Playwright config blocks | closed |
| T-08-07-SC | Tampering | npm installs | high | mitigate | No package installed | closed |
| T-08-08-01 | Tampering | Scenario reaching live SendGrid | high | mitigate | Scenarios inject `sendMail` via `ProcessSendJobDeps`; zero `api.sendgrid.com` refs in any failure-injection/harness file (grep-verified) | closed |
| T-08-08-02 | Repudiation | Asserting logs instead of state | medium | mitigate | Scenarios assert `sends` row status/count and `SendJobResult` (see `docs/failure-injection-scenarios.md` evidence column) | closed |
| T-08-08-03 | Tampering | Second injection seam in send-dispatch | medium | mitigate | Scenarios use the pre-existing Phase-4 `ProcessSendJobDeps.sendMail` seam only | closed |
| T-08-08-04 | Information Disclosure | Fixture key material in ephemeral DB | low | accept | See Accepted Risks AR-5 | closed |
| T-08-08-SC | Tampering | npm installs | high | mitigate | No package installed | closed |
| T-08-09-01 | Denial of Service | Untested migration chain | high | mitigate | `packages/db/src/__tests__/migrate-from-empty.test.ts` applies full chain to empty DB, asserts schema + RLS posture | closed |
| T-08-09-02 | Tampering | Unsafe DDL against populated tables | high | mitigate | `migrate-incremental.test.ts` seeds rows then applies remainder; NOT-NULL-without-DEFAULT fixture asserted to reject | closed |
| T-08-09-03 | Repudiation | Vacuously green incremental run | high | mitigate | `applyRemainingMigrations` returns applied list; length ≥ 1 asserted; seeds inserted in tenant scope | closed |
| T-08-09-04 | Tampering | Out-of-order migration from non-padded name | medium | mitigate | `listMigrationFiles` throws on unpadded prefix (`migration-runner.ts:56`); numeric sort fixed in review WR-05 (5ca8cbc) | closed |
| T-08-09-05 | Tampering | Provisioning dropping a non-test DB | critical | mitigate | Both runs use 08-02's `createEphemeralDatabase`/`dropEphemeralDatabase` with in-function name validation | closed |
| T-08-09-SC | Tampering | npm installs | high | mitigate | Only `vitest@4.1.9` (already in repo at that version) + internal link | closed |
| T-08-10-01 | Tampering | E2E specs writing to dev DB | high | mitigate | `apps/web/e2e/provision-database.ts` provisions ephemeral DB and calls `assertTestDatabaseUrl` (line 82); runs at config load (c2483ed) | closed |
| T-08-10-02 | Tampering | Silent attachment to running dev stack | high | mitigate | `reuseExistingServer: false` on both webServer entries (`playwright.config.ts:68,100`); with a dev stack listening the run refuses outright (recorded in 08-10 summary as stronger form) | closed |
| T-08-10-03 | Tampering | Dev config leaking into E2E process | high | mitigate | `dev:e2e` scripts carry no `--env-file` (verified in both package.json files); env supplied via `webServer.env` | closed |
| T-08-10-04 | Repudiation | Configuration claimed but not verified | medium | mitigate | Redacted DSN printed behind `E2E_DSN_MARKER` (`provision-database.ts:100`); asserted by CI `e2e` job | closed |
| T-08-10-05 | Information Disclosure | Connection string in CI logs | low | mitigate | `redact()` strips the password before printing (`provision-database.ts:57`) | closed |
| T-08-10-SC | Tampering | npm installs | high | mitigate | Only internal workspace link added | closed |
| T-08-11-01 | Repudiation | Workspace dropping out of coverage denominator | high | mitigate | Root `vitest.config.ts` with `test.projects` — single aggregated run; broken-project → exit 1 verified empirically (recorded in SPECIFICATION.md §vitest) | closed |
| T-08-11-02 | Tampering | Threshold without provenance | medium | mitigate | `coverage-baseline.json` records `measuredLines`, `measuredAt` (date/plan/covered/total/command), `increment`, and scope note | closed |
| T-08-11-03 | Denial of Service | Losing `fileParallelism: false` under aggregation | medium | mitigate | Worker's own `vitest.config.ts:50` keeps it; root config inherits per-project configs by path (noted in root config comment) | closed |
| T-08-11-04 | Repudiation | Coverage % standing in for crash scenarios | medium | mitigate | D-20: scenarios tracked by name in `docs/failure-injection-scenarios.md`, never by percentage | closed |
| T-08-11-SC | Tampering | npm install (`@vitest/coverage-v8`) | high | mitigate | Official `vitest-dev` scope, approved in 08-RESEARCH.md; pinned to installed vitest's 4.1.x family | closed |
| T-08-12-01 | Tampering | Harness reaching live SendGrid | high | mitigate | `sigkill-entrypoint.ts` imports `processSendJob` directly and injects only `sendMail`; no server boot; no SendGrid host refs (grep-verified) | closed |
| T-08-12-02 | Repudiation | Kill landing outside the claim window | high | mitigate | Kill triggered by IPC marker emitted inside injected `sendMail` which never settles; intermediate `dispatching` status asserted | closed |
| T-08-12-03 | Tampering | Duplicate send on restart | high | mitigate | Post-kill redelivery asserts `sendMail` call count 0 and `sends` row count 1 (CR-04 regression guard) | closed |
| T-08-12-04 | Tampering | Child connecting to unintended DB | medium | mitigate | Parent forwards resolved `TEST_DATABASE_URL`; consolidated fixture guard fires in the child (no fallback exists) | closed |
| T-08-12-05 | Denial of Service | Orphaned child after failed assertion | low | mitigate | `killAndAwaitExit` (`spawn-and-kill.ts:138`) awaits exit; `afterAll` kills survivors; SIGKILL-survivor surfacing fixed in review WR-02 (d47fdd3) | closed |
| T-08-12-SC | Tampering | npm installs | high | mitigate | No new package (`execa` from 08-01) | closed |
| T-08-13-01 | Denial of Service | Job loss across Redis restart | high | mitigate | `redis-restart.test.ts`: real `redis-server` from `docker/redis.conf`, SIGTERM + restart from same data dir; waiting count preserved and processed; loss demonstrated without the config | closed |
| T-08-13-02 | Repudiation | Timing wait masking unhealthy container | medium | mitigate | `waitForHealthy` in `temp-redis.ts` polls real status with bounded attempts; no fixed sleep | closed |
| T-08-13-03 | Tampering | Restart under shared production queue | medium | mitigate | Run-unique queue name; `apps/worker` `fileParallelism: false` in force | closed |
| T-08-13-04 | Repudiation | Coverage % substituting for scenario evidence | medium | mitigate | `docs/failure-injection-scenarios.md` maps all five modes to script + file path, cites D-20, states the substitution is invalid | closed |
| T-08-13-05 | Tampering | Scenario reaching live SendGrid | high | mitigate | Injected `sendMail` with call-count assertion; zero SendGrid host refs (grep-verified) | closed |
| T-08-13-SC | Tampering | npm installs | high | mitigate | No new package | closed |
| T-08-14-01 | Tampering | Lowering baseline to turn red green | high | mitigate | `coverage-ratchet.mjs` compares against `git show <base>:coverage-baseline.json`, exits 1 on any decrease, no tolerance band | closed |
| T-08-14-02 | Repudiation | Rounded comparison admitting regression | medium | mitigate | `checkCoverageGate` compares unrounded `covered/total`; baseline note documents the 84.996%-vs-85% case | closed |
| T-08-14-03 | Repudiation | Gate passing on empty report | high | mitigate | `if (!(total > 0))` returns fail with distinct reason (`coverage-gate.mjs:37`) — also catches NaN | closed |
| T-08-14-04 | Tampering | Ratchet passing when base ref unavailable | medium | mitigate | Missing base file → explicit null (introducing-commit) case; other `git show` failures error; null-base vacuous pass hardened in review WR-04 (021fd52) | closed |
| T-08-14-SC | Tampering | npm installs | high | mitigate | Both scripts use only `node:` builtins | closed |
| T-08-15-01 | Information Disclosure | Secrets file in working root | high | mitigate | File moved (only `.env.example` remains in root, verified); `check-root-hygiene.mjs` blacklists `/^\.env($\|\.)/` and Redis dumps, allow-lists `.env.example` | closed |
| T-08-15-02 | Tampering | Divergent hardcoded config paths | medium | mitigate | `resolveEnvPath()` in `scripts/env-path.mjs` is the single decision point; readers (`load-env.ts`, vitest/playwright configs) all import it | closed |
| T-08-15-03 | Denial of Service | Config loaded after boot-time schema | medium | mitigate | `import "./load-env.js"` is the first import in `apps/api/src/server.ts` (verified) | closed |
| T-08-15-04 | Information Disclosure | Agent reading/writing the secrets file | high | mitigate | Physical move was a blocking operator checkpoint; hygiene check operates on directory-entry names, not contents | closed |
| T-08-15-05 | Information Disclosure | Secrets inside files elsewhere in tree | medium | accept | See Accepted Risks AR-6 | closed |
| T-08-15-SC | Tampering | npm installs | high | mitigate | All new scripts use only `node:` builtins | closed |
| T-08-16-01 | Tampering | Tampered envelope-encrypted secret | high | mitigate | `envelope.test.ts:61` — tampered authTag and tampered ciphertext both assert rejection | closed |
| T-08-16-02 | Information Disclosure | Cross-tenant row visibility | critical | mitigate | `tenant-context.test.ts:88` — "hides one workspace's rows from another"; direct insert-under-A / select-under-B absence assertion | closed |
| T-08-16-03 | Information Disclosure | Cross-tenant decryptability of envelope | high | mitigate | Workspace-bound decryption tested (`decryptTenantSecret(WORKSPACE_A, …)` in envelope tests); result recorded per plan | closed |
| T-08-16-04 | Tampering | Lowering threshold to close coverage gap | high | mitigate | Baseline outside 08-16 edit scope; ratchet re-run; baseline note explicitly forbids lowering | closed |
| T-08-16-05 | Repudiation | RLS posture assertion encoding wrong direction | medium | mitigate | "no tenant in scope — the pre-Phase-10 RLS baseline" describe block (`tenant-context.test.ts:164`) records observed behavior explicitly | closed |
| T-08-16-SC | Tampering | npm installs | high | mitigate | Only `vitest@4.1.9` + internal link | closed |
| T-08-17-01 | Repudiation | Docs asserting unimplemented protections | medium | mitigate | `ARCHITECTURE.md`/`CONVENTIONS.md` written present-tense-with-citation; cited paths mechanically asserted to exist | closed |
| T-08-17-02 | Repudiation | Written rule diverging from enforced rule | medium | mitigate | Marker syntax quoted from `lint-migrations.mjs`; linter run against fixture using the documented syntax | closed |
| T-08-17-03 | Repudiation | Documentation rot | medium | mitigate | Per-document trigger lists in `.claude/CLAUDE.md`; stale placeholders removed | closed |
| T-08-17-04 | Information Disclosure | Secrets transcribed into new docs | medium | mitigate | No env values/credentials/connection strings restated; facts linked to SPECIFICATION.md | closed |
| T-08-17-05 | Tampering | Losing an existing routing rule | low | mitigate | Existing SPECIFICATION.md routing list byte-identical, asserted with `git diff` | closed |
| T-08-17-SC | Tampering | npm installs | high | mitigate | No package installed | closed |
| T-08-18-01 | Elevation of Privilege | Admin bypass of branch protection | high | mitigate | Live-verified via GitHub API: `enforce_admins: true`; required checks `static`, `test`, `failure-injection` | closed |
| T-08-18-02 | Tampering | Unpinned third-party actions | high | mitigate | All 8 `uses:` references pinned to full 40-char SHAs (grep-verified on branch) | closed |
| T-08-18-03 | Repudiation | Required check that never runs | high | mitigate | Both `push` and `pull_request` triggers present; required-check names match workflow job ids; verified end-to-end via throwaway PR (`throwaway/08-18-protection-check` branch exists on remote) | closed |
| T-08-18-04 | Repudiation | Failure scenarios passing only in aggregate | medium | mitigate | Five separate CI steps (`ci.yml:182–194`); `failure:all` aggregate absent from the workflow (exists only as local convenience script) | closed |
| T-08-18-05 | Denial of Service | Flaky browser run blocking merges | medium | mitigate | `e2e` job carries `continue-on-error: true` (`ci.yml:203`) and is excluded from required checks (API-verified) | closed |
| T-08-18-06 | Information Disclosure | Repo secrets exposed to fork PR runs | medium | accept | See Accepted Risks AR-7 | closed |
| T-08-18-SC | Tampering | npm installs | high | mitigate | No package installed; `npx playwright install` fetches browsers for the already-declared `@playwright/test` version | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-1 | T-08-01-04 | CI job env credentials are the docker-compose dev defaults (`postgres`/`mega_crm_dev_pw`) already public in `docker/init-app-role.sql`; no production secret introduced | plan 08-01 (plan-time disposition) | 2026-08-06 |
| AR-2 | T-08-03-04 | Type-aware linting reads only repo-local TypeScript already present in the checkout; no secret material involved | plan 08-03 (plan-time disposition) | 2026-08-06 |
| AR-3 | T-08-04-04 | Dev Redis on 6379 without `requirepass` is a pre-existing condition of the dev-only compose file (SPECIFICATION.md §1.3); production hardening belongs to Phase 15 | plan 08-04 (plan-time disposition) | 2026-08-06 |
| AR-4 | T-08-05-04 | Migration-linter input is trusted repo content read from disk; nothing is executed | plan 08-05 (plan-time disposition) | 2026-08-06 |
| AR-5 | T-08-08-04 | Fixture SendGrid key is the literal test value already used by `send-dispatch-durability.test.ts`, encrypted with the test-only local KEK, in a database dropped at teardown | plan 08-08 (plan-time disposition) | 2026-08-06 |
| AR-6 | T-08-15-05 | Content-based secret scanning is a different class of check, deferred to Phase 13 by decision (D-29); the root-hygiene check is name-based and root-scoped | plan 08-15 (plan-time disposition) | 2026-08-06 |
| AR-7 | T-08-18-06 | The workflow references no repository secret; every credential it uses is a public dev default. Revisit if a deployment job is added in Phase 14 | plan 08-18 (plan-time disposition) | 2026-08-06 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-06 | 102 | 102 | 0 | /gsd-secure-phase (L1 evidence pass; register authored at plan time across all 18 plans; short-circuit per ASVS L1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-06
