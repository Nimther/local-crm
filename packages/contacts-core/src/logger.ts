import pino from "pino";

/**
 * Minimal structured logger for this shared package (D-05 conflict logging
 * inside `upsertContactByIdentity`). Deliberately independent of
 * `apps/api/src/logger.ts` (which pulls in `env.ts` and KMS/redaction
 * concerns specific to the API app) -- `@mega-crm/contacts-core` is imported
 * by BOTH `apps/api` and `apps/worker`, so it cannot depend back on either
 * app (mirrors `@mega-crm/tenant-context`'s dependency-light `console.error`
 * listener for the same reason).
 */
export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
});
