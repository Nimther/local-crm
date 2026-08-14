import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import { SEND_STATUSES, type SendStatus } from "@mega-crm/delivery-core";

export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "canceled";

export interface CampaignRow {
  id: string;
  workspaceId: string;
  name: string;
  status: CampaignStatus;
  segmentId: string;
  templateId: string | null;
  fromSenderId: string | null;
  fromEmail: string | null;
  scheduledAt: Date | null;
  sendableTotal: number | null;
  sentCount: number;
  failedCount: number;
  excludedTotal: number | null;
  snapshotCursor: string | null;
  sendingStartedAt: Date | null;
  terminalAt: Date | null;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Column list shared by every read/write of `campaigns` that needs the full row shape. */
const CAMPAIGN_COLUMNS = `
  id,
  workspace_id as "workspaceId",
  name,
  status,
  segment_id as "segmentId",
  template_id as "templateId",
  from_sender_id as "fromSenderId",
  from_email as "fromEmail",
  scheduled_at as "scheduledAt",
  sendable_total as "sendableTotal",
  sent_count as "sentCount",
  failed_count as "failedCount",
  excluded_total as "excludedTotal",
  snapshot_cursor as "snapshotCursor",
  sending_started_at as "sendingStartedAt",
  terminal_at as "terminalAt",
  delivered_count as "deliveredCount",
  opened_count as "openedCount",
  clicked_count as "clickedCount",
  bounced_count as "bouncedCount",
  unsubscribed_count as "unsubscribedCount",
  created_by_user_id as "createdByUserId",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

/**
 * D-03/D-08: thrown by every state-transition/mutation function below when
 * the requested change is not legal from the campaign's current status
 * (`illegal_transition`), the campaign is missing a required field before
 * launch (`incomplete`), or the campaign id does not resolve within the
 * caller's workspace (`not_found`). Mirrors segment.repository.ts's
 * `SegmentConflictError` shape.
 */
export class CampaignStateError extends Error {
  constructor(
    message: string,
    public readonly code: "illegal_transition" | "incomplete" | "not_found"
  ) {
    super(message);
    this.name = "CampaignStateError";
  }
}

export interface CreateCampaignInput {
  name: string;
  segmentId: string;
  templateId?: string | null;
  fromSenderId?: string | null;
  fromEmail?: string | null;
  createdByUserId: string;
}

/** CAMP-01: creates a draft campaign. All lifecycle fields start at their column defaults (status='draft', counters=0). */
export async function createCampaign(input: CreateCampaignInput): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `INSERT INTO campaigns (workspace_id, name, segment_id, template_id, from_sender_id, from_email, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [
        workspaceId,
        input.name,
        input.segmentId,
        input.templateId ?? null,
        input.fromSenderId ?? null,
        input.fromEmail ?? null,
        input.createdByUserId,
      ]
    );
    return rows[0];
  });
}

export interface ListCampaignsQuery {
  page: number;
  pageSize: number;
}

export interface ListCampaignsResult {
  items: CampaignRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Workspace-scoped, paginated campaign list (progress counters ride along on CampaignRow already). */
export async function listCampaigns(query: ListCampaignsQuery): Promise<ListCampaignsResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM campaigns WHERE workspace_id = $1`,
      [workspaceId]
    );
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [workspaceId, query.pageSize, (query.page - 1) * query.pageSize]
    );
    return {
      items: rows,
      total: Number(countRows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

export async function getCampaign(id: string): Promise<CampaignRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    );
    return rows[0] ?? null;
  });
}

export interface UpdateCampaignInput {
  name?: string;
  segmentId?: string;
  templateId?: string | null;
  fromSenderId?: string | null;
  fromEmail?: string | null;
}

/**
 * D-08: only a `draft` campaign can be edited in place -- any other status
 * throws `illegal_transition` (the caller must cancel back to draft first,
 * D-07). Locked read-check-write (`SELECT ... FOR UPDATE`) so an in-flight
 * launch can never race a concurrent edit.
 */
export async function updateCampaign(id: string, patch: UpdateCampaignInput): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new CampaignStateError("Campaign not found", "not_found");
    }
    if (existing.status !== "draft") {
      throw new CampaignStateError("Only a draft campaign can be edited", "illegal_transition");
    }

    const nextName = patch.name !== undefined ? patch.name : existing.name;
    const nextSegmentId = patch.segmentId !== undefined ? patch.segmentId : existing.segmentId;
    const nextTemplateId = patch.templateId !== undefined ? patch.templateId : existing.templateId;
    const nextFromSenderId = patch.fromSenderId !== undefined ? patch.fromSenderId : existing.fromSenderId;
    const nextFromEmail = patch.fromEmail !== undefined ? patch.fromEmail : existing.fromEmail;

    const { rows: updated } = await client.query<CampaignRow>(
      `UPDATE campaigns SET
         name = $3,
         segment_id = $4,
         template_id = $5,
         from_sender_id = $6,
         from_email = $7,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id, nextName, nextSegmentId, nextTemplateId, nextFromSenderId, nextFromEmail]
    );
    return updated[0];
  });
}

