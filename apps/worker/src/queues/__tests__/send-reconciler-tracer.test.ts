import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { dispatchSendGate } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import { runReconcilerTick } from "../send-reconciler.worker.js";
import {
  connectFixtureSendgridKey,
  countingSendMail,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
} from "../../test/failure-fixtures.js";

/**
 * The end-to-end tracer proof for Phase 11's delivery-correctness slice
 * (11-03): a campaign send whose prior attempt left a committed
 * `dispatching` claim is redelivered, lands in `reconciling` (not
 * `failed`), never calls SendGrid a second time, and increments no campaign
 * counter (DLV-02) -- then the reconciler tick discovers it across
 * workspaces, classifies it purely from webhook evidence in `send_events`
 * (no provider call anywhere, D-01/D-05), and resolves it to `sent`
 * (DLV-03). A second tick over the same row proves idempotency (DLV-04).
 *
 * Mirrors send-dispatch-durability.test.ts's setup/fixtures exactly --
 * `arrangeInterruptedClaim` is copied from that suite's own CR-04 helper.
 */
describe("send-reconciler.worker.ts end-to-end tracer (DLV-02/DLV-03/DLV-04)", () => {
  let pool: Pool;
  let redisClient: Redis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
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

  async function sendRowFor(
    workspaceId: string,
    campaignId: string,
    contactId: string
  ): Promise<{ id: string; status: string; sentAt: Date | null; reconcilingSince: Date | null } | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{
          id: string;
          status: string;
          sentAt: Date | null;
          reconcilingSince: Date | null;
        }>(
          `SELECT id, status, sent_at as "sentAt", reconciling_since as "reconcilingSince"
           FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0];
      })
    );
  }

  async function campaignFailedCountFor(workspaceId: string, campaignId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ failedCount: number }>(
          `SELECT failed_count as "failedCount" FROM campaigns WHERE id = $1 AND workspace_id = $2`,
          [workspaceId, campaignId]
        );
        return rows[0]?.failedCount ?? 0;
      })
    );
  }

  /** Inserts a raw send_events row correlated by send_id -- the ONLY evidence the reconciler is allowed to read (D-01/D-05: never a SendGrid call). */
  async function insertSendEventEvidence(workspaceId: string, sendId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'processed', '{}'::jsonb, now())`,
          [workspaceId, `sg-evt-${sendId}`, sendId]
        )
      )
    );
  }

  it("end to end: interrupted redelivery -> reconciling -> webhook evidence -> reconciler resolves to sent, with zero provider calls throughout", async () => {
    const workspaceId = await freshWorkspaceId(pool, "reconciler-tracer");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await arrangeInterruptedClaim(workspaceId, campaignId, contactId);

    const failedCountBefore = await campaignFailedCountFor(workspaceId, campaignId);

    const counting = countingSendMail();
    const redeliveredResult = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(redeliveredResult.outcome).toBe("reconciling");
    expect(counting.callCount(), "an interrupted claim must never trigger a SendGrid call").toBe(0);

    const afterRedelivery = await sendRowFor(workspaceId, campaignId, contactId);
    expect(afterRedelivery?.status).toBe("reconciling");
    expect(afterRedelivery?.reconcilingSince).not.toBeNull();
    expect(afterRedelivery?.sentAt).toBeNull();
    expect(
      await campaignFailedCountFor(workspaceId, campaignId),
      "the interrupted branch must not increment failed_count -- the reconciler backfills counters exactly once"
    ).toBe(failedCountBefore);

    const sendId = afterRedelivery?.id;
    if (!sendId) {
      throw new Error("test setup failure: no sends row found after the interrupted redelivery");
    }

    await insertSendEventEvidence(workspaceId, sendId);

    const beforeTick = new Date();
    const firstTick = await runReconcilerTick();
    expect(firstTick.resolved).toBeGreaterThanOrEqual(1);

    const afterTick = await sendRowFor(workspaceId, campaignId, contactId);
    expect(afterTick?.status).toBe("sent");
    expect(afterTick?.reconcilingSince).toBeNull();
    expect(afterTick?.sentAt).not.toBeNull();
    // sent_at is back-dated (COALESCE to dispatched_at/reconciling_since/
    // queued_at), never stamped with the reconciler's own now() -- it must
    // not be LATER than the tick that resolved it.
    expect((afterTick?.sentAt as Date).getTime()).toBeLessThanOrEqual(beforeTick.getTime() + 5000);
    expect(counting.callCount(), "the reconciler must never call the provider").toBe(0);

    const secondTick = await runReconcilerTick();
    expect(secondTick.resolved).toBe(0);

    const afterSecondTick = await sendRowFor(workspaceId, campaignId, contactId);
    expect(afterSecondTick?.status).toBe("sent");
    expect(afterSecondTick?.sentAt?.getTime()).toBe((afterTick?.sentAt as Date).getTime());
    expect(counting.callCount(), "the second tick must also never call the provider").toBe(0);
  });
});
