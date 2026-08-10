import { Queue } from "bullmq";
import {
  EMAIL_TRIGGERED_QUEUE,
  FLOW_RUN_ADVANCE_QUEUE,
  FLOW_SEGMENT_SWEEP_FLOW_QUEUE,
  FLOW_TRIGGER_EVALUATOR_QUEUE,
  type EmailTriggeredJob,
  type FlowRunAdvanceJob,
  type FlowSegmentSweepFlowJob,
  type FlowTriggerCheckJob,
} from "@mega-crm/shared-schemas";
import { buildRedisConnectionOptions } from "../connection.js";

/** Mirrors campaign-broadcast-producer.ts's DEFAULT_JOB_OPTIONS (02-10 convention). */
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
};

/**
 * flowRunAdvanceQueue's OWN job options (CR-01 fix, 06-12) -- deliberately
 * NOT the shared `DEFAULT_JOB_OPTIONS` above. Retry resilience (`attempts`/
 * `backoff`) is unchanged, but retention differs: a completed advance job is
 * removed immediately (`removeOnComplete: true`) so a future wake for the
 * SAME run can never be shadowed by a still-retained completed job under a
 * reused id (the CR-01 root cause -- BullMQ `Queue.add()` no-ops while a job
 * with the given id exists in ANY state). Failed advance jobs are retained
 * ~24h (`removeOnFail: { age: 86400 }`, not `false`/forever) so a failure is
 * observable without growing Redis unboundedly.
 */
const FLOW_RUN_ADVANCE_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: true,
  removeOnFail: { age: 86400 },
};

function requireRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker's flow-queues producers");
  }
  return redisUrl;
}

/**
 * Worker-side producer Queue for `EMAIL_TRIGGERED_QUEUE`'s flow-step sends
 * (FLOW-01) -- `handlers/send-node.ts`'s `handleSendNode` enqueues onto this
 * SAME queue `email-triggered.worker.ts` already consumes (no forked send
 * lane, mirrors `campaign-broadcast-producer.ts`'s singleton-Queue-module
 * convention: ONE producer instance per queue name per process, reused by
 * every in-process call site rather than constructed ad hoc). `jobId` is
 * deterministic (`${flowRunId}-${nodeId}`, set at the call site) so a
 * redelivered advance can never double-enqueue the same step's send.
 */
export const emailTriggeredQueue = new Queue<EmailTriggeredJob>(EMAIL_TRIGGERED_QUEUE, {
  connection: buildRedisConnectionOptions(requireRedisUrl()),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

/**
 * Worker-side producer Queue for `FLOW_RUN_ADVANCE_QUEUE` -- the engine's
 * own per-run "tick". Uses `FLOW_RUN_ADVANCE_JOB_OPTIONS` (its own options,
 * NOT the shared `DEFAULT_JOB_OPTIONS`) -- see that constant's doc comment
 * for why (CR-01, 06-12). Every producer of a job on this queue MUST enqueue
 * via `enqueueFlowRunAdvance` below, never `flowRunAdvanceQueue.add(...)`
 * directly, so every wake gets a unique-per-wake jobId.
 */
export const flowRunAdvanceQueue = new Queue<FlowRunAdvanceJob>(FLOW_RUN_ADVANCE_QUEUE, {
  connection: buildRedisConnectionOptions(requireRedisUrl()),
  defaultJobOptions: FLOW_RUN_ADVANCE_JOB_OPTIONS,
});

/**
 * The SOLE way to enqueue a `flowRunAdvanceQueue` job (CR-01 fix, 06-12).
 * `jobId` is unique per wake (`${flowRunId}-${Date.now()}`) -- it embeds the
 * flowRunId for greppability/observability, but the timestamp suffix
 * guarantees an in-flight/completed/failed job for the same run can never
 * shadow a future wake for that same run. Idempotency/safety is NOT provided
 * by jobId dedup here -- it comes from `processFlowRunAdvance`'s
 * queue-as-doorbell guards (status/next_wake_at re-check + `FOR UPDATE OF fr
 * SKIP LOCKED`), so duplicate/stacked advance jobs for one run are harmless
 * no-ops rather than double-executions.
 */
export async function enqueueFlowRunAdvance(
  payload: FlowRunAdvanceJob,
  opts?: { delay?: number }
): Promise<void> {
  await flowRunAdvanceQueue.add("advance", payload, {
    jobId: `${payload.flowRunId}-${Date.now()}`,
    ...(opts?.delay !== undefined ? { delay: opts.delay } : {}),
  });
}

/**
 * Worker-side producer Queue for `FLOW_TRIGGER_EVALUATOR_QUEUE` (FLOW-02,
 * 06-06) -- `events-ingest.worker.ts` enqueues here once per ingested event,
 * right after the event upsert commits, so `flow-trigger-evaluator.worker.ts`
 * can match the event's name against live event-triggered flows. Same
 * singleton-Queue-module convention as the other producers in this file.
 */
export const flowTriggerEvaluatorQueue = new Queue<FlowTriggerCheckJob>(FLOW_TRIGGER_EVALUATOR_QUEUE, {
  connection: buildRedisConnectionOptions(requireRedisUrl()),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

/**
 * flowSegmentSweepFlowQueue's OWN job options (Phase 12, WRK-05/WRK-06,
 * D-09) -- deliberately NOT the shared `DEFAULT_JOB_OPTIONS` above, for the
 * SAME reason `FLOW_RUN_ADVANCE_JOB_OPTIONS` isn't either (CR-01, 06-12):
 * `removeOnComplete: true` so a retained completed job under a reused
 * jobId (deterministic per flow, `sweep-${flowId}`, set by the discovery
 * tick in `flow-segment-sweep.worker.ts`) can never shadow the NEXT
 * discovery tick's enqueue for that same flow -- BullMQ's `Queue.add()`
 * no-ops while a job with the given id exists in ANY state, and a
 * still-running (or still-retained-completed) sweep for a flow must never
 * be double-enqueued. `removeOnFail` is retained for a bounded window (not
 * `false`/forever) so a failed walk is inspectable without growing Redis
 * unboundedly.
 */
const FLOW_SEGMENT_SWEEP_FLOW_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: true,
  removeOnFail: { age: 86400 },
};

/**
 * Worker-side producer Queue for `FLOW_SEGMENT_SWEEP_FLOW_QUEUE` (WRK-05/
 * WRK-06, D-09) -- `flow-segment-sweep.worker.ts`'s discovery tick enqueues
 * one bounded-walk job per live segment-triggered flow here. Same
 * singleton-Queue-module convention as the other producers in this file;
 * exported so both the discovery worker and the failure-injection/test
 * suites can enqueue onto (or inspect) it directly without a live queue
 * round trip through a separate module.
 */
export const flowSegmentSweepFlowQueue = new Queue<FlowSegmentSweepFlowJob>(FLOW_SEGMENT_SWEEP_FLOW_QUEUE, {
  connection: buildRedisConnectionOptions(requireRedisUrl()),
  defaultJobOptions: FLOW_SEGMENT_SWEEP_FLOW_JOB_OPTIONS,
});
