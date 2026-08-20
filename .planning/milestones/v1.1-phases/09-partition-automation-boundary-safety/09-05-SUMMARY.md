---
phase: 09-partition-automation-boundary-safety
plan: 05
subsystem: database
tags: [documentation, specification, architecture, conventions, postgresql, partitioning, phase-gate]

# Dependency graph
requires:
  - phase: 09-partition-automation-boundary-safety
    provides: "09-01: migration 0038, ensurePartitions/attachPartitionCheckFirst/computeBufferMonths, runPartitionMaintenance, the watchdog module (unwired)"
  - phase: 09-partition-automation-boundary-safety
    provides: "09-02: partition-maintenance.worker.ts (daily job-scheduler tick + boot immediate run), OPERATOR_ALERT_EMAIL boot-required, startPartitionWatchdog armed in apps/api's main()"
  - phase: 09-partition-automation-boundary-safety
    provides: "09-03: partition-maintenance-runs.ts Drizzle schema, ensurePartitions wired into the test-support fixture, 13 boundary/precision tests"
  - phase: 09-partition-automation-boundary-safety
    provides: "09-04: relocateAllDefaultRows/relocateMonth, operator CLI, runbook, migration 0039 (partition_relocation_admin_scan RLS policy on contacts/sends)"
provides:
  - "SPECIFICATION.md sections 2, 3, 5, 6, 7, 8, 9, 10 updated to the as-built state of everything phase 9 shipped, including two undocumented mid-phase deviations: the 0039 admin-scan RLS policy and the two-pool discipline"
  - "ARCHITECTURE.md §6: the partition horizon and two-process dead-man's-switch described as a boundary/flow, not an implementation note; the stale 'no code creates future partitions' forward-looking entry removed"
  - "CONVENTIONS.md: three binding rules — single-source partition DDL, never a tenant-scoped connection for ensurePartitions/attachPartitionCheckFirst/runPartitionMaintenance, and the job-scheduler-vs-interval registration distinction"
  - "Phase gate: full repository lint/lint:migrations/build/test green (11/11 workspaces); the two phase-specific suites green; a catalog query against a freshly migrated ephemeral database confirms 20 attached monthly partitions (10+10, 2026-09..2027-06, all relispartition=true), closing the 2026-09-01 deadline as a verified fact"
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - SPECIFICATION.md
    - ARCHITECTURE.md
    - CONVENTIONS.md

key-decisions:
  - "Documented the two mid-phase deviations from 09-04 (the 0039 admin-scan RLS policy on contacts/sends) and from 09-03/09-04 (the two-pool discipline for any ensurePartitions caller) as first-class SPECIFICATION.md/ARCHITECTURE.md/CONVENTIONS.md content rather than leaving them as SUMMARY-only history, per this plan's own upstream-state briefing"
  - "Ran the 2026-09-01 deadline confirmation against a purpose-built, fully migrated, throwaway ephemeral database rather than the shared local dev/test database — matching 09-04's own documented discipline against disturbing state a parallel executor might depend on"
  - "Recorded the live operator-alert email confirmation as an outstanding verification rather than fabricating a pass: OPERATOR_ALERT_EMAIL is absent from this machine's externally-resolved env file, and no interactive human is present in this autonomous worktree run to read an inbox even if it were configured"

requirements-completed: [DB-01, DB-02, DB-03, DB-04]

