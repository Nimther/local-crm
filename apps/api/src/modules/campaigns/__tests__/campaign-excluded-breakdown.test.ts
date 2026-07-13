import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { createCampaign, getCampaignProgress } from "../campaign.repository.js";

/**
 * 07-03/D-07: getCampaignProgress must also return `excludedBreakdown`, an
 * array of `{ reason, count }` grouped over `sends` WHERE campaign_id = X
 * AND status = 'excluded', GROUP BY exclusion_reason -- the source data for
 * the campaign summary's «Пропущено: N» breakdown row. Excluded messages
 * must never be folded into any rate denominator (that invariant lives in
 * the web-side computeRate call sites, verified separately by rates.test.ts
 * and CampaignProgress.tsx's D-01 denominators).
 *
 * RED (this plan's Task 1): fails because getCampaignProgress does not yet
 * query/return excludedBreakdown.
 * GREEN: campaign.repository.ts's getCampaignProgress extended to run the
 * grouped query and include the field on its response.
 */
describe("Campaign excluded-reason breakdown (D-07)", () => {
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
    return res.json() as { id: string; slug: string; name: string };
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
    return res.json() as { id: string };
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

  async function createExcludedSend(
    workspaceId: string,
    campaignId: string,
    contactId: string,
    exclusionReason: string | null
  ): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, exclusion_reason)
           VALUES ($1, $2, $3, 'campaign', 'excluded', $4)`,
          [workspaceId, campaignId, contactId, exclusionReason]
        )
      )
    );
  }

  it("returns an empty array when the campaign has zero excluded sends", async () => {
    const { cookie, workspace } = await owner("excluded-breakdown-empty");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "No exclusions",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );

    const progress = await withTenant(workspace.id, () => getCampaignProgress(campaign.id));
    expect(progress?.excludedBreakdown).toEqual([]);
  });

  it("groups excluded sends by exclusion_reason", async () => {
    const { cookie, workspace } = await owner("excluded-breakdown-grouped");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "With exclusions",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );

    const suppressedContactA = await createFixtureContact(workspace.id);
    const suppressedContactB = await createFixtureContact(workspace.id);
    const frequencyCappedContact = await createFixtureContact(workspace.id);

    await createExcludedSend(workspace.id, campaign.id, suppressedContactA, "suppressed");
    await createExcludedSend(workspace.id, campaign.id, suppressedContactB, "suppressed");
    await createExcludedSend(workspace.id, campaign.id, frequencyCappedContact, "frequency_cap");

    const progress = await withTenant(workspace.id, () => getCampaignProgress(campaign.id));
    expect(progress?.excludedBreakdown).toBeDefined();

    const sorted = [...(progress?.excludedBreakdown ?? [])].sort((a, b) =>
      (a.reason ?? "").localeCompare(b.reason ?? "")
    );
    expect(sorted).toEqual([
      { reason: "frequency_cap", count: 1 },
      { reason: "suppressed", count: 2 },
    ]);
  });
});
