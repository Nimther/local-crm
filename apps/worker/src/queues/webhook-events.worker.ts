import { randomUUID } from "node:crypto";
import { Worker, type Job, type ConnectionOptions } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import {
  normalizeEventType,
  resolveSuppression,
  SOFT_BOUNCE_SUPPRESS_THRESHOLD,
  type NormalizedEventType,
} from "@mega-crm/delivery-core";
import { WEBHOOK_EVENTS_QUEUE, webhookEventsJobSchema, type WebhookEventsJob } from "@mega-crm/shared-schemas";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ExtractedEventRow {
  id: string;
  sgEventId: string;
  sendId: string | null;
  eventType: string;
  reason: string | null;
  payload: unknown;
  isTest: boolean;
  occurredAt: string;
  /** Pure-computed at extraction time (D-14) -- null for out-of-scope events (WBHK-02). */
  normalizedType: NormalizedEventType | null;
}

/** ECMAScript's maximum time value in milliseconds -- `new Date(ms)` never throws within this bound. */
const MAX_DATE_TIME_VALUE_MS = 8.64e15;

/**
 * Best-effort field extraction from a raw SendGrid webhook event (WBHK-01/02/
 * 03/04, D-14/D-15). Returns `null` for an event lacking a usable
 * `sg_event_id` (WBHK-03's sole dedup key) OR a usable `timestamp`, rather
 * than throwing -- one malformed event in a batch must not crash the whole
 * batch.
 */
function extractEventRow(raw: unknown): ExtractedEventRow | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const event = raw as Record<string, unknown>;

  const sgEventId = typeof event.sg_event_id === "string" ? event.sg_event_id.trim() : "";
  if (!sgEventId) {
    return null;
  }

  // SendGrid's `timestamp` is Unix seconds. It must be deterministic
  // per-event -- the same replayed event always resolves to the same
  // occurred_at, which is what makes `ON CONFLICT (workspace_id,
  // sg_event_id, occurred_at)` dedupe correctly across redeliveries (see
  // send-events.ts's doc-comment). A missing/non-numeric timestamp is
  // therefore treated exactly like a missing sg_event_id (skip -- return
  // null) rather than substituted with wall-clock time: a wall-clock
  // fallback would differ on every redelivery, defeating the dedup key
  // (WR-01). An out-of-range numeric timestamp would make `new Date(...)`
  // throw a RangeError and crash the whole batch (WR-02), so it is
  // bounds-checked against the ECMAScript Date-representable range before
  // construction.
  const isUsableTimestamp =
    typeof event.timestamp === "number" &&
    Number.isFinite(event.timestamp) &&
    Math.abs(event.timestamp * 1000) <= MAX_DATE_TIME_VALUE_MS;
  if (!isUsableTimestamp) {
    return null;
  }
  const occurredAt = new Date((event.timestamp as number) * 1000).toISOString();

  const eventType = typeof event.event === "string" ? event.event : "unknown";
  const rawSubtype = typeof event.type === "string" ? event.type : undefined;
  const reason = typeof event.reason === "string" ? event.reason : null;

  const customArgs =
    event.custom_args && typeof event.custom_args === "object"
      ? (event.custom_args as Record<string, unknown>)
      : undefined;
  const rawSendId = typeof customArgs?.send_id === "string" ? customArgs.send_id : null;
  // D-15: custom_args.send_id may point at a deleted/orphaned send, or be
  // absent entirely (a tenant's own webhook traffic bypassing the platform)
  // -- the FK is nullable (ON DELETE SET NULL) for exactly this reason. A
  // structurally-invalid value (not UUID-shaped) is nulled out defensively
  // rather than passed through to a uuid-typed column, which would throw
  // 22P02 and abort the whole batch insert.
  const sendId = rawSendId && UUID_RE.test(rawSendId) ? rawSendId : null;
  const isTest = customArgs?.test === "true";

  return {
    id: randomUUID(),
    sgEventId,
    sendId,
    eventType,
    reason,
    payload: event,
    isTest,
    occurredAt,
    normalizedType: normalizeEventType({ event: eventType, type: rawSubtype }),
  };
}

