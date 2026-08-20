#!/usr/bin/env node
// GSD 01-07 gap closure: loud pre-dev env checker.
//
// Closes the "tsx watch stays alive after an env crash so the stack looks
// up" masquerade (see .planning/debug/registration-api-econnrefused.md).
// Wired as the root `predev` npm script so `npm run dev` aborts before
// `concurrently` ever starts api+web when required env vars are missing.
//
// No dependencies -- Node built-ins only.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveEnvPath } from "./env-path.mjs";

// 08-15 (QG-07): the default target is resolveEnvPath()'s — one decision point
// for where this machine's configuration lives, overridable with
// MEGA_CRM_ENV_FILE. The explicit argv[2] override is kept: it is how a
// developer checks an arbitrary file, and removing it would break an existing
// workflow for no gain.
const targetPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolveEnvPath();

if (!existsSync(targetPath)) {
  console.error(
    [
      `Env check failed: ${targetPath} does not exist.`,
      "",
      "Create it from the template in the repository:",
      `  mkdir -p "${targetPath.replace(/\/[^/]*$/, "")}"`,
      `  cp .env.example "${targetPath}"`,
      "",
      "Then fill in the required values and re-run npm run dev.",
      "The configuration deliberately lives OUTSIDE the repository working root;",
      "set MEGA_CRM_ENV_FILE to override the location.",
    ].join("\n")
  );
  process.exit(1);
}

const raw = readFileSync(targetPath, "utf8");
const values = {};

for (const line of raw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) continue;
  const eqIndex = trimmed.indexOf("=");
  if (eqIndex === -1) continue;
  const key = trimmed.slice(0, eqIndex).trim();
  const value = trimmed.slice(eqIndex + 1).trim();
  values[key] = value;
}

function isMissing(name) {
  return !values[name] || values[name].length === 0;
}

// GSD 10-15 (gap G-10-1): the admin DSN variables GSD_ADMIN_DATABASE_URL /
// TEST_ADMIN_DATABASE_URL (consumed by scripts/ensure-db-roles.mjs's
// resolveAdminDsn) are deliberately ABSENT from baseRequired below. Their
// compose-default fallback DSN is valid in compose and CI environments, so
// hard-requiring either variable here would fail an environment that is
// correctly configured -- unlike DATABASE_URL etc., "unset" is not itself a
// misconfiguration for these two.
//
// The consequence that made G-10-1 confusing to diagnose: this check (predev
// step 1) passed while ensure-db-roles.mjs's DSN dependency (predev step 2)
// was unmet, so the `&&` chain aborted one step later with no signal from
// here. scripts/__tests__/predev-env-loading.test.mjs (Task 2, 10-15) is the
// guard that now covers that seam -- it fails if any predev-chain script
// that reads a DATABASE_URL-suffixed variable stops routing through
// resolveEnvPath(), independent of whether check-env.mjs's required list
// covers that variable.
const baseRequired = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "WEB_URL",
  "PLATFORM_SENDGRID_API_KEY",
  "PLATFORM_MAIL_FROM",
  // 09-02 (DB-02, D-01): presence-only check here; apps/api/src/env.ts
  // enforces the email-format contract. A `npm run dev` stack whose
  // partition watchdog has nowhere to send is a silently disarmed alert
  // channel -- hard fail, not a warning like the PUBLIC_APP_URL localhost
  // heads-up below.
  "OPERATOR_ALERT_EMAIL",
  "REDIS_URL",
  // Phase 10 (SEC-01/SEC-02, P3): worker-only DSN for the mega_crm_scan
  // role's cross-workspace scans -- deliberately absent from
  // apps/api/src/env.ts's schema (the API process must never hold this
  // credential). Presence-only check here; apps/worker/src/server.ts
  // enforces the fail-fast contract at boot.
  "SCAN_DATABASE_URL",
  // Phase 10 (SEC-05, D-04): the API-process-only DSN better-auth's adapter
  // connects with, under the `mega_crm_auth` role -- presence-only check
  // here; apps/api/src/env.ts enforces the non-empty contract.
  "AUTH_DATABASE_URL",
  // 04-16 gap closure: read lazily (and thrown on) inside
  // packages/delivery-core/src/unsubscribe-token.ts at send-time -- every
  // broadcast/test send signs a List-Unsubscribe token, so a missing value
  // here previously crashed per-job instead of failing loud at boot (the
  // root cause of UAT Tests 4/5). Presence-only check; apps/api/src/env.ts
  // and apps/worker/src/server.ts enforce the >=32-char strength contract
  // and (19-02, D-03) the comma/whitespace charset contract, mirrored below.
  // 19-02 (ROT-01, D-01): UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS is deliberately
  // NOT added here -- it is optional, so there is no presence to require.
  // Its conditional structural validation (D-02/D-03/D-07) lives in the
  // block below, after the missing-required check.
  "UNSUBSCRIBE_TOKEN_SECRET",
  // For a LIVE SendGrid webhook UAT this must be a publicly reachable https
  // URL (e.g. an ngrok/cloudflared tunnel pointed at this API's port) --
  // SendGrid delivers events by calling this URL directly from the public
  // internet. A localhost value is fine for every other feature but breaks
  // live webhook provisioning/delivery; see docs/webhook-live-uat.md for
  // the full tunnel + SendGrid key-scope setup. Presence-only check here;
  // the localhost heads-up below is a non-fatal warning, not a hard fail.
  "PUBLIC_APP_URL",
];

