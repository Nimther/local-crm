#!/usr/bin/env node
// GSD 04-16 gap closure: predev migration bootstrap.
//
// Prevents the "unapplied migration" failure class (UAT Test 5's kickoff
// crash: `column "fan_out_complete" does not exist`, because migrations
// 0017-0019 were added but never applied to the dev DB and `npm run dev`
// had no migrate step). Wired as the second step of the root `predev` npm
// script (after scripts/check-env.mjs), so `npm run dev` always applies
// pending Drizzle migrations before the stack boots.
//
// No dependencies -- Node built-ins only.

import { execSync } from "node:child_process";
import { resolve } from "node:path";

// Load the repo-root .env, mirroring apps/api/vitest.config.ts and
// apps/worker/vitest.config.ts's env-loading pattern. This runtime load is
// done by Node itself (process.loadEnvFile), not by a Claude tool, so it is
// not affected by the .env* tool-deny.
try {
  process.loadEnvFile(resolve(import.meta.dirname, "../.env"));
} catch {
  // .env not present -- rely on already-exported environment variables
}

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is required to apply migrations -- set it in .env"
  );
  process.exit(1);
}

// drizzle.config.ts (packages/db) reads process.env.DATABASE_URL directly,
// so the child inheriting the now-populated process.env resolves DB
// credentials correctly regardless of cwd. Let a migrate failure propagate
// as a non-zero exit -- do not swallow it.
execSync("npm run db:migrate", { stdio: "inherit", env: process.env });
