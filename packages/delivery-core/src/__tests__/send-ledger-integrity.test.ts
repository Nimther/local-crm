import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getAuthTestDatabaseUrl } from "@mega-crm/test-support";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../test/db-fixture.js";
import { dispatchSendGate, recordSendResult, recordExcluded } from "../send-ledger.js";

/**
 * CR-07 (04-VERIFICATION.md truth #4, SEND-04/SEND-06): recordExcluded's
 * unconditional `ON CONFLICT ... DO UPDATE SET status='excluded'` lets an
 * at-least-once BullMQ kickoff redelivery DEMOTE an already-'sent' (or
 * in-flight 'dispatching') row back to 'excluded' -- erasing delivery
 * history and corrupting pre-send-gate's frequency-cap accounting (which
 * counts this same campaign's own status='sent' rows). This integration test
 * proves recordExcluded can never overwrite a terminal/in-flight send, while
 * the normal exclusion path (fresh insert, re-classification of an
 * already-excluded row) keeps working. Runs against the real test Postgres
 * (RLS-forced fixtures, mirroring send-dispatch-idempotency.test.ts's
 * convention) -- send-ledger.ts's functions take a raw PoolClient and issue
 * real SQL, so a stubbed client cannot exercise the ON CONFLICT guard itself.
 */
describe("recordExcluded ledger integrity (CR-07, SEND-04/SEND-06)", () => {
  let pool: Pool;
  // 10-09 (SEC-05): mega_crm_app (`pool` above) holds only SELECT on
  // organization post-migration-0045 -- seeding a fixture workspace row
  // needs the mega_crm_auth-backed connection instead.
  let authPool: Pool | undefined;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
    await authPool?.end();
  });

  function getAuthTestPool(): Pool {
    if (!authPool) authPool = new Pool({ connectionString: getAuthTestDatabaseUrl() });
    return authPool;
  }

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await getAuthTestPool().query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  // segments/campaigns/contacts all carry ENABLE + FORCE ROW LEVEL SECURITY --
  // fixture inserts MUST run inside withTenant/withTenantTransaction
  // (send-dispatch-idempotency.test.ts's convention).
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

  async function sendsRowFor(
    workspaceId: string,
    campaignId: string,
    contactId: string
  ): Promise<{ status: string; exclusionReason: string | null } | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; exclusionReason: string | null }>(
          `SELECT status, exclusion_reason as "exclusionReason" FROM sends
           WHERE workspace_id = $1 AND campaign_id = $2 AND contact_id = $3`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0];
      })
    );
  }

  it("does NOT demote an already-'sent' row when a kickoff re-walk calls recordExcluded again", async () => {
    const workspaceId = await freshWorkspaceId("ledger-sent-guard");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const gate = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
        if (gate === "skipped") throw new Error("expected a fresh sendId, got 'skipped'");
        await recordSendResult(client, gate.sendId, { status: "sent", providerMessageId: "sg-fixture-id" });
      })
    );

    expect((await sendsRowFor(workspaceId, campaignId, contactId))?.status).toBe("sent");

    // Simulated at-least-once kickoff redelivery: the exclusion re-walk calls
    // recordExcluded for a contact who has, in the interim, already been sent to.
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordExcluded(client, { workspaceId, campaignId, contactId }, "unsubscribed")
      )
    );

    const row = await sendsRowFor(workspaceId, campaignId, contactId);
    expect(row?.status, "a delivered send must never be demoted to 'excluded'").toBe("sent");
  });

  it("does NOT demote an in-flight 'dispatching' row when recordExcluded is called concurrently", async () => {
    const workspaceId = await freshWorkspaceId("ledger-dispatching-guard");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const gate = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
        if (gate === "skipped") throw new Error("expected a fresh sendId, got 'skipped'");
        // Leave the row at its inserted 'dispatching' status -- simulates a
        // SendGrid call still in flight when the exclusion re-walk runs.
      })
    );

    expect((await sendsRowFor(workspaceId, campaignId, contactId))?.status).toBe("dispatching");

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordExcluded(client, { workspaceId, campaignId, contactId }, "unsubscribed")
      )
    );

    const row = await sendsRowFor(workspaceId, campaignId, contactId);
    expect(row?.status, "an in-flight send must never be demoted to 'excluded'").toBe("dispatching");
  });

  it("still inserts a fresh 'excluded' row with the supplied reason when no row exists yet", async () => {
    const workspaceId = await freshWorkspaceId("ledger-fresh-exclude");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordExcluded(client, { workspaceId, campaignId, contactId }, "unsubscribed")
      )
    );

    const row = await sendsRowFor(workspaceId, campaignId, contactId);
    expect(row?.status).toBe("excluded");
    expect(row?.exclusionReason).toBe("unsubscribed");
  });

  it("still updates the exclusion_reason when re-classifying an already-'excluded' row", async () => {
    const workspaceId = await freshWorkspaceId("ledger-reclassify");
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordExcluded(client, { workspaceId, campaignId, contactId }, "no_email")
      )
    );
    expect((await sendsRowFor(workspaceId, campaignId, contactId))?.exclusionReason).toBe("no_email");

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        recordExcluded(client, { workspaceId, campaignId, contactId }, "suppressed")
      )
    );

    const row = await sendsRowFor(workspaceId, campaignId, contactId);
    expect(row?.status).toBe("excluded");
    expect(row?.exclusionReason, "re-classification of an already-excluded contact still works").toBe(
      "suppressed"
    );
  });
});
