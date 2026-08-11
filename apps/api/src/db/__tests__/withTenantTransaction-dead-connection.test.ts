import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ensureTestDbMigrated, getTestDatabaseUrl, createTestPool } from "../../test/db-fixture.js";
import { withTenant, withTenantTransaction } from "../../middleware/tenant-context.js";
import { pool } from "@mega-crm/tenant-context";

/**
 * WR-09 gap closure (UAT Test 11 follow-up): the sibling
 * `rls-pooling-chaos.test.ts` kills a connection it checks out and releases
 * MANUALLY (`doomed.release(true)`), so it never exercises
 * `withTenantTransaction`'s OWN catch -> ROLLBACK -> release(err) branch.
 * This test lets `withTenantTransaction` own the client that gets killed,
 * forcing that exact destroy-on-error path (packages/tenant-context/src/index.ts
 * lines 80-94) to run, and proves the pool self-heals afterward.
 */
describe("withTenantTransaction dead-connection destroy path (WR-09)", () => {
  beforeAll(async () => {
    await ensureTestDbMigrated();
    process.env.DATABASE_URL = getTestDatabaseUrl();

    // Expected: this test intentionally terminates a pooled connection.
    pool.on("error", () => {
      // no-op -- CR-03 handler already logs; this is a defensive extra
      // listener matching the sibling chaos test's pattern.
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("a connection killed mid-transaction is destroyed on release and the pool recovers (WR-09)", async () => {
    const admin = createTestPool();
    try {
      let doomedPid: number | undefined;

      await expect(
        withTenant(randomUUID(), () =>
          withTenantTransaction(async (client) => {
            // node-postgres emits 'error' on the client itself when
            // Postgres closes the socket out from under it — expected here
            // since we're about to pg_terminate_backend it on purpose.
            // Without a listener this is an unhandled 'error' event and
            // crashes the process (same pattern as rls-pooling-chaos.test.ts).
            client.on("error", () => {
              // expected: this connection is being intentionally killed below
            });

            const {
              rows: [{ pid }],
            } = await client.query<{ pid: number }>("SELECT pg_backend_pid() as pid");
            doomedPid = pid;

            // Kill this exact backend from a separate admin pool.
            await admin.query("SELECT pg_terminate_backend($1)", [pid]);

            // Wait for the server-initiated termination to land as a
            // socket event on this client (asynchronous relative to
            // pg_terminate_backend returning).
            await new Promise((resolve) => {
              setTimeout(resolve, 100);
            });

            // Force the failure: the client's socket is now dead, so this
            // query rejects. The error propagates out of fn, and
            // withTenantTransaction's catch then runs ROLLBACK (which also
            // throws on the dead socket) -> releaseWithError is set ->
            // finally destroys the client via client.release(err).
            await client.query("SELECT 1");
          })
        )
      ).rejects.toThrow();

      expect(doomedPid).toBeDefined();

      // Prove the backend was genuinely destroyed (not just marked).
      const { rows } = await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [
        doomedPid,
      ]);
      expect(rows).toHaveLength(0);

      // Prove the pool recovers AND never re-serves the destroyed
      // connection: run several sequential recovery transactions and
      // assert none of them receive the destroyed backend's pid.
      const pids: number[] = [];
      for (let i = 0; i < 6; i++) {
        const pid = await withTenant(randomUUID(), () =>
          withTenantTransaction(async (client) => {
            const {
              rows: [{ pid: recoveredPid }],
            } = await client.query<{ pid: number }>("SELECT pg_backend_pid() as pid");
            return recoveredPid;
          })
        );
        expect(typeof pid).toBe("number");
        pids.push(pid);
      }

      expect(pids).not.toContain(doomedPid);
    } finally {
      await admin.end();
    }
  });
});
