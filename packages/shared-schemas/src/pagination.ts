/**
 * Maximum page size for the small, bounded, client-side "fetch effectively
 * all" exhaustive lookups -- the campaign builder's segment picker, the
 * campaigns-list segment-name lookup, and the D-03 scheduled-campaign
 * warning (SegmentDetailPage). This is the single source of truth shared by
 * `segmentListQuerySchema`/`campaignListQuerySchema` (their `pageSize` `max`
 * bound) and those three web call sites (their `pageSize` request argument),
 * so the client/server contract cannot silently drift again (see
 * .planning/debug/campaign-builder-segments-400.md).
 *
 * Segments and campaigns are low-cardinality per-workspace tables (unlike
 * contacts/events/sends), so a 200-row bound is a trivial, index-backed,
 * RLS-scoped query.
 */
export const EXHAUSTIVE_LOOKUP_PAGE_SIZE = 200;

/**
 * Page size for the workspace-wide send-log list (07-05, D-13/ANLT-05). The
 * `sends` ledger is a high-cardinality, time-ordered table (unlike segments/
 * campaigns above) -- a bounded, offset-paginated page keeps each query
 * index-backed under RLS rather than an unbounded scan.
 */
export const SEND_LOG_PAGE_SIZE = 50;
