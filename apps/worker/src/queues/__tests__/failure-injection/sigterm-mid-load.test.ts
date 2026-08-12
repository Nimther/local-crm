import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import type { ChildProcess } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Queue } from "bullmq";
import { startTempRedis, spawnAndAwaitReady, type SpawnedChild, type TempRedis } from "@mega-crm/test-support";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { upsertWorkspaceSendSettings } from "@mega-crm/delivery-core";
import type { EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
} from "../../../test/failure-fixtures.js";
import { WORKER_STOP_GRACE_PERIOD_SECONDS } from "../../../shutdown-budget.js";
import { SIGTERM_LOAD_HARNESS_READY } from "../../../test/harness/sigterm-load-entrypoint.js";

/**
 * Phase 14 plan 07, Task 3 -- Pitfall 7: "verify with a real SIGTERM sent
 * mid-load-test -- not just that shutdown *starts*" (ROADMAP.md § Phase 14).
 *
 * Reproduce with `npm run failure:sigterm-mid-load` from the repo root.
 *
 * A REAL child process (`apps/worker/src/test/harness/sigterm-load-entrypoint.ts`,
 * spawned via `spawnAndAwaitReady`, which uses `fork()`) runs a real BullMQ
 * `Worker` consuming a test-scoped queue through the real
 * `handleEmailBroadcastJob` processor and a real `/healthz`+`/readyz`
 * listener wired exactly the way `server.ts`'s `buildWorker()` wires its own.
 * This file drives sustained load into that queue (a burst of jobs against a
 * `concurrency: 5` worker, the same shape `tenant-rps-sustained.test.ts` and
 * `tenant-fairness.test.ts` already use for "real load, no SendGrid
 * traffic") until jobs are GENUINELY active (`queue.getActiveCount() > 0`,
 * polled -- a deterministic marker, never a sleep), THEN sends a REAL
 * `SIGTERM` and observes three things:
 *
 *   1. The process exits ON ITS OWN, with a clean status, before
 *      `WORKER_STOP_GRACE_PERIOD_SECONDS` elapses -- imported, never
 *      hand-typed, so a future change to any of its three inputs moves this
 *      test's deadline with it. This file contains NO SIGKILL fallback: if
 *      the child does not exit gracefully inside the budget, the awaiting
 *      promise below REJECTS and the test fails loudly, exactly the outcome
 *      the grace period exists to prevent (a forced kill must never be
 *      silently absorbed into a passing assertion).
 *   2. `/readyz`, probed over a REAL HTTP request to the child's own health
 *      port, returns 503 shortly after the signal -- the same fact a deploy
 *      script's "the old worker has stopped accepting work" check depends on
 *      (R-05).
 *   3. Every send that was in flight at SIGTERM ends in a state consistent
 *      with what the worker actually observed. BullMQ's `Worker.close()`
 *      (the default, non-forced form `closeWorkerRuntime` calls) WAITS for
 *      the currently-active job's processor promise to settle before
 *      returning -- so a send already claimed (`dispatching`) at the moment
 *      of the signal is expected to reach a real terminal outcome, not be
 *      abandoned. The one state that must NEVER appear once the process has
 *      exited is `dispatching` itself: a row still claimed by a process that
 *      is provably gone is exactly "an outcome nobody observed." Every other
 *      value in `SEND_STATUSES` (`sent`/`failed`/`reconciling`/`unknown`) is
 *      accepted without asserting which one -- Phase 11's own vocabulary,
 *      reused rather than reinvented, for a race the design deliberately
 *      leaves open.
 */
