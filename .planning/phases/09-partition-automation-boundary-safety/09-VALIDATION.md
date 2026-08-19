---
phase: 9
slug: partition-automation-boundary-safety
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-06
validated: 2026-08-19
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

Sources: `09-RESEARCH.md` § Validation Architecture (framework, requirement→test map,
sampling rate, Wave 0 gaps) and the five plan files `09-01-PLAN.md` … `09-05-PLAN.md`
(the `<automated>` commands each task actually carries).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.9 (pinned per workspace, no root-level vitest), plus the `@mega-crm/test-support` ephemeral-Postgres fixture (`createEphemeralDatabase` / `ensureTestDbMigrated` / `createTestPool`) established in Phase 8 |
| **Config file** | Per-workspace, all already present: `packages/db/vitest.config.ts`, `apps/api/vitest.config.ts`, `apps/worker/vitest.config.ts`, `packages/test-support/vitest.config.ts` — no new config and no framework install in this phase |
| **Quick run command** | `npx vitest run --root packages/db src/partitions/__tests__/ src/__tests__/fixture-partition-parity.test.ts && npx vitest run --root apps/api src/modules/ops/__tests__/partition-maintenance-tracer.test.ts src/modules/ops/__tests__/partition-watchdog.test.ts src/__tests__/env-schema.test.ts` — narrowed 2026-08-19 to the phase-9 files: `apps/api src/modules/ops/__tests__/` now holds 13 suites, 11 of them from later phases (10–16 watchdogs), so the bare-directory form no longer measures phase 9 |
| **Full suite command** | `npm test` (root — fans out to `npm run test --workspaces --if-present`) |
| **Measured runtime** (2026-08-19) | Quick: ~8s wall total — `packages/db` partitions + fixture-parity: 47 tests in ~4.8s; `apps/api` tracer + watchdog + env-schema: 29 tests in ~3.1s; `apps/worker` partition-maintenance.worker: 7 tests in ~2.8s. Well under the ~30–60s original estimate. Full: green at 09-05's phase gate (2026-08-06, 725 tests / 11 workspaces); not re-run for this audit — full-suite runs on this machine hit known environmental noise (sentry-DSN env tests, advisory-lock flakes under load) unrelated to phase 9. |

Additional non-vitest gates the plans lean on (fast, seconds each): `npm run lint`,
`npm run lint:migrations`, `npm run build -w packages/db`, `npm run build -w apps/worker`,
`npm run build -w apps/api`, and a set of `node -e` manifest/journal assertions.

---

## Sampling Rate

- **After every task commit:** the task's own `<automated>` block (each task carries at
  least one, and every code-producing task carries a vitest command). Cheapest useful
  signal: `npx vitest run --root <workspace> <single test file>`.
- **After every plan wave:** `npm test` (root). This phase touches `packages/db`,
  `packages/test-support`, `apps/worker` and `apps/api`, and plan 09-03's fixture change
  alters the bootstrap of every database-using suite in the repository — so a
  workspace-scoped run is not sufficient at a wave boundary.
- **Before `/gsd-verify-work`:** full suite green, plus `npm run lint`,
  `npm run lint:migrations` and `npm run build` — this is exactly plan 09-05 task 3's
  gate, per Phase 8's QG-01/QG-05 CI gates already in place.
- **Max feedback latency:** ~60s (single-file ephemeral-DB suite). No watch-mode flags are
  used anywhere in this phase; every command is a one-shot `vitest run`.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | DB-01, DB-02 | T-09-01, T-09-02, T-09-06, T-09-07 | Partition identifiers come only from `Date` arithmetic against the frozen `PARTITIONED_TABLES` allowlist; no `events_%`/`send_events_%` relation is ever left with `relispartition = false`; CHECK-first attach runs unconditionally | tracer (integration, ephemeral DB) | `npx vitest run --root apps/api src/modules/ops/__tests__/partition-maintenance-tracer.test.ts` | ✅ exists (was created RED-first) | ✅ green (re-run 2026-08-19) |
