import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";

/**
 * D-05: distinct observed event names for the segment builder's behavioral
 * condition picker. Uses a loose-index-scan (skip-scan) recursive CTE over
 * the existing `idx_events_workspace_name_time` index -- NOT a naive
 * `SELECT DISTINCT name FROM events`, which RESEARCH.md's benchmark measured
 * at 5,640ms against 2M events (Pitfall 2) vs this CTE's 3ms for an
 * identical result.
 */
export async function listObservedEventNames(): Promise<string[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<{ name: string }>(
      `WITH RECURSIVE distinct_names AS (
         (SELECT name FROM events WHERE workspace_id = $1 ORDER BY name LIMIT 1)
         UNION ALL
         SELECT (
           SELECT name FROM events
           WHERE workspace_id = $1 AND name > distinct_names.name
           ORDER BY name LIMIT 1
         )
         FROM distinct_names
         WHERE distinct_names.name IS NOT NULL
       )
       SELECT name FROM distinct_names WHERE name IS NOT NULL`,
      [workspaceId]
    );
    return rows.map((r) => r.name);
  });
}
