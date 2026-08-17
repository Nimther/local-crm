import "./load-env.js";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
// Phase 15 plan 10 (OPS-08): namespace import, not a named import of the
// Fastify error-handler helper below -- keeps this file's only mention of
// that helper's name on its single call-site line, not duplicated here too.
import * as Sentry from "@sentry/node";
import { initSentry } from "./sentry.js";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Redis } from "ioredis";
import sgMail from "@sendgrid/mail";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "@fastify/type-provider-zod";
import { withCorrelation } from "@mega-crm/tenant-context";
import { logger } from "./logger.js";
import { env } from "./env.js";
import { pool } from "./db.js";
import {
  startPartitionWatchdog,
  WATCHDOG_INTERVAL_MS,
  STALE_THRESHOLD_HOURS,
  type OperatorAlertMessage,
} from "./modules/ops/partition-watchdog.js";
import {
  startSendReconcilerWatchdog,
  RECONCILER_WATCHDOG_INTERVAL_MS,
  RECONCILER_STALE_THRESHOLD_MINUTES,
  RECONCILING_AGE_ALERT_HOURS,
  type ReconcilerAlertMessage,
} from "./modules/ops/send-reconciler-watchdog.js";
import {
  startDeadLetterWatchdog,
  DEAD_LETTER_WATCHDOG_INTERVAL_MS,
  DEAD_LETTER_ALERT_DEDUP_HOURS,
  type DeadLetterAlertMessage,
} from "./modules/ops/dead-letter-watchdog.js";
import {
  startIngestionHealthWatchdog,
  INGESTION_WATCHDOG_INTERVAL_MS,
  INGESTION_ALERT_DEDUP_HOURS,
  type IngestionAlertMessage,
} from "./modules/ops/ingestion-health-watchdog.js";
import {
  startReputationWatchdog,
  REPUTATION_WATCHDOG_INTERVAL_MS,
  REPUTATION_ALERT_DEDUP_HOURS,
  type ReputationAlertMessage,
} from "./modules/ops/reputation-watchdog.js";
import {
  startQueueDepthWatchdog,
  QUEUE_DEPTH_WATCHDOG_INTERVAL_MS,
  QUEUE_DEPTH_ALERT_DEDUP_HOURS,
  type QueueDepthAlertMessage,
} from "./modules/ops/queue-depth-watchdog.js";
import {
  startOldestJobAgeWatchdog,
  OLDEST_JOB_AGE_WATCHDOG_INTERVAL_MS,
  OLDEST_JOB_AGE_ALERT_DEDUP_HOURS,
  type OldestJobAgeAlertMessage,
} from "./modules/ops/oldest-job-age-watchdog.js";
import {
  startWebhookLagWatchdog,
  WEBHOOK_LAG_WATCHDOG_INTERVAL_MS,
  WEBHOOK_LAG_ALERT_DEDUP_HOURS,
  type WebhookLagAlertMessage,
} from "./modules/ops/webhook-lag-watchdog.js";
import {
  startFailedSendShareWatchdog,
  FAILED_SEND_SHARE_WATCHDOG_INTERVAL_MS,
  FAILED_SEND_SHARE_ALERT_DEDUP_HOURS,
  type FailedSendShareAlertMessage,
} from "./modules/ops/failed-send-share-watchdog.js";
import { closeQueueMonitorQueues } from "./modules/ops/queue-monitor.js";
import { authPlugin } from "./modules/auth/plugin.js";
import { registerWorkspaceRoutes } from "./modules/tenancy/workspaces.js";
import { registerProfileRoutes } from "./modules/tenancy/profile.js";
import { registerInviteRoutes } from "./modules/tenancy/invites.js";
import { registerMemberRoutes } from "./modules/tenancy/members.js";
import { registerSendgridKeyRoutes } from "./modules/tenancy/sendgrid-key.js";
import { registerContactsRoutes } from "./modules/contacts/contacts.routes.js";
import { registerContactsApiRoutes } from "./modules/contacts/contacts-api.routes.js";
import { registerApiKeyRoutes } from "./modules/api-keys/api-keys.routes.js";
import { registerEventsApiRoutes } from "./modules/events/events-api.routes.js";
import { registerCsvImportRoutes } from "./modules/contacts/csv-import.routes.js";
import { registerSegmentsRoutes } from "./modules/segments/segments.routes.js";
import { registerUnsubscribeRoutes } from "./modules/delivery/unsubscribe.routes.js";
import { registerCampaignsRoutes } from "./modules/campaigns/campaigns.routes.js";
import { registerFlowsRoutes } from "./modules/flows/flows.routes.js";
import { registerSendSettingsRoutes } from "./modules/campaigns/send-settings.routes.js";
import { registerWebhookRoutes } from "./modules/webhooks/webhooks.routes.js";
import { registerWebhookSettingsRoutes } from "./modules/webhooks/webhook-settings.routes.js";
import { registerAnalyticsRoutes } from "./modules/analytics/index.js";
import { registerSendLogRoutes } from "./modules/send-log/send-log.routes.js";
import { ensureMigrationsCurrentOnce, registerOpsHealthRoutes } from "./modules/ops/health.js";

