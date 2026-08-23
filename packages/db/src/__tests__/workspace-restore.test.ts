import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrationFile, createEphemeralDatabase, dropEphemeralDatabase, listMigrationFiles } from "@mega-crm/test-support";

import { restoreWorkspace, WorkspaceNotDeletedError, WorkspacePurgeStartedError } from "../workspace-restore.js";
import { buildWorkspacePurgeReport, formatWorkspacePurgeReport } from "../workspace-purge-report.js";

/**
 * Phase 22 (PRG-05, D-13/D-14/D-15, plan 22-06), Task 1: `restoreWorkspace`
 * un-deletes a workspace before its purge's point of no return, and refuses
 * unconditionally after it -- against a real, fully migrated Postgres
 * database with real RLS, mirroring `migration-0059-contact-erasure.test.ts`'s
 * own `adminPool`/`withWorkspace` fixture shape (organization INSERT is
 * restricted to `mega_crm_auth` as of migration 0045, so seeding a workspace
 * row goes through the superuser `adminPool`, never the ordinary
 * `mega_crm_app`-role `pool` this suite otherwise uses).
 *
 * `packages/db` has no dependency on `apps/worker` (a package cannot depend
 * on an app -- see `workspace-purge-tables.ts`'s own header) and no
 * dependency on `@mega-crm/tenant-context` (which itself depends on
 * `@mega-crm/db` -- importing it back here would be a cycle), so every
 * tenant-scoped fixture write in this file goes through this suite's own
 * `withWorkspace` helper (a direct `SET LOCAL app.current_workspace_id`),
 * not `withTenant`/`withTenantTransaction`.
 */

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

