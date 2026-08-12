import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";
import type { EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { Worker, type Job } from "bullmq";
import { buildRedisConnectionOptions, createRedisConnection, SEND_LOCK_DURATION_MS } from "@mega-crm/queue-core";
import { pool } from "@mega-crm/tenant-context";
import { assertMigrationsCurrent } from "@mega-crm/db";
import { scrubbedConsole } from "@mega-crm/redaction";

import { handleEmailBroadcastJob } from "../../queues/email-broadcast.worker.js";
import { markWorkerDraining, startWorkerHealthServer, type WorkerHealthServer } from "../../health-server.js";
import { closeWorkerRuntime } from "../../server.js";

/**
 * Phase 14 plan 07, Task 3 (Pitfall 7) -- the child process for
 * `sigterm-mid-load.test.ts`. Builds a MINIMAL, real production-shaped
 * worker runtime (one BullMQ `Worker` consuming a test-scoped queue via the
 * real `handleEmailBroadcastJob` processor, plus a real `/healthz`+`/readyz`
 * listener wired exactly the way `apps/worker/src/server.ts`'s `buildWorker()`
 * wires its own -- same `markWorkerDraining`/`closeWorkerRuntime` functions,
 * same shared-connection discipline) rather than the full twenty-worker
 * production process: the twenty other workers add nothing this scenario
 * observes, and each would need its own fixture wiring (SCAN_DATABASE_URL,
 * UNSUBSCRIBE_TOKEN_SECRET, PUBLIC_APP_URL) that has no bearing on the one
 * question under test -- does a REAL SIGTERM sent to a REAL process under
 * REAL load cause it to self-terminate inside its grace period, and does
 * `/readyz` observe the transition.
 *
 * TEST HARNESS ONLY. Nothing in production imports this file.
 *
 * The injected `sendMail` never reaches SendGrid (the same
 * `ProcessSendJobDeps.sendMail` seam every other failure-injection file
 * uses) -- it resolves a fixed 202 after a deliberate, short, configurable
 * delay, which is what makes a job provably "in flight" for a
 * parent-observable window without ever risking a live network call.
 *
 * SIGTERM/SIGINT are handled by calling `markWorkerDraining()` FIRST, then
 * `closeWorkerRuntime` (the SAME two-step ordering `server.ts`'s
 * `requestWorkerRuntimeShutdown` uses) -- reused directly, not
 * reimplemented, so this harness proves the real shutdown path rather than
 * a parallel one that could quietly drift from it. `worker.close()`'s
 * default (non-forced) behavior WAITS for the current job to finish before
 * returning (BullMQ's own `Worker.close(force = false)`), which is the
 * mechanism that makes "no in-flight send left unresolved" true by
 * construction rather than by luck -- this file adds no additional
 * draining logic of its own.
 *
 * D-23-style ordering (mirrors `sigkill-entrypoint.ts` exactly, and for the
 * same reason): actual execution is gated behind `process.on("message", ...)`
 * receiving `SIGTERM_LOAD_HARNESS_RUN`, NOT run unconditionally at module
 * top level. The parent test file imports THIS module directly to reach
 * `SIGTERM_LOAD_HARNESS_READY` (the same constant both processes must agree
 * on) -- if `main()` ran eagerly at import time, that import alone would
 * execute the harness (reading env vars that do not exist in the PARENT
 * process, calling `process.exit`) inside the TEST RUNNER's own process,
 * not just inside the forked child. Gating behind the message handler makes
 * importing this file for its constant inert everywhere except inside the
 * forked child that `spawnAndAwaitReady` sends the run message to.
 */

function readEnvOrFail(name: string): string {
  const value = process.env[name];
  if (!value) {
    scrubbedConsole.error(`sigterm-load-entrypoint: ${name} is not set -- refusing to start`);
    process.exit(1);
  }
  return value;
}

export const SIGTERM_LOAD_HARNESS_READY = "sigterm-load-harness:ready";

/** The parent's go-ahead -- matches `spawnAndAwaitReady`'s default `runMessage` ("run"). */
const SIGTERM_LOAD_HARNESS_RUN = "run";

async function main(): Promise<void> {
  const redisUrl = readEnvOrFail("SIGTERM_LOAD_HARNESS_REDIS_URL");
  const queueName = readEnvOrFail("SIGTERM_LOAD_HARNESS_QUEUE_NAME");
  const healthPort = Number(readEnvOrFail("SIGTERM_LOAD_HARNESS_HEALTH_PORT"));
  const sendLatencyMs = Number(process.env.SIGTERM_LOAD_HARNESS_SEND_LATENCY_MS ?? "1500");

  const connection = createRedisConnection(redisUrl);

  const sendMail = (
    _apiKey: string,
    _payload: SendGridMailSendRequest,
  ): Promise<SendTenantMailResult> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve({ status: 202, headers: new Headers(), messageId: "sg-message-id-sigterm-harness" });
      }, sendLatencyMs);
    });

  const worker: Worker<EmailBroadcastJob> = new Worker<EmailBroadcastJob>(
    queueName,
    (job: Job<EmailBroadcastJob>, token) => handleEmailBroadcastJob(job, worker, { sendMail }, token),
    { connection: buildRedisConnectionOptions(redisUrl), concurrency: 5, lockDuration: SEND_LOCK_DURATION_MS },
  );

  const healthServer: WorkerHealthServer = await startWorkerHealthServer({
    queryPostgres: () => pool.query("SELECT 1"),
    redisConnection: connection,
    checkMigrationsCurrent: () => assertMigrationsCurrent(pool),
    port: healthPort,
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // R-05: mark draining BEFORE any close begins -- the observable fact
    // the parent's /readyz probe below depends on.
    markWorkerDraining();
    closeWorkerRuntime([worker], connection, healthServer)
      .then(() => {
        process.exit(0);
      })
      .catch((err: unknown) => {
        scrubbedConsole.error(`sigterm-load-entrypoint: shutdown error after ${signal}`, err);
        process.exit(1);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  process.send?.(SIGTERM_LOAD_HARNESS_READY);
}

process.on("message", (message: unknown) => {
  if (message !== SIGTERM_LOAD_HARNESS_RUN) return;

  main().catch((err: unknown) => {
    scrubbedConsole.error("sigterm-load-entrypoint: failed to start", err);
    process.exit(2);
  });
});
