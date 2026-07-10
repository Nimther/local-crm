import { Queue, type ConnectionOptions } from "bullmq";
import { FLOW_ENROLL_EXISTING_QUEUE, type FlowEnrollExistingJob } from "@mega-crm/shared-schemas";
import { env } from "../../env.js";

/**
 * Builds plain ioredis connection options from REDIS_URL -- NOT a
 * constructed `Redis`/`ioredis` client instance. Duplicated from
 * apps/api/src/modules/campaigns/campaign-queues.ts (which itself documents
 * why: BullMQ bundles its OWN internal `ioredis` copy at a version pinned
 * independently of this workspace's `ioredis` dependency, so passing a
 * constructed client instance across that boundary is a TypeScript
 * nominal-type mismatch). This is connection-config parsing, not business
 * logic prone to drift, so duplicating it here matches the established
 * convention.
 */
function buildRedisConnectionOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const db = url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : undefined;

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    username: url.username || undefined,
    password: url.password || undefined,
    db,
    maxRetriesPerRequest: null,
  };
}

const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
};

/**
 * Producer-side queue for FLOW_ENROLL_EXISTING_QUEUE (D-04) -- flows.routes.ts's
 * publish handler enqueues one job here when the marketer chooses to
 * back-fill current segment members on publish. Consumer is
 * apps/worker/src/queues/flows/flow-enroll-existing.worker.ts. Mirrors
 * apps/api/src/modules/campaigns/campaign-queues.ts's producer-side
 * convention exactly (a new file, matching that module's split between
 * apps/api's producer and apps/worker's consumer).
 */
export const flowEnrollExistingQueue = new Queue<FlowEnrollExistingJob>(FLOW_ENROLL_EXISTING_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});
