---
phase: 21-per-contact-dsr-export
plan: 06
subsystem: api
tags: [postgres, drizzle, fastify, zod, dsr, gdpr, migrations]

# Dependency graph
requires:
  - phase: 21-per-contact-dsr-export (plans 21-01..21-05)
    provides: the six-section DSR export document (metadata/profile/customProperties/consentHistory/events/sends+sendEvents), the withTenantTransactionRepeatableRead-scoped repository, the walkToExhaustion keyset helper, and the relocated send-event payload allowlists in @mega-crm/delivery-core
provides:
  - flowParticipation and campaignMemberships sections completing the eight-section DSR export document
  - three new page readers (selectFlowRunsPage, selectFlowRunStepsPage, selectCampaignRecipientsPage) plus the batching walkFlowRunStepsToExhaustion helper
  - migration 0067 (idx_flow_runs_workspace_contact, idx_campaign_recipients_workspace_contact, idx_flow_run_steps_flow_run_id)
  - SPECIFICATION.md as-built record for the export route, permission resource, indexes, migration, and the relocated delivery-core allowlist package
  - COVERAGE.md external-API declaration for Phase 21
affects: [phase-22-workspace-quiesce-physical-purge]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Journey-table export walk: no status predicate on flow_runs (every status is GDPR Art. 15 processing history), batched flow_run_steps lookup via ANY($::uuid[]) chunked to the page limit"
    - "SQL-only, additive migrations get no drizzle schema mirror and no snapshot file (same precedent as 0065)"

key-files:
  created:
    - packages/db/migrations/0067_dsr_export_contact_indexes.sql
    - .planning/phases/21-per-contact-dsr-export/COVERAGE.md
  modified:
    - apps/api/src/modules/contacts/dsr-export.repository.ts
    - apps/api/src/modules/contacts/__tests__/dsr-export.test.ts
    - packages/shared-schemas/src/dsr-export.ts
    - packages/db/migrations/meta/_journal.json
    - packages/db/src/migration-tiers.ts
    - packages/db/src/__tests__/migration-tiers.test.ts
    - packages/db/src/__tests__/migration-rollback-rehearsal.test.ts
    - packages/db/src/__tests__/migration-empty-diff.test.ts
    - SPECIFICATION.md

key-decisions:
  - "flow_runs read carries no status predicate — the only pre-existing contact-scoped index (flow_runs_one_active_per_contact) is partial over waiting/advancing, and an implementation shaped by it would silently drop completed/exited/ejected processing history"
  - "flow_run_steps walked via a batched ANY($::uuid[]) lookup (walkFlowRunStepsToExhaustion), chunked to DSR_EXPORT_PAGE_LIMIT groups, since the table carries no contact_id of its own"
  - "Migration 0067 classified auto-reversible (three plain CREATE INDEX, no table/column/constraint) with a hand-verified DROP INDEX inverse registered in migration-rollback-rehearsal.test.ts"

patterns-established:
  - "New auto-reversible migration requires: migration-tiers.ts classification, MIGRATION_INVERSES entry, and updates to migration-tiers.test.ts's/migration-empty-diff.test.ts's pinned literals — the same category of change 0066 itself required"

requirements-completed: [DSR-02, DSR-03]

coverage:
  - id: D1
    description: "flowParticipation section: every flow_runs row for the contact across all statuses (including terminal), nested flow_run_steps in chronological order"
    requirement: "DSR-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#flow participation: runs of every status are exported, oldest first, with their steps (DSR-02, D-04)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#flow participation: a terminal run is not filtered out (DSR-02, D-04)"
        status: pass
    human_judgment: false
  - id: D2
    description: "campaignMemberships section: every campaign_recipients row for the contact, ordered oldest first"
    requirement: "DSR-02"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#campaign memberships: every campaign that targeted this contact is exported (DSR-02, D-04)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Journey sections are contact-scoped (isolation) and empty-but-counted when a contact has neither"
    requirement: "DSR-03"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#journey sections: another contact's runs and memberships are absent (DSR-02, D-04)"
        status: pass
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#journey sections: a contact with neither exports two empty arrays with counts of 0 (DSR-02, D-04)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Document has exactly the eight D-05 sections, every metadata.sectionRowCounts key equals a real array length"
    verification:
      - kind: unit
        ref: "apps/api/src/modules/contacts/__tests__/dsr-export.test.ts#the document now has all eight sections, every count verified against a real length (D-05, D-06)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Migration 0067 creates the three missing contact-scoped indexes and is applied by both migration test paths"
    verification:
      - kind: integration
        ref: "npm run lint:migrations"
        status: pass
      - kind: integration
        ref: "npm run test:migrations (packages/db, 30 files / 246 passed / 1 skipped)"
        status: pass
    human_judgment: false
  - id: D6
    description: "SPECIFICATION.md and COVERAGE.md are as-built accurate for this plan's changes"
    verification:
      - kind: other
        ref: "npm run check:spec-env-coverage (55 names checked, all present)"
        status: pass
      - kind: other
        ref: "npm run check:runbook-coverage (4 alerts checked, all covered)"
        status: pass
    human_judgment: true
    rationale: "Prose accuracy (route/gate/status-code/index descriptions matching the actual code) was spot-checked by the executor via grep against the source files, but a documentation-quality review is best confirmed by a human reader, not an automated script."

