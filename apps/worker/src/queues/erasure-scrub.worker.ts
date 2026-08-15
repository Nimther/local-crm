import { Worker, type ConnectionOptions, type Job } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { buildJobOptions, buildRedisConnectionOptions, STANDARD_JOB_RETENTION } from "@mega-crm/queue-core";
import type { BuiltJobOptions } from "@mega-crm/queue-core";
import { ERASURE_SCRUB_QUEUE, erasureScrubJobSchema, type ErasureScrubJob } from "@mega-crm/shared-schemas";
import { wrapProcessor } from "../processor-wrapper.js";
import type { ErasureRecordStatus } from "@mega-crm/db";
import {
  advanceErasureScrubCheckpoint,
  loadErasureScrubCheckpoint,
  type ScrubCursor,
  type ScrubTable,
} from "./erasure-scrub-checkpoint.js";

/**
 * Phase 13 (CMP-04, D-01/D-04, plan 13-13): the asynchronous evidence-hygiene
 * half of contact erasure. Plan 13-10's `deleteContact` anonymizes the
 * `contacts` row synchronously and enqueues exactly one job on
 * `ERASURE_SCRUB_QUEUE`; this file consumes it, walking the erased contact's
 * linked `send_events.payload` and `events.properties` rows in bounded,
 * resumable pages and rewriting each JSONB value.
 *
 * ALLOWLIST RECONSTRUCTION, NOT A DENYLIST FILTER (REVIEWS.md (Codex)
 * BLOCKER finding 4 -- this reverses an earlier version of this plan that
 * directed reuse of `@mega-crm/redaction`'s `REDACTION_RULES`). A denylist
 * can only remove what someone anticipated: `REDACTION_RULES`'s `keyRules`
 * match known field NAMES and its `valueRules` backstop narrows the gap for
 * email/phone-SHAPED values, but neither can bound `events.properties`,
 * whose entire key space is tenant-invented, or a `send_events.payload`
 * field like `reason`/`response` that carries the recipient's address inside
 * a longer free-form SMTP diagnostic string under a key name that looks
 * like nothing sensitive at all. Reconstructing from an allowlist inverts
 * the burden: an unanticipated field is dropped BY CONSTRUCTION (it was
 * simply never copied forward), not by a detector that could miss it. This
 * file therefore imports nothing from `@mega-crm/redaction` and defines no
 * PII-shaped regular expression of its own -- see this module's own tests
 * for the specific cases (`reason` embedding an address, a tenant-invented
 * key holding a person's name) that a denylist provably cannot catch and
 * this allowlist closes by never copying them forward at all.
 *
 * SCOPE BOUNDARY (gap-closure plan 13-16, closing 13-VERIFICATION.md Gap #1):
 * this worker rewrites `send_events.payload` and `events.properties` and
 * deliberately does NOT reach `send_event_quarantine` or `ingress_journal`.
 * Both of those tables are disposed of by their own retention horizons on
 * the `webhook-replay-sweep` tick instead (`SEND_EVENT_QUARANTINE_RETENTION_DAYS`,
 * `INGRESS_JOURNAL_RETENTION_DAYS`, both `packages/db/src/webhooks/`), and
 * both horizons expire faster than an erasure request's own completion
 * window -- a row carrying an erasure-requested contact's data is gone from
 * either table on its own before this scrub would ever need to touch it.
 * This exclusion is falsifiable, not permanent: if either horizon is ever
 * lengthened past that completion window, the exemption argument stops
 * holding and this worker's scope must be reconsidered, not assumed.
 */