/**
 * Options for `buildServer`. The only override that exists today is the
 * distributed rate limiter's Redis endpoint -- needed so
 * rate-limit-distributed.test.ts (SEC-11) can point two in-process instances
 * at one disposable Redis, and separately point an instance at a Redis it is
 * about to stop, without touching the process-wide `env.REDIS_URL` every
 * other apps/api test relies on for its own (unrelated, unconnected) BullMQ
 * queue construction. Production and every other test call `buildServer()`
 * with no arguments and get `env.REDIS_URL`, the same Redis URL the rest of
 * the system already uses.
 */
export interface BuildServerOptions {
  rateLimitRedisUrl?: string;
}

/**
 * Phase 15 plan 02 (OPS-11, RESEARCH.md Pitfall 6): Fastify's default
 * `genReqId` is a per-process monotonic counter (`req-1`, `req-2`, ...) that
 * restarts at 1 on every deploy -- two different deploys, or two API
 * replicas, can log the identical `request_id` for two unrelated requests,
 * defeating a Loki correlation query entirely. An inbound `x-request-id`
 * header is echoed back so a caller/reverse-proxy can supply its own
 * correlation id, but that header is attacker-controlled input (T-15-04) --
 * it is used ONLY as an opaque correlation label (never for auth/dedup) and
 * constrained to a bounded-length safe character set before being echoed, so
 * a crafted header cannot inject a `set_config`-breaking separator into the
 * `application_name` value it eventually reaches (packages/tenant-context's
 * `composeApplicationName`). Any value outside that pattern falls back to
 * `crypto.randomUUID()` (Node 22 built-in, no new dependency), same as no
 * header at all.
 */
const REQUEST_ID_SAFE_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

function resolveRequestId(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined && REQUEST_ID_SAFE_PATTERN.test(value)) {
    return value;
  }
  return randomUUID();
}