/**
 * CAMP-02: draft -> sending, immediate launch. Requires templateId AND
 * (fromEmail OR fromSenderId) AND segmentId all set -- else `incomplete`
 * (CampaignStateError). Any non-draft source status is `illegal_transition`.
 * Locked read-check-write prevents a race against a concurrent edit/cancel.
 */
export async function launchCampaign(id: string): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new CampaignStateError("Campaign not found", "not_found");
    }
    if (existing.status !== "draft") {
      throw new CampaignStateError("Only a draft campaign can be launched", "illegal_transition");
    }
    if (!existing.templateId || !(existing.fromEmail || existing.fromSenderId) || !existing.segmentId) {
      throw new CampaignStateError(
        "Campaign is missing a required field (template, sender, or segment) before launch",
        "incomplete"
      );
    }

    const { rows: updated } = await client.query<CampaignRow>(
      `UPDATE campaigns SET status = 'sending', sending_started_at = now(), updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id]
    );
    return updated[0];
  });
}

/**
 * CAMP-02/D-06: draft -> scheduled for a future UTC instant (the 04-06
 * scheduler worker picks up due campaigns and enqueues the kickoff job).
 * Only a draft can be scheduled -- else `illegal_transition`.
 */
export async function scheduleCampaign(id: string, scheduledAt: Date): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new CampaignStateError("Campaign not found", "not_found");
    }
    if (existing.status !== "draft") {
      throw new CampaignStateError("Only a draft campaign can be scheduled", "illegal_transition");
    }

    const { rows: updated } = await client.query<CampaignRow>(
      `UPDATE campaigns SET status = 'scheduled', scheduled_at = $3, updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id, scheduledAt]
    );
    return updated[0];
  });
}

/**
 * D-07/D-09: scheduled -> draft (clears scheduledAt, un-does the schedule
 * with no history lost) OR sending -> canceled (terminal, current counters
 * preserved as-is -- already-sent mail is never recalled). Any other source
 * status is `illegal_transition` (draft/sent/canceled are not cancelable).
 */
export async function cancelCampaign(id: string): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new CampaignStateError("Campaign not found", "not_found");
    }

    if (existing.status === "scheduled") {
      const { rows: updated } = await client.query<CampaignRow>(
        `UPDATE campaigns SET status = 'draft', scheduled_at = NULL, updated_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [workspaceId, id]
      );
      return updated[0];
    }

    if (existing.status === "sending") {
      const { rows: updated } = await client.query<CampaignRow>(
        `UPDATE campaigns SET status = 'canceled', terminal_at = now(), updated_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [workspaceId, id]
      );
      return updated[0];
    }

    throw new CampaignStateError(
      "Only a scheduled or sending campaign can be canceled",
      "illegal_transition"
    );
  });
}

