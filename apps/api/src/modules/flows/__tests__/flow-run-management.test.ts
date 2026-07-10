import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, member } from "@mega-crm/db";
import { buildServer } from "../../../server.js";
import { withTenant, withTenantTransaction } from "../../../middleware/tenant-context.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * FLOW-06/FLOW-07/D-21/D-22/D-23: run visibility (counters + list), eject
 * (single/bulk, Owner/Admin-gated), and the D-22 delete guard -- the run
 * read-model + intervention surface this plan adds on top of 06-04's flow
 * lifecycle API. Mirrors flow-lifecycle.test.ts's real-HTTP harness.
 */
describe("Flow run management (D-21/D-22/D-23)", () => {
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
    return { cookie: `${sessionCookie.name}=${sessionCookie.value}`, userId: res.json().user.id as string };
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

  async function addMemberWithRole(organizationId: string, role: "member" | "admin" | "owner", nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    await db.insert(member).values({ organizationId, userId: account.userId, role });
    return account;
  }

  const validDefinition = {
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

  async function createFlow(cookie: string, slug: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/flows`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create flow failed: ${res.body}`).toBe(201);
    return res.json() as { id: string; status: string; draftVersionId: string | null; liveVersionId: string | null };
  }

  async function publishFlow(cookie: string, slug: string, flowId: string) {
    await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${slug}/flows/${flowId}`,
      headers: { cookie },
      payload: { definition: validDefinition },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/flows/${flowId}/publish`,
      headers: { cookie },
    });
    expect(res.statusCode, `publish failed: ${res.body}`).toBe(200);
    return res.json() as { id: string; status: string; liveVersionId: string };
  }

  async function createContact(cookie: string, slug: string, email: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/contacts`,
      headers: { cookie },
      payload: { email },
    });
    expect(res.statusCode, `create contact failed: ${res.body}`).toBe(201);
    return res.json() as { id: string };
  }

  /**
   * Directly inserts a flow_runs row (no engine trigger involved) -- the
   * run-management surface under test doesn't care how a run was created.
   * RLS (ENABLE+FORCE, 06-01) requires `app.current_workspace_id` to be set,
   * so this runs inside the same withTenant/withTenantTransaction scope the
   * repository layer itself uses (mirrors apps/worker's createFixtureFlowRun).
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
        return rows[0];
      })
    );
  }

  it("D-21: run counts + list surface active runs and how many are on old (non-live) versions", async () => {
    const { cookie, workspace } = await owner("flow-run-counts");
    const flow = await createFlow(cookie, workspace.slug, "Counts flow");
    const publishedV1 = await publishFlow(cookie, workspace.slug, flow.id);

    const contactA = await createContact(cookie, workspace.slug, "a@example.com");
    const contactB = await createContact(cookie, workspace.slug, "b@example.com");
    const contactC = await createContact(cookie, workspace.slug, "c@example.com");

    // Two runs pinned to v1.
    await insertRun(workspace.id, flow.id, publishedV1.liveVersionId, contactA.id, "waiting");
    await insertRun(workspace.id, flow.id, publishedV1.liveVersionId, contactB.id, "advancing");
    // A completed run should NOT count as active.
    await insertRun(workspace.id, flow.id, publishedV1.liveVersionId, contactC.id, "completed");

    // Re-publish so live_version_id moves to v2 -- the two in-flight runs
    // above stay pinned to v1 (FLOW-07), which is now a non-live version.
    await publishFlow(cookie, workspace.slug, flow.id);

    const runsRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/runs`,
      headers: { cookie },
    });
    expect(runsRes.statusCode, `runs list failed: ${runsRes.body}`).toBe(200);
    const body = runsRes.json() as {
      total: number;
      counts: { active: number; onOldVersions: number };
      items: Array<{ contactId: string; onOldVersion: boolean; status: string }>;
    };
    expect(body.total).toBe(3);
    expect(body.counts.active).toBe(2);
    expect(body.counts.onOldVersions).toBe(2);

    const filtered = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/runs?status=completed`,
      headers: { cookie },
    });
    const filteredBody = filtered.json() as { total: number; items: unknown[] };
    expect(filteredBody.total).toBe(1);
  });

  it("D-21/D-23: eject (single via runIds, bulk via contactIds) marks matching active runs 'ejected' and is Owner/Admin-gated", async () => {
    const { cookie: ownerCookie, workspace } = await owner("flow-eject");
    const memberAccount = await addMemberWithRole(workspace.id, "member", "flow-eject-member");
    const flow = await createFlow(ownerCookie, workspace.slug, "Eject flow");
    const published = await publishFlow(ownerCookie, workspace.slug, flow.id);

    const contactA = await createContact(ownerCookie, workspace.slug, "eject-a@example.com");
    const contactB = await createContact(ownerCookie, workspace.slug, "eject-b@example.com");
    const runA = await insertRun(workspace.id, flow.id, published.liveVersionId, contactA.id, "waiting");
    await insertRun(workspace.id, flow.id, published.liveVersionId, contactB.id, "advancing");

    const memberEject = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/runs/eject`,
      headers: { cookie: memberAccount.cookie },
      payload: { runIds: [runA.id] },
    });
    expect(memberEject.statusCode).toBe(403);

    const singleEject = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/runs/eject`,
      headers: { cookie: ownerCookie },
      payload: { runIds: [runA.id] },
    });
    expect(singleEject.statusCode, `eject failed: ${singleEject.body}`).toBe(200);
    expect((singleEject.json() as { ejected: number }).ejected).toBe(1);

    const bulkEject = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/runs/eject`,
      headers: { cookie: ownerCookie },
      payload: { contactIds: [contactB.id] },
    });
    expect(bulkEject.statusCode, `bulk eject failed: ${bulkEject.body}`).toBe(200);
    expect((bulkEject.json() as { ejected: number }).ejected).toBe(1);

    const runsRes = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/runs`,
      headers: { cookie: ownerCookie },
    });
    const body = runsRes.json() as { counts: { active: number }; items: Array<{ status: string; flowVersionId: string }> };
    expect(body.counts.active).toBe(0);
    // FLOW-07: eject never re-points flow_version_id.
    for (const run of body.items) {
      expect(run.flowVersionId).toBe(published.liveVersionId);
    }
  });

  it("D-22/D-23: delete is blocked for a live flow, blocked for paused-with-active-runs, and Owner/Admin-gated", async () => {
    const { cookie: ownerCookie, workspace } = await owner("flow-delete-guard");
    const memberAccount = await addMemberWithRole(workspace.id, "member", "flow-delete-member");
    const flow = await createFlow(ownerCookie, workspace.slug, "Delete-guard flow");
    const published = await publishFlow(ownerCookie, workspace.slug, flow.id);

    const memberDelete = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie: memberAccount.cookie },
    });
    expect(memberDelete.statusCode).toBe(403);

    const deleteLive = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(deleteLive.statusCode).toBe(409);

    const paused = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/pause`,
      headers: { cookie: ownerCookie },
    });
    expect(paused.statusCode).toBe(200);

    const contact = await createContact(ownerCookie, workspace.slug, "delete-guard@example.com");
    await insertRun(workspace.id, flow.id, published.liveVersionId, contact.id, "waiting");

    const deletePausedWithRuns = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(deletePausedWithRuns.statusCode).toBe(409);

    const ejectAll = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/runs/eject`,
      headers: { cookie: ownerCookie },
      payload: { contactIds: [contact.id] },
    });
    expect(ejectAll.statusCode, `eject failed: ${ejectAll.body}`).toBe(200);

    const deletePausedZeroActive = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie: ownerCookie },
    });
    expect(deletePausedZeroActive.statusCode, `delete failed: ${deletePausedZeroActive.body}`).toBe(200);
    expect((deletePausedZeroActive.json() as { deleted: boolean }).deleted).toBe(true);
  });

  it("D-22: a never-published draft flow is always deletable", async () => {
    const { cookie, workspace } = await owner("flow-delete-never-published");
    const flow = await createFlow(cookie, workspace.slug, "Never published");
    expect(flow.status).toBe("draft");
    expect(flow.liveVersionId).toBeNull();

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
    });
    expect(deleteRes.statusCode, `delete failed: ${deleteRes.body}`).toBe(200);
    expect((deleteRes.json() as { deleted: boolean }).deleted).toBe(true);
  });
});
