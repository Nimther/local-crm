import { Queue } from "bullmq";
import {
  CAMPAIGN_KICKOFF_QUEUE,
  EMAIL_BROADCAST_QUEUE,
  type CampaignKickoffJob,
  type EmailBroadcastJob,
} from "@mega-crm/shared-schemas";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { scrubbedConsole } from "@mega-crm/redaction";
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

// Phase 14 plan 01 (Task 3, Rule 2 -- missing critical functionality,
// surfaced by OPS-04's healthz-independent-of-Redis test): BullMQ's
// `QueueBase` forwards its underlying ioredis connection's own `error`
// events via `this.emit('error', error)` (see `node_modules/bullmq/dist/.../
// queue-base.js`). Node's `EventEmitter` THROWS when an `error` event has no
// listener -- with `maxRetriesPerRequest: null` (BullMQ's own required
// setting) ioredis retries a broken connection forever, re-emitting `error`
// on every failed attempt, so an unreachable Redis would crash the whole
// `apps/api` process the very first time it happened. Every OTHER Redis
// client in this codebase already carries this listener (CR-03 precedent,
// `packages/queue-core/src/connection.ts`'s own `createRedisConnection`,
// `apps/api/src/server.ts`'s `rateLimitRedis`) -- these two queues were the
// only two that never got one.
campaignKickoffQueue.on("error", (err) => {
  scrubbedConsole.error("campaignKickoffQueue: Redis connection error", err);
});
emailBroadcastQueue.on("error", (err) => {
  scrubbedConsole.error("emailBroadcastQueue: Redis connection error", err);
});
