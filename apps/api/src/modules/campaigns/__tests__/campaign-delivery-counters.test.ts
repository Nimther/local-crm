import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { createCampaign, getCampaignProgress } from "../campaign.repository.js";

/**
 * D-07/D-08/D-09/WBHK-04: the campaign progress endpoint (and the underlying
 * getCampaignProgress repository function) must surface the five delivery
 * counters written by the 05-03 webhook worker
 * (delivered/opened/clicked/bounced/unsubscribed). Seeds a campaign with
 * non-zero counters directly (bypassing the webhook pipeline, whose own
 * exactly-once behavior is already covered by 05-03's integration tests)
 * and asserts the progress endpoint returns them unchanged.
 */
describe("Campaign delivery counters (D-07/D-08/D-09)", () => {
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

  it("progress endpoint returns delivered/opened/clicked/bounced/unsubscribed counters", async () => {
    const { cookie, workspace } = await owner("campaign-delivery-counters");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "Delivery counters test",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );

    // Seed non-zero delivery counters directly -- the webhook worker's
    // exactly-once counter-increment behavior is already covered by
    // 05-03's own integration tests; this test only proves the read path.
    await withTenant(workspace.id, () =>
      withTenantTransaction((client) =>
        client.query(
          `UPDATE campaigns SET
             delivered_count = $2,
             opened_count = $3,
             clicked_count = $4,
             bounced_count = $5,
             unsubscribed_count = $6
           WHERE id = $1`,
          [campaign.id, 7, 4, 2, 3, 1]
        )
      )
    );

    const progress = await withTenant(workspace.id, () => getCampaignProgress(campaign.id));
    expect(progress).toMatchObject({
      deliveredCount: 7,
      openedCount: 4,
      clickedCount: 2,
      bouncedCount: 3,
      unsubscribedCount: 1,
    });

    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}/progress`,
      headers: { cookie },
    });
    expect(res.statusCode, `progress request failed: ${res.body}`).toBe(200);
    expect(res.json()).toMatchObject({
      deliveredCount: 7,
      openedCount: 4,
      clickedCount: 2,
      bouncedCount: 3,
      unsubscribedCount: 1,
    });

    // Campaign detail response must also carry the same counters.
    const detailRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}`,
      headers: { cookie },
    });
    expect(detailRes.statusCode, `campaign detail request failed: ${detailRes.body}`).toBe(200);
    expect(detailRes.json()).toMatchObject({
      deliveredCount: 7,
      openedCount: 4,
      clickedCount: 2,
      bouncedCount: 3,
      unsubscribedCount: 1,
    });
  });
});
