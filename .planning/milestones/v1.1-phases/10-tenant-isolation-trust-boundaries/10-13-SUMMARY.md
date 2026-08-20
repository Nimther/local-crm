---
phase: 10-tenant-isolation-trust-boundaries
plan: 13
subsystem: observability
tags: [redaction, pino, logging, sec-13, worker, secrets, pii]

# Dependency graph
requires:
  - phase: 10-tenant-isolation-trust-boundaries
    provides: plan 10-08's worker sibling-drop signal (webhook.sibling_workspace_event_dropped), plan 10-09's mega_crm_auth role migration, and the rest of Phase 10's tenant-isolation work this plan's tests/build ran against
provides:
  - "@mega-crm/redaction workspace package: REDACTION_RULES (single rule table), PINO_REDACT_OPTIONS (compiled field-path form), scrub() (unlimited-depth recursive walker), scrubbedConsole (console wrapper)"
  - apps/api/src/logger.ts consuming the compiled PINO_REDACT_OPTIONS instead of an inline path array
  - every direct console call under apps/worker/src (outside __tests__) routed through scrubbedConsole
  - a documented decision for packages/tenant-context's pool.on("error") listener (stays on bare console.error -- no tenant payload, package stays dependency-light)
affects: [phase-15-observability]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One rule table (REDACTION_RULES) compiled two ways -- a fixed-depth field-path list for Pino, and an unlimited-depth recursive scrub() for freeform payloads -- rather than two hand-maintained lists"
    - "scrubbedConsole: a drop-in console.log/error/warn/info/debug replacement that scrubs every argument, including special-cased Error handling (name/message/stack preserved, message and own enumerable properties scrubbed) so console.error(msg, err) doesn't collapse to {}"

key-files:
  created:
    - packages/redaction/package.json
    - packages/redaction/tsconfig.json
    - packages/redaction/vitest.config.ts
    - packages/redaction/src/rules.ts
    - packages/redaction/src/pino-redact.ts
    - packages/redaction/src/scrub.ts
    - packages/redaction/src/scrubbed-console.ts
    - packages/redaction/src/index.ts
    - packages/redaction/src/__tests__/rules-parity.test.ts
    - packages/redaction/src/__tests__/scrub.test.ts
  modified:
    - apps/api/src/logger.ts
    - apps/api/package.json
    - apps/worker/package.json
    - apps/worker/src/server.ts
    - apps/worker/src/queues/webhook-events.worker.ts
    - apps/worker/src/queues/partition-maintenance.worker.ts
    - apps/worker/src/test/failure-fixtures.ts
    - apps/worker/src/test/harness/sigkill-entrypoint.ts
    - packages/tenant-context/src/index.ts
    - vitest.config.ts
    - package-lock.json
    - SPECIFICATION.md

key-decisions:
  - "scrubbedConsole lives inside @mega-crm/redaction itself, not a worker-local wrapper module -- the package has no runtime deps and console is a global, so this costs nothing and lets apps/api adopt the same wrapper later without a second implementation"
  - "packages/tenant-context's pool.on(\"error\") listener stays on bare console.error -- the argument is always a driver-level connection Error with no tenant payload, and the package deliberately stays dependency-light (imported by both apps and every worker queue)"
  - "The grep-based acceptance criterion (\"every direct console call under apps/worker/src, excluding __tests__ directories\") was read literally: apps/worker/src/test/failure-fixtures.ts and src/test/harness/sigkill-entrypoint.ts are TEST HARNESS files but live under src/test/, not src/__tests__/, so they were wrapped too -- wrapping them is harmless (scrub() passes non-matching values through unchanged) and makes the grep check unambiguously pass"
  - "keyRules include email/phone (not just the four absorbed secret names) so a shallow field literally named email/phone is caught by BOTH compiled forms identically -- valueRules' email/phone patterns are the separate, depth-independent backstop for the same PII under any OTHER field name"

patterns-established:
  - "A workspace package with zero runtime dependencies can still use a real third-party library (pino) as a devDependency purely to drive its own test assertions (rules-parity.test.ts runs a real Pino instance to prove the compiled logger config matches scrub()'s output) -- this doesn't compromise the \"no runtime dependencies\" claim"

requirements-completed: [SEC-13]

