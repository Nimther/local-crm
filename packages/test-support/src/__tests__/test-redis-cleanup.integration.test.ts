import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";

import { startTempRedis, type TempRedis } from "../harness/temp-redis.js";
import { clearTestRedisDatabase } from "../redis-guard.js";

describe("test Redis cleanup against an isolated server", () => {
  let server: TempRedis | undefined;

  beforeAll(async () => {
    server = await startTempRedis();
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("flushes only the guarded non-zero DB and leaves DB 0 untouched", async () => {
    if (!server) throw new Error("temporary Redis did not start");
    const devClient = new Redis(`${server.url}/0`);
    const testClient = new Redis(`${server.url}/1`);
    devClient.on("error", () => undefined);
    testClient.on("error", () => undefined);

    try {
      await devClient.set("dev-sentinel", "preserve");
      await testClient.set("test-sentinel", "remove");

      await clearTestRedisDatabase(`${server.url}/1`);

      expect(await testClient.exists("test-sentinel")).toBe(0);
      expect(await devClient.get("dev-sentinel")).toBe("preserve");
    } finally {
      devClient.disconnect();
      testClient.disconnect();
    }
  });
});
