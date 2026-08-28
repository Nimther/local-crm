import { flowRunAdvanceQueue } from "../queues/flows/flow-queues.js";

/**
 * Redis-side test isolation for `FLOW_RUN_ADVANCE_QUEUE` (debug session
 * `flow-run-advance-shared-redis`, 2026-08-28).
 *
 * WHY THIS EXISTS. The harness isolates Postgres but NOT Redis. The
 * `globalSetup` guard in `packages/test-support` provisions and drops a fresh
 * ephemeral database every run, while every worker/api test process points at
 * ONE shared Redis logical DB (`redis://localhost:6379/1`, see
 * `apps/worker/vitest.base.config.ts`) with no per-run BullMQ `prefix` and no
 * cleanup anywhere. BullMQ jobs enqueued by one run therefore survive into the
 * next one indefinitely (measured 2026-08-28 on a developer machine: 21973
 * waiting `webhook-events` jobs, 3180 `flow-trigger-evaluator`, 2911
 * `email-triggered`, ... none ever consumed or cleaned).
 *
 * For every queue except this one that residue is inert dead weight, because
 * the worker suite contains no consumer for it. `flow-run-advance` is the ONE
 * exception: `flow-run-advance-integration.test.ts` (and now
 * `flow-run-advance-queue-isolation.test.ts`) registers a REAL BullMQ `Worker`
 * on it via `createFlowRunAdvanceWorker`, which passes `{ connection }` and
 * nothing else -- so BullMQ's DEFAULT concurrency of 1 applies. That turns
 * residue from dead weight into WORK: every foreign job ahead of the test's own
 * job in the FIFO wait list costs one serial `withTenantTransaction` round trip
 * (measured 2.15 ms/job idle, several times that under v8 coverage
 * instrumentation plus concurrent Postgres load) before the test's own hop can
 * start -- against a fixed 10s `waitFor` budget. Hence the load-dependent
 * "passes in isolation, fails in the full suite" flake signature, and hence a
 * self-sustaining feedback loop: a run that times out abandons the backlog it
 * inherited for the next run.
 *
 * WHEN TO CALL IT. Any test file that constructs a real Worker on this queue
 * MUST call this in its `beforeAll` and MUST do so BEFORE constructing the
 * Worker. Before, not after: a constructed Worker begins consuming
 * immediately and may already have moved jobs into `active`, and `drain()`
 * removes only wait/paused/prioritized (plus delayed, with `true`) -- never
 * `active`. Draining after the Worker exists would leave exactly the jobs
 * whose cost is already being paid.
 *
 * Safe under `fileParallelism: false` (set in `apps/worker/vitest.base.config.ts`
 * for this very queue): no other file executes during these `beforeAll` hooks,
 * so this cannot destroy a job another file still needs. All four sibling
 * producer files that enumerate this queue (`flow-run-advance.test.ts`,
 * `flow-trigger-evaluator.test.ts`, `flow-segment-trigger.test.ts`,
 * `flow-send-idempotency.test.ts`) assert only on jobs they enqueue themselves
 * within their own file, filtered by their own `data.flowRunId`.
 *
 * @returns how many jobs were removed -- the depth of the foreign backlog this
 *   suite would otherwise have inherited as its own serial workload. Sampled
 *   BEFORE the drain because BullMQ's `Queue.drain()` resolves to `void`, not a
 *   count.
 */
export async function isolateFlowRunAdvanceQueueForTest(): Promise<number> {
  // Exactly the states `drain(true)` removes -- so the returned number is the
  // count of what was actually destroyed, not an approximation.
  const counts = await flowRunAdvanceQueue.getJobCounts("wait", "paused", "prioritized", "delayed");
  const removed = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);

  await flowRunAdvanceQueue.drain(true);

  return removed;
}
