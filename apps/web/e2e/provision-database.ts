import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertTestDatabaseUrl,
  createEphemeralDatabase,
  ensureTestDbMigrated,
} from "@mega-crm/test-support";

/**
 * 08-18 (QG-04) — provisioning moved OUT of `globalSetup`, because
 * `globalSetup` runs too late to affect the servers under test.
 *
 * Playwright builds its startup task list in this order
 * (`playwright/lib/runner/index.js`, `createGlobalSetupTasks`):
 *
 *     createRemoveOutputDirsTask()
 *     ...createPluginSetupTasks(config)   <- the webServer plugin starts here
 *     ...globalTeardowns
 *     ...globalSetups                     <- globalSetup only now
 *
 * So the API server had already booted, and read DATABASE_URL, before
 * `globalSetup` ever assigned the ephemeral DSN to it. 08-10 provisioned a
 * database, guarded it, migrated it and printed it — and then the server
 * under test used a completely different one.
 *
 * On a developer machine that different one is the DEV database, which has
 * the schema, so all five specs passed and the isolation looked real. The
 * evidence that it was not: 79 of the 88 rows in the development `user` table
 * were `owner-<timestamp>@example.com` E2E fixtures, the newest written by the
 * very run that verified 08-10. CI is where it finally showed, because there
 * the dev DSN names an empty database and the first query failed with
 * `relation "user" does not exist`.
 *
 * This module is imported by `playwright.config.ts` at module scope, which is
 * evaluated before ANY task in that list — including the webServer plugin.
 * The DSN is then passed to the server explicitly rather than left to be
 * inherited, so no ordering assumption remains at all.
 */

/** Where the resolved state is handed to global-teardown.ts. */
export const E2E_STATE_FILE = path.join(tmpdir(), "mega-crm-e2e-database.json");

/** Stable, greppable marker so CI can assert which database the run touched. */
export const E2E_DSN_MARKER = "[e2e:database]";

/**
 * Set once provisioning has happened, so a config re-load does not provision
 * again. Playwright loads the config in the runner process AND in every worker
 * process it spawns; workers inherit this variable, so they reuse the database
 * the runner made instead of each creating one and orphaning it.
 */
const REUSE_ENV_VAR = "MEGA_CRM_E2E_DATABASE_URL";

/** Strip the password so the line is safe to print into a CI log. */
function redact(dsn: string): string {
  try {
    const url = new URL(dsn);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<unparseable dsn>";
  }
}

export async function provisionE2eDatabase(): Promise<string> {
  const alreadyProvisioned = process.env[REUSE_ENV_VAR];
  if (alreadyProvisioned) {
    // A worker process re-loading the config. Re-assign the two variables the
    // in-process code reads, but do not touch the database or the state file.
    process.env.TEST_DATABASE_URL = alreadyProvisioned;
    process.env.DATABASE_URL = alreadyProvisioned;
    return alreadyProvisioned;
  }

  const created = await createEphemeralDatabase({ workspace: "e2e" });

  // Guard the DSN that is about to be used, while process.env.DATABASE_URL
  // still holds whatever the caller had — the same ordering the vitest hook
  // uses, and the reason it is not vacuous.
  assertTestDatabaseUrl(created.dsn, process.env.DATABASE_URL);

  // The API server boots against this database, so the schema has to be there
  // before it starts. ensureTestDbMigrated reads TEST_DATABASE_URL.
  process.env.TEST_DATABASE_URL = created.dsn;
  await ensureTestDbMigrated();

  process.env.DATABASE_URL = created.dsn;
  process.env[REUSE_ENV_VAR] = created.dsn;

  writeFileSync(
    E2E_STATE_FILE,
    JSON.stringify({ databaseName: created.databaseName, adminDsn: created.adminDsn }),
  );

  // Printing this is the point, not decoration. SPEC's success criterion for
  // QG-04 is that CI can assert WHICH connection string the run used, and a
  // config value nobody reads back is not evidence.
  console.log(`${E2E_DSN_MARKER} ${redact(created.dsn)}`);

  return created.dsn;
}
