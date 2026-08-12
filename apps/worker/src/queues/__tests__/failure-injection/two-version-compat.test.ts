import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { Queue } from "bullmq";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { WEBHOOK_EVENTS_QUEUE, WEBHOOK_EVENTS_SCHEMA_VERSION, type WebhookEventsJob } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../../test/db-fixture.js";
import { createFixtureCampaign, createFixtureContact, insertFixtureOrganization } from "../../../test/failure-fixtures.js";
import { createWebhookEventsWorker } from "../../webhook-events.worker.js";

/**
 * Phase 14 plan 07, Task 2 -- R-05's deploy-safety contract, both directions:
 * "a rolling deploy can have an old-code worker still draining jobs enqueued
 * by new code (or vice versa)" (ROADMAP.md § Sequencing Decisions R-05,
 * "do not drop it").
 *
 * Reproduce with `npm run failure:two-version-compat` from the repo root.
 *
 * FIVE workers in this codebase gate a versioned job payload the same way
 * (validate with `safeParse` against a schema whose `schemaVersion` is a
 * `z.literal`, defer -- log via `scrubbedConsole`, return without ever
 * calling the business-logic function, never throw -- on any parse failure
 * whose every issue path is `schemaVersion`): `webhook-events.worker.ts`,
 * `send-reconciler.worker.ts`, `webhook-replay-sweep.worker.ts`,
 * `reputation-tick.worker.ts`, `erasure-scrub.worker.ts` (each worker's own
 * doc comment above its `createXWorker` function states this explicitly and
 * cross-references the others -- confirmed by reading all five before
 * writing this file, per the plan's own instruction).
 *
 * This scenario exercises `webhook-events.worker.ts`'s gate specifically,
 * for one reason the other four do not share: of the five,
 * `webhookEventsJobSchema` is the ONLY one whose `schemaVersion` field is
 * `.optional()` (`packages/shared-schemas/src/queues.ts`) rather than a bare
 * required `z.literal`. The other four introduced `schemaVersion` as a
 * REQUIRED field from their very first shipped version -- there was never a
 * payload shape that predates it, so there is no genuine "previous form" to
 * enqueue for direction two below; testing them would mean enqueuing the
 * SAME shape twice under two names. `webhook-events.worker.ts` alone carries
 * real history: a payload enqueued by pre-Phase-13 code has NEITHER
 * `schemaVersion` nor `journalId` at all (the schema's own doc comment,
 * `packages/shared-schemas/src/queues.ts` lines ~273-286), and that legacy
 * shape must still be processed to completion today. That makes it the one
 * queue where R-05's overlap can be proven against two ACTUALLY DISTINCT
 * payload shapes, not the same shape relabelled.
 *
 * Drives a REAL BullMQ `Queue`/`Worker` pair (`createWebhookEventsWorker`,
 * the actual production factory registered in `apps/worker/src/server.ts`)
 * against a throwaway `startTempRedis()` instance -- mirrors
 * `webhook-replay-sweep.test.ts`'s own precedent for constructing a real
 * Queue against `WEBHOOK_EVENTS_QUEUE` (a fixed, non-namespaced queue name)
 * without contending with any other test file's shared Redis DB.
 *
 * Version constants (`WEBHOOK_EVENTS_SCHEMA_VERSION`) come from the real
 * exported source, never an invented literal -- the assertion is about the
 * gate's behavior at the actual boundary the next deploy will cross.
 */
