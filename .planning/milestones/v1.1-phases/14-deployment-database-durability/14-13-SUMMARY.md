---
phase: 14-deployment-database-durability
plan: 13
subsystem: docs
tags: [specification, architecture, conventions, ci-gate, deployment, database-durability]

requires:
  - phase: 14-deployment-database-durability
    provides: "every plan 14-01 through 14-12's SUMMARY.md 'SPECIFICATION.md items for 14-13' note, plus code-derived facts for 14-09/14-10/14-11 (no SUMMARY exists for those three -- paused at real-host human-verify checkpoints)"
provides:
  - "SPECIFICATION.md sections 2, 3, 4, 5, 6, 7, 8: every new dependency/version, every new secret name, the two new schema objects (member's unique constraint, partition retention), the migrate runner and retention step, the two new health routes, the backup observability signal, and eight documented divergences"
  - "scripts/check-spec-env-coverage.mjs + npm run check:spec-env-coverage: a CI-enforced gate (static job) comparing every name in docker/prod.env.example against SPECIFICATION.md, word-boundary matched, names only, values never read"
  - "ARCHITECTURE.md sections 14-17: deployment topology (with the connection-budget table), migration gating, backup/PITR, retention -- plus a satisfied-not-forward-looking rewrite of section 10's drain-timeout instruction"
  - "CONVENTIONS.md 'Deployment' section: pool-factory, TLS-source-of-truth, and derived-stop-grace-period rules, each naming its machine gate and the failure it prevents"
affects: ["any future phase adding a secret, dependency, schema object, queue, route or observability hook -- the env-coverage gate is what makes CLAUDE.md's same-change rule survive it"]

tech-stack:
  added: []
  patterns:
    - "check-spec-env-coverage.mjs: Node-builtins-only gate script in the class of lint-session-state.mjs/lint-pg-pool-factory.mjs -- exported pure helpers, import.meta.url CLI guard, reported checked-name count, word-boundary (not substring) name matching so a longer name sharing a shorter name's prefix cannot silently satisfy the shorter one's coverage requirement"

key-files:
  created:
    - scripts/check-spec-env-coverage.mjs
    - scripts/__tests__/check-spec-env-coverage.test.mjs
    - scripts/__fixtures__/spec-env-coverage/env.example
    - scripts/__fixtures__/spec-env-coverage/passing-spec.md
    - scripts/__fixtures__/spec-env-coverage/missing-spec.md
  modified:
    - SPECIFICATION.md
    - ARCHITECTURE.md
    - CONVENTIONS.md
    - package.json
    - .github/workflows/ci.yml

key-decisions:
  - "The gate is one-directional (env.example -> SPECIFICATION.md) by design: a name SPECIFICATION.md documents that docker/prod.env.example deliberately omits (PARTITION_RETENTION_ENABLED, per plan 14-12's own D5 coverage check -- no committed config sets it) is not a coverage gap and must not trip the gate."
  - "Word-boundary (\\b) containment, not substring containment, for the missing-name check -- a plain .includes() would credit a shorter name (PGBACKREST_REPO1_S3_KEY) as 'present' merely because a longer name sharing its prefix (PGBACKREST_REPO1_S3_KEY_SECRET) appears somewhere in the document. Proven by a dedicated fixture pair, not asserted from reading the regex."
  - "pgBackRest's real installed-in-image version is recorded as undetermined, not the Dockerfile comment's Debian-bookworm-package-metadata figure (2.45-1) treated as fact -- no SUMMARY exists for plan 14-10 (blocking checkpoint, no Docker daemon in this environment) and the Dockerfile's own header explicitly defers to a real `docker build && docker run ... pgbackrest version` as the authoritative record. SPECIFICATION.md §2.6 states both the recorded comment value and the undetermined-until-real-build caveat side by side."
  - "AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY filed into SPECIFICATION.md §3.8 despite predating Phase 14 (standard AWS SDK v3 credential-chain variables, already 'не определено' in §3.4 since Phase 10) -- plan 14-08 is the first plan to give them a named place in docker/prod.env.example, and the gate's own extractor found them missing from the document; filed rather than left failing."
  - "Several now-false statements the new facts directly contradicted were corrected as Rule 1 fixes, not left standing next to the new content: apps/worker's 'no HTTP listener' claim, the API's 'no healthcheck endpoint' claim, packages/db's second pool 'no pool.on(error)' claim, member's 'no unique constraint' claim (both in §4.1 and the §9 review-questions list), the TLS/PgBouncer 'не определено'/'отсутствует' claims in §3.6, and CONVENTIONS.md's stale forward-reference to 'Phase 14's transaction-mode PgBouncer pooling' (PgBouncer was deferred, not shipped)."

