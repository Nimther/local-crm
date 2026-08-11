/**
 * SendGrid v3 `mail/send` request shape (SEND-05, RESEARCH.md Code Examples).
 * `headers` may NOT override x-sg-id/x-sg-eid/received/dkim-signature/
 * Content-Type/Content-Transfer-Encoding/To/From/Subject/Reply-To/CC/BCC --
 * `List-Unsubscribe`/`List-Unsubscribe-Post` are NOT in that forbidden list.
 */
export interface SendGridMailSendRequest {
  personalizations: Array<{
    to: [{ email: string }];
    dynamic_template_data: Record<string, unknown>;
    custom_args: { send_id: string; workspace_id: string; campaign_id: string };
  }>;
  from: { email: string };
  template_id: string;
  headers: {
    "List-Unsubscribe": string;
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click";
  };
  tracking_settings: {
    // D-15: SendGrid's own unsubscribe tracking is disabled -- the platform
    // (contacts.subscription_status) is the single source of truth, avoiding
    // two competing unsubscribe mechanisms.
    subscription_tracking: { enable: false };
  };
}

export interface BuildMailSendRequestParams {
  to: string;
  templateId: string;
  fromEmail: string;
  dynamicTemplateData: Record<string, unknown>;
  /** The fully-built `${PUBLIC_APP_URL}/unsubscribe/${token}` URL (see `buildListUnsubscribeUrl`). */
  listUnsubscribeUrl: string;
  /** This send's `sends.id` -- also the token's `sendId` (RESEARCH.md Pitfall 5). */
  sendId: string;
  workspaceId: string;
  campaignId: string;
}

/** Builds the exact `mail/send` request shape for one recipient (SEND-05, D-15). */
export function buildMailSendRequest(params: BuildMailSendRequestParams): SendGridMailSendRequest {
  return {
    personalizations: [
      {
        to: [{ email: params.to }],
        dynamic_template_data: params.dynamicTemplateData,
        custom_args: {
          send_id: params.sendId,
          workspace_id: params.workspaceId,
          campaign_id: params.campaignId,
        },
      },
    ],
    from: { email: params.fromEmail },
    template_id: params.templateId,
    headers: {
      "List-Unsubscribe": `<${params.listUnsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tracking_settings: {
      subscription_tracking: { enable: false },
    },
  };
}

export interface SendTenantMailResult {
  status: number;
  headers: Headers;
  messageId: string | null;
}

/**
 * Redacts the tenant's decrypted API key from any thrown/logged error
 * message or stack (T-04-03-04) -- the key must never end up in logs even
 * transitively via an error object.
 */
function redactApiKey(err: unknown, apiKey: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = new Error(message.split(apiKey).join("[REDACTED]"));
  if (err instanceof Error && err.stack) {
    redacted.stack = err.stack.split(apiKey).join("[REDACTED]");
  }
  return redacted;
}

/**
 * Raw `fetch` POST to SendGrid's `mail/send` v3 endpoint with a per-call
 * `Authorization: Bearer` header (RESEARCH.md Pitfall 2 / Anti-Patterns --
 * never `@sendgrid/mail`'s module-level `sgMail` singleton, which would race
 * across concurrently-dispatching tenants). Matches the raw-fetch convention
 * already established by `apps/api/src/modules/tenancy/sendgrid-client.ts`.
 */
export async function sendTenantMailV3(
  apiKey: string,
  payload: SendGridMailSendRequest
): Promise<SendTenantMailResult> {
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return { status: res.status, headers: res.headers, messageId: res.headers.get("x-message-id") };
  } catch (err) {
    throw redactApiKey(err, apiKey);
  }
}
