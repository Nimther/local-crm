/**
 * SendGrid Event Webhook auto-provisioning (D-01/D-02/D-05, RESEARCH.md
 * "SendGrid webhook auto-provisioning"): stands up the platform's OWN
 * independently-named Event Webhook via a tenant's BYO key, by reading a
 * per-request-decrypted key argument. Structurally separate from
 * `platform-mail/client.ts` (RESEARCH.md Pitfall 4 -- two-key discipline):
 * this module never imports platform-mail, reads no env var directly (the
 * key is always passed in, already decrypted by the caller), and has a
 * completely different function signature (`provisionEventWebhook(apiKey,
 * callbackUrl, workspaceId, existingWebhookId?)` vs. platformMail's `{ to,
 * subject, html }`-shaped senders) so a type error, not a runtime mix-up,
 * would catch any accidental cross-use.
 */

/** D-05: our own independently-named webhook, never touching a tenant's pre-existing ones. */
const WEBHOOK_FRIENDLY_NAME_BASE = "Mega CRM Delivery Tracking";

/**
 * Workspace-scoped friendly_name (CR-01 / T-05-G2-01): one BYO SendGrid key
 * can be connected to multiple workspaces, so a single global friendly_name
 * would let workspace B's provisioning match/adopt/repoint workspace A's
 * webhook. Appending a short workspace discriminator keeps each workspace's
 * match/create/patch scoped to only its OWN webhook.
 */
function webhookFriendlyName(workspaceId: string): string {
  return `${WEBHOOK_FRIENDLY_NAME_BASE} (${workspaceId.slice(0, 8)})`;
}

const EVENT_FLAGS = {
  delivered: true,
  bounce: true,
  dropped: true,
  open: true,
  click: true,
  unsubscribe: true,
  group_unsubscribe: true, // D-11: group_unsubscribe also -> unsubscribed
  spam_report: true,
} as const;

export type ProvisionEventWebhookError = "missing_scope" | "cap_reached" | "failed";

export type ProvisionEventWebhookResult =
  | { id: string; publicKey: string }
  | { error: ProvisionEventWebhookError; webhookId?: string };

interface SendGridWebhookSummary {
  id: string;
  url: string;
  friendly_name?: string;
}

interface SendGridWebhookListResponse {
  webhooks?: SendGridWebhookSummary[];
  max_allowed?: number;
}

interface SendGridWebhookIdResponse {
  id: string;
}

interface SendGridSignedWebhookResponse {
  id: string;
  public_key: string;
}

/**
 * Redacts the tenant's decrypted API key from any thrown/logged error
 * message or stack (T-05-10) -- mirrors `send-mail.ts`'s `redactApiKey`
 * approach verbatim.
 */
function redactApiKey(err: unknown, apiKey: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = new Error(message.split(apiKey).join("[REDACTED]"));
  if (err instanceof Error && err.stack) {
    redacted.stack = err.stack.split(apiKey).join("[REDACTED]");
  }
  return redacted;
}

function errorForStatus(status: number): ProvisionEventWebhookError {
  return status === 401 || status === 403 ? "missing_scope" : "failed";
}

/**
 * Redacts the tenant's decrypted API key from an arbitrary logged string
 * (T-05-08-01) -- same substring-replace approach as `redactApiKey`, but
 * for a plain string (a SendGrid response body) rather than an Error.
 */
function redactSecret(text: string, apiKey: string): string {
  return text.split(apiKey).join("[REDACTED]");
}

/**
 * Logs a non-ok SendGrid provisioning response's status + redacted body so
 * an operator can diagnose WHY provisioning failed (closes the L2 silent
 * failure gap from sendgrid-webhook-not-provisioned.md). Never logs the
 * Authorization header or the raw (unredacted) body -- only the
 * `redactSecret`-processed text.
 */
async function logNonOkProvisionResponse(context: string, res: Response, apiKey: string): Promise<void> {
  const bodyText = await res.text();
  // eslint-disable-next-line no-console
  console.warn(`provisionEventWebhook [${context}] non-ok response:`, res.status, redactSecret(bodyText, apiKey));
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

/**
 * Best-effort pre-flight (Pitfall 4): lists the account's existing Event
 * Webhooks so a CREATE can (a) reuse an already-present platform webhook by
 * `friendly_name` instead of accumulating a duplicate if the stored id was
 * ever lost, and (b) detect the plan's `max_allowed` cap before attempting a
 * doomed POST. A failed listing call (e.g. insufficient scope) is non-fatal
 * here -- the real CREATE attempt below still runs and surfaces its own
 * typed error.
 */
async function listExistingWebhooks(
  apiKey: string
): Promise<{ webhooks: SendGridWebhookSummary[]; maxAllowed: number } | null> {
  const res = await fetch("https://api.sendgrid.com/v3/user/webhooks/event/settings/all", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    await logNonOkProvisionResponse("list", res, apiKey);
    return null;
  }
  const body = (await res.json()) as SendGridWebhookListResponse;
  return {
    webhooks: body.webhooks ?? [],
    maxAllowed: body.max_allowed ?? Number.POSITIVE_INFINITY,
  };
}

async function postCreate(
  apiKey: string,
  url: string,
  callbackUrl: string,
  workspaceId: string
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      enabled: true,
      url: callbackUrl,
      friendly_name: webhookFriendlyName(workspaceId),
      ...EVENT_FLAGS,
    }),
  });
}