requirements-completed: [DB-09, DB-11, DB-13, DB-14]

coverage:
  - id: T1
    description: "SPECIFICATION.md sections 2-8 filed with exact values from the nine available SUMMARYs plus code-derived facts for 14-09/14-10/14-11; check-spec-env-coverage.mjs gate wired into CI"
    requirement: "DB-14"
    verification:
      - kind: integration
        ref: "npm run check:spec-env-coverage -- 46 names checked, 0 missing"
        status: pass
      - kind: unit
        ref: "npx vitest run --root scripts __tests__/check-spec-env-coverage.test.mjs -- 10/10 tests (extraction, word-boundary matching, fixture files, real-repo files)"
        status: pass
      - kind: integration
        ref: "npx vitest run --root scripts -- full lane, 8 files / 117 tests, no regression in sibling guard scripts"
        status: pass
      - kind: unit
        ref: "npm run lint (0 warnings), npm run lint:floor (638 files, floor 390, OK), npm run build --workspaces --if-present (all 15 workspaces clean)"
        status: pass
    human_judgment: false
  - id: T2
    description: "ARCHITECTURE.md's four new sections (deployment topology with the connection budget table, migration gating, backup/PITR, retention) plus the satisfied drain-timeout rewrite; CONVENTIONS.md's three new rules"
    requirement: "DB-13, DB-14"
    verification:
      - kind: unit
        ref: "grep -q max_connections && grep -qi 'connection budget' ARCHITECTURE.md && grep -qi createPgPool && grep -qi 'stop.grace' CONVENTIONS.md && npm run lint -- all pass"
        status: pass
      - kind: unit
        ref: "git status --porcelain during Task 2 shows only ARCHITECTURE.md/CONVENTIONS.md touched -- no source file outside the two doc files was modified"
        status: pass
    human_judgment: false

duration: ~2h
completed: 2026-08-13
status: complete
---

# Phase 14 Plan 13: SPECIFICATION.md / ARCHITECTURE.md / CONVENTIONS.md consolidation Summary

**Filed every dependency, secret, schema object, scheduler change, public entry point and divergence Phase 14's twelve prior plans introduced into SPECIFICATION.md sections 2-8, added a CI-enforced env-coverage gate so a future secret added to `docker/prod.env.example` without a matching filing fails the build, wrote ARCHITECTURE.md's four new deployment models (topology/migration-gating/backup-PITR/retention) with the connection-budget table as D-09's PgBouncer-deferral evidence, and recorded CONVENTIONS.md's three new machine-gated rules — while correcting eight now-false statements the new facts directly contradicted.**

## Performance

- **Duration:** ~2h
- **Tasks:** 2 (Task 1 SPECIFICATION.md + gate, Task 2 ARCHITECTURE.md + CONVENTIONS.md)
- **Files created:** 5
- **Files modified:** 5

## Accomplishments

