import { z } from "zod";

/** POST /api/workspaces/:slug/api-keys -- name only; the server generates the key itself (D-21). */
export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, "Введите название ключа"),
});
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/** GET list item shape -- never includes the secret, only the display mask (D-22). */
export const apiKeyListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  keyMask: z.string(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type ApiKeyListItem = z.infer<typeof apiKeyListItemSchema>;

/** POST create response -- the ONLY response that ever carries the full secret (D-22). */
export const apiKeyCreatedSchema = apiKeyListItemSchema.extend({
  fullKey: z.string(),
});
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>;
