---
phase: 15-observability-alerting-frontend-resilience
plan: 19
subsystem: observability
tags: [pino, asynclocalstorage, correlation, bullmq, sendgrid, logging]

requires:
  - phase: 15-observability-alerting-frontend-resilience
    provides: "packages/tenant-context's CorrelationStore.sendId field and withCorrelation helper (plan 15-02); apps/worker's Pino logger and wrapProcessor (plans 15-02/15-08)"
provides:
  - "sendId bound into the ALS correlation store on all three send-dispatch paths (campaign, test, flow), so it reaches the pino mixin"
  - "four Pino log call sites in send-dispatch.ts: three 'send dispatch claimed' entry lines and one 'send outcome ambiguous' line, all internal-id-only"
  - "executable proof (correlation-tracer.test.ts third `it`) that a captured worker log line carries sendId identical to the SendGrid custom_args.send_id value, alongside requestId/jobId"
  - "SPECIFICATION.md §7 Correlation-модель entry documenting the dispatch-side binding"
affects: ["15-20 (webhook-events.worker.ts per-event sendId binding)", "15-21 (ARCHITECTURE.md §18 correlation-boundary documentation)"]

tech-stack:
  added: []
  patterns:
    - "withCorrelation({ sendId }, async () => { ... }) scope wrapping an entire post-claim dispatch region, returned directly (return withCorrelation(...)) so no control flow moves"
    - "Entry log line as the first statement inside a freshly-opened correlation scope, never before it — the mixin only stamps lines actually emitted from inside the scope"

key-files:
  created: []
  modified:
    - apps/worker/src/queues/send-dispatch.ts
    - apps/worker/src/__tests__/correlation-tracer.test.ts
    - SPECIFICATION.md

key-decisions:
  - "Wrapped the campaign and flow branches immediately after their `const { claim } = claimResult;` destructuring, and the test branch immediately after `const sendId = randomUUID();`, matching the plan's exact placement to avoid moving any existing return/throw/transaction/lane-slot call."
  - "The ambiguity log line in handleAmbiguousSendMailError logs only classifyTransportError's verdict, never `err` itself — an unclassified transport error can echo request-derived content the path-list redactor cannot reach."
  - "Covered campaign-path and flow-path bindings by source/grep assertions rather than two more live-DB integration tests, per the plan's explicit scope note — the mechanism is identical across all three paths and the grep assertion is what the phase re-verifier runs against gap G-15-1."

requirements-completed: [OPS-11]

coverage:
  - id: D1
    description: "sendId bound via withCorrelation on the campaign, test, and flow dispatch paths in send-dispatch.ts, and reaches a real captured Pino log line identical to the value SendGrid receives in custom_args.send_id, alongside requestId and jobId on the same line"
    requirement: "OPS-11"
    verification:
      - kind: unit
        ref: "apps/worker/src/__tests__/correlation-tracer.test.ts#carries sendId into a captured worker log line alongside requestId and jobId, matching the custom_args.send_id SendGrid receives (G-15-1 dispatch half)"
        status: pass
      - kind: other
        ref: "grep -c 'withCorrelation({ sendId' apps/worker/src/queues/send-dispatch.ts == 3"
        status: pass
      - kind: other
        ref: "grep -cE 'logger\\.(info|warn|error)\\(' apps/worker/src/queues/send-dispatch.ts (non-comment) == 4, zero of which match claim.to|testTo|dynamicTemplateData|apiKey|.email"
        status: pass
    human_judgment: false
  - id: D2
    description: "SPECIFICATION.md §7 Correlation-модель subsection documents the dispatch-side binding in the same change as the code (CLAUDE.md same-change filing rule)"
    requirement: "OPS-11"
    verification:
      - kind: other
        ref: "grep -c 'план 15-19' SPECIFICATION.md >= 1; node one-liner confirming the paragraph sits between ### Correlation-модель and ### Структурированное логирование; npm run check:spec-env-coverage exit 0"
        status: pass
    human_judgment: false

duration: 16min
completed: 2026-08-16
status: complete
---

# Phase 15 Plan 19: Dispatch-side sendId correlation binding Summary

**Bound `sendId` into the ALS correlation store on all three send-dispatch paths and emitted four Pino log lines inside those scopes, so `send_id` is greppable in Loki for the first time (G-15-1 dispatch half, OPS-11).**