- **`scripts/check-spec-env-coverage.mjs`** (Task 1): extracts every uncommented `NAME=` line from `docker/prod.env.example` (de-duplicated, commented placeholder lines like `# API_PORT=4000` correctly excluded), and asserts each name appears in `SPECIFICATION.md` via word-boundary (not substring) matching — proven against a dedicated fixture pair that a shorter name sharing a longer name's prefix (`FIXTURE_PREFIX` vs `FIXTURE_PREFIX_LONGER`) is never credited as present merely because the longer one is mentioned. Wired into `.github/workflows/ci.yml`'s `static` job as `SPECIFICATION env coverage`; `test`/`failure-injection`/`e2e` untouched. Sequence-inverted per plan: wrote the gate first, ran it against the real files to get a literal missing-name worklist (27 names on the first run), then filed each one.
- **SPECIFICATION.md §2.6** (Phase 14 dependencies): zero new npm packages confirmed (matches RESEARCH.md's own Package Legitimacy Audit) — only two `package.json` metadata changes (root `devDependencies` gained `drizzle-orm`/`@mega-crm/db` for `migrate-runner.mjs`; `packages/tenant-context` gained a runtime `@mega-crm/db` dependency for the pool factory) and two `exports`-field additions (`delivery-core`/`queue-core`). OS-level packages recorded with their sourcing: `pgbackrest` (Debian bookworm `2.45-1` per the Dockerfile's own comment, **actual in-image version recorded as undetermined** — no Docker daemon in this environment, no SUMMARY for plan 14-10) and `cron`. Every image's exact `FROM` tag recorded character-for-character: `node:22-slim` (api/worker/web-build), `caddy:2` (Alpine, confirmed via docker-library/docs), `postgres:17`, `redis:7`.
- **SPECIFICATION.md §3.8** (Phase 14 secrets): all 46 names `docker/prod.env.example` declares, grouped by purpose — deploy identity (3), sizing (10), Postgres bootstrap (6), pgBackRest repository (7, including the non-secret fixed `PGBACKREST_STANZA`), retention flag (1, `PARTITION_RETENTION_ENABLED` — deliberately absent from the example file per plan 14-12), test-only overrides (13, never set by any production invocation), plus `WORKER_HEALTH_PORT` and the pre-existing-but-newly-documented AWS credential-chain trio. The GHCR pull token is recorded as a host-level `docker login` credential, not invented as an env var.
- **SPECIFICATION.md §4** (schema): migration `0062`'s `member_organization_user_unique` constraint (closing half of review-question 16); migration `0063`'s `partition_maintenance_runs` retention columns and the new `partition_retention_drops` ledger, under a new §4.7 documenting the retention policy (12-month horizon, the five excluded evidence-table groups, the combined recovery-horizon arithmetic, the flag's off-everywhere status). Journal/snapshot counts corrected (64 migrations, 13 snapshots — was 62/11).
- **SPECIFICATION.md §5.17** (scheduler): the migrate runner and its gating, the retention step's composition into the existing daily tick, the pool factory, the connection-budget table (with its transients — migrate-runner's dedicated client, the pgbackrest sidecar's socket connection — named separately from the pooled-connection sum), and the OS-level backup cron schedule.
- **SPECIFICATION.md §6.17** (entry points): `GET /healthz`/`GET /readyz` on both `apps/api` and `apps/worker`, the worker's loopback-only binding and its draining-flag behavior.
- **SPECIFICATION.md §7** (observability): pgBackRest's own `check`/`info` as the sixth independent dead-man's-switch, with the "configured vs. actually backed up" distinction stated explicitly and the Phase 15 alerting deferral named as a forward follow-on, not a silent gap.
- **SPECIFICATION.md §8.4** (divergences): Node 22 (images) vs. `.nvmrc`'s Node 26 (dev/CI); pgBackRest's actual-vs-assumed version and Caddy's confirmed Alpine base; D-09's PgBouncer deferral with the connection-budget table as its owner-and-revisit-trigger evidence; D-10's TLS `verify-full` deferral with its revisit trigger; and an explicit statement that plans 14-09/14-10/14-11's real-host checkpoints remain unperformed as of this writing.
- **ARCHITECTURE.md §§14-17** (Task 2): deployment topology (six containers, SHA-immutable images, the connection-budget table restated as a model with the same arithmetic SPECIFICATION.md's table carries), migration gating (the dedicated-connection advisory lock as half the guarantee, the explicit-exit-code ordering vs. Compose's documented `depends_on` re-trigger bug, `/readyz`'s independent re-verification), backup and point-in-time recovery (why the archive tool must live inside the database's own container, what a restore actually restores, the RPO/RTO the cadence buys), and retention (partition drop as the mechanism, the combined recovery-horizon arithmetic, the flag's precondition). §10's drain-timeout paragraph rewritten from "Phase 14 must set this" to "this is now satisfied," naming the publish script and the compose-invariant gate.
- **CONVENTIONS.md "Deployment" section** (Task 2): three rules — pool factory (gate: `lint:pg-pool-factory`), TLS source-of-truth (gate: `pg-tls.test.ts` for the client half, `validate-prod-compose.mjs`'s TLS-entrypoint check for the server half), derived stop-grace-period (gate: `validate-prod-compose.mjs`'s drift check) — each stating the failure it prevents, not only the rule.
- **Eight now-false statements corrected as Rule 1 fixes**, each pointing forward to the new content rather than being silently deleted: §1.1's worker "no HTTP listener" row, §1.3's "no Dockerfile/deploy-manifests" paragraph, §3.6's "second pool has no error handler" and "TLS не определено" lines, §4.1/§9-item-16's "`member` has no unique constraint," §6.1/§7's "no healthcheck endpoint" lines, §9-item-11's "Dockerfile/CI/deploy-manifests absent," and CONVENTIONS.md's "Phase 14's transaction-mode PgBouncer pooling" forward-reference (PgBouncer was deferred, not shipped — D-09).

## Task Commits

1. **Task 1: SPECIFICATION.md sections 2-8, with a machine gate on the secrets section** — `6541d72` (docs)
2. **Task 2: ARCHITECTURE.md's four new sections including the connection budget, and CONVENTIONS.md's three new rules** — `86fc4f7` (docs)

_This SUMMARY.md is committed directly via `git add -f` per this worktree's repo-specific rules (`.planning/` is gitignored)._

## Files Created/Modified

- `scripts/check-spec-env-coverage.mjs` — the env-coverage extractor + word-boundary missing-name check + CLI
- `scripts/__tests__/check-spec-env-coverage.test.mjs` — 10 tests: extraction, word-boundary matching (including the shared-prefix false-negative-prevention case), fixture-file passing/missing cases, real-repo files
- `scripts/__fixtures__/spec-env-coverage/{env.example,passing-spec.md,missing-spec.md}` — the fixture triple
- `SPECIFICATION.md` — sections 1 (two stale-statement fixes), 2.6 (new), 3.6 (two fixes), 3.8 (new), 4.1/4.2/4.6/4.7 (member constraint, retention table/policy, journal counts), 5.17 (new), 6.1/6.17 (healthcheck fix + new section), 7 (healthcheck fix + backup observability), 8.1/8.4 (PgBouncer row updated + new divergences section), 9-items-11/16/18 (three closures)
- `package.json` — `check:spec-env-coverage` script
- `.github/workflows/ci.yml` — one new step in the `static` job
- `ARCHITECTURE.md` — §10's drain-timeout rewrite, four new sections (14-17), the Phase 14-15 forward-looking bullet rewritten
- `CONVENTIONS.md` — new "Deployment" section (three rules), the session-state rule's PgBouncer reference reworded, the Phase 15 forward-looking bullet rewritten

## Connection budget table, as filed

Filed identically (same arithmetic, same source citations) into both `SPECIFICATION.md` §5.17 and `ARCHITECTURE.md` §14, per the plan's own key_link requiring the two numbers (PG_POOL_SIZES sum, `max_connections`) to combine into one auditable table rather than staying two facts a reader has to combine themselves:

| Consumer | `max` | Runs in |
|---|---|---|
| `db` | 10 | `apps/api`, `apps/worker` |
| `auth` | 10 | `apps/api` |
| `tenant-context` | 20 | `apps/api`, `apps/worker` |
| `tenant-context-scan` | 5 | `apps/api`, `apps/worker` |
| `worker-partition-maintenance` | 2 | `apps/worker` |
| `worker-dead-letter` | 2 | `apps/worker` |
| every `packages/db/scripts` operator CLI | 2 each (`PG_POOL_DEFAULT_MAX`) | one process at a time |
| `migrate-runner.mjs`'s dedicated `pg.Client` | 1 (not a pool; excluded from the sum) | one-shot `migrate` step only |
| `pgbackrest` sidecar's control connection | 1 superuser Unix-socket connection (not a `pg.Pool`) | scheduled backup/check only |

Sum for one instance each of `apps/api` (45) + `apps/worker` (39) = **84**. Configured `PG_MAX_CONNECTIONS` default **200** — deliberately not "just above 84," to absorb a rolling-restart transient doubling (84→~168), `superuser_reserved_connections`, and concurrent operator CLIs. `scripts/validate-prod-compose.mjs` fails the build if the resolved value is ≤84. This table is D-09's PgBouncer-deferral evidence, not an assertion — the revisit trigger is real pressure against these numbers, not a date.

## Recorded as undetermined (per this document's own «не определено» idiom, never guessed)

- **pgBackRest's actual installed-in-image version** — the Debian bookworm package-metadata figure (`2.45-1`) is recorded from `docker/postgres/Dockerfile`'s own comment, but no real `docker build && docker run ... pgbackrest version` has been executed in this environment (no Docker daemon), and no SUMMARY exists for plan 14-10 to have recorded one either.
- **Whether a real deploy, a real off-host backup/WAL-shipment, or a real point-in-time restore has ever been performed** — plans 14-09, 14-10, and 14-11 all stopped at their own blocking human-verify checkpoint (real VPS / real S3-compatible repository / real host required, all unreachable from this environment); `PARTITION_RETENTION_ENABLED` stays off pending the third of these specifically (D-08's precondition).
- **The AWS credential chain's actual configuration** — `packages/kms`'s `KMSClient({})` still relies on the AWS SDK's own default chain; nothing in this repository configures it beyond documenting the three standard variable names' existence.

## Divergences filed into §8.4

1. Node 22 (Dockerfiles) vs. `.nvmrc`'s Node 26 (dev/CI) — deliberate, `.nvmrc`'s Node 26 documented elsewhere to hang `drizzle-kit` in this sandbox.
2. pgBackRest's actual (`2.45-1` per Dockerfile comment, unconfirmed in a real build) vs. RESEARCH.md's assumed (`2.5x [ASSUMED]`).
3. Caddy's confirmed Alpine base (`caddy:2`) — a research gap closed, not a divergence from an assumption.
4. D-09: PgBouncer deferred, with the connection-budget table as evidence, owner (operator/next sizing phase), and revisit trigger (real connection pressure) named.
5. D-10: Postgres TLS stops at `sslmode=require` + self-signed rather than `verify-full`, with owner (operator, at real-CA-availability time) and revisit trigger (a trusted CA becoming available, or an audit requirement) named.
6. Plans 14-09/14-10/14-11's real-host checkpoints remaining unperformed as of this writing — stated once, cross-referenced from §3.8/§4.7/§8.1, not repeated as three separate unrelated facts.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Eight statements in SPECIFICATION.md/CONVENTIONS.md directly falsified by this phase's own new content**
- **Found during:** Task 1/Task 2, while reading the surrounding sections for context before filing new material (advisor-flagged before writing, not caught after).
- **Issue:** Statements like "worker has no HTTP listener," "no healthcheck endpoint," "second pool has no error handler," "`member` has no unique constraint," and CONVENTIONS.md's forward-reference to "Phase 14's transaction-mode PgBouncer pooling" would have sat directly beside the new content contradicting them — the exact "documenting a capability the code does not have" / internal-contradiction failure mode T-14-87 names as the worst outcome this document can produce for a security reviewer.
- **Fix:** Corrected each in place with a one-line note pointing at the new section that supersedes it, rather than a full rewrite of the surrounding prose.
- **Files modified:** `SPECIFICATION.md`, `CONVENTIONS.md`
- **Verification:** Each correction re-read against the code fact it now states (worker health server, pool factory, migration 0062, PgBouncer's actual D-09 status).
- **Committed in:** `6541d72` (SPECIFICATION.md fixes), `86fc4f7` (CONVENTIONS.md fix)

**2. [Rule 2 - Missing critical] AWS_REGION/AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY filed despite predating Phase 14**
- **Found during:** Task 1, running the gate against the real files after the first pass of filing — these three names remained in the missing-name output.
- **Issue:** These are standard AWS SDK v3 credential-chain variables that already existed conceptually (§3.4's "не определено" for `KMSClient({})`'s credential source) but had never been given a named place matching `docker/prod.env.example`'s list, which plan 14-08 is the first to introduce.
- **Fix:** Added a short paragraph in §3.8 cross-referencing §3.4 and stating plainly that these are not new variables, only newly-named in the production example file.
- **Files modified:** `SPECIFICATION.md`
- **Verification:** `npm run check:spec-env-coverage` — 0 missing after this addition.
- **Committed in:** `6541d72`

---

**Total deviations:** 2 (1 Rule 1 — eight related internal-contradiction fixes across two files, treated as one class of correction; 1 Rule 2 — a small, necessary completion the gate's own worklist surfaced). No scope creep beyond what DB-09/DB-11/DB-13/DB-14 required.

## Issues Encountered

- **Sequence-inversion worked as advised:** writing the gate script before filing content, then running it against the real `docker/prod.env.example`/`SPECIFICATION.md` pair, produced an exact 27-name worklist on the first run — filing each one and re-running converged to 0 missing without any guessing about which names were actually absent.
- **Fixture design bug caught by the gate's own tests:** the first draft of `missing-spec.md`'s header comment named the deliberately-omitted variable in prose, which made the coverage check find it "present" via that comment — a self-inflicted false negative in the test fixture itself, not in the gate logic. Fixed by rewording the comment to describe the omission without naming either variable literally.

## User Setup Required

None for this plan's own work — no external service configuration required. Documenting, not performing, the still-open real-host checkpoints for plans 14-09/14-10/14-11 remains the operator's obligation, unchanged by this plan.

## Next Phase Readiness

- `SPECIFICATION.md` describes the deployed system as built, with a CI gate preventing its secrets section from silently falling behind `docker/prod.env.example` in any future phase.
- `ARCHITECTURE.md`'s deployment/migration/backup/retention models are cross-referenced from the runbooks that own each procedure, without duplicating any of them.
- `CONVENTIONS.md`'s three new deployment rules are each backed by a real, already-passing machine gate.
- **Still open, explicitly recorded rather than silently assumed:** the real-host checkpoints for plans 14-09 (first deploy), 14-10 (first backup), and 14-11 (first restore drill) — all three remain the phase's actual completion gate for OPS-02/OPS-03/DB-09/DB-10, not this plan's documentation work.

## Self-Check: PASSED

All 6 created/referenced files confirmed present via direct filesystem check (`scripts/check-spec-env-coverage.mjs`, `scripts/__tests__/check-spec-env-coverage.test.mjs`, all 3 `scripts/__fixtures__/spec-env-coverage/*` files, this SUMMARY.md). Both task commits (`6541d72`, `86fc4f7`) confirmed present via `git log --oneline --all`.

---
*Phase: 14-deployment-database-durability*
*Completed: 2026-08-13*