/**
 * The complete, frozen list of `send_events.payload` top-level keys that
 * survive a scrub. This list IS the PII bound and the evidence contract at
 * once (T-13-13-03): shrinking it trades away evidence, widening it risks
 * carrying PII forward, so a change here is a decision about both at the
 * same time, not a routine edit.
 *
 * SURVIVING (what evidence each preserves):
 *   - `event`                 the provider's event name; what happened
 *   - `type`                  the provider's bounce sub-classification (`bounce` vs `blocked`)
 *   - `timestamp`             the provider's event time
 *   - `sg_event_id`           provider event identity, for forensic correlation
 *   - `sg_message_id`         provider message identity, the join back to the send
 *   - `smtp-id`               the message identity the receiving MTA saw
 *   - `status`                the SMTP status code (e.g. `5.1.1`); the delivery outcome
 *   - `attempt`               the delivery attempt number
 *   - `asm_group_id`          the SendGrid unsubscribe-group id; consent evidence
 *   - `bounce_classification` the provider's own bounce category
 *
 * EXCLUDED (everything else, by default -- named here so a future reader
 * does not "restore" one without re-reading why it was dropped):
 *   - `email`                 the recipient address; the entire point of the scrub
 *   - `reason`, `response`    free-form SMTP text that routinely embeds the
 *                             recipient address verbatim inside a longer
 *                             string -- the clearest demonstration of why a
 *                             key-name denylist fails: neither key name
 *                             looks like PII, so no key rule would flag
 *                             them, and the address is a SUBSTRING of a
 *                             longer diagnostic message, not the whole value
 *   - `ip`, `useragent`       network/device identifiers about the person, personal data in their own right
 *   - `url`, `url_offset`     a clicked link can carry a per-recipient token/identifier in its query string
 *   - `category`, `unique_args`, `marketing_campaign_*`, and every other
 *     custom argument -- a tenant-defined key space, unenumerable by construction
 *   - everything else, by default -- the property that makes the guarantee hold
 */
export const SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST = [
  "event",
  "type",
  "timestamp",
  "sg_event_id",
  "sg_message_id",
  "smtp-id",
  "status",
  "attempt",
  "asm_group_id",
  "bounce_classification",
] as const;

/**
 * Reconstructs a `send_events.payload` value by copying ONLY allowlisted
 * keys forward from the input -- builds a NEW object up from nothing, never
 * walks the input tearing keys out of it. The distinction matters even
 * though the two read as equivalent on a known-shape input: a build-up
 * implementation cannot leak a key nobody thought to name, a tear-down one
 * always can.
 *
 * Handles `null`, an array, or any other non-plain-object input by returning
 * an empty object rather than throwing -- the scrub must never fail on a
 * malformed historical row. Omits an allowlisted key that was absent from
 * the input rather than materializing it as `null`, so a scrubbed payload
 * never gains a field the original never had. Pure and idempotent by
 * construction (a reconstruction from a fixed allowlist applied to its own
 * output is a fixed point) -- asserted by tests anyway, because a resumed
 * page or a replayed job re-processes rows and a future change to this
 * function could break that silently.
 */
export function buildScrubbedSendEventPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {};
  }
  const input = payload as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of SEND_EVENT_PAYLOAD_EVIDENCE_ALLOWLIST) {
    if (key in input) {
      result[key] = input[key];
    }
  }
  return result;
}

/**
 * Unconditionally returns an empty object, for every input. `events.properties`
 * gets NO allowlist because there is no field in it that can be shown to be
 * evidence: the entire key space is tenant-supplied at event-ingestion time,
 * so naming any field here would be a guess about one tenant's schema
 * applied to every tenant. The event's own evidence -- that it occurred,
 * when, and for which contact -- lives in the row's non-JSONB columns
 * (`name`, `occurred_at`, `contact_id`), which this scrub never touches. If
 * a specific tenant-defined field is ever proven necessary as evidence,
 * adding a scoped allowlist for it is the change to make at that time; until
 * then, empty is the only defensible bound. Pure and idempotent (an empty
 * object rewritten from an empty object is still empty) -- asserted by
 * tests for the same replay-safety reason as `buildScrubbedSendEventPayload`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature intentionally accepts the input it ignores, documenting that no field of it is ever inspected
export function buildScrubbedEventProperties(properties: unknown): Record<string, unknown> {
  return {};
}

/** Rows-per-page bound for both scrub walks (T-13-13-05). Sized to match `flow-segment-sweep-flow.worker.ts`'s `SWEEP_PAGE_SIZE` precedent: large enough that a typical contact's history scrubs in a handful of pages, small enough that each page's transaction (a bounded SELECT plus up to this many single-row UPDATEs) stays short. */
export const ERASURE_SCRUB_PAGE_LIMIT = 500;

