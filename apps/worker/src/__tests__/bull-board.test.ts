import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
import { emailBroadcastQueue } from "../queues/campaign-broadcast-producer.js";
import {
  emailTriggeredQueue,
  flowRunAdvanceQueue,
  flowSegmentSweepFlowQueue,
  flowTriggerEvaluatorQueue,
} from "../queues/flows/flow-queues.js";
import { CAMPAIGN_SCHEDULER_QUEUE } from "../queues/campaign-scheduler.worker.js";
import { ANALYTICS_RECONCILE_QUEUE } from "../queues/analytics-reconciliation.worker.js";
import { PARTITION_MAINTENANCE_QUEUE } from "../queues/partition-maintenance.worker.js";
import { WEBHOOK_REPLAY_SWEEP_QUEUE } from "../queues/webhook-replay-sweep.worker.js";
import { REPUTATION_TICK_QUEUE } from "../queues/reputation-tick.worker.js";
import { ERASURE_SCRUB_RECLAIM_QUEUE } from "../queues/erasure-scrub-reclaim.worker.js";
import { boardQueues } from "../queues/board-queues.js";
import { closeTrackedQueues, trackedQueueCount } from "../queues/queue-registry.js";

/**
 * Phase 15 plan 16 (OPS-14), Task 2: read-only queue handles for Bull Board
 * introspection. `boardQueues` must cover exactly the 20 queue names the
 * worker registers a `Worker` for (`server.ts`'s `workers: Worker[]` array)
 * -- neither a subset (a queue invisible on the board) nor a superset (a
 * phantom queue name nothing consumes).
 */

const QUEUES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "queues");

/** Mirrors `processor-wrapper-coverage.test.ts`'s filesystem enumeration -- every `*.worker.ts` file under `apps/worker/src/queues` (including `flows/`), never a hard-coded count. */
function findWorkerFactoryFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findWorkerFactoryFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".worker.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * The full set of queue names `server.ts`'s `buildWorker()` registers a
 * BullMQ `Worker` for, imported directly from each queue's own canonical
 * constant -- the SAME constants `board-queues.ts` itself must import to
 * build `boardQueues` (its own acceptance criterion: derived from
 * constants, never a hand-typed duplicate string).
 */
const EXPECTED_QUEUE_NAMES = [
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
];

describe("board-queues.ts: read-only queue handles for Bull Board (OPS-14 Task 2)", () => {
  it("boardQueues' name set equals the full set of queue names the worker registers a Worker for", () => {
    expect(boardQueues).toHaveLength(EXPECTED_QUEUE_NAMES.length);
    expect(new Set(boardQueues.map((q) => q.name))).toEqual(new Set(EXPECTED_QUEUE_NAMES));
  });

  it("the number of *.worker.ts factory files on disk matches boardQueues' length (backstop against a forgotten future queue)", () => {
    const factoryFiles = findWorkerFactoryFiles(QUEUES_DIR);
    expect(factoryFiles.length).toBeGreaterThanOrEqual(20);
    expect(factoryFiles.length).toBe(boardQueues.length);
  });

  it("every board handle is a bullmq Queue instance, never a Worker", () => {
    for (const q of boardQueues) {
      expect(q).toBeInstanceOf(Queue);
    }
  });

  it("reuses the existing tracked producer Queue for a queue name that already has one, instead of opening a second handle", () => {
    const byName = new Map(boardQueues.map((q) => [q.name, q]));
    expect(byName.get(EMAIL_BROADCAST_QUEUE)).toBe(emailBroadcastQueue);
    expect(byName.get(EMAIL_TRIGGERED_QUEUE)).toBe(emailTriggeredQueue);
    expect(byName.get(FLOW_RUN_ADVANCE_QUEUE)).toBe(flowRunAdvanceQueue);
    expect(byName.get(FLOW_TRIGGER_EVALUATOR_QUEUE)).toBe(flowTriggerEvaluatorQueue);
    expect(byName.get(FLOW_SEGMENT_SWEEP_FLOW_QUEUE)).toBe(flowSegmentSweepFlowQueue);
  });

  it("every handle -- reused or newly constructed -- is registered with the shutdown registry, and closing empties it", async () => {
    expect(trackedQueueCount()).toBe(boardQueues.length);

    await closeTrackedQueues();

    expect(trackedQueueCount()).toBe(0);
  });
});
