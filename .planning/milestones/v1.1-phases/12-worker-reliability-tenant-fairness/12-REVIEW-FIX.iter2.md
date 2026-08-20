---
phase: 12-worker-reliability-tenant-fairness
fixed_at: 2026-08-11T08:20:00Z
review_path: .planning/phases/12-worker-reliability-tenant-fairness/12-REVIEW.md
iteration: 1
findings_in_scope: 2
fixed: 2
skipped: 0
status: all_fixed
---

# Phase 12: Code Review Fix Report

**Fixed at:** 2026-08-11T08:20:00Z
**Source review:** .planning/phases/12-worker-reliability-tenant-fairness/12-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 2 (1 Warning, 1 Info; REVIEW.md reported 0 critical/blocker findings; `fix_scope: all` so Info was included)
- Fixed: 2
- Skipped: 0

**Isolation note:** All edits were made in an isolated git worktree (`gsd-reviewfix/12-*` branch created from `gsd/phase-12-worker-reliability-tenant-fairness`), committed there, then fast-forward-merged back into `gsd/phase-12-worker-reliability-tenant-fairness` before the worktree and temp branch were removed. This avoided racing the foreground session on the shared working tree.

## Fixed Issues

### WR-01: Worker-side ioredis clients have no `'error'` listener — errors bypass the codebase's logging/redaction convention

**Files modified:** `apps/worker/src/queues/send-dispatch.ts`, `packages/queue-core/src/connection.ts`, `packages/queue-core/src/__tests__/connection-error-listener.test.ts` (new)
**Commit:** `33af0a4`
**Applied fix:** Read both files and confirmed current code matched the reviewer's description exactly (no drift). Added `.on("error", ...)` to `send-dispatch.ts`'s lazily-constructed `defaultRedisClient`, routed through the already-imported `scrubbedConsole.error`. Added the identical listener to `connection.ts`'s `createRedisConnection`, importing `scrubbedConsole` from `@mega-crm/redaction` (already a declared dependency of `packages/queue-core`). Added a new regression test (`connection-error-listener.test.ts`) that mocks `scrubbedConsole` and proves, without any live Redis, that (a) exactly one `'error'` listener is registered and (b) an emitted error routes through `scrubbedConsole.error` with an identifying message — mirroring the emit-based proof pattern already used by `error-listeners.test.ts` and `shared-error-listener.test.ts` for `worker.on("error", ...)`.

Verification: `packages/queue-core` full test suite (24 tests, 3 files) passes, including the 2 new tests. `tsc --noEmit` is clean for both `packages/queue-core` and `apps/worker` (no errors in either edited file; ran the whole-package check and filtered for the touched files to rule out both new and pre-existing errors).

**Scope note:** `send-dispatch.ts`'s `getDefaultRedisClient` is a module-private singleton not currently exported for testing, and every existing test in that file's suite injects its own `redisClient` via `deps` (confirmed by the reviewer's own analysis), bypassing this code path entirely. Exporting the private singleton getter purely to unit-test it would exceed this finding's stated fix (which only asked for the listener + a routing regression test, demonstrated via `connection.ts`'s identical pattern). The `send-dispatch.ts` change itself is a 2-line mechanical mirror of the already-tested `connection.ts` fix, so it was applied but not independently unit-tested; this is a judgment call, not a limitation of the fix's correctness.

### IN-01: Stale "RED under current code" comments no longer match the (passing) assertions they annotate

**Files modified:** `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts`
**Commit:** `408f727`
**Applied fix:** Read the cited lines (452-499) and confirmed the test still exists verbatim as the reviewer described, with the two stale "RED under current code" comments directly above passing assertions. Replaced both comments with descriptions of the current (passing) behavior — the sweep's stale-snapshot cleanup (`drainStaleSnapshotBatches`/`deleteStaleSnapshotBatch`) clearing the snapshot row on segment exit, and the resulting second run on rejoin — removing the "RED"/TDD-red framing per the reviewer's suggested wording.

Verification: comment-only change; re-read confirmed text present and surrounding code (including the exact assertions) untouched. `tsc --noEmit` for `apps/worker` shows no errors referencing this file.

## Skipped Issues

None — all in-scope findings were fixed.

---

_Fixed: 2026-08-11T08:20:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
