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
      // 10-09 (SEC-12): baseValidEnv()'s 20-char secret is below the
      // production floor added in this same plan -- override it here so
      // this test still exercises only the PUBLIC_APP_URL guard.
      BETTER_AUTH_SECRET: "01234567890123456789012345678901",
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

  /**
   * Phase 13 (CMP-08, plan 13-11): narrowed from a blanket "zero files" ban
   * to an explicit allowlist. `ingestion-health-watchdog.ts` is the first
   * apps/api consumer of `withCrossWorkspaceScan` -- `ingress_journal` is
   * the first RLS-forced, tenant-scoped table an apps/api-resident watchdog
   * needs to read platform-wide, and migration 0055 (plan 13-01) grants the
   * dedicated `mega_crm_scan` role exactly that read (GRANT SELECT +
   * `ingress_journal_scan` policy). This is a plan-time architectural
   * decision, not an ad hoc relaxation: 13-11-PLAN.md's `key_links` names
   * "readIngestionHealth under withCrossWorkspaceScan" explicitly, threat
   * T-13-11-08 depends on it, and 13-REVIEWS.md HIGH finding 2 directed it.
   *
   * Phase 15 (OPS-13, plan 15-13, Task 3): `oldest-job-age-watchdog.ts` is
   * the SECOND permitted consumer, added for the structurally identical
   * reason -- its own `readOldestReconcilingSince` needs a platform-wide
   * `MIN(reconciling_since)` over `sends`, another RLS-forced, tenant-scoped
   * table, through the SAME `mega_crm_scan` role's existing unrestricted
   * `sends_scan` policy (migration 0042 -- the same grant
   * `send-reconciler.worker.ts`'s own discovery query already uses, see
   * SPECIFICATION.md §5.10).
   *
   * Phase 15 (OPS-13, plan 15-14, Task 2): `failed-send-share-watchdog.ts`
   * is the THIRD permitted consumer, for the same structural reason again --
   * its own `readSendStatusCountsSince` needs a platform-wide per-status
   * `COUNT(*) ... GROUP BY status` over `sends`, through the SAME
   * unrestricted `sends_scan` policy.
   *
   * Phase 15 (OPS-13, plan 15-14, Task 1): `webhook-lag-watchdog.ts` is the
   * FOURTH permitted consumer -- its own `readNewestWebhookEventAt` needs a
   * platform-wide `MAX(last_event_at)` over `workspace_webhook_endpoints`
   * (migration 0065's column-level scan grant), and it also reuses
   * `oldest-job-age-watchdog.ts`'s own `readOldestReconcilingSince` for the
   * "outstanding sends" half, both under the same `withCrossWorkspaceScan`
   * call. Any OTHER file importing `withCrossWorkspaceScan` still fails this
   * test -- P3's original intent (apps/api holds no BROAD scan-role
   * membership) is preserved by keeping the allowlist to these four
   * narrowly-scoped consumers.
   */
  it("only modules/ops/ingestion-health-watchdog.ts, modules/ops/oldest-job-age-watchdog.ts, modules/ops/failed-send-share-watchdog.ts and modules/ops/webhook-lag-watchdog.ts under apps/api/src (outside __tests__) import withCrossWorkspaceScan", () => {
    const ALLOWED = [
      path.join(API_SRC_DIR, "modules", "ops", "ingestion-health-watchdog.ts"),
      path.join(API_SRC_DIR, "modules", "ops", "oldest-job-age-watchdog.ts"),
      path.join(API_SRC_DIR, "modules", "ops", "failed-send-share-watchdog.ts"),
      path.join(API_SRC_DIR, "modules", "ops", "webhook-lag-watchdog.ts"),
    ];
    const offenders = collectTsFiles(API_SRC_DIR).filter(
      (file) => readFileSync(file, "utf8").includes("withCrossWorkspaceScan") && !ALLOWED.includes(file),
    );
    expect(offenders).toEqual([]);
  });
});
