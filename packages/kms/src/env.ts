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
/**
 * 08-07: the type is declared here rather than asserted inline on
 * `KMS_PROVIDER`. The ternary already produces `"aws" | "local"`, so
 * `no-unnecessary-type-assertion` correctly reported the inline `as` as
 * redundant *for the expression* — but the property it initializes widens to
 * `string` without one, silently turning the provider selector into an
 * unconstrained string. Annotating the binding keeps the union where it
 * belongs and leaves no assertion to flag.
 */
interface KmsEnv {
  NODE_ENV: string;
  KMS_PROVIDER: "local" | "aws";
  KMS_LOCAL_KEK: string | undefined;
  KMS_KEK_ID: string | undefined;
}

export const env: KmsEnv = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  KMS_PROVIDER: process.env.KMS_PROVIDER === "aws" ? "aws" : "local",
  KMS_LOCAL_KEK: process.env.KMS_LOCAL_KEK,
  KMS_KEK_ID: process.env.KMS_KEK_ID,
};
