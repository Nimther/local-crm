import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "../modules/auth/auth.js";
import { statement } from "../modules/auth/access-control.js";
import { findActiveWorkspaceBySlug } from "../modules/tenancy/workspace-lookup.js";
import { NOT_FOUND_BODY } from "../modules/tenancy/resolve-workspace-member.js";

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
        // SEC-10/SEC-15/T-10-04-02: same NOT_FOUND_BODY resolveWorkspaceMember
        // sends -- an imported reference, not a re-typed literal, so this
        // independently-written 404 branch cannot silently drift from the
        // resolver's byte-identical missing-vs-forbidden contract.
        await reply.code(404).send(NOT_FOUND_BODY);
        return;
      }
      organizationId = workspace.id;
    }

    let result: { success?: boolean } | boolean;
    try {
      result = (await auth.api.hasPermission({
        headers: toFetchHeaders(request),
        body: {
          permissions: { [resource]: [action] },
          ...(organizationId ? { organizationId } : {}),
        },
      })) as { success?: boolean } | boolean;
    } catch (err) {
      // SEC-10/SEC-15/T-10-04-02 (anti-enumeration sweep caught this, Rule
      // 1 auto-fix): better-auth's hasPermission THROWS -- it doesn't
      // resolve `{ success: false }` -- when the caller isn't a member of
      // `organizationId` at all, distinct from "member but insufficient
      // role" (which resolves false, handled below via `allowed`).
      // Uncaught, this surfaced a bare 401 for a real foreign workspace
      // while this same guard's own missing-workspace branch above returns
      // 404 -- an enumeration oracle letting any authenticated caller learn
      // a slug is real just by trying a permission-gated route on it.
      // Mapped to the identical NOT_FOUND_BODY 404, mirroring
      // resolveWorkspaceMember's non-member catch branch.
      if (organizationId) {
        await reply.code(404).send(NOT_FOUND_BODY);
        return;
      }
      throw err;
    }

    const allowed = typeof result === "boolean" ? result : Boolean(result?.success);

    if (!allowed) {
      await reply.code(403).send({ error: "Forbidden: missing permission" });
    }
  };
}
