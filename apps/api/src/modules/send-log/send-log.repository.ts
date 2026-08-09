import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import { SEND_LOG_PAGE_SIZE } from "@mega-crm/shared-schemas";

/**
 * D-15's closed status vocabulary: Phase 5's D-06 priority chain
 * (bounced/dropped/spam/clicked/opened/delivered/sent), extended with
 * `failed` and `excluded`. `unsubscribed` deliberately excluded here --
 * 07-01's SUMMARY notes it never participates in the D-06 derivation (it's a
 * subscription-status concern, not a per-message delivery fact), so it can
 * never actually be produced by `COMPUTED_STATUS_SQL` below.
 *
 * Phase 11 (11-10, DLV-02/DLV-07): `reconciling` and `unknown` are ledger
 * states, not delivery facts -- they reach the computed status through
 * `COMPUTED_STATUS_SQL`'s fall-through arms, not the D-06 fact chain.
 * `unknown` means the platform never learned this send's outcome (a
 * transport-layer ambiguity the reconciler could not resolve within its
 * resolution window) and it will NOT be automatically re-sent -- see
 * ARCHITECTURE.md ##9's DLV-07 delivery model before changing any UI copy
 * that surfaces this value.
 */
export const SEND_LOG_STATUSES = [
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "dropped",
  "spam",
  "failed",
  "excluded",
  "reconciling",
  "unknown",
] as const;

export type SendLogStatus = (typeof SEND_LOG_STATUSES)[number];

export interface ListSendLogQuery {
  contactId?: string;
  campaignOrFlowId?: string;
  statuses?: SendLogStatus[];
  period?: 7 | 30 | 90;
  page: number;
}

export interface SendLogRow {
  id: string;
  contactId: string;
  contactEmail: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  flowId: string | null;
  flowName: string | null;
  flowRunId: string | null;
  status: string;
  exclusionReason: string | null;
  bounceReason: string | null;
  dropReason: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  openCount: number;
  clickCount: number;
}

export interface ListSendLogResult {
  items: SendLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SendEventRow {
  id: string;
  eventType: string;
  occurredAt: Date;
  reason: string | null;
  clickUrl: string | null;
}

/**
 * D-06/D-15: one collapsed current status per row, expressed as a SQL CASE
 * (mirrors `apps/api/src/modules/analytics/timeline.repository.ts`'s
 * identical precedent and `@mega-crm/delivery-core`'s `deriveCurrentStatus`
 * pure-JS equivalent) -- `excluded`/`failed` are checked ahead of the D-06
 * delivery-fact chain since an excluded/failed send never has any delivery
 * fact set, so ordering here never changes the result, only readability.
 *
 * Phase 11 (11-10): `reconciling` and `unknown` are placed on OPPOSITE sides
 * of the delivery-fact chain, deliberately:
 * - `reconciling` is checked BEFORE the fact chain. A row can be
 *   `reconciling` while the webhook worker has already written a fact for
 *   it (facts are recorded independently of `status`, ARCHITECTURE.md ##9)
 *   -- but the reconciler has not yet adjudicated that evidence, so the row
 *   is still "being determined" and must say so, not jump ahead of the sole
 *   writer that is allowed to resolve it.
 * - `unknown` is checked AFTER the fact chain. This is precisely the
 *   late-evidence case the reconciler's bounded re-scan (D-04) exists for:
 *   an `unknown` row that has since gained a fact should surface as that
 *   fact immediately, not continue to claim ignorance.
 */
const COMPUTED_STATUS_SQL = `
    CASE
      WHEN s.status = 'excluded' THEN 'excluded'
      WHEN s.status = 'failed' THEN 'failed'
      WHEN s.status = 'reconciling' THEN 'reconciling'
      WHEN s.bounced_at IS NOT NULL THEN 'bounced'
      WHEN s.dropped_at IS NOT NULL THEN 'dropped'
      WHEN s.spam_reported_at IS NOT NULL THEN 'spam'
      WHEN s.first_clicked_at IS NOT NULL THEN 'clicked'
      WHEN s.first_opened_at IS NOT NULL THEN 'opened'
      WHEN s.delivered_at IS NOT NULL THEN 'delivered'
      WHEN s.status = 'unknown' THEN 'unknown'
      ELSE s.status::text
    END
`;

/**
 * D-13/D-15/ANLT-05: the workspace-wide per-message send list. Filters
 * compile to a parameterized WHERE (T-07-05-01, never string-interpolated) --
 * copies `contact.repository.ts`'s `listContacts` $N-placeholder builder.
 * contact/campaign-or-flow/period filters apply inside the base subquery;
 * the computed-status multi-select filters the OUTER query (mirrors
 * `timeline.repository.ts`'s subquery-then-filter shape) since the computed
 * `status` column doesn't exist as a real column to filter on directly --
 * it's a derived CASE expression.
 */
export async function listSendLog(query: ListSendLogQuery): Promise<ListSendLogResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const conditions: string[] = ["s.workspace_id = $1"];
    const params: unknown[] = [workspaceId];

