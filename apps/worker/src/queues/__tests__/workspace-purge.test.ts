import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { PURGE_TABLE_ORDER, deletePurgeBatch } from "@mega-crm/db";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { insertFixtureOrganization } from "../../test/failure-fixtures.js";
import { parseWorkerEnv } from "../../env.js";
import { processWorkspacePurge } from "../workspace-purge.worker.js";

/**
 * Phase 22 (PRG-01/PRG-02/PRG-03/PRG-05, plan 22-01), Task 1: the tracer's
 * end-to-end proof -- discover, report, destroy a two-table walk in FK
 * order, tombstone. Real Postgres, real RLS, mirrors
 * `erasure-scrub.test.ts`'s own harness shape wholesale.
 *
 * Every `it()` below seeds its OWN fresh workspace(s) and calls exactly the
 * ticks its own scenario needs -- this file's tests share ONE physical test
 * database for the whole file (each vitest test FILE gets its own ephemeral
 * database, but every `it()` within the file shares it), and
 * `processWorkspacePurge` is a GLOBAL scan over every `organization` row.
 * Self-contained fixtures per test, plus every assertion scoped to that
 * test's own `workspaceId`, is what keeps a leftover `reported`/`complete`
 * record from an EARLIER test from ever affecting a LATER one's assertions
 * -- a later tick opportunistically finishing an earlier test's already-
 * asserted workspace is harmless.
 */
