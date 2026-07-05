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
 * guarantee). D-01: conditions within a group are OR'd, groups are AND'd,
 * every group is always parenthesized (Pitfall 7) so SQL's tighter-binding
 * AND can never silently invert the intended precedence.
 */
export function compileSegmentDefinition(def: SegmentDefinition, workspaceId: string): CompiledSegment {
  const params: unknown[] = [workspaceId];
  const groupClauses = def.groups.map((group) => {
    const conditionClauses = group.conditions.map((cond) => compileCondition(cond, params));
    // OR within group -- always parenthesized, even a single-condition group.
    return `(${conditionClauses.join(" OR ")})`;
  });
  // AND across groups.
  const whereSql = ["c.workspace_id = $1", ...groupClauses].join(" AND ");
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
