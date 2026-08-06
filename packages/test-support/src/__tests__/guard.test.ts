import { describe, expect, it } from "vitest";

import { assertTestDatabaseUrl } from "../guard.js";

/**
 * 08-01 / 08-02 (QG-04) — the fail-closed test-database guard.
 *
 * These are the SPEC R4 acceptance rows written as executable assertions. The
 * guard is a pure function over two DSN strings: it never opens a connection,
 * so this suite needs no provisioned database.
 *
 * Two independent conditions, evaluated in this order:
 *   1. the test database name must start with `mega_crm_test`;
 *   2. the normalized {host, port, database} triple must differ from the dev
 *      DSN's — loopback aliases collapsed, an absent port defaulted to 5432,
 *      credentials and query parameters ignored.
 *
 * Order matters: a DSN failing BOTH reports the prefix problem first, so the
 * rejection message names the condition a developer should fix first.
 *
 * The guard deliberately has NO opt-out parameter and reads NO environment
 * variable (SPEC R4 negative criterion / D-14) — there is intentionally no
 * "skip" case to test here, because no such surface exists.
 */

const DEV_DSN = "postgres://u:p@localhost:5432/mega_crm";

const rejecting: Array<{
  name: string;
  testUrl: string | undefined;
  devUrl: string | undefined;
  message: RegExp;
}> = [
    {
      name: "TEST_DATABASE_URL unset",
      testUrl: undefined,
      devUrl: DEV_DSN,
      message: /TEST_DATABASE_URL/,
    },
    {
      name: "TEST_DATABASE_URL empty string",
      testUrl: "",
      devUrl: DEV_DSN,
      message: /TEST_DATABASE_URL/,
    },
    {
      name: "byte-identical to DATABASE_URL",
      testUrl: DEV_DSN,
      devUrl: DEV_DSN,
      // fails the prefix condition first — `mega_crm` is not `mega_crm_test*`
      message: /mega_crm_test/,
    },
    {
      name: "IPv4 loopback alias, credentials and query params differing",
      testUrl: "postgres://u@127.0.0.1:5432/mega_crm?sslmode=disable",
      devUrl: DEV_DSN,
      message: /mega_crm_test/,
    },
    {
      name: "IPv6 loopback alias",
      testUrl: "postgres://u@[::1]:5432/mega_crm",
      devUrl: DEV_DSN,
      message: /mega_crm_test/,
    },
    {
      name: "database name lacking the mega_crm_test prefix",
      testUrl: "postgres://u:p@localhost:5432/megacrm_tests",
      devUrl: DEV_DSN,
      message: /mega_crm_test/,
    },
    {
      // The row that actually reaches the SECOND condition: the prefix passes,
      // so only default-port normalization can catch this. Without it the two
      // DSNs look different as strings while addressing the same database.
      name: "absent port normalizes to 5432, making the triple equal to dev",
      testUrl: "postgres://u:p@localhost/mega_crm_test_shared",
      devUrl: "postgres://u:p@localhost:5432/mega_crm_test_shared",
      message: /DATABASE_URL/,
    },
];

const accepting: Array<{ name: string; testUrl: string; devUrl: string }> = [
    {
      name: "correctly provisioned per-run ephemeral database",
      testUrl: "postgres://mega_crm_app:pw@localhost:5432/mega_crm_test_worker_abc123",
      devUrl: "postgres://mega_crm_app:pw@localhost:5432/mega_crm",
    },
    {
      // Same database NAME, different host — the triple differs, so this is a
      // genuinely different physical database and must be allowed.
      name: "same database name on a different host",
      testUrl: "postgres://u:p@db.example.com:5432/mega_crm_test_api_1",
      devUrl: "postgres://u:p@localhost:5432/mega_crm_test_api_1",
    },
];

describe("assertTestDatabaseUrl — rejects", () => {
  it.each(rejecting)("throws — $name", ({ testUrl, devUrl, message }) => {
    expect(() => assertTestDatabaseUrl(testUrl, devUrl)).toThrow(message);
  });
});

describe("assertTestDatabaseUrl — accepts", () => {
  it.each(accepting)("does not throw — $name", ({ testUrl, devUrl }) => {
    expect(() => assertTestDatabaseUrl(testUrl, devUrl)).not.toThrow();
  });
});

/**
 * Message-content contracts (SPEC R4 `<behavior>`): a CI log must identify the
 * misconfiguration without a debugger, so each rejection names the specific
 * condition that failed and the offending values.
 */
describe("assertTestDatabaseUrl — rejection messages name the failing condition", () => {
  it("the unset rejection names TEST_DATABASE_URL", () => {
    expect(() => assertTestDatabaseUrl(undefined, DEV_DSN)).toThrow(/TEST_DATABASE_URL/);
    expect(() => assertTestDatabaseUrl(undefined, DEV_DSN)).toThrow(/unset or empty/i);
  });

  it("the empty-string rejection names TEST_DATABASE_URL", () => {
    expect(() => assertTestDatabaseUrl("", DEV_DSN)).toThrow(/TEST_DATABASE_URL/);
  });

  it("the prefix rejection names mega_crm_test and quotes the offending database", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432/staging_db", DEV_DSN)).toThrow(
      /mega_crm_test/,
    );
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432/staging_db", DEV_DSN)).toThrow(
      /staging_db/,
    );
  });

  it("the equality rejection names DATABASE_URL", () => {
    expect(() =>
      assertTestDatabaseUrl(
        "postgres://u:p@localhost/mega_crm_test_shared",
        "postgres://u:p@localhost:5432/mega_crm_test_shared",
      ),
    ).toThrow(/DATABASE_URL/);
  });

  it("covers every SPEC R4 acceptance row", () => {
    expect(rejecting.length).toBeGreaterThanOrEqual(6);
    expect(accepting.length).toBeGreaterThanOrEqual(2);
    expect(rejecting.length + accepting.length).toBeGreaterThanOrEqual(9);
  });
});
