import type { FastifyReply, FastifyRequest } from "fastify";
import { auth } from "../modules/auth/auth.js";
import { statement } from "../modules/auth/access-control.js";

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
 * D-19: 403s unless the session's active-organization role grants `action`
 * on `resource` — checked server-side via better-auth's createAccessControl
 * statement (never client-side-only). Postgres RLS does not substitute for
 * this: RLS scopes by workspace, not by role.
 */
export function requirePermission(resource: Resource, action: string) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const result = (await auth.api.hasPermission({
      headers: toFetchHeaders(request),
      body: {
        permissions: { [resource]: [action] } as Record<string, string[]>,
      },
    })) as { success?: boolean } | boolean;

    const allowed = typeof result === "boolean" ? result : Boolean(result?.success);

    if (!allowed) {
      await reply.code(403).send({ error: "Forbidden: missing permission" });
    }
  };
}
