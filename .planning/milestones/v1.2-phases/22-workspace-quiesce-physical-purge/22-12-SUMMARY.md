---
phase: 22-workspace-quiesce-physical-purge
plan: 12
subsystem: worker / compliance-docs
tags: [gap-closure, dead-letter, retention, pii-inventory, purge]
dependency-graph:
  requires: ["22-11"]
  provides: ["dead-letter-retention-sweep", "DEAD_LETTER_RETENTION_DAYS"]
  affects: ["apps/worker/src/queues/workspace-purge.worker.ts"]
tech-stack:
  added: []
  patterns:
    - "bounded, primary-key-scoped batch DELETE loop (mirrors PURGE_BATCH_SIZE discipline, never ctid)"
    - "object-level zod superRefine for a cross-variable env invariant"
key-files:
  created:
    - apps/worker/src/queues/dead-letter-retention.ts
    - apps/worker/src/queues/__tests__/dead-letter-retention.test.ts
  modified:
    - apps/worker/src/env.ts
    - apps/worker/src/queues/workspace-purge.worker.ts
    - apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts
    - docs/PII-INVENTORY.md
    - docs/runbooks/workspace-purge-and-restore.md
    - SPECIFICATION.md
    - docker/prod.env.example
    - .planning/phases/22-workspace-quiesce-physical-purge/deferred-items.md
decisions:
  - "Recorded decision: option (b), a bounded retention timer on dead_letter_jobs.failed_at, boot-validated to stay at or below WORKSPACE_PURGE_RETENTION_DAYS -- not option (a), a workspace_id backfill column (declined: structurally incomplete for payloads without a workspaceId key, and contradicts migration 0054's deliberate platform-scoped, no-RLS design)."
  - "Fixed a pre-existing test's now-stale invariant (workspace-purge-tables.test.ts's inventory-reconciliation check) with an explicit, documented exemption list rather than silently loosening the assertion, mirroring this repo's own RLS_ACCEPT_EXEMPT precedent."
metrics:
  duration: "~75 minutes"
  completed: "2026-08-24"
status: complete
---

# Phase 22 Plan 12: Bounded dead-letter retention sweep + PII documentation Summary

Closes verification gap 1 (`dead_letter_jobs.payload` retained indefinitely, table absent from the PII inventory and purge runbook) with a boot-validated retention window and a bounded, id-scoped sweep wired last into the existing `workspace-purge` tick — never a `workspace_id` backfill, per the recorded option-(b) decision.

## What Was Built