coverage:
  - id: D1
    description: "SPECIFICATION.md records the as-built state of everything phase 9 added: tsx devDependency, OPERATOR_ALERT_EMAIL, migration 0038/0039, partition_maintenance_runs, the partition-maintenance queue and its cron schedule, the apps/api background watchdog interval, and the Bull Board divergence"
    requirement: DB-01
    verification:
      - kind: other
        ref: "grep -q 'partition_maintenance_runs' SPECIFICATION.md && grep -q 'OPERATOR_ALERT_EMAIL' SPECIFICATION.md && grep -q '0038_partition_catchup_and_maintenance_runs' SPECIFICATION.md && grep -q 'partition-maintenance' SPECIFICATION.md (verify gate)"
        status: pass
      - kind: other
        ref: "node -e tsx-literal-version assertion against packages/db/package.json (verify gate)"
        status: pass
    human_judgment: false
  - id: D2
    description: "ARCHITECTURE.md describes the partition horizon and the two-process dead-man's-switch as a boundary and data flow"
    requirement: DB-02
    verification:
      - kind: other
        ref: "grep -qi 'partition' ARCHITECTURE.md && grep -q 'partition_maintenance_runs' ARCHITECTURE.md (verify gate)"
        status: pass
    human_judgment: false
  - id: D3
    description: "CONVENTIONS.md binds single-source partition DDL and the job-scheduler registration form for fixed-hour ticks"
    requirement: DB-03
    verification:
      - kind: other
        ref: "grep -q 'ensurePartitions' CONVENTIONS.md && grep -q 'PARTITIONED_TABLES' CONVENTIONS.md (verify gate)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every requirement (DB-01..DB-04) has a named automated command demonstrating it, and the full repository suite is green"
    requirement: DB-04
    verification:
      - kind: integration
        ref: "npm run lint / npm run lint:migrations / npm run build / npm test (all 11 workspaces green)"
        status: pass
      - kind: integration
        ref: "npx vitest run --root packages/db src/partitions/__tests__/ (23 tests) and --root apps/api src/modules/ops/__tests__/ (13 tests)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The 2026-09-01 deadline is confirmed closed by inspecting a migrated database (20 attached monthly partitions, all relispartition=true), not by trusting the automation alone"
    requirement: DB-01
    verification:
      - kind: integration
        ref: "catalog query against a freshly created, fully migrated ephemeral database (mega_crm_test_gate09_05_*) confirms events×10 + send_events×10 partitions covering 2026-09..2027-06, all relispartition=true"
        status: pass
    human_judgment: false
  - id: D6
    description: "The live operator alert email has been observed arriving at a real inbox, or its absence is recorded with a reason"
    verification: []
    human_judgment: true
    rationale: "Requires a human to read a real inbox after a real SendGrid send. OPERATOR_ALERT_EMAIL is unset in this machine's externally-resolved env file (~/.config/mega-crm/.env), and this plan executed as an unattended autonomous worktree run with no human present to observe delivery even if it were configured. Recorded as outstanding per the plan's own explicit instruction, not silently absorbed into a green phase."

duration: 14min
completed: 2026-08-06
status: complete
---

# Phase 9 Plan 5: Binding-Document As-Built Update & Phase Gate Summary

**SPECIFICATION.md/ARCHITECTURE.md/CONVENTIONS.md brought up to phase 9's actual as-built state (including the two mid-phase deviations 09-03/09-04 discovered — the 0039 admin-scan RLS policy and the two-pool discipline); full repository gate green; a catalog query against a freshly migrated ephemeral database confirms the 2026-09-01 deadline is closed by fact, not assumption; live operator-alert email delivery recorded as an outstanding verification.**

## Performance

- **Duration:** ~14 min
- **Started:** 2026-08-06T17:21:31Z
- **Completed:** 2026-08-06T17:35:33Z
- **Tasks:** 3 (task 1: auto; task 2: auto; task 3: auto)
- **Files modified:** 3 (SPECIFICATION.md, ARCHITECTURE.md, CONVENTIONS.md — no code files)

## Accomplishments

