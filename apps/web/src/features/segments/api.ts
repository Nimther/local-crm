import type {
  ContactListResponse,
  CreateSegmentInput,
  SegmentDefinition,
  SegmentListResponse,
  SegmentResponse,
  UpdateSegmentInput,
} from "@mega-crm/shared-schemas";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

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

/** GET /api/workspaces/:slug/segments/:id -- D-12 segment detail (definition + metadata). */
export function getSegment(slug: string, id: string): Promise<SegmentResponse> {
  return apiGet<SegmentResponse>(`/api/workspaces/${slug}/segments/${id}`);
}

/** PATCH /api/workspaces/:slug/segments/:id -- D-13/D-14: rename and/or redefine (both optional). */
export function updateSegment(slug: string, id: string, body: UpdateSegmentInput): Promise<SegmentResponse> {
  return apiPatch<SegmentResponse>(`/api/workspaces/${slug}/segments/${id}`, body);
}

/** DELETE /api/workspaces/:slug/segments/:id -- D-14 free deletion (Phase 3). */
export function deleteSegment(slug: string, id: string): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(`/api/workspaces/${slug}/segments/${id}`);
}

/** GET /api/workspaces/:slug/segments/:id/members -- D-12 paginated member list (contacts). */
export function listSegmentMembers(
  slug: string,
  id: string,
  params: { page?: number; pageSize?: number } = {}
): Promise<ContactListResponse> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return apiGet<ContactListResponse>(`/api/workspaces/${slug}/segments/${id}/members${qs ? `?${qs}` : ""}`);
}
