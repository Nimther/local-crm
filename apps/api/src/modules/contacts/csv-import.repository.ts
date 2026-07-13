import type { PoolClient } from "pg";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import type { CsvColumnMapping, CsvDryRunSummary, DuplicatePolicy } from "@mega-crm/shared-schemas";

export interface CsvImportRow {
  id: string;
  fileName: string;
  createdByUserId: string;
  status: "uploaded" | "validating" | "ready" | "applying" | "done" | "failed";
  duplicatePolicy: DuplicatePolicy;
  mapping: CsvColumnMapping | null;
  defaultTimezone: string | null;
  totalRows: number;
  processedRows: number;
  summary: Record<string, number> | null;
  createdAt: Date;
  updatedAt: Date;
}

const CSV_IMPORT_COLUMNS = `
  id,
  file_name as "fileName",
  created_by_user_id as "createdByUserId",
  status,
  duplicate_policy as "duplicatePolicy",
  mapping,
  default_timezone as "defaultTimezone",
  total_rows as "totalRows",
  processed_rows as "processedRows",
  summary,
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

/** POST /imports (upload): creates the history/progress row (D-20) before any row is staged. */
export async function createCsvImport(input: {
  fileName: string;
  createdByUserId: string;
}): Promise<CsvImportRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CsvImportRow>(
      `INSERT INTO csv_imports (workspace_id, file_name, created_by_user_id)
       VALUES ($1, $2, $3) RETURNING ${CSV_IMPORT_COLUMNS}`,
      [workspaceId, input.fileName, input.createdByUserId]
    );
    return rows[0];
  });
}

/**
 * Bulk-inserts one chunk of staged rows on an already-open transaction --
 * the upload route calls this repeatedly as csv-parse streams the file, so
 * memory usage stays bounded regardless of file size (D-16: 100k+ rows).
 */
export async function insertStagingRowsChunk(
  client: PoolClient,
  workspaceId: string,
  csvImportId: string,
  chunk: Array<{ rowNumber: number; raw: Record<string, string> }>
): Promise<void> {
  if (chunk.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  chunk.forEach((row, idx) => {
    const base = idx * 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    params.push(csvImportId, workspaceId, row.rowNumber, row.raw);
  });
  await client.query(
    `INSERT INTO csv_import_rows (csv_import_id, workspace_id, row_number, raw) VALUES ${values.join(", ")}`,
    params
  );
}

export async function updateCsvImportTotalRows(id: string, totalRows: number): Promise<void> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    await client.query(
      `UPDATE csv_imports SET total_rows = $3, updated_at = now() WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId, totalRows]
    );
  });
}

export async function getCsvImport(id: string): Promise<CsvImportRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CsvImportRow>(
      `SELECT ${CSV_IMPORT_COLUMNS} FROM csv_imports WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId]
    );
    return rows[0] ?? null;
  });
}

/** D-20: import history, newest first. */
export async function listCsvImports(): Promise<CsvImportRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<CsvImportRow>(
      `SELECT ${CSV_IMPORT_COLUMNS} FROM csv_imports WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId]
    );
    return rows;
  });
}

export interface StagedRow {
  rowNumber: number;
  raw: Record<string, string>;
}

/**
 * Reads ALL staged rows in ordered pages, regardless of status -- the
 * dry-run validator is the authoritative (re-runnable) classification step,
 * so it must re-examine every row every time it runs (e.g. after the
 * marketer changes the column mapping and re-validates), not just rows
 * still `pending` from a previous attempt.
 */
export async function getStagedRowsPage(csvImportId: string, afterRowNumber: number, limit: number): Promise<StagedRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<StagedRow>(
      `SELECT row_number as "rowNumber", raw FROM csv_import_rows
       WHERE csv_import_id = $1 AND workspace_id = $2 AND row_number > $3
       ORDER BY row_number ASC LIMIT $4`,
      [csvImportId, workspaceId, afterRowNumber, limit]
    );
    return rows;
  });
}

/**
 * Sets one staged row's status at dry-run time: `error` (with a reason,
 * D-18's error-report becomes visible immediately, before apply ever runs)
 * or `pending` (reset -- makes re-running dry-run with a corrected mapping
 * safe: a row previously marked error is re-classified, not stuck errored
 * forever). The apply worker only ever touches rows still `pending`.
 */
export async function setStagedRowClassification(
  csvImportId: string,
  rowNumber: number,
  status: "pending" | "error",
  reason: string | null
): Promise<void> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    await client.query(
      `UPDATE csv_import_rows SET status = $3, reason = $4
       WHERE csv_import_id = $1 AND workspace_id = $2 AND row_number = $5`,
      [csvImportId, workspaceId, status, reason, rowNumber]
    );
  });
}

export async function saveDryRunResult(
  id: string,
  input: {
    mapping: CsvColumnMapping;
    duplicatePolicy: DuplicatePolicy;
    defaultTimezone: string | null | undefined;
    summary: CsvDryRunSummary;
  }
): Promise<void> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    await client.query(
      `UPDATE csv_imports SET mapping = $3, duplicate_policy = $4, default_timezone = $5, summary = $6, status = 'ready', updated_at = now()
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId, input.mapping, input.duplicatePolicy, input.defaultTimezone ?? null, input.summary]
    );
  });
}

export async function markCsvImportApplying(id: string): Promise<void> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    await client.query(`UPDATE csv_imports SET status = 'applying', updated_at = now() WHERE id = $1 AND workspace_id = $2`, [
      id,
      workspaceId,
    ]);
  });
}

/**
 * WR-04: makes the schema's `failed` status actually reachable (IN-06). Set
 * when the upload route's streaming parse loop throws mid-file (e.g. a
 * malformed CSV) or the uploaded file was silently truncated by the
 * multipart size limit -- either way, the import must never be left looking
 * like a pending/successful `uploaded` row.
 */
export async function markCsvImportFailed(id: string): Promise<void> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    await client.query(`UPDATE csv_imports SET status = 'failed', updated_at = now() WHERE id = $1 AND workspace_id = $2`, [
      id,
      workspaceId,
    ]);
  });
}

export interface ErrorRow {
  rowNumber: number;
  raw: Record<string, string>;
  reason: string | null;
}

/** D-18: only the errored rows, for the downloadable error-report CSV. */
export async function getErrorRows(csvImportId: string): Promise<ErrorRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<ErrorRow>(
      `SELECT row_number as "rowNumber", raw, reason FROM csv_import_rows
       WHERE csv_import_id = $1 AND workspace_id = $2 AND status = 'error'
       ORDER BY row_number ASC`,
      [csvImportId, workspaceId]
    );
    return rows;
  });
}
