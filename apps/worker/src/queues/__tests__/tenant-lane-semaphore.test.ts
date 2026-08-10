import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Redis } from "ioredis";
import {
  acquireTenantLaneSlot,
  releaseTenantLaneSlot,
  resolveTenantLaneCap,
  TENANT_LANE_CONCURRENCY_DEFAULTS,
  SEND_SLOT_LEASE_TTL_MS,
  SEND_SLOT_LEASE_MARGIN_MS,
  type AcquireSlotResult,
  type TenantLane,
} from "../tenant-lane-semaphore.js";
import { SEND_LOCK_DURATION_MS } from "../queue-options.js";

/**
 * WRK-02 (D-01/D-02/D-03): the per-tenant-per-lane concurrency semaphore.
 * A correct RPS token bucket (rate-limiter.ts) still lets one tenant's
 * large backlog occupy worker slots ahead of another tenant's small batch
 * -- this suite proves the primitive that closes that gap, in isolation.
 * Runs against a real (test) Redis instance, mirroring rate-limiter.test.ts
 * -- the sorted-set semaphore's atomicity guarantees are exercised through
 * a real Lua script evaluation, not a mock.
 */
describe("tenant-lane-semaphore.ts (WRK-02)", () => {
  const redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
  const keysToClean: string[] = [];

  /** Mirrors the module's own key shape (`tenant-lane-sem:{workspaceId}:{lane}`, PLAN.md) so this suite can clean up after itself without importing an internal helper. */
  function trackKey(workspaceId: string, lane: TenantLane): void {
    keysToClean.push(`tenant-lane-sem:${workspaceId}:${lane}`);
  }

  afterEach(async () => {
    if (keysToClean.length > 0) {
      await redisClient.del(...keysToClean);
      keysToClean.length = 0;
    }
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  it("acquiring with a cap of N succeeds N times for one workspace and lane; the N+1th acquire in the same window is rejected", async () => {
    const workspaceId = randomUUID();
    const lane: TenantLane = "broadcast";
    trackKey(workspaceId, lane);
    const cap = 3;

    const results: AcquireSlotResult[] = [];
    for (let i = 0; i < cap; i += 1) {
      results.push(await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap }));
    }
    const overCap = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });

    expect(results.every((result) => result.acquired), "all N acquires within the cap must succeed").toBe(true);
    expect(overCap.acquired, "the N+1th acquire in the same window must be rejected").toBe(false);
  });

  it("releasing one held slot lets exactly one further acquire succeed for that tenant and lane, then rejects again", async () => {
    const workspaceId = randomUUID();
    const lane: TenantLane = "broadcast";
    trackKey(workspaceId, lane);
    const cap = 2;

    const first = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });
    await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });
    const overCap = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });
    expect(overCap.acquired, "cap is fully held before any release").toBe(false);

    await releaseTenantLaneSlot(redisClient, workspaceId, lane, first.token);

    const afterRelease = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });
    const afterReleaseSecond = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });

    expect(afterRelease.acquired, "exactly one further acquire succeeds after the release").toBe(true);
    expect(afterReleaseSecond.acquired, "the cap is exhausted again once the freed slot is consumed").toBe(false);
  });

  it("a holder whose lease has expired stops counting toward the cap, so a crashed worker cannot leak a slot permanently", async () => {
    const workspaceId = randomUUID();
    const lane: TenantLane = "broadcast";
    trackKey(workspaceId, lane);
    const cap = 1;
    // A deliberately short lease, passed through the options argument --
    // the production TTL is tens of seconds and a test must not sleep that
    // long to prove expiry.
    const leaseTtlMs = 50;

    const first = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap, leaseTtlMs });
    expect(first.acquired).toBe(true);

    await new Promise((resolve) => {
      setTimeout(resolve, leaseTtlMs + 100);
    });

    // No release happened -- a later acquire succeeds anyway because the
    // held lease elapsed and the holder no longer counts toward the cap.
    const afterExpiry = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap, leaseTtlMs });
    expect(afterExpiry.acquired, "the expired holder's slot must be reclaimed without any release").toBe(true);
  });

  it("holding the cap in the broadcast lane leaves the same workspace's triggered lane fully available (D-02 within-tenant isolation)", async () => {
    const workspaceId = randomUUID();
    trackKey(workspaceId, "broadcast");
    trackKey(workspaceId, "triggered");
    const cap = 1;

    const broadcastHeld = await acquireTenantLaneSlot(redisClient, workspaceId, "broadcast", { cap });
    expect(broadcastHeld.acquired).toBe(true);
    const broadcastOverCap = await acquireTenantLaneSlot(redisClient, workspaceId, "broadcast", { cap });
    expect(broadcastOverCap.acquired, "the broadcast lane is fully held at its own cap").toBe(false);

    const triggeredStillAvailable = await acquireTenantLaneSlot(redisClient, workspaceId, "triggered", { cap });
    expect(
      triggeredStillAvailable.acquired,
      "D-02: a tenant's own broadcast holder must never consume the same tenant's triggered-lane slots"
    ).toBe(true);
  });

  it("holding the cap for workspace A leaves workspace B's same-lane slots fully available", async () => {
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    trackKey(workspaceA, "broadcast");
    trackKey(workspaceB, "broadcast");
    const cap = 1;

    const aHeld = await acquireTenantLaneSlot(redisClient, workspaceA, "broadcast", { cap });
    expect(aHeld.acquired).toBe(true);
    const aOverCap = await acquireTenantLaneSlot(redisClient, workspaceA, "broadcast", { cap });
    expect(aOverCap.acquired, "workspace A's own cap is exhausted").toBe(false);

    const bStillAvailable = await acquireTenantLaneSlot(redisClient, workspaceB, "broadcast", { cap });
    expect(bStillAvailable.acquired, "workspace B's independent cap is unaffected by A's exhaustion").toBe(true);
  });

  it("a rejected acquire returns a positive retry-after delay derived from the oldest live holder's remaining lease", async () => {
    const workspaceId = randomUUID();
    const lane: TenantLane = "broadcast";
    trackKey(workspaceId, lane);
    const cap = 1;
    const leaseTtlMs = 5_000;

    await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap, leaseTtlMs });
    const rejected = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap, leaseTtlMs });

    expect(rejected.acquired).toBe(false);
    expect(rejected.retryAfterMs, "retryAfterMs must be present and positive on rejection").toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(leaseTtlMs);
  });

  it("a successful acquire returns a token; passing it to release removes the holder, and releasing an unheld token is a no-op", async () => {
    const workspaceId = randomUUID();
    const lane: TenantLane = "broadcast";
    trackKey(workspaceId, lane);
    const cap = 1;

    const held = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });
    expect(held.acquired).toBe(true);
    expect(held.token).toBeTruthy();

    // An unheld/bogus token must be a no-op: it must not throw, and it must
    // not free the real holder's slot.
    await releaseTenantLaneSlot(redisClient, workspaceId, lane, randomUUID());

    const stillOverCap = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });
    expect(stillOverCap.acquired, "an unheld-token release must not have freed the real holder's slot").toBe(false);

    await releaseTenantLaneSlot(redisClient, workspaceId, lane, held.token);
    const afterRealRelease = await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });
    expect(afterRealRelease.acquired, "releasing the real token frees the slot").toBe(true);
  });

  it("issues exactly one Redis script evaluation per acquire call (a single atomic round trip)", async () => {
    const workspaceId = randomUUID();
    const lane: TenantLane = "broadcast";
    trackKey(workspaceId, lane);
    const evalSpy = vi.spyOn(redisClient, "eval");

    await acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap: 1 });

    expect(evalSpy).toHaveBeenCalledTimes(1);
    evalSpy.mockRestore();
  });

  it("SEND_SLOT_LEASE_TTL_MS stays below SEND_LOCK_DURATION_MS so a leaked slot expires before BullMQ would consider the job stalled", () => {
    expect(SEND_SLOT_LEASE_TTL_MS).toBeLessThan(SEND_LOCK_DURATION_MS);
    expect(SEND_SLOT_LEASE_MARGIN_MS).toBeGreaterThan(0);
  });

  describe("resolveTenantLaneCap", () => {
    const ENV_VAR = "TENANT_LANE_CONCURRENCY_BROADCAST";
    let originalValue: string | undefined;

    beforeEach(() => {
      originalValue = process.env[ENV_VAR];
    });

    afterEach(() => {
      if (originalValue === undefined) {
        delete process.env[ENV_VAR];
      } else {
        process.env[ENV_VAR] = originalValue;
      }
    });

    it.each([
      ["absent", undefined],
      ["empty", ""],
      ["non-numeric", "not-a-number"],
      ["fractional", "3.5"],
      ["zero", "0"],
      ["negative", "-1"],
    ])("falls back to the versioned default when the override is %s", (_label, value) => {
      if (value === undefined) {
        delete process.env[ENV_VAR];
      } else {
        process.env[ENV_VAR] = value;
      }
      expect(resolveTenantLaneCap("broadcast")).toBe(TENANT_LANE_CONCURRENCY_DEFAULTS.broadcast);
    });

    it("returns the parsed value for a positive integer override", () => {
      process.env[ENV_VAR] = "7";
      expect(resolveTenantLaneCap("broadcast")).toBe(7);
    });
  });

  it("when the injected Redis client's script evaluation rejects, acquireTenantLaneSlot rejects with that error", async () => {
    const redisError = new Error("redis connection lost mid-script");
    const stubClient = { eval: () => Promise.reject(redisError) } as unknown as Redis;

    // `.rejects` fails this assertion outright if the promise instead
    // RESOLVES to any value (including `{ acquired: false, ... }`) -- so
    // this single assertion covers both required properties: the error
    // propagates, AND the promise never resolves to either boolean value
    // of `acquired`.
    await expect(acquireTenantLaneSlot(stubClient, randomUUID(), "broadcast", { cap: 1 })).rejects.toBe(redisError);
  });
});