/**
 * `occurredAt` is read as TEXT (`se.occurred_at::text`), never as a parsed
 * JS `Date` -- `pg`'s default timestamptz type parser truncates to
 * MILLISECOND precision (it builds the `Date` via `Date.UTC(...)` with a
 * 3-digit millisecond field, discarding anything finer), while Postgres's
 * own `now()` (and therefore every row this scrub's own test fixtures seed
 * with server-computed timestamps) carries MICROSECOND precision. Round-
 * tripping a `Date`-truncated value back into a `WHERE occurred_at = $n` or
 * `WHERE (occurred_at, id) > ($n, $m)` comparison against the ORIGINAL,
 * untruncated column value made that row compare strictly GREATER than its
 * own truncated cursor forever -- the per-row UPDATE silently matched zero
 * rows (T-13-13 failure-injection test 1), and the keyset WHERE clause kept
 * re-including that same row on every subsequent page, an unbounded loop
 * (test 2). Text round-trips a Postgres value through Postgres LOSSLESSLY;
 * casting it straight back to `timestamptz` in SQL (`$n::timestamptz`)
 * reconstructs the identical value bit-for-bit. Production `send_events`
 * rows never carry sub-second precision in the first place (the webhook
 * worker derives `occurred_at` from SendGrid's integer-seconds `timestamp`
 * field), which is why Task 2's own fixtures -- built from JS `Date`s with
 * only millisecond precision to begin with -- never exposed this; it took a
 * server-computed `now()`-based fixture (Task 3's failure-injection
 * scenario) to surface it.
 */
interface SendEventKeysetRow {
  id: string;
  occurredAt: string;
  payload: unknown;
}

interface EventsKeysetRow {
  id: string;
  occurredAt: string;
}

export interface ScrubPageResult {
  /** Rows this page rewrote (0 means the walk reached the end of this table's matching set for this contact). */
  processed: number;
  /** The cursor committed alongside this page's UPDATE -- `done: true` once a page returns zero rows. */
  cursor: ScrubCursor;
}

function isCursorInProgress(cursor: ScrubCursor | null): cursor is { done: false; occurredAt: string; id: string } {
  return cursor !== null && cursor.done === false;
}

/**
 * One bounded, keyset-paginated page of the `send_events` scrub (T-13-13-05).
 * Reaches the contact through `sends.contact_id` (`send_events` itself has
 * no `contact_id` column) and orders by `(occurred_at, id)` -- `occurred_at`
 * MUST lead the keyset because `send_events` is partitioned by range on it
 * (Postgres requires every ordering that must stay stable across pages of a
 * partitioned table to include the partition key). Rewrites each row's
 * `payload` individually via `buildScrubbedSendEventPayload` and an UPDATE
 * scoped to that row's own `(workspace_id, id, occurred_at)` -- the table's
 * physical primary key -- so every UPDATE in this loop is bounded to exactly
 * one row by construction, never an unbounded statement over the page's
 * range. Commits the checkpoint (cursor advance AND `sends_scrubbed`
 * increment together, see `advanceErasureScrubCheckpoint`'s own doc
 * comment) on the SAME `client` the caller has already opened inside one
 * `withTenantTransaction` -- the row rewrites and the checkpoint advance are
 * therefore visible or absent together (T-13-13-02).
 *
 * A page with zero rows means the walk has reached the end of this
 * contact's `send_events` -- writes the terminal `{ done: true }` cursor
 * rather than advancing a positional one, so "finished" is a value
 * distinguishable from "not started" (`null`).
 */
