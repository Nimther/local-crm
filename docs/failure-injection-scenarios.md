# Failure-injection scenarios

The five failure modes the delivery audit named, each reproducible by one command.

## Why this file exists separately from the coverage number

A coverage percentage measures **which lines executed**, not **which failure modes were
reproduced**. Those are different claims, and letting the percentage stand in as evidence for
these five is the exact substitution Pitfall 22 warns about: coverage can stay green while a
scenario quietly rots, because a deleted assertion still executes the lines around it.

D-20 therefore keeps this checklist deliberately apart from `coverage-baseline.json` and the
gate in `scripts/coverage-gate.mjs`. Neither number can satisfy the other's criterion. QG-06 is
satisfied by the table below being true; QG-03 is satisfied by the threshold. If you are
looking for proof that these scenarios exist, this file — and running the commands — is the
proof.

## The five scenarios

| # | Failure mode | Command | Test file | What is asserted | Injection mechanism |
|---|---|---|---|---|---|
| 1 | SendGrid rate-limits the send (429) | `npm run failure:429` | `apps/worker/src/queues/__tests__/failure-injection/rate-limit-429.test.ts` | `{outcome: "rate_limited", rateLimitMs: 3000}` for `retry-after: 3`; backoff derived from `x-ratelimit-reset` when that header is used instead; the fixed 2s fallback when neither is present; **`sends` row count 0** — the claim was released, not stranded; exactly one send attempt | `ProcessSendJobDeps.sendMail` resolves a crafted 429 |
| 2 | The SendGrid call times out | `npm run failure:timeout` | `apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts` | the abort propagates with its identity intact; `sends` status **`dispatching`** after the rejection; the simulated redelivery makes **0** further send calls and resolves to **`failed`**; row count 1 | injected `sendMail` throws a `DOMException` named `AbortError` |
| 3 | The connection to SendGrid resets | `npm run failure:reset` | `apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts` | identical chain to #2, asserted on a distinct error identity | injected `sendMail` throws an `Error` carrying `code: "ECONNRESET"` |
| 4 | The worker process dies mid-dispatch | `npm run failure:sigkill` | `apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts` | the child's exit signal is **`SIGKILL`** with a null code; `sends` status **`dispatching`** immediately after the kill; the restart makes **0** send calls, resolves to **`failed`**, row count 1 | a real forked process running the real `processSendJob`; the injected `sendMail` posts an IPC marker and then never settles, and the parent kills on that marker |
| 5 | Redis restarts under a live queue | `npm run failure:redis-restart` | `apps/worker/src/queues/__tests__/failure-injection/redis-restart.test.ts` | the waiting count before and after the restart are equal and non-zero; a worker attached afterwards processes **all** of them; and — separately — the same sequence against a server without the versioned config **loses every job** | a real `redis-server` booted from `docker/redis.conf`, stopped with SIGTERM and started again from the same data directory |

## Phase 14 (deployment/database durability) additions

This table predates Phase 14 and was never fully kept current as later phases (11-13) added
further scenarios to `failure:all` (see `package.json`'s own script list for the complete,
authoritative set at any given commit — this file's own header already names the coverage
number as a distinct claim from "which scenarios exist"). The three rows below are Phase 14
plan 07's own additions; earlier gaps between this table and `package.json` are a pre-existing
documentation-staleness item, not something this plan corrects.

