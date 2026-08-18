import "./load-env.js";
import type { Redis } from "ioredis";
import type { Job, Worker } from "bullmq";
import { scrubbedConsole } from "@mega-crm/redaction";
import { attachSharedErrorListeners, buildRedisConnectionOptions, createRedisConnection } from "@mega-crm/queue-core";
import { pool } from "@mega-crm/tenant-context";
import { assertMigrationsCurrent } from "@mega-crm/db";
import { markWorkerDraining, startWorkerHealthServer, type WorkerHealthServer } from "./health-server.js";
import { assertKmsReady } from "@mega-crm/kms";
import { logger } from "./logger.js";
import { mountBullBoard } from "./bull-board.js";
import { closeTrackedQueues } from "./queues/queue-registry.js";
import { isTerminalJobFailure, writeDeadLetterOnTerminalFailure } from "./queues/dead-letter/dead-letter-writer.js";
import { setProcessorErrorReporter } from "./processor-wrapper.js";
import { initSentry, reportProcessorError, flushSentry, SENTRY_FLUSH_TIMEOUT_MS } from "./sentry.js";
import { createEventsIngestWorker } from "./queues/events-ingest.worker.js";
import { createImportsCsvWorker } from "./queues/imports-csv.worker.js";
import { createEmailBroadcastWorker } from "./queues/email-broadcast.worker.js";
import { createEmailTriggeredWorker } from "./queues/email-triggered.worker.js";
import { createCampaignKickoffWorker } from "./queues/campaign-kickoff.worker.js";
import { createCampaignSchedulerWorker } from "./queues/campaign-scheduler.worker.js";
import { createWebhookEventsWorker } from "./queues/webhook-events.worker.js";
import { createAnalyticsReconciliationWorker } from "./queues/analytics-reconciliation.worker.js";
import { createFlowRunAdvanceWorker } from "./queues/flows/flow-run-advance.worker.js";
import { createFlowReconciliationWorker } from "./queues/flows/flow-reconciliation.worker.js";
import { createFlowTriggerEvaluatorWorker } from "./queues/flows/flow-trigger-evaluator.worker.js";
import { createFlowSegmentSweepWorker } from "./queues/flows/flow-segment-sweep.worker.js";
import { createFlowSegmentSweepFlowWorker } from "./queues/flows/flow-segment-sweep-flow.worker.js";
import { createFlowEnrollExistingWorker } from "./queues/flows/flow-enroll-existing.worker.js";
import { createPartitionMaintenanceWorker } from "./queues/partition-maintenance.worker.js";
import { createSendReconcilerWorker } from "./queues/send-reconciler.worker.js";
import { createWebhookReplaySweepWorker } from "./queues/webhook-replay-sweep.worker.js";
import { createReputationTickWorker } from "./queues/reputation-tick.worker.js";
import { createErasureScrubWorker } from "./queues/erasure-scrub.worker.js";
import { createErasureScrubReclaimWorker } from "./queues/erasure-scrub-reclaim.worker.js";

/**
 * The worker process's runtime handle: a standalone shared ioredis
 * connection (kept for process-level shutdown/inspection, e.g. a future
 * @bull-board wiring) plus every registered BullMQ Worker. 02-06 (event
 * ingestion) registers events:ingest below; 02-07 (CSV import) pushes its
 * Worker into `workers` here too — this file stays the single place that
 * owns process-level startup/shutdown, so neither slice plan needs to
 * re-derive graceful-shutdown wiring.
 *
 * Each Worker gets its OWN internal connection built from plain
 * `buildRedisConnectionOptions(...)` (not this shared `connection`
 * instance) -- BullMQ bundles its own internal `ioredis` copy at a
 * different version than this workspace's, so passing a constructed
 * `Redis` client instance across that boundary is a TypeScript nominal-type
 * mismatch (see events-ingest.worker.ts's `createEventsIngestWorker` doc
 * comment); a plain options object has no such class identity and works
 * regardless. `worker.close()` (called below) already closes each Worker's
 * own BullMQ-managed connection.
 */
export interface WorkerRuntime {
  connection: ReturnType<typeof createRedisConnection>;
  workers: Worker[];
  /** Phase 14 plan 04 (D-14, OPS-04/OPS-05): the worker's own `/healthz`+`/readyz` listener -- see `closeWorkerRuntime`'s ordering comment for why it closes LAST. */
  healthServer: WorkerHealthServer;
  close: () => Promise<void>;
}