# Metrics
duration: ~2h
completed: 2026-08-22
status: complete
---

# Phase 21 Plan 06: Journey Sections + Contact-Scoped Indexes + As-Built Docs Summary

**Adds `flowParticipation`/`campaignMemberships` to the DSR export (completing all eight D-05 sections), ships migration 0067's three contact-scoped indexes, and lands the Phase 21 SPECIFICATION.md/COVERAGE.md as-built record in one branch.**

## Performance

- **Duration:** ~2h
- **Tasks:** 3 (all `type="auto"`; Task 1 also `tdd="true"`)
- **Files modified:** 10 (2 created, 8 modified)

## Accomplishments

- `dsr-export.repository.ts` gained `selectFlowRunsPage`, `selectFlowRunStepsPage`, `selectCampaignRecipientsPage` and the batching helper `walkFlowRunStepsToExhaustion`; `getDsrExportDocument` now returns all eight D-05 sections with a verifiable count per section (including the two nested counts, `flowRunSteps`/`sendEvents`, tracked separately from their parent arrays).
- `flow_runs` is read with **no status predicate** — every run status, including `completed`/`exited`/`ejected`, is exported as GDPR Art. 15 processing history, deliberately not leaning on the pre-existing `flow_runs_one_active_per_contact` partial index (which only covers `waiting`/`advancing`).
- Migration `0067_dsr_export_contact_indexes.sql` adds `idx_flow_runs_workspace_contact`, `idx_campaign_recipients_workspace_contact`, `idx_flow_run_steps_flow_run_id` — closing the index gap 21-RESEARCH.md's Pitfall 2 verified and making REQUIREMENTS.md's synchronous-export justification true rather than half-true.
- `SPECIFICATION.md` records the export route (§6.5 table row + new §6.5.3), the `contact: ["export"]` permission resource, the three new indexes (§4.5, with `campaign_recipients`/`flow_run_steps` removed from the "no explicit index" list to avoid self-contradiction), the migration (§4.6, corrected journal-count/newest-tag/trailing-run literals), the relocated `@mega-crm/delivery-core` allowlist package (§1.2), and an explicit "no new dependency" note (§2.9).
- `.planning/phases/21-per-contact-dsr-export/COVERAGE.md` declares this phase integrates no external API.

## Task Commits

Each task was committed atomically (Task 1 as a TDD RED→GREEN pair):

1. **Task 1 RED: failing tests for flowParticipation/campaignMemberships** - `438d86e` (test)
2. **Task 1 GREEN: flowParticipation and campaignMemberships export sections** - `83a8877` (feat)
3. **Task 2: migration 0067 + contact-scoped indexes** - `5e8346c` (feat)
4. **Task 3: SPECIFICATION.md + COVERAGE.md as-built record** - `bd0e204` (docs)

_TDD gate compliance: a `test(...)` commit (438d86e) precedes a `feat(...)` commit (83a8877) for Task 1, per plan frontmatter `tdd="true"`. No refactor commit was needed._

## Files Created/Modified

