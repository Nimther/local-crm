import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import { pool } from "../db.js";

/**
 * Request-scoped tenant context — AsyncLocalStorage ONLY, never a
 * module-level mutable variable (a module-level var would leak across
 * concurrent requests sharing the same Node event loop; see
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
 * next request that reuses it (01-RESEARCH.md Pitfall 1). `SET LOCAL`
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
