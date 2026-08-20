import pino from "pino";

/**
 * Minimal structured logger for this shared package (D-05 previous-secret
 * verification logging inside `verifyUnsubscribeToken`). Deliberately
 * independent of `apps/api/src/logger.ts` (which pulls in `env.ts` and
 * KMS/redaction concerns specific to the API app) -- `@mega-crm/delivery-core`
 * is imported by BOTH `apps/api` and `apps/worker`, so it cannot depend back
 * on either app (mirrors `@mega-crm/contacts-core`'s same-shaped logger for
 * the same reason).
 */
export const logger = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
});
