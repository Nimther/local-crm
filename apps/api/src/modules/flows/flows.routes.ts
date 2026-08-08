import type { FastifyInstance } from "fastify";
import {
  createFlowSchema,
  flowListQuerySchema,
  flowRunEjectSchema,
  flowRunListQuerySchema,
  publishFlowSchema,
  updateFlowDraftSchema,
} from "@mega-crm/shared-schemas";
import type { FlowDefinition } from "@mega-crm/flows-core";
import { auth } from "../auth/auth.js";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug } from "../tenancy/workspace-lookup.js";
import { resolveWorkspaceMember, NOT_FOUND_BODY } from "../tenancy/resolve-workspace-member.js";
import { getSegment, countSegmentMembers } from "../segments/segment.repository.js";
import {
  FlowStateError,
  createFlow,
  deleteFlow,
  duplicateFlow,
  getFlow,
  listFlows,
  pauseFlow,
  publishFlow,
  resumeFlow,
  updateFlowDraft,
  type FlowRow,
} from "./flow.repository.js";
import { getPinnedVersion } from "./flow-version.repository.js";
import { ejectRuns, listRuns, type FlowRunRow } from "./flow-run.repository.js";
import { shapeFlowValidationFields } from "./flow-validation.js";
import { flowEnrollExistingQueue } from "./flow-queues.js";

/**
 * Maps a FlowStateError to its HTTP status (D-06/D-18/D-17): `not_found`->404,
 * `illegal_transition`->409 (locked state machine rejected the transition),
 * `incomplete`->422 with the D-17 hard-error `fields` breakdown (only ever
 * thrown by publishFlow). Returns `null` for any other error so the caller
 * re-throws (never swallows an unrelated bug) -- mirrors
 * campaigns.routes.ts's `mapCampaignStateError`.
 */
function mapFlowStateError(err: unknown): { code: number; body: Record<string, unknown> } | null {
  if (!(err instanceof FlowStateError)) return null;
  if (err.code === "not_found") {
    return { code: 404, body: { error: "Flow not found" } };
  }
  if (err.code === "illegal_transition") {
    return { code: 409, body: { error: err.message } };
  }
  return {
    code: 422,
    body: { error: err.message, fields: err.details ? shapeFlowValidationFields(err.details) : {} },
  };
}

