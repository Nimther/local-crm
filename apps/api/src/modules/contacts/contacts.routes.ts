import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createContactSchema, updateContactSchema, contactListQuerySchema } from "@mega-crm/shared-schemas";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { withTenant } from "../../middleware/tenant-context.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "../tenancy/workspace-lookup.js";
import { getCallerRoles } from "../tenancy/member-roles.js";
import {
  ContactConflictError,
  ContactValidationError,
  createContact,
  deleteContact,
  getContact,
  listContacts,
  listContactEvents,
  updateContact,
  type ContactEventRow,
  type ContactRow,
} from "./contact.repository.js";
import { listPropertyRegistry } from "./property-registry.js";

function toContactEventResponse(row: ContactEventRow) {
  return {
    id: row.id,
    name: row.name,
    properties: row.properties,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  };
}

function toContactResponse(row: ContactRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    externalId: row.externalId,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    city: row.city,
    country: row.country,
    timezone: row.timezone,
    tags: row.tags,
    properties: row.properties,
    subscriptionStatus: row.subscriptionStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolves `:slug` to a workspace AND confirms the caller is a member --
 * ANY throw from getCallerRoles (unauthenticated, unknown slug, non-member)
 * maps to the SAME 404 a nonexistent workspace returns, mirroring
 * sendgrid-key.ts's GET route so contact routes cannot be used as a
 * workspace-enumeration oracle (T-02-01-04).
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

/**
 * Session-authed contact CRUD (CONT-01, CONT-05, SUBS-01). Ordinary
 * workspace membership is sufficient -- contact management is not an
 * elevated-role action, unlike SendGrid-key connect or member-role changes.
 */
export async function registerContactsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/contacts", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = contactListQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const result = await withTenant(workspace.id, () => listContacts(parsed.data));
    return reply.send({
      items: result.items.map(toContactResponse),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  });

  fastify.post("/api/workspaces/:slug/contacts", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const parsed = createContactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    try {
      const created = await withTenant(workspace.id, () => createContact(parsed.data));
      return reply.code(201).send(toContactResponse(created));
    } catch (err) {
      if (err instanceof ContactValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      if (err instanceof ContactConflictError) {
        return reply.code(409).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  fastify.get("/api/workspaces/:slug/contacts/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const contact = await withTenant(workspace.id, () => getContact(id));
    if (!contact) {
      return reply.code(404).send({ error: "Contact not found" });
    }
    return reply.send(toContactResponse(contact));
  });

  // D-14/EVNT-01: the contact-card live event feed's read route -- ordinary
  // membership, same access level as the rest of this module. Newest-first,
  // paginated (T-02-08-02); workspace isolation is enforced BOTH by this
  // explicit contact-existence check (404 if the contact isn't in this
  // workspace) AND by RLS on the `events` table underneath (T-02-08-01).
  fastify.get("/api/workspaces/:slug/contacts/:id/events", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const query = request.query as { page?: string };
    const page = query.page ? Math.max(1, Number(query.page) || 1) : 1;

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const contact = await withTenant(workspace.id, () => getContact(id));
    if (!contact) {
      return reply.code(404).send({ error: "Contact not found" });
    }

    const events = await withTenant(workspace.id, () => listContactEvents(id, { page }));
    return reply.send(events.map(toContactEventResponse));
  });

  fastify.patch("/api/workspaces/:slug/contacts/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const parsed = updateContactSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    try {
      const updated = await withTenant(workspace.id, () => updateContact(id, parsed.data));
      if (!updated) {
        return reply.code(404).send({ error: "Contact not found" });
      }
      return reply.send(toContactResponse(updated));
    } catch (err) {
      if (err instanceof ContactValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code });
      }
      if (err instanceof ContactConflictError) {
        return reply.code(409).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  // D-10/D-19: read-only registry of auto-discovered custom-property keys,
  // powering the contact-form property editor's key autocomplete.
  fastify.get("/api/workspaces/:slug/property-registry", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const items = await withTenant(workspace.id, () => listPropertyRegistry());
    return reply.send(items);
  });

  fastify.delete("/api/workspaces/:slug/contacts/:id", async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string };
    const workspace = await resolveWorkspaceMember(request, reply, slug);
    if (!workspace) return;

    const deleted = await withTenant(workspace.id, () => deleteContact(id));
    if (!deleted) {
      return reply.code(404).send({ error: "Contact not found" });
    }
    return reply.send({ deleted: true });
  });
}