/**
 * Phase 12 (WRK-07): the shutdown ordering, factored out of `buildWorker()`
 * so it is testable without constructing all sixteen production workers
 * (`graceful-shutdown.test.ts` drives this directly against a handful of
 * real, test-scoped `Worker`s/`Queue`s).
 *
 * Order matters: every registered `Worker` closes FIRST (draining any
 * in-flight job to completion, BullMQ's own default), THEN every tracked
 * long-lived `Queue` handle (`queue-registry.ts`) closes, THEN the shared
 * connection disconnects, and -- Phase 14 plan 04 (D-14, R-05) -- the health
 * server closes LAST, after all three of those. A producer `Queue` close
 * racing a still-draining `Worker` could drop an enqueue the worker was
 * mid-making; closing workers first removes that race entirely. The health
 * server closes last because the entire point of `markWorkerDraining()` is
 * that a draining process can still be ASKED what it is doing while it
 * drains -- closing the listener before the drain finishes would blind the
 * deploy script at exactly the moment it most needs visibility.
 * `healthServer` is optional so this function's existing two-argument call
 * sites (`graceful-shutdown.test.ts`'s pre-existing Phase 12 tests, which
 * construct neither a real `WorkerRuntime` nor a health server) keep
 * working unchanged. Idempotent: calling this twice is safe --
 * `closeTrackedQueues()` drains its own registry before closing, BullMQ's
 * own `Worker.close()` and `Redis.disconnect()` both tolerate being called
 * more than once, and `startWorkerHealthServer`'s own `close()` guards
 * against a second `node:http` close (which would otherwise reject).
 */
export async function closeWorkerRuntime(
  workers: Worker[],
  connection: Redis,
  healthServer?: WorkerHealthServer
): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  await closeTrackedQueues();
  // Phase 15 plan 10 (OPS-08, T-15-32): flushes any Sentry event still
  // in-flight AFTER every worker/queue has fully drained, so a real
  // in-flight capture is not racing a job that is still being processed --
  // but BEFORE the shared connection disconnects and the health server
  // closes, so a hanging flush is still bounded by its own explicit timeout
  // rather than by anything downstream. A no-op (resolves immediately) when
  // Sentry was never initialized (no DSN configured).
  await flushSentry(SENTRY_FLUSH_TIMEOUT_MS);
  connection.disconnect();
  if (healthServer) {
    await healthServer.close();
  }
}

/**
 * Phase 12 (WRK-08/WRK-10): attaches the shared error/failed listener over
 * the FULL worker array handed to it, rather than at each factory's own
 * construction site. Factored out of `buildWorker()` so
 * `shared-error-listener.test.ts` can drive it directly against a handful
 * of real, test-scoped `Worker`s without constructing all sixteen
 * production workers (the same testability reasoning as
 * `closeWorkerRuntime` above).
 *
 * `onTerminalFailure` composes the terminal-vs-mid-retry gate
 * (`isTerminalJobFailure`) with the dead-letter writer explicitly, even
 * though the writer re-checks the same gate internally -- a mid-retry
 * failure must never reach the writer at all, not merely be filtered inside
 * it, so the composition is visible at the call site that wires the two
 * together.
 *
 * Attaching over the array (not per-factory) is deliberate: the array is
 * the exhaustive registry of every worker this process runs, so a worker
 * added to it later can never be forgotten the way a per-factory call site
 * could be if a future author simply forgot to add it to a new factory.
 */
export function attachSharedListeners(workers: Worker[]): void {
  const onTerminalFailure = (job: Job | undefined, err: Error, queueName: string): Promise<void> | undefined => {
    if (!job || !isTerminalJobFailure(job)) {
      return undefined;
    }
    return writeDeadLetterOnTerminalFailure(job, err, queueName);
  };

  for (const worker of workers) {
    attachSharedErrorListeners(worker, worker.name, { onTerminalFailure });
  }
}

/**
 * Phase 16 (D-06/D-07): the worker's loud, non-fatal boot-time announcement
 * for the `SENDGRID_BASE_URL` override -- factored out of `buildWorker()`
 * (same testability reasoning as `attachSharedListeners`/`closeWorkerRuntime`
 * above) so `sendgrid-base-url-boot-log.test.ts` can drive it directly
 * against an injected logger double, without constructing all twenty
 * production BullMQ workers.
 *
 * Deliberately does NOT throw when the override is active: D-07 explicitly
 * rejected a production guard here, because the UAT itself runs on the
 * production VPS -- the override must remain usable for its own purpose. The
 * absent/empty-string case is a silent no-op, mirroring
 * `packages/delivery-core/src/send-mail.ts`'s own absent-is-default
 * treatment of the same variable. `log` defaults to the module's real Pino
 * logger; tests inject a stub.
 */
