import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowDefinition } from "@mega-crm/flows-core";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processFlowTriggerCheck } from "../flows/flow-trigger-evaluator.worker.js";
import { flowRunAdvanceQueue } from "../flows/flow-queues.js";

/**
 * `flow-trigger-evaluator.worker.ts`'s `processFlowTriggerCheck`
 * (FLOW-02/FLOW-04, 06-06's overall `<verification>`): a matching event
 * creates exactly one version-pinned run and enqueues an advance; re-entry
 * modes (once_ever/once_per_n_days/every_time) and the one-active-run guard
 * gate re-entry exactly as D-06/D-07 specify; a non-matching event name
 * creates nothing. Invoked directly against real Postgres/Redis (mirrors
 * flow-run-advance.test.ts's convention) -- the resulting
 * `FLOW_RUN_ADVANCE_QUEUE` enqueue is asserted via
 * `flowRunAdvanceQueue.getJob(...)`, never a stubbed dependency.
 */
describe("flow-trigger-evaluator.worker.ts processFlowTriggerCheck (FLOW-02/FLOW-04)", () => {
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
   * Seeds a live event-triggered flow (trigger -> send -> exit) with a
   * given re-entry mode -- kept local to this test file (scenario-specific
   * shape), mirroring flow-run-advance.test.ts's own local `seedFlowRun`.
   */
  async function seedLiveEventFlow(
    workspaceId: string,
    opts: { eventName?: string; reentryMode?: string; reentryWindowDays?: number | null } = {}
  ): Promise<{ flowId: string; flowVersionId: string; sendNodeId: string }> {
    const eventName = opts.eventName ?? "fixture_trigger_event";
    const sendNodeId = "send-1";

    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: flowRows } = await client.query<{ id: string }>(
          `INSERT INTO flows
             (workspace_id, name, status, trigger_type, trigger_event_name, reentry_mode, reentry_window_days, created_by_user_id)
           VALUES ($1, 'Fixture trigger flow', 'live', 'event', $2, $3, $4, 'test-user')
           RETURNING id`,
          [workspaceId, eventName, opts.reentryMode ?? "every_time", opts.reentryWindowDays ?? null]
        );
        const flowId = flowRows[0].id;

        const definition: FlowDefinition = {
          nodes: [
            { id: "trigger-1", type: "trigger", triggerType: "event", eventName, position: { x: 0, y: 0 } },
            {
              id: sendNodeId,
              type: "send",
              templateId: "d-fixture-template",
              fromEmail: "sender@fixture.test",
              position: { x: 0, y: 100 },
            },
            { id: "exit-1", type: "exit", position: { x: 0, y: 200 } },
          ],
          edges: [
            { id: "e1", source: "trigger-1", target: sendNodeId },
            { id: "e2", source: sendNodeId, target: "exit-1" },
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

        return { flowId, flowVersionId, sendNodeId };
      })
    );
  }

  interface FlowRunRow {
    id: string;
    flowVersionId: string;
    status: string;
  }

  async function getFlowRuns(workspaceId: string, flowId: string, contactId: string): Promise<FlowRunRow[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<FlowRunRow>(
          `SELECT id, flow_version_id as "flowVersionId", status
           FROM flow_runs WHERE workspace_id = $1 AND flow_id = $2 AND contact_id = $3`,
          [workspaceId, flowId, contactId]
        );
        return rows;
      })
    );
  }

  async function setLastEntryAt(workspaceId: string, flowRunId: string, lastEntryAt: Date): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(`UPDATE flow_runs SET last_entry_at = $2 WHERE id = $1`, [flowRunId, lastEntryAt])
      )
    );
  }

  async function markRunTerminal(workspaceId: string, flowRunId: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) =>
        client.query(
          `UPDATE flow_runs SET status = 'completed', exited_at = now(), exit_reason = 'reached_exit' WHERE id = $1`,
          [flowRunId]
        )
      )
    );
  }

  it("a live event-triggered flow + a matching event -> exactly one run pinned to live_version_id + an advance job enqueued", async () => {
    const workspaceId = await freshWorkspaceId("flow-trigger-single");
    const contactId = await createFixtureContact(workspaceId);
    const { flowId, flowVersionId } = await seedLiveEventFlow(workspaceId, { eventName: "fixture_trigger_event" });

    await processFlowTriggerCheck({ workspaceId, contactId, eventName: "fixture_trigger_event" });

    const runs = await getFlowRuns(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(1);
    expect(runs[0].flowVersionId).toBe(flowVersionId);
    expect(runs[0].status).toBe("waiting");

    // Located by data.flowRunId, not a fixed jobId (06-12/CR-01 -- jobId is
    // now unique-per-wake, `${flowRunId}-${Date.now()}`).
    const pendingJobs = await flowRunAdvanceQueue.getJobs(["waiting", "delayed", "active", "completed"]);
    const job = pendingJobs.find((j) => j.data?.flowRunId === runs[0].id);
    expect(job).toBeDefined();
    expect(job?.data).toMatchObject({ workspaceId, flowRunId: runs[0].id });
  });

  it("a non-matching event name creates no run", async () => {
    const workspaceId = await freshWorkspaceId("flow-trigger-nomatch");
    const contactId = await createFixtureContact(workspaceId);
    const { flowId } = await seedLiveEventFlow(workspaceId, { eventName: "fixture_trigger_event" });

    await processFlowTriggerCheck({ workspaceId, contactId, eventName: "some_other_event" });

    const runs = await getFlowRuns(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(0);
  });

  it("once_ever: a second matching event after the first run -> no new run", async () => {
    const workspaceId = await freshWorkspaceId("flow-trigger-once-ever");
    const contactId = await createFixtureContact(workspaceId);
    const { flowId } = await seedLiveEventFlow(workspaceId, {
      eventName: "fixture_trigger_event",
      reentryMode: "once_ever",
    });

    await processFlowTriggerCheck({ workspaceId, contactId, eventName: "fixture_trigger_event" });
    let runs = await getFlowRuns(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(1);

    // Terminate the first run so once_ever's active-run guard isn't what's blocking the second attempt.
    await markRunTerminal(workspaceId, runs[0].id);

    await processFlowTriggerCheck({ workspaceId, contactId, eventName: "fixture_trigger_event" });
    runs = await getFlowRuns(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(1); // once_ever: no second entry, ever
  });

  it("once_per_n_days (N=7): a second event within the window -> no new run; after 7 days -> a new run", async () => {
    const workspaceId = await freshWorkspaceId("flow-trigger-once-per-n");
    const contactId = await createFixtureContact(workspaceId);
    const { flowId } = await seedLiveEventFlow(workspaceId, {
      eventName: "fixture_trigger_event",
      reentryMode: "once_per_n_days",
      reentryWindowDays: 7,
    });

    await processFlowTriggerCheck({ workspaceId, contactId, eventName: "fixture_trigger_event" });
    let runs = await getFlowRuns(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(1);
    await markRunTerminal(workspaceId, runs[0].id);

    // Within the 7-day window (last_entry_at 1 day ago) -- blocked.
    await setLastEntryAt(workspaceId, runs[0].id, new Date(Date.now() - 1 * 24 * 60 * 60 * 1000));
    await processFlowTriggerCheck({ workspaceId, contactId, eventName: "fixture_trigger_event" });
    runs = await getFlowRuns(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(1); // still just the one run -- blocked within the window

    // Outside the 7-day window (last_entry_at 8 days ago) -- allowed.
    await setLastEntryAt(workspaceId, runs[0].id, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
    await processFlowTriggerCheck({ workspaceId, contactId, eventName: "fixture_trigger_event" });
    runs = await getFlowRuns(workspaceId, flowId, contactId);
    expect(runs).toHaveLength(2); // a new run created past the window
  });

  it("one-active-run: two concurrent matching events while a run is active -> exactly one active run", async () => {
    const workspaceId = await freshWorkspaceId("flow-trigger-active-run");
    const contactId = await createFixtureContact(workspaceId);
    const { flowId } = await seedLiveEventFlow(workspaceId, {
      eventName: "fixture_trigger_event",
      reentryMode: "every_time",
    });

    // Two "concurrent" triggers for the same contact x flow, run sequentially
    // (the DB-level ON CONFLICT DO NOTHING backstop is what's under test here,
    // not real process concurrency) -- the second must be a no-op while the
    // first run is still active (waiting/advancing).
    await Promise.all([
      processFlowTriggerCheck({ workspaceId, contactId, eventName: "fixture_trigger_event" }),
      processFlowTriggerCheck({ workspaceId, contactId, eventName: "fixture_trigger_event" }),
    ]);

    const runs = await getFlowRuns(workspaceId, flowId, contactId);
    const activeRuns = runs.filter((run) => run.status === "waiting" || run.status === "advancing");
    expect(activeRuns).toHaveLength(1);
  });
});
