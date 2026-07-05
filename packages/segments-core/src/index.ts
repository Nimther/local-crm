export type {
  ConditionOperator,
  AttributeCondition,
  BehavioralTimeframe,
  BehavioralCondition,
  SegmentCondition,
  SegmentGroup,
  SegmentDefinition,
  CompiledSegment,
} from "./types.js";

// operators.ts / compile.ts exports land in Task 2 (compileSegmentDefinition
// and friends) -- kept as a forward reference so this barrel is already the
// stable import surface (`@mega-crm/segments-core`) before the compiler
// itself exists.
