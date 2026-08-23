import { Queue } from "bullmq";
import {
  CAMPAIGN_KICKOFF_QUEUE,
  EMAIL_BROADCAST_QUEUE,
  EMAIL_TRIGGERED_QUEUE,
  ERASURE_SCRUB_QUEUE,
  EVENTS_INGEST_QUEUE,
  FLOW_ENROLL_EXISTING_QUEUE,
  FLOW_RECONCILIATION_QUEUE,
  FLOW_RUN_ADVANCE_QUEUE,
  FLOW_SEGMENT_SWEEP_FLOW_QUEUE,
  FLOW_SEGMENT_SWEEP_QUEUE,
  FLOW_TRIGGER_EVALUATOR_QUEUE,
  IMPORTS_CSV_QUEUE,
  SEND_RECONCILER_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
} from "@mega-crm/shared-schemas";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { emailBroadcastQueue } from "./campaign-broadcast-producer.js";
import {
  emailTriggeredQueue,
  flowRunAdvanceQueue,
  flowSegmentSweepFlowQueue,
  flowTriggerEvaluatorQueue,
} from "./flows/flow-queues.js";
import { CAMPAIGN_SCHEDULER_QUEUE } from "./campaign-scheduler.worker.js";
import { ANALYTICS_RECONCILE_QUEUE } from "./analytics-reconciliation.worker.js";
import { PARTITION_MAINTENANCE_QUEUE } from "./partition-maintenance.worker.js";
import { WEBHOOK_REPLAY_SWEEP_QUEUE } from "./webhook-replay-sweep.worker.js";
import { REPUTATION_TICK_QUEUE } from "./reputation-tick.worker.js";
import { ERASURE_SCRUB_RECLAIM_QUEUE } from "./erasure-scrub-reclaim.worker.js";
import { WORKSPACE_PURGE_QUEUE } from "./workspace-purge.worker.js";
import { registerTrackedQueue } from "./queue-registry.js";

/**
 * Phase 15 plan 16 (OPS-14, D-09): read-only `Queue` handles for the Bull
 * Board mount (`bull-board.ts`). Bull Board's adapter wraps a `Queue`, not a
 * `Worker` -- `server.ts`'s own `workers: Worker[]` array cannot be reused
 * for this, so these handles are additive and constructed here instead.
 *
 * Derived from the SAME queue-name constants every producer/consumer in
 * this codebase already imports -- never a hand-typed duplicate string --
 * so a queue added to `server.ts`'s worker registration in a future phase
 * shows up on the board the moment its constant is added to the list below,
 * with no other code change (the plan's own `backstop`-verified must_have).
 * `bull-board.test.ts`'s filesystem-enumeration test is the guard against
 * this list silently drifting out of sync with `server.ts`'s actual
 * registrations.
 *
 * Five of the twenty queue names already have a genuinely long-lived,
 * module-scope, tracked PRODUCER `Queue` elsewhere in this process
 * (`campaign-broadcast-producer.ts`'s `emailBroadcastQueue`, `flow-queues.ts`'s
 * `emailTriggeredQueue`/`flowRunAdvanceQueue`/`flowTriggerEvaluatorQueue`/
 * `flowSegmentSweepFlowQueue`) -- those are REUSED here, never re-constructed
 * or re-registered (`queue-registry.ts`'s own rule against double-registering
 * an already-tracked handle). The other fifteen queue names have no such
 * producer in this process (their only consumer-side presence today is the
 * `Worker` itself, or a producer that is lazily created well after boot), so
 * a fresh read-only `Queue` handle is constructed for each and registered
 * with the shutdown registry here.
 */
function requireRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker's board-queues");
  }
  return redisUrl;
}

/**
 * Queue names board-queues.ts must NOT construct a fresh handle for -- an
 * existing tracked producer already covers them. Each producer is a
 * `Queue<SpecificJobType>` -- widened to the untyped `Queue` here (a Bull
 * Board handle has no use for the job-payload generic), since a single
 * `Map`/array holding several mutually-incompatible `Queue<T>` generics
 * cannot otherwise be typed without TypeScript trying to unify their `add()`
 * signatures into one impossible type.
 */
const REUSED_PRODUCER_QUEUES: ReadonlyMap<string, Queue> = new Map<string, Queue>([
  [EMAIL_BROADCAST_QUEUE, emailBroadcastQueue as Queue],
  [EMAIL_TRIGGERED_QUEUE, emailTriggeredQueue as Queue],
  [FLOW_RUN_ADVANCE_QUEUE, flowRunAdvanceQueue as Queue],
  [FLOW_TRIGGER_EVALUATOR_QUEUE, flowTriggerEvaluatorQueue as Queue],
  [FLOW_SEGMENT_SWEEP_FLOW_QUEUE, flowSegmentSweepFlowQueue as Queue],
]);

/**
 * Every queue name `server.ts`'s `buildWorker()` registers a BullMQ `Worker`
 * for (twenty-one as of Phase 22 plan 22-01) -- listed once here, from
 * constants, not re-typed as literal strings.
 */
const WORKER_QUEUE_NAMES: readonly string[] = [
  EVENTS_INGEST_QUEUE,
  IMPORTS_CSV_QUEUE,
  EMAIL_BROADCAST_QUEUE,
  EMAIL_TRIGGERED_QUEUE,
  CAMPAIGN_KICKOFF_QUEUE,
  CAMPAIGN_SCHEDULER_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
  ANALYTICS_RECONCILE_QUEUE,
  FLOW_RUN_ADVANCE_QUEUE,
  FLOW_RECONCILIATION_QUEUE,
  FLOW_TRIGGER_EVALUATOR_QUEUE,
  FLOW_SEGMENT_SWEEP_QUEUE,
  FLOW_SEGMENT_SWEEP_FLOW_QUEUE,
  FLOW_ENROLL_EXISTING_QUEUE,
  PARTITION_MAINTENANCE_QUEUE,
  SEND_RECONCILER_QUEUE,
  WEBHOOK_REPLAY_SWEEP_QUEUE,
  REPUTATION_TICK_QUEUE,
  ERASURE_SCRUB_QUEUE,
  ERASURE_SCRUB_RECLAIM_QUEUE,
  WORKSPACE_PURGE_QUEUE,
];

function buildBoardQueue(name: string): Queue {
  const reused = REUSED_PRODUCER_QUEUES.get(name);
  if (reused) {
    return reused;
  }
  return registerTrackedQueue(
    new Queue(name, { connection: buildRedisConnectionOptions(requireRedisUrl()) })
  );
}

/**
 * The full read-only Bull Board queue list -- one `Queue` handle per name in
 * `WORKER_QUEUE_NAMES`, reusing the five existing tracked producers and
 * constructing (then registering) a fresh handle for every other name.
 */
export const boardQueues: Queue[] = WORKER_QUEUE_NAMES.map(buildBoardQueue);
