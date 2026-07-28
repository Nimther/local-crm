import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { dispatchSendGate } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";

/**
 * Durability regression tests pinning CR-03 (a rejected SendGrid 4xx
 * recorded as 'sent') and CR-04 (a worker crash between the 'dispatching'
 * claim commit and the terminal record causing a duplicate email on
 * redelivery) -- 04-VERIFICATION.md verification truth #4, SEND-06/SEND-07.
 *
 * Fixture helpers are copied verbatim from send-dispatch-idempotency.test.ts
 * (not exported there, per that file's own convention) so this suite can
 * additionally arrange a committed 'dispatching' claim directly via
 * `dispatchSendGate`, simulating a crash that happens strictly AFTER the
 * claim transaction commits but BEFORE SendGrid is ever called.
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

  function fakeSendMail(
    status: number,
    headers: Record<string, string> = {}
  ): (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult> {
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
    return async () => ({
      status,
      headers: new Headers(headers),
      messageId: status < 300 ? "sg-message-id-fixture" : null,
    });
  }

  function countingSendMail(status = 202): {
    fn: (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;
    callCount: () => number;
  } {
    let calls = 0;
    return {
      // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
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

  // workspace_sendgrid_keys/segments/campaigns/contacts all carry ENABLE +
  // FORCE ROW LEVEL SECURITY -- fixture inserts MUST run inside
  // withTenant/withTenantTransaction (send-dispatch-idempotency's convention).
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

  async function createFixtureCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const segmentId = segmentRows[0].id;

        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Fixture campaign', 'sending', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentId]
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

  async function sendsStatusFor(workspaceId: string, campaignId: string, contactId: string): Promise<string | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(
          `SELECT status FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0]?.status;
      })
    );
  }

  async function sendsRowCountFor(workspaceId: string, campaignId: string, contactId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows.length;
      })
    );
  }

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
    const workspaceId = await freshWorkspaceId("dispatch-interrupted");
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
    const workspaceId = await freshWorkspaceId("dispatch-4xx");
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
    const workspaceId = await freshWorkspaceId("dispatch-429-release");
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
    const workspaceId = await freshWorkspaceId("dispatch-test-4xx");
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
    const workspaceId = await freshWorkspaceId("dispatch-sent-regression");
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
