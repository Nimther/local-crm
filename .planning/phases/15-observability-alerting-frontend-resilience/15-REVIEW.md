---
phase: 15-observability-alerting-frontend-resilience
reviewed: 2026-08-16T00:00:00Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - apps/worker/src/queues/send-dispatch.ts
  - apps/worker/src/queues/webhook-events.worker.ts
  - apps/worker/src/__tests__/correlation-tracer.test.ts
  - apps/worker/src/queues/__tests__/send-dispatch-error-listener.test.ts
  - apps/worker/src/queues/__tests__/webhook-events-sendid-correlation.test.ts
  - ARCHITECTURE.md
  - SPECIFICATION.md
findings:
  critical: 0
  warning: 0
  info: 1
  total: 1
status: issues_found
---

# Phase 15: Code Review Report (gap-closure diff, plans 15-19..15-21)

**Reviewed:** 2026-08-16T00:00:00Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found (Info only — no Critical or Warning findings)

## Summary

Scope: the diff from `6a721bf3a686607042bcc89d257e228d43f22e71` to HEAD, confirmed via
`git diff --name-only 6a721bf..HEAD -- . ':!.planning/'` to touch exactly the seven files
listed above and no others (in particular, `processor-wrapper.ts` and
`application-name-correlation.test.ts` — both discussed in the SPECIFICATION.md/
ARCHITECTURE.md prose as WR-03/CR-01 context — are NOT part of this diff; their current
state was already correct going into it, and the docs cite them only as historical
grounding for this diff's own claims).

This is a small, well-scoped gap-closure change: it adds `withCorrelation({ sendId })`
scopes around the existing post-claim dispatch regions in `send-dispatch.ts` (campaign,
test-send, flow) and around the existing per-event side-effect application in
`webhook-events.worker.ts`, plus five new Pino log call sites (four in send-dispatch.ts:
three `"send dispatch claimed"` + one `"send outcome ambiguous"`; one in
webhook-events.worker.ts: `"webhook event applied to send"`). I diffed both worker files
against their pre-gap-closure versions line-by-line: every wrap is purely additive —
no `return`/`throw`/transaction/lane-slot/rate-limiter call changed position or
condition, confirming the plans' own stated invariant in code, not just in the doc
comments that assert it.

**PII / scope-placement checks (the stated focus of this review) — all clean:**
- None of the five new log lines includes a recipient email, template data, SendGrid
  API key, bounce/drop `reason` text, or raw webhook `payload`. Each carries only
  internal ids (`campaignId`, `flowRunId`, `nodeId`, `sendId` via mixin) or a
  two-value classification enum (`classifyTransportError`'s verdict).
- The webhook per-event `withCorrelation({ sendId: send.id })` scope opens strictly
  inside the `for (const row of newRows)` loop, immediately after the same-transaction
  liveness re-check (`if (!send) continue;`), and closes when that iteration's async
  callback settles — verified against `webhook-events-sendid-correlation.test.ts`'s
  "two sends in one batch produce two lines with two distinct sendId values" test,
  which proves no cross-event identifier bleed.
- The three send-dispatch scopes (campaign/test/flow) each open immediately after the
  send's own id becomes available (`claim.sendId` destructure, or `randomUUID()` for
  test) and wrap the entire remainder of that branch (lane-slot, rate limiter,
  SendGrid call, every outcome return) — confirmed against the "carries sendId into a
  captured worker log line ... matching the custom_args.send_id SendGrid receives"
  test in `correlation-tracer.test.ts`, including its explicit assertion that the
  fixture recipient address never appears on the matching line.

**Doc-accuracy checks (ARCHITECTURE.md §18 correlation model, SPECIFICATION.md §3/§7)
— all verified against the actual code/config, not taken on faith:**
- ARCHITECTURE.md's per-field correlation table (`workspaceId`/`requestId`/`jobId`/
  `sendId` — where each is bound, where each is absent) matches the code exactly,
  including the claim that `wrapProcessor`'s own "job completed"/"job failed" lines
  never carry `sendId` — traced through `processor-wrapper.ts` and confirmed: those
  `child.info`/`child.error` calls run after the awaited `withCorrelation({jobId,
  requestId}, ...)` promise has already settled and its `AsyncLocalStorage.run()`
  scope has exited, so the mixin picks up no `sendId` at that point. This is a correct
  description of real `AsyncLocalStorage` behavior, not a hand-wave.
