import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 07-05/ANLT-05/D-13/D-15: the workspace-wide send-log list. Each filter
 * (contact/campaign-or-flow/status multi-select/period) compiles to a
 * parameterized WHERE -- never string-interpolated (T-07-05-01) -- and the
 * computed status column (D-06 chain extended with failed/excluded) drives
 * both the response's `status` field and the multi-select filter.
 */
describe("Send log filters (07-05, ANLT-05)", () => {
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

  async function createContact(cookie: string, slug: string, payload: Record<string, unknown>) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload,
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  async function createFixtureCampaign(workspaceId: string, name: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture segment', '{}'::jsonb, 'fixture-user')
           RETURNING id`,
          [workspaceId]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, segment_id, created_by_user_id)
           VALUES ($1, $2, $3, 'fixture-user')
           RETURNING id`,
          [workspaceId, name, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
  }

  async function createFixtureFlowRun(
    workspaceId: string,
    contactId: string,
    flowName: string
  ): Promise<{ flowId: string; flowRunId: string }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, created_by_user_id)
           VALUES ($1, $2, 'fixture-user')
           RETURNING id`,
          [workspaceId, flowName]
        );
        const flowId = flowRows[0].id;
        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition)
           VALUES ($1, $2, 1, '{"nodes":[],"edges":[]}'::jsonb)
           RETURNING id`,
          [workspaceId, flowId]
        );
        const { rows: runRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_runs (workspace_id, flow_id, flow_version_id, contact_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [workspaceId, flowId, versionRows[0].id, contactId]
        );
        return { flowId, flowRunId: runRows[0].id };
      })
    );
  }

  async function insertSend(
    workspaceId: string,
    contactId: string,
    opts: {
      campaignId?: string;
      flowRunId?: string;
      nodeId?: string;
      status?: "dispatching" | "sent" | "failed" | "excluded";
      sentAt?: Date;
      queuedAt?: Date;
      deliveredAt?: Date;
      bouncedAt?: Date;
      bounceReason?: string;
      exclusionReason?: string;
    } = {}
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends
             (workspace_id, contact_id, campaign_id, flow_run_id, node_id, kind, status,
              queued_at, sent_at, delivered_at, bounced_at, bounce_reason, exclusion_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           RETURNING id`,
          [
            workspaceId,
            contactId,
            opts.campaignId ?? null,
            opts.flowRunId ?? null,
            opts.nodeId ?? null,
            opts.flowRunId ? "flow" : "campaign",
            opts.status ?? "sent",
            opts.queuedAt ?? new Date(),
            opts.sentAt ?? null,
            opts.deliveredAt ?? null,
            opts.bouncedAt ?? null,
            opts.bounceReason ?? null,
            opts.exclusionReason ?? null,
          ]
        );
        return rows[0].id;
      })
    );
  }

  function sendLogUrl(slug: string, query?: string) {
    return `/api/workspaces/${slug}/send-log${query ? `?${query}` : ""}`;
  }

  it("filters by contactId via a bound parameter", async () => {
    const { cookie, workspace } = await owner("sendlog-contact");
    const contactA = await createContact(cookie, workspace.slug, { email: `a-${Date.now()}@example.com` });
    const contactB = await createContact(cookie, workspace.slug, { email: `b-${Date.now()}@example.com` });

    await insertSend(workspace.id, contactA.id, { sentAt: new Date() });
    await insertSend(workspace.id, contactB.id, { sentAt: new Date() });

    const res = await app.inject({
      method: "GET",
      url: sendLogUrl(workspace.slug, `contactId=${contactA.id}`),
      headers: { cookie },
    });
    expect(res.statusCode, `send-log failed: ${res.body}`).toBe(200);
    const body = res.json<{ items: Array<{ contactId: string }>; total: number }>();
    expect(body.total).toBe(1);
    expect(body.items[0].contactId).toBe(contactA.id);
  });

  it("filters by campaignOrFlowId across BOTH a direct campaign send and a flow-run send whose flow_id matches", async () => {
    const { cookie, workspace } = await owner("sendlog-campflow");
    const contact = await createContact(cookie, workspace.slug, { email: `campflow-${Date.now()}@example.com` });

    const campaignId = await createFixtureCampaign(workspace.id, "Fixture campaign");
    const { flowId, flowRunId } = await createFixtureFlowRun(workspace.id, contact.id, "Fixture flow");

    await insertSend(workspace.id, contact.id, { campaignId, sentAt: new Date() });
    await insertSend(workspace.id, contact.id, { flowRunId, nodeId: "node-1", sentAt: new Date() });
    // Noise: a send belonging to neither.
    await insertSend(workspace.id, contact.id, { sentAt: new Date() });

    const byCampaign = await app.inject({
      method: "GET",
      url: sendLogUrl(workspace.slug, `campaignOrFlowId=${campaignId}`),
      headers: { cookie },
    });
    expect(byCampaign.statusCode, `send-log failed: ${byCampaign.body}`).toBe(200);
    expect((byCampaign.json<{ total: number }>()).total).toBe(1);

    const byFlow = await app.inject({
      method: "GET",
      url: sendLogUrl(workspace.slug, `campaignOrFlowId=${flowId}`),
      headers: { cookie },
    });
    expect(byFlow.statusCode, `send-log failed: ${byFlow.body}`).toBe(200);
    const flowBody = byFlow.json<{ total: number; items: Array<{ flowRunId: string | null }> }>();
    expect(flowBody.total).toBe(1);
    expect(flowBody.items[0].flowRunId).toBe(flowRunId);
  });

  it("computes the D-06 chain + failed/excluded and the status multi-select filters on that computed value", async () => {
    const { cookie, workspace } = await owner("sendlog-status");
    const contact = await createContact(cookie, workspace.slug, { email: `status-${Date.now()}@example.com` });

    const deliveredId = await insertSend(workspace.id, contact.id, { sentAt: new Date(), deliveredAt: new Date() });
    const bouncedId = await insertSend(workspace.id, contact.id, {
      sentAt: new Date(),
      bouncedAt: new Date(),
      bounceReason: "mailbox_full",
    });
    const failedId = await insertSend(workspace.id, contact.id, { status: "failed", queuedAt: new Date() });
    const excludedId = await insertSend(workspace.id, contact.id, {
      status: "excluded",
      exclusionReason: "suppressed",
      queuedAt: new Date(),
    });

    const all = await app.inject({ method: "GET", url: sendLogUrl(workspace.slug), headers: { cookie } });
    expect(all.statusCode, `send-log failed: ${all.body}`).toBe(200);
    const allBody = all.json<{ items: Array<{ id: string; status: string }> }>();
    const byId = new Map(allBody.items.map((i) => [i.id, i.status]));
    expect(byId.get(deliveredId)).toBe("delivered");
    expect(byId.get(bouncedId)).toBe("bounced");
    expect(byId.get(failedId)).toBe("failed");
    expect(byId.get(excludedId)).toBe("excluded");

    // Multi-select: failed + excluded only.
    const filtered = await app.inject({
      method: "GET",
      url: sendLogUrl(workspace.slug, "status=failed&status=excluded"),
      headers: { cookie },
    });
    expect(filtered.statusCode, `send-log failed: ${filtered.body}`).toBe(200);
    const filteredBody = filtered.json<{ items: Array<{ id: string }>; total: number }>();
    expect(filteredBody.total).toBe(2);
    expect(new Set(filteredBody.items.map((i) => i.id))).toEqual(new Set([failedId, excludedId]));
  });

  it("filters by period (a bound now() - interval window), excluding an old send", async () => {
    const { cookie, workspace } = await owner("sendlog-period");
    const contact = await createContact(cookie, workspace.slug, { email: `period-${Date.now()}@example.com` });

    const recentId = await insertSend(workspace.id, contact.id, { sentAt: new Date() });
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100);
    const oldId = await insertSend(workspace.id, contact.id, { sentAt: oldDate, queuedAt: oldDate });

    const res = await app.inject({
      method: "GET",
      url: sendLogUrl(workspace.slug, "period=30"),
      headers: { cookie },
    });
    expect(res.statusCode, `send-log failed: ${res.body}`).toBe(200);
    const body = res.json<{ items: Array<{ id: string }>; total: number }>();
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(recentId);
    expect(body.items.some((i) => i.id === oldId)).toBe(false);
  });

  it("keeps an adversarial status filter value bound (rejects it as a 400, never interpolates it into SQL)", async () => {
    const { cookie, workspace } = await owner("sendlog-adversarial");

    const res = await app.inject({
      method: "GET",
      url: sendLogUrl(workspace.slug, `status=${encodeURIComponent("'; DROP TABLE sends; --")}`),
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a malformed period as a 400", async () => {
    const { cookie, workspace } = await owner("sendlog-badperiod");

    const res = await app.inject({
      method: "GET",
      url: sendLogUrl(workspace.slug, "period=45"),
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });
});
