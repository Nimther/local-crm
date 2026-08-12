import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Phase 14 plan 03 (DB-14, D-11), Task 1 -- the single factory every
 * production Postgres pool in this monorepo must go through.
 *
 * `scrubbedConsole` is mocked (not asserted against real redaction logic,
 * already covered by `packages/redaction`'s own tests) -- mirrors
 * `packages/queue-core/src/__tests__/connection-error-listener.test.ts`'s own
 * proof shape for `createRedisConnection`: this suite proves only the
 * WIRING (exactly one listener, routed through scrubbedConsole, the
 * process survives), not redaction correctness.
 *
 * The error-listener behavior is testable without a live database: a
 * `pg.Pool` never actually opens a socket until `.connect()`/`.query()` is
 * called, so building one against an unreachable DSN and emitting an
 * `'error'` directly (same pattern as the ioredis precedent) proves the
 * wiring without any I/O.
 */

const { scrubbedConsole } = vi.hoisted(() => ({
  scrubbedConsole: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
}));

vi.mock("@mega-crm/redaction", () => ({ scrubbedConsole }));

const {
  createPgPool,
  assertDsnRequestsTls,
  poolSizeFor,
  PG_POOL_SIZES,
  PG_POOL_DEFAULT_MAX,
} = await import("../pool.js");

const UNREACHABLE_DSN = "postgres://u:p@127.0.0.1:65535/db";

describe("createPgPool -- error handler (DB-14)", () => {
  beforeEach(() => {
    scrubbedConsole.error.mockClear();
  });

  it("attaches exactly one 'error' listener to the returned pool", () => {
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: "test-consumer" });
    try {
      expect(pool.listenerCount("error")).toBe(1);
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it("routes an emitted 'error' through scrubbedConsole.error, naming the consumer, and does not throw", () => {
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: "test-consumer" });
    try {
      const err = new Error("Connection terminated unexpectedly (simulated)");
      expect(() => pool.emit("error", err)).not.toThrow();
      expect(scrubbedConsole.error).toHaveBeenCalledTimes(1);
      const [message, loggedErr] = scrubbedConsole.error.mock.calls[0];
      expect(message).toContain("test-consumer");
      expect(loggedErr).toBe(err);
    } finally {
      void pool.end().catch(() => undefined);
    }
  });
});

describe("createPgPool -- required connection string", () => {
  it("throws when the connection string is missing, naming the consumer", () => {
    // @ts-expect-error -- deliberately omitting the required field
    expect(() => createPgPool({ name: "test-consumer" })).toThrow(/test-consumer/);
  });

  it("throws when the connection string is empty", () => {
    expect(() => createPgPool({ connectionString: "", name: "test-consumer" })).toThrow(/test-consumer/);
  });
});

describe("assertDsnRequestsTls", () => {
  it("returns normally for sslmode=require", () => {
    expect(() => assertDsnRequestsTls("postgres://u:p@h/db?sslmode=require")).not.toThrow();
  });

  it("returns normally for sslmode=verify-ca", () => {
    expect(() => assertDsnRequestsTls("postgres://u:p@h/db?sslmode=verify-ca")).not.toThrow();
  });

  it("returns normally for sslmode=verify-full", () => {
    expect(() => assertDsnRequestsTls("postgres://u:p@h/db?sslmode=verify-full")).not.toThrow();
  });

  it("throws when sslmode is absent", () => {
    expect(() => assertDsnRequestsTls("postgres://u:p@h/db")).toThrow();
  });

  it("throws for sslmode=disable", () => {
    expect(() => assertDsnRequestsTls("postgres://u:p@h/db?sslmode=disable")).toThrow();
  });
});

describe("createPgPool -- production TLS enforcement (fail-closed)", () => {
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("throws in production when the DSN lacks sslmode", () => {
    process.env.NODE_ENV = "production";
    expect(() =>
      createPgPool({ connectionString: "postgres://u:p@h/db", name: "test-consumer" }),
    ).toThrow();
  });

  it("returns a pool in production when the DSN requests TLS", () => {
    process.env.NODE_ENV = "production";
    const pool = createPgPool({
      connectionString: "postgres://u:p@h/db?sslmode=require",
      name: "test-consumer",
    });
    try {
      expect(pool).toBeDefined();
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it("does not assert TLS outside production even without sslmode", () => {
    process.env.NODE_ENV = "test";
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: "test-consumer" });
    try {
      expect(pool).toBeDefined();
    } finally {
      void pool.end().catch(() => undefined);
    }
  });
});

describe("createPgPool -- explicit named sizes", () => {
  it("uses PG_POOL_SIZES's max for a named consumer present in the table", () => {
    const [firstName, firstMax] = Object.entries(PG_POOL_SIZES)[0];
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: firstName });
    try {
      expect(pool.options.max).toBe(firstMax);
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it("falls back to PG_POOL_DEFAULT_MAX for a name absent from PG_POOL_SIZES", () => {
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: "not-in-the-table" });
    try {
      expect(pool.options.max).toBe(PG_POOL_DEFAULT_MAX);
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it("honors an explicit max override regardless of the named default", () => {
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: "not-in-the-table", max: 37 });
    try {
      expect(pool.options.max).toBe(37);
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it("poolSizeFor mirrors createPgPool's own resolution (pure)", () => {
    const [firstName, firstMax] = Object.entries(PG_POOL_SIZES)[0];
    expect(poolSizeFor(firstName)).toBe(firstMax);
    expect(poolSizeFor("not-in-the-table")).toBe(PG_POOL_DEFAULT_MAX);
    expect(poolSizeFor("not-in-the-table", 9)).toBe(9);
  });
});

describe("createPgPool -- no ssl config object attached", () => {
  it("does not attach an 'ssl' property to the pool's own options", () => {
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: "test-consumer" });
    try {
      expect(pool.options.ssl).toBeUndefined();
    } finally {
      void pool.end().catch(() => undefined);
    }
  });
});
