import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Worker } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import type { FlowRunAdvanceJob } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { createFlowRunAdvanceWorker } from "../flows/flow-run-advance.worker.js";
import { emailTriggeredQueue, enqueueFlowRunAdvance, flowRunAdvanceQueue } from "../flows/flow-queues.js";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";

/**
 * CR-01 regression coverage (06-12): a REAL BullMQ `Queue`/`Worker` pair
 * (not a direct `processFlowRunAdvance` call, unlike `flow-run-advance.test.ts`)
 * drives a multi-step flow run through every step of its graph. Under the
 * pre-fix code (deterministic `jobId: flowRunId` on `flowRunAdvanceQueue`,
 * shared `DEFAULT_JOB_OPTIONS` retaining completed jobs 24h / failed jobs
 * forever, plus WR-08's missing send/branch forward nudge), BOTH scenarios
 * below stall after their first hop: `Queue.add()` no-ops while a job with
 * the reused id already exists in ANY state, so the second wake for the SAME
 * run is silently dropped and the run never advances past step one.
 */
describe("flow-run-advance CR-01 integration: real Queue/Worker multi-step advancement", () => {
  let pool: Pool;
  let worker: Worker<FlowRunAdvanceJob>;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is required for the flow-run-advance-integration test (see vitest.config.ts)");
    }
    worker = createFlowRunAdvanceWorker(buildRedisConnectionOptions(redisUrl));
  });

  afterAll(async () => {
    await worker.close();
    await pool.end();
  });

  // 10-09 (SEC-05): delegates to the mega_crm_auth-backed INSERT in
  // failure-fixtures.ts instead of duplicating it -- mega_crm_app holds
  // only SELECT on organization post-migration-0045.
  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function createFixtureContact(workspaceId: string): Promise<string> {
    const email = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email]
        );
        return rows[0].id;
      })
    );
  }

  /** Scenario A fixture: trigger -> send-A -> send-B -> exit-1 (two consecutive non-terminal send nodes). */
  async function seedTwoSendFlowRun(
    workspaceId: string,
    contactId: string
  ): Promise<{ flowRunId: string; sendANodeId: string; sendBNodeId: string; exitNodeId: string }> {
    const sendANodeId = "send-A";
    const sendBNodeId = "send-B";
    const exitNodeId = "exit-1";

    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
           VALUES ($1, 'Fixture two-send flow', 'live', 'event', 'fixture_event', 'test-user')
           RETURNING id`,
          [workspaceId]
        );
        const flowId = flowRows[0].id;

        const definition: FlowDefinition = {
          nodes: [
            { id: "trigger-1", type: "trigger", triggerType: "event", eventName: "fixture_event", position: { x: 0, y: 0 } },
            { id: sendANodeId, type: "send", templateId: "d-fixture-template", fromEmail: "sender@fixture.test", position: { x: 0, y: 100 } },
            { id: sendBNodeId, type: "send", templateId: "d-fixture-template", fromEmail: "sender@fixture.test", position: { x: 0, y: 200 } },
            { id: exitNodeId, type: "exit", position: { x: 0, y: 300 } },
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: sendANodeId },
            { id: "e2", source: sendANodeId, target: sendBNodeId },
            { id: "e3", source: sendBNodeId, target: exitNodeId },
          ],
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
          `INSERT INTO flow_runs
             (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id, next_wake_at, entered_at)
           VALUES ($1, $2, $3, $4, 'waiting', $5, $6, $7)
           RETURNING id`,
          [workspaceId, flowId, flowVersionId, contactId, sendANodeId, new Date(Date.now() - 60_000), new Date(Date.now() - 60 * 60 * 1000)]
        );

        return { flowRunId: runRows[0].id, sendANodeId, sendBNodeId, exitNodeId };
      })
    );
  }

  /** Scenario B fixture: trigger -> delay-1 -> delay-2 -> send-1 -> exit-1 (two consecutive delay nodes). */
  async function seedTwoDelayFlowRun(
    workspaceId: string,
    contactId: string
  ): Promise<{ flowRunId: string; delay1NodeId: string; delay2NodeId: string; sendNodeId: string; exitNodeId: string }> {
    const delay1NodeId = "delay-1";
    const delay2NodeId = "delay-2";
    const sendNodeId = "send-1";
    const exitNodeId = "exit-1";

    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, created_by_user_id)
           VALUES ($1, 'Fixture two-delay flow', 'live', 'event', 'fixture_event', 'test-user')
           RETURNING id`,
          [workspaceId]
        );
        const flowId = flowRows[0].id;

        const definition: FlowDefinition = {
          nodes: [
            { id: "trigger-1", type: "trigger", triggerType: "event", eventName: "fixture_event", position: { x: 0, y: 0 } },
            { id: delay1NodeId, type: "delay", delay: { kind: "fixed", amount: 30, unit: "minutes" }, position: { x: 0, y: 100 } },
            { id: delay2NodeId, type: "delay", delay: { kind: "fixed", amount: 30, unit: "minutes" }, position: { x: 0, y: 200 } },
            { id: sendNodeId, type: "send", templateId: "d-fixture-template", fromEmail: "sender@fixture.test", position: { x: 0, y: 300 } },
            { id: exitNodeId, type: "exit", position: { x: 0, y: 400 } },
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: delay1NodeId },
            { id: "e2", source: delay1NodeId, target: delay2NodeId },
            { id: "e3", source: delay2NodeId, target: sendNodeId },
            { id: "e4", source: sendNodeId, target: exitNodeId },
          ],
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
          `INSERT INTO flow_runs
             (workspace_id, flow_id, flow_version_id, contact_id, status, current_node_id, next_wake_at, entered_at)
           VALUES ($1, $2, $3, $4, 'waiting', $5, $6, $7)
           RETURNING id`,
          [workspaceId, flowId, flowVersionId, contactId, delay1NodeId, new Date(Date.now() - 60_000), new Date(Date.now() - 60 * 60 * 1000)]
        );

        return { flowRunId: runRows[0].id, delay1NodeId, delay2NodeId, sendNodeId, exitNodeId };
      })
    );
  }

  interface FlowRunState {
    status: string;
    currentNodeId: string | null;
  }

  async function getFlowRunState(workspaceId: string, flowRunId: string): Promise<FlowRunState> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<FlowRunState>(
          `SELECT status, current_node_id as "currentNodeId" FROM flow_runs WHERE id = $1`,
          [flowRunId]
        );
        return rows[0];
      })
    );
  }

  async function forceDue(workspaceId: string, flowRunId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE flow_runs SET next_wake_at = $2 WHERE id = $1`, [flowRunId, new Date(Date.now() - 1000)])
      )
    );
  }

  interface FlowRunStep {
    nodeId: string;
    nodeType: string;
    outcome: string;
  }

  async function getFlowRunSteps(workspaceId: string, flowRunId: string): Promise<FlowRunStep[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<FlowRunStep>(
          `SELECT node_id as "nodeId", node_type as "nodeType", outcome
           FROM flow_run_steps WHERE flow_run_id = $1 ORDER BY created_at ASC`,
          [flowRunId]
        );
        return rows;
      })
    );
  }

  /**
   * Polls `predicate` every `intervalMs` up to `timeoutMs`, invoking `onTick`
   * (if provided) on every poll -- Scenario B's unique-jobId assertion piggy-
   * backs on this to sample `flowRunAdvanceQueue`'s live job ids for the run
   * DURING advancement, since `removeOnComplete: true` means a completed
   * wake's job is gone by the time the predicate finally succeeds.
   */
  async function waitFor(
    predicate: () => Promise<boolean>,
    opts: { timeoutMs?: number; intervalMs?: number; onTick?: () => Promise<void> } = {}
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const intervalMs = opts.intervalMs ?? 150;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (opts.onTick) await opts.onTick();
      if (await predicate()) return;
      if (Date.now() > deadline) {
        throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  it(
    "Scenario A: a real Worker advances a two-send-node run to 'completed' with no test intervention between hops",
    async () => {
      const workspaceId = await freshWorkspaceId("flow-adv-int-sends");
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, sendANodeId, sendBNodeId, exitNodeId } = await seedTwoSendFlowRun(workspaceId, contactId);

      await enqueueFlowRunAdvance({ workspaceId, flowRunId });

      await waitFor(async () => (await getFlowRunState(workspaceId, flowRunId)).status === "completed", {
        timeoutMs: 10_000,
      });

      const state = await getFlowRunState(workspaceId, flowRunId);
      expect(state.status).toBe("completed");

      const steps = await getFlowRunSteps(workspaceId, flowRunId);
      const stepByNode = new Map(steps.map((s) => [s.nodeId, s]));
      expect(stepByNode.get(sendANodeId)).toMatchObject({ nodeType: "send", outcome: "enqueued" });
      expect(stepByNode.get(sendBNodeId)).toMatchObject({ nodeType: "send", outcome: "enqueued" });
      expect(stepByNode.get(exitNodeId)).toMatchObject({ nodeType: "exit", outcome: "completed" });

      const sendAJob = await emailTriggeredQueue.getJob(`${flowRunId}-${sendANodeId}`);
      const sendBJob = await emailTriggeredQueue.getJob(`${flowRunId}-${sendBNodeId}`);
      expect(sendAJob, "send-A's send job was enqueued").toBeDefined();
      expect(sendBJob, "send-B's send job was enqueued (CR-01: the pre-fix jobId reuse drops this second hop)").toBeDefined();
    },
    15_000
  );

  it(
    "Scenario B (2+ delay chain): a real Worker advances the run past BOTH delay-1 and delay-2 via non-shadowed delayed nudges",
    async () => {
      const workspaceId = await freshWorkspaceId("flow-adv-int-delays");
      const contactId = await createFixtureContact(workspaceId);
      const { flowRunId, delay1NodeId, delay2NodeId, sendNodeId, exitNodeId } = await seedTwoDelayFlowRun(
        workspaceId,
        contactId
      );

      async function getDelayedAdvanceJobIdForRun(): Promise<string | undefined> {
        const jobs = await flowRunAdvanceQueue.getJobs(["delayed"]);
        return jobs.find((job) => job.data?.flowRunId === flowRunId)?.id;
      }

      // Initial nudge onto delay-1.
      await enqueueFlowRunAdvance({ workspaceId, flowRunId });

      // Hop 1: the real Worker processes delay-1 and advances current_node_id
      // to delay-2, scheduling delay-1's OWN delayed nudge (far in the
      // future -- 30 minutes -- so it will not fire during this test).
      await waitFor(async () => (await getFlowRunState(workspaceId, flowRunId)).currentNodeId === delay2NodeId, {
        timeoutMs: 10_000,
      });

      const jobIdAfterDelay1 = await getDelayedAdvanceJobIdForRun();
      expect(jobIdAfterDelay1, "delay-1's own delayed advance nudge is sitting in the queue").toBeDefined();
      // Still there, untouched -- its own 30-minute wake has not elapsed.
      // Proves this job was never consumed/shadowed by what follows: the
      // CR-01 fix means the NEXT wake below gets its OWN id.
      expect(await flowRunAdvanceQueue.getJob(jobIdAfterDelay1!)).toBeDefined();

      // Fast-forward: simulate delay-1's wait elapsing by forcing the run
      // due, then enqueue a FRESH advance nudge. Under the pre-fix code
      // (jobId: flowRunId, retained completed/failed jobs) this add() would
      // silently no-op because delay-1's completed advance job already
      // occupies that id -- the run would stall at delay-2 forever.
      await forceDue(workspaceId, flowRunId);
      await enqueueFlowRunAdvance({ workspaceId, flowRunId });

      // Hop 2: the real Worker processes delay-2 and advances current_node_id
      // to the send node -- proving the SECOND delay's wake was NOT shadowed
      // by delay-1's still-live (and, under the old code, retained-forever)
      // advance job.
      await waitFor(async () => (await getFlowRunState(workspaceId, flowRunId)).currentNodeId === sendNodeId, {
        timeoutMs: 10_000,
      });

      const jobIdAfterDelay2 = await getDelayedAdvanceJobIdForRun();
      expect(
        jobIdAfterDelay2,
        "delay-2's dispatch produced a DIFFERENT advance job id than delay-1's -- unique-per-wake, no shadowing"
      ).toBeDefined();
      expect(jobIdAfterDelay2).not.toBe(jobIdAfterDelay1);
      // delay-1's original delayed job is STILL present and untouched (its
      // 30-minute wake never elapsed) -- coexisting peacefully alongside the
      // fresh, distinct wake that actually drove hop 2's progress.
      expect(await flowRunAdvanceQueue.getJob(jobIdAfterDelay1!)).toBeDefined();
      expect(jobIdAfterDelay1).toContain(flowRunId);
      expect(jobIdAfterDelay2).toContain(flowRunId);

      // Fast-forward past delay-2's own future wake (its dispatch, like
      // delay-1's, sets next_wake_at to a real future value) and drive the
      // run through the send node to its terminal 'completed' state.
      await forceDue(workspaceId, flowRunId);
      await enqueueFlowRunAdvance({ workspaceId, flowRunId });

      await waitFor(async () => (await getFlowRunState(workspaceId, flowRunId)).status === "completed", {
        timeoutMs: 10_000,
      });

      const steps = await getFlowRunSteps(workspaceId, flowRunId);
      const stepByNode = new Map(steps.map((s) => [s.nodeId, s]));
      expect(stepByNode.get(delay1NodeId)).toMatchObject({ nodeType: "delay", outcome: "waiting" });
      expect(stepByNode.get(delay2NodeId)).toMatchObject({ nodeType: "delay", outcome: "waiting" });
      expect(stepByNode.get(sendNodeId)).toMatchObject({ nodeType: "send", outcome: "enqueued" });
      expect(stepByNode.get(exitNodeId)).toMatchObject({ nodeType: "exit", outcome: "completed" });

      const sendJob = await emailTriggeredQueue.getJob(`${flowRunId}-${sendNodeId}`);
      expect(sendJob, "the send node past both delays enqueued its send job").toBeDefined();
    },
    20_000
  );
});
