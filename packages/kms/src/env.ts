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
  KMS_PROVIDER: "local" | "aws" | "file";
  KMS_LOCAL_KEK: string | undefined;
  KMS_KEK_ID: string | undefined;
  KMS_FILE_KEK_PATH: string | undefined;
}

export function loadKmsEnv(source: NodeJS.ProcessEnv = process.env): KmsEnv {
  const rawProvider = source.KMS_PROVIDER ?? "local";
  if (rawProvider !== "local" && rawProvider !== "aws" && rawProvider !== "file") {
    throw new Error(`KMS_PROVIDER must be one of local, aws, file (received ${JSON.stringify(rawProvider)})`);
  }
  if (source.NODE_ENV === "production" && rawProvider === "local") {
    throw new Error("KMS_PROVIDER=local must never be imported or used when NODE_ENV=production");
  }
  if (rawProvider === "aws" && !source.KMS_KEK_ID) {
    throw new Error("KMS_KEK_ID must be set when KMS_PROVIDER=aws");
  }
  if (rawProvider === "file" && !source.KMS_FILE_KEK_PATH) {
    throw new Error("KMS_FILE_KEK_PATH must be set when KMS_PROVIDER=file");
  }
  return {
    NODE_ENV: source.NODE_ENV ?? "development",
    KMS_PROVIDER: rawProvider,
    KMS_LOCAL_KEK: source.KMS_LOCAL_KEK,
    KMS_KEK_ID: source.KMS_KEK_ID,
    KMS_FILE_KEK_PATH: source.KMS_FILE_KEK_PATH,
  };
}

export const env: KmsEnv = loadKmsEnv();