/** Assembles the Fastify app: zod type provider, better-auth handler, workspace/profile/invite/member routes. */
export async function buildServer(options: BuildServerOptions = {}) {
  // Phase 15 plan 10 (OPS-08): initialized before the Fastify instance is
  // built, per this plan's own instruction -- a missing DSN is a no-op
  // (initSentry logs once and returns false), so this never blocks/slows
  // boot and every apps/api integration test calling buildServer() directly
  // (there is no separate DSN in the test environment) hits exactly that
  // no-op path.
  initSentry();

  const app = Fastify({
    loggerInstance: logger,
    // 04-03: find-my-way's default maxParamLength (100) is too small for the
    // signed `:token` route param on /unsubscribe/:token -- the HMAC token
    // (base64url JSON payload + '.' + base64url signature) runs ~230-260
    // chars. Without this, find-my-way returns a 414 for every genuine
    // token, defeating the endpoint entirely.
    routerOptions: { maxParamLength: 1024 },
    genReqId: (req) => resolveRequestId(req.headers["x-request-id"]),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // OPS-11 (RESEARCH.md Pattern 1/Pitfall 7): the FIRST onRequest hook
  // registered, so every later hook (including the migration-currency guard
  // below) and the route handler itself run inside this correlation scope --
  // Fastify hooks execute in registration order. Deliberately never reads or
  // consumes `request.body` -- the SendGrid webhook route's raw-body ECDSA
  // signature verification depends on those exact bytes reaching its own
  // content-type parser untouched. `done()` is called SYNCHRONOUSLY from
  // inside `withCorrelation`'s callback (not `async (request) => { await
  // withCorrelation(...) }`) so the ALS context is established for the
  // continuation Fastify runs when `done()` fires, not just for the
  // synchronous body of this hook.
  app.addHook("onRequest", (request, _reply, done) => {
    withCorrelation({ requestId: request.id }, () => done());
  });

  // SEC-11 (T-10-12-01): a per-process (in-memory) rate-limit store silently
  // multiplies every configured limit by however many API replicas are
  // running -- each replica counts only the requests IT saw, so N replicas
  // together allow N times the configured max before any of them returns
  // 429. Backing the store with Redis makes the count a single value shared
  // by every instance regardless of which one a given request lands on
  // (rate-limit-distributed.test.ts's two-instance test asserts the exact
  // request count this fixes).
  //
  // This client is deliberately separate from every BullMQ connection in
  // this codebase (apps/worker/src/queues/connection.ts,
  // apps/api/.../*-queue.ts): it sits directly in the request path -- the
  // `incr` call happens before the route handler runs -- so unlike a queue
  // connection (which SHOULD hold open and retry indefinitely, per BullMQ's
  // own `maxRetriesPerRequest: null` requirement) this one is configured to
  // fail FAST: a short `connectTimeout`, a reconnect backoff that gives up
  // after a few attempts (`retryStrategy` returning `null`), and
  // `enableOfflineQueue: false` so a command issued while disconnected
  // rejects immediately instead of queuing behind a reconnect (T-10-12-06).
  const rateLimitRedisUrl = options.rateLimitRedisUrl ?? env.REDIS_URL;
  const rateLimitRedis = new Redis(rateLimitRedisUrl, {
    connectTimeout: 1_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1_000)),
  });

  // T-10-12-04 (SEC-08): `skipOnError` below swallows the failure silently
  // from the request's point of view -- this listener is the ONLY thing
  // that makes a store outage observable. The message names the limiter
  // explicitly and says what happened (unthrottled, not merely "errored")
  // so an operator reading logs does not have to infer the consequence.
  rateLimitRedis.on("error", (err) => {
    logger.error(
      { err },
      "rate-limiter Redis client error -- requests are proceeding UNTHROTTLED (fail-open, SEC-08)"
    );
  });

  // `global: false`: only routes that opt in via `{ config: { rateLimit } }`
  // are limited (invite accept/register-from-invite, T-01-13 brute-force
  // mitigation; the contacts/events ingest APIs; the SendGrid webhook
  // receiver as of this plan) -- every other route is unaffected.
  // `skipOnError: true` is the deliberate fail-open (T-10-12-03):
  // availability is preferred over throttling during a store outage, made
  // visible by the error listener above rather than silently swallowed.
  // `nameSpace` keeps the limiter's Redis keys out of BullMQ's own key space
  // in the same Redis instance/db (T-10-12-05 -- BullMQ prefixes its keys
  // with `bull:`).
  await app.register(rateLimit, {
    global: false,
    redis: rateLimitRedis,
    nameSpace: "fastify-rate-limit-api:",
    skipOnError: true,
  });

  // `enableOfflineQueue: false` above means a command issued before this
  // client's INITIAL connection finishes rejects immediately, same as a
  // genuine outage -- which would make the very first requests after boot
  // silently unthrottled (skipOnError) even against a perfectly healthy
  // Redis, purely because the handshake hadn't completed yet. Waiting here,
  // bounded by `connectTimeout`, closes that startup window: `buildServer()`
  // does not return until the client has either reached "ready" or already
  // failed once (in which case the error listener above has already logged
  // it, and later requests fail open exactly as designed).
  await new Promise<void>((resolve) => {
    if (rateLimitRedis.status === "ready") {
      resolve();
      return;
    }
    const onReady = (): void => {
      rateLimitRedis.off("error", onSettled);
      resolve();
    };
    const onSettled = (): void => {
      rateLimitRedis.off("ready", onReady);
      resolve();
    };
    rateLimitRedis.once("ready", onReady);
    rateLimitRedis.once("error", onSettled);
  });

  // CR-01/WR-05: script-blocking CSP on every response, defense-in-depth on
  // top of the token format guard + attribute escaping in
  // unsubscribe.routes.ts. default-src 'none' blocks any script execution
  // (script-src has no override, so it falls back to default-src);
  // style-src allows 'unsafe-inline' because the public unsubscribe page
  // (and better-auth's own pages, if any) render a plain in-file <style>
  // block, matching this repo's no-template-engine convention -- there is
  // no separate stylesheet to point script-src-style-nonce machinery at.
  // This is the single registration for the whole app (previously
  // registered a second time, with permissive defaults, nested inside
  // authPlugin -- consolidated here so there is one source of truth for the
  // CSP actually served).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });

  await app.register(registerOpsHealthRoutes);

  // DB-06 (paired with OPS-05, ROADMAP § Phase 14): "does not accept traffic
  // until migrations complete" is implemented as a request-time refusal,
  // not a startup sleep. Runs before every route's own preHandler/handler
  // (Fastify's onRequest fires earliest in the lifecycle, before body
  // parsing) and deliberately never reads or consumes `request.body` --
  // the SendGrid webhook route's raw-body ECDSA signature verification
  // depends on those exact bytes reaching its own content-type parser
  // untouched (RESEARCH.md: body-parsing-before-verification is the most
  // common SendGrid integration bug).
  //
  // Migration currency ONLY -- never Postgres-liveness-in-general, never
  // Redis. See `ensureMigrationsCurrentOnce`'s own header comment in
  // health.ts for the full DB-06-vs-OPS-05 split rationale: widening this
  // guard would make every apps/api integration suite depend on a live
  // Redis for routes that never touch it. `/readyz` is where all three
  // checks live; this guard is where the migration half is enforced
  // against every request. Do not "fix" this asymmetry without re-reading
  // that comment first.
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/healthz" || request.url === "/readyz") return;
    try {
      await ensureMigrationsCurrentOnce();
    } catch (err) {
      await reply.code(503).send({
        ready: false,
        error: "migrations_pending",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await app.register(authPlugin);
  await app.register(registerWorkspaceRoutes);
  await app.register(registerProfileRoutes);
  await app.register(registerInviteRoutes);
  await app.register(registerMemberRoutes);
  await app.register(registerSendgridKeyRoutes);
  await app.register(registerContactsRoutes);
  await app.register(registerContactsApiRoutes);
  await app.register(registerApiKeyRoutes);
  await app.register(registerEventsApiRoutes);
  await app.register(registerCsvImportRoutes);
  await app.register(registerSegmentsRoutes);
  await app.register(registerUnsubscribeRoutes);
  await app.register(registerCampaignsRoutes);
  await app.register(registerFlowsRoutes);
  await app.register(registerSendSettingsRoutes);
  await app.register(registerWebhookRoutes);
  await app.register(registerWebhookSettingsRoutes);
  await app.register(registerAnalyticsRoutes);
  await app.register(registerSendLogRoutes);

  // Phase 15 plan 10 (OPS-08): registered AFTER every route above, per this
  // plan's own instruction. Safe to call unconditionally (even with no DSN
  // configured, i.e. every test run) -- it only adds an onError hook that
  // forwards to Sentry's own captureException, which itself no-ops when no
  // client is initialized.
  Sentry.setupFastifyErrorHandler(app);

  // Every apps/api integration test calls `buildServer()` and closes the
  // returned instance in teardown -- closing the limiter's Redis client here
  // (rather than leaving every call site to remember it exists) is what
  // keeps `npx vitest run --root apps/api` from hanging on an open ioredis
  // handle after the suite finishes. `disconnect()`, not `quit()`: this hook
  // must also succeed cleanly when the limiter's Redis is already down (the
  // Redis-down proof in rate-limit-distributed.test.ts closes the app in
  // exactly that state), and `quit()` needs a live connection to send its
  // command over.
  app.addHook("onClose", () => {
    rateLimitRedis.disconnect();
  });

  // Phase 15 plan 13 (OPS-13, Task 1): closes queue-monitor.ts's own new
  // read-only `emailTriggeredQueue` handle -- the one BullMQ `Queue` that
  // module constructs itself (every other queue it reads is a REUSED handle
  // already owned, and already closed where relevant, by its own producer
  // module). Same rationale as the `rateLimitRedis.disconnect()` hook just
  // above: without this, `npx vitest run --root apps/api` would hang on an
  // open ioredis handle after the suite finishes.
  app.addHook("onClose", async () => {
    await closeQueueMonitorQueues();
  });

  return app;
}

/**
 * D-04: the partition watchdog's real dispatch -- plain-text only, through
 * the PLATFORM's own SendGrid account/key (never a tenant's BYO key, never
 * a Dynamic Template), mirroring `modules/platform-mail/client.ts`'s own
 * platform-key-only discipline so an emergency channel never depends on a
 * template existing in the platform SendGrid account.
 */
async function sendOperatorAlert(message: OperatorAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM partition maintenance alert",
    text: message.text,
  });
}

/**
 * 11-09 (D-14): the send-reconciler watchdog's own real dispatch -- same
 * platform-key-only, plain-text discipline as `sendOperatorAlert` above, just
 * a different subject line so the two alert channels are distinguishable in
 * an operator's inbox.
 */
async function sendReconcilerOperatorAlert(message: ReconcilerAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM send reconciler alert",
    text: message.text,
  });
}

