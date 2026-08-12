#!/usr/bin/env node
// GSD Phase 14 plan 04 (Pitfall 7, D-14, R-05): prints
// WORKER_STOP_GRACE_PERIOD_SECONDS as a bare integer on stdout, so a shell
// can capture it directly into the worker container's stop-grace-period
// setting. Compose/Kubernetes cannot import a TypeScript constant --
// apps/worker/src/shutdown-budget.ts's own header comment requires Phase 14
// to build the extraction mechanism, and this script is it.
//
// Invocation (plans 14-08/14-09 copy this verbatim):
//
//   npm run build -w apps/worker && node scripts/print-stop-grace-period.mjs
//
// Requires a build first: imports the COMPILED
// apps/worker/dist/shutdown-budget.js, never the TypeScript source, so the
// printed number always matches what the running container actually
// executes (`node dist/server.js`) -- never a value read from source that
// could drift from what was actually built and shipped.
//
// Never falls back to a hand-typed number when the build is missing or
// stale -- exits loudly instead. A fallback here is the exact failure
// Pitfall 7 warns about: the container silently gets a grace period
// shorter than the SendGrid timeout, and a routine deploy starts producing
// the ambiguous-outcome sends Phase 11's reconciler exists to clean up.
//
// No dependencies -- Node built-ins only.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILT_MODULE_PATH = path.join(REPO_ROOT, "apps/worker/dist/shutdown-budget.js");
const BUILD_COMMAND = "npm run build -w apps/worker";

// `fail` exits synchronously and never returns control to its caller --
// deliberately not relying on `process.exit()`'s own control-flow behavior
// alone (which schedules termination but does not, by itself, guarantee no
// further statement in the calling function runs first): every call site
// below is followed immediately by `return`, so a future edit that inserts
// code between `fail(...)` and the function's end cannot accidentally run
// past a reported failure with `mod`/`value` left in an invalid state.
function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  let mod;
  try {
    mod = await import(pathToFileURL(BUILT_MODULE_PATH).href);
  } catch (err) {
    fail(
      [
        `print-stop-grace-period FAILED: could not import ${BUILT_MODULE_PATH}.`,
        `  ${err instanceof Error ? err.message : String(err)}`,
        "",
        "The worker must be built first:",
        "",
        `  ${BUILD_COMMAND}`,
        "",
        "This script never falls back to a hand-typed grace period -- a stale",
        "or missing build would otherwise silently ship a number the running",
        "container's actual constant no longer matches (Pitfall 7).",
      ].join("\n")
    );
    return;
  }

  const value = mod.WORKER_STOP_GRACE_PERIOD_SECONDS;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(
      `print-stop-grace-period FAILED: WORKER_STOP_GRACE_PERIOD_SECONDS is not an integer (${JSON.stringify(value)}) -- the built output may be stale or the constant's shape changed. Rebuild with "${BUILD_COMMAND}".`
    );
    return;
  }

  process.stdout.write(`${String(value)}\n`);
}

await main();
