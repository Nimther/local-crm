import { describe, expect, it } from "vitest";

import { assertTestDatabaseUrl } from "../guard.js";

/**
 * 08-01 (QG-04) — the fail-closed test-database guard.
 *
 * These are the SPEC R4 acceptance rows written as executable assertions. The
 * guard is a pure function over two DSN strings: it never opens a connection,
 * so this suite needs no provisioned database.
 *
 * The guard deliberately has NO opt-out parameter and reads NO environment
 * variable (SPEC R4 negative criterion / D-14) — there is intentionally no
 * "skip" case to test here, because no such surface exists.
 */

const DEV_DSN = "postgres://u:p@localhost:5432/mega_crm";

describe("assertTestDatabaseUrl", () => {
  it("throws when TEST_DATABASE_URL is unset — never falls back to DATABASE_URL", () => {
    expect(() => assertTestDatabaseUrl(undefined, DEV_DSN)).toThrow(/unset or empty/i);
  });

  it("throws when TEST_DATABASE_URL is an empty string", () => {
    expect(() => assertTestDatabaseUrl("", DEV_DSN)).toThrow(/unset or empty/i);
  });

  it("throws when the test DSN is byte-identical to the dev DSN", () => {
    expect(() => assertTestDatabaseUrl(DEV_DSN, DEV_DSN)).toThrow();
  });

  it("throws when the test DSN differs only by loopback alias, credentials or query params", () => {
    // 127.0.0.1 collapses to the same normalized host as localhost; the missing
    // password and the ?sslmode=disable query string are both ignored, so this
    // resolves to the very same physical database as DEV_DSN.
    expect(() =>
      assertTestDatabaseUrl("postgres://u@127.0.0.1:5432/mega_crm?sslmode=disable", DEV_DSN),
    ).toThrow();
  });

  it("throws when the test database name lacks the mega_crm_test prefix", () => {
    expect(() => assertTestDatabaseUrl("postgres://u:p@localhost:5432/staging_db", DEV_DSN)).toThrow(
      /mega_crm_test/,
    );
  });

  it("returns without throwing for a correctly provisioned ephemeral database", () => {
    expect(() =>
      assertTestDatabaseUrl(
        "postgres://mega_crm_app:mega_crm_dev_pw@localhost:5432/mega_crm_test_worker",
        "postgres://mega_crm_app:mega_crm_dev_pw@localhost:5432/mega_crm",
      ),
    ).not.toThrow();
  });
});
