import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import type { FlowExitCondition } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processFlowRunAdvance } from "../flows/flow-run-advance.worker.js";
import { emailTriggeredQueue, flowRunAdvanceQueue } from "../flows/flow-queues.js";
import { upsertWorkspaceSendSettings } from "@mega-crm/delivery-core";

// 06-15/D-08/FLOW-05: two DST-free IANA zones with a large, stable wall-clock
// separation (~15.5h) so assertions never depend on the exact wall-clock
// minute the suite happens to run at.
const CONTACT_TZ = "Asia/Kolkata"; // UTC+5:30, no DST
const WORKSPACE_TZ = "Pacific/Honolulu"; // UTC-10, no DST

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
          [workspaceId, opts.quietHoursMode ?? "workspace_default", opts.quietHoursStart ?? null, opts.quietHoursEnd ?? null]
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

    // Durable timer: a BullMQ delayed advance nudge exists for this run, not
    // a setTimeout. Located by data.flowRunId (not a fixed jobId, 06-12/CR-01
    // -- jobId is now unique-per-wake, `${flowRunId}-${Date.now()}`).
    const delayedJobs = await flowRunAdvanceQueue.getJobs(["delayed", "waiting"]);
    expect(delayedJobs.some((j) => j.data.flowRunId === flowRunId)).toBe(true);
  });

  it("06-07/06-13/D-08/D-14/Pitfall 4/CR-02: a send node inside its flow's custom quiet-hours window defers -- NO send job, next_wake_at = window end", async () => {
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
    // 'custom' is the exact value QuietHoursCard.tsx + flow.repository.ts
    // persist for a per-flow window (CR-02) -- NOT the legacy 'override'
    // value the worker used to branch on.
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE flows SET quiet_hours_mode = 'custom', quiet_hours_start = $1, quiet_hours_end = $2 WHERE id = (SELECT flow_id FROM flow_runs WHERE id = $3)`, [
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

    // Located by data.flowRunId (not a fixed jobId, 06-12/CR-01 -- jobId is
    // now unique-per-wake, `${flowRunId}-${Date.now()}`).
    const delayedJobs = await flowRunAdvanceQueue.getJobs(["delayed", "waiting"]);
    expect(
      delayedJobs.some((j) => j.data.flowRunId === flowRunId),
      "a delayed advance nudge is enqueued for the window end"
    ).toBe(true);
  });

  it("06-13/CR-02 regression: quiet_hours_mode 'workspace_default' with the workspace default disabled does NOT defer -- only 'custom' engages a flow's own window", async () => {
    const workspaceId = await freshWorkspaceId("flow-advance-quiet-hours-workspace-default");
    const contactId = await createFixtureContact(workspaceId);

    // Same window bounds as the 'custom' test above, but seeded on a flow
    // whose quiet_hours_mode is 'workspace_default' (the DB/schema default,
    // 06-13). The workspace has no quiet-hours settings row, so
    // getWorkspaceSendSettings resolves quietHoursEnabled=false and no gate
    // applies -- proving the fix keys off 'custom' specifically, not any
    // truthy start/end pair.
    const now = new Date();
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const quietHoursStart = (utcMinutes - 30 + 1440) % 1440;
    const quietHoursEnd = (utcMinutes + 30) % 1440;

    const { flowRunId, sendNodeId, exitNodeId } = await seedFlowRun(workspaceId, contactId, {});
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE flows SET quiet_hours_mode = 'workspace_default', quiet_hours_start = $1, quiet_hours_end = $2 WHERE id = (SELECT flow_id FROM flow_runs WHERE id = $3)`, [
          quietHoursStart,
          quietHoursEnd,
          flowRunId,
        ])
      )
    );

    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    expect(state.status).toBe("waiting");
    expect(state.currentNodeId).toBe(exitNodeId); // advanced past the send node -- not deferred

    const steps = await getFlowRunSteps(workspaceId, flowRunId);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ nodeId: sendNodeId, nodeType: "send", outcome: "enqueued" });

    const sendJob = await emailTriggeredQueue.getJob(`${flowRunId}-${sendNodeId}`);
    expect(sendJob, "send job IS enqueued -- 'workspace_default' with quiet hours disabled applies no gate").toBeDefined();
  });

  it("06-15/D-08/FLOW-05: a custom quiet-hours window is evaluated in the CONTACT's timezone -- a send inside the contact's local window defers even when the workspace default timezone places now outside it", async () => {
    const workspaceId = await freshWorkspaceId("flow-advance-contact-tz-quiet-hours");
    const contactId = await createFixtureContact(workspaceId);

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(`UPDATE contacts SET timezone = $1 WHERE workspace_id = $2 AND id = $3`, [
          CONTACT_TZ,
          workspaceId,
          contactId,
        ]);
        await upsertWorkspaceSendSettings(client, workspaceId, { defaultTimezone: WORKSPACE_TZ });
      })
    );

    // A 120-minute window (60 minutes of slack each side) centered on the
    // contact's CURRENT local minute-of-day in CONTACT_TZ.
    const contactParts = new Intl.DateTimeFormat("en-US", {
      timeZone: CONTACT_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const contactHour = Number(contactParts.find((p) => p.type === "hour")!.value);
    const contactMinute = Number(contactParts.find((p) => p.type === "minute")!.value);
    const localMinutes = contactHour * 60 + contactMinute;
    const quietHoursStart = (localMinutes - 60 + 1440) % 1440;
    const quietHoursEnd = (localMinutes + 60) % 1440;

    const { flowRunId, sendNodeId } = await seedFlowRun(workspaceId, contactId, {});
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE flows SET quiet_hours_mode = 'custom', quiet_hours_start = $1, quiet_hours_end = $2 WHERE id = (SELECT flow_id FROM flow_runs WHERE id = $3)`, [
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
    expect(sendJob, "no send job enqueued -- the contact's own timezone places now inside its quiet window").toBeUndefined();
  });

  it("06-15/D-08/FLOW-05: a wait_until delay computes next_wake_at at the contact's local time-of-day, not the workspace default timezone", async () => {
    const workspaceId = await freshWorkspaceId("flow-advance-contact-tz-wait-until");
    const contactId = await createFixtureContact(workspaceId);

    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        await client.query(`UPDATE contacts SET timezone = $1 WHERE workspace_id = $2 AND id = $3`, [
          CONTACT_TZ,
          workspaceId,
          contactId,
        ]);
        await upsertWorkspaceSendSettings(client, workspaceId, { defaultTimezone: WORKSPACE_TZ });
      })
    );

    const { flowRunId } = await seedDelayFlowRun(workspaceId, contactId, {
      id: "delay-1",
      type: "delay",
      delay: { kind: "wait_until", timeOfDay: 600 },
      position: { x: 0, y: 50 },
    });

    await processFlowRunAdvance({ workspaceId, flowRunId });

    const state = await getFlowRunState(workspaceId, flowRunId);
    const nextWakeAt = new Date(state.nextWakeAt!);

    const contactParts = new Intl.DateTimeFormat("en-US", {
      timeZone: CONTACT_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(nextWakeAt);
    const contactHour = contactParts.find((p) => p.type === "hour")!.value;
    const contactMinute = contactParts.find((p) => p.type === "minute")!.value;
    expect(contactHour).toBe("10");
    expect(contactMinute).toBe("00");

    // Divergence proof: the same instant is NOT 10:00 in the workspace
    // default timezone -- confirms the resolution actually used the
    // contact's own timezone, not the workspace default.
    const workspaceParts = new Intl.DateTimeFormat("en-US", {
      timeZone: WORKSPACE_TZ,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(nextWakeAt);
    const workspaceHour = workspaceParts.find((p) => p.type === "hour")!.value;
    const workspaceMinute = workspaceParts.find((p) => p.type === "minute")!.value;
    expect(`${workspaceHour}:${workspaceMinute}`).not.toBe("10:00");
  });
});
