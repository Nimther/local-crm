import { z } from "zod";
import { subscriptionStatusSchema } from "./contact.js";

/**
 * Phase 21 (DSR-01..04, D-05/D-06/D-07): the per-contact DSR export
 * document. This plan (21-01) establishes ONLY `metadata`, `profile` and
 * `customProperties` -- the Growth rule in 21-01-PLAN.md's
 * `<document_contract>` requires every later section (`consentHistory`,
 * `events`, `sends`, `flowParticipation`, `campaignMemberships`) to be
 * ADDED here by the plan that implements its walk, never pre-declared as an
 * empty placeholder.
 */
export const DSR_EXPORT_FORMAT_VERSION = "1.0";

/**
 * D-06: full provenance, no requester identity. `sectionRowCounts` is an
 * open-ended integer map so later plans can add a key per section without
 * a schema-shape change here.
 */
export const dsrExportMetadataSchema = z.object({
  generatedAt: z.string(),
  exportFormatVersion: z.string(),
  allowlistName: z.string(),
  allowlistVersion: z.string(),
  workspace: z.object({
    id: z.string(),
    name: z.string(),
  }),
  contact: z.object({
    id: z.string(),
  }),
  sectionRowCounts: z.record(z.string(), z.number().int()),
});
export type DsrExportMetadata = z.infer<typeof dsrExportMetadataSchema>;

/**
 * D-07: camelCase, mirrors `contactResponseSchema`'s field naming --
 * deliberately NOT re-exporting `contactResponseSchema` itself, since the
 * export profile excludes `workspaceId` (already carried in `metadata`).
 */
export const dsrExportProfileSchema = z.object({
  id: z.string(),
  externalId: z.string().nullable(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  timezone: z.string().nullable(),
  tags: z.array(z.string()),
  subscriptionStatus: subscriptionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DsrExportProfile = z.infer<typeof dsrExportProfileSchema>;

/**
 * Phase 21 plan 03 (DSR-01): one `subscription_status_history` row, exactly
 * as `selectConsentHistoryPage` reads it in `dsr-export.repository.ts`.
 * `oldStatus`/`reason` are nullable because the underlying columns are
 * (a first-ever history row can have no prior status; not every source
 * records a reason).
 */
export const dsrExportConsentHistoryEntrySchema = z.object({
  id: z.string(),
  oldStatus: z.string().nullable(),
  newStatus: z.string(),
  source: z.string(),
  reason: z.string().nullable(),
  changedAt: z.string(),
});
export type DsrExportConsentHistoryEntry = z.infer<typeof dsrExportConsentHistoryEntrySchema>;

/**
 * Phase 21 plan 03 (DSR-02, D-01): one `events` row -- deliberately no
 * `properties` field. The repository's `selectEventsPage` never selects
 * that column at all, so there is no value here to omit; the schema simply
 * has no key for it.
 */
export const dsrExportEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  occurredAt: z.string(),
  receivedAt: z.string(),
});
export type DsrExportEvent = z.infer<typeof dsrExportEventSchema>;

/** D-05: the document shape this plan establishes -- see the module doc comment for the Growth rule governing every later section. */
export const dsrExportDocumentSchema = z.object({
  metadata: dsrExportMetadataSchema,
  profile: dsrExportProfileSchema,
  customProperties: z.record(z.string(), z.unknown()),
  consentHistory: z.array(dsrExportConsentHistoryEntrySchema),
  events: z.array(dsrExportEventSchema),
});
export type DsrExportDocument = z.infer<typeof dsrExportDocumentSchema>;

/** D-13: the typed 410 body for an already-erased contact -- no document keys. */
export const dsrExportErasedBodySchema = z.object({
  code: z.literal("contact_erased"),
  erasedAt: z.string(),
  erasureRecordId: z.string().nullable(),
});
export type DsrExportErasedBody = z.infer<typeof dsrExportErasedBodySchema>;
