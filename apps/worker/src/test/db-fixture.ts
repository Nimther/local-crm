import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/db/migrations relative to this file's location -- same depth as
// apps/api/src/test/db-fixture.ts (apps/worker/src/test -> repo root).
const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../packages/db/migrations");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL (or DATABASE_URL, via vitest.config.ts test.env) must be set. " +
      "It must point at a non-superuser Postgres role so Row-Level Security is genuinely " +
      "enforced during tests — see .env.example."
  );
}

let migratedPromise: Promise<void> | null = null;

// Same fixed advisory-lock key convention as apps/api/src/test/db-fixture.ts
// -- both apps' test suites migrate the SAME physical test database, so they
// must serialize on the same lock to avoid a concurrent "column already
// exists" race if both are ever run at once.
const MIGRATION_ADVISORY_LOCK_KEY = 8_472_991;

async function applyPendingMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS _test_migrations_applied (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    mkdirSync(MIGRATIONS_DIR, { recursive: true });
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await client.query<{ exists: boolean }>(
        "SELECT true as exists FROM _test_migrations_applied WHERE filename = $1",
        [file]
      );
      if (rows.length > 0) continue;

      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO _test_migrations_applied (filename) VALUES ($1)", [file]);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    client.release();
  }
}

/** The test database's connection string (non-superuser role). */
export function getTestDatabaseUrl(): string {
  return TEST_DATABASE_URL as string;
}

/**
 * Applies every committed SQL migration (schema + RLS policies) to the test
 * database exactly once per test process, tracked in `_test_migrations_applied`.
 * Mirrors apps/api/src/test/db-fixture.ts exactly (duplicated rather than
 * shared: this is test scaffolding, not the tenant-scoping/upsert logic that
 * 02-06 extracted to @mega-crm/contacts-core / @mega-crm/tenant-context to
 * avoid drift).
 */
export function ensureTestDbMigrated(): Promise<void> {
  if (!migratedPromise) {
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    migratedPromise = applyPendingMigrations(pool).finally(() => pool.end());
  }
  return migratedPromise;
}

/** A fresh pg Pool pointed at the test database. Caller owns its lifecycle (must `.end()`). */
export function createTestPool(): Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
}

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
