import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

// registerObservedProperty/registerObservedProperties now live in
// @mega-crm/contacts-core (extracted in 02-06 so apps/worker's events:ingest
// worker can call the exact same D-10 auto-discovery helper as this app's
// own contact.repository.ts, without duplicating the type-inference logic).
export { registerObservedProperty, type ObservedPropertyType } from "@mega-crm/contacts-core";

export interface PropertyRegistryRow {
  key: string;
  observedType: "string" | "number" | "bool" | "date";
}

/**
 * D-10/D-19: read path for the auto-discovered property registry -- powers
 * the custom-property-editor key autocomplete (02-02) and the future CSV
 * column-mapping "known properties" list (02-07). Read-only, no
 * enforcement -- suggestions only. Stays in apps/api (unlike the write
 * helper) because it needs `getWorkspaceId`/`withTenantTransaction`, which
 * are only meaningful inside a session-authed request's tenant context --
 * apps/worker never calls this read path.
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
