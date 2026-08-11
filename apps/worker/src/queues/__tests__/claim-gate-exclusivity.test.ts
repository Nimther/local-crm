import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { dispatchSendGate, claimFlowSend, recordExcluded, recordFlowExcluded } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
  sendsStatusFor,
} from "../../test/failure-fixtures.js";

/**
 * Phase 11 (DLV-04, plan 11-03, Task 2) -- the retry-worker half of DLV-04's
 * exclusivity guarantee: a redelivered/retried job must refuse to touch a
 * `sends` row currently in `reconciling` or `unknown`, and a redelivered
 * exclusion re-walk must not stomp one back to `excluded` (RESEARCH.md
 * Pitfall 3). `resolveOneSend`'s `SELECT ... FOR UPDATE SKIP LOCKED`
 * (send-reconciler.worker.ts) closes the OTHER half -- reconciler-vs-
 * reconciler -- and is exercised by send-reconciler-tracer.test.ts, not
 * here. Both halves are required for DLV-04; this file proves the one row
 * locking alone cannot close.
 *
 * Rows are arranged by a normal claim (`dispatchSendGate`/`claimFlowSend`)
 * followed by a direct `UPDATE ... SET status = $2::send_status` inside the
 * SAME `withTenant`/`withTenantTransaction` scope every other tenant-scoped
 * write in this codebase uses -- mirroring `send-dispatch-durability.test.ts`'s
 * own arrange-then-assert convention.
 */
describe("claim-gate exclusivity: reconciling/unknown refuse retry-worker and exclusion re-walk (DLV-04)", () => {
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

  /** Claims a fresh campaign send, then forces it directly to `status` -- returns the sendId. */
  async function arrangeCampaignSendAtStatus(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    status: "reconciling" | "unknown"
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const claim = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
        if (claim === "skipped" || !claim.sendId) {
          throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
        }
        await client.query(`UPDATE sends SET status = $2::send_status WHERE id = $1`, [claim.sendId, status]);
        return claim.sendId;
      })
    );
  }

  /** Claims a fresh flow-step send, then forces it directly to `status` -- returns the sendId. */
  async function arrangeFlowSendAtStatus(
    workspaceId: string,
    flowRunId: string,
    nodeId: string,
    contactId: string,
    status: "reconciling" | "unknown"
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const claim = await claimFlowSend(client, { workspaceId, flowRunId, nodeId, contactId });
        if (claim === "skipped" || !claim.sendId) {
          throw new Error("test setup failure: expected a fresh claimFlowSend claim");
        }
        await client.query(`UPDATE sends SET status = $2::send_status WHERE id = $1`, [claim.sendId, status]);
        return claim.sendId;
      })
    );
  }

  async function sendRowById(workspaceId: string, sendId: string): Promise<{ status: string; exclusionReason: string | null }> {
    const row = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; exclusionReason: string | null }>(
          `SELECT status, exclusion_reason as "exclusionReason" FROM sends WHERE id = $1`,
          [sendId]
        );
        return rows[0];
      })
    );
    if (!row) throw new Error(`test assertion failure: no sends row for id ${sendId}`);
    return row;
  }

  for (const status of ["reconciling", "unknown"] as const) {
    it(`dispatchSendGate called for an existing row in '${status}' returns "skipped"`, async () => {
      const workspaceId = await freshWorkspaceId(pool, `claim-gate-campaign-${status}`);
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      await arrangeCampaignSendAtStatus(workspaceId, campaignId, contactId, status);

      const result = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => dispatchSendGate(client, { workspaceId, campaignId, contactId }))
      );

      expect(result).toBe("skipped");
    });

    it(`claimFlowSend called for an existing flow row in '${status}' returns "skipped"`, async () => {
      const workspaceId = await freshWorkspaceId(pool, `claim-gate-flow-${status}`);
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

      await arrangeFlowSendAtStatus(workspaceId, flowRunId, nodeId, contactId, status);

      const result = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => claimFlowSend(client, { workspaceId, flowRunId, nodeId, contactId }))
      );

      expect(result).toBe("skipped");
    });

    it(`recordExcluded called for a row in '${status}' leaves status unchanged and exclusion_reason null`, async () => {
      const workspaceId = await freshWorkspaceId(pool, `claim-gate-excluded-${status}`);
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await arrangeCampaignSendAtStatus(workspaceId, campaignId, contactId, status);

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => recordExcluded(client, { workspaceId, campaignId, contactId }, "suppressed"))
      );

      const row = await sendRowById(workspaceId, sendId);
      expect(row.status).toBe(status);
      expect(row.exclusionReason).toBeNull();
    });

    it(`recordFlowExcluded called for a flow row in '${status}' leaves status unchanged and exclusion_reason null`, async () => {
      const workspaceId = await freshWorkspaceId(pool, `claim-gate-flow-excluded-${status}`);
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

      const sendId = await arrangeFlowSendAtStatus(workspaceId, flowRunId, nodeId, contactId, status);

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordFlowExcluded(client, { workspaceId, flowRunId, nodeId, contactId }, "suppressed")
        )
      );

      const row = await sendRowById(workspaceId, sendId);
      expect(row.status).toBe(status);
      expect(row.exclusionReason).toBeNull();
    });
  }

  it("processSendJob redelivered onto a 'reconciling' campaign row returns { outcome: \"skipped\" } and makes zero provider calls", async () => {
    const workspaceId = await freshWorkspaceId(pool, "claim-gate-process-send-job");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await arrangeCampaignSendAtStatus(workspaceId, campaignId, contactId, "reconciling");

    const counting = countingSendMail();
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result).toEqual({ outcome: "skipped" });
    expect(counting.callCount(), "a redelivered job must never call the provider for a reconciling row").toBe(0);
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("reconciling");
  });

  it("recordExcluded still overwrites an existing 'excluded' row's exclusion_reason (pre-existing re-classification behavior is not regressed)", async () => {
    const workspaceId = await freshWorkspaceId(pool, "claim-gate-excluded-reclassify");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordExcluded(client, { workspaceId, campaignId, contactId }, "unsubscribed")
      )
    );
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("excluded");

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordExcluded(client, { workspaceId, campaignId, contactId }, "suppressed")
      )
    );

    const row = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; exclusionReason: string | null }>(
          `SELECT status, exclusion_reason as "exclusionReason" FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0];
      })
    );
    expect(row?.status).toBe("excluded");
    expect(row?.exclusionReason, "re-classification must still update exclusion_reason on an existing excluded row").toBe(
      "suppressed"
    );
  });
});
