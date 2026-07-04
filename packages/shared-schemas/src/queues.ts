import { z } from "zod";

/**
 * Queue name constants shared by producer (apps/api) and consumer
 * (apps/worker) so neither side can drift on the literal string BullMQ uses
 * to route jobs. Two separate queues (not one queue + job `priority`) so a
 * flooded broadcast queue can never starve triggered sends — see
 * STACK.md's Queue & Send Pipeline rationale.
 */
export const EVENTS_INGEST_QUEUE = "events:ingest";
export const IMPORTS_CSV_QUEUE = "imports:csv";

/**
 * Placeholder job payload schemas — finalized in 02-06 (event ingestion)
 * and 02-07 (CSV import) once those plans define the real producer/consumer
 * contract. Kept here now so apps/worker's connection scaffolding has a
 * concrete import to typecheck against.
 */
export const eventsIngestJobSchema = z.object({
  workspaceId: z.string().uuid(),
});
export type EventsIngestJob = z.infer<typeof eventsIngestJobSchema>;

export const importsCsvJobSchema = z.object({
  workspaceId: z.string().uuid(),
});
export type ImportsCsvJob = z.infer<typeof importsCsvJobSchema>;
