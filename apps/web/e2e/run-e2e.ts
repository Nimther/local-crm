import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";

import { dropEphemeralDatabase } from "@mega-crm/test-support";

import { E2E_STATE_FILE } from "./provision-database.js";

/**
 * The E2E entrypoint: runs Playwright, then drops the ephemeral database.
 *
 * WHY THIS EXISTS — the drop cannot be a `globalTeardown` hook.
 *
 * Every run, green or red, ended with
 * `57P01: terminating connection due to administrator command`, because the
 * drop ran while the API server was still up and still holding pool
 * connections. That is not a symptom of a failing spec; it is a lifecycle
 * ordering defect, verified in Playwright 1.61.1's own source:
 *
 *   `runner/index.js` TaskRunner.runDeferCleanup:
 *       for (const task of this._tasks) {                        // setup order
 *         teardownRunner._tasks.unshift({ setup: task.teardown }); // PREPEND
 *         await task.setup?.(...);
 *       }
 *
 * Teardown tasks are UNSHIFTED, so they run in exact reverse of setup order.
 * Setup order puts the webServer plugin BEFORE `globalTeardown`
 * (`createGlobalSetupTasks`: removeOutputDirs → pluginSetup → globalTeardowns →
 * globalSetups), so the effective teardown order is:
 *
 *       globalSetup teardown
 *   →   globalTeardown            <- the drop used to happen HERE
 *   →   webServer plugin teardown <- servers only stop HERE
 *
 * `dropEphemeralDatabase` runs `pg_terminate_backend` against every session on
 * the database, so it was force-killing the live API server's pool backends and
 * node-postgres surfaced each killed connection as 57P01.
 *
 * No change INSIDE `globalTeardown` can fix this, because `globalTeardown` is
 * itself the hook that runs too early. The drop has to leave Playwright's
 * lifecycle entirely — hence this wrapper. By the time the child process has
 * exited, the webServer plugin has stopped both servers and their pools are
 * closed, so the terminate-and-drop has nothing left to kill.
 *
 * `apps/web/e2e/global-teardown.ts` and the `globalTeardown` config entry were
 * removed in the same change; this file replaces both.
 */

const require = createRequire(import.meta.url);

/**
 * Resolved through Node, not shelled out to.
 *
 * `npx playwright` would re-resolve through PATH and could pick up a different
 * install; a bare `"playwright"` command would need a shell. Resolving the CLI
 * module and running it under this same `process.execPath` pins the child to
 * exactly the @playwright/test this workspace declares.
 */
const PLAYWRIGHT_CLI = require.resolve("@playwright/test/cli");

/** Prefix for this file's own output, so it is distinguishable from Playwright's. */
const LOG_PREFIX = "[e2e:teardown]";

type ChildResult = { code: number | null; signal: NodeJS.Signals | null };

/**
 * Run `playwright test`, forwarding this process's arguments verbatim.
 *
 * `stdio: "inherit"` is required, not incidental: CI runs
 * `npm run test:e2e 2>&1 | tee e2e-output.txt` and then greps that file for the
 * `[e2e:database]` marker to prove which database the run touched. Capturing
 * and re-emitting the streams would risk losing or reordering that line.
 */
function runPlaywright(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [PLAYWRIGHT_CLI, "test", ...args], {
      stdio: "inherit",
    });

    // Ctrl+C reaches every process in the foreground group, so the child has
    // already been signalled by the time this handler runs. Registering a
    // handler at all is what matters: it REPLACES Node's default behaviour of
    // terminating this process immediately, which would skip the drop and leak
    // a database on exactly the runs a developer interrupts. Re-signalling the
    // child covers the other path — being signalled directly (`kill <pid>`)
    // rather than through the group.
    const forward = (signal: NodeJS.Signals) => () => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = forward("SIGINT");
    const onSigterm = forward("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);

    const cleanup = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    // "close" rather than "exit": it fires after the child's stdio has been
    // fully released, which is the point at which the servers it owned are
    // genuinely gone.
    child.on("close", (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

/**
 * Drop the database `provision-database.ts` created for this run.
 *
 * State travels through a temp file because provisioning happens in the
 * Playwright process (at config load) and the drop happens here, in its parent.
 * The name guard lives inside `dropEphemeralDatabase`, so this function decides
 * nothing about what is safe to destroy.
 */
async function dropProvisionedDatabase(): Promise<void> {
  let state: { databaseName: string; adminDsn: string };
  try {
    state = JSON.parse(readFileSync(E2E_STATE_FILE, "utf8")) as typeof state;
  } catch {
    // No state file means provisioning never got far enough to create one —
    // there is nothing to drop, and inventing a name to try would be worse.
    return;
  }

  try {
    await dropEphemeralDatabase(state.databaseName, state.adminDsn);
  } finally {
    rmSync(E2E_STATE_FILE, { force: true });
  }
}

const { code, signal } = await runPlaywright(process.argv.slice(2));

// Unconditional: a failing run leaves a database behind just as surely as a
// passing one, and the next run provisions a fresh name rather than reclaiming
// it, so skipping the drop here would leak one database per red run.
let dropFailed = false;
try {
  await dropProvisionedDatabase();
} catch (error) {
  dropFailed = true;
  console.error(`${LOG_PREFIX} FAILED to drop the ephemeral database:`, error);
}

// Exit-code precedence. The test result dominates: a red run must stay red, and
// must not be recoloured by teardown. A leaked database on an otherwise green
// run is still a failure worth surfacing, so it takes the remaining slot.
if (signal !== null) {
  // Conventional 128+N, so an interrupted run is distinguishable from a
  // test failure by anything reading the exit code.
  process.exit(128 + (os.constants.signals[signal] ?? 0));
}
if (code !== 0) {
  process.exit(code ?? 1);
}
process.exit(dropFailed ? 1 : 0);
