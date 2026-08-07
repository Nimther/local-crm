import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";

import { getWorkspaceId, pool, withPreTenantLookup, withTenant, withTenantTransaction } from "../index.js";

/**
 * 08-16 (QG-03) — the tenant context and the RLS session variable.
 *
 * This package sets the session variable every RLS policy in the schema reads.
 * It has been exercised by apps/api's and apps/worker's suites since Phase 1,
 * and until now nothing asserted cross-tenant invisibility DIRECTLY — it was
 * only ever an implicit consequence of other tests happening to pass.
 *
 * The second describe block below pins Phase 10's fail-closed RLS contract
 * (SEC-03/SEC-04): every `workspace_isolation` policy raises on absent or
 * reverted-to-empty tenant context, never silently returns zero rows.
 */

const WORKSPACE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

async function seedOrganizations(): Promise<void> {
  // `organization` is not tenant-scoped, so this runs outside any tenant scope.
  for (const [id, slug] of [
    [WORKSPACE_A, "tenant-ctx-a"],
    [WORKSPACE_B, "tenant-ctx-b"],
  ]) {
    await pool.query(
      `INSERT INTO organization (id, name, slug) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, `Tenant ${slug}`, `${slug}-${Date.now().toString(36)}`],
    );
  }
}

describe("tenant context (RLS session variable)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    await seedOrganizations();
  });

  afterAll(async () => {
    await pool.end();
  });

  it("binds the workspace id into the session for the transaction's duration", async () => {
    const seen = await withTenant(WORKSPACE_A, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ v: string }>(
          "SELECT current_setting('app.current_workspace_id', true) AS v",
        );
        return rows[0].v;
      }),
    );
    expect(seen).toBe(WORKSPACE_A);
  });

  it("refuses to run at all with no tenant in scope", async () => {
    // Both entry points fail closed rather than defaulting to some workspace.
    expect(() => getWorkspaceId()).toThrow(/No tenant context/);
    // The callback is never reached — withTenantTransaction throws before it
    // acquires a client — so it deliberately has nothing to await.
    await expect(withTenantTransaction(() => Promise.resolve(undefined))).rejects.toThrow(
      /No tenant context/,
    );
  });

  it("does not leak one scope's workspace id into the next", async () => {
    const first = await withTenant(WORKSPACE_A, () => Promise.resolve(getWorkspaceId()));
    const second = await withTenant(WORKSPACE_B, () => Promise.resolve(getWorkspaceId()));
    expect(first).toBe(WORKSPACE_A);
    expect(second).toBe(WORKSPACE_B);

    // And the GUC itself: SET LOCAL scopes to the transaction, so a connection
    // returning to the pool cannot carry the previous tenant's id forward.
    const seenB = await withTenant(WORKSPACE_B, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query<{ v: string }>(
          "SELECT current_setting('app.current_workspace_id', true) AS v",
        );
        return rows[0].v;
      }),
    );
    expect(seenB).toBe(WORKSPACE_B);
  });

  it("hides one workspace's rows from another — the property every policy exists for", async () => {
    const email = `isolation-${Date.now().toString(36)}@fixture.test`;

    await withTenant(WORKSPACE_A, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO contacts (workspace_id, email, subscription_status)
           VALUES ($1, $2, 'subscribed')`,
          [WORKSPACE_A, email],
        ),
      ),
    );

    const visibleToA = await withTenant(WORKSPACE_A, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM contacts WHERE email = $1`, [email]);
        return rows.length;
      }),
    );
    const visibleToB = await withTenant(WORKSPACE_B, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM contacts WHERE email = $1`, [email]);
        return rows.length;
      }),
    );

    expect(visibleToA, "the owning workspace must see its own row").toBe(1);
    expect(visibleToB, "another workspace must not see it — this is the whole point of RLS").toBe(0);
  });

  it("rolls the transaction back when the callback throws", async () => {
    const email = `rollback-${Date.now().toString(36)}@fixture.test`;
    const boom = new Error("deliberate failure after the insert");

    await expect(
      withTenant(WORKSPACE_A, () =>
        withTenantTransaction(async (client) => {
          await client.query(
            `INSERT INTO contacts (workspace_id, email, subscription_status)
             VALUES ($1, $2, 'subscribed')`,
            [WORKSPACE_A, email],
          );
          throw boom;
        }),
      ),
    ).rejects.toBe(boom);

    const survived = await withTenant(WORKSPACE_A, () =>
      withTenantTransaction(async (client) => {
        const { rows } = await client.query(`SELECT id FROM contacts WHERE email = $1`, [email]);
        return rows.length;
      }),
    );
    expect(survived, "the insert must not have survived the throw").toBe(0);
  });

  it("withPreTenantLookup's sentinel grants nothing beyond letting the predicate evaluate -- zero contacts rows visible", async () => {
    // Seed a real contacts row under a real workspace first, so "zero rows
    // visible" is a meaningful claim, not vacuously true on an empty table.
    await withTenant(WORKSPACE_A, () =>
      withTenantTransaction((client) =>
        client.query(
          `INSERT INTO contacts (workspace_id, email, subscription_status) VALUES ($1, $2, 'subscribed')`,
          [WORKSPACE_A, `sentinel-fixture-${Date.now().toString(36)}@fixture.test`],
        ),
      ),
    );

    const visible = await withPreTenantLookup((client) =>
      client.query(`SELECT id FROM contacts`).then((res) => res.rows.length),
    );
    expect(
      visible,
      "the sentinel matches no real organization.id -- it must grant no rows, only make the predicate evaluable",
    ).toBe(0);
  });
});