export async function scrubSendEventsPage(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  erasureRecordId: string,
  cursor: ScrubCursor | null
): Promise<ScrubPageResult> {
  const table: ScrubTable = "sends";
  const afterClause = isCursorInProgress(cursor) ? `AND (se.occurred_at, se.id) > ($3::timestamptz, $4::uuid)` : "";
  const params: unknown[] = isCursorInProgress(cursor)
    ? [workspaceId, contactId, cursor.occurredAt, cursor.id, ERASURE_SCRUB_PAGE_LIMIT]
    : [workspaceId, contactId, ERASURE_SCRUB_PAGE_LIMIT];
  const limitIdx = params.length;

  const { rows } = await client.query<SendEventKeysetRow>(
    `SELECT se.id, se.occurred_at::text as "occurredAt", se.payload
     FROM send_events se
     JOIN sends s ON s.id = se.send_id
     WHERE se.workspace_id = $1 AND s.contact_id = $2 ${afterClause}
     ORDER BY se.occurred_at ASC, se.id ASC
     LIMIT $${limitIdx}`,
    params
  );

  if (rows.length === 0) {
    const doneCursor: ScrubCursor = { done: true };
    await advanceErasureScrubCheckpoint(client, workspaceId, erasureRecordId, table, doneCursor, 0);
    return { processed: 0, cursor: doneCursor };
  }

  for (const row of rows) {
    const scrubbed = buildScrubbedSendEventPayload(row.payload);
    await client.query(
      `UPDATE send_events SET payload = $1::jsonb WHERE workspace_id = $2 AND id = $3 AND occurred_at = $4::timestamptz`,
      [JSON.stringify(scrubbed), workspaceId, row.id, row.occurredAt]
    );
  }

  const last = rows[rows.length - 1];
  const nextCursor: ScrubCursor = { done: false, occurredAt: last.occurredAt, id: last.id };
  await advanceErasureScrubCheckpoint(client, workspaceId, erasureRecordId, table, nextCursor, rows.length);

  return { processed: rows.length, cursor: nextCursor };
}

/**
 * One bounded, keyset-paginated page of the `events` scrub. Unlike
 * `send_events`, `events` carries `contact_id` directly (no join needed).
 * Because `buildScrubbedEventProperties` returns an empty object for every
 * input, this page does not read `properties` back at all -- it rewrites the
 * page's selected ids to `'{}'::jsonb` in ONE bulk UPDATE, bounded to
 * exactly the ids this page's SELECT returned (never an unbounded statement
 * over the whole table). `buildScrubbedEventProperties` is still called (on
 * an empty seed object) and its result is what the UPDATE writes, so the
 * "no tenant field ever survives" property has exactly one place to change
 * if a future allowlist for `events.properties` is ever justified -- this
 * function's own call site -- rather than two independent copies of `{}`
 * (the code path and the SQL literal) that could drift apart.
 */
export async function scrubEventsPage(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  erasureRecordId: string,
  cursor: ScrubCursor | null
): Promise<ScrubPageResult> {
  const table: ScrubTable = "events";
  const afterClause = isCursorInProgress(cursor) ? `AND (occurred_at, id) > ($3::timestamptz, $4::uuid)` : "";
  const params: unknown[] = isCursorInProgress(cursor)
    ? [workspaceId, contactId, cursor.occurredAt, cursor.id, ERASURE_SCRUB_PAGE_LIMIT]
    : [workspaceId, contactId, ERASURE_SCRUB_PAGE_LIMIT];
  const limitIdx = params.length;

  const { rows } = await client.query<EventsKeysetRow>(
    `SELECT id, occurred_at::text as "occurredAt" FROM events
     WHERE workspace_id = $1 AND contact_id = $2 ${afterClause}
     ORDER BY occurred_at ASC, id ASC
     LIMIT $${limitIdx}`,
    params
  );

  if (rows.length === 0) {
    const doneCursor: ScrubCursor = { done: true };
    await advanceErasureScrubCheckpoint(client, workspaceId, erasureRecordId, table, doneCursor, 0);
    return { processed: 0, cursor: doneCursor };
  }

  const emptyProperties = buildScrubbedEventProperties({});
  const ids = rows.map((row) => row.id);
  await client.query(`UPDATE events SET properties = $1::jsonb WHERE workspace_id = $2 AND id = ANY($3::uuid[])`, [
    JSON.stringify(emptyProperties),
    workspaceId,
    ids,
  ]);

  const last = rows[rows.length - 1];
  const nextCursor: ScrubCursor = { done: false, occurredAt: last.occurredAt, id: last.id };
  await advanceErasureScrubCheckpoint(client, workspaceId, erasureRecordId, table, nextCursor, rows.length);

  return { processed: rows.length, cursor: nextCursor };
}

type PageScrubFn = (
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  erasureRecordId: string,
  cursor: ScrubCursor | null
) => Promise<ScrubPageResult>;