/**
 * 12-10 (D-08): the dead-letter watchdog's own real dispatch -- same
 * platform-key-only, plain-text discipline as `sendOperatorAlert` and
 * `sendReconcilerOperatorAlert` above, a third distinct subject line so all
 * three alert channels stay distinguishable in an operator's inbox.
 */
async function sendDeadLetterOperatorAlert(message: DeadLetterAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM dead-letter alert",
    text: message.text,
  });
}

/**
 * Phase 13 (CMP-08, plan 13-11): the ingestion-health watchdog's own real
 * dispatch -- same platform-key-only, plain-text discipline as every
 * sibling above, a fourth distinct subject line so all four alert channels
 * stay distinguishable in an operator's inbox.
 */
async function sendIngestionHealthOperatorAlert(message: IngestionAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM ingestion health alert",
    text: message.text,
  });
}

/**
 * Phase 13 (CMP-09, plan 13-11): the reputation watchdog's own real dispatch
 * -- same platform-key-only discipline as every sibling above, used for
 * BOTH the operator alert and every workspace member's tenant alert (D-09:
 * a tenant's own SendGrid key must never carry this message -- see
 * reputation-watchdog.ts's own header for why).
 */
async function sendReputationAlert(message: ReputationAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM reputation alert",
    text: message.text,
  });
}

