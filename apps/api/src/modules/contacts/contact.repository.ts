import type { PoolClient } from "pg";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import { logger } from "../../logger.js";
import { registerObservedProperty } from "./property-registry.js";

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

export interface CreateContactInput {
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

export type UpdateContactInput = Partial<CreateContactInput>;

export interface ListContactsQuery {
  search?: string;
  status?: SubscriptionStatus;
  tag?: string;
  sort?: "createdAt" | "-createdAt" | "email" | "-email";
  page: number;
  pageSize: number;
}

export interface ListContactsResult {
  items: ContactRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Thrown for the D-01/D-07 email-uniqueness rule and the D-12
 * suppressed/subscription-status transition rules -- contacts.routes.ts
 * maps every code here to a 409 response.
 */
export class ContactConflictError extends Error {
  constructor(
    message: string,
    public readonly code: "email_taken" | "invalid_status_transition" | "cannot_set_suppressed"
  ) {
    super(message);
    this.name = "ContactConflictError";
  }
}

const CONTACT_COLUMNS = `
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

async function isEmailSuppressed(client: PoolClient, workspaceId: string, email: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM workspace_suppressions WHERE workspace_id = $1 AND email = $2`,
    [workspaceId, email]
  );
  return rows.length > 0;
}

async function isEmailTaken(
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

async function registerObservedProperties(
  client: PoolClient,
  workspaceId: string,
  properties: Record<string, unknown> | undefined
): Promise<void> {
  if (!properties) return;
  for (const [key, value] of Object.entries(properties)) {
    await registerObservedProperty(client, workspaceId, key, value);
  }
}

/**
 * Pitfall 4: property keys that map to platform-managed columns must never
 * reach the freeform `properties` JSONB merge, from ANY of
 * `upsertContactByIdentity`'s three call sites (this API route, the
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
 * Contacts API route (this plan), the events:ingest worker (02-06), and the
 * imports:csv worker (02-07). Must be called with `client` already inside an
 * open `withTenantTransaction` (RESEARCH.md Pattern 1) -- Postgres's
 * `INSERT ... ON CONFLICT` can only target ONE named constraint per
 * statement, so external_id-then-email priority is resolved here via an
 * explicit `SELECT ... FOR UPDATE` + branch, never a single SQL statement
 * (Pitfall 2 / RESEARCH.md Anti-Patterns).
 *
 * Branches:
 *  A. external_id match -> update in place.
 *  B. email match, no external_id on file yet, incoming one present ->
 *     attach it as the new identity anchor (D-03).
 *  C. email match, an external_id is ALREADY set and DIFFERS from the
 *     incoming one -> the incoming external_id is ignored (D-06: the
 *     anchor is immutable) and a structured conflict is logged (RESEARCH
 *     Open Question 1 / Assumption A1).
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

/** D-13: search (email/first_name/last_name/external_id) + status/tag filters, sort, offset/limit pagination. */
export async function listContacts(query: ListContactsQuery): Promise<ListContactsResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const conditions: string[] = ["workspace_id = $1"];
    const params: unknown[] = [workspaceId];

    if (query.search) {
      params.push(`%${query.search}%`);
      const idx = params.length;
      conditions.push(
        `(email ILIKE $${idx} OR first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR external_id ILIKE $${idx})`
      );
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`subscription_status = $${params.length}`);
    }
    if (query.tag) {
      params.push(query.tag);
      conditions.push(`$${params.length} = ANY(tags)`);
    }

    const whereClause = conditions.join(" AND ");

    // Default: newest-first (no explicit sort requested).
    let sortColumn = "created_at";
    let sortDirection: "ASC" | "DESC" = "DESC";
    if (query.sort === "email") {
      sortColumn = "email";
      sortDirection = "ASC";
    } else if (query.sort === "-email") {
      sortColumn = "email";
      sortDirection = "DESC";
    } else if (query.sort === "createdAt") {
      sortColumn = "created_at";
      sortDirection = "ASC";
    } else if (query.sort === "-createdAt") {
      sortColumn = "created_at";
      sortDirection = "DESC";
    }

    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM contacts WHERE ${whereClause}`,
      params
    );

    params.push(query.pageSize, (query.page - 1) * query.pageSize);
    const { rows } = await client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE ${whereClause}
       ORDER BY ${sortColumn} ${sortDirection}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    return {
      items: rows,
      total: Number(countRows[0]?.count ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

export async function getContact(id: string): Promise<ContactRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, id]
    );
    return rows[0] ?? null;
  });
}

/**
 * D-01: rejects a duplicate email within the workspace.
 * D-08/D-11: the workspace suppression list ALWAYS overrides the requested
 * (or default "subscribed") status -- compliance protection against
 * "deleted -> reimported -> resubscribed".
 */
export async function createContact(input: CreateContactInput): Promise<ContactRow> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();

    if (input.email && (await isEmailTaken(client, workspaceId, input.email))) {
      throw new ContactConflictError(
        `Email ${input.email} is already used by another contact in this workspace`,
        "email_taken"
      );
    }

    let subscriptionStatus: SubscriptionStatus = input.subscriptionStatus ?? "subscribed";
    if (input.email && (await isEmailSuppressed(client, workspaceId, input.email))) {
      subscriptionStatus = "suppressed";
    }

    const { rows } = await client.query<ContactRow>(
      `INSERT INTO contacts
         (workspace_id, external_id, email, first_name, last_name, phone, city, country, tags, properties, subscription_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${CONTACT_COLUMNS}`,
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
        input.properties ?? {},
        subscriptionStatus,
      ]
    );

    await registerObservedProperties(client, workspaceId, input.properties);

    return rows[0];
  });
}

/**
 * D-06: external_id is an identity anchor -- settable once (while null),
 * then immutable; a change attempt against an already-set external_id is
 * silently ignored (not an error), matching the "rejected/ignored" wording.
 * D-07: email is editable with a uniqueness check.
 * D-12: subscribed<->unsubscribed is allowed; suppressed cannot be moved to
 * subscribed via this path, and suppressed cannot be SET directly here
 * either -- only the create-time suppression check (or a future
 * bounce/webhook flow) may set it (T-02-01-02).
 */
export async function updateContact(id: string, patch: UpdateContactInput): Promise<ContactRow | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows: existingRows } = await client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = existingRows[0];
    if (!existing) return null;

    let nextEmail = existing.email;
    if (patch.email !== undefined && patch.email !== existing.email) {
      if (await isEmailTaken(client, workspaceId, patch.email, id)) {
        throw new ContactConflictError(
          `Email ${patch.email} is already used by another contact in this workspace`,
          "email_taken"
        );
      }
      nextEmail = patch.email;
    }

    // D-06: only attach when previously unset; otherwise silently ignore.
    const nextExternalId = existing.externalId ? existing.externalId : (patch.externalId ?? existing.externalId);

    let nextStatus = existing.subscriptionStatus;
    if (patch.subscriptionStatus !== undefined && patch.subscriptionStatus !== existing.subscriptionStatus) {
      if (existing.subscriptionStatus === "suppressed" && patch.subscriptionStatus === "subscribed") {
        throw new ContactConflictError(
          "A suppressed contact cannot be moved back to subscribed via the ordinary update path",
          "invalid_status_transition"
        );
      }
      if (patch.subscriptionStatus === "suppressed") {
        throw new ContactConflictError(
          "subscription_status cannot be set to suppressed directly -- only automated bounce/spam handling may do so",
          "cannot_set_suppressed"
        );
      }
      nextStatus = patch.subscriptionStatus;
    }

    const nextProperties = patch.properties ? { ...existing.properties, ...patch.properties } : existing.properties;

    const { rows } = await client.query<ContactRow>(
      `UPDATE contacts SET
         email = $3,
         external_id = $4,
         first_name = $5,
         last_name = $6,
         phone = $7,
         city = $8,
         country = $9,
         tags = $10,
         properties = $11,
         subscription_status = $12,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2
       RETURNING ${CONTACT_COLUMNS}`,
      [
        workspaceId,
        id,
        nextEmail,
        nextExternalId,
        patch.firstName !== undefined ? patch.firstName : existing.firstName,
        patch.lastName !== undefined ? patch.lastName : existing.lastName,
        patch.phone !== undefined ? patch.phone : existing.phone,
        patch.city !== undefined ? patch.city : existing.city,
        patch.country !== undefined ? patch.country : existing.country,
        patch.tags !== undefined ? patch.tags : existing.tags,
        nextProperties,
        nextStatus,
      ]
    );

    await registerObservedProperties(client, workspaceId, patch.properties);

    return rows[0];
  });
}

/** D-08: an unsubscribed/suppressed contact's email is preserved in the workspace suppression list on delete. */
export async function deleteContact(id: string): Promise<boolean> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<{ email: string | null; subscriptionStatus: SubscriptionStatus }>(
      `DELETE FROM contacts WHERE workspace_id = $1 AND id = $2
       RETURNING email, subscription_status as "subscriptionStatus"`,
      [workspaceId, id]
    );
    const deleted = rows[0];
    if (!deleted) return false;

    if (
      deleted.email &&
      (deleted.subscriptionStatus === "unsubscribed" || deleted.subscriptionStatus === "suppressed")
    ) {
      await client.query(
        `INSERT INTO workspace_suppressions (workspace_id, email, reason)
         VALUES ($1, $2, 'contact_deleted')
         ON CONFLICT (workspace_id, email) DO NOTHING`,
        [workspaceId, deleted.email]
      );
    }

    return true;
  });
}
