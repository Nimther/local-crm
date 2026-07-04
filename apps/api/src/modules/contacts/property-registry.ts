import type { PoolClient } from "pg";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

export type ObservedPropertyType = "string" | "number" | "bool" | "date";

export interface PropertyRegistryRow {
  key: string;
  observedType: ObservedPropertyType;
}

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

/**
 * D-10/D-19: read path for the auto-discovered property registry -- powers
 * the custom-property-editor key autocomplete (02-02) and the future CSV
 * column-mapping "known properties" list (02-07). Read-only, no
 * enforcement -- suggestions only.
 */
export async function listPropertyRegistry(): Promise<PropertyRegistryRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<PropertyRegistryRow>(
      `SELECT key, observed_type as "observedType" FROM workspace_property_registry
       WHERE workspace_id = $1 ORDER BY key ASC`,
      [workspaceId]
    );
    return rows;
  });
}
