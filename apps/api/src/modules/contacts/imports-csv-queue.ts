import { Queue } from "bullmq";
import { IMPORTS_CSV_QUEUE, type ImportsCsvJob } from "@mega-crm/shared-schemas";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { env } from "../../env.js";

/**
 * Producer-side BullMQ Queue for IMPORTS_CSV_QUEUE (CONT-02, D-16) -- the
 * consumer is apps/worker/src/queues/imports-csv.worker.ts's Worker.
 *
 * WR-01: `defaultJobOptions` retries a transient failure instead of
 * dropping an already-accepted import job on the first error -- same
 * durability fix applied to events-queue.ts. Built through the shared
 * `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10).
 */
export const importsCsvQueue = new Queue<ImportsCsvJob>(IMPORTS_CSV_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: buildJobOptions(STANDARD_JOB_RETENTION),
});
