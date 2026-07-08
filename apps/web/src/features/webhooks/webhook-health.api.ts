import type { WebhookHealthResponse } from "@mega-crm/shared-schemas";
import { apiGet, apiPost } from "@/lib/api";

/**
 * D-02/D-03/WBHK-01: thin typed client over the 05-04 health/reconnect
 * routes. `getWebhookHealth` is readable by any workspace member;
 * `reconnectWebhook` is server-side gated to Owner/Admin (requirePermission)
 * -- the client never enforces that itself, it only hides the button.
 */
export function getWebhookHealth(slug: string): Promise<WebhookHealthResponse> {
  return apiGet<WebhookHealthResponse>(`/api/workspaces/${slug}/webhook-health`);
}

export function reconnectWebhook(slug: string): Promise<WebhookHealthResponse> {
  return apiPost<WebhookHealthResponse>(`/api/workspaces/${slug}/webhook-reconnect`, {});
}
