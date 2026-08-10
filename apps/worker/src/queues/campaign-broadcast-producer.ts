import { Queue } from "bullmq";
import { EMAIL_BROADCAST_QUEUE, type EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";

/**
 * Built through the shared `@mega-crm/queue-core` factory (Phase 12,
 * WRK-11, D-10) -- 5 attempts w/ exponential backoff, completed jobs pruned
 * after 24h, failed jobs kept for inspection/manual retry. Previously its
 * own literal (02-10 convention), mirroring apps/api's own
 * `campaign-queues.ts`; both now build from the same shared constants.
 */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

function requireRedisUrl(): string {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker's campaign-broadcast-producer");
  }
  return redisUrl;
}

/**
 * Worker-side producer Queue for EMAIL_BROADCAST_QUEUE (SEND-01/CAMP-02):
 * `campaign-kickoff.worker.ts` (this module's sibling) fans out one
 * `kind: 'campaign'` job per sendable recipient here after
 * `recipient-snapshot.ts` freezes the audience -- the CONSUMER is
 * `email-broadcast.worker.ts`'s `createEmailBroadcastWorker`, registered in
 * `server.ts`. This is a SEPARATE `Queue` instance from apps/api's own
 * producer (`campaign-queues.ts`'s `emailBroadcastQueue`, used for the
 * test-send handler) -- each process constructs its own BullMQ `Queue`
 * against its own connection, matching this codebase's established
 * one-Queue-instance-per-process convention (never share a `Queue`/`Worker`
 * instance across process boundaries).
 */
export const emailBroadcastQueue = new Queue<EmailBroadcastJob>(EMAIL_BROADCAST_QUEUE, {
  connection: buildRedisConnectionOptions(requireRedisUrl()),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});