coverage:
  - id: D1
    description: "One rule table (REDACTION_RULES) is the sole source for both the structured-logger field configuration and the recursive scrubbing function"
    requirement: "SEC-13"
    verification:
      - kind: unit
        ref: "packages/redaction/src/__tests__/rules-parity.test.ts#Test 9: every field name the previous logger configuration redacted is still covered by the compiled path list"
        status: pass
    human_judgment: false
  - id: D2
    description: "A representative payload (provider key, password, token, contact email, nested freeform object) is redacted identically through the compiled logger config and through scrub()"
    requirement: "SEC-13"
    verification:
      - kind: unit
        ref: "packages/redaction/src/__tests__/rules-parity.test.ts#Test 8"
        status: pass
    human_judgment: false
  - id: D3
    description: "scrub() reaches secret/PII values nested at arbitrary depth (no depth ceiling) -- backstop probe at depth 7"
    requirement: "SEC-13"
    verification:
      - kind: unit
        ref: "packages/redaction/src/__tests__/scrub.test.ts#Test 2 (backstop probe)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Every direct console call under apps/worker/src (outside __tests__) is routed through scrubbedConsole"
    requirement: "SEC-13"
    verification:
      - kind: unit
        ref: "grep -rn 'console\\.' apps/worker/src --include=*.ts | grep -v __tests__ (0 raw console.* calls, only a comment mention)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The worker's sibling-drop signal (webhook.sibling_workspace_event_dropped, plan 10-08) passes through scrubbedConsole"
    requirement: "SEC-13"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-sibling-drop.test.ts (6/6)"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-08-08
status: complete
---

# Phase 10 Plan 13: Shared redaction module (@mega-crm/redaction) Summary

**One rule table (`REDACTION_RULES`) compiled into a Pino field-path list for `apps/api` and an unlimited-depth recursive `scrub()` for `apps/worker`'s console surface, closing the gap where the worker previously redacted nothing at all.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-08-08T02:00:00+05:00 (approx.)
- **Completed:** 2026-08-08T02:25:40+05:00
- **Tasks:** 3
- **Files modified:** 22 (10 created, 12 modified)

## Accomplishments

