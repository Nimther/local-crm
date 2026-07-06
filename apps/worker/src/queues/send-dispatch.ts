import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { CONTACT_COLUMNS, type ContactRow } from "@mega-crm/contacts-core";
import { decryptTenantSecret } from "@mega-crm/kms";
import {
  evaluatePreSendGate,
  dispatchSendGate,
  releaseDispatchClaim,
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
  | { outcome: "failed"; sendId: string }
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

interface SendPrereqs {
  apiKey: string;
  rps: number;
  templateId: string;
  fromEmail: string;
}

/**
 * Reads the tenant's decrypted SendGrid key, send settings (RPS), and the
 * campaign's templateId/fromEmail -- shared by both the campaign-claim
 * transaction and the test-send transaction so the two dispatch paths can
 * never drift on how these prerequisites are resolved.
 */
async function readSendPrereqs(client: PoolClient, workspaceId: string, campaignId: string): Promise<SendPrereqs> {
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

  return { apiKey, rps, templateId: campaign.templateId, fromEmail: campaign.fromEmail };
}

interface ClaimedCampaignSend extends SendPrereqs {
  sendId: string;
  to: string;
  dynamicTemplateData: Record<string, unknown>;
  unsubscribeUrl: string;
}

type ClaimResult =
  | { kind: "proceed"; claim: ClaimedCampaignSend }
  | { kind: "excluded"; reason: string }
  | { kind: "skipped" }
  | { kind: "failed"; sendId: string };

/**
 * CR-04 fix, unit 1 of 3: the ONLY transaction that touches the ledger
 * before SendGrid is ever called. Reads all prerequisites, runs the
 * pre-send gate, and commits the 'dispatching' claim -- all in one
 * transaction, so a worker crash immediately after COMMIT leaves a
 * committed claim (not a half-inserted row) for a redelivered job to find
 * via `dispatchSendGate`'s `interrupted` signal, which is handled entirely
 * within this SAME transaction (no SendGrid call, no second transaction
 * needed for that branch).
 */
async function claimCampaignSend(
  client: PoolClient,
  params: { workspaceId: string; campaignId: string; contactId: string }
): Promise<ClaimResult> {
  const { workspaceId, campaignId, contactId } = params;
  const prereqs = await readSendPrereqs(client, workspaceId, campaignId);

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
    return { kind: "excluded", reason: gateDecision.reason };
  }

  const dispatchResult = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
  if (dispatchResult === "skipped") {
    // SEND-06: a redelivered job for an already-terminal row never reaches
    // this far again -- no second SendGrid call, no second row.
    return { kind: "skipped" };
  }

  if (dispatchResult.interrupted) {
    // CR-04: a PRIOR attempt already committed this claim and never
    // finished (crash between the claim commit and the terminal record).
    // Never re-call SendGrid for it -- record it as failed instead, closing
    // the duplicate-send window at-most-once.
    await recordSendResult(client, dispatchResult.sendId, { status: "failed" });
    return { kind: "failed", sendId: dispatchResult.sendId };
  }

  const sendId = dispatchResult.sendId;
  const to = contact.email as string; // evaluatePreSendGate already proved email is present (no_email otherwise)
  const unsubscribeUrl = buildListUnsubscribeUrl(
    signUnsubscribeToken({
      sendId,
      contactId,
      workspaceId,
      exp: Math.floor(Date.now() / 1000) + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
    })
  );
  const dynamicTemplateData = buildContactTemplateData(contact, { unsubscribeUrl }) as unknown as Record<string, unknown>;

  return { kind: "proceed", claim: { ...prereqs, sendId, to, dynamicTemplateData, unsubscribeUrl } };
}

/**
 * The shared send-dispatch processor (SEND-01/02/05/06/07, SUBS-03/04) --
 * called by BOTH `email-broadcast.worker.ts` and `email-triggered.worker.ts`
 * so pre-send gating, throttling, and dispatch logic can never drift
 * between the two send sources (ARCHITECTURE.md Pitfall 6/7). Exported
 * standalone (not only as a Worker's inline processor) so
 * `send-dispatch-idempotency.test.ts`/`backoff.test.ts`/
 * `send-dispatch-durability.test.ts` can invoke it directly, mirroring
 * `events-ingest.worker.ts`'s exported-processor convention --
 * `workspaceId` is always re-derived from `job.data`, never ambient state.
 * Never returns/throws a raw 429/5xx as an error: it signals
 * `{outcome: "rate_limited", rateLimitMs}` and leaves the actual
 * `worker.rateLimit()` + `Worker.RateLimitError()` call to the thin Worker
 * wrapper (Pattern 3), which keeps this function unit-testable without a
 * live BullMQ Worker.
 *
 * CR-04: the external SendGrid call is NEVER inside a database transaction.
 * For `kind === "campaign"` dispatch runs as three units -- (1) a claim
 * transaction that commits the 'dispatching' row before any network call,
 * (2) the SendGrid call itself, outside any transaction, and (3) a record
 * transaction that only ever runs AFTER SendGrid has responded. A crash
 * between (1) and (2), or between (2) and (3), can only ever leave a
 * committed 'dispatching' claim -- never a duplicate SendGrid call, because
 * `claimCampaignSend`'s `interrupted` branch (unit 1) intercepts a
 * redelivered job before it ever reaches unit 2 again.
 */
