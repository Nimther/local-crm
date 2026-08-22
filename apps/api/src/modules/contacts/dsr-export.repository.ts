import { withTenantTransactionRepeatableRead } from "@mega-crm/tenant-context";
import { DSR_EXPORT_FORMAT_VERSION, type DsrExportDocument } from "@mega-crm/shared-schemas";

/**
 * Phase 21 plan 01 (D-10, mirrors ERASURE_SCRUB_PAGE_LIMIT): the bounded
 * page size every multi-row section of this export walks in. This plan
 * (21-01) has no multi-row section yet -- profile and customProperties are
 * both single-row reads -- but the constant is exported now so every later
 * plan's keyset walk (events, sends, flow_runs, campaign_recipients)
 * imports the SAME value rather than each re-declaring its own 500.
 */
export const DSR_EXPORT_PAGE_LIMIT = 500;

/**
 * Thrown when `getDsrExportDocument` finds the contact but its
 * `anonymized_at` is non-null (D-13/D-15) -- the route maps this to a typed
 * 410, never a file.
 */
export class ContactErasedError extends Error {
  constructor(
    message: string,
    public readonly erasedAt: string,
    public readonly erasureRecordId: string | null
  ) {
    super(message);
    this.name = "ContactErasedError";
  }
}

interface ContactExportRow {
  id: string;
  externalId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  tags: string[];
  properties: Record<string, unknown>;
  subscriptionStatus: DsrExportDocument["profile"]["subscriptionStatus"];
  createdAt: Date;
  updatedAt: Date;
  anonymizedAt: Date | null;
}

/**
 * Phase 21 plan 01 (DSR-01, D-05/D-06/D-15): assembles the export document
 * for exactly one contact, entirely inside a single
 * `withTenantTransactionRepeatableRead` snapshot. The FIRST read inside
 * that transaction is `anonymized_at` (fail-closed erasure gate, D-15) --
 * deliberately selected together with every other profile column so no
 * second round trip is needed once the gate passes, and deliberately NOT
 * filtered by `anonymized_at IS NULL` in the WHERE clause, because this
 * function must distinguish "no such contact" (zero rows -> null, -> 404)
 * from "found, but erased" (a row with anonymized_at set -> throw
 * ContactErasedError, -> 410) -- the same distinction contact.repository.ts's
 * `updateContact` draws for the same reason.
 *
 * Returns `null` when no row matches `workspace_id`+`id` -- the route maps
 * this to the anti-enumeration `NOT_FOUND_BODY` 404 (SC4), so a foreign
 * workspace's contact id and a contact id that never existed are
 * indistinguishable at the wire.
 */
export async function getDsrExportDocument(
  workspaceId: string,
  workspaceName: string,
  contactId: string
): Promise<DsrExportDocument | null> {
  return withTenantTransactionRepeatableRead(async (client) => {
    const { rows } = await client.query<ContactExportRow>(
      `SELECT
         id,
         external_id as "externalId",
         email,
         first_name as "firstName",
         last_name as "lastName",
         phone,
         city,
         country,
         timezone,
         tags,
         properties,
         subscription_status as "subscriptionStatus",
         created_at as "createdAt",
         updated_at as "updatedAt",
         anonymized_at as "anonymizedAt"
       FROM contacts
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, contactId]
    );
    const row = rows[0];
    if (!row) return null;

    if (row.anonymizedAt !== null) {
      const { rows: erasureRows } = await client.query<{ id: string }>(
        `SELECT id FROM erasure_records
         WHERE workspace_id = $1 AND contact_id = $2
         ORDER BY anonymized_at DESC
         LIMIT 1`,
        [workspaceId, contactId]
      );
      throw new ContactErasedError(
        `Contact ${contactId} has been anonymized -- no DSR export can be assembled`,
        row.anonymizedAt.toISOString(),
        erasureRows[0]?.id ?? null
      );
    }

    const customProperties = row.properties ?? {};

    const document: DsrExportDocument = {
      metadata: {
        generatedAt: new Date().toISOString(),
        exportFormatVersion: DSR_EXPORT_FORMAT_VERSION,
        allowlistName: "SEND_EVENT_PAYLOAD_EXPORT_ALLOWLIST",
        allowlistVersion: "1",
        workspace: { id: workspaceId, name: workspaceName },
        contact: { id: contactId },
        sectionRowCounts: {
          profile: 1,
          customProperties: Object.keys(customProperties).length,
        },
      },
      profile: {
        id: row.id,
        externalId: row.externalId,
        email: row.email,
        firstName: row.firstName,
        lastName: row.lastName,
        phone: row.phone,
        city: row.city,
        country: row.country,
        timezone: row.timezone,
        tags: row.tags,
        subscriptionStatus: row.subscriptionStatus,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      customProperties,
    };

    return document;
  });
}
