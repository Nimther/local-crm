import { afterEach, describe, expect, it } from "vitest";
import { MigrationsPendingError } from "@mega-crm/db";
import {
  markWorkerDraining,
  resetWorkerDrainingForTests,
  startWorkerHealthServer,
  WORKER_HEALTH_HOST,
  type WorkerHealthServer,
  type WorkerReadinessDeps,
} from "../health-server.js";

/**
 * Phase 15 plan 16 (OPS-14, Task 1): the externally-observed `/healthz`/
 * `/readyz` contract, captured against the PRE-MIGRATION `node:http`
 * implementation so the assertions here come from observed behaviour, not
 * from a reading of the source about to be rewritten. This file's own
 * `git diff` between the commit that adds it and the commit that migrates
 * `health-server.ts` onto Fastify must be EMPTY -- the same assertions,
 * unweakened, must pass against both transports. The container healthchecks
 * (`docker/docker-compose.prod.yml`) and `scripts/deploy.sh`'s readiness gate
 * both parse exactly this shape; a silent change here surfaces as a failed
 * production deploy, not a failed test, which is why this is captured BEFORE
 * the migration rather than after (this task's own `reversibility` note).
 *
 * Deliberately narrower in scope than the pre-existing `health-server.test.ts`
 * (which already exercises HEAD requests, IPv6-refusal, and the full
 * `WorkerRuntime` lifecycle) -- this file asserts exactly the six behaviours
 * this plan's own `<behavior>` block names, so a future edit to this file for
 * an unrelated reason has the smallest possible surface to accidentally
 * weaken.
 */

function makeDeps(overrides: Partial<WorkerReadinessDeps> = {}): WorkerReadinessDeps {
  return {
    queryPostgres: () => Promise.resolve({ rows: [{ ok: 1 }] }),
    redisConnection: { info: () => Promise.resolve("redis_version:7.0.0") },
    checkMigrationsCurrent: () => Promise.resolve(),
    ...overrides,
  };
}

describe("apps/worker health contract (OPS-14 Task 1): captured against the pre-Fastify implementation", () => {
  // 4190 (sieve/ManageSieve) is on the WHATWG fetch spec's "bad ports"
  // blocklist -- undici's fetch refuses to even attempt a connection to it
  // ("TypeError: fetch failed" / "Error: bad port"), discovered empirically
  // while writing this file. 4191 is not on that list.
  const PORT = 4191;
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

  it("GET /healthz returns 200 with the documented body and performs no I/O", async () => {
    let postgresCalled = false;
    let redisCalled = false;
    let migrationsCalled = false;
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
      checkMigrationsCurrent: () => {
        migrationsCalled = true;
        return Promise.reject(new Error("should never be called"));
      },
    });

    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(postgresCalled).toBe(false);
    expect(redisCalled).toBe(false);
    expect(migrationsCalled).toBe(false);
  });

  it("GET /readyz with all three checks passing returns 200 and the full checks array", async () => {
    await start();
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ready: boolean; checks: { name: string; ok: boolean }[] };
    expect(body.ready).toBe(true);
    expect(body.checks.map((check) => check.name).sort()).toEqual(["migrations", "postgres", "redis"]);
    expect(body.checks.every((check) => check.ok)).toBe(true);
  });

  it("GET /readyz with one check failing returns 503 and names the failing check", async () => {
    await start({
      checkMigrationsCurrent: () => Promise.reject(new MigrationsPendingError(["0001_init"])),
    });
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ready: boolean; checks: { name: string; ok: boolean; detail?: string }[] };
    expect(body.ready).toBe(false);
    const migrationsCheck = body.checks.find((check) => check.name === "migrations");
    expect(migrationsCheck?.ok).toBe(false);
    expect(migrationsCheck?.detail).toContain("0001_init");
    const postgresCheck = body.checks.find((check) => check.name === "postgres");
    expect(postgresCheck?.ok).toBe(true);
  });

  it("GET /readyz while draining short-circuits to the draining response before any check runs", async () => {
    let checkedAnything = false;
    await start({
      queryPostgres: () => {
        checkedAnything = true;
        return Promise.resolve({ rows: [] });
      },
      redisConnection: {
        info: () => {
          checkedAnything = true;
          return Promise.resolve("redis_version:7.0.0");
        },
      },
      checkMigrationsCurrent: () => {
        checkedAnything = true;
        return Promise.resolve();
      },
    });
    markWorkerDraining();

    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { ready: boolean; checks: unknown[] };
    expect(body.ready).toBe(false);
    expect(body.checks).toEqual([]);
    expect(checkedAnything).toBe(false);
  });

  it("an unknown path returns the same status it returns today (404)", async () => {
    await start();
    const response = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/unknown-path`);
    expect(response.status).toBe(404);
  });

  it("every response carries Connection: close and the JSON content type", async () => {
    await start();

    const healthzResponse = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/healthz`);
    expect(healthzResponse.headers.get("connection")).toBe("close");
    expect(healthzResponse.headers.get("content-type")).toMatch(/application\/json/);

    const readyzResponse = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/readyz`);
    expect(readyzResponse.headers.get("connection")).toBe("close");
    expect(readyzResponse.headers.get("content-type")).toMatch(/application\/json/);

    const unknownResponse = await fetch(`http://${WORKER_HEALTH_HOST}:${String(PORT)}/unknown-path`);
    expect(unknownResponse.headers.get("connection")).toBe("close");
  });
});
