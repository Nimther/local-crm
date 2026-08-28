import { describe, expect, it, vi } from "vitest";

import { assertTestRedisUrl, createTestRedisPreparer } from "../redis-guard.js";

describe("test Redis isolation guard", () => {
  it.each([
    undefined,
    "",
    "redis://localhost:6379",
    "redis://localhost:6379/",
    "redis://localhost:6379/0",
    "redis://localhost:6379/?db=1",
  ])("refuses an unset, implicit, or DB-0 Redis URL before cleanup: %s", (redisUrl) => {
    expect(() => assertTestRedisUrl(redisUrl)).toThrow(/FATAL:.*explicit.*logical DB.*>= 1/i);
  });

  it.each(["redis://localhost:6379/1", "rediss://cache.example.test:6380/15"])(
    "accepts an explicit non-zero logical DB: %s",
    (redisUrl) => {
      expect(assertTestRedisUrl(redisUrl)).toBe(redisUrl);
    },
  );

  it("clears one validated test DB exactly once across every project setup in the run", async () => {
    const clearDatabase = vi.fn(() => Promise.resolve());
    const prepare = createTestRedisPreparer(clearDatabase);
    const redisUrl = "redis://localhost:6379/1";

    await Promise.all([prepare(redisUrl), prepare(redisUrl), prepare(redisUrl)]);

    expect(clearDatabase).toHaveBeenCalledTimes(1);
    expect(clearDatabase).toHaveBeenCalledWith(redisUrl);
  });

  it("validates before constructing or calling the destructive cleanup seam", async () => {
    const clearDatabase = vi.fn(() => Promise.resolve());
    const prepare = createTestRedisPreparer(clearDatabase);

    await expect(prepare("redis://localhost:6379/0")).rejects.toThrow(/FATAL/i);
    expect(clearDatabase).not.toHaveBeenCalled();
  });

  it("fails closed if projects in one aggregate run resolve different Redis databases", async () => {
    const clearDatabase = vi.fn(() => Promise.resolve());
    const prepare = createTestRedisPreparer(clearDatabase);

    await prepare("redis://localhost:6379/1");

    await expect(prepare("redis://localhost:6379/2")).rejects.toThrow(
      /different test Redis URL/i,
    );
    expect(clearDatabase).toHaveBeenCalledTimes(1);
  });
});
