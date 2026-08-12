import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createEphemeralDatabase, dropEphemeralDatabase } from "@mega-crm/test-support";
import type { ReadinessResult } from "../health.js";
import type { buildServer } from "../../../server.js";

/**
 * Phase 14 plan 01, Task 1 -- the tracer end-to-end test (DB-05/DB-06,
 * OPS-04/OPS-05, D-13): an un-migrated database refuses readiness by name,
 * the dedicated-connection locked runner applies the full migration history,
 * and the SAME endpoint then reports ready.
 *
 * Reuses `createEphemeralDatabase`/`dropEphemeralDatabase` directly (the
 * fixture `migrate-from-empty.test.ts` already uses), NOT
 * `ensureTestDbMigrated()`/`getTestDatabaseUrl()` -- this suite's whole
 * point is a database with ZERO migrations applied, and the shared apps/api
 * project database has (or will have, by the time some other test file's
 * `beforeAll` runs) the full chain already applied.
 *
 * `process.env.DATABASE_URL` is overridden BEFORE the first import of
 * `../../../server.js` below. `@mega-crm/db` and `@mega-crm/tenant-context`
 * both construct their pg `Pool` from `process.env.DATABASE_URL` at MODULE
 * IMPORT TIME, and every vitest test FILE gets its own fresh module
 * registry, so this is safe for exactly the reason
 * `packages/test-support/src/db-fixture.ts`'s own "Lazy is load-bearing"
 * comment documents for `TEST_DATABASE_URL`.
 *
 * The migrate runner itself is exercised as a REAL child process
 * (`node scripts/migrate-runner.mjs`), not an in-process import -- the exit
 * code is part of the contract (the deploy script's ordering guarantee
 * depends on it being truthful), and a plain `.ts` test file has no type
 * declarations for a `.mjs` script to import cleanly.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const MIGRATE_RUNNER_PATH = path.join(REPO_ROOT, "scripts/migrate-runner.mjs");

function runMigrateRunner(databaseUrl: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MIGRATE_RUNNER_PATH], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
}

describe("GET /readyz: an un-migrated database refuses readiness, the runner makes it ready", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let databaseName: string;
  let adminDsn: string;
  let ephemeralDsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "readyz-e2e" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    ephemeralDsn = created.dsn;

    // MUST happen before any db-consuming module is imported in this worker.
    process.env.DATABASE_URL = ephemeralDsn;

    const serverModule = await import("../../../server.js");
    app = await serverModule.buildServer();
  });

  afterAll(async () => {
    await app?.close();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  it("responds 503 naming the migration check before migrations are applied, then 200 after the runner applies them", async () => {
    const before = await app.inject({ method: "GET", url: "/readyz" });
    expect(before.statusCode).toBe(503);
    const beforeBody = before.json<ReadinessResult>();
    expect(beforeBody.ready).toBe(false);
    const beforeMigrationsCheck = beforeBody.checks.find((check) => check.name === "migrations");
    expect(beforeMigrationsCheck?.ok).toBe(false);
    expect(beforeMigrationsCheck?.detail).toBeTruthy();

    const { code } = await runMigrateRunner(ephemeralDsn);
    expect(code).toBe(0);

    const after = await app.inject({ method: "GET", url: "/readyz" });
    expect(after.statusCode).toBe(200);
    const afterBody = after.json<ReadinessResult>();
    expect(afterBody.ready).toBe(true);
    expect(afterBody.checks.every((check) => check.ok)).toBe(true);
  });
});

/**
 * Phase 14 plan 01, Task 3 (OPS-05/DB-06) -- the remaining blocks below each
 * need a DIFFERENT `DATABASE_URL`/`REDIS_URL` in force at `server.js`'s
 * (and its transitive `@mega-crm/tenant-context` pool's) IMPORT time. A
 * single test file only gets ONE fresh module registry from vitest, so
 * every block below calls `vi.resetModules()` in its own `beforeAll` BEFORE
 * overriding env vars and re-importing `server.js` -- this is the same
 * pattern `packages/test-support/src/__tests__/db-fixture-advisory-unlock.test.ts`
 * already uses for exactly this reason.
 */

// A port nothing listens on in this sandbox -- immediate connection refusal.
const CLOSED_PORT = 1;

/** A real, unauthenticated, already-registered route -- used to prove the guard fires (or doesn't) without needing any session/auth setup. */
const NON_HEALTH_ROUTE = "/api/workspaces/definitely-not-a-real-slug-14-01/send-settings";

async function provisionMigratedDatabase(workspace: string): Promise<{
  databaseName: string;
  adminDsn: string;
  dsn: string;
}> {
  const created = await createEphemeralDatabase({ workspace });
  const { code } = await runMigrateRunner(created.dsn);
  if (code !== 0) {
    throw new Error(`fixture setup: migrate-runner failed to migrate ${workspace}'s database`);
  }
  return created;
}

