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

/**
 * Phase 22 (PRG-06, D-04): the single API-side soft-delete lookup shared by
 * `apiKeyAuth` (every API-key-authed surface) and the SendGrid webhook route
 * -- one fail-closed rule, not two hand-rolled queries that could drift.
 *
 * Fail-closed: returns `true` (refuse) both when the row's `deletedAt` is
 * non-null AND when no `organization` row is found at all -- a workspace
 * this lookup cannot resolve is treated exactly like a soft-deleted one,
 * never admitted by default. Deliberately does not join `purge_records`:
 * quiesce starts at soft delete, long before any purge record exists.
 */
export async function isWorkspaceSoftDeletedById(workspaceId: string): Promise<boolean> {
  const org = await db.query.organization.findFirst({
    where: eq(organization.id, workspaceId),
  });
  return !org || org.deletedAt !== null;
}
