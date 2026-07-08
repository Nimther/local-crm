import { z } from "zod";

/**
 * GET /api/workspaces/:slug/webhook-health response contract (D-03,
 * WBHK-01): `connected` mirrors the platform's own Event Webhook
 * provisioning state (D-01/D-02), NOT whether a SendGrid key is connected
 * at all -- a key can be connected while the webhook itself is "pending" or
 * "error". Never carries the `pathToken` or `publicKey` (T-05-03).
 */
export const webhookHealthResponseSchema = z.object({
  connected: z.boolean(),
  provisionStatus: z.enum(["pending", "active", "error"]),
  lastEventAt: z.string().nullable(),
});
export type WebhookHealthResponse = z.infer<typeof webhookHealthResponseSchema>;
