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
    // 06-03: `campaign_id` is omitted entirely (not present, not an empty
    // string) for a flow-step send -- there is no campaigns row to
    // attribute to. Webhook attribution (05-03) resolves via `send_id`
    // alone (a DB lookup of the `sends` row), so an absent `campaign_id`
    // never breaks delivery-event processing.
    custom_args: { send_id: string; workspace_id: string; campaign_id?: string; test?: "true" };
  }>;
  from: { email: string; name?: string };
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
    // D-04 (Phase 5, closes Pitfall 3): forced on for EVERY send, independent
    // of the tenant's own SendGrid account-level tracking settings -- webhook
    // opened/clicked events never fire otherwise.
    open_tracking: { enable: true };
    click_tracking: { enable: true };
  };
}

export interface BuildMailSendRequestParams {
  to: string;
  templateId: string;
  fromEmail: string;
  /** Optional inbox-visible display name for the RFC 5322 From identity. */
  fromName?: string | null;
  dynamicTemplateData: Record<string, unknown>;
  /** The fully-built `${PUBLIC_APP_URL}/unsubscribe/${token}` URL (see `buildListUnsubscribeUrl`). */
  listUnsubscribeUrl: string;
  /** This send's `sends.id` -- also the token's `sendId` (RESEARCH.md Pitfall 5). */
  sendId: string;
  workspaceId: string;
  /** Absent for a flow-step send (06-03) -- a flow send has no campaigns row to attribute to. */
  campaignId?: string;
  /**
   * D-15 (Phase 5, closes Pitfall 2): when true, tags the outbound message
   * with a `test: "true"` custom_arg so webhook events for it can be
   * excluded from stats/suppression -- a bounced test address must never be
   * indistinguishable from a real orphaned send. Only `kind='test'` dispatch
   * sets this; `kind='campaign'` sends must never carry the key at all.
   */
  isTest?: boolean;
}

/** Builds the exact `mail/send` request shape for one recipient (SEND-05, D-15). */
export function buildMailSendRequest(params: BuildMailSendRequestParams): SendGridMailSendRequest {
  const fromName = params.fromName?.trim();
  return {
    personalizations: [
      {
        to: [{ email: params.to }],
        dynamic_template_data: params.dynamicTemplateData,
        custom_args: {
          send_id: params.sendId,
          workspace_id: params.workspaceId,
          ...(params.campaignId !== undefined ? { campaign_id: params.campaignId } : {}),
          ...(params.isTest === true ? { test: "true" as const } : {}),
        },
      },
    ],
    from: fromName ? { email: params.fromEmail, name: fromName } : { email: params.fromEmail },
    template_id: params.templateId,
    headers: {
      "List-Unsubscribe": `<${params.listUnsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tracking_settings: {
      subscription_tracking: { enable: false },
      open_tracking: { enable: true },
      click_tracking: { enable: true },
    },
  };
}

export interface SendTenantMailResult {
  status: number;
  headers: Headers;
  messageId: string | null;
}

/**
 * SendGrid `mail/send` call timeout (Phase 11, D-15, DLV-06) -- versioned
 * constant, Phase 9 D-12 convention (a change to this number must be
 * visible in a diff, never silently absorbed into a library default).
 *
 * Deliberately, STRICTLY below `SEND_LOCK_DURATION_MS`
 * (`apps/worker/src/queues/queue-options.ts`), with margin left over for the
 * claim transaction that runs before this call and the record transaction
 * that runs after it. `apps/worker/src/queues/__tests__/
 * send-timing-invariant.test.ts` asserts
 * `SENDGRID_TIMEOUT_MS + CLAIM_TX_MARGIN_MS + RECORD_TX_MARGIN_MS <
 * SEND_LOCK_DURATION_MS` against these real exported values -- not just a
 * comment asserting it.
 *
 * Why the ordering matters (ARCHITECTURE.md §9, the send delivery state
 * machine): BullMQ renews a job's lock on a timer independent of the job
 * processor's own promise. If this call could hang past `lockDuration`,
 * BullMQ's stalled-checker could redeliver the job to a SECOND live worker
 * while the FIRST worker's `sendTenantMailV3` call is still pending -- two
 * live processors racing to write the same `sends` row. Bounding this call
 * strictly below the lock duration guarantees the original processor always
 * reaches its own terminal/ambiguous write first.
 */
export const SENDGRID_TIMEOUT_MS = 20_000;

/**
 * `sendTenantMailV3`'s target URL (Phase 16, D-06/D-07) -- versioned
 * constant, same Phase 9 D-12 convention as `SENDGRID_TIMEOUT_MS` above (a
 * change must be visible in a diff, never silently absorbed into a library
 * default). The default -- and the ONLY value any production boot ever
 * uses -- is the real SendGrid `mail/send` endpoint. `SENDGRID_BASE_URL`
 * exists solely for Phase 16's fault-injection UAT session, where a real
 * HTTP 429 must reach this production fetch path without genuinely
 * exceeding SendGrid's own rate ceiling (D-06). An empty-string value is
 * treated as absent -- an accidentally-blanked env line must not
 * half-enable this seam. Only this call site reads the override; the
 * tenant key-check client (`apps/api/src/modules/tenancy/sendgrid-client.ts`)
 * and the platform system-mail sender are structurally separate files and
 * never read it.
 */
export const SENDGRID_MAIL_SEND_URL: string =
  process.env.SENDGRID_BASE_URL && process.env.SENDGRID_BASE_URL.length > 0
    ? process.env.SENDGRID_BASE_URL
    : "https://api.sendgrid.com/v3/mail/send";

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
 *
 * Bounded by `AbortSignal.timeout(SENDGRID_TIMEOUT_MS)` (Phase 11, D-15) --
 * no call can hang unbounded and pin a worker concurrency slot indefinitely.
 * Every thrown error -- a normal network failure, an HTTP-level rejection
 * `fetch` itself never throws for, or the abort firing mid-flight -- still
 * leaves this function ONLY via `redactApiKey` below: there is exactly one
 * `try`/`catch` in this function, deliberately, so the timeout path cannot
 * accidentally open a second, unredacted error route out of this call.
 */
export async function sendTenantMailV3(
  apiKey: string,
  payload: SendGridMailSendRequest
): Promise<SendTenantMailResult> {
  try {
    const res = await fetch(SENDGRID_MAIL_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
    });
    return { status: res.status, headers: res.headers, messageId: res.headers.get("x-message-id") };
  } catch (err) {
    throw redactApiKey(err, apiKey);
  }
}
