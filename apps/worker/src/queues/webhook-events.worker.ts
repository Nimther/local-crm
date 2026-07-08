import { randomUUID } from "node:crypto";
import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
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
}

/**
 * Best-effort field extraction from a raw SendGrid webhook event (dedup-only
 * slice, WBHK-01/03 -- full normalization/side effects are 05-03). Returns
 * `null` for an event lacking a usable `sg_event_id` (WBHK-03's sole dedup
 * key) rather than throwing -- one malformed event in a batch must not crash
 * the whole batch.
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

  // SendGrid's `timestamp` is Unix seconds. Deterministic per-event -- the
  // same replayed event always resolves to the same occurred_at, which is
  // what makes `ON CONFLICT (workspace_id, sg_event_id, occurred_at)` dedupe
  // correctly across redeliveries (see send-events.ts's doc-comment).
  const occurredAt =
    typeof event.timestamp === "number"
      ? new Date(event.timestamp * 1000).toISOString()
      : new Date().toISOString();

  const eventType = typeof event.event === "string" ? event.event : "unknown";
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
  };
}

/**
 * The webhook-events job handler (WBHK-01/03, D-14): re-derives
 * `workspaceId` from `job.data` (never ambient state), then performs ONE
 * multi-row parameterized INSERT into `send_events` with
 * `ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING
 * RETURNING id, sg_event_id` -- only rows Postgres actually returns are
 * "new" (RESEARCH.md Pattern 3). This plan intentionally stops at dedup
 * storage: no status/suppression/counter side effects yet (05-03 iterates
 * the RETURNING rows for those).
 *
 * Exported standalone (not only inside the Worker's inline processor) so
 * webhook-events-idempotency.test.ts can invoke it directly without a live
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
      const COLUMNS_PER_ROW = 9;
      const placeholders: string[] = [];
      const values: unknown[] = [];

      rows.forEach((row, index) => {
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

      const { rows: insertedRows } = await client.query(
        `INSERT INTO send_events (id, workspace_id, sg_event_id, send_id, event_type, reason, payload, is_test, occurred_at, received_at)
         VALUES ${placeholders.join(", ")}
         ON CONFLICT (workspace_id, sg_event_id, occurred_at) DO NOTHING
         RETURNING id, sg_event_id`,
        values
      );

      // NOTE for 05-03: `insertedRows` is the exactly-once gate for all
      // future side effects (fact-column updates, suppression, counters) --
      // keep the RETURNING clause in place; iterate only these rows.
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
