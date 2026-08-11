import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { PoolClient } from "pg";
import { scrubbedConsole } from "@mega-crm/redaction";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { CONTACT_COLUMNS, type ContactRow } from "@mega-crm/contacts-core";
import { decryptTenantSecret } from "@mega-crm/kms";
import {
  evaluatePreSendGate,
  dispatchSendGate,
  releaseDispatchClaim,
  recordSendResult,
  recordExcluded,
  recordFlowStepResult,
  incrementCampaignSendCounter,
  tryCompleteCampaign,
  buildContactTemplateData,
  buildMailSendRequest,
  sendTenantMailV3,
  signUnsubscribeToken,
  buildListUnsubscribeUrl,
  getWorkspaceSendSettings,
  classifyTransportError,
  type SendGridMailSendRequest,
  type SendTenantMailResult,
} from "@mega-crm/delivery-core";
import {
  emailBroadcastJobSchema,
  emailTriggeredJobSchema,
  type EmailBroadcastJob,
  type EmailTriggeredJob,
} from "@mega-crm/shared-schemas";
import { consumeTenantToken, DEFAULT_TENANT_RPS } from "./rate-limiter.js";
import { claimFlowSend } from "./flows/flow-send.js";
import {
  acquireTenantLaneSlot,
  releaseTenantLaneSlot,
  resolveTenantLaneCap,
  SEND_SLOT_LEASE_TTL_MS,
  type TenantLane,
} from "./tenant-lane-semaphore.js";

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
  // Phase 11 (D-10, plan 11-05): `cause` discriminates WHY the send is being
  // rate-limited, because the two causes now get different retry treatment.
  // `tenant_bucket` (the per-tenant rate-limiter-flexible token bucket
  // denied the call) is NOT a failure -- the Worker wrapper keeps turning it
  // into `worker.rateLimit()` + `Worker.RateLimitError()`, consuming none of
  // the job's `attempts`. `provider_backoff` (SendGrid itself returned
  // 429/5xx) now consumes ONE of the job's BOUNDED `attempts`, with BullMQ's
  // exponential backoff applying between redeliveries -- the previous
  // unbounded Retry-After-driven `worker.rateLimit()` loop for this case is
  // deliberately gone. Introduced now (not deferred) because Phase 12's
  // WRK-01 is documented to split exactly this cause discriminator further
  // (per-tenant fairness, queue-depth-aware backoff, etc.) -- shaping the
  // field now means WRK-01 extends this shape instead of reshaping it.
  | { outcome: "rate_limited"; rateLimitMs: number; cause: "tenant_bucket" | "provider_backoff" }
  // Phase 11 (DLV-02, plan 11-03): a prior attempt already committed the
  // 'dispatching' claim and never reached a terminal write (worker crash
  // between the claim commit and the SendGrid call, or between the call and
  // the record transaction) -- this process cannot prove whether SendGrid
  // was ever called, so it stops asserting an outcome (it no longer writes
  // 'failed' here) and hands the row to the reconciler
  // (send-reconciler.worker.ts), which backfills counters exactly once when
  // it resolves the row from webhook evidence. Shaped as its own variant
  // (not folded into "failed") so Phase 12 can add a `cause` discriminator
  // to THIS variant without reshaping the ones above it.
  | { outcome: "reconciling"; sendId: string }
  // Phase 11 (D-11, plan 11-10): the test-send-only ambiguous disposition.
  // A `kind='test'` send has no `sends` row (D-12) -- the ledger path
  // expresses ambiguity as the `reconciling` STATE on a row it owns; the
  // test path has no row to write a state onto, so the ambiguity has to
  // live in the returned outcome instead. Never automatically retried
  // (D-11): the branch that produces this returns rather than throws, so
  // BullMQ completes the job instead of redelivering it.
  | { outcome: "unknown"; sendId: string };

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
    // 12-REVIEW.md WR-01: without this listener, a connection error on this
    // client bypasses scrubbedConsole entirely -- ioredis 5.x's own internal
    // fallback logs it unredacted via raw `console.error` (it does not crash
    // the process the way an unhandled `pg.Pool` error would), which is both
    // an unredacted-log risk and invisible to every other error/log path in
    // this codebase.
    defaultRedisClient.on("error", (err) => {
      scrubbedConsole.error("send-dispatch: default rate-limiter/semaphore Redis client error", err);
    });
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

