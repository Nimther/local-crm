import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { createCampaign, getCampaignProgress } from "../campaign.repository.js";

/**
 * D-16 (Phase 13, closing Phase 11 D-13's deferral): `getCampaignProgress`'s
 * ledger re-aggregation must give `reconciling` and `unknown` sends their own
 * named count instead of silently dropping them from a four-key allow-list.
 * The ledger's six values must always sum to the campaign's total `sends`
 * row count -- that sum is the assertion that makes "an ambiguous send is
 * invisible" a test failure rather than a quiet data gap.
 *
 * RED (this plan's Task 1): fails today because the ledger initializer only
 * recognizes `sent`/`failed`/`excluded`/`dispatching` and the `reconciling`/
 * `unknown` rows are dropped entirely.
 * GREEN: campaign.repository.ts's `getCampaignProgress` widened to a
 * six-key `Record<SendStatus, number>` ledger built from the shared
 * `SEND_STATUSES` vocabulary.
 */
describe("Campaign progress ambiguous-send ledger (D-16)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const TEST_USER_ID = "test-user";

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUp(email: string, password: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password, name },
    });
    expect(res.statusCode, `sign-up failed: ${res.body}`).toBe(200);
    const sessionCookie = res.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) {
      throw new Error("sign-up response did not set a session cookie");
    }
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
  }

  async function createWorkspace(cookie: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create workspace failed: ${res.body}`).toBe(200);
    return res.json<{ id: string; slug: string; name: string }>();
  }

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    const workspace = await createWorkspace(account.cookie, `${nameSeed} Co`);
    return { ...account, workspace };
  }

  async function createSegment(cookie: string, slug: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/segments`,
      headers: { cookie },
      payload: {
        name,
        definition: {
          version: 1,
          groups: [
            {
              conditions: [
                { type: "attribute", source: "standard", field: "subscriptionStatus", operator: "eq", value: "subscribed" },
              ],
            },
          ],
        },
      },
    });
    expect(res.statusCode, `create segment failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
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

  async function createSend(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    status: "sent" | "failed" | "excluded" | "dispatching" | "reconciling" | "unknown"
  ): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status)
           VALUES ($1, $2, $3, 'campaign', $4)`,
          [workspaceId, campaignId, contactId, status]
        )
      )
    );
  }

  it("reports reconciling and unknown as their own named counts, summing to the total sends", async () => {
    const { cookie, workspace } = await owner("ambiguous-ledger");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "Ambiguous ledger",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );

    const statuses: Array<"sent" | "failed" | "excluded" | "dispatching" | "reconciling" | "unknown"> = [
      "sent",
      "sent",
      "failed",
      "reconciling",
      "unknown",
    ];
    for (const status of statuses) {
      const contactId = await createFixtureContact(workspace.id);
      await createSend(workspace.id, campaign.id, contactId, status);
    }

    const progress = await withTenant(workspace.id, () => getCampaignProgress(campaign.id));
    expect(progress?.ledger).toEqual({
      sent: 2,
      failed: 1,
      excluded: 0,
      dispatching: 0,
      reconciling: 1,
      unknown: 1,
    });

    const ledgerSum = Object.values(progress?.ledger ?? {}).reduce((total, count) => total + count, 0);
    expect(ledgerSum).toBe(statuses.length);

    // sentCount/failedCount on the row-level counters are independent of the
    // ledger re-aggregation and must be unaffected by the presence of
    // ambiguous sends.
    expect(progress?.sentCount).toBe(0);
    expect(progress?.failedCount).toBe(0);
  });

  it("returns reconciling: 0 and unknown: 0 rather than omitting the keys when there are no ambiguous sends", async () => {
    const { cookie, workspace } = await owner("ambiguous-ledger-empty");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "No ambiguous sends",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );

    const contactId = await createFixtureContact(workspace.id);
    await createSend(workspace.id, campaign.id, contactId, "sent");

    const progress = await withTenant(workspace.id, () => getCampaignProgress(campaign.id));
    expect(progress?.ledger.reconciling).toBe(0);
    expect(progress?.ledger.unknown).toBe(0);
    expect(Object.keys(progress?.ledger ?? {}).sort()).toEqual(
      ["dispatching", "excluded", "failed", "reconciling", "sent", "unknown"]
    );
  });
});
