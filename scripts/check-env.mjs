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

const baseRequired = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "WEB_URL",
  "PLATFORM_SENDGRID_API_KEY",
  "PLATFORM_MAIL_FROM",
  "REDIS_URL",
  // 04-16 gap closure: read lazily (and thrown on) inside
  // packages/delivery-core/src/unsubscribe-token.ts at send-time -- every
  // broadcast/test send signs a List-Unsubscribe token, so a missing value
  // here previously crashed per-job instead of failing loud at boot (the
  // root cause of UAT Tests 4/5). Presence-only check; apps/api/src/env.ts
  // and apps/worker/src/server.ts enforce the >=32-char strength contract.
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
} else {
  required.push("KMS_LOCAL_KEK");
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
