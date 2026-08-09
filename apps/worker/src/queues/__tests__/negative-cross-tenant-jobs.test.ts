import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withCrossWorkspaceScan, withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { dispatchSendGate } from "@mega-crm/delivery-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool, createFixtureFlowRun } from "../../test/db-fixture.js";
import { insertFixtureOrganization, createFixtureCampaign, createFixtureContact, connectFixtureSendgridKey } from "../../test/failure-fixtures.js";

import { processEventIngestJob } from "../events-ingest.worker.js";
import { processImportsCsvJob } from "../imports-csv.worker.js";
import { processSendJob } from "../send-dispatch.js";
import { processCampaignKickoffJob } from "../campaign-kickoff.worker.js";
import { reconcileWorkspaceDay } from "../analytics-reconciliation.worker.js";
import { processFlowRunAdvance } from "../flows/flow-run-advance.worker.js";
import { findDueFlowRunCandidates, transitionAndNudge } from "../flows/flow-reconciliation.worker.js";
import { processFlowTriggerCheck } from "../flows/flow-trigger-evaluator.worker.js";
import { runFlowSegmentSweepTick } from "../flows/flow-segment-sweep.worker.js";
import { processFlowEnrollExisting } from "../flows/flow-enroll-existing.worker.js";
import { findReconcilableCandidates, resolveOneSend } from "../send-reconciler.worker.js";

/**
 * SEC-16 (background-job half), SPEC R2: this is the counterpart to
 * `apps/api/src/__tests__/negative-cross-tenant.test.ts` for
 * `apps/worker`. Background jobs take a workspace id (and other resource
 * ids) as DATA, not as an authenticated caller identity -- a hostile job
 * payload (a workspace id that does not own the referenced rows, or a
 * resource id belonging to a sibling workspace) is the internal analogue of
 * a crafted HTTP request. Every case here drives an EXPORTED job handler
 * directly (mirrors the existing convention throughout this codebase --
 * `webhook-events-sibling-drop.test.ts`, `campaign-scheduler-scan.test.ts`)
 * and reads BOTH workspaces' resulting state afterwards under their own
 * tenant scopes, so "nothing happened to the wrong workspace" is verified
 * rather than inferred from an absence of a thrown error.
 *
 * "each background-job family" (SPEC's phrasing, not "each worker file"): a
 * family may span several files (`processSendJob` is shared verbatim by
 * `email-broadcast.worker.ts` and `email-triggered.worker.ts`) or may already
 * have a dedicated attempted-access proof in another file
 * (`campaign-scheduler-scan.test.ts`, `webhook-events-sibling-drop.test.ts`)
 * -- the coverage assertion at the bottom of this file accounts for both
 * shapes explicitly, with a one-line reason recorded for each.
 */
