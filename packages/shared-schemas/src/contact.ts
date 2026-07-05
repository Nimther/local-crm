import { z } from "zod";

/** 3-state subscription status (SUBS-01) -- see packages/db/src/schema/contacts.ts's subscriptionStatusEnum. */
export const subscriptionStatusSchema = z.enum(["subscribed", "unsubscribed", "suppressed"]);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

const propertiesSchema = z.record(z.string(), z.unknown());

/**
 * POST /api/workspaces/:slug/contacts -- D-02: at least one of email/
 * externalId is required (a contact identified purely by custom properties
 * has no anchor to match future events/CSV rows against).
 */
export const createContactSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
    externalId: z.string().trim().min(1).max(255).optional(),
    firstName: z.string().trim().max(255).optional(),
    lastName: z.string().trim().max(255).optional(),
    phone: z.string().trim().max(50).optional(),
    city: z.string().trim().max(255).optional(),
    country: z.string().trim().max(255).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    properties: propertiesSchema.optional(),
    subscriptionStatus: subscriptionStatusSchema.optional(),
  })
  .refine((v) => Boolean(v.email || v.externalId), {
    message: "At least one of email or externalId is required",
    path: ["email"],
  });
export type CreateContactInput = z.infer<typeof createContactSchema>;

/**
 * PATCH /api/workspaces/:slug/contacts/:id -- D-06: an incoming externalId
 * that differs from an already-set one is silently ignored by the
 * repository, not rejected by this schema. D-12: subscriptionStatus
 * transitions are asymmetrically validated by the repository (schema only
 * constrains the value to a valid enum member).
 */
export const updateContactSchema = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
  externalId: z.string().trim().min(1).max(255).optional(),
  // CR-04: null is an explicit "clear this field" signal (distinct from
  // omitted/undefined, which means "keep existing value" -- see
  // contact.repository.ts's updateContact). email/externalId stay
  // non-nullable -- they are identity anchors, not clearable via this path.
  firstName: z.string().trim().max(255).nullable().optional(),
  lastName: z.string().trim().max(255).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  city: z.string().trim().max(255).nullable().optional(),
  country: z.string().trim().max(255).nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  properties: propertiesSchema.optional(),
  subscriptionStatus: subscriptionStatusSchema.optional(),
});
export type UpdateContactInput = z.infer<typeof updateContactSchema>;

/** GET /api/workspaces/:slug/contacts -- D-13: search + status/tag filters + sort + pagination. */
export const contactListQuerySchema = z.object({
  search: z.string().trim().optional(),
  status: subscriptionStatusSchema.optional(),
  tag: z.string().trim().optional(),
  sort: z.enum(["createdAt", "-createdAt", "email", "-email"]).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type ContactListQuery = z.infer<typeof contactListQuerySchema>;

export const contactResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  externalId: z.string().nullable(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  tags: z.array(z.string()),
  properties: z.record(z.string(), z.unknown()),
  subscriptionStatus: subscriptionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ContactResponse = z.infer<typeof contactResponseSchema>;

export const contactListResponseSchema = z.object({
  items: z.array(contactResponseSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ContactListResponse = z.infer<typeof contactListResponseSchema>;

/**
 * GET /api/workspaces/:slug/property-registry -- D-10/D-19: auto-discovered
 * custom-property keys with their observed type, used for the contact-form
 * custom-property editor's key autocomplete (suggestions only, no schema
 * enforcement).
 */
export const propertyRegistryItemSchema = z.object({
  key: z.string(),
  observedType: z.enum(["string", "number", "bool", "date"]),
});
export type PropertyRegistryItem = z.infer<typeof propertyRegistryItemSchema>;

/**
 * POST /v1/contacts (CONT-03, API-key-authed integration surface) -- same
 * D-02 "at least one identifier" rule as the session-authed create schema.
 * Accepts either a single contact or a batch (an integration that already
 * batches its own event traffic can batch contact upserts the same way).
 */
const upsertContactApiItemSchema = z
  .object({
    externalId: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    firstName: z.string().trim().max(255).optional(),
    lastName: z.string().trim().max(255).optional(),
    phone: z.string().trim().max(50).optional(),
    city: z.string().trim().max(255).optional(),
    country: z.string().trim().max(255).optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    properties: propertiesSchema.optional(),
    subscriptionStatus: subscriptionStatusSchema.optional(),
  })
  .refine((v) => Boolean(v.email || v.externalId), {
    message: "At least one of email or externalId is required",
    path: ["email"],
  });

export const upsertContactApiSchema = z.union([
  upsertContactApiItemSchema,
  z.array(upsertContactApiItemSchema).min(1).max(1000),
]);
export type UpsertContactApiItem = z.infer<typeof upsertContactApiItemSchema>;
export type UpsertContactApiInput = z.infer<typeof upsertContactApiSchema>;
