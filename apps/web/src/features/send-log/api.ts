import { apiGet } from "@/lib/api";

/**
 * D-15's closed status vocabulary (mirrors apps/api/src/modules/send-log/
 * send-log.repository.ts's SEND_LOG_STATUSES).
 *
 * Phase 11 (11-10): `reconciling`/`unknown` added -- ledger states, not
 * delivery facts. `SEND_LOG_STATUS_VALUES` is the runtime source both
 * `SendLogStatus` (below) and the drift test derive from -- apps/web has no
 * package dependency on apps/api, so the two vocabularies cannot be
 * compared via a shared import; `send-log-status-vocabulary.test.ts` instead
 * asserts this array against a copy of the API's list committed in the test
 * itself, with a comment naming this file's sibling as the source of truth.
 */
export const SEND_LOG_STATUS_VALUES = [
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

export type SendLogStatus = (typeof SEND_LOG_STATUS_VALUES)[number];

export interface SendLogItem {
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
  queuedAt: string;
  sentAt: string | null;
  openCount: number;
  clickCount: number;
}

export interface SendLogListResponse {
  items: SendLogItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SendLogEventItem {
  id: string;
  eventType: string;
  occurredAt: string;
  reason: string | null;
  clickUrl: string | null;
}

/** D-13: filters are the exact URL search params other pages deep-link with (contactId/campaignOrFlowId/status[]/period/page). */
export function fetchSendLog(slug: string, params: URLSearchParams): Promise<SendLogListResponse> {
  return apiGet<SendLogListResponse>(`/api/workspaces/${slug}/send-log?${params.toString()}`);
}

/** D-14: the drawer's per-message chronology, oldest -> newest. */
export function fetchSendLogEvents(slug: string, sendId: string): Promise<SendLogEventItem[]> {
  return apiGet<SendLogEventItem[]>(`/api/workspaces/${slug}/send-log/${sendId}/events`);
}