**Task 1 — `DEAD_LETTER_RETENTION_DAYS` env invariant.** Added `DEAD_LETTER_RETENTION_DAYS_FLOOR = 7` (matching BullMQ's own `FAILED_JOB_RETENTION_SECONDS`) and `DEAD_LETTER_RETENTION_DAYS` (default 30) to `apps/worker/src/env.ts`'s `workerEnvSchema`, plus an object-level `.superRefine` enforcing `DEAD_LETTER_RETENTION_DAYS <= WORKSPACE_PURGE_RETENTION_DAYS` (at most, not strictly less — equal is allowed). This is the single `superRefine` in the schema, and its issue path/message names both variables and the compliance reason. TDD RED→GREEN: `adda043` (5 failing env cases + a floor-constant case) → `9bdaf78` (implementation, all 6 pass).

**Task 2 — bounded sweep, wired last into the tick.** New `apps/worker/src/queues/dead-letter-retention.ts` exports `DEAD_LETTER_SWEEP_BATCH_SIZE = 500` and `sweepExpiredDeadLetterJobs(client, cutoff, batchSize?)`: a `DELETE ... WHERE id IN (SELECT id ... WHERE failed_at < $1 LIMIT $2)` loop, primary-key scoped (never `ctid`), `cutoff` passed as a `Date` (never `::timestamp`-cast), one statement per batch (never a multi-batch transaction), looping until a batch deletes zero rows. Wired into `workspace-purge.worker.ts`'s `processWorkspacePurge` as the LAST statement, deliberately outside any try/catch (a sweep throw fails the BullMQ job visibly rather than blocking the destructive walk or reporting phase that already ran). Added `ProcessWorkspacePurgeDeps.deadLetterRetentionDays?: number`, mirroring the existing `retentionDays` seam. TDD RED→GREEN: `ce0d562` (6 failing sweep/wiring cases) → `45dfba7` (implementation, all 13 pass in the file, 25/25 combined with `workspace-purge.test.ts`).

**Task 3 — four documents reconciled (`ba848e9`):**
- `docs/PII-INVENTORY.md`: `dead_letter_jobs` row added to Excluded tables, naming `scrub()`'s partial key-name coverage (misses `firstName`/`lastName`/`externalId`/`testTo`/freeform `properties`), the table's platform-scoped design, and the `DEAD_LETTER_RETENTION_DAYS` bound.
- `docs/runbooks/workspace-purge-and-restore.md`: new "Dead-letter rows" subsection between the survivor table and "Cryptographic erasure", clarifying `dead_letter_jobs` is not a fifth D-10 evidence survivor; states the env var/default, the after-soft-delete residual (a row created after soft-delete can outlive that workspace's purge by up to the retention window), and the watchdog-silencing interaction.
- `SPECIFICATION.md`: `DEAD_LETTER_RETENTION_DAYS` documented in §3 (env/validation table), §4 (retention-policy paragraph on the existing `dead_letter_jobs` entry, naming the recorded decision and both declined/chosen options), §5 (sweep as the tick's final step, in §5.20).
- `docker/prod.env.example`: `DEAD_LETTER_RETENTION_DAYS=` added in the same comment style/placement as `WORKSPACE_PURGE_RETENTION_DAYS` above it. `node scripts/check-spec-env-coverage.mjs` passes (57 names checked).

**Deviation fix (Rule 1/Rule 3, not in `files_modified`):** Task 3's addition to `docs/PII-INVENTORY.md` tripped `workspace-purge-tables.test.ts`'s pre-existing "inventory reconciliation" assertion (every inventory-named table must be in `PURGE_TABLE_ORDER` or `PURGE_EVIDENCE_TABLES` — true before this plan, no longer true by this plan's own recorded decision that `dead_letter_jobs` stays out of both). Fixed with an explicit, documented `INVENTORY_RECONCILIATION_EXEMPT_TABLES` set naming `dead_letter_jobs` and why, mirroring this repo's own `RLS_ACCEPT_EXEMPT` precedent rather than silently loosening the check (`25a9ca3`). This test file is explicitly listed in this plan's own `<verification>` section as expected to pass.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1/Rule 3 — pre-existing test invariant made stale by this plan's own doc change] `workspace-purge-tables.test.ts`'s inventory-reconciliation assertion**
- **Found during:** post-Task-3 full regression run (`npm run test -w apps/worker`)
- **Issue:** the test asserted every table named in `docs/PII-INVENTORY.md` must appear in `PURGE_TABLE_ORDER` or `PURGE_EVIDENCE_TABLES`; adding `dead_letter_jobs` to the Excluded tables list (this plan's Task 3, and the recorded option-(b) decision that it stay out of both lists) broke that assertion.
- **Fix:** added `INVENTORY_RECONCILIATION_EXEMPT_TABLES = new Set(["dead_letter_jobs"])`, with a doc comment naming the reason and the `RLS_ACCEPT_EXEMPT` precedent it mirrors; the test now passes both the exemption case and every other table's original check unweakened.
- **Files modified:** `apps/worker/src/queues/__tests__/workspace-purge-tables.test.ts`
- **Commit:** `25a9ca3`

No other deviations — every other task executed exactly as planned.

### Auth gates

None encountered.

## Known Stubs

None. No hardcoded empty values, placeholder text, or unwired data sources were introduced.

## Threat Flags

None — every new network/data surface introduced (the sweep's own DELETE against `dead_letter_jobs`) is already covered by this plan's own `<threat_model>` (T-22-12-01 through T-22-12-06, T-22-12-SC).

## Verification Results

- `npx vitest run --root apps/worker src/queues/__tests__/dead-letter-retention.test.ts` — 13/13 pass (5 env cases + floor-constant + 6 sweep/wiring cases + batch-size constant check).
- `npx vitest run --root apps/worker src/queues/__tests__/workspace-purge.test.ts src/queues/__tests__/workspace-purge-auth.test.ts src/queues/__tests__/workspace-purge-tables.test.ts src/queues/__tests__/workspace-purge-neighbour-safety.test.ts` — 46/46 pass together (also confirmed each file passes in isolation individually).
- `npm run failure:workspace-purge-resume` — 8/8 pass, unaffected by the new sweep call site.
- `npx vitest run --root apps/api src/modules/ops/__tests__/dead-letter-watchdog.test.ts` — 12/12 pass, unaffected.
- `npm run test -w apps/worker` (full suite, run twice): each run showed exactly the two already-documented pre-existing failures (`sentry.test.ts`'s no-DSN case, `stop-grace-period-publish.test.ts`'s missing `dist` build) plus a re-observed instance of the documented purge-test load flake (different specific test cases failed on each run; every failing file passed cleanly in isolation immediately after — see `deferred-items.md`'s "Plan 22-12" section). Zero new, non-flaky, non-pre-existing failures.
- Scoped lint (`npx eslint` against every TypeScript file in `files_modified` plus the one deviation-fixed test file) — zero errors.
- All required greps from Task 1/2/3 acceptance criteria pass: `DEAD_LETTER_RETENTION_DAYS_FLOOR` declared with value 7; exactly one `superRefine`; batch selector reads `id`; zero `ctid`/`dead_letter_alert_state`/`::timestamp` occurrences in `dead-letter-retention.ts`'s executable code; `dead_letter_jobs` absent from `packages/db/src/workspace-purge-tables.ts`; `COVERAGE.md` untouched; `DEAD_LETTER_RETENTION_DAYS` present in SPECIFICATION.md §3/§4/§5 and in `docker/prod.env.example`.

## Self-Check: PASSED

All 8 files claimed as created/modified verified present on disk. All 7 commit hashes (`adda043`, `9bdaf78`, `ce0d562`, `45dfba7`, `ba848e9`, `25a9ca3`, `e517bad`) verified present in `git log`.