function adminDsnForDatabase(adminDsn: string, databaseName: string): string {
  const url = new URL(adminDsn);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("workspace restore + purge report (Phase 22, plan 22-06)", () => {
  let pool: Pool;
  let adminPool: Pool;
  let databaseName: string;
  let adminDsn: string;
  let dsn: string;

  beforeAll(async () => {
    const created = await createEphemeralDatabase({ workspace: "workspace-restore" });
    databaseName = created.databaseName;
    adminDsn = created.adminDsn;
    dsn = created.dsn;
    pool = new Pool({ connectionString: dsn, max: 10 });
    adminPool = new Pool({ connectionString: adminDsnForDatabase(created.adminDsn, databaseName), max: 5 });

    const files = listMigrationFiles(MIGRATIONS_DIR);
    for (const file of files) {
      await applyMigrationFile(pool, MIGRATIONS_DIR, file);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (databaseName) await dropEphemeralDatabase(databaseName, adminDsn);
  });

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const { rows } = await adminPool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`],
    );
    return rows[0].id;
  }

  async function softDeleteWorkspace(workspaceId: string, daysAgo: number): Promise<void> {
    await pool.query(`UPDATE organization SET "deletedAt" = now() - ($2 || ' days')::interval WHERE id = $1`, [
      workspaceId,
      daysAgo,
    ]);
  }

  interface OrganizationRow {
    deletedAt: Date | null;
    name: string;
    slug: string;
  }

  async function readOrganization(workspaceId: string): Promise<OrganizationRow> {
    const { rows } = await pool.query<OrganizationRow>(
      `SELECT "deletedAt" AS "deletedAt", name, slug FROM organization WHERE id = $1`,
      [workspaceId],
    );
    return rows[0];
  }

  /** What `withTenant`/`withTenantTransaction` do, applied to this suite's own pool -- see this file's header comment. */
  async function withWorkspace<T>(workspaceId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async function seedContacts(workspaceId: string, count: number): Promise<string[]> {
    return withWorkspace(workspaceId, async (client) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const email = `contact-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@fixture.test`;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status)
           VALUES ($1, $2, 'Fixture', 'subscribed') RETURNING id`,
          [workspaceId, email],
        );
        ids.push(rows[0].id);
      }
      return ids;
    });
  }

  async function seedSegment(workspaceId: string): Promise<string> {
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO segments (workspace_id, name, definition, created_by_user_id)
         VALUES ($1, 'Fixture Segment', '{}'::jsonb, 'fixture-user') RETURNING id`,
        [workspaceId],
      );
      return rows[0].id;
    });
  }

  type CampaignStatus = "draft" | "scheduled" | "sending" | "sent" | "canceled";

  async function seedCampaign(
    workspaceId: string,
    segmentId: string,
    status: CampaignStatus,
    scheduledAt: Date | null,
  ): Promise<string> {
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO campaigns (workspace_id, name, status, segment_id, scheduled_at, created_by_user_id)
         VALUES ($1, 'Fixture Campaign', $2, $3, $4, 'fixture-user') RETURNING id`,
        [workspaceId, status, segmentId, scheduledAt],
      );
      return rows[0].id;
    });
  }

  async function readCampaignStatus(workspaceId: string, campaignId: string): Promise<string> {
    return withWorkspace(workspaceId, async (client) => {
      const { rows } = await client.query<{ status: string }>(`SELECT status FROM campaigns WHERE id = $1`, [campaignId]);
      return rows[0].status;
    });
  }

  async function insertPurgeRecord(
    workspaceId: string,
    opts: { status: string; softDeletedAt: Date; eligibleAt: Date; firstDestructiveBatchAt?: Date | null },
  ): Promise<void> {
    await pool.query(
      `INSERT INTO purge_records (workspace_id, soft_deleted_at, eligible_at, status, first_destructive_batch_at, reported_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [workspaceId, opts.softDeletedAt, opts.eligibleAt, opts.status, opts.firstDestructiveBatchAt ?? null],
    );
  }

  /**
   * Wraps a real `Pool` so `restoreWorkspace`'s single dedicated connection
   * fails on the first query whose text matches `failOnMatch` -- the
   * "atomic" case's fault-injection seam. `restoreWorkspace`'s deps type is
   * `{ pool?: Pool }` only, so this is the one injection point available;
   * the double cast (`as unknown as Pool`) is deliberate and confined to
   * this test file (never used from source), matching the class of seam
   * `workspace-purge.worker.ts`'s own tests use for its `deletePurgeBatch`
   * injection.
   */
  function createFaultInjectingPool(realPool: Pool, failOnMatch: RegExp): Pool {
    const faultyPool = {
      connect: async () => {
        const realClient = await realPool.connect();
        const faultyClient = {
          query: (...args: unknown[]): Promise<unknown> => {
            const first = args[0];
            const text = typeof first === "string" ? first : (first as { text?: string } | undefined)?.text;
            if (text && failOnMatch.test(text)) {
              return Promise.reject(new Error("INJECTED FAILURE: mid-transaction fault"));
            }
            return (realClient.query as (...a: unknown[]) => Promise<unknown>)(...args);
          },
          release: (err?: Error) => realClient.release(err),
        };
        return faultyClient;
      },
    };
    return faultyPool as unknown as Pool;
  }

  describe("Task 1: restore before/after the point of no return, D-15 campaign defusal, atomicity", () => {
    it("restores before any purge record exists", async () => {
      const workspaceId = await freshWorkspaceId("restore-no-record");
      await softDeleteWorkspace(workspaceId, 10);

      const result = await restoreWorkspace(workspaceId, { pool });

      expect(result.workspaceId).toBe(workspaceId);
      expect(result.campaignsFlippedToDraft).toEqual([]);
      const org = await readOrganization(workspaceId);
      expect(org.deletedAt).toBeNull();
    });

    it("restores during the report-only window: a purge_records row at reported with no destructive batch yet is left as history", async () => {
      const workspaceId = await freshWorkspaceId("restore-report-only");
      const deletedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
      await softDeleteWorkspace(workspaceId, 40);
      await insertPurgeRecord(workspaceId, {
        status: "reported",
        softDeletedAt: deletedAt,
        eligibleAt: new Date(),
        firstDestructiveBatchAt: null,
      });

      const result = await restoreWorkspace(workspaceId, { pool });
      expect(result.workspaceId).toBe(workspaceId);

      const org = await readOrganization(workspaceId);
      expect(org.deletedAt).toBeNull();

      const { rows } = await pool.query<{ status: string; firstDestructiveBatchAt: Date | null }>(
        `SELECT status, first_destructive_batch_at AS "firstDestructiveBatchAt" FROM purge_records WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(rows[0].status).toBe("reported"); // untouched -- restore does not delete the record; it becomes history
      expect(rows[0].firstDestructiveBatchAt).toBeNull();
    });

    it("refuses after the first destructive batch: WorkspacePurgeStartedError, deletedAt still set, no campaign flipped", async () => {
      const workspaceId = await freshWorkspaceId("restore-past-point-of-no-return");
      await softDeleteWorkspace(workspaceId, 40);
      const segmentId = await seedSegment(workspaceId);
      const campaignId = await seedCampaign(workspaceId, segmentId, "scheduled", new Date(Date.now() - 1000));
      await insertPurgeRecord(workspaceId, {
        status: "purging",
        softDeletedAt: new Date(),
        eligibleAt: new Date(),
        firstDestructiveBatchAt: new Date(),
      });

      await expect(restoreWorkspace(workspaceId, { pool })).rejects.toThrow(WorkspacePurgeStartedError);

      const org = await readOrganization(workspaceId);
      expect(org.deletedAt).not.toBeNull();
      expect(await readCampaignStatus(workspaceId, campaignId)).toBe("scheduled");
    });

    it("refuses a workspace that is not soft-deleted", async () => {
      const workspaceId = await freshWorkspaceId("restore-never-deleted");
      await expect(restoreWorkspace(workspaceId, { pool })).rejects.toThrow(WorkspaceNotDeletedError);
    });

    it("refuses an unknown workspace id", async () => {
      await expect(restoreWorkspace(randomUUID(), { pool })).rejects.toThrow(WorkspaceNotDeletedError);
    });

    it("overdue scheduled campaign is defused: a scheduled campaign whose scheduled_at has passed flips to draft and is reported", async () => {
      const workspaceId = await freshWorkspaceId("restore-overdue-campaign");
      await softDeleteWorkspace(workspaceId, 10);
      const segmentId = await seedSegment(workspaceId);
      const overdueCampaignId = await seedCampaign(workspaceId, segmentId, "scheduled", new Date(Date.now() - 60_000));

      const result = await restoreWorkspace(workspaceId, { pool });

      expect(result.campaignsFlippedToDraft).toEqual([overdueCampaignId]);
      expect(await readCampaignStatus(workspaceId, overdueCampaignId)).toBe("draft");
    });

    it("a future-dated scheduled campaign, a sending campaign and a sent campaign all survive restore untouched", async () => {
      const workspaceId = await freshWorkspaceId("restore-untouched-campaigns");
      await softDeleteWorkspace(workspaceId, 10);
      const segmentId = await seedSegment(workspaceId);
      const futureCampaignId = await seedCampaign(workspaceId, segmentId, "scheduled", new Date(Date.now() + 60 * 60 * 1000));
      const sendingCampaignId = await seedCampaign(workspaceId, segmentId, "sending", null);
      const sentCampaignId = await seedCampaign(workspaceId, segmentId, "sent", null);

      const result = await restoreWorkspace(workspaceId, { pool });

      expect(result.campaignsFlippedToDraft).toEqual([]);
      expect(await readCampaignStatus(workspaceId, futureCampaignId)).toBe("scheduled");
      expect(await readCampaignStatus(workspaceId, sendingCampaignId)).toBe("sending");
      expect(await readCampaignStatus(workspaceId, sentCampaignId)).toBe("sent");
    });

    it("atomic: a mid-transaction failure between clearing deletedAt and the campaign flip leaves deletedAt set", async () => {
      const workspaceId = await freshWorkspaceId("restore-atomic");
      await softDeleteWorkspace(workspaceId, 10);

      const faultyPool = createFaultInjectingPool(pool, /UPDATE campaigns/);

      await expect(restoreWorkspace(workspaceId, { pool: faultyPool })).rejects.toThrow(/INJECTED FAILURE/);

      const org = await readOrganization(workspaceId);
      expect(org.deletedAt).not.toBeNull();
    });
  });

  describe("Task 2: the on-demand eligibility report -- read-only, no personal data", () => {
    it("report for one workspace: per-table counts, eligibleAt and status match the underlying data", async () => {
      const workspaceId = await freshWorkspaceId("report-one-workspace");
      const deletedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      await pool.query(`UPDATE organization SET "deletedAt" = $2 WHERE id = $1`, [workspaceId, deletedAt]);
      const [contactId] = await seedContacts(workspaceId, 3);
      await withWorkspace(workspaceId, (client) =>
        client.query(
          `INSERT INTO subscription_status_history (workspace_id, contact_id, old_status, new_status, source)
           VALUES ($1, $2, 'subscribed', 'unsubscribed', 'manual_ui')`,
          [workspaceId, contactId],
        ),
      );

      const report = await buildWorkspacePurgeReport({ pool, retentionDays: 30 }, { workspaceId });

      expect(report.workspaces).toHaveLength(1);
      const entry = report.workspaces[0];
      expect(entry.workspaceId).toBe(workspaceId);
      expect(entry.tableCounts).toEqual({ contacts: 3, subscription_status_history: 1 });
      expect(entry.eligibleAt?.getTime()).toBe(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
      expect(entry.status).toBe("not yet reported");
    });

    it("report for all eligible: lists exactly the eligible workspaces, excluding one not yet eligible", async () => {
      const eligibleA = await freshWorkspaceId("report-eligible-a");
      const eligibleB = await freshWorkspaceId("report-eligible-b");
      const notYetEligible = await freshWorkspaceId("report-not-yet-eligible");
      await softDeleteWorkspace(eligibleA, 40);
      await softDeleteWorkspace(eligibleB, 35);
      await softDeleteWorkspace(notYetEligible, 3);

      const report = await buildWorkspacePurgeReport({ pool, retentionDays: 30 }, { allEligible: true });

      const ids = report.workspaces.map((w) => w.workspaceId);
      expect(ids).toContain(eligibleA);
      expect(ids).toContain(eligibleB);
      expect(ids).not.toContain(notYetEligible);
    });

    it("report is read-only: running it against a workspace with no purge_records row writes nothing", async () => {
      const workspaceId = await freshWorkspaceId("report-read-only");
      await softDeleteWorkspace(workspaceId, 40);

      await buildWorkspacePurgeReport({ pool, retentionDays: 30 }, { workspaceId });

      const { rows } = await pool.query(`SELECT 1 FROM purge_records WHERE workspace_id = $1`, [workspaceId]);
      expect(rows).toHaveLength(0);
      const org = await readOrganization(workspaceId);
      expect(org.deletedAt).not.toBeNull(); // untouched
    });

    it("report contains no personal data: no contact email, no contact name, no workspace name in the formatted output", async () => {
      const workspaceId = await freshWorkspaceId("report-no-pii-sentinel");
      await softDeleteWorkspace(workspaceId, 40);
      const sentinelEmail = "sentinel-pii-marker@example.test";
      const sentinelFirstName = "SentinelFirstNameMarker";
      await withWorkspace(workspaceId, (client) =>
        client.query(
          `INSERT INTO contacts (workspace_id, email, first_name, subscription_status) VALUES ($1, $2, $3, 'subscribed')`,
          [workspaceId, sentinelEmail, sentinelFirstName],
        ),
      );

      const report = await buildWorkspacePurgeReport({ pool, retentionDays: 30 }, { workspaceId });
      const formatted = formatWorkspacePurgeReport(report);

      expect(formatted).not.toContain(sentinelEmail);
      expect(formatted).not.toContain(sentinelFirstName);
      expect(formatted).not.toContain("report-no-pii-sentinel"); // the seeded organization name fragment
    });
  });
});
