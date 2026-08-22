---
phase: 21-per-contact-dsr-export
plan: 02
subsystem: compliance
tags: [gdpr, dsr, allowlist, delivery-core, erasure, jsonb, drizzle]

# Dependency graph
requires:
  - phase: 13-compliance-analytics-integrity
    provides: SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST + buildScrubbedSendEventPayload/buildScrubbedEventProperties (erasure scrub, build-up allowlist precedent)
provides:
  - Single shared definition of the send_events.payload JSONB disclosure rule in @mega-crm/delivery-core, importable by both apps/api (export) and apps/worker (erasure)
  - SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST as a structural superset of the evidence allowlist, plus buildExportSendEventPayload
  - docs/PII-INVENTORY.md — the per-table PII inventory Phase 22's purge will cite
affects: [22-workspace-quiesce-physical-purge, 21-per-contact-dsr-export other plans reading/exporting send_events.payload]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Build-up allowlist reconstruction (never tear-down/denylist) for freeform tenant JSONB, now shared across two runtimes via one package"
    - "Export allowlist declared as a spread of the evidence allowlist, making the superset relationship structural and test-asserted rather than a comment-only promise"

key-files:
  created:
    - packages/delivery-core/src/send-event-payload-allowlist.ts
    - packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts
    - docs/PII-INVENTORY.md
  modified:
    - packages/delivery-core/src/index.ts
    - apps/worker/src/queues/erasure-scrub.worker.ts

key-decisions:
  - "D-02/D-03 implemented exactly as decided at discuss-phase: export allowlist is a spread-based structural superset of the evidence allowlist, both live in @mega-crm/delivery-core as the single shared definition"
  - "SPECIFICATION.md intentionally NOT touched — plan 21-06 owns §1.2 for Wave-1 file-ownership exclusivity; this plan's package-export surface change will be recorded there by that plan"

patterns-established:
  - "Two build-up functions (buildScrubbedSendEventPayload, buildExportSendEventPayload) are structurally parallel over two related allowlists, so a reviewer can see the only difference is which allowlist each reads"

requirements-completed: [DSR-03]

coverage:
  - id: D1
    description: "SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST, buildScrubbedSendEventPayload, buildScrubbedEventProperties, ERASURE_SCRUB_PAGE_LIMIT relocated to @mega-crm/delivery-core with exactly one definition each, imported by the worker"
    requirement: "DSR-03"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/erasure-scrub.test.ts (23 tests, unchanged file)"
        status: pass
      - kind: other
        ref: "grep -c 'SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST = \\[' apps/worker/src/queues/erasure-scrub.worker.ts == 0; same grep against packages/delivery-core/src/send-event-payload-allowlist.ts == 1"
        status: pass
    human_judgment: false
  - id: D2
    description: "SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST is a structural superset of the evidence allowlist (spread-based), adding exactly ip/useragent/url/reason, asserted by a test"
    requirement: "DSR-03"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts > 'export allowlist is a superset of the evidence allowlist' + 'export allowlist adds exactly the subject's own single-recipient fields'"
        status: pass
    human_judgment: false
  - id: D3
    description: "buildExportSendEventPayload builds up (never tears down), returns {} for null/array/non-object, omits absent keys rather than nulling them, is idempotent"
    requirement: "DSR-03"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts > buildExportSendEventPayload describe block (5 tests)"
        status: pass
    human_judgment: false
  - id: D4
    description: "buildScrubbedEventProperties still returns {} for every input — events.properties has no allowlist on either path (D-01)"
    requirement: "DSR-03"
    verification:
      - kind: unit
        ref: "packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts > 'buildScrubbedEventProperties returns {} for every input'"
        status: pass
    human_judgment: false
  - id: D5
    description: "docs/PII-INVENTORY.md enumerates, per table, which columns count as personal data for export/purge, with an explicit reason for every excluded table"
    requirement: "DSR-03"
    verification:
      - kind: other
        ref: "grep -q for SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST/flow_run_steps/campaign_recipients/workspace_suppressions/send_event_quarantine against docs/PII-INVENTORY.md — all pass"
        status: pass
      - kind: other
        ref: "npm run check:root-hygiene"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-08-22
