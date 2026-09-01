import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { encryptTenantSecret } from "@mega-crm/kms";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";
import { emailBroadcastQueue } from "../campaign-queues.js";

/**
 * CR-02 gap-closure (CAMP-01/02/04): the campaign builder only ever writes
 * `fromSenderId` (a numeric SendGrid verified-sender id, stored as a
 * string) -- nothing resolves it to `campaigns.from_email`, which the
 * dispatch worker (send-dispatch.ts:155) hard-requires for both
 * `kind='campaign'` and `kind='test'`. This test drives the real HTTP
 * launch/schedule/test-send routes against a campaign created with ONLY
 * fromSenderId (no fromEmail) and asserts the persisted from_email, with
 * SendGrid's own `/v3/scopes` + `/v3/verified_senders` endpoints stubbed via
 * `vi.stubGlobal("fetch", ...)` -- the real network is never touched.
 *
 * RED (this plan's Task 1): fails because nothing resolves fromSenderId yet
 * -- from_email stays null after launch/test-send.
 * GREEN (Task 2): resolveCampaignFromEmail wired into launch/schedule/
 * test-send makes this pass.
 */
describe("Campaign sender resolution (CR-02, CAMP-01/02/04)", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  const VERIFIED_SENDER_ID = 98765;
  const VERIFIED_SENDER_EMAIL = "verified@sender.test";
  const VERIFIED_SENDER_FROM_NAME = "Verified Sender Name";
  const VERIFIED_SENDER_NICKNAME = "Internal account label";
  const UNKNOWN_SENDER_ID = "00000";

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    app = await buildServer();
    await app.ready();
  });

  afterEach(() => {
    // Restore the real global fetch after every test that stubbed it, so a
    // stub leak never bleeds into an unrelated test/file.
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  afterAll(async () => {
    await app.close();
  });

  const realFetch = globalThis.fetch;

  function stubSendGridFetch(): void {
    // eslint-disable-next-line @typescript-eslint/require-await -- test double: the signature must match the async function it replaces at the DI seam; a stub having nothing to await is the point
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      // Request has no meaningful toString() — it stringifies to
      // "[object Request]", which would silently match none of the URL
      // branches below and route every call to the unexpected-call throw.
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

      if (url.includes("/v3/scopes")) {
        return new Response(JSON.stringify({ scopes: ["mail.send"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/v3/verified_senders")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: VERIFIED_SENDER_ID,
                from_email: VERIFIED_SENDER_EMAIL,
                from_name: VERIFIED_SENDER_FROM_NAME,
                nickname: VERIFIED_SENDER_NICKNAME,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`sender-resolution.test.ts: unexpected fetch to ${url} (init: ${JSON.stringify(init)})`);
    });
  }

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

  // workspace_sendgrid_keys carries ENABLE + FORCE ROW LEVEL SECURITY --
  // fixture inserts MUST run inside withTenant/withTenantTransaction
  // (send-dispatch-idempotency.test.ts's connectFixtureSendgridKey pattern).
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

  async function createCampaign(
    cookie: string,
    slug: string,
    body: { name: string; segmentId: string; templateId?: string | null; fromSenderId?: string | null }
  ) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/campaigns`,
      headers: { cookie },
      payload: body,
    });
    expect(res.statusCode, `create campaign failed: ${res.body}`).toBe(201);
    return res.json<{
      id: string;
      fromEmail: string | null;
      fromName: string | null;
      fromSenderId: string | null;
    }>();
  }

  async function getCampaign(cookie: string, slug: string, id: string) {
    const res = await app.inject({
      method: "GET",
      url: `/api/workspaces/${slug}/campaigns/${id}`,
      headers: { cookie },
    });
    expect(res.statusCode, `get campaign failed: ${res.body}`).toBe(200);
    return res.json<{
      id: string;
      fromEmail: string | null;
      fromName: string | null;
      fromSenderId: string | null;
    }>();
  }

  it("launch resolves a fromSenderId-only campaign to its verified sender email and persists it", async () => {
    stubSendGridFetch();
    const { cookie, workspace } = await owner("sender-resolve-launch");
    await connectFixtureSendgridKey(workspace.id);
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await createCampaign(cookie, workspace.slug, {
      name: "Launch with sender id only",
      segmentId: segment.id,
      templateId: "d-test-1",
      fromSenderId: String(VERIFIED_SENDER_ID),
    });
    expect(campaign.fromEmail).toBeNull();
    expect(campaign.fromName).toBeNull();

    const launchRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}/launch`,
      headers: { cookie },
      // TMPL-02/RESEARCH Pitfall #1 regression: the version echoed back is
      // the campaign's own first-read version (1) -- sender resolution no
      // longer performs its own write ahead of this locked check, so this
      // primary (non-fallback) sender path must succeed on the FIRST
      // attempt, not 409 with a spuriously-already-stale version.
      payload: { expectedVersion: 1 },
    });
    expect(launchRes.statusCode, `launch failed: ${launchRes.body}`).toBe(200);
    const launchBody = launchRes.json<{
      fromEmail: string | null;
      fromName: string | null;
      status: string;
      version: number;
    }>();
    expect(launchBody.fromEmail).toBe(VERIFIED_SENDER_EMAIL);
    expect(launchBody.fromName).toBe(VERIFIED_SENDER_FROM_NAME);
    expect(launchBody.fromName).not.toBe(VERIFIED_SENDER_NICKNAME);
    expect(launchBody.status).toBe("sending");
    expect(launchBody.version).toBe(2);

    const persisted = await getCampaign(cookie, workspace.slug, campaign.id);
    expect(persisted.fromEmail).toBe(VERIFIED_SENDER_EMAIL);
    expect(persisted.fromName).toBe(VERIFIED_SENDER_FROM_NAME);
  });

  it("schedule resolves and persists the verified sender's real From Name", async () => {
    stubSendGridFetch();
    const { cookie, workspace } = await owner("sender-resolve-schedule");
    await connectFixtureSendgridKey(workspace.id);
    const segment = await createSegment(cookie, workspace.slug, "All contacts");
    const campaign = await createCampaign(cookie, workspace.slug, {
      name: "Schedule with sender id only",
      segmentId: segment.id,
      templateId: "d-test-1",
      fromSenderId: String(VERIFIED_SENDER_ID),
    });

    const scheduleRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}/schedule`,
      headers: { cookie },
      payload: {
        scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        expectedVersion: 1,
      },
    });
    expect(scheduleRes.statusCode, `schedule failed: ${scheduleRes.body}`).toBe(200);
    const body = scheduleRes.json<{ fromEmail: string | null; fromName: string | null }>();
    expect(body.fromEmail).toBe(VERIFIED_SENDER_EMAIL);
    expect(body.fromName).toBe(VERIFIED_SENDER_FROM_NAME);
    expect(body.fromName).not.toBe(VERIFIED_SENDER_NICKNAME);

    const persisted = await getCampaign(cookie, workspace.slug, campaign.id);
    expect(persisted.fromName).toBe(VERIFIED_SENDER_FROM_NAME);
  });

  it("test-send resolves a fromSenderId-only campaign to its verified sender email and persists it", async () => {
    stubSendGridFetch();
    const { cookie, workspace } = await owner("sender-resolve-test-send");
    await connectFixtureSendgridKey(workspace.id);
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await createCampaign(cookie, workspace.slug, {
      name: "Test-send with sender id only",
      segmentId: segment.id,
      templateId: "d-test-1",
      fromSenderId: String(VERIFIED_SENDER_ID),
    });
    expect(campaign.fromEmail).toBeNull();
    expect(campaign.fromName).toBeNull();

    const testSendRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}/test-send`,
      headers: { cookie },
      // TMPL-03/D-11: test-send now requires the same expectedVersion
      // precondition as launch -- echoing the campaign's own first-read
      // version (1), same reasoning as the launch case above.
      payload: { expectedVersion: 1 },
    });
    expect(testSendRes.statusCode, `test-send failed: ${testSendRes.body}`).toBe(202);

    const persisted = await getCampaign(cookie, workspace.slug, campaign.id);
    expect(persisted.fromEmail).toBe(VERIFIED_SENDER_EMAIL);
    expect(persisted.fromName).toBe(VERIFIED_SENDER_FROM_NAME);

    const jobs = await emailBroadcastQueue.getJobs(["waiting", "delayed", "prioritized", "paused"]);
    const queued = jobs.find((job) => job.data.campaignId === campaign.id);
    expect(queued?.data.fromName).toBe(VERIFIED_SENDER_FROM_NAME);
    expect(queued?.data.fromName).not.toBe(VERIFIED_SENDER_NICKNAME);
  });

  it("launch fails with 422 when fromSenderId does not match any verified sender", async () => {
    stubSendGridFetch();
    const { cookie, workspace } = await owner("sender-resolve-launch-unknown");
    await connectFixtureSendgridKey(workspace.id);
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await createCampaign(cookie, workspace.slug, {
      name: "Launch with unresolvable sender",
      segmentId: segment.id,
      templateId: "d-test-1",
      fromSenderId: UNKNOWN_SENDER_ID,
    });

    const launchRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}/launch`,
      headers: { cookie },
      payload: { expectedVersion: 1 },
    });
    expect(launchRes.statusCode, `expected 422, got ${launchRes.statusCode}: ${launchRes.body}`).toBe(422);
    const body = launchRes.json<{ error?: string; fields?: Record<string, string> }>();
    expect(body.fields?.sender ?? body.error).toBeTruthy();
  });

  it("test-send fails with 422 when fromSenderId does not match any verified sender", async () => {
    stubSendGridFetch();
    const { cookie, workspace } = await owner("sender-resolve-test-send-unknown");
    await connectFixtureSendgridKey(workspace.id);
    const segment = await createSegment(cookie, workspace.slug, "All contacts");

    const campaign = await createCampaign(cookie, workspace.slug, {
      name: "Test-send with unresolvable sender",
      segmentId: segment.id,
      templateId: "d-test-1",
      fromSenderId: UNKNOWN_SENDER_ID,
    });

    const testSendRes = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/campaigns/${campaign.id}/test-send`,
      headers: { cookie },
      // TMPL-03/D-11: same required precondition as above.
      payload: { expectedVersion: 1 },
    });
    expect(
      testSendRes.statusCode,
      `expected 422, got ${testSendRes.statusCode}: ${testSendRes.body}`
    ).toBe(422);
    const body = testSendRes.json<{ error?: string; fields?: Record<string, string> }>();
    expect(body.fields?.sender ?? body.error).toBeTruthy();
  });
});
