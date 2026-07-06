/**
 * @mega-crm/kms reads its own KMS configuration directly from `process.env`
 * (mirroring `packages/tenant-context`'s direct `DATABASE_URL` read) instead
 * of importing apps/api's `env.ts` -- a shared package must never depend
 * back on the app(s) that consume it (02-05 precedent for tenant-context):
 * apps/worker also loads this package and has no import path into apps/api's
 * source, so a backward dependency here would make the package unusable
 * from the worker.
 *
 * apps/api's own `env.ts` remains the PRIMARY boot-time guard (its
 * `superRefine` rejects `KMS_PROVIDER=local` under `NODE_ENV=production`
 * before the server even starts listening, regardless of whether this
 * module is ever imported). `local-provider.ts`'s `NODE_ENV` check below is
 * a redundant, defense-in-depth guard for any process (worker included)
 * that imports this package directly.
 */
export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  KMS_PROVIDER: (process.env.KMS_PROVIDER === "aws" ? "aws" : "local") as "local" | "aws",
  KMS_LOCAL_KEK: process.env.KMS_LOCAL_KEK,
  KMS_KEK_ID: process.env.KMS_KEK_ID,
};
