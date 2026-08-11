/**
 * Thin re-export shim (04-02): the envelope-encryption implementation now
 * lives in the shared `@mega-crm/kms` package (packages/kms/src/client.ts)
 * so apps/worker -- a separate process with no source import path into
 * apps/api -- can decrypt a tenant's SendGrid key at send-dispatch time
 * (SEND-05). Kept here (rather than deleting and repointing every
 * importer) to minimise churn for sendgrid-key.ts and the existing
 * `__tests__/envelope.test.ts` suite, whose relative imports
 * (`../client.js`) keep resolving unchanged.
 */
export * from "@mega-crm/kms";
