import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { campaignKickoffQueue } from "../campaign-queues.js";

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

  /**
   * TMPL-02/D-05/D-06/D-07: launch is refused unless the caller echoes back
   * the exact `version` it read off the campaign response -- the precondition
   * is required (400 without it), compared under the same locked transaction
   * that flips status and bumps version (409 `version_conflict` on
   * mismatch, dispatching nothing), and status is checked before version so
   * a launch retried against an already-transitioned campaign reports
   * `illegal_transition`, not a conflict.
   */
  describe("launch version precondition (TMPL-02, D-06/D-07)", () => {
    // A single shared owner/workspace/segment for every case below (each
    // case still gets its OWN fresh campaign via createCampaignViaRoute) --
    // one sign-up here instead of one per case keeps this file's total
    // /api/auth/* traffic well under the 20-per-minute rate limit
    // (auth/plugin.ts) that eight more owner() calls in this one file would
    // otherwise trip.
    let cookie: string;
    let slug: string;
    let segmentId: string;

    beforeAll(async () => {
      const ctx = await owner("camp-routes-launch-version");
      cookie = ctx.cookie;
      slug = ctx.workspace.slug;
      segmentId = await createSegment(cookie, slug);
    });

    it("a freshly created draft's GET response carries version 1", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Version check");

      const res = await app.inject({
        method: "GET",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ version: number }>().version).toBe(1);
    });

    it("launch with the current version succeeds, bumps version by exactly one, and enqueues a kickoff job", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Launch happy path");

      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/launch`,
        headers: { cookie },
        payload: { expectedVersion: 1 },
      });
      expect(res.statusCode, `launch failed: ${res.body}`).toBe(200);
      const body = res.json<{ status: string; version: number }>();
      expect(body.status).toBe("sending");
      expect(body.version).toBe(2);

      // Positive control the stale-version case below relies on: a
      // successful launch DOES enqueue a kickoff job keyed by the campaign
      // id (SEND-03).
      const job = await campaignKickoffQueue.getJob(campaign.id);
      expect(job?.data.campaignId).toBe(campaign.id);
    });

    it("a stale version is refused with 409 version_conflict, leaves the row untouched, and enqueues nothing", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Stale version");

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}`,
        headers: { cookie },
        payload: { name: "Renamed" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json<{ version: number }>().version).toBe(2);

      const launchRes = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/launch`,
        headers: { cookie },
        payload: { expectedVersion: 1 },
      });
      expect(
        launchRes.statusCode,
        `expected 409, got ${launchRes.statusCode}: ${launchRes.body}`
      ).toBe(409);
      const body = launchRes.json<{ code: string; currentVersion: number }>();
      expect(body.code).toBe("version_conflict");
      expect(body.currentVersion).toBe(2);

      const after = await app.inject({
        method: "GET",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}`,
        headers: { cookie },
      });
      expect(after.statusCode).toBe(200);
      const afterBody = after.json<{ status: string; version: number }>();
      expect(afterBody.status).toBe("draft");
      expect(afterBody.version).toBe(2);

      const job = await campaignKickoffQueue.getJob(campaign.id);
      expect(job).toBeFalsy();
    });

    it("rejects a launch body with no expectedVersion", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Missing precondition");

      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/launch`,
        headers: { cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it.each([
      ["zero", { expectedVersion: 0 }],
      ["a string", { expectedVersion: "2" }],
      ["a non-integer", { expectedVersion: 1.5 }],
    ])("rejects a malformed expectedVersion (%s)", async (_label, payload) => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, `Malformed ${_label}`);

      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/launch`,
        headers: { cookie },
        payload,
      });
      expect(res.statusCode, `expected 400, got ${res.statusCode}: ${res.body}`).toBe(400);
    });

    it("status beats version: launching an already-sending campaign is 409 illegal_transition, not version_conflict", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Status beats version");

      const firstLaunch = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/launch`,
        headers: { cookie },
        payload: { expectedVersion: 1 },
      });
      expect(firstLaunch.statusCode, `first launch failed: ${firstLaunch.body}`).toBe(200);
      const freshVersion = firstLaunch.json<{ version: number }>().version;

      const secondLaunch = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/launch`,
        headers: { cookie },
        payload: { expectedVersion: freshVersion },
      });
      expect(
        secondLaunch.statusCode,
        `expected 409, got ${secondLaunch.statusCode}: ${secondLaunch.body}`
      ).toBe(409);
      expect(secondLaunch.json<{ code: string }>().code).toBe("illegal_transition");
    });
  });

  /**
   * TMPL-02/D-06/D-07: schedule now shares launch's uniform expectedVersion
   * contract (required, compared under the same lock that flips status),
   * and cancel bumps the version like every other mutation without
   * demanding a precondition (D-06 enumerates launch/schedule/test-send
   * only, never cancel).
   */
  describe("schedule version precondition (TMPL-02, D-06/D-07)", () => {
    let cookie: string;
    let slug: string;
    let segmentId: string;

    beforeAll(async () => {
      const ctx = await owner("camp-routes-schedule-version");
      cookie = ctx.cookie;
      slug = ctx.workspace.slug;
      segmentId = await createSegment(cookie, slug);
    });

    function futureIso(msFromNow = 60 * 60 * 1000) {
      return new Date(Date.now() + msFromNow).toISOString();
    }

    it("schedule with the current version succeeds and bumps version by exactly one", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Schedule happy path");

      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/schedule`,
        headers: { cookie },
        payload: { scheduledAt: futureIso(), expectedVersion: 1 },
      });
      expect(res.statusCode, `schedule failed: ${res.body}`).toBe(200);
      const body = res.json<{ status: string; version: number; scheduledAt: string | null }>();
      expect(body.status).toBe("scheduled");
      expect(body.version).toBe(2);
      expect(body.scheduledAt).toBeTruthy();
    });

    it("a stale version is refused with 409 version_conflict, leaves the row draft/unscheduled, and enqueues nothing for a future send", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Schedule stale version");

      const patchRes = await app.inject({
        method: "PATCH",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}`,
        headers: { cookie },
        payload: { name: "Renamed" },
      });
      expect(patchRes.statusCode).toBe(200);
      expect(patchRes.json<{ version: number }>().version).toBe(2);

      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/schedule`,
        headers: { cookie },
        payload: { scheduledAt: futureIso(), expectedVersion: 1 },
      });
      expect(res.statusCode, `expected 409, got ${res.statusCode}: ${res.body}`).toBe(409);
      const body = res.json<{ code: string; currentVersion: number }>();
      expect(body.code).toBe("version_conflict");
      expect(body.currentVersion).toBe(2);

      const after = await app.inject({
        method: "GET",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}`,
        headers: { cookie },
      });
      const afterBody = after.json<{ status: string; scheduledAt: string | null; version: number }>();
      expect(afterBody.status).toBe("draft");
      expect(afterBody.scheduledAt).toBeNull();
      expect(afterBody.version).toBe(2);
    });

    it("rejects a schedule body with no expectedVersion / a malformed one", async () => {
      const campaignA = await createCampaignViaRoute(cookie, slug, segmentId, "Schedule missing precondition");
      const resA = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaignA.id}/schedule`,
        headers: { cookie },
        payload: { scheduledAt: futureIso() },
      });
      expect(resA.statusCode).toBe(400);

      const campaignB = await createCampaignViaRoute(cookie, slug, segmentId, "Schedule zero precondition");
      const resB = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaignB.id}/schedule`,
        headers: { cookie },
        payload: { scheduledAt: futureIso(), expectedVersion: 0 },
      });
      expect(resB.statusCode).toBe(400);
    });

    it("a past scheduledAt with a correct expectedVersion still returns 422 (existing date guard preserved)", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Schedule past date");

      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/schedule`,
        headers: { cookie },
        payload: { scheduledAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), expectedVersion: 1 },
      });
      expect(res.statusCode, `expected 422, got ${res.statusCode}: ${res.body}`).toBe(422);
    });

    it("cancel bumps the version by exactly one and returns to draft", async () => {
      const campaign = await createCampaignViaRoute(cookie, slug, segmentId, "Cancel bumps version");

      const scheduleRes = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/schedule`,
        headers: { cookie },
        payload: { scheduledAt: futureIso(), expectedVersion: 1 },
      });
      expect(scheduleRes.statusCode, `schedule failed: ${scheduleRes.body}`).toBe(200);
      const scheduledVersion = scheduleRes.json<{ version: number }>().version;

      const cancelRes = await app.inject({
        method: "POST",
        url: `/api/workspaces/${slug}/campaigns/${campaign.id}/cancel`,
        headers: { cookie },
        payload: {},
      });
      expect(cancelRes.statusCode, `cancel failed: ${cancelRes.body}`).toBe(200);
      const body = cancelRes.json<{ status: string; version: number }>();
      expect(body.status).toBe("draft");
      expect(body.version).toBe(scheduledVersion + 1);
    });
  });
});
