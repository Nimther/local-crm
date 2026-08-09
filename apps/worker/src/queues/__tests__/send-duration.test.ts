import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { dispatchSendGate, claimFlowSend, recordSendResult, recordFlowStepResult } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
  sendsTimingFor,
} from "../../test/failure-fixtures.js";

/**
 * Phase 11 (DLV-09, plan 11-06, Task 1) -- `recordSendResult`/
 * `recordFlowStepResult` now carry `dispatchedAt`/`dispatchDurationMs`
 * alongside `status`, written with `COALESCE` so an omitted measurement
 * never erases a recorded one, and `reconciling_since` still only advances
 * on FIRST entry into `reconciling` (11-03's own guarantee, re-asserted here
 * against the widened signature). Drives both ledger functions directly
 * against live Postgres -- no `processSendJob`/`processFlowSendJob`
 * involved, that wiring is `ambiguous-outcome.test.ts`'s job.
 */
describe("send-ledger.ts recordSendResult/recordFlowStepResult dispatch timing (DLV-09)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function claimCampaignRow(workspaceId: string, campaignId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const claim = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
        if (claim === "skipped" || !claim.sendId) {
          throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
        }
        return claim.sendId;
      }),
    );
  }

  async function claimFlowRow(
    workspaceId: string,
    flowRunId: string,
    nodeId: string,
    contactId: string,
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const claim = await claimFlowSend(client, { workspaceId, flowRunId, nodeId, contactId });
        if (claim === "skipped" || !claim.sendId) {
          throw new Error("test setup failure: expected a fresh claimFlowSend claim");
        }
        return claim.sendId;
      }),
    );
  }

  describe("recordSendResult (campaign ledger)", () => {
    it("status: 'sent' leaves dispatched_at/dispatch_duration_ms/sent_at all set", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-campaign-sent");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const sendId = await claimCampaignRow(workspaceId, campaignId, contactId);

      const dispatchedAt = new Date("2026-01-01T00:00:00.000Z");
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordSendResult(client, sendId, {
            status: "sent",
            providerMessageId: "m",
            dispatchedAt,
            dispatchDurationMs: 123,
          }),
        ),
      );

      const row = await sendsTimingFor(sendId, workspaceId);
      expect(row?.status).toBe("sent");
      expect(row?.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(row?.dispatchDurationMs).toBe(123);
      expect(row?.sentAt).not.toBeNull();
    });

    it("status: 'failed' leaves dispatched_at/dispatch_duration_ms set and sent_at null", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-campaign-failed");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const sendId = await claimCampaignRow(workspaceId, campaignId, contactId);

      const dispatchedAt = new Date("2026-01-01T00:00:00.000Z");
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordSendResult(client, sendId, { status: "failed", dispatchedAt, dispatchDurationMs: 456 }),
        ),
      );

      const row = await sendsTimingFor(sendId, workspaceId);
      expect(row?.status).toBe("failed");
      expect(row?.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(row?.dispatchDurationMs).toBe(456);
      expect(row?.sentAt).toBeNull();
    });

    it("status: 'reconciling' leaves dispatched_at/dispatch_duration_ms set, reconciling_since non-null, sent_at null", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-campaign-reconciling");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const sendId = await claimCampaignRow(workspaceId, campaignId, contactId);

      const dispatchedAt = new Date("2026-01-01T00:00:00.000Z");
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordSendResult(client, sendId, { status: "reconciling", dispatchedAt, dispatchDurationMs: 789 }),
        ),
      );

      const row = await sendsTimingFor(sendId, workspaceId);
      expect(row?.status).toBe("reconciling");
      expect(row?.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(row?.dispatchDurationMs).toBe(789);
      expect(row?.reconcilingSince).not.toBeNull();
      expect(row?.sentAt).toBeNull();
    });

    it("omitting the timing fields on a second call preserves the values written by the first", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-campaign-preserve");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const sendId = await claimCampaignRow(workspaceId, campaignId, contactId);

      const dispatchedAt = new Date("2026-01-01T00:00:00.000Z");
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordSendResult(client, sendId, { status: "reconciling", dispatchedAt, dispatchDurationMs: 111 }),
        ),
      );

      // Second call omits both timing fields entirely -- an omitted
      // measurement must not null out a recorded one.
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => recordSendResult(client, sendId, { status: "reconciling" })),
      );

      const row = await sendsTimingFor(sendId, workspaceId);
      expect(row?.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(row?.dispatchDurationMs).toBe(111);
    });

    it("a second 'reconciling' write does not move reconciling_since forward", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-campaign-reconciling-since");
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const sendId = await claimCampaignRow(workspaceId, campaignId, contactId);

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordSendResult(client, sendId, { status: "reconciling", dispatchedAt: new Date(), dispatchDurationMs: 1 }),
        ),
      );
      const firstRow = await sendsTimingFor(sendId, workspaceId);
      const firstReconcilingSince = firstRow?.reconcilingSince?.getTime();

      await new Promise((resolve) => setTimeout(resolve, 10));

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordSendResult(client, sendId, { status: "reconciling", dispatchedAt: new Date(), dispatchDurationMs: 2 }),
        ),
      );
      const secondRow = await sendsTimingFor(sendId, workspaceId);

      expect(secondRow?.reconcilingSince?.getTime()).toBe(firstReconcilingSince);
    });
  });

  describe("recordFlowStepResult (flow ledger)", () => {
    it("status: 'sent' leaves dispatched_at/dispatch_duration_ms/sent_at all set", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-flow-sent");
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);
      const sendId = await claimFlowRow(workspaceId, flowRunId, nodeId, contactId);

      const dispatchedAt = new Date("2026-01-01T00:00:00.000Z");
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordFlowStepResult(client, sendId, {
            status: "sent",
            providerMessageId: "m",
            dispatchedAt,
            dispatchDurationMs: 123,
          }),
        ),
      );

      const row = await sendsTimingFor(sendId, workspaceId);
      expect(row?.status).toBe("sent");
      expect(row?.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(row?.dispatchDurationMs).toBe(123);
      expect(row?.sentAt).not.toBeNull();
    });

    it("status: 'failed' leaves dispatched_at/dispatch_duration_ms set and sent_at null", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-flow-failed");
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);
      const sendId = await claimFlowRow(workspaceId, flowRunId, nodeId, contactId);

      const dispatchedAt = new Date("2026-01-01T00:00:00.000Z");
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordFlowStepResult(client, sendId, { status: "failed", dispatchedAt, dispatchDurationMs: 456 }),
        ),
      );

      const row = await sendsTimingFor(sendId, workspaceId);
      expect(row?.status).toBe("failed");
      expect(row?.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(row?.dispatchDurationMs).toBe(456);
      expect(row?.sentAt).toBeNull();
    });

    it("status: 'reconciling' leaves dispatched_at/dispatch_duration_ms set, reconciling_since non-null, sent_at null", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-flow-reconciling");
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);
      const sendId = await claimFlowRow(workspaceId, flowRunId, nodeId, contactId);

      const dispatchedAt = new Date("2026-01-01T00:00:00.000Z");
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordFlowStepResult(client, sendId, { status: "reconciling", dispatchedAt, dispatchDurationMs: 789 }),
        ),
      );

      const row = await sendsTimingFor(sendId, workspaceId);
      expect(row?.status).toBe("reconciling");
      expect(row?.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(row?.dispatchDurationMs).toBe(789);
      expect(row?.reconcilingSince).not.toBeNull();
      expect(row?.sentAt).toBeNull();
    });

    it("omitting the timing fields on a second call preserves the values written by the first", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-flow-preserve");
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);
      const sendId = await claimFlowRow(workspaceId, flowRunId, nodeId, contactId);

      const dispatchedAt = new Date("2026-01-01T00:00:00.000Z");
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordFlowStepResult(client, sendId, { status: "reconciling", dispatchedAt, dispatchDurationMs: 111 }),
        ),
      );

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => recordFlowStepResult(client, sendId, { status: "reconciling" })),
      );

      const row = await sendsTimingFor(sendId, workspaceId);
      expect(row?.dispatchedAt?.getTime()).toBe(dispatchedAt.getTime());
      expect(row?.dispatchDurationMs).toBe(111);
    });

    it("a second 'reconciling' write does not move reconciling_since forward", async () => {
      const workspaceId = await freshWorkspaceId(pool, "duration-flow-reconciling-since");
      await connectFixtureSendgridKey(workspaceId);
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);
      const sendId = await claimFlowRow(workspaceId, flowRunId, nodeId, contactId);

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordFlowStepResult(client, sendId, {
            status: "reconciling",
            dispatchedAt: new Date(),
            dispatchDurationMs: 1,
          }),
        ),
      );
      const firstRow = await sendsTimingFor(sendId, workspaceId);
      const firstReconcilingSince = firstRow?.reconcilingSince?.getTime();

      await new Promise((resolve) => setTimeout(resolve, 10));

      await withTenant(workspaceId, () =>
        withTenantTransaction((client) =>
          recordFlowStepResult(client, sendId, {
            status: "reconciling",
            dispatchedAt: new Date(),
            dispatchDurationMs: 2,
          }),
        ),
      );
      const secondRow = await sendsTimingFor(sendId, workspaceId);

      expect(secondRow?.reconcilingSince?.getTime()).toBe(firstReconcilingSince);
    });
  });
});