- `apps/api/src/modules/contacts/dsr-export.repository.ts` - three new page readers, `walkFlowRunStepsToExhaustion`, wiring into `getDsrExportDocument`
- `apps/api/src/modules/contacts/__tests__/dsr-export.test.ts` - six new test cases (journey sections, isolation, eight-section completeness) plus flow/campaign seeding helpers
- `packages/shared-schemas/src/dsr-export.ts` - `dsrExportFlowRunSchema`, `dsrExportFlowRunStepSchema`, `dsrExportCampaignMembershipSchema`, wired into `dsrExportDocumentSchema`
- `packages/db/migrations/0067_dsr_export_contact_indexes.sql` - the three new indexes + `COMMENT ON INDEX` for each
- `packages/db/migrations/meta/_journal.json` - `idx: 67` entry appended
- `packages/db/src/migration-tiers.ts` - `0067_dsr_export_contact_indexes: "auto-reversible"` classification
- `packages/db/src/__tests__/migration-rollback-rehearsal.test.ts` - `MIGRATION_INVERSES` entry (three `DROP INDEX` statements) + doc-comment bullet
- `packages/db/src/__tests__/migration-tiers.test.ts` - pinned trailing-run literal updated to the two-element array
- `packages/db/src/__tests__/migration-empty-diff.test.ts` - `shippedMigrationCount`/journal-newest-tag literals updated (68 / `0067_dsr_export_contact_indexes`)
- `SPECIFICATION.md` - §1.2, §2.9 (new), §4.5, §4.6, §6.5 table row + new §6.5.3
- `.planning/phases/21-per-contact-dsr-export/COVERAGE.md` - the phase's external-API declaration line

## Decisions Made

- Included an `id` field on both the `flowParticipation` and `campaignMemberships` row shapes (not explicitly named in the plan's `<behavior>` text) for consistency with the existing `sends`/`sendEvents` precedent and to give each nested `steps` group a stable key; no test asserts an exact key set on these nested rows, so this is additive, not a deviation from any assertion.
- Migration 0067 is SQL-only and deliberately does **not** get a drizzle schema mirror or a new snapshot file — same precedent this repository already established for 0049/0052/0065 (index/grant-only migrations).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Migration 0067 required updates to three pre-existing test files' hardcoded literals**
- **Found during:** Task 2, running `npm run test:migrations` after adding the migration and journal entry
- **Issue:** `packages/db/src/migration-tiers.ts` throws for any journal tag it hasn't classified (`tierFor: unknown migration tag "0067_dsr_export_contact_indexes"`), and two test files (`migration-tiers.test.ts`, `migration-empty-diff.test.ts`) pin exact literals (trailing auto-reversible run, shipped migration count, journal's newest tag) that a new migration necessarily changes — the same category of update 0066 itself required when it shipped (per SPECIFICATION.md §4.6's own note that these counts aren't recalculated per phase).
- **Fix:** Classified `0067_dsr_export_contact_indexes` as `auto-reversible` in `migration-tiers.ts`; added a hand-verified `DROP INDEX` inverse (all three indexes) to `migration-rollback-rehearsal.test.ts`'s `MIGRATION_INVERSES` registry with a doc-comment bullet explaining why it's safe (pure additive index DDL, no data touched); updated `migration-tiers.test.ts`'s pinned trailing-run array to `["0066_campaigns_version", "0067_dsr_export_contact_indexes"]`; updated `migration-empty-diff.test.ts`'s `shippedMigrationCount` (67→68) and journal-newest-tag (`0066_campaigns_version`→`0067_dsr_export_contact_indexes`) assertions, leaving `comparedAgainstSnapshot`/`snapshotFileCount` unchanged since 0067 ships no schema-file change and therefore no new snapshot.
- **Files modified:** `packages/db/src/migration-tiers.ts`, `packages/db/src/__tests__/migration-rollback-rehearsal.test.ts`, `packages/db/src/__tests__/migration-tiers.test.ts`, `packages/db/src/__tests__/migration-empty-diff.test.ts`
- **Verification:** `npm run test:migrations` — 30 test files, 246 passed / 1 skipped, 0 failed
- **Committed in:** `5e8346c` (Task 2 commit)

**2. [Rule 1 - Bug] Fixed an unused test variable caught by lint**
- **Found during:** Task 1, running `npm run lint` after the GREEN implementation
- **Issue:** `run2Id` in the new "runs of every status" test was assigned but never read (`@typescript-eslint/no-unused-vars`).
- **Fix:** Dropped the unused binding (`await seedFlowRun(...)` instead of `const run2Id = await seedFlowRun(...)`).
- **Files modified:** `apps/api/src/modules/contacts/__tests__/dsr-export.test.ts`
- **Verification:** `npm run lint` — 0 errors in files this plan touched
- **Committed in:** `83a8877` (Task 1 GREEN commit)

---

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking, 1 Rule 1 bug)
**Impact on plan:** Both necessary for `npm run test:migrations`/`npm run lint` to pass on the files this plan touched. No scope creep — no unrelated file was modified.

## Issues Encountered

