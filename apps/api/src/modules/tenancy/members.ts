import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { db, member } from "@mega-crm/db";
import { auth } from "../auth/auth.js";
import { requirePermission, toFetchHeaders } from "../../middleware/role-guard.js";
import { findActiveWorkspaceBySlug } from "./workspace-lookup.js";
import { getCallerRoles, normalizeRoles } from "./member-roles.js";

const updateMemberRoleSchema = z.object({
  role: z.enum(["member", "admin", "owner"]),
});

/**
 * Member list/role/remove (TENANT-03, D-17/D-18) over better-auth's
 * organization plugin. `requirePermission("member", ...)` blocks a Member
 * outright; the Owner-only restriction on Admin-role assignment/removal and
 * ownership transfer is an explicit check on top (see member-roles.ts) --
 * better-auth's own guard only special-cases its built-in `creatorRole`
 * ("owner"), never a project-defined "admin" role.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin contract: app.register() resolves the returned promise, and the declared Promise<void> is part of that signature -- dropping async would change it, not simplify it
export async function registerMemberRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get("/api/workspaces/:slug/members", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const workspace = await findActiveWorkspaceBySlug(slug);
    if (!workspace) {
      return reply.code(404).send({ error: "Workspace not found" });
    }

    try {
      const { members } = await auth.api.listMembers({
        headers: toFetchHeaders(request),
        query: { organizationId: workspace.id },
      });
      return reply.send(
        members.map((m) => ({
          id: m.id,
          userId: m.userId,
          name: m.user.name,
          email: m.user.email,
          role: normalizeRoles(m.role).join(","),
        }))
      );
    } catch (err) {
      if (err instanceof APIError) {
        return reply.code(err.statusCode ?? 403).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.post(
    "/api/workspaces/:slug/members/:memberId/role",
    { preHandler: requirePermission("member", "update") },
    async (request, reply) => {
      const { slug, memberId } = request.params as { slug: string; memberId: string };
      const parsed = updateMemberRoleSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.flatten() });
      }

      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const headers = toFetchHeaders(request);

      // D-18: only the Owner may assign the Admin role or transfer
      // ownership. better-auth's own updateMemberRole already blocks anyone
      // but the Owner from touching the "owner" end of this -- this closes
      // the "admin" gap it leaves open.
      if (parsed.data.role === "admin" || parsed.data.role === "owner") {
        const callerRoles = await getCallerRoles(headers, slug);
        if (!callerRoles.includes("owner")) {
          return reply
            .code(403)
            .send({ error: "Только владелец может назначать роль администратора или передавать владение" });
        }
      }

      try {
        const updated = await auth.api.updateMemberRole({
          headers,
          body: { memberId, role: parsed.data.role, organizationId: workspace.id },
        });
        return reply.send({ id: updated.id, role: normalizeRoles(updated.role).join(",") });
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 400).send({ error: err.message });
        }
        throw err;
      }
    }
  );

  fastify.delete(
    "/api/workspaces/:slug/members/:memberId",
    { preHandler: requirePermission("member", "delete") },
    async (request, reply) => {
      const { slug, memberId } = request.params as { slug: string; memberId: string };
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        return reply.code(404).send({ error: "Workspace not found" });
      }

      const headers = toFetchHeaders(request);

      const target = await db.query.member.findFirst({
        where: and(eq(member.id, memberId), eq(member.organizationId, workspace.id)),
      });
      if (!target) {
        return reply.code(404).send({ error: "Member not found" });
      }

      // D-18: only the Owner may remove an Admin (or another Owner).
      const targetRoles = normalizeRoles(target.role);
      if (targetRoles.includes("admin") || targetRoles.includes("owner")) {
        const callerRoles = await getCallerRoles(headers, slug);
        if (!callerRoles.includes("owner")) {
          return reply.code(403).send({ error: "Только владелец может удалить администратора или владельца" });
        }
      }

      try {
        await auth.api.removeMember({
          headers,
          body: { memberIdOrEmail: memberId, organizationId: workspace.id },
        });
        return reply.send({ status: true });
      } catch (err) {
        if (err instanceof APIError) {
          return reply.code(err.statusCode ?? 400).send({ error: err.message });
        }
        throw err;
      }
    }
  );
}
