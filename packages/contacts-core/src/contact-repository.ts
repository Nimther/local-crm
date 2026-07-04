import type { PoolClient } from "pg";
import { logger } from "./logger.js";
import { registerObservedProperties } from "./property-registry.js";

export type SubscriptionStatus = "subscribed" | "unsubscribed" | "suppressed";

export interface ContactRow {
  id: string;
  workspaceId: string;
  externalId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  tags: string[];
  properties: Record<string, unknown>;
  subscriptionStatus: SubscriptionStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Column list shared by every read/write of `contacts` that needs the full row shape. */
export const CONTACT_COLUMNS = `
  id,
  workspace_id as "workspaceId",
  external_id as "externalId",
  email,
  first_name as "firstName",
  last_name as "lastName",
  phone,
  city,
  country,
  tags,
  properties,
  subscription_status as "subscriptionStatus",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export async function isEmailSuppressed(client: PoolClient, workspaceId: string, email: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM workspace_suppressions WHERE workspace_id = $1 AND email = $2`,
    [workspaceId, email]
  );
  return rows.length > 0;
}

export async function isEmailTaken(
  client: PoolClient,
  workspaceId: string,
  email: string,
  excludeContactId?: string
): Promise<boolean> {
  const { rows } = await client.query(
    excludeContactId
      ? `SELECT 1 FROM contacts WHERE workspace_id = $1 AND email = $2 AND id != $3`
      : `SELECT 1 FROM contacts WHERE workspace_id = $1 AND email = $2`,
    excludeContactId ? [workspaceId, email, excludeContactId] : [workspaceId, email]
  );
  return rows.length > 0;
}

/**
 * Pitfall 4: property keys that map to platform-managed columns must never
 * reach the freeform `properties` JSONB merge, from ANY of
 * `upsertContactByIdentity`'s call sites (the Contacts API route, the
 * events:ingest worker EVNT-02, the imports:csv worker).
 */
export const RESERVED_CONTACT_PROPERTY_KEYS = new Set([
  "id",
  "workspace_id",
  "external_id",
  "email",
  "subscription_status",
]);

