import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { consumeTenantToken } from "../rate-limiter.js";

/**
 * SEND-02/SEND-03: the per-tenant token bucket (`rate-limiter-flexible`'s
 * `RateLimiterRedis`, keyed by `workspaceId`) must gate a send once a
 * tenant's configured RPS budget is exhausted -- this is the mechanism
 * `send-dispatch.ts` consumes before every SendGrid call, independent of
 * which queue (`email-broadcast`/`email-triggered`) the job came from.
 * Runs against a real (test) Redis instance -- `rate-limiter-flexible`'s
 * `RateLimiterRedis` executes Lua scripts against its `storeClient` and
 * cannot be exercised meaningfully against a mock.
 */
describe("rate-limiter.ts consumeTenantToken (SEND-02/SEND-03)", () => {
  const redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");

  afterAll(async () => {
    await redisClient.quit();
  });

  it("allows sends up to the configured RPS ceiling, then gates the next one", async () => {
    const workspaceId = randomUUID();
    const rps = 2;

    const first = await consumeTenantToken(redisClient, workspaceId, rps);
    const second = await consumeTenantToken(redisClient, workspaceId, rps);
    const third = await consumeTenantToken(redisClient, workspaceId, rps);

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed, "a 3rd send within the same second must be gated at rps=2").toBe(false);
    expect(third.msBeforeNext).toBeGreaterThan(0);
  });

  it("scopes the bucket per workspaceId -- one tenant's exhausted budget never blocks another tenant", async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const rps = 1;

    const aFirst = await consumeTenantToken(redisClient, workspaceA, rps);
    const aSecond = await consumeTenantToken(redisClient, workspaceA, rps);
    const bFirst = await consumeTenantToken(redisClient, workspaceB, rps);

    expect(aFirst.allowed).toBe(true);
    expect(aSecond.allowed, "workspace A is over its own budget").toBe(false);
    expect(bFirst.allowed, "workspace B's independent budget is unaffected by A's exhaustion").toBe(true);
  });
});
