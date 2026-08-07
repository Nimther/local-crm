import path from "node:path";

import { getScanTestDatabaseUrl } from "./db-fixture.js";
import { assertTestDatabaseUrl } from "./guard.js";
import { createEphemeralDatabase, dropEphemeralDatabase } from "./provision-db.js";

/**
 * 08-01 / 08-02 (QG-04) — vitest `globalSetup`: provision, guard, tear down.
 *
 * This is the single point vitest and Playwright share (D-09). It runs before
 * vitest collects any test file, so a DSN that would touch the dev database
 * aborts the run before a single connection is opened.
 *
 * Ordering inside this function is deliberate:
 *   1. provision the ephemeral database;
 *   2. run the guard on the DSN that will ACTUALLY be used — not on whatever
 *      happened to be in the environment beforehand — while process.env
 *      .DATABASE_URL still holds the real dev DSN to compare against;
 *   3. only then publish the DSN into the environment.
 *
 * Reversing 2 and 3 would compare the new DSN against itself and pass
 * vacuously.
 *
 * Teardown is RETURNED rather than run from a `posttest` script: a returned
 * teardown still runs when the suite fails, whereas an npm `posttest` does not
 * run on a non-zero exit and Playwright does not use npm scripts at all (D-09).
 */
export default async function setup(project?: { name?: string }): Promise<() => Promise<void>> {
  const workspace = project?.name?.trim() || path.basename(process.cwd());

  const { databaseName, dsn, adminDsn } = await createEphemeralDatabase({ workspace });

  // Guard the DSN we are about to hand to the suite, against the still-intact
  // dev DSN.
  assertTestDatabaseUrl(dsn, process.env.DATABASE_URL);

  // Preserve the TRUE dev DSN before it is overwritten below.
  //
  // 08-06: db-fixture.ts runs the guard again inside the test process (D-14
  // layer b, so an entrypoint that bypassed this hook still cannot reach dev).
  // That second check needs something real to compare against — and by then
  // DATABASE_URL has been replaced by the ephemeral DSN, so comparing against
  // it would compare the DSN to itself and throw on every run.
  if (process.env.DATABASE_URL) {
    process.env.GSD_DEV_DATABASE_URL = process.env.DATABASE_URL;
  }

  // Publish to BOTH names. vitest forks its test workers after globalSetup
  // returns and hands them the parent's process.env, so mutations here reach
  // the test processes. DATABASE_URL must also be set because
  // packages/tenant-context reads it directly (SPECIFICATION.md §3.2) — leaving
  // it pointed at dev would send tenant-scoped pools to the dev database.
  process.env.TEST_DATABASE_URL = dsn;
  process.env.DATABASE_URL = dsn;

  // Phase 10 (SEC-01/D-02): publish the scan-role DSN for the SAME ephemeral
  // database. vitest forks its test workers AFTER globalSetup returns and
  // hands them the parent's process.env, so every workspace's tests inherit
  // this without constructing their own DSN. Deliberately no auth DSN here --
  // plan 10-09 adds that once the auth role first has grants.
  process.env.SCAN_DATABASE_URL = getScanTestDatabaseUrl();

  return async function teardown(): Promise<void> {
    await dropEphemeralDatabase(databaseName, adminDsn);
  };
}