## Performance

- **Duration:** 16 min
- **Started:** 2026-08-16T13:57:43+05:00 (worktree base)
- **Completed:** 2026-08-16T14:13:18+05:00
- **Tasks:** 2 completed
- **Files modified:** 3

## Accomplishments

- `send-dispatch.ts` now opens `withCorrelation({ sendId ... })` scopes on the campaign path (in `processSendJob`, right after `const { claim } = claimResult;`), the test-send path (right after `const sendId = randomUUID();`), and the flow path (in `processFlowSendJob`, right after its own `const { claim } = claimResult;`) — each scope wraps the entire post-claim region (lane-slot acquire/release, rate limiter, the SendGrid call, every outcome return) with zero change to any `return`/`throw`/transaction/lane-slot/rate-limiter call's position or condition.
- Four Pino call sites added, all inside a correlation scope: `logger.info({ kind: "campaign", campaignId }, "send dispatch claimed")`, `logger.info({ kind: "test", campaignId }, "send dispatch claimed")`, and `logger.info({ kind: "flow", flowRunId, nodeId }, "send dispatch claimed")` as the first statement of each of the three scopes, plus `logger.warn({ classification }, "send outcome ambiguous")` in the shared `handleAmbiguousSendMailError` helper (which inherits `sendId` from whichever caller's scope invoked it — campaign or flow — needing no binding of its own).
- Added a third `it` to `correlation-tracer.test.ts` proving a captured worker log line carries `sendId` strictly equal to the `custom_args.send_id` value the fake `sendMail` received, on the SAME line as `requestId`/`jobId`, with the fixture recipient address absent from the serialized line.
- Filed the dispatch-side binding into `SPECIFICATION.md` §7's `### Correlation-модель` subsection, tagged `план 15-19`, in the same change as the code (per `.claude/CLAUDE.md`'s mandatory same-change filing rule).

## Red-run failure (before the source edit)

The new `it` was run against unmodified `send-dispatch.ts` and failed as expected — no log line anywhere in the captured stdout carried a `sendId` field at all (the field simply didn't exist yet):

```
AssertionError: expected a captured worker log line with sendId=fbedd035-ac23-4cc1-8c06-fd24e3d0dfa9 and requestId=trace-req-sendid-msvl1yl6;
captured lines: [{"level":30,...,"jobId":"e5ac4fb4-...","requestId":"trace-req-msvl1yiz","queue":"email-broadcast","kind":"test","campaignId":"66a184ca-...","msg":"email-broadcast job processing"}, ...]
    ❯ src/__tests__/correlation-tracer.test.ts:264:7
      expected undefined to be defined
```

None of the four captured lines (from the two pre-existing tests plus this new one) had a `sendId` field — confirming the gap the plan describes: the field was declared on `CorrelationStore` but no dispatch call site ever bound or emitted it.

## sendId value shared between the log line and custom_args (passing run)

In the passing run, the fake `sendMail` captured `payload.personalizations[0].custom_args.send_id` into `capturedSendId`, and the test asserted a captured JSON log line existed where `line.sendId === capturedSendId` — this held true for a real `randomUUID()`-derived test-send id (e.g. an id of the shape `fbedd035-ac23-4cc1-8c06-fd24e3d0dfa9` in one local run), proving the byte-identical value flowed from the ALS-bound scope through the pino `mixin()` onto the log line and into the SendGrid request body's `custom_args.send_id` for the same send.

## Four log call sites (by file line, current state)

1. `apps/worker/src/queues/send-dispatch.ts:377` — `logger.warn({ classification }, "send outcome ambiguous")`, inside `handleAmbiguousSendMailError`, run immediately after `classifyTransportError(err)` and before the retry/reconcile branch.
2. `apps/worker/src/queues/send-dispatch.ts:~486` — `logger.info({ kind: "campaign", campaignId }, "send dispatch claimed")`, first statement inside the campaign path's `withCorrelation({ sendId: claim.sendId }, ...)` callback.
3. `apps/worker/src/queues/send-dispatch.ts:~606` — `logger.info({ kind: "test", campaignId }, "send dispatch claimed")`, first statement inside the test-send path's `withCorrelation({ sendId }, ...)` callback.
4. `apps/worker/src/queues/send-dispatch.ts:~774` — `logger.info({ kind: "flow", flowRunId, nodeId }, "send dispatch claimed")`, first statement inside the flow path's `withCorrelation({ sendId: claim.sendId }, ...)` callback.

## `wrapProcessor` boundary confirmation

`wrapProcessor`'s own `"job completed"`/`"job failed"` lines (`apps/worker/src/processor-wrapper.ts`) run **outside** all three new `withCorrelation({ sendId ... })` scopes — they execute in the continuation after the wrapped handler's promise has already settled, which is exactly the AsyncLocalStorage limitation this file's own `ProcessorErrorContext` header comment (and `SPECIFICATION.md`'s план-15-10 paragraph) already documents for `workspace_id`. Confirmed empirically by the captured-lines dump above: in the passing "before this plan" tracer run, both the "email-broadcast job processing" line (from `handleEmailBroadcastJob`, itself inside the scope) and the wrapper's "job completed" line appear, but only the former (and now, post-implementation, the new "send dispatch claimed"/"send outcome ambiguous" lines) carry `sendId` — the wrapper's completion/failure lines never will, by construction. This fact is load-bearing for plan 15-21, which documents this boundary in `ARCHITECTURE.md` §18.

