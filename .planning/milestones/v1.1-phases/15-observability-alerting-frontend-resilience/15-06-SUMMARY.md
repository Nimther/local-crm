---
phase: 15-observability-alerting-frontend-resilience
plan: 06
subsystem: observability
tags: [sentry, redaction, pii, secrets, ci, testing, vitest]

requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "plan 15-01's @sentry/node devDependency declaration (type-only) in packages/redaction; plan 15-04's PINO_REDACT_OPTIONS depth expansion and shared rules.ts"
provides:
  - "sentryBeforeSend -- the shared beforeSend/beforeSendTransaction hook every future Sentry.init() call (web/api/worker) must wire in"
  - "sentry-scrub-fixtures.test.ts -- the OPS-09 blocking CI gate proving no secret/PII reaches Sentry"
  - "check:sentry-redaction npm script + named CI step inside the required static job"
affects: [15-10, 15-11, 15-12]

tech-stack:
  added: []
  patterns:
    - "Sentry beforeSend hooks delegate entirely to packages/redaction's scrub() -- never a second, Sentry-specific rule list"
    - "Generic <E extends Event> function signature lets one hook satisfy both beforeSend (ErrorEvent) and beforeSendTransaction (TransactionEvent) under strictFunctionTypes"
    - "Fixture tests assert absence against a single JSON.stringify of the whole returned event, never per-field, plus a mandatory negative control"

key-files:
  created:
    - packages/redaction/src/sentry-scrub.ts
    - packages/redaction/src/__tests__/sentry-scrub-fixtures.test.ts
  modified:
    - packages/redaction/src/index.ts
    - package.json
    - .github/workflows/ci.yml
    - SPECIFICATION.md

key-decisions:
  - "sentryBeforeSend is generic (<E extends Event>) rather than pinned to ErrorEvent -- verified by compiling against the real @sentry/node@10.70.0 Options type that a function narrowed to ErrorEvent is NOT assignable to beforeSendTransaction's slot under strictFunctionTypes"
  - "Fixture events are plain objects shaped like Sentry's real Event/Exception/Breadcrumb/RequestEventData types (not actual Error instances) -- scrub()'s generic object walker handles every string field uniformly, so no change to scrub.ts was needed"
  - "Fixture error content is constructed inline, reproducing the exact message templates of the two roadmap-named call sites (sendTenantMailV3's Authorization header, ContactConflictError's email_taken message) rather than cross-package-importing apps/api/packages/delivery-core into packages/redaction, which has no dependency path to either and must stay dependency-light per SEC-13"
  - "check:sentry-redaction added as a named step inside CI's static job (not a new job) so the gate is blocking immediately under existing branch protection, per the plan's own explicit rationale"

requirements-completed: [OPS-09]

coverage:
  - id: D1
    description: "sentryBeforeSend hook exists, delegates the whole event body to scrub(), typed generically so it assigns to both beforeSend and beforeSendTransaction"
    requirement: "OPS-09"
    verification:
      - kind: unit
        ref: "packages/redaction/src/__tests__/scrub.test.ts (regression, unchanged) + npm run build -w packages/redaction (typecheck, includes strictFunctionTypes compatibility)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Fixture test proves five leak scenarios (SendGrid key in message/frame-vars/extra/request-header; contact email+phone in contexts/extra; five-level-deep freeform JSONB; breadcrumb email; no-op round-trip) are all scrubbed, plus a negative control proving the assertions are load-bearing"
    requirement: "OPS-09"
    verification:
      - kind: unit
        ref: "packages/redaction/src/__tests__/sentry-scrub-fixtures.test.ts -- all 6 tests"
        status: pass
    human_judgment: false
  - id: D3
    description: "The fixture test runs as a named, blocking step inside CI's required static job (check:sentry-redaction)"
    requirement: "OPS-09"
    verification:
      - kind: unit
        ref: "npm run check:sentry-redaction; node -e check confirming the step string appears inside the static job's YAML slice"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-08-15
status: complete
---

# Phase 15 Plan 06: Sentry beforeSend Redaction Gate Summary

