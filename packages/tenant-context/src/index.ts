import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import type { PoolClient } from "pg";

/**
 * The tenant-scoped pg Pool — shared by both apps/api and apps/worker, so
 * request-path and worker-path code run `SET LOCAL app.current_workspace_id`
 * through the exact same connection pool and transaction helper (no drift
 * between two independent implementations of the RLS mechanism — see
 * 02-PATTERNS.md / RESEARCH.md Structure Rationale). This is a SEPARATE
 * client from `@mega-crm/db`'s Drizzle client (used for better-auth's own
 * tables, which are not RLS-protected). Both point at the same physical
 * database via the same DATABASE_URL.
 */
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// CR-03: without this listener, an idle-connection termination (Postgres
// restart/failover/idle timeout) surfaces as an uncaught 'error' event and
// crashes the process (API or worker). Log it instead so the pool recovers
// on its own. Uses console.error (not a structured logger) to keep this
// shared package dependency-light — callers that want structured logging
// wrap/observe at their own layer.
pool.on("error", (err) => {
  // eslint-disable-next-line no-console
  console.error("idle pg pool client error (connection dropped)", err);
});

/**
 * Request/job-scoped tenant context — AsyncLocalStorage ONLY, never a
 * module-level mutable variable (a module-level var would leak across
 * concurrent requests/jobs sharing the same Node event loop; see
 * 01-RESEARCH.md Pitfall 1 / Anti-Patterns).
 */
const tenantContext = new AsyncLocalStorage<{ workspaceId: string }>();

/** Runs `fn` with `workspaceId` bound as the active tenant for its entire async scope. */
export function withTenant<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ workspaceId }, fn);
}

/** Returns the active tenant's workspace_id. Throws if no tenant context is set. */
export function getWorkspaceId(): string {
  const ctx = tenantContext.getStore();
  if (!ctx) {
    throw new Error("No tenant context set for this request");
  }
  return ctx.workspaceId;
}

/**
 * Runs `fn` inside a transaction that first sets the tenant GUC via
 * `SET LOCAL` (via `set_config(..., true)`) — NEVER a plain `SET`, which
 * would persist for the life of the pooled connection and leak into the
 * next request/job that reuses it (01-RESEARCH.md Pitfall 1). `SET LOCAL`
 * scopes to the transaction only and auto-resets on COMMIT/ROLLBACK, which
 * is what makes this safe under connection-pool reuse — proven by
 * apps/api/src/db/__tests__/rls-pooling-chaos.test.ts.
 *
 * Always releases the client in `finally` so a broken/aborted connection is
 * never silently kept alive in the pool.
 */
export async function withTenantTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const ctx = tenantContext.getStore();
  if (!ctx) {
    throw new Error("No tenant context set for this request");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [
      ctx.workspaceId,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be dead (e.g. terminated mid-transaction) —
      // releasing below with `destroy=true` handles that case.
    }
    throw err;
  } finally {
    client.release();
  }
}
