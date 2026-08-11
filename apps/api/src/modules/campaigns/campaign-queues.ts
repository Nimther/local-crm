import { Queue } from "bullmq";
import {
  CAMPAIGN_KICKOFF_QUEUE,
  EMAIL_BROADCAST_QUEUE,
  type CampaignKickoffJob,
  type EmailBroadcastJob,
} from "@mega-crm/shared-schemas";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { env } from "../../env.js";

/** Built through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11, D-10). */
const DEFAULT_JOB_OPTIONS = buildJobOptions(STANDARD_JOB_RETENTION);

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
