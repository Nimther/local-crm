import { Queue } from "bullmq";
import { getWorkspaceId, withTenantTransaction } from "../../middleware/tenant-context.js";
import { isValidIanaTimezone } from "@mega-crm/delivery-core";
import {
  CONTACT_COLUMNS,
  ensureWorkspaceSuppressionKey,
  hashSuppressionEmail,
  isEmailSuppressed,
  isEmailTaken,
  normalizeSuppressionEmail,
  recordSubscriptionStatusChange,
  registerObservedProperties,
  upsertContactByIdentity,
  type ContactRow,
  type SubscriptionStatus,
  type UpsertContactIdentityInput,
  type UpsertContactIdentityResult,
} from "@mega-crm/contacts-core";
import {
  buildErasureScrubJobId,
  buildErasureScrubJobPayload,
  ERASURE_SCRUB_QUEUE,
  SUPPRESSION_REASON_CONTACT_DELETED,
  type ErasureScrubJob,
} from "@mega-crm/shared-schemas";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import { env } from "../../env.js";

// upsertContactByIdentity (CONT-04/EVNT-02) and its supporting helpers now
// live in @mega-crm/contacts-core -- extracted in 02-06 so apps/worker's
// events:ingest worker can reuse the exact same D-01..D-08 identity rules
// (apps/worker has no dependency path to this app's source). Re-exported
// here so every existing importer of this module (contacts-api.routes.ts,
// upsert-priority.test.ts) keeps resolving unchanged.
export { RESERVED_CONTACT_PROPERTY_KEYS } from "@mega-crm/contacts-core";
export {
  upsertContactByIdentity,
  type ContactRow,
  type SubscriptionStatus,
  type UpsertContactIdentityInput,
  type UpsertContactIdentityResult,
};

/**
 * DSR-01/D-14 (plan 21-04): `getContact`'s additive select (mirroring
 * `updateContact`'s existing precedent below) returns `anonymizedAt` too, so
 * the single-contact route can put it on the wire. Every OTHER read in this
 * file returns plain `ContactRow` -- `anonymizedAt` is `undefined` there,
 * not `null`, because those selects never fetch the column; `toContactResponse`
 * normalises `undefined` to `null` on the wire (see contacts.routes.ts).
 */
export interface ContactRowWithAnonymizedAt extends ContactRow {
  anonymizedAt?: Date | null;
}

export interface CreateContactInput {
  externalId?: string;
  email?: string;
  // CR-04: nullable on the update path (Partial<CreateContactInput> below) so
  // an explicit `null` can clear a previously-set value -- `undefined` (the
  // field omitted) still means "keep existing" in updateContact.
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  city?: string | null;
  country?: string | null;
  /** IANA timezone name (06-07, FLOW-05/D-08) -- validated via `isValidIanaTimezone` before ever reaching storage (T-06-07-01). `null` explicitly clears it (CR-04 convention). */
  timezone?: string | null;
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

export interface ContactEventRow {
  id: string;
  name: string;
  properties: Record<string, unknown>;
  occurredAt: Date;
  receivedAt: Date;
}

const CONTACT_EVENTS_PAGE_SIZE = 50;

/**
 * D-14/EVNT-01: the contact-card live event feed's read path. Newest-first,
 * paginated (T-02-08-02 -- unbounded reads are a DoS risk at this table's
 * write volume), scoped by BOTH workspace_id and contact_id -- RLS on the
 * partitioned `events` parent table (0007_events_partitioned.sql) is the
 * defense-in-depth layer underneath this explicit filter (T-02-08-01).
 */
export async function listContactEvents(
  contactId: string,
  options: { page: number } = { page: 1 }
): Promise<ContactEventRow[]> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const page = Math.max(1, options.page);
    const { rows } = await client.query<ContactEventRow>(
      `SELECT id, name, properties, occurred_at as "occurredAt", received_at as "receivedAt"
       FROM events
       WHERE workspace_id = $1 AND contact_id = $2
       ORDER BY occurred_at DESC
       LIMIT $3 OFFSET $4`,
      [workspaceId, contactId, CONTACT_EVENTS_PAGE_SIZE, (page - 1) * CONTACT_EVENTS_PAGE_SIZE]
    );
    return rows;
  });
}

