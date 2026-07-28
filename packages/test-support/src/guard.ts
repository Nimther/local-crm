import { URL } from "node:url";

/**
 * 08-01 (QG-04) — fail-closed test-database guard.
 *
 * Two independent conditions, evaluated in this order:
 *   1. the test database name must start with `mega_crm_test`;
 *   2. the test DSN must not resolve to the same normalized host+port+database
 *      as the dev DSN.
 *
 * Normalization collapses loopback aliases and ignores credentials and query
 * parameters, so `postgres://u@127.0.0.1:5432/mega_crm?sslmode=disable` and
 * `postgres://u:p@localhost:5432/mega_crm` are recognized as the same physical
 * database rather than as two different strings.
 *
 * D-14 / SPEC R4 negative criterion: this module takes no opt-out parameter and
 * reads no environment variable. There is deliberately no way for a caller to
 * turn the check off — not even for local convenience. Adding one would reopen
 * exactly the boundary this file exists to close.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeDsn(raw: string): { host: string; port: string; database: string } {
  const url = new URL(raw);
  const host = LOOPBACK_HOSTS.has(url.hostname) ? "loopback" : url.hostname.toLowerCase();
  const port = url.port || "5432";
  const database = url.pathname.replace(/^\//, "");
  return { host, port, database };
}

export function assertTestDatabaseUrl(
  testUrl: string | undefined,
  devUrl: string | undefined,
): void {
  if (!testUrl || testUrl.length === 0) {
    throw new Error(
      "FATAL: TEST_DATABASE_URL is unset or empty. Tests must never fall back to DATABASE_URL.",
    );
  }

  const testDsn = normalizeDsn(testUrl);

  if (!testDsn.database.startsWith("mega_crm_test")) {
    throw new Error(
      `FATAL: test database name "${testDsn.database}" does not start with the required "mega_crm_test" prefix.`,
    );
  }

  if (devUrl) {
    const devDsn = normalizeDsn(devUrl);
    if (
      testDsn.host === devDsn.host &&
      testDsn.port === devDsn.port &&
      testDsn.database === devDsn.database
    ) {
      throw new Error(
        `FATAL: TEST_DATABASE_URL resolves to the same host+port+database as DATABASE_URL ` +
          `(${devDsn.host}:${devDsn.port}/${devDsn.database}).`,
      );
    }
  }
}