- New `packages/redaction` (`@mega-crm/redaction`) workspace package with zero runtime dependencies: `REDACTION_RULES` (the single rule table), `PINO_REDACT_OPTIONS` (compiled field-path form), `scrub()` (unlimited-depth recursive walker matching by key name AND value pattern), `scrubbedConsole` (console wrapper).
- `apps/api/src/logger.ts` now consumes `PINO_REDACT_OPTIONS` instead of declaring its own inline `redact.paths` array.
- Every direct `console.*` call site under `apps/worker/src` (outside `__tests__`) now routes through `scrubbedConsole`, including the plan 10-08 sibling-drop signal (`webhook.sibling_workspace_event_dropped`) and `partition-maintenance.worker.ts`.
- `scrub()` special-cases `Error` instances so `console.error(msg, err)` keeps `name`/`message`/`stack` (Node's `Object.entries(new Error(...))` returns nothing, so a naive walk would have silently collapsed every worker error log into `{}`).
- Documented, rather than left ambiguous, the decision for `packages/tenant-context`'s `pool.on("error")` listener: stays on bare `console.error` (no tenant payload in a driver-level connection error; package deliberately stays dependency-light).
- SPECIFICATION.md §2.2/§2.3/§2.5/§7 updated: the new package, its two compiled forms, the rule categories, and the fact that Phase 15's Sentry `beforeSend` hook is expected to consume `scrub()` rather than growing a second rule list.

## Task Commits

Each task was committed atomically (Task 1 followed strict RED→GREEN TDD):

1. **Task 1a (RED): scaffolding + failing tests** - `577c7b1` (test) — package.json/tsconfig/vitest.config plus both test files, committed against stub `rules.ts`/`scrub.ts`/`pino-redact.ts` that made 9/10 tests fail.
2. **Task 1b (GREEN): real implementation** - `452f711` (feat) — restored the real `rules.ts`/`scrub.ts`/`pino-redact.ts`, registered `packages/redaction` in the root `vitest.config.ts`, ran `npm install` (lockfile diff), 10/10 passing.
3. **Task 2: wire API logger and worker log surface** - `6c543b6` (feat) — `apps/api/src/logger.ts`, `scrubbedConsole` added to the package, every `apps/worker/src` console call site wrapped, `@mega-crm/redaction` added as a dependency of both apps, `packages/tenant-context`'s decision documented. Includes the Rule 1 phone-regex fix (see Deviations).
4. **Task 3: SPECIFICATION.md** - `4d59d83` (docs)

**Plan metadata:** (this commit, once created by the orchestrator after merge)

_Note: Task 1 used two commits (test → feat) per its `(RED then GREEN)` frontmatter, exactly as `<tdd_execution>` prescribes for a `tdd="true"` task._

## Files Created/Modified

- `packages/redaction/src/rules.ts` - `REDACTION_RULES`: the single rule table (key-name rules absorbing the four names `apps/api/src/logger.ts` covered plus other secret/PII field names actually used in this codebase; value-pattern rules for SendGrid key shape/email/phone)
- `packages/redaction/src/pino-redact.ts` - compiles key rules into `PINO_REDACT_OPTIONS` at the same 3 wildcard depths the previous inline array used
- `packages/redaction/src/scrub.ts` - `scrub()`: unlimited-depth recursive walker, key-name AND value-pattern matching, never mutates input, terminates cycles via `WeakSet`, special-cases `Error`
- `packages/redaction/src/scrubbed-console.ts` - `scrubbedConsole`: console wrapper used by `apps/worker`
- `packages/redaction/src/__tests__/scrub.test.ts` - 7 plan-specified behaviors + 1 extra (Error handling), 8 tests
- `packages/redaction/src/__tests__/rules-parity.test.ts` - Test 8 (parity, via a real Pino instance) and Test 9 (no-narrowing vs. the literal previous path list)
- `apps/api/src/logger.ts` - now imports `PINO_REDACT_OPTIONS` instead of declaring its own path array
- `apps/worker/src/server.ts` - boot/shutdown console calls -> `scrubbedConsole`
- `apps/worker/src/queues/webhook-events.worker.ts` - the plan 10-08 sibling-drop signal -> `scrubbedConsole`
- `apps/worker/src/queues/partition-maintenance.worker.ts` - 3 console call sites -> `scrubbedConsole`
- `apps/worker/src/test/failure-fixtures.ts`, `apps/worker/src/test/harness/sigkill-entrypoint.ts` - test-harness console calls -> `scrubbedConsole` (see Deviations/decisions)
- `packages/tenant-context/src/index.ts` - documented decision comment, no functional change
- `vitest.config.ts` - registered `packages/redaction/vitest.config.ts` in the aggregate coverage projects list
- `SPECIFICATION.md` - §2.2/§2.3/§2.5 (new package, dependency declarations), §7 (both compiled forms, rule categories, Phase 15 forward-note)

## Decisions Made

- `scrubbedConsole` lives inside `@mega-crm/redaction` (not a worker-local wrapper) — no runtime deps, `console` is a global, and `apps/api` can reuse it later.
- `packages/tenant-context`'s `pool.on("error")` stays on bare `console.error` — documented in-file, not silently left ambiguous.
- The acceptance criterion's `__tests__`-only exclusion was read literally: `apps/worker/src/test/` (singular, no underscores) test-harness files were wrapped too, since they are not literally under `__tests__/` and the grep-based check scopes to that exact exclusion.
- `keyRules` includes `email`/`phone` alongside the absorbed secret names, so a shallow field named exactly `email`/`phone` is caught by both compiled forms identically; the separate `valueRules` patterns are the depth-independent backstop for the same PII under any other field name.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Phone value-pattern regex false-matched UUID substrings**
- **Found during:** Task 2 verification (`npx vitest run --root apps/worker src/queues/__tests__/webhook-events-sibling-drop.test.ts`)
- **Issue:** The first version of the phone value-pattern (`/(?:\+?\d[\d\s().-]{7,}\d)/`) matched any 7+ digit-ish run. `owningWorkspaceId`/`receivingWorkspaceId` are UUIDs (e.g. `41449741-1da4-43a0-8eaf-48197d214661`), and a UUID's first hex group is sometimes all-digit by chance — this pattern matched `41449741-1` inside it, so `scrub()` redacted a workspace id in the sibling-drop signal test, breaking an assertion that the signal carries the raw ids. Since workspace_id/contact_id/send_id UUIDs are logged constantly throughout both apps, this would have silently over-redacted identifiers everywhere `scrub()` ran, not just in this one test.
- **Fix:** Tightened the pattern to require 10-15 total digits (E.164 range) with `\b` word boundaries: `/\+?\(?\d(?:[\s().-]*\d){9,14}\b/`. Verified against realistic phone formats (`+1 415-555-0199`, `(415) 555-0199`, `+14155550199`) — all still match — and against the exact UUID that broke the test — no longer matches, because a UUID's digit runs are broken up by hex letters (a-f) outside the allowed character class.
- **Files modified:** `packages/redaction/src/rules.ts`
- **Verification:** `packages/redaction`'s own 10/10 tests still pass; `webhook-events-sibling-drop.test.ts` 6/6; full `apps/worker` suite 131/131; full `apps/api` suite 342/342.
- **Committed in:** `6c543b6` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - bug fix)
**Impact on plan:** Necessary correctness fix caught by the plan's own required verification step before it could reach any other file in the codebase. No scope creep.

