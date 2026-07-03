import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, organization } from "@mega-crm/db";
import { APIError } from "better-auth/api";
import {
  createWorkspaceSchema,
  deleteWorkspaceSchema,
  workspaceListItemSchema,
  workspaceResponseSchema,
} from "@mega-crm/shared-schemas";
import { auth } from "../auth/auth.js";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { findActiveWorkspaceBySlug } from "./workspace-lookup.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

/** D-16 slug generation with collision retry (RESEARCH.md "Workspace slug generation"). */
export async function createUniqueWorkspaceSlug(name: string): Promise<string> {
  const base = slugify(name) || "workspace";
  let candidate = base;
  let attempts = 0;

  while (await db.query.organization.findFirst({ where: eq(organization.slug, candidate) })) {
    attempts += 1;
    candidate = `${base}-${nanoid(6).toLowerCase()}`;
    if (attempts > 5) {
      throw new Error("Could not generate a unique workspace slug");
    }
  }

  return candidate;
}

function toWorkspaceResponse(
  org: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date | string;
  },
  role: string
) {
  return workspaceResponseSchema.parse({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt instanceof Date ? org.createdAt.toISOString() : org.createdAt,
    role,
  });
}

/**
 * POST /api/workspaces (TENANT-01): creates the workspace (better-auth
 * organization) with a unique slug; the creator becomes Owner via
 * better-auth's default org-creation behavior — no per-workspace-creation
 * limit (D-15, billing arrives in v2).
 *
 * GET /api/workspaces/:slug: member-only read, 403/404 for non-members.
 */
export async function registerWorkspaceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/api/workspaces", async (request, reply) => {
    const parsed = createWorkspaceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const slug = await createUniqueWorkspaceSlug(parsed.data.name);

    try {
      const org = await auth.api.createOrganization({
        headers: toFetchHeaders(request),
        body: { name: parsed.data.name, slug },
      });

      if (!org) {
        return reply.code(500).send({ error: "Failed to create workspace" });
      }

      // The creator always becomes "owner" (better-auth's default
      // creatorRole) — no extra round-trip needed here.
      return reply.send(toWorkspaceResponse(org, "owner"));
    } catch (err) {
      if (err instanceof APIError) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.get("/api/workspaces/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const headers = toFetchHeaders(request);

    try {
      const org = await auth.api.getFullOrganization({
        headers,
        query: { organizationSlug: slug },
      });

      // D-20: a soft-deleted workspace is excluded from reads exactly like a
      // non-existent one -- `getFullOrganization` doesn't know about
      // `deletedAt` (a project-added additionalField), so the check happens
      // here.
      if (!org || (org as { deletedAt?: Date | string | null }).deletedAt) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const { role } = await auth.api.getActiveMemberRole({
        headers,
        query: { organizationSlug: slug },
      });

      return reply.send(toWorkspaceResponse(org, Array.isArray(role) ? role[0] : role));
    } catch (err) {
      if (err instanceof APIError) {
        return reply.code(err.statusCode ?? 404).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * GET /api/workspaces (list, TENANT-05/D-13): the workspace switcher and
   * the post-login root redirect both need "every workspace I belong to" --
   * filtered so a soft-deleted workspace (D-20) never reappears in the
   * switcher. better-auth's own `organization.list` client method has no
   * such filter (its adapter doesn't know about `deletedAt`), so this app
   * route wraps it instead of the frontend calling `authClient.organization.list()`
   * directly.
   */
  fastify.get("/api/workspaces", async (request, reply) => {
    const orgs = (await auth.api.listOrganizations({
      headers: toFetchHeaders(request),
    })) as Array<{ id: string; name: string; slug: string; deletedAt?: Date | string | null }>;

    const active = orgs.filter((org) => !org.deletedAt);
    return reply.send(active.map((org) => workspaceListItemSchema.parse(org)));
  });

  /**
   * DELETE /api/workspaces/:slug (D-20): Owner-only soft delete. Deliberately
   * does NOT call better-auth's own `organization.delete` -- that endpoint
   * hard-deletes the row (`adapter.deleteOrganization`, verified by reading
   * better-auth/dist/plugins/organization/routes/crud-org.mjs) which
   * conflicts with D-20's soft-delete/deferred-cleanup requirement. The
   * `organization:delete` ac permission is granted only to the Owner role
   * (see access-control.ts), so `requirePermission` alone enforces
   * Owner-only here.
   */
  fastify.delete(
    "/api/workspaces/:slug",
    { preHandler: requirePermission("organization", "delete") },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = deleteWorkspaceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      if (parsed.data.confirmName !== workspace.name) {
        return reply.code(400).send({ error: "Workspace name does not match" });
      }

      await db.update(organization).set({ deletedAt: new Date() }).where(eq(organization.id, workspace.id));

      return reply.send({ status: true });
    }
  );
}
