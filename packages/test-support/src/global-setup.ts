import path from "node:path";

import { assertTestDatabaseUrl } from "./guard.js";
import {
  AUTH_ROLE,
  buildTestRoleDsn,
  createEphemeralDatabase,
  dropEphemeralDatabase,
  SCAN_ROLE,
} from "./provision-db.js";
import { prepareTestRedisOnce } from "./redis-guard.js";

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
 *      happened to be in the environment beforehand — against the TRUE dev DSN;
 *   3. only then publish the DSN into the environment.
 *
 * Reversing 2 and 3 would compare the new DSN against itself and pass
 * vacuously.
 *
 * Teardown is RETURNED rather than run from a `posttest` script: a returned
 * teardown still runs when the suite fails, whereas an npm `posttest` does not
 * run on a non-zero exit and Playwright does not use npm scripts at all (D-09).
 *
 * ── Phase 10 debug (aggregate-coverage-run-fails): WHY THE DSN IS PUBLISHED TWICE
 *
 * This hook is registered by FIVE projects (apps/api, apps/worker, packages/db,
 * packages/delivery-core, packages/tenant-context). `npm run test` runs each
 * workspace in its own vitest process, so for years only one of them existed at
 * a time. The aggregated `npm run coverage` run does not: vitest executes every
 * project's globalSetup sequentially in ONE parent process, and only then forks
 * the test workers (`Vitest.initializeGlobalSetup`).
 *
 * `process.env` is a single, process-wide object, so publishing a PER-PROJECT
 * value into it is last-writer-wins. Five databases were provisioned and every
 * project's workers received the fifth one's DSN — silently collapsing the
 * five tenants-in-separate-databases into one shared database, which is exactly
 * the isolation db-fixture-isolation.test.ts exists to guarantee. apps/worker's
 * `runFlowSegmentSweepTick()` is deliberately cross-tenant, so it then found and
 * compiled packages/tenant-context's segment fixtures and crashed.
 *
 * The fix is to publish through vitest's PER-PROJECT channel, `project.config
 * .env`, which vitest merges OVER the inherited `process.env` when it spawns
 * that project's workers. `process.env` is still written because it is the only
 * channel the Playwright entrypoint (which passes no vitest project) has, and
 * because it is what this hook's own later statements and single-project runs
 * rely on. Where the two disagree, `config.env` wins — per project, correctly.
 */

/**
 * What `GSD_TEST_PROJECT` is set to in the SHARED `process.env` once a second
 * project has provisioned its own database.
 *
 * At that point the shared copy cannot identify anyone, so it says so instead
 * of naming whichever project happened to run last. `db-fixture.ts` refuses to
 * hand out a DSN when it reads this marker: seeing it means the per-project
 * `config.env` channel did NOT reach this worker, and every DSN in scope
 * therefore belongs to some other project. Turning a silent cross-project data
 * bleed into a loud, self-describing failure is the whole point — the previous
 * failure mode was only noticed because one project's fixture happened to be
 * shaped in a way that crashed another project's code.
 */
export const AMBIGUOUS_PROJECT_MARKER = "<ambiguous:multiple-vitest-projects>";

/**
 * The shape this hook needs from a vitest `TestProject`. Declared structurally
 * rather than imported from `vitest/node` because the same function is also
 * called by the Playwright entrypoint, which passes neither field.
 */
interface GlobalSetupProject {
  name?: string;
  config?: { env?: Record<string, string> };
}

export default async function setup(project?: GlobalSetupProject): Promise<() => Promise<void>> {
  const workspace = project?.name?.trim() || path.basename(process.cwd());

  // WINDOWS id 14: BullMQ queues live outside the per-project ephemeral
  // Postgres boundary. Clear the dedicated test Redis DB once per Vitest
  // parent process before any project starts, but only after the fail-closed
  // guard proves the URL names an explicit logical DB >= 1. Never read the
  // ordinary REDIS_URL here: on a developer machine it is the live DB-0 URL.
  const testRedisUrl =
    project?.config?.env?.REDIS_URL ??
    process.env.TEST_REDIS_URL ??
    "redis://localhost:6379/1";
  await prepareTestRedisOnce(testRedisUrl);

  const { databaseName, dsn, adminDsn } = await createEphemeralDatabase({ workspace });

  // The TRUE dev DSN, which is what the guard has to compare against.
  //
  // `GSD_DEV_DATABASE_URL` is preferred over `DATABASE_URL` because by the
  // second project's invocation `DATABASE_URL` has already been replaced by the
  // FIRST project's ephemeral DSN. Reading it there would compare one ephemeral
  // database against another — two names that can never collide — so the guard
  // would pass vacuously for projects 2..N and the fail-closed protection this
  // whole module exists to provide would silently switch itself off.
  const devDsn = process.env.GSD_DEV_DATABASE_URL ?? process.env.DATABASE_URL;

  // Guard the DSN we are about to hand to the suite, against the dev DSN.
  assertTestDatabaseUrl(dsn, devDsn);

  // Everything a forked test worker needs in order to reach ONLY this project's
  // own database. Assembled first, published to both channels below, so the two
  // can never drift.
  const published: Record<string, string> = {
    TEST_DATABASE_URL: dsn,
    // DATABASE_URL must also be set because packages/tenant-context reads it
    // directly (SPECIFICATION.md §3.2) — leaving it pointed at dev would send
    // tenant-scoped pools to the dev database.
    DATABASE_URL: dsn,
    // Phase 10 (SEC-01/D-02) and (SEC-05/D-04): the scan- and auth-role DSNs for
    // the SAME ephemeral database. Derived from `dsn` directly rather than read
    // back out of `process.env`, so they cannot pick up another project's
    // database, and so this hook does not depend on the order of its own
    // assignments. `dsn` was validated by the guard two statements above.
    SCAN_DATABASE_URL: buildTestRoleDsn(dsn, SCAN_ROLE),
    AUTH_DATABASE_URL: buildTestRoleDsn(dsn, AUTH_ROLE),
    // Which project this database was provisioned FOR. Only meaningful in the
    // per-project channel; see AMBIGUOUS_PROJECT_MARKER for the shared copy.
    GSD_TEST_PROJECT: workspace,
  };

  // 08-06: db-fixture.ts runs the guard again inside the test process (D-14
  // layer b, so an entrypoint that bypassed this hook still cannot reach dev).
  // That second check needs something real to compare against — and by then
  // DATABASE_URL has been replaced by the ephemeral DSN, so comparing against
  // it would compare the DSN to itself and throw on every run.
  if (devDsn) published.GSD_DEV_DATABASE_URL = devDsn;

  // (a) The PER-PROJECT channel. vitest merges this over the inherited
  //     process.env when spawning this project's workers, so it is the only
  //     channel that stays correct once more than one project is in the run.
  if (project?.config) {
    project.config.env ??= {};
    Object.assign(project.config.env, published);
  }

  // (b) The SHARED channel, for the Playwright entrypoint (no vitest project)
  //     and for single-project runs. Every value except the project marker is
  //     safe to overwrite: they are only ever read by a worker that did not
  //     receive (a), and such a worker is already in trouble.
  const previousProject = process.env.GSD_TEST_PROJECT;
  Object.assign(process.env, published);
  if (previousProject && previousProject !== workspace) {
    process.env.GSD_TEST_PROJECT = AMBIGUOUS_PROJECT_MARKER;
  }

  return async function teardown(): Promise<void> {
    await dropEphemeralDatabase(databaseName, adminDsn);
  };
}
