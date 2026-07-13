import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import { getContact } from "../contacts/contact.repository.js";
import { listContactTimeline, type TimelineRow } from "./timeline.repository.js";

const timelineQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  type: z.enum(["all", "events", "emails", "statuses"]).optional(),
});

/**
 * Resolves `:slug` to a workspace AND confirms the caller is a member --
 * copied verbatim from contacts.routes.ts's `resolveWorkspaceMember` (not
 * exported there) so every analytics route gets the identical
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

function toTimelineResponse(row: TimelineRow) {
  return {
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    label: row.label,
    detail: row.detail,
  };
}

/**
 * D-10/ANLT-03: the contact card's unified activity timeline. Ordinary
 * workspace membership is sufficient (analytics is readable by every role
 * including Member, per RESEARCH.md V4 -- no elevated-role check).
 *
 * T-07-02-01 (IDOR): mirrors `listContactEvents`'s double-gate exactly -- an
 * explicit `getContact(id)` existence check 404s a foreign-workspace
 * contact id (never an empty 200), on top of RLS on every unioned table.
 */
export async function registerTimelineRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/contacts/:id/timeline", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = timelineQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const contact = await withTenant(workspace.id, () => getContact(id));
    if (!contact) {
      return reply.code(404).send({ error: "Contact not found" });
    }

    const rows = await withTenant(workspace.id, () =>
      listContactTimeline(id, { page: parsed.data.page, type: parsed.data.type })
    );
    return reply.send(rows.map(toTimelineResponse));
  });
}
