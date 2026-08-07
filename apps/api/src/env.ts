import { z } from "zod";

export const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    // 10-09 (SEC-05, D-04): better-auth's drizzleAdapter pool connects as the
    // dedicated `mega_crm_auth` login role on its OWN DSN, not `mega_crm_app`
    // -- the secret-bearing auth tables (session/account/verification) are
    // reachable only through this credential as of migration 0045. Deliberately
    // NO cross-workspace-scan variable here -- plan 10-01's P3 negative test
    // (apps/api/src/__tests__/env-schema.test.ts) asserts this schema's
    // source never names that variable.
    AUTH_DATABASE_URL: z.string().min(1, "AUTH_DATABASE_URL is required"),
    // 02-05: BullMQ queue backend (event ingestion + CSV import); the API
    // refuses to boot without a configured Redis, same pattern as DATABASE_URL.
    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 characters"),
    BETTER_AUTH_URL: z.string().url(),
    WEB_URL: z.string().url(),
    API_PORT: z.coerce.number().int().positive().default(4000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // D-07: platform's own SendGrid account/key for system emails (verify,
    // reset, invite) -- structurally separate from any tenant's BYO key.
    PLATFORM_SENDGRID_API_KEY: z.string().min(1, "PLATFORM_SENDGRID_API_KEY is required"),
    PLATFORM_MAIL_FROM: z.string().email("PLATFORM_MAIL_FROM must be a valid email address"),
    // 09-02 (DB-02, D-01): the address the partition watchdog emails when
    // the maintenance job stops, when the partition buffer drops below the
    // threshold, or when a DEFAULT partition holds rows -- it is the only
    // push channel the platform has before Phase 15's real alerting
    // arrives, so a missing value must fail the API boot rather than
    // silently disable the dead-man's switch. Same email validator shape as
    // PLATFORM_MAIL_FROM so a typo fails at boot rather than at first
    // alert. Deliberately no `.optional()` and no `.default(` -- a default
    // would mean alerts going nowhere while every check reports configured.
    OPERATOR_ALERT_EMAIL: z.string().email("OPERATOR_ALERT_EMAIL must be a valid email address"),
    // 01-05 / RESEARCH.md Pattern 3 + Pitfall 3: envelope encryption of the
    // tenant SendGrid key. "local" is a dev-only static-KEK provider;
    // "aws" is the real KMS path for staging/prod (KMS_KEK_ID required).
    KMS_PROVIDER: z.enum(["local", "aws"]).default("local"),
    KMS_LOCAL_KEK: z.string().optional(),
    KMS_KEK_ID: z.string().optional(),
    // 04-03/04-16: packages/delivery-core signs/verifies the one-click
    // List-Unsubscribe token (HMAC secret) and builds its public URL from
    // these -- the API also hosts GET/POST /unsubscribe/:token, so it fails
    // fast on the same contract the worker enforces at boot.
    UNSUBSCRIBE_TOKEN_SECRET: z
      .string()
      .min(32, "UNSUBSCRIBE_TOKEN_SECRET must be at least 32 characters"),
    PUBLIC_APP_URL: z.string().url(),
  })
  .superRefine((val, ctx) => {
    // Boot-time guard (RESEARCH.md Pitfall 3 / Open Question 2): the
    // local-dev-only static KEK must never back production. This is the
    // primary enforcement point (fails before the server even starts
    // listening); kms/local-provider.ts carries a redundant guard for the
    // case where it's imported directly.
    if (val.NODE_ENV === "production" && val.KMS_PROVIDER === "local") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "KMS_PROVIDER=local must never be used when NODE_ENV=production (RESEARCH.md Pitfall 3)",
        path: ["KMS_PROVIDER"],
      });
    }
    if (val.KMS_PROVIDER === "aws" && !val.KMS_KEK_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "KMS_KEK_ID is required when KMS_PROVIDER=aws",
        path: ["KMS_KEK_ID"],
      });
    }
    // 05-12 gap-closure (defense-in-depth #2): SendGrid rejects a non-https
    // Event Webhook URL outright (400 "webhook url must use https"). The
    // provisioning-layer pre-flight guard catches this at request time, but
    // a production boot should never even start with a misconfigured
    // PUBLIC_APP_URL -- development/test intentionally still allow http
    // (local tunnels / localhost), matching the KMS_PROVIDER=local guard's
    // same NODE_ENV-gated shape above.
    if (val.NODE_ENV === "production" && val.PUBLIC_APP_URL.startsWith("http://")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PUBLIC_APP_URL must use https when NODE_ENV=production (SendGrid rejects non-https webhook URLs)",
        path: ["PUBLIC_APP_URL"],
      });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  - ${path}: ${issue.message}`;
  });
  throw new Error(
    [
      "Invalid environment configuration -- the API cannot start.",
      "Fix these variables (see .env.example):",
      ...lines,
    ].join("\n")
  );
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
