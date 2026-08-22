import type { PoolClient } from "pg";
import { withTenantTransactionRepeatableRead } from "@mega-crm/tenant-context";
import { buildExportSendEventPayload } from "@mega-crm/delivery-core";
import {
  DSR_EXPORT_FORMAT_VERSION,
  type DsrExportConsentHistoryEntry,
  type DsrExportDocument,
  type DsrExportEvent,
  type DsrExportSend,
  type DsrExportSendEvent,
} from "@mega-crm/shared-schemas";

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

/**
 * Phase 21 plan 03 (D-10, D-15): a keyset cursor over `(timestamp, id)`,
 * mirroring `erasure-scrub.worker.ts`'s `scrubEventsPage` shape but with no
 * checkpoint persistence -- this walk lives entirely inside the single
 * REPEATABLE READ transaction `getDsrExportDocument` already opened, and is
 * never resumed across requests.
 */
interface KeysetCursor {
  timestamp: string;
  id: string;
}

/**
 * Phase 21 plan 03 (DSR-01): one bounded page of `subscription_status_history`
 * rows for this contact, ordered `(changed_at, id)` ascending. `client` is
 * the first argument so a test can drive one page directly on a client it
 * owns, matching `scrubEventsPage`'s signature shape.
 */
export async function selectConsentHistoryPage(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  cursor: KeysetCursor | null,
  limit: number = DSR_EXPORT_PAGE_LIMIT
): Promise<DsrExportConsentHistoryEntry[]> {
  const afterClause = cursor ? `AND (changed_at, id) > ($3::timestamptz, $4::uuid)` : "";
  const params: unknown[] = cursor
    ? [workspaceId, contactId, cursor.timestamp, cursor.id, limit]
    : [workspaceId, contactId, limit];
  const limitIdx = params.length;

  const { rows } = await client.query<DsrExportConsentHistoryEntry>(
    `SELECT
       id,
       old_status as "oldStatus",
       new_status as "newStatus",
       source,
       reason,
       changed_at::text as "changedAt"
     FROM subscription_status_history
     WHERE workspace_id = $1 AND contact_id = $2 ${afterClause}
     ORDER BY changed_at ASC, id ASC
     LIMIT $${limitIdx}`,
    params
  );
  return rows;
}

/**
 * Phase 21 plan 03 (DSR-02, D-01): one bounded page of `events` rows for
 * this contact, ordered `(occurred_at, id)` ascending -- `occurred_at`
 * leads the keyset because `events` is range-partitioned on it (Postgres
 * needs the partition key in any ordering that must stay stable across
 * pages), matching the existing `scrubEventsPage` walk exactly.
 *
 * `properties` is never named in this SELECT. Unlike the erasure scrub
 * (which rewrites the column to `{}`), the export does not read it at all
 * -- there is no code path on which a tenant-supplied key under this
 * freeform JSONB column could reach the exported artifact (D-01).
 */
export async function selectEventsPage(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  cursor: KeysetCursor | null,
  limit: number = DSR_EXPORT_PAGE_LIMIT
): Promise<DsrExportEvent[]> {
  const afterClause = cursor ? `AND (occurred_at, id) > ($3::timestamptz, $4::uuid)` : "";
  const params: unknown[] = cursor
    ? [workspaceId, contactId, cursor.timestamp, cursor.id, limit]
    : [workspaceId, contactId, limit];
  const limitIdx = params.length;

  const { rows } = await client.query<DsrExportEvent>(
    `SELECT id, name, occurred_at::text as "occurredAt", received_at::text as "receivedAt"
     FROM events
     WHERE workspace_id = $1 AND contact_id = $2 ${afterClause}
     ORDER BY occurred_at ASC, id ASC
     LIMIT $${limitIdx}`,
    params
  );
  return rows;
}

/**
 * Phase 21 plan 05 (DSR-02): one `sends` row, exactly as
 * `dsrExportSendSchema` expects it minus `sendEvents` (attached separately,
 * once the whole `send_events` walk below finishes).
 */
