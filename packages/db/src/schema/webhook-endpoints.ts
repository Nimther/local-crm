import { pgTable, text, timestamp, uuid, unique } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/**
 * Per-workspace SendGrid Event Webhook registration (WBHK-01, D-01/D-02/D-05).
 * `pathToken` is the unguessable per-tenant URL segment
 * (`/webhooks/sendgrid/:pathToken`) resolved by `findWebhookEndpointByToken`
 * BEFORE any RLS tenant context exists -- see
 * packages/db/migrations/0021_webhook_endpoints.sql's
 * `webhook_endpoint_runtime_lookup` policy, mirroring
 * `workspace_api_keys`'s `api_key_runtime_lookup` precedent (0006).
 * `publicKey` is stored PLAIN TEXT, NOT KMS-encrypted (Assumption A1,
 * RESEARCH.md Architecture Pattern 1) -- a webhook verification public key
 * is not a secret by definition.
 */
export const workspaceWebhookEndpoints = pgTable(
  "workspace_webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    pathToken: text("path_token").notNull(),
    sendgridWebhookId: text("sendgrid_webhook_id"),
    publicKey: text("public_key"),
    provisionStatus: text("provision_status").notNull().default("pending"),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("workspace_webhook_endpoints_path_token_unique").on(t.pathToken)]
);
