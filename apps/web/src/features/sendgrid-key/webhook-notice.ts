import type { WebhookHealthResponse } from "@mega-crm/shared-schemas";

/**
 * Pure, DOM-free decision helpers for the SendGrid key connect/recheck +
 * webhook-health UI (05-09, UAT Test 1/3 gap-closure). Mirrors the
 * segmentSaveGate node-lane precedent: apps/web's vitest lane is
 * `environment: "node"` with no jsdom/@testing-library installed, so any
 * logic worth unit-testing here must stay a pure function -- rendering
 * itself lives in SendGridKeySettings.tsx and is exercised via phase UAT.
 */

/**
 * The inline warning to render after a connect/recheck response that DID
 * succeed (the key connected) but carries a non-fatal webhook-provisioning
 * warning (D-01: provisioning is best-effort and never fails the connect
 * itself).
 */
export function webhookNoticeForKeyResponse(data: { webhookWarning?: string }): string | null {
  return data.webhookWarning ?? null;
}

export interface ReconnectToastResult {
  variant: "success" | "error";
  message: string;
}

const RECONNECT_FAILED_FALLBACK = "Не удалось настроить отслеживание доставки";
const RECONNECT_SUCCESS_MESSAGE = "Отслеживание доставки переподключено";

/**
 * Decides the toast variant/message for a completed reconnect mutation
 * (05-09: stops the prior unconditional `toast.success(...)` from lying
 * about a reconnect whose provisioning actually failed).
 */
export function reconnectToastForHealth(data: {
  provisionStatus: WebhookHealthResponse["provisionStatus"];
  provisionError: string | null;
}): ReconnectToastResult {
  if (data.provisionStatus === "error") {
    return { variant: "error", message: data.provisionError ?? RECONNECT_FAILED_FALLBACK };
  }
  return { variant: "success", message: RECONNECT_SUCCESS_MESSAGE };
}

/**
 * Drives the WebhookHealthCard's `CardDescription`: an error state returns
 * the curated reason (WHY it's broken); otherwise returns null so the
 * caller falls back to its existing last-event / "События ещё не
 * поступали" rendering unchanged.
 */
export function webhookHealthDescription(data: {
  provisionStatus: WebhookHealthResponse["provisionStatus"];
  provisionError: string | null;
  lastEventAt: string | null;
}): string | null {
  if (data.provisionStatus === "error" && data.provisionError) {
    return data.provisionError;
  }
  return null;
}