/** D-11: copies name/segment/template/sender into a fresh draft. Does not affect the source campaign's state. */
export async function duplicateCampaign(id: string, createdByUserId: string): Promise<CampaignRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      throw new CampaignStateError("Campaign not found", "not_found");
    }

    const { rows: created } = await client.query<CampaignRow>(
      `INSERT INTO campaigns (workspace_id, name, segment_id, template_id, from_sender_id, from_email, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [
        workspaceId,
        existing.name,
        existing.segmentId,
        existing.templateId,
        existing.fromSenderId,
        existing.fromEmail,
        createdByUserId,
      ]
    );
    return created[0];
  });
}

/** Only draft/canceled campaigns are deletable -- scheduled/sending/sent preserve history (Phase 7). */
export async function deleteCampaign(id: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) return false;

    if (existing.status !== "draft" && existing.status !== "canceled") {
      throw new CampaignStateError(
        "Only a draft or canceled campaign can be deleted",
        "illegal_transition"
      );
    }

    const { rows: deleted } = await client.query(
      `DELETE FROM campaigns WHERE workspace_id = $1 AND id = $2 RETURNING id`,
      [workspaceId, id]
    );
    return deleted.length > 0;
  });
}

export interface CampaignExcludedBreakdownItem {
  reason: string | null;
  count: number;
}

export interface CampaignProgress {
  status: CampaignStatus;
  sentCount: number;
  failedCount: number;
  sendableTotal: number | null;
  excludedTotal: number | null;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  /**
   * D-16 (Phase 13, closing Phase 11 D-13's deferral): `reconciling` and
   * `unknown` are ledger states, not delivery facts -- a send in either
   * state has an outcome the platform has not observed, so it is reported
   * as its own count next to `sent` and `failed` and is never folded into
   * either. This is deliberately asymmetric with `workspace_daily_rollup`,
   * which continues to exclude both states per Phase 11 D-13: a campaign
   * card answers "where are my sends right now" (an unobserved outcome
   * belongs there), while a daily rollup answers "what happened on this
   * day" (an unobserved outcome has no place there). `ledger` is typed as
   * `Record<SendStatus, number>` over the full shared vocabulary so a
   * future seventh status becomes a compile-time error here, not a silent
   * zero.
   */
  ledger: Record<SendStatus, number>;
  /** D-07: excluded sends grouped by exclusion_reason, for the «Пропущено» breakdown row. Empty array when none. */
  excludedBreakdown: CampaignExcludedBreakdownItem[];
}

/**
 * CAMP-05/D-07/D-09: reads the row's own progress counters (kept fresh by
 * the 04-06 kickoff/dispatch worker AND, since 05-03, the webhook worker's
 * delivered/opened/clicked/bounced/unsubscribed counters) AND independently
 * re-aggregates live counts from the `sends` ledger, grouped by status -- a
 * second, cheap cross-check so a stuck counter-update never silently
 * diverges from the ledger's own truth during an in-flight send.
 */
export async function getCampaignProgress(id: string): Promise<CampaignProgress | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CampaignRow>(
      `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    );
    const campaign = rows[0];
    if (!campaign) return null;

    const { rows: ledgerRows } = await client.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text as count FROM sends
       WHERE workspace_id = $1 AND campaign_id = $2
       GROUP BY status`,
      [workspaceId, id]
    );
    // D-16: initialize every status in the shared vocabulary at zero so a
    // status this query returns can never be silently dropped -- the
    // previous four-key allow-list is exactly how `reconciling`/`unknown`
    // became invisible. `knownStatuses` is built from `SEND_STATUSES`
    // rather than restating the literals, so the accepted set and the
    // `Record<SendStatus, number>` initializer can never drift apart.
    const ledger = Object.fromEntries(SEND_STATUSES.map((status) => [status, 0])) as Record<
      SendStatus,
      number
    >;
    const knownStatuses = new Set<string>(SEND_STATUSES);
    for (const row of ledgerRows) {
      if (knownStatuses.has(row.status)) {
        ledger[row.status as SendStatus] = Number(row.count);
      }
    }

    // D-07: excluded-reason breakdown for the campaign summary's «Пропущено»
    // row. Parameterized + scoped by workspace_id, same tenant-scoped path
    // as the ledger re-aggregation above (T-07-03-01).
    const { rows: excludedRows } = await client.query<{ reason: string | null; count: string }>(
      `SELECT exclusion_reason as reason, count(*)::text as count FROM sends
       WHERE workspace_id = $1 AND campaign_id = $2 AND status = 'excluded'
       GROUP BY exclusion_reason`,
      [workspaceId, id]
    );
    const excludedBreakdown: CampaignExcludedBreakdownItem[] = excludedRows.map((row) => ({
      reason: row.reason,
      count: Number(row.count),
    }));

    return {
      status: campaign.status,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      sendableTotal: campaign.sendableTotal,
      excludedTotal: campaign.excludedTotal,
      deliveredCount: campaign.deliveredCount,
      openedCount: campaign.openedCount,
      clickedCount: campaign.clickedCount,
      bouncedCount: campaign.bouncedCount,
      unsubscribedCount: campaign.unsubscribedCount,
      ledger,
      excludedBreakdown,
    };
  });
}