/**
 * Idempotent "first write wins" fact-column update (D-06 Pattern 4):
 * `WHERE <column> IS NULL` gates the write so a replayed or out-of-order
 * event can never overwrite an already-set fact. Returns whether THIS call
 * was the one that set the column -- the exactly-once counter-increment gate
 * (D-09).
 */
async function setFactColumnOnce(
  client: PoolClient,
  sendId: string,
  column: string,
  occurredAt: string,
  reasonWrite?: { reasonColumn: string; reason: string | null }
): Promise<boolean> {
  const sql = reasonWrite
    ? `UPDATE sends SET ${column} = $2, ${reasonWrite.reasonColumn} = $3 WHERE id = $1 AND ${column} IS NULL RETURNING id`
    : `UPDATE sends SET ${column} = $2 WHERE id = $1 AND ${column} IS NULL RETURNING id`;
  const params = reasonWrite ? [sendId, occurredAt, reasonWrite.reason] : [sendId, occurredAt];
  const { rows } = await client.query(sql, params);
  return rows.length > 0;
}

/** Unique-recipient campaign counter increment (D-07/D-09), only ever called after a `setFactColumnOnce` just-set. */
async function incrementCampaignCounter(client: PoolClient, campaignId: string, column: string): Promise<void> {
  await client.query(`UPDATE campaigns SET ${column} = ${column} + 1, updated_at = now() WHERE id = $1`, [
    campaignId,
  ]);
}

/**
 * Suppression dual-write (D-13): flips `contacts.subscription_status` to
 * 'suppressed' AND inserts a `workspace_suppressions` row (per-event,
 * per-transaction single-row write -- never bulk), reading the contact's
 * email from the UPDATE's own RETURNING rather than a second query. A
 * contact with no email on file (external_id-only) still gets the status
 * flip; the suppression-list row is skipped since it requires an email.
 */
async function applySuppression(
  client: PoolClient,
  workspaceId: string,
  contactId: string,
  reason: string
): Promise<void> {
  const { rows } = await client.query<{ email: string | null }>(
    `UPDATE contacts SET subscription_status = 'suppressed', updated_at = now() WHERE id = $1 RETURNING email`,
    [contactId]
  );
  const email = rows[0]?.email;
  if (email) {
    await client.query(
      `INSERT INTO workspace_suppressions (id, workspace_id, email, reason, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())
       ON CONFLICT (workspace_id, email) DO NOTHING`,
      [workspaceId, email, reason]
    );
  }
}

/** Unsubscribe outcome (D-11/D-13): status change ONLY -- never a `workspace_suppressions` row. */
async function applyUnsubscribe(client: PoolClient, contactId: string): Promise<void> {
  await client.query(`UPDATE contacts SET subscription_status = 'unsubscribed', updated_at = now() WHERE id = $1`, [
    contactId,
  ]);
}

interface ResolvedSend {
  id: string;
  campaignId: string | null;
  contactId: string;
}

/**
 * Applies the full D-06/D-09/D-10/D-11/D-12/D-13 side-effect contract for
 * ONE genuinely-new, non-test, normalized event whose `send_id` resolved to
 * a live `sends` row. Never called for is_test rows or unresolved sends
 * (D-15) -- the caller gates both before invoking this.
 */
