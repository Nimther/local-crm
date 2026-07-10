import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import type { FlowExitCondition } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processFlowRunAdvance } from "../flows/flow-run-advance.worker.js";
import { emailTriggeredQueue, flowRunAdvanceQueue } from "../flows/flow-queues.js";

/**
 * `flow-run-advance.worker.ts`'s `processFlowRunAdvance` (FLOW-01/03/06/07,
 * 06-05's overall `<verification>`): the engine's step-boundary semantics --
 * a due send node enqueues exactly one flow-step send and advances the
 * pointer; an exit CONDITION satisfied at the boundary short-circuits
 * BEFORE any send (D-14); a stale nudge for an already-terminal run is a
 * pure no-op. Invoked directly (mirrors `campaign-kickoff.worker.smoke.
 * test.ts`'s exported-processor convention) against real Postgres/Redis --
 * the actual `EMAIL_TRIGGERED_QUEUE` enqueue is asserted via
 * `emailTriggeredQueue.getJob(...)`, not a stubbed dependency, since this
 * codebase's established convention (campaign-kickoff/campaign-broadcast)
 * never mocks BullMQ's own Queue -- only the SendGrid network call
 * (`sendMail`) is ever faked, and this test never reaches that far (no
 * consumer is running against `EMAIL_TRIGGERED_QUEUE` in this process, so
 * the enqueued job just sits there for inspection).
 */
