import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { dispatchSendGate } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  fakeSendMail,
  freshWorkspaceId,
  sendsRowCountFor,
  sendsStatusFor,
} from "../../test/failure-fixtures.js";

/**
 * Durability regression tests pinning CR-03 (a rejected SendGrid 4xx
 * recorded as 'sent') and CR-04 (a worker crash between the 'dispatching'
 * claim commit and the terminal record causing a duplicate email on
 * redelivery) -- 04-VERIFICATION.md verification truth #4, SEND-06/SEND-07.
 *
 * 08-08: the fixture helpers this file used to define locally now live in
 * `../../test/failure-fixtures.ts`, because the three failure-injection
 * scenarios need the same ones and a third copy is how the two existing
 * copies started drifting. `arrangeInterruptedClaim` stays here -- it is
 * specific to this suite's CR-04 crash simulation.
 */
describe("send-dispatch.ts processSendJob durability (SEND-06/SEND-07, CR-03/CR-04)", () => {
  let pool: Pool;
  let redisClient: Redis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redisClient = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/1");
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  /**
   * Arranges a committed 'dispatching' claim WITHOUT ever calling SendGrid --
   * simulates a worker crash that happens strictly between the claim
   * transaction's COMMIT and the (never-reached) SendGrid call.
   */
  async function arrangeInterruptedClaim(workspaceId: string, campaignId: string, contactId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => dispatchSendGate(client, { workspaceId, campaignId, contactId }))
    );
  }

  it("CR-04: an interrupted redelivery (committed 'dispatching' claim, no terminal result) never re-calls SendGrid and records 'failed'", async () => {
    const workspaceId = await freshWorkspaceId(pool, "dispatch-interrupted");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await arrangeInterruptedClaim(workspaceId, campaignId, contactId);

    const counting = countingSendMail();
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(counting.callCount(), "an interrupted claim must never trigger a second SendGrid call").toBe(0);
    expect(result.outcome).toBe("failed");
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("failed");
    expect(await sendsRowCountFor(workspaceId, campaignId, contactId), "no duplicate sends row for the interrupted key").toBe(1);
  });

  it("CR-03: a SendGrid 400 rejection is recorded as status='failed', never 'sent'", async () => {
    const workspaceId = await freshWorkspaceId(pool, "dispatch-4xx");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const counting = countingSendMail(400);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("failed");
    expect(counting.callCount()).toBe(1);
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("failed");
  });

  it("SEND-07: a 429 releases the claim (no stranded 'dispatching' row) and a retry succeeds with exactly one sends row", async () => {
    const workspaceId = await freshWorkspaceId(pool, "dispatch-429-release");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const rateLimited = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: fakeSendMail(429, { "retry-after": "1" }), redisClient }
    );
    expect(rateLimited.outcome).toBe("rate_limited");
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "the claim must be released (no stranded 'dispatching' row) so a retry can re-claim"
    ).toBe(0);

    const counting = countingSendMail(202);
    const retried = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(retried.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("sent");
    expect(await sendsRowCountFor(workspaceId, campaignId, contactId)).toBe(1);
  });

  it("SEND-07: a test-send 4xx is reported failed, never sent", async () => {
    const workspaceId = await freshWorkspaceId(pool, "dispatch-test-4xx");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);

    const counting = countingSendMail(400);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "probe@fixture.test" },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("failed");
    expect(counting.callCount(), "SendGrid must be called exactly once for the test send").toBe(1);
  });

  it("SEND-06 regression: a redelivered job for an already-'sent' contact still calls SendGrid 0 times", async () => {
    const workspaceId = await freshWorkspaceId(pool, "dispatch-sent-regression");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const counting = countingSendMail(202);
    const first = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );
    expect(first.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);

    const redelivered = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );
    expect(redelivered.outcome).toBe("skipped");
    expect(counting.callCount(), "SendGrid must not be called again for an already-sent contact").toBe(1);
    expect(await sendsRowCountFor(workspaceId, campaignId, contactId), "no duplicate sends row for the redelivered job").toBe(1);
  });
});
