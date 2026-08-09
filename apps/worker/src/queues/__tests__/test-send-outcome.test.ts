import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Job, Worker } from "bullmq";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { EmailBroadcastJob } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import { handleEmailBroadcastJob } from "../email-broadcast.worker.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  fakeSendMail,
  freshWorkspaceId,
  throwingSendMail,
} from "../../test/failure-fixtures.js";

/** D-12: a test send never writes to the sends ledger -- counts ALL rows for the campaign, not scoped to a contact (a test send has none). */
async function sendsRowCountForCampaign(workspaceId: string, campaignId: string): Promise<number> {
  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows } = await client.query(`SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2`, [
        workspaceId,
        campaignId,
      ]);
      return rows.length;
    })
  );
}

/**
 * Phase 11 (D-11, plan 11-10): a `kind='test'` send has no `sends` row
 * (D-12) -- when its provider call is ambiguous, the ambiguity has to
 * surface through the RETURNED OUTCOME (`{ outcome: "unknown", sendId }`)
 * rather than a ledger state, since there is no row to write one onto.
 * Drives `processSendJob` through the SAME `ProcessSendJobDeps.sendMail`
 * seam `ambiguous-outcome.test.ts` uses for the campaign/flow paths -- no
 * new seam, per DLV-08's own convention.
 */
describe("test-send outcome vocabulary (D-11, plan 11-10)", () => {
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

  async function seedTestSendCampaign(nameSeed: string): Promise<{ workspaceId: string; campaignId: string }> {
    const workspaceId = await freshWorkspaceId(pool, nameSeed);
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    return { workspaceId, campaignId };
  }

  for (const [label, error] of [
    ["a TimeoutError", new DOMException("The operation was aborted", "AbortError")],
    ["an ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["an unrecognized plain Error (fail-closed default)", new Error("boom")],
  ] as const) {
    it(`${label} returns { outcome: "unknown", sendId } and does not throw, with no sends row written`, async () => {
      const { workspaceId, campaignId } = await seedTestSendCampaign("test-send-unknown");
      const throwing = throwingSendMail(error);

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
        { sendMail: throwing.fn, redisClient }
      );

      expect(throwing.callCount()).toBe(1);
      expect(result.outcome).toBe("unknown");
      if (result.outcome !== "unknown") throw new Error("unreachable -- narrowed above");
      expect(result.sendId).toBeTruthy();

      expect(
        await sendsRowCountForCampaign(workspaceId, campaignId),
        "D-12: a test send never writes to the sends ledger, ambiguous or not"
      ).toBe(0);
    });
  }

  it("an ECONNREFUSED rethrows -- a provably-never-sent test send can still retry (no duplicate risk)", async () => {
    const { workspaceId, campaignId } = await seedTestSendCampaign("test-send-refused");
    const refusedError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const throwing = throwingSendMail(refusedError);

    await expect(
      processSendJob(
        { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
        { sendMail: throwing.fn, redisClient }
      ),
      "a provably pre-connection failure must rethrow with its identity intact"
    ).rejects.toBe(refusedError);

    expect(throwing.callCount()).toBe(1);
  });

  it("a definite 4xx still returns { outcome: 'failed', sendId } -- unchanged", async () => {
    const { workspaceId, campaignId } = await seedTestSendCampaign("test-send-failed");

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
      { sendMail: fakeSendMail(400), redisClient }
    );

    expect(result.outcome).toBe("failed");
    expect(
      await sendsRowCountForCampaign(workspaceId, campaignId),
      "D-12: a test send never writes to the sends ledger, failed or not"
    ).toBe(0);
  });

  it("a 202 still returns { outcome: 'sent', ... } -- unchanged", async () => {
    const { workspaceId, campaignId } = await seedTestSendCampaign("test-send-sent");

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
      { sendMail: fakeSendMail(202), redisClient }
    );

    expect(result.outcome).toBe("sent");
  });

  describe("Worker-level: an unknown outcome completes the job rather than throwing", () => {
    function fakeWorker(): Worker<EmailBroadcastJob> {
      return { rateLimit: vi.fn() } as unknown as Worker<EmailBroadcastJob>;
    }

    function fakeJob(data: EmailBroadcastJob): Job<EmailBroadcastJob> {
      return { data } as Job<EmailBroadcastJob>;
    }

    it("handleEmailBroadcastJob resolves (does not throw) when processSendJob returns { outcome: 'unknown' }", async () => {
      const { workspaceId, campaignId } = await seedTestSendCampaign("test-send-worker-unknown");
      const throwing = throwingSendMail(new Error("boom"));

      await expect(
        handleEmailBroadcastJob(
          fakeJob({ workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" }),
          fakeWorker(),
          { sendMail: throwing.fn, redisClient }
        )
      ).resolves.toBeUndefined();

      expect(throwing.callCount()).toBe(1);
    });
  });
});
