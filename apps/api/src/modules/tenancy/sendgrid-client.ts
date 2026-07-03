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
  | { valid: true; scopes: string[]; verifiedSenders: SendGridVerifiedSender[] }
  | { valid: false; reason: "invalid" | "missing_scope" };

interface SendGridScopesResponse {
  scopes: string[];
}

interface SendGridVerifiedSendersResponse {
  results: Array<{ id: number; from_email: string; nickname?: string }>;
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

  return { valid: true, scopes, verifiedSenders };
}
