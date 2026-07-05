/**
 * Segment definition tree (SEGM-01/02/03, D-01..D-06). This file is the
 * TypeScript source of truth for the versioned `SegmentDefinition` JSON --
 * `packages/shared-schemas/src/segment.ts`'s Zod schemas mirror these exact
 * shapes at the API boundary. `compileSegmentDefinition` (compile.ts) is the
 * single function that turns this tree into a parameterized SQL WHERE
 * fragment for every consumer (live-preview count, member list, point-check).
 */

/**
 * D-03 operator registry, grouped by property type. Every operator maps to a
 * hard-coded SQL fragment in operators.ts -- never derived from a client
 * string directly (Security Domain / T-03-01).
 */
export type ConditionOperator =
  // string
  | "eq"
  | "neq"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty"
  // number
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  // bool
  | "is_true"
  | "is_false"
  // date
  | "before"
  | "after"
  | "in_last_days"
  // tags
  | "has_tag"
  | "not_has_tag";

/**
 * A profile-attribute condition. `standard` fields resolve through the
 * `STANDARD_FIELD_COLUMNS` allow-list (operators.ts); `custom` fields are
 * property-registry keys read via `properties ->> $N` (key always a bind
 * param, never an interpolated identifier).
 */
export interface AttributeCondition {
  type: "attribute";
  source: "standard" | "custom";
  field: string;
  operator: ConditionOperator;
  value?: unknown;
}

/** D-06: "{event} {at least N times | none} over {last N days | all time}". */
export type BehavioralTimeframe = { kind: "last_days"; days: number } | { kind: "all_time" };

export interface BehavioralCondition {
  type: "behavioral";
  eventName: string;
  countOperator: "at_least" | "none";
  /** Required when countOperator === "at_least" (validated by Zod at the boundary). */
  count?: number;
  timeframe: BehavioralTimeframe;
}

export type SegmentCondition = AttributeCondition | BehavioralCondition;

/** D-01: conditions within a group are OR'd. Always parenthesized (Pitfall 7). */
export interface SegmentGroup {
  conditions: SegmentCondition[]; // min 1, enforced by Zod at the boundary
}

/** D-01: groups are AND'd together. Arbitrary nesting is out of scope (v1). */
export interface SegmentDefinition {
  version: 1;
  groups: SegmentGroup[]; // min 1, enforced by Zod at the boundary
}

/** Output of compileSegmentDefinition -- one parameterized WHERE fragment + its params. */
export interface CompiledSegment {
  whereSql: string;
  params: unknown[];
}
