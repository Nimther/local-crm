import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { buildServer } from "../../../server.js";

/**
 * Phase 14 plan 01, Task 3 (OPS-04) -- `/healthz` proven independent of both
 * backing services: it must answer 200 while Postgres is unreachable, and
 * 200 while Redis is unreachable, because a liveness probe that fails during
 * a backing-service outage gets the container killed for an outage it did
 * not cause (T-14-06).
 *
 * Each scenario points the relevant URL at a closed port (rather than
 * stopping a shared service) so this suite never disturbs sibling suites.
 * `process.env.*_URL` is overridden BEFORE the first import of
 * `../../../server.js` in that scenario's own `beforeAll` -- every
 * db/redis-consuming module in this codebase constructs its client at
 * MODULE IMPORT TIME, and each vitest test FILE gets its own fresh module
 * registry (the same "lazy is load-bearing" pattern this plan's
 * readyz.test.ts already uses).
 */

// A port nothing listens on in this sandbox -- a real, immediate connection
// refusal rather than a slow timeout.
const CLOSED_PORT = 1;

describe("GET /healthz: independent of Postgres", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    process.env.DATABASE_URL = `postgresql://mega_crm_app:mega_crm_dev_pw@localhost:${String(CLOSED_PORT)}/mega_crm_unreachable`;

    const serverModule = await import("../../../server.js");
    app = await serverModule.buildServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns 200 with DATABASE_URL pointed at a closed port", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
  });
});

describe("GET /healthz: independent of Redis", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    process.env.REDIS_URL = `redis://localhost:${String(CLOSED_PORT)}`;

    const serverModule = await import("../../../server.js");
    app = await serverModule.buildServer();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns 200 with REDIS_URL pointed at a closed port", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
  });
});