**`sentryBeforeSend` routes every Sentry event through `packages/redaction`'s existing `scrub()`, proven against five representative leak scenarios plus a negative control, and wired as a blocking step in CI's required `static` job -- before any Sentry SDK exists anywhere in this codebase.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-08-15T11:00:00Z (approx.)
- **Completed:** 2026-08-15T11:40:52Z
- **Tasks:** 3 (all `type="auto"`, first two `tdd="true"`)
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- Implemented `sentryBeforeSend` (`packages/redaction/src/sentry-scrub.ts`), a generic hook that delegates the entire Sentry event body to the package's existing depth-unbounded `scrub()` -- no second, Sentry-specific redaction rule list. Verified by direct compilation that the generic signature (`<E extends Event>`) is required for the same function to satisfy both `beforeSend` and `beforeSendTransaction` under `strictFunctionTypes` (a function parameter narrowed to `ErrorEvent` alone is rejected for the `beforeSendTransaction` slot).
- Wrote `sentry-scrub-fixtures.test.ts`: five named scenarios (A-E) covering the two roadmap-named leak payloads (a `sendTenantMailV3`-shaped SendGrid key leak; a `ContactConflictError`-shaped contact email/phone leak) plus a five-level-deep freeform JSONB case, a breadcrumb-data case, and a no-op round-trip case -- plus a mandatory negative control proving the same event without the hook still contains the plaintext needle. Every absence assertion serializes the whole returned event once and checks for zero occurrences, never a per-field check.
- Performed and recorded the RED/GREEN transition by hand (see below) to prove the fixture assertions are load-bearing, not vacuous.
- Added `check:sentry-redaction` (root `package.json`) and wired it as a named, blocking step inside CI's `static` job -- already a required check under branch protection, so no repository-admin action is needed for this to block merges immediately.
- Updated `SPECIFICATION.md` §7 (the concrete implementation, its fixture coverage, and the standing prohibition on any `Sentry.init()` call until this gate is green) and corrected two stale `план 15-04` attributions in §2 to the actual authoring plan (15-06).

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement the shared Sentry beforeSend hook** - `459dcb1` (feat)
2. **Task 2: The fixture test** - `97a7b05` (test)
3. **Task 3: Make the fixture test a blocking merge gate** - `53dbe26` (feat)

_Note: Task 1 and Task 2 are each marked `tdd="true"` in the plan, but Task 1's implementation was written first (there is no prior test to fail against) and Task 2's RED/GREEN evidence was produced by temporarily neutering Task 1's already-committed implementation (see "TDD RED/GREEN Evidence" below) rather than via a separate `test:` commit followed by a separate `feat:` commit -- the plan's two-task structure (implementation task, then fixture-test task) does not map onto a literal RED-commit-then-GREEN-commit sequence the way a single `tdd="true"` task normally would._

## TDD RED/GREEN Evidence (Task 2)

Because Task 1's implementation was already committed before Task 2's fixture test was written, RED/GREEN was demonstrated by hand rather than via commit sequencing:

