import { Queue } from "bullmq";
import { EMAIL_BROADCAST_QUEUE, type EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";

/**
 * Mirrors apps/api/src/modules/campaigns/campaign-queues.ts's
 * `DEFAULT_JOB_OPTIONS` (02-10 convention): 5 attempts w/ exponential
 * backoff, completed jobs pruned after 24h, failed jobs kept for
 * inspection/manual retry.
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: false,
};

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
