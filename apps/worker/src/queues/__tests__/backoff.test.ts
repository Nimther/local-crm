import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";

/**
 * SEND-07: a SendGrid 429/5xx response must yield a rate-limit signal
 * (`{outcome: "rate_limited", rateLimitMs}`) that the Worker wrapper turns
 * into `worker.rateLimit(ms)` + `Worker.RateLimitError()` -- BullMQ's
 * official mechanism that does NOT consume one of the job's `attempts`
 * (docs.bullmq.io/guide/rate-limiting). `processSendJob` itself never
 * throws for this case (kept unit-testable without a live Worker, per the
 * plan's own testing-architecture note) -- these tests instead prove the
 * DOWNSTREAM effect BullMQ's non-consumed-attempt guarantee depends on:
 * 04-12 (T-04-12-03) releases the 'dispatching' claim on a 429/5xx (rather
 * than leaving it stranded), so the `sends` row for the key no longer
 * exists after the response -- and a subsequent redelivery of the SAME job
 * re-claims a FRESH row and still ends up `sent`, rather than dispatchSendGate
 * silently treating a stranded claim as already resolved.
 */
describe("send-dispatch.ts 429/5xx backoff (SEND-07)", () => {
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

  function sendMailReturning(
    status: number,
    headers: Record<string, string> = {}
  ): (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult> {
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
    return async () => ({ status, headers: new Headers(headers), messageId: status < 300 ? "sg-fixture" : null });
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

  it("a 429 response yields {outcome:'rate_limited'} and releases the dispatch claim (T-04-12-03, no consumed attempt)", async () => {
    const workspaceId = await freshWorkspaceId("backoff-429");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: sendMailReturning(429, { "retry-after": "3" }), redisClient }
    );

    expect(result).toEqual({ outcome: "rate_limited", rateLimitMs: 3000 });
    expect(
      await sendsStatusFor(workspaceId, campaignId, contactId),
      "the claim must be released, not left stranded 'dispatching'"
    ).toBeUndefined();
  });

  it("a 500 response also yields {outcome:'rate_limited'} using the fixed 2s fallback when no rate-limit headers are present", async () => {
    const workspaceId = await freshWorkspaceId("backoff-500");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: sendMailReturning(500), redisClient }
    );

    expect(result).toEqual({ outcome: "rate_limited", rateLimitMs: 2000 });
  });

  it("prefers X-RateLimit-Reset (unix seconds) over the fixed fallback when Retry-After is absent", async () => {
    const workspaceId = await freshWorkspaceId("backoff-reset-header");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const resetAt = Math.floor(Date.now() / 1000) + 10;
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: sendMailReturning(429, { "x-ratelimit-reset": String(resetAt) }), redisClient }
    );

    expect(result.outcome).toBe("rate_limited");
    if (result.outcome === "rate_limited") {
      // Allow slack for the ms elapsed between resetAt's computation above and the call.
      expect(result.rateLimitMs).toBeGreaterThan(8000);
      expect(result.rateLimitMs).toBeLessThanOrEqual(10000);
    }
  });

  it("does NOT consume a retry attempt: a redelivered job after a 429 still succeeds and records exactly one sent row", async () => {
    const workspaceId = await freshWorkspaceId("backoff-redeliver");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const rateLimited = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: sendMailReturning(429, { "retry-after": "1" }), redisClient }
    );
    expect(rateLimited.outcome).toBe("rate_limited");

    // Simulated BullMQ redelivery after worker.rateLimit(ms) elapses -- the
    // SAME (workspaceId, campaignId, contactId) job, now with SendGrid
    // healthy again.
    const retried = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: sendMailReturning(202), redisClient }
    );

    expect(retried.outcome).toBe("sent");
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("sent");

    const rowCount = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows.length;
      })
    );
    expect(rowCount, "exactly one sends row across the rate-limited attempt + successful retry").toBe(1);
  });
});
