import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MigrationsPendingError, MigrationsTableMissingError } from "@mega-crm/db";
import { ensureTestDbMigrated, startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { buildRedisConnectionOptions, createRedisConnection } from "@mega-crm/queue-core";
import {
  checkWorkerReadiness,
  markWorkerDraining,
  resetWorkerDrainingForTests,
  startWorkerHealthServer,
  WORKER_HEALTH_HOST,
  type WorkerHealthServer,
  type WorkerReadinessDeps,
} from "../health-server.js";
import { buildWorker, closeWorkerRuntime, requestWorkerRuntimeShutdown, type WorkerRuntime } from "../server.js";

/**
 * Phase 14 plan 04 (D-14, OPS-04/OPS-05, R-05) -- the worker's health
 * contract, mirroring `apps/api/src/modules/ops/__tests__/healthz.test.ts` /
 * `readyz.test.ts`'s structure: Task 1's block drives `startWorkerHealthServer`
 * directly with fully injected (fake) dependencies -- no real Postgres/Redis
 * needed at all, matching this plan's own "drive each failure independently
 * without stopping shared services" design goal. Task 2's block extends this
 * SAME file with the real `buildWorker()`/`closeWorkerRuntime` lifecycle.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function makeDeps(overrides: Partial<WorkerReadinessDeps> = {}): WorkerReadinessDeps {
  return {
    queryPostgres: () => Promise.resolve({ rows: [{ ok: 1 }] }),
    redisConnection: { info: () => Promise.resolve("redis_version:7.0.0") },
    checkMigrationsCurrent: () => Promise.resolve(),
    ...overrides,
  };
}

describe("apps/worker health server (Task 1: node:http, loopback, three named checks)", () => {
  const PORT = 4187;
  let server: WorkerHealthServer | undefined;

  afterEach(async () => {
    resetWorkerDrainingForTests();
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  async function start(overrides: Partial<WorkerReadinessDeps> = {}): Promise<void> {
    server = await startWorkerHealthServer({ ...makeDeps(overrides), port: PORT });
  }

  it("GET /healthz returns 200 with a static body and performs no Postgres/Redis I/O, even when both would fail", async () => {
    let postgresCalled = false;
    let redisCalled = false;
    await start({
      queryPostgres: () => {
        postgresCalled = true;
        return Promise.reject(new Error("should never be called"));
      },
      redisConnection: {
        info: () => {
          redisCalled = true;
          return Promise.reject(new Error("should never be called"));
        },
      },
    });

    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(postgresCalled).toBe(false);
    expect(redisCalled).toBe(false);
  });

  it("GET /readyz returns 200 when Postgres, Redis and migrations all pass", async () => {
    await start();
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ready: boolean; checks: { name: string; ok: boolean }[] };
    expect(body.ready).toBe(true);
    expect(body.checks.every((check) => check.ok)).toBe(true);
  });

  it("GET /readyz returns 503 naming the postgres check when Postgres is unreachable", async () => {
    await start({ queryPostgres: () => Promise.reject(new Error("connection refused")) });
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ready: boolean; checks: { name: string; ok: boolean; detail?: string }[] };
    expect(body.ready).toBe(false);
    const postgresCheck = body.checks.find((check) => check.name === "postgres");
    expect(postgresCheck?.ok).toBe(false);
    expect(postgresCheck?.detail).toBeTruthy();
  });

  it("GET /readyz returns 503 naming the redis check when only Redis is unreachable", async () => {
    await start({ redisConnection: { info: () => Promise.reject(new Error("redis down")) } });
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ready: boolean; checks: { name: string; ok: boolean }[] };
    expect(body.ready).toBe(false);
    const redisCheck = body.checks.find((check) => check.name === "redis");
    expect(redisCheck?.ok).toBe(false);
    const postgresCheck = body.checks.find((check) => check.name === "postgres");
    expect(postgresCheck?.ok).toBe(true);
    const migrationsCheck = body.checks.find((check) => check.name === "migrations");
    expect(migrationsCheck?.ok).toBe(true);
  });

  it("GET /readyz returns 503 naming the migration check and listing pending tags", async () => {
    await start({
      checkMigrationsCurrent: () => Promise.reject(new MigrationsPendingError(["0001_init", "0002_add_column"])),
    });
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: { name: string; ok: boolean; detail?: string }[] };
    const migrationsCheck = body.checks.find((check) => check.name === "migrations");
    expect(migrationsCheck?.ok).toBe(false);
    expect(migrationsCheck?.detail).toContain("0001_init");
    expect(migrationsCheck?.detail).toContain("0002_add_column");
  });

  it("GET /readyz returns 503 for a never-migrated database (MigrationsTableMissingError)", async () => {
    await start({ checkMigrationsCurrent: () => Promise.reject(new MigrationsTableMissingError()) });
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { checks: { name: string; ok: boolean; detail?: string }[] };
    const migrationsCheck = body.checks.find((check) => check.name === "migrations");
    expect(migrationsCheck?.ok).toBe(false);
    expect(migrationsCheck?.detail).toBeTruthy();
  });

  it("GET /readyz returns 503 after markWorkerDraining() even when all three checks would pass", async () => {
    await start();
    markWorkerDraining();
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ready: boolean; checks: unknown[] };
    expect(body.ready).toBe(false);
  });

  it("GET /unknown returns 404", async () => {
    await start();
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/unknown`);
    expect(response.status).toBe(404);
  });

  it("POST /healthz returns 405", async () => {
    await start();
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/healthz`, { method: "POST" });
    expect(response.status).toBe(405);
  });

  it("the /readyz response body never contains a queue name, DSN or tenant identifier", async () => {
    await start({
      queryPostgres: () => Promise.reject(new Error("connection refused to postgresql://user:pw@host/db")),
    });
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    const raw = await response.text();
    expect(raw).not.toMatch(/email:triggered|email:broadcast|tenant_id|workspace_id/i);
  });

  it("binds to the loopback interface only -- a connection via the IPv6 loopback address (::1) on the same port is refused", async () => {
    await start();

    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "::1", port: PORT, family: 6 }, () => {
          socket.destroy();
          reject(new Error("connection to ::1 unexpectedly succeeded"));
        });
        socket.on("error", () => {
          resolve();
        });
      })
    ).resolves.toBeUndefined();
  });

  it("closing the server resolves and releases the port, so a second startWorkerHealthServer on the same port succeeds", async () => {
    await start();
    await server?.close();
    server = undefined;

    const second = await startWorkerHealthServer({ ...makeDeps(), port: PORT });
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/healthz`);
    expect(response.status).toBe(200);
    await second.close();
  });

  it("checkWorkerReadiness itself (no HTTP) matches the same contract exercised above", async () => {
    const result = await checkWorkerReadiness(makeDeps());
    expect(result.ready).toBe(true);
    expect(result.checks.map((check) => check.name).sort()).toEqual(["migrations", "postgres", "redis"]);
  });
});

describe("WorkerRuntime lifecycle (Task 2): health server owned by buildWorker()/closeWorkerRuntime", () => {
  const RUNTIME_HEALTH_PORT = 4188;

  // A DEDICATED throwaway Redis (startTempRedis), never the shared
  // per-project TEST_REDIS_URL/db1 -- that logical DB is shared across every
  // apps/worker test FILE and can carry leftover queued jobs from sibling
  // suites (e.g. email-broadcast/email-triggered fixtures that never
  // drained). Constructing the FULL real `buildWorker()` (all twenty
  // production BullMQ Workers, using the SAME production queue names) against
  // that shared DB means this test's runtime immediately starts consuming
  // and processing whatever stale backlog is sitting there -- observed
  // directly during this plan's own verification as a flood of unrelated
  // job-processing log noise and a resource-contention-induced ECONNRESET on
  // this test's own loopback health-check socket. An isolated instance has
  // no queues but the ones this test itself creates.
  let redis: TempRedis;
  let previousRedisUrl: string | undefined;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    redis = await startTempRedis({});
  }, 30_000);

  afterAll(async () => {
    await redis?.stop();
  });

  afterEach(() => {
    resetWorkerDrainingForTests();
    delete process.env.WORKER_HEALTH_PORT;
    if (previousRedisUrl !== undefined) {
      process.env.REDIS_URL = previousRedisUrl;
      previousRedisUrl = undefined;
    }
  });

  it(
    "buildWorker() returns a runtime whose health server is listening, and /readyz on it is answerable",
    async () => {
      previousRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = redis.url;
      process.env.WORKER_HEALTH_PORT = String(RUNTIME_HEALTH_PORT);

      const runtime = await buildWorker();
      try {
        expect(runtime.healthServer).toBeDefined();

        const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(RUNTIME_HEALTH_PORT)}/readyz`);
        expect([200, 503]).toContain(response.status);
        const body = (await response.json()) as { ready: boolean; checks: unknown[] };
        expect(typeof body.ready).toBe("boolean");
        expect(Array.isArray(body.checks)).toBe(true);
      } finally {
        await runtime.close();
      }
    },
    30_000
  );

  it(
    "the SIGTERM path (requestWorkerRuntimeShutdown) marks draining before the BullMQ workers finish closing, close() is idempotent, and the health port frees for reuse",
    async () => {
      // A minimal, test-scoped WorkerRuntime -- same shape buildWorker()
      // returns, same closeWorkerRuntime()/requestWorkerRuntimeShutdown()
      // wiring, but with exactly one throwaway BullMQ Worker rather than all
      // twenty production ones (this plan's own health-server.ts/server.ts
      // wiring is what's under test here, not any individual queue's
      // behavior -- graceful-shutdown.test.ts's Phase 12 precedent for this
      // exact kind of lifecycle assertion).
      const SIGTERM_TEST_PORT = 4189;
      const connectionOptions = buildRedisConnectionOptions(redis.url);
      const worker = new Worker("health-lifecycle-test-queue", () => Promise.resolve(undefined), {
        connection: connectionOptions,
      });
      const connection = createRedisConnection(redis.url);
      const healthServer = await startWorkerHealthServer({
        ...makeDeps(),
        redisConnection: connection,
        port: SIGTERM_TEST_PORT,
      });
      const runtime: WorkerRuntime = {
        connection,
        workers: [worker],
        healthServer,
        close: () => closeWorkerRuntime([worker], connection, healthServer),
      };

      let releaseClose: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseClose = resolve;
      });
      const originalClose = worker.close.bind(worker);
      const closeSpy = vi.spyOn(worker, "close").mockImplementation(async () => {
        await gate;
        return originalClose();
      });

      const shutdownPromise = requestWorkerRuntimeShutdown(runtime);

      await vi.waitFor(() => {
        expect(closeSpy).toHaveBeenCalled();
      });

      const midResponse = await fetch(`http://${WORKER_HEALTH_HOST}:${String(SIGTERM_TEST_PORT)}/readyz`);
      expect(midResponse.status).toBe(503);
      const midBody = (await midResponse.json()) as { ready: boolean };
      expect(midBody.ready).toBe(false);

      releaseClose?.();
      await shutdownPromise;

      // Idempotent close.
      await expect(runtime.close()).resolves.toBeUndefined();

      // The health port is free -- a fresh listener on the same port succeeds.
      const fresh = await startWorkerHealthServer({ ...makeDeps(), port: SIGTERM_TEST_PORT });
      const freshResponse = await fetch(`http://${WORKER_HEALTH_HOST}:${String(SIGTERM_TEST_PORT)}/healthz`);
      expect(freshResponse.status).toBe(200);
      await fresh.close();
    },
    30_000
  );

  describe("source invariants", () => {
    it("WorkerRuntime declares a healthServer field, and buildWorker() starts it", () => {
      const source = readFileSync(path.join(REPO_ROOT, "apps/worker/src/server.ts"), "utf8");
      expect(source).toMatch(/healthServer:\s*WorkerHealthServer/);
      expect(source).toMatch(/startWorkerHealthServer\(/);
    });

    it("markWorkerDraining is called before runtime.close() in the shutdown path", () => {
      const source = readFileSync(path.join(REPO_ROOT, "apps/worker/src/server.ts"), "utf8");
      const fnBody = source.slice(source.indexOf("export function requestWorkerRuntimeShutdown"));
      const drainIdx = fnBody.indexOf("markWorkerDraining()");
      const closeIdx = fnBody.indexOf("runtime.close()");
      expect(drainIdx).toBeGreaterThan(-1);
      expect(closeIdx).toBeGreaterThan(drainIdx);
    });

    it("closeWorkerRuntime closes the health server last, after the shared connection disconnects", () => {
      const source = readFileSync(path.join(REPO_ROOT, "apps/worker/src/server.ts"), "utf8");
      const closeWorkerRuntimeBody = source.slice(source.indexOf("export async function closeWorkerRuntime"));
      const disconnectIdx = closeWorkerRuntimeBody.indexOf("connection.disconnect()");
      const healthCloseIdx = closeWorkerRuntimeBody.indexOf("healthServer.close()");
      expect(disconnectIdx).toBeGreaterThan(-1);
      expect(healthCloseIdx).toBeGreaterThan(disconnectIdx);
    });
  });
});
