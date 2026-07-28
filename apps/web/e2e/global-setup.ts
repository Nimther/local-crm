import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertTestDatabaseUrl,
  createEphemeralDatabase,
  ensureTestDbMigrated,
} from "@mega-crm/test-support";

/**
 * 08-10 (QG-04) — the Playwright E2E lane provisions its own database.
 *
 * Until this existed, all five specs ran against the developer's dev database
 * and wrote to it: playwright.config.ts booted `npm run dev -w apps/api`, whose
 * `--env-file=../../.env` points at exactly that database, with
 * `reuseExistingServer: true` on top so an already-running dev stack was
 * silently attached to even when everything else was configured correctly.
 *
 * Every piece of logic here is a CALL into @mega-crm/test-support — the same
 * functions apps/api and apps/worker's vitest globalSetup calls. There is
 * deliberately no naming rule, no DSN comparison and no provisioning logic
 * written in this file: a second implementation is the CI-only-branch pattern
 * SPEC R4 forbids, just spelled differently.
 */

/** Where the resolved state is handed to global-teardown.ts. */
export const E2E_STATE_FILE = path.join(tmpdir(), "mega-crm-e2e-database.json");

/** Stable, greppable marker so CI can assert which database the run touched. */
export const E2E_DSN_MARKER = "[e2e:database]";

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

export default async function globalSetup(): Promise<void> {
  const created = await createEphemeralDatabase({ workspace: "e2e" });

  // Guard the DSN that is about to be used, while process.env.DATABASE_URL
  // still holds whatever the caller had — the same ordering the vitest hook
  // uses, and the reason it is not vacuous.
  assertTestDatabaseUrl(created.dsn, process.env.DATABASE_URL);

  // The API server boots against this database, so the schema has to be there
  // before it starts. ensureTestDbMigrated reads TEST_DATABASE_URL.
  process.env.TEST_DATABASE_URL = created.dsn;
  await ensureTestDbMigrated();

  // webServer commands inherit this process's environment, and Playwright
  // starts them after globalSetup returns — so assigning here is what actually
  // routes the API at the ephemeral database. The `dev:e2e` scripts carry no
  // --env-file, so this is their only source of a DSN: if this hook did not
  // run, the API would fail to boot rather than quietly reach dev.
  process.env.DATABASE_URL = created.dsn;

  writeFileSync(
    E2E_STATE_FILE,
    JSON.stringify({ databaseName: created.databaseName, adminDsn: created.adminDsn }),
  );

  // Printing this is the point, not decoration. SPEC's success criterion for
  // QG-04 is that CI can assert WHICH connection string the run used, and a
  // config value nobody reads back is not evidence.
  console.log(`${E2E_DSN_MARKER} ${redact(created.dsn)}`);
}
