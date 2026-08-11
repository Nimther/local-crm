import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import { compileSegmentDefinition, type SegmentDefinition } from "@mega-crm/segments-core";
import { FLOW_SEGMENT_SWEEP_FLOW_SCHEMA_VERSION } from "@mega-crm/shared-schemas";
import { createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";
import { insertFixtureOrganization } from "../../../test/failure-fixtures.js";
import type { LiveSegmentFlowRow } from "../../flows/flow-trigger-evaluator.worker.js";
import {
  SWEEP_PAGE_SIZE,
  runFlowSegmentSweepFlowJob,
  sweepOneFlowPage,
} from "../../flows/flow-segment-sweep-flow.worker.js";
import { loadSweepCheckpoint } from "../../flows/flow-segment-sweep-checkpoint.js";

/**
 * Phase 12 (WRK-05/WRK-06, D-09) — the segment sweep's bounded, checkpointed
 * walk must resume exactly where a kill left it, and its cursor must reset
 * on completion rather than persist forever (Pitfall 3: the ONE clause that
 * must NOT be copied from `recipient-snapshot.ts`, whose one-shot
 * `campaigns.snapshot_cursor` freeze is correct for THAT job but would
 * silently and permanently skip a contact for this perpetual one).
 *
 * State-based rather than kill-based (the shape 11-11 established for
 * indistinguishable crash boundaries, `arrangeCrashedBeforeResultWrite`'s
 * own doc comment): a real process kill between page 1's commit and page 2
 * would leave EXACTLY the same durable state this test arranges directly --
 * a committed checkpoint row pointing at page 1's last contact, and no
 * further work done -- so a real-kill harness here would add process
 * machinery (fork, IPC marker, SIGKILL) without adding a single new
 * assertion. The assertions below are entirely on COMMITTED Postgres state,
 * never on process mechanics.
 *
 * Reproduce with `npm run failure:segment-sweep-resume` from the repo root.
 */
describe("failure injection: segment-sweep kill-resume (WRK-05/WRK-06, D-09)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  const VIP_SEGMENT_DEFINITION: SegmentDefinition = {
    version: 1,
    groups: [
      {
        conditions: [{ type: "attribute", source: "custom", field: "tier", operator: "eq", value: "vip" }],
      },
    ],
  };

  async function createFixtureSegment(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture kill-resume segment', $2, 'test-user') RETURNING id`,
          [workspaceId, VIP_SEGMENT_DEFINITION]
        );
        return rows[0].id;
      })
    );
  }

  /** Returns the flow shaped exactly as `sweepOneFlowPage`/`enterSegmentTriggeredFlow` need, so the test can drive a single page directly without going through discovery. */
  async function seedLiveSegmentFlow(workspaceId: string, segmentId: string): Promise<LiveSegmentFlowRow> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const definition: FlowDefinition = {
          nodes: [
            { id: "trigger-1", type: "trigger", triggerType: "segment", segmentId, position: { x: 0, y: 0 } },
            { id: "exit-1", type: "exit", position: { x: 0, y: 100 } },
          ],
          edges: [{ id: "e1", source: "trigger-1", target: "exit-1" }],
        };

        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_segment_id, reentry_mode, created_by_user_id)
           VALUES ($1, 'Fixture kill-resume flow', 'live', 'segment', $2, 'every_time', 'test-user')
           RETURNING id`,
          [workspaceId, segmentId]
        );
        const flowId = flowRows[0].id;

        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now()) RETURNING id`,
          [workspaceId, flowId, definition]
        );
        await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowId, versionRows[0].id]);

        return {
          id: flowId,
          liveVersionId: versionRows[0].id,
          triggerSegmentId: segmentId,
          reentryMode: "every_time",
          reentryWindowDays: null,
        };
      })
    );
  }

  /** One INSERT...SELECT round trip for `count` VIP-tier contacts -- fast enough to seed several pages' worth without hundreds of individual INSERTs. */
  async function seedManyVipContacts(workspaceId: string, count: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status, properties)
           SELECT $1,
                  'bulk-' || gs || '-' || substr(gen_random_uuid()::text, 1, 8) || '@fixture.test',
                  'Fixture', 'subscribed', '{"tier":"vip"}'::jsonb
           FROM generate_series(1, $2) AS gs`,
          [workspaceId, count]
        )
      )
    );
  }

  async function flowRunsCountFor(workspaceId: string, flowId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2`,
          [workspaceId, flowId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function runsForContact(workspaceId: string, flowId: string, contactId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3`,
          [workspaceId, flowId, contactId]
        );
        return Number(rows[0].count);
      })
    );
  }

  it(
    "resumes from the committed checkpoint after a simulated interruption, without reprocessing already-committed contacts, and clears the cursor on completion",
    async () => {
      const workspaceId = await freshWorkspaceId("segment-sweep-kill-resume");
      const segmentId = await createFixtureSegment(workspaceId);
      const flow = await seedLiveSegmentFlow(workspaceId, segmentId);

      // At least two pages' worth (SWEEP_PAGE_SIZE=500 today) -- the walk
      // MUST need a second page for "interrupted after page 1" to mean
      // anything.
      const totalContacts = SWEEP_PAGE_SIZE + 200;
      await seedManyVipContacts(workspaceId, totalContacts);

      const { whereSql, params } = compileSegmentDefinition(VIP_SEGMENT_DEFINITION, workspaceId);

      // --- simulate a kill strictly between page 1's commit and page 2 ----
      // A real process kill here would leave IDENTICAL durable state: one
      // committed page, one committed checkpoint row, nothing further done.
      const firstPage = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => sweepOneFlowPage(client, workspaceId, flow, whereSql, params, null))
      );
      expect(firstPage.processed).toBe(SWEEP_PAGE_SIZE);
      expect(firstPage.lastContactId).not.toBeNull();

      const checkpointAfterInterruption = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => loadSweepCheckpoint(client, workspaceId, flow.id))
      );
      expect(
        checkpointAfterInterruption,
        "the committed page's cursor must survive the simulated crash -- it was committed in the SAME transaction as the page's enrollment writes (D-09)",
      ).toBe(firstPage.lastContactId);

      const runsAfterFirstPage = await flowRunsCountFor(workspaceId, flow.id);
      expect(runsAfterFirstPage, "exactly one page's worth of contacts were enrolled before the interruption").toBe(
        SWEEP_PAGE_SIZE,
      );

      // --- resume: the next job for this flow re-reads the checkpoint -----
      await runFlowSegmentSweepFlowJob({
        schemaVersion: FLOW_SEGMENT_SWEEP_FLOW_SCHEMA_VERSION,
        workspaceId,
        flowId: flow.id,
      });

      // Resuming must enroll ONLY the contacts beyond the committed cursor.
      // Total enrolled count is exactly the seeded total -- never more (no
      // duplicate re-entry for the already-committed first page, since the
      // resumed walk's cursor strictly excludes it by construction) and
      // never less (the remainder was not skipped).
      const runsAfterResume = await flowRunsCountFor(workspaceId, flow.id);
      expect(
        runsAfterResume,
        "resuming from the checkpoint enrolls the remainder exactly once -- no gap, no duplicate",
      ).toBe(totalContacts);

      // The resumed walk reached the end of the matching set (a page
      // returning 0 rows) -- the cursor must be CLEARED, not left pointing
      // at the last contact.
      const checkpointAfterCompletion = await withTenant(workspaceId, () =>
        withTenantTransaction((client) => loadSweepCheckpoint(client, workspaceId, flow.id))
      );
      expect(
        checkpointAfterCompletion,
        "a completed walk resets its cursor rather than persisting it (D-09/Pitfall 3)",
      ).toBeNull();

      // --- the reset matters: prove a contact BEHIND the old cursor ------
      // position is not permanently skipped. A hand-crafted low UUID sorts
      // before every contact id created above (random v4 UUIDs) -- this is
      // the assertion that fails if a future change makes the cursor
      // permanent instead of resetting.
      const behindCursorContactId = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO contacts (id, workspace_id, email, first_name, subscription_status, properties)
             VALUES ('00000000-0000-4000-8000-000000000001', $1, 'behind-cursor@fixture.test', 'Fixture', 'subscribed', '{"tier":"vip"}'::jsonb)
             RETURNING id`,
            [workspaceId]
          );
          return rows[0].id;
        })
      );

      await runFlowSegmentSweepFlowJob({
        schemaVersion: FLOW_SEGMENT_SWEEP_FLOW_SCHEMA_VERSION,
        workspaceId,
        flowId: flow.id,
      });

      expect(
        await runsForContact(workspaceId, flow.id, behindCursorContactId),
        "a contact inserted behind the OLD (now-cleared) cursor position must be enrolled by the next full walk -- a permanent cursor would silently and forever skip it",
      ).toBe(1);
    },
    60_000,
  );
});