/** Loops one table's page function until a page reports `done: true`, re-reading the checkpoint before the FIRST page so a resumed job continues from exactly where a prior pass (or a prior page within this same call) left off. Each page is its own `withTenantTransaction` -- mirrors `flow-segment-sweep-flow.worker.ts`'s own short-transaction-per-page discipline. */
async function walkTableToExhaustion(
  workspaceId: string,
  contactId: string,
  erasureRecordId: string,
  table: ScrubTable,
  pageFn: PageScrubFn
): Promise<void> {
  let cursor = await withTenant(workspaceId, () =>
    withTenantTransaction((client) => loadErasureScrubCheckpoint(client, workspaceId, erasureRecordId, table))
  );

  if (cursor !== null && cursor.done) {
    return; // a prior pass already walked this table to exhaustion
  }

  for (;;) {
    const result = await withTenant(workspaceId, () =>
      withTenantTransaction((client) => pageFn(client, workspaceId, contactId, erasureRecordId, cursor))
    );
    cursor = result.cursor;
    if (result.cursor.done) {
      break;
    }
  }
}

interface ErasureRecordForScrub {
  status: ErasureRecordStatus;
}

async function loadErasureRecordForScrub(
  client: PoolClient,
  workspaceId: string,
  erasureRecordId: string
): Promise<ErasureRecordForScrub | null> {
  const { rows } = await client.query<ErasureRecordForScrub>(
    `SELECT status FROM erasure_records WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, erasureRecordId]
  );
  return rows[0] ?? null;
}

async function markScrubStartedIfPending(client: PoolClient, workspaceId: string, erasureRecordId: string): Promise<void> {
  await client.query(
    `UPDATE erasure_records SET status = 'scrubbing', scrub_started_at = now()
     WHERE workspace_id = $1 AND id = $2 AND status = 'pending'`,
    [workspaceId, erasureRecordId]
  );
}

async function markScrubComplete(client: PoolClient, workspaceId: string, erasureRecordId: string): Promise<void> {
  await client.query(
    `UPDATE erasure_records SET status = 'complete', scrub_completed_at = now() WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, erasureRecordId]
  );
}

async function markScrubFailed(
  client: PoolClient,
  workspaceId: string,
  erasureRecordId: string,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await client.query(`UPDATE erasure_records SET status = 'failed', scrub_error = $3 WHERE workspace_id = $1 AND id = $2`, [
    workspaceId,
    erasureRecordId,
    message,
  ]);
}

export interface RunErasureScrubParams {
  workspaceId: string;
  contactId: string;
  erasureRecordId: string;
}

/**
 * The scrub job's full run (T-13-13-01 through T-13-13-07): moves the
 * erasure record from `pending` to `scrubbing` with `scrub_started_at`,
 * walks `send_events` then `events` to exhaustion in bounded resumable
 * pages, and finally marks the record `complete` with `scrub_completed_at`.
 * A job that finds its record already `complete` returns immediately
 * without resetting anything (T-13-13-CMP-04: a job replayed after
 * BullMQ-level redelivery, or a reclaim by plan 13-15, must be a no-op).
 *
 * On an unrecoverable error, marks the record `failed` with the error
 * message recorded in `scrub_error` -- a `pending`-forever record is
 * indistinguishable from "the job has not run yet" to an operator, while a
 * `failed` record with a message is actionable -- and RE-THROWS, so BullMQ's
 * own attempts/backoff (`buildJobOptions(STANDARD_JOB_RETENTION)`, the same
 * shape every other queue in this codebase uses) retries it, and a
 * terminal failure still reaches the dead-letter path via
 * `attachSharedErrorListeners` (`apps/worker/src/server.ts`). A retried
 * attempt after a marked failure resumes from whatever cursor position the
 * failed attempt last committed -- the walk is resumable regardless of which
 * status it is resuming from.
 */
