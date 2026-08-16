import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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
import {
  resetWorkerDrainingForTests,
  startWorkerHealthServer,
  WORKER_HEALTH_HOST,
  type WorkerHealthServer,
} from "../health-server.js";
import { BULL_BOARD_BASE_PATH, mountBullBoard } from "../bull-board.js";

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

});

/**
 * Phase 15 plan 16 (OPS-14), Task 3: the board mounted on the worker's own
 * loopback-only health listener. Placed in its OWN describe block, run
 * BEFORE the shutdown-registry test below (which closes every `boardQueues`
 * handle) -- the board's `/api/queues` route performs a real round trip
 * against each queue's Redis connection, so it must run against still-open
 * handles.
 */
describe("bull-board.ts: the board mounted on the health listener (OPS-14 Task 3)", () => {
  const PORT = 4192;
  let server: WorkerHealthServer | undefined;

  afterEach(async () => {
    resetWorkerDrainingForTests();
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  async function start(): Promise<void> {
    server = await startWorkerHealthServer({
      queryPostgres: () => Promise.resolve({ rows: [{ ok: 1 }] }),
      redisConnection: { info: () => Promise.resolve("redis_version:7.0.0") },
      checkMigrationsCurrent: () => Promise.resolve(),
      port: PORT,
      beforeListen: mountBullBoard,
    });
  }

  it("/healthz and /readyz still answer their original contract with the board mounted", async () => {
    await start();

    const healthzResponse = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/healthz`);
    expect(healthzResponse.status).toBe(200);
    expect(await healthzResponse.json()).toEqual({ status: "ok" });

    const readyzResponse = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(readyzResponse.status).toBe(200);
    const readyzBody = (await readyzResponse.json()) as { ready: boolean; checks: unknown[] };
    expect(readyzBody.ready).toBe(true);
  });

  it("the board's base path responds on the loopback listener", async () => {
    await start();

    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}${BULL_BOARD_BASE_PATH}/api/queues`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { queues: { name: string }[] };
    expect(body.queues.map((q) => q.name).sort()).toEqual([...EXPECTED_QUEUE_NAMES].sort());
  });

  it("the board is read-only: a mutating route (pause) is refused with 405, never performing the mutation", async () => {
    await start();

    const response = await fetch(
      `http://${WORKER_HEALTH_HOST}:${String(PORT)}${BULL_BOARD_BASE_PATH}/api/queues/${EVENTS_INGEST_QUEUE}/pause`,
      { method: "PUT" }
    );
    expect(response.status).toBe(405);
    const body = (await response.json()) as { error?: string };
    expect(JSON.stringify(body)).toMatch(/READ_ONLY/i);
  });
});

describe("board-queues.ts shutdown (OPS-14 Task 2, run last -- closes every boardQueues handle)", () => {
  it("every handle -- reused or newly constructed -- is registered with the shutdown registry, and closing empties it", async () => {
    expect(trackedQueueCount()).toBe(boardQueues.length);

    await closeTrackedQueues();

    expect(trackedQueueCount()).toBe(0);
  });
});
