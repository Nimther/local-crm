---
phase: 12-worker-reliability-tenant-fairness
fixed_at: 2026-08-11T08:25:00Z
review_path: .planning/phases/12-worker-reliability-tenant-fairness/12-REVIEW.md
iteration: 2
findings_in_scope: 1
fixed: 1
skipped: 0
status: all_fixed
---

# Phase 12: Code Review Fix Report

**Fixed at:** 2026-08-11T08:25:00Z
**Source review:** .planning/phases/12-worker-reliability-tenant-fairness/12-REVIEW.md
**Iteration:** 2

**Summary:**
- Findings in scope: 1 (0 critical, 0 warning, 1 info; `fix_scope: all` so the Info finding was included)
- Fixed: 1
- Skipped: 0

**Isolation note:** The edit was made in an isolated git worktree (`gsd-reviewfix/12-*` branch created from `gsd/phase-12-worker-reliability-tenant-fairness`), verified and committed there, then fast-forward-merged back into `gsd/phase-12-worker-reliability-tenant-fairness` before the worktree and temp branch were removed. This avoided racing the foreground session on the shared working tree.

## Fixed Issues

### IN-02: `send-dispatch.ts`'s new error-listener wiring has no direct regression test

**Files modified:** `apps/worker/src/queues/send-dispatch.ts`, `apps/worker/src/queues/__tests__/send-dispatch-error-listener.test.ts` (new)
**Commit:** `5f6e0b3`
**Applied fix:** Exported `getDefaultRedisClient` (previously module-private) and added a test-only `__resetDefaultRedisClientForTests()` hook that clears the lazily-created singleton reference between test cases. Added a new regression test file, `send-dispatch-error-listener.test.ts`, mirroring `packages/queue-core/src/__tests__/connection-error-listener.test.ts`'s emit-based proof pattern: it mocks `@mega-crm/redaction`'s `scrubbedConsole` and asserts (a) exactly one `'error'` listener is registered on the singleton, (b) repeated calls return the same singleton instance until reset, and (c) an emitted connection error reaches `scrubbedConsole.error` with the exact identifying message used in production code — closing the coverage gap the review noted (the two existing `send-dispatch` test files both inject their own `deps.redisClient` and never exercise `getDefaultRedisClient()`'s own construction/wiring path).

Chose the "export + reset hook" option from the finding's Fix section over the "integration-style `processSendJob` with `deps = {}`" alternative, since it produces a direct, fast, unit-level proof of the wiring itself (matching the sibling `connection.ts` test's scope and style) rather than an indirect assertion routed through the full send pipeline.

**Verification performed inside the isolated worktree:**
- Tier 1: re-read the modified `send-dispatch.ts` section and the new test file in full — fix text present, surrounding code intact.
- Tier 2: `npx vitest run src/queues/__tests__/send-dispatch-error-listener.test.ts` from `apps/worker` — 1 file, 3 tests, all passing. `npx tsc --noEmit -p tsconfig.json` — clean. `npx eslint` on both modified/created files — clean (no naming-convention complaint about the leading-underscore export).

## Skipped Issues

None — the single in-scope finding was fixed.

---

_Fixed: 2026-08-11T08:25:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 2_
