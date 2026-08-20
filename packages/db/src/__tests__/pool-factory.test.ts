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
  assertDsnOmitsOptionsParam,
  poolSizeFor,
  PG_POOL_SIZES,
  PG_POOL_DEFAULT_MAX,
} = await import("../pool.js");

// pg's own resolver, not this module's -- proves the pin survives the real
// merge `new Pool({...})` performs internally (WR-01 follow-up), not just
// the pre-merge config object this factory hands to `new Pool()`. No
// `@types/pg` declarations exist for this internal module (only the public
// `pg` entry point is typed), so this import is deliberately untyped.
// @ts-expect-error -- pg's internal connection-parameters module has no type declarations
const { default: ConnectionParameters } = await import("pg/lib/connection-parameters.js");

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

/**
 * Phase 17 plan 01 (WR-06, D-01), Task 2 -- a Docker-less, config-level
 * guard for the TimeZone pin.
 *
 * This block is deliberately NOT the primary proof of WR-06's fix. D-02
 * rejected a config/`SHOW timezone`-only assertion as insufficient on its
 * own -- `pg-timezone.test.ts`'s behavioral test (a real non-UTC database,
 * a real naive-timestamp write, a real stored-value comparison) is the real
 * bar. This block exists for a different reason: `pg-timezone.test.ts`
 * needs a reachable Postgres cluster, and this repository's own sandbox has
 * repeatedly lacked one (see `pg-tls.test.ts`'s environment-gate comment for
 * the precedent). A pure-JS guard means a future refactor that drops the pin
 * fails a test that runs everywhere, not only where a database happens to
 * be available. Neither test file supersedes the other -- see
 * `pg-timezone.test.ts` for the behavioral counterpart.
 *
 * Constructs, asserts, and `end()`s in the same style as the neighbouring
 * no-ssl-config block: no `connect()` / `query()` call, no I/O at all.
 */
describe("createPgPool -- TimeZone startup parameter (WR-06)", () => {
  it("carries the exact '-c TimeZone=UTC' startup-parameter string on the pool's own resolved options", () => {
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: "guard" });
    try {
      expect(pool.options.options).toBe("-c TimeZone=UTC");
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it("still has no 'ssl' property attached -- the pin did not smuggle in a second TLS mechanism", () => {
    const pool = createPgPool({ connectionString: UNREACHABLE_DSN, name: "guard" });
    try {
      expect(pool.options.ssl).toBeUndefined();
    } finally {
      void pool.end().catch(() => undefined);
    }
  });

  it("survives pg's own DSN-merge: the RESOLVED ConnectionParameters (not pool.options) still carries the pin", () => {
    // Mirrors exactly what a real connection negotiates, unlike the
    // pre-merge `pool.options.options` assertion above -- proves the pin
    // is not silently defeated by pg's `Object.assign({}, config,
    // parse(connectionString))` merge (WR-01 follow-up).
    const resolved = new ConnectionParameters({
      connectionString: UNREACHABLE_DSN,
      options: "-c TimeZone=UTC",
    });
    expect(resolved.options).toBe("-c TimeZone=UTC");
  });
});

describe("assertDsnOmitsOptionsParam (WR-01 follow-up)", () => {
  it("returns normally when the DSN has no 'options' query parameter", () => {
    expect(() => assertDsnOmitsOptionsParam(UNREACHABLE_DSN)).not.toThrow();
  });

  it("throws when the DSN carries its own 'options' query parameter", () => {
    expect(() =>
      assertDsnOmitsOptionsParam("postgres://u:p@h/db?options=-c%20search_path%3Dfoo"),
    ).toThrow(/options/);
  });
});

describe("createPgPool -- rejects a DSN-level 'options' override of the TimeZone pin (WR-01 follow-up)", () => {
  it("throws instead of silently letting the DSN's own 'options' win", () => {
    expect(() =>
      createPgPool({
        connectionString: "postgres://u:p@h/db?options=-c%20search_path%3Dfoo",
        name: "test-consumer",
      }),
    ).toThrow(/options/);
  });

  it("proves the hazard this guard closes: without the guard, the DSN's 'options' would silently win", () => {
    // Same repro as the REVIEW.md finding -- run against pg's own resolver
    // directly (bypassing this factory's guard) to document exactly what
    // the guard above prevents.
    const resolved = new ConnectionParameters({
      connectionString: "postgres://u:p@h/db?options=-c%20search_path%3Dfoo",
      options: "-c TimeZone=UTC",
    });
    expect(resolved.options).toBe("-c search_path=foo");
  });
});
