import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 08-REVIEW WR-01 — a failed `pg_advisory_unlock` must not leak the pg
 * client.
 *
 * `applyPendingMigrations`'s `finally` block used to run the unlock query and
 * `client.release()` back-to-back with no inner guard: if the unlock query
 * itself rejected (a live possibility when the connection was already dropped
 * by the server, e.g. under the redis-restart/sigkill failure-injection
 * scenarios that share a CI job with this fixture), the throw propagated out
 * of the outer `finally` before `client.release()` ran. The leaked
 * checked-out client then makes `pool.end()` — and therefore any `beforeAll`
 * awaiting `ensureTestDbMigrated()` — hang until `hookTimeout`, instead of
 * failing fast with the real error.
 *
 * This is exercised with a fully mocked `pg` module (no real Postgres
 * connection): the fake client's `query` rejects specifically for the
 * `pg_advisory_unlock` call and reports every migration as already applied
 * for everything else, so the only thing under test is release-on-error
 * ordering, not migration application itself.
 */

const ORIGINAL_ENV = { ...process.env };

describe("applyPendingMigrations releases the client when the advisory unlock rejects", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.TEST_DATABASE_URL = "postgres://u:p@localhost:5432/mega_crm_test_wr01";
    delete process.env.GSD_DEV_DATABASE_URL;
    delete process.env.DATABASE_URL;
    // This suite deliberately synthesises the environment a globalSetup-free
    // entrypoint would have. In an aggregated run the shared process.env copy of
    // GSD_TEST_PROJECT carries global-setup.ts's ambiguity marker (this project
    // registers no globalSetup of its own, so it inherits other projects'), and
    // db-fixture.ts fails closed on it. Clearing it keeps this test measuring
    // release-on-error ordering rather than that guard.
    delete process.env.GSD_TEST_PROJECT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.doUnmock("pg");
    vi.restoreAllMocks();
  });

  it("still releases the client back to the pool", async () => {
    const releaseMock = vi.fn();
    const queryMock = vi.fn((sql: unknown) => {
      const text = String(sql);
      if (text.includes("pg_advisory_unlock")) {
        return Promise.reject(new Error("connection terminated unexpectedly"));
      }
      if (text.includes("SELECT true as exists")) {
        // Pretend every migration is already recorded so the fixture never
        // needs to actually execute migration SQL against the fake client.
        return Promise.resolve({ rows: [{ exists: true }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const fakeClient = { query: queryMock, release: releaseMock };
    const connectMock = vi.fn(() => Promise.resolve(fakeClient));
    const endMock = vi.fn(() => Promise.resolve());

    vi.doMock("pg", () => ({
      Pool: vi.fn(function FakePool() {
        return { connect: connectMock, end: endMock };
      }),
    }));

    const { ensureTestDbMigrated } = await import("../db-fixture.js");

    await expect(ensureTestDbMigrated()).rejects.toThrow("connection terminated unexpectedly");
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });
});
