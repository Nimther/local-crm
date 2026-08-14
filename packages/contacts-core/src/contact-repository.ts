import type { PoolClient } from "pg";
import { logger } from "./logger.js";
import { registerObservedProperties } from "./property-registry.js";
import { recordSubscriptionStatusChange } from "./subscription-status-history.js";
import { hashSuppressionEmail, loadWorkspaceSuppressionKey, normalizeSuppressionEmail } from "./suppression-hash.js";

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
  /** Phase 6 (06-01, FLOW-01): IANA timezone name -- validated at the app layer only (see apps/api's contact.repository.ts); stored as opaque text here, mirroring city/country. */
  timezone: string | null;
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
  timezone,
  tags,
  properties,
  subscription_status as "subscriptionStatus",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

/**
 * CMP-04 (D-02, plan 13-12): compares by HMAC hash, never plaintext -- the
 * three write sites (`deleteContact`, `applySuppression`, and this plan's
 * backfill) now write only `email_hash`, so a plaintext comparison would
 * silently miss every address suppressed after this conversion.
 *
 * `loadWorkspaceSuppressionKey` returning `null` means this workspace has no
 * `workspace_suppression_keys` row, i.e. it has never suppressed anything --
 * that absence IS the answer, so this short-circuits to `false` without
 * performing any further query or any KMS work. This function NEVER calls
 * `ensureWorkspaceSuppressionKey`: creating a key just to hash a candidate
 * against zero rows would put key-management work on the pre-send/pre-create
 * path of every tenant with a clean suppression list, which is exactly the
 * hot-path cost the cache exists to avoid for the tenants that need it
 * least (T-13-12-05).
 */
export async function isEmailSuppressed(client: PoolClient, workspaceId: string, email: string): Promise<boolean> {
  const key = await loadWorkspaceSuppressionKey(client, workspaceId);
  if (!key) return false;

  const hash = hashSuppressionEmail(normalizeSuppressionEmail(email), key);
  const { rows } = await client.query(
    `SELECT 1 FROM workspace_suppressions WHERE workspace_id = $1 AND email_hash = $2`,
    [workspaceId, hash]
  );
  return rows.length > 0;
}

/**
 * CMP-04 (plan 13-10, Task 3): `anonymized_at IS NULL` is added here too,
 * defensively -- an anonymized row already has `email = NULL`, and `NULL =
 * $2` is never true in SQL, so this filter changes no observable behavior
 * (an anonymized row could never match anyway). Added anyway because the
 * plan calls this out explicitly among the identity-lookup reads, and a
 * reader auditing "does every contacts read here exclude anonymized rows"
 * should not have to re-derive the NULL-never-matches argument to confirm
 * it.
 */
