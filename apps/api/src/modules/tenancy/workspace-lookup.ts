import { and, eq, isNull } from "drizzle-orm";
import { db, organization } from "@mega-crm/db";

export interface ActiveWorkspace {
  id: string;
  name: string;
  slug: string;
}

/**
 * Resolves a workspace by its URL slug, excluding soft-deleted workspaces
 * (D-20). Shared by workspaces.ts, invites.ts, members.ts, and
 * middleware/role-guard.ts (which all need to turn a `:slug` route param
 * into an `organizationId` for better-auth's org-plugin API calls) -- kept
 * in its own module rather than re-exported from workspaces.ts to avoid a
 * circular import (role-guard.ts already imports auth.ts, which workspaces.ts
 * also imports).
 */
export async function findActiveWorkspaceBySlug(slug: string): Promise<ActiveWorkspace | null> {
  const org = await db.query.organization.findFirst({
    where: and(eq(organization.slug, slug), isNull(organization.deletedAt)),
  });
  return org ? { id: org.id, name: org.name, slug: org.slug } : null;
}