async function toFlowResponse(row: FlowRow) {
  // Best-current-editable-definition contract: the working draft if one
  // exists, else the live published definition, else an empty graph (a
  // brand-new flow always has a draft, so this only matters transiently).
  const versionId = row.draftVersionId ?? row.liveVersionId;
  let definition: FlowDefinition = { nodes: [], edges: [] };
  if (versionId) {
    const version = await getPinnedVersion(versionId);
    if (version) definition = version.definition;
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    status: row.status,
    triggerType: row.triggerType,
    triggerEventName: row.triggerEventName,
    triggerSegmentId: row.triggerSegmentId,
    draftVersionId: row.draftVersionId,
    liveVersionId: row.liveVersionId,
    reentryMode: row.reentryMode,
    reentryWindowDays: row.reentryWindowDays,
    quietHoursMode: row.quietHoursMode,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    exitConditions: row.exitConditions,
    definition,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** D-21: per-run shape for GET /flows/:id/runs -- the contact display fields + the onOldVersion flag (FLOW-07 immutability made visible). */
function toFlowRunSummaryResponse(row: FlowRunRow) {
  return {
    id: row.id,
    flowId: row.flowId,
    flowVersionId: row.flowVersionId,
    contactId: row.contactId,
    contactEmail: row.contactEmail,
    contactFirstName: row.contactFirstName,
    contactLastName: row.contactLastName,
    status: row.status,
    currentNodeId: row.currentNodeId,
    onOldVersion: row.onOldVersion,
    nextWakeAt: row.nextWakeAt ? row.nextWakeAt.toISOString() : null,
    enteredAt: row.enteredAt.toISOString(),
    lastEntryAt: row.lastEntryAt.toISOString(),
    exitedAt: row.exitedAt ? row.exitedAt.toISOString() : null,
    exitReason: row.exitReason,
  };
}

/**
 * Flow lifecycle API (FLOW-01/FLOW-04/FLOW-05/FLOW-06/FLOW-07). Ordinary
 * workspace membership is sufficient for create/list/read/draft-update and
 * duplicate -- publish/pause/resume are Owner/Admin-only (D-23) via
 * `requirePermission("flow", "publish")`, the sole action reserved on the
 * `flow` resource (01-01).
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerFlowsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/flows", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = flowListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    // NOTE: toFlowResponse's definition-fetch (getPinnedVersion) itself needs
    // ambient tenant context -- it MUST run inside the same withTenant scope
    // as the repository call, never after it resolves (AsyncLocalStorage
    // exits the moment withTenant's callback promise settles).
    const body = await withTenant(workspace.id, async () => {
      const result = await listFlows(parsed.data);
      return {
        items: await Promise.all(result.items.map(toFlowResponse)),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      };
    });
    return reply.send(body);
  });

  fastify.post("/api/workspaces/:slug/flows", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = createFlowSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
    if (!session) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    const created = await withTenant(workspace.id, async () => {
      const flow = await createFlow({ name: parsed.data.name, createdByUserId: session.user.id });
      return toFlowResponse(flow);
    });
    return reply.code(201).send(created);
  });

  fastify.get("/api/workspaces/:slug/flows/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const body = await withTenant(workspace.id, async () => {
      const flow = await getFlow(id);
      return flow ? toFlowResponse(flow) : null;
    });
    if (!body) {
      return reply.code(404).send({ error: "Flow not found" });
    }
    return reply.send(body);
  });

  fastify.patch("/api/workspaces/:slug/flows/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = updateFlowDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    try {
      const body = await withTenant(workspace.id, async () => {
        const updated = await updateFlowDraft(id, parsed.data);
        return toFlowResponse(updated);
      });
      return reply.send(body);
    } catch (err) {
      const mapped = mapFlowStateError(err);
      if (mapped) return reply.code(mapped.code).send(mapped.body);
      throw err;
    }
  });

  // D-04: "~N contacts" preview for a segment-triggered flow's publish
  // dialog. Meaningful only when the flow is currently segment-triggered
  // (triggerType/triggerSegmentId are synced onto the flows row by
  // updateFlowDraft whenever the draft definition changes) -- returns 400
  // for an event-triggered (or not-yet-configured) flow.
  fastify.get("/api/workspaces/:slug/flows/:id/enroll-preview", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const body = await withTenant(workspace.id, async () => {
      const flow = await getFlow(id);
      if (!flow) return { status: 404 as const };
      if (flow.triggerType !== "segment" || !flow.triggerSegmentId) {
        return { status: 400 as const };
      }
      const segment = await getSegment(flow.triggerSegmentId);
      if (!segment) return { status: 400 as const };
      const count = await countSegmentMembers(segment.definition);
      return { status: 200 as const, count };
    });

    if (body.status === 404) {
      return reply.code(404).send({ error: "Flow not found" });
    }
    if (body.status === 400) {
      return reply.code(400).send({ error: "Flow is not segment-triggered" });
    }
    return reply.send({ count: body.count });
  });

  // D-23: publish/pause/resume are Owner/Admin-only.
  fastify.post(
    "/api/workspaces/:slug/flows/:id/publish",
    { preHandler: requirePermission("flow", "publish") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const parsed = publishFlowSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      try {
        const enrollExisting = parsed.data.enrollExisting ?? false;
        const body = await withTenant(workspace.id, async () => {
          const result = await publishFlow(id, { enrollExisting });

          // D-04/06-18(CR-02): the enroll-existing choice only ever applies
          // to a segment-triggered flow -- an event-triggered flow's publish
          // never touches the membership snapshot at all. The
          // enrollExisting=false (seed-only) branch is now performed
          // ATOMICALLY inside publishFlow's own transaction (see
          // flow.repository.ts), so the route enqueues the async
          // flowEnrollExistingQueue job ONLY for the enrollExisting=true
          // (resumable batch back-fill) case -- removing the async-job
          // race/job-loss window entirely for the false case.
          if (result.segmentTriggered && result.triggerSegmentId && enrollExisting) {
            await flowEnrollExistingQueue.add(
              "enroll-existing",
              {
                workspaceId: workspace.id,
                flowId: result.flow.id,
                flowVersionId: result.flow.liveVersionId as string,
                enrollExisting: true,
              },
              { jobId: `${result.flow.id}-${result.flow.liveVersionId}-enroll-existing` }
            );
          }

          return toFlowResponse(result.flow);
        });
        return reply.send(body);
      } catch (err) {
        const mapped = mapFlowStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/flows/:id/pause",
    { preHandler: requirePermission("flow", "publish") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      try {
        const body = await withTenant(workspace.id, async () => {
          const paused = await pauseFlow(id);
          return toFlowResponse(paused);
        });
        return reply.send(body);
      } catch (err) {
        const mapped = mapFlowStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  fastify.post(
    "/api/workspaces/:slug/flows/:id/resume",
    { preHandler: requirePermission("flow", "publish") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      try {
        const body = await withTenant(workspace.id, async () => {
          const resumed = await resumeFlow(id);
          return toFlowResponse(resumed);
        });
        return reply.send(body);
      } catch (err) {
        const mapped = mapFlowStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );

  // D-23: duplicate stays Member-allowed (unlike campaigns' launch-gated
  // duplicate) -- it only ever produces a new 'draft' flow, never affects a
  // live/paused flow's state.
  fastify.post("/api/workspaces/:slug/flows/:id/duplicate", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const session = await auth.api.getSession({ headers: toFetchHeaders(request) });
    if (!session) {
      return reply.code(401).send({ error: "Not authenticated" });
    }

    try {
      const body = await withTenant(workspace.id, async () => {
        const duplicated = await duplicateFlow(id, session.user.id);
        return toFlowResponse(duplicated);
      });
      return reply.code(201).send(body);
    } catch (err) {
      const mapped = mapFlowStateError(err);
      if (mapped) return reply.code(mapped.code).send(mapped.body);
      throw err;
    }
  });

  // D-21: any workspace member can read the run list + counts (the flow
  // detail page's "N in flow (M on old versions)" header).
  fastify.get("/api/workspaces/:slug/flows/:id/runs", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = flowRunListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const resolved = await resolveWorkspaceMember(request, reply, slug);
    if (!resolved) return;
    const workspace = resolved.workspace;

    const body = await withTenant(workspace.id, async () => {
      const flow = await getFlow(id);
      if (!flow) return null;

      const result = await listRuns(id, parsed.data);
      return {
        items: result.items.map(toFlowRunSummaryResponse),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        counts: result.counts,
      };
    });
    if (!body) {
      return reply.code(404).send({ error: "Flow not found" });
    }
    return reply.send(body);
  });

  // D-21/D-23: eject (single via runIds, bulk via contactIds) is
  // Owner/Admin-only -- it is a destructive intervention on a live run.
  fastify.post(
    "/api/workspaces/:slug/flows/:id/runs/eject",
    { preHandler: requirePermission("flow", "publish") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const parsed = flowRunEjectSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      const body = await withTenant(workspace.id, async () => {
        const flow = await getFlow(id);
        if (!flow) return null;
        const ejected = await ejectRuns(id, {
          runIds: parsed.data.runIds,
          contactIds: parsed.data.contactIds,
        });
        return { ejected };
      });
      if (!body) {
        return reply.code(404).send({ error: "Flow not found" });
      }
      return reply.send(body);
    }
  );

  // D-22/D-23: delete is Owner/Admin-only and guarded -- never-published or
  // paused-with-zero-active-runs only, else 409 (illegal_transition).
  fastify.delete(
    "/api/workspaces/:slug/flows/:id",
    { preHandler: requirePermission("flow", "publish") },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send(NOT_FOUND_BODY);
      }

      try {
        const deleted = await withTenant(workspace.id, () => deleteFlow(id));
        if (!deleted) {
          return reply.code(404).send({ error: "Flow not found" });
        }
        return reply.send({ deleted: true });
      } catch (err) {
        const mapped = mapFlowStateError(err);
        if (mapped) return reply.code(mapped.code).send(mapped.body);
        throw err;
      }
    }
  );
}
