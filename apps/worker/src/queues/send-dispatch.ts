import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { CONTACT_COLUMNS, type ContactRow } from "@mega-crm/contacts-core";
import { decryptTenantSecret } from "@mega-crm/kms";
import {
  evaluatePreSendGate,
  dispatchSendGate,
  recordSendResult,
  recordExcluded,
  buildContactTemplateData,
  buildMailSendRequest,
  sendTenantMailV3,
  signUnsubscribeToken,
  buildListUnsubscribeUrl,
  getWorkspaceSendSettings,
  type SendGridMailSendRequest,
  type SendTenantMailResult,
} from "@mega-crm/delivery-core";
import { emailBroadcastJobSchema, type EmailBroadcastJob, type EmailTriggeredJob } from "@mega-crm/shared-schemas";
import { consumeTenantToken, DEFAULT_TENANT_RPS } from "./rate-limiter.js";

/**
 * Effectively long-lived per RESEARCH.md Assumption A3 -- an old marketing
 * email sitting unopened for months must still successfully unsubscribe
 * when finally clicked (a CAN-SPAM/GDPR concern, not just a UX one). `exp`
 * stays in the signed payload only as defense-in-depth against unbounded
 * reuse outside this purpose, not as a short functional expiry.
 */
const UNSUBSCRIBE_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365 * 5;

export type SendJobResult =
  | { outcome: "sent"; sendId: string; providerMessageId: string | null }
  | { outcome: "skipped" }
  | { outcome: "excluded"; reason: string }
  | { outcome: "rate_limited"; rateLimitMs: number };

export interface ProcessSendJobDeps {
  /**
   * Overrides the real SendGrid call -- test files inject a fake resolving
   * a crafted 200/429/5xx `SendTenantMailResult` so every branch below can
   * be asserted without a live network call (RESEARCH.md Validation
   * Architecture Test Map).
   */
  sendMail?: (apiKey: string, payload: SendGridMailSendRequest) => Promise<SendTenantMailResult>;
  /** The rate limiter's dedicated ioredis client -- defaults to a lazily-created singleton from REDIS_URL. */
  redisClient?: Redis;
}

let defaultRedisClient: Redis | null = null;

/**
 * Lazily-created singleton ioredis client for the rate limiter -- its OWN
 * connection, separate from BullMQ's internal one (RESEARCH.md Code
 * Examples / read_first `connection.ts` note).
 */
function getDefaultRedisClient(): Redis {
  if (!defaultRedisClient) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is required for apps/worker's send-dispatch rate limiter");
    }
    defaultRedisClient = new Redis(redisUrl);
  }
  return defaultRedisClient;
}

/**
 * Computes the backoff duration from a SendGrid 429/5xx response
 * (RESEARCH.md Pattern 3): prefer `Retry-After` (seconds) when present, fall
 * back to `X-RateLimit-Reset` (a Unix-seconds timestamp), and finally a
 * fixed 2s seed when SendGrid sends neither header.
 */
function parseRetryAfter(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
  }

  const resetHeader = headers.get("x-ratelimit-reset");
  if (resetHeader !== null) {
    const resetUnixSeconds = Number(resetHeader);
    if (!Number.isNaN(resetUnixSeconds)) {
      const msUntilReset = resetUnixSeconds * 1000 - Date.now();
      if (msUntilReset > 0) {
        return msUntilReset;
      }
    }
  }

  return 2000;
}

interface CampaignRow {
  templateId: string | null;
  fromEmail: string | null;
}

interface SendgridKeyRow {
  ciphertext: string;
  encryptedDek: string;
  iv: string;
  authTag: string;
}

/**
 * The shared send-dispatch processor (SEND-01/02/05/06/07, SUBS-03/04) --
 * called by BOTH `email-broadcast.worker.ts` and `email-triggered.worker.ts`
 * so pre-send gating, throttling, and dispatch logic can never drift
 * between the two send sources (ARCHITECTURE.md Pitfall 6/7). Exported
 * standalone (not only as a Worker's inline processor) so
 * `send-dispatch-idempotency.test.ts`/`backoff.test.ts` can invoke it
 * directly, mirroring `events-ingest.worker.ts`'s exported-processor
 * convention -- `workspaceId` is always re-derived from `job.data`, never
 * ambient state. Never returns/throws a raw 429/5xx as an error: it signals
 * `{outcome: "rate_limited", rateLimitMs}` and leaves the actual
 * `worker.rateLimit()` + `Worker.RateLimitError()` call to the thin Worker
 * wrapper (Pattern 3), which keeps this function unit-testable without a
 * live BullMQ Worker.
 */