describe("flow-run-advance.worker.ts processFlowRunAdvance (FLOW-01/03/06/07)", () => {
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
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
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

  /**
   * Seeds a flows/flow_versions/flow_runs triplet with a full
   * trigger->send->exit graph (unlike `db-fixture.ts`'s shared
   * `createFixtureFlowRun`, which stops at a bare send node with no
   * outgoing edge -- this plan's tests need a real next-node to advance
   * INTO). Kept local to this test file, mirroring
   * `flow-send-idempotency.test.ts`'s own locally-defined fixture
   * convention for scenario-specific shapes.
   */
  async function seedFlowRun(
    workspaceId: string,
    contactId: string,
    opts: {
      exitConditions?: FlowExitCondition[];
      status?: string;
      nextWakeAt?: Date | null;
      currentNodeId?: string;
      enteredAt?: Date;
    } = {}
  ): Promise<{ flowId: string; flowVersionId: string; flowRunId: string; sendNodeId: string; exitNodeId: string }> {
    const sendNodeId = "send-1";
    const exitNodeId = "exit-1";

    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows (workspace_id, name, status, trigger_type, trigger_event_name, exit_conditions, created_by_user_id)
           VALUES ($1, 'Fixture flow', 'live', 'event', 'fixture_event', $2, 'test-user')
           RETURNING id`,
          [workspaceId, JSON.stringify(opts.exitConditions ?? [])]
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
              id: sendNodeId,
              type: "send",
              templateId: "d-fixture-template",
              fromEmail: "sender@fixture.test",
              position: { x: 0, y: 100 },
            },
            { id: exitNodeId, type: "exit", position: { x: 0, y: 200 } },
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: sendNodeId },
            { id: "e2", source: sendNodeId, target: exitNodeId },
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
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id`,
          [
            workspaceId,
            flowId,
            flowVersionId,
            contactId,
            opts.status ?? "waiting",
            opts.currentNodeId ?? sendNodeId,
            opts.nextWakeAt === undefined ? new Date(Date.now() - 60_000) : opts.nextWakeAt,
            opts.enteredAt ?? new Date(Date.now() - 60 * 60 * 1000),
          ]
        );
        const flowRunId = runRows[0].id;

        return { flowId, flowVersionId, flowRunId, sendNodeId, exitNodeId };
      })
    );
  }

  /**
   * 06-07: seeds a trigger->delay->send->exit graph, `current_node_id`
   * starting at the delay node, so `processFlowRunAdvance` dispatches
   * `handleDelayNode` (rather than `seedFlowRun`'s send-node-first shape).
   */
  async function seedDelayFlowRun(
    workspaceId: string,
    contactId: string,
    delayNode: Extract<FlowDefinition["nodes"][number], { type: "delay" }>,
    opts: { quietHoursMode?: string; quietHoursStart?: number; quietHoursEnd?: number } = {}
  ): Promise<{ flowRunId: string; delayNodeId: string; sendNodeId: string }> {
    const delayNodeId = delayNode.id;
    const sendNodeId = "send-1";
    const exitNodeId = "exit-1";

    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows
             (workspace_id, name, status, trigger_type, trigger_event_name, quiet_hours_mode, quiet_hours_start, quiet_hours_end, created_by_user_id)
           VALUES ($1, 'Fixture delay flow', 'live', 'event', 'fixture_event', $2, $3, $4, 'test-user')
           RETURNING id`,
          [workspaceId, opts.quietHoursMode ?? "inherit", opts.quietHoursStart ?? null, opts.quietHoursEnd ?? null]
        );
        const flowId = flowRows[0].id;

        const definition: FlowDefinition = {
          nodes: [
            { id: "trigger-1", type: "trigger", triggerType: "event", eventName: "fixture_event", position: { x: 0, y: 0 } },
            delayNode,
            {
              id: sendNodeId,
              type: "send",
              templateId: "d-fixture-template",
              fromEmail: "sender@fixture.test",
              position: { x: 0, y: 100 },
            },
            { id: exitNodeId, type: "exit", position: { x: 0, y: 200 } },
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: delayNodeId },
            { id: "e2", source: delayNodeId, target: sendNodeId },
            { id: "e3", source: sendNodeId, target: exitNodeId },
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
          [workspaceId, flowId, flowVersionId, contactId, delayNodeId, new Date(Date.now() - 60_000), new Date(Date.now() - 60 * 60 * 1000)]
        );

        return { flowRunId: runRows[0].id, delayNodeId, sendNodeId };
      })
    );
  }

  interface FlowRunState {
    status: string;
    currentNodeId: string | null;
    exitReason: string | null;
    nextWakeAt: Date | null;
  }

  async function getFlowRunState(workspaceId: string, flowRunId: string): Promise<FlowRunState> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<FlowRunState>(
          `SELECT status, current_node_id as "currentNodeId", exit_reason as "exitReason", next_wake_at as "nextWakeAt"
           FROM flow_runs WHERE id = $1`,
          [flowRunId]
        );
        return rows[0];
      })
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

  async function insertFixtureEvent(workspaceId: string, contactId: string, name: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at, received_at)
           VALUES ($1, $2, $3, $4, $5, now(), now())`,
          [randomUUID(), workspaceId, contactId, name, {}]
        )
      )
    );
  }

  it("a due send node enqueues exactly one kind:'flow' send job and advances current_node_id to the exit node", async () => {
    const workspaceId = await freshWorkspaceId("flow-advance-send");
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, sendNodeId, exitNodeId } = await seedFlowRun(workspaceId, contactId);

    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    expect(state.status).toBe("waiting");
    expect(state.currentNodeId).toBe(exitNodeId);

    const steps = await getFlowRunSteps(workspaceId, flowRunId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ nodeId: sendNodeId, nodeType: "send", outcome: "enqueued" });

    const job = await emailTriggeredQueue.getJob(`${flowRunId}-${sendNodeId}`);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({ workspaceId, kind: "flow", flowRunId, nodeId: sendNodeId, contactId });
  });

  it("D-14: an exit condition satisfied at the boundary exits the run and enqueues NO send job", async () => {
    const workspaceId = await freshWorkspaceId("flow-advance-exit-cond");
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, sendNodeId } = await seedFlowRun(workspaceId, contactId, {
      exitConditions: [{ type: "event", eventName: "unsubscribed_elsewhere" }],
    });

    // Occurs AFTER the run's (explicitly backdated) entered_at.
    await insertFixtureEvent(workspaceId, contactId, "unsubscribed_elsewhere");

    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    expect(state.status).toBe("exited");
    expect(state.exitReason).toBe("exit_condition");

    const steps = await getFlowRunSteps(workspaceId, flowRunId);
    expect(steps).toHaveLength(1);
    expect(steps[0].outcome).toBe("exit_condition_satisfied");

    const job = await emailTriggeredQueue.getJob(`${flowRunId}-${sendNodeId}`);
    expect(job, "no send job enqueued when the exit condition is satisfied at the boundary").toBeUndefined();
  });

  it("a stale advance for an already-terminal run is a no-op (no extra steps, no send)", async () => {
    const workspaceId = await freshWorkspaceId("flow-advance-stale");
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, sendNodeId } = await seedFlowRun(workspaceId, contactId, {
      status: "completed",
      currentNodeId: "exit-1",
    });

    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    expect(state.status).toBe("completed"); // untouched

    const steps = await getFlowRunSteps(workspaceId, flowRunId);
    expect(steps).toHaveLength(0);

    const job = await emailTriggeredQueue.getJob(`${flowRunId}-${sendNodeId}`);
    expect(job).toBeUndefined();
  });

  it("06-07/FLOW-05: a due fixed-duration delay node sets a future next_wake_at, advances to the next node, and enqueues NO send", async () => {
    const workspaceId = await freshWorkspaceId("flow-advance-delay-fixed");
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, delayNodeId, sendNodeId } = await seedDelayFlowRun(workspaceId, contactId, {
      id: "delay-1",
      type: "delay",
      delay: { kind: "fixed", amount: 30, unit: "minutes" },
      position: { x: 0, y: 50 },
    });

    const before = Date.now();
    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    expect(state.status).toBe("waiting");
    expect(state.currentNodeId).toBe(sendNodeId); // advanced PAST the delay node itself
    expect(new Date(state.nextWakeAt!).getTime()).toBeGreaterThan(before + 29 * 60_000);

    const steps = await getFlowRunSteps(workspaceId, flowRunId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ nodeId: delayNodeId, nodeType: "delay", outcome: "waiting" });

    const sendJob = await emailTriggeredQueue.getJob(`${flowRunId}-${sendNodeId}`);
    expect(sendJob, "no send job enqueued -- the delay only advances the pointer, doesn't dispatch the next node").toBeUndefined();

    // Durable timer: a BullMQ delayed advance nudge exists (jobId: flowRunId), not a setTimeout.
    const advanceJob = await flowRunAdvanceQueue.getJob(flowRunId);
    expect(advanceJob).toBeDefined();
  });

  it("06-07/D-08/D-14/Pitfall 4: a send node inside its flow's override quiet-hours window defers -- NO send job, next_wake_at = window end", async () => {
    const workspaceId = await freshWorkspaceId("flow-advance-quiet-hours");
    const contactId = await createFixtureContact(workspaceId);

    // A 60-minute window (UTC, no contact/workspace timezone set -- resolves
    // to UTC) straddling the CURRENT actual wall-clock minute, guaranteeing
    // "now" falls inside it regardless of when this test runs.
    const now = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const quietHoursStart = (utcMinutes - 30 + 1440) % 1440;
    const quietHoursEnd = (utcMinutes + 30) % 1440;

    const { flowRunId, sendNodeId } = await seedFlowRun(workspaceId, contactId, {});
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE flows SET quiet_hours_mode = 'override', quiet_hours_start = $1, quiet_hours_end = $2 WHERE id = (SELECT flow_id FROM flow_runs WHERE id = $3)`, [
          quietHoursStart,
          quietHoursEnd,
          flowRunId,
        ])
      )
    );

    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    expect(state.status).toBe("waiting");
    expect(state.currentNodeId).toBe(sendNodeId); // NOT advanced -- still at the deferred send node

    const steps = await getFlowRunSteps(workspaceId, flowRunId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ nodeId: sendNodeId, nodeType: "send", outcome: "deferred_quiet_hours" });

    const sendJob = await emailTriggeredQueue.getJob(`${flowRunId}-${sendNodeId}`);
    expect(sendJob, "no send job enqueued while inside the quiet-hours window").toBeUndefined();

    const advanceJob = await flowRunAdvanceQueue.getJob(flowRunId);
    expect(advanceJob, "a delayed advance nudge is enqueued for the window end").toBeDefined();
  });
});
