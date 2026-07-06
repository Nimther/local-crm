import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";

/**
 * CR-05/CR-06 regression tests (04-13, CAMP-02/03/05): pins that a
 * non-empty-audience campaign actually reaches `status='sent'` with live
 * `sent_count`/`failed_count` progress as terminal sends land, and that
 * canceling a `sending` campaign authoritatively stops in-flight dispatch.
 * Fixture helpers copied verbatim from send-dispatch-idempotency.test.ts /
 * send-dispatch-durability.test.ts (not exported there, per established
 * convention) -- campaign rows are arranged directly via RLS-scoped UPDATE
 * inside withTenant/withTenantTransaction so each case can pin an exact
 * sendable_total/fan_out_complete/status combination without depending on
 * campaign-kickoff.worker.ts's own fan-out.
 */
describe("campaign completion + cancel (CR-05/CR-06, CAMP-02/03/05)", () => {
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

  function fakeSendMail(status: number): (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult> {
    return async () => ({
      status,
      headers: new Headers(),
      messageId: status < 300 ? "sg-message-id-fixture" : null,
    });
  }

  function countingSendMail(status = 202): {
    fn: (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;
    callCount: () => number;
  } {
    let calls = 0;
    return {
      fn: async () => {
        calls += 1;
        return { status, headers: new Headers(), messageId: status < 300 ? "sg-message-id-fixture" : null };
      },
      callCount: () => calls,
    };
  }

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  async function connectFixtureSendgridKey(workspaceId: string): Promise<void> {
    const encrypted = await encryptTenantSecret(workspaceId, "SG.fixture_test_key_0000000000000000");
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO workspace_sendgrid_keys (workspace_id, encrypted_dek, ciphertext, iv, auth_tag, key_mask, status)
           VALUES ($1, $2, $3, $4, $5, 'SG.fi…0000', 'active')`,
          [workspaceId, encrypted.encryptedDek, encrypted.ciphertext, encrypted.iv, encrypted.authTag]
        )
      )
    );
  }

  /** Creates a 'sending' campaign and immediately pins its sendable_total/fan_out_complete for this test's arrangement. */
  async function createFixtureCampaign(
    workspaceId: string,
    overrides: { sendableTotal: number; fanOutComplete: boolean }
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const segmentId = segmentRows[0].id;

        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, sendable_total, fan_out_complete, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', $3, $4, 'test-user')
           RETURNING id`,
          [workspaceId, segmentId, overrides.sendableTotal, overrides.fanOutComplete]
        );
        return campaignRows[0].id;
      })
    );
  }

  async function createFixtureContact(workspaceId: string): Promise<string> {
    const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email]
        );
        return rows[0].id;
      })
    );
  }

  interface CampaignSnapshot {
    status: string;
    sentCount: number;
    failedCount: number;
    terminalAt: Date | null;
  }

  async function getCampaignSnapshot(workspaceId: string, campaignId: string): Promise<CampaignSnapshot> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<CampaignSnapshot>(
          `SELECT status, sent_count as "sentCount", failed_count as "failedCount", terminal_at as "terminalAt"
           FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        return rows[0];
      })
    );
  }

  async function setCampaignStatus(workspaceId: string, campaignId: string, status: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE campaigns SET status = $2::campaign_status WHERE id = $1`, [campaignId, status])
      )
    );
  }

  async function sendsRowExists(workspaceId: string, campaignId: string, contactId: string): Promise<boolean> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows.length > 0;
      })
    );
  }

  it("CR-05/CAMP-03/CAMP-05: a 2-recipient campaign advances sent_count live and reaches 'sent' after the last terminal send", async () => {
    const workspaceId = await freshWorkspaceId("completion-two");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 2, fanOutComplete: true });
    const contactA = await createFixtureContact(workspaceId);
    const contactB = await createFixtureContact(workspaceId);

    const counting = countingSendMail(202);

    const firstResult = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId: contactA },
      { sendMail: counting.fn, redisClient }
    );
    expect(firstResult.outcome).toBe("sent");

    const afterFirst = await getCampaignSnapshot(workspaceId, campaignId);
    expect(afterFirst.sentCount).toBe(1);
    expect(afterFirst.status).toBe("sending");
    expect(afterFirst.terminalAt).toBeNull();

    const secondResult = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId: contactB },
      { sendMail: counting.fn, redisClient }
    );
    expect(secondResult.outcome).toBe("sent");

    const afterSecond = await getCampaignSnapshot(workspaceId, campaignId);
    expect(afterSecond.sentCount).toBe(2);
    expect(afterSecond.status).toBe("sent");
    expect(afterSecond.terminalAt).not.toBeNull();
  });

  it("D-10/CR-05: a fully-failed 1-recipient campaign still terminates to 'sent' with a visible failed_count", async () => {
    const workspaceId = await freshWorkspaceId("completion-failed");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
    const contactId = await createFixtureContact(workspaceId);

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: fakeSendMail(400), redisClient }
    );
    expect(result.outcome).toBe("failed");

    const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshot.failedCount).toBe(1);
    expect(snapshot.sentCount).toBe(0);
    expect(snapshot.status).toBe("sent");
    expect(snapshot.terminalAt).not.toBeNull();
  });

  it("CR-06/CAMP-02: canceling a sending campaign stops in-flight dispatch -- 0 SendGrid calls, no send row, counters frozen", async () => {
    const workspaceId = await freshWorkspaceId("completion-canceled");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
    const contactId = await createFixtureContact(workspaceId);

    await setCampaignStatus(workspaceId, campaignId, "canceled");

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("skipped");
    expect(counting.callCount()).toBe(0);
    expect(await sendsRowExists(workspaceId, campaignId, contactId)).toBe(false);

    const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshot.status).toBe("canceled");
    expect(snapshot.sentCount).toBe(0);
    expect(snapshot.failedCount).toBe(0);
  });

  it("guard: a campaign already 'sent' never has its counters incremented again by a stray terminal record", async () => {
    const workspaceId = await freshWorkspaceId("completion-guard");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId, { sendableTotal: 1, fanOutComplete: true });
    const contactId = await createFixtureContact(workspaceId);

    await setCampaignStatus(workspaceId, campaignId, "sent");

    const counting = countingSendMail(202);
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("skipped");
    expect(counting.callCount()).toBe(0);

    const snapshot = await getCampaignSnapshot(workspaceId, campaignId);
    expect(snapshot.status).toBe("sent");
    expect(snapshot.sentCount).toBe(0);
    expect(snapshot.failedCount).toBe(0);
  });
});
