import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db as sharedDb, organization } from "@mega-crm/db";
import { ensureTestDbMigrated, getTestDatabaseUrl } from "../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";
import { pool } from "../../db.js";
import { upsertKey, getKey } from "../../modules/tenancy/sendgrid-key.repository.js";

/**
 * TENANT-05: cross-tenant isolation on `workspace_sendgrid_keys` must hold
 * even after a pooled connection is killed mid-transaction and reused by a
 * different tenant's request (Pitfall 1 / RESEARCH.md Pattern 2). This is
 * the single highest-leverage test in Phase 1 — it proves `SET LOCAL` +
 * `AsyncLocalStorage` (never a module-level variable, never plain `SET`)
 * actually holds under connection-pool reuse, not just in a clean request.
 */
describe("RLS pooled-connection isolation chaos test (TENANT-05)", () => {
  let workspaceAId: string;
  let workspaceBId: string;

  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();

    workspaceAId = randomUUID();
    workspaceBId = randomUUID();

    await sharedDb.insert(organization).values([
      {
        id: workspaceAId,
        name: "Workspace A",
        slug: `workspace-a-${workspaceAId.slice(0, 8)}`,
        createdAt: new Date(),
      },
      {
        id: workspaceBId,
        name: "Workspace B",
        slug: `workspace-b-${workspaceBId.slice(0, 8)}`,
        createdAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("throws when no tenant context is set for a tenant-scoped transaction", async () => {
    await expect(
      withTenantTransaction(async () => {
        return null;
      })
    ).rejects.toThrow(/No tenant context/);
  });

  it("never leaks workspace A's row into workspace B's context, including after a killed pooled connection", async () => {
    // 1. Write a probe row for workspace A under A's own tenant context.
    await withTenant(workspaceAId, async () => {
      await upsertKey({
        ciphertext: "cipher-a",
        encryptedDek: "dek-a",
        iv: "iv-a",
        authTag: "tag-a",
        keyMask: "SG.aaaa...aaaa",
        status: "active",
      });
    });

    // 2. Simulate a pooled connection being killed mid-transaction: acquire
    //    a client directly, set workspace A's GUC, then have Postgres
    //    itself terminate that backend before COMMIT/ROLLBACK ever runs.
    const doomed = await pool.connect();
    const {
      rows: [{ pid }],
    } = await doomed.query<{ pid: number }>("SELECT pg_backend_pid() as pid");
    await doomed.query("BEGIN");
    await doomed.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceAId]);

    const admin = await pool.connect();
    try {
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    } finally {
      admin.release();
    }

    // The doomed client's underlying socket is now dead — releasing it must
    // destroy it (never return a poisoned connection to the pool).
    try {
      doomed.release(true);
    } catch {
      // already terminated by Postgres — expected
    }

    // 3. A fresh tenant transaction for workspace B, on a pool that just
    //    recycled a forcibly-killed connection, must see ONLY B's rows —
    //    zero bleed-through of A's `app.current_workspace_id` GUC or A's data.
    await withTenant(workspaceBId, async () => {
      const existing = await getKey();
      expect(existing).toBeNull();

      await upsertKey({
        ciphertext: "cipher-b",
        encryptedDek: "dek-b",
        iv: "iv-b",
        authTag: "tag-b",
        keyMask: "SG.bbbb...bbbb",
        status: "active",
      });

      const rows = await withTenantTransaction(async (client) => {
        const result = await client.query<{ workspace_id: string }>(
          "SELECT workspace_id FROM workspace_sendgrid_keys"
        );
        return result.rows;
      });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.workspace_id === workspaceBId)).toBe(true);
    });

    // 4. Workspace A's context still only ever sees its own row too.
    await withTenant(workspaceAId, async () => {
      const key = await getKey();
      expect(key).not.toBeNull();
      expect(key?.status).toBe("active");
    });
  });
});
