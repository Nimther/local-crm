import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
