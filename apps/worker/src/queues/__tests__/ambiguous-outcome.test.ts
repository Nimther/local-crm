import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
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
  sendsTimingFor,
  throwingSendMail,
} from "../../test/failure-fixtures.js";

/**
 * Phase 11 (D-10, DLV-02, DLV-09, plan 11-06, Task 2) -- `classifyTransportError`
 * (11-05) is consumed HERE: every ambiguous provider outcome on both the
 * campaign and the flow send path now lands in `reconciling` DIRECTLY, on
 * the first call, with no redelivery required to observe it. Only a
 * provably pre-connection failure (DNS/refused) releases the claim and
 * rethrows for BullMQ's bounded retry. Drives `processSendJob` through the
 * `ProcessSendJobDeps.sendMail` seam with `throwingSendMail` -- the same
 * seam DLV-08's crash scenarios inject through, no new seam added.
 */
describe("send-dispatch.ts ambiguous provider outcomes (D-10, DLV-02, DLV-09)", () => {
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

  async function campaignCountersFor(
    workspaceId: string,
    campaignId: string,
  ): Promise<{ status: string; sentCount: number; failedCount: number }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; sentCount: number; failedCount: number }>(
          `SELECT status, sent_count as "sentCount", failed_count as "failedCount"
           FROM campaigns WHERE id = $1 AND workspace_id = $2`,
          [campaignId, workspaceId],
        );
        if (!rows[0]) throw new Error("test setup failure: no campaign row found");
        return rows[0];
      }),
    );
  }

  async function flowSendRowFor(
    workspaceId: string,
    flowRunId: string,
    nodeId: string,
  ): Promise<{ id: string; status: string } | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM sends
           WHERE workspace_id = $1 AND flow_run_id = $2 AND node_id = $3 AND kind = 'flow'`,
          [workspaceId, flowRunId, nodeId],
        );
        return rows[0];
      }),
    );
  }

  describe("campaign path (processSendJob kind='campaign')", () => {
    for (const [label, error] of [
      ["a TimeoutError", new DOMException("The operation was aborted", "AbortError")],
      ["an ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
      ["an unrecognized plain Error (fail-closed default)", new Error("boom")],
    ] as const) {
      it(`${label} leaves the row 'reconciling', returns { outcome: "reconciling" }, and does not throw`, async () => {
        const workspaceId = await freshWorkspaceId(pool, "ambiguous-campaign");
        await connectFixtureSendgridKey(workspaceId);
        const campaignId = await createFixtureCampaign(workspaceId);
        const contactId = await createFixtureContact(workspaceId);

        const countersBefore = await campaignCountersFor(workspaceId, campaignId);
        const throwing = throwingSendMail(error);

        const result = await processSendJob(
          { workspaceId, campaignId, kind: "campaign", contactId },
          { sendMail: throwing.fn, redisClient },
        );

        expect(throwing.callCount()).toBe(1);
        expect(result.outcome).toBe("reconciling");
        if (result.outcome !== "reconciling") throw new Error("unreachable");

        expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("reconciling");

        const timing = await sendsTimingFor(result.sendId, workspaceId);
        expect(timing?.dispatchedAt).not.toBeNull();
        expect(timing?.dispatchDurationMs).not.toBeNull();
        expect(timing?.reconcilingSince).not.toBeNull();

        const countersAfter = await campaignCountersFor(workspaceId, campaignId);
        expect(countersAfter.sentCount, "sent_count must be byte-identical to its pre-call value").toBe(
          countersBefore.sentCount,
        );
        expect(countersAfter.failedCount, "failed_count must be byte-identical to its pre-call value").toBe(
          countersBefore.failedCount,
        );
        expect(countersAfter.status, "campaign status must be unchanged").toBe(countersBefore.status);
      });
    }

    it("an ECONNREFUSED releases the claim and rethrows for BullMQ's bounded retry", async () => {
      const workspaceId = await freshWorkspaceId(pool, "ambiguous-campaign-refused");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const refusedError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      const throwing = throwingSendMail(refusedError);

      await expect(
        processSendJob(
          { workspaceId, campaignId, kind: "campaign", contactId },
          { sendMail: throwing.fn, redisClient },
        ),
        "a provably pre-connection failure must rethrow with its identity intact",
      ).rejects.toBe(refusedError);

      expect(throwing.callCount()).toBe(1);
      expect(
        await sendsRowCountFor(workspaceId, campaignId, contactId),
        "the claim must be released (deleted), not left stranded at 'dispatching'",
      ).toBe(0);
    });

    it("a successful 202 leaves the row 'sent' with non-null dispatched_at/dispatch_duration_ms", async () => {
      const workspaceId = await freshWorkspaceId(pool, "ambiguous-campaign-sent");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: fakeSendMail(202), redisClient },
      );

      expect(result.outcome).toBe("sent");
      if (result.outcome !== "sent") throw new Error("unreachable");
      const timing = await sendsTimingFor(result.sendId, workspaceId);
      expect(timing?.status).toBe("sent");
      expect(timing?.dispatchedAt).not.toBeNull();
      expect(timing?.dispatchDurationMs).not.toBeNull();
    });

    it("a permanent 4xx leaves the row 'failed' with non-null dispatched_at/dispatch_duration_ms", async () => {
      const workspaceId = await freshWorkspaceId(pool, "ambiguous-campaign-failed");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: fakeSendMail(400), redisClient },
      );

      expect(result.outcome).toBe("failed");
      if (result.outcome !== "failed") throw new Error("unreachable");
      const timing = await sendsTimingFor(result.sendId, workspaceId);
      expect(timing?.status).toBe("failed");
      expect(timing?.dispatchedAt).not.toBeNull();
      expect(timing?.dispatchDurationMs).not.toBeNull();
    });

    it("a retried job arriving after an ambiguous outcome returns { outcome: \"skipped\" } and makes no provider call", async () => {
      const workspaceId = await freshWorkspaceId(pool, "ambiguous-campaign-retry-skip");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const throwing = throwingSendMail(new Error("boom"));
      const first = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: throwing.fn, redisClient },
      );
      expect(first.outcome).toBe("reconciling");

      const counting = countingSendMail(202);
      const retried = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: counting.fn, redisClient },
      );

      expect(retried.outcome).toBe("skipped");
      expect(counting.callCount()).toBe(0);
    });
  });

  describe("flow path (processSendJob kind='flow')", () => {
    async function seedFlow(nameSeed: string) {
      const workspaceId = await freshWorkspaceId(pool, nameSeed);
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);
      return { workspaceId, contactId, flowRunId, nodeId };
    }

    for (const [label, error] of [
      ["a TimeoutError", new DOMException("The operation was aborted", "AbortError")],
      ["an ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
      ["an unrecognized plain Error (fail-closed default)", new Error("boom")],
    ] as const) {
      it(`${label} leaves the flow-step row 'reconciling', returns { outcome: "reconciling" }, and does not throw`, async () => {
        const { workspaceId, contactId, flowRunId, nodeId } = await seedFlow("ambiguous-flow");
        const throwing = throwingSendMail(error);

        const result = await processSendJob(
          { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
          { sendMail: throwing.fn, redisClient },
        );

        expect(throwing.callCount()).toBe(1);
        expect(result.outcome).toBe("reconciling");
        if (result.outcome !== "reconciling") throw new Error("unreachable");

        const row = await flowSendRowFor(workspaceId, flowRunId, nodeId);
        expect(row?.status).toBe("reconciling");

        const timing = await sendsTimingFor(result.sendId, workspaceId);
        expect(timing?.dispatchedAt).not.toBeNull();
        expect(timing?.dispatchDurationMs).not.toBeNull();
        expect(timing?.reconcilingSince).not.toBeNull();
      });
    }

    it("an ECONNREFUSED releases the claim and rethrows for BullMQ's bounded retry", async () => {
      const { workspaceId, contactId, flowRunId, nodeId } = await seedFlow("ambiguous-flow-refused");
      const refusedError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      const throwing = throwingSendMail(refusedError);

      await expect(
        processSendJob(
          { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
          { sendMail: throwing.fn, redisClient },
        ),
        "a provably pre-connection failure must rethrow with its identity intact",
      ).rejects.toBe(refusedError);

      expect(throwing.callCount()).toBe(1);
      const row = await flowSendRowFor(workspaceId, flowRunId, nodeId);
      expect(row, "the claim must be released (deleted), not left stranded at 'dispatching'").toBeUndefined();
    });

    it("a successful 202 leaves the flow-step row 'sent' with non-null dispatched_at/dispatch_duration_ms", async () => {
      const { workspaceId, contactId, flowRunId, nodeId } = await seedFlow("ambiguous-flow-sent");

      const result = await processSendJob(
        { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
        { sendMail: fakeSendMail(202), redisClient },
      );

      expect(result.outcome).toBe("sent");
      if (result.outcome !== "sent") throw new Error("unreachable");
      const timing = await sendsTimingFor(result.sendId, workspaceId);
      expect(timing?.status).toBe("sent");
      expect(timing?.dispatchedAt).not.toBeNull();
      expect(timing?.dispatchDurationMs).not.toBeNull();
    });

    it("a permanent 4xx leaves the flow-step row 'failed' with non-null dispatched_at/dispatch_duration_ms", async () => {
      const { workspaceId, contactId, flowRunId, nodeId } = await seedFlow("ambiguous-flow-failed");

      const result = await processSendJob(
        { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
        { sendMail: fakeSendMail(400), redisClient },
      );

      expect(result.outcome).toBe("failed");
      if (result.outcome !== "failed") throw new Error("unreachable");
      const timing = await sendsTimingFor(result.sendId, workspaceId);
      expect(timing?.status).toBe("failed");
      expect(timing?.dispatchedAt).not.toBeNull();
      expect(timing?.dispatchDurationMs).not.toBeNull();
    });

    it("a retried flow job arriving after an ambiguous outcome returns { outcome: \"skipped\" } and makes no provider call", async () => {
      const { workspaceId, contactId, flowRunId, nodeId } = await seedFlow("ambiguous-flow-retry-skip");

      const throwing = throwingSendMail(new Error("boom"));
      const first = await processSendJob(
        { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
        { sendMail: throwing.fn, redisClient },
      );
      expect(first.outcome).toBe("reconciling");

      const counting = countingSendMail(202);
      const retried = await processSendJob(
        { workspaceId, kind: "flow", flowRunId, nodeId, contactId },
        { sendMail: counting.fn, redisClient },
      );

      expect(retried.outcome).toBe("skipped");
      expect(counting.callCount()).toBe(0);
    });
  });
});
