import { readFileSync, rmSync } from "node:fs";

import { dropEphemeralDatabase } from "@mega-crm/test-support";

import { E2E_STATE_FILE } from "./provision-database.js";

/**
 * 08-10 (QG-04) — drops the database provision-database.ts provisioned.
 *
 * A separate file because Playwright's `globalTeardown` is its own module
 * path, required for its default export. Since 08-18 the provisioning half no
 * longer runs as a hook at all — it happens when playwright.config.ts is
 * evaluated — but the drop still has to be a hook, because it must run after
 * the servers have stopped.
 *
 * State travels through a temp file rather than module scope. The two halves
 * are loaded as separate entry points, so a shared module-level variable is an
 * assumption about Playwright's loader; a file is not.
 *
 * The drop itself is name-guarded inside dropEphemeralDatabase — this file
 * decides nothing about what is safe to destroy.
 */
export default async function globalTeardown(): Promise<void> {
  let state: { databaseName: string; adminDsn: string };
  try {
    state = JSON.parse(readFileSync(E2E_STATE_FILE, "utf8")) as typeof state;
  } catch {
    // No state file means provisioning never got far enough to create one.
    // Nothing to drop, and inventing a name to try would be worse.
    return;
  }

  try {
    await dropEphemeralDatabase(state.databaseName, state.adminDsn);
  } finally {
    rmSync(E2E_STATE_FILE, { force: true });
  }
}