describe("workspace purge: discover, report, destroy, tombstone (Task 1)", () => {
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
    return insertFixtureOrganization(nameSeed);
  }

  async function softDeleteWorkspace(workspaceId: string, daysAgo: number): Promise<void> {
    await pool.query(`UPDATE organization SET "deletedAt" = now() - ($2 || ' days')::interval WHERE id = $1`, [
      workspaceId,
      daysAgo,
    ]);
  }

  async function seedContacts(workspaceId: string, count: number): Promise<string[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
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
      }),
    );
  }

  async function seedSubscriptionStatusHistory(workspaceId: string, contactId: string, count: number): Promise<void> {
    await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        for (let i = 0; i < count; i += 1) {
          await client.query(
            `INSERT INTO subscription_status_history (workspace_id, contact_id, old_status, new_status, source)
             VALUES ($1, $2, 'subscribed', 'unsubscribed', 'manual_ui')`,
            [workspaceId, contactId],
          );
        }
      }),
    );
  }

  async function countContacts(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(`SELECT count(*) AS count FROM contacts WHERE workspace_id = $1`, [
          workspaceId,
        ]);
        return Number(rows[0].count);
      }),
    );
  }

  async function countSubscriptionStatusHistory(workspaceId: string): Promise<number> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM subscription_status_history WHERE workspace_id = $1`,
          [workspaceId],
        );
        return Number(rows[0].count);
      }),
    );
  }

  interface PurgeRecordRow {
    status: string;
    reportedAt: Date | null;
    firstDestructiveBatchAt: Date | null;
    purgedAt: Date | null;
    tableCounts: Record<string, number>;
    completedTables: string[];
    purgeError: string | null;
  }

  async function readPurgeRecord(workspaceId: string): Promise<PurgeRecordRow | null> {
    const { rows } = await pool.query<PurgeRecordRow>(
      `SELECT status,
              reported_at AS "reportedAt",
              first_destructive_batch_at AS "firstDestructiveBatchAt",
              purged_at AS "purgedAt",
              table_counts AS "tableCounts",
              completed_tables AS "completedTables",
              purge_error AS "purgeError"
         FROM purge_records WHERE workspace_id = $1`,
      [workspaceId],
    );
    return rows[0] ?? null;
  }

  interface OrganizationRow {
    name: string;
    slug: string;
    deletedAt: Date | null;
    purgedAt: Date | null;
  }

  async function readOrganization(workspaceId: string): Promise<OrganizationRow> {
    const { rows } = await pool.query<OrganizationRow>(
      `SELECT name, slug, "deletedAt" AS "deletedAt", "purgedAt" AS "purgedAt" FROM organization WHERE id = $1`,
      [workspaceId],
    );
    return rows[0];
  }

  it("report-only first tick: announces a retention-elapsed workspace with a pre-destruction census, destroys nothing yet", async () => {
    const workspaceId = await freshWorkspaceId("purge-report-only");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 3);
    await seedSubscriptionStatusHistory(workspaceId, contactId, 5);

    await processWorkspacePurge();

    const record = await readPurgeRecord(workspaceId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("reported");
    expect(record!.reportedAt).not.toBeNull();
    expect(record!.firstDestructiveBatchAt).toBeNull();
    expect(record!.purgedAt).toBeNull();
    expect(record!.tableCounts).toEqual({ contacts: 3, subscription_status_history: 5 });

    expect(await countContacts(workspaceId)).toBe(3);
    expect(await countSubscriptionStatusHistory(workspaceId)).toBe(5);
  });

  it("second tick destroys: the following tick removes every row and completes the record with ordered timestamps", async () => {
    const workspaceId = await freshWorkspaceId("purge-second-tick");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 3);
    await seedSubscriptionStatusHistory(workspaceId, contactId, 5);

    await processWorkspacePurge(); // tick 1: report
    await processWorkspacePurge(); // tick 2: destroy

    expect(await countContacts(workspaceId)).toBe(0);
    expect(await countSubscriptionStatusHistory(workspaceId)).toBe(0);

    const record = await readPurgeRecord(workspaceId);
    expect(record!.status).toBe("complete");
    expect(record!.firstDestructiveBatchAt).not.toBeNull();
    expect(record!.purgedAt).not.toBeNull();
    expect(record!.reportedAt!.getTime()).toBeLessThanOrEqual(record!.firstDestructiveBatchAt!.getTime());
    expect(record!.firstDestructiveBatchAt!.getTime()).toBeLessThanOrEqual(record!.purgedAt!.getTime());
    expect(record!.tableCounts).toEqual({ contacts: 3, subscription_status_history: 5 });
  });

  it("tombstone, not delete: the organization row survives with deletedAt intact, purgedAt set, and non-identifying name/slug", async () => {
    const workspaceId = await freshWorkspaceId("purge-tombstone");
    const before = await readOrganization(workspaceId);
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 1);
    await seedSubscriptionStatusHistory(workspaceId, contactId, 1);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy + tombstone

    const after = await readOrganization(workspaceId);
    expect(after.deletedAt).not.toBeNull();
    expect(after.purgedAt).not.toBeNull();
    expect(after.name).not.toBe(before.name);
    expect(after.slug).not.toBe(before.slug);
    expect(after.name).not.toContain("purge-tombstone");
    expect(after.slug).not.toContain("purge-tombstone");
  });

  it("not yet eligible: a too-recent soft-delete and a never-deleted workspace both survive two ticks untouched", async () => {
    const tooRecentId = await freshWorkspaceId("purge-too-recent");
    await softDeleteWorkspace(tooRecentId, 3);
    const [recentContactId] = await seedContacts(tooRecentId, 2);
    await seedSubscriptionStatusHistory(tooRecentId, recentContactId, 2);

    const neverDeletedId = await freshWorkspaceId("purge-never-deleted");
    const [liveContactId] = await seedContacts(neverDeletedId, 2);
    await seedSubscriptionStatusHistory(neverDeletedId, liveContactId, 2);

    await processWorkspacePurge();
    await processWorkspacePurge();

    expect(await readPurgeRecord(tooRecentId)).toBeNull();
    expect(await readPurgeRecord(neverDeletedId)).toBeNull();
    expect(await countContacts(tooRecentId)).toBe(2);
    expect(await countContacts(neverDeletedId)).toBe(2);
  });

  it("retention floor: parseWorkerEnv throws naming the variable when below the floor, and defaults to 30 when absent", () => {
    expect(() => parseWorkerEnv({ WORKSPACE_PURGE_RETENTION_DAYS: "0" })).toThrow(/WORKSPACE_PURGE_RETENTION_DAYS/);
    const parsed = parseWorkerEnv({});
    expect(parsed.WORKSPACE_PURGE_RETENTION_DAYS).toBe(30);
  });

  it("walk order: subscription_status_history is fully drained before the first contacts batch is issued", async () => {
    const workspaceId = await freshWorkspaceId("purge-walk-order");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactId] = await seedContacts(workspaceId, 2);
    await seedSubscriptionStatusHistory(workspaceId, contactId, 3);

    await processWorkspacePurge(); // report

    const calls: Array<{ table: string; workspaceId: string }> = [];
    const spyDeletePurgeBatch: typeof deletePurgeBatch = async (client, table, wsId, limit) => {
      calls.push({ table, workspaceId: wsId });
      return deletePurgeBatch(client, table, wsId, limit);
    };

    await processWorkspacePurge({ deletePurgeBatch: spyDeletePurgeBatch }); // destroy

    const callsForThisWorkspace = calls.filter((c) => c.workspaceId === workspaceId);
    expect(callsForThisWorkspace.length).toBeGreaterThan(0);
    const firstContactsIdx = callsForThisWorkspace.findIndex((c) => c.table === "contacts");
    const lastHistoryIdx = callsForThisWorkspace.reduce(
      (last, c, idx) => (c.table === "subscription_status_history" ? idx : last),
      -1,
    );
    expect(lastHistoryIdx).toBeGreaterThanOrEqual(0);
    expect(firstContactsIdx).toBeGreaterThan(lastHistoryIdx);
    expect(PURGE_TABLE_ORDER.indexOf("subscription_status_history")).toBeLessThan(PURGE_TABLE_ORDER.indexOf("contacts"));
  });

  /**
   * Task 2 (PRG-02, D-10, migration 0069): erasure evidence must survive the
   * purge's destruction of the contacts it references.
   */
  async function seedFixtureErasureRecord(workspaceId: string, contactId: string): Promise<string> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at, status)
           VALUES ($1, $2, now(), 'pending') RETURNING id`,
          [workspaceId, contactId],
        );
        return rows[0].id;
      }),
    );
  }

  interface ErasureRecordRow {
    id: string;
    workspaceId: string;
    contactId: string | null;
    status: string;
    requestedAt: Date;
    anonymizedAt: Date;
  }

  async function readErasureRecord(workspaceId: string, erasureRecordId: string): Promise<ErasureRecordRow | null> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<ErasureRecordRow>(
          `SELECT id, workspace_id AS "workspaceId", contact_id AS "contactId", status,
                  requested_at AS "requestedAt", anonymized_at AS "anonymizedAt"
             FROM erasure_records WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, erasureRecordId],
        );
        return rows[0] ?? null;
      }),
    );
  }

  it("erasure evidence survives the purge: the erasure_records row outlives its purged contact, with contact_id set to NULL", async () => {
    const workspaceId = await freshWorkspaceId("purge-erasure-evidence");
    await softDeleteWorkspace(workspaceId, 40);
    const [contactIdA, contactIdB] = await seedContacts(workspaceId, 2);
    const erasureRecordId = await seedFixtureErasureRecord(workspaceId, contactIdA);
    const before = await readErasureRecord(workspaceId, erasureRecordId);

    await processWorkspacePurge(); // report
    await processWorkspacePurge(); // destroy

    expect(await countContacts(workspaceId)).toBe(0);
    void contactIdB;

    const after = await readErasureRecord(workspaceId, erasureRecordId);
    expect(after).not.toBeNull();
    expect(after!.contactId).toBeNull();
    expect(after!.workspaceId).toBe(workspaceId);
    expect(after!.status).toBe(before!.status);
    expect(after!.requestedAt).toEqual(before!.requestedAt);
    expect(after!.anonymizedAt).toEqual(before!.anonymizedAt);
  });

  it("erasure_records is a declared evidence table, disjoint from the destructive walk order", async () => {
    const { PURGE_EVIDENCE_TABLES } = await import("@mega-crm/db");
    expect(PURGE_EVIDENCE_TABLES).toContain("erasure_records");
    for (const table of PURGE_TABLE_ORDER) {
      expect(PURGE_EVIDENCE_TABLES as readonly string[]).not.toContain(table);
    }
  });
});
