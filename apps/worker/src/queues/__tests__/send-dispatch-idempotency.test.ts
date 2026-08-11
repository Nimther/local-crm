import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob, type SendJobResult } from "../send-dispatch.js";
import { verifyUnsubscribeToken, type SendGridMailSendRequest, type SendTenantMailResult } from "@mega-crm/delivery-core";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * send-dispatch.ts's shared `processSendJob` (SEND-01/05/06/07, SUBS-03,
 * D-12): invoked directly with a crafted job payload -- no live BullMQ
 * Queue/Redis round-trip needed, mirroring events-ingest.worker.ts's
 * exported-processor test convention (Pattern 2). The SendGrid network call
 * is replaced with a fake `sendMail` (ProcessSendJobDeps) so these tests
 * never touch the real network, while every other step (KMS decrypt,
 * pre-send gate, idempotent ledger insert, rate limiter) runs against the
 * real test Postgres/Redis, matching this codebase's established
 * integration-test convention for worker processors.
 */
describe("send-dispatch.ts processSendJob (SEND-01/05/06/07, SUBS-03, D-12)", () => {
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

  function countingSendMail(): {
    fn: (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;
    callCount: () => number;
    lastPayload: () => SendGridMailSendRequest | undefined;
  } {
    let calls = 0;
    let lastPayload: SendGridMailSendRequest | undefined;
    return {
      // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
      fn: async (_apiKey, payload) => {
        calls += 1;
        lastPayload = payload;
        return { status: 202, headers: new Headers(), messageId: "sg-message-id-fixture" };
      },
      callCount: () => calls,
      lastPayload: () => lastPayload,
    };
  }

  // 10-09 (SEC-05): delegates to the mega_crm_auth-backed INSERT in
  // failure-fixtures.ts instead of duplicating it -- mega_crm_app holds
  // only SELECT on organization post-migration-0045.
  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  // workspace_sendgrid_keys/segments/campaigns/contacts all carry ENABLE +
  // FORCE ROW LEVEL SECURITY -- fixture inserts MUST run inside
  // withTenant/withTenantTransaction (imports-csv-idempotency's convention).
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

  async function createFixtureContact(
    workspaceId: string,
    overrides: { email?: string | null; subscriptionStatus?: "subscribed" | "unsubscribed" | "suppressed" } = {}
  ): Promise<string> {
    const email = overrides.email === undefined ? `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test` : overrides.email;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', $3) RETURNING id`,
          [workspaceId, email, overrides.subscriptionStatus ?? "subscribed"]
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

  it("SEND-05/SUBS-03: a sendable contact is decrypted, gated, sent, and recorded as sent", async () => {
    const workspaceId = await freshWorkspaceId("dispatch-sendable");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const counting = countingSendMail();
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("sent");

    // SUBS-04: every non-test send carries both RFC 8058 headers, built
    // from a per-message signed token (not a static/shared unsubscribe URL).
    const payload = counting.lastPayload();
    expect(payload?.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(payload?.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/api\.test\.local\/unsubscribe\/.+>$/);
    expect(payload?.tracking_settings.subscription_tracking.enable).toBe(false);
  });

  it("SEND-06: a redelivered job for an already-'sent' contact calls SendGrid 0 times and creates no second sends row", async () => {
    const workspaceId = await freshWorkspaceId("dispatch-idempotent");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    const counting = countingSendMail();
    const first = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );
    expect(first.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);

    // Simulated BullMQ at-least-once redelivery of the SAME job.
    const redelivered: SendJobResult = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(redelivered.outcome).toBe("skipped");
    expect(counting.callCount(), "SendGrid must not be called again for an already-sent contact").toBe(1);

    const rowCount = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(
          `SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows.length;
      })
    );
    expect(rowCount, "no duplicate sends row for the redelivered job").toBe(1);
  });

  it("SUBS-03: an unsubscribed contact is recorded as excluded and SendGrid is never called", async () => {
    const workspaceId = await freshWorkspaceId("dispatch-excluded");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId, { subscriptionStatus: "unsubscribed" });

    const counting = countingSendMail();
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "campaign", contactId },
      { sendMail: counting.fn, redisClient }
    );

    expect(result).toEqual({ outcome: "excluded", reason: "unsubscribed" });
    expect(counting.callCount()).toBe(0);
    expect(await sendsStatusFor(workspaceId, campaignId, contactId)).toBe("excluded");
  });

  it("D-12: a test send skips the pre-send gate and the ledger insert but still calls SendGrid", async () => {
    const workspaceId = await freshWorkspaceId("dispatch-test-send");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);

    const counting = countingSendMail();
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    expect(counting.callCount()).toBe(1);

    const rowCount = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM sends WHERE workspace_id = $1 AND campaign_id = $2`, [
          workspaceId,
          campaignId,
        ]);
        return rows.length;
      })
    );
    expect(rowCount, "D-12: test sends are never written to the send ledger").toBe(0);
  });

  it("CR-01: a test send with no contactId signs its List-Unsubscribe token with a valid random UUID, not a placeholder literal", async () => {
    const workspaceId = await freshWorkspaceId("dispatch-test-send-uuid");
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);

    const counting = countingSendMail();
    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "probe@fixture.test" },
      { sendMail: counting.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");

    const payload = counting.lastPayload();
    const header = payload?.headers["List-Unsubscribe"];
    expect(header).toMatch(/^<.+\/unsubscribe\/.+>$/);
    const token = header?.slice(header.indexOf("/unsubscribe/") + "/unsubscribe/".length, header.length - 1);
    expect(token).toBeTruthy();

    const decoded = verifyUnsubscribeToken(token!);
    expect(decoded).not.toBeNull();
    expect(decoded?.contactId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(decoded?.contactId).not.toBe("test-send");
  });

  it("send-dispatch.ts never imports @sendgrid/mail's module-level singleton", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../send-dispatch.ts", import.meta.url), "utf8")
    );
    expect(source).not.toMatch(/from ["']@sendgrid\/mail["']/);
  });
});
