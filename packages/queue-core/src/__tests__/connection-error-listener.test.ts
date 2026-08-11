import { describe, expect, it, vi } from "vitest";

/**
 * 12-REVIEW.md WR-01: `createRedisConnection` (the shared ioredis client
 * backing every BullMQ Queue/Worker) previously registered no `'error'`
 * listener at all -- unlike every other long-lived connection in this
 * codebase (`pg.Pool`'s `.on("error", ...)` in `partition-maintenance.worker.ts`/
 * `dead-letter-writer.ts`, `apps/api/src/server.ts`'s `rateLimitRedis.on("error", ...)`),
 * so a connection error bypassed `scrubbedConsole`'s redaction and was
 * invisible to every other logging/alerting path -- ioredis's own internal
 * fallback logs it unredacted via raw `console.error` instead.
 *
 * `scrubbedConsole` is mocked (not asserted against real redaction logic,
 * already covered by `packages/redaction`'s own tests) so this suite proves
 * only the WIRING: exactly one `'error'` listener is registered, and an
 * emitted error reaches `scrubbedConsole.error` with an identifying message.
 * No live Redis is used -- `.emit("error", ...)` is invoked directly on the
 * real `ioredis` instance, matching the emit-based proof pattern already
 * used by `error-listeners.test.ts` and `shared-error-listener.test.ts` for
 * `worker.on("error", ...)`.
 */

const { scrubbedConsole } = vi.hoisted(() => ({
  scrubbedConsole: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

vi.mock("@mega-crm/redaction", () => ({ scrubbedConsole }));

const { createRedisConnection } = await import("../connection.js");

describe("createRedisConnection error listener (12-REVIEW.md WR-01)", () => {
  it("registers exactly one 'error' listener on the returned client", () => {
    const client = createRedisConnection("redis://127.0.0.1:65535/0");
    try {
      expect(client.listenerCount("error")).toBe(1);
    } finally {
      client.disconnect();
    }
  });

  it("routes an emitted connection error through scrubbedConsole.error, not ioredis's raw console fallback", () => {
    scrubbedConsole.error.mockClear();
    const client = createRedisConnection("redis://127.0.0.1:65535/0");
    try {
      const err = new Error("ECONNREFUSED (simulated)");
      client.emit("error", err);

      expect(scrubbedConsole.error).toHaveBeenCalledWith("queue-core: shared ioredis connection error", err);
    } finally {
      client.disconnect();
    }
  });
});
