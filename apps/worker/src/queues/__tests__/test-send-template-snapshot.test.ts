import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { SendGridMailSendRequest, SendTenantMailResult } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processSendJob } from "../send-dispatch.js";
import {
  connectFixtureSendgridKey,
  createFixtureCampaign,
  createFixtureContact,
  freshWorkspaceId,
} from "../../test/failure-fixtures.js";

/**
 * TMPL-03/D-12 three-path template-correctness proof (SC2, plan 20-04):
 *
 * - **Test-send** (`kind='test'`): the dispatcher must prefer the job
 *   payload's `templateId`/`fromEmail` snapshot -- captured at enqueue time
 *   from the version-checked row, plan 20-03 -- over a fresh read of
 *   `campaigns` at dispatch time. Covered by the top-level "snapshot wins",
 *   "the async-gap proof (D-12)", "rolling-deploy fallback", and
 *   "effective-value prerequisite check" cases. Plan 20-03's own
 *   route-level assertion (`campaigns-routes.test.ts`) already proves the
 *   enqueued job CARRIES the saved row's values; this file proves the
 *   WORKER honours what it carries.
 * - **Launch and Schedule** (`kind='campaign'`): both fan out through
 *   `campaign-kickoff.worker.ts` onto `kind='campaign'` jobs, and neither
 *   can be edited after the `sending`/`scheduled` transition (RESEARCH
 *   Pattern 3) -- there is no editable window a snapshot would protect, so
 *   the dispatcher always re-derives from the row via `readSendPrereqs`
 *   called WITHOUT an override. Covered by the "campaign dispatch path"
 *   describe block below: "row-derived after a save" (the row's NEW
 *   template wins after an edit) and "snapshot scoping pin" (a `templateId`
 *   field on a `kind='campaign'` job is ignored).
 *
 * Each assertion below operates at the `sendMail` seam (the payload
 * `buildMailSendRequest` produces), never at the returned outcome alone --
 * "sent" alone cannot distinguish which template was actually used.
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

  async function updateCampaignFromName(
    workspaceId: string,
    campaignId: string,
    fromName: string | null
  ): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE campaigns SET from_name = $1 WHERE id = $2 AND workspace_id = $3`, [
          fromName,
          campaignId,
          workspaceId,
        ])
      )
    );
  }

  it("snapshot wins: a kind='test' job's templateId/fromEmail/fromName override the row's own values", async () => {
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
        fromName: "Snapshot Sender",
      },
      { sendMail: recording.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    const payload = recording.lastPayload();
    expect(payload?.template_id).toBe("d-snapshot-template");
    expect(payload?.from).toEqual({ email: "snapshot-sender@fixture.test", name: "Snapshot Sender" });
  });

  it("the async-gap proof (D-12): a template change after enqueue does not redirect an already-queued test send", async () => {
    const { workspaceId, campaignId } = await seedFixtureCampaign("tmpl-async-gap");
    // Simulate a save landing on the row AFTER the job was enqueued with its snapshot.
    await updateCampaignTemplateId(workspaceId, campaignId, "d-fixture-template-CHANGED");
    await updateCampaignFromName(workspaceId, campaignId, "Changed Sender Name");
    const recording = recordingSendMail();

    const result = await processSendJob(
      {
        workspaceId,
        campaignId,
        kind: "test",
        testTo: "marketer@fixture.test",
        templateId: "d-fixture-template", // the ORIGINAL snapshot, captured before the row changed
        fromEmail: "sender@fixture.test",
        fromName: "Original Sender Name",
      },
      { sendMail: recording.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    const payload = recording.lastPayload();
    expect(payload?.template_id, "the queued test send must not follow the row's later change").toBe("d-fixture-template");
    expect(payload?.from).toEqual({ email: "sender@fixture.test", name: "Original Sender Name" });
  });

  it("rolling-deploy fallback: an old-shaped kind='test' job uses the row's current template/sender/name", async () => {
    const { workspaceId, campaignId } = await seedFixtureCampaign("tmpl-rolling-deploy");
    await updateCampaignFromName(workspaceId, campaignId, "Persisted Sender Name");
    const recording = recordingSendMail();

    const result = await processSendJob(
      { workspaceId, campaignId, kind: "test", testTo: "marketer@fixture.test" },
      { sendMail: recording.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    const payload = recording.lastPayload();
    expect(payload?.template_id).toBe("d-fixture-template");
    expect(payload?.from).toEqual({ email: "sender@fixture.test", name: "Persisted Sender Name" });
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

  it("a blank test-send snapshot produces the legacy email-only From payload", async () => {
    const { workspaceId, campaignId } = await seedFixtureCampaign("from-name-blank");
    await updateCampaignFromName(workspaceId, campaignId, "Persisted Sender Name");
    const recording = recordingSendMail();

    const result = await processSendJob(
      {
        workspaceId,
        campaignId,
        kind: "test",
        testTo: "marketer@fixture.test",
        fromName: "   ",
      },
      { sendMail: recording.fn, redisClient }
    );

    expect(result.outcome).toBe("sent");
    expect(recording.lastPayload()?.from).toEqual({ email: "sender@fixture.test" });
  });

  describe("campaign dispatch path (SC2: launch and schedule converge here, both row-derived)", () => {
    it("row-derived after a save: a kind='campaign' job sends the campaign's NEW template after an edit", async () => {
      const { workspaceId, campaignId } = await seedFixtureCampaign("tmpl-campaign-row-derived");
      const contactId = await createFixtureContact(workspaceId);
      // The "marketer saved a new template" step of the original bug scenario.
      await updateCampaignTemplateId(workspaceId, campaignId, "d-fixture-template-NEW");
      await updateCampaignFromName(workspaceId, campaignId, "Campaign Sender Name");
      const recording = recordingSendMail();

      const result = await processSendJob(
        { workspaceId, campaignId, kind: "campaign", contactId },
        { sendMail: recording.fn, redisClient }
      );

      expect(result.outcome).toBe("sent");
      const payload = recording.lastPayload();
      expect(payload?.template_id, "launch/schedule pick up the saved template with no snapshot involved").toBe(
        "d-fixture-template-NEW"
      );
      expect(payload?.from).toEqual({ email: "sender@fixture.test", name: "Campaign Sender Name" });
    });

    it("snapshot scoping pin: a kind='campaign' job carrying a templateId field is ignored -- the ROW's template is sent", async () => {
      const { workspaceId, campaignId } = await seedFixtureCampaign("tmpl-campaign-scoping-pin");
      const contactId = await createFixtureContact(workspaceId);
      await updateCampaignFromName(workspaceId, campaignId, "Persisted Campaign Name");
      const recording = recordingSendMail();

      const result = await processSendJob(
        {
          workspaceId,
          campaignId,
          kind: "campaign",
          contactId,
          // A campaign job schema-permits these fields (they are shared with
          // kind='test' on the same emailBroadcastJobSchema) but the campaign
          // branch must never consult them -- T-20-04-01.
          templateId: "d-should-be-ignored",
          fromEmail: "should-be-ignored@fixture.test",
          fromName: "Should Be Ignored",
        },
        { sendMail: recording.fn, redisClient }
      );

      expect(result.outcome).toBe("sent");
      const payload = recording.lastPayload();
      expect(payload?.template_id, "a campaign job can never be redirected by its own payload").toBe("d-fixture-template");
      expect(payload?.from).toEqual({ email: "sender@fixture.test", name: "Persisted Campaign Name" });
    });
  });
});
