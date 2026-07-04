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

const targetPath = resolve(process.cwd(), process.argv[2] || ".env");

if (!existsSync(targetPath)) {
  console.error(
    [
      `Env check failed: ${targetPath} does not exist.`,
      "Copy .env.example to .env and fill in the required values, then re-run npm run dev.",
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
      "See .env.example.",
    ].join("\n")
  );
  process.exit(1);
}

console.log("Env check passed.");
process.exit(0);
