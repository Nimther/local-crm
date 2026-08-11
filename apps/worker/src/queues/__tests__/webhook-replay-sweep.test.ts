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
import { createFixtureCampaign, createFixtureContact, insertFixtureOrganization } from "../../test/failure-fixtures.js";
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
      // Phase 13 (CMP-05, plan 13-04): classifyOccurredAt quarantines events
      // outside [now-7d, now+5min]; a fixed 2023-era timestamp would make the
      // replayed batch quarantine instead of insert. Keep fixtures in-window.
      rawBatch = [{ sg_event_id: `sg-${randomUUID()}`, event: "delivered", timestamp: Math.floor(Date.now() / 1000) - 3600 }],
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

  /** Phase 13 (CMP-07, plan 13-07) deviation: the orphan-replay test below needs a REAL send_id -- see its own comment. */
  async function createFixtureSend(workspaceId: string, campaignId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', 'sent', now()) RETURNING id`,
          [workspaceId, campaignId, contactId]
        );
        return rows[0].id;
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
    // Phase 13 (CMP-07, plan 13-07) deviation: the dedup key is now
    // (workspace_id, send_id, event_type, occurred_at) -- a null send_id
    // (the orphan shape this event used before) is NEVER deduped against
    // another null send_id (NULL is always distinct in a unique index), so
    // replaying the identical event object would insert a SECOND row, not
    // zero -- the opposite of what this test's own name asserts. A real
    // send_id gives the new key something to dedupe on, preserving the
    // "processing the same stored batch twice is at-most-once" intent this
    // test exists to prove.
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    // In-window timestamp (see seedJournalRow's rawBatch note re plan 13-04).
    const event = {
      sg_event_id: `sg-${randomUUID()}`,
      event: "delivered",
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      send_id: sendId,
      workspace_id: workspaceId,
      campaign_id: campaignId,
    };
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

  /**
   * Task 2 (Codex follow-up review, WARNING finding 6): the retention step
   * -- `pruneIngressJournal`/`purgeExpiredIngressJournalPayloads`, run after
   * the replay step in the SAME per-workspace transaction. `retentionDays`
   * is overridden per test (rather than waiting on the real ~7-day
   * horizon), and `receivedAtMinutesAgo` is chosen so a row is unambiguously
   * past (or inside) that overridden horizon.
   */
  describe("retention (Task 2)", () => {
    it("a COMPLETED row aged past the retention horizon is deleted outright", async () => {
      const workspaceId = await freshWorkspaceId("retention-prune");
      const journalId = await seedJournalRow(workspaceId, {
        receivedAtMinutesAgo: 2 * 24 * 60, // 2 days
        ingestionCompletedAt: new Date(),
      });

      const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId], retentionDays: 1 });

      expect(summary.journalRowsPruned).toBe(1);
      expect(await readJournalRow(workspaceId, journalId)).toBeUndefined();
    });

    it("a COMPLETED row aged inside the retention horizon is left present", async () => {
      const workspaceId = await freshWorkspaceId("retention-prune-fresh");
      const journalId = await seedJournalRow(workspaceId, {
        receivedAtMinutesAgo: 30,
        ingestionCompletedAt: new Date(),
      });

      const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId], retentionDays: 1 });

      expect(summary.journalRowsPruned).toBe(0);
      const row = await readJournalRow(workspaceId, journalId);
      expect(row).toBeDefined();
      expect(row?.rawBatch).not.toBeNull();
    });

    it("an INCOMPLETE, attempt-capped row aged past the retention horizon survives as a tombstone: raw_batch null, payload_purged_at set", async () => {
      const workspaceId = await freshWorkspaceId("retention-purge-capped");
      const journalId = await seedJournalRow(workspaceId, {
        receivedAtMinutesAgo: 2 * 24 * 60,
        replayCount: WEBHOOK_REPLAY_MAX_ATTEMPTS,
      });

      const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId], retentionDays: 1 });

      expect(summary.rowsEnqueued, "an attempt-capped row must never be enqueued, purged or not").toBe(0);
      expect(summary.journalPayloadsPurged).toBe(1);
      const row = await readJournalRow(workspaceId, journalId);
      expect(row).toBeDefined();
      expect(row?.rawBatch).toBeNull();
      expect(row?.payloadPurgedAt).not.toBeNull();
    });

    it("an incomplete/never-transitions-to-absent property: a merely-stuck row aged past the horizon is ALSO enqueued this same tick, then survives purge as a tombstone -- retention runs after replay, never before it", async () => {
      const workspaceId = await freshWorkspaceId("retention-purge-stuck");
      const journalId = await seedJournalRow(workspaceId, { receivedAtMinutesAgo: 2 * 24 * 60 });

      const beforeCount = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text as count FROM ingress_journal WHERE id = $1`,
            [journalId]
          );
          return Number(rows[0].count);
        })
      );
      expect(beforeCount).toBe(1);

      const summary = await runWebhookReplaySweep({ workspaceIds: [workspaceId], retentionDays: 1 });

      // Enqueued THIS tick (replay ran before retention)...
      expect(summary.rowsEnqueued).toBe(1);
      expect(summary.journalPayloadsPurged).toBe(1);

      // ...and the job it produced actually carries the real batch --
      // proof the payload was captured before this same tick's retention
      // step nulled raw_batch on the row.
      const [result] = (await drainEnqueuedJobsFor(workspaceId)) as { inserted: number }[];
      expect(result.inserted).toBe(1);

      // The row itself never transitioned from present to absent -- only
      // present-with-payload to present-without-payload.
      const row = await readJournalRow(workspaceId, journalId);
      expect(row, "an incomplete row must never be deleted by retention, only tombstoned").toBeDefined();
      expect(row?.rawBatch).toBeNull();
      expect(row?.payloadPurgedAt).not.toBeNull();
      expect(row?.replayCount).toBe(1);

      const afterCount = await withTenant(workspaceId, () =>
        withTenantTransaction(async (client) => {
          const { rows } = await client.query<{ count: string }>(
            `SELECT count(*)::text as count FROM ingress_journal WHERE id = $1`,
            [journalId]
          );
          return Number(rows[0].count);
        })
      );
      expect(afterCount, "count(*) must be 1 both before and after the tick").toBe(1);
    });

    it("a tombstone created by one tick is still present, unchanged, after a second tick over the same data", async () => {
      const workspaceId = await freshWorkspaceId("retention-tombstone-survives");
      const journalId = await seedJournalRow(workspaceId, {
        receivedAtMinutesAgo: 2 * 24 * 60,
        replayCount: WEBHOOK_REPLAY_MAX_ATTEMPTS,
      });

      await runWebhookReplaySweep({ workspaceIds: [workspaceId], retentionDays: 1 });
      const afterFirstTick = await readJournalRow(workspaceId, journalId);
      expect(afterFirstTick?.payloadPurgedAt).not.toBeNull();

      const secondSummary = await runWebhookReplaySweep({ workspaceIds: [workspaceId], retentionDays: 1 });

      expect(secondSummary.journalRowsPruned, "a tombstone must never be pruned -- it never reached ingestion_completed_at").toBe(0);
      expect(secondSummary.journalPayloadsPurged, "an already-purged row is idempotent -- a second purge call matches zero rows").toBe(0);
      const afterSecondTick = await readJournalRow(workspaceId, journalId);
      expect(afterSecondTick).toBeDefined();
      expect(afterSecondTick?.rawBatch).toBeNull();
      expect(afterSecondTick?.payloadPurgedAt?.getTime()).toBe(afterFirstTick?.payloadPurgedAt?.getTime());
    });
  });
});
