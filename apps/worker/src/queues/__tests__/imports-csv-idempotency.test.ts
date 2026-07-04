import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { processImportsCsvJob } from "../imports-csv.worker.js";

interface CsvImportRowStatus {
  rowNumber: number;
  status: string;
  reason: string | null;
}

interface CsvImportSnapshot {
  status: string;
  processedRows: number;
  summary: Record<string, number> | null;
}

/**
 * imports:csv worker (CONT-02, D-15/D-16, Pitfall 1): invokes
 * `processImportsCsvJob` directly with rows staged via raw SQL -- no live
 * BullMQ Queue/Redis round-trip needed (mirrors events-ingest-idempotency's
 * pattern). This file owns the FULL row-processing correctness contract
 * apps/api's csv-import.test.ts deliberately leaves unverified (that file
 * only proves the synchronous upload/dry-run/enqueue HTTP surface, since no
 * worker runs in that test process): both D-15 duplicate policies, reuse of
 * the shared `upsertContactByIdentity` (D-01..D-08 identity rules), progress
 * recomputation, and idempotent re-delivery.
 */
describe("imports:csv worker (CONT-02, D-15/D-16, Pitfall 1)", () => {
  let pool: Pool;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  const MAPPING = { external_id: "externalId", email: "email", first_name: "firstName", tags: "tags" };

  async function freshWorkspaceId(nameSeed: string): Promise<string> {
    const slug = `${nameSeed}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO organization (name, slug) VALUES ($1, $2) RETURNING id`,
      [`${nameSeed} Co`, slug]
    );
    return rows[0].id;
  }

  async function createCsvImport(
    workspaceId: string,
    input: { duplicatePolicy: "update" | "skip"; totalRows: number }
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO csv_imports (workspace_id, file_name, created_by_user_id, mapping, duplicate_policy, total_rows, status)
       VALUES ($1, 'fixture.csv', 'test-user', $2, $3, $4, 'ready')
       RETURNING id`,
      [workspaceId, MAPPING, input.duplicatePolicy, input.totalRows]
    );
    return rows[0].id;
  }

  async function stageRows(workspaceId: string, csvImportId: string, rows: Array<Record<string, string>>): Promise<void> {
    let rowNumber = 1;
    for (const raw of rows) {
      await pool.query(
        `INSERT INTO csv_import_rows (csv_import_id, workspace_id, row_number, raw) VALUES ($1, $2, $3, $4)`,
        [csvImportId, workspaceId, rowNumber, raw]
      );
      rowNumber += 1;
    }
  }

  async function getRowStatuses(workspaceId: string, csvImportId: string): Promise<CsvImportRowStatus[]> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<CsvImportRowStatus>(
          `SELECT row_number as "rowNumber", status, reason FROM csv_import_rows WHERE csv_import_id = $1 ORDER BY row_number`,
          [csvImportId]
        );
        return rows;
      })
    );
  }

  async function getCsvImportSnapshot(workspaceId: string, csvImportId: string): Promise<CsvImportSnapshot> {
    return withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<CsvImportSnapshot>(
          `SELECT status, processed_rows as "processedRows", summary FROM csv_imports WHERE id = $1`,
          [csvImportId]
        );
        return rows[0];
      })
    );
  }

  it("CONT-02: update policy creates new contacts and merges non-empty CSV values into an existing match (reuses upsertContactByIdentity)", async () => {
    const workspaceId = await freshWorkspaceId("worker-csv-update");

    const existingId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, external_id, email, last_name) VALUES ($1, $2, $3, $4) RETURNING id`,
          [workspaceId, "update-ext-1", "before@example.com", "Existing"]
        );
        return rows[0].id;
      })
    );

    const csvImportId = await createCsvImport(workspaceId, { duplicatePolicy: "update", totalRows: 2 });
    await stageRows(workspaceId, csvImportId, [
      { external_id: "update-ext-1", email: "after@example.com", first_name: "Merged", tags: "vip" },
      { external_id: "update-ext-2", email: "new@example.com", first_name: "Newcomer", tags: "" },
    ]);

    await processImportsCsvJob({ workspaceId, csvImportId });

    const rowStatuses = await getRowStatuses(workspaceId, csvImportId);
    expect(rowStatuses.map((r) => r.status)).toEqual(["updated", "created"]);

    const snapshot = await getCsvImportSnapshot(workspaceId, csvImportId);
    expect(snapshot.status).toBe("done");
    expect(snapshot.processedRows).toBe(2);
    expect(snapshot.summary).toMatchObject({ created: 1, updated: 1, skipped: 0, errorCount: 0 });

    const merged = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{
          email: string;
          firstName: string | null;
          lastName: string | null;
          tags: string[];
        }>(
          `SELECT email, first_name as "firstName", last_name as "lastName", tags FROM contacts WHERE id = $1`,
          [existingId]
        );
        return rows[0];
      })
    );
    expect(merged.email).toBe("after@example.com");
    expect(merged.firstName).toBe("Merged");
    expect(merged.lastName).toBe("Existing"); // untouched field preserved by upsertContactByIdentity
    expect(merged.tags).toEqual(["vip"]);
  });

  it("D-15: skip policy leaves an existing match completely untouched, only creating brand-new contacts", async () => {
    const workspaceId = await freshWorkspaceId("worker-csv-skip");

    const existingId = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO contacts (workspace_id, external_id, first_name) VALUES ($1, $2, $3) RETURNING id`,
          [workspaceId, "skip-ext-1", "Untouched"]
        );
        return rows[0].id;
      })
    );

    const csvImportId = await createCsvImport(workspaceId, { duplicatePolicy: "skip", totalRows: 2 });
    await stageRows(workspaceId, csvImportId, [
      { external_id: "skip-ext-1", email: "", first_name: "ShouldNotApply", tags: "" },
      { external_id: "skip-ext-2", email: "brandnew@example.com", first_name: "Brand", tags: "" },
    ]);

    await processImportsCsvJob({ workspaceId, csvImportId });

    const rowStatuses = await getRowStatuses(workspaceId, csvImportId);
    expect(rowStatuses.map((r) => r.status)).toEqual(["skipped", "created"]);

    const untouched = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ firstName: string | null }>(
          `SELECT first_name as "firstName" FROM contacts WHERE id = $1`,
          [existingId]
        );
        return rows[0];
      })
    );
    expect(untouched.firstName).toBe("Untouched");

    const snapshot = await getCsvImportSnapshot(workspaceId, csvImportId);
    expect(snapshot.summary).toMatchObject({ created: 1, updated: 0, skipped: 1, errorCount: 0 });
  });

  it("Pitfall 1: re-running the apply job for the same staged rows is a safe no-op (no double-create, no double-appended tags)", async () => {
    const workspaceId = await freshWorkspaceId("worker-csv-idempotent");

    const csvImportId = await createCsvImport(workspaceId, { duplicatePolicy: "update", totalRows: 1 });
    await stageRows(workspaceId, csvImportId, [
      { external_id: "idem-ext-1", email: "idem@example.com", first_name: "Once", tags: "vip" },
    ]);

    await processImportsCsvJob({ workspaceId, csvImportId });
    await processImportsCsvJob({ workspaceId, csvImportId }); // simulated BullMQ redelivery

    const contactRows = await withTenant(workspaceId, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ id: string; tags: string[] }>(
          `SELECT id, tags FROM contacts WHERE workspace_id = $1 AND external_id = $2`,
          [workspaceId, "idem-ext-1"]
        );
        return rows;
      })
    );
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0].tags).toEqual(["vip"]); // not doubled to ["vip", "vip"]

    const snapshot = await getCsvImportSnapshot(workspaceId, csvImportId);
    expect(snapshot.processedRows).toBe(1); // recomputed from row state, never double-counted on retry
  });

  it("CONT-02: a malformed row (missing both identifiers) is marked errored and excluded from applied counts", async () => {
    const workspaceId = await freshWorkspaceId("worker-csv-error");

    const csvImportId = await createCsvImport(workspaceId, { duplicatePolicy: "update", totalRows: 1 });
    await stageRows(workspaceId, csvImportId, [{ external_id: "", email: "", first_name: "Ghost", tags: "" }]);

    await processImportsCsvJob({ workspaceId, csvImportId });

    const rowStatuses = await getRowStatuses(workspaceId, csvImportId);
    expect(rowStatuses[0].status).toBe("error");
    expect(rowStatuses[0].reason).toBeTruthy();

    const snapshot = await getCsvImportSnapshot(workspaceId, csvImportId);
    expect(snapshot.summary).toMatchObject({ created: 0, updated: 0, skipped: 0, errorCount: 1 });
  });
});