/**
 * THE FAIL-CLOSED RLS CONTRACT (SEC-03/SEC-04) — pinned Phase 10 baseline.
 *
 * Every `workspace_isolation` policy in the schema now shares ONE predicate:
 * `current_setting('app.current_workspace_id')::uuid` — no `missing_ok`
 * second argument, no NULLIF guard. Absent tenant context is a programming
 * error, not "no such record": an error is the only signal application code
 * cannot mistake for a legitimately empty result set.
 *
 * This describe block replaces what used to be a "PRE-PHASE-10 BASELINE" at
 * this exact spot in the file, documenting the OPPOSITE (fail-open)
 * behaviour: before migration 0044, a connection that had never been
 * tenant-scoped returned ZERO ROWS (current_setting's `missing_ok` form
 * returns NULL, and `NULL::uuid = anything` is NULL — excluded, not an
 * error). Inverting that assertion — asserting the thrown error, never a row
 * count — is a first-class SEC-03/SEC-04 deliverable, not incidental
 * collateral (RESEARCH.md Pitfall 1: a row-count assertion of 0 passes under
 * BOTH the old and the new predicate and proves nothing).
 */
describe("the fail-closed RLS contract (SEC-03/SEC-04)", () => {
  let fresh: Pool;

  beforeAll(async () => {
    fresh = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });

    // `flows` (unlike `contacts`) has no rows seeded anywhere else in this
    // file — without at least one row, Postgres's executor has nothing to
    // filter and never invokes current_setting() at all, so the predicate
    // would never get a chance to throw. One committed row is enough to make
    // "the query throws" a meaningful assertion rather than vacuously true.
    //
    // Seeded through a THROWAWAY pool, never `fresh` and never the shared
    // `pool` export: the module-level `pool` is already closed by the
    // preceding describe block's own `afterAll`, and seeding through `fresh`
    // itself (max: 1, a single physical connection) would leave that one
    // connection "touched" -- its GUC reverted to '' rather than genuinely
    // unset -- which would break the never-scoped assertions below that
    // depend on `fresh` staying pristine.
    const seedPool = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
    try {
      const client = await seedPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [WORKSPACE_A]);
        await client.query(
          `INSERT INTO flows (workspace_id, name, created_by_user_id) VALUES ($1, $2, $3)`,
          [WORKSPACE_A, `fail-closed-contract-fixture-${Date.now().toString(36)}`, "test-user"],
        );
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    } finally {
      await seedPool.end();
    }
  });

  afterAll(async () => {
    await fresh.end();
  });

  it("rejects on a connection that has never been scoped (contacts)", async () => {
    // A DEDICATED, single-use pool -- never `fresh` (shared with the catalog
    // tests below, and reused by the recycled-connection tests via
    // `fresh.connect()`). With `max: 1`, sharing `fresh` across the
    // never-scoped and recycled-connection tests would hand the recycled
    // tests' already-touched physical connection back to a later
    // never-scoped test, turning "unrecognized configuration parameter"
    // (never touched) into "invalid input syntax for type uuid" (touched,
    // reverted to '') purely from test-ordering leakage, not from anything
    // this contract itself asserts.
    const neverScoped = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
    try {
      await expect(
        neverScoped.query(`SELECT id FROM contacts`),
        "an unset GUC must raise, not silently exclude every row",
      ).rejects.toThrow(/unrecognized configuration parameter/);
    } finally {
      await neverScoped.end();
    }
  });

  it("rejects on a connection recycled from a committed tenant-scoped transaction (contacts)", async () => {
    const recycled = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
    try {
      const client = await recycled.connect();
      try {
        // Reproduce what withTenantTransaction leaves behind.
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [WORKSPACE_A]);
        await client.query("COMMIT");

        // The GUC has now reverted to '' rather than being unset.
        await expect(
          client.query(`SELECT id FROM contacts`),
          "the fail-closed predicate evaluates ''::uuid here and errors",
        ).rejects.toThrow(/invalid input syntax for type uuid/);
      } finally {
        client.release();
      }
    } finally {
      await recycled.end();
    }
  });

  it("rejects on a connection that has never been scoped — a second, previously null-tolerating table (flows)", async () => {
    const neverScoped = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
    try {
      await expect(
        neverScoped.query(`SELECT id FROM flows`),
        "flows was NULLIF-guarded before this phase and silently returned zero rows here; the unification must be uniform, not contacts-specific",
      ).rejects.toThrow(/unrecognized configuration parameter/);
    } finally {
      await neverScoped.end();
    }
  });

  it("rejects on a connection recycled from a committed tenant-scoped transaction — flows", async () => {
    const recycled = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
    try {
      const client = await recycled.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [WORKSPACE_A]);
        await client.query("COMMIT");

        await expect(
          client.query(`SELECT id FROM flows`),
          "flows' old NULLIF guard converted this leftover '' into NULL (excluded, not an error) -- the fail-closed rewrite must remove that too",
        ).rejects.toThrow(/invalid input syntax for type uuid/);
      } finally {
        client.release();
      }
    } finally {
      await recycled.end();
    }
  });

  it("uses one identical predicate across exactly 22 workspace_isolation policies", async () => {
    const { rows } = await fresh.query<{ qual: string }>(
      `SELECT qual FROM pg_policies WHERE policyname = 'workspace_isolation'`,
    );
    expect(rows, "expected exactly 22 workspace_isolation policies in the catalog").toHaveLength(22);

    const distinctQuals = new Set(rows.map((r) => r.qual));
    expect(
      distinctQuals.size,
      `expected one shared predicate across all 22 policies, found ${distinctQuals.size} distinct forms: ${[...distinctQuals].join(" | ")}`,
    ).toBe(1);
  });

  it("never uses the null-tolerating NULLIF guard, asserted from the catalog (prohibition P2)", async () => {
    const { rows } = await fresh.query<{ tablename: string; qual: string; with_check: string }>(
      `SELECT tablename, qual, with_check FROM pg_policies WHERE policyname = 'workspace_isolation'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.qual, `${row.tablename}'s USING clause must not use NULLIF`).not.toMatch(/NULLIF/i);
      expect(row.with_check, `${row.tablename}'s WITH CHECK clause must not use NULLIF`).not.toMatch(/NULLIF/i);
    }
  });

  it("scopes every workspace_isolation policy to an explicit, non-PUBLIC role", async () => {
    // node-postgres does not register a default array parser for `name[]`
    // (pg_policies.roles' actual column type), so `roles` would otherwise
    // come back as the raw `'{public}'`-style text literal instead of a
    // parsed JS array. Computing the two booleans in SQL sidesteps that
    // entirely -- `= ANY(roles)` and `array_length` work directly against
    // the array value inside Postgres, no client-side array parsing needed.
    const { rows } = await fresh.query<{
      tablename: string;
      roleCount: number | null;
      appliesToPublic: boolean;
    }>(
      `SELECT tablename,
              array_length(roles, 1) AS "roleCount",
              ('public' = ANY(roles)) AS "appliesToPublic"
         FROM pg_policies WHERE policyname = 'workspace_isolation'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.roleCount, `${row.tablename}'s workspace_isolation policy has an empty roles array`).toBeGreaterThan(0);
      expect(
        row.appliesToPublic,
        `${row.tablename}'s workspace_isolation policy must not apply to PUBLIC`,
      ).toBe(false);
    }
  });

});
