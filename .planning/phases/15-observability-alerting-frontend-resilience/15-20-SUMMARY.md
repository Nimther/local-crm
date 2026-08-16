---
phase: 15-observability-alerting-frontend-resilience
plan: 20
subsystem: observability
tags: [pino, asynclocalstorage, correlation, bullmq, sendgrid, webhook]

requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "packages/tenant-context's CorrelationStore.sendId field and withCorrelation helper (plan 15-02); apps/worker's Pino logger and mixin() (plan 15-02); the dispatch-side sendId binding on send-dispatch.ts (plan 15-19), which this plan closes the loop with"
provides:
  - "one withCorrelation({ sendId: send.id }) scope opened per resolved webhook event inside processWebhookEventBatch's for-loop, immediately after the defensive live-send re-check"
  - "the first structured Pino call site apps/worker/src/queues/webhook-events.worker.ts has ever had -- logger.info({ eventType, isTest }, \"webhook event applied to send\")"
  - "webhook-events-sendid-correlation.test.ts -- a new suite capturing real Pino output and proving sendId/workspaceId land on the line, per-event (not per-batch) attribution, and no PII/reason leak"
  - "SPECIFICATION.md §7 Correlation-модель entry (tagged план 15-20) documenting the webhook-side binding, sibling to план 15-19's dispatch-side entry"
affects: ["15-21 (ARCHITECTURE.md §18 correlation-boundary documentation and the two stale-doc fixes)"]

tech-stack:
  added: []
  patterns:
    - "withCorrelation({ sendId }, async () => { ... }) scope opened PER EVENT inside a batch-processing loop, immediately after the point a per-event identifier is proven live -- never around the batch or the enclosing transaction, since a batch spans many different sends"
    - "Hoisting a narrowed property (row.normalizedType) into a local const before entering a closure, so TypeScript's control-flow narrowing (which does not cross function boundaries) survives into the callback"

key-files:
  created:
    - apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts
  modified:
    - apps/worker/src/queues/webhook-events.worker.ts
    - SPECIFICATION.md

key-decisions:
  - "Wrapped only the applyEventSideEffects call, opened immediately after `if (!send) continue;` -- the first point send.id is a proven-live send in this workspace -- exactly matching the plan's key_link, so no existing continue guard, insert, quarantine write, debounceWebhookHealth, or markIngestionComplete call moved."
  - "Hoisted `const normalizedType = row.normalizedType;` right before opening the scope, after the plan's advisor-flagged catch that property narrowing on `row.normalizedType === null` does not survive across the `async () => {...}` closure boundary passed to withCorrelation -- avoids a tsc failure without touching (or reordering) the guard itself."
  - "Test 3's PII-leak fixture uses a `delivered` event (not a bounce/dropped subtype) carrying the fixture email inside `reason` -- extractEventRow captures `row.reason` from any event type regardless of its normalizedType, so this avoids needing a bounce_hard-specific type/subtype pairing while still exercising the exact no-PII guarantee (T-15-20-01)."
  - "Reworded the doc comment immediately above the new withCorrelation call site to avoid the literal substring `withCorrelation({ sendId` -- the plan's own grep gate (`grep -c 'withCorrelation({ sendId' == 1`) would otherwise count the comment as a second occurrence, the exact trap plan 15-19's SUMMARY documented hitting and fixing."

requirements-completed: [OPS-11]

coverage:
  - id: D1
    description: "webhook-events.worker.ts opens a per-event withCorrelation({ sendId: send.id }) scope inside processWebhookEventBatch's for-loop and emits one Pino line inside it, so an ingested provider event for a live send produces a structured line carrying that send's identifier and workspace -- joining with plan 15-19's dispatch-side binding on the same sendId"
    requirement: "OPS-11"
    verification:
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts#emits a captured log line with sendId equal to the resolved send's id and workspaceId equal to the fixture workspace"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts#binds sendId per event, not per batch: two sends in one batch produce two lines with two distinct sendId values"
        status: pass
      - kind: unit
        ref: "apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts#never puts the provider reason text or a contact email onto a line carrying a sendId"
        status: pass
      - kind: other
        ref: "grep -c 'withCorrelation({ sendId' apps/worker/src/queues/webhook-events.worker.ts == 1"
        status: pass
      - kind: other
        ref: "grep -v comments apps/worker/src/queues/webhook-events.worker.ts | grep -cE 'logger\\.(info|warn|error)\\(' == 1, matching none of row.reason|row.payload|rawEvent|.email"
        status: pass
      - kind: integration
        ref: "webhook-events-status.test.ts + webhook-events-idempotency.test.ts + webhook-events-sibling-drop.test.ts + webhook-open-click-counts.test.ts (22 tests, unchanged)"
        status: pass
    human_judgment: false
  - id: D2
    description: "SPECIFICATION.md §7 Correlation-модель subsection documents the webhook-side binding in the same change as the code (CLAUDE.md same-change filing rule)"
    requirement: "OPS-11"
    verification:
      - kind: other
        ref: "grep -c 'план 15-20' SPECIFICATION.md >= 1; grep -c 'webhook event applied to send' SPECIFICATION.md >= 1; grep -c 'план 15-19' SPECIFICATION.md >= 1; node one-liner confirming both paragraphs sit between ### Correlation-модель and ### Структурированное логирование; npm run check:spec-env-coverage exit 0"
        status: pass
    human_judgment: false

