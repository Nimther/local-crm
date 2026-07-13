import type { PoolClient } from "pg";

/**
 * Source-tag vocabulary for `subscription_status_history.source` (07-01,
 * D-09). One tag per mutation call site so the contact timeline (07-02) can
 * attribute a status change to where it came from.
 */
export type SubscriptionStatusChangeSource =
  | "webhook_suppression"
  | "webhook_unsubscribe"
  | "unsubscribe_route"
  | "manual_ui"
  | "csv_or_api_upsert";

export interface RecordSubscriptionStatusChangeParams {
  workspaceId: string;
  contactId: string;
  /** Null only for a genuine first-ever record; every real call site in this codebase has a known prior status. */
  oldStatus: string | null;
  newStatus: string;
  source: SubscriptionStatusChangeSource;
  reason?: string | null;
}

/**
 * D-09: writes exactly one `subscription_status_history` row recording a
 * subscription-status transition. Must be called with `client` already
 * inside the caller's open tenant-scoped transaction -- this function never
 * opens its own transaction, so the write always participates in (and is
 * rolled back with) whichever transaction the mutation itself ran in, and
 * RLS applies via the ambient `app.current_workspace_id` GUC.
 *
 * This helper does NOT compare old vs new status -- every caller MUST gate
 * the call on `newStatus !== oldStatus` itself (Rule: "a write that does not
 * change the value writes no history row"). Calling this unconditionally
 * would record no-op "changes", which is exactly what the plan's
 * prohibition forbids.
 */
export async function recordSubscriptionStatusChange(
  client: PoolClient,
  params: RecordSubscriptionStatusChangeParams
): Promise<void> {
  await client.query(
    `INSERT INTO subscription_status_history
       (workspace_id, contact_id, old_status, new_status, source, reason, changed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [params.workspaceId, params.contactId, params.oldStatus, params.newStatus, params.source, params.reason ?? null]
  );
}
