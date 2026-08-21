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
  /** TMPL-02/D-05: optimistic-lock token, incremented once per mutating write inside this file's locked transactions. */
  version: number;
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
  version,
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
 * launch (`incomplete`), the campaign id does not resolve within the
 * caller's workspace (`not_found`), or (TMPL-02/D-05/D-06/D-07) the
 * caller's `expectedVersion` no longer matches the row's real version
 * (`version_conflict`). Mirrors segment.repository.ts's
 * `SegmentConflictError` shape.
 */
export class CampaignStateError extends Error {
  constructor(
    message: string,
    public readonly code: "illegal_transition" | "incomplete" | "not_found" | "version_conflict",
    /** Set only for the `version_conflict` case -- the row's real version, so the route can build its 409 body without a second read. */
    public readonly currentVersion?: number
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
         version = version + 1,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id, nextName, nextSegmentId, nextTemplateId, nextFromSenderId, nextFromEmail]
    );
    return updated[0];
  });
}

export interface LaunchCampaignOptions {
  /** TMPL-02/D-05/D-06: the optimistic-lock token the client read off the campaign response it is launching. */
  expectedVersion: number;
  /**
   * RESEARCH Pitfall #1: the already-resolved sender email (from the
   * read-only `resolveCampaignSenderEmail`, run OUTSIDE this lock), or
   * `null` when the campaign has neither `fromSenderId` nor `fromEmail`
   * set. Persisted here, in the SAME `UPDATE` as the status flip and the
   * version bump, so a fromSenderId-based launch bumps `version` exactly
   * once per marketer click -- never as a separate write ahead of the
   * version check, which would make that write itself the cause of a
   * spurious `version_conflict` on the very next comparison.
   */
  resolvedFromEmail: string | null;
}

/**
 * CAMP-02: draft -> sending, immediate launch. Requires templateId AND
 * (fromEmail OR fromSenderId) AND segmentId all set -- else `incomplete`
 * (CampaignStateError). Any non-draft source status is `illegal_transition`.
 * TMPL-02/D-05/D-06/D-07: `options.expectedVersion` is compared against the
 * row's real `version` INSIDE this same locked transaction -- never as a
 * route-level pre-check followed by an unlocked write -- and a mismatch
 * throws `version_conflict` carrying the row's real version so the client
 * can refetch and retry. Checked in this order: status (so a concurrent
 * launch/cancel reports the real state, not a conflict), then version (so
 * a stale view never produces a misleading per-field `incomplete` error),
 * then completeness. Locked read-check-write prevents a race against a
 * concurrent edit/cancel.
 */
export async function launchCampaign(
  id: string,
  options: LaunchCampaignOptions
): Promise<CampaignRow> {
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
    if (existing.version !== options.expectedVersion) {
      throw new CampaignStateError(
        "Campaign was modified since it was loaded",
        "version_conflict",
        existing.version
      );
    }
    if (!existing.templateId || !(existing.fromEmail || existing.fromSenderId) || !existing.segmentId) {
      throw new CampaignStateError(
        "Campaign is missing a required field (template, sender, or segment) before launch",
        "incomplete"
      );
    }

    const { rows: updated } = await client.query<CampaignRow>(
      `UPDATE campaigns SET
         status = 'sending',
         sending_started_at = now(),
         from_email = COALESCE($3, from_email),
         version = version + 1,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id, options.resolvedFromEmail]
    );
    return updated[0];
  });
}

export interface ScheduleCampaignOptions {
  scheduledAt: Date;
  /** TMPL-02/D-05/D-06/D-11: same optimistic-lock precondition as launchCampaign -- see LaunchCampaignOptions's own doc comment. */
  expectedVersion: number;
  /**
   * RESEARCH Pitfall #1: the already-resolved sender email (from the
   * read-only `resolveCampaignSenderEmail`, run OUTSIDE this lock), or
   * `null` when the campaign has neither `fromSenderId` nor `fromEmail`
   * set. Persisted here, in the SAME `UPDATE` as the status flip and the
   * version bump, so a fromSenderId-based schedule bumps `version` exactly
   * once per marketer click -- same reasoning as launchCampaign's own
   * `resolvedFromEmail` field.
   */
  resolvedFromEmail: string | null;
}

/**
 * CAMP-02/D-06: draft -> scheduled for a future UTC instant (the 04-06
 * scheduler worker picks up due campaigns and enqueues the kickoff job).
 * Only a draft can be scheduled -- else `illegal_transition`.
 * TMPL-02/D-05/D-06/D-11 (plan 20-03): `options.expectedVersion` is
 * compared against the row's real `version` INSIDE this same locked
 * transaction, mirroring `launchCampaign` exactly -- checked in this order:
 * not_found -> status (so a concurrent launch/cancel reports the real
 * state) -> version. Deliberately NO completeness check is added here:
 * scheduling an incomplete draft is existing, deliberate behaviour (the
 * launch that eventually fires the scheduled campaign is what enforces
 * completeness), and this plan does not change that.
 */
export async function scheduleCampaign(id: string, options: ScheduleCampaignOptions): Promise<CampaignRow> {
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
    if (existing.version !== options.expectedVersion) {
      throw new CampaignStateError(
        "Campaign was modified since it was loaded",
        "version_conflict",
        existing.version
      );
    }

    const { rows: updated } = await client.query<CampaignRow>(
      `UPDATE campaigns SET
         status = 'scheduled',
         scheduled_at = $3,
         from_email = COALESCE($4, from_email),
         version = version + 1,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id, options.scheduledAt, options.resolvedFromEmail]
    );
    return updated[0];
  });
}

