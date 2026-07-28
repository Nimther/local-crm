import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "@mega-crm/test-support";

import { getWorkspaceId, pool, withTenant, withTenantTransaction } from "../index.js";

/**
 * 08-16 (QG-03) — the tenant context and the RLS session variable.
 *
 * This package sets the session variable every RLS policy in the schema reads.
 * It has been exercised by apps/api's and apps/worker's suites since Phase 1,
 * and until now nothing asserted cross-tenant invisibility DIRECTLY — it was
 * only ever an implicit consequence of other tests happening to pass.
 *
 * Two of the assertions below are deliberate pre-change baselines and are
 * labelled as such: Phase 10 unifies the RLS policy variants, and the
 * no-tenant-in-scope behaviour is exactly what that change moves.
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
    await expect(withTenantTransaction(async () => undefined)).rejects.toThrow(/No tenant context/);
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
});

/**
 * PRE-PHASE-10 BASELINE — do not "fix" these by changing the expectation.
 *
 * `0001_rls_policies.sql` writes twelve policies as a bare cast
 * (`current_setting('app.current_workspace_id', true)::uuid`) and ten with a
 * NULLIF guard. SPECIFICATION.md §4.3 documents the consequence, and these two
 * assertions are where it becomes observable:
 *
 *   - on a connection that has NEVER been tenant-scoped, current_setting returns
 *     NULL, the predicate is NULL, and the table returns ZERO ROWS;
 *   - on a connection that HAS been scoped and returned to the pool, the custom
 *     GUC holds the EMPTY STRING, and a bare-cast policy evaluates `''::uuid`
 *     and THROWS.
 *
 * So the same query fails open-to-zero-rows or errors depending only on the
 * connection's history. Phase 10 unifies the variants and must do so in the
 * fail-closed direction; these assertions are what that change has to move
 * deliberately rather than discover.
 */
describe("no tenant in scope — the pre-Phase-10 RLS baseline", () => {
  let fresh: Pool;

  beforeAll(() => {
    fresh = new Pool({ connectionString: getTestDatabaseUrl(), max: 1 });
  });

  afterAll(async () => {
    await fresh.end();
  });

  it("returns zero rows on a connection that has never been scoped", async () => {
    const { rows } = await fresh.query(`SELECT id FROM contacts`);
    expect(rows.length, "an unset GUC reads as NULL, so the policy matches nothing").toBe(0);
  });

  it("throws on a connection recycled from a scoped transaction", async () => {
    const client = await fresh.connect();
    try {
      // Reproduce what withTenantTransaction leaves behind.
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [WORKSPACE_A]);
      await client.query("COMMIT");

      // The GUC has now reverted to '' rather than being unset.
      await expect(
        client.query(`SELECT id FROM contacts`),
        "a bare-cast policy evaluates ''::uuid here and errors",
      ).rejects.toThrow(/invalid input syntax for type uuid/);
    } finally {
      client.release();
    }
  });
});