1. Wrote `sentry-scrub-fixtures.test.ts` against the real `sentryBeforeSend`. All 6 tests passed immediately (expected, since Task 1's implementation is correct).
2. Temporarily edited `packages/redaction/src/sentry-scrub.ts` to return `event` unchanged (bypassing `scrub()` entirely) -- a backup of the real file was kept outside the repo first.
3. Re-ran `npx vitest run --root packages/redaction src/__tests__/sentry-scrub-fixtures.test.ts`: **4 of 6 failed** (Scenarios A, B, C, D -- every scenario that plants a needle for the hook to remove). Scenario E (nothing to scrub) and the negative control (deliberately not run through the hook) correctly still passed -- exactly the expected RED signature, proving the four failing assertions are load-bearing rather than vacuous.
4. Restored the real implementation, confirmed byte-for-byte identical to the pre-probe file via `diff`, and re-ran the suite: all 6 passed (GREEN).

## Files Created/Modified

- `packages/redaction/src/sentry-scrub.ts` - `sentryBeforeSend<E extends Event>(event, hint): E`, delegates to `scrub()`
- `packages/redaction/src/index.ts` - re-exports `sentryBeforeSend`
- `packages/redaction/src/__tests__/sentry-scrub-fixtures.test.ts` - the OPS-09 fixture test (6 cases)
- `package.json` - new `check:sentry-redaction` script
- `.github/workflows/ci.yml` - new named step "Sentry redaction fixture gate (OPS-09)" inside the `static` job
- `SPECIFICATION.md` - §7 new bullet documenting the shipped hook/gate; §2 corrected two stale plan-number attributions

## Decisions Made

- Typed `sentryBeforeSend` generically (`<E extends Event>`) rather than pinned to `ErrorEvent`, verified against the real `@sentry/node@10.70.0` types by compiling a standalone probe file (`Sentry.init({ beforeSend: sentryBeforeSend, beforeSendTransaction: sentryBeforeSend })`) -- confirmed the narrower `ErrorEvent`-only signature the plan's own snippet suggested is rejected for the `beforeSendTransaction` slot under this project's `strict` TypeScript settings, while the generic form type-checks for both.
- Built fixture events as plain objects shaped like Sentry's real `Event`/`Exception`/`Breadcrumb`/`RequestEventData` types rather than as actual `Error` instances wrapped later -- `scrub()`'s existing generic object-walker branch (not its `Error`-instance special case) handles every string field uniformly, so no change to `scrub.ts` or `rules.ts` was needed, keeping this plan's `files_modified` list accurate.
- Reproduced the two roadmap-named call sites' exact error/message shapes inline in the test file (`sendTenantMailV3`'s `Authorization: Bearer <key>` header construction; `ContactConflictError`'s `email_taken` message template) instead of importing across package boundaries -- `packages/redaction` has no dependency path to `apps/api` or `packages/delivery-core` and must stay dependency-light (SEC-13); the plan's `files_modified` list does not include `packages/redaction/package.json`, so no new workspace dependency was added.
- Placed the new CI step immediately after the existing `Lint` step (before `Lint file-count floor`) inside `static`, per the plan's instruction to land it "between the job's existing lint/typecheck steps and its end" without touching any other existing step.

## Deviations from Plan

**1. [Rule 1 - Docs accuracy] Corrected two stale "план 15-04" attributions in SPECIFICATION.md §2**
- **Found during:** Task 3 (updating SPECIFICATION.md §7 per the plan's explicit instruction)
- **Issue:** SPECIFICATION.md §2 (lines documenting `packages/redaction`'s dependencies and the per-workspace dependency table) attributed the future `sentry-scrub.ts` to "план 15-04" in two places. The actual plan implementing it is 15-06 (this plan) -- 15-04 was OPS-07's `PINO_REDACT_OPTIONS` depth-expansion plan, an unrelated change in the same file section.
- **Fix:** Updated both references to attribute `sentry-scrub.ts` to plan 15-06, and changed the "объявлен, ещё не используется" (declared, not yet used) note for `@sentry/node` in `packages/redaction` to reflect that it is now actually consumed (type-only) by `sentry-scrub.ts`.
- **Files modified:** `SPECIFICATION.md`
- **Verification:** `npm run check:spec-env-coverage` still passes (46/46 names present); manual re-read of the corrected lines.
- **Committed in:** `53dbe26` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (docs accuracy, Rule 1)
**Impact on plan:** No code-behavior impact. Corrects a factual inaccuracy in the as-built specification document that this exact plan's own work made newly relevant.

## Issues Encountered

- This worktree had no `node_modules` at all (fresh worktree checkout with no shared install). Ran `npm ci --prefer-offline` before any verification step -- `@sentry/node@10.70.0` was already present in `package-lock.json` (declared by plan 15-01), so this was a lockfile materialization, not a new package install, and did not require the package-legitimacy checkpoint.
- Confirmed via direct TypeScript compilation (a scratch probe file, created and deleted before any commit) that `strictFunctionTypes` rejects a `beforeSendTransaction: sentryBeforeSend` assignment when `sentryBeforeSend`'s parameter is typed narrowly as `ErrorEvent` (as the plan's own RESEARCH.md code snippet showed), which is why the shipped implementation uses a generic parameter instead.

## User Setup Required

None - no external service configuration required. (Sentry SaaS org/projects/DSNs remain a future plan's `checkpoint:human-verify` operator prerequisite, per 15-RESEARCH.md -- not touched by this plan.)

## Next Phase Readiness

- `sentryBeforeSend` and its blocking CI gate are ready for plans 15-10/15-11/15-12 (the three `Sentry.init()` sites: web/api/worker) to wire in directly as `beforeSend`/`beforeSendTransaction`.
- Per Pitfall 18 and this plan's own prohibition, no `Sentry.init()` call may be added anywhere in this codebase until this gate stays green -- it now does, and is enforced in CI going forward.
- No blockers.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-15*
