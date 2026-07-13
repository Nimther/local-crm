import { apiGet } from "@/lib/api";

/** D-15's closed status vocabulary (mirrors apps/api/src/modules/send-log/send-log.repository.ts's SEND_LOG_STATUSES). */
export type SendLogStatus =
  | "sent"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "dropped"
  | "spam"
  | "failed"
  | "excluded";

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
