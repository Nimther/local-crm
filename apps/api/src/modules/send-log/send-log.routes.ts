import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import {
  getSendById,
  listSendEventsForSend,
  listSendLog,
  SEND_LOG_STATUSES,
  type SendEventRow,
  type SendLogRow,
} from "./send-log.repository.js";

const SEND_LOG_PERIODS = [7, 30, 90] as const;

/** Accepts a single `?status=x` or repeated `?status=x&status=y` (Fastify's default query parser arrays repeated keys). */
const sendLogQuerySchema = z.object({
  contactId: z.string().uuid().optional(),
  campaignOrFlowId: z.string().uuid().optional(),
  status: z.preprocess(
    (value) => (value === undefined ? undefined : Array.isArray(value) ? value : [value]),
    z.array(z.enum(SEND_LOG_STATUSES)).optional()
  ),
  period: z.coerce
    .number()
    .int()
    .refine((value) => (SEND_LOG_PERIODS as readonly number[]).includes(value), {
      message: "period must be 7, 30, or 90",
    })
    .optional(),
  page: z.coerce.number().int().min(1).optional(),
});

/**
 * Resolves `:slug` to a workspace AND confirms the caller is a member --
 * copied verbatim from contacts.routes.ts's `resolveWorkspaceMember` (not
 * exported there) so the send-log routes get the identical
 * workspace-enumeration-safe 404 behavior (T-02-01-04 precedent).
 */
async function resolveWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string
): Promise<ActiveWorkspace | null> {
  const workspace = await findActiveWorkspaceBySlug(slug);
  if (!workspace) {
    await reply.code(404).send({ error: "Workspace not found" });
    return null;
  }

  try {
    await getCallerRoles(toFetchHeaders(request), slug);
  } catch {
    await reply.code(404).send({ error: "Workspace not found" });
    return null;
  }

  return workspace;
}

function toSendLogResponse(row: SendLogRow) {
  return {
    id: row.id,
    contactId: row.contactId,
    contactEmail: row.contactEmail,
    contactFirstName: row.contactFirstName,
    contactLastName: row.contactLastName,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    flowId: row.flowId,
    flowName: row.flowName,
    flowRunId: row.flowRunId,
    status: row.status,
    exclusionReason: row.exclusionReason,
    bounceReason: row.bounceReason,
    dropReason: row.dropReason,
    queuedAt: row.queuedAt.toISOString(),
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    openCount: row.openCount,
    clickCount: row.clickCount,
  };
}

function toSendEventResponse(row: SendEventRow) {
  return {
    id: row.id,
    eventType: row.eventType,
    occurredAt: row.occurredAt.toISOString(),
    reason: row.reason,
    clickUrl: row.clickUrl,
  };
}

/**
 * The workspace-wide send log (ANLT-05/D-13..16). Ordinary workspace
 * membership is sufficient for both routes -- analytics/send-log is
 * readable by every role including Member (RESEARCH.md V4, no evidence of a
 * more restrictive requirement than the underlying data those roles already
 * read).
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerSendLogRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/send-log", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = sendLogQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const result = await withTenant(workspace.id, () =>
      listSendLog({
        contactId: parsed.data.contactId,
        campaignOrFlowId: parsed.data.campaignOrFlowId,
        statuses: parsed.data.status,
        period: parsed.data.period as 7 | 30 | 90 | undefined,
        page: parsed.data.page ?? 1,
      })
    );

    return reply.send({
      items: result.items.map(toSendLogResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  // T-07-05-02 (IDOR): explicit send-existence check 404s a foreign-workspace
  // sendId (never an empty 200 array), on top of RLS on both `sends` and
  // `send_events`.
  fastify.get("/api/workspaces/:slug/send-log/:sendId/events", async (request, reply) => {
    const { slug, sendId } = request.params as { slug: string; sendId: string };

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const send = await withTenant(workspace.id, () => getSendById(sendId));
    if (!send) {
      return reply.code(404).send({ error: "Send not found" });
    }

    const events = await withTenant(workspace.id, () => listSendEventsForSend(sendId));
    return reply.send(events.map(toSendEventResponse));
  });
}
