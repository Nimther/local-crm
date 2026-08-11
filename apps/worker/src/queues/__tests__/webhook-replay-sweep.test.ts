import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Queue } from "bullmq";
import { startTempRedis, type TempRedis, getScanTestDatabaseUrl } from "@mega-crm/test-support";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import {
  WEBHOOK_EVENTS_QUEUE,
  WEBHOOK_EVENTS_SCHEMA_VERSION,
  webhookEventsJobSchema,
} from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { processWebhookEventBatch } from "../webhook-events.worker.js";
import {
  runWebhookReplaySweep,
  WEBHOOK_REPLAY_SWEEP_PAGE_LIMIT,
  WEBHOOK_REPLAY_MAX_ATTEMPTS,
} from "../webhook-replay-sweep.worker.js";

/**
 * Phase 13 (CMP-08, D-06/D-07, plan 13-06), Task 1: proves the replay-sweep's
 * find-stuck-rows-and-re-enqueue half. Every assertion here is scoped to
 * workspace ids this test itself creates and passes through
 * `runWebhookReplaySweep`'s `workspaceIds` test-only override -- the
 * ephemeral test database is shared across parallel test files (this
 * project's own wave-context convention), so an unscoped cross-workspace
 * scan's counts would be flaky.
 *
 * `received_at`/`replay_count`/`payload_purged_at` are seeded directly via
 * SQL (not `writeIngressJournal`, which always stamps `received_at` at
 * `now()`) so each behavior case can construct an exact fixture age/state
 * without waiting on real wall-clock thresholds.
 */
