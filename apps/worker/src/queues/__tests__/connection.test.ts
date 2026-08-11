import { describe, expect, it } from "vitest";
import { buildRedisConnectionOptions } from "../connection.js";

describe("buildRedisConnectionOptions", () => {
  it("builds connection options from a REDIS_URL with maxRetriesPerRequest null (required by BullMQ)", () => {
    const options = buildRedisConnectionOptions("redis://localhost:6379");

    expect(options.host).toBe("localhost");
    expect(options.port).toBe(6379);
    expect(options.maxRetriesPerRequest).toBeNull();
  });

  it("parses a logical DB index from the URL path (test-Redis convention)", () => {
    const options = buildRedisConnectionOptions("redis://localhost:6379/1");

    expect(options.db).toBe(1);
  });

  it("parses credentials from the URL when present", () => {
    const options = buildRedisConnectionOptions("redis://user:pass@example.com:6380/2");

    expect(options.host).toBe("example.com");
    expect(options.port).toBe(6380);
    expect(options.username).toBe("user");
    expect(options.password).toBe("pass");
    expect(options.db).toBe(2);
  });
});
