import { STANDARD_FIELD_COLUMNS, compileOperator } from "./operators.js";
import type {
  AttributeCondition,
  BehavioralCondition,
  CompiledSegment,
  SegmentCondition,
  SegmentDefinition,
} from "./types.js";

/**
 * The single source every count/list/point-check call mode compiles a
 * SegmentDefinition through (SEGM-03's structural "identical membership"
 * guarantee). D-01 as amended: conditions within a group are OR'd, groups are
 * combined by the user-selected `def.groupCombinator` (one combinator for the
 * whole definition, default "and"), and every group is always parenthesized
 * (Pitfall 7) so SQL's tighter-binding AND can never silently invert the
 * intended precedence.
 *
 * CMP-04 (plan 13-10, Task 3): `c.anonymized_at IS NULL` is baked into the
 * base predicate here rather than patched into every call site -- every
 * count/list/point-check caller across BOTH apps compiles through THIS one
 * function (segment count/list/point-check, campaign audience
 * materialization via `recipient-snapshot.ts`, flow event/segment-trigger
 * evaluation, branch-node/exit-condition point-checks, enroll-existing,
 * segment-sweep), so fixing it here is what makes "an erased person is
 * never counted as a live contact or targeted for a send" hold everywhere
 * this engine is used, not just in the one or two paths a manual audit
 * happened to visit.
 */
export function compileSegmentDefinition(def: SegmentDefinition, workspaceId: string): CompiledSegment {
  const params: unknown[] = [workspaceId];
  const groupClauses = def.groups.map((group) => {
    const conditionClauses = group.conditions.map((cond) => compileCondition(cond, params));
    // OR within group -- always parenthesized, even a single-condition group.
    return `(${conditionClauses.join(" OR ")})`;
  });
  // User-selected combinator ACROSS groups. The `?? "and"` default is applied
  // HERE, not only at the Zod boundary: the workers (recipient-snapshot,
  // branch-node, exit-conditions, segment-sweep, enroll-existing) read
  // `segments.definition` straight out of jsonb without a Zod re-parse, so a
  // schema-level `.default()` never reaches already-persisted rows.
  const combinator = def.groupCombinator ?? "and";
  // SECURITY-CRITICAL (CMP-04): `c.workspace_id = $1` and
  // `c.anonymized_at IS NULL` must NEVER end up inside the OR. SQL binds AND
  // tighter than OR, so joining a bare `... OR (g1) OR (g2)` onto them would
  // read as `(ws AND anon) OR g1 OR g2` -- a contact of ANY workspace matching
  // g1 would pass, and anonymized_at would be bypassed, across all 8+
  // membership-evaluation call sites at once. So the OR'd groups get their own
  // enclosing paren and the base predicates are AND'ed on from OUTSIDE it.
  //
  // The extra paren is CONDITIONAL, and deliberately so: the "field absent",
  // "explicit and" and "single group" paths must stay byte-for-byte identical
  // to the pre-combinator output, or every existing segment's membership
  // shifts on deploy. A single group has nothing to combine either way.
  const grouped =
    combinator === "or" && groupClauses.length > 1 ? [`(${groupClauses.join(" OR ")})`] : groupClauses;
  const whereSql = ["c.workspace_id = $1", "c.anonymized_at IS NULL", ...grouped].join(" AND ");
  return { whereSql, params };
}

function compileCondition(cond: SegmentCondition, params: unknown[]): string {
  if (cond.type === "attribute") {
    return compileAttributeCondition(cond, params);
  }
  return compileBehavioralCondition(cond, params);
}

/**
 * `standard` fields resolve through the STANDARD_FIELD_COLUMNS allow-list
 * (throws on unknown field -- fails closed, T-03-01). `custom` fields are
 * NEVER interpolated as a raw identifier -- the property-registry key is
 * itself pushed as a bind param via `properties ->> $N`, so only a
 * parameterized value ever reaches SQL, never a client-controlled column
 * name.
 */
function compileAttributeCondition(cond: AttributeCondition, params: unknown[]): string {
  let column: string;
  if (cond.source === "standard") {
    const mapped = STANDARD_FIELD_COLUMNS[cond.field];
    if (!mapped) {
      throw new Error(`Unknown standard field: ${cond.field}`);
    }
    column = mapped;
  } else {
    params.push(cond.field);
    column = `c.properties ->> $${params.length}`;
  }
  return compileOperator(column, cond.operator, cond.value, params);
}

/**
 * D-02/D-06: "{event} {at least N times | none} over {last N days | all
 * time}". countOperator "none" negates to NOT EXISTS; "at_least" with
 * count > 1 adds a GROUP BY/HAVING count(*) >= N clause so N>1 is honored
 * rather than silently treated as >=1.
 */
function compileBehavioralCondition(cond: BehavioralCondition, params: unknown[]): string {
  const negate = cond.countOperator === "none";

  params.push(cond.eventName);
  const eventNameParam = params.length;

  let timeClause = "";
  if (cond.timeframe.kind === "last_days") {
    params.push(cond.timeframe.days);
    timeClause = ` AND e.occurred_at >= now() - ($${params.length} || ' days')::interval`;
  }

  let havingClause = "";
  const requiredCount = cond.count ?? 1;
  if (!negate && requiredCount > 1) {
    params.push(requiredCount);
    havingClause = ` GROUP BY e.contact_id HAVING count(*) >= $${params.length}`;
  }

  const sub = `SELECT 1 FROM events e WHERE e.workspace_id = c.workspace_id AND e.contact_id = c.id AND e.name = $${eventNameParam}${timeClause}${havingClause}`;
  return `${negate ? "NOT " : ""}EXISTS (${sub})`;
}
