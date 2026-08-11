import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

/** Common row shape every UNION branch below is normalized into (ANLT-03/D-10). */
export type TimelineRowKind = "event" | "send" | "status_change" | "flow_entry_exit";

export interface TimelineRow {
  kind: TimelineRowKind;
  occurredAt: Date;
  label: string;
  detail: Record<string, unknown>;
}

/** D-10: the record-type filter's four values -- «Статусы» buckets BOTH status_change and flow_entry_exit rows together (the UI-SPEC's copywriting contract defines only 4 filter values for 4 underlying kinds). */
export type TimelineTypeFilter = "all" | "events" | "emails" | "statuses";

const CONTACT_TIMELINE_PAGE_SIZE = 50;

const KINDS_BY_TYPE_FILTER: Record<Exclude<TimelineTypeFilter, "all">, TimelineRowKind[]> = {
  events: ["event"],
  emails: ["send"],
  statuses: ["status_change", "flow_entry_exit"],
};

/**
 * D-10/D-11/D-12/ANLT-03: unions `events`, `sends`, `subscription_status_history`,
 * and `flow_runs` into one `{ kind, occurredAt, label, detail }` shape,
 * newest first, paginated with the codebase's existing page/pageSize offset
 * convention. Repeated opens/clicks collapse to a single send row for free
 * (D-11) -- the send branch reads `sends.open_count`/`click_count` (O(1) per
 * row), never a per-row send_events aggregate subquery. The send
 * branch's `status` mirrors `@mega-crm/delivery-core`'s `deriveCurrentStatus`
 * D-06 priority chain (bounced/dropped/spam > clicked > opened > delivered >
 * the ledger's own `status`), expressed in SQL, with `excluded` taking
 * top priority since an excluded send never has any delivery fact set.
 */
export async function listContactTimeline(
  contactId: string,
  options: { page?: number; type?: TimelineTypeFilter } = {}
): Promise<TimelineRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const page = Math.max(1, options.page ?? 1);
    const type = options.type ?? "all";
    const kinds = type === "all" ? null : KINDS_BY_TYPE_FILTER[type];

    const { rows } = await client.query<{ kind: TimelineRowKind; occurredAt: Date; label: string; detail: Record<string, unknown> }>(
      `SELECT kind, occurred_at as "occurredAt", label, detail
       FROM (
         SELECT
           'event'::text AS kind,
           e.occurred_at AS occurred_at,
           e.name AS label,
           jsonb_build_object('eventId', e.id, 'properties', e.properties) AS detail
         FROM events e
         WHERE e.workspace_id = $1 AND e.contact_id = $2

         UNION ALL

         SELECT
           'send'::text AS kind,
           COALESCE(s.sent_at, s.queued_at) AS occurred_at,
           'Письмо'::text AS label,
           jsonb_build_object(
             'sendId', s.id,
             'campaignId', s.campaign_id,
             'flowRunId', s.flow_run_id,
             'nodeId', s.node_id,
             'status', CASE
               WHEN s.status = 'excluded' THEN 'excluded'
               -- Phase 11 (11-10): checked before the fact chain for the
               -- same reason send-log.repository.ts's COMPUTED_STATUS_SQL
               -- does -- a row can be 'reconciling' with a fact already
               -- recorded but not yet adjudicated by the reconciler.
               -- 'unknown' needs no matching explicit arm: this ladder's
               -- own ELSE already falls through to the raw status text
               -- after the fact chain, which is the desired late-evidence-
               -- wins behavior for 'unknown' too.
               WHEN s.status = 'reconciling' THEN 'reconciling'
               WHEN s.bounced_at IS NOT NULL THEN 'bounced'
               WHEN s.dropped_at IS NOT NULL THEN 'dropped'
               WHEN s.spam_reported_at IS NOT NULL THEN 'spam'
               WHEN s.first_clicked_at IS NOT NULL THEN 'clicked'
               WHEN s.first_opened_at IS NOT NULL THEN 'opened'
               WHEN s.delivered_at IS NOT NULL THEN 'delivered'
               ELSE s.status::text
             END,
             'openCount', s.open_count,
             'clickCount', s.click_count,
             'reason', CASE
               WHEN s.status = 'excluded' THEN s.exclusion_reason
               WHEN s.bounced_at IS NOT NULL THEN s.bounce_reason
               WHEN s.dropped_at IS NOT NULL THEN s.drop_reason
               ELSE NULL
             END
           ) AS detail
         FROM sends s
         WHERE s.workspace_id = $1 AND s.contact_id = $2

         UNION ALL

         SELECT
           'status_change'::text AS kind,
           h.changed_at AS occurred_at,
           (COALESCE(h.old_status, '—') || ' → ' || h.new_status)::text AS label,
           jsonb_build_object('oldStatus', h.old_status, 'newStatus', h.new_status, 'source', h.source, 'reason', h.reason) AS detail
         FROM subscription_status_history h
         WHERE h.workspace_id = $1 AND h.contact_id = $2

         UNION ALL

         SELECT
           'flow_entry_exit'::text AS kind,
           fr.entered_at AS occurred_at,
           'Вошёл в цепочку'::text AS label,
           jsonb_build_object(
             'flowId', fr.flow_id,
             'flowRunId', fr.id,
             'enteredAt', fr.entered_at,
             'exitedAt', fr.exited_at,
             'exitReason', fr.exit_reason,
             'status', fr.status
           ) AS detail
         FROM flow_runs fr
         WHERE fr.workspace_id = $1 AND fr.contact_id = $2
       ) unioned
       WHERE ($5::text[] IS NULL OR kind = ANY($5::text[]))
       ORDER BY occurred_at DESC
       LIMIT $3 OFFSET $4`,
      [workspaceId, contactId, CONTACT_TIMELINE_PAGE_SIZE, (page - 1) * CONTACT_TIMELINE_PAGE_SIZE, kinds]
    );

    return rows;
  });
}
