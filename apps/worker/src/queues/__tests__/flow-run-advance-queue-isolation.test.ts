import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Worker } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import type { FlowRunAdvanceJob } from "@mega-crm/shared-schemas";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { createTestPool, createFixtureFlowRun, ensureTestDbMigrated, getTestDatabaseUrl } from "../../test/db-fixture.js";
import { createFixtureContact, insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { createFlowRunAdvanceWorker } from "../flows/flow-run-advance.worker.js";
import { enqueueFlowRunAdvance, flowRunAdvanceQueue } from "../flows/flow-queues.js";
import { isolateFlowRunAdvanceQueueForTest } from "../../test/queue-fixture.js";

/**
 * Debug session `flow-run-advance-shared-redis`: the regression gate for the
 * load-dependent flake in `flow-run-advance-integration.test.ts`.
 *
 * THE ASYMMETRY THIS FILE PINS DOWN. Postgres is per-run ephemeral (the
 * `globalSetup` guard in packages/test-support provisions and drops a fresh
 * database every run). Redis is NOT: every worker/api test process points at
 * ONE shared logical DB (`redis://localhost:6379/1`,
 * `apps/worker/vitest.base.config.ts`), with no per-run BullMQ `prefix` and
 * no cleanup anywhere in the harness. So BullMQ jobs enqueued by one run
 * survive into the next one, forever.
 *
 * For every queue except this one that residue is inert dead weight, because
 * the worker suite contains no consumer for it (measured 2026-08-28 on a
 * developer machine: 21973 waiting `webhook-events` jobs, 3180
 * `flow-trigger-evaluator`, 2911 `email-triggered`, 2881 `erasure-scrub`,
 * ... none of them ever consumed or cleaned).
 *
 * `flow-run-advance` is the ONE exception: `flow-run-advance-integration.test.ts`
 * registers a REAL BullMQ `Worker` on it -- the only real consumer in the
 * whole suite -- with BullMQ's DEFAULT concurrency of 1
 * (`createFlowRunAdvanceWorker` passes `{ connection }` and nothing else).
 * That turns residue from dead weight into WORK: every foreign job ahead of
 * the test's own job in the FIFO wait list costs one serial
 * `withTenantTransaction` round trip (measured: 2.15 ms/job on an idle
 * machine) before the test's own hop can even start -- and the test's budget
 * is a 10s `waitFor`. 752 foreign waiting jobs were observed on that queue
 * before this session drained them; the intra-run contribution from the
 * sibling producer files is only ~17, so the dominant term is cross-run
 * accumulation, which is unbounded.
 *
 * Hence the flake signature: passes in isolation (small backlog, idle
 * machine, 1.6s of drain), fails under full-suite load (bigger backlog, and
 * 3-10x the per-job cost under v8 coverage instrumentation + concurrent
 * Postgres load) -- the exact "isolation-pass" pattern recorded in the
 * project's flake notes.
 */

/**
 * Sized from the measured drain rate, not guessed: 2.15 ms/job on an idle
 * machine means ~4650 foreign jobs are enough to exhaust a 10s `waitFor`
 * budget. 12000 is a ~2.6x margin over that threshold, so the RED state is
 * deterministic on an idle developer machine and not merely likely under
 * load. Once the harness isolates the queue before starting the Worker, the
 * seeds are removed before the Worker exists and the cost is ~0 regardless
 * of this number.
 */
const RESIDUE_JOBS = 12_000;

/** The budget `flow-run-advance-integration.test.ts` actually gives each of its hops. */
const HOP_BUDGET_MS = 10_000;

describe("flow-run-advance: shared-Redis queue isolation", () => {
  let pool: Pool;
  let worker: Worker<FlowRunAdvanceJob>;
  let waitingCountAtWorkerStart: number;
  let residueRemoved: number;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();

    // Establishes a known baseline so RESIDUE_JOBS below is the EXACT depth
    // this file seeds. This is deliberately NOT the isolation step under
    // test: it runs BEFORE the residue is seeded, whereas the harness
    // isolation this file asserts must run AFTER anything a previous run (or
    // a sibling file) left behind and before the Worker is constructed.
    await flowRunAdvanceQueue.drain(true);

    // Stands in for what a previous run leaves on the shared logical DB:
    // schema-valid advance payloads (`flowRunAdvanceJobSchema` = two uuids)
    // whose runs do not exist in THIS run's ephemeral database. That is the
    // exact shape real residue has, and it takes the same fast no-op code
    // path through `processFlowRunAdvance` (`loadDueFlowRun` returns null) --
    // NOT the retry/backoff/dead-letter path a malformed payload would take.
    for (let offset = 0; offset < RESIDUE_JOBS; offset += 2_000) {
      const batch = Array.from({ length: Math.min(2_000, RESIDUE_JOBS - offset) }, () => {
        const flowRunId = randomUUID();
        return {
          name: "advance",
          data: { workspaceId: randomUUID(), flowRunId },
          opts: { jobId: `${flowRunId}-${Date.now()}` },
        };
      });
      await flowRunAdvanceQueue.addBulk(batch);
    }

    // THE FIX UNDER TEST. The shared harness seam every file that starts a
    // real Worker on this queue must call, immediately before constructing it:
    // whatever a previous run or a sibling file left on the shared logical DB
    // is removed at the one instant that matters. The `RESIDUE_JOBS` seeded
    // above stand in for that residue, so this call is what takes the depth
    // sampled below from 12000 to 0.
    residueRemoved = await isolateFlowRunAdvanceQueueForTest();

    // Sampled at the ONE instant that matters -- immediately before the real
    // Worker starts consuming, which is the point at which foreign backlog
    // becomes this suite's own serial workload.
    waitingCountAtWorkerStart = await flowRunAdvanceQueue.getWaitingCount();

    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error("REDIS_URL is required for the flow-run-advance queue-isolation test (see vitest.base.config.ts)");
    }
    worker = createFlowRunAdvanceWorker(buildRedisConnectionOptions(redisUrl));
  }, 120_000);

  afterAll(async () => {
    // Unconditional, and in this order: the Worker has to stop consuming
    // before the queue is emptied, and the queue MUST be emptied whether this
    // file passed or failed. A failing run aborts mid-drain, and leaving
    // 12000 seeded jobs behind on the shared logical DB would manufacture
    // exactly the cross-run residue this file exists to diagnose -- poisoning
    // every subsequent run, including this file's own next execution.
    await worker?.close();
    await flowRunAdvanceQueue.drain(true);
    await pool?.end();
  });

  it("the real Worker starts on a queue with no foreign jobs on it", () => {
    // The clock-free half of the guarantee: whatever a previous run or a
    // sibling file left on the shared queue must be gone BEFORE this suite's
    // Worker is constructed. Deterministic -- no timing, no load dependence.
    expect(
      waitingCountAtWorkerStart,
      "foreign jobs left on the shared flow-run-advance queue are inherited as this suite's own serial workload"
    ).toBe(0);

    // Guards the assertion above against passing VACUOUSLY. A depth of 0 is
    // the right answer for two very different reasons -- the seam removed the
    // residue, or the seed loop silently enqueued nothing at all -- and only
    // the first one is evidence. So assert the seam reported removing the full
    // seeded depth: at least `RESIDUE_JOBS`, and possibly a few more if a
    // sibling file or a previous run left extra behind, which is exactly what
    // the seam is for.
    expect(
      residueRemoved,
      "the isolation seam actually removed the seeded residue (a vacuous 0 above would mean the seed loop no-opped)"
    ).toBeGreaterThanOrEqual(RESIDUE_JOBS);
  });

  it("advances its own run within the same 10s budget the integration suite uses, with residue present", async () => {
    const workspaceId = await insertFixtureOrganization("flow-adv-queue-isolation");
    const contactId = await createFixtureContact(workspaceId);
    const { flowRunId, nodeId } = await createFixtureFlowRun(workspaceId, contactId);

    await enqueueFlowRunAdvance({ workspaceId, flowRunId });

    // The symptom-level half: the run's single send hop (dead-end send node ->
    // terminal `completed`) must land inside the budget. Under the unisolated
    // harness this times out, because the job is queued BEHIND every foreign
    // job at concurrency 1.
    const deadline = Date.now() + HOP_BUDGET_MS;
    for (;;) {
      const status = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ status: string }>(
            `SELECT status FROM flow_runs WHERE id = $1`,
            [flowRunId]
          );
          return rows[0]?.status;
        })
      );
      if (status === "completed") break;
      if (Date.now() > deadline) {
        const waiting = await flowRunAdvanceQueue.getWaitingCount();
        throw new Error(
          `waitFor: flow run did not reach 'completed' within ${HOP_BUDGET_MS}ms ` +
            `(status=${status}, foreign jobs still queued ahead of it=${waiting}, node=${nodeId})`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 60_000);
});
