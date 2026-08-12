import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
// Phase 14 plan 03 (DB-14, D-11): deep-imports @mega-crm/db's factory module
// directly (NOT the package root "@mega-crm/db"), because the root's
// src/index.ts throws at import time when DATABASE_URL is unset and
// eagerly constructs its own "db"/"auth" pools -- importing the root here
// would inject both of those side effects into every consumer of this
// already dependency-light package. `packages/db/package.json`'s own
// `"./src/*.js": "./src/*.ts"` exports-map entry is what makes this deep
// import resolve. Mirrors apps/worker's own
// `@mega-crm/db/src/partitions/...` deep-import precedent.
import { createPgPool } from "@mega-crm/db/src/pool.js";

// Phase 10 (SEC-01/SEC-02, D-02): the cross-workspace scan helper lives in
// its own module (scan.ts) but is re-exported here so `withTenantTransaction`
// and `withCrossWorkspaceScan` share one public entry point, same as every
// other consumer of this package.
export { closeScanPool, withCrossWorkspaceScan } from "./scan.js";

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
// Phase 14 plan 03 (DB-14, D-11) SUPERSEDES the 10-13 (SEC-13) decision
// recorded here previously: this pool is now built through
// `@mega-crm/db`'s `createPgPool` factory, which routes its error listener
// through `@mega-crm/redaction`'s `scrubbedConsole` unconditionally (every
// factory-built pool does, with no opt-out) rather than the bare
// `console.error` this package's own "stay dependency-light" argument used
// to justify. DB-14's CI-enforced invariant (no bare `pg.Pool` outside the
// factory) takes priority over that argument now -- the dependency-light
// property this package still keeps is "no NEW runtime dependency for its
// OWN sake", not "never depend on `@mega-crm/db`", and `@mega-crm/db`
// already sits below this package in the dependency graph (no cycle: see
// `packages/db/src/pool.ts`'s own header, which documents this package by
// name and does not import it back).
export const pool = createPgPool({ connectionString: process.env.DATABASE_URL ?? "", name: "tenant-context" });

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
  let releaseWithError: Error | undefined;
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
    } catch (rollbackErr) {
      // The ROLLBACK itself failed -- the connection is dead (e.g.
      // terminated mid-transaction). Passing the error to `client.release()`
      // below tells node-postgres to DESTROY this client instead of
      // returning it to the pool, so the next checkout never inherits a
      // broken connection (WR-09).
      releaseWithError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(releaseWithError);
  }
}

/**
 * Phase 10 plan 10-07 (SEC-03/SEC-04, migration 0044): the all-zeros UUID.
 * `gen_random_uuid()` cannot produce this value (it is not a valid v4 UUID),
 * so it matches no real `organization.id` and therefore no real workspace's
 * rows in any `workspace_isolation`-protected table.
 */
export const PRE_TENANT_LOOKUP_SENTINEL_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Runs `fn` inside a transaction whose `app.current_workspace_id` is set to
 * the sentinel above -- for the two callers (API-key auth, webhook receipt)
 * that must query a tenant table BEFORE any real workspace is known.
 *
 * Migration 0044 made every `workspace_isolation` policy fail-closed: a
 * connection that has never set `app.current_workspace_id` at all now
 * THROWS (`unrecognized configuration parameter`) rather than silently
 * returning zero rows. `lookupApiKeyById` and `findWebhookEndpointByToken`
 * used to rely on exactly that old fail-open behaviour to survive querying
 * a tenant table with no workspace in scope; under the fail-closed
 * predicate they would now throw on every call, not just unknown ids.
 * `withPreTenantLookup` restores an evaluable (non-throwing) predicate
 * without depending on the fail-open gap that no longer exists.
 *
 * What this grants: NOTHING by itself. Setting the tenant GUC to a value
 * that matches no real workspace makes `workspace_isolation`'s predicate
 * evaluate to `false` instead of raising -- the query returns zero rows for
 * every ordinary tenant-scoped read run inside this helper. Every row a
 * caller of this helper actually SEES is granted by a SECOND, narrowly-keyed
 * permissive policy specific to that table (`api_key_runtime_lookup` on
 * `workspace_api_keys`, `webhook_endpoint_runtime_lookup` on
 * `workspace_webhook_endpoints`) -- Postgres combines all permissive
 * policies for a role with OR, so that second policy's own predicate (an
 * exact id/token match against a caller-supplied, transaction-local GUC) is
 * what actually grants the one row the caller already knows how to name.
 * Adding a new caller of this helper therefore requires adding such a
 * narrowly-keyed policy on the target table -- calling this helper alone
 * grants access to nothing.
 *
 * Mirrors `withTenantTransaction`'s exact BEGIN/COMMIT/ROLLBACK and
 * `client.release(releaseWithError)` discipline -- deliberately NOT
 * AsyncLocalStorage-scoped like the tenant context above: there is no
 * "current pre-tenant lookup" to leak across concurrent lookups the way a
 * real workspaceId could.
 */
export async function withPreTenantLookup<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let releaseWithError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.current_workspace_id', $1, true)", [
      PRE_TENANT_LOOKUP_SENTINEL_WORKSPACE_ID,
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      releaseWithError = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
    }
    throw err;
  } finally {
    client.release(releaseWithError);
  }
}