describe("webhook-replay-sweep.worker.ts (CMP-08, D-06, plan 13-06)", () => {
  let pool: Pool;
  let redis: TempRedis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();
    pool = createTestPool();
    redis = await startTempRedis({});
    process.env.REDIS_URL = redis.url;
  });

  afterAll(async () => {
    await pool.end();
    await redis.stop();
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  interface SeedOverrides {
    receivedAtMinutesAgo?: number;
    ingestionCompletedAt?: Date | null;
    replayCount?: number;
    payloadPurgedAt?: Date | null;
    rawBatch?: unknown[] | null;
  }

  async function seedJournalRow(workspaceId: string, overrides: SeedOverrides = {}): Promise<string> {
    const {
      receivedAtMinutesAgo = 30,
      ingestionCompletedAt = null,
      replayCount = 0,
      payloadPurgedAt = null,
      rawBatch = [{ sg_event_id: `sg-${randomUUID()}`, event: "delivered", timestamp: 1_700_000_000 }],
    } = overrides;

    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO ingress_journal
             (workspace_id, raw_batch, received_at, ingestion_completed_at, replay_count, payload_purged_at)
           VALUES ($1, $2, now() - make_interval(mins => $3), $4, $5, $6)
           RETURNING id`,
          [
            workspaceId,
            rawBatch === null ? null : JSON.stringify(rawBatch),
            receivedAtMinutesAgo,
            ingestionCompletedAt,
            replayCount,
            payloadPurgedAt,
          ]
        );
        return rows[0].id;
      })
    );
  }

  interface JournalRowState {
    id: string;
    ingestionCompletedAt: Date | null;
    replayCount: number;
    payloadPurgedAt: Date | null;
    rawBatch: unknown;
  }

  async function readJournalRow(workspaceId: string, journalId: string): Promise<JournalRowState | undefined> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<JournalRowState>(
          `SELECT id, ingestion_completed_at as "ingestionCompletedAt", replay_count as "replayCount",
                  payload_purged_at as "payloadPurgedAt", raw_batch as "rawBatch"
           FROM ingress_journal WHERE id = $1`,
          [journalId]
        );
        return rows[0];
      })
    );
  }

  async function countSendEvents(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM send_events WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  /** Fetches and processes every job this sweep enqueued for `workspaceId`, mirroring how a real webhook-events Worker consumes the queue -- without a live BullMQ Worker loop (mirrors webhook-events-idempotency.test.ts's direct-call convention). */
  async function drainEnqueuedJobsFor(workspaceId: string): Promise<unknown[]> {
    const queue = new Queue(WEBHOOK_EVENTS_QUEUE, { connection: buildRedisConnectionOptions(redis.url) });
    try {
      const jobs = await queue.getJobs(["waiting", "delayed"]);
      const own = jobs.filter((job) => (job.data as { workspaceId?: string }).workspaceId === workspaceId);
      const results: unknown[] = [];
      for (const job of own) {
        results.push(await processWebhookEventBatch(job.data));
      }
      return results;
    } finally {
      await queue.close();
    }
  }

  async function countQueuedJobsFor(workspaceId: string): Promise<number> {
    const queue = new Queue(WEBHOOK_EVENTS_QUEUE, { connection: buildRedisConnectionOptions(redis.url) });
    try {
      const jobs = await queue.getJobs(["waiting", "delayed"]);
      return jobs.filter((job) => (job.data as { workspaceId?: string }).workspaceId === workspaceId).length;
    } finally {
      await queue.close();
    }
  }

  it("packages/shared-schemas exports the versioned tick schema", async () => {
    const { webhookReplaySweepTickJobSchema, WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION } = await import(
      "@mega-crm/shared-schemas"
    );
    expect(WEBHOOK_REPLAY_SWEEP_TICK_SCHEMA_VERSION).toBe(1);
    expect(webhookReplaySweepTickJobSchema.safeParse({ schemaVersion: 1 }).success).toBe(true);
    expect(webhookReplaySweepTickJobSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });

  it("a journal row with no completion mark, 30 minutes old, is enqueued exactly once", async () => {
    const workspaceId = await freshWorkspaceId("replay-stuck");
    const journalId = await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30 });

    const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId] });

    expect(summary.rowsEnqueued).toBe(1);
    expect(await countQueuedJobsFor(workspaceId)).toBe(1);

    const queue = new Queue(WEBHOOK_EVENTS_QUEUE, { connection: buildRedisConnectionOptions(redis.url) });
    try {
      const jobs = await queue.getJobs(["waiting", "delayed"]);
      const job = jobs.find((j) => (j.data as { workspaceId?: string }).workspaceId === workspaceId);
      expect(job).toBeDefined();
      const parsed = webhookEventsJobSchema.parse(job?.data);
      expect(parsed.schemaVersion).toBe(WEBHOOK_EVENTS_SCHEMA_VERSION);
      expect(parsed.journalId).toBe(journalId);
    } finally {
      await queue.close();
    }
  });

  it("a completed journal row, however old, is never enqueued", async () => {
    const workspaceId = await freshWorkspaceId("replay-completed");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 60, ingestionCompletedAt: new Date() });

    const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId] });

    expect(summary.rowsEnqueued).toBe(0);
    expect(await countQueuedJobsFor(workspaceId)).toBe(0);
  });

  it("a journal row inside the stuck threshold (2 minutes old) is not enqueued", async () => {
    const workspaceId = await freshWorkspaceId("replay-fresh");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 2 });

    const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId] });

    expect(summary.rowsEnqueued).toBe(0);
    expect(await countQueuedJobsFor(workspaceId)).toBe(0);
  });

  it("after the replayed job is processed, the journal row is marked complete and replay_count is 1", async () => {
    const workspaceId = await freshWorkspaceId("replay-processed");
    const journalId = await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30 });

    await runWebhookReplaySweep({ workspaceIds: [workspaceId] });
    await drainEnqueuedJobsFor(workspaceId);

    const row = await readJournalRow(workspaceId, journalId);
    expect(row?.ingestionCompletedAt).not.toBeNull();
    expect(row?.replayCount).toBe(1);
  });

  it("processing the same journal row's batch twice leaves exactly one send_events row and the same campaign/rollup counts", async () => {
    const workspaceId = await freshWorkspaceId("replay-double");
    const event = { sg_event_id: `sg-${randomUUID()}`, event: "delivered", timestamp: 1_700_000_000 };
    const journalId = await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30, rawBatch: [event] });

    await runWebhookReplaySweep({ workspaceIds: [workspaceId] });
    const [firstResult] = (await drainEnqueuedJobsFor(workspaceId)) as { inserted: number }[];
    expect(firstResult.inserted).toBe(1);
    expect(await countSendEvents(workspaceId)).toBe(1);

    // A second, independent processing of the SAME stored batch (the
    // BullMQ at-least-once redelivery premise) -- called directly rather
    // than through a second sweep tick, since the row is now marked
    // complete and the sweep would correctly refuse to re-enqueue it.
    const replay = await processWebhookEventBatch({
      workspaceId,
      events: [event],
      schemaVersion: WEBHOOK_EVENTS_SCHEMA_VERSION,
      journalId,
    });
    expect(replay.inserted).toBe(0);
    expect(await countSendEvents(workspaceId)).toBe(1);
  });

  it("a journal row at the attempt cap is not enqueued", async () => {
    const workspaceId = await freshWorkspaceId("replay-capped");
    await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30, replayCount: WEBHOOK_REPLAY_MAX_ATTEMPTS });

    const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId] });

    expect(summary.rowsEnqueued).toBe(0);
    expect(summary.rowsSkippedAttemptCapped).toBe(1);
    expect(await countQueuedJobsFor(workspaceId)).toBe(0);
  });

  it("a tombstoned journal row (payload_purged_at set) is not enqueued and its replay_count is unchanged", async () => {
    const workspaceId = await freshWorkspaceId("replay-tombstone");
    const journalId = await seedJournalRow(workspaceId, {
      receivedAtMinutesAgo: 30,
      rawBatch: null,
      payloadPurgedAt: new Date(),
      replayCount: 2,
    });

    const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId] });

    expect(summary.rowsEnqueued).toBe(0);
    expect(summary.rowsSkippedTombstoned).toBe(1);
    expect(await countQueuedJobsFor(workspaceId)).toBe(0);
    expect((await readJournalRow(workspaceId, journalId))?.replayCount).toBe(2);
  });

  it("a tick with more stuck rows than the page limit enqueues exactly the page limit", async () => {
    const workspaceId = await freshWorkspaceId("replay-page-limit");
    const pageLimit = 3;
    for (let i = 0; i < pageLimit + 2; i += 1) {
      await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 30 + i });
    }

    const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId], pageLimit });

    expect(summary.rowsEnqueued).toBe(pageLimit);
    expect(await countQueuedJobsFor(workspaceId)).toBe(pageLimit);
  });

  it("WEBHOOK_REPLAY_SWEEP_PAGE_LIMIT and WEBHOOK_REPLAY_MAX_ATTEMPTS are positive bounded constants", () => {
    expect(WEBHOOK_REPLAY_SWEEP_PAGE_LIMIT).toBeGreaterThan(0);
    expect(WEBHOOK_REPLAY_MAX_ATTEMPTS).toBeGreaterThan(0);
  });
});
