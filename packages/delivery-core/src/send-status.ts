/**
 * Pure current-status priority helper (D-06).
 *
 * This is a READ-TIME helper, NOT a stored generated column -- the priority
 * rule can change without a migration. Facts (nullable fact timestamps) are
 * COALESCE-written by the 05-03 worker and never overwritten once set,
 * satisfying D-06's out-of-order-event safety: no matter what order webhook
 * events arrive in, `deriveCurrentStatus` always derives the same current
 * status from the same set of facts (order-insensitive by construction --
 * it inspects presence/absence of each fact, not arrival order).
 */
export interface DeliveryFacts {
  deliveredAt?: Date | string | null;
  firstOpenedAt?: Date | string | null;
  firstClickedAt?: Date | string | null;
  bouncedAt?: Date | string | null;
  droppedAt?: Date | string | null;
  spamReportedAt?: Date | string | null;
  unsubscribedAt?: Date | string | null;
}

// 08-07: the trailing `| string` absorbed every literal before it, so this
// union WAS exactly `string` and no-redundant-type-constituents reported all
// seven members. `(string & {})` keeps the known statuses visible to editor
// completion and to a reader, while still accepting whatever `baseStatus` the
// ledger supplies — which is the openness the original `| string` intended.
export type CurrentStatus =
  | "bounced"
  | "dropped"
  | "spam"
  | "clicked"
  | "opened"
  | "delivered"
  | "sent"
  | (string & {});

/**
 * D-06 priority order: terminal (bounced/dropped/spam) wins over any
 * open/click/delivered fact > clicked > opened > delivered > falls back to
 * `baseStatus` (e.g. the ledger's own `sends.status`, typically 'sent')
 * when no delivery fact is set at all.
 */
export function deriveCurrentStatus(facts: DeliveryFacts, baseStatus: string): CurrentStatus {
  if (facts.bouncedAt) return "bounced";
  if (facts.droppedAt) return "dropped";
  if (facts.spamReportedAt) return "spam";
  if (facts.firstClickedAt) return "clicked";
  if (facts.firstOpenedAt) return "opened";
  if (facts.deliveredAt) return "delivered";
  return baseStatus;
}
