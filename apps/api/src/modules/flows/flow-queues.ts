import { Queue } from "bullmq";
import { FLOW_ENROLL_EXISTING_QUEUE, type FlowEnrollExistingJob } from "@mega-crm/shared-schemas";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { env } from "../../env.js";

/** Built through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10). */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

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