export function logSendgridBaseUrlOverrideIfActive(log: Pick<typeof logger, "warn"> = logger): void {
  const override = process.env.SENDGRID_BASE_URL;
  if (!override || override.length === 0) {
    return;
  }
  log.warn(
    { sendgridBaseUrlOverride: override },
    "SENDGRID_BASE_URL override is active -- tenant mail is NOT going to real SendGrid. This must NEVER be set outside a Phase 16 UAT fault-injection session."
  );
}

/**
 * Assembles the worker runtime: one shared Redis connection plus the
 * events:ingest (EVNT-02/EVNT-03) and imports:csv (CONT-02) BullMQ Workers.
 * No HTTP listener; this is a long-running background process, not a
 * server.
 */
// Phase 14 plan 04: buildWorker() now genuinely awaits (startWorkerHealthServer),
// so the require-await disable this function needed before that change is
// stale -- removed rather than left as a now-inert directive.
export async function buildWorker(): Promise<WorkerRuntime> {
  await assertKmsReady();
  // Phase 15 plan 10 (OPS-08): initialized once at boot, before anything
  // else -- a missing SENTRY_DSN_WORKER is a no-op (initSentry logs once and
  // returns false), so this never blocks/slows boot. The reporter is
  // injected into processor-wrapper.ts's seam UNCONDITIONALLY, DSN or not --
  // `reportProcessorError`'s own Sentry.captureException call already
  // no-ops when no client is initialized, exactly like
  // apps/api/src/server.ts's Sentry.setupFastifyErrorHandler wiring.
  initSentry();
  setProcessorErrorReporter(reportProcessorError);

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required for apps/worker to start");
  }

  // Phase 10 (SEC-01/SEC-02, P3): the worker is the ONLY process that may
  // hold this credential -- apps/api/src/env.ts's schema deliberately does
  // not declare SCAN_DATABASE_URL at all, which is the structural half of
  // the "API process holds neither scan-role credentials nor membership"
  // proof. Fail fast here rather than let the first cross-workspace scan
  // throw lazily deep inside a BullMQ job.
  const scanDatabaseUrl = process.env.SCAN_DATABASE_URL;
  if (!scanDatabaseUrl) {
    throw new Error(
      "SCAN_DATABASE_URL is required for apps/worker to start -- cross-workspace scans connect as the dedicated least-privilege mega_crm_scan role"
    );
  }

  // 04-16 gap closure: the send workers registered below (email-broadcast,
  // email-triggered) call signUnsubscribeToken/buildListUnsubscribeUrl
  // (packages/delivery-core/src/unsubscribe-token.ts) on every send --
  // those throw lazily per-job if unset. Fail fast here, before any Worker
  // is constructed, so a missing/weak secret dies the process at boot
  // instead of exhausting BullMQ retries into the failed set (the observed
  // UAT Test 4/5 failure mode).
  const unsubscribeTokenSecret = process.env.UNSUBSCRIBE_TOKEN_SECRET;
  if (!unsubscribeTokenSecret || unsubscribeTokenSecret.length < 32) {
    throw new Error(
      "UNSUBSCRIBE_TOKEN_SECRET (>=32 chars) is required for apps/worker to start -- it signs every List-Unsubscribe token"
    );
  }
  const publicAppUrl = process.env.PUBLIC_APP_URL;
  if (!publicAppUrl) {
    throw new Error(
      "PUBLIC_APP_URL is required for apps/worker to start -- it builds the public unsubscribe link"
    );
  }

  // Phase 16 (D-06/D-07): inverse-polarity check -- warn (never throw) when
  // SENDGRID_BASE_URL is active, so a forgotten override is discovered at
  // the next boot rather than by a delivery incident.
  logSendgridBaseUrlOverrideIfActive();

  const connection = createRedisConnection(redisUrl);
  const workers: Worker[] = [
    createEventsIngestWorker(buildRedisConnectionOptions(redisUrl)),
    createImportsCsvWorker(buildRedisConnectionOptions(redisUrl)),
    // SEND-03: two independently-concurrent queues (bounded broadcast,
    // higher-concurrency triggered) -- each gets its OWN
    // buildRedisConnectionOptions(...) call, same nominal-type reason as the
    // two workers above (never a constructed Redis instance).
    createEmailBroadcastWorker(buildRedisConnectionOptions(redisUrl)),
    createEmailTriggeredWorker(buildRedisConnectionOptions(redisUrl)),
    // CAMP-02/SEND-01: closes the launch-to-send loop -- the kickoff worker
    // consumes CAMPAIGN_KICKOFF_QUEUE (produced by both the launch route's
    // immediate-launch enqueue and the scheduler below); the scheduler scans
    // due `scheduled` campaigns and produces the same kickoff job.
    createCampaignKickoffWorker(buildRedisConnectionOptions(redisUrl)),
    createCampaignSchedulerWorker(buildRedisConnectionOptions(redisUrl)),
    // WBHK-01/03: its own dedicated lane (not folded into events-ingest or
    // either send queue), per CLAUDE.md queue-isolation guidance.
    createWebhookEventsWorker(buildRedisConnectionOptions(redisUrl)),
    // ANLT-04 (07-06): periodic correctness backstop for workspace_daily_rollup
    // -- overwrites each recent day's row from a fresh scan of `sends`,
    // self-healing any drift from the webhook worker's incremental increments.
    createAnalyticsReconciliationWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-01/03/06/07 (06-05): the flow execution engine -- the advance
    // worker steps one flow_run one node at a time (send/exit this plan),
    // the reconciliation worker is its durable due-run backstop scan.
    createFlowRunAdvanceWorker(buildRedisConnectionOptions(redisUrl)),
    createFlowReconciliationWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-02/04 (06-06): the trigger evaluator -- matches an ingested
    // event's name against live event-triggered flows, applies re-entry
    // control + the one-active-run guard, and creates version-pinned runs.
    createFlowTriggerEvaluatorWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-02 (06-08): the segment-entry periodic bulk-diff sweep (D-02b
    // safety net) -- discovery half, enqueues one bounded walk job per flow.
    createFlowSegmentSweepWorker(buildRedisConnectionOptions(redisUrl)),
    // WRK-05/WRK-06 (12-06): the sweep's bounded, checkpointed, resumable
    // per-flow walk -- pages on contacts.id under a per-page statement
    // timeout, committing its resume cursor in the same transaction as
    // that page's enrollment work, so a kill between pages is exactly
    // resumable by construction.
    createFlowSegmentSweepFlowWorker(buildRedisConnectionOptions(redisUrl)),
    // FLOW-02/D-04 (06-08): the publish route's enroll-existing resumable
    // batch, fired once per publish when the marketer chooses to back-fill
    // current segment members.
    createFlowEnrollExistingWorker(buildRedisConnectionOptions(redisUrl)),
    // DB-01/DB-02 (09-02): keeps the rolling monthly partition horizon for
    // `events`/`send_events` self-maintaining (daily 03:00 UTC job-scheduler
    // tick plus one immediate run per boot) and writes the
    // `partition_maintenance_runs` health row the API-side watchdog
    // (`apps/api/src/modules/ops/partition-watchdog.ts`, started in a
    // DIFFERENT process by this plan's task 3) reads.
    createPartitionMaintenanceWorker(buildRedisConnectionOptions(redisUrl)),
    // DLV-03 (11-03): the classification-only reconciler -- discovers
    // `reconciling` rows across every tenant (cross-workspace scan role),
    // claims each one exclusively per-tenant, and resolves it to `sent`
    // from webhook evidence already on disk. Never calls SendGrid (D-01).
    createSendReconcilerWorker(buildRedisConnectionOptions(redisUrl)),
    // CMP-08 (D-06/D-07, 13-06): the recovery half of the webhook-ingress
    // durability journal (13-01) -- finds journal rows with no
    // ingestion-complete mark past the stuck threshold and re-enqueues them
    // onto webhook-events, then prunes/tombstones the journal at its
    // retention horizon in the same tick.
    createWebhookReplaySweepWorker(buildRedisConnectionOptions(redisUrl)),
    // CMP-09 (D-09 through D-12, 13-09): measures each tenant's
    // spam-complaint and hard-bounce rates over a rolling 7-day window from
    // delivery fact columns already on `sends`, tiers them, and records the
    // observation per workspace per metric. Measurement only -- nothing here
    // pauses, throttles, or blocks sending; plan 13-11 carries the alert.
    createReputationTickWorker(buildRedisConnectionOptions(redisUrl)),
    // CMP-04 (D-01/D-04, 13-13): the asynchronous evidence-hygiene half of
    // contact erasure -- consumes the job plan 13-10's deleteContact
    // enqueues, walking the erased contact's linked send_events.payload and
    // events.properties rows in bounded, checkpointed pages and rewriting
    // each JSONB value from an explicit evidence allowlist. Job-per-erasure,
    // not a repeatable tick -- registers no job scheduler.
    createErasureScrubWorker(buildRedisConnectionOptions(redisUrl)),
    // CMP-04 (D-04, R-05, 13-15): closes the last gap in CMP-04's durability
    // chain -- plan 13-10's deleteContact enqueues the scrub job AFTER its
    // transaction commits, which leaves exactly one failure mode: a crash
    // between the commit and the enqueue strands a durable pending
    // erasure_records row with no job behind it. This scheduled tick finds
    // such stranded pending/scrubbing records past a 15-minute lease and
    // re-enqueues their scrub through the SAME shared job-id derivation the
    // request path uses, so a reclaim of an already-queued record is a
    // no-op rather than a second scrub.
    createErasureScrubReclaimWorker(buildRedisConnectionOptions(redisUrl)),
  ];

  // Phase 12 (WRK-08/WRK-10): attach the shared error/failed listener,
  // wired to the dead-letter writer, over the FULL worker array immediately
  // after it is built -- see attachSharedListeners's own doc comment above
  // for why this happens over the array rather than per-factory.
  attachSharedListeners(workers);

  // Phase 14 plan 04 (D-14, OPS-04/OPS-05): the worker's own health server --
  // same three checks apps/api's /readyz runs, reusing the SAME
  // `@mega-crm/tenant-context` pool the worker already holds (never a
  // second Postgres connection) and the SAME shared ioredis `connection`
  // constructed above (never a second Redis connection). `checkMigrationsCurrent`
  // is `assertMigrationsCurrent` (D-13, packages/db/src/migration-journal.ts)
  // bound to that pool -- the identical applied-vs-shipped definition
  // apps/api's /readyz uses, never a second comparison.
  //
  // Phase 15 plan 16 (OPS-14, D-09/D-10): `beforeListen` mounts the
  // read-only Bull Board onto this SAME Fastify instance -- `board-queues.ts`'s
  // handles are already constructed by the time this module graph finished
  // loading (its module-level `boardQueues` array is built at import time,
  // before `main()` ever runs), so "after the queue handles exist" holds by
  // construction; this hook itself runs before `app.listen(...)` starts
  // accepting connections (`health-server.ts`'s own contract for the hook).
  const healthServer = await startWorkerHealthServer({
    queryPostgres: () => pool.query("SELECT 1"),
    redisConnection: connection,
    checkMigrationsCurrent: () => assertMigrationsCurrent(pool),
    beforeListen: mountBullBoard,
  });

  const close = (): Promise<void> => closeWorkerRuntime(workers, connection, healthServer);

  return { connection, workers, healthServer, close };
}

