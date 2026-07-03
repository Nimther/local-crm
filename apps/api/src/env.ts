import { z } from "zod";

const envSchema = z.object({
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
});

export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