duration: 22min
completed: 2026-08-16
status: complete
---

# Phase 15 Plan 20: Webhook-side sendId correlation binding Summary

**Bound `sendId` into the ALS correlation store per resolved webhook event in `webhook-events.worker.ts` and emitted its first-ever structured Pino line, closing the webhook half of G-15-1 (OPS-11) so a send's identifier now joins the dispatch line (plan 15-19) and the provider-event line in one Loki query.**

## Performance

- **Duration:** 22 min
- **Tasks:** 2 completed
- **Files modified:** 3 (1 new test file, 1 source file, 1 doc)

## Accomplishments

- `webhook-events.worker.ts` — 844 lines that manipulate `sendId` throughout (extraction, live-send re-resolution, FK nulling) but previously had ZERO structured logger calls — now opens `withCorrelation({ sendId: send.id }, async () => { ... })` inside `processWebhookEventBatch`'s `for (const row of newRows)` loop, immediately after the defensive `if (!send) continue;` re-check, wrapping only the `applyEventSideEffects` call.
- One Pino call site added as the first statement inside that scope: `logger.info({ eventType: normalizedType, isTest: row.isTest }, "webhook event applied to send")` at line 811. `sendId`/`workspaceId` arrive via `mixin()`, never passed explicitly.
- The scope is deliberately per-event: a webhook batch carries events for many different sends, and a scope hoisted to the batch or transaction level would stamp one arbitrary send's identifier onto every other send's lines in the same batch — confidently wrong correlation, worse than no correlation at all.
- New suite `webhook-events-sendid-correlation.test.ts` (3 tests) captures real Pino stdout output (same technique as `correlation-tracer.test.ts`: spy `process.stdout.write` in `beforeAll` before any static import reaches `../logger.js`, then dynamically import `../../logger.js` and bump its level to `"info"`, then dynamically import `../webhook-events.worker.js`).
- Filed the webhook-side binding into `SPECIFICATION.md` §7's `### Correlation-модель` subsection, tagged `план 15-20`, immediately after `план 15-19`'s dispatch-side paragraph, in the same change as the code.

## Red-run output (before the source edit)

Running the new suite against unmodified `webhook-events.worker.ts` produced exactly the failure the gap describes — every captured-lines array was empty, because the file emitted zero log lines of any kind (not the static-import-capture-trap shape, which would still show zero lines but from a suite that never reached a real assertion; here the suite ran and asserted correctly, and genuinely observed nothing to find):

```
FAIL src/queues/__tests__/webhook-events-sendid-correlation.test.ts > ... > emits a captured log line with sendId equal to the resolved send's id and workspaceId equal to the fixture workspace
AssertionError: expected a captured worker log line with sendId=1f83c973-6bdc-4c02-86a4-6fb212be0db7; captured lines: []: expected undefined to be defined

FAIL src/queues/__tests__/webhook-events-sendid-correlation.test.ts > ... > binds sendId per event, not per batch: two sends in one batch produce two lines with two distinct sendId values
AssertionError: expected exactly one line per fixture send id; captured lines: []: expected [] to have a length of 2 but got +0

FAIL src/queues/__tests__/webhook-events-sendid-correlation.test.ts > ... > never puts the provider reason text or a contact email onto a line carrying a sendId
AssertionError: expected at least one line with sendId=47a736a3-5486-4295-a3f9-015b2aff90d9; captured lines: []: expected 0 to be greater than 0

Test Files  1 failed (1)
     Tests  3 failed (3)
```

All three tests were red for the correct reason (the missing feature — no logger call existed anywhere in the file to capture), not a harness artifact. The precondition probe (`webhook-events-status.test.ts`, run once first, 6/6 passing) confirmed the DB fixture harness itself was healthy before this red run, so the empty capture is attributable to the source gap, not to a broken test rig.

## Two distinct sendId values (Test 2, per-event proof)

Test 2 arranged two `sends` rows in one workspace and submitted one batch carrying one `delivered` event per send. The two captured lines carried:

- `sendIdA = 55d0943e-1537-4c21-a569-ad439b861d0f`
- `sendIdB = 45457798-dd00-4647-a92a-bab064631f7c`

Two lines, two distinct ids, each equal to its own fixture send — confirming the scope resets per iteration and never leaks one event's identifier onto another event's line in the same batch. This is the assertion that would fail against a scope hoisted to batch/transaction level, the specific wrong implementation the plan's `key_links` forbid.

## New call site (exact line)

`apps/worker/src/queues/webhook-events.worker.ts:811` — `logger.info({ eventType: normalizedType, isTest: row.isTest }, "webhook event applied to send")`, the first statement inside the new `withCorrelation({ sendId: send.id }, async () => { ... })` scope (opened at line 810), itself immediately after the `if (!send) continue;` guard at line 804.

