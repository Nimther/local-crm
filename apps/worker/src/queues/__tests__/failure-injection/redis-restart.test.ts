import path from "node:path";
import { fileURLToPath } from "node:url";

import { Queue, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";

import { buildRedisConnectionOptions } from "@mega-crm/queue-core";

/**
 * 08-13 (QG-06 scenario 5, WRK-12) — jobs survive a Redis restart.
 *
 * Reproduce with `npm run failure:redis-restart` from the repo root.
 *
 * This is the scenario that turns 08-04's configuration claim into a
 * behavioural one. `docker/redis.conf` sets `appendonly yes` with
 * `appendfsync everysec`; without AOF, whether an enqueued job survived a
 * restart would depend on RDB snapshot timing, which is to say on luck. The
 * server here is booted from that exact file, so what is asserted below is the
 * durability guarantee itself and not an accident of when a snapshot happened
 * to land.
 *
 * The restart is a real process restart: SIGTERM, wait for exit, start again on
 * the same port from the same data directory. SIGTERM rather than SIGKILL
 * because Redis performs a final fsync on a clean shutdown — which is exactly
 * what `docker restart` does to a container, and the reason job survival is a
 * guarantee rather than a hope.
 *
 * Both assertions are needed. The surviving-count check alone would pass if the
 * jobs were present but unprocessable; the processed-count check alone would
 * pass if something had re-enqueued them. Together they are what SPEC R6
 * scenario 5 and SPEC R7's separate survival criterion actually ask for.
 *
 * Deliberately NOT extended into a memory-pressure or eviction simulation —
 * BullMQ's behaviour at its ceiling is Phase 12 (RESEARCH Pitfall 6).
 */

const REDIS_CONF = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../../docker/redis.conf",
);

const ENQUEUED_JOB_COUNT = 5;

describe("failure injection: Redis restart under a live queue (QG-06 / WRK-12)", () => {
  let redis: TempRedis;
  /** Run-unique: never a production queue name, which other files share. */
  let queueName: string;

  beforeAll(async () => {
    redis = await startTempRedis({ configFile: REDIS_CONF });
    queueName = `failure-redis-restart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterAll(async () => {
    await redis?.stop();
  });

  it("keeps jobs enqueued before the restart, and processes them after it", async () => {
    const connection = () => buildRedisConnectionOptions(redis.url);

    // --- enqueue ------------------------------------------------------------
    const producer = new Queue(queueName, { connection: connection() });
    for (let i = 0; i < ENQUEUED_JOB_COUNT; i += 1) {
      await producer.add("survive", { index: i });
    }

    const before = await producer.getWaitingCount();
    expect(before, "the jobs must actually be waiting before the restart is meaningful").toBe(
      ENQUEUED_JOB_COUNT,
    );

    // Close before restarting: a client held across the restart errors on its
    // own, and that error must not be mistaken for job loss.
    await producer.close();

    // --- the restart --------------------------------------------------------
    await redis.restart();

    // --- the jobs are still there -------------------------------------------
    const afterRestart = new Queue(queueName, { connection: connection() });
    const after = await afterRestart.getWaitingCount();
    expect(after, "every job enqueued before the restart must still be waiting after it").toBe(
      before,
    );

    // --- and they still get processed ---------------------------------------
    let processed = 0;
    const allDone = new Promise<void>((resolve) => {
      const worker = new Worker(
        queueName,
        () => {
          processed += 1;
          if (processed === ENQUEUED_JOB_COUNT) {
            void worker.close().then(resolve);
          }
          return Promise.resolve();
        },
        { connection: connection() },
      );
    });

    await allDone;

    expect(processed, "surviving the restart is only half of it — they must still run").toBe(
      ENQUEUED_JOB_COUNT,
    );

    await afterRestart.obliterate({ force: true });
    await afterRestart.close();
  });

  /**
   * The discrimination proof, kept as a test rather than a one-time observation.
   *
   * A survival assertion that has only ever been seen to pass is
   * indistinguishable from one that asserts nothing. This runs the identical
   * sequence against a STOCK server — no `docker/redis.conf`, therefore no AOF —
   * and asserts the jobs are GONE. That is what makes the assertion above a
   * statement about the durability configuration rather than about Redis
   * happening to still be warm.
   *
   * If this test ever starts passing with a non-zero count, the sibling above
   * has stopped proving anything and both need looking at.
   */
  it("loses the same jobs without the versioned config — which is why the assertion above means something", async () => {
    const stock = await startTempRedis({});
    try {
      const name = `failure-redis-restart-noaof-${Math.random().toString(36).slice(2, 8)}`;
      const producer = new Queue(name, { connection: buildRedisConnectionOptions(stock.url) });
      for (let i = 0; i < ENQUEUED_JOB_COUNT; i += 1) {
        await producer.add("vanish", { index: i });
      }
      expect(await producer.getWaitingCount()).toBe(ENQUEUED_JOB_COUNT);
      await producer.close();

      await stock.restart();

      const afterRestart = new Queue(name, { connection: buildRedisConnectionOptions(stock.url) });
      expect(
        await afterRestart.getWaitingCount(),
        "a stock server persists nothing here, so the restart must lose every job",
      ).toBe(0);
      await afterRestart.close();
    } finally {
      await stock.stop();
    }
  });
});