- The doc's exact call-site count ("ровно четыре call site" in send-dispatch.ts, one
  in webhook-events.worker.ts) matches what's actually in the diff — 4 + 1 = 5,
  counted directly against the code.
- SPECIFICATION.md's §3 CR-01 fix description (SENTRY_DSN_API/WORKER/ENVIRONMENT moved
  exclusively to `env_file: { path: ${MEGA_CRM_ENV_FILE}, required: false }`, removed
  from the `environment:` blocks; `IMAGE_TAG` deliberately kept as compose-level
  `${VAR}` interpolation because `scripts/deploy.sh` does `export IMAGE_TAG`) was
  checked directly against `docker/docker-compose.prod.yml` (grep for the three
  Sentry var names confirms they appear only in comments, never as `environment:`
  keys) and against `scripts/deploy.sh:346` (`export IMAGE_TAG="$target"`) — both
  match the doc's claims exactly.
- The "844-line file, no structured-logger call site before this plan" claim about
  `webhook-events.worker.ts` was checked against `git show
  6a721bf...:apps/worker/src/queues/webhook-events.worker.ts | wc -l` → 844, confirming
  the doc describes the pre-diff state accurately.

No Critical or Warning findings in the diff region. One Info finding below (a
message/data mismatch on one log line, not a functional defect).

## Info

### IN-01: "send outcome ambiguous" log message fires on a branch that is not ambiguous

**File:** `apps/worker/src/queues/send-dispatch.ts:377`
**Issue:** `handleAmbiguousSendMailError` logs `logger.warn({ classification },
"send outcome ambiguous")` unconditionally, before branching on `classification`.
For `classification === "pre_connection_retryable"` the very next lines (378-382)
release the already-committed claim and rethrow the original error for a bounded
BullMQ retry — this is the one case the function's own doc comment describes as
NOT ambiguous ("a provable DNS failure or refused connection... the transport layer
proved the request never left this process"). The log line's fixed message string
therefore asserts "outcome ambiguous" on a line whose own `classification` field
says otherwise. The structured field makes this recoverable for any consumer that
filters on `classification` rather than the message text, so this doesn't rise to a
correctness bug — but an operator or alert rule matching on the message string
`"send outcome ambiguous"` (e.g. a Loki/Grafana panel counting ambiguous-outcome
volume, which is exactly the kind of consumer this observability phase is building)
would over-count provable, cleanly-retried transport failures as genuine ambiguous
sends requiring reconciler attention.
**Fix:** Move the `logger.warn` call below the `if (classification ===
"pre_connection_retryable")` branch so it only fires on the path that actually writes
`reconciling`, and log a distinct message (e.g. `"send retry: pre-connection
failure"` via `logger.info`) on the retryable branch:
```ts
async function handleAmbiguousSendMailError(
  err: unknown,
  sendId: string,
  dispatchedAt: Date,
  writeReconciling: (client: PoolClient, dispatchDurationMs: number) => Promise<void>
): Promise<SendJobResult> {
  const dispatchDurationMs = Date.now() - dispatchedAt.getTime();
  const classification = classifyTransportError(err);

  if (classification === "pre_connection_retryable") {
    logger.info({ classification }, "send retry: pre-connection failure");
    await withTenantTransaction((client) => releaseDispatchClaim(client, sendId));
    throw err;
  }

  logger.warn({ classification }, "send outcome ambiguous");
  await withTenantTransaction((client) => writeReconciling(client, dispatchDurationMs));
  return { outcome: "reconciling", sendId };
}
```
No control-flow change — same two branches, same releases/rethrow/reconciling write,
only the log call moved and split.

---

_Reviewed: 2026-08-16T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
