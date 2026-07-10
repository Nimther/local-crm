import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, member } from "@mega-crm/db";
import { buildServer } from "../../../server.js";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../../test/db-fixture.js";

/**
 * FLOW-01/FLOW-04/FLOW-05/FLOW-06/FLOW-07/D-17/D-20/D-23/D-24: the flow
 * lifecycle API end to end via real HTTP requests against a real Postgres
 * test database -- draft CRUD, atomic validated publish (server-side
 * re-validation, never a client isValid flag), pause/resume, duplicate,
 * D-20's lazy single-working-draft auto-creation on the first edit after
 * publish, D-23's Owner/Admin-only gate on publish/pause/resume, and D-24's
 * segment restrict-delete extension. Mirrors campaigns'
 * campaign-state-machine.test.ts harness.
 */
describe("Flow lifecycle (FLOW-01/06/07, D-17/D-20/D-23/D-24)", () => {
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

  /** Adds a member with an explicit role directly, mirroring role-guard.test.ts. */
  async function addMemberWithRole(organizationId: string, role: "member" | "admin" | "owner", nameSeed: string) {
    const email = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const account = await signUp(email, "correct horse battery staple 42", nameSeed);
    await db.insert(member).values({ organizationId, userId: account.userId, role });
    return account;
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

  async function createFlow(cookie: string, slug: string, name: string) {
    const res = await app.inject({
      method: "POST",
      url: `/api/workspaces/${slug}/flows`,
      headers: { cookie },
      payload: { name },
    });
    expect(res.statusCode, `create flow failed: ${res.body}`).toBe(201);
    return res.json() as {
      id: string;
      status: string;
      draftVersionId: string | null;
      liveVersionId: string | null;
    };
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

  const noTriggerDefinition = {
    nodes: [{ id: "x1", type: "exit", position: { x: 0, y: 0 } }],
    edges: [],
  };

  it("publish rejects an incomplete definition server-side (422 + fields) and succeeds once valid (D-17)", async () => {
    const { cookie, workspace } = await owner("flow-publish");
    const flow = await createFlow(cookie, workspace.slug, "Welcome series");
    expect(flow.status).toBe("draft");
    expect(flow.draftVersionId).not.toBeNull();

    const patchInvalid = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: { definition: noTriggerDefinition },
    });
    expect(patchInvalid.statusCode, `patch failed: ${patchInvalid.body}`).toBe(200);

    const publishRejected = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie },
    });
    expect(publishRejected.statusCode).toBe(422);
    const rejectedBody = publishRejected.json() as { fields: Record<string, string> };
    expect(rejectedBody.fields.trigger).toBeTruthy();

    const patchValid = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: {
        definition: validDefinition,
        reentryMode: "once_per_n_days",
        reentryWindowDays: 7,
        quietHoursMode: "custom",
        quietHoursStart: 60,
        quietHoursEnd: 480,
        exitConditions: [{ type: "event", eventName: "unsubscribed" }],
      },
    });
    expect(patchValid.statusCode, `patch failed: ${patchValid.body}`).toBe(200);
    const patched = patchValid.json() as { triggerEventName: string; reentryWindowDays: number };
    expect(patched.triggerEventName).toBe("purchase");
    expect(patched.reentryWindowDays).toBe(7);

    const published = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie },
    });
    expect(published.statusCode, `publish failed: ${published.body}`).toBe(200);
    const publishedBody = published.json() as { status: string; liveVersionId: string | null; draftVersionId: string | null };
    expect(publishedBody.status).toBe("live");
    expect(publishedBody.liveVersionId).not.toBeNull();
    // D-20: draft_version_id is cleared on publish -- the next edit lazily
    // recreates a working draft rather than one being eagerly allocated here.
    expect(publishedBody.draftVersionId).toBeNull();
  });

  it("pause/resume enforce legal transitions (live<->paused) and D-20 lazily recreates a draft on first post-publish edit", async () => {
    const { cookie, workspace } = await owner("flow-pause-resume");
    const flow = await createFlow(cookie, workspace.slug, "Onboarding");
    await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: { definition: validDefinition },
    });
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie },
    });

    const pauseAgainOnDraft = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/pause`,
      headers: { cookie },
    });
    expect(pauseAgainOnDraft.statusCode).toBe(200);
    expect((pauseAgainOnDraft.json() as { status: string }).status).toBe("paused");

    const pauseWhilePaused = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/pause`,
      headers: { cookie },
    });
    expect(pauseWhilePaused.statusCode).toBe(409);

    const resumed = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/resume`,
      headers: { cookie },
    });
    expect(resumed.statusCode).toBe(200);
    expect((resumed.json() as { status: string }).status).toBe("live");

    // D-20: after publish, draft_version_id is null -- the first edit since
    // publish must lazily create a fresh working draft from the live
    // definition.
    const getBeforeEdit = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
    });
    expect((getBeforeEdit.json() as { draftVersionId: string | null }).draftVersionId).toBeNull();

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: { name: "Onboarding v2" },
    });
    expect(renamed.statusCode, `rename failed: ${renamed.body}`).toBe(200);
    const renamedBody = renamed.json() as { draftVersionId: string | null; definition: unknown };
    expect(renamedBody.draftVersionId).not.toBeNull();
    // The lazily-created draft copies the live definition forward.
    expect((renamedBody.definition as { nodes: unknown[] }).nodes.length).toBe(3);
  });

  it("06-16/WR-04/D-18: publishing accumulated draft changes on a paused flow keeps it paused (does not silently resume)", async () => {
    const { cookie, workspace } = await owner("flow-publish-paused");
    const flow = await createFlow(cookie, workspace.slug, "Paused publish safety");

    const firstPatch = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: { definition: validDefinition },
    });
    expect(firstPatch.statusCode, `patch failed: ${firstPatch.body}`).toBe(200);

    const firstPublish = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie },
    });
    expect(firstPublish.statusCode, `publish failed: ${firstPublish.body}`).toBe(200);
    expect((firstPublish.json() as { status: string }).status).toBe("live");

    const paused = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/pause`,
      headers: { cookie },
    });
    expect(paused.statusCode, `pause failed: ${paused.body}`).toBe(200);
    expect((paused.json() as { status: string }).status).toBe("paused");

    // Editing the draft again while paused (D-20 lazily recreates a working
    // draft on the paused flow).
    const secondPatch = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: { definition: validDefinition },
    });
    expect(secondPatch.statusCode, `patch failed: ${secondPatch.body}`).toBe(200);
    expect((secondPatch.json() as { draftVersionId: string | null }).draftVersionId).not.toBeNull();

    // WR-04: publishing the accumulated draft changes on a PAUSED flow must
    // NOT silently resume enrollment/sends -- the flow stays paused (D-18/D-19).
    const secondPublish = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie },
    });
    expect(secondPublish.statusCode, `publish failed: ${secondPublish.body}`).toBe(200);
    const secondPublishBody = secondPublish.json() as {
      status: string;
      draftVersionId: string | null;
      liveVersionId: string | null;
    };
    expect(secondPublishBody.status).toBe("paused");
    expect(secondPublishBody.draftVersionId).toBeNull();
    expect(secondPublishBody.liveVersionId).not.toBeNull();
  });

  it("duplicate copies config + current definition into a fresh draft", async () => {
    const { cookie, workspace } = await owner("flow-duplicate");
    const flow = await createFlow(cookie, workspace.slug, "Cart abandon");
    await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: { definition: validDefinition, reentryMode: "once_ever" },
    });
    await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie },
    });

    const duplicated = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/duplicate`,
      headers: { cookie },
    });
    expect(duplicated.statusCode, `duplicate failed: ${duplicated.body}`).toBe(201);
    const body = duplicated.json() as {
      id: string;
      status: string;
      reentryMode: string;
      draftVersionId: string | null;
      definition: { nodes: unknown[] };
    };
    expect(body.id).not.toBe(flow.id);
    expect(body.status).toBe("draft");
    expect(body.reentryMode).toBe("once_ever");
    expect(body.draftVersionId).not.toBeNull();
    expect(body.definition.nodes.length).toBe(3);
  });

  it("D-23: publish/pause/resume are Owner/Admin-only; draft CRUD + duplicate remain Member-allowed", async () => {
    const { cookie: ownerCookie, workspace } = await owner("flow-role-gate");
    const memberAccount = await addMemberWithRole(workspace.id, "member", "flow-member");

    const created = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows`,
      headers: { cookie: memberAccount.cookie },
      payload: { name: "Member-created flow" },
    });
    expect(created.statusCode, `member create failed: ${created.body}`).toBe(201);
    const flow = created.json() as { id: string };

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie: memberAccount.cookie },
      payload: { definition: validDefinition },
    });
    expect(patched.statusCode, `member patch failed: ${patched.body}`).toBe(200);

    const memberPublish = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie: memberAccount.cookie },
    });
    expect(memberPublish.statusCode).toBe(403);

    const ownerPublish = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie: ownerCookie },
    });
    expect(ownerPublish.statusCode, `owner publish failed: ${ownerPublish.body}`).toBe(200);

    const memberPause = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/pause`,
      headers: { cookie: memberAccount.cookie },
    });
    expect(memberPause.statusCode).toBe(403);

    const memberDuplicate = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/duplicate`,
      headers: { cookie: memberAccount.cookie },
    });
    expect(memberDuplicate.statusCode, `member duplicate failed: ${memberDuplicate.body}`).toBe(201);
  });

  it("CR-03: a live flow's unpublished draft trigger edit does not change trigger_* until re-published", async () => {
    const { cookie, workspace } = await owner("flow-cr03-draft-leak");
    const flow = await createFlow(cookie, workspace.slug, "Purchase follow-up");

    // Publish an event-triggered flow (trigger event = "purchase").
    const firstPatch = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: { definition: validDefinition },
    });
    expect(firstPatch.statusCode, `patch failed: ${firstPatch.body}`).toBe(200);
    // Contrast case: a still-draft flow's PATCH reflects the new trigger
    // immediately (the draft IS the flow's trigger pre-publish).
    expect((firstPatch.json() as { triggerEventName: string | null }).triggerEventName).toBe("purchase");

    const firstPublish = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie },
    });
    expect(firstPublish.statusCode, `publish failed: ${firstPublish.body}`).toBe(200);
    expect((firstPublish.json() as { status: string; triggerEventName: string | null }).status).toBe("live");
    expect((firstPublish.json() as { triggerEventName: string | null }).triggerEventName).toBe("purchase");

    // Autosave a draft edit on the now-live flow that changes the trigger
    // event to "signup" -- this must NOT re-target live enrollment.
    const signupDefinition = {
      nodes: validDefinition.nodes.map((node) =>
        node.id === "t1" ? { ...node, eventName: "signup" } : node
      ),
      edges: validDefinition.edges,
    };
    const draftEdit = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: { definition: signupDefinition },
    });
    expect(draftEdit.statusCode, `draft edit failed: ${draftEdit.body}`).toBe(200);

    const getAfterDraftEdit = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
    });
    expect(getAfterDraftEdit.statusCode).toBe(200);
    const afterDraftEditBody = getAfterDraftEdit.json() as { triggerEventName: string | null; status: string };
    // CR-03 regression: the columns flow-trigger-evaluator/flow-segment-sweep
    // read stay pinned to "purchase" -- the unpublished draft edit did not
    // leak into live enrollment.
    expect(afterDraftEditBody.triggerEventName).toBe("purchase");
    expect(afterDraftEditBody.status).toBe("live");

    // Re-publishing promotes the draft's new trigger to be the live trigger.
    const secondPublish = await app.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}/publish`,
      headers: { cookie },
    });
    expect(secondPublish.statusCode, `re-publish failed: ${secondPublish.body}`).toBe(200);

    const getAfterRepublish = await app.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
    });
    expect((getAfterRepublish.json() as { triggerEventName: string | null }).triggerEventName).toBe("signup");
  });

  it("D-24: a segment referenced by a flow trigger cannot be deleted", async () => {
    const { cookie, workspace } = await owner("flow-segment-restrict");
    const segment = await createSegment(cookie, workspace.slug, "Restrict-delete target");
    const flow = await createFlow(cookie, workspace.slug, "Segment-triggered flow");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/${workspace.slug}/flows/${flow.id}`,
      headers: { cookie },
      payload: {
        definition: {
          nodes: [
            { id: "t1", type: "trigger", triggerType: "segment", segmentId: segment.id, position: { x: 0, y: 0 } },
            { id: "x1", type: "exit", position: { x: 100, y: 0 } },
          ],
          edges: [{ id: "e1", source: "t1", target: "x1" }],
        },
      },
    });
    expect(patched.statusCode, `patch failed: ${patched.body}`).toBe(200);
    expect((patched.json() as { triggerSegmentId: string | null }).triggerSegmentId).toBe(segment.id);

    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/workspaces/${workspace.slug}/segments/${segment.id}`,
      headers: { cookie },
    });
    expect(deleteRes.statusCode).toBe(409);
    expect((deleteRes.json() as { code: string }).code).toBe("referenced_by_flow");
  });
});
