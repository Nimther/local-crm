import { assertTestDatabaseUrl } from "./guard.js";

/**
 * 08-01 (QG-04) — vitest `globalSetup` entrypoint.
 *
 * This is the single point at which the guard runs. vitest invokes globalSetup
 * before it collects any test file, so a thrown error here aborts the run
 * before a single test executes — which is the whole point: a misconfigured
 * DSN must never get far enough to open a connection.
 *
 * The error is deliberately allowed to propagate rather than being caught and
 * turned into a warning or a graceful default (SPEC R4 / Pitfall 21: the guard
 * must be a hard failure).
 *
 * This tracer version performs no database creation — per-run ephemeral
 * provisioning arrives in 08-02.
 */
export default async function setup(): Promise<void> {
  assertTestDatabaseUrl(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
}