export async function processSendJob(
  data: EmailBroadcastJob | EmailTriggeredJob,
  deps: ProcessSendJobDeps = {}
): Promise<SendJobResult> {
  const job = emailBroadcastJobSchema.parse(data);
  const { workspaceId, campaignId, kind, contactId, testTo, testData } = job;
  const sendMail = deps.sendMail ?? sendTenantMailV3;
  const redisClient = deps.redisClient ?? getDefaultRedisClient();

  return withTenant(workspaceId, async () => {
    if (kind === "campaign") {
      if (!contactId) {
        throw new Error("contactId is required for kind='campaign'");
      }

      // Unit 1: claim transaction -- commits BEFORE any SendGrid call.
      const claimResult = await withTenantTransaction((client) =>
        claimCampaignSend(client, { workspaceId, campaignId, contactId })
      );

      if (claimResult.kind === "excluded") {
        return { outcome: "excluded", reason: claimResult.reason };
      }
      if (claimResult.kind === "skipped") {
        return { outcome: "skipped" };
      }
      if (claimResult.kind === "failed") {
        return { outcome: "failed", sendId: claimResult.sendId };
      }

      const { claim } = claimResult;

      // SEND-02/SEND-03: the per-tenant token bucket is consumed before
      // EVERY SendGrid call, regardless of which queue the job came from.
      const rateResult = await consumeTenantToken(redisClient, workspaceId, claim.rps);
      if (!rateResult.allowed) {
        // The claim was already committed (unit 1) -- release it so it
        // isn't left stranded blocking a legitimate retry (T-04-12-03).
        await withTenantTransaction((client) => releaseDispatchClaim(client, claim.sendId));
        return { outcome: "rate_limited", rateLimitMs: rateResult.msBeforeNext };
      }

      // Unit 2: the external SendGrid call -- NOT inside any transaction.
      const payload = buildMailSendRequest({
        to: claim.to,
        templateId: claim.templateId,
        fromEmail: claim.fromEmail,
        dynamicTemplateData: claim.dynamicTemplateData,
        listUnsubscribeUrl: claim.unsubscribeUrl,
        sendId: claim.sendId,
        workspaceId,
        campaignId,
      });
      const response = await sendMail(claim.apiKey, payload);

      // Unit 3: record the terminal result in a SEPARATE transaction, only
      // ever entered after SendGrid has responded.
      if (response.status === 429 || response.status >= 500) {
        // SEND-07: SendGrid did not accept the message -- release the
        // claim so a clean backoff retry re-claims and re-attempts.
        await withTenantTransaction((client) => releaseDispatchClaim(client, claim.sendId));
        return { outcome: "rate_limited", rateLimitMs: parseRetryAfter(response.headers) };
      }

      if (response.status >= 400) {
        // CR-03: a non-retryable 4xx rejection (400/401/403/413/...) is
        // recorded as failed, never as sent.
        await withTenantTransaction((client) => recordSendResult(client, claim.sendId, { status: "failed" }));
        return { outcome: "failed", sendId: claim.sendId };
      }

      await withTenantTransaction((client) =>
        recordSendResult(client, claim.sendId, { status: "sent", providerMessageId: response.messageId })
      );
      return { outcome: "sent", sendId: claim.sendId, providerMessageId: response.messageId };
    }

    // kind === "test" (Pitfall 1, D-12): rides the SAME queue (SEND-01),
    // but skips the pre-send gate AND the ledger insert entirely -- never
    // filtered by the sending marketer's own subscription status, never
    // counted toward the frequency cap, and never has a claim to release.
    // Still carries a List-Unsubscribe header and still passes through the
    // per-tenant rate limiter below (harmless for a single email).
    if (!testTo) {
      throw new Error("testTo is required for kind='test'");
    }
    const sendId = randomUUID();
    const unsubscribeUrl = buildListUnsubscribeUrl(
      signUnsubscribeToken({
        sendId,
        contactId: contactId ?? "test-send",
        workspaceId,
        exp: Math.floor(Date.now() / 1000) + UNSUBSCRIBE_TOKEN_TTL_SECONDS,
      })
    );
    const dynamicTemplateData =
      testData ??
      (buildContactTemplateData(
        {
          firstName: null,
          lastName: null,
          email: testTo,
          phone: null,
          city: null,
          country: null,
          tags: [],
          properties: {},
        },
        { unsubscribeUrl }
      ) as unknown as Record<string, unknown>);

    const prereqs = await withTenantTransaction((client) => readSendPrereqs(client, workspaceId, campaignId));

    const rateResult = await consumeTenantToken(redisClient, workspaceId, prereqs.rps);
    if (!rateResult.allowed) {
      return { outcome: "rate_limited", rateLimitMs: rateResult.msBeforeNext };
    }

    const payload = buildMailSendRequest({
      to: testTo,
      templateId: prereqs.templateId,
      fromEmail: prereqs.fromEmail,
      dynamicTemplateData,
      listUnsubscribeUrl: unsubscribeUrl,
      sendId,
      workspaceId,
      campaignId,
    });
    const response = await sendMail(prereqs.apiKey, payload);

    if (response.status === 429 || response.status >= 500) {
      return { outcome: "rate_limited", rateLimitMs: parseRetryAfter(response.headers) };
    }

    return { outcome: "sent", sendId, providerMessageId: response.messageId };
  });
}
