import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "../modules/auth/auth.js";
import { statement } from "../modules/auth/access-control.js";
import { findActiveWorkspaceBySlug } from "../modules/tenancy/workspace-lookup.js";

type Resource = keyof typeof statement;

/** Converts Fastify's Node-style request headers into a Web-standard Headers object for better-auth's `auth.api.*` calls. */
export function toFetchHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, String(value));
    }
  }
  return headers;
}

/**
 * D-19: 403s unless the caller's role in the *route's* workspace grants
 * `action` on `resource` — checked server-side via better-auth's
 * createAccessControl statement (never client-side-only). Postgres RLS does
 * not substitute for this: RLS scopes by workspace, not by role.
 *
 * When the route has a `:slug` param (every 01-04 team/workspace-delete
 * route does), the permission check is scoped to THAT workspace's
 * organizationId explicitly, rather than falling back to the session's
 * "active organization" — this codebase's established pattern (see
 * workspaces.ts's GET/:slug using `organizationSlug` per-request) is that a
 * user can act on any workspace they belong to without first "switching"
 * into it, so permission checks must resolve the same way.
 */
export function requirePermission(resource: Resource, action: string) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { slug } = request.params as { slug?: string };
    let organizationId: string | undefined;

    if (slug) {
      const workspace = await findActiveWorkspaceBySlug(slug);
      if (!workspace) {
        await reply.code(404).send({ error: "Workspace not found" });
        return;
      }
      organizationId = workspace.id;
    }

    const result = (await auth.api.hasPermission({
      headers: toFetchHeaders(request),
      body: {
        permissions: { [resource]: [action] } as Record<string, string[]>,
        ...(organizationId ? { organizationId } : {}),
      },
    })) as { success?: boolean } | boolean;

    const allowed = typeof result === "boolean" ? result : Boolean(result?.success);

    if (!allowed) {
      await reply.code(403).send({ error: "Forbidden: missing permission" });
    }
  };
}
