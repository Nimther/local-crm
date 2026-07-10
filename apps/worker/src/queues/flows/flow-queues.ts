import { Queue } from "bullmq";
import {
  EMAIL_TRIGGERED_QUEUE,
  FLOW_RUN_ADVANCE_QUEUE,
  FLOW_TRIGGER_EVALUATOR_QUEUE,
  type EmailTriggeredJob,
  type FlowRunAdvanceJob,
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
 * own per-run "tick". `flow-reconciliation.worker.ts`'s due-run backstop
 * enqueues here with `jobId: flowRunId` (Task 2), the SAME dedupe
 * convention `campaign-scheduler.worker.ts`'s kickoff enqueue uses, so a
 * burst of redelivered nudges for the SAME run can never stack up more than
 * one pending advance job.
 */
export const flowRunAdvanceQueue = new Queue<FlowRunAdvanceJob>(FLOW_RUN_ADVANCE_QUEUE, {
  connection: buildRedisConnectionOptions(requireRedisUrl()),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

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
