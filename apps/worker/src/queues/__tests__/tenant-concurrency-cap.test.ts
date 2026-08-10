import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import { consumeTenantToken, DEFAULT_TENANT_RPS } from "../rate-limiter.js";
import * as semaphore from "../tenant-lane-semaphore.js";
import type { TenantLane } from "../tenant-lane-semaphore.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  createFixtureContact,
  fakeSendMail,
  freshWorkspaceId,
  sendsStatusFor,
  throwingSendMail,
} from "../../test/failure-fixtures.js";

/**
 * WRK-02 (D-01/D-02, plan 12-04): proves the tenant-lane-semaphore wired
 * into all three `send-dispatch.ts` dispatch paths (12-04 Task 1) --
 * concurrency is driven DETERMINISTICALLY by pre-acquiring the lane's slots
 * directly through the semaphore module before invoking `processSendJob`,
 * never by racing real parallel sends against timing. A single small cap,
 * set via the SAME environment override `resolveTenantLaneCap` reads in
 * production, keeps every fixture in this file fast without needing the
 * production defaults (3/12).
 */
describe("send-dispatch.ts tenant-lane concurrency cap (WRK-02, plan 12-04)", () => {
  let pool: Pool;
  let redisClient: Redis;
  const TEST_CAP = 1;
  const keysToClean: string[] = [];
  const ORIGINAL_BROADCAST_CAP = process.env.TENANT_LANE_CONCURRENCY_BROADCAST;
  const ORIGINAL_TRIGGERED_CAP = process.env.TENANT_LANE_CONCURRENCY_TRIGGERED;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
    // Same env override `resolveTenantLaneCap` (tenant-lane-semaphore.ts)
    // reads in production -- a cap of 1 keeps every fixture below fast
    // without needing the production defaults (broadcast:3/triggered:12).
    process.env.TENANT_LANE_CONCURRENCY_BROADCAST = String(TEST_CAP);
    process.env.TENANT_LANE_CONCURRENCY_TRIGGERED = String(TEST_CAP);
  });

  afterAll(async () => {
    if (ORIGINAL_BROADCAST_CAP === undefined) {
      delete process.env.TENANT_LANE_CONCURRENCY_BROADCAST;
    } else {
      process.env.TENANT_LANE_CONCURRENCY_BROADCAST = ORIGINAL_BROADCAST_CAP;
    }
    if (ORIGINAL_TRIGGERED_CAP === undefined) {
      delete process.env.TENANT_LANE_CONCURRENCY_TRIGGERED;
    } else {
      process.env.TENANT_LANE_CONCURRENCY_TRIGGERED = ORIGINAL_TRIGGERED_CAP;
    }
    await pool.end();
    await redisClient.quit();
  });

  afterEach(async () => {
    if (keysToClean.length > 0) {
      await redisClient.del(...keysToClean);
      keysToClean.length = 0;
    }
  });

  /** Mirrors tenant-lane-semaphore.test.ts's own key-cleanup convention. */
  function trackKey(workspaceId: string, lane: TenantLane): void {
    keysToClean.push(`tenant-lane-sem:${workspaceId}:${lane}`);
  }

  /** Pre-fills `workspaceId`'s `lane` to `TEST_CAP` directly through the semaphore module -- deterministic saturation, no real parallel send needed. */
  async function fillLane(workspaceId: string, lane: TenantLane, cap = TEST_CAP): Promise<void> {
    trackKey(workspaceId, lane);
    for (let i = 0; i < cap; i += 1) {
      const result = await semaphore.acquireTenantLaneSlot(redisClient, workspaceId, lane, { cap });
      if (!result.acquired) {
        throw new Error("test setup failure: could not pre-fill the lane to its cap");
      }
    }
  }

  async function flowSendRowFor(
    workspaceId: string,
    flowRunId: string,
    nodeId: string
  ): Promise<{ id: string; status: string } | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM sends
           WHERE workspace_id = $1 AND flow_run_id = $2 AND node_id = $3 AND kind = 'flow'`,
          [workspaceId, flowRunId, nodeId]
        );
        return rows[0];
      })
    );
  }

  describe("over-cap defers through the tenant_bucket path, never fails", () => {
    it("a campaign send whose workspace already holds every broadcast slot defers, and releases its dispatch claim", async () => {
      const workspaceId = await freshWorkspaceId(pool, "cap-campaign-over");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      await fillLane(workspaceId, "broadcast");

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: fakeSendMail(202), redisClient }
      );

      expect(result).toMatchObject({ outcome: "rate_limited", cause: "tenant_bucket" });
      if (result.outcome === "rate_limited") {
        expect(result.rateLimitMs).toBeGreaterThan(0);
      }
      expect(
        await sendsStatusFor(workspaceId, campaignId, contactId),
        "the claim must be released, not left stranded 'dispatching'"
      ).toBeUndefined();
    });

    it("a flow send whose workspace already holds every triggered slot defers, and releases its dispatch claim", async () => {
      const workspaceId = await freshWorkspaceId(pool, "cap-flow-over");
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);
      await fillLane(workspaceId, "triggered");

      const result = await processSendJob(
        { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
        { sendMail: fakeSendMail(202), redisClient }
      );

      expect(result).toMatchObject({ outcome: "rate_limited", cause: "tenant_bucket" });
      if (result.outcome === "rate_limited") {
        expect(result.rateLimitMs).toBeGreaterThan(0);
      }
      const row = await flowSendRowFor(workspaceId, flowRunId, nodeId);
      expect(row, "the claim must be released, not left stranded 'dispatching'").toBeUndefined();
    });

    it("a test send whose workspace already holds every broadcast slot defers (there is no dispatch claim to release)", async () => {
      const workspaceId = await freshWorkspaceId(pool, "cap-test-over");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      await fillLane(workspaceId, "broadcast");

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
        { sendMail: fakeSendMail(202), redisClient }
      );

      expect(result).toMatchObject({ outcome: "rate_limited", cause: "tenant_bucket" });
      if (result.outcome === "rate_limited") {
        expect(result.rateLimitMs).toBeGreaterThan(0);
      }
    });
  });

  describe("the acquired slot is released on every exit path (T-12-04-02)", () => {
    it("a successful send releases the slot after the terminal ledger write", async () => {
      const workspaceId = await freshWorkspaceId(pool, "cap-release-sent");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const releaseSpy = vi.spyOn(semaphore, "releaseTenantLaneSlot");

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: fakeSendMail(202), redisClient }
      );

      expect(result.outcome).toBe("sent");
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      releaseSpy.mockRestore();
    });

    it("a provider rejection (429/5xx) releases the slot before returning", async () => {
      const workspaceId = await freshWorkspaceId(pool, "cap-release-provider");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const releaseSpy = vi.spyOn(semaphore, "releaseTenantLaneSlot");

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: fakeSendMail(429, { "retry-after": "1" }), redisClient }
      );

      expect(result).toMatchObject({ outcome: "rate_limited", cause: "provider_backoff" });
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      releaseSpy.mockRestore();
    });

    it("a permanent 4xx failure releases the slot before returning", async () => {
      const workspaceId = await freshWorkspaceId(pool, "cap-release-4xx");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const releaseSpy = vi.spyOn(semaphore, "releaseTenantLaneSlot");

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: fakeSendMail(400), redisClient }
      );

      expect(result.outcome).toBe("failed");
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      releaseSpy.mockRestore();
    });

    it("a thrown sendMail releases the slot before the ambiguous-outcome result is returned", async () => {
      const workspaceId = await freshWorkspaceId(pool, "cap-release-throw");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const releaseSpy = vi.spyOn(semaphore, "releaseTenantLaneSlot");
      const throwing = throwingSendMail(new Error("boom"));

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: throwing.fn, redisClient }
      );

      expect(result.outcome).toBe("reconciling");
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      releaseSpy.mockRestore();
    });

    it("a send that acquires a slot and then fails the RPS check releases the slot before returning", async () => {
      const workspaceId = await freshWorkspaceId(pool, "cap-release-rps");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      // Exhaust the workspace's default 10rps bucket entirely -- the SAME
      // consumeTenantToken keyed by workspaceId that the dispatch path
      // itself consumes (rate-limiter.test.ts's own convention), so the
      // lane slot is acquired successfully but the RPS check right after
      // it denies the call.
      for (let i = 0; i < DEFAULT_TENANT_RPS; i += 1) {
        await consumeTenantToken(redisClient, workspaceId, DEFAULT_TENANT_RPS);
      }
      const releaseSpy = vi.spyOn(semaphore, "releaseTenantLaneSlot");

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: fakeSendMail(202), redisClient }
      );

      expect(result).toMatchObject({ outcome: "rate_limited", cause: "tenant_bucket" });
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      releaseSpy.mockRestore();
    });
  });

  it("holding the cap in a lane for workspace A does not delay workspace B's send in the same lane", async () => {
    const workspaceA = await freshWorkspaceId(pool, "cap-cross-tenant-a");
    await connectFixtureSendgridKey(workspaceA);
    const campaignA = await createFixtureCampaign(workspaceA);
    const contactA = await createFixtureContact(workspaceA);
    await fillLane(workspaceA, "broadcast");

    const workspaceB = await freshWorkspaceId(pool, "cap-cross-tenant-b");
    await connectFixtureSendgridKey(workspaceB);
    const campaignB = await createFixtureCampaign(workspaceB);
    const contactB = await createFixtureContact(workspaceB);

    const blockedResult = await processSendJob(
      { workspaceId: workspaceA, campaignId: campaignA, kind: "campaign", contactId: contactA },
      { sendMail: fakeSendMail(202), redisClient }
    );
    expect(blockedResult).toMatchObject({ outcome: "rate_limited", cause: "tenant_bucket" });

    const counting = fakeSendMail(202);
    let called = false;
    const wrappedSendMail: typeof counting = async (apiKey, payload) => {
      called = true;
      return counting(apiKey, payload);
    };

    const freeResult = await processSendJob(
      { workspaceId: workspaceB, campaignId: campaignB, kind: "campaign", contactId: contactB },
      { sendMail: wrappedSendMail, redisClient }
    );

    expect(freeResult.outcome, "workspace B's send must reach SendGrid while workspace A's lane is full").toBe("sent");
    expect(called, "workspace B's fake sendMail must have been invoked").toBe(true);
  });
});
