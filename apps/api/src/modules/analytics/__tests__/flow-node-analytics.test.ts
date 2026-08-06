import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * 07-04/ANLT-02: the flow-analytics endpoint aggregates flow_run_steps by
 * node_id (across ALL flow versions a node_id appeared in, D-05) into
 * distinct-contact pass counts (Pitfall 4 -- COUNT(DISTINCT contact_id), a
 * re-entering contact must count once, not twice), plus send-node
 * sent/delivered/opened/clicked/bounced counts joined from `sends` on
 * (flow_run_id, node_id). Also asserts the IDOR double-gate: a flow id
 * belonging to another workspace 404s.
 */
describe("Flow node analytics (07-04, ANLT-02)", () => {
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

  async function createContact(cookie: string, slug: string, email: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload: { email },
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  async function createFlow(cookie: string, slug: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/flows`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create flow failed: ${res.body}`).toBe(201);
    return res.json<{ id: string }>();
  }

  const definitionV1 = {
    nodes: [
      { id: "t1", type: "trigger", triggerType: "event", eventName: "purchase", position: { x: 0, y: 0 } },
      { id: "s1", type: "send", templateId: "d-1", fromEmail: "marketing@example.com", position: { x: 100, y: 0 } },
      { id: "x1", type: "exit", position: { x: 200, y: 0 } },
    ],
    edges: [
      { id: "e1", source: "t1", target: "s1" },
      { id: "e2", source: "s1", target: "x1" },
    ],
  };

  async function publishFlow(cookie: string, slug: string, flowId: string, definition: unknown) {
    await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${slug}/flows/${flowId}`,
      headers: { cookie },
      payload: { definition },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/flows/${flowId}/publish`,
      headers: { cookie },
    });
    expect(res.statusCode, `publish failed: ${res.body}`).toBe(200);
    return res.json<{ id: string; status: string; liveVersionId: string }>();
  }

  /**
   * Directly inserts a flow_runs row -- mirrors flow-run-management.test.ts's
   * insertRun helper. `status` defaults to 'waiting'; a re-entering contact's
   * PRIOR run must be inserted as a terminal status (completed/exited) since
   * `flow_runs_one_active_per_contact` allows only one waiting/advancing run
   * per (workspace, flow, contact).
   */
  async function insertRun(
    workspaceId: string,
    flowId: string,
    flowVersionId: string,
    contactId: string,
    status: "waiting" | "advancing" | "completed" | "exited" | "ejected" = "waiting"
  ) {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO flow_runs (workspace_id, flow_id, flow_version_id, contact_id, status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [workspaceId, flowId, flowVersionId, contactId, status]
        );
        return rows[0].id;
      })
    );
  }

  /** Directly inserts a flow_run_steps row (FLOW-01 append-only node-visit log). */
  async function insertStep(
    workspaceId: string,
    flowRunId: string,
    nodeId: string,
    nodeType: string,
    outcome: string,
    sendId?: string
  ) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO flow_run_steps (workspace_id, flow_run_id, node_id, node_type, outcome, send_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [workspaceId, flowRunId, nodeId, nodeType, outcome, sendId ?? null]
        )
      )
    );
  }

  async function insertSend(
    workspaceId: string,
    contactId: string,
    flowRunId: string,
    nodeId: string,
    opts: {
      sentAt?: Date | null;
      deliveredAt?: Date | null;
      firstOpenedAt?: Date | null;
      firstClickedAt?: Date | null;
      bouncedAt?: Date | null;
    } = {}
  ): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends
             (workspace_id, contact_id, kind, status, flow_run_id, node_id, sent_at, delivered_at, first_opened_at, first_clicked_at, bounced_at)
           VALUES ($1, $2, 'flow', 'sent', $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            workspaceId,
            contactId,
            flowRunId,
            nodeId,
            opts.sentAt ?? new Date(),
            opts.deliveredAt ?? null,
            opts.firstOpenedAt ?? null,
            opts.firstClickedAt ?? null,
            opts.bouncedAt ?? null,
          ]
        );
        return rows[0].id;
      })
    );
  }

  function analyticsUrl(slug: string, flowId: string) {
    return `/api/workspaces/${slug}/flows/${flowId}/analytics`;
  }

  it("aggregates per node_id across versions with COUNT(DISTINCT contact_id), and send-node delivery counts", async () => {
    const { cookie, workspace } = await owner("flow-analytics-basic");
    const flow = await createFlow(cookie, workspace.slug, "Analytics flow");
    const v1 = await publishFlow(cookie, workspace.slug, flow.id, definitionV1);

    const contactA = await createContact(cookie, workspace.slug, `analytics-a-${Date.now()}@example.com`);
    const contactB = await createContact(cookie, workspace.slug, `analytics-b-${Date.now()}@example.com`);

    // Contact A passes through t1 -> s1 -> x1 once.
    const runA = await insertRun(workspace.id, flow.id, v1.liveVersionId, contactA.id);
    await insertStep(workspace.id, runA, "t1", "trigger", "entered");
    const sendA = await insertSend(workspace.id, contactA.id, runA, "s1", {
      deliveredAt: new Date(),
      firstOpenedAt: new Date(),
    });
    await insertStep(workspace.id, runA, "s1", "send", "sent", sendA);
    await insertStep(workspace.id, runA, "x1", "exit", "exited");

    // Contact B re-enters and passes through node s1 TWICE (re-entry,
    // Pitfall 4) -- must contribute 1 to s1's contactCount, not 2.
    const runB1 = await insertRun(workspace.id, flow.id, v1.liveVersionId, contactB.id, "completed");
    await insertStep(workspace.id, runB1, "t1", "trigger", "entered");
    const sendB1 = await insertSend(workspace.id, contactB.id, runB1, "s1", { bouncedAt: new Date() });
    await insertStep(workspace.id, runB1, "s1", "send", "sent", sendB1);

    const runB2 = await insertRun(workspace.id, flow.id, v1.liveVersionId, contactB.id);
    await insertStep(workspace.id, runB2, "t1", "trigger", "entered");
    const sendB2 = await insertSend(workspace.id, contactB.id, runB2, "s1", { deliveredAt: new Date() });
    await insertStep(workspace.id, runB2, "s1", "send", "sent", sendB2);

    const res = await app.inject({
      method: "GET",
      url: analyticsUrl(workspace.slug, flow.id),
      headers: { cookie },
    });
    expect(res.statusCode, `analytics failed: ${res.body}`).toBe(200);
    const rows = res.json<Array<{
      nodeId: string;
      nodeType: string;
      contactCount: number;
      sent?: number;
      delivered?: number;
      opened?: number;
      clicked?: number;
      bounced?: number;
    }>>();

    const t1Row = rows.find((r) => r.nodeId === "t1")!;
    expect(t1Row.contactCount).toBe(2); // contact A once, contact B once (2 distinct contacts, 3 total visits)

    const s1Row = rows.find((r) => r.nodeId === "s1")!;
    // Re-entry: contact B passed through s1 twice but is one distinct contact -- s1 total distinct = 2 (A + B).
    expect(s1Row.contactCount).toBe(2);
    expect(s1Row.sent).toBe(3);
    expect(s1Row.delivered).toBe(2);
    expect(s1Row.opened).toBe(1);
    expect(s1Row.bounced).toBe(1);

    const x1Row = rows.find((r) => r.nodeId === "x1")!;
    expect(x1Row.contactCount).toBe(1);
  });

  it("aggregates a node_id shared across two flow versions (D-05), including nodes removed from the live version", async () => {
    const { cookie, workspace } = await owner("flow-analytics-versions");
    const flow = await createFlow(cookie, workspace.slug, "Versioned flow");
    const v1 = await publishFlow(cookie, workspace.slug, flow.id, definitionV1);

    const contactA = await createContact(cookie, workspace.slug, `analytics-v1-${Date.now()}@example.com`);
    const runV1 = await insertRun(workspace.id, flow.id, v1.liveVersionId, contactA.id);
    await insertStep(workspace.id, runV1, "s1", "send", "sent");
    // v1-only node, removed in v2.
    await insertStep(workspace.id, runV1, "x1", "exit", "exited");

    // Republish with a v2 definition that drops node x1 but keeps s1 (shared node_id).
    const definitionV2 = {
      nodes: [
        { id: "t1", type: "trigger", triggerType: "event", eventName: "purchase", position: { x: 0, y: 0 } },
        { id: "s1", type: "send", templateId: "d-1", fromEmail: "marketing@example.com", position: { x: 100, y: 0 } },
        { id: "x2", type: "exit", position: { x: 200, y: 0 } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "s1" },
        { id: "e2", source: "s1", target: "x2" },
      ],
    };
    const v2 = await publishFlow(cookie, workspace.slug, flow.id, definitionV2);

    const contactB = await createContact(cookie, workspace.slug, `analytics-v2-${Date.now()}@example.com`);
    const runV2 = await insertRun(workspace.id, flow.id, v2.liveVersionId, contactB.id);
    await insertStep(workspace.id, runV2, "s1", "send", "sent");
    await insertStep(workspace.id, runV2, "x2", "exit", "exited");

    const res = await app.inject({
      method: "GET",
      url: analyticsUrl(workspace.slug, flow.id),
      headers: { cookie },
    });
    expect(res.statusCode, `analytics failed: ${res.body}`).toBe(200);
    const rows = res.json<Array<{ nodeId: string; contactCount: number }>>();

    // s1 aggregated across BOTH versions: contact A (v1) + contact B (v2).
    const s1Row = rows.find((r) => r.nodeId === "s1")!;
    expect(s1Row.contactCount).toBe(2);

    // x1 is removed from the live (v2) definition but must still be listed (D-05).
    const x1Row = rows.find((r) => r.nodeId === "x1")!;
    expect(x1Row).toBeDefined();
    expect(x1Row.contactCount).toBe(1);

    const x2Row = rows.find((r) => r.nodeId === "x2")!;
    expect(x2Row.contactCount).toBe(1);
  });

  it("404s for a flow id belonging to another workspace (IDOR double-gate)", async () => {
    const a = await owner("flow-analytics-idor-a");
    const b = await owner("flow-analytics-idor-b");
    const flowInB = await createFlow(b.cookie, b.workspace.slug, "IDOR flow");

    const res = await app.inject({
      method: "GET",
      url: analyticsUrl(a.workspace.slug, flowInB.id),
      headers: { cookie: a.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
