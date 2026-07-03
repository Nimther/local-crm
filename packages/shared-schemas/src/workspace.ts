import { z } from "zod";

/** Shared between the Fastify route (apps/api) and the React form (apps/web, 01-02). */
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "Workspace name is required").max(120),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const workspaceResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  role: z.string(),
});
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;

/** GET /api/workspaces (list) -- deliberately lighter than workspaceResponseSchema: no role (varies per caller is irrelevant here) and soft-deleted workspaces are excluded server-side (D-20). */
export const workspaceListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
});
export type WorkspaceListItem = z.infer<typeof workspaceListItemSchema>;

/** D-20: type-the-name-to-confirm soft delete. */
export const deleteWorkspaceSchema = z.object({
  confirmName: z.string().trim().min(1, "Введите название воркспейса"),
});
export type DeleteWorkspaceInput = z.infer<typeof deleteWorkspaceSchema>;