/**
 * Thrown for the D-01/D-07 email-uniqueness rule and the D-12
 * suppressed/subscription-status transition rules -- contacts.routes.ts
 * maps every code here to a 409 response.
 */
export class ContactConflictError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "email_taken"
      | "invalid_status_transition"
      | "cannot_set_suppressed"
      // CMP-04 (plan 13-10, Task 3): thrown by updateContact when the
      // targeted row has already been anonymized. contacts.routes.ts
      // deliberately maps THIS code to 404 (not the usual 409) -- an
      // anonymized contact must never be presented to a tenant as a live
      // contact (threat T-13-10-03's prohibition), so the wire-visible
      // outcome is identical to "contact not found", the same as if the
      // row had been hard-deleted. The typed error/code still exists so
      // the refusal is explicit internally (logging, tests) rather than a
      // silent zero-row UPDATE or an accidental PII repopulation.
      | "contact_anonymized"
  ) {
    super(message);
    this.name = "ContactConflictError";
  }
}

/**
 * 06-07/T-06-07-01: thrown when a provided `timezone` fails the
 * `isValidIanaTimezone` allowlist check -- distinct from
 * `ContactConflictError` (409 conflict) because this is a 400 input-
 * validation failure, not a state conflict. contacts.routes.ts maps this to
 * a 400 response.
 */
export class ContactValidationError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_timezone"
  ) {
    super(message);
    this.name = "ContactValidationError";
  }
}

/** Shared by createContact/updateContact -- never stores an invalid IANA zone (T-06-07-01). `null`/`undefined` pass through untouched. */
function assertValidTimezone(timezone: string | null | undefined): void {
  if (timezone && !isValidIanaTimezone(timezone)) {
    throw new ContactValidationError(`"${timezone}" is not a valid IANA timezone`, "invalid_timezone");
  }
}

/**
 * D-13: search (email/first_name/last_name/external_id) + status/tag filters,
 * sort, offset/limit pagination. `anonymized_at IS NULL` (CMP-04, plan
 * 13-10, Task 3) is a tenant-visibility filter, not a soft-delete
 * convention -- evidence queries over sends/send_events/
 * subscription_status_history deliberately do NOT apply it.
 */
export async function listContacts(query: ListContactsQuery): Promise<ListContactsResult> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const conditions: string[] = ["workspace_id = $1", "anonymized_at IS NULL"];
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

/**
 * CMP-04/T-13-10-03 (plan 13-10, Task 2 deviation Rule 3): `anonymized_at IS
 * NULL` is pulled forward into THIS task rather than left for Task 3's full
 * enumeration, because Task 2's own `<verify>` runs `contact-crud.test.ts`,
 * whose "delete removes the contact -- subsequent GET is 404" assertion
 * would otherwise regress the moment `deleteContact` stops hard-deleting
 * the row below: an anonymized row with no filter here would make this
 * read return 200 with a nameless, emailless contact instead of 404. Task
 * 3 still owns the FULL enumeration (list, count, isEmailTaken, the
 * contacts-core identity lookups, segment/audience reads) and records it
 * in the SUMMARY -- this is a tenant-visibility filter, not a soft-delete
 * convention, and evidence queries over sends/send_events/
 * subscription_status_history deliberately do NOT apply it.
 */