/**
 * WRK-02 (D-01/D-02, T-12-04-03): derives the tenant-lane-semaphore lane
 * from the job's validated `kind`, never from a separate caller-supplied
 * argument -- a job payload can never select a different lane's slot pool.
 * `campaign` and `test` jobs ride `EMAIL_BROADCAST_QUEUE`, `flow` jobs ride
 * `EMAIL_TRIGGERED_QUEUE` (packages/shared-schemas/src/queues.ts), so the
 * lane is a property of the kind: the broadcast lane for the former two,
 * the triggered lane for the latter.
 */
function laneForSendJobKind(kind: "campaign" | "test" | "flow"): TenantLane {
  return kind === "flow" ? "triggered" : "broadcast";
}

interface CampaignRow {
  templateId: string | null;
  fromEmail: string | null;
  status: string;
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
  /** CR-06: the campaign's live status -- claimCampaignSend gates kind='campaign' dispatch on this being 'sending'; the kind='test' path never reads it. */
  status: string;
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
    `SELECT template_id as "templateId", from_email as "fromEmail", status
     FROM campaigns WHERE id = $1 AND workspace_id = $2`,
    [campaignId, workspaceId]
  );
  const campaign = campaignRows[0];
  if (!campaign || !campaign.templateId || !campaign.fromEmail) {
    throw new Error(`Campaign ${campaignId} is missing a templateId/fromEmail for dispatch`);
  }

  return { apiKey, rps, templateId: campaign.templateId, fromEmail: campaign.fromEmail, status: campaign.status };
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
  | { kind: "failed"; sendId: string }
  | { kind: "reconciling"; sendId: string };

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

  // CR-06: a campaign that is no longer 'sending' (canceled, or already
  // terminal) must never claim or dispatch -- checked before the contact
  // fetch, the pre-send gate, or dispatchSendGate's own claim insert.
  if (prereqs.status !== "sending") {
    return { kind: "skipped" };
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
    return { kind: "excluded", reason: gateDecision.reason };
  }

  const dispatchResult = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
  if (dispatchResult === "skipped") {
    // SEND-06: a redelivered job for an already-terminal row never reaches
    // this far again -- no second SendGrid call, no second row.
    return { kind: "skipped" };
  }

  if (dispatchResult.interrupted) {
    // Phase 11 (DLV-02, was CR-04's "record it as failed" -- superseded): a
    // PRIOR attempt already committed this claim and never finished (crash
    // between the claim commit and the terminal record). This process
    // cannot prove whether SendGrid was ever called for it, so it must NOT
    // assert an outcome -- 'failed' would tell an operator/analyst "nothing
    // was sent" when a phantom-accepted mail may already be in the
    // recipient's inbox. Never re-call SendGrid for it; hand it to the
    // reconciler instead. No incrementCampaignSendCounter/tryCompleteCampaign
    // call here (D-12): the reconciler backfills counters exactly once when
    // it resolves the row, so counting it here would double-count.
    await recordSendResult(client, dispatchResult.sendId, { status: "reconciling" });
    return { kind: "reconciling", sendId: dispatchResult.sendId };
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
 * The ONE place a throw from `sendMail` becomes a ledger write (Phase 11,
 * D-10, plan 11-06) -- shared by the campaign branch (`processSendJob`) and
 * the flow branch (`processFlowSendJob`) below so "what counts as
 * ambiguous" can never drift between the two send paths (this file's own
 * CR-04 doc comment already makes "the two send paths must not drift" an
 * explicit invariant; this is that invariant enforced in code for the
 * classification decision specifically).
 *
 * `classifyTransportError`'s verdict decides everything:
 * - `pre_connection_retryable` (a provable DNS failure or refused
 *   connection, per `transport-classify.ts`'s narrow allowlist) releases
 *   the claim committed by unit 1 and RETHROWS the original error, so
 *   BullMQ's bounded `attempts`/backoff apply -- the transport layer proved
 *   the request never left this process, so a retry cannot duplicate it.
 * - `ambiguous` (the fail-closed default -- everything else, including an
 *   unrecognized throw) writes `reconciling` via the caller-supplied
 *   `writeReconciling` (`recordSendResult` for campaign,
 *   `recordFlowStepResult` for flow) and returns `{ outcome: "reconciling" }`
 *   WITHOUT touching any campaign counter or completion check -- the
 *   process stopped knowing the outcome, so it stops asserting one.
 *
 * Never called for a resolved `SendTenantMailResult` (2xx/4xx/429/5xx) --
 * only for a REJECTED `sendMail` call. Those known-status branches keep
 * their own per-path handling in `processSendJob`/`processFlowSendJob`
 * because a resolved response is never ambiguous.
 */
async function handleAmbiguousSendMailError(
  err: unknown,
  sendId: string,
  dispatchedAt: Date,
  writeReconciling: (client: PoolClient, dispatchDurationMs: number) => Promise<void>
): Promise<SendJobResult> {
  const dispatchDurationMs = Date.now() - dispatchedAt.getTime();
  const classification = classifyTransportError(err);

  if (classification === "pre_connection_retryable") {
    await withTenantTransaction((client) => releaseDispatchClaim(client, sendId));
    throw err;
  }

  await withTenantTransaction((client) => writeReconciling(client, dispatchDurationMs));
  return { outcome: "reconciling", sendId };
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
 *
 * `kind === "flow"` (06-03) rides this SAME queue/limiter/gate, with its own
 * claim/prereqs helpers in `./flows/flow-send.ts` (`claimFlowSend`,
 * `readFlowSendPrereqs`) -- branched on BEFORE `emailBroadcastJobSchema` is
 * ever applied, since a flow job has no `campaignId` at all and would fail
 * that schema's required field.
 */
export async function processSendJob(
  data: EmailBroadcastJob | EmailTriggeredJob,
  deps: ProcessSendJobDeps = {}
): Promise<SendJobResult> {
  const sendMail = deps.sendMail ?? sendTenantMailV3;
  const redisClient = deps.redisClient ?? getDefaultRedisClient();

  if (data.kind === "flow") {
    // T-06-02-01 type seam: a flow job's shape (flowRunId/nodeId, no
    // campaignId) is validated with emailTriggeredJobSchema's flow variant,
    // never with emailBroadcastJobSchema (which would reject it for a
    // missing required campaignId).
    const job = emailTriggeredJobSchema.parse(data);
    if (job.kind !== "flow") {
      throw new Error("processSendJob: kind='flow' branch received a non-flow job after re-parsing");
    }
    return processFlowSendJob(job, { sendMail, redisClient });
  }

  const job = emailBroadcastJobSchema.parse(data);
  const { workspaceId, campaignId, kind, contactId, testTo, testData } = job;

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
      if (claimResult.kind === "reconciling") {
        return { outcome: "reconciling", sendId: claimResult.sendId };
      }

      const { claim } = claimResult;

      // WRK-02 (D-01/D-02): the per-tenant-per-lane concurrency slot is
      // acquired BEFORE the per-tenant RPS check, immediately after the
      // claim is destructured -- an over-cap send defers through the SAME
      // tenant_bucket path an over-RPS send does (D-01's "one deferral
      // flow, two triggers"), so the worker wrapper's existing deferral
      // branch handles both with no change. The claim was already
      // committed (unit 1) -- an over-cap send releases it exactly like
      // the over-RPS path just below, so it is never left stranded
      // (T-12-04-01).
      const lane = laneForSendJobKind("campaign");
      const laneSlot = await acquireTenantLaneSlot(redisClient, workspaceId, lane, {
        cap: resolveTenantLaneCap(lane),
        leaseTtlMs: SEND_SLOT_LEASE_TTL_MS,
      });
      if (!laneSlot.acquired) {
        await withTenantTransaction((client) => releaseDispatchClaim(client, claim.sendId));
        return { outcome: "rate_limited", rateLimitMs: laneSlot.retryAfterMs ?? 0, cause: "tenant_bucket" };
      }

      try {
        // SEND-02/SEND-03: the per-tenant token bucket is consumed before
        // EVERY SendGrid call, regardless of which queue the job came from.
        const rateResult = await consumeTenantToken(redisClient, workspaceId, claim.rps);
        if (!rateResult.allowed) {
          // The claim was already committed (unit 1) -- release it so it
          // isn't left stranded blocking a legitimate retry (T-04-12-03).
          await withTenantTransaction((client) => releaseDispatchClaim(client, claim.sendId));
          return { outcome: "rate_limited", rateLimitMs: rateResult.msBeforeNext, cause: "tenant_bucket" };
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
          isTest: false,
        });
        const dispatchedAt = new Date();
        let response: SendTenantMailResult;
        try {
          response = await sendMail(claim.apiKey, payload);
        } catch (err) {
          // Phase 11 (D-10, plan 11-06): a rejected sendMail call -- timeout,
          // reset, DNS failure, or anything unrecognized -- is classified and
          // resolved by the shared helper above, never here, so this branch
          // can never drift from processFlowSendJob's identical catch below.
          return handleAmbiguousSendMailError(err, claim.sendId, dispatchedAt, (client, dispatchDurationMs) =>
            recordSendResult(client, claim.sendId, { status: "reconciling", dispatchedAt, dispatchDurationMs })
          );
        }
        const dispatchDurationMs = Date.now() - dispatchedAt.getTime();

        // Unit 3: record the terminal result in a SEPARATE transaction, only
        // ever entered after SendGrid has responded.
        if (response.status === 429 || response.status >= 500) {
          // SEND-07: SendGrid did not accept the message -- release the
          // claim so a clean backoff retry re-claims and re-attempts.
          await withTenantTransaction((client) => releaseDispatchClaim(client, claim.sendId));
          return { outcome: "rate_limited", rateLimitMs: parseRetryAfter(response.headers), cause: "provider_backoff" };
        }

        if (response.status >= 400) {
          // CR-03: a non-retryable 4xx rejection (400/401/403/413/...) is
          // recorded as failed, never as sent. CR-05: the counter/completion
          // pair is called in the SAME transaction as the terminal record.
          await withTenantTransaction(async (client) => {
            await recordSendResult(client, claim.sendId, { status: "failed", dispatchedAt, dispatchDurationMs });
            await incrementCampaignSendCounter(client, campaignId, "failed");
            await tryCompleteCampaign(client, campaignId);
          });
          return { outcome: "failed", sendId: claim.sendId };
        }

        await withTenantTransaction(async (client) => {
          await recordSendResult(client, claim.sendId, {
            status: "sent",
            providerMessageId: response.messageId,
            dispatchedAt,
            dispatchDurationMs,
          });
          await incrementCampaignSendCounter(client, campaignId, "sent");
          await tryCompleteCampaign(client, campaignId);
        });
        return { outcome: "sent", sendId: claim.sendId, providerMessageId: response.messageId };
      } finally {
        // WRK-02 (T-12-04-02): released on every exit above -- success,
        // provider rejection, 4xx failure, ambiguous throw, and RPS
        // deferral alike. Sits in `finally`, never a `catch`, so it can
        // never alter what the branch above returns or throws.
        await releaseTenantLaneSlot(redisClient, workspaceId, lane, laneSlot.token);
      }
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
    // CR-01: a test send has no real contact (the enqueuing route never
    // sets one), but the signed token's contactId still flows into the
    // public unsubscribe route's uuid-typed `WHERE id = $1` (CAMP-04,
    // SUBS-04). Falling back to a valid random UUID (not a placeholder
    // literal) guarantees a redeemed test-send link always resolves to
    // either a real contact or an unknown-but-valid UUID (0 rows updated,
    // still the normal 2xx) -- never a Postgres 22P02 on a non-UUID literal.
    const unsubscribeUrl = buildListUnsubscribeUrl(
      signUnsubscribeToken({
        sendId,
        contactId: contactId ?? randomUUID(),
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

    // WRK-02: the SAME lane-slot gate as the campaign/flow branches above,
    // acquired before the per-tenant RPS check -- but this path has no
    // dispatch claim to release (D-12: a test send has no `sends` row), so
    // an over-cap test send returns the rate-limited result directly.
    const testLane = laneForSendJobKind("test");
    const testLaneSlot = await acquireTenantLaneSlot(redisClient, workspaceId, testLane, {
      cap: resolveTenantLaneCap(testLane),
      leaseTtlMs: SEND_SLOT_LEASE_TTL_MS,
    });
    if (!testLaneSlot.acquired) {
      return { outcome: "rate_limited", rateLimitMs: testLaneSlot.retryAfterMs ?? 0, cause: "tenant_bucket" };
    }

    try {
      const rateResult = await consumeTenantToken(redisClient, workspaceId, prereqs.rps);
      if (!rateResult.allowed) {
        return { outcome: "rate_limited", rateLimitMs: rateResult.msBeforeNext, cause: "tenant_bucket" };
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
        isTest: true,
      });
      let response: SendTenantMailResult;
      try {
        response = await sendMail(prereqs.apiKey, payload);
      } catch (err) {
        // Phase 11 (D-10/D-11, plan 11-10): mirrors the campaign/flow branches'
        // classification via the SAME `classifyTransportError`, but the
        // disposition differs on the ambiguous path -- there is no ledger row
        // to write `reconciling` onto (D-12), so the ambiguity surfaces as a
        // distinct `unknown` OUTCOME instead. `pre_connection_retryable`
        // rethrows exactly like the campaign/flow paths: no row exists to
        // release, and the transport layer proved nothing was sent, so a
        // retry cannot duplicate it.
        const classification = classifyTransportError(err);
        if (classification === "pre_connection_retryable") {
          throw err;
        }
        // `ambiguous` -- log via scrubbedConsole, naming the campaign id and
        // the outcome only, NEVER the recipient address (`testTo`) supplied
        // by the caller (T-11-10-05). Return, do not throw: throwing here is
        // what would make BullMQ retry a test send, which D-11 forbids.
        scrubbedConsole.warn("test-send outcome unknown (ambiguous provider error)", { campaignId, outcome: "unknown" });
        return { outcome: "unknown", sendId };
      }

      if (response.status === 429 || response.status >= 500) {
        return { outcome: "rate_limited", rateLimitMs: parseRetryAfter(response.headers), cause: "provider_backoff" };
      }

      // SEND-07: mirrors the kind='campaign' branch's >=400 -> failed
      // disposition (line ~333) -- a non-retryable 4xx rejection (bad
      // template, unverified sender, etc.) must be reported as failed, never
      // as a false 'sent'. The test path has no ledger row to update (D-12) --
      // only the returned outcome changes.
      if (response.status >= 400) {
        return { outcome: "failed", sendId };
      }

      return { outcome: "sent", sendId, providerMessageId: response.messageId };
    } finally {
      // WRK-02 (T-12-04-02): released on every exit above, mirroring the
      // campaign/flow branches' `finally` -- never a `catch`.
      await releaseTenantLaneSlot(redisClient, workspaceId, testLane, testLaneSlot.token);
    }
  });
}

/**
 * `kind === "flow"` dispatch (FLOW-01/FLOW-07, 06-03) -- rides the SAME
 * email-triggered queue, per-tenant `consumeTenantToken` limiter, and
 * `evaluatePreSendGate` gate as `kind === "campaign"`; no forked dispatch
 * path, no second rate limiter (T-06-03-02). Same three-unit discipline as
 * the campaign branch above: (1) `claimFlowSend`'s claim transaction commits
 * BEFORE any network call, (2) the SendGrid call itself, outside any
 * transaction, (3) `recordFlowStepResult` in a SEPARATE transaction only
 * ever entered after SendGrid has responded. Template/sender come from the
 * PINNED `flow_versions.definition` send-node config
 * (`readFlowSendPrereqs`), never from a `campaigns` row.
 */
async function processFlowSendJob(
  job: Extract<EmailTriggeredJob, { kind: "flow" }>,
  deps: { sendMail: NonNullable<ProcessSendJobDeps["sendMail"]>; redisClient: Redis }
): Promise<SendJobResult> {
  const { workspaceId, flowRunId, nodeId, contactId } = job;
  const { sendMail, redisClient } = deps;

  return withTenant(workspaceId, async () => {
    // Unit 1: claim transaction -- commits BEFORE any SendGrid call.
    const claimResult = await withTenantTransaction((client) =>
      claimFlowSend(client, { workspaceId, flowRunId, nodeId, contactId })
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
    if (claimResult.kind === "reconciling") {
      // Phase 11 (DLV-02, plan 11-06): flow-side parity with the campaign
      // branch's identical `claimResult.kind === "reconciling"` handling
      // above -- `claimFlowSend` (flows/flow-send.ts) already wrote
      // 'reconciling' for this interrupted claim; no provider call here.
      return { outcome: "reconciling", sendId: claimResult.sendId };
    }

    const { claim } = claimResult;

    // WRK-02 (D-01/D-02): same lane-slot gate as the campaign branch,
    // acquired before the per-tenant RPS check -- an over-cap flow send
    // defers through the SAME tenant_bucket path an over-RPS send does,
    // and releases the already-committed claim so it is never left
    // stranded (T-12-04-01), mirroring the over-RPS release just below.
    const lane = laneForSendJobKind("flow");
    const laneSlot = await acquireTenantLaneSlot(redisClient, workspaceId, lane, {
      cap: resolveTenantLaneCap(lane),
      leaseTtlMs: SEND_SLOT_LEASE_TTL_MS,
    });
    if (!laneSlot.acquired) {
      await withTenantTransaction((client) => releaseDispatchClaim(client, claim.sendId));
      return { outcome: "rate_limited", rateLimitMs: laneSlot.retryAfterMs ?? 0, cause: "tenant_bucket" };
    }

    try {
      // SEND-02/SEND-03 sibling: the SAME per-tenant token bucket is consumed
      // before EVERY SendGrid call, regardless of kind.
      const rateResult = await consumeTenantToken(redisClient, workspaceId, claim.rps);
      if (!rateResult.allowed) {
        await withTenantTransaction((client) => releaseDispatchClaim(client, claim.sendId));
        return { outcome: "rate_limited", rateLimitMs: rateResult.msBeforeNext, cause: "tenant_bucket" };
      }

      // Unit 2: the external SendGrid call -- NOT inside any transaction.
      // campaignId is omitted (06-03: a flow send has no campaigns row).
      const payload = buildMailSendRequest({
        to: claim.to,
        templateId: claim.templateId,
        fromEmail: claim.fromEmail,
        dynamicTemplateData: claim.dynamicTemplateData,
        listUnsubscribeUrl: claim.unsubscribeUrl,
        sendId: claim.sendId,
        workspaceId,
        isTest: false,
      });
      const dispatchedAt = new Date();
      let response: SendTenantMailResult;
      try {
        response = await sendMail(claim.apiKey, payload);
      } catch (err) {
        // Phase 11 (D-10, plan 11-06): identical classification/disposition
        // as the campaign branch above, via the SAME shared helper -- the
        // only per-path difference is which ledger function writes the
        // ambiguous status.
        return handleAmbiguousSendMailError(err, claim.sendId, dispatchedAt, (client, dispatchDurationMs) =>
          recordFlowStepResult(client, claim.sendId, { status: "reconciling", dispatchedAt, dispatchDurationMs })
        );
      }
      const dispatchDurationMs = Date.now() - dispatchedAt.getTime();

      // Unit 3: record the terminal result in a SEPARATE transaction, only
      // ever entered after SendGrid has responded.
      if (response.status === 429 || response.status >= 500) {
        await withTenantTransaction((client) => releaseDispatchClaim(client, claim.sendId));
        return { outcome: "rate_limited", rateLimitMs: parseRetryAfter(response.headers), cause: "provider_backoff" };
      }

      if (response.status >= 400) {
        await withTenantTransaction((client) =>
          recordFlowStepResult(client, claim.sendId, { status: "failed", dispatchedAt, dispatchDurationMs })
        );
        return { outcome: "failed", sendId: claim.sendId };
      }

      await withTenantTransaction((client) =>
        recordFlowStepResult(client, claim.sendId, {
          status: "sent",
          providerMessageId: response.messageId,
          dispatchedAt,
          dispatchDurationMs,
        })
      );
      return { outcome: "sent", sendId: claim.sendId, providerMessageId: response.messageId };
    } finally {
      // WRK-02 (T-12-04-02): released on every exit above, mirroring the
      // campaign branch's `finally` -- never a `catch`.
      await releaseTenantLaneSlot(redisClient, workspaceId, lane, laneSlot.token);
    }
  });
}
