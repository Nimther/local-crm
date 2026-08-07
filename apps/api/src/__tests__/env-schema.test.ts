import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envSchema } from "../env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_SRC_DIR = path.resolve(__dirname, "..");

/**
 * envSchema (05-12 gap-closure, defense-in-depth #2): a production boot with
 * a non-https PUBLIC_APP_URL must fail fast -- SendGrid rejects a non-https
 * Event Webhook URL outright. Development/test still accept http (local
 * tunnels / localhost).
 */
function baseValidEnv(): Record<string, string> {
  return {
    DATABASE_URL: "postgres://user:pass@localhost:5432/megacrm_test",
    AUTH_DATABASE_URL: "postgres://mega_crm_auth:pass@localhost:5432/megacrm_test",
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

/**
 * BETTER_AUTH_SECRET production floor (10-09, SEC-12): the base field's
 * existing min(16) is development/test's only guard -- production requires
 * at least 32 characters, gated the same NODE_ENV-conditional way as the
 * KMS_PROVIDER=local and PUBLIC_APP_URL guards above.
 */
describe("envSchema BETTER_AUTH_SECRET production floor", () => {
  it("Test 1: production + a 20-character secret fails, with an issue on path BETTER_AUTH_SECRET", () => {
    const result = envSchema.safeParse({
      ...baseValidEnv(),
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "0123456789abcdef0123",
      PUBLIC_APP_URL: "https://app.example.com",
      KMS_PROVIDER: "aws",
      KMS_KEK_ID: "arn:aws:kms:us-east-1:123456789012:key/test-kek",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("BETTER_AUTH_SECRET"));
      expect(issue, "expected an issue on BETTER_AUTH_SECRET").toBeTruthy();
    }
  });

  it("Test 2: the same 20-character secret in development still passes -- the floor is production-only", () => {
    const result = envSchema.safeParse({
      ...baseValidEnv(),
      NODE_ENV: "development",
      BETTER_AUTH_SECRET: "0123456789abcdef0123",
    });

    expect(result.success).toBe(true);
  });

  it("Test 3: a 32-character secret in production passes", () => {
    const result = envSchema.safeParse({
      ...baseValidEnv(),
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
      PUBLIC_APP_URL: "https://app.example.com",
      KMS_PROVIDER: "aws",
      KMS_KEK_ID: "arn:aws:kms:us-east-1:123456789012:key/test-kek",
    });

    expect(result.success).toBe(true);
  });

  it("Test 4: the failure message names the variable and the 32-character requirement", () => {
    const result = envSchema.safeParse({
      ...baseValidEnv(),
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "0123456789abcdef0123",
      PUBLIC_APP_URL: "https://app.example.com",
      KMS_PROVIDER: "aws",
      KMS_KEK_ID: "arn:aws:kms:us-east-1:123456789012:key/test-kek",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes("BETTER_AUTH_SECRET"));
      expect(issue?.message).toMatch(/BETTER_AUTH_SECRET/);
      expect(issue?.message).toMatch(/32/);
    }
  });
});

/**
 * Phase 10 (SEC-01/SEC-02, P3, D-01): "the API process holds neither
 * scan-role credentials nor membership" is a STRUCTURAL claim -- it must be
 * true of the source, not just of the runtime-parsed env object (a
 * Zod-parsed object strips unknown keys, so testing `env.SCAN_DATABASE_URL`
 * at runtime would pass vacuously even if the schema declared it). These
 * two assertions read the source directly.
 */
describe("P3 -- apps/api holds no scan-role credential or entry point", () => {
  it("apps/api/src/env.ts does not reference SCAN_DATABASE_URL", () => {
    const envSource = readFileSync(path.join(API_SRC_DIR, "env.ts"), "utf8");
    expect(envSource).not.toMatch(/SCAN_DATABASE_URL/);
  });

  function collectTsFiles(dir: string): string[] {
    const entries = readdirSync(dir);
    const files: string[] = [];
    for (const entry of entries) {
      if (entry === "__tests__") continue;
      const entryPath = path.join(dir, entry);
      const stat = statSync(entryPath);
      if (stat.isDirectory()) {
        files.push(...collectTsFiles(entryPath));
      } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
        files.push(entryPath);
      }
    }
    return files;
  }

  it("no file under apps/api/src (outside __tests__) imports withCrossWorkspaceScan", () => {
    const offenders = collectTsFiles(API_SRC_DIR).filter((file) =>
      readFileSync(file, "utf8").includes("withCrossWorkspaceScan"),
    );
    expect(offenders).toEqual([]);
  });
});