describe("failure injection: webhook-events worker meets an unrecognized schemaVersion, both directions (R-05)", () => {
  let pool: Pool;
  let redis: TempRedis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
    redis = await startTempRedis({});
  });

  afterAll(async () => {
    await pool.end();
    await redis.stop();
  });

  function connection(): ReturnType<typeof buildRedisConnectionOptions> {
    return buildRedisConnectionOptions(redis.url);
  }

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    return insertFixtureOrganization(nameSeed);
  }

  async function createFixtureSend(workspaceId: string, campaignId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', 'sent', now()) RETURNING id`,
          [workspaceId, campaignId, contactId],
        );
        return rows[0].id;
      }),
    );
  }

  async function countSendEvents(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM send_events WHERE workspace_id = $1`,
          [workspaceId],
        );
        return Number(rows[0].count);
      }),
    );
  }

  // In-window (classifyOccurredAt's [now-7d, now+5min]) so every event below
  // extracts and inserts rather than quarantining -- CMP-05's bound is not
  // what this scenario is testing.
  const FIXED_TIMESTAMP = Math.floor(Date.now() / 1000) - 3600;

  function flattenedSendgridEvent(sendId: string) {
    return {
      email: "hello@fixture.test",
      event: "delivered",
      sg_event_id: `sg-${randomUUID()}`,
      sg_message_id: "abc.filterdrecv-x",
      timestamp: FIXED_TIMESTAMP,
      send_id: sendId,
    };
  }

  async function arrangeWorkspaceWithSend(nameSeed: string): Promise<{
    workspaceId: string;
    campaignId: string;
    sendId: string;
  }> {
    const workspaceId = await freshWorkspaceId(nameSeed);
    const campaignId = await createFixtureCampaign(workspaceId);
    const contactId = await createFixtureContact(workspaceId);
    const sendId = await createFixtureSend(workspaceId, campaignId, contactId);
    return { workspaceId, campaignId, sendId };
  }

  it(
    "an unrecognized-version job is deferred (not processed, not failed); a recognized job and a legacy pre-versioned job interleaved with it both complete",
    async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const recognized = await arrangeWorkspaceWithSend("two-version-recognized");
      const legacy = await arrangeWorkspaceWithSend("two-version-legacy");
      const unrecognized = await arrangeWorkspaceWithSend("two-version-unrecognized");

      const queue = new Queue<WebhookEventsJob>(WEBHOOK_EVENTS_QUEUE, { connection: connection() });
      const worker = createWebhookEventsWorker(connection());

      try {
        // Interleaved, not grouped -- the unrecognized job sits BETWEEN the
        // two that must complete, so a deferral that stalled the queue would
        // show up as the recognized/legacy jobs never reaching 'completed',
        // not merely as a slow drain.

        // Direction one (R-05): the running worker meets a payload ONE
        // GREATER than its own recognized version. Never invented -- derived
        // from the real exported constant. `as WebhookEventsJob` is required
        // here (unlike the recognized/legacy jobs below): `schemaVersion`'s
        // real type is the literal `1`, and `Queue<WebhookEventsJob>.add`
        // enforces that literal at the call site -- the whole point of this
        // job is to carry a value that literal type does NOT admit.
        const unrecognizedJob = await queue.add("webhook-events", {
          workspaceId: unrecognized.workspaceId,
          events: [flattenedSendgridEvent(unrecognized.sendId)],
          schemaVersion: WEBHOOK_EVENTS_SCHEMA_VERSION + 1,
        } as WebhookEventsJob);

        const recognizedJob = await queue.add("webhook-events", {
          workspaceId: recognized.workspaceId,
          events: [flattenedSendgridEvent(recognized.sendId)],
          schemaVersion: WEBHOOK_EVENTS_SCHEMA_VERSION,
        });

        // Direction two (R-05): the CURRENT worker meets the PREVIOUS
        // recognized form -- here, literally the pre-Phase-13 shape with
        // neither `schemaVersion` nor `journalId` at all. Both fields are
        // `.optional()` on `webhookEventsJobSchema` precisely so a payload
        // that omits them entirely is still valid, so no cast is needed here.
        const legacyJob = await queue.add("webhook-events", {
          workspaceId: legacy.workspaceId,
          events: [flattenedSendgridEvent(legacy.sendId)],
        });

        // Poll until every job has reached a TERMINAL BullMQ state
        // (completed or failed) -- summed across every queue state at each
        // poll, not read off `completed` alone: the exact G-12-3 lesson
        // STATE.md records is that a queue nothing consumes leaves jobs in
        // states a `completed`-only assertion never sees, silently passing
        // or failing for the wrong reason. Summing here means a job stuck in
        // `waiting`/`active`/`delayed` keeps the loop running (and eventually
        // times out loudly) rather than a bare `completed === 3` wrongly
        // reporting success while a fourth, unaccounted-for state exists.
        const settleDeadline = Date.now() + 20_000;
        let finalCounts = await queue.getJobCounts("waiting", "active", "delayed", "completed", "failed");
        for (;;) {
          finalCounts = await queue.getJobCounts("waiting", "active", "delayed", "completed", "failed");
          const total = finalCounts.waiting + finalCounts.active + finalCounts.delayed + finalCounts.completed + finalCounts.failed;
          if (total !== 3) {
            throw new Error(`two-version-compat: expected exactly 3 jobs across all states, saw ${String(total)} (counts: ${JSON.stringify(finalCounts)})`);
          }
          if (finalCounts.completed + finalCounts.failed === 3) break;
          if (Date.now() > settleDeadline) {
            throw new Error(`two-version-compat: jobs did not reach a terminal state within 20s (counts: ${JSON.stringify(finalCounts)})`);
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(finalCounts.failed, "an unrecognized schemaVersion must never be marked failed -- it must be deferred by returning, not thrown").toBe(0);

        const [unrecognizedState, recognizedState, legacyState] = await Promise.all([
          unrecognizedJob.getState(),
          recognizedJob.getState(),
          legacyJob.getState(),
        ]);
        expect(unrecognizedState, "the deferred job must not be in BullMQ's failed state").not.toBe("failed");
        expect(recognizedState, "the recognized job must complete, proving the unrecognized job did not stall the queue").toBe("completed");
        expect(legacyState, "the legacy pre-versioned job must complete under the current worker").toBe("completed");

        // The behavioral proof that matters: NOT PROCESSED means no
        // send_events row exists for the unrecognized-version workspace,
        // regardless of what BullMQ's own bookkeeping says about the job.
        expect(
          await countSendEvents(unrecognized.workspaceId),
          "an unrecognized-version job must never reach the insert -- 'completed' in BullMQ terms means 'resolved as a no-op', not 'processed'",
        ).toBe(0);

        // And the two that SHOULD have been processed actually were.
        expect(await countSendEvents(recognized.workspaceId)).toBe(1);
        expect(await countSendEvents(legacy.workspaceId), "the legacy pre-versioned payload must still be processed to completion").toBe(1);

        // The worker logs the deferral rather than silently swallowing it
        // (mirrors webhook-events-journal.test.ts's own Test 8 assertion).
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        await worker.close();
        await queue.obliterate({ force: true });
        await queue.close();
        errorSpy.mockRestore();
      }
    },
    30_000,
  );
});
