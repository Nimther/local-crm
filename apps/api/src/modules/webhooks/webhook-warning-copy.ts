/**
 * Shared provisioning-failure copy (05-09, UAT Test 1/3 gap-closure):
 * extracted verbatim from `sendgrid-key.ts` so both the connect/recheck
 * handlers (sendgrid-key.ts) AND the health/reconnect route
 * (webhook-settings.routes.ts) map the same typed
 * `ProvisionEventWebhookError` reason to the SAME human-readable Russian
 * copy -- avoids the two call sites drifting on wording.
 */

export const WEBHOOK_MISSING_SCOPE_WARNING =
  "SendGrid ключ подключён, но у него нет прав на управление вебхуками, поэтому отслеживание доставки не настроено автоматически. Создайте ключ с правами Webhooks Settings или настройте вебхук вручную.";
export const WEBHOOK_CAP_REACHED_WARNING =
  "SendGrid ключ подключён, но на аккаунте достигнут лимит Event Webhook'ов, поэтому отслеживание доставки не настроено автоматически. Освободите слот в настройках SendGrid.";
export const WEBHOOK_PROVISION_FAILED_WARNING =
  "SendGrid ключ подключён, но не удалось автоматически настроить вебхук отслеживания доставки. Попробуйте переподключить ключ позже.";

export function webhookWarningFor(reason: "missing_scope" | "cap_reached" | "failed"): string {
  if (reason === "missing_scope") return WEBHOOK_MISSING_SCOPE_WARNING;
  if (reason === "cap_reached") return WEBHOOK_CAP_REACHED_WARNING;
  return WEBHOOK_PROVISION_FAILED_WARNING;
}
