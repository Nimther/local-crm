import type { FastifyReply, FastifyRequest } from "fastify";
import { toFetchHeaders } from "../../middleware/role-guard.js";
import { findActiveWorkspaceBySlug, type ActiveWorkspace } from "./workspace-lookup.js";
import { getCallerRoles } from "./member-roles.js";

/**
 * SEC-14: the ONE shared 404 body every workspace-membership failure path
 * sends -- mirrors api-key-auth.ts's `UNAUTHORIZED_BODY` precedent. Frozen so
 * no caller can mutate a shared reference and accidentally desync the four
 * failure paths that must stay byte-identical.
 */
export const NOT_FOUND_BODY = { error: "Workspace not found" } as const;

export interface WorkspaceMemberResolution {
  workspace: ActiveWorkspace;
  roles: string[];
}

/**
 * Resolves `:slug` to a workspace AND confirms the caller is a member --
 * the single implementation SEC-14 requires. Previously nine near-identical
 * copies lived across contacts/csv-import/send-log/flows/segments/campaigns/
 * flow-analytics/timeline/dashboard route modules; no route module may
 * reintroduce a local copy.
 *
 * Deliberately indistinguishable failure classes: an unknown slug, a
 * soft-deleted workspace's slug, an unauthenticated caller, and an
 * authenticated non-member caller must all produce the exact same status
 * code and response bytes (`NOT_FOUND_BODY`) -- otherwise this endpoint
 * becomes a workspace-enumeration oracle. ANY throw from `getCallerRoles`
 * (unauthenticated, unknown slug, non-member) is caught and mapped to the
 * same 404 a nonexistent workspace returns.
 *
 * Returns `{ workspace, roles }` on success -- `roles` is the one
 * behavioral addition over the former copies (which discarded it): several
 * route modules call `getCallerRoles` a second time for owner/admin checks,
 * and returning it here lets a future change remove that second call
 * without altering this contract. No caller's role logic changes in this
 * plan.
 */
export async function resolveWorkspaceMember(
  request: FastifyRequest,
  reply: FastifyReply,
  slug: string
): Promise<WorkspaceMemberResolution | null> {
  const workspace = await findActiveWorkspaceBySlug(slug);
  if (!workspace) {
    await reply.code(404).send(NOT_FOUND_BODY);
    return null;
  }

  let roles: string[];
  try {
    roles = await getCallerRoles(toFetchHeaders(request), slug);
  } catch {
    await reply.code(404).send(NOT_FOUND_BODY);
    return null;
  }

  return { workspace, roles };
}