export interface SendPageRow {
  id: string;
  campaignId: string | null;
  kind: string;
  status: string;
  exclusionReason: string | null;
  providerMessageId: string | null;
  queuedAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  firstOpenedAt: string | null;
  firstClickedAt: string | null;
  bouncedAt: string | null;
  droppedAt: string | null;
  unsubscribedAt: string | null;
  spamReportedAt: string | null;
  bounceReason: string | null;
  dropReason: string | null;
  flowRunId: string | null;
  nodeId: string | null;
  openCount: number;
  clickCount: number;
  dispatchedAt: string | null;
}

/**
 * Phase 21 plan 05 (DSR-02): one bounded page of `sends` rows for this
 * contact, ordered `(queued_at, id)` ascending -- `queued_at` leads the
 * keyset rather than `sent_at` because `queued_at` is `NOT NULL DEFAULT
 * now()` on every row while `sent_at` is null for anything not yet sent,
 * and a nullable cursor column cannot order a stable keyset walk.
 * Deliberately excludes `reconciling_since`/`dispatch_duration_ms`:
 * `docs/PII-INVENTORY.md` records both as platform telemetry about the
 * dispatch attempt, not the subject's personal data.
 */
export async function selectSendsPage(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  cursor: KeysetCursor | null,
  limit: number = DSR_EXPORT_PAGE_LIMIT
): Promise<SendPageRow[]> {
  const afterClause = cursor ? `AND (queued_at, id) > ($3::timestamptz, $4::uuid)` : "";
  const params: unknown[] = cursor
    ? [workspaceId, contactId, cursor.timestamp, cursor.id, limit]
    : [workspaceId, contactId, limit];
  const limitIdx = params.length;

  const { rows } = await client.query<SendPageRow>(
    `SELECT
       id,
       campaign_id as "campaignId",
       kind,
       status,
       exclusion_reason as "exclusionReason",
       provider_message_id as "providerMessageId",
       queued_at::text as "queuedAt",
       sent_at::text as "sentAt",
       delivered_at::text as "deliveredAt",
       first_opened_at::text as "firstOpenedAt",
       first_clicked_at::text as "firstClickedAt",
       bounced_at::text as "bouncedAt",
       dropped_at::text as "droppedAt",
       unsubscribed_at::text as "unsubscribedAt",
       spam_reported_at::text as "spamReportedAt",
       bounce_reason as "bounceReason",
       drop_reason as "dropReason",
       flow_run_id as "flowRunId",
       node_id as "nodeId",
       open_count as "openCount",
       click_count as "clickCount",
       dispatched_at::text as "dispatchedAt"
     FROM sends
     WHERE workspace_id = $1 AND contact_id = $2 ${afterClause}
     ORDER BY queued_at ASC, id ASC
     LIMIT $${limitIdx}`,
    params
  );
  return rows;
}

/**
 * Phase 21 plan 05 (DSR-02/DSR-03, T-21-05-02/T-21-05-05): one page of
 * `send_events` rows reached ONLY through a join to `sends` -- the table
 * carries no `contact_id` of its own -- with `buildExportSendEventPayload`
 * from `@mega-crm/delivery-core` applied to every row's `payload` INSIDE
 * this reader, so no raw `payload` value can ever escape it. `occurred_at`
 * must lead the keyset because `send_events` is range-partitioned on it
 * (mirrors `erasure-scrub.worker.ts`'s `scrubSendEventsPage`). Returns
 * `sendId` alongside the export-shaped fields so the caller can group pages
 * by their parent send; `sendId` is stripped before the row is placed under
 * `sends[].sendEvents` (the nesting already carries it).
 */
export interface SendEventPageRow extends DsrExportSendEvent {
  sendId: string;
}