export async function isEmailTaken(
  client: PoolClient,
  workspaceId: string,
  email: string,
  excludeContactId?: string
): Promise<boolean> {
  const { rows } = await client.query(
    excludeContactId
      ? `SELECT 1 FROM contacts WHERE workspace_id = $1 AND email = $2 AND anonymized_at IS NULL AND id != $3`
      : `SELECT 1 FROM contacts WHERE workspace_id = $1 AND email = $2 AND anonymized_at IS NULL`,
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

/**
 * Read-only identity-priority lookup (external_id first, then email) --
 * shares the exact same D-01..D-03 priority rule `upsertContactByIdentity`
 * matches against, WITHOUT locking or writing. Added for 02-07 (CSV import):
 * the D-15 "skip existing" duplicate policy needs to know whether a row's
 * identity already exists before deciding to skip it (never calling the
 * upsert at all) or create a new contact -- both apps/api's dry-run counter
 * and apps/worker's apply worker call this SAME function so neither process
 * can disagree about "does this identity already exist."
 *
 * CMP-04/T-13-10-08 (plan 13-10, Task 3, REVIEWS.md HIGH finding 3): BOTH
 * branches gain `anonymized_at IS NULL`. `deleteContact` nulls `external_id`
 * in the SAME anonymizing UPDATE that nulls `email`, which is what makes
 * this filter cost nothing rather than turn a match into a unique
 * violation: with both columns NULL on the erased row, the filtered lookup
 * finds nothing and the constraint has nothing to collide with. A future
 * reader removing either half (the UPDATE's nulling, or this filter)
 * reintroduces the defect from the other side -- an anonymized row would
 * either stay a match target (filter removed) or become an un-matchable
 * row with a live identity column the constraint could still collide on
 * (nulling removed).
 */
export async function findContactIdByIdentity(
  client: PoolClient,
  workspaceId: string,
  input: { externalId?: string; email?: string }
): Promise<string | null> {
  if (input.externalId) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM contacts WHERE workspace_id = $1 AND external_id = $2 AND anonymized_at IS NULL`,
      [workspaceId, input.externalId]
    );
    if (rows[0]) return rows[0].id;
  }
  if (input.email) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM contacts WHERE workspace_id = $1 AND email = $2 AND anonymized_at IS NULL`,
      [workspaceId, input.email]
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

export interface UpsertContactIdentityInput {
  externalId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  city?: string;
  country?: string;
  /** IANA timezone name (06-07) -- callers (csv-mapping.ts) are responsible for IANA validation before this reaches storage; stored as opaque text here, mirroring city/country. */
  timezone?: string;
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
  /**
   * True only for the brand-new-contact (Branch E) path. Added for 02-07
   * (CSV import): the imports:csv worker needs to record accurate
   * created/updated row counts for the completion report (D-18) without
   * duplicating this function's identity-match logic just to tell the two
   * cases apart -- optional field, so every pre-existing caller (the
   * Contacts API route, events:ingest worker) that ignores it is unaffected.
   */
  created?: boolean;
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
 *
 * CMP-04/T-13-10-08 (plan 13-10, Task 3, REVIEWS.md HIGH finding 3): BOTH
 * FOR UPDATE branches below gain `anonymized_at IS NULL`, for the exact
 * same reason `findContactIdByIdentity` does (see that function's own
 * comment) -- an anonymized row is never an upsert match target, which is
 * what makes a re-import create a NEW contact instead of writing PII back
 * into the erased row.
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
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = $1 AND external_id = $2 AND anonymized_at IS NULL FOR UPDATE`,
      [workspaceId, input.externalId]
    );
    existing = rows[0];
  }

  let attachExternalId = false;
  let externalIdConflict = false;

  if (!existing && input.email) {
    const { rows } = await client.query<ContactRow>(
      `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE workspace_id = $1 AND email = $2 AND anonymized_at IS NULL FOR UPDATE`,
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

    // CR-02: the INSERT is wrapped in a SAVEPOINT so a concurrent-insert
    // race (23505) can be recovered from WITHOUT aborting the caller's
    // whole transaction. Without the SAVEPOINT, a failed INSERT leaves the
    // transaction in the aborted state (Postgres semantics: any error
    // aborts the transaction unless it happened inside a subtransaction),
    // so the retry's own first statement below would itself throw 25P02
    // ("current transaction is aborted") -- the previous "retry" was dead
    // code that could never actually run.
    await client.query("SAVEPOINT upsert_insert");
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_id, external_id, email, first_name, last_name, phone, city, country, timezone, tags, properties, subscription_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
          input.timezone ?? null,
          input.tags ?? [],
          safeProperties,
          subscriptionStatus,
        ]
      );
      await client.query("RELEASE SAVEPOINT upsert_insert");
      await registerObservedProperties(client, workspaceId, safeProperties);
      return { contactId: rows[0].id, created: true };
    } catch (err) {
      if (!_isRetry && isUniqueViolation(err)) {
        // A concurrent insert raced us between the SELECTs above and this
        // INSERT -- ROLLBACK TO SAVEPOINT un-aborts the transaction (unlike
        // a bare ROLLBACK, it discards only the failed INSERT, not the
        // whole transaction), so the retry's SELECT below can now actually
        // run and resolve against whichever row won the race.
        await client.query("ROLLBACK TO SAVEPOINT upsert_insert");
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

  // WR-06/D-12: mirror updateContact's transition guards exactly -- valid
  // subscribed<->unsubscribed transitions apply, but suppressed can never
  // be set directly here nor moved back to subscribed via this path (only
  // the create-time suppression check, or a future bounce/webhook flow,
  // may set suppressed). Unlike updateContact, an invalid transition here
  // does not throw (this is a shared upsert used by unattended ingestion
  // paths, not a direct user-facing PATCH) -- it is silently skipped and
  // logged, consistent with this function's existing conflict-logging style.
  let nextStatus = existing.subscriptionStatus;
  if (input.subscriptionStatus !== undefined && input.subscriptionStatus !== existing.subscriptionStatus) {
    if (existing.subscriptionStatus === "suppressed" && input.subscriptionStatus === "subscribed") {
      logger.warn(
        {
          workspaceId,
          contactId: existing.id,
          reason: "invalid_status_transition",
          from: existing.subscriptionStatus,
          to: input.subscriptionStatus,
        },
        "upsertContactByIdentity: a suppressed contact cannot be moved back to subscribed via this path -- ignored (D-12)"
      );
    } else if (input.subscriptionStatus === "suppressed") {
      logger.warn(
        {
          workspaceId,
          contactId: existing.id,
          reason: "cannot_set_suppressed",
          from: existing.subscriptionStatus,
          to: input.subscriptionStatus,
        },
        "upsertContactByIdentity: subscription_status cannot be set to suppressed directly via this path -- ignored (D-12)"
      );
    } else {
      nextStatus = input.subscriptionStatus;
    }
  }

  await client.query(
    `UPDATE contacts SET
       external_id = $3,
       email = $4,
       first_name = $5,
       last_name = $6,
       phone = $7,
       city = $8,
       country = $9,
       timezone = $10,
       tags = $11,
       properties = $12,
       subscription_status = $13,
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
      input.timezone !== undefined ? input.timezone : existing.timezone,
      input.tags !== undefined ? input.tags : existing.tags,
      nextProperties,
      nextStatus,
    ]
  );

  // D-09: record the status transition (07-01) -- gated on an actual value
  // change so a re-upsert of the same status writes zero history rows.
  if (nextStatus !== existing.subscriptionStatus) {
    await recordSubscriptionStatusChange(client, {
      workspaceId,
      contactId: existing.id,
      oldStatus: existing.subscriptionStatus,
      newStatus: nextStatus,
      source: "csv_or_api_upsert",
    });
  }

  await registerObservedProperties(client, workspaceId, safeProperties);

  return {
    contactId: existing.id,
    attached: attachExternalId || undefined,
    emailChangeSkipped: emailChangeSkipped || undefined,
  };
}