function stripReservedPropertyKeys(properties: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!properties) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (RESERVED_CONTACT_PROPERTY_KEYS.has(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");
}

export interface UpsertContactIdentityInput {
  externalId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  city?: string;
  country?: string;
  tags?: string[];
  properties?: Record<string, unknown>;
  subscriptionStatus?: SubscriptionStatus;
}

export interface UpsertContactIdentityResult {
  contactId: string;
  /** D-03: true when this call attached a previously-absent external_id to an email-matched contact. */
  attached?: boolean;
  /** D-04/D-05: true when an incoming email collided with a DIFFERENT contact and the change was skipped. */
  emailChangeSkipped?: boolean;
}

/**
 * CONT-04/EVNT-02: the SINGLE prioritized two-key upsert -- called from the
 * Contacts API route (`apps/api`), the events:ingest worker (`apps/worker`,
 * 02-06), and the imports:csv worker (02-07). Extracted into this shared
 * package (rather than living only in `apps/api`) so `apps/worker` -- a
 * separate process/app with no dependency path to `apps/api`'s source --
 * can reuse the exact same D-01..D-08 identity rules without drift (same
 * reasoning as the `@mega-crm/tenant-context` extraction in 02-05).
 *
 * Must be called with `client` already inside an open tenant transaction --
 * Postgres's `INSERT ... ON CONFLICT` can only target ONE named constraint
 * per statement, so external_id-then-email priority is resolved here via an
 * explicit `SELECT ... FOR UPDATE` + branch, never a single SQL statement
 * (Pitfall 2 / RESEARCH.md Anti-Patterns).
 *
 * Branches:
 *  A. external_id match -> update in place.
 *  B. email match, no external_id on file yet, incoming one present ->
 *     attach it as the new identity anchor (D-03).
 *  C. email match, an external_id is ALREADY set and DIFFERS from the
 *     incoming one -> the incoming external_id is ignored (D-06: the
 *     anchor is immutable) and a structured conflict is logged.
 *  D. the incoming email (on a contact matched via EITHER branch above) is
 *     already owned by a DIFFERENT contact -> the email change is skipped
 *     and a structured conflict is logged (D-04/D-05); every other field
 *     still applies.
 *  E. no match at all -> insert a new contact; the workspace suppression
 *     list overrides any requested status (D-08/D-11); a concurrent unique
 *     violation (a race between the SELECTs above and this INSERT) is
 *     caught and retried once against whichever row won (optimistic-upsert
 *     defense-in-depth).
 *
 * Reserved property keys (Pitfall 4) are stripped before ANY properties
 * merge, and every surviving custom key is recorded via the single shared
 * `registerObservedProperty` helper (D-10).
 */
export async function upsertContactByIdentity(
  client: PoolClient,
  workspaceId: string,
  input: UpsertContactIdentityInput,
  _isRetry = false
): Promise<UpsertContactIdentityResult> {
  const safeProperties = stripReservedPropertyKeys(input.properties);

  let existing: ContactRow | undefined;

  if (input.externalId) {
    const { rows } = await client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = $1 AND external_id = $2 FOR UPDATE`,
      [workspaceId, input.externalId]
    );
    existing = rows[0];
  }

  let attachExternalId = false;
  let externalIdConflict = false;

  if (!existing && input.email) {
    const { rows } = await client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = $1 AND email = $2 FOR UPDATE`,
      [workspaceId, input.email]
    );
    existing = rows[0];
    if (existing) {
      if (!existing.externalId && input.externalId) {
        attachExternalId = true; // D-03
      } else if (existing.externalId && input.externalId && existing.externalId !== input.externalId) {
        externalIdConflict = true; // Branch C / A1
      }
    }
  }

  if (!existing) {
    // Branch E: neither identifier matched -- new contact.
    let subscriptionStatus: SubscriptionStatus = input.subscriptionStatus ?? "subscribed";
    if (input.email && (await isEmailSuppressed(client, workspaceId, input.email))) {
      subscriptionStatus = "suppressed"; // D-08/D-11
    }

    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_id, external_id, email, first_name, last_name, phone, city, country, tags, properties, subscription_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          workspaceId,
          input.externalId ?? null,
          input.email ?? null,
          input.firstName ?? null,
          input.lastName ?? null,
          input.phone ?? null,
          input.city ?? null,
          input.country ?? null,
          input.tags ?? [],
          safeProperties,
          subscriptionStatus,
        ]
      );
      await registerObservedProperties(client, workspaceId, safeProperties);
      return { contactId: rows[0].id };
    } catch (err) {
      if (!_isRetry && isUniqueViolation(err)) {
        // A concurrent insert raced us between the SELECTs above and this
        // INSERT -- retry once, now resolving against whichever row won.
        return upsertContactByIdentity(client, workspaceId, input, true);
      }
      throw err;
    }
  }

  // Branches A/B/C matched an existing contact -- D-04: check whether the
  // incoming email (if changing) is already owned by someone else BEFORE
  // applying it.
  let nextEmail = existing.email;
  let emailChangeSkipped = false;
  if (input.email && input.email !== existing.email) {
    const emailTakenByAnother = await isEmailTaken(client, workspaceId, input.email, existing.id);
    if (emailTakenByAnother) {
      emailChangeSkipped = true;
      logger.warn(
        { workspaceId, contactId: existing.id, reason: "email_conflict", incomingEmail: input.email },
        "upsertContactByIdentity: incoming email already belongs to a different contact -- email change skipped (D-04)"
      );
    } else {
      nextEmail = input.email;
    }
  }

  let nextExternalId = existing.externalId;
  if (attachExternalId) {
    nextExternalId = input.externalId ?? null;
  } else if (externalIdConflict) {
    logger.warn(
      { workspaceId, contactId: existing.id, reason: "external_id_conflict", incomingExternalId: input.externalId },
      "upsertContactByIdentity: incoming external_id differs from the contact's existing identity anchor -- ignored (D-06/A1)"
    );
  }

  const nextProperties =
    Object.keys(safeProperties).length > 0 ? { ...existing.properties, ...safeProperties } : existing.properties;

  await client.query(
    `UPDATE contacts SET
       external_id = $3,
       email = $4,
       first_name = $5,
       last_name = $6,
       phone = $7,
       city = $8,
       country = $9,
       tags = $10,
       properties = $11,
       updated_at = now()
     WHERE workspace_id = $1 AND id = $2`,
    [
      workspaceId,
      existing.id,
      nextExternalId,
      nextEmail,
      input.firstName !== undefined ? input.firstName : existing.firstName,
      input.lastName !== undefined ? input.lastName : existing.lastName,
      input.phone !== undefined ? input.phone : existing.phone,
      input.city !== undefined ? input.city : existing.city,
      input.country !== undefined ? input.country : existing.country,
      input.tags !== undefined ? input.tags : existing.tags,
      nextProperties,
    ]
  );

  await registerObservedProperties(client, workspaceId, safeProperties);

  return {
    contactId: existing.id,
    attached: attachExternalId || undefined,
    emailChangeSkipped: emailChangeSkipped || undefined,
  };
}
