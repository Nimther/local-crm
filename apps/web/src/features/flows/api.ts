import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateFlowInput,
  FlowExitCondition,
  FlowQuietHoursMode,
  FlowReentryMode,
  UpdateFlowDraftInput,
} from "@mega-crm/shared-schemas";
import type { FlowDefinition } from "@mega-crm/flows-core";
import { apiGet, apiPatch, apiPost } from "@/lib/api";

/** FLOW-04..07: flow lifecycle status (mirrors apps/api's FlowRow['status'], D-18/D-22 — no terminal state in v1). */
export type FlowStatus = "draft" | "live" | "paused";

/**
 * No shared-schemas response type exists for flows (only the request schemas
 * do) — this shape mirrors flows.routes.ts's toFlowResponse exactly
 * (field-for-field, dates as ISO strings). Same convention as campaigns/api.ts.
 */
export interface FlowResponse {
  id: string;
  workspaceId: string;
  name: string;
  status: FlowStatus;
  triggerType: "event" | "segment" | null;
  triggerEventName: string | null;
  triggerSegmentId: string | null;
  draftVersionId: string | null;
  liveVersionId: string | null;
  reentryMode: FlowReentryMode;
  reentryWindowDays: number | null;
  quietHoursMode: FlowQuietHoursMode;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  exitConditions: FlowExitCondition[];
  /** Best-current-editable definition: working draft if one exists, else the live published definition. */
  definition: FlowDefinition;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlowListResponse {
  items: FlowResponse[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Thin per-endpoint fetch wrappers (campaigns/api.ts convention)
// ---------------------------------------------------------------------------

/** GET /api/workspaces/:slug/flows (FLOW-01 list). */
export function listFlows(
  slug: string,
  params: { page?: number; pageSize?: number } = {}
): Promise<FlowListResponse> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return apiGet<FlowListResponse>(`/api/workspaces/${slug}/flows${qs ? `?${qs}` : ""}`);
}

/** POST /api/workspaces/:slug/flows — name-only draft creation (mirrors campaigns). */
export function createFlow(slug: string, body: CreateFlowInput): Promise<FlowResponse> {
  return apiPost<FlowResponse>(`/api/workspaces/${slug}/flows`, body);
}

/** GET /api/workspaces/:slug/flows/:id */
export function getFlow(slug: string, id: string): Promise<FlowResponse> {
  return apiGet<FlowResponse>(`/api/workspaces/${slug}/flows/${id}`);
}

/** PATCH /api/workspaces/:slug/flows/:id — draft update; D-20 lazily recreates a working draft after publish. */
export function updateFlowDraft(slug: string, id: string, body: UpdateFlowDraftInput): Promise<FlowResponse> {
  return apiPatch<FlowResponse>(`/api/workspaces/${slug}/flows/${id}`, body);
}

/**
 * POST /api/workspaces/:slug/flows/:id/publish (Owner/Admin-only, D-23).
 * The server re-runs validateFlowDefinition inside the publish transaction and
 * rejects with 422 {fields} — the client-computed blocker list is NEVER sent
 * or trusted (Pitfall 3); render the server-returned list on rejection.
 */
export function publishFlow(slug: string, id: string): Promise<FlowResponse> {
  return apiPost<FlowResponse>(`/api/workspaces/${slug}/flows/${id}/publish`, {});
}

/** POST /api/workspaces/:slug/flows/:id/pause (Owner/Admin-only, D-23). */
export function pauseFlow(slug: string, id: string): Promise<FlowResponse> {
  return apiPost<FlowResponse>(`/api/workspaces/${slug}/flows/${id}/pause`, {});
}

/** POST /api/workspaces/:slug/flows/:id/resume (Owner/Admin-only, D-23). */
export function resumeFlow(slug: string, id: string): Promise<FlowResponse> {
  return apiPost<FlowResponse>(`/api/workspaces/${slug}/flows/${id}/resume`, {});
}

/** POST /api/workspaces/:slug/flows/:id/duplicate — new draft copy, Member-allowed (D-23). */
export function duplicateFlow(slug: string, id: string): Promise<FlowResponse> {
  return apiPost<FlowResponse>(`/api/workspaces/${slug}/flows/${id}/duplicate`, {});
}

// ---------------------------------------------------------------------------
// TanStack Query hooks
// ---------------------------------------------------------------------------

/** Query-key helpers so every hook invalidates/updates the same key shapes. */
export const flowKeys = {
  all: (slug: string) => ["workspace", slug, "flows"] as const,
  list: (slug: string, page: number, pageSize: number) =>
    ["workspace", slug, "flows", page, pageSize] as const,
  detail: (slug: string, id: string) => ["workspace", slug, "flows", "detail", id] as const,
};

/** Paginated flow list (keepPreviousData for stable pagination, mirrors CampaignsListPage). */
export function useFlows(slug: string, params: { page?: number; pageSize?: number } = {}) {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  return useQuery({
    queryKey: flowKeys.list(slug, page, pageSize),
    queryFn: () => listFlows(slug, { page, pageSize }),
    placeholderData: keepPreviousData,
    enabled: Boolean(slug),
  });
}

/** Single flow (canvas/detail page source of truth on load). */
export function useFlow(slug: string, id: string | undefined) {
  return useQuery({
    queryKey: flowKeys.detail(slug, id ?? ""),
    queryFn: () => getFlow(slug, id as string),
    enabled: Boolean(slug && id),
  });
}

export function useCreateFlow(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateFlowInput) => createFlow(slug, body),
    onSuccess: async (created) => {
      queryClient.setQueryData(flowKeys.detail(slug, created.id), created);
      await queryClient.invalidateQueries({ queryKey: flowKeys.all(slug) });
    },
  });
}

/**
 * Draft PATCH used by the canvas's debounced autosave (useAutosaveDraft).
 * Updates the detail cache in place instead of invalidating — an invalidate
 * would refetch mid-edit and clobber unsaved canvas state.
 */
export function useUpdateFlowDraft(slug: string, id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateFlowDraftInput) => updateFlowDraft(slug, id, body),
    onSuccess: (updated) => {
      queryClient.setQueryData(flowKeys.detail(slug, id), updated);
    },
  });
}

export function usePublishFlow(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => publishFlow(slug, id),
    onSuccess: async (published) => {
      queryClient.setQueryData(flowKeys.detail(slug, published.id), published);
      await queryClient.invalidateQueries({ queryKey: flowKeys.all(slug) });
    },
  });
}

export function usePauseFlow(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => pauseFlow(slug, id),
    onSuccess: async (paused) => {
      queryClient.setQueryData(flowKeys.detail(slug, paused.id), paused);
      await queryClient.invalidateQueries({ queryKey: flowKeys.all(slug) });
    },
  });
}

export function useResumeFlow(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => resumeFlow(slug, id),
    onSuccess: async (resumed) => {
      queryClient.setQueryData(flowKeys.detail(slug, resumed.id), resumed);
      await queryClient.invalidateQueries({ queryKey: flowKeys.all(slug) });
    },
  });
}

export function useDuplicateFlow(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => duplicateFlow(slug, id),
    onSuccess: async (duplicated) => {
      queryClient.setQueryData(flowKeys.detail(slug, duplicated.id), duplicated);
      await queryClient.invalidateQueries({ queryKey: flowKeys.all(slug) });
    },
  });
}