/**
 * D-07/D-09: scheduled -> draft (clears scheduledAt, un-does the schedule
 * with no history lost) OR sending -> canceled (terminal, current counters
 * preserved as-is -- already-sent mail is never recalled). Any other source
 * status is `illegal_transition` (draft/sent/canceled are not cancelable).
 * D-05 (plan 20-03): both branches bump `version` like every other mutation
 * in this file, keeping the any-write-bumps invariant true for cancel too --
 * but deliberately takes NO `expectedVersion` parameter. D-06 enumerates
 * only launch/schedule/test-send as requiring the precondition; cancel is
 * never listed, and adding one here would break the cancel button against a
 * decision nobody made.
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
        `UPDATE campaigns SET status = 'draft', scheduled_at = NULL, version = version + 1, updated_at = now()
         WHERE workspace_id = $1 AND id = $2
         RETURNING ${CAMPAIGN_COLUMNS}`,
        [workspaceId, id]
      );
      return updated[0];
    }

    if (existing.status === "sending") {
      const { rows: updated } = await client.query<CampaignRow>(
        `UPDATE campaigns SET status = 'canceled', terminal_at = now(), version = version + 1, updated_at = now()
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

export interface PrepareCampaignTestSendOptions {
  /** TMPL-03/D-11: same uniform optimistic-lock precondition as launch/schedule. */
  expectedVersion: number;
  /**
   * RESEARCH Pitfall #1: the already-resolved sender email (from the
   * read-only `resolveCampaignSenderEmail`, run OUTSIDE this lock), or
   * `null` when the campaign has neither `fromSenderId` nor `fromEmail`
   * set.
   */
  resolvedFromEmail: string | null;
}

/**
 * TMPL-03/D-11/D-12 (plan 20-03): the locked version check for the
 * test-send path -- mirrors `launchCampaign`'s shape exactly (`SELECT ...
 * FOR UPDATE`, `not_found` -> `version_conflict` -> `incomplete`), but
 * deliberately never checks or changes `status`: a test send is not a
 * state transition and is legal in any status today, and this plan does
 * not narrow that.
 *
 * The persisting `UPDATE` below is CONDITIONAL -- guarded by `from_email
 * IS DISTINCT FROM` the resolved address -- so the any-write-bumps
 * invariant never fires on a no-op test send (every test send would
 * otherwise invalidate the client's cached version for no reason it could
 * see). The persist is kept at all (not dropped) for two reasons recorded
 * in this plan's "Resolved research questions": (1) rolling-deploy safety
 * -- an old worker draining a pre-Phase-20-shaped job ignores the new
 * `templateId`/`fromEmail` snapshot fields entirely and falls back to
 * reading `campaigns.from_email`, so a `fromSenderId`-only campaign that
 * has never launched still needs that column populated; (2)
 * `launchIncompleteFields`/`computeIncompleteReason` (apps/web) treat the
 * sender as configured when either `fromSenderId` or `fromEmail` is set,
 * so persisting keeps that UI semantics unchanged. When the write does not
 * fire, the caller gets back the locked `existing` row (whose `from_email`
 * already equals the resolved address, or the caller would have written
 * it).
 */
export async function prepareCampaignTestSend(
  id: string,
  options: PrepareCampaignTestSendOptions
): Promise<CampaignRow> {
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
    if (existing.version !== options.expectedVersion) {
      throw new CampaignStateError(
        "Campaign was modified since it was loaded",
        "version_conflict",
        existing.version
      );
    }

    // A snapshot cannot be taken of a template/sender that is not chosen --
    // each check names the specific missing field (TMPL-03).
    if (!existing.templateId) {
      throw new CampaignStateError(
        "Campaign is missing a required field (template) before a test send",
        "incomplete"
      );
    }
    const effectiveFromEmail = options.resolvedFromEmail ?? existing.fromEmail;
    if (!effectiveFromEmail) {
      throw new CampaignStateError(
        "Campaign is missing a required field (sender) before a test send",
        "incomplete"
      );
    }

    const { rows: updated } = await client.query<CampaignRow>(
      `UPDATE campaigns SET
         from_email = $3,
         version = version + 1,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND from_email IS DISTINCT FROM $3
       RETURNING ${CAMPAIGN_COLUMNS}`,
      [workspaceId, id, effectiveFromEmail]
    );
    return updated[0] ?? existing;
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
