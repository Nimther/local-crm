import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { auth } from "../auth/auth.js";
import { toFetchHeaders } from "../../middleware/role-guard.js";

const updateNameSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters").max(128),
});

/**
 * D-24 (v1 scope: display name + change password only; email change and
 * avatar are v2). Thin wrappers over better-auth's own `/update-user` and
 * `/change-password` endpoints -- kept as app-level routes (rather than the
 * frontend calling better-auth's client directly) for the same reason
 * `/api/workspaces` wraps `auth.api.createOrganization`: one consistent
 * app-facing REST surface.
 */
export async function registerProfileRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post("/api/profile/name", async (request, reply) => {
    const parsed = updateNameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      await auth.api.updateUser({
        headers: toFetchHeaders(request),
        body: { name: parsed.data.name },
      });
      return reply.send({ status: true });
    } catch (err) {
      if (err instanceof APIError) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
      throw err;
    }
  });

  fastify.post("/api/profile/password", async (request, reply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      await auth.api.changePassword({
        headers: toFetchHeaders(request),
        body: {
          currentPassword: parsed.data.currentPassword,
          newPassword: parsed.data.newPassword,
        },
      });
      return reply.send({ status: true });
    } catch (err) {
      if (err instanceof APIError) {
        return reply.code(err.statusCode ?? 400).send({ error: err.message });
      }
      throw err;
    }
  });
}