| # | Failure mode | Command | Test file | What is asserted | Injection mechanism |
|---|---|---|---|---|---|
| 6 | The migration runner dies mid-run, holding the advisory lock (DB-05, ROADMAP-locked) | `npm run failure:migrate-unclean-death` | `apps/worker/src/queues/__tests__/failure-injection/migrate-unclean-death.test.ts` | no advisory lock for the migration key survives the kill (`pg_locks` empty); the journal contains no entry for a migration that did not fully apply; a second runner acquires the lock, exits 0, and drives the journal to the full shipped set | a real forked `scripts/migrate-runner.mjs` process, SIGKILLed the instant it signals (via its own inert-unless-enabled test hook) that it holds the lock but has not yet called `migrate()` |
| 7 | A worker meets a job payload `schemaVersion` it does not recognize, in both directions (R-05) | `npm run failure:two-version-compat` | `apps/worker/src/queues/__tests__/failure-injection/two-version-compat.test.ts` | an unrecognized-version job is neither processed (no `send_events` row) nor marked failed; a recognized-version job interleaved with it still completes; a legacy pre-versioned payload (no `schemaVersion` field at all) is still processed by the current worker | real jobs enqueued onto a real `WEBHOOK_EVENTS_QUEUE` Worker (`createWebhookEventsWorker`) against a throwaway `startTempRedis()` instance |
| 8 | A real SIGTERM arrives mid-load and the worker must self-terminate inside its stop-grace-period (Pitfall 7) | `npm run failure:sigterm-mid-load` | `apps/worker/src/queues/__tests__/failure-injection/sigterm-mid-load.test.ts` | the child exits on its own, with a clean status, before `WORKER_STOP_GRACE_PERIOD_SECONDS` elapses (no SIGKILL fallback); `/readyz` returns 503 shortly after the signal; no send is left in `dispatching` once the process has exited | a real forked worker process (health server + one BullMQ Worker under sustained fake-send load), sent a real `SIGTERM` |

### Scenario 5 is also WRK-12's survival check

It is the only thing that makes `docker/redis.conf`'s `appendonly yes` / `appendfsync everysec`
a statement about behaviour rather than about a config file. Its second test is the
discrimination proof: against a stock server the jobs are gone after the restart. If that test
ever starts passing with a non-zero count, the first one has stopped proving anything.

### What none of them do

No scenario reaches `api.sendgrid.com` or sends real mail. All five inject through the
`ProcessSendJobDeps.sendMail` seam that has existed since Phase 4, so
`packages/delivery-core/src/send-mail.ts` — which hardcodes the SendGrid endpoint — is never
called. Each asserts its injected function's **call count** rather than trusting absence.

Scenario 5 deliberately stops short of driving Redis to its memory ceiling. BullMQ's behaviour
under `OOM command not allowed` is Phase 12's territory, and extending this scenario into it is
scope creep RESEARCH.md flags by name (Pitfall 6).

## Running them

Each command is independently runnable from the repo root, and that independence is a SPEC
acceptance criterion in its own right — a scenario that only passes when its siblings ran first
is not a reproducible failure mode.

```
npm run failure:429
npm run failure:timeout
npm run failure:reset
npm run failure:sigkill
npm run failure:redis-restart
```

`npm run failure:all` runs the five in sequence. **It is a local convenience and is not what CI
runs.** CI invokes the five separately, precisely so that an ordering dependency between them
would show up as a failure rather than being hidden by an aggregate script.

### Prerequisites

Live Postgres and Redis on the usual ports, plus `redis-server` on `PATH` — scenario 5 starts
its own throwaway instance and never touches the one on 6379.

## For whoever plans Phase 11

Phase 11 changes the delivery state machine and adds a reconciling state to `send_status`. Two
of these scenarios encode **today's** terminal outcome deliberately, and both will need updating
as part of that work — not treated as regressions:

| File | Assertion to revisit |
|---|---|
| `apps/worker/src/queues/__tests__/failure-injection/timeout.test.ts` | `expect(await sendsStatusFor(...)).toBe("failed")` after the redelivery, and `expect(redelivered.outcome).toBe("failed")` |
| `apps/worker/src/queues/__tests__/failure-injection/connection-reset.test.ts` | the same two assertions |
| `apps/worker/src/queues/__tests__/failure-injection/sigkill.test.ts` | `expect(await sendsStatusFor(...)).toBe("failed")` after the restart |

Each site carries a comment naming Phase 11. They assert `failed` because that is what the code
produces today: there is no `reconciling` value in the enum and no `AbortController` in
`send-mail.ts`. A harness asserting a state the system cannot produce is red from birth, and a
permanently-red harness gets deleted rather than fixed.

Note also that scenarios 2 and 3 are currently **indistinguishable in effect** — both arrive at
`processSendJob` as a rejected promise and follow the identical path. They are separate files
with distinct error identities so that when Phase 11 gives them different handling, the failing
file names which mode regressed instead of one shared test failing ambiguously. Reading them as
proof that the system already treats timeouts and resets differently would be reading them
wrong.
