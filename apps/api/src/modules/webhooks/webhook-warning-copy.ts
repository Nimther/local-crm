/**
 * Shared provisioning-failure copy (05-09, UAT Test 1/3 gap-closure):
 * extracted verbatim from `sendgrid-key.ts` so both the connect/recheck
 * handlers (sendgrid-key.ts) AND the health/reconnect route
 * (webhook-settings.routes.ts) map the same typed
 * `ProvisionEventWebhookError` reason to the SAME human-readable Russian
 * copy -- avoids the two call sites drifting on wording.
 */

import type { ProvisionEventWebhookError } from "./sendgrid-webhook-provision.js";

export const WEBHOOK_MISSING_SCOPE_WARNING =
  "SendGrid ключ подключён, но у него нет прав на управление вебхуками, поэтому отслеживание доставки не настроено автоматически. Создайте ключ с правами Webhooks Settings или настройте вебхук вручную.";
export const WEBHOOK_CAP_REACHED_WARNING =
  "SendGrid ключ подключён, но на аккаунте достигнут лимит Event Webhook'ов, поэтому отслеживание доставки не настроено автоматически. Освободите слот в настройках SendGrid.";
export const WEBHOOK_PROVISION_FAILED_WARNING =
  "SendGrid ключ подключён, но не удалось автоматически настроить вебхук отслеживания доставки. Попробуйте переподключить ключ позже.";
/**
 * 05-12 gap-closure: unlike the other three reasons, this one is fully
 * actionable -- the marketer (or the operator reading their screen) can fix
 * PUBLIC_APP_URL themselves, so the copy names the exact env var, the
 * https requirement, and the runbook, and tells them to restart the server
 * (env.PUBLIC_APP_URL is read once at boot) before retrying.
 */
export const WEBHOOK_INSECURE_URL_WARNING =
  "SendGrid ключ подключён, но адрес приложения (переменная PUBLIC_APP_URL) использует http, а SendGrid принимает только https-адреса для вебхуков, поэтому отслеживание доставки не настроено. Укажите https-адрес (например, публичный туннель) в PUBLIC_APP_URL, перезапустите сервер (значение читается один раз при старте) и нажмите «Переподключить». Подробности: docs/webhook-live-uat.md.";

export function webhookWarningFor(reason: ProvisionEventWebhookError): string {
  if (reason === "missing_scope") return WEBHOOK_MISSING_SCOPE_WARNING;
  if (reason === "cap_reached") return WEBHOOK_CAP_REACHED_WARNING;
  if (reason === "insecure_url") return WEBHOOK_INSECURE_URL_WARNING;
  return WEBHOOK_PROVISION_FAILED_WARNING;
}
