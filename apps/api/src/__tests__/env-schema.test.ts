import { describe, expect, it } from "vitest";
import { envSchema } from "../env.js";

/**
 * envSchema (05-12 gap-closure, defense-in-depth #2): a production boot with
 * a non-https PUBLIC_APP_URL must fail fast -- SendGrid rejects a non-https
 * Event Webhook URL outright. Development/test still accept http (local
 * tunnels / localhost).
 */
function baseValidEnv(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/megacrm_test",
    REDIS_URL: "redis://localhost:6379/1",
    BETTER_AUTH_SECRET: "0123456789abcdef0123",
    BETTER_AUTH_URL: "http://localhost:4000",
    WEB_URL: "http://localhost:5173",
    PLATFORM_SENDGRID_API_KEY: "SG.test_platform_key_0000000000000000",
    PLATFORM_MAIL_FROM: "noreply@megacrm.test",
    UNSUBSCRIBE_TOKEN_SECRET: "test-only-unsubscribe-secret-at-least-32-bytes",
    PUBLIC_APP_URL: "https://api.test.local",
    KMS_PROVIDER: "local",
    KMS_LOCAL_KEK: "grdVCb1fxmhPzylKEPqafcPW4xOMaynE0UwaFUo2OUE=",
  };
}

describe("envSchema PUBLIC_APP_URL https enforcement", () => {
  it("production + http PUBLIC_APP_URL fails, with an issue on path PUBLIC_APP_URL", () => {
    const result = envSchema.safeParse({
      ...baseValidEnv(),
      NODE_ENV: "production",
      PUBLIC_APP_URL: "http://app.example.com",
      KMS_PROVIDER: "aws",
      KMS_KEK_ID: "arn:aws:kms:us-east-1:123456789012:key/test-kek",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const hasPublicAppUrlIssue = result.error.issues.some((issue) =>
        issue.path.includes("PUBLIC_APP_URL")
      );
      expect(hasPublicAppUrlIssue).toBe(true);
    }
  });

  it("production + https PUBLIC_APP_URL passes", () => {
    const result = envSchema.safeParse({
      ...baseValidEnv(),
      NODE_ENV: "production",
      PUBLIC_APP_URL: "https://app.example.com",
      KMS_PROVIDER: "aws",
      KMS_KEK_ID: "arn:aws:kms:us-east-1:123456789012:key/test-kek",
    });

    expect(result.success).toBe(true);
  });

  it("development + http PUBLIC_APP_URL still passes (local tunnels/localhost allowed)", () => {
    const result = envSchema.safeParse({
      ...baseValidEnv(),
      NODE_ENV: "development",
      PUBLIC_APP_URL: "http://localhost:4000",
      KMS_PROVIDER: "local",
    });

    expect(result.success).toBe(true);
  });
});