- **Pre-existing, out-of-scope lint failures (not fixed, per scope-boundary rule):** `apps/web/src/lib/sentry.ts:98,99,121` — `@typescript-eslint/no-unsafe-assignment`/`no-unsafe-member-access` on `import.meta.env`. Confirmed identical at the worktree's base commit (`69be700`, via `git show <base>:apps/web/src/lib/sentry.ts`), last touched in Phase 15 (commit `336da68`). Logged in `.planning/phases/21-per-contact-dsr-export/deferred-items.md`.
- **`grep -c 'withTenantTransactionRepeatableRead' apps/api/src/modules/contacts/dsr-export.repository.ts` returns 3, not the plan's stated "still 1"** — the count includes the import line and one doc-comment mention, in addition to the single actual call site. This was already true before this plan's changes (verified by reading the pre-existing file); the substantive invariant the criterion cares about — exactly one transaction opened per export — is unchanged and holds (no new call to the function was added).
- **Full `npm run test` across all workspaces is not 100% green in this environment, but every failure is pre-existing/environmental and untouched by this plan's files:**
  - `apps/api`/`apps/worker` `sentry.test.ts` "no DSN configured" tests fail deterministically on this machine — real Sentry DSNs live in `~/.config/mega-crm/.env` since UAT (documented project memory: "Sentry DSN env test failures"); these pass in CI.
  - `apps/api`'s `webhooks-signature.test.ts` (BullMQ queue-depth assertion, `20811` vs `20810`) and `packages/db`'s `migrate-runner-advisory-lock.test.ts` (advisory-lock concurrency timing) both failed only under the full parallel suite, not when run in isolation earlier in this session — matches documented project memory ("dev-stack test gate flakes": advisory-lock tests flake under full-suite load).
  - `apps/worker`'s `stop-grace-period-publish.test.ts` and `apps/web`'s `playwright-package-source-import.test.ts` require a prior `npm run build -w apps/worker`/`apps/web` respectively (dist-file imports); this worktree only ran `npm run build -w apps/api` (this plan's own scope) plus the top-level `npm run build`, which failed for `apps/web` on an unrelated `vite/client` type-resolution error caused by this worktree's minimal `node_modules` (only `@mega-crm/*` packages were symlinked in — see Cleanup note below — not third-party deps like `vite`'s own type declarations), not by anything this plan changed.
  - None of the failing test files were touched by this plan. `apps/api`'s own full suite (82 files) ran green except the two items above; `apps/db`'s `test:migrations` (the plan's own required gate) is fully green; `packages/shared-schemas`'s and `apps/api`'s `dsr-export`/`dsr-export-isolation` suites are fully green.
- **Worktree infra note (per project safety rule #4):** this worktree ships with no `node_modules` at all; bare `@mega-crm/*` imports would otherwise resolve up through the worktree's ancestor directories to the main checkout's stale copies. Temporary symlinks (`node_modules/@mega-crm/{api,web,worker,contacts-core,db,delivery-core,flows-core,kms,queue-core,redaction,segments-core,shared-schemas,tenant-context,test-support}` → this worktree's own `apps/*`/`packages/*`) were created before running any test, used throughout, and removed before returning (verified via `git status --short --ignored`).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 21 (per-contact DSR export) is functionally complete: DSR-01 through DSR-04 are all covered across plans 21-01 through 21-06, with the export document now carrying all eight D-05 sections and a verifiable row count for each.
- Phase 22 (workspace quiesce & physical purge) inherits migration 0067's three contact-scoped indexes directly — its own contact-scoped scans of `flow_runs`/`campaign_recipients`/`flow_run_steps` ride the same indexes this plan added.
- No blockers. The phase-level `<verification>` block's automated checks (`dsr-export.test.ts`, `lint:migrations`+`test:migrations`, `check:spec-env-coverage`+`check:runbook-coverage`) all pass; the orchestrator's own phase-gate run of `npm run test`/`npm run lint`/`npm run build` across all workspaces should expect the same pre-existing, environment-specific failures documented above under "Issues Encountered" (none in files this plan touched).

## Self-Check: PASSED

All claimed files verified to exist on disk (`dsr-export.repository.ts`, `dsr-export.ts`, `0067_dsr_export_contact_indexes.sql`, `COVERAGE.md`, this `SUMMARY.md`), and all four claimed commit hashes (`438d86e`, `83a8877`, `5e8346c`, `bd0e204`) verified present in `git log --oneline --all`.

---
*Phase: 21-per-contact-dsr-export*
*Completed: 2026-08-22*
