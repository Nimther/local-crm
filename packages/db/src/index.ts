import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as authSchema from "./schema/auth.js";
import * as sendgridKeysSchema from "./schema/sendgrid-keys.js";
import * as contactsSchema from "./schema/contacts.js";
import * as suppressionsSchema from "./schema/suppressions.js";
import * as propertyRegistrySchema from "./schema/property-registry.js";
import * as apiKeysSchema from "./schema/api-keys.js";
import * as eventsSchema from "./schema/events.js";
import * as csvImportsSchema from "./schema/csv-imports.js";

const schema = {
  ...authSchema,
  ...sendgridKeysSchema,
  ...contactsSchema,
  ...suppressionsSchema,
  ...propertyRegistrySchema,
  ...apiKeysSchema,
  ...eventsSchema,
  ...csvImportsSchema,
};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set to construct the Drizzle client (@mega-crm/db)");
}

const pool = new Pool({ connectionString: databaseUrl });

/**
 * Drizzle client used for better-auth's drizzleAdapter and any non-tenant
 * query (e.g. workspace-slug uniqueness lookups). This client is NOT the
 * tenant-scoped RLS pool — see apps/api/src/db.ts + middleware/tenant-context.ts
 * for the pool that runs `SET LOCAL app.current_workspace_id` per transaction.
 */
export const db = drizzle(pool, { schema });

export * from "./schema/auth.js";
export * from "./schema/sendgrid-keys.js";
export * from "./schema/contacts.js";
export * from "./schema/suppressions.js";
export * from "./schema/property-registry.js";
export * from "./schema/api-keys.js";
export * from "./schema/events.js";
export * from "./schema/csv-imports.js";
export { TENANT_GUC_KEY } from "./rls.js";
