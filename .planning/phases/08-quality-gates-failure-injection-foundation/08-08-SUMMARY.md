---
phase: 08-quality-gates-failure-injection-foundation
plan: 08
subsystem: testing
tags: [failure-injection, sendgrid, bullmq, send-dispatch, rate-limit, timeout, econnreset, rls]

requires:
  - phase: 08-06
    provides: the consolidated db-fixture and ephemeral-database provisioning the worker suite runs against
provides:
  - npm scripts failure:429, failure:timeout, failure:reset — three audit-named failure modes, one command each
  - apps/worker/src/test/failure-fixtures.ts — shared DI fakes and RLS-safe seed builders
  - apps/worker/src/queues/__tests__/failure-injection/ — the scenario directory 08-12 and 08-13 extend
affects: [08-12, 08-13, phase-11-delivery-state-machine]

tech-stack:
  added: []
  patterns:
    - "Failure scenarios inject only ProcessSendJobDeps.sendMail — the seam that has existed since Phase 4 — and assert database state, never log output"
    - "Counting fakes: a call counter distinguishes 'was never called' from 'was called and did nothing', which is the whole assertion for an intercepted redelivery"
    - "Assert the pre-change baseline literally, with the future change named in a comment rather than pre-empted in the expectation"

key-files:
  created:
    - apps/worker/src/test/failure-fixtures.ts
    - apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts
    - apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts
  modified:
    - apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts
    - package.json

key-decisions:
  - "Timeout and connection reset get separate files and separate commands even though send-dispatch.ts cannot distinguish them today — the injected errors carry distinct identities, so when Phase 11 handles them differently the failing file names which mode regressed"
  - "The terminal-status assertions say `failed`, not the `reconciling` state Phase 11 will introduce. A harness asserting a state the system cannot produce is red from birth and gets deleted rather than fixed"
  - "freshWorkspaceId takes the Pool as a parameter; the other fixtures do not, because `organization` is the only table here that is not tenant-scoped and every other insert must go through withTenant"
  - "send-dispatch-idempotency.test.ts keeps its own local copies — leaving it alone keeps the extraction's blast radius to one existing file"

patterns-established:
  - "apps/worker/src/queues/__tests__/failure-injection/ is the home for audit-named failure modes; 08-12 (SIGKILL) and 08-13 (Redis restart) join it"
  - "Each scenario is a root-level npm script, so a developer reproducing an audit finding runs one command from where they are standing"

requirements-completed: [QG-06]

coverage:
  - id: D1
    description: "`npm run failure:429` reproduces a SendGrid rate limit and proves the dispatch claim is released rather than stranded"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts — 3 tests, exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "`npm run failure:timeout` reproduces an aborted send: stranded dispatching claim, redelivery intercepted with zero further send attempts, terminal failed, one row"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts — exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "`npm run failure:reset` reproduces the same chain for a socket reset, distinguishable from the timeout scenario by error identity"
    requirement: QG-06
    verification:
      - kind: integration
        ref: "apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts — exit 0"
        status: pass
    human_judgment: false
  - id: D4
    description: "No scenario reaches the real SendGrid endpoint or sends mail; each asserts its injected function's call count rather than trusting absence"
    requirement: QG-06
    verification:
      - kind: manual_procedural
        ref: "grep -rc 'api.sendgrid.com' apps/worker/src/queues/__tests__/failure-injection/ — 0; no file references sendTenantMailV3"
        status: pass
      - kind: integration
        ref: "each scenario asserts callCount on its injected sendMail (1 for the attempt, 0 for the redelivery)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Shared fixtures extracted without regressing the suite that used to own them"
    verification:
      - kind: integration
        ref: "send-dispatch-durability.test.ts — 5/5 green after extraction; full workspace suite 100 files / 593 tests, exit 0"
        status: pass
    human_judgment: false
  - id: D6
    description: "The assertions describe the system as it is today, with the Phase 11 change flagged rather than pre-empted"
    verification: []
    human_judgment: true
    rationale: "Whether the recorded baseline is the RIGHT baseline for Phase 11 to change against is a design judgment. The mechanical part — that `reconciling` appears only in comments, never in an expect() — is checked; the editorial part is not."

duration: 24 min
completed: 2026-07-28
status: complete
---

# Phase 8 Plan 08: Failure Injection (429 / Timeout / Connection Reset) Summary

**Three audit-named failure modes reduced to one command each, asserting database state on the DI seam that already existed — and asserting the pre-Phase-11 behaviour deliberately, not the behaviour Phase 11 will produce.**

## Performance

- **Duration:** 24 min
- **Started:** 2026-07-28T08:30:00Z
- **Completed:** 2026-07-28T08:54:00Z
- **Tasks:** 3
- **Files modified:** 6 (4 created, 2 modified)

## Accomplishments

- **`npm run failure:429`** — three cases matching `parseRetryAfter`'s three branches: `Retry-After` (deep-equality on `{outcome: "rate_limited", rateLimitMs: 3000}`), `X-RateLimit-Reset` (bounded rather than pinned — the value depends on how much of the current second has elapsed, so an exact assertion would be flaky), and neither header (the fixed 2s seed, read out of `send-dispatch.ts` rather than assumed).
- **`npm run failure:timeout`** and **`npm run failure:reset`** — each asserts the full chain: rejection → claim stranded at `dispatching` → BullMQ redelivery → `claimCampaignSend`'s interrupted branch → terminal `failed`, exactly one row.
- **`apps/worker/src/test/failure-fixtures.ts`** — the DI fakes and RLS-safe seed builders, moved verbatim out of `send-dispatch-durability.test.ts` (which had itself copied them from `send-dispatch-idempotency.test.ts`), plus a new `throwingSendMail(error)`.
- **No new seam.** All three scenarios inject only `ProcessSendJobDeps.sendMail`, which has existed since Phase 4. `send-dispatch.ts` was not touched and is not in this plan's `files_modified`.

