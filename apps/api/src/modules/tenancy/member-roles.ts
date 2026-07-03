import { auth } from "../auth/auth.js";

/** better-auth stores/returns roles as a single string or an array, and may comma-join multiple roles into one string -- normalize to a role-name array either way. */
export function normalizeRoles(role: string | string[]): string[] {
  const joined = Array.isArray(role) ? role.join(",") : role;
  return joined
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * D-18: several member/invite mutations need an explicit "is the caller the
 * Owner?" check beyond the ac-permission gate (`requirePermission`) --
 * better-auth's own `updateMemberRole`/`removeMember` only special-case the
 * built-in `creatorRole` ("owner"), never a project-defined "admin" role, so
 * "only Owner may assign/remove Admin" has to be enforced by the caller.
 */
export async function getCallerRoles(headers: Headers, organizationSlug: string): Promise<string[]> {
  const { role } = await auth.api.getActiveMemberRole({
    headers,
    query: { organizationSlug },
  });
  return normalizeRoles(role);
}