async function applyEventSideEffects(
  client: PoolClient,
  workspaceId: string,
  send: ResolvedSend,
  event: { normalizedType: NormalizedEventType; reason: string | null; occurredAt: string }
): Promise<void> {
  switch (event.normalizedType) {
    case "delivered": {
      const justSet = await setFactColumnOnce(client, send.id, "delivered_at", event.occurredAt);
      if (justSet) {
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "delivered_count");
        // D-10: a genuinely-new delivery resets the consecutive soft-bounce streak.
        await client.query(
          `UPDATE contacts SET consecutive_soft_bounces = 0, updated_at = now() WHERE id = $1`,
          [send.contactId]
        );
      }
      break;
    }
    case "open": {
      const justSet = await setFactColumnOnce(client, send.id, "first_opened_at", event.occurredAt);
      if (justSet && send.campaignId) {
        await incrementCampaignCounter(client, send.campaignId, "opened_count");
      }
      break;
    }
    case "click": {
      const justSet = await setFactColumnOnce(client, send.id, "first_clicked_at", event.occurredAt);
      if (justSet && send.campaignId) {
        await incrementCampaignCounter(client, send.campaignId, "clicked_count");
      }
      break;
    }
    case "bounce_hard": {
      const justSet = await setFactColumnOnce(client, send.id, "bounced_at", event.occurredAt, {
        reasonColumn: "bounce_reason",
        reason: "hard_bounce",
      });
      if (justSet) {
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "bounced_count");
        await applySuppression(client, workspaceId, send.contactId, "hard_bounce");
      }
      break;
    }
    case "bounce_soft": {
      // D-10 streak (atomic row-locked increment -- the outer dedup
      // RETURNING gate already guarantees this runs at most once per
      // genuinely-new soft-bounce event).
      const { rows } = await client.query<{ consecutiveSoftBounces: number }>(
        `UPDATE contacts SET consecutive_soft_bounces = consecutive_soft_bounces + 1, updated_at = now()
         WHERE id = $1 RETURNING consecutive_soft_bounces as "consecutiveSoftBounces"`,
        [send.contactId]
      );
      const streak = rows[0]?.consecutiveSoftBounces ?? 0;
      if (streak >= SOFT_BOUNCE_SUPPRESS_THRESHOLD) {
        const justSet = await setFactColumnOnce(client, send.id, "bounced_at", event.occurredAt, {
          reasonColumn: "bounce_reason",
          reason: "soft_bounce_streak",
        });
        if (justSet) {
          if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "bounced_count");
          await applySuppression(client, workspaceId, send.contactId, "soft_bounce_streak");
        }
      }
      break;
    }
    case "dropped": {
      const justSet = await setFactColumnOnce(client, send.id, "dropped_at", event.occurredAt, {
        reasonColumn: "drop_reason",
        reason: event.reason,
      });
      if (justSet) {
        // D-08: every address-drop terminal counts into bounced_count
        // ("не доставлено"), independent of the specific reason -- the
        // reason itself stays queryable via sends.drop_reason.
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "bounced_count");

        const outcome = resolveSuppression("dropped", event.reason);
        if (outcome?.status === "suppressed") {
          await applySuppression(client, workspaceId, send.contactId, outcome.reason);
        } else if (outcome?.status === "unsubscribed") {
          await applyUnsubscribe(client, send.contactId);
        }
      }
      break;
    }
    case "spam_report": {
      const justSet = await setFactColumnOnce(client, send.id, "spam_reported_at", event.occurredAt);
      if (justSet) {
        // No dedicated spam counter exists (Task 1 decision) -- spam is a
        // non-delivery terminal, grouped into bounced_count like dropped.
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "bounced_count");
        await applySuppression(client, workspaceId, send.contactId, "spam_report");
      }
      break;
    }
    case "unsubscribe":
    case "group_unsubscribe": {
      const justSet = await setFactColumnOnce(client, send.id, "unsubscribed_at", event.occurredAt);
      if (justSet) {
        await applyUnsubscribe(client, send.contactId);
        if (send.campaignId) await incrementCampaignCounter(client, send.campaignId, "unsubscribed_count");
      }
      break;
    }
  }
}

/** D-03: one conditional health-timestamp write per BATCH, never per event. */
async function debounceWebhookHealth(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(
    `UPDATE workspace_webhook_endpoints
     SET last_event_at = now(), updated_at = now()
     WHERE workspace_id = $1 AND (last_event_at IS NULL OR last_event_at < now() - interval '60 seconds')`,
    [workspaceId]
  );
}

/**
 * The webhook-events job handler (WBHK-01/02/03/04, SUBS-02, D-14): re-derives
 * `workspaceId` from `job.data` (never ambient state), performs ONE multi-row
 * parameterized INSERT into `send_events` with
 * `ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING
 * RETURNING id` -- only rows Postgres actually returns are "new"
 * (RESEARCH.md Pattern 3). For each genuinely-new, non-test event whose
 * `custom_args.send_id` resolves to a live `sends` row, applies the full
 * fact-column + counter + suppression side-effect contract, all inside the
 * SAME tenant-scoped transaction as the dedup insert. Finishes with a
 * debounced webhook-health timestamp write.
 *
 * Exported standalone (not only inside the Worker's inline processor) so
 * the webhook-events-*.test.ts suites can invoke it directly without a live
 * BullMQ Queue/Redis round-trip (mirrors processEventIngestJob's rationale).
 */
