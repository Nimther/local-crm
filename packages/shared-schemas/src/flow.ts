import { z } from "zod";
import { flowDefinitionSchema } from "@mega-crm/flows-core";

import { EXHAUSTIVE_LOOKUP_PAGE_SIZE } from "./pagination.js";

/** POST /api/workspaces/:slug/flows -- name-only draft creation (mirrors campaigns). */
export const createFlowSchema = z.object({
  name: z.string().trim().min(1).max(255),
});
export type CreateFlowInput = z.infer<typeof createFlowSchema>;

/** D-06/D-07: once ever / once per N days (from last entry) / every time, one active run per contact regardless of mode. */
export const flowReentryModeSchema = z.enum(["once_ever", "once_per_n_days", "every_time"]);
export type FlowReentryMode = z.infer<typeof flowReentryModeSchema>;

/** D-09: workspace default window, a per-flow custom override, or disabled entirely. */
export const flowQuietHoursModeSchema = z.enum(["workspace_default", "custom", "disabled"]);
export type FlowQuietHoursMode = z.infer<typeof flowQuietHoursModeSchema>;

/**
 * D-15: two exit-condition kinds -- segment membership (in/not_in) or an
 * event occurring after the run's entry (checked against `events.occurred_at
 * > run.started_at`). These are flow-level exit rules, distinct from the
 * explicit exit NODES on the canvas (FLOW-01), which are just path-end
 * markers.
 */
export const flowExitConditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("segment"), segmentId: z.string().uuid(), mode: z.enum(["in", "not_in"]) }),
  z.object({ type: z.literal("event"), eventName: z.string().min(1) }),
]);
export type FlowExitCondition = z.infer<typeof flowExitConditionSchema>;

/**
 * PATCH /api/workspaces/:slug/flows/:id/draft -- all fields optional so any
 * subset can be updated independently. `definition` reuses flows-core's
 * flowDefinitionSchema directly (no redeclaration) to avoid the node/edge
 * shape ever drifting between packages. superRefine enforces the two
 * conditionally-required pairs: reentryWindowDays when reentryMode is
 * "once_per_n_days" (D-06), and quietHoursStart/quietHoursEnd when
 * quietHoursMode is "custom" (D-09).
 */
export const updateFlowDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    definition: flowDefinitionSchema.optional(),
    reentryMode: flowReentryModeSchema.optional(),
    reentryWindowDays: z.number().int().min(1).optional(),
    quietHoursMode: flowQuietHoursModeSchema.optional(),
    quietHoursStart: z.number().int().min(0).max(1439).optional(),
    quietHoursEnd: z.number().int().min(0).max(1439).optional(),
    exitConditions: z.array(flowExitConditionSchema).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.reentryMode === "once_per_n_days" && val.reentryWindowDays === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reentryWindowDays"],
        message: "reentryWindowDays is required when reentryMode is 'once_per_n_days'",
      });
    }
    if (val.quietHoursMode === "custom" && (val.quietHoursStart === undefined || val.quietHoursEnd === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quietHoursStart"],
        message: "quietHoursStart and quietHoursEnd are required when quietHoursMode is 'custom'",
      });
    }
  });
export type UpdateFlowDraftInput = z.infer<typeof updateFlowDraftSchema>;

/**
 * POST /api/workspaces/:slug/flows/:id/publish -- D-04's enroll-existing
 * choice, meaningful only for a segment-triggered flow: `true` enqueues a
 * resumable batch that creates runs for current segment members (subject to
 * re-entry/frequency-cap/quiet-hours, same as any other entry path);
 * `false`/omitted marks current members "seen" in the membership snapshot
 * WITHOUT creating any run, so only future entrants enroll. Ignored (no-op)
 * for an event-triggered flow. Optional/no-body-required so the existing
 * bare `POST .../publish` call (no payload) keeps working unchanged.
 */
export const publishFlowSchema = z.object({
  enrollExisting: z.boolean().optional(),
});
export type PublishFlowInput = z.infer<typeof publishFlowSchema>;

/** GET /api/workspaces/:slug/flows */
export const flowListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(EXHAUSTIVE_LOOKUP_PAGE_SIZE).optional().default(20),
});
export type FlowListQuery = z.infer<typeof flowListQuerySchema>;

/** The `flow_runs.status` domain (06-01) -- reused here for the runs-list filter. */
export const flowRunStatusSchema = z.enum(["waiting", "advancing", "completed", "exited", "ejected"]);
export type FlowRunStatus = z.infer<typeof flowRunStatusSchema>;

/** GET /api/workspaces/:slug/flows/:id/runs -- D-21 run visibility, optional status filter. */
export const flowRunListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(EXHAUSTIVE_LOOKUP_PAGE_SIZE).optional().default(20),
  status: flowRunStatusSchema.optional(),
});
export type FlowRunListQuery = z.infer<typeof flowRunListQuerySchema>;

/**
 * POST /api/workspaces/:slug/flows/:id/runs/eject -- D-21 single (runIds) or
 * bulk (contactIds) eject; at least one non-empty array must be provided.
 */
export const flowRunEjectSchema = z
  .object({
    runIds: z.array(z.string().uuid()).optional(),
    contactIds: z.array(z.string().uuid()).optional(),
  })
  .refine((val) => (val.runIds?.length ?? 0) > 0 || (val.contactIds?.length ?? 0) > 0, {
    message: "At least one of runIds or contactIds must be provided",
  });
export type FlowRunEjectInput = z.infer<typeof flowRunEjectSchema>;