/**
 * CREATE (Open Question #1 / Assumption A3): attempts the documented path
 * first, falling back to `.../settings/all` on a 404/405 response. Guarded
 * by `listExistingWebhooks` so a reconnect that ever lost its stored
 * `sendgridWebhookId` reuses the platform's own webhook by the
 * workspace-scoped `friendly_name` instead of creating a duplicate, and a
 * plan `max_allowed` cap is surfaced as a typed error before ever POSTing
 * (Pitfall 4). CR-01 / T-05-G2-02: when the matched webhook's `url` no
 * longer equals the caller's `callbackUrl` (e.g. its stored id was
 * recovered after a lost DB row, so the pathToken changed), the reused
 * webhook is PATCHed to the new callbackUrl before being returned as
 * active -- otherwise it would keep pointing at a now-404ing stale URL
 * while reporting `provisionStatus: 'active'`.
 */
async function createWebhook(
  apiKey: string,
  callbackUrl: string,
  workspaceId: string
): Promise<{ id: string } | { error: ProvisionEventWebhookError }> {
  const listing = await listExistingWebhooks(apiKey);
  if (listing) {
    const existing = listing.webhooks.find(
      (webhook) => webhook.friendly_name === webhookFriendlyName(workspaceId)
    );
    if (existing) {
      if (existing.url !== callbackUrl) {
        return patchWebhook(apiKey, existing.id, callbackUrl, workspaceId);
      }
      return { id: existing.id };
    }
    if (listing.webhooks.length >= listing.maxAllowed) {
      return { error: "cap_reached" };
    }
  }

  let res = await postCreate(
    apiKey,
    "https://api.sendgrid.com/v3/user/webhooks/event/settings",
    callbackUrl,
    workspaceId
  );
  if (res.status === 404 || res.status === 405) {
    // A3 fallback: retry against the `.../settings/all` path.
    res = await postCreate(
      apiKey,
      "https://api.sendgrid.com/v3/user/webhooks/event/settings/all",
      callbackUrl,
      workspaceId
    );
  }
  if (!res.ok) {
    await logNonOkProvisionResponse("create", res, apiKey);
    return { error: errorForStatus(res.status) };
  }
  const created = (await res.json()) as SendGridWebhookIdResponse;
  return { id: created.id };
}

/** PATCH in place (D-05, Pitfall 4) -- a reconnect never re-POSTs a create. */
async function patchWebhook(
  apiKey: string,
  id: string,
  callbackUrl: string,
  workspaceId: string
): Promise<{ id: string } | { error: ProvisionEventWebhookError }> {
  const res = await fetch(`https://api.sendgrid.com/v3/user/webhooks/event/settings/${id}`, {
    method: "PATCH",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      enabled: true,
      url: callbackUrl,
      friendly_name: webhookFriendlyName(workspaceId),
      ...EVENT_FLAGS,
    }),
  });
  if (!res.ok) {
    await logNonOkProvisionResponse("patch", res, apiKey);
    return { error: errorForStatus(res.status) };
  }
  const patched = (await res.json()) as SendGridWebhookIdResponse;
  return { id: patched.id };
}

/** Enables signed verification; the `public_key` is returned in the same response (confirmed against official docs). */
async function enableSignedVerification(
  apiKey: string,
  id: string
): Promise<{ id: string; publicKey: string } | { error: ProvisionEventWebhookError }> {
  const res = await fetch(`https://api.sendgrid.com/v3/user/webhooks/event/settings/signed/${id}`, {
    method: "PATCH",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ enabled: true }),
  });
  if (!res.ok) {
    await logNonOkProvisionResponse("signed", res, apiKey);
    return { error: errorForStatus(res.status) };
  }
  const body = (await res.json()) as SendGridSignedWebhookResponse;
  return { id: body.id, publicKey: body.public_key };
}

/**
 * Creates or PATCHes the platform's own named, signed Event Webhook via the
 * tenant's key (D-01/D-02/D-05). Never throws for expected failures
 * (insufficient scope, plan cap, or any other non-ok SendGrid response) --
 * always returns a typed `{ error }` so a provisioning failure degrades
 * gracefully without ever failing the SendGrid key connect/recheck itself
 * (D-01 fallback). Any genuinely unexpected exception (network failure,
 * JSON parse error) is redacted (T-05-10) and also mapped to
 * `{ error: "failed" }` -- this function never throws.
 */
export async function provisionEventWebhook(
  apiKey: string,
  callbackUrl: string,
  workspaceId: string,
  existingWebhookId?: string
): Promise<ProvisionEventWebhookResult> {
  try {
    const webhookResult = existingWebhookId
      ? await patchWebhook(apiKey, existingWebhookId, callbackUrl, workspaceId)
      : await createWebhook(apiKey, callbackUrl, workspaceId);
    if ("error" in webhookResult) {
      return webhookResult;
    }

    const signedResult = await enableSignedVerification(apiKey, webhookResult.id);
    if ("error" in signedResult) {
      return { error: signedResult.error, webhookId: webhookResult.id };
    }

    return { id: signedResult.id, publicKey: signedResult.publicKey };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("provisionEventWebhook failed:", redactApiKey(err, apiKey));
    return { error: "failed" };
  }
}
