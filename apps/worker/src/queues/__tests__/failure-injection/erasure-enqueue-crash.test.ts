import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Queue } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { startTempRedis, type TempRedis, createTestPool, ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { ERASURE_SCRUB_QUEUE, type ErasureScrubJob } from "@mega-crm/shared-schemas";
import { insertFixtureOrganization } from "../../../test/failure-fixtures.js";
import { deleteContact, type DeleteContactDeps } from "@mega-crm/api/src/modules/contacts/contact.repository.js";
import { runErasureScrubReclaim } from "../../erasure-scrub-reclaim.worker.js";
import { runErasureScrub } from "../../erasure-scrub.worker.js";

/**
 * Phase 13 (CMP-04, D-04, plan 13-15) -- the direct proof of the finding this
 * plan closes: plan 13-10's `deleteContact` commits the anonymization, the
 * suppression insert, and the `erasure_records` row as ONE transaction, then
 * enqueues the scrub job AFTER that commit. This scenario injects the
 * failure at the ONE seam that matters -- AFTER the commit, BEFORE the
 * enqueue call completes -- using the `enqueueErasureScrub` dependency
 * plan 13-10 exposes on `contact.repository.ts` specifically for this
 * purpose (see that file's own `DeleteContactDeps` doc comment). Injecting
 * earlier (`beforeErasureRecordWrite`) tests the transaction's atomicity,
 * which plan 13-10's own `contact-erasure.test.ts` already covers; injecting
 * later tests nothing at all -- the enqueue would have already succeeded.
 *
 * This drives the WHOLE recovery, not only the detection: the stranded
 * `pending` record after the injected failure, one reclaim tick producing
 * the job, processing that job to a completed, actually-scrubbed erasure,
 * and a second reclaim tick afterward enqueueing nothing.
 *
 * `apps/worker` declares `@mega-crm/api` as a devDependency ONLY (never
 * promoted, never imported from production code -- see 13-15-PLAN.md's
 * "Cross-app shared-module placement"); this file is test-only, and
 * `apps/api/src/middleware/tenant-context.ts` is itself a thin re-export of
 * `@mega-crm/tenant-context` (02-05, PITFALLS Pitfall 8), so `deleteContact`
 * reads the SAME AsyncLocalStorage-scoped tenant context this file's own
 * `withTenant` call sets -- no HTTP server, no cross-process boundary.
 *
 * Reproduce with `npm run failure:erasure-enqueue-crash` from the repo root.
 */
describe("failure injection: erasure-enqueue-crash (CMP-04, D-04, plan 13-15)", () => {
  let pool: Pool;
  let redis: TempRedis;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
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

  async function seedContact(workspaceId: string, email: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'unsubscribed') RETURNING id`,
          [workspaceId, email]
        );
        return rows[0].id;
      })
    );
  }

  async function seedCampaign(workspaceId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: segmentRows } = await client.query<{ id: string }>(
          `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
           VALUES ($1, 'Fixture crash-recovery segment', $2, 'test-user') RETURNING id`,
          [workspaceId, { operator: "and", conditions: [] }]
        );
        const { rows: campaignRows } = await client.query<{ id: string }>(
          `INSERT INTO campaigns (workspace_id, name, status, segment_id, template_id, from_email, created_by_user_id)
           VALUES ($1, 'Fixture crash-recovery campaign', 'sent', $2, 'd-fixture-template', 'sender@fixture.test', 'test-user')
           RETURNING id`,
          [workspaceId, segmentRows[0].id]
        );
        return campaignRows[0].id;
      })
    );
  }

  async function seedSendWithEvent(workspaceId: string, campaignId: string, contactId: string, email: string): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows: sendRows } = await client.query<{ id: string }>(
          `INSERT INTO sends (workspace_id, campaign_id, contact_id, kind, status, sent_at)
           VALUES ($1, $2, $3, 'campaign', 'sent', now()) RETURNING id`,
          [workspaceId, campaignId, contactId]
        );
        const sendId = sendRows[0].id;
        await client.query(
          `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, payload, occurred_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'delivered', $4::jsonb, now())`,
          [
            workspaceId,
            `sg-crash-recovery-${sendId}`,
            sendId,
            JSON.stringify({ email, event: "delivered", reason: `informational only, mentions ${email}` }),
          ]
        );
      })
    );
  }

  interface ContactState {
    anonymizedAt: Date | null;
    email: string | null;
  }

  async function readContactState(workspaceId: string, contactId: string): Promise<ContactState> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<ContactState>(
          `SELECT anonymized_at as "anonymizedAt", email FROM contacts WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, contactId]
        );
        return rows[0];
      })
    );
  }

  interface ErasureRecordState {
    id: string;
    status: string;
  }

  async function readErasureRecords(workspaceId: string, contactId: string): Promise<ErasureRecordState[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<ErasureRecordState>(
          `SELECT id, status FROM erasure_records WHERE workspace_id = $1 AND contact_id = $2`,
          [workspaceId, contactId]
        );
        return rows;
      })
    );
  }

  async function suppressionCount(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text as count FROM workspace_suppressions WHERE workspace_id = $1`,
          [workspaceId]
        );
        return Number(rows[0].count);
      })
    );
  }

  async function sendEventPayloadsFor(workspaceId: string, contactId: string): Promise<Record<string, unknown>[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ payload: Record<string, unknown> }>(
          `SELECT se.payload FROM send_events se JOIN sends s ON s.id = se.send_id
           WHERE se.workspace_id = $1 AND s.contact_id = $2`,
          [workspaceId, contactId]
        );
        return rows.map((r) => r.payload);
      })
    );
  }

  /** Every job the reclaim tick enqueued for `workspaceId`, on ERASURE_SCRUB_QUEUE, in waiting/delayed state. */
  async function queuedJobsFor(workspaceId: string): Promise<{ id?: string; data: ErasureScrubJob }[]> {
    const queue = new Queue<ErasureScrubJob>(ERASURE_SCRUB_QUEUE, { connection: buildRedisConnectionOptions(redis.url) });
    try {
      const jobs = await queue.getJobs(["waiting", "delayed"]);
      return jobs.filter((job) => job.data.workspaceId === workspaceId).map((job) => ({ id: job.id, data: job.data }));
    } finally {
      await queue.close();
    }
  }

  it(
    "a crash strictly between deleteContact's commit and the enqueue call is recovered end to end by one reclaim tick",
    async () => {
      const workspaceId = await freshWorkspaceId("erasure-enqueue-crash");
      const email = "erasure-enqueue-crash@example.test";
      const contactId = await seedContact(workspaceId, email);
      const campaignId = await seedCampaign(workspaceId);
      await seedSendWithEvent(workspaceId, campaignId, contactId, email);

      // --- inject the failure strictly between the commit and the enqueue --
      const deps: DeleteContactDeps = {
        enqueueErasureScrub: () => {
          throw new Error("INJECTED FAILURE strictly between the erasure transaction's commit and the enqueue call");
        },
      };

      await expect(withTenant(workspaceId, () => deleteContact(contactId, deps))).rejects.toThrow(
        /INJECTED FAILURE/
      );

      // --- the transaction committed: contact anonymized, suppression
      // present, exactly one PENDING erasure record -- the durable, stranded
      // state a crash in this gap leaves behind ------------------------
      const contactAfterCrash = await readContactState(workspaceId, contactId);
      expect(contactAfterCrash.anonymizedAt, "the commit already happened -- anonymization survives the enqueue failure").not.toBeNull();
      expect(contactAfterCrash.email).toBeNull();

      expect(await suppressionCount(workspaceId), "the suppression insert is in the SAME transaction, so it survives too").toBe(1);

      const recordsAfterCrash = await readErasureRecords(workspaceId, contactId);
      expect(recordsAfterCrash).toHaveLength(1);
      expect(recordsAfterCrash[0].status).toBe("pending");
      const erasureRecordId = recordsAfterCrash[0].id;

      // --- one reclaim tick: the stranded pending record is found and
      // re-enqueued (leaseMinutes: 0 -- this test proves recovery happens
      // at all, not the specific production lease window, which plan
      // 13-15's own erasure-scrub-reclaim.test.ts covers) ------------------
      const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceId], leaseMinutes: 0 });
      expect(summary.recordsReclaimed).toBe(1);

      const jobs = await queuedJobsFor(workspaceId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data.erasureRecordId).toBe(erasureRecordId);
      expect(jobs[0].data.contactId).toBe(contactId);
      expect(jobs[0].data.workspaceId).toBe(workspaceId);

      // --- process the reclaimed job exactly as erasure-scrub.worker.ts's
      // real Worker would -- the erasure finishes end to end despite the
      // crash: the record reaches complete and the linked send_events
      // payload no longer carries the former address --------------------
      await runErasureScrub({
        workspaceId: jobs[0].data.workspaceId,
        contactId: jobs[0].data.contactId,
        erasureRecordId: jobs[0].data.erasureRecordId,
      });

      const recordsAfterScrub = await readErasureRecords(workspaceId, contactId);
      expect(recordsAfterScrub).toHaveLength(1);
      expect(recordsAfterScrub[0].status).toBe("complete");

      const payloadsAfterScrub = await sendEventPayloadsFor(workspaceId, contactId);
      expect(payloadsAfterScrub.length).toBeGreaterThan(0);
      for (const payload of payloadsAfterScrub) {
        expect(JSON.stringify(payload)).not.toContain(email);
      }

      // --- the terminal no-op: a second reclaim tick after completion
      // enqueues nothing -- the reclaimer cannot become a loop on a
      // healthy, completed record ------------------------------------
      const secondSummary = await runErasureScrubReclaim({ workspaceIds: [workspaceId], leaseMinutes: 0 });
      expect(secondSummary.recordsReclaimed).toBe(0);
      expect(await queuedJobsFor(workspaceId)).toHaveLength(1); // still the one job from the first tick, none added
    },
    60_000
  );
});
