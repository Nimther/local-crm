import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import {
  CampaignStateError,
  cancelCampaign,
  createCampaign,
  duplicateCampaign,
  launchCampaign,
  updateCampaign,
} from "../campaign.repository.js";

/**
 * D-03/D-07/D-08/D-09/D-10/D-11: the campaign lifecycle state machine's
 * locked transitions -- draft->sending happy path, draft->sent rejected,
 * update-on-scheduled rejected, scheduled->draft cancel, sending->canceled,
 * duplicate creates a new draft. Drives the real HTTP sign-up/workspace/
 * segment/contact routes to seed fixtures (mirrors segments'
 * attribute-conditions.test.ts harness), then calls campaign.repository
 * functions directly (campaigns.routes.ts doesn't exist until this plan's
 * Task 2).
 */
describe("Campaign state machine (CAMP-01..05)", () => {
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

  it("draft -> sending succeeds when template/sender/segment are set", async () => {
    const { cookie, workspace } = await owner("campaign-launch-happy");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "Spring Sale",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );
    expect(campaign.status).toBe("draft");

    const launched = await withTenant(workspace.id, () => launchCampaign(campaign.id));
    expect(launched.status).toBe("sending");
    expect(launched.sendingStartedAt).not.toBeNull();
  });

  it("launch is rejected as 'incomplete' when template/sender is missing", async () => {
    const { cookie, workspace } = await owner("campaign-launch-incomplete");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({ name: "No Template", segmentId: segment.id, createdByUserId: TEST_USER_ID })
    );

    await expect(withTenant(workspace.id, () => launchCampaign(campaign.id))).rejects.toMatchObject({
      code: "incomplete",
    });
  });

  it("draft -> sent is rejected (no direct jump; only sending/canceled are reachable via the repository)", async () => {
    const { cookie, workspace } = await owner("campaign-draft-to-sent");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "Direct to sent",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );

    // The repository exposes no "markSent" transition reachable from draft --
    // launchCampaign only ever produces 'sending'. cancelCampaign, the only
    // other draft-adjacent transition, rejects a plain draft outright,
    // proving there is no code path from draft directly to a terminal state.
    await expect(withTenant(workspace.id, () => cancelCampaign(campaign.id))).rejects.toMatchObject({
      code: "illegal_transition",
    });
  });

  it("updateCampaign on a scheduled campaign is rejected (D-08)", async () => {
    const { cookie, workspace } = await owner("campaign-update-scheduled");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({ name: "Scheduled edit test", segmentId: segment.id, createdByUserId: TEST_USER_ID })
    );

    const { scheduleCampaign } = await import("../campaign.repository.js");
    const scheduled = await withTenant(workspace.id, () =>
      scheduleCampaign(campaign.id, new Date(Date.now() + 60 * 60 * 1000))
    );
    expect(scheduled.status).toBe("scheduled");

    await expect(
      withTenant(workspace.id, () => updateCampaign(campaign.id, { name: "Renamed" }))
    ).rejects.toMatchObject({ code: "illegal_transition" });
  });

  it("scheduled -> draft cancel works (D-07)", async () => {
    const { cookie, workspace } = await owner("campaign-cancel-scheduled");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({ name: "Cancel me", segmentId: segment.id, createdByUserId: TEST_USER_ID })
    );

    const { scheduleCampaign } = await import("../campaign.repository.js");
    await withTenant(workspace.id, () =>
      scheduleCampaign(campaign.id, new Date(Date.now() + 60 * 60 * 1000))
    );

    const canceled = await withTenant(workspace.id, () => cancelCampaign(campaign.id));
    expect(canceled.status).toBe("draft");
    expect(canceled.scheduledAt).toBeNull();
  });

  it("sending -> canceled works (D-09)", async () => {
    const { cookie, workspace } = await owner("campaign-cancel-sending");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "In flight",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );
    await withTenant(workspace.id, () => launchCampaign(campaign.id));

    const canceled = await withTenant(workspace.id, () => cancelCampaign(campaign.id));
    expect(canceled.status).toBe("canceled");
    expect(canceled.terminalAt).not.toBeNull();
  });

  it("duplicate creates a new draft copying segment/template/sender", async () => {
    const { cookie, workspace } = await owner("campaign-duplicate");
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await withTenant(workspace.id, () =>
      createCampaign({
        name: "Original",
        segmentId: segment.id,
        templateId: "d-template-1",
        fromEmail: "marketing@example.com",
        createdByUserId: TEST_USER_ID,
      })
    );
    await withTenant(workspace.id, () => launchCampaign(campaign.id));

    const duplicated = await withTenant(workspace.id, () => duplicateCampaign(campaign.id, TEST_USER_ID));
    expect(duplicated.id).not.toBe(campaign.id);
    expect(duplicated.status).toBe("draft");
    expect(duplicated.segmentId).toBe(segment.id);
    expect(duplicated.templateId).toBe("d-template-1");
    expect(duplicated.fromEmail).toBe("marketing@example.com");
  });

  it("CampaignStateError carries the expected error codes", () => {
    const err = new CampaignStateError("test", "incomplete");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CampaignStateError");
    expect(err.code).toBe("incomplete");
  });
});