export async function selectSendEventsPage(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  cursor: KeysetCursor | null,
  limit: number = DSR_EXPORT_PAGE_LIMIT
): Promise<SendEventPageRow[]> {
  const afterClause = cursor ? `AND (se.occurred_at, se.id) > ($3::timestamptz, $4::uuid)` : "";
  const params: unknown[] = cursor
    ? [workspaceId, contactId, cursor.timestamp, cursor.id, limit]
    : [workspaceId, contactId, limit];
  const limitIdx = params.length;

  const { rows } = await client.query<{
    id: string;
    sgEventId: string;
    sendId: string;
    eventType: string;
    reason: string | null;
    isTest: boolean;
    occurredAt: string;
    receivedAt: string;
    payload: unknown;
  }>(
    `SELECT
       se.id,
       se.sg_event_id as "sgEventId",
       se.send_id as "sendId",
       se.event_type as "eventType",
       se.reason,
       se.is_test as "isTest",
       se.occurred_at::text as "occurredAt",
       se.received_at::text as "receivedAt",
       se.payload
     FROM send_events se
     JOIN sends s ON s.id = se.send_id
     WHERE se.workspace_id = $1 AND s.contact_id = $2 ${afterClause}
     ORDER BY se.occurred_at ASC, se.id ASC
     LIMIT $${limitIdx}`,
    params
  );
  return rows.map((row) => ({
    id: row.id,
    sgEventId: row.sgEventId,
    sendId: row.sendId,
    eventType: row.eventType,
    reason: row.reason,
    isTest: row.isTest,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    payload: buildExportSendEventPayload(row.payload),
  }));
}

/**
 * Phase 21 plan 03 (D-10): walks a keyset page reader to exhaustion inside
 * the caller's already-open transaction, accumulating every row. No
 * checkpoint table, no cursor persistence -- this loop's whole lifetime is
 * one HTTP request's transaction, never resumed across requests (unlike the
 * erasure scrub's resumable multi-job walk).
 */
async function walkToExhaustion<Row extends { id: string }>(
  pageReader: (cursor: KeysetCursor | null) => Promise<Row[]>,
  cursorFromRow: (row: Row) => string
): Promise<Row[]> {
  const allRows: Row[] = [];
  let cursor: KeysetCursor | null = null;
  for (;;) {
    const page = await pageReader(cursor);
    if (page.length === 0) break;
    allRows.push(...page);
    const last = page[page.length - 1];
    cursor = { timestamp: cursorFromRow(last), id: last.id };
  }
  return allRows;
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

    // Phase 21 plan 03 (DSR-01, D-10): walk to exhaustion on the SAME
    // client, inside this same REPEATABLE READ transaction -- no section
    // opens a transaction of its own.
    const consentHistory = await walkToExhaustion(
      (cursor) => selectConsentHistoryPage(client, workspaceId, contactId, cursor),
      (last) => last.changedAt
    );

    // Phase 21 plan 03 (DSR-02, D-01, D-10): same discipline, `events.properties`
    // never named in the reader's SELECT.
    const events = await walkToExhaustion(
      (cursor) => selectEventsPage(client, workspaceId, contactId, cursor),
      (last) => last.occurredAt
    );

    // Phase 21 plan 05 (DSR-02, D-10): same discipline -- both walks on the
    // SAME client, inside this same REPEATABLE READ transaction.
    const sendRows = await walkToExhaustion(
      (cursor) => selectSendsPage(client, workspaceId, contactId, cursor),
      (last) => last.queuedAt
    );
    const sendEventRows = await walkToExhaustion(
      (cursor) => selectSendEventsPage(client, workspaceId, contactId, cursor),
      (last) => last.occurredAt
    );

    // Groups the whole-contact send-events walk by its parent send id, then
    // attaches each group to its send as `sendEvents` (dropping `sendId`
    // from the nested entry -- the nesting already carries it). A send
    // event whose `send_id` no longer resolves to one of this contact's
    // sends cannot appear at all: `selectSendEventsPage`'s join already
    // excludes it (T-21-05-02).
    const sendEventsBySendId = new Map<string, DsrExportSendEvent[]>();
    for (const { sendId, ...entry } of sendEventRows) {
      const group = sendEventsBySendId.get(sendId) ?? [];
      group.push(entry);
      sendEventsBySendId.set(sendId, group);
    }
    const sends: DsrExportSend[] = sendRows.map((row) => ({
      ...row,
      sendEvents: sendEventsBySendId.get(row.id) ?? [],
    }));

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
          consentHistory: consentHistory.length,
          events: events.length,
          sends: sends.length,
          sendEvents: sendEventRows.length,
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
      consentHistory,
      events,
      sends,
    };

    return document;
  });
}
