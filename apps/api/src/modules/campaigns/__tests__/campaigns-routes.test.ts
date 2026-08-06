import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 08-16 (QG-03) — the campaign HTTP surface that had no test.
 *
 * campaigns.routes.ts was the largest uncovered block in the repository: 80 of
 * 242 lines. The existing suites drive the repository functions directly, or
 * hit only `/:id`, `/launch`, `/progress` and `/test-send`; list, create,
 * update, delete, audience-breakdown and test-sample were never exercised
 * through the route layer at all — which is where the validation, the
 * membership resolution and the error mapping live.
 *
 * The two `sendgrid/*` routes are deliberately not covered here: they call out
 * to SendGrid, and no test in this phase makes a network call to that host.
 */
describe("campaign routes (CAMP-01..05)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function owner(nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const signUp = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { email, password: "correct horse battery staple 42", name: nameSeed },
    });
    expect(signUp.statusCode, `sign-up failed: ${signUp.body}`).toBe(200);
    const sessionCookie = signUp.cookies.find((c) => c.name.toLowerCase().includes("session"));
    if (!sessionCookie) throw new Error("sign-up set no session cookie");
    const cookie = `${sessionCookie.name}=${sessionCookie.value}`;

    const ws = await app.inject({
      method: "POST",
      url: "/api/workspaces",
      headers: { cookie },
      payload: { name: `${nameSeed} Co` },
    });
    expect(ws.statusCode, `create workspace failed: ${ws.body}`).toBe(200);
    return { cookie, workspace: ws.json<{ id: string; slug: string }>() };
  }

  async function createSegment(cookie: string, slug: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/segments`,
      headers: { cookie },
      payload: {
        name: "All subscribed",
        definition: {
          version: 1,
          groups: [
            {
              conditions: [
                {
                  type: "attribute",
                  source: "standard",
                  field: "subscriptionStatus",
                  operator: "eq",
                  value: "subscribed",
                },
              ],
            },
          ],
        },
      },
    });
    expect(res.statusCode, `create segment failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>().id;
  }

  async function createCampaignViaRoute(
    cookie: string,
    slug: string,
    segmentId: string,
    name = "Spring Sale",
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/campaigns`,
      headers: { cookie },
      payload: { name, segmentId, templateId: "d-template-1", fromEmail: "marketing@example.com" },
    });
    expect(res.statusCode, `create campaign failed: ${res.body}`).toBe(201);
    return res.json<{ id: string; name: string; status: string }>();
  }

  describe("create", () => {
    it("creates a draft and echoes it back", async () => {
      const { cookie, workspace } = await owner("camp-routes-create");
      const segmentId = await createSegment(cookie, workspace.slug);
      const created = await createCampaignViaRoute(cookie, workspace.slug, segmentId);

      expect(created.status).toBe("draft");
      expect(created.name).toBe("Spring Sale");
    });

    it("rejects a body that fails the schema", async () => {
      const { cookie, workspace } = await owner("camp-routes-create-bad");
      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspace.slug}/campaigns`,
        headers: { cookie },
        payload: { name: "", segmentId: "not-a-uuid" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("list", () => {
    it("returns the workspace's campaigns with pagination metadata", async () => {
      const { cookie, workspace } = await owner("camp-routes-list");
      const segmentId = await createSegment(cookie, workspace.slug);
      await createCampaignViaRoute(cookie, workspace.slug, segmentId, "First");
      await createCampaignViaRoute(cookie, workspace.slug, segmentId, "Second");

      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.slug}/campaigns`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);

      const body = res.json<{
        items: { name: string }[];
        total: number;
        page: number;
        pageSize: number;
      }>();
      expect(body.total).toBe(2);
      expect(body.page).toBe(1);
      expect(body.items.map((c) => c.name).sort()).toEqual(["First", "Second"]);
    });

    it("honours an explicit page size", async () => {
      const { cookie, workspace } = await owner("camp-routes-list-page");
      const segmentId = await createSegment(cookie, workspace.slug);
      await createCampaignViaRoute(cookie, workspace.slug, segmentId, "One");
      await createCampaignViaRoute(cookie, workspace.slug, segmentId, "Two");

      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.slug}/campaigns?page=1&pageSize=1`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: unknown[]; total: number; pageSize: number }>();
      expect(body.items).toHaveLength(1);
      expect(body.total).toBe(2);
      expect(body.pageSize).toBe(1);
    });

    it("rejects an out-of-range page size rather than clamping it silently", async () => {
      const { cookie, workspace } = await owner("camp-routes-list-bad");
      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.slug}/campaigns?pageSize=0`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("update", () => {
    it("applies a partial update and returns the new state", async () => {
      const { cookie, workspace } = await owner("camp-routes-patch");
      const segmentId = await createSegment(cookie, workspace.slug);
      const campaign = await createCampaignViaRoute(cookie, workspace.slug, segmentId);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}`,
        headers: { cookie },
        payload: { name: "Renamed" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ name: string }>().name).toBe("Renamed");
    });

    it("treats null as an explicit clear, per the D-09 convention", async () => {
      const { cookie, workspace } = await owner("camp-routes-patch-null");
      const segmentId = await createSegment(cookie, workspace.slug);
      const campaign = await createCampaignViaRoute(cookie, workspace.slug, segmentId);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}`,
        headers: { cookie },
        payload: { templateId: null },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ templateId: string | null }>().templateId).toBeNull();
    });

    it("rejects an invalid body", async () => {
      const { cookie, workspace } = await owner("camp-routes-patch-bad");
      const segmentId = await createSegment(cookie, workspace.slug);
      const campaign = await createCampaignViaRoute(cookie, workspace.slug, segmentId);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}`,
        headers: { cookie },
        payload: { fromEmail: "not-an-email" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("delete", () => {
    it("deletes a draft", async () => {
      const { cookie, workspace } = await owner("camp-routes-delete");
      const segmentId = await createSegment(cookie, workspace.slug);
      const campaign = await createCampaignViaRoute(cookie, workspace.slug, segmentId);

      const res = await app.inject({
        method: "DELETE",
        url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ deleted: boolean }>().deleted).toBe(true);

      const after = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}`,
        headers: { cookie },
      });
      expect(after.statusCode).toBe(404);
    });

    it("reports 404 for a campaign that is not there", async () => {
      const { cookie, workspace } = await owner("camp-routes-delete-404");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/workspaces/${workspace.slug}/campaigns/00000000-0000-0000-0000-000000000000`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("audience breakdown", () => {
    it("reports the sendable count and the exclusion breakdown", async () => {
      const { cookie, workspace } = await owner("camp-routes-audience");
      const segmentId = await createSegment(cookie, workspace.slug);
      const campaign = await createCampaignViaRoute(cookie, workspace.slug, segmentId);

      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}/audience-breakdown`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);

      const body = res.json<{ sendableCount: number; breakdown: unknown }>();
      expect(typeof body.sendableCount).toBe("number");
      expect(body.breakdown).toBeDefined();
    });

    it("reports 404 for a campaign that is not there", async () => {
      const { cookie, workspace } = await owner("camp-routes-audience-404");
      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.slug}/campaigns/00000000-0000-0000-0000-000000000000/audience-breakdown`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("test sample", () => {
    it("responds for an existing campaign", async () => {
      const { cookie, workspace } = await owner("camp-routes-sample");
      const segmentId = await createSegment(cookie, workspace.slug);
      const campaign = await createCampaignViaRoute(cookie, workspace.slug, segmentId);

      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}/test-sample`,
        headers: { cookie },
      });
      // No contacts exist in this workspace, so an empty sample is a valid
      // outcome; what is asserted is that the route resolves rather than 500s.
      expect([200, 404]).toContain(res.statusCode);
    });
  });

  describe("membership", () => {
    it("refuses a workspace the caller is not a member of", async () => {
      const a = await owner("camp-routes-tenant-a");
      const b = await owner("camp-routes-tenant-b");

      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${b.workspace.slug}/campaigns`,
        headers: { cookie: a.cookie },
      });
      expect([403, 404]).toContain(res.statusCode);
    });
  });
});