describe("Negative cross-tenant suite: background-job families (SEC-16)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function insertContact(
    workspaceId: string,
    overrides: { email?: string; externalId?: string; country?: string } = {}
  ): Promise<string> {
    const email = overrides.email ?? `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, external_id, country, subscription_status)
           VALUES ($1, $2, $3, $4, 'subscribed') RETURNING id`,
          [workspaceId, email, overrides.externalId ?? null, overrides.country ?? null]
        );
        return rows[0].id;
      })
    );
  }

  // -------------------------------------------------------------------
  // Test 1: job families that take a workspace id from job.data -- a job
  // naming workspace B whose referenced rows belong to workspace A produces
  // no cross-workspace effect.
  // -------------------------------------------------------------------

  describe("events:ingest (processEventIngestJob)", () => {
    it("a job naming workspace B with an externalId collision against workspace A's contact affects only workspace B", async () => {
      const workspaceA = await freshWorkspaceId("jobs-events-a");
      const workspaceB = await freshWorkspaceId("jobs-events-b");
      const sharedExternalId = `shared-ext-${randomUUID()}`;
      await insertContact(workspaceA, { externalId: sharedExternalId });

      await processEventIngestJob({
        workspaceId: workspaceB,
        eventId: randomUUID(),
        occurredAt: new Date().toISOString(),
        name: "negative_suite_event",
        properties: {},
        externalId: sharedExternalId,
      });

      const aEventCount = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text as count FROM events WHERE workspace_id = $1`, [
            workspaceA,
          ]);
          return Number(rows[0].count);
        })
      );
      expect(aEventCount).toBe(0);

      const bContactCount = await withTenant(workspaceB, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text as count FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
            [workspaceB, sharedExternalId]
          );
          return Number(rows[0].count);
        })
      );
      expect(bContactCount).toBe(1);
    });
  });

  describe("imports:csv (processImportsCsvJob)", () => {
    it("a job naming workspace B with workspace A's csvImportId is a no-op -- workspace A's import row is unchanged", async () => {
      const workspaceA = await freshWorkspaceId("jobs-csv-a");
      const workspaceB = await freshWorkspaceId("jobs-csv-b");

      const csvImportId = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO csv_imports (workspace_id, file_name, created_by_user_id) VALUES ($1, 'fixture.csv', 'test-user') RETURNING id`,
            [workspaceA]
          );
          return rows[0].id;
        })
      );

      await processImportsCsvJob({ workspaceId: workspaceB, csvImportId });

      const statusAfter = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ status: string }>(`SELECT status FROM csv_imports WHERE id = $1`, [csvImportId]);
          return rows[0]?.status;
        })
      );
      expect(statusAfter).toBe("uploaded"); // default status, untouched by the hostile job
    });
  });

  describe("email-broadcast / email-triggered (processSendJob, shared by both queues)", () => {
    it("a campaign-kind job naming workspace B with workspace A's campaignId/contactId is denied by the tenant-scoped lookup -- no send row is created anywhere", async () => {
      const workspaceA = await freshWorkspaceId("jobs-send-a");
      const workspaceB = await freshWorkspaceId("jobs-send-b");
      await connectFixtureSendgridKey(workspaceB); // so the failure is the campaign lookup, not a missing key

      const campaignAId = await createFixtureCampaign(workspaceA);
      const contactAId = await createFixtureContact(workspaceA);

      await expect(
        processSendJob({
          workspaceId: workspaceB,
          campaignId: campaignAId,
          kind: "campaign",
          contactId: contactAId,
        })
      ).rejects.toThrow();

      const sendCountA = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text as count FROM sends WHERE workspace_id = $1`, [
            workspaceA,
          ]);
          return Number(rows[0].count);
        })
      );
      const sendCountB = await withTenant(workspaceB, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text as count FROM sends WHERE workspace_id = $1`, [
            workspaceB,
          ]);
          return Number(rows[0].count);
        })
      );
      expect(sendCountA).toBe(0);
      expect(sendCountB).toBe(0);
    });

    it("a flow-kind job naming workspace B with workspace A's flowRunId is denied by the tenant-scoped lookup -- no send row is created anywhere", async () => {
      const workspaceA = await freshWorkspaceId("jobs-send-flow-a");
      const workspaceB = await freshWorkspaceId("jobs-send-flow-b");
      const contactAId = await createFixtureContact(workspaceA);
      const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceA, contactAId);

      await expect(
        processSendJob({
          workspaceId: workspaceB,
          kind: "flow",
          flowRunId,
          nodeId,
          contactId: contactAId,
        })
      ).rejects.toThrow();

      const sendCountEither = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text as count FROM sends`, []);
          return Number(rows[0].count);
        })
      );
      expect(sendCountEither).toBe(0);
    });
  });

  describe("campaign-kickoff (processCampaignKickoffJob)", () => {
    it("a job naming workspace B with workspace A's campaignId is a no-op -- workspace A's campaign is unchanged and no sends are enqueued", async () => {
      const workspaceA = await freshWorkspaceId("jobs-kickoff-a");
      const workspaceB = await freshWorkspaceId("jobs-kickoff-b");
      const campaignAId = await createFixtureCampaign(workspaceA);

      const before = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ fanOutComplete: boolean; status: string }>(
            `SELECT fan_out_complete as "fanOutComplete", status FROM campaigns WHERE id = $1`,
            [campaignAId]
          );
          return rows[0];
        })
      );

      await processCampaignKickoffJob({ workspaceId: workspaceB, campaignId: campaignAId });

      const after = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ fanOutComplete: boolean; status: string }>(
            `SELECT fan_out_complete as "fanOutComplete", status FROM campaigns WHERE id = $1`,
            [campaignAId]
          );
          return rows[0];
        })
      );
      expect(after).toEqual(before);

      const sendCountA = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text as count FROM sends WHERE workspace_id = $1`, [
            workspaceA,
          ]);
          return Number(rows[0].count);
        })
      );
      expect(sendCountA).toBe(0);
    });
  });

  describe("flow-run-advance (processFlowRunAdvance)", () => {
    it("a job naming workspace B with workspace A's flowRunId is a no-op -- workspace A's run is unchanged", async () => {
      const workspaceA = await freshWorkspaceId("jobs-advance-a");
      const workspaceB = await freshWorkspaceId("jobs-advance-b");
      const contactAId = await createFixtureContact(workspaceA);
      const { flowRunId } = await createFixtureFlowRun(workspaceA, contactAId);

      const before = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ status: string; currentNodeId: string | null }>(
            `SELECT status, current_node_id as "currentNodeId" FROM flow_runs WHERE id = $1`,
            [flowRunId]
          );
          return rows[0];
        })
      );

      await processFlowRunAdvance({ workspaceId: workspaceB, flowRunId });

      const after = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ status: string; currentNodeId: string | null }>(
            `SELECT status, current_node_id as "currentNodeId" FROM flow_runs WHERE id = $1`,
            [flowRunId]
          );
          return rows[0];
        })
      );
      expect(after).toEqual(before);
    });
  });

  describe("flow-trigger-evaluator (processFlowTriggerCheck)", () => {
    async function seedLiveEventFlow(workspaceId: string, eventName: string): Promise<string> {
      return withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows: flowRows } = await client.query<{ id: string }>(
            `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
             VALUES ($1, 'Negative-suite trigger flow', 'live', 'event', $2, 'test-user') RETURNING id`,
            [workspaceId, eventName]
          );
          const flowId = flowRows[0].id;
          const { rows: versionRows } = await client.query<{ id: string }>(
            `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
             VALUES ($1, $2, 1, $3, now()) RETURNING id`,
            [
              workspaceId,
              flowId,
              {
                nodes: [
                  { id: "trigger-1", type: "trigger", triggerType: "event", eventName, position: { x: 0, y: 0 } },
                  { id: "exit-1", type: "exit", position: { x: 0, y: 100 } },
                ],
                edges: [{ id: "e1", source: "trigger-1", target: "exit-1" }],
              },
            ]
          );
          await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowId, versionRows[0].id]);
          return flowId;
        })
      );
    }

    it("a job naming workspace B with workspace A's contactId creates no flow_runs row anywhere and workspace A's flow_runs are unaffected", async () => {
      const workspaceA = await freshWorkspaceId("jobs-trigger-a");
      const workspaceB = await freshWorkspaceId("jobs-trigger-b");
      const contactAId = await createFixtureContact(workspaceA);
      const eventName = `negative_suite_trigger_${randomUUID()}`;
      await seedLiveEventFlow(workspaceB, eventName);

      const beforeA = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text as count FROM flow_runs WHERE workspace_id = $1`, [
            workspaceA,
          ]);
          return Number(rows[0].count);
        })
      );

      // Denied either by an outright throw (a cross-workspace FK/RLS
      // violation) or by a graceful no-op -- either is an acceptable "denied"
      // outcome; what must NOT happen is a flow_runs row appearing in
      // workspace B that references workspace A's contact.
      await processFlowTriggerCheck({ workspaceId: workspaceB, contactId: contactAId, eventName }).catch(() => undefined);

      const afterA = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(`SELECT count(*)::text as count FROM flow_runs WHERE workspace_id = $1`, [
            workspaceA,
          ]);
          return Number(rows[0].count);
        })
      );
      expect(afterA).toBe(beforeA);

      const crossRunCount = await withTenant(workspaceB, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text as count FROM flow_runs WHERE workspace_id = $1 AND contact_id = $2`,
            [workspaceB, contactAId]
          );
          return Number(rows[0].count);
        })
      );
      expect(crossRunCount).toBe(0);
    });
  });

  describe("flow-enroll-existing (processFlowEnrollExisting)", () => {
    it("a job naming workspace B with workspace A's flowId is a no-op -- workspace A's flow enroll_cursor and snapshot are unchanged", async () => {
      const workspaceA = await freshWorkspaceId("jobs-enroll-a");
      const workspaceB = await freshWorkspaceId("jobs-enroll-b");

      const flowAId = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows: segmentRows } = await client.query<{ id: string }>(
            `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
             VALUES ($1, 'Negative-suite enroll segment', $2, 'test-user') RETURNING id`,
            [workspaceA, { version: 1, groups: [{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] }] }]
          );
          const { rows: flowRows } = await client.query<{ id: string }>(
            `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_segment_id, created_by_user_id)
             VALUES ($1, 'Negative-suite enroll flow', 'live', 'segment', $2, 'test-user') RETURNING id`,
            [workspaceA, segmentRows[0].id]
          );
          const { rows: versionRows } = await client.query<{ id: string }>(
            `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
             VALUES ($1, $2, 1, $3, now()) RETURNING id`,
            [workspaceA, flowRows[0].id, { nodes: [{ id: "t1", type: "trigger", triggerType: "segment", position: { x: 0, y: 0 } }], edges: [] }]
          );
          await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowRows[0].id, versionRows[0].id]);
          return flowRows[0].id;
        })
      );

      await insertContact(workspaceA, { country: "RU" });

      await processFlowEnrollExisting({
        workspaceId: workspaceB,
        flowId: flowAId,
        flowVersionId: randomUUID(), // unused by the no-op path below -- the schema requires it, loadFlow(workspaceB, flowAId) is what actually denies this
        enrollExisting: true,
      });

      const snapshotCount = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text as count FROM flow_segment_membership_snapshot WHERE workspace_id = $1 AND flow_id = $2`,
            [workspaceA, flowAId]
          );
          return Number(rows[0].count);
        })
      );
      expect(snapshotCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // Test 2: scan-consumer families -- per-row work after discovery affects
  // only the row's own workspace.
  // -------------------------------------------------------------------

  describe("flow-reconciliation (findDueFlowRunCandidates / transitionAndNudge, scan consumer)", () => {
    async function seedWaitingFlowRun(nameSeed: string, nextWakeAt: Date): Promise<{ workspaceId: string; flowRunId: string }> {
      const workspaceId = await freshWorkspaceId(nameSeed);
      const contactId = await insertContact(workspaceId);
      const flowRunId = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows: flowRows } = await client.query<{ id: string }>(
            `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
             VALUES ($1, 'Negative-suite reconciliation flow', 'live', 'event', 'fixture_event', 'test-user') RETURNING id`,
            [workspaceId]
          );
          const { rows: versionRows } = await client.query<{ id: string }>(
            `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
             VALUES ($1, $2, 1, $3, now()) RETURNING id`,
            [workspaceId, flowRows[0].id, { nodes: [{ id: "exit-1", type: "exit", position: { x: 0, y: 0 } }], edges: [] }]
          );
          const { rows: runRows } = await client.query<{ id: string }>(
            `INSERT INTO flow_runs (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id, next_wake_at)
             VALUES ($1, $2, $3, $4, 'waiting', 'exit-1', $5) RETURNING id`,
            [workspaceId, flowRows[0].id, versionRows[0].id, contactId, nextWakeAt]
          );
          return runRows[0].id;
        })
      );
      return { workspaceId, flowRunId };
    }

    it("discovers due flow_runs across two workspaces and each transitions only its own run via the unchanged per-tenant path", async () => {
      const past = new Date(Date.now() - 60_000);
      const a = await seedWaitingFlowRun("jobs-reconcile-a", past);
      const b = await seedWaitingFlowRun("jobs-reconcile-b", past);

      const candidates = await findDueFlowRunCandidates();
      const candidateIds = candidates.map((c) => c.id);
      expect(candidateIds).toContain(a.flowRunId);
      expect(candidateIds).toContain(b.flowRunId);

      const candidateA = candidates.find((c) => c.id === a.flowRunId)!;
      const candidateB = candidates.find((c) => c.id === b.flowRunId)!;
      expect(candidateA.workspaceId).toBe(a.workspaceId);
      expect(candidateB.workspaceId).toBe(b.workspaceId);

      expect(await transitionAndNudge(candidateA)).toBe(true);
      expect(await transitionAndNudge(candidateB)).toBe(true);

      // Cross-check: transitioning A's candidate through B's workspace id
      // must fail (not just "the happy path succeeded") -- the per-tenant
      // re-verification query is workspace-scoped, so a row from a DIFFERENT
      // workspace than the one in the candidate is never touched.
      const mismatched = await transitionAndNudge({ id: a.flowRunId, workspaceId: b.workspaceId });
      expect(mismatched).toBe(false);
    });
  });

  describe("send-reconciler (findReconcilableCandidates / resolveOneSend, scan consumer)", () => {
    /**
     * Claims a fresh campaign send, forces it directly to `reconciling`, and
     * inserts a correlated `send_events` row -- the discoverable-and-resolvable
     * shape `findReconcilableCandidates`/`resolveOneSend` (11-03) expect.
     */
    async function seedReconcilingSendWithEvidence(
      nameSeed: string
    ): Promise<{ workspaceId: string; campaignId: string; sendId: string }> {
      const workspaceId = await freshWorkspaceId(nameSeed);
      await connectFixtureSendgridKey(workspaceId);
      const campaignId = await createFixtureCampaign(workspaceId);
      const contactId = await createFixtureContact(workspaceId);

      const sendId = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const claim = await dispatchSendGate(client, { workspaceId, campaignId, contactId });
          if (claim === "skipped" || !claim.sendId) {
            throw new Error("test setup failure: expected a fresh dispatchSendGate claim");
          }
          await client.query(`UPDATE sends SET status = 'reconciling' WHERE id = $1`, [claim.sendId]);
          await client.query(
            `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'processed', '{}'::jsonb, now())`,
            [workspaceId, `sg-evt-${claim.sendId}`, claim.sendId]
          );
          return claim.sendId;
        })
      );
      return { workspaceId, campaignId, sendId };
    }

    it("discovers reconciling sends across two workspaces and each resolves only its own row via the unchanged per-tenant path", async () => {
      const a = await seedReconcilingSendWithEvidence("jobs-reconciler-a");
      const b = await seedReconcilingSendWithEvidence("jobs-reconciler-b");

      const candidates = await findReconcilableCandidates();
      const candidateIds = candidates.map((c) => c.id);
      expect(candidateIds).toContain(a.sendId);
      expect(candidateIds).toContain(b.sendId);

      const candidateA = candidates.find((c) => c.id === a.sendId)!;
      const candidateB = candidates.find((c) => c.id === b.sendId)!;
      expect(candidateA.workspaceId).toBe(a.workspaceId);
      expect(candidateB.workspaceId).toBe(b.workspaceId);

      // Cross-check FIRST, while both rows are still 'reconciling': resolving
      // A's send id through B's workspace id must fail -- the per-tenant
      // claim query is RLS-scoped, so a row from a DIFFERENT workspace than
      // the one in the candidate is never touched, let alone resolved.
      const mismatched = await resolveOneSend({ id: a.sendId, workspaceId: b.workspaceId });
      expect(mismatched).toBe(false);

      const stillReconciling = await withTenant(a.workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ status: string }>(`SELECT status FROM sends WHERE id = $1`, [a.sendId]);
          return rows[0]?.status;
        })
      );
      expect(stillReconciling, "the mismatched cross-tenant attempt must make no write to A's row").toBe("reconciling");

      expect(await resolveOneSend(candidateA)).toBe(true);
      expect(await resolveOneSend(candidateB)).toBe(true);
    });
  });

  describe("flow-segment-sweep (runFlowSegmentSweepTick, scan consumer)", () => {
    async function seedLiveSegmentFlowWithMatchingContact(nameSeed: string): Promise<{ workspaceId: string; flowId: string; contactId: string }> {
      const workspaceId = await freshWorkspaceId(nameSeed);
      const contactId = await insertContact(workspaceId, { country: "RU" });
      const flowId = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows: segmentRows } = await client.query<{ id: string }>(
            `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
             VALUES ($1, 'Negative-suite sweep segment', $2, 'test-user') RETURNING id`,
            [workspaceId, { version: 1, groups: [{ conditions: [{ type: "attribute", source: "standard", field: "country", operator: "eq", value: "RU" }] }] }]
          );
          const { rows: flowRows } = await client.query<{ id: string }>(
            `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_segment_id, created_by_user_id)
             VALUES ($1, 'Negative-suite sweep flow', 'live', 'segment', $2, 'test-user') RETURNING id`,
            [workspaceId, segmentRows[0].id]
          );
          const { rows: versionRows } = await client.query<{ id: string }>(
            `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
             VALUES ($1, $2, 1, $3, now()) RETURNING id`,
            [
              workspaceId,
              flowRows[0].id,
              { nodes: [{ id: "t1", type: "trigger", triggerType: "segment", position: { x: 0, y: 0 } }, { id: "e1", type: "exit", position: { x: 0, y: 100 } }], edges: [{ id: "e", source: "t1", target: "e1" }] },
            ]
          );
          await client.query(`UPDATE flows SET live_version_id = $2 WHERE id = $1`, [flowRows[0].id, versionRows[0].id]);
          return flowRows[0].id;
        })
      );
      return { workspaceId, flowId, contactId };
    }

    it("sweeps live segment-triggered flows across two workspaces and enrolls each workspace's own matching contact only", async () => {
      const a = await seedLiveSegmentFlowWithMatchingContact("jobs-sweep-a");
      const b = await seedLiveSegmentFlowWithMatchingContact("jobs-sweep-b");

      await runFlowSegmentSweepTick();

      const aRun = await withTenant(a.workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text as count FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3`,
            [a.workspaceId, a.flowId, a.contactId]
          );
          return Number(rows[0].count);
        })
      );
      const bRun = await withTenant(b.workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text as count FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3`,
            [b.workspaceId, b.flowId, b.contactId]
          );
          return Number(rows[0].count);
        })
      );
      expect(aRun).toBe(1);
      expect(bRun).toBe(1);

      // No cross-workspace flow_run: workspace A's contact never enrolled
      // into workspace B's flow, and vice versa.
      const crossA = await withTenant(a.workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text as count FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2`,
            [a.workspaceId, b.flowId]
          );
          return Number(rows[0].count);
        })
      );
      expect(crossA).toBe(0);
    });
  });

  describe("analytics-reconciliation (reconcileWorkspaceDay, scan consumer)", () => {
    it("discovers organizations across two workspaces via the scan role, and each workspace's rollup reflects only its own sends", async () => {
      const workspaceA = await freshWorkspaceId("jobs-analytics-a");
      const workspaceB = await freshWorkspaceId("jobs-analytics-b");

      // The discovery half: the SAME `SELECT id FROM organization` the
      // worker's tick runs via `withCrossWorkspaceScan`, proven to see both
      // freshly-seeded workspaces (mirrors packages/tenant-context's own
      // scan.test.ts "10-03 Test 4" proof for the identical query).
      const discovered = await withCrossWorkspaceScan((client) =>
        client
          .query<{ id: string }>(`SELECT id FROM organization WHERE id = ANY($1::uuid[])`, [[workspaceA, workspaceB]])
          .then((r) => r.rows.map((row) => row.id))
      );
      expect(discovered.sort()).toEqual([workspaceA, workspaceB].sort());

      const contactA = await insertContact(workspaceA);
      const contactB = await insertContact(workspaceB);
      // Derived from the DB session's own `now()::date` (not a JS UTC
      // computation) -- this environment's test database session TimeZone
      // is not UTC, and `sent_at::date` below casts using THAT session
      // setting. Unified UTC day semantics for daily metrics is an explicit
      // Phase 11+ concern (PROJECT.md Active); this test only needs "today"
      // as `reconcileWorkspaceDay`'s own `sent_at::date` comparison will
      // resolve it, so workspace-scoping (this test's actual claim) is
      // proven without depending on that separate, later-phase fix.
      const { rows: todayRows } = await pool.query<{ today: string }>(`SELECT now()::date::text as today`);
      const today = todayRows[0].today;

      // One 'sent' send per workspace, dated today.
      await withTenant(workspaceA, () =>
        withTenantTransaction((client) =>
          client.query(`INSERT INTO sends (workspace_id, contact_id, kind, status, sent_at) VALUES ($1, $2, 'campaign', 'sent', now())`, [
            workspaceA,
            contactA,
          ])
        )
      );
      // Workspace B gets TWO sends -- so a mixed count would be visibly wrong
      // if the reconcile scoped incorrectly.
      await withTenant(workspaceB, () =>
        withTenantTransaction(async (client) => {
          await client.query(`INSERT INTO sends (workspace_id, contact_id, kind, status, sent_at) VALUES ($1, $2, 'campaign', 'sent', now())`, [
            workspaceB,
            contactB,
          ]);
          await client.query(`INSERT INTO sends (workspace_id, contact_id, kind, status, sent_at) VALUES ($1, $2, 'campaign', 'sent', now())`, [
            workspaceB,
            contactB,
          ]);
        })
      );

      // The per-workspace reconcile half: each workspace gets its OWN fresh
      // `withTenant`/`withTenantTransaction` scope (mirrors the worker's own
      // `reconcileWorkspace` wrapper).
      await withTenant(workspaceA, () => withTenantTransaction((client) => reconcileWorkspaceDay(client, workspaceA, today)));
      await withTenant(workspaceB, () => withTenantTransaction((client) => reconcileWorkspaceDay(client, workspaceB, today)));

      const rollupA = await withTenant(workspaceA, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ sentCount: number }>(
            `SELECT sent_count as "sentCount" FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
            [workspaceA, today]
          );
          return rows[0]?.sentCount ?? 0;
        })
      );
      const rollupB = await withTenant(workspaceB, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ sentCount: number }>(
            `SELECT sent_count as "sentCount" FROM workspace_daily_rollup WHERE workspace_id = $1 AND day = $2`,
            [workspaceB, today]
          );
          return rows[0]?.sentCount ?? 0;
        })
      );
      expect(rollupA).toBe(1);
      expect(rollupB).toBe(2);
    });
  });

  // -------------------------------------------------------------------
  // Test 3: an outright hostile foreign resource id is denied by the
  // tenant-scoped query rather than silently operating on it -- this is
  // already the load-bearing assertion in every Test-1 case above (each one
  // is exactly "a payload naming a foreign resource id"); this section adds
  // the one family whose denial shape is a graceful boolean rather than a
  // no-op/throw, so the "denied, not silently operating" claim is visible
  // for that shape too.
  // -------------------------------------------------------------------

  it("Test 3: transitionAndNudge given a real flow_run id paired with a foreign workspaceId returns false rather than transitioning the wrong workspace's row", async () => {
    const past = new Date(Date.now() - 60_000);
    const workspaceA = await freshWorkspaceId("jobs-hostile-pair-a");
    const workspaceB = await freshWorkspaceId("jobs-hostile-pair-b");
    const contactId = await insertContact(workspaceA);
    const flowRunId = await withTenant(workspaceA, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
           VALUES ($1, 'Hostile-pair flow', 'live', 'event', 'fixture_event', 'test-user') RETURNING id`,
          [workspaceA]
        );
        const { rows: versionRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_versions (workspace_id, flow_id, version_number, definition, published_at)
           VALUES ($1, $2, 1, $3, now()) RETURNING id`,
          [workspaceA, flowRows[0].id, { nodes: [{ id: "exit-1", type: "exit", position: { x: 0, y: 0 } }], edges: [] }]
        );
        const { rows: runRows } = await client.query<{ id: string }>(
          `INSERT INTO flow_runs (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id, next_wake_at)
           VALUES ($1, $2, $3, $4, 'waiting', 'exit-1', $5) RETURNING id`,
          [workspaceA, flowRows[0].id, versionRows[0].id, contactId, past]
        );
        return runRows[0].id;
      })
    );

    const result = await transitionAndNudge({ id: flowRunId, workspaceId: workspaceB });
    expect(result).toBe(false);

    const statusAfter = await withTenant(workspaceA, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string }>(`SELECT status FROM flow_runs WHERE id = $1`, [flowRunId]);
        return rows[0]?.status;
      })
    );
    expect(statusAfter).toBe("waiting"); // unchanged
  });

  // -------------------------------------------------------------------
  // Test 4: the scan role cannot reach a table it was never granted.
  // -------------------------------------------------------------------

  it("Test 4: the scan pool refuses a read of an ungranted tenant table (permission denied, not an empty result)", async () => {
    // flow_versions has no grant/policy for mega_crm_scan anywhere in this
    // migration set (mirrors packages/tenant-context/src/__tests__/scan.test.ts's
    // own "Test 5" proof of the identical fact from the package's own test
    // suite -- this asserts the SAME runtime consequence from the worker
    // consumer's side).
    await expect(withCrossWorkspaceScan((client) => client.query(`SELECT id FROM flow_versions LIMIT 1`))).rejects.toThrow(
      /permission denied for table flow_versions/
    );
  });

  // -------------------------------------------------------------------
  // Test 5 (coverage): the set of job families registered in buildWorker's
  // array equals the set this suite exercises, with an explicit commented
  // exclusion set.
  // -------------------------------------------------------------------

  describe("Test 5: coverage -- every job family in buildWorker's array has a case or a documented exclusion", () => {
    // These families have a dedicated attempted-access proof HOUSED IN THIS
    // FILE (Test 1/2/3 above).
    const COVERED_FAMILIES = new Set([
      "EventsIngest",
      "ImportsCsv",
      "EmailBroadcast", // via processSendJob, shared with EmailTriggered
      "EmailTriggered", // via processSendJob, shared with EmailBroadcast
      "CampaignKickoff",
      "FlowRunAdvance",
      "FlowReconciliation",
      "FlowTriggerEvaluator",
      "FlowSegmentSweep",
      "FlowEnrollExisting",
      "AnalyticsReconciliation",
      "SendReconciler",
    ]);

    const EXCLUDED_FAMILIES: Record<string, string> = {
      CampaignScheduler:
        "already has a dedicated attempted-access proof in campaign-scheduler-scan.test.ts (seeds due campaigns in two workspaces, proves findDueCampaignCandidates/transitionToSending's per-tenant re-verification independently transitions each) -- this file does not duplicate it",
      WebhookEvents:
        "already has a dedicated attempted-access proof in webhook-events-sibling-drop.test.ts (SEC-09/WR-01 -- a sibling workspace's send_id is resolved via the scan role and dropped, never redirected) -- this file does not duplicate it",
      PartitionMaintenance:
        "processes cluster-wide partition DDL with no workspace id anywhere in its job payload or query -- there is no tenant boundary for a hostile payload to cross",
    };

    it("every create*Worker family in buildWorker's array is covered or has a documented exclusion reason", () => {
      const serverPath = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../server.ts");
      const serverSource = readFileSync(serverPath, "utf8");
      const registeredFamilies = [...serverSource.matchAll(/create(\w+)Worker\(/g)].map((m) => m[1]);

      expect(registeredFamilies.length).toBeGreaterThan(0);

      const uniqueRegistered = new Set(registeredFamilies);
      const accountedFor = new Set([...COVERED_FAMILIES, ...Object.keys(EXCLUDED_FAMILIES)]);

      const missing = [...uniqueRegistered].filter((f) => !accountedFor.has(f));
      expect(missing, `job family(ies) registered in buildWorker but neither covered nor excluded: ${missing.join(", ")}`).toEqual([]);

      const stale = [...accountedFor].filter((f) => !uniqueRegistered.has(f));
      expect(stale, `covered/excluded family(ies) no longer registered in buildWorker: ${stale.join(", ")}`).toEqual([]);
    });
  });
});