    if (query.contactId) {
      params.push(query.contactId);
      conditions.push(`s.contact_id = $${params.length}`);
    }
    if (query.campaignOrFlowId) {
      params.push(query.campaignOrFlowId);
      const idx = params.length;
      conditions.push(`(s.campaign_id = $${idx} OR fr.flow_id = $${idx})`);
    }
    if (query.period) {
      params.push(query.period);
      conditions.push(`COALESCE(s.sent_at, s.queued_at) >= now() - make_interval(days => $${params.length}::int)`);
    }

    const innerWhere = conditions.join(" AND ");

    let statusFilterSql = "TRUE";
    if (query.statuses && query.statuses.length > 0) {
      params.push(query.statuses);
      statusFilterSql = `status = ANY($${params.length}::text[])`;
    }

    const baseQuery = `
      SELECT
        s.id AS id,
        s.contact_id AS "contactId",
        c.email AS "contactEmail",
        c.first_name AS "contactFirstName",
        c.last_name AS "contactLastName",
        s.campaign_id AS "campaignId",
        camp.name AS "campaignName",
        fr.flow_id AS "flowId",
        fl.name AS "flowName",
        s.flow_run_id AS "flowRunId",
        ${COMPUTED_STATUS_SQL} AS status,
        s.exclusion_reason AS "exclusionReason",
        s.bounce_reason AS "bounceReason",
        s.drop_reason AS "dropReason",
        s.queued_at AS "queuedAt",
        s.sent_at AS "sentAt",
        s.open_count AS "openCount",
        s.click_count AS "clickCount"
      FROM sends s
      LEFT JOIN contacts c ON c.id = s.contact_id
      LEFT JOIN campaigns camp ON camp.id = s.campaign_id
      LEFT JOIN flow_runs fr ON fr.id = s.flow_run_id
      LEFT JOIN flows fl ON fl.id = fr.flow_id
      WHERE ${innerWhere}
    `;

    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM (${baseQuery}) sub WHERE ${statusFilterSql}`,
      params
    );

    const pageSize = SEND_LOG_PAGE_SIZE;
    params.push(pageSize, (query.page - 1) * pageSize);
    const { rows } = await client.query<SendLogRow>(
      `SELECT * FROM (${baseQuery}) sub
       WHERE ${statusFilterSql}
       ORDER BY COALESCE("sentAt", "queuedAt") DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      items: rows,
      total: Number(countRows[0]?.count ?? 0),
      page: query.page,
      pageSize,
    };
  });
}

/**
 * T-07-05-02 (IDOR): the drawer route's explicit existence check -- a
 * foreign-workspace `sendId` resolves to `null` here (RLS + the explicit
 * `workspace_id = $1` filter), letting the route 404 instead of returning an
 * empty-but-200 events array that would leak "this id exists elsewhere".
 */
export async function getSendById(sendId: string): Promise<{ id: string } | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM sends WHERE workspace_id = $1 AND id = $2`, [
      workspaceId,
      sendId,
    ]);
    return rows[0] ?? null;
  });
}

/**
 * D-14: the drawer's per-message chronology, oldest-first (sent → delivered
 * → opened ×N → clicks by URL). `clickUrl` reads SendGrid's own `url` field
 * off the raw event payload -- only present on click events, `null`
 * otherwise.
 */
export async function listSendEventsForSend(sendId: string): Promise<SendEventRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<SendEventRow>(
      `SELECT
         id,
         event_type AS "eventType",
         occurred_at AS "occurredAt",
         reason,
         payload->>'url' AS "clickUrl"
       FROM send_events
       WHERE workspace_id = $1 AND send_id = $2
       ORDER BY occurred_at ASC`,
      [workspaceId, sendId]
    );
    return rows;
  });
}