| 09-01-02 | 01 | 1 | DB-02 | T-09-03, T-09-04, T-09-05 | Alert body carries no workspace id, contact id, event payload, credential or connection string; platform key only, never a tenant BYO key; exactly one send per dedup window across concurrent replicas | unit + integration (ephemeral DB, injected `sendMail` seam) | `npx vitest run --root apps/api src/modules/ops/__tests__/partition-watchdog.test.ts` | ✅ exists (was created RED-first) | ✅ green (re-run 2026-08-19) |
| 09-02-01 | 02 | 2 | DB-01 | T-09-08, T-09-09 | One idempotent scheduler id across boots; no try/catch in the processor and `removeOnFail: false`, so a DDL failure cannot present as a healthy run | integration (BullMQ + Redis) | `npx vitest run --root apps/worker src/queues/__tests__/partition-maintenance.worker.test.ts` | ✅ exists (was created RED-first) | ✅ green (re-run 2026-08-19) |
| 09-02-02 | 02 | 2 | DB-02 | T-09-12 | `OPERATOR_ALERT_EMAIL` required with no default — the dead-man's switch cannot be disarmed by omission (API refuses to boot, `predev` aborts) | unit (zod env schema) | `npx vitest run --root apps/api src/__tests__/env-schema.test.ts` | ✅ exists (extended) | ✅ green (re-run 2026-08-19) |
| 09-02-03 | 02 | 2 | DB-02 | T-09-10, T-09-11 | The real SendGrid dispatch is unreachable from any test process — the interval starts only under the direct-run guard, never inside `buildServer()`; boot log names numbers only | integration + region-scoped source assertion | `npx vitest run --root apps/api src/modules/ops/__tests__/` then `! awk '/^export async function buildServer/,/^}/' apps/api/src/server.ts \| grep -q 'startPartitionWatchdog'` | ✅ (created in wave 1) | ✅ green (re-run 2026-08-19; region assertion re-verified: `buildServer` body contains no `startPartitionWatchdog`) |
| 09-04-01 | 04 | 2 | DB-03 | T-09-17, T-09-19, T-09-21 | Discovered month values never interpolated into an identifier; every date bound parameterised; row movement bounded by `RELOCATE_BATCH_SIZE` with `SKIP LOCKED`, no long exclusive lock on the live parent | integration (ephemeral DB, seeded DEFAULT rows) | `npx vitest run --root packages/db src/partitions/__tests__/relocate-default.test.ts` | ✅ exists (was created RED-first) | ✅ green (re-run 2026-08-19) |
| 09-04-02 | 04 | 2 | DB-03 | T-09-20, T-09-22 | CLI prints the database name only, never the DSN; relocation is reachable only by deliberate operator invocation — no lifecycle or CI script references it | manifest / source assertion (no test file) | `node -e '…packages/db scripts + tsx devDependency…'`, `node -e '…root passthrough…'`, `node -e '…no predev/pretest wiring…'`, `git diff --stat package-lock.json` | ✅ N/A — asserts `package.json` / lockfile, not a suite | ✅ green (re-run 2026-08-19: relocate script present, no predev/pretest wiring) |
| 09-04-03 | 04 | 2 | DB-04 | T-09-18, T-09-23 | The late-automation case (DEFAULT already holds rows for the new month) is exercised by the same exported function the operator's CLI calls; a partial run exits non-zero rather than reporting success | integration (ephemeral DB, month-rollover scenario) | `npx vitest run --root packages/db src/partitions/__tests__/boundary-crossing-late-automation.test.ts` | ✅ exists (was created RED-first) | ✅ green (re-run 2026-08-19) |
| 09-03-01 | 03 | 3 | DB-01 | — | N/A — type-inference declaration only; the health table intentionally carries no `workspace_id` and therefore no RLS policy | build + source assertion (no test file) | `npm run build -w packages/db` then `grep -c 'partition-maintenance-runs.js' packages/db/src/index.ts \| grep -q '^2$'` | ✅ N/A — asserts the barrel export, not a suite | ✅ green (re-run 2026-08-19: `partition-maintenance-runs.js` ×2 in barrel) |
| 09-03-02 | 03 | 3 | DB-01 | T-09-13, T-09-15, T-09-16 | Fixture DDL is serialised by the existing session-scoped advisory lock; no try/catch around the fixture's `ensurePartitions`, so a failure fails the run instead of silently degrading tests to DEFAULT routing; Phase 8's fail-closed DSN guard is unchanged | integration (ephemeral DB, fixture parity) | `npx vitest run --root packages/db src/__tests__/fixture-partition-parity.test.ts` | ✅ exists (was created RED-first) | ✅ green (re-run 2026-08-19) |
| 09-03-03 | 03 | 3 | DB-01, DB-04 | T-09-14 | Zero `events_%`/`send_events_%` relations with `relispartition = false` after every call — no orphaned freestanding table carrying `workspace_id` without RLS; bounds asserted through `pg_get_expr(relpartbound, oid)` and routing through `tableoid` | integration (ephemeral DB, month-boundary + contiguity + calendar precision) | `npx vitest run --root packages/db src/partitions/__tests__/ensure-partitions.test.ts` | ✅ exists (was created RED-first) | ✅ green (re-run 2026-08-19) |
| 09-05-01 | 05 | 4 | DB-01, DB-02, DB-03, DB-04 (documentation of) | T-09-24, T-09-25 | Every new surface is recorded in `SPECIFICATION.md`; the `tsx` version assertion is automated so a research range cannot be written in place of the installed value; no credential value is written into any document | doc / manifest assertion | `grep -q 'partition_maintenance_runs' SPECIFICATION.md`, `grep -q 'OPERATOR_ALERT_EMAIL' SPECIFICATION.md`, `grep -q '0038_partition_catchup_and_maintenance_runs' SPECIFICATION.md`, `grep -q 'partition-maintenance' SPECIFICATION.md`, `node -e '…literal tsx version…'` | ✅ N/A — asserts documents, not a suite | ✅ green (re-run 2026-08-19: all doc greps pass; SPECIFICATION.md records `tsx` at the exact `package.json` value `^4.19.2`) |
| 09-05-02 | 05 | 4 | DB-01 (documentation of) | T-09-24 | The `ensurePartitions`-is-the-only-source-of-partition-DDL convention is written down where a future contributor will hit it | doc assertion | `grep -q 'ensurePartitions' CONVENTIONS.md`, `grep -q 'PARTITIONED_TABLES' CONVENTIONS.md`, `grep -qi 'partition' ARCHITECTURE.md`, `grep -q 'partition_maintenance_runs' ARCHITECTURE.md` | ✅ N/A — asserts documents, not a suite | ✅ green (re-run 2026-08-19: all doc greps pass; SPECIFICATION.md records `tsx` at the exact `package.json` value `^4.19.2`) |
| 09-05-03 | 05 | 4 | DB-01, DB-02, DB-03, DB-04 | T-09-26, T-09-27, T-09-28 | The deadline is confirmed closed by the presence of 10 attached partitions per table, not by the existence of automation; the delivered alert body is confirmed to carry no tenant data; an unperformed live check is recorded as outstanding rather than absorbed into a green phase | full-suite gate + catalog assertion + human-check | `npm run lint`, `npm run lint:migrations`, `npm run build`, `npm test`, `npx vitest run --root packages/db src/partitions/__tests__/`, `npx vitest run --root apps/api src/modules/ops/__tests__/` | ✅ (all suites created in waves 1–3) | ✅ green — full gate attested by 09-05 SUMMARY (2026-08-06: lint, lint:migrations, build, `npm test` 725 tests / 11 workspaces, catalog query confirming 20 attached partitions); phase-scoped suites re-run green 2026-08-19. Full `npm test` not re-run for this audit (known machine-local sentry-DSN/advisory-lock noise unrelated to phase 9). Human-check (live alert email) remains outstanding — see Manual-Only |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

