/**
 * Thin re-export shim (04-02): the local-provider implementation now lives
 * in the shared `@mega-crm/kms` package (packages/kms/src/local-provider.ts),
 * moved alongside client.ts. Kept here only so
 * `__tests__/envelope.test.ts`'s existing relative import
 * (`../local-provider.js`, used to exercise the NODE_ENV=production
 * refusal-to-boot guard) keeps resolving without modification.
 */
export * from "@mega-crm/kms/src/local-provider.js";