export async function getContact(id: string): Promise<ContactRowWithAnonymizedAt | null> {
  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    const { rows } = await client.query<ContactRowWithAnonymizedAt>(
      `SELECT ${CONTACT_COLUMNS}, anonymized_at as "anonymizedAt" FROM contacts WHERE workspace_id = $1 AND id = $2 AND anonymized_at IS NULL`,
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
  assertValidTimezone(input.timezone);

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
         (workspace_id, external_id, email, first_name, last_name, phone, city, country, timezone, tags, properties, subscription_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        input.timezone ?? null,
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
  assertValidTimezone(patch.timezone);

  return withTenantTransaction(async (client) => {
    const workspaceId = getWorkspaceId();
    // CMP-04 (plan 13-10, Task 3): reads `anonymized_at` too, in addition to
    // CONTACT_COLUMNS -- deliberately NOT filtered by `anonymized_at IS
    // NULL` here (unlike every OTHER read in this file), because this
    // function needs to tell "no such contact" (existing is undefined)
    // apart from "found, but anonymized" (existing.anonymizedAt is set) so
    // it can refuse the second case explicitly rather than silently
    // updating zero rows or repopulating a scrubbed column.
    const { rows: existingRows } = await client.query<ContactRow & { anonymizedAt: Date | null }>(
      `SELECT ${CONTACT_COLUMNS}, anonymized_at as "anonymizedAt" FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = existingRows[0];
    if (!existing) return null;
    if (existing.anonymizedAt !== null) {
      throw new ContactConflictError(`Contact ${id} has been anonymized and cannot be modified`, "contact_anonymized");
    }

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

    // CR-04: full replacement, not a merge -- when the caller sends a
    // `properties` object (even `{}` after removing the last key) it
    // replaces the stored value wholesale, so a removed key actually stays
    // removed. Omitting `properties` entirely (undefined, e.g. the
    // Overview-tab PATCH) keeps the existing value untouched.
    const nextProperties = patch.properties ?? existing.properties;

    const { rows } = await client.query<ContactRow>(
      `UPDATE contacts SET
         email = $3,
         external_id = $4,
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
        patch.timezone !== undefined ? patch.timezone : existing.timezone,
        patch.tags !== undefined ? patch.tags : existing.tags,
        nextProperties,
        nextStatus,
      ]
    );

    // D-09 (07-01): record the status transition -- gated on an actual
    // value change so updating a contact to its current status writes zero
    // history rows.
    if (nextStatus !== existing.subscriptionStatus) {
      await recordSubscriptionStatusChange(client, {
        workspaceId,
        contactId: existing.id,
        oldStatus: existing.subscriptionStatus,
        newStatus: nextStatus,
        source: "manual_ui",
      });
    }

    await registerObservedProperties(client, workspaceId, patch.properties);

    return rows[0];
  });
}

/**
 * Producer-side BullMQ Queue for ERASURE_SCRUB_QUEUE (CMP-04, plan 13-10) --
 * the consumer is plan 13-13's future scrub worker. Module-singleton, built
 * through the shared `@mega-crm/queue-core` factory (Phase 12, WRK-11,
 * D-10) like every other producer in this codebase -- never a hand-rolled
 * connection/job-options literal.
 *
 * Phase 15 plan 13 (OPS-13, Rule 3): exported (was module-private) so
 * `apps/api/src/modules/ops/queue-monitor.ts` can read this queue's job
 * counts through the SAME handle this module already holds, instead of
 * constructing a second, duplicate `Queue` instance for the same
 * `ERASURE_SCRUB_QUEUE` name -- exactly the "reuse the seven Queue handles
 * apps/api already constructs" instruction that plan's Task 1 gives.
 */
export const erasureScrubQueue = new Queue<ErasureScrubJob>(ERASURE_SCRUB_QUEUE, {
  connection: buildRedisConnectionOptions(env.REDIS_URL),
  defaultJobOptions: buildJobOptions(STANDARD_JOB_RETENTION),
});

async function defaultEnqueueErasureScrub(payload: ErasureScrubJob, jobId: string): Promise<void> {
  await erasureScrubQueue.add("erasure-scrub", payload, { jobId });
}

export interface DeleteContactDeps {
  /**
   * Test-only failure-injection seam (T-13-10-02's atomicity criterion):
   * called immediately BEFORE the `erasure_records` INSERT, inside the same
   * transaction as the anonymizing UPDATE and the suppression INSERT.
   * Throwing here proves all three writes roll back together. Defaults to
   * a no-op so every existing caller is unaffected.
   */
  beforeErasureRecordWrite?: () => Promise<void> | void;
  /**
   * Enqueues the erasure-scrub job AFTER the transaction commits -- never
   * inside it (REVIEWS.md (Codex) BLOCKER finding 3: a job enqueued inside
   * a transaction that then rolls back would reference an `erasure_records`
   * id that never existed, which nothing in the system can distinguish
   * from a bug; a committed erasure whose enqueue fails is instead a
   * durable `pending` `erasure_records` row plan 13-15's reclaimer can find
   * and re-enqueue). Injectable so plan 13-15's failure-injection scenario
   * -- and this plan's own enqueue-failure acceptance criterion -- can fail
   * this exact seam without a live BullMQ Queue/Redis round trip or a
   * module-singleton stub. Defaults to the real `erasureScrubQueue.add`.
   */
  enqueueErasureScrub?: (payload: ErasureScrubJob, jobId: string) => Promise<void>;
}

interface DeleteContactTxResult {
  erased: boolean;
  alreadyAnonymized: boolean;
  workspaceId: string;
  erasureRecordId?: string;
}

/**
 * CMP-04 (D-01/D-04, plan 13-10): erasure, not row removal. The row and its
 * foreign keys (`sends`, `subscription_status_history`, `events`) survive;
 * mail stops in THIS request because the suppression entry and status are
 * resolved here, synchronously; the JSONB PII in linked `send_events` and
 * `events` rows is scrubbed asynchronously by the job this enqueues,
 * tracked to completion by the `erasure_records` row it writes.
 *
 * Inside one transaction, in order:
 *  1. `SELECT ... FOR UPDATE` captures the pre-erasure email/status/
 *     anonymized_at under a row lock, BEFORE anything is written. `FOR
 *     UPDATE` holds the row against a concurrent delete/update for the
 *     rest of the transaction, so the address captured here is provably
 *     the address the anonymizing UPDATE is about to scrub. A row with a
 *     non-null `anonymizedAt` short-circuits here (already erased --
 *     return true, write nothing further, so a retried request cannot
 *     create a second erasure record or a second scrub job).
 *  2. The anonymizing UPDATE nulls every PII/identity column named in the
 *     schema (`email`, `first_name`, `last_name`, `phone`, `external_id`,
 *     `city`, `country`, `timezone`) and empties `tags`/`properties`
 *     ([Rule 2 - Missing critical functionality]: the plan's own text names
 *     only email/first_name/last_name/phone/external_id/attributes, but
 *     `contacts` has no `attributes` column -- the freeform JSONB bag is
 *     named `properties` -- and Task 1's schema read additionally surfaced
 *     four more personal-data columns the plan text never named: `city`,
 *     `country`, `timezone`, `tags`. T-13-10-01's disposition is
 *     `mitigate` against "incomplete PII scrub", which makes closing this
 *     gap a correctness requirement, not a scope expansion). `external_id`
 *     is scrubbed here (not merely filtered in Task 3's reads) because the
 *     shared identity lookup in `packages/contacts-core/src/contact-repository.ts`
 *     resolves external_id BEFORE email -- an anonymized row that kept it
 *     would stay addressable by the one identifier erasure did not remove.
 *     Steps 2 and later NEVER read a value back from THIS statement's own
 *     `RETURNING` -- Postgres's `RETURNING` yields POST-update values, so
 *     an `UPDATE ... SET email = NULL ... RETURNING email` would return
 *     null. Every downstream write below uses the value captured in step 1.
 *  3. The suppression INSERT runs UNCONDITIONALLY on every erasure -- not
 *     gated on the pre-erasure subscription status (REVIEWS.md (Codex)
 *     BLOCKER finding 1: the old gate left a currently-subscribed contact's
 *     address freely re-importable and immediately mailable after erasure,
 *     the exact outcome CMP-04 exists to prevent). The ONE surviving guard
 *     is a null captured email -- a contact with no address has nothing to
 *     hash and nothing to suppress (CMP-04, D-02, plan 13-12: this insert
 *     writes only `email_hash`, computed from the captured address under
 *     this workspace's own key; see step 3's own code comment).
 *  4. The `beforeErasureRecordWrite` test seam, then the `erasure_records`
 *     INSERT (`status = 'pending'`) -- in the SAME transaction as steps 2-3,
 *     so a crash cannot leave an anonymized row with no auditable record of
 *     why, and an injected failure here rolls back the anonymization and
 *     the suppression insert too.
 *
 * AFTER the transaction commits (never inside it, see `DeleteContactDeps`'s
 * own comment), exactly one erasure-scrub job is enqueued with a
 * deterministic `jobId` derived from the erasure record's own id
 * (`buildErasureScrubJobId`) -- calling delete twice for the same contact
 * therefore enqueues at most one job, because the second call's row lock
 * finds `anonymizedAt` already set and returns before reaching step 2.
 */
export async function deleteContact(id: string, deps: DeleteContactDeps = {}): Promise<boolean> {
  const result = await withTenantTransaction(async (client): Promise<DeleteContactTxResult> => {
    const workspaceId = getWorkspaceId();

    // Step 1: capture pre-erasure identity under a row lock, before
    // anything is written.
    const { rows } = await client.query<{
      email: string | null;
      subscriptionStatus: SubscriptionStatus;
      anonymizedAt: Date | null;
    }>(
      `SELECT email, subscription_status as "subscriptionStatus", anonymized_at as "anonymizedAt"
       FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [workspaceId, id]
    );
    const existing = rows[0];
    if (!existing) {
      return { erased: false, alreadyAnonymized: false, workspaceId };
    }
    if (existing.anonymizedAt !== null) {
      // Already erased -- idempotent no-op, no second record/job.
      return { erased: true, alreadyAnonymized: true, workspaceId };
    }

    // Step 2: the anonymizing UPDATE. Computed once in JS (not two separate
    // `now()` calls) so the same instant is written to both `contacts.anonymized_at`
    // and `erasure_records.anonymized_at` below.
    const anonymizedAt = new Date();
    await client.query(
      `UPDATE contacts SET
         email = NULL,
         first_name = NULL,
         last_name = NULL,
         phone = NULL,
         external_id = NULL,
         city = NULL,
         country = NULL,
         timezone = NULL,
         tags = '{}',
         properties = '{}'::jsonb,
         anonymized_at = $3,
         updated_at = now()
       WHERE workspace_id = $1 AND id = $2 AND anonymized_at IS NULL`,
      [workspaceId, id, anonymizedAt]
    );

    // Step 3: unconditional suppression write, from the value captured in
    // step 1 -- the ONE surviving guard is a null captured email. CMP-04
    // (D-02, plan 13-12): hashes the captured address under this workspace's
    // own key and writes ONLY the hash -- never the plaintext `email`
    // column, which this write site no longer populates at all.
    // `ensureWorkspaceSuppressionKey` is safe to call unconditionally here
    // (unlike the read-only `isEmailSuppressed`): this write site is the
    // first-ever suppression for a workspace exactly once, and creating the
    // key on that occasion is the intended, one-time cost.
    if (existing.email) {
      const key = await ensureWorkspaceSuppressionKey(client, workspaceId);
      const hash = hashSuppressionEmail(normalizeSuppressionEmail(existing.email), key);
      await client.query(
        `INSERT INTO workspace_suppressions (workspace_id, email_hash, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, email_hash) DO NOTHING`,
        [workspaceId, hash, SUPPRESSION_REASON_CONTACT_DELETED]
      );
    }

    // Step 4: the auditable proof, same transaction as steps 2-3.
    await deps.beforeErasureRecordWrite?.();
    const { rows: erasureRows } = await client.query<{ id: string }>(
      `INSERT INTO erasure_records (workspace_id, contact_id, anonymized_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [workspaceId, id, anonymizedAt]
    );

    return { erased: true, alreadyAnonymized: false, workspaceId, erasureRecordId: erasureRows[0].id };
  });

  // AFTER commit: enqueue exactly one scrub job for a fresh erasure. Never
  // for the already-anonymized short-circuit (no new erasure record to
  // scrub) and never for "no such contact".
  if (result.erased && !result.alreadyAnonymized && result.erasureRecordId) {
    const jobId = buildErasureScrubJobId(result.erasureRecordId);
    const payload = buildErasureScrubJobPayload(result.workspaceId, id, result.erasureRecordId);
    const enqueue = deps.enqueueErasureScrub ?? defaultEnqueueErasureScrub;
    await enqueue(payload, jobId);
  }

  return result.erased;
}