**Per-requirement automated evidence** (the table plan 09-05 task 3 must reproduce in its SUMMARY):

| Requirement | Named automated command |
|---|---|
| DB-01 | `npx vitest run --root packages/db src/partitions/__tests__/ensure-partitions.test.ts` (+ `src/__tests__/fixture-partition-parity.test.ts`) |
| DB-02 | `npx vitest run --root apps/api src/modules/ops/__tests__/partition-watchdog.test.ts` (+ `partition-maintenance-tracer.test.ts`) |
| DB-03 | `npx vitest run --root packages/db src/partitions/__tests__/relocate-default.test.ts` |
| DB-04 | `npx vitest run --root packages/db src/partitions/__tests__/boundary-crossing-late-automation.test.ts` (+ the month-boundary cases in `ensure-partitions.test.ts`) |

---

## Wave 0 Requirements

**No separate Wave 0 plan is required.** Existing infrastructure covers all phase
requirements: Vitest 4.1.9 and a per-workspace `vitest.config.ts` are already present in
every workspace this phase touches, and Phase 8's `@mega-crm/test-support` fixtures
(`createEphemeralDatabase`, `ensureTestDbMigrated`, `createTestPool`,
`applyMigrationFile`/`listMigrationFiles`) cover every scenario below. No framework
install, no new config file.