/**
 * Phase 15 (OPS-13, plan 15-13): the queue-depth watchdog's own real
 * dispatch -- same platform-key-only, plain-text discipline as every
 * sibling above, a sixth distinct subject line so all six alert channels
 * stay distinguishable in an operator's inbox.
 */
async function sendQueueDepthAlert(message: QueueDepthAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM queue depth alert",
    text: message.text,
  });
}

/**
 * Phase 15 (OPS-13, plan 15-13): the oldest-job-age watchdog's own real
 * dispatch -- same platform-key-only, plain-text discipline as every
 * sibling above, a seventh distinct subject line.
 */
async function sendOldestJobAgeAlert(message: OldestJobAgeAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM oldest-job-age alert",
    text: message.text,
  });
}

/**
 * Phase 15 (OPS-13, plan 15-14): the webhook-lag watchdog's own real
 * dispatch -- same platform-key-only, plain-text discipline as every
 * sibling above, an eighth distinct subject line.
 */
async function sendWebhookLagAlert(message: WebhookLagAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM webhook-lag alert",
    text: message.text,
  });
}

/**
 * Phase 15 (OPS-13, plan 15-14): the failed-send-share watchdog's own real
 * dispatch -- same platform-key-only, plain-text discipline as every
 * sibling above, a ninth distinct subject line so all nine alert channels
 * stay distinguishable in an operator's inbox.
 */
async function sendFailedSendShareAlert(message: FailedSendShareAlertMessage): Promise<void> {
  await sgMail.send({
    to: message.to,
    from: env.PLATFORM_MAIL_FROM,
    subject: "Mega CRM failed-send-share alert",
    text: message.text,
  });
}

