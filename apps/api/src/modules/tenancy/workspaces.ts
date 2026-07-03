import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, organization } from "@mega-crm/db";
import { APIError } from "better-auth/api";
import { createWorkspaceSchema, workspaceResponseSchema } from "@mega-crm/shared-schemas";
import { auth } from "../auth/auth.js";
import { toFetchHeaders } from "../../middleware/role-guard.js";

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

function toWorkspaceResponse(org: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date | string;
}) {
  return workspaceResponseSchema.parse({
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt instanceof Date ? org.createdAt.toISOString() : org.createdAt,
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

      return reply.send(toWorkspaceResponse(org));
    } catch (err) {
      if (err instanceof APIError) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.get("/api/workspaces/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };

    try {
      const org = await auth.api.getFullOrganization({
        headers: toFetchHeaders(request),
        query: { organizationSlug: slug },
      });

      if (!org) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      return reply.send(toWorkspaceResponse(org));
    } catch (err) {
      if (err instanceof APIError) {
        return reply.code(err.statusCode ?? 404).send({ error: err.message });
      }
      throw err;
    }
  });
}
