import { Queue, type ConnectionOptions } from "bullmq";
import {
  CAMPAIGN_KICKOFF_QUEUE,
  EMAIL_BROADCAST_QUEUE,
  type CampaignKickoffJob,
  type EmailBroadcastJob,
} from "@mega-crm/shared-schemas";
import { env } from "../../env.js";

/**
 * Builds plain ioredis connection options from REDIS_URL -- NOT a
 * constructed `Redis`/`ioredis` client instance. Duplicated from
 * apps/api/src/modules/contacts/imports-csv-queue.ts (which itself documents
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
 * Producer-side queue for CAMPAIGN_KICKOFF_QUEUE (SEND-03) -- the
 * campaignsroutes' launch handler enqueues one job per immediate launch; the
 * 04-06 scheduler worker enqueues one per due scheduled campaign. Consumer
 * is the 04-06 kickoff/dispatch worker.
 */
export const campaignKickoffQueue = new Queue<CampaignKickoffJob>(CAMPAIGN_KICKOFF_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

/**
 * Producer-side queue for EMAIL_BROADCAST_QUEUE (SEND-01/SEND-06) -- the
 * campaigns routes' test-send handler enqueues a `kind: 'test'` job here
 * (never a direct SendGrid call, Pitfall 1); the 04-06 kickoff worker
 * enqueues one `kind: 'campaign'` job per recipient. Consumer is
 * apps/worker/src/queues/email-broadcast.worker.ts.
 */
export const emailBroadcastQueue = new Queue<EmailBroadcastJob>(EMAIL_BROADCAST_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});
