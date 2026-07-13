import type {
  CreateCampaignInput,
  ScheduleCampaignInput,
  TestSendCampaignInput,
  UpdateCampaignInput,
} from "@mega-crm/shared-schemas";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";

/** CAMP-01..05: campaign lifecycle status (mirrors apps/api's CampaignRow['status']). */
export type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "canceled";

/**
 * No shared-schemas response type exists yet for campaigns (only the request
 * schemas do) -- this shape mirrors campaigns.routes.ts's toCampaignResponse
 * exactly (field-for-field, dates as ISO strings).
 */
export interface CampaignResponse {
  id: string;
  workspaceId: string;
  name: string;
  status: CampaignStatus;
  segmentId: string;
  templateId: string | null;
  fromSenderId: string | null;
  fromEmail: string | null;
  scheduledAt: string | null;
  sendableTotal: number | null;
  sentCount: number;
  failedCount: number;
  excludedTotal: number | null;
  sendingStartedAt: string | null;
  terminalAt: string | null;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignListResponse {
  items: CampaignResponse[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET /api/workspaces/:slug/campaigns (CAMP-01). */
export function listCampaigns(
  slug: string,
  params: { page?: number; pageSize?: number } = {}
): Promise<CampaignListResponse> {
  const search = new URLSearchParams();
  if (params.page) search.set("page", String(params.page));
  if (params.pageSize) search.set("pageSize", String(params.pageSize));
  const qs = search.toString();
  return apiGet<CampaignListResponse>(`/api/workspaces/${slug}/campaigns${qs ? `?${qs}` : ""}`);
}

/** POST /api/workspaces/:slug/campaigns -- create a draft (CAMP-01). */
export function createCampaign(slug: string, body: CreateCampaignInput): Promise<CampaignResponse> {
  return apiPost<CampaignResponse>(`/api/workspaces/${slug}/campaigns`, body);
}

/** GET /api/workspaces/:slug/campaigns/:id */
export function getCampaign(slug: string, id: string): Promise<CampaignResponse> {
  return apiGet<CampaignResponse>(`/api/workspaces/${slug}/campaigns/${id}`);
}

/** PATCH /api/workspaces/:slug/campaigns/:id -- only legal while status='draft' (D-08). */
export function updateCampaign(slug: string, id: string, body: UpdateCampaignInput): Promise<CampaignResponse> {
  return apiPatch<CampaignResponse>(`/api/workspaces/${slug}/campaigns/${id}`, body);
}

/** DELETE /api/workspaces/:slug/campaigns/:id -- only draft/canceled are deletable. */
export function deleteCampaign(slug: string, id: string): Promise<{ deleted: boolean }> {
  return apiDelete<{ deleted: boolean }>(`/api/workspaces/${slug}/campaigns/${id}`);
}

/** POST /api/workspaces/:slug/campaigns/:id/launch (D-19: Owner/Admin-only server-side). */
export function launchCampaign(slug: string, id: string): Promise<CampaignResponse> {
  return apiPost<CampaignResponse>(`/api/workspaces/${slug}/campaigns/${id}/launch`, {});
}

/** POST /api/workspaces/:slug/campaigns/:id/schedule (D-06/D-19). */
export function scheduleCampaign(
  slug: string,
  id: string,
  body: ScheduleCampaignInput
): Promise<CampaignResponse> {
  return apiPost<CampaignResponse>(`/api/workspaces/${slug}/campaigns/${id}/schedule`, body);
}

/** POST /api/workspaces/:slug/campaigns/:id/cancel (D-07/D-09/D-19). */
export function cancelCampaign(slug: string, id: string): Promise<CampaignResponse> {
  return apiPost<CampaignResponse>(`/api/workspaces/${slug}/campaigns/${id}/cancel`, {});
}

/** POST /api/workspaces/:slug/campaigns/:id/duplicate -- new draft copy (D-11/D-19). */
export function duplicateCampaign(slug: string, id: string): Promise<CampaignResponse> {
  return apiPost<CampaignResponse>(`/api/workspaces/${slug}/campaigns/${id}/duplicate`, {});
}

/** POST /api/workspaces/:slug/campaigns/:id/test-send (CAMP-04, ordinary-member level). */
export function testSendCampaign(
  slug: string,
  id: string,
  body: TestSendCampaignInput
): Promise<{ queued: boolean; to: string }> {
  return apiPost<{ queued: boolean; to: string }>(`/api/workspaces/${slug}/campaigns/${id}/test-send`, body);
}

/** GET /api/workspaces/:slug/campaigns/:id/test-sample -- D-18 buildContactTemplateData sample (04-08 test-send panel). */
export function getCampaignTestSample(slug: string, id: string): Promise<{ sample: Record<string, unknown> }> {
  return apiGet<{ sample: Record<string, unknown> }>(`/api/workspaces/${slug}/campaigns/${id}/test-sample`);
}

export interface CampaignProgressExcludedBreakdownItem {
  reason: string | null;
  count: number;
}

export interface CampaignProgress {
  status: CampaignStatus;
  sentCount: number;
  failedCount: number;
  sendableTotal: number | null;
  excludedTotal: number | null;
  deliveredCount: number;
  openedCount: number;
  clickedCount: number;
  bouncedCount: number;
  unsubscribedCount: number;
  ledger: {
    sent: number;
    failed: number;
    excluded: number;
    dispatching: number;
  };
  /** D-07: excluded sends grouped by exclusion_reason, for the «Пропущено» breakdown row. */
  excludedBreakdown: CampaignProgressExcludedBreakdownItem[];
}

/** GET /api/workspaces/:slug/campaigns/:id/progress -- CAMP-05 polling target (04-08: refetchInterval 3000, gated on status='sending'). */
export function getCampaignProgress(slug: string, id: string): Promise<CampaignProgress> {
  return apiGet<CampaignProgress>(`/api/workspaces/${slug}/campaigns/${id}/progress`);
}

export interface AudienceExclusionBreakdownItem {
  reason: string;
  count: number;
}

export interface CampaignAudienceBreakdown {
  sendableCount: number;
  breakdown: AudienceExclusionBreakdownItem[];
}

/** GET /api/workspaces/:slug/campaigns/:id/audience-breakdown -- D-04 (04-08 launch-confirm dialog). */
export function getCampaignAudienceBreakdown(slug: string, id: string): Promise<CampaignAudienceBreakdown> {
  return apiGet<CampaignAudienceBreakdown>(`/api/workspaces/${slug}/campaigns/${id}/audience-breakdown`);
}

export interface SendGridDynamicTemplate {
  id: string;
  name: string;
  generation: string;
}

/**
 * GET /api/workspaces/:slug/campaigns/sendgrid/templates -- D-16 refresh-list
 * source for the template combobox. The route has no `:id` segment (it
 * reads the tenant's own SendGrid key, not a specific campaign), so this
 * wrapper only ever takes `slug`.
 */
export function listCampaignTemplates(slug: string): Promise<{ templates: SendGridDynamicTemplate[] }> {
  return apiGet<{ templates: SendGridDynamicTemplate[] }>(`/api/workspaces/${slug}/campaigns/sendgrid/templates`);
}

export interface SendGridVerifiedSender {
  id: number;
  fromEmail: string;
  nickname?: string;
}

/** GET /api/workspaces/:slug/campaigns/sendgrid/senders -- D-17 verified-sender list for the sender combobox. */
export function listCampaignSenders(slug: string): Promise<{ senders: SendGridVerifiedSender[] }> {
  return apiGet<{ senders: SendGridVerifiedSender[] }>(`/api/workspaces/${slug}/campaigns/sendgrid/senders`);
}