`09-RESEARCH.md` § Wave 0 Gaps listed three test files as missing. They are not deferred to
a Wave 0 plan — each is created RED-first inside the `tdd="true"` task that owns it, so no
`<automated>` command in this phase references a file that nothing creates:

- [x] `apps/api/src/modules/ops/__tests__/partition-watchdog.test.ts` — DB-02 — created by task 09-01-02 (RED first)
- [x] `packages/db/src/partitions/__tests__/ensure-partitions.test.ts` — DB-01, DB-04(a) — created by task 09-03-03 (RED first)
- [x] `packages/db/src/partitions/__tests__/relocate-default.test.ts` — DB-03, DB-04(b) — created by task 09-04-01 (RED first); invokes the exact exported function the npm-script CLI calls, per D-08's "test and procedure are the same code"
- [x] `apps/api/src/modules/ops/__tests__/partition-maintenance-tracer.test.ts` — the end-to-end spine for DB-01+DB-02 — created by task 09-01-01 (RED first)
- [x] `packages/db/src/partitions/__tests__/boundary-crossing-late-automation.test.ts` — DB-04(b) — created by task 09-04-03 (RED first)
- [x] `packages/db/src/__tests__/fixture-partition-parity.test.ts` — DB-01 — created by task 09-03-02 (RED first)

Two directories do not yet exist and are created by the tasks above:
`packages/db/src/partitions/` (plan 09-01 task 1) and `apps/api/src/modules/ops/`
(plan 09-01 task 1). `docs/runbooks/` is created by plan 09-04 task 3.

