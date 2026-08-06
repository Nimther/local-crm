// 08-06 (D-13): the migration runner, advisory lock, tracking-table DDL and
// DSN resolution that used to live here are now in @mega-crm/test-support.
// Only this workspace's own fixture helper stays. Kept as a shim rather than
// rewriting every import site: a mass import rewrite in the same change as the
// dev-DB fallback removal would make a regression impossible to bisect.
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";

export { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";

export interface FixtureFlowTriplet {
  flowId: string;
  flowVersionId: string;
  flowRunId: string;
  nodeId: string;
}

/**
 * Seeds a minimal `flows` / `flow_versions` / `flow_runs` triplet with a
 * single `send` node (06-03, FLOW-01/FLOW-07) -- the exact shape
 * `apps/worker/src/queues/flows/flow-send.ts`'s `readFlowSendPrereqs` reads
 * (join `flow_runs.flow_version_id` -> `flow_versions.definition`, find the
 * node by id). Lives here (not per-test-file, unlike
 * `send-dispatch-idempotency.test.ts`'s locally-defined
 * `createFixtureCampaign`) because every flow-engine test file added later
 * in this phase (06-04's publish routes, 06-05's run-advance worker, 06-06's
 * reconciliation/sweep workers) needs the SAME triplet shape -- centralizing
 * it here avoids five near-identical copies drifting apart.
 *
 * All three inserts run inside ONE `withTenant`/`withTenantTransaction`
 * scope (RLS ENABLE+FORCE on all three tables, 06-01) and `flows.status` is
 * `'live'` with `live_version_id` pointing at the just-created version --
 * `flow_runs.flow_version_id` is the pin `readFlowSendPrereqs` actually
 * reads, so this is the field that matters for dispatch; `live_version_id`
 * is set only for shape-completeness (a flow's own CRUD/publish routes are
 * out of this plan's scope, 06-04).
 */
export async function createFixtureFlowRun(
  workspaceId: string,
  contactId: string,
  overrides: { templateId?: string | null; fromEmail?: string | null; nodeId?: string } = {}
): Promise<FixtureFlowTriplet> {
  const nodeId = overrides.nodeId ?? "send-1";
  const templateId = overrides.templateId === undefined ? "d-fixture-template" : overrides.templateId;
  const fromEmail = overrides.fromEmail === undefined ? "sender@fixture.test" : overrides.fromEmail;

  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { rows: flowRows } = await client.query<{ id: string }>(
        `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
         VALUES ($1, 'Fixture flow', 'live', 'event', 'fixture_event', 'test-user')
         RETURNING id`,
        [workspaceId]
      );
      const flowId = flowRows[0].id;

      const definition: FlowDefinition = {
        nodes: [
          {
            id: "trigger-1",
            type: "trigger",
            triggerType: "event",
            eventName: "fixture_event",
            position: { x: 0, y: 0 },
          },
          {
            id: nodeId,
            type: "send",
            ...(templateId !== null ? { templateId } : {}),
            ...(fromEmail !== null ? { fromEmail } : {}),
            position: { x: 0, y: 100 },
          },
        ],
        edges: [{ id: "e1", source: "trigger-1", target: nodeId }],
      };

      const { rows: versionRows } = await client.query<{ id: string }>(
        `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
         VALUES ($1, $2, 1, $3, now())
         RETURNING id`,
        [workspaceId, flowId, definition]
      );
      const flowVersionId = versionRows[0].id;

      await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowId, flowVersionId]);

      const { rows: runRows } = await client.query<{ id: string }>(
        `INSERT INTO flow_runs (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id)
         VALUES ($1, $2, $3, $4, 'advancing', $5)
         RETURNING id`,
        [workspaceId, flowId, flowVersionId, contactId, nodeId]
      );
      const flowRunId = runRows[0].id;

      return { flowId, flowVersionId, flowRunId, nodeId };
    })
  );
}