export async function runErasureScrub(params: RunErasureScrubParams): Promise<void> {
  const { workspaceId, contactId, erasureRecordId } = params;

  const record = await withTenant(workspaceId, () =>
    withTenantTransaction((client) => loadErasureRecordForScrub(client, workspaceId, erasureRecordId))
  );

  if (!record) {
    // Defensive: erasure_records cascades from contacts/organization deletes
    // (migration 0059), so this should not happen for a job produced by
    // deleteContact's own committed transaction. Nothing to scrub if it did.
    console.error("erasure-scrub: erasure_records row not found, skipping", { erasureRecordId });
    return;
  }

  if (record.status === "complete") {
    return; // replayed job after completion is a no-op (does not reset anything)
  }

  try {
    if (record.status === "pending") {
      await withTenant(workspaceId, () =>
        withTenantTransaction((client) => markScrubStartedIfPending(client, workspaceId, erasureRecordId))
      );
    }

    await walkTableToExhaustion(workspaceId, contactId, erasureRecordId, "sends", scrubSendEventsPage);
    await walkTableToExhaustion(workspaceId, contactId, erasureRecordId, "events", scrubEventsPage);

    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => markScrubComplete(client, workspaceId, erasureRecordId))
    );
  } catch (err) {
    await withTenant(workspaceId, () =>
      withTenantTransaction((client) => markScrubFailed(client, workspaceId, erasureRecordId, err))
    ).catch((markErr) => {
      console.error("erasure-scrub: failed to record scrub failure on the erasure record", markErr);
    });
    throw err;
  }
}

/**
 * The job options this queue's PRODUCER (`apps/api/src/modules/contacts/contact.repository.ts`'s
 * `deleteContact`, plan 13-10) builds its `Queue`'s `defaultJobOptions`
 * from -- `buildJobOptions(STANDARD_JOB_RETENTION)`, the same shape every
 * other queue in this codebase uses (WRK-11, D-10). Re-exported here (not
 * re-declared) so a future SECOND producer of this queue (plan 13-15's
 * reclaimer, re-enqueueing a stranded `pending` record) imports the SAME
 * value from the SAME place its sibling producer does, rather than each
 * independently calling `buildJobOptions(STANDARD_JOB_RETENTION)` and
 * risking the two drifting if one is ever edited without the other. This
 * constant is NOT passed to `new Worker(...)` below -- `WorkerOptions` has
 * no `attempts`/`backoff`/retention fields at all; job options govern how a
 * `Queue.add()` call enqueues a job, not how a `Worker` processes one.
 */
export const ERASURE_SCRUB_JOB_OPTIONS: BuiltJobOptions = buildJobOptions(STANDARD_JOB_RETENTION);

/**
 * Constructs the erasure-scrub Worker (T-13-13-*, R-05): validates every
 * job's payload against `erasureScrubJobSchema` and DEFERS (logs, returns
 * without processing) an unrecognized `schemaVersion` rather than throwing
 * it into BullMQ retries -- mirrors every other versioned-payload consumer
 * in this codebase (`sendReconcilerTickJobSchema`'s own doc comment).
 *
 * This is a job-PER-ERASURE queue, not a repeatable tick -- it registers no
 * job scheduler (`scheduler-registration.test.ts` pins exactly that
 * absence, the property worth proving for a queue that could easily have
 * been mis-modeled as periodic). `autorun` is included only when the caller
 * supplies a value (the G-12-1 regression: `Object.assign`-based option
 * merging inside BullMQ clobbers its own `true` default with an explicit
 * `undefined` key, so this factory must never pass the key at all unless a
 * caller actually wants to override it).
 */
export function createErasureScrubWorker(connection: ConnectionOptions, options: { autorun?: boolean } = {}): Worker {
  return new Worker(
    ERASURE_SCRUB_QUEUE,
    wrapProcessor(ERASURE_SCRUB_QUEUE, async (job: Job) => {
      const parsed = erasureScrubJobSchema.safeParse(job.data);
      if (!parsed.success) {
        console.error("erasure-scrub: deferring job with an unrecognized payload shape", { jobId: job.id });
        return;
      }
      const data: ErasureScrubJob = parsed.data;
      await runErasureScrub({
        workspaceId: data.workspaceId,
        contactId: data.contactId,
        erasureRecordId: data.erasureRecordId,
      });
    }),
    { connection, ...(options.autorun !== undefined ? { autorun: options.autorun } : {}) }
  );
}

/** Convenience re-export so `apps/worker/src/server.ts` can build this worker's connection the same way every other factory does. */
export { buildRedisConnectionOptions };