const required = [...baseRequired];

const kmsProvider = values.KMS_PROVIDER || "local";
if (kmsProvider === "aws") {
  required.push("KMS_KEK_ID");
} else if (kmsProvider === "file") {
  required.push("KMS_FILE_KEK_PATH");
} else if (kmsProvider === "local") {
  required.push("KMS_LOCAL_KEK");
} else {
  console.error(`Env check failed: KMS_PROVIDER must be one of local, aws, file (received ${JSON.stringify(kmsProvider)})`);
  process.exit(1);
}

const missing = required.filter(isMissing);

if (missing.length > 0) {
  console.error(
    [
      `Env check failed: ${missing.length} required variable(s) missing or empty in ${targetPath}:`,
      ...missing.map((name) => `  - ${name}`),
      "See .env.example in the repository for the full template.",
    ].join("\n")
  );
  process.exit(1);
}

// 19-02 (ROT-01, D-07, SC4): the previous-secrets list's hard structural
// bound -- a soft cap, not a date-based purge. Declared independently here;
// apps/api/src/env.ts and apps/worker/src/server.ts each declare their own
// copy per this codebase's triplication convention (SPECIFICATION.md §3.1),
// and __tests__/check-env-unsubscribe-previous.test.mjs's Block B proves the
// three agree.
const MAX_UNSUBSCRIBE_PREVIOUS_SECRETS = 5;

// 19-02 (ROT-01, D-01/D-02/D-03/D-07): conditional structural validation of
// UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS, and the same tightened charset rule on
// the primary secret. Mirrors apps/api/src/env.ts's superRefine and
// apps/worker/src/server.ts's assertUnsubscribeTokenSecrets, independently
// hard-coded here per this codebase's triplication convention. Only runs
// when the previous-secrets value is present and non-empty -- its absence
// is the normal pre-rotation state (D-01). Violation lines name the
// variable, the rule and (for count/length rules) the offending 1-based
// position -- never the value, never a fragment of it (T-19-08).
{
  const violations = [];
  const primary = values.UNSUBSCRIBE_TOKEN_SECRET || "";
  if (/[,\s]/.test(primary)) {
    violations.push("UNSUBSCRIBE_TOKEN_SECRET must not contain a comma or whitespace (D-03)");
  }
  const previous = values.UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS;
  if (previous) {
    if (/\s/.test(previous)) {
      violations.push("UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entries must not contain whitespace (D-03)");
    }
    const entries = previous.split(",");
    if (entries.length > MAX_UNSUBSCRIBE_PREVIOUS_SECRETS) {
      violations.push(
        `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS supports at most ${MAX_UNSUBSCRIBE_PREVIOUS_SECRETS} retired secrets (found ${entries.length})`
      );
    }
    const seen = new Set();
    entries.forEach((entry, index) => {
      const position = index + 1;
      if (entry.length === 0) {
        violations.push(`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entry ${position} must not be empty`);
      } else if (entry.length < 32) {
        violations.push(`UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entry ${position} must be at least 32 characters`);
      }
      if (entry === primary || seen.has(entry)) {
        violations.push(
          `UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS entry ${position} duplicates the primary secret or another entry`
        );
      }
      seen.add(entry);
    });
  }

  if (violations.length > 0) {
    console.error(
      [
        `Env check failed: UNSUBSCRIBE_TOKEN_SECRET_PREVIOUS validation failed in ${targetPath}:`,
        ...violations.map((v) => `  - ${v}`),
        "See .env.example in the repository for the full template.",
      ].join("\n")
    );
    process.exit(1);
  }
}

// Non-fatal heads-up: a localhost PUBLIC_APP_URL is fine for local dev of
// everything except live SendGrid webhook delivery (SendGrid cannot reach a
// localhost URL from the public internet). Warn only -- do not fail the
// check -- and point at the runbook. See docs/webhook-live-uat.md.
const publicAppUrl = values.PUBLIC_APP_URL || "";
if (/localhost|127\.0\.0\.1/.test(publicAppUrl)) {
  console.warn(
    [
      "Heads up: PUBLIC_APP_URL points at localhost/127.0.0.1.",
      "Live SendGrid webhook delivery cannot reach a localhost URL --",
      "see docs/webhook-live-uat.md for tunnel (ngrok/cloudflared) setup",
      "before running the live webhook UAT.",
    ].join(" ")
  );
}

// 05-12 gap-closure (round-4 UAT root cause): SendGrid rejects ANY non-https
// Event Webhook URL with `400 "webhook url must use https"`, not just
// localhost ones (e.g. a plain http:// tunnel URL also fails). Broader than
// the localhost-only check above -- fires on any http:// scheme. Non-fatal:
// per the 05-10 decision, local dev of every other feature is fine on
// http/localhost; only live webhook delivery needs https.
if (/^http:\/\//i.test(publicAppUrl)) {
  console.warn(
    [
      "Heads up: PUBLIC_APP_URL uses http://.",
      "SendGrid requires an https webhook URL and will reject provisioning",
      "with 400 \"webhook url must use https\".",
      "Set an https tunnel URL (e.g. ngrok/cloudflared) in PUBLIC_APP_URL and",
      "restart the server before the live webhook UAT --",
      "see docs/webhook-live-uat.md.",
    ].join(" ")
  );
}

console.log("Env check passed.");
process.exit(0);
