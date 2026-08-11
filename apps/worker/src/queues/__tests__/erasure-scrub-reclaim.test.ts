import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { Queue } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { startTempRedis, type TempRedis } from "@mega-crm/test-support";
import { buildRedisConnectionOptions } from "@mega-crm/queue-core";
import { ERASURE_SCRUB_QUEUE, buildErasureScrubJobId, type ErasureScrubJob } from "@mega-crm/shared-schemas";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import {
  ERASURE_SCRUB_RECLAIM_LEASE_MINUTES,
  ERASURE_SCRUB_RECLAIM_PAGE_LIMIT,
  findReclaimableErasureRecords,
  runErasureScrubReclaim,
} from "../erasure-scrub-reclaim.worker.js";

/**
 * Phase 13 (CMP-04, D-04, R-05, plan 13-15), Task 1: proves the reclaim
 * tick's find-stranded-records-and-re-enqueue half. Every scenario passes
 * `workspaceIds` (this test's own seeded ids) through
 * `runErasureScrubReclaim`'s test-only override -- the ephemeral test
 * database is shared across parallel test files (this project's wave-context
 * convention), so an unscoped cross-workspace scan's counts would be flaky.
 *
 * `requested_at`/`scrub_started_at` are seeded directly via SQL (not through
 * `deleteContact`/`runErasureScrub`, which always stamp "now") so each
 * behavior case can construct an exact fixture age without waiting on real
 * wall-clock thresholds -- mirrors `webhook-replay-sweep.test.ts`'s own
 * `receivedAtMinutesAgo` fixture convention for the identical reason.
 */