## Four pre-existing regression suites (unchanged)

`webhook-events-status.test.ts`, `webhook-events-idempotency.test.ts`, `webhook-events-sibling-drop.test.ts`, and `webhook-open-click-counts.test.ts` — 22 tests total, all pass unchanged. `webhook-open-click-counts.test.ts` in particular drives `applyEventSideEffects` (the exact call the new scope wraps) through open/click counter assertions, confirming the scope introduces no branch and no behavior change.

## `git diff --stat` (plan-wide, both tasks)

```
SPECIFICATION.md                                     |   1 +
apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts | 241 +++++++++++++++++++++
apps/worker/src/queues/webhook-events.worker.ts      |  28 ++-
3 files changed, 263 insertions(+), 7 deletions(-)
```

Exactly the three files the plan's `<verification>` step 8 names.

## Grep/type gates (all pass)

- `grep -c 'withCorrelation({ sendId' apps/worker/src/queues/webhook-events.worker.ts` == 1
- Non-comment `logger\.(info|warn|error)\(` count == 1, matching none of `row\.reason|row\.payload|rawEvent|\.email`
- `scrubbedConsole` site count == 3 (the pre-existing `sibling_workspace_event_dropped` site plus the other two unrelated pre-existing sites in this file, all untouched)
- `npx tsc -p apps/worker/tsconfig.json --noEmit` exits 0
- `grep -c 'план 15-20' SPECIFICATION.md` == 1; `grep -c 'webhook event applied to send' SPECIFICATION.md` == 1; `grep -c 'план 15-19'` == 1 (unchanged)
- `npm run check:spec-env-coverage` — 53 names checked, all present
- Node one-liner confirms both `план 15-19` and `план 15-20` sit inside `### Correlation-модель`, before `### Структурированное логирование`

## Task Commits

Each task was committed atomically:

1. **Task 1: Bind sendId per resolved webhook event and emit one Pino line inside that scope** - `b5bb962` (feat, tdd: red observed then green)
2. **Task 2: File the webhook-side binding into SPECIFICATION.md §7, in this same change** - `33b7c95` (docs)

## Files Created/Modified

- `apps/worker/src/queues/webhook-events.worker.ts` - one `withCorrelation({ sendId: send.id })` scope opened per event, a `../logger.js` import, one Pino call site
- `apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts` - new suite proving the field lands, per-event (not per-batch) attribution, and no PII leak
- `SPECIFICATION.md` - one new paragraph in §7's `### Correlation-модель` subsection, tagged `план 15-20`

## Decisions Made

- Placement of the `withCorrelation` scope followed the plan's exact prescription (immediately after the `if (!send) continue;` re-check, wrapping only `applyEventSideEffects`), so no existing `continue` guard, insert, quarantine write, `debounceWebhookHealth`, or `markIngestionComplete` call moved position.
- Hoisted `const normalizedType = row.normalizedType;` before opening the scope, since TypeScript's null-narrowing on `row.normalizedType === null` (checked earlier in the loop) does not survive across the `async () => {...}` closure boundary passed to `withCorrelation` — a compile error otherwise, with no change to the guard itself.
- Test 3 planted the PII fixture inside a `delivered` event's `reason` field rather than a `bounce_hard`/`dropped` event, since `extractEventRow` captures `row.reason` for every event type regardless of its normalized outcome — this exercises the exact no-PII guarantee without needing a bounce-specific type/subtype pairing.
- Reworded the doc comment directly above the new call site to avoid the literal substring `withCorrelation({ sendId` (used a paraphrase instead) so the plan's own grep gate counts exactly the one real scope-opening call site, not two — the same trap plan 15-19's SUMMARY recorded hitting and fixing.

## Deviations from Plan

None - plan executed exactly as written. One micro-adjustment during implementation (not a deviation from required behavior, purely editorial): reworded a doc comment to avoid accidentally tripping the plan's own literal-substring grep gate, matching the precedent plan 15-19 already set for the same trap.

## Issues Encountered

None. Postgres and Redis were both reachable locally (`pg_isready` succeeded, `redis-cli ping` → `PONG`), and the ephemeral test DB fixture provisioned correctly on the first `ensureTestDbMigrated()` call, so the plan's `<precondition>` was met without needing to halt. A precondition probe (running the existing `webhook-events-status.test.ts` suite once before writing the new test) confirmed the harness was healthy before attributing the new suite's initial all-empty-captures failure to the missing source feature.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 15-21 (ARCHITECTURE.md §18 boundary documentation, plus the two stale-doc fixes plans 15-19/15-20 deliberately did not touch) can proceed.
- No blockers. `send_id` is now bound and emitted on both halves of the send lifecycle this milestone targeted: dispatch (plan 15-19) and webhook ingestion (this plan). G-15-1 is fully closed at the code level; plan 15-21 remains for the documentation-accuracy gaps the phase verifier also flagged (ARCHITECTURE.md §18's stale requestId-fallback claim and its overclaim about sendId propagation, both of which predate this plan and this plan's own paragraph does not restate).

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-16*