describe("failure injection: real SIGTERM mid-load, self-termination inside the stop-grace-period (Pitfall 7)", () => {
  let pool: Pool;
  let redis: TempRedis;
  const HARNESS_ENTRYPOINT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../test/harness/sigterm-load-entrypoint.ts",
  );

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await pool.end();
    await redis.stop();
  });

  /** Mirrors `packages/test-support/src/harness/temp-redis.ts`'s own private helper -- not exported, so duplicated here rather than widening that module's public surface for one caller. */
  async function reserveFreePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        server.close(() => {
          if (port > 0) resolve(port);
          else reject(new Error("could not reserve a free port for the SIGTERM-load harness's health server"));
        });
      });
    });
  }

  async function fetchReadyz(port: number): Promise<number> {
    const response = await fetch(`http://127.0.0.1:${String(port)}/readyz`);
    return response.status;
  }

  /**
   * Awaits the child's own 'exit' event -- NEVER sends a second signal.
   * `killAndAwaitExit` (packages/test-support) is deliberately NOT reused
   * here: it SIGKILLs by design, which is exactly the fallback this
   * scenario must never fall into on a passing run.
   */
  function awaitGracefulExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `sigterm-mid-load: child did not exit on its own within ${String(timeoutMs)}ms of SIGTERM -- ` +
              "this is a failure, not a case for a forced SIGKILL fallback",
          ),
        );
      }, timeoutMs);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }

  async function sendStatusCountsFor(workspaceId: string): Promise<Record<string, number>> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; count: string }>(
          `SELECT status, count(*)::text as count FROM sends WHERE workspace_id = $1 GROUP BY status`,
          [workspaceId],
        );
        return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
      }),
    );
  }

  it(
    "self-terminates on a real SIGTERM sent while jobs are actively in flight, reports 503 on /readyz, and leaves no send claimed-but-unresolved",
    async () => {
      const JOB_COUNT = 20;
      const SEND_LATENCY_MS = 1_500;

      const workspaceId = await freshWorkspaceId(pool, "sigterm-mid-load");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => upsertWorkspaceSendSettings(client, workspaceId, { rpsLimit: 50 })),
      );

      const contactIds: string[] = [];
      for (let i = 0; i < JOB_COUNT; i += 1) {
        contactIds.push(await createFixtureContact(workspaceId));
      }

      const queueName = `sigterm-load-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const healthPort = await reserveFreePort();

      const child: SpawnedChild = await spawnAndAwaitReady({
        entrypoint: HARNESS_ENTRYPOINT,
        readyMessage: SIGTERM_LOAD_HARNESS_READY,
        execArgv: ["--import", "tsx"],
        env: {
          DATABASE_URL: getTestDatabaseUrl(),
          TEST_DATABASE_URL: getTestDatabaseUrl(),
          REDIS_URL: redis.url,
          SIGTERM_LOAD_HARNESS_REDIS_URL: redis.url,
          SIGTERM_LOAD_HARNESS_QUEUE_NAME: queueName,
          SIGTERM_LOAD_HARNESS_HEALTH_PORT: String(healthPort),
          SIGTERM_LOAD_HARNESS_SEND_LATENCY_MS: String(SEND_LATENCY_MS),
        },
      });

      // Sanity check the harness is answering BEFORE the signal -- if this
      // fails, everything below would fail for the wrong reason.
      expect(await fetchReadyz(healthPort)).toBe(200);

      const queue = new Queue<EmailBroadcastJob>(queueName, { connection: buildRedisConnectionOptions(redis.url) });
      try {
        for (const contactId of contactIds) {
          await queue.add("send", { workspaceId, campaignId, kind: "campaign", contactId });
        }

        // Deterministic marker that jobs are GENUINELY in flight in the
        // child -- polled, never a blind sleep (SPEC R6).
        const activeDeadline = Date.now() + 10_000;
        for (;;) {
          const activeCount = await queue.getActiveCount();
          if (activeCount > 0) break;
          if (Date.now() > activeDeadline) {
            throw new Error("sigterm-mid-load: no job became active within 10s -- the harness worker never started consuming");
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }

        // --- the signal ------------------------------------------------------
        child.child.kill("SIGTERM");

        // --- fact 2: /readyz observes the drain almost immediately -----------
        const readyzDeadline = Date.now() + 2_000;
        let readyzStatus: number | undefined;
        for (;;) {
          try {
            readyzStatus = await fetchReadyz(healthPort);
          } catch {
            // The listener may already be mid-close by the time this
            // resolves -- treated as "not 200", the loop below decides pass/fail.
            readyzStatus = undefined;
          }
          if (readyzStatus === 503) break;
          if (Date.now() > readyzDeadline) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(readyzStatus, "/readyz must report 503 shortly after SIGTERM, while the process drains").toBe(503);

        // --- fact 1: self-termination inside the derived grace period --------
        const exit = await awaitGracefulExit(child.child, WORKER_STOP_GRACE_PERIOD_SECONDS * 1000);
        expect(exit.signal, "the process must exit ON ITS OWN -- a non-null signal means something else killed it").toBeNull();
        expect(exit.code, "a clean graceful shutdown exits 0").toBe(0);

        // --- fact 3: no send left claimed-but-unresolved ----------------------
        const counts = await sendStatusCountsFor(workspaceId);
        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        expect(total, "at least one send must have actually been claimed, or this scenario proves nothing").toBeGreaterThan(0);
        expect(
          counts.dispatching ?? 0,
          "no send may remain 'dispatching' once the process that claimed it has exited -- that is exactly the unobserved-outcome state the drain exists to prevent",
        ).toBe(0);

        const acceptableStatuses = new Set(["sent", "failed", "reconciling", "unknown"]);
        for (const status of Object.keys(counts)) {
          expect(acceptableStatuses.has(status), `unexpected send status "${status}" -- not in Phase 11's own terminal/ambiguous vocabulary`).toBe(
            true,
          );
        }
      } finally {
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
      }
    },
    Math.max(60_000, (WORKER_STOP_GRACE_PERIOD_SECONDS + 15) * 1000),
  );
});