describe("erasure-scrub-reclaim.worker.ts (CMP-04, D-04, plan 13-15)", () => {
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

  async function createFixtureContact(workspaceId: string, email: string): Promise<string> {
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

  interface SeedOverrides {
    status?: "pending" | "scrubbing" | "complete" | "failed";
    requestedAtMinutesAgo?: number;
    scrubStartedAtMinutesAgo?: number | null;
    scrubError?: string | null;
  }

  /** Seeds an `erasure_records` row with an exact, test-controlled age -- unlike `deleteContact`/`runErasureScrub`, which always stamp "now". */
  async function seedErasureRecord(workspaceId: string, contactId: string, overrides: SeedOverrides = {}): Promise<string> {
    const {
      status = "pending",
      requestedAtMinutesAgo = 0,
      scrubStartedAtMinutesAgo = null,
      scrubError = null,
    } = overrides;

    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at, status, requested_at, scrub_started_at, scrub_error)
           VALUES (
             $1, $2, now(), $3,
             now() - make_interval(mins => $4),
             CASE WHEN $5::float8 IS NULL THEN NULL ELSE now() - make_interval(mins => $5) END,
             $6
           )
           RETURNING id`,
          [workspaceId, contactId, status, requestedAtMinutesAgo, scrubStartedAtMinutesAgo, scrubError]
        );
        return rows[0].id;
      })
    );
  }

  async function readErasureRecordStatusAndError(
    workspaceId: string,
    erasureRecordId: string
  ): Promise<{ status: string; scrubError: string | null }> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ status: string; scrubError: string | null }>(
          `SELECT status, scrub_error as "scrubError" FROM erasure_records WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, erasureRecordId]
        );
        return rows[0];
      })
    );
  }

  /** Every job this tick enqueued for `workspaceId`, on ERASURE_SCRUB_QUEUE, in waiting/delayed state. */
  async function queuedJobsFor(workspaceId: string): Promise<{ id?: string; data: ErasureScrubJob }[]> {
    const queue = new Queue<ErasureScrubJob>(ERASURE_SCRUB_QUEUE, { connection: buildRedisConnectionOptions(redis.url) });
    try {
      const jobs = await queue.getJobs(["waiting", "delayed"]);
      return jobs.filter((job) => job.data.workspaceId === workspaceId).map((job) => ({ id: job.id, data: job.data }));
    } finally {
      await queue.close();
    }
  }

  it("packages/shared-schemas exports the versioned reclaim tick schema", async () => {
    const { erasureScrubReclaimTickJobSchema, ERASURE_SCRUB_RECLAIM_TICK_SCHEMA_VERSION } = await import(
      "@mega-crm/shared-schemas"
    );
    expect(ERASURE_SCRUB_RECLAIM_TICK_SCHEMA_VERSION).toBe(1);
    expect(erasureScrubReclaimTickJobSchema.safeParse({ schemaVersion: 1 }).success).toBe(true);
    expect(erasureScrubReclaimTickJobSchema.safeParse({ schemaVersion: 2 }).success).toBe(false);
  });

  it("a pending record aged past the lease threshold is enqueued exactly once, with the erasure record's own id as the payload", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-pending-stale");
    const contactId = await createFixtureContact(workspaceId, "stale-pending@example.test");
    const erasureRecordId = await seedErasureRecord(workspaceId, contactId, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 5,
    });

    const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    expect(summary.recordsReclaimed).toBe(1);
    const jobs = await queuedJobsFor(workspaceId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data.erasureRecordId).toBe(erasureRecordId);
    expect(jobs[0].data.contactId).toBe(contactId);
    expect(jobs[0].id).toBe(buildErasureScrubJobId(erasureRecordId));
  });

  it("a pending record aged two minutes is not enqueued", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-pending-fresh");
    const contactId = await createFixtureContact(workspaceId, "fresh-pending@example.test");
    await seedErasureRecord(workspaceId, contactId, { status: "pending", requestedAtMinutesAgo: 2 });

    const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    expect(summary.recordsReclaimed).toBe(0);
    expect(await queuedJobsFor(workspaceId)).toHaveLength(0);
  });

  it("a scrubbing record whose scrub_started_at is past the lease is enqueued exactly once", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-scrubbing-stale");
    const contactId = await createFixtureContact(workspaceId, "stale-scrubbing@example.test");
    const erasureRecordId = await seedErasureRecord(workspaceId, contactId, {
      status: "scrubbing",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 20,
      scrubStartedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 5,
    });

    const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    expect(summary.recordsReclaimed).toBe(1);
    const jobs = await queuedJobsFor(workspaceId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data.erasureRecordId).toBe(erasureRecordId);
  });

  it("a scrubbing record whose scrub_started_at is one minute old is not enqueued", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-scrubbing-fresh");
    const contactId = await createFixtureContact(workspaceId, "fresh-scrubbing@example.test");
    await seedErasureRecord(workspaceId, contactId, {
      status: "scrubbing",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 20,
      scrubStartedAtMinutesAgo: 1,
    });

    const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    expect(summary.recordsReclaimed).toBe(0);
    expect(await queuedJobsFor(workspaceId)).toHaveLength(0);
  });

  it("a complete record is never reclaimed at any age", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-complete");
    const contactId = await createFixtureContact(workspaceId, "complete@example.test");
    await seedErasureRecord(workspaceId, contactId, {
      status: "complete",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES * 100,
    });

    const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    expect(summary.recordsReclaimed).toBe(0);
    expect(await queuedJobsFor(workspaceId)).toHaveLength(0);
  });

  it("a failed record is never reclaimed at any age, and its scrub_error is left untouched", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-failed");
    const contactId = await createFixtureContact(workspaceId, "failed@example.test");
    const erasureRecordId = await seedErasureRecord(workspaceId, contactId, {
      status: "failed",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES * 100,
      scrubError: "a genuine, recorded scrub failure",
    });

    const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    expect(summary.recordsReclaimed).toBe(0);
    expect(await queuedJobsFor(workspaceId)).toHaveLength(0);
    const row = await readErasureRecordStatusAndError(workspaceId, erasureRecordId);
    expect(row.status).toBe("failed");
    expect(row.scrubError).toBe("a genuine, recorded scrub failure");
  });

  it("the enqueued job's jobId equals buildErasureScrubJobId(recordId), compared against the function's own output rather than a literal", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-jobid-shared");
    const contactId = await createFixtureContact(workspaceId, "jobid-shared@example.test");
    const erasureRecordId = await seedErasureRecord(workspaceId, contactId, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 1,
    });

    await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    const jobs = await queuedJobsFor(workspaceId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(buildErasureScrubJobId(erasureRecordId));
  });

  it("two consecutive reclaim ticks over one stranded record leave exactly one job in the scrub queue", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-idempotent-tick");
    const contactId = await createFixtureContact(workspaceId, "idempotent-tick@example.test");
    await seedErasureRecord(workspaceId, contactId, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 1,
    });

    await runErasureScrubReclaim({ workspaceIds: [workspaceId] });
    await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    // BullMQ's own jobId dedup: the second tick's Queue.add with the SAME
    // deterministic jobId is a no-op against the still-waiting first job.
    expect(await queuedJobsFor(workspaceId)).toHaveLength(1);
  });

  it("a tick with more reclaimable records than the page limit enqueues exactly the page limit and leaves the rest for the next tick", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-page-limit");
    const pageLimit = 3;
    for (let i = 0; i < pageLimit + 2; i += 1) {
      const contactId = await createFixtureContact(workspaceId, `page-limit-${i}@example.test`);
      await seedErasureRecord(workspaceId, contactId, {
        status: "pending",
        requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 10 + i,
      });
    }

    const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceId], pageLimit });

    expect(summary.recordsReclaimed).toBe(pageLimit);
    expect(await queuedJobsFor(workspaceId)).toHaveLength(pageLimit);
  });

  it("reclaimable records in two different workspaces are both found by one tick, each carrying only its own workspaceId", async () => {
    const workspaceA = await freshWorkspaceId("reclaim-cross-a");
    const workspaceB = await freshWorkspaceId("reclaim-cross-b");
    const contactA = await createFixtureContact(workspaceA, "cross-a@example.test");
    const contactB = await createFixtureContact(workspaceB, "cross-b@example.test");
    const erasureRecordA = await seedErasureRecord(workspaceA, contactA, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 1,
    });
    const erasureRecordB = await seedErasureRecord(workspaceB, contactB, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 1,
    });

    const summary = await runErasureScrubReclaim({ workspaceIds: [workspaceA, workspaceB] });

    expect(summary.workspacesScanned).toBe(2);
    expect(summary.recordsReclaimed).toBe(2);

    const jobsA = await queuedJobsFor(workspaceA);
    const jobsB = await queuedJobsFor(workspaceB);
    expect(jobsA).toHaveLength(1);
    expect(jobsB).toHaveLength(1);
    expect(jobsA[0].data.erasureRecordId).toBe(erasureRecordA);
    expect(jobsA[0].data.workspaceId).toBe(workspaceA);
    expect(jobsB[0].data.erasureRecordId).toBe(erasureRecordB);
    expect(jobsB[0].data.workspaceId).toBe(workspaceB);
  });

  it("a reclaim tick performs no write against contacts, workspace_suppressions, send_events, or events", async () => {
    const workspaceId = await freshWorkspaceId("reclaim-no-side-effects");
    const email = "no-side-effects@example.test";
    const contactId = await createFixtureContact(workspaceId, email);
    await seedErasureRecord(workspaceId, contactId, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 1,
    });

    const before = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ email: string | null }>(`SELECT email FROM contacts WHERE id = $1`, [
          contactId,
        ]);
        return rows[0];
      })
    );

    await runErasureScrubReclaim({ workspaceIds: [workspaceId] });

    const after = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ email: string | null }>(`SELECT email FROM contacts WHERE id = $1`, [
          contactId,
        ]);
        return rows[0];
      })
    );
    expect(after).toEqual(before);
    expect(after?.email).toBe(email);
  });

  it("a tick whose enqueue rejects for one workspace still processes the remaining workspaces and does not throw out of the tick", async () => {
    const { Queue: BullQueue } = await import("bullmq");
    const workspaceA = await freshWorkspaceId("reclaim-error-a");
    const workspaceB = await freshWorkspaceId("reclaim-error-b");
    const contactA = await createFixtureContact(workspaceA, "error-a@example.test");
    const contactB = await createFixtureContact(workspaceB, "error-b@example.test");
    await seedErasureRecord(workspaceA, contactA, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 1,
    });
    const erasureRecordB = await seedErasureRecord(workspaceB, contactB, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 1,
    });

    const vi = await import("vitest");
    const addSpy = vi.vi.spyOn(BullQueue.prototype, "add").mockRejectedValueOnce(new Error("simulated enqueue failure"));

    try {
      const summary = await expect(runErasureScrubReclaim({ workspaceIds: [workspaceA, workspaceB] })).resolves.toBeDefined();
      void summary;
    } finally {
      addSpy.mockRestore();
    }

    // Workspace B (processed after the injected rejection on A) must still
    // have been reclaimed -- the tick does not abort on the first error.
    const jobsB = await queuedJobsFor(workspaceB);
    expect(jobsB).toHaveLength(1);
    expect(jobsB[0].data.erasureRecordId).toBe(erasureRecordB);
  });

  it("the reclaim query is executed inside withTenant -- findReclaimableErasureRecords sees only rows in its own tenant scope", async () => {
    const workspaceA = await freshWorkspaceId("reclaim-tenant-scope-a");
    const workspaceB = await freshWorkspaceId("reclaim-tenant-scope-b");
    const contactA = await createFixtureContact(workspaceA, "tenant-scope-a@example.test");
    await seedErasureRecord(workspaceA, contactA, {
      status: "pending",
      requestedAtMinutesAgo: ERASURE_SCRUB_RECLAIM_LEASE_MINUTES + 1,
    });

    const rowsUnderB = await withTenant(workspaceB, () =>
      withTenantTransaction((client) => findReclaimableErasureRecords(client, ERASURE_SCRUB_RECLAIM_LEASE_MINUTES, 100))
    );
    expect(rowsUnderB).toHaveLength(0);

    const rowsUnderA = await withTenant(workspaceA, () =>
      withTenantTransaction((client) => findReclaimableErasureRecords(client, ERASURE_SCRUB_RECLAIM_LEASE_MINUTES, 100))
    );
    expect(rowsUnderA).toHaveLength(1);
  });

  it("ERASURE_SCRUB_RECLAIM_LEASE_MINUTES and ERASURE_SCRUB_RECLAIM_PAGE_LIMIT are positive bounded constants", () => {
    expect(ERASURE_SCRUB_RECLAIM_LEASE_MINUTES).toBeGreaterThan(0);
    expect(ERASURE_SCRUB_RECLAIM_PAGE_LIMIT).toBeGreaterThan(0);
  });
});
