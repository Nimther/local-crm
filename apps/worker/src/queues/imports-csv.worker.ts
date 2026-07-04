import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { applyCsvRowMapping, findContactIdByIdentity, upsertContactByIdentity } from "@mega-crm/contacts-core";
import { IMPORTS_CSV_QUEUE, importsCsvJobSchema, type ImportsCsvJob } from "@mega-crm/shared-schemas";

const PAGE_SIZE = 500;

interface CsvImportConfigRow {
  id: string;
  mapping: Record<string, string> | null;
  duplicatePolicy: "update" | "skip";
}

interface StagedRow {
  id: string;
  rowNumber: number;
  raw: Record<string, string>;
}

/**
 * The imports:csv job handler (CONT-02, D-15/D-16, Pattern 2): re-derives
 * `workspaceId` from `job.data` (never ambient state -- this process is
 * separate from the one that enqueued the job), reads the mapping +
 * duplicatePolicy the dry-run route already persisted on `csv_imports`, and
 * processes every staged row still `pending` (rows the dry-run already
 * marked `error` are never touched here -- D-18's error report doesn't
 * change once the marketer has seen it). Reuses `applyCsvRowMapping` (SAME
 * interpreter apps/api's dry-run counter uses) and `upsertContactByIdentity`
 * (SAME upsert the Contacts API route and events:ingest worker use) so CSV
 * identity/mapping rules can never drift between the three ingestion paths.
 *
 * Idempotency (Pitfall 1): each row is only processed while its OWN
 * persisted `status` is still `pending`, re-checked with `FOR UPDATE` inside
 * the same transaction that flips it -- a redelivered/re-run job for the
 * same csvImportId is therefore a safe no-op for every row already
 * created/updated/skipped/errored. `processedRows`/`summary` are RECOMPUTED
 * from `GROUP BY status` counts (never incremented), so re-running the job
 * can never double-count progress either.
 *
 * Exported standalone (not only as a Worker's inline processor) so
 * imports-csv-idempotency.test.ts can invoke it directly with rows staged
 * via raw SQL, without needing a live BullMQ Queue/Redis round-trip.
 */
export async function processImportsCsvJob(data: ImportsCsvJob): Promise<void> {
  const { workspaceId, csvImportId } = importsCsvJobSchema.parse(data);

  await withTenant(workspaceId, async () => {
    const config = await withTenantTransaction(async (client) => {
      const { rows } = await client.query<CsvImportConfigRow>(
        `SELECT id, mapping, duplicate_policy as "duplicatePolicy" FROM csv_imports WHERE id = $1 AND workspace_id = $2`,
        [csvImportId, workspaceId]
      );
      return rows[0];
    });
    if (!config) return; // unknown/foreign import id -- nothing to do

    const mapping = config.mapping ?? {};

    await withTenantTransaction((client) =>
      client.query(`UPDATE csv_imports SET status = 'applying', updated_at = now() WHERE id = $1`, [csvImportId])
    );

    let cursor = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pendingRows = await withTenantTransaction(async (client) => {
        const { rows } = await client.query<StagedRow>(
          `SELECT id, row_number as "rowNumber", raw FROM csv_import_rows
           WHERE csv_import_id = $1 AND status = 'pending' AND row_number > $2
           ORDER BY row_number ASC LIMIT $3`,
          [csvImportId, cursor, PAGE_SIZE]
        );
        return rows;
      });
      if (pendingRows.length === 0) break;

      for (const row of pendingRows) {
        cursor = row.rowNumber;

        try {
          await withTenantTransaction(async (client) => {
            // Row-level idempotency guard: lock + re-check status inside
            // THIS transaction, in case a prior partial run already
            // resolved it (Pitfall 1).
            const { rows: lockedRows } = await client.query<{ status: string }>(
              `SELECT status FROM csv_import_rows WHERE id = $1 FOR UPDATE`,
              [row.id]
            );
            if (lockedRows[0]?.status !== "pending") return;

            const { input, error } = applyCsvRowMapping(row.raw, mapping);
            if (error) {
              await client.query(`UPDATE csv_import_rows SET status = 'error', reason = $2 WHERE id = $1`, [
                row.id,
                error,
              ]);
              return;
            }

            if (config.duplicatePolicy === "skip") {
              const existingId = await findContactIdByIdentity(client, workspaceId, input);
              if (existingId) {
                await client.query(`UPDATE csv_import_rows SET status = 'skipped' WHERE id = $1`, [row.id]);
                return;
              }
            }

            const result = await upsertContactByIdentity(client, workspaceId, input);
            await client.query(`UPDATE csv_import_rows SET status = $2 WHERE id = $1`, [
              row.id,
              result.created ? "created" : "updated",
            ]);
          });
        } catch (err) {
          // Any unexpected failure (e.g. a malformed subscriptionStatus
          // value rejected by the enum column) marks just THIS row as
          // errored rather than aborting the whole import -- the row's
          // original transaction above was already rolled back, so this
          // update runs in its own fresh transaction.
          const message = err instanceof Error ? err.message : "Unknown error processing row";
          await withTenantTransaction((client) =>
            client.query(`UPDATE csv_import_rows SET status = 'error', reason = $2 WHERE id = $1`, [row.id, message])
          ).catch(() => undefined);
        }
      }
    }

    await withTenantTransaction(async (client) => {
      const { rows: counts } = await client.query<{ status: string; count: string }>(
        `SELECT status, count(*) FROM csv_import_rows WHERE csv_import_id = $1 GROUP BY status`,
        [csvImportId]
      );
      const byStatus: Record<string, number> = {};
      for (const c of counts) byStatus[c.status] = Number(c.count);

      const processedRows =
        (byStatus.created ?? 0) + (byStatus.updated ?? 0) + (byStatus.skipped ?? 0) + (byStatus.error ?? 0);
      const summary = {
        created: byStatus.created ?? 0,
        updated: byStatus.updated ?? 0,
        skipped: byStatus.skipped ?? 0,
        errorCount: byStatus.error ?? 0,
      };
      const stillPending = byStatus.pending ?? 0;

      await client.query(
        `UPDATE csv_imports SET processed_rows = $2, summary = $3, status = $4, updated_at = now() WHERE id = $1`,
        [csvImportId, processedRows, summary, stillPending > 0 ? "applying" : "done"]
      );
    });
  });
}

/**
 * Constructs the actual BullMQ Worker consuming IMPORTS_CSV_QUEUE --
 * registered in apps/worker/src/server.ts's buildWorker(). Takes plain
 * ioredis `ConnectionOptions` (not a constructed client instance) for the
 * same nominal-type reason documented in events-ingest.worker.ts's
 * `createEventsIngestWorker`.
 */
export function createImportsCsvWorker(connection: ConnectionOptions): Worker<ImportsCsvJob> {
  return new Worker<ImportsCsvJob>(
    IMPORTS_CSV_QUEUE,
    async (job: Job<ImportsCsvJob>) => {
      await processImportsCsvJob(job.data);
    },
    { connection }
  );
}
