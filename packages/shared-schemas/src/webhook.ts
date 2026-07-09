import { z } from "zod";

/**
 * GET /api/workspaces/:slug/webhook-health response contract (D-03,
 * WBHK-01): `connected` mirrors the platform's own Event Webhook
 * provisioning state (D-01/D-02), NOT whether a SendGrid key is connected
 * at all -- a key can be connected while the webhook itself is "pending" or
 * "error". Never carries the `pathToken` or `publicKey` (T-05-03).
 *
 * `provisionError` (05-09, T-05-09-01): a curated, human-readable Russian
 * reason mapped from the typed `ProvisionEventWebhookError` enum
 * (`webhookWarningFor`) when `provisionStatus === "error"`, else `null`.
 * NEVER carries the raw SendGrid response body or the tenant's api key --
 * only the pre-mapped copy string.
 */
export const webhookHealthResponseSchema = z.object({
  connected: z.boolean(),
  provisionStatus: z.enum(["pending", "active", "error"]),
  lastEventAt: z.string().nullable(),
  provisionError: z.string().nullable(),
});
export type WebhookHealthResponse = z.infer<typeof webhookHealthResponseSchema>;