status: complete
---

# Phase 21 Plan 02: JSONB Allowlist Relocation & PII Inventory Summary

**Moved the erasure-scrub JSONB allowlist into `@mega-crm/delivery-core`, added a structurally-superset DSR export allowlist (spread + set-difference test), and wrote `docs/PII-INVENTORY.md` as the shared per-table PII definition Phase 22's purge will cite.**

## Performance

- **Duration:** 35 min
- **Started:** 2026-08-22T16:19:00Z
- **Completed:** 2026-08-22T16:29:00Z
- **Tasks:** 2
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments

- `SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST`, `buildScrubbedSendEventPayload`, `buildScrubbedEventProperties`, `ERASURE_SCRUB_PAGE_LIMIT` now have exactly one definition in the monorepo (`@mega-crm/delivery-core`), imported by `apps/worker`'s erasure-scrub worker for its own internal call sites and re-exported for its unchanged test suite.
- Added `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST`, declared as a TypeScript spread of the evidence list plus `ip`/`useragent`/`url`/`reason` — the export ⊇ evidence relationship is structural, not a comment, and is asserted by a set-difference test that fails on any undecided future addition.
- Added `buildExportSendEventPayload`, the export-side build-up counterpart to `buildScrubbedSendEventPayload`, with identical null/array/non-object handling and omit-rather-than-null-fill semantics, proven idempotent and non-leaking of a synthetic other-subject email nested in a tenant-invented key.
- Wrote `docs/PII-INVENTORY.md`: per-table inventory naming all 9 included groups (`contacts`, `contacts.properties`, `subscription_status_history`, `events`, `sends`, `send_events`, `flow_runs`, `flow_run_steps`, `campaign_recipients`) and 4 excluded groups (`workspace_suppressions`, `send_event_quarantine`, `erasure_records`, checkpoint/plumbing tables), each excluded row carrying a written reason, plus the erased-contact refusal note and the "Consumed by" section naming both Phase 21's export repository (forward reference — not yet built) and Phase 22's purge.

## Task Commits

Each task was committed atomically (Task 1 is `tdd="true"`, RED → GREEN):

1. **Task 1 RED: failing test for export superset** - `45a15b1` (test)
2. **Task 1 GREEN: relocate allowlist + add export superset** - `51435ba` (feat)
3. **Task 2: PII inventory doc** - `54a9265` (docs)

**Plan metadata:** committed separately per worktree protocol (SUMMARY.md commit, this file).

## Files Created/Modified

- `packages/delivery-core/src/send-event-payload-allowlist.ts` - the single shared definition: both allowlists + `buildScrubbedSendEventPayload`/`buildExportSendEventPayload`/`buildScrubbedEventProperties`/`ERASURE_SCRUB_PAGE_LIMIT`
- `packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts` - superset assertion + build-up behavior coverage for both builders
- `packages/delivery-core/src/index.ts` - named re-export block for the six new symbols
- `apps/worker/src/queues/erasure-scrub.worker.ts` - the four relocated definitions replaced with an import (for internal call sites `scrubSendEventsPage`/`scrubEventsPage`) plus an explicit `export { ... }` so `erasure-scrub.test.ts` keeps importing unchanged
- `docs/PII-INVENTORY.md` - the per-table PII inventory Phase 22's purge will cite

## Decisions Made

- Followed D-02/D-03 exactly as decided at discuss-phase: shared package location is `@mega-crm/delivery-core` (already a dependency of both `apps/api` and `apps/worker`), export allowlist declared as a spread for structural superset, no denylist/regex anywhere on either path.
- Did not touch `SPECIFICATION.md` even though CLAUDE.md's same-change rule would normally require documenting a new package export surface — plan 21-02 explicitly defers §1.2 ownership to plan 21-06 for Wave-1 file-ownership exclusivity (stated in the plan body under "Artifacts this phase produces"). Flagging this here so the verifier does not read the omission as a missed same-change update.