- **SPECIFICATION.md** updated section by section against the code, not the plans: §2 records `tsx` at its literal `packages/db/package.json` version and states no third-party package was added by 09-05 itself; §3 records `OPERATOR_ALERT_EMAIL` (reader, validation, no new secret material — reuses the existing `PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM` pair) in both the env-var table and the `check-env.mjs` predev list; §5 documents the `partition-maintenance` BullMQ queue (job-scheduler registration, `0 3 * * *` UTC cron, `removeOnFail: false`, the boot-time immediate job, the `LOOKAHEAD_MONTHS`/`BUFFER_ALERT_THRESHOLD_MONTHS` constants) as the first use of `upsertJobScheduler` in this codebase; §6 records the `apps/api` background watchdog interval as the phase's only new non-HTTP surface, explicitly stating no route/plugin/parser/auth/rate-limit was added; §7 corrects the stale "not yet wired" note now that 09-02 armed the watchdog at boot, and records the persisted health signal, the single plain-text push channel, and the honest Bull Board gap; §8 ties the existing Bull Board divergence row to this phase's alert design; §9 closes the "no partition maintenance code" review item and refreshes the admin-scan-policy and `defaultJobOptions`-duplication counts (8→9 files).
- **ARCHITECTURE.md** gains §6, describing the partition horizon and the two-process dead-man's-switch as a boundary and flow in the document's existing prose voice (no diagram, matching the document's own stated policy): one idempotent DDL function called from three places (daily tick, boot-time run, test fixture), a worker that writes health to Postgres and a watchdog that reads it from a genuinely separate process, and an explicit statement of what the arrangement makes loud (job stopped, horizon shrinking, DEFAULT holding rows) versus what it does not (dashboards, queue-depth alerting — Phase 15). The stale "Phase 9 — partition growth... no code creates future partitions" forward-looking entry is removed since it is now false.
- **CONVENTIONS.md** gains three binding rules under a new "Partition maintenance" section: (1) `ensurePartitions` is the single source of partition DDL, the CHECK-constraint-first sequence is unconditional on every attach, and a new partitioned table registers in `PARTITIONED_TABLES`; (2) a caller of `ensurePartitions`/`attachPartitionCheckFirst`/`runPartitionMaintenance` never uses a tenant-scoped connection — the two-pool discipline that 09-03 and 09-04 rediscovered independently, which is what makes it a rule rather than one test's incident; (3) a BullMQ tick needing a fixed wall-clock hour uses the job-scheduler form, with the four pre-existing interval-form ticks recorded as deliberate precedent, not drift.
- **Phase gate ran clean:** `npm run lint`, `npm run lint:migrations`, `npm run build`, `npm test` all exit 0 across all 11 workspaces (280 apps/api + 45 apps/web + 122 apps/worker + 36 packages/db + 70 delivery-core + 15 flows-core + 10 kms + 19 segments-core + 18 shared-schemas + 7 tenant-context + 103 test-support = 725 tests). The two phase-specific suites (`packages/db src/partitions/__tests__/` — 23 tests, `apps/api src/modules/ops/__tests__/` — 13 tests) are both green. A catalog query run against a purpose-built, fully migrated, throwaway ephemeral database (not the shared dev/test database) confirms 20 attached monthly partitions — `events`×10 and `send_events`×10 covering 2026-09 through 2027-06 — every one with `relispartition = true`, closing the hard 2026-09-01 deadline as an observed fact rather than an assumed consequence of a green test suite.

## Task Commits

Each task was committed atomically:

1. **Task 1: SPECIFICATION.md as-built record** - `ba437e6` (docs)
2. **Task 2: ARCHITECTURE.md and CONVENTIONS.md binding updates** - `67a9666` (docs)
3. **Task 3: Phase gate — per-requirement evidence, full suite, and live alert confirmation** - `0fdcddd` (docs)

_No test/feat commits — this plan is documentation and verification only, per its own frontmatter (`files_modified: [SPECIFICATION.md, ARCHITECTURE.md, CONVENTIONS.md]`). TDD gate does not apply: none of the three tasks is behavior-adding (no `<behavior>` block, no non-test source files touched)._

## Files Created/Modified

- `SPECIFICATION.md` - §2 (tsx devDependency, no-new-third-party-package note), §3 (OPERATOR_ALERT_EMAIL), §5 (partition-maintenance queue/scheduler/constants, 14th worker, job-scheduler-vs-interval distinction), §6 (apps/api background watchdog interval as the phase's only new non-HTTP surface), §7 (watchdog now wired, persisted health signal, single push channel, Bull Board gap), §8 (Bull Board divergence tied to this phase), §9 (closed the "no partition code" item, refreshed duplication counts, extended the admin-scan-policy item to 0039), §10 (verification date recorded)
- `ARCHITECTURE.md` - New §6 "Partition maintenance and the dead-man's switch"; removed the stale Phase 9 forward-looking entry
- `CONVENTIONS.md` - New "Partition maintenance" section with three binding rules (single-source DDL, no tenant-scoped connections for the partition-maintenance call path, job-scheduler vs. interval registration)

## Decisions Made

- **Documented both mid-phase deviations as first-class binding-document content, not left as SUMMARY-only history.** The 0039 admin-scan RLS policy (on `contacts`/`sends`) and the two-pool discipline (independently rediscovered by 09-03 and 09-04) are exactly the kind of change CLAUDE.md's SPECIFICATION.md rule and Phase 8's binding-update rule for ARCHITECTURE.md/CONVENTIONS.md exist to catch — a security-relevant RLS policy addition and a real architectural seam are not incidental test-fixture details.
- **Ran the deadline-confirmation catalog query against a purpose-built ephemeral database, not the shared local dev/test database.** The shared `mega_crm` dev database on this machine has NOT had migrations 0038/0039 applied (confirmed by direct inspection: only `events_2026_07`/`_08` + DEFAULT exist there) — migrating it as a side effect of this plan's verification step would be exactly the kind of parallel-executor interference 09-04's own SUMMARY documented and deliberately avoided. Created and dropped a dedicated `mega_crm_test_gate09_05_*` database instead, using the same `createEphemeralDatabase`/migration-runner/`ensurePartitions` primitives production and the test fixture both use.
- **Recorded the live operator-alert email confirmation as outstanding, not performed.** `OPERATOR_ALERT_EMAIL` is absent entirely from this machine's externally-resolved env file (`~/.config/mega-crm/.env`) — `PLATFORM_SENDGRID_API_KEY`/`PLATFORM_MAIL_FROM` are present and look real, but without `OPERATOR_ALERT_EMAIL` the watchdog has no address to alert, and this plan ran as an unattended autonomous worktree executor with no interactive human present to read an inbox even had the variable been set. The plan's own action text explicitly anticipates exactly this outcome ("If the live confirmation cannot be performed... record that explicitly... rather than marking the phase verified") rather than treating it as a blocking failure.

## Deviations from Plan

None - plan executed exactly as written. (The two deviations *described* in this plan's own upstream-state briefing were introduced by 09-03/09-04, not by this plan; this plan's job was to document them, which it did — see Decisions Made above.)

## Issues Encountered

- **`.planning/` is gitignored in this repository and did not exist in the freshly created worktree.** Copied it from the main checkout (`/Users/primeropanther/Projects/mega-crm/.planning`) into the worktree before reading any plan/context file, per this run's own instructions (the orchestrator copies the SUMMARY back out before removing the worktree).
- **Worktree had no `node_modules`.** Ran `npm ci --prefer-offline` from the worktree root before any lint/build/test step, matching every prior plan in this phase's own documented note.
- **The plan's `grep -q '0038_partition_catchup_and_maintenance_runs'` verify command required the literal migration filename string, which the document's existing style (backtick `0038` only) had never used anywhere.** Added one explicit filename reference (`packages/db/migrations/0038_partition_catchup_and_maintenance_runs.sql`) alongside the existing `0038` shorthand in §4.4, satisfying the check without changing the document's established citation style elsewhere.

## User Setup Required

**External service / environment configuration required to close the outstanding verification.** No `{phase}-USER-SETUP.md` was generated (this is a documentation-only phase-gate plan), but the specific gap blocking full phase closure is:

- Set `OPERATOR_ALERT_EMAIL` in this machine's externally-resolved env file (`~/.config/mega-crm/.env`, or wherever `MEGA_CRM_ENV_FILE` resolves to) to a real, readable inbox address.
- Confirm `PLATFORM_SENDGRID_API_KEY` and `PLATFORM_MAIL_FROM` (already present in this environment) correspond to a verified SendGrid sender.
- With both in place, boot the stack (`npm run dev`), manufacture an unhealthy partition-buffer state (drop enough future `events` partitions to fall below `BUFFER_ALERT_THRESHOLD_MONTHS`), let the watchdog poll (`WATCHDOG_INTERVAL_MS` = 15 min, or restart `apps/api` to force an immediate first poll), and confirm a plain-text email arrives at the configured address containing both table names, per-table buffer numbers, both DEFAULT counts, and a timestamp — and nothing else (no workspace id, contact id, event payload, or connection string). Restore the horizon and confirm the next poll sends nothing.

## Next Phase Readiness

- Phase 9 (partition automation & boundary safety) is functionally and documentarily complete: the 2026-09-01 deadline is closed by an inspected, migrated database, not by an assumption; the daily maintenance worker, the boot-time immediate run, the DEFAULT-relocation procedure and its operator CLI/runbook, and the two-process dead-man's-switch are all implemented, tested, and — as of 09-02 — wired into their respective process boot sequences.
- **One outstanding item carries forward:** the live operator-alert email has never been observed arriving at a real inbox on this machine. This is not a code gap — the mechanism is fully covered by injected-seam tests (13 tests across the tracer/watchdog suites) — it is an unperformed environmental verification, explicitly recorded rather than silently absorbed. Whoever next has access to a configured `OPERATOR_ALERT_EMAIL` and a verified SendGrid sender should perform the human-check steps in `09-05-PLAN.md`'s Task 3 `<verify><human-check>` block.
- No blockers for any later phase. This plan touched no code, only the three binding documents plus this SUMMARY.

## Self-Check: PASSED

All 3 modified files verified present with expected content on disk (`SPECIFICATION.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`); all 3 task commits (`ba437e6`, `67a9666`, `0fdcddd`) verified present in `git log --oneline`.

---
*Phase: 09-partition-automation-boundary-safety*
*Completed: 2026-08-06*
