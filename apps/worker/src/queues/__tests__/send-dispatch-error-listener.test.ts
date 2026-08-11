import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 12-REVIEW.md IN-02: `getDefaultRedisClient` (the lazily-created singleton
 * ioredis client backing send-dispatch.ts's rate limiter / tenant lane
 * semaphore) had its `'error'` listener fixed under WR-01, but -- unlike
 * `packages/queue-core/src/connection.ts`'s `createRedisConnection`, which
 * got `connection-error-listener.test.ts` -- no regression test proved the
 * wiring directly. `send-dispatch-idempotency.test.ts` and
 * `send-dispatch-durability.test.ts` both inject their own `deps.redisClient`,
 * bypassing `getDefaultRedisClient()` entirely, so nothing exercised the
 * no-`deps` production path.
 *
 * This suite mirrors `connection-error-listener.test.ts`'s emit-based proof
 * pattern exactly: `scrubbedConsole` is mocked (redaction itself is already
 * covered by `packages/redaction`'s own tests), no live Redis socket is
 * required, and `__resetDefaultRedisClientForTests` (added alongside this
 * test) clears the module-level singleton between cases so each test
 * observes a freshly-constructed client with its own listener.
 */

const { scrubbedConsole } = vi.hoisted(() => ({
  scrubbedConsole: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

vi.mock("@mega-crm/redaction", () => ({ scrubbedConsole }));

const { getDefaultRedisClient, __resetDefaultRedisClientForTests } = await import("../send-dispatch.js");

describe("send-dispatch.ts getDefaultRedisClient error listener (12-REVIEW.md IN-02)", () => {
  afterEach(() => {
    // Disconnect whatever singleton the test constructed before clearing the
    // module-level reference, so no dangling socket outlives the test.
    const client = getDefaultRedisClient();
    client.disconnect();
    __resetDefaultRedisClientForTests();
  });

  it("registers exactly one 'error' listener on the singleton client", () => {
    const client = getDefaultRedisClient();
    expect(client.listenerCount("error")).toBe(1);
  });

  it("returns the same singleton instance across calls until reset", () => {
    const first = getDefaultRedisClient();
    const second = getDefaultRedisClient();
    expect(second).toBe(first);
  });

  it("routes an emitted connection error through scrubbedConsole.error, not ioredis's raw console fallback", () => {
    scrubbedConsole.error.mockClear();
    const client = getDefaultRedisClient();
    const err = new Error("ECONNREFUSED (simulated)");
    client.emit("error", err);

    expect(scrubbedConsole.error).toHaveBeenCalledWith(
      "send-dispatch: default rate-limiter/semaphore Redis client error",
      err
    );
  });
});
