import { z } from "zod";

/** D-24: hard cap on how many events a single POST /v1/events call may batch. */
export const MAX_EVENT_BATCH_SIZE = 1000;

const eventPropertiesSchema = z.record(z.string(), z.unknown());

/**
 * POST /v1/events envelope (EVNT-01/EVNT-03) -- validates ONLY the shape:
 * `name` is a non-empty string, `properties` is a JSON object (its internal
 * shape is NEVER schema-enforced, per project decision -- "Строгие
 * схемы/валидация событий" is explicitly out of scope), and `occurredAt`/
 * `eventId` are optional client-supplied overrides (RESEARCH Open Question
 * 2: an optional client-supplied eventId is honored so a tenant's own
 * retried HTTP POSTs are also deduplicated). At least one of
 * `externalId`/`email` is required to identify/create the contact
 * (EVNT-02) -- the same D-02 rule `upsertContactApiSchema` enforces for
 * CONT-04.
 */
export const eventEnvelopeSchema = z
  .object({
    name: z.string().trim().min(1, "Event name is required"),
    properties: eventPropertiesSchema.default({}),
    occurredAt: z.string().datetime().optional(),
    eventId: z.string().uuid().optional(),
    externalId: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
  })
  .refine((v) => Boolean(v.email || v.externalId), {
    message: "At least one of email or externalId is required to identify the contact",
    path: ["email"],
  });
export type EventEnvelopeInput = z.infer<typeof eventEnvelopeSchema>;

/** Per-item result shape returned by POST /v1/events (D-24: "accepted" means validated + queued, NOT processed). */
export const eventIngestResultItemSchema = z.union([
  z.object({ eventId: z.string().uuid(), status: z.literal("accepted") }),
  z.object({ eventId: z.string().uuid().optional(), status: z.literal("rejected"), error: z.string() }),
]);
export type EventIngestResultItem = z.infer<typeof eventIngestResultItemSchema>;
