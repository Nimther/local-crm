import { pgTable, text, timestamp, uuid, jsonb, integer, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * CSV contact import (CONT-02, D-15..D-20). `csv_imports` is the
 * history/progress/dry-run-summary row a marketer sees on the import
 * status/history screen; `csv_import_rows` is the STAGING table the upload
 * route streams every parsed CSV row into (RESEARCH.md's Decision surfaced:
 * no object storage + a separate worker process means the uploaded file
 * itself cannot be re-read later -- persisted rows are what survive the
 * marketer navigating away, D-16).
 *
 * `status` lifecycle: uploaded -> validating -> ready (dry-run done,
 * mapping+duplicatePolicy persisted) -> applying (worker running) ->
 * done | failed.
 */
export const csvImports = pgTable("csv_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  fileName: text("file_name").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  status: text("status").notNull().default("uploaded"), // uploaded|validating|ready|applying|done|failed
  duplicatePolicy: text("duplicate_policy").notNull().default("update"), // update|skip (D-15)
  mapping: jsonb("mapping"), // column header -> target field/property key; set once the dry-run runs (D-17)
  defaultTimezone: text("default_timezone"), // per-import default IANA timezone applied to rows without one; validated app-side, D-08/FLOW-05
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  summary: jsonb("summary"), // {willCreate,willUpdate,errorCount} after dry-run; {created,updated,skipped,errorCount} after apply (D-18)
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * One row per staged CSV line. `UNIQUE (csv_import_id, row_number)` is the
 * idempotency key (RESEARCH.md Pitfall 1): a redelivered apply-job chunk
 * re-processing the same rows is guarded by each row's own persisted
 * `status` (only `pending` rows are ever (re)applied), not by this
 * constraint alone -- the constraint's job is to make "row N of this
 * import" a stable, non-duplicable identity in the first place.
 */
export const csvImportRows = pgTable(
  "csv_import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    csvImportId: uuid("csv_import_id")
      .notNull()
      .references(() => csvImports.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").notNull(), // parsed CSV row keyed by header column (csv-parse `columns: true`)
    status: text("status").notNull().default("pending"), // pending|created|updated|skipped|error
    reason: text("reason"), // set only for status='error' (D-18's error-report "reason" column)
  },
  (t) => [unique("csv_import_rows_import_row_unique").on(t.csvImportId, t.rowNumber)]
);
