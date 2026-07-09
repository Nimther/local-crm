/**
 * Tenant SendGrid client (D-21, RESEARCH.md "SendGrid key validation at
 * connect time"): validates a tenant's BYO key by reading a
 * per-request-decrypted key argument. Structurally separate from
 * `platform-mail/client.ts` (RESEARCH.md Pitfall 4 -- two-key discipline):
 * this module never imports platform-mail, reads no env var directly (the
 * key is always passed in, already decrypted by the caller), and has a
 * completely different function signature (`validateTenantSendGridKey(apiKey)`
 * vs. platformMail's `{ to, subject, html }`-shaped senders) so a type error,
 * not a runtime mix-up, would catch any accidental cross-use.
 */

export interface SendGridVerifiedSender {
  id: number;
  fromEmail: string;
  nickname?: string;
}

export type ValidateTenantSendGridKeyResult =
  | { valid: true; scopes: string[]; verifiedSenders: SendGridVerifiedSender[]; webhookScopePresent: boolean }
  | { valid: false; reason: "invalid" | "missing_scope" };

/**
 * Scope prefix SendGrid uses for Event Webhook management (05-09, UAT Test
 * 1/3 gap-closure): a key can validate for `mail.send` yet lack this scope,
 * in which case `provisionEventWebhook`'s CREATE/PATCH call is doomed to a
 * 403. Detecting this at connect time lets the caller short-circuit
 * deterministically instead of attempting (and silently failing) the call.
 */
export const WEBHOOK_EVENT_SETTINGS_SCOPE_PREFIX = "user.webhooks.event.settings";

interface SendGridScopesResponse {
  scopes: string[];
}

interface SendGridVerifiedSendersResponse {
  results: Array<{ id: number; from_email: string; nickname?: string }>;
}

export interface SendGridDynamicTemplate {
  id: string;
  name: string;
  generation: string;
}

interface SendGridTemplatesResponse {
  result?: Array<{ id: string; name: string; generation: string }>;
  templates?: Array<{ id: string; name: string; generation: string }>;
}

/** GET /v3/scopes then /v3/verified_senders (D-21): validates the key is live and has mail.send, then lists the tenant's verified senders. */
export async function validateTenantSendGridKey(apiKey: string): Promise<ValidateTenantSendGridKeyResult> {
  const scopesRes = await fetch("https://api.sendgrid.com/v3/scopes", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!scopesRes.ok) {
    return { valid: false, reason: "invalid" };
  }

  const { scopes } = (await scopesRes.json()) as SendGridScopesResponse;
  if (!scopes.includes("mail.send")) {
    return { valid: false, reason: "missing_scope" };
  }

  const webhookScopePresent = scopes.some((s) => s.startsWith(WEBHOOK_EVENT_SETTINGS_SCOPE_PREFIX));

  const sendersRes = await fetch("https://api.sendgrid.com/v3/verified_senders", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const verifiedSenders: SendGridVerifiedSender[] = sendersRes.ok
    ? ((await sendersRes.json()) as SendGridVerifiedSendersResponse).results.map((sender) => ({
        id: sender.id,
        fromEmail: sender.from_email,
        nickname: sender.nickname,
      }))
    : [];

  return { valid: true, scopes, verifiedSenders, webhookScopePresent };
}

/**
 * GET /v3/templates?generations=dynamic (D-16 "refresh list" source for the
 * campaign builder's template picker). Same raw-fetch-with-`Bearer` key
 * convention as `validateTenantSendGridKey` above -- never imports
 * `@sendgrid/mail`'s module-level `sgMail` singleton. Always live, no local
 * cache (RESEARCH.md Don't-Hand-Roll: matches the verified-senders read).
 * Manual `template_id` entry remains the fallback if this returns `[]`
 * (non-ok response, e.g. an invalid/revoked key) or the tenant has no
 * dynamic templates yet.
 */
export async function listTenantSendGridTemplates(apiKey: string): Promise<SendGridDynamicTemplate[]> {
  const templatesRes = await fetch(
    "https://api.sendgrid.com/v3/templates?generations=dynamic&page_size=200",
    { headers: { Authorization: `Bearer ${apiKey}` } }
  );
  if (!templatesRes.ok) {
    return [];
  }

  const body = (await templatesRes.json()) as SendGridTemplatesResponse;
  const templates = body.result ?? body.templates ?? [];
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    generation: template.generation,
  }));
}
