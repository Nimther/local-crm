import { z } from "zod";

/**
 * D-03 operator registry -- string/number/bool/date/tag operators, including
 * D-02's first-class negations. Exactly 16 operators; no more, no fewer (see
 * packages/segments-core/src/types.ts's ConditionOperator, which this schema
 * mirrors).
 */
export const conditionOperatorSchema = z.enum([
  // string
  "eq",
  "neq",
  "contains",
  "not_contains",
  "is_empty",
  "is_not_empty",
  // number
  "gt",
  "gte",
  "lt",
  "lte",
  // bool
  "is_true",
  "is_false",
  // date
  "before",
  "after",
  "in_last_days",
  // tags
  "has_tag",
  "not_has_tag",
]);
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>;

/**
 * A profile-attribute condition (SEGM-01). `standard` fields are validated
 * against the segments-core `STANDARD_FIELD_COLUMNS` allow-list at compile
 * time (fails closed on unknown field); `custom` fields are property-registry
 * keys (D-03).
 */
export const attributeConditionSchema = z.object({
  type: z.literal("attribute"),
  source: z.enum(["standard", "custom"]),
  field: z.string(),
  operator: conditionOperatorSchema,
  value: z.unknown().optional(),
});
export type AttributeCondition = z.infer<typeof attributeConditionSchema>;

/** A behavioral condition (SEGM-02) -- D-02/D-06 count + timeframe + negation. */
export const behavioralConditionSchema = z.object({
  type: z.literal("behavioral"),
  eventName: z.string().min(1),
  countOperator: z.enum(["at_least", "none"]),
  count: z.number().int().min(1).optional(),
  timeframe: z.union([
    z.object({ kind: z.literal("last_days"), days: z.number().int().min(1) }),
    z.object({ kind: z.literal("all_time") }),
  ]),
});
export type BehavioralCondition = z.infer<typeof behavioralConditionSchema>;

export const segmentConditionSchema = z.discriminatedUnion("type", [
  attributeConditionSchema,
  behavioralConditionSchema,
]);
export type SegmentCondition = z.infer<typeof segmentConditionSchema>;

/** D-01: conditions within a group are OR'd -- min 1 condition. */
export const segmentGroupSchema = z.object({
  conditions: z.array(segmentConditionSchema).min(1),
});
export type SegmentGroup = z.infer<typeof segmentGroupSchema>;

/**
 * Versioned segment definition (SEGM-01/02/03). D-01: groups are AND'd
 * together; arbitrary group nesting is out of scope (v1).
 */
export const segmentDefinitionSchema = z.object({
  version: z.literal(1),
  groups: z.array(segmentGroupSchema).min(1),
});
export type SegmentDefinition = z.infer<typeof segmentDefinitionSchema>;

/** POST /api/workspaces/:slug/segments */
export const createSegmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  definition: segmentDefinitionSchema,
});
export type CreateSegmentInput = z.infer<typeof createSegmentSchema>;

/**
 * PATCH /api/workspaces/:slug/segments/:id -- D-14: rename or redefine, both
 * optional so either can be updated independently. D-13: redefining a segment
 * changes its membership everywhere it's referenced (dynamic, no snapshots).
 */
export const updateSegmentSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  definition: segmentDefinitionSchema.optional(),
});
export type UpdateSegmentInput = z.infer<typeof updateSegmentSchema>;

/** GET /api/workspaces/:slug/segments -- D-10/D-11 segment list page. */
export const segmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type SegmentListQuery = z.infer<typeof segmentListQuerySchema>;

/** GET /api/workspaces/:slug/segments/:id/members -- D-12 paginated member list. */
export const segmentMembersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type SegmentMembersQuery = z.infer<typeof segmentMembersQuerySchema>;

/**
 * D-11: name, last-computed member count + timestamp, created/updated,
 * author. `memberCount`/`memberCountAt` are nullable until the first count
 * computation lands (engine-owned freshness policy, see 03-02).
 */
export const segmentResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  definition: segmentDefinitionSchema,
  createdByUserId: z.string().nullable(),
  memberCount: z.number().nullable(),
  memberCountAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SegmentResponse = z.infer<typeof segmentResponseSchema>;

export const segmentListResponseSchema = z.object({
  items: z.array(segmentResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type SegmentListResponse = z.infer<typeof segmentListResponseSchema>;

/**
 * POST /api/workspaces/:slug/segments/preview-count (SEGM-04) -- live-preview
 * count body. Not a persisted resource, just the definition to evaluate.
 */
export const previewCountSchema = z.object({
  definition: segmentDefinitionSchema,
});
export type PreviewCountInput = z.infer<typeof previewCountSchema>;
