import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { CONTACT_COLUMNS, type ContactRow } from "@mega-crm/contacts-core";
import { evaluatePreSendGate, recordExcluded, tryCompleteCampaign, isWorkspaceSoftDeleted } from "@mega-crm/delivery-core";
import { CAMPAIGN_KICKOFF_QUEUE, campaignKickoffJobSchema, type CampaignKickoffJob } from "@mega-crm/shared-schemas";
import { materializeCampaignSnapshot } from "./recipient-snapshot.js";
import { emailBroadcastQueue } from "./campaign-broadcast-producer.js";
import { wrapProcessor } from "../processor-wrapper.js";
import { logger } from "../logger.js";

/** Cursor page size for walking the frozen `campaign_recipients` snapshot (mirrors imports-csv.worker.ts's PAGE_SIZE convention). */
const BREAKDOWN_PAGE_SIZE = 5_000;

interface CampaignKickoffStateRow {
  status: string;
  fanOutComplete: boolean;
}

/**
 * The campaign-kickoff job handler (CAMP-02/CAMP-05, SEND-01, D-02/D-04/D-05):
 * re-derives `workspaceId` from `job.data` (never ambient state, Pattern 2),
 * then: (1) freezes the audience via `materializeCampaignSnapshot`
 * (recipient-snapshot.ts); (2) walks the frozen `campaign_recipients`
 * snapshot on a `contact_id` keyset cursor, running the SAME
 * `evaluatePreSendGate` the dispatch worker (04-04) uses so "who is
 * sendable" can never drift between kickoff's breakdown and the actual
 * send-time gate, recording every non-sendable contact via `recordExcluded`
 * (durable, frozen D-04 exclusion breakdown) and fanning out one
 * `email-broadcast` job per sendable contact in the SAME pass (a
 * deterministic `jobId` makes re-enqueuing on redelivery a safe no-op, and
 * the send-dispatch worker's own `dispatchSendGate` is the final SEND-06
 * idempotency backstop); (3) persists the frozen `sendable_total`/
 * `excluded_total` denominator; (4) an empty sendable audience completes
 * the campaign straight to `sent` with 0 sent (D-05) instead of a separate
 * failed state.
 *
 * Idempotency (T-04-06-01/03): the whole breakdown+fan-out pass is guarded
 * by a `fan_out_complete` flag persisted on the campaign row -- once set, a
 * redelivered kickoff job returns immediately without re-walking
 * `campaign_recipients` or re-enqueuing anything. Before that flag is set,
 * a redelivered job safely redoes the walk (every write it makes --
 * `recordExcluded`'s `ON CONFLICT DO UPDATE`, the deterministic
 * email-broadcast `jobId`, and `dispatchSendGate`'s own DB-level gate --
 * is independently idempotent).
 *
 * Exported standalone (not only as a Worker's inline processor) so this
 * worker can be unit/integration-tested directly, mirroring
 * events-ingest.worker.ts's exported-processor convention.
 */
