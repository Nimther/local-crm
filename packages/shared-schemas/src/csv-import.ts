import { z } from "zod";

/**
 * CSV contact import (CONT-02, D-15..D-20). A mapping key is the CSV's
 * header column name; its value is either one of the contact's standard
 * fields (externalId/email/firstName/lastName/phone/city/country/tags/
 * subscriptionStatus) or -- per D-19 -- any other string, which is treated
 * as a brand-new custom-property key with no separate "create property"
 * step required. See `@mega-crm/contacts-core`'s `applyCsvRowMapping` for
 * the shared interpreter both the dry-run counter (apps/api) and the apply
 * worker (apps/worker) run against, so neither side can silently drift on
 * what a mapping means.
 */
export const csvColumnMappingSchema = z.record(z.string(), z.string());
export type CsvColumnMapping = z.infer<typeof csvColumnMappingSchema>;

/** D-15: the per-import duplicate-handling switch -- "update" (merge, default) or "skip" (leave existing matches untouched). */
export const duplicatePolicySchema = z.enum(["update", "skip"]);
export type DuplicatePolicy = z.infer<typeof duplicatePolicySchema>;

/** POST /api/workspaces/:slug/imports (multipart upload) response -- D-17's "first ~20 mapped rows" preview. */
export const csvUploadResponseSchema = z.object({
  importId: z.string().uuid(),
  headers: z.array(z.string()),
  previewRows: z.array(z.record(z.string(), z.string())),
  totalRows: z.number(),
});
export type CsvUploadResponse = z.infer<typeof csvUploadResponseSchema>;

/** POST /api/workspaces/:slug/imports/:id/dry-run request body. */
export const csvDryRunRequestSchema = z.object({
  mapping: csvColumnMappingSchema,
  duplicatePolicy: duplicatePolicySchema.default("update"),
});
export type CsvDryRunRequest = z.infer<typeof csvDryRunRequestSchema>;

/** D-17: whole-file validation counts, computed WITHOUT writing any contact. */
export const csvDryRunSummarySchema = z.object({
  willCreate: z.number(),
  willUpdate: z.number(),
  errorCount: z.number(),
});
export type CsvDryRunSummary = z.infer<typeof csvDryRunSummarySchema>;

/** D-18: post-apply completion summary -- distinct field set from the dry-run's willCreate/willUpdate. */
export const csvApplySummarySchema = z.object({
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  errorCount: z.number(),
});
export type CsvApplySummary = z.infer<typeof csvApplySummarySchema>;

/** GET /api/workspaces/:slug/imports/:id (D-16 progress polling) and the history list item shape (D-20). */
export const csvImportStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["uploaded", "validating", "ready", "applying", "done", "failed"]),
  fileName: z.string(),
  duplicatePolicy: duplicatePolicySchema,
  totalRows: z.number(),
  processedRows: z.number(),
  summary: z
    .object({
      willCreate: z.number().optional(),
      willUpdate: z.number().optional(),
      created: z.number().optional(),
      updated: z.number().optional(),
      skipped: z.number().optional(),
      errorCount: z.number().optional(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type CsvImportStatus = z.infer<typeof csvImportStatusSchema>;
