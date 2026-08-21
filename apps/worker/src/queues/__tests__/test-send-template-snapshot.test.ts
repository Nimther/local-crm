import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import { connectFixtureSendgridKey, createFixtureCampaign, freshWorkspaceId } from "../../test/failure-fixtures.js";

/**
 * TMPL-03/D-12: for `kind='test'`, the dispatcher must prefer the job
 * payload's `templateId`/`fromEmail` snapshot -- captured at enqueue time
 * from the version-checked row, plan 20-03 -- over a fresh read of
 * `campaigns` at dispatch time, falling back to the row when either field is
 * absent (rolling-deploy safety). Each assertion below operates at the
 * `sendMail` seam (the payload `buildMailSendRequest` produces), never at
 * the returned outcome alone -- "sent" alone cannot distinguish which
 * template was actually used.
 */
describe("test-send-template-snapshot (TMPL-03, D-12)", () => {
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

  /** Local recording double -- captures the LAST payload handed to the seam (send-dispatch-idempotency.test.ts precedent). */
  function recordingSendMail(): {
    fn: (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;
    lastPayload: () => SendGridMailSendRequest | undefined;
  } {
    let lastPayload: SendGridMailSendRequest | undefined;
    return {
      // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam
      fn: async (_apiKey, payload) => {
        lastPayload = payload;
        return { status: 202, headers: new Headers(), messageId: "sg-message-id-fixture" };
      },
      lastPayload: () => lastPayload,
    };
  }

  async function seedFixtureCampaign(nameSeed: string): Promise<{ workspaceId: string; campaignId: string }> {
    const workspaceId = await freshWorkspaceId(pool, nameSeed);
    await connectFixtureSendgridKey(workspaceId);
    const campaignId = await createFixtureCampaign(workspaceId);
    return { workspaceId, campaignId };
  }

  /** Simulates a marketer's save landing on the row while a job waits in the queue. */
  async function updateCampaignTemplateId(workspaceId: string, campaignId: string, templateId: string | null): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE campaigns SET template_id = $1 WHERE id = $2 AND workspace_id = $3`, [
          templateId,
          campaignId,
          workspaceId,
        ])
      )
    );
  }

  it("snapshot wins: a kind='test' job's templateId/fromEmail override the row's own values", async () => {
    const { workspaceId, campaignId } = await seedFixtureCampaign("tmpl-snapshot-wins");
    const recording = recordingSendMail();

    const result = await processSendJob(
      {
        workspaceId,
        campaignId,
        kind: "test",
        testTo: "marketer@fixture.test",
        templateId: "d-snapshot-template",
        fromEmail: "snapshot-sender@fixture.test",
      },
      { sendMail: recording.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    const payload = recording.lastPayload();
    expect(payload?.template_id).toBe("d-snapshot-template");
    expect(payload?.from.email).toBe("snapshot-sender@fixture.test");
  });

  it("the async-gap proof (D-12): a template change after enqueue does not redirect an already-queued test send", async () => {
    const { workspaceId, campaignId } = await seedFixtureCampaign("tmpl-async-gap");
    // Simulate a save landing on the row AFTER the job was enqueued with its snapshot.
    await updateCampaignTemplateId(workspaceId, campaignId, "d-fixture-template-CHANGED");
    const recording = recordingSendMail();

    const result = await processSendJob(
      {
        workspaceId,
        campaignId,
        kind: "test",
        testTo: "marketer@fixture.test",
        templateId: "d-fixture-template", // the ORIGINAL snapshot, captured before the row changed
        fromEmail: "sender@fixture.test",
      },
      { sendMail: recording.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    const payload = recording.lastPayload();
    expect(payload?.template_id, "the queued test send must not follow the row's later change").toBe("d-fixture-template");
  });

  it("rolling-deploy fallback: a kind='test' job carrying neither snapshot field uses the row's current template/sender", async () => {
    const { workspaceId, campaignId } = await seedFixtureCampaign("tmpl-rolling-deploy");
    const recording = recordingSendMail();

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
      { sendMail: recording.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    const payload = recording.lastPayload();
    expect(payload?.template_id).toBe("d-fixture-template");
    expect(payload?.from.email).toBe("sender@fixture.test");
  });

  it("effective-value prerequisite check: a snapshot rescues a test send even when the row's template_id is now null", async () => {
    const { workspaceId, campaignId } = await seedFixtureCampaign("tmpl-effective-value");
    await updateCampaignTemplateId(workspaceId, campaignId, null);
    const recording = recordingSendMail();

    const result = await processSendJob(
      {
        workspaceId,
        campaignId,
        kind: "test",
        testTo: "marketer@fixture.test",
        templateId: "d-snapshot-rescue",
        fromEmail: "rescue-sender@fixture.test",
      },
      { sendMail: recording.fn, redisClient }
    );

    expect(result.outcome, "the check must see the EFFECTIVE values, not throw the missing-prerequisite error").toBe("sent");
    const payload = recording.lastPayload();
    expect(payload?.template_id).toBe("d-snapshot-rescue");
    expect(payload?.from.email).toBe("rescue-sender@fixture.test");
  });
});