export async function processCampaignKickoffJob(data: CampaignKickoffJob): Promise<void> {
  const { workspaceId, campaignId } = campaignKickoffJobSchema.parse(data);

  await withTenant(workspaceId, async () => {
    // T-22-02-04 (PRG-06, D-01/D-02): the fan-out guard -- checked BEFORE the
    // audience walk (materializeCampaignSnapshot below) so a kickoff job
    // already sitting in the queue at soft-delete time enqueues ZERO
    // per-recipient jobs, rather than fanning out a broadcast the dispatch
    // gate (send-dispatch.ts's claimCampaignSend) would then have to exclude
    // one row at a time. Freeze, never cancel (D-02): no status transition,
    // no completion attempt -- the campaign is left exactly as the tenant's
    // last action left it, so a later restore finds it untouched.
    const workspaceDeleted = await withTenantTransaction((client) => isWorkspaceSoftDeleted(client, workspaceId));
    if (workspaceDeleted) {
      logger.info({ workspaceId, campaignId }, "campaign kickoff refused: workspace soft-deleted");
      return;
    }

    const state = await withTenantTransaction(async (client) => {
      const { rows } = await client.query<CampaignKickoffStateRow>(
        `SELECT status, fan_out_complete as "fanOutComplete" FROM campaigns WHERE id = $1`,
        [campaignId]
      );
      return rows[0];
    });
    if (!state) return; // unknown/foreign campaign id -- nothing to do

    // Terminal statuses (sent/canceled) or an already-completed fan-out are
    // both hard stops -- a redelivered kickoff for either must be a no-op.
    if (state.status === "sent" || state.status === "canceled" || state.fanOutComplete) {
      return;
    }

    await materializeCampaignSnapshot(campaignId);

    let cursor: string | null = null;
    let sendableTotal = 0;
    let excludedTotal = 0;
    let canceledMidFanOut = false;

    while (true) {
      const page = await withTenantTransaction(async (client) => {
        const { rows: statusRows } = await client.query<{ status: string }>(
          `SELECT status FROM campaigns WHERE id = $1`,
          [campaignId]
        );
        const { rows } = await client.query<{ contactId: string }>(
          `SELECT contact_id as "contactId" FROM campaign_recipients
           WHERE campaign_id = $1 ${cursor ? "AND contact_id > $2" : ""}
           ORDER BY contact_id ASC
           LIMIT ${cursor ? "$3" : "$2"}`,
          cursor ? [campaignId, cursor, BREAKDOWN_PAGE_SIZE] : [campaignId, BREAKDOWN_PAGE_SIZE]
        );
        return { status: statusRows[0]?.status, recipientIds: rows.map((row) => row.contactId) };
      });

      // CR-06: re-read status at the start of every page -- a cancel (or a
      // 'sent' terminal reached through some other path) that happens
      // mid-fan-out stops further enqueuing immediately, without waiting
      // for the whole frozen snapshot to be walked.
      if (page.status === "canceled" || page.status === "sent") {
        canceledMidFanOut = true;
        break;
      }
      if (page.recipientIds.length === 0) break;
      const recipientIds = page.recipientIds;

      const contacts = await withTenantTransaction(async (client) => {
        const { rows } = await client.query<ContactRow>(
          `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
          [workspaceId, recipientIds]
        );
        return rows;
      });
      const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));

      for (const contactId of recipientIds) {
        const contact = contactsById.get(contactId);
        if (!contact) {
          // Contact deleted after the snapshot was frozen -- can't send to
          // it; excluded rather than silently skipped, keeping the D-04
          // breakdown's total reconciled with the frozen recipient count.
          await withTenantTransaction((client) =>
            recordExcluded(client, { workspaceId, campaignId, contactId }, "no_email")
          );
          excludedTotal += 1;
          continue;
        }

        const gateDecision = await withTenantTransaction((client) =>
          evaluatePreSendGate(client, { workspaceId, contact })
        );

        if (!gateDecision.sendable) {
          await withTenantTransaction((client) =>
            recordExcluded(client, { workspaceId, campaignId, contactId }, gateDecision.reason)
          );
          excludedTotal += 1;
          continue;
        }

        sendableTotal += 1;
        // T-04-06-03: deterministic jobId (dash-separated -- BullMQ rejects
        // ':') makes a redelivered kickoff's re-enqueue a safe no-op.
        await emailBroadcastQueue.add(
          "send",
          { workspaceId, campaignId, kind: "campaign", contactId },
          { jobId: `${workspaceId}-${campaignId}-${contactId}` }
        );
      }

      cursor = recipientIds.at(-1) ?? cursor;
    }

    if (canceledMidFanOut) {
      // CR-06: the campaign was canceled (or otherwise reached 'sent')
      // while this fan-out was still walking the frozen snapshot -- leave
      // its status/totals exactly as that transition set them. Do not mark
      // fan_out_complete (the walk genuinely did not finish) and do not
      // force any status transition here.
      return;
    }

    if (sendableTotal === 0) {
      // D-05: an empty sendable audience completes straight to 'sent' with
      // 0 sent -- no separate failed state. Guarded WHERE status='sending'
      // (CR-06) so a campaign canceled between the entry-level check and
      // this final write is never forced back to 'sent'.
      await withTenantTransaction((client) =>
        client.query(
          `UPDATE campaigns SET
             status = 'sent',
             sendable_total = $2,
             excluded_total = $3,
             fan_out_complete = true,
             terminal_at = now(),
             updated_at = now()
           WHERE id = $1 AND status = 'sending'`,
          [campaignId, sendableTotal, excludedTotal]
        )
      );
      return;
    }

    await withTenantTransaction(async (client) => {
      await client.query(
        `UPDATE campaigns SET
           sendable_total = $2,
           excluded_total = $3,
           fan_out_complete = true,
           updated_at = now()
         WHERE id = $1`,
        [campaignId, sendableTotal, excludedTotal]
      );
      // CR-05: covers the case where every sendable recipient's send
      // already completed (incrementCampaignSendCounter/tryCompleteCampaign
      // in send-dispatch.ts) before fan_out_complete was set here --
      // tryCompleteCampaign's own status='sending' guard makes this a
      // no-op for an already-canceled/terminal campaign.
      await tryCompleteCampaign(client, campaignId);
    });
  });
}

/**
 * Constructs the actual BullMQ Worker consuming CAMPAIGN_KICKOFF_QUEUE --
 * registered in apps/worker/src/server.ts's buildWorker(). Both the
 * launch route's immediate-launch enqueue and the 04-06 scheduler's
 * due-campaign enqueue use `jobId: campaignId`, so this Worker's own
 * concurrency processes at most one kickoff per campaign at a time.
 */
export function createCampaignKickoffWorker(connection: ConnectionOptions): Worker<CampaignKickoffJob> {
  return new Worker<CampaignKickoffJob>(
    CAMPAIGN_KICKOFF_QUEUE,
    wrapProcessor(CAMPAIGN_KICKOFF_QUEUE, async (job: Job<CampaignKickoffJob>) => {
      await processCampaignKickoffJob(job.data);
    }),
    { connection }
  );
}
