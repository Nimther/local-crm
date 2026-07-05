import type { CreateSegmentInput, SegmentDefinition, SegmentListResponse, SegmentResponse } from "@mega-crm/shared-schemas";
import { apiGet, apiPost } from "@/lib/api";

/** D-10/D-11: paginated segment list. */
export function listSegments(
  slug: string,
  params: { page?: number; pageSize?: number } = {}
): Promise<SegmentListResponse> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return apiGet<SegmentListResponse>(`/api/workspaces/${slug}/segments${qs ? `?${qs}` : ""}`);
}

/** D-05: observed event names + free-text fallback (segment builder behavioral condition). */
export function fetchEventNames(slug: string): Promise<{ names: string[] }> {
  return apiGet<{ names: string[] }>(`/api/workspaces/${slug}/segments/event-names`);
}

/**
 * SEGM-04/D-08: live-preview count for an unsaved definition. `degraded: true`
 * means the server's statement_timeout kicked in (T-03-04) -- callers must
 * keep showing the last successfully computed count, dimmed, per the
 * UI-SPEC's "(устарело)" copy.
 */
export type PreviewCountResult = { count: number } | { degraded: true };

export function fetchPreviewCount(slug: string, definition: SegmentDefinition): Promise<PreviewCountResult> {
  return apiPost<PreviewCountResult>(`/api/workspaces/${slug}/segments/preview-count`, { definition });
}

/** POST /api/workspaces/:slug/segments -- create a named segment (SEGM-01/02). */
export function createSegment(slug: string, body: CreateSegmentInput): Promise<SegmentResponse> {
  return apiPost<SegmentResponse>(`/api/workspaces/${slug}/segments`, body);
}
