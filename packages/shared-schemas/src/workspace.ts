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
