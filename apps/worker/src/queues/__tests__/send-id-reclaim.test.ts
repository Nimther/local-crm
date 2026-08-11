import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import {
  dispatchSendGate,
  claimFlowSend,
  releaseDispatchClaim,
  recordExcluded,
  recordFlowExcluded,
  deriveCampaignSendId,
  deriveFlowSendId,
} from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  fakeSendMail,
  insertFixtureOrganization,
  sendsRowCountFor,
  sendsStatusFor,
} from "../../test/failure-fixtures.js";

/**
 * Phase 11 (D-09, DLV-05, plan 11-04, Task 2) -- proves `sends.id` is now a
 * pure function of the send intent for both campaign and flow ledger
 * inserts, and that the release-then-re-claim cycle this closes (RESEARCH.md
 * Pitfall 4) provably reproduces the SAME id: `releaseDispatchClaim` DELETEs
 * a `dispatching` row on a 429/5xx response, and the derivation (not a
 * plumbed-through value) is what guarantees the next claim attempt for the
 * identical intent lands on the exact same id a phantom-accepted message's
 * webhook evidence would already be addressed to.
 *
 * Human decision at the 11-04 package-legitimacy checkpoint: `send-id.ts`
 * hand-rolls UUIDv5 over `node:crypto` rather than depending on the `uuid`
 * npm package RESEARCH.md recommended -- no dependency-installation
 * assertion belongs in this file; `send-id.test.ts` (packages/delivery-core)
 * carries that correctness burden. This file only proves the ledger's
 * insert/release/re-claim behavior against the derivation, exactly as it
 * would against any other id source.
 */
describe("send-id reclaim (D-09, DLV-05): derived ids, and release-then-re-claim reproduces them", () => {
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

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function flowSendsFor(
    workspaceId: string,
    flowRunId: string,
    nodeId: string
  ): Promise<Array<{ id: string; status: string }>> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM sends
           WHERE workspace_id = $1 AND flow_run_id = $2 AND node_id = $3 AND kind = 'flow'`,
          [workspaceId, flowRunId, nodeId]
        );
        return rows;
      })
    );
  }

  async function sendsRowCountForCampaignOnly(workspaceId: string, campaignId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2`,
          [workspaceId, campaignId]
        );
        return rows.length;
      })
    );
  }

  it("dispatchSendGate's fresh campaign claim returns the derived id", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-campaign-derive");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const claim = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => dispatchSendGate(client, { workspaceId, campaignId, contactId }))
    );

    if (claim === "skipped") {
      throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
    }
    expect(claim.sendId).toBe(deriveCampaignSendId(workspaceId, campaignId, contactId));
  });

  it("claimFlowSend's fresh flow claim returns the derived id", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-flow-derive");
    await connectFixtureSendgridKey(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

    const claim = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => claimFlowSend(client, { workspaceId, flowRunId, nodeId, contactId }))
    );

    if (claim === "skipped") {
      throw new Error("test setup failure: expected a fresh claimFlowSend claim");
    }
    expect(claim.sendId).toBe(deriveFlowSendId(workspaceId, flowRunId, nodeId));
  });

  it("releaseDispatchClaim deletes the row, and a subsequent dispatchSendGate for the SAME intent returns the SAME id", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-campaign-cycle");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const firstClaim = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => dispatchSendGate(client, { workspaceId, campaignId, contactId }))
    );
    if (firstClaim === "skipped") {
      throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
    }
    const firstId = firstClaim.sendId;

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => releaseDispatchClaim(client, firstId))
    );
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "the row must actually be deleted by the release"
    ).toBe(0);

    const secondClaim = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => dispatchSendGate(client, { workspaceId, campaignId, contactId }))
    );
    if (secondClaim === "skipped") {
      throw new Error("test setup failure: expected a fresh re-claim after release");
    }

    expect(secondClaim.sendId, "the re-claim for the identical intent must reproduce the EXACT SAME id").toBe(firstId);
    expect(secondClaim.sendId).toBe(deriveCampaignSendId(workspaceId, campaignId, contactId));
  });

  it("processSendJob: a 429 release followed by a 202 retry leaves exactly one sends row, whose id is the derived id", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-processjob-429-202");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const expectedId = deriveCampaignSendId(workspaceId, campaignId, contactId);

    const rateLimited = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: fakeSendMail(429, { "retry-after": "1" }), redisClient }
    );
    expect(rateLimited.outcome).toBe("rate_limited");
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "the 429 release must leave no stranded row"
    ).toBe(0);

    const counting = countingSendMail(202);
    const retried = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(retried.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);
    if (retried.outcome !== "sent") {
      throw new Error("unreachable: outcome already asserted 'sent'");
    }
    expect(retried.sendId, "the reclaimed row's id must be the derived id, reproducing the phantom-correlation target").toBe(
      expectedId
    );
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("sent");
    expect(
      await sendsRowCountFor(workspaceId, campaignId, contactId),
      "exactly one sends row total for the intent -- no duplicate from the release-then-re-claim cycle"
    ).toBe(1);
  });

  it("recordExcluded inserts a row whose id equals deriveCampaignSendId for that intent", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-excluded-campaign");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordExcluded(client, { workspaceId, campaignId, contactId }, "suppressed")
      )
    );

    const [row] = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows;
      })
    );

    expect(row?.status).toBe("excluded");
    expect(row?.id).toBe(deriveCampaignSendId(workspaceId, campaignId, contactId));
  });

  it("recordFlowExcluded inserts a row whose id equals deriveFlowSendId for that intent", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-excluded-flow");
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordFlowExcluded(client, { workspaceId, flowRunId, nodeId, contactId }, "suppressed")
      )
    );

    const rows = await flowSendsFor(workspaceId, flowRunId, nodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("excluded");
    expect(rows[0].id).toBe(deriveFlowSendId(workspaceId, flowRunId, nodeId));
  });

  it("a kind='test' send still creates no sends row (D-11 exemption from this module untouched)", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-test-kind-exempt");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);

    const before = await sendsRowCountForCampaignOnly(workspaceId, campaignId);

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "probe@fixture.test" },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);
    expect(
      await sendsRowCountForCampaignOnly(workspaceId, campaignId),
      "a test send must never insert a sends row"
    ).toBe(before);
  });
});
