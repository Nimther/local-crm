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
    OPERATOR_ALERT_EMAIL: "ops@megacrm.test",
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

/**
 * OPERATOR_ALERT_EMAIL (09-02, DB-02, D-01): the partition watchdog's only
 * push channel. A missing or malformed value must fail boot -- a disarmed
 * dead-man's switch must never look configured.
 */
describe("envSchema OPERATOR_ALERT_EMAIL enforcement", () => {
  it("fails when OPERATOR_ALERT_EMAIL is absent", () => {
    const { OPERATOR_ALERT_EMAIL: _omit, ...withoutOperatorAlertEmail } = baseValidEnv();
    const result = envSchema.safeParse(withoutOperatorAlertEmail);

    expect(result.success).toBe(false);
    if (!result.success) {
      const hasIssue = result.error.issues.some((issue) =>
        issue.path.includes("OPERATOR_ALERT_EMAIL")
      );
      expect(hasIssue).toBe(true);
    }
  });

  it("fails when OPERATOR_ALERT_EMAIL is not a valid email address", () => {
    const result = envSchema.safeParse({
      ...baseValidEnv(),
      OPERATOR_ALERT_EMAIL: "not-an-email-host",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const hasIssue = result.error.issues.some((issue) =>
        issue.path.includes("OPERATOR_ALERT_EMAIL")
      );
      expect(hasIssue).toBe(true);
    }
  });

  it("passes with a valid OPERATOR_ALERT_EMAIL", () => {
    const result = envSchema.safeParse(baseValidEnv());
    expect(result.success).toBe(true);
  });
});
