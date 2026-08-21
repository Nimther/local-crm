import { z } from "zod";

// 19-02 (ROT-01, D-07, SC4): the previous-secrets list's hard structural
// bound -- a soft cap, not a date-based purge. Declared independently here;
// apps/worker/src/server.ts and scripts/check-env.mjs each declare their
// own copy per this codebase's triplication convention (SPECIFICATION.md
// §3.1), and 19-02 Task 3's parity assertion proves the three agree.
const MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5;

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
    KMS_PROVIDER: z.enum(["local", "aws", "file"]).default("local"),
    KMS_LOCAL_KEK: z.string().optional(),
    KMS_KEK_ID: z.string().optional(),
    KMS_FILE_KEK_PATH: z.string().min(1).optional(),
    // 04-03/04-16: packages/delivery-core signs/verifies the one-click
    // List-Unsubscribe token (HMAC secret) and builds its public URL from
    // these -- the API also hosts GET/POST /unsubscribe/:token, so it fails
    // fast on the same contract the worker enforces at boot.
    // 19-02 (ROT-01, D-03): the comma/whitespace refine below is what makes
    // packages/delivery-core's comma-split of UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS
    // unambiguous -- a secret containing either character could otherwise
    // collide with the list delimiter or hide inside a split fragment.
    UNSUBSCRIBE_TOKEN_SECRET: z
      .string()
      .min(32, "UNSUBSCRIBE_TOKEN_SECRET must be at least 32 characters")
      .refine(
        (v) => !/[,\s]/.test(v),
        "UNSUBSCRIBE_TOKEN_SECRET must not contain a comma or whitespace (D-03)"
      ),
    // 19-02 (ROT-01, D-01, D-02): the ordered, comma-separated list of
    // retired unsubscribe-token secrets the two-step rotation runbook keeps
    // verification-only for already-issued links. Optional -- its absence
    // is the normal pre-rotation state and every existing deploy env file
    // stays valid as-is. Full structural validation lives in the
    // superRefine below (this field itself is presence-only).
    UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS: z.string().optional(),
    PUBLIC_APP_URL: z.string().url(),
    // 10-11 (SEC-07): the SendGrid Event Webhook's signature-timestamp
    // replay/staleness window, in seconds -- overridable without a deploy.
    // Same coercion shape as API_PORT. Default matches
    // signature-verify.ts's DEFAULT_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
    // keep the two in sync if either changes.
    WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(600),
    // Phase 15 plan 10 (OPS-08): all three optional -- a missing DSN must
    // never fail boot or fail validation (RESEARCH.md Pitfall 18's
    // one-way-door risk means Sentry init is opt-in per environment, never
    // required). apps/api/src/sentry.ts's initSentry() simply stays
    // uninitialized when SENTRY_DSN_API is unset. Real values are supplied
    // only in the deployed environment (see docker/prod.env.example and this
    // plan's SUMMARY.md "User Setup Required").
    SENTRY_DSN_API: z.string().optional(),
    // Overrides Sentry's own "environment" tag; defaults to NODE_ENV
    // (apps/api/src/sentry.ts) when unset rather than being required here,
    // since NODE_ENV already carries this information for every other
    // purpose in this schema.
    SENTRY_ENVIRONMENT: z.string().optional(),
    // Reuses docker-compose.prod.yml's existing IMAGE_TAG (the full deployed
    // image SHA, plan 14-08/14-09) as Sentry's release identifier rather
    // than introducing a second, parallel release variable -- this plan's
    // Task 3 threads it through to the container's own process environment
    // (previously IMAGE_TAG only selected which image tag `docker compose`
    // pulls; it was never passed into the container itself). Optional
    // because dev/test never sets it -- Sentry simply omits `release` from
    // the event in that case.
    IMAGE_TAG: z.string().optional(),
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
    if (val.KMS_PROVIDER === "file" && !val.KMS_FILE_KEK_PATH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "KMS_FILE_KEK_PATH is required when KMS_PROVIDER=file",
        path: ["KMS_FILE_KEK_PATH"],
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
    // 10-09 (SEC-12): the base field above only enforces min(16) -- fine for
    // development/test, where a short fixture secret is convenient and the
    // cost of guessing it is zero. Production sessions are signed with this
    // secret, so a weak value there silently weakens every session in the
    // system; the floor is gated the same NODE_ENV-conditional way as the
    // KMS_PROVIDER=local and PUBLIC_APP_URL guards above, so
    // development/test are unaffected.
    if (val.NODE_ENV === "production" && val.BETTER_AUTH_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "BETTER_AUTH_SECRET must be at least 32 characters when NODE_ENV=production",
        path: ["BETTER_AUTH_SECRET"],
      });
    }
    // 19-02 (ROT-01, D-01/D-02/D-03/D-07): structural validation of the
    // previous-secrets rotation list. Only runs when the variable is set
    // and non-empty -- its absence is the normal pre-rotation state (D-01)
    // and needs no validation. A comma inside an intended single entry is
    // structurally unobservable after the split below (it simply becomes a
    // list boundary), so the per-entry length and non-empty checks, not a
    // per-fragment comma check, are the practical backstop for a mistyped
    // entry. No issue message here echoes a secret value or a fragment of
    // one (T-19-08).
    if (val.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS) {
      if (/\s/.test(val.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entries must not contain whitespace (D-03)",
          path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"],
        });
      }
      const entries = val.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS.split(",");
      if (entries.length > MAX_UNSUBSCRIBE_PREVIOUS_SECRETS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS supports at most ${MAX_UNSUBSCRIBE_PREVIOUS_SECRETS} retired secrets`,
          path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"],
        });
      }
      const seen = new Set<string>();
      for (const entry of entries) {
        if (entry.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS must not contain empty entries",
            path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"],
          });
        } else if (entry.length < 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "each UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entry must be at least 32 characters",
            path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"],
          });
        }
        if (entry === val.UNSUBSCRIBE_TOKEN_SECRET || seen.has(entry)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS must not duplicate the primary secret or another entry",
            path: ["UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS"],
          });
        }
        seen.add(entry);
      }
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
