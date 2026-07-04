import type { PoolClient } from "pg";

export type ObservedPropertyType = "string" | "number" | "bool" | "date";

const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function inferObservedType(value: unknown): ObservedPropertyType {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "string" && ISO_DATE_RE.test(value)) return "date";
  return "string";
}

/**
 * D-10: registers a custom-property key the first time it's observed, with
 * an inferred type (string/number/bool/date) -- suggestions only for
 * CSV-mapping/segment-builder UIs, never enforced. This is the SINGLE
 * centralized write path (called from contact.repository.ts's
 * createContact/updateContact today; the future events:ingest and
 * imports:csv workers must call this exact function too, per RESEARCH.md's
 * drift-avoidance guidance -- four independent "guess the type"
 * implementations would disagree with each other).
 */
export async function registerObservedProperty(
  client: PoolClient,
  workspaceId: string,
  key: string,
  value: unknown
): Promise<void> {
  const observedType = inferObservedType(value);
  await client.query(
    `INSERT INTO workspace_property_registry (workspace_id, key, observed_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, key) DO NOTHING`,
    [workspaceId, key, observedType]
  );
}
