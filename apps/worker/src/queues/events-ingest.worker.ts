import { Worker, type Job, type ConnectionOptions } from "bullmq";
import { withTenant, withTenantTransaction } from "@mega-crm/tenant-context";
import { upsertContactByIdentity } from "@mega-crm/contacts-core";
import { EVENTS_INGEST_QUEUE, eventsIngestJobSchema, type EventsIngestJob } from "@mega-crm/shared-schemas";
import { flowTriggerEvaluatorQueue } from "./flows/flow-queues.js";
import { wrapProcessor } from "../processor-wrapper.js";

/**
 * The events:ingest job handler (EVNT-02/EVNT-03, Pattern 2): re-derives
 * `workspaceId` from `job.data` (never ambient state -- this process is
 * separate from the one that enqueued the job), upserts the contact via the
 * SAME `upsertContactByIdentity` the Contacts API route uses (no D-01..D-08
 * drift risk between call sites), then writes the event row idempotently
 * keyed on the job's deterministic `(workspace_id, id, occurred_at)` --
 * `ON CONFLICT (workspace_id, id, occurred_at) DO NOTHING` is the DB-level
 * safety net for BullMQ's at-least-once redelivery guarantee (Pitfall 1),
 * AND (as of migration 0010, CR-01) scopes dedupe per-tenant so a
 * client-supplied eventId from one workspace can never suppress another
 * workspace's event sharing the same id. Event properties are
 * forwarded into `upsertContactByIdentity`'s `properties` input too (D-10:
 * custom properties are auto-discovered from events as well as the API/CSV/
 * UI) -- `upsertContactByIdentity` strips reserved keys (Pitfall 4) before
 * any JSONB merge, so a `subscription_status` property arriving via an
 * event can never flip the contact's real column.
 *
 * Exported standalone (not only as a Worker's inline processor) so
 * events-ingest-idempotency.test.ts can invoke it directly with a crafted
 * payload, without needing a live BullMQ Queue/Redis round-trip.
 *
 * FLOW-02 (06-06): once the events INSERT commits, enqueues a
 * flow-trigger-check job onto `FLOW_TRIGGER_EVALUATOR_QUEUE` so
 * `flow-trigger-evaluator.worker.ts` can match this event's name against
 * live event-triggered flows for this contact. `jobId` is deterministic
 * (`${workspaceId}-${eventId}-flow-trigger`) so a redelivered ingest job's
 * re-enqueue is a safe no-op, mirroring this file's own events-INSERT
 * idempotency discipline (Pitfall 1).
 */
export async function processEventIngestJob(data: EventsIngestJob): Promise<void> {
  const { workspaceId, eventId, occurredAt, name, properties, externalId, email } =
    eventsIngestJobSchema.parse(data);

  const { contactId } = await withTenant(workspaceId, () =>
    withTenantTransaction(async (client) => {
      const { contactId } = await upsertContactByIdentity(client, workspaceId, {
        externalId,
        email,
        properties,
      });

      await client.query(
        `INSERT INTO events (id, workspace_id, contact_id, name, properties, occurred_at, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (workspace_id, id, occurred_at) DO NOTHING`,
        [eventId, workspaceId, contactId, name, properties, occurredAt]
      );

      return { contactId };
    })
  );

  await flowTriggerEvaluatorQueue.add(
    "check",
    { workspaceId, contactId, eventName: name },
    { jobId: `${workspaceId}-${eventId}-flow-trigger` }
  );
}

/**
 * Constructs the actual BullMQ Worker consuming EVENTS_INGEST_QUEUE --
 * registered in apps/worker/src/server.ts's buildWorker(). Takes plain
 * ioredis `ConnectionOptions` (not a constructed `Redis`/`ioredis` client
 * instance) -- BullMQ bundles its OWN internal copy of `ioredis`
 * (bullmq@5.79.1 pins ioredis@5.10.1 exactly), which TypeScript treats as a
 * structurally distinct class from this workspace's own `ioredis@5.11.0`
 * (nominal mismatch on `Redis`'s private/protected members). A plain options
 * object has no such class identity, so it satisfies BullMQ's
 * `ConnectionOptions` regardless of which `ioredis` copy built it; BullMQ
 * constructs its own internal client from these options.
 */
export function createEventsIngestWorker(connection: ConnectionOptions): Worker<EventsIngestJob> {
  return new Worker<EventsIngestJob>(
    EVENTS_INGEST_QUEUE,
    wrapProcessor(EVENTS_INGEST_QUEUE, async (job: Job<EventsIngestJob>) => {
      await processEventIngestJob(job.data);
    }),
    { connection }
  );
}