export async function processWebhookEventBatch(data: WebhookEventsJob): Promise<{ inserted: number }> {
  const { workspaceId, events } = webhookEventsJobSchema.parse(data);

  const rows = events.map(extractEventRow).filter((row): row is ExtractedEventRow => row !== null);
  if (rows.length === 0) {
    return { inserted: 0 };
  }

  return withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      // D-15: `send_events.send_id` carries a real FK to `sends(id)` --
      // Postgres enforces referential integrity at INSERT time regardless of
      // is_test/orphan intent, so a `custom_args.send_id` that never
      // corresponds to a live send (deleted, or Pitfall 2's kind='test'
      // dispatch that never writes a `sends` row at all) MUST be nulled out
      // here before insertion, not passed through as a dangling FK value.
      const candidateSendIds = [...new Set(rows.map((row) => row.sendId).filter((id): id is string => id !== null))];
      let liveSendIds = new Set<string>();
      if (candidateSendIds.length > 0) {
        const { rows: liveSends } = await client.query<{ id: string }>(
          `SELECT id FROM sends WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
          [workspaceId, candidateSendIds]
        );
        liveSendIds = new Set(liveSends.map((r) => r.id));
      }
      const resolvedRows = rows.map((row) => ({
        ...row,
        sendId: row.sendId !== null && liveSendIds.has(row.sendId) ? row.sendId : null,
      }));

      const COLUMNS_PER_ROW = 9;
      const placeholders: string[] = [];
      const values: unknown[] = [];

      resolvedRows.forEach((row, index) => {
        const base = index * COLUMNS_PER_ROW;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, now())`
        );
        values.push(
          row.id,
          workspaceId,
          row.sgEventId,
          row.sendId,
          row.eventType,
          row.reason,
          row.payload,
          row.isTest,
          row.occurredAt
        );
      });

      const { rows: insertedRows } = await client.query<{ id: string }>(
        `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, reason, payload, is_test, occurred_at, received_at)
         VALUES ${placeholders.join(", ")}
         ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING
         RETURNING id`,
        values
      );

      // Pattern 3: only rows Postgres actually returned are genuinely new --
      // a replayed/duplicate event is skipped with zero side effects.
      const insertedIds = new Set(insertedRows.map((r) => r.id));
      const newRows = resolvedRows.filter((row) => insertedIds.has(row.id));

      for (const row of newRows) {
        // D-15 (Pitfall 2): a test-marked event is stored (already done by
        // the insert above) but produces zero status/counter/suppression
        // side effects.
        if (row.isTest) continue;
        // Out-of-scope SendGrid event type (e.g. processed/deferred) --
        // normalizeEventType already returned null for these.
        if (row.normalizedType === null) continue;
        // No send_id marker, or one that didn't resolve to a live send
        // (already nulled out above) -- nothing to process (D-15).
        if (row.sendId === null) continue;

        const { rows: sendRows } = await client.query<ResolvedSend>(
          `SELECT id, campaign_id as "campaignId", contact_id as "contactId"
           FROM sends WHERE id = $1 AND workspace_id = $2`,
          [row.sendId, workspaceId]
        );
        const send = sendRows[0];
        // Defensive re-check (row.sendId already validated live above; this
        // guards a same-transaction delete race).
        if (!send) continue;

        await applyEventSideEffects(client, workspaceId, send, {
          normalizedType: row.normalizedType,
          reason: row.reason,
          occurredAt: row.occurredAt,
        });
      }

      // D-03: debounced once per batch, not once per event.
      await debounceWebhookHealth(client, workspaceId);

      return { inserted: insertedRows.length };
    })
  );
}

/**
 * Constructs the actual BullMQ Worker consuming WEBHOOK_EVENTS_QUEUE --
 * registered in apps/worker/src/server.ts's buildWorker(). Takes plain
 * ioredis `ConnectionOptions` (not a constructed `Redis` client instance),
 * same nominal-type reason as createEventsIngestWorker.
 */
export function createWebhookEventsWorker(connection: ConnectionOptions): Worker<WebhookEventsJob> {
  return new Worker<WebhookEventsJob>(
    WEBHOOK_EVENTS_QUEUE,
    async (job: Job<WebhookEventsJob>) => {
      await processWebhookEventBatch(job.data);
    },
    { connection }
  );
}