### What the assertions actually protect

The 429 scenario's interesting property is not that a rate limit is reported — it is whether the dispatch claim survives one. `dispatchSendGate` commits a `dispatching` row in its own transaction *before* SendGrid is called. A rate-limited attempt that failed to release that claim would strand the row, the retry would hit the interrupted branch, and a routine backoff would become a permanently undelivered email. **The returned outcome reads `rate_limited` either way** — only the `sends` row count of 0 proves the release.

The timeout and reset scenarios turn on the redelivery's call count being **0**. That interrupted branch is the only thing standing between a mid-flight failure and a duplicate email, and a counter is the only way to distinguish "was never called" from "was called and happened to do nothing".

## Task Commits

1. **Task 1: extract shared fixtures** — `e339d8b` (refactor)
2. **Task 2: failure:429** — `bf7e328` (test)
3. **Task 3: failure:timeout + failure:reset** — `a612547` (test)

## Files Created/Modified

- `apps/worker/src/test/failure-fixtures.ts` — `fakeSendMail`, `countingSendMail`, `throwingSendMail`, `freshWorkspaceId`, `connectFixtureSendgridKey`, `createFixtureCampaign`, `createFixtureContact`, `sendsStatusFor`, `sendsRowCountFor`, with the RLS constraint carried across in comment form
- `apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts` — 3 tests
- `apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts` — the abort-shaped chain
- `apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts` — the socket-reset chain
- `apps/worker/src/queues/__tests__/send-dispatch-durability.test.ts` — imports the fixtures instead of defining them; `arrangeInterruptedClaim` stays, being specific to its own CR-04 simulation
- `package.json` — `failure:429`, `failure:timeout`, `failure:reset`

## Decisions Made

- **Two files for timeout and reset, not one parameterized file.** They are indistinguishable to `send-dispatch.ts` today — both arrive as a rejected promise, and there is no `AbortController` in `delivery-core/src/send-mail.ts`. The injected errors nonetheless carry distinct identities (`DOMException` named `AbortError` vs `Error` with `code: "ECONNRESET"`), asserted by reference in each file. When Phase 11 gives them different handling, the failing file names which mode regressed instead of one shared test failing ambiguously.
- **`failed`, not `reconciling`.** The `send_status` enum has no `reconciling` value and the code cannot produce one. Asserting the future state would make the harness red from birth, and a permanently-red harness gets deleted rather than fixed. Each terminal assertion carries a comment naming Phase 11 as the point at which it must be changed deliberately.
- **Root-level npm scripts, not workspace scripts.** A developer reproducing an audit finding is standing at the repo root.
- **`freshWorkspaceId` takes the Pool; nothing else does.** `organization` is the one table involved that is not tenant-scoped; every other insert must go through `withTenant`/`withTenantTransaction` because all four carry ENABLE + FORCE ROW LEVEL SECURITY.

## Deviations from Plan

### 1. [Rule 1 — Environment] The plan's `<verify>` commands assume Docker

- **Found during:** Task 1.
- **Issue:** Every `<automated>` block opens with `docker compose up -d --wait`. Docker is not installed on this machine — the constraint 08-01 recorded and 08-04 resolved.
- **Resolution:** Ran the same vitest invocations against the native Postgres and Redis on the same ports and DSNs, which is exactly the amended D-03 ("same services and DSNs, different startup mechanism"). Nothing about the scenarios depends on the startup mechanism — the worker suite provisions its own ephemeral database through `globalSetup`, and both `TEST_ADMIN_DATABASE_URL` (08-07) and the guard were already in place.
- **Verification:** all three scripts exit 0 locally; the same commands run unchanged in CI against compose services.

Beyond that, the plan executed as written. `send-dispatch.ts` was not modified, no package was installed, and no scenario references the SendGrid host.

**Total deviations:** 1 environmental, 0 auto-fixed, 0 architectural.
**Impact on plan:** None. Every artifact exists as specified.

## Issues Encountered

None. The `ProcessSendJobDeps.sendMail` seam was exactly as the plan described, and the three `parseRetryAfter` branches matched the code without adjustment.

One thing worth recording for Phase 11: **the two error shapes are currently indistinguishable in effect**. Both scenarios assert the identical chain and identical terminal state, and they pass for the same reason. Their value today is that they *name* the two modes and pin the baseline; their value in Phase 11 is that they will diverge. Anyone reading them as proof that the system handles timeouts and resets differently would be reading them wrong — the file comments say so explicitly.

## User Setup Required

None. `npm run failure:429`, `failure:timeout` and `failure:reset` need only the local Postgres and Redis the rest of the worker suite already uses.

## Next Phase Readiness

- **`apps/worker/src/queues/__tests__/failure-injection/` and the shared fixture module are the substrate for 08-12 (SIGKILL) and 08-13 (Redis restart)** — the two remaining audit-named modes, both of which need a real OS process or a real container restart rather than a DI fake.
- **QG-06 is not yet complete** and is correctly not marked so: 08-12 and 08-13 also declare it, and the shared-ID gate holds it open until every declaring plan has a SUMMARY.
- **Phase 11 has its baseline.** The delivery state machine cannot be changed safely without this harness, and the three assertions that will need deliberate updating are flagged in place rather than left to be discovered.

---
*Phase: 08-quality-gates-failure-injection-foundation*
*Completed: 2026-07-28*