describe("GET /readyz: per-check 503 responses name the failing check", () => {
  describe("Postgres unreachable", () => {
    let app: Awaited<ReturnType<typeof buildServer>>;

    beforeAll(async () => {
      vi.resetModules();
      process.env.DATABASE_URL = `postgresql://mega_crm_app:mega_crm_dev_pw@localhost:${String(CLOSED_PORT)}/mega_crm_unreachable`;
      const serverModule = await import("../../../server.js");
      app = await serverModule.buildServer();
    });

    afterAll(async () => {
      await app?.close();
    });

    it("responds 503 naming the postgres check", async () => {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<ReadinessResult>();
      expect(body.ready).toBe(false);
      const postgresCheck = body.checks.find((check) => check.name === "postgres");
      expect(postgresCheck?.ok).toBe(false);
    });
  });

  describe("Redis unreachable (Postgres and migrations fine)", () => {
    let app: Awaited<ReturnType<typeof buildServer>>;
    let databaseName: string;
    let adminDsn: string;

    beforeAll(async () => {
      const migrated = await provisionMigratedDatabase("readyz-redis-down");
      databaseName = migrated.databaseName;
      adminDsn = migrated.adminDsn;

      vi.resetModules();
      process.env.DATABASE_URL = migrated.dsn;
      process.env.REDIS_URL = `redis://localhost:${String(CLOSED_PORT)}`;
      const serverModule = await import("../../../server.js");
      app = await serverModule.buildServer();
    });

    afterAll(async () => {
      await app?.close();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("responds 503 naming the redis check, with postgres and migrations both ok", async () => {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<ReadinessResult>();
      expect(body.ready).toBe(false);
      const redisCheck = body.checks.find((check) => check.name === "redis");
      expect(redisCheck?.ok).toBe(false);
      const postgresCheck = body.checks.find((check) => check.name === "postgres");
      expect(postgresCheck?.ok).toBe(true);
      const migrationsCheck = body.checks.find((check) => check.name === "migrations");
      expect(migrationsCheck?.ok).toBe(true);
    });
  });
});

describe("onRequest guard (DB-06): refuses non-health traffic until migrations are current", () => {
  describe("a database with pending migrations", () => {
    let app: Awaited<ReturnType<typeof buildServer>>;
    let databaseName: string;
    let adminDsn: string;

    beforeAll(async () => {
      const created = await createEphemeralDatabase({ workspace: "readyz-guard-pending" });
      databaseName = created.databaseName;
      adminDsn = created.adminDsn;

      vi.resetModules();
      process.env.DATABASE_URL = created.dsn;
      const serverModule = await import("../../../server.js");
      app = await serverModule.buildServer();
    });

    afterAll(async () => {
      await app?.close();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    it("refuses a non-health route with 503 naming migrations_pending, without reaching its handler", async () => {
      const response = await app.inject({ method: "GET", url: NON_HEALTH_ROUTE });
      expect(response.statusCode).toBe(503);
      const body = response.json<{ error: string }>();
      // The route's own handler would answer 404 "Workspace not found" for
      // this nonexistent slug (proven by the "fully migrated" block below) --
      // getting the guard's distinct body shape instead proves the handler
      // was never reached.
      expect(body.error).toBe("migrations_pending");
    });

    it("still answers /readyz -- the guard never blocks the health routes themselves", async () => {
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(503);
      const body = response.json<ReadinessResult>();
      const migrationsCheck = body.checks.find((check) => check.name === "migrations");
      expect(migrationsCheck?.ok).toBe(false);
      expect(migrationsCheck?.detail).toBeTruthy();
    });
  });

  describe("a fully migrated database", () => {
    let app: Awaited<ReturnType<typeof buildServer>>;
    let databaseName: string;
    let adminDsn: string;

    beforeAll(async () => {
      const migrated = await provisionMigratedDatabase("readyz-guard-migrated");
      databaseName = migrated.databaseName;
      adminDsn = migrated.adminDsn;

      vi.resetModules();
      process.env.DATABASE_URL = migrated.dsn;
      const serverModule = await import("../../../server.js");
      app = await serverModule.buildServer();
    });

    afterAll(async () => {
      await app?.close();
      if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // MUST run before any other test in this block issues a non-health
    // request against `app`: the guard's confirmed-once latch (a
    // module-level flag in health.ts) would otherwise already be set by an
    // earlier request, making every subsequent request's query count zero
    // rather than the "exactly one" this test exists to prove. vitest runs
    // `it`s within a `describe` in declaration order, so this being first
    // is what makes it the app's first-ever non-health request.
    it("performs exactly one migration query across two consecutive non-health requests", async () => {
      const dbModule = await import("../../../db.js");
      const querySpy = vi.spyOn(dbModule.pool, "query");

      await app.inject({ method: "GET", url: NON_HEALTH_ROUTE });
      await app.inject({ method: "GET", url: NON_HEALTH_ROUTE });

      const migrationQueryCalls = querySpy.mock.calls.filter((call) =>
        String(call[0]).includes("__drizzle_migrations"),
      );
      expect(migrationQueryCalls).toHaveLength(1);
    });

    it("is invisible in the healthy case -- the non-health route returns its own normal response", async () => {
      const response = await app.inject({ method: "GET", url: NON_HEALTH_ROUTE });
      // The guard did not intercept; the route's own handler ran and
      // reported the (nonexistent) workspace not found -- a DIFFERENT body
      // shape than the guard's `migrations_pending` signature above.
      expect(response.statusCode).toBe(404);
      const body = response.json<{ error: string }>();
      expect(body.error).toBe("Workspace not found");
    });
  });
});
