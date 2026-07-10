import { z } from "zod";

import { EXHAUSTIVE_LOOKUP_PAGE_SIZE } from "./pagination.js";

/**
 * POST /api/workspaces/:slug/campaigns (CAMP-01) -- name + segment are
 * required to create a draft; template/sender/fromEmail can be filled in
 * later before launch.
 */
export const createCampaignSchema = z.object({
  name: z.string().min(1),
  segmentId: z.string().uuid(),
  templateId: z.string().min(1).nullable().optional(),
  fromSenderId: z.string().nullable().optional(),
  fromEmail: z.string().email().nullable().optional(),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

/**
 * PATCH /api/workspaces/:slug/campaigns/:id -- all fields optional, and
 * name/templateId/fromEmail/fromSenderId accept `null` as an explicit
 * "clear this field" signal (D-09 null-means-clear convention, mirroring
 * contact.ts's updateContactSchema). segmentId stays non-nullable but
 * remains editable while the campaign is still a draft (repository-layer
 * concern, not schema-layer).
 */
export const updateCampaignSchema = z.object({
  name: z.string().min(1).optional(),
  segmentId: z.string().uuid().optional(),
  templateId: z.string().min(1).nullable().optional(),
  fromSenderId: z.string().nullable().optional(),
  fromEmail: z.string().email().nullable().optional(),
});
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

/** GET /api/workspaces/:slug/campaigns */
export const campaignListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(EXHAUSTIVE_LOOKUP_PAGE_SIZE).optional().default(20),
});
export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;

/**
 * POST /api/workspaces/:slug/campaigns/:id/launch -- an action, not a
 * resource update; the body carries no data (immediate send).
 */
export const launchCampaignSchema = z.object({});
export type LaunchCampaignInput = z.infer<typeof launchCampaignSchema>;

/**
 * POST /api/workspaces/:slug/campaigns/:id/schedule -- D-06: the picker
 * converts local time to UTC client-side before this ISO datetime string
 * ever reaches the API.
 */
export const scheduleCampaignSchema = z.object({
  scheduledAt: z.string().datetime(),
});
export type ScheduleCampaignInput = z.infer<typeof scheduleCampaignSchema>;

/**
 * POST /api/workspaces/:slug/campaigns/:id/test-send -- D-19: `to` defaults
 * to the current user's own email server-side when omitted;
 * `dynamicTemplateData` is editable JSON overriding the template's default
 * dynamic data for this one test send.
 */
export const testSendCampaignSchema = z.object({
  to: z.string().email().optional(),
  dynamicTemplateData: z.record(z.string(), z.unknown()).optional(),
});
export type TestSendCampaignInput = z.infer<typeof testSendCampaignSchema>;

/**
 * PUT /api/workspaces/:slug/send-settings (D-13) -- per-workspace frequency
 * cap + optional rps override, PLUS (06-07/D-08/D-09) the workspace default
 * timezone + quiet-hours window a flow's `quiet_hours_mode: 'workspace_default'`
 * falls back to. frequencyWindowHours defaults to 24; rpsLimit null/omitted
 * means "use the platform default", resolved by delivery-core.
 *
 * `defaultTimezone` is format-checked here (non-empty string) only -- the
 * actual `Intl.supportedValuesOf('timeZone')` allowlist check
 * (`isValidIanaTimezone`) runs at the route layer in `apps/api`
 * (T-06-07-01), NOT in this schema, since `@mega-crm/shared-schemas` is
 * bundled into the browser (`apps/web`) and must never depend on
 * `@mega-crm/delivery-core` (a Node-only package pulling in `pg`/KMS/
 * SendGrid).
 */
export const workspaceSendSettingsSchema = z.object({
  frequencyCap: z.number().int().min(1),
  frequencyWindowHours: z.number().int().min(1).default(24),
  rpsLimit: z.number().int().min(1).nullable().optional(),
  defaultTimezone: z.string().trim().min(1).nullable().optional(),
  /** Minutes since local midnight, 0-1439. */
  quietHoursStart: z.number().int().min(0).max(1439).nullable().optional(),
  /** Minutes since local midnight, 0-1439. */
  quietHoursEnd: z.number().int().min(0).max(1439).nullable().optional(),
  quietHoursEnabled: z.boolean().optional().default(false),
});
export type WorkspaceSendSettingsInput = z.infer<typeof workspaceSendSettingsSchema>;