export async function processSendJob(
  data: EmailBroadcastJob | EmailTriggeredJob,
  deps: ProcessSendJobDeps = {}
): Promise<SendJobResult> {
  const job = emailBroadcastJobSchema.parse(data);
  const { workspaceId, campaignId, kind, contactId, testTo, testData } = job;
  const sendMail = deps.sendMail ?? sendTenantMailV3;
  const redisClient = deps.redisClient ?? getDefaultRedisClient();

  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows: keyRows } = await client.query<SendgridKeyRow>(
        `SELECT ciphertext, encrypted_dek as "encryptedDek", iv, auth_tag as "authTag"
         FROM workspace_sendgrid_keys WHERE workspace_id = $1`,
        [workspaceId]
      );
      const keyRow = keyRows[0];
      if (!keyRow) {
        throw new Error(`No SendGrid key connected for workspace ${workspaceId}`);
      }
      const apiKey = await decryptTenantSecret(workspaceId, keyRow);

      const settings = await getWorkspaceSendSettings(client, workspaceId);
      const rps = settings.rpsLimit ?? DEFAULT_TENANT_RPS;

      const { rows: campaignRows } = await client.query<CampaignRow>(
        `SELECT template_id as "templateId", from_email as "fromEmail"
         FROM campaigns WHERE id = $1 AND workspace_id = $2`,
        [campaignId, workspaceId]
      );
      const campaign = campaignRows[0];
      if (!campaign || !campaign.templateId || !campaign.fromEmail) {
        throw new Error(`Campaign ${campaignId} is missing a templateId/fromEmail for dispatch`);
      }
      const templateId = campaign.templateId;
      const fromEmail = campaign.fromEmail;

      let sendId: string;
      let to: string;
      let dynamicTemplateData: Record<string, unknown>;
      let unsubscribeUrl: string;

      if (kind === "campaign") {
        if (!contactId) {
          throw new Error("contactId is required for kind='campaign'");
        }

        const { rows: contactRows } = await client.query<ContactRow>(
          `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = $1 AND workspace_id = $2`,
          [contactId, workspaceId]
        );
        const contact = contactRows[0];
        if (!contact) {
          throw new Error(`Contact ${contactId} not found in workspace ${workspaceId}`);
        }

        const gateDecision = await evaluatePreSendGate(client, { workspaceId, contact });
        if (!gateDecision.sendable) {
          await recordExcluded(client, { workspaceId, campaignId, contactId }, gateDecision.reason);
          return { outcome: "excluded", reason: gateDecision.reason };
        }

        const dispatchResult = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
        if (dispatchResult === "skipped") {
          // SEND-06: a redelivered job for an already-'sent' row never
          // reaches this far again -- no second SendGrid call, no second row.
          return { outcome: "skipped" };
        }

        sendId = dispatchResult.sendId;
        to = contact.email as string; // evaluatePreSendGate already proved email is present (no_email otherwise)
        unsubscribeUrl = buildListUnsubscribeUrl(
          signUnsubscribeToken({
            sendId,
            contactId,
            workspaceId,
            exp: Math.floor(Date.now() / 1000) + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
          })
        );
        dynamicTemplateData = buildContactTemplateData(contact, { unsubscribeUrl }) as unknown as Record<string, unknown>;
      } else {
        // kind === "test" (Pitfall 1, D-12): rides the SAME queue (SEND-01),
        // but skips the pre-send gate AND the ledger insert entirely --
        // never filtered by the sending marketer's own subscription status,
        // never counted toward the frequency cap. Still carries a
        // List-Unsubscribe header and still passes through the per-tenant
        // rate limiter below (harmless for a single email).
        if (!testTo) {
          throw new Error("testTo is required for kind='test'");
        }
        to = testTo;
        sendId = randomUUID();
        unsubscribeUrl = buildListUnsubscribeUrl(
          signUnsubscribeToken({
            sendId,
            contactId: contactId ?? "test-send",
            workspaceId,
            exp: Math.floor(Date.now() / 1000) + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
          })
        );
        dynamicTemplateData =
          testData ??
          (buildContactTemplateData(
            {
              firstName: null,
              lastName: null,
              email: to,
              phone: null,
              city: null,
              country: null,
              tags: [],
              properties: {},
            },
            { unsubscribeUrl }
          ) as unknown as Record<string, unknown>);
      }

      // SEND-02/SEND-03: the per-tenant token bucket is consumed before
      // EVERY SendGrid call (campaign or test), regardless of which queue
      // the job came from -- both workers call this same function.
      const rateResult = await consumeTenantToken(redisClient, workspaceId, rps);
      if (!rateResult.allowed) {
        return { outcome: "rate_limited", rateLimitMs: rateResult.msBeforeNext };
      }

      const payload = buildMailSendRequest({
        to,
        templateId,
        fromEmail,
        dynamicTemplateData,
        listUnsubscribeUrl: unsubscribeUrl,
        sendId,
        workspaceId,
        campaignId,
      });
      const response = await sendMail(apiKey, payload);

      if (response.status === 429 || response.status >= 500) {
        // SEND-07: signal the caller to back off WITHOUT recording any
        // terminal status -- the `sends` row (for kind='campaign') stays
        // 'dispatching', so a retried job's dispatchSendGate call finds the
        // same row and is free to attempt the SendGrid call again.
        return { outcome: "rate_limited", rateLimitMs: parseRetryAfter(response.headers) };
      }

      if (kind === "campaign") {
        await recordSendResult(client, sendId, { status: "sent", providerMessageId: response.messageId });
      }
      return { outcome: "sent", sendId, providerMessageId: response.messageId };
    })
  );
}