## Issues Encountered

**Pre-existing, unrelated test-isolation flakiness blocks `npm run coverage`/`npm run coverage:gate` in this environment.** `apps/worker/src/queues/__tests__/flow-segment-trigger.test.ts` (4 of its tests) fails with `Cannot read properties of undefined (reading 'map')` inside `compileSegmentDefinition` — but **only** when run as part of the full cross-workspace aggregate (`npm run coverage`, which runs `apps/api` + `apps/worker` + every `packages/*` project concurrently against a shared ephemeral Postgres/Redis). Confirmed unrelated to this plan:
- The file passes 8/8 in isolation (`npx vitest run --root apps/worker src/queues/__tests__/flow-segment-trigger.test.ts`).
- The full `apps/worker` suite passes 131/131 standalone (`npx vitest run --root apps/worker`).
- `packages/redaction` has zero DB/Redis interaction (pure functions only) and cannot be the cause.
- `git log` shows this test file and its `packages/segments-core` dependency were last touched in plan 10-09 — before this plan existed.
- A similarly-flaky `apps/api` test (`webhooks-signature.test.ts`'s queue-depth assertion) was also observed intermittently in the full-aggregate/full-`apps/api` runs and passed cleanly every time it was run in isolation — same shared-state-under-concurrency signature.

This is a pre-existing cross-workspace test-isolation issue (per the codebase's own `vitest.config.ts` comments, several files already carry `fileParallelism: false` for exactly this class of problem; `flow-segment-trigger.test.ts` does not). Per the Scope Boundary rule, it was not fixed here — fixing shared-state contention across concurrent workspace test runs is a distinct, larger concern than SEC-13's redaction work. `npx vitest run --root packages/redaction` (10/10), `--root apps/api` (342/342 standalone), `--root apps/worker` (131/131 standalone), `npm run build --workspaces --if-present`, and `npm run lint` all pass clean — the plan's other verification commands are unaffected.

**Recommendation:** worth a follow-up investigation (not scoped to any current plan) into why `flow-segment-trigger.test.ts` behaves differently under full-aggregate concurrency — likely a shared-state/timing issue with `packages/segments-core`'s test fixtures similar to the ones `06-12`'s `fileParallelism: false` precedent already addressed elsewhere.

## Known Stubs

None.

## Threat Flags

None — this plan's threat model (T-10-13-01 through T-10-13-06) is fully addressed by the shared rule table, the parity/no-narrowing tests, the backstop-depth test, and the grep-verified worker console wrapping; no new trust-boundary surface was introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `@mega-crm/redaction` is ready for Phase 15's Sentry `beforeSend` hook to consume directly (documented in SPECIFICATION.md §7 as the expected third consumer of `scrub()`).
- The pre-existing `flow-segment-trigger.test.ts` aggregate-only flakiness (see Issues Encountered) is NOT a blocker for this plan but is worth flagging to whichever phase next runs a full `npm run coverage` — it will reproduce there too until investigated.

---
*Phase: 10-tenant-isolation-trust-boundaries*
*Completed: 2026-08-08*

## Self-Check: PASSED

All 16 created/modified files verified present on disk (packages/redaction/* x10, apps/api/src/logger.ts, apps/worker/src/server.ts + queue files, packages/tenant-context/src/index.ts, SPECIFICATION.md). All 4 task commits (`577c7b1`, `452f711`, `6c543b6`, `4d59d83`) verified present in `git log`.
