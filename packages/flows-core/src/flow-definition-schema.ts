import { z } from "zod";

/**
 * The flow-definition Zod schema (FLOW-01) -- the single node/edge model
 * shared by the canvas (instant client-side feedback) and the server
 * (authority, re-validated at publish time by validateFlowDefinition in
 * flow-validate.ts). Mirrors segments-core's SegmentDefinition pattern: one
 * schema, imported by both sides of the trust boundary, never reimplemented.
 *
 * Five node types (06-UI-SPEC Canvas & Node Visual Language): trigger,
 * delay, branch, send, exit. This file is pure data shape -- it does NOT
 * import pg / withTenant / any DB module (T-06-02-02, T-06-02-01).
 */

/** Free-form 2D canvas placement -- not a layout-spacing value (06-UI-SPEC). */
export const flowNodePositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});
export type FlowNodePosition = z.infer<typeof flowNodePositionSchema>;

/**
 * D-13: a branch has exactly two logical outgoing paths (yes/no), expressed
 * via each outgoing edge's `sourceHandle` rather than a fixed node field --
 * see flowEdgeSchema below.
 */
export const flowTriggerNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("trigger"),
  triggerType: z.enum(["event", "segment"]),
  eventName: z.string().min(1).optional(),
  segmentId: z.string().uuid().optional(),
  position: flowNodePositionSchema,
});
export type FlowTriggerNode = z.infer<typeof flowTriggerNodeSchema>;

/** Delay-node kinds: a fixed duration wait, or a wait-until-time-of-day wait. */
export const flowDelayFixedSchema = z.object({
  kind: z.literal("fixed"),
  amount: z.number().int().positive(),
  unit: z.enum(["minutes", "hours", "days"]),
});
export type FlowDelayFixed = z.infer<typeof flowDelayFixedSchema>;

export const flowDelayWaitUntilSchema = z.object({
  kind: z.literal("wait_until"),
  /** Minutes since local midnight (0-1439). */
  timeOfDay: z.number().int().min(0).max(1439),
  /** 0 (Sunday) - 6 (Saturday); absent means "any day". */
  dayOfWeek: z.number().int().min(0).max(6).optional(),
});
export type FlowDelayWaitUntil = z.infer<typeof flowDelayWaitUntilSchema>;

export const flowDelaySchema = z.discriminatedUnion("kind", [flowDelayFixedSchema, flowDelayWaitUntilSchema]);
export type FlowDelay = z.infer<typeof flowDelaySchema>;

export const flowDelayNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("delay"),
  delay: flowDelaySchema,
  position: flowNodePositionSchema,
});
export type FlowDelayNode = z.infer<typeof flowDelayNodeSchema>;

/** D-13: binary yes/no branch, evaluated against a segment membership check. */
export const flowBranchNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("branch"),
  segmentId: z.string().uuid(),
  position: flowNodePositionSchema,
});
export type FlowBranchNode = z.infer<typeof flowBranchNodeSchema>;

/** A send node needs a templateId + a verified sender to be publish-ready. */
export const flowSendNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("send"),
  templateId: z.string().min(1).optional(),
  fromSenderId: z.string().min(1).optional(),
  fromEmail: z.string().email().optional(),
  position: flowNodePositionSchema,
});
export type FlowSendNode = z.infer<typeof flowSendNodeSchema>;

export const flowExitNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal("exit"),
  position: flowNodePositionSchema,
});
export type FlowExitNode = z.infer<typeof flowExitNodeSchema>;

export const flowNodeSchema = z.discriminatedUnion("type", [
  flowTriggerNodeSchema,
  flowDelayNodeSchema,
  flowBranchNodeSchema,
  flowSendNodeSchema,
  flowExitNodeSchema,
]);
export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowNodeType = FlowNode["type"];

/**
 * D-13: a branch node's two outgoing edges are distinguished by
 * `sourceHandle` ("yes" | "no"); every other node type has at most one
 * outgoing edge and omits `sourceHandle`.
 */
export const flowEdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.enum(["yes", "no"]).optional(),
});
export type FlowEdge = z.infer<typeof flowEdgeSchema>;

/** The full flow definition: node/edge JSON persisted on a flow_version row. */
export const flowDefinitionSchema = z.object({
  nodes: z.array(flowNodeSchema),
  edges: z.array(flowEdgeSchema),
});
export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;
