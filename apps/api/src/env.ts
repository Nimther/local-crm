import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    BETTER_AUTH_SECRET: z.string().min(16, "BETTER_AUTH_SECRET must be at least 16 characters"),
    BETTER_AUTH_URL: z.string().url(),
    WEB_URL: z.string().url(),
    API_PORT: z.coerce.number().int().positive().default(4000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // D-07: platform's own SendGrid account/key for system emails (verify,
    // reset, invite) -- structurally separate from any tenant's BYO key.
    PLATFORM_SENDGRID_API_KEY: z.string().min(1, "PLATFORM_SENDGRID_API_KEY is required"),
    PLATFORM_MAIL_FROM: z.string().email("PLATFORM_MAIL_FROM must be a valid email address"),
    // 01-05 / RESEARCH.md Pattern 3 + Pitfall 3: envelope encryption of the
    // tenant SendGrid key. "local" is a dev-only static-KEK provider;
    // "aws" is the real KMS path for staging/prod (KMS_KEK_ID required).
    KMS_PROVIDER: z.enum(["local", "aws"]).default("local"),
    KMS_LOCAL_KEK: z.string().optional(),
    KMS_KEK_ID: z.string().optional(),
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
  });

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