async function main(): Promise<void> {
  const app = await buildServer();
  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });

  // D-02: the watchdog must live in a DIFFERENT process from the BullMQ
  // worker whose liveness it checks (apps/worker's partition-maintenance
  // job, 09-02 task 1) -- started here, in apps/api's own process, and
  // never registered as a queue job. Started in main(), never inside
  // buildServer(): every apps/api integration test calls buildServer(), so
  // an interval registered there would keep a timer alive in every test
  // process, poll a test database on WATCHDOG_INTERVAL_MS's cadence, and
  // reach the real SendGrid dispatch path from a test run. main() runs
  // only under the isDirectRun guard below, which is exactly the boundary
  // wanted.
  //
  // 11-09 (D-14) update: this process now arms TWO independent dead-man's
  // switches sharing one alert channel (the platform SendGrid key, plain
  // text, `OPERATOR_ALERT_EMAIL`) -- the pre-existing partition-maintenance
  // watchdog above, and the send-reconciler watchdog below. They alert on
  // completely independent conditions (partition buffer/DEFAULT-row health
  // vs. reconciler tick liveness/ambiguity backlog) and dedup independently
  // (their own `last_alert_sent_at` columns live on two different tables),
  // so neither watchdog's dedup window or health state can mask the other's.
  sgMail.setApiKey(env.PLATFORM_SENDGRID_API_KEY);
  startPartitionWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendOperatorAlert,
  });
  startSendReconcilerWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendReconcilerOperatorAlert,
  });
  // 12-10 (D-08): a THIRD independent dead-man's switch, over
  // dead_letter_jobs rather than a per-tick health row -- it alerts on an
  // entirely different condition (unacknowledged terminal job failures) and
  // dedups independently (its own last_alert_sent_at column on
  // dead_letter_alert_state), so it cannot mask or be masked by either
  // watchdog above.
  startDeadLetterWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendDeadLetterOperatorAlert,
  });
  // Phase 13 (CMP-08, plan 13-11): a FOURTH independent dead-man's switch,
  // over ingress_journal's stuck/attempt-capped/tombstoned rows -- its own
  // read goes through the dedicated mega_crm_scan role (the cross-workspace
  // scan helper, wrapped inside checkIngestionHealthAndAlert itself), its
  // claim/dedup state
  // (ingestion_alert_state) lives on its own table, so it cannot mask or be
  // masked by any watchdog above.
  startIngestionHealthWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendIngestionHealthOperatorAlert,
  });
  // Phase 13 (CMP-09, plan 13-11): a FIFTH independent dead-man's switch,
  // over reputation_alert_state -- the first of these five to also alert a
  // TENANT audience (every workspace member), never only the operator. Keyed
  // by (workspace_id, metric) rather than singleton, and dedups per
  // (workspace_id, metric) pair -- see reputation-watchdog.ts's own header.
  startReputationWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendReputationAlert,
  });
  // Phase 15 (OPS-13, plan 15-13): a SIXTH independent dead-man's switch,
  // over BullMQ queue depth across all 8 monitored send-pipeline lanes. It
  // claims through the SHARED ops_alert_state table (plan 15-12) under its
  // own alert name ("queue-depth") and its own dedup window
  // (QUEUE_DEPTH_ALERT_DEDUP_HOURS), independent of every watchdog above and
  // below -- a claim under one alert name can never satisfy or block
  // another's WHERE predicate, so none of these nine watchdogs can mask or
  // be masked by any other.
  startQueueDepthWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendQueueDepthAlert,
  });
  // Phase 15 (OPS-13, plan 15-13): a SEVENTH independent dead-man's switch,
  // over the oldest pending BullMQ job's age AND the oldest outstanding
  // sends.reconciling_since, evaluated together into one alert
  // ("oldest-job-age") so a send stuck at either stage produces exactly one
  // email, never two. Deliberately set BELOW send-reconciler-watchdog.ts's
  // own RECONCILING_AGE_ALERT_HOURS (see that module's own constant
  // comments) -- an earlier warning on the same underlying signal, never a
  // simultaneous duplicate.
  startOldestJobAgeWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendOldestJobAgeAlert,
  });
  // Phase 15 (OPS-13, plan 15-14): an EIGHTH independent dead-man's switch,
  // answering "is delivery evidence still arriving" -- a deliberately
  // DIFFERENT question from ingestion-health-watchdog.ts's "is an
  // already-arrived batch stuck" (see webhook-lag-watchdog.ts's own header
  // for the full distinction). Claims under its own alert name
  // ("webhook-lag") and its own dedup window, so it cannot mask or be
  // masked by ingestion-health-watchdog above or any other watchdog here.
  startWebhookLagWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendWebhookLagAlert,
  });
  // Phase 15 (OPS-13, plan 15-14): a NINTH independent dead-man's switch,
  // over the share of terminal (sent/failed) sends that failed, over a
  // rolling window -- rate-limited deferrals and other non-terminal
  // control-flow outcomes are structurally excluded from both sides of the
  // ratio (see failed-send-share-watchdog.ts's own header), so routine
  // per-tenant backpressure can never read as a false outage. Claims under
  // its own alert name ("failed-send-share") and its own dedup window,
  // independent of every watchdog above.
  startFailedSendShareWatchdog({
    client: pool,
    operatorEmail: env.OPERATOR_ALERT_EMAIL,
    sendMail: sendFailedSendShareAlert,
  });

  // Names only the interval/threshold numbers -- never the operator
  // address or anything derived from the SendGrid key (T-09-11).
  logger.info(
    { pollIntervalMs: WATCHDOG_INTERVAL_MS, staleThresholdHours: STALE_THRESHOLD_HOURS },
    "partition watchdog armed -- watching apps/worker's partition-maintenance job from a separate process"
  );
  logger.info(
    {
      pollIntervalMs: RECONCILER_WATCHDOG_INTERVAL_MS,
      staleThresholdMinutes: RECONCILER_STALE_THRESHOLD_MINUTES,
      reconcilingAgeAlertHours: RECONCILING_AGE_ALERT_HOURS,
    },
    "send-reconciler watchdog armed -- watching apps/worker's send-reconciler tick from a separate process"
  );
  logger.info(
    { pollIntervalMs: DEAD_LETTER_WATCHDOG_INTERVAL_MS, alertDedupHours: DEAD_LETTER_ALERT_DEDUP_HOURS },
    "dead-letter watchdog armed -- watching dead_letter_jobs for unacknowledged terminal failures"
  );
  logger.info(
    { pollIntervalMs: INGESTION_WATCHDOG_INTERVAL_MS, alertDedupHours: INGESTION_ALERT_DEDUP_HOURS },
    "ingestion-health watchdog armed -- watching ingress_journal for stuck/attempt-capped/unrecoverable webhook batches"
  );
  logger.info(
    { pollIntervalMs: REPUTATION_WATCHDOG_INTERVAL_MS, alertDedupHours: REPUTATION_ALERT_DEDUP_HOURS },
    "reputation watchdog armed -- watching reputation_alert_state for warn/critical tier crossings"
  );
  logger.info(
    { pollIntervalMs: QUEUE_DEPTH_WATCHDOG_INTERVAL_MS, alertDedupHours: QUEUE_DEPTH_ALERT_DEDUP_HOURS },
    "queue-depth watchdog armed -- watching all 8 monitored BullMQ send-pipeline lanes for a backing-up queue"
  );
  logger.info(
    { pollIntervalMs: OLDEST_JOB_AGE_WATCHDOG_INTERVAL_MS, alertDedupHours: OLDEST_JOB_AGE_ALERT_DEDUP_HOURS },
    "oldest-job-age watchdog armed -- watching the oldest pending BullMQ job and the oldest outstanding sends.reconciling_since"
  );
  logger.info(
    { pollIntervalMs: WEBHOOK_LAG_WATCHDOG_INTERVAL_MS, alertDedupHours: WEBHOOK_LAG_ALERT_DEDUP_HOURS },
    "webhook-lag watchdog armed -- watching workspace_webhook_endpoints.last_event_at against outstanding reconciling sends"
  );
  logger.info(
    { pollIntervalMs: FAILED_SEND_SHARE_WATCHDOG_INTERVAL_MS, alertDedupHours: FAILED_SEND_SHARE_ALERT_DEDUP_HOURS },
    "failed-send-share watchdog armed -- watching the rolling share of terminal sends that failed"
  );
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