/**
 * R-05 (stop-old-then-start-new): the exact shutdown path the SIGTERM/SIGINT
 * handler below invokes, factored out so tests can drive it directly rather
 * than sending a real signal to the test process
 * (`health-server.test.ts`'s `WorkerRuntime` lifecycle suite).
 * `markWorkerDraining()` runs BEFORE `runtime.close()` begins -- this
 * ordering IS the observable half of R-05: the deploy script needs "the old
 * worker has stopped accepting work" as a fact, and a flag flipped at the
 * very start of shutdown, before any Worker/Queue/connection starts
 * closing, is that fact.
 */
export function requestWorkerRuntimeShutdown(runtime: WorkerRuntime): Promise<void> {
  markWorkerDraining();
  return runtime.close();
}

async function main(): Promise<void> {
  const runtime = await buildWorker();

  const shutdown = (signal: NodeJS.Signals) => {
    scrubbedConsole.log(`apps/worker received ${signal}, shutting down gracefully`);
    requestWorkerRuntimeShutdown(runtime)
      .then(() => process.exit(0))
      .catch((err) => {
        scrubbedConsole.error("apps/worker shutdown error", err);
        process.exit(1);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  scrubbedConsole.log(
    `apps/worker started (${runtime.workers.length} BullMQ worker(s) registered: events:ingest, imports:csv, email-broadcast, email-triggered, campaign-kickoff, campaign-scheduler, webhook-events, analytics-reconciliation, flow-run-advance, flow-reconciliation, flow-trigger-evaluator, flow-segment-sweep, flow-segment-sweep-flow, flow-enroll-existing, partition-maintenance, send-reconciler, webhook-replay-sweep, reputation-tick, erasure-scrub, erasure-scrub-reclaim)`
  );
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    scrubbedConsole.error(err);
    process.exitCode = 1;
  });
}