## Deviations from Plan

**1. [Environment] Worktree module resolution required a temporary local `node_modules/@mega-crm/delivery-core` symlink to test the GREEN state**
- **Found during:** Task 1, running `apps/worker`'s test suite against the relocated allowlist
- **Issue:** This worktree has no local `node_modules`; Node's module resolution walked up past the worktree root to the main checkout's `node_modules/@mega-crm/delivery-core` symlink, which points at the main checkout's OWN (unmodified) `packages/delivery-core`. The worker's tests therefore called the *pre-relocation* `delivery-core` and failed with `buildScrubbedSendEventPayload is not a function`, even though the worktree's own `packages/delivery-core/src/send-event-payload-allowlist.ts` was correct.
- **Fix:** Created a temporary symlink `<worktree>/node_modules/@mega-crm/delivery-core -> ../../packages/delivery-core` (relative, pointing at the worktree's own package) so Node's upward resolution stopped at the worktree before reaching the main checkout. Re-ran both `packages/delivery-core` and `apps/worker` test suites successfully, then **deleted the entire temporary `node_modules` directory** before committing, per this worktree's project safety rules (no untracked helper files left behind).
- **Files modified:** none (the symlink was created and removed outside version control; `git status --short` was clean of it before every commit)
- **Verification:** `git status --short` after removal showed only the intended source changes; both scoped test files and the full `apps/worker`/`packages/delivery-core` suites were re-run green after the symlink was in place, then the symlink was removed and no further test run was needed since no source files changed after that point.
- **Committed in:** N/A (no commit includes the symlink; it never touched the working tree state at commit time)

---

**Total deviations:** 1 auto-fixed (environment/tooling, no code change), 0 architectural.
**Impact on plan:** None on scope — this was purely a local test-environment workaround to correctly exercise the worktree's own code; no plan file, source file, or test file was altered because of it.

## Issues Encountered

- `npm run lint` (repo-wide) fails with 4 pre-existing `@typescript-eslint` errors in `apps/web/src/lib/sentry.ts`, a file untouched by this plan — confirmed via `git status --short` (no `apps/web` changes) and via scoped `eslint` run against exactly this plan's touched files (`packages/delivery-core/src/send-event-payload-allowlist.ts`, `packages/delivery-core/src/index.ts`, `packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts`, `apps/worker/src/queues/erasure-scrub.worker.ts`), which is clean. Out of scope per the executor's scope-boundary rule; not fixed.
- `npm run test -w apps/worker` (full suite) has exactly one pre-existing failure: `sentry.test.ts > with no DSN configured, does not throw and leaves the SDK uninitialized`. This is the documented, deterministic environmental quirk on this machine (real Sentry DSNs live in `~/.config/mega-crm/.env` since the Phase 16 UAT) — passes in CI. 660/661 tests pass; the scoped `erasure-scrub.test.ts` run (this plan's actual verification target) is 23/23 green.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The shared allowlist package and PII inventory are ready for the remaining Phase 21 plans (the export route/repository, UI) to consume `SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST` / `buildExportSendEventPayload` directly from `@mega-crm/delivery-core`, and for Phase 22's purge planning to cite `docs/PII-INVENTORY.md` and the same shared constants.
- No blockers. `SPECIFICATION.md` §1.2 update for this package's new export surface remains plan 21-06's responsibility, as scoped.

---
*Phase: 21-per-contact-dsr-export*
*Completed: 2026-08-22*

## Self-Check: PASSED

All created files verified present on disk (`packages/delivery-core/src/send-event-payload-allowlist.ts`, `packages/delivery-core/src/__tests__/send-event-payload-allowlist.test.ts`, `docs/PII-INVENTORY.md`, this SUMMARY.md); all four commit hashes (`45a15b1`, `51435ba`, `54a9265`, `8984c68`) verified present in `git log`.
