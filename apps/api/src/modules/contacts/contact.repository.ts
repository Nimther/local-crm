import type { PoolClient } from "pg";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
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