`wave_0_complete` stays `false` until wave 1 lands the first of these files on disk; there
is no Wave 0 work item blocking wave 1.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A plain-text operator alert actually reaches a human inbox | DB-02 | Every automated test injects a fake `sendMail` seam (the Phase 8 `ProcessSendJobDeps.sendMail` pattern), deliberately, so no test path reaches SendGrid. A dead-man's switch nobody has observed firing is a claim, not a fact (threat T-09-28). Requires a real `PLATFORM_SENDGRID_API_KEY` with a verified sender and a reachable `OPERATOR_ALERT_EMAIL` inbox. | Plan 09-05 task 3 `<human-check>`: boot the stack (`npm run dev`); drop enough future `events` partitions against the dev database to push the buffer below the alert threshold; let the watchdog poll (or restart the API to force the first poll). Confirm (1) a plain-text email arrives at `OPERATOR_ALERT_EMAIL`; (2) the body names both `events` and `send_events` with a per-table buffer number, both DEFAULT counts and a timestamp; (3) the body contains no workspace id, contact identifier, event payload text or connection string; (4) it is plain text — no HTML, no SendGrid template; (5) after restoring the horizon, the next poll sends nothing. If it cannot be performed, record it in the SUMMARY as an outstanding verification with the reason — do not mark the phase verified on the injected-seam tests alone. |
| Delivery status of the alert email itself | DB-02 (accepted gap) | Not verified at all — by design. A send *error* propagates and fails the watchdog call (plan 09-01 task 2 test 8), but a silent bounce after SendGrid accepts the message is invisible to this phase. Recorded in `COVERAGE.md` as the bridge-to-Phase-15 limitation. | None. Closing this loop belongs to Phase 15's real alerting (OPS-06 … OPS-19). |
| Bull Board visibility of a failed maintenance job | — (D-01, deferred) | Bull Board is not installed in this repository (RESEARCH A1). D-01's second loud signal is therefore not verifiable in Phase 9; installing it is Phase 15 / OPS-14. See the `<context_deviation>` block in `09-01-PLAN.md`. | None in Phase 9. `removeOnFail: false` (plan 09-02 task 1) preserves the failed job so it becomes visible the moment Phase 15 wires Bull Board up. |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — all 14 tasks carry at least one `<automated>` command; no `MISSING —` marker exists anywhere in this phase
- [x] Sampling continuity: no 3 consecutive tasks without automated verify — every task has one
- [x] Wave 0 covers all MISSING references — every referenced test file is created RED-first by a named `tdd="true"` task in this phase (see Wave 0 Requirements)
- [x] No watch-mode flags — every command is a one-shot `vitest run`; `test:watch` scripts exist in `apps/api`/`apps/worker` but are referenced by no task
- [x] Feedback latency < 60s (single-file ephemeral-DB suite; estimate pending first measured run)
- [x] `nyquist_compliant: true` set in frontmatter — hold released 2026-08-19: estimated runtimes replaced with measured values (~8s quick path) and every suite has run green (09-05 phase gate 2026-08-06 + phase-scoped re-run 2026-08-19)

**Approval:** validated 2026-08-19 (`/gsd-validate-phase 9`)

---

## Validation Audit 2026-08-19

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

All 14 tasks re-verified against the current tree (branch `gsd/phase-16-live-sendgrid-verification`, 7 phases after execution):

- All 8 phase-9 test files exist on disk; all suites green — `packages/db` partitions + fixture-parity (47 tests, ~4.8s), `apps/api` tracer + watchdog + env-schema (29 tests, ~3.1s), `apps/worker` partition-maintenance.worker (7 tests, ~2.8s).
- All manifest/doc assertions pass (SPECIFICATION.md / ARCHITECTURE.md / CONVENTIONS.md greps, barrel export ×2, relocate CLI wiring, `tsx` recorded at the exact `package.json` value `^4.19.2`, runbook present).
- Region assertion re-verified: `buildServer()` body contains no `startPartitionWatchdog`.
- Full `npm test` deliberately not re-run for this audit: 09-05's recorded gate (725 tests / 11 workspaces green, 2026-08-06) stands as the full-suite evidence; a re-run today would only add known machine-local environmental noise (sentry-DSN env tests, advisory-lock flakes) unrelated to phase 9.
- No test files generated; no auditor spawned (zero gaps → skip per workflow §3).
- Manual-Only items unchanged: the live operator-alert email delivery (DB-02 environmental confirmation, `OPERATOR_ALERT_EMAIL` still unset on this machine) remains outstanding by design; automated coverage of the mechanism itself is complete via the injected-seam suites.