## `git diff --stat` (plan-wide, both tasks)

```
SPECIFICATION.md                                   |   1 +
apps/worker/src/__tests__/correlation-tracer.test.ts |  63 +++
apps/worker/src/queues/send-dispatch.ts            | 562 +++++++++++----------
3 files changed, 366 insertions(+), 260 deletions(-)
```

Exactly the three files the plan's `<verification>` step 7 names.

## Task Commits

Each task was committed atomically:

1. **Task 1: Bind sendId into the correlation store on all three dispatch paths, and emit Pino lines inside those scopes** - `b22e045` (feat, tdd: red observed then green)
2. **Task 2: File the dispatch-side binding into SPECIFICATION.md §7, in this same change** - `1bc8dcb` (docs)

## Files Created/Modified

- `apps/worker/src/queues/send-dispatch.ts` - three `withCorrelation({ sendId ... })` scopes (campaign/test/flow), a `../logger.js` import, four Pino call sites
- `apps/worker/src/__tests__/correlation-tracer.test.ts` - third `it` proving sendId reaches a captured log line alongside requestId/jobId, with the no-PII assertion
- `SPECIFICATION.md` - one new paragraph in §7's `### Correlation-модель` subsection, tagged `план 15-19`

## Decisions Made

- Placement of each `withCorrelation` scope's opening point followed the plan's exact prescription (immediately after the claim destructuring / `randomUUID()` call) rather than any alternative point, so no existing statement's position or condition changed.
- The ambiguity line logs only the two-value `classification` enum, never `err`, consistent with the file's existing `scrubbedConsole` sites' rationale for not trusting a fixed-depth path-list redactor against an unclassified provider/transport throw.
- Campaign-path and flow-path bindings were verified via source/grep assertions (per the plan's explicit `<behavior>` note) rather than two additional live-DB integration tests, since the mechanism is identical across all three paths and a full contact/segment/flow-version fixture for each would duplicate coverage the grep-level check already provides.

## Deviations from Plan

None - plan executed exactly as written. One micro-adjustment made during implementation (not a deviation from the required behavior, purely editorial): the plan's own read_first commentary happened to use the literal substring `withCorrelation({ sendId` in a doc comment inside `handleAmbiguousSendMailError`'s neighborhood; the comment was worded to avoid that literal substring so the `grep -c 'withCorrelation({ sendId'` assertion counts exactly the three real scope-opening call sites (not four), matching the plan's own acceptance criterion.

## Issues Encountered

None. Redis was reachable locally (`redis-cli ping` → `PONG`) and the ephemeral test DB fixture provisioned correctly, so the plan's `<precondition>` was met without needing to halt.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 15-20 (webhook-events.worker.ts per-event sendId binding) and plan 15-21 (ARCHITECTURE.md §18 boundary documentation, plus the two stale-doc fixes plan 15-19/15-20 deliberately did not touch) can proceed — this plan's SUMMARY records the exact `wrapProcessor` boundary fact plan 15-21 needs.
- No blockers. `send_id` is now bound and emitted on all three dispatch paths; the webhook-events half of G-15-1 remains open for plan 15-20.

---
*Phase: 15-observability-alerting-frontend-resilience*
*Completed: 2026-08-16*
